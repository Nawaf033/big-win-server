const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const OpenAI = require('openai');
const env = require('./src/config/env');
const apiRoutes = require('./src/routes/apiRoutes');

const app = express();

const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://render.com',
    'X-Title': 'BigWin',
  },
});

const FALLBACK_VISION_MODEL = 'google/gemini-2.0-flash-lite-preview-02-05:free';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/**
 * Safely extract a string image URL from string | { url } | array payloads.
 */
function extractImageUrl(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.startsWith('http') ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractImageUrl(item);
      if (url) return url;
    }
    return null;
  }

  if (typeof value === 'object') {
    return extractImageUrl(value.url ?? value.src ?? value.original ?? null);
  }

  return null;
}

const EXCLUDED_MODEL_TERMS = ['safety', 'guard', 'moderation', 'embed', 'rerank'];
const VISION_ID_HINTS = ['vision', 'vl', 'pixtral', 'llava', 'gemini', 'qwen2-vl'];

function isExcludedModelId(id) {
  return EXCLUDED_MODEL_TERMS.some((term) => id.includes(term));
}

function hasVisionCapability(model) {
  const id = String(model?.id || '').toLowerCase();
  const inputModalities = model?.architecture?.input_modalities;
  const hasImageModality =
    Array.isArray(inputModalities) && inputModalities.includes('image');

  const idHint = VISION_ID_HINTS.some((hint) => id.includes(hint));

  return hasImageModality || idHint;
}

function isEligibleFreeVisionModel(model) {
  const id = String(model?.id || '').toLowerCase();
  if (!id.endsWith(':free')) return false;
  if (isExcludedModelId(id)) return false;
  return hasVisionCapability(model);
}

/**
 * Pick the first active free vision model from OpenRouter.
 */
async function resolveActiveFreeVisionModel() {
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://render.com',
        'X-Title': 'BigWin',
      },
    });

    if (!response.ok) {
      throw new Error(`OpenRouter models API returned ${response.status}`);
    }

    const payload = await response.json();
    const models = Array.isArray(payload?.data) ? payload.data : [];

    const freeVisionModels = models
      .filter(isEligibleFreeVisionModel)
      .sort((a, b) => {
        const aHasImage = Array.isArray(a.architecture?.input_modalities)
          ? Number(a.architecture.input_modalities.includes('image'))
          : 0;
        const bHasImage = Array.isArray(b.architecture?.input_modalities)
          ? Number(b.architecture.input_modalities.includes('image'))
          : 0;
        return bHasImage - aHasImage;
      });

    const selected = freeVisionModels[0]?.id;
    if (!selected) {
      throw new Error('No active free vision models found');
    }

    return selected;
  } catch (error) {
    console.warn(
      `⚠️ Failed to resolve dynamic OpenRouter model (${error.message}). Using fallback.`
    );
    return FALLBACK_VISION_MODEL;
  }
}

function extractJsonObject(text) {
  if (!text || typeof text !== 'string') return null;

  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // fall through
      }
    }

    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        // fall through
      }
    }
  }

  return null;
}

function parseAiProductContent(rawText) {
  const parsed = extractJsonObject(rawText);

  if (!parsed || typeof parsed !== 'object') {
    return {
      description: String(rawText || '').trim(),
      highlights: [],
      tags: [],
    };
  }

  return {
    description: String(parsed.description || '').trim(),
    highlights: Array.isArray(parsed.highlights)
      ? parsed.highlights.map((item) => String(item).trim()).filter(Boolean)
      : [],
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.map((item) => String(item).trim()).filter(Boolean)
      : [],
  };
}

function formatSallaDescription({ description, highlights }) {
  const paragraphs = String(description || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${line}</p>`)
    .join('');

  const highlightsHtml =
    Array.isArray(highlights) && highlights.length > 0
      ? `<h3>أبرز المميزات</h3><ul>${highlights
          .map((item) => `<li>${item}</li>`)
          .join('')}</ul>`
      : '';

  return `${paragraphs}${highlightsHtml}`.trim();
}

const SALLA_TOKEN_URL = 'https://accounts.salla.sa/oauth2/token';

/** In-memory Salla OAuth tokens (updated after refresh). */
const sallaAuth = {
  accessToken: process.env.SALLA_ACCESS_TOKEN || null,
  refreshToken: process.env.SALLA_REFRESH_TOKEN || null,
};

function getSallaAccessToken() {
  return sallaAuth.accessToken || process.env.SALLA_ACCESS_TOKEN || null;
}

function isInvalidTokenError(status, payload) {
  if (status === 401) return true;

  const message = String(
    payload?.error?.message ||
      payload?.error_description ||
      payload?.error ||
      payload?.message ||
      ''
  ).toLowerCase();

  return (
    message.includes('invalid token') ||
    message.includes('unauthenticated') ||
    message.includes('unauthorized') ||
    message.includes('access token')
  );
}

/**
 * Refresh the Salla access token using the stored refresh token.
 */
async function refreshSallaAccessToken() {
  const clientId = process.env.SALLA_CLIENT_ID;
  const clientSecret = process.env.SALLA_CLIENT_SECRET;
  const refreshToken = sallaAuth.refreshToken || process.env.SALLA_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'SALLA_CLIENT_ID, SALLA_CLIENT_SECRET, and SALLA_REFRESH_TOKEN are required to refresh the access token'
    );
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const response = await fetch(SALLA_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.access_token) {
    const message =
      payload?.error_description ||
      payload?.error?.message ||
      payload?.error ||
      payload?.message ||
      `Salla token refresh failed (${response.status})`;
    throw new Error(message);
  }

  sallaAuth.accessToken = payload.access_token;
  process.env.SALLA_ACCESS_TOKEN = payload.access_token;

  // Salla refresh tokens are single-use; keep the newest one in memory.
  if (payload.refresh_token) {
    sallaAuth.refreshToken = payload.refresh_token;
    process.env.SALLA_REFRESH_TOKEN = payload.refresh_token;
  }

  console.log('🔄 Salla Access Token refreshed successfully!');
  return sallaAuth.accessToken;
}

async function sendSallaProductUpdate(productId, body, accessToken) {
  const response = await fetch(`https://api.salla.dev/admin/v2/products/${productId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

/**
 * Update a Salla product with AI-generated description and tags.
 * Automatically refreshes the OAuth access token and retries once on 401.
 */
async function updateSallaProduct(productId, { description, highlights, tags }) {
  if (!productId) {
    throw new Error('productId is required to update Salla product');
  }

  let accessToken = getSallaAccessToken();
  if (!accessToken) {
    throw new Error('SALLA_ACCESS_TOKEN is not configured');
  }

  const body = {
    description: formatSallaDescription({ description, highlights }),
  };

  if (Array.isArray(tags) && tags.length > 0) {
    body.tags = tags;
  }

  let { response, payload } = await sendSallaProductUpdate(productId, body, accessToken);

  if (isInvalidTokenError(response.status, payload)) {
    console.warn('⚠️ Salla access token invalid/expired. Refreshing...');
    accessToken = await refreshSallaAccessToken();
    ({ response, payload } = await sendSallaProductUpdate(productId, body, accessToken));
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      `Salla API returned ${response.status}`;
    throw new Error(message);
  }

  console.log(`✅ Product ${productId} updated successfully in Salla store!`);
  return payload;
}

/**
 * Analyze a Salla product image via OpenRouter and generate Arabic copy.
 */
async function generateArabicProductContent({ productName, productPrice, mainImageUrl }) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  if (!mainImageUrl || typeof mainImageUrl !== 'string') {
    throw new Error('mainImageUrl must be a valid string URL');
  }

  const selectedModel = await resolveActiveFreeVisionModel();
  console.log(`🤖 Selected OpenRouter model: ${selectedModel}`);
  console.log('✍️ Generating Arabic product marketing text, highlights, and tags...');

  const safeName = productName || 'منتج بدون اسم';
  const safePrice = productPrice == null ? 'غير متوفر' : productPrice;

  const prompt = `أنت كاتب محتوى تجاري لمنصة سلة في السعودية (متجر Big Win).

اسم المنتج: ${safeName}
السعر: ${safePrice}

حلّل صورة المنتج المرفقة، ثم أنشئ محتوى تسويقي جذاب بالعربية الفصحى السهلة.

أرجع JSON فقط بالمفاتيح التالية:
- description: وصف منتج جذاب من 3 إلى 5 جمل
- highlights: مصفوفة من 3 إلى 6 نقاط بيع رئيسية قصيرة
- tags: مصفوفة من 5 إلى 10 وسوم/كلمات مفتاحية عربية مناسبة للمتجر الإلكتروني`;

  const response = await openrouter.chat.completions.create({
    model: selectedModel,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: mainImageUrl } },
        ],
      },
    ],
  });

  const rawText = response.choices?.[0]?.message?.content?.trim() || '';
  return {
    rawText,
    ...parseAiProductContent(rawText),
  };
}

// ==========================================
// 1️⃣ Middlewares (إعدادات معالجة البيانات)
// ==========================================
app.use(cors());
app.use(
  bodyParser.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// ==========================================
// 2️⃣ Primary Routes (المسارات الأساسية)
// ==========================================

// فحص حالة السيرفر (Health Check)
app.get('/', (_req, res) => {
  res.json({
    success: true,
    message: 'Big Win dropshipping API',
    version: '1.0.0',
  });
});

// مسار استقبال إشعارات سلة (Salla Webhook)
app.post('/webhook', (req, res) => {
  // Acknowledge Salla immediately so the webhook does not time out
  res.status(200).json({ success: true, message: 'Webhook acknowledged' });

  const data = req.body?.data || {};
  const productId = data.id ?? data.product_id ?? null;
  const productName = data.name ?? data.product_name ?? 'منتج بدون اسم';
  const rawPrice =
    data.price?.amount ??
    data.price?.value ??
    data.price ??
    data.regular_price?.amount ??
    data.regular_price ??
    null;
  const productPrice =
    rawPrice == null || (typeof rawPrice === 'object' && rawPrice.amount == null)
      ? 'غير متوفر'
      : typeof rawPrice === 'object'
        ? rawPrice.amount ?? rawPrice.value ?? 'غير متوفر'
        : rawPrice;

  const mainImageUrl = extractImageUrl(
    data.main_image ??
      data.main_image_url ??
      data.image ??
      data.images ??
      null
  );

  console.log('📦 Salla Webhook Received:', {
    event: req.body?.event,
    productId,
    productName,
    productPrice,
    mainImageUrl,
  });

  if (!mainImageUrl || typeof mainImageUrl !== 'string') {
    console.log('⏭️ Skipping AI analysis: no valid string image URL in webhook payload');
    return;
  }

  // Run AI enrichment after acknowledging Salla, then sync back to the store
  generateArabicProductContent({ productName, productPrice, mainImageUrl })
    .then(async (aiResponse) => {
      console.log('✨ OpenRouter Product Content:');
      console.log('---------------------------');
      console.log(aiResponse.rawText);
      console.log('---------------------------');

      if (!productId) {
        console.warn('⚠️ Skipping Salla product update: missing productId');
        return;
      }

      try {
        await updateSallaProduct(productId, {
          description: aiResponse.description,
          highlights: aiResponse.highlights,
          tags: aiResponse.tags,
        });
      } catch (sallaError) {
        console.error(`❌ Salla product update failed for ${productId}:`, sallaError.message);
      }
    })
    .catch((error) => {
      console.error('❌ OpenRouter analysis failed:', error.message);
    });
});

// مسارات API الأخرى
app.use('/api/v1', apiRoutes);

// ==========================================
// 3️⃣ Error & 404 Handlers (معالجة الأخطاء)
// ==========================================

// معالج الصفحات غير الموجودة (يوضع بعد كل المسارات)
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
  });
});

// معالج الأخطاء العام
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';
  res.status(status).json({
    success: false,
    error: message,
    ...(env.nodeEnv !== 'production' && err.details ? { details: err.details } : {}),
  });
});

// ==========================================
// 4️⃣ Start Server (تشغيل السيرفر)
// ==========================================
app.listen(env.port, () => {
  console.log(`Big Win backend listening on port ${env.port}`);
});

module.exports = app;
app.post('/salla/webhook', (req, res) => {
  // طباعة محتوى الإشعار كاملاً لظهور التوكن في سجلات Render
  console.log("=== SALLA WEBHOOK PAYLOAD ===");
  console.log(JSON.stringify(req.body, null, 2));
  console.log("=============================");

  // إرجاع استجابة نجاح لسلة
  res.status(200).send('OK');
});

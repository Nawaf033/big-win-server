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

const VISION_MODELS = [
  'qwen/qwen2-vl-72b-instruct:free',
  'google/gemini-2.0-flash-thinking-exp:free',
  'mistralai/pixtral-12b:free',
];

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
    model: VISION_MODELS[0],
    models: VISION_MODELS,
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

  return response.choices?.[0]?.message?.content?.trim() || '';
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

  // Run AI enrichment after acknowledging Salla
  generateArabicProductContent({ productName, productPrice, mainImageUrl })
    .then((aiResponse) => {
      console.log('✨ OpenRouter Product Content:');
      console.log('---------------------------');
      console.log(aiResponse);
      console.log('---------------------------');
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

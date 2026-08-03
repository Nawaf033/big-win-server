const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
const env = require('./src/config/env');
const apiRoutes = require('./src/routes/apiRoutes');

const app = express();
const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function detectImageMimeType(contentType, imageUrl) {
  if (contentType?.startsWith('image/')) {
    return contentType.split(';')[0].trim();
  }

  const extension = String(imageUrl).split('?')[0].split('.').pop()?.toLowerCase();
  const mimeByExt = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
  };

  return mimeByExt[extension] || 'image/jpeg';
}

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
 * Analyze a Salla product image with Gemini 2.5 Flash and generate Arabic copy.
 */
async function generateArabicProductContent({ productName, productPrice, mainImageUrl }) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  if (!mainImageUrl || typeof mainImageUrl !== 'string') {
    throw new Error('mainImageUrl must be a valid string URL');
  }

  const safeName = productName || 'منتج بدون اسم';
  const safePrice = productPrice == null ? 'غير متوفر' : productPrice;

  const imageResponse = await axios.get(mainImageUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 5,
  });

  const mimeType = detectImageMimeType(imageResponse.headers['content-type'], mainImageUrl);
  const imageBase64 = Buffer.from(imageResponse.data).toString('base64');

  const prompt = `أنت كاتب محتوى تجاري لمنصة سلة في السعودية (متجر Big Win).

اسم المنتج: ${safeName}
السعر: ${safePrice}

حلّل صورة المنتج أعلاه، ثم أنشئ محتوى تسويقي جذاب بالعربية الفصحى السهلة.

أرجع JSON فقط بالمفاتيح التالية:
- description: وصف منتج جذاب من 3 إلى 5 جمل
- highlights: مصفوفة من 3 إلى 6 نقاط بيع رئيسية قصيرة
- tags: مصفوفة من 5 إلى 10 وسوم/كلمات مفتاحية عربية مناسبة للمتجر الإلكتروني`;

  const response = await gemini.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
  });

  return response.text?.trim() || '';
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
    console.log('⏭️ Skipping Gemini analysis: no valid string image URL in webhook payload');
    return;
  }

  // Run AI enrichment after acknowledging Salla
  generateArabicProductContent({ productName, productPrice, mainImageUrl })
    .then((aiResponse) => {
      console.log('✨ Gemini Product Content:');
      console.log('---------------------------');
      console.log(aiResponse);
      console.log('---------------------------');
    })
    .catch((error) => {
      console.error('❌ Gemini analysis failed:', error.message);
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

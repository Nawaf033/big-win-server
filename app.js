const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const env = require('./src/config/env');
const apiRoutes = require('./src/routes/apiRoutes');

const app = express();

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
  console.log('📦 Salla Webhook Received:', JSON.stringify(req.body, null, 2));
  res.status(200).send('Webhook Received Successfully');
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
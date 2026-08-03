const crypto = require('crypto');
const env = require('../config/env');
const sallaProductService = require('../services/sallaProductService');

const SUPPORTED_EVENTS = new Set([
  'product.created',
  'product.updated',
  'product.deleted',
  'order.created',
  'order.updated',
  'app.store.authorize',
]);

function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !env.sallaAccessToken) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', env.sallaAccessToken)
    .update(rawBody)
    .digest('hex');

  const received = signatureHeader.replace(/^sha256=/i, '');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(received, 'hex')
    );
  } catch {
    return false;
  }
}

async function handleWebhook(req, res, next) {
  try {
    const signature =
      req.headers['x-salla-signature'] ||
      req.headers['x-salla-security-strategy'] ||
      req.headers['authorization'];

    const rawBody = req.rawBody || JSON.stringify(req.body);

    if (signature && !verifyWebhookSignature(rawBody, String(signature))) {
      return res.status(401).json({
        success: false,
        error: 'Invalid webhook signature',
      });
    }

    const payload = req.body;

    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Invalid webhook payload',
      });
    }

    const { event } = payload;

    if (!event || typeof event !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing event field in webhook payload',
      });
    }

    if (!SUPPORTED_EVENTS.has(event)) {
      return res.status(200).json({
        success: true,
        message: 'Event acknowledged but not handled',
        event,
      });
    }

    const result = await sallaProductService.handleWebhookEvent(payload);

    return res.status(200).json({
      success: true,
      event,
      result,
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  handleWebhook,
};

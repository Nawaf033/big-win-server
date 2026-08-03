const express = require('express');
const searchController = require('../controllers/searchController');
const sallaWebhookController = require('../controllers/sallaWebhookController');

const router = express.Router();

router.get('/health', (_req, res) => {
  res.status(200).json({
    success: true,
    service: 'big-win-backend',
    timestamp: new Date().toISOString(),
  });
});

router.post('/search-image', searchController.searchImage);
router.post('/salla/webhook', sallaWebhookController.handleWebhook);

module.exports = router;

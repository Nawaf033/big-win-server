const { sallaClient } = require('../config/salla');

async function listProducts({ page = 1, keyword } = {}) {
  const params = { page };
  if (keyword) params.keyword = keyword;

  const { data } = await sallaClient.get('/products', { params });
  return data;
}

async function getProduct(productId) {
  const { data } = await sallaClient.get(`/products/${productId}`);
  return data;
}

async function createProduct(productPayload) {
  const { data } = await sallaClient.post('/products', productPayload);
  return data;
}

async function updateProduct(productId, productPayload) {
  const { data } = await sallaClient.put(`/products/${productId}`, productPayload);
  return data;
}

async function deleteProduct(productId) {
  const { data } = await sallaClient.delete(`/products/${productId}`);
  return data;
}

/**
 * Handle Salla webhook events related to products and orders.
 * @param {{ event: string, merchant: object, data: object }} payload
 */
async function handleWebhookEvent(payload) {
  const { event, data } = payload;

  switch (event) {
    case 'product.created':
    case 'product.updated':
      return { handled: true, action: 'product_sync', productId: data?.id };

    case 'product.deleted':
      return { handled: true, action: 'product_removed', productId: data?.id };

    case 'order.created':
    case 'order.updated':
      return { handled: true, action: 'order_sync', orderId: data?.id };

    case 'app.store.authorize':
      return { handled: true, action: 'store_authorized', merchantId: payload.merchant?.id };

    default:
      return { handled: false, action: 'ignored', event };
  }
}

module.exports = {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  handleWebhookEvent,
};

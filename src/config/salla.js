const axios = require('axios');
const env = require('./env');

const SALLA_BASE_URL = 'https://api.salla.dev/admin/v2';

const sallaClient = axios.create({
  baseURL: SALLA_BASE_URL,
  timeout: 30000,
  headers: {
    Authorization: `Bearer ${env.sallaAccessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});

sallaClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const message =
      error.response?.data?.message ||
      error.response?.data?.error?.message ||
      error.message;

    const wrapped = new Error(`Salla API error${status ? ` (${status})` : ''}: ${message}`);
    wrapped.status = status || 502;
    wrapped.details = error.response?.data;
    throw wrapped;
  }
);

module.exports = {
  sallaClient,
  SALLA_BASE_URL,
};

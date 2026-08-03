require('dotenv').config();

const requiredVars = ['SALLA_ACCESS_TOKEN', 'SERPAPI_KEY', 'ANTHROPIC_API_KEY'];

function validateEnv() {
  const missing = requiredVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.warn(
      `[config] Missing environment variables: ${missing.join(', ')}. Some features may be unavailable.`
    );
  }
}

validateEnv();

module.exports = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  sallaAccessToken: process.env.SALLA_ACCESS_TOKEN,
  serpApiKey: process.env.SERPAPI_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
};

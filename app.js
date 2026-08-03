const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const env = require('./src/config/env');
const apiRoutes = require('./src/routes/apiRoutes');

const app = express();

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

app.get('/', (_req, res) => {
  res.json({
    success: true,
    message: 'Big Win dropshipping API',
    version: '1.0.0',
  });
});

app.use('/api/v1', apiRoutes);

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const message = err.message || 'Internal server error';

  if (env.nodeEnv !== 'production') {
    console.error(err);
  } else {
    console.error(`[error] ${status}: ${message}`);
  }

  res.status(status).json({
    success: false,
    error: message,
    ...(env.nodeEnv !== 'production' && err.details ? { details: err.details } : {}),
  });
});

app.listen(env.port, () => {
  console.log(`Big Win backend listening on port ${env.port}`);
});

module.exports = app;

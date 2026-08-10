'use strict';
// Structured logging, mirroring the ERP backend's pino setup so operators read
// one log format across both services.
//
// The redact list is not decoration. Tool payloads and ERP responses flow
// through this logger, and both can carry an Authorization header or a client's
// personal details. §43 says log the metadata, not the secrets.

const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'headers["x-service-auth"]',
      'config.AI_API_KEY',
      'config.SERVICE_AUTH_SECRET',
      'apiKey',
      'token',
      'password',
      '*.authorization',
    ],
    censor: '[redacted]',
  },
  base: { service: 'mps-ai' },
});

module.exports = logger;

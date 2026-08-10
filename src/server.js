'use strict';
// Process entry point. Boot, listen, shut down cleanly.

const { load } = require('./config');
const { buildAppFromConfig } = require('./app');
const logger = require('./lib/logger');

let config;
try {
  config = load();
} catch (err) {
  // Before pino is trusted with it: a config failure can occur while LOG_LEVEL
  // itself is the invalid value, and a silent exit here is the hardest possible
  // start-up failure to diagnose.
  console.error(`[mps-ai] ${err.message}`);
  process.exit(1);
}

const app = buildAppFromConfig(config);

const server = app.listen(config.PORT, () => {
  logger.info({
    port: config.PORT,
    env: config.NODE_ENV,
    erp: config.ERP_BACKEND_URL,
    origins: config.allowedOrigins.length,
  }, 'mps_ai_started');
});

function shutdown(signal) {
  logger.info({ signal }, 'shutting_down');
  server.close(() => process.exit(0));
  // Don't hang forever on a wedged keep-alive connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = server;

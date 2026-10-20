'use strict';
// Express app assembly, separated from listen() so tests build the real app
// with fake collaborators instead of asserting against a mock of themselves.

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { createErpClient } = require('./integrations/erp/client');
const { createOpenRouterProvider } = require('./platform/provider/openrouter');
const { createRouter } = require('./platform/router');
const { createClientAgent } = require('./agents/client/agent');
const { createClientAgentRouter } = require('./api/clientAgent');
const { createUsageLedger } = require('./lib/usageLedger');
const { list: listTools } = require('./platform/tools/registry');
const logger = require('./lib/logger');

function buildApp({ config, erp, provider }) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '128kb' }));

  // §47 — an explicit allow-list. `credentials` stays off, deliberately, and
  // this is now MORE important, not less (WIRE-01 fix): the browser's session
  // cookie reaches us same-origin only (through the Next.js /ai rewrite), where
  // CORS never applies. Cross-site sends are impossible to accept anyway — the
  // cookie is SameSite=strict — so a service-side credentials flag cannot open
  // a CSRF hole that browsers would not already close. Non-browser callers
  // still send a Bearer header, which needs no credentials mode at all.
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);              // server-to-server, curl
      if (config.allowedOrigins.includes(origin)) return cb(null, true);
      logger.warn({ origin }, 'cors_rejected');
      return cb(new Error('Origin not allowed'));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    credentials: false,
  }));

  // §48 — liveness. No config, no secrets, no upstream calls: a health check
  // that fails because OpenRouter is slow tells the orchestrator to restart a
  // process that is working fine.
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'mps-ai' }));

  // Capability discovery (§37). Names and summaries only — the endpoints they
  // map to are internal, and publishing them would just be a map of the ERP.
  app.get('/capabilities', (_req, res) => res.json({
    agents: ['client'],
    tools: listTools(),
  }));

  // §45 — keyed by token rather than IP so one studio behind one NAT is not
  // rate-limited as a single user. The token is hashed into the key by
  // express-rate-limit's store, never logged.
  const limiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    max: config.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const h = req.headers.authorization;
      return typeof h === 'string' && h.length > 16 ? h.slice(-32) : req.ip;
    },
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } },
  });

  const router = createRouter({ config, provider });
  const ledger = createUsageLedger({ config });
  const agent = createClientAgent({ config, erp, router, ledger });

  app.use('/ai/client-agent', limiter, createClientAgentRouter({ agent }));

  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } }));

  app.use((err, _req, res, _next) => {
    if (err && err.message === 'Origin not allowed') {
      return res.status(403).json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed.' } });
    }
    logger.error({ err: err?.message }, 'unhandled_error');
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  });

  return app;
}

/** Wire the real collaborators. Split out so buildApp stays injectable. */
function buildAppFromConfig(config) {
  const erp = createErpClient({ config });
  const provider = createOpenRouterProvider({ config });
  return buildApp({ config, erp, provider });
}

module.exports = { buildApp, buildAppFromConfig };

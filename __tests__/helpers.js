'use strict';
// Shared fixtures. Not a test file — jest's testMatch is `*.test.js`.
//
// Every suite builds the REAL app via buildApp() with fake collaborators, so a
// passing assertion means the request actually travelled cors → limiters →
// route → agent → registry → ERP adapter in that order, rather than exercising
// a mock of the thing under test.

const request = require('supertest');
const { buildApp } = require('../src/app');
const { load } = require('../src/config');

const BASE_ENV = {
  NODE_ENV: 'test',
  AI_API_KEY: 'test-key',
  ERP_BACKEND_URL: 'https://erp.example.test',
  SERVICE_AUTH_SECRET: 'x'.repeat(48),
  ALLOWED_ORIGINS: 'https://app.example.test',
  STUDIO_TIMEZONE: 'Asia/Kolkata',
};

function configWith(overrides = {}) {
  return load({ ...BASE_ENV, ...overrides });
}

/** An ERP stand-in that records exactly what it was asked, by whom. */
function fakeErp(handler) {
  const calls = [];
  return {
    calls,
    get: async (path, { userToken, requestId } = {}) => {
      calls.push({ path, userToken, requestId });
      return handler(path, userToken);
    },
  };
}

/** A provider that never calls out, and records the prompt it was given. */
function fakeProvider() {
  const seen = [];
  return {
    seen,
    name: 'fake',
    generate: async ({ messages, model }) => {
      seen.push({ messages, model });
      return {
        content: 'Answer.',
        model: model || 'fake-model',
        usage: { prompt: 10, completion: 5 },
        latency_ms: 1,
      };
    },
  };
}

/** Captures audit events instead of writing them to a log. */
function fakeAuditSink() {
  const events = [];
  return {
    events,
    info: (obj, msg) => events.push({ level: 'info', ...obj, msg }),
    warn: (obj, msg) => events.push({ level: 'warn', ...obj, msg }),
    error: (obj, msg) => events.push({ level: 'error', ...obj, msg }),
    debug: () => {},
  };
}

/** A clock frozen at a known instant, so date assertions are not flaky. */
function fixedClock(iso = '2026-08-13T09:15:00Z', timeZone = 'Asia/Kolkata') {
  const { createStudioClock } = require('../src/platform/time/studioClock');
  return createStudioClock({ timeZone, now: () => new Date(iso) });
}

const ERP_ERR = (status) => {
  const e = new Error(`ERP responded ${status}`);
  e.status = status;
  e.code = status === 404 ? 'NOT_FOUND' : 'ERP_DENIED';
  throw e;
};

/** The happy-path ERP: a named client, empty snapshot. */
const okErp = (extra = {}) => fakeErp(async (path) => (path.endsWith('/snapshot')
  ? { data: { ...extra }, latency_ms: 1 }
  : { data: { data: { name: 'Rahul Sharma' } }, latency_ms: 1 }));

function appWith({ erp, provider = fakeProvider(), config = configWith(), clock, audit }) {
  return { app: buildApp({ config, erp, provider, clock, audit }), provider, erp, config };
}

const post = (app, body, token = 'user-jwt-alpha') =>
  request(app).post('/ai/client-agent/chat')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

/** The system message the model was handed on the Nth call. */
const systemOf = (provider, n = 0) => provider.seen[n].messages[0].content;

/** The fenced retrieved-data message, if one was sent. */
const contextOf = (provider, n = 0) =>
  provider.seen[n].messages.find((m) => m.content.includes('RETRIEVED DATA'));

module.exports = {
  BASE_ENV,
  configWith,
  fakeErp,
  fakeProvider,
  fakeAuditSink,
  fixedClock,
  okErp,
  ERP_ERR,
  appWith,
  post,
  systemOf,
  contextOf,
};

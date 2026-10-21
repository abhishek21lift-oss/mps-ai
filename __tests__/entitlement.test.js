'use strict';
// Audit P1-2 — the `ai_suite` entitlement gate.
//
// The quota gate is a LIMIT, not an entitlement: a studio under its monthly
// allowance was never refused, so a plan that excludes the AI suite still got a
// working panel and spent the shared model account. These tests pin the three
// answers that matter — entitled, not entitled, and "the ERP would not say" —
// plus the ordering that keeps a tenancy denial from looking like a plan denial.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { buildApp } = require('../src/app');
const { load } = require('../src/config');

const BASE_ENV = {
  NODE_ENV: 'test',
  AI_API_KEY: 'test-key',
  ERP_BACKEND_URL: 'https://erp.example.test',
  SERVICE_AUTH_SECRET: 'x'.repeat(48),
  ALLOWED_ORIGINS: 'https://app.example.test',
};

const config = load(BASE_ENV);

const profileOk = { data: { data: { name: 'Rahul Sharma' } }, latency_ms: 1 };

/** ERP stand-in: records every read, and answers what the test tells it to. */
function fakeErp({ features, failFeatures = false } = {}) {
  const calls = [];
  const posts = [];
  return {
    calls,
    posts,
    get: async (p, opts = {}) => {
      calls.push({ path: p, userToken: opts.userToken, requestId: opts.requestId });
      if (p === '/api/features') {
        if (failFeatures) {
          const e = new Error('ERP responded 502');
          e.status = 502; e.code = 'ERP_DENIED'; throw e;
        }
        return { data: { data: features }, latency_ms: 1 };
      }
      if (p === '/api/ai/usage/service/quota') {
        return { data: { data: { over: false, enforcement_enabled: false } }, latency_ms: 1 };
      }
      if (p.endsWith('/snapshot')) return { data: {}, latency_ms: 1 };
      if (p.includes('/clients/')) return profileOk;
      return { data: {}, latency_ms: 1 };
    },
    post: async (p, body, opts = {}) => {
      posts.push({ path: p, body, userToken: opts.userToken, requestId: opts.requestId });
      return { data: { ok: true }, latency_ms: 1 };
    },
  };
}

function spyProvider() {
  const seen = [];
  return {
    seen,
    name: 'fake',
    generate: async ({ messages, model }) => {
      seen.push({ messages, model });
      return {
        content: 'He attended 11 of 12 sessions.',
        model: model || 'fake-model',
        usage: { prompt: 10, completion: 5 },
        latency_ms: 1,
      };
    },
  };
}

const appWith = (erp, provider = spyProvider(), cfg = config) => buildApp({ config: cfg, erp, provider });
const withCookie = (req) => req.set('Cookie', 'token=user-jwt-alpha');
const ask = (app, body = { clientId: 'c-1', message: 'How is this client doing?' }) =>
  withCookie(request(app).post('/ai/client-agent/chat').send(body));

describe('P1-2 — ai_suite is enforced before model spend', () => {
  test('entitled studio: the turn proceeds and is reported', async () => {
    const erp = fakeErp({ features: { ai_suite: true, ai_knowledge_base: true } });
    const provider = spyProvider();
    const res = await ask(appWith(erp, provider));

    expect(res.status).toBe(200);
    expect(provider.seen).toHaveLength(1);

    // The flag is read as the end user, with the same forwarded token as every
    // other read — no service identity, no invented tenant.
    const featuresCall = erp.calls.find((c) => c.path === '/api/features');
    expect(featuresCall).toBeTruthy();
    expect(featuresCall.userToken).toBe('user-jwt-alpha');

    expect(erp.posts.some((p) => p.path === '/api/ai/usage/service/ingest')).toBe(true);
  });

  test('unentitled studio: 403 AI_NOT_ENABLED, no model call, no usage report', async () => {
    const erp = fakeErp({ features: { ai_suite: false } });
    const provider = spyProvider();
    const res = await ask(appWith(erp, provider));

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AI_NOT_ENABLED');
    expect(provider.seen).toHaveLength(0);
    expect(erp.posts).toHaveLength(0);
  });

  test('unentitled studio spends no quota read either: entitlement runs first', async () => {
    const erp = fakeErp({ features: { ai_suite: false } });
    await ask(appWith(erp));

    const paths = erp.calls.map((c) => c.path);
    expect(paths).toContain('/api/features');
    expect(paths).not.toContain('/api/ai/usage/service/quota');
  });

  test('the denied turn is recorded as such, not as a success', async () => {
    const ledgerFile = path.join(os.tmpdir(), `entitlement-${process.pid}-${Date.now()}.jsonl`);
    const cfg = load({ ...BASE_ENV, USAGE_LEDGER_FILE: ledgerFile });
    const erp = fakeErp({ features: { ai_suite: false } });
    await ask(appWith(erp, spyProvider(), cfg));

    const row = JSON.parse(fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').pop());
    expect(row.outcome).toBe('ai_disabled');
    expect(row.code).toBe('AI_NOT_ENABLED');
    fs.unlinkSync(ledgerFile);
  });
});

describe('P1-2 — entitlement that cannot be read fails closed', () => {
  test('feature-service failure: 503 ENTITLEMENT_UNVERIFIED and no spend', async () => {
    const erp = fakeErp({ failFeatures: true });
    const provider = spyProvider();
    const res = await ask(appWith(erp, provider));

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ENTITLEMENT_UNVERIFIED');
    expect(provider.seen).toHaveLength(0);
    expect(erp.posts).toHaveLength(0);
  });

  test('an empty map is "unverified", not "off" — a token with no studio gets {}', async () => {
    const erp = fakeErp({ features: {} });
    const provider = spyProvider();
    const res = await ask(appWith(erp, provider));

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ENTITLEMENT_UNVERIFIED');
    expect(provider.seen).toHaveLength(0);
  });

  test('a non-boolean value is not coerced into an answer', async () => {
    const erp = fakeErp({ features: { ai_suite: 'true' } });
    const provider = spyProvider();
    const res = await ask(appWith(erp, provider));

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ENTITLEMENT_UNVERIFIED');
    expect(provider.seen).toHaveLength(0);
  });

  test('a plan denial on the stream carries its status on the error event', async () => {
    const erp = fakeErp({ features: { ai_suite: false } });
    const provider = spyProvider();
    const res = await withCookie(request(appWith(erp, provider))
      .post('/ai/client-agent/chat/stream')
      .send({ clientId: 'c-1', message: 'How is this client doing?' }));

    expect(res.status).toBe(200); // the stream is open; the failure rides the event
    const line = res.text.split('\n').find((l) => l.startsWith('data:'));
    const event = JSON.parse(line.slice(5).trim());
    expect(event.code).toBe('AI_NOT_ENABLED');
    expect(event.status).toBe(403);
    expect(provider.seen).toHaveLength(0);
  });
});

describe('P1-2 — authorisation still comes first', () => {
  test('an invisible client is CLIENT_NOT_FOUND, and the entitlement is never read', async () => {
    const erp = fakeErp({ features: { ai_suite: true } });
    erp.get = async (p, opts = {}) => {
      erp.calls.push({ path: p, userToken: opts.userToken, requestId: opts.requestId });
      const e = new Error('ERP responded 404');
      e.status = 404; e.code = 'NOT_FOUND'; throw e;
    };
    const provider = spyProvider();
    const res = await ask(appWith(erp, provider));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CLIENT_NOT_FOUND');
    expect(erp.calls.map((c) => c.path)).not.toContain('/api/features');
    expect(provider.seen).toHaveLength(0);
  });
});

'use strict';
// Phase 4E — failed usage ingestion is OBSERVABLE.
//
// reportUsage is deliberately best-effort: a failed report must never break
// the answer (degrades bookkeeping, not the turn). What it did do is log the
// failure at `debug`, a level production does not emit — an ERP outage
// silently dropped every ingest without a single warn-level line. This pins
// the failure at warn (an alert rule can match the message) while keeping the
// success path silent and the turn unaffected.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const mockLogger = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};
jest.mock('../src/lib/logger', () => mockLogger);

const { buildApp } = require('../src/app');
const { load } = require('../src/config');

const BASE_ENV = {
  NODE_ENV: 'test',
  AI_API_KEY: 'test-key',
  ERP_BACKEND_URL: 'https://erp.example.test',
  SERVICE_AUTH_SECRET: 'x'.repeat(48),
  ALLOWED_ORIGINS: 'https://app.example.test',
};

/** ERP whose usage ingest endpoint can fail like the real client does. */
function fakeErp({ ingestFails = false } = {}) {
  return {
    get: async (p) => {
      if (p === '/api/ai/usage/service/quota') return { data: { data: { over: false, enforcement_enabled: false } }, latency_ms: 1 };
      if (p.endsWith('/snapshot')) return { data: {}, latency_ms: 1 };
      return { data: { data: { name: 'X' } }, latency_ms: 1 };
    },
    post: async (p) => {
      if (ingestFails && p === '/api/ai/usage/service/ingest') {
        const e = new Error('ERP responded 503');
        e.code = 'ERP_DENIED';
        throw e;
      }
      return { data: { ok: true }, latency_ms: 1 };
    },
  };
}

function streamingProvider() {
  return {
    name: 'fake',
    generate: async ({ model, onDelta }) => {
      onDelta?.('The client attended 11 of 12 sessions.');
      return {
        content: 'The client attended 11 of 12 sessions.',
        model: model || 'fake-model',
        usage: { prompt: 321, completion: 9 },
        latency_ms: 2,
      };
    },
  };
}

const withCookie = (req, token = 'user-jwt-alpha') => req.set('Cookie', `token=${encodeURIComponent(token)}`);

function ledgerCfg() {
  return load({
    ...BASE_ENV,
    USAGE_LEDGER_FILE: path.join(os.tmpdir(), `usage-obs-${process.pid}-${Date.now()}.jsonl`),
  });
}

afterEach(() => {
  jest.clearAllMocks();
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith(`usage-obs-${process.pid}`)) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch { /* best effort */ } }
  }
});

describe('4E — usage ingest failures are observable, never fatal to the turn', () => {
  test('a failed ingest is logged at warn carrying the code and request id', async () => {
    const cfg = ledgerCfg();
    const app = buildApp({ config: cfg, erp: fakeErp({ ingestFails: true }), provider: streamingProvider() });
    const res = await withCookie(request(app).post('/ai/client-agent/chat')
      .send({ clientId: 'c-1', message: 'Summarize this client' }));

    // The turn is still fine — bookkeeping degrades, the answer does not.
    expect(res.status).toBe(200);
    const warnCalls = mockLogger.warn.mock.calls.filter((c) => c[1] === 'usage_ingest_failed');
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    const payload = warnCalls[0][0];
    expect(payload.code).toBe('ERP_DENIED');
    expect(typeof payload.requestId).toBe('string');
    // The message carries no prompt content and no credential.
    expect(JSON.stringify(warnCalls[0])).not.toContain('Summarize');
    expect(JSON.stringify(warnCalls[0])).not.toContain('user-jwt');
  });

  test('a successful ingest stays quiet at warn and debug', async () => {
    const cfg = ledgerCfg();
    const app = buildApp({ config: cfg, erp: fakeErp(), provider: streamingProvider() });
    await withCookie(request(app).post('/ai/client-agent/chat')
      .send({ clientId: 'c-1', message: 'Summarize this client' }));

    expect(mockLogger.warn.mock.calls.some((c) => c[1] === 'usage_ingest_failed')).toBe(false);
    expect(mockLogger.debug.mock.calls.some((c) => c[1] === 'usage_ingest_failed')).toBe(false);
  });
});

// ── Phase 5B — recovery is by re-delivery with a stable request id, not a retry loop ──

describe('5B — a failing ingest is retried by no one in-process: evidence stays local', () => {
  test('persistent ingest failure: exactly ONE warn per turn, no in-turn retry loop, ledger row still appended',
    async () => {
      const cfg = ledgerCfg();
      const app = buildApp({ config: cfg, erp: fakeErp({ ingestFails: true }), provider: streamingProvider() });
      const res = await withCookie(request(app).post('/ai/client-agent/chat')
        .send({ clientId: 'c-1', message: 'Summarize this client' }));

      expect(res.status).toBe(200);
      const warns = mockLogger.warn.mock.calls.filter((c) => c[1] === 'usage_ingest_failed');
      expect(warns.length).toBe(1); // loud once — never a silent loop pretending to retry
      // The durable evidence the recovery design relies on: the completed turn
      // (outcome + request id, no content) is in the local ledger regardless.
      const row = JSON.parse(fs.readFileSync(cfg.usageLedgerFile, 'utf8').trim().split('\n').pop());
      expect(row.outcome).toBe('ok');
      expect(row.request_id).toBeTruthy();
    });
});

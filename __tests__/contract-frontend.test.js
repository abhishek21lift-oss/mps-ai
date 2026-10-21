'use strict';
// The round-2 remediation contract tests (WIRE-01/MPS-01/MPS-02).
//
// These run against the REAL app (buildApp with fake collaborators), like
// security.test.js, and codify the CANONICAL contract the Next.js frontend
// calls into — see /tmp/opencode/myptstudio-ai-remediation-v1/
// WIRE_01_CONTRACT_FIX.md. They are the executable half of the shared fixture;
// the frontend side lives in 619-erp-frontend/src/lib/__tests__/
// client-ai-contract.test.ts and must be kept in lockstep with this file.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { buildApp } = require('../src/app');
const { load } = require('../src/config');
const { createOpenRouterProvider } = require('../src/platform/provider/openrouter');

const BASE_ENV = {
  NODE_ENV: 'test',
  AI_API_KEY: 'test-key',
  ERP_BACKEND_URL: 'https://erp.example.test',
  SERVICE_AUTH_SECRET: 'x'.repeat(48),
  ALLOWED_ORIGINS: 'https://app.example.test',
};

const config = load(BASE_ENV);

/** ERP stand-in like security.test.js's, plus a POST spy for usage ingest. */
function fakeErp(handler) {
  const calls = [];
  const posts = [];
  return {
    calls,
    posts,
    get: async (p, opts = {}) => {
      calls.push({ path: p, userToken: opts.userToken, requestId: opts.requestId });
      // Entitlement is a prerequisite for every turn (audit P1-2); tests about
      // anything else should not have to restate it.
      if (p === '/api/features') return { data: { data: { ai_suite: true } }, latency_ms: 1 };
      return handler(p, opts);
    },
    post: async (p, body, opts = {}) => {
      posts.push({ path: p, body, userToken: opts.userToken, requestId: opts.requestId });
      return { data: { ok: true }, latency_ms: 1 };
    },
  };
}

/** A provider that streams in two cumulative deltas, like the real parser does. */
function streamingProvider({ failFirst = false } = {}) {
  const seen = [];
  return {
    seen,
    name: 'fake',
    generate: async ({ messages, model, onDelta }) => {
      seen.push({ messages, model, streamed: typeof onDelta === 'function' });
      if (failFirst) {
        const e = new Error('Model provider responded 429');
        e.code = 'AI_PROVIDER_ERROR'; e.status = 429; throw e;
      }
      onDelta?.('The client attended');
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

function appWith(erp, provider = streamingProvider(), configOverride) {
  return buildApp({ config: configOverride || config, erp, provider });
}

/** ERP that answers the quota probe, snapshot and profile without 404s. */
const quotaErp = (quota) => fakeErp(async (p) => {
  if (p === '/api/ai/usage/service/quota') {
    return { data: { data: quota }, latency_ms: 1 };
  }
  if (p.endsWith('/snapshot')) return { data: {}, latency_ms: 1 };
  return { data: { data: { name: 'X' } }, latency_ms: 1 };
});

/** SSE response, parsed into {headers, raw, events:[{event,data}], comments}. */
async function readSse(res) {
  const text = res.text;
  const events = [];
  const comments = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith(':')) { comments.push(line.slice(1).trim()); continue; }
    if (line.startsWith('event:')) {
      current = { event: line.slice(6).trim(), data: '' };
      continue;
    }
    if (line.startsWith('data:') && current) {
      current.data = JSON.parse(line.slice(5).trim());
      events.push(current);
      current = null;
    }
  }
  return { text, events, comments, headers: res.headers };
}

const withCookie = (req, token = 'user-jwt-alpha') => req.set('Cookie', `token=${encodeURIComponent(token)}`);

// ── WIRE-01: the two credential forms ──────────────────────────────────────────

describe('WIRE-01 — the browser session credential', () => {
  test('the httpOnly `token` cookie authenticates a JSON turn and is forwarded verbatim', async () => {
    const erp = fakeErp(async (p) => {
      if (p.endsWith('/snapshot')) return { data: { weight: 78.4 }, latency_ms: 1 };
      return { data: { data: { name: 'Rahul Sharma' } }, latency_ms: 1 };
    });
    const app = appWith(erp);

    const res = await withCookie(
      request(app).post('/ai/client-agent/chat')
        .send({ clientId: 'c-1', message: 'Summarize this client' }),
    );

    expect(res.status).toBe(200);
    // Every ERP call the turn made carried the SAME forwarded token — the
    // cookie value, untouched. Nothing was minted or rewritten.
    expect(erp.calls.length).toBeGreaterThan(0);
    for (const call of erp.calls) expect(call.userToken).toBe('user-jwt-alpha');
  });

  test('no credential at all → 401 before any ERP call or model spend', async () => {
    const erp = fakeErp(async () => { throw new Error('must not be called'); });
    const app = appWith(erp, streamingProvider());

    const res = await request(app)
      .post('/ai/client-agent/chat')
      .send({ clientId: 'c-1', message: 'hi' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('NO_TOKEN');
    expect(erp.calls).toHaveLength(0);
  });

  test('Authorization wins when both forms are present', async () => {
    const erp = fakeErp(async (p) => {
      if (p.endsWith('/snapshot')) return { data: {}, latency_ms: 1 };
      return { data: { data: { name: 'X' } }, latency_ms: 1 };
    });
    const app = appWith(erp);

    await withCookie(
      request(app).post('/ai/client-agent/chat')
        .set('Authorization', 'Bearer header-token')
        .send({ clientId: 'c-1', message: 'summary' }),
      'cookie-token');

    expect(erp.calls.every((c) => c.userToken === 'header-token')).toBe(true);
  });
});

// ── WIRE-01: accurate error codes ─────────────────────────────────────────────

describe('WIRE-01 — distinguishable failures', () => {
  test('unknown assistant route → NOT_FOUND (endpoint miss)', async () => {
    const app = appWith(fakeErp(async () => { throw new Error('no'); }));
    const res = await withCookie(
      request(app).post('/ai/client-agent/does-not-exist')
        .send({ clientId: 'c-1', message: 'x' }));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('invisible client → CLIENT_NOT_FOUND (authorisation, not a route miss)', async () => {
    const erp = fakeErp(async () => {
      const e = new Error('ERP responded 404'); e.status = 404; e.code = 'NOT_FOUND'; throw e;
    });
    const app = appWith(erp, streamingProvider());
    const res = await withCookie(
      request(app).post('/ai/client-agent/chat')
        .send({ clientId: 'c-not-mine', message: 'summary' }));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CLIENT_NOT_FOUND');
  });
});

// ── WIRE-01/MPS-03: the SSE stream contract ───────────────────────────────────

describe('WIRE-01 — /chat/stream is real server-sent events', () => {
  test('start → incremental chunks → done, consumed through the rewrite-free transport', async () => {
    const erp = fakeErp(async (p) => {
      if (p.endsWith('/snapshot')) return { data: { weight: 78.4 }, latency_ms: 1 };
      return { data: { data: { name: 'Rahul Sharma' } }, latency_ms: 1 };
    });
    const provider = streamingProvider();
    const app = appWith(erp, provider);

    const res = await withCookie(
      request(app).post('/ai/client-agent/chat/stream')
        .send({ clientId: 'c-1', message: 'Summarize attendance' }));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const sse = await readSse(res);
    const start = sse.events.find((e) => e.event === 'start');
    const chunks = sse.events.filter((e) => e.event === 'chunk');
    const done = sse.events.find((e) => e.event === 'done');
    const errors = sse.events.filter((e) => e.event === 'error');

    expect(errors).toHaveLength(0);
    // start carries real provenance, not placeholders.
    expect(start).toBeTruthy();
    expect(start.data.clientName).toBe('Rahul Sharma');
    expect(start.data.toolsUsed).toContain('getClientProfile');
    expect(start.data.requestId).toBeTruthy();
    // Chunks are DELTAS the frontend accumulates (`text += content`), and they
    // arrive during generation, not after it (the fake provider emitted
    // deltas while streaming). Each payload also carries the `type` field —
    // the field the browser parser actually switches on.
    expect(provider.seen[0].streamed).toBe(true);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].data.type).toBe('chunk');
    expect(chunks[0].data.content).toBe('The client attended');
    expect(chunks.at(-1).data.content).toBe(' 11 of 12 sessions.');
    // done is the JSON-contract answer, byte-for-byte the same shape /chat gives.
    expect(done.data.type).toBe('done');
    expect(done.data.message).toBe('The client attended 11 of 12 sessions.');
    expect(done.data.clientId).toBe('c-1');
    expect(done.data.toolsUsed).toContain('getClientProfile');
    expect(done.data.meta.requestId).toBeTruthy();
    expect(done.data.proposedAction).toBeNull();
  });

  test('a stream denial is a single error event, before any content', async () => {
    const erp = fakeErp(async () => {
      const e = new Error('ERP responded 404'); e.status = 404; e.code = 'NOT_FOUND'; throw e;
    });
    const app = appWith(erp, streamingProvider());
    const res = await withCookie(
      request(app).post('/ai/client-agent/chat/stream')
        .send({ clientId: 'c-not-mine', message: 'summary' }));

    expect(res.status).toBe(200); // stream opens, then the event carries the failure
    const sse = await readSse(res);
    expect(sse.events).toHaveLength(1);
    expect(sse.events[0].event).toBe('error');
    expect(sse.events[0].data.code).toBe('CLIENT_NOT_FOUND');
    // The status rides the event so the panel can map it like any HTTP answer.
    expect(sse.events[0].data.status).toBe(404);
    expect(sse.events[0].data.partial).toBe(false);
  });

  test('model failure mid-provider → error event; upstream failure before deltas counts attempts', async () => {
    const erp = fakeErp(async (p) => {
      if (p.endsWith('/snapshot')) return { data: {}, latency_ms: 1 };
      return { data: { data: { name: 'X' } }, latency_ms: 1 };
    });
    // Both models fail → ALL_MODELS_FAILED with attempts metadata.
    const provider = streamingProvider({ failFirst: true });
    const app = appWith(erp, provider);
    const res = await withCookie(
      request(app).post('/ai/client-agent/chat/stream')
        .send({ clientId: 'c-1', message: 'what about attendance?' }));
    const sse = await readSse(res);
    const errEvent = sse.events.find((e) => e.event === 'error');
    expect(errEvent.data.code).toBe('ALL_MODELS_FAILED');
  });
});

// ── MPS-01: quota gate ─────────────────────────────────────────────────────────

describe('MPS-01 — the studio quota gate', () => {
  test('enforce mode: an over-limit studio is refused with QUOTA_EXCEEDED, before model spend', async () => {
    const enforceCfg = load({ ...BASE_ENV, AI_QUOTA_MODE: 'enforce' });
    const erp = quotaErp({ over: true, enforcement_enabled: true, tokens_used: 1_000_000, limit: 1_000_000, used_pct: 100 });
    const provider = streamingProvider();
    const app = appWith(erp, provider, enforceCfg);
    const res = await withCookie(
      request(app).post('/ai/client-agent/chat')
        .send({ clientId: 'c-1', message: 'summary' }));

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(provider.seen).toHaveLength(0); // fail-closed: no tokens spent
  });

  test('enforce mode FAILS CLOSED when the quota cannot be verified', async () => {
    const enforceCfg = load({ ...BASE_ENV, AI_QUOTA_MODE: 'enforce' });
    const erp = fakeErp(async (p) => {
      if (p === '/api/ai/usage/service/quota') {
        const e = new Error('ERP responded 502'); e.status = 502; e.code = 'ERP_DENIED'; throw e;
      }
      return { data: { data: { name: 'X' } }, latency_ms: 1 };
    });
    const provider = streamingProvider();
    const app = appWith(erp, provider, enforceCfg);
    const res = await withCookie(
      request(app).post('/ai/client-agent/chat')
        .send({ clientId: 'c-1', message: 'summary' }));

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('QUOTA_UNVERIFIED');
    expect(provider.seen).toHaveLength(0);
  });

  test('monitor mode (default): over-limit is logged, not refused', async () => {
    const erp = quotaErp({ over: true, enforcement_enabled: true, tokens_used: 999, limit: 100, used_pct: 999 });
    const provider = streamingProvider();
    const app = appWith(erp, provider);
    const res = await withCookie(
      request(app).post('/ai/client-agent/chat')
        .send({ clientId: 'c-1', message: 'summary' }));
    expect(res.status).toBe(200);
  });

  test('quota off skips the endpoint entirely', async () => {
    const offCfg = load({ ...BASE_ENV, AI_QUOTA_MODE: 'off' });
    const erp = quotaErp({ over: true, enforcement_enabled: true });
    const app = appWith(erp, streamingProvider(), offCfg);
    await withCookie(request(app).post('/ai/client-agent/chat')
      .send({ clientId: 'c-1', message: 'summary' }));
    expect(erp.calls.some((c) => c.path === '/api/ai/usage/service/quota')).toBe(false);
  });

  test('enforce mode defers to the ERP switch: enforcement_enabled:false proceeds even when over', async () => {
    // The kill switch is the ERP's, not the service's. A studio the operator
    // turned enforcement off for must NOT be cut off by this service's mode.
    const enforceCfg = load({ ...BASE_ENV, AI_QUOTA_MODE: 'enforce' });
    const erp = quotaErp({ over: true, enforcement_enabled: false, tokens_used: 2_000_000, limit: 1_000_000, used_pct: 200 });
    const provider = streamingProvider();
    const app = appWith(erp, provider, enforceCfg);
    const res = await withCookie(request(app).post('/ai/client-agent/chat')
      .send({ clientId: 'c-1', message: 'summary' }));
    expect(res.status).toBe(200);
    expect(provider.seen).toHaveLength(1);
  });

  test('monitor mode proceeds even when the quota probe itself errors', async () => {
    const erp = fakeErp(async (p) => {
      if (p === '/api/ai/usage/service/quota') {
        const e = new Error('ERP responded 503'); e.code = 'ERP_DENIED'; throw e;
      }
      if (p.endsWith('/snapshot')) return { data: {}, latency_ms: 1 };
      return { data: { data: { name: 'X' } }, latency_ms: 1 };
    });
    const provider = streamingProvider();
    const app = appWith(erp, provider);
    const res = await withCookie(request(app).post('/ai/client-agent/chat')
      .send({ clientId: 'c-1', message: 'summary' }));
    expect(res.status).toBe(200);
    expect(provider.seen).toHaveLength(1); // monitoring blindness never stops the answer
  });
});

// ── MPS-01: usage ledger + ERP ingest report ──────────────────────────────────

describe('MPS-01 — the auditable usage record', () => {
  function tempLedgerEnv() {
    return load({ ...BASE_ENV, USAGE_LEDGER_FILE: path.join(os.tmpdir(), `usage-${process.pid}-${Date.now()}.jsonl`) });
  }

  test('a successful turn appends outcome-faithful rows with NO prompt and NO client data', async () => {
    const cfg = tempLedgerEnv();
    const erp = quotaErp({ over: false, enforcement_enabled: false });
    const app = appWith(erp, streamingProvider(), cfg);
    await withCookie(request(app).post('/ai/client-agent/chat')
      .send({ clientId: 'c-1', message: 'Summarize attendance and his salary feelings' }));

    const row = JSON.parse(fs.readFileSync(cfg.usageLedgerFile, 'utf8').trim().split('\n').pop());
    expect(row.outcome).toBe('ok');
    expect(row.request_id).toBeTruthy();
    expect(row.usage).toEqual({ prompt: 321, completion: 9, known: true });
    expect(row.attempts.map((a) => a.ok)).toEqual([true]);
    // The ledger is not a content store:
    const raw = fs.readFileSync(cfg.usageLedgerFile, 'utf8').trim();
    expect(raw).not.toContain('attendance');
    expect(raw).not.toContain('c-1');
    expect(raw).not.toContain('user-jwt-alpha');
    fs.unlinkSync(cfg.usageLedgerFile);
  });

  test('successes are reported into the ERP ledger with real identity resolved server-side', async () => {
    const cfg = tempLedgerEnv();
    const erp = quotaErp({ over: false, enforcement_enabled: false });
    const app = appWith(erp, streamingProvider(), cfg);
    await withCookie(request(app).post('/ai/client-agent/chat')
      .send({ clientId: 'c-1', message: 'summary' }));

    const ingest = erp.posts.find((p) => p.path === '/api/ai/usage/service/ingest');
    expect(ingest).toBeTruthy();
    expect(ingest.userToken).toBe('user-jwt-alpha');
    expect(ingest.body.outcome).toBe('ok');
    expect(ingest.body.promptTokens).toBe(321);
    expect(ingest.body.completionTokens).toBe(9);
    // The model recorded is the one actually used (provider echoes request → primary here).
    expect(ingest.body.model).toBe(cfg.AI_PRIMARY_MODEL);
    // No content, no client identifiers:
    const raw = JSON.stringify(ingest.body);
    expect(raw).not.toContain('c-1');
    expect(raw).not.toContain('summary');
    fs.unlinkSync(cfg.usageLedgerFile);
  });

  test('a failed model turn is recorded with its attempts and outcome, not faked as success', async () => {
    const cfg = tempLedgerEnv();
    const erp = fakeErp(async (p) => {
      if (p.endsWith('/snapshot')) return { data: {}, latency_ms: 1 };
      return { data: { data: { name: 'X' } }, latency_ms: 1 };
    });
    const app = appWith(erp, streamingProvider({ failFirst: true }), cfg);
    const res = await withCookie(request(app).post('/ai/client-agent/chat')
      .send({ clientId: 'c-1', message: 'summary' }));
    expect(res.status).toBe(503);

    const row = JSON.parse(fs.readFileSync(cfg.usageLedgerFile, 'utf8').trim().split('\n').pop());
    expect(row.outcome).toBe('model_failed');
    expect(row.attempts.map((a) => a.ok)).toEqual([false, false]);
    expect(row.attempts.every((a) => a.code)).toBe(true);
    fs.unlinkSync(cfg.usageLedgerFile);
  });

  test('ledger disabled (empty env value or default in tests) writes nothing', async () => {
    const erp = fakeErp(async (p) => p.endsWith('/snapshot')
      ? { data: {}, latency_ms: 1 }
      : { data: { data: { name: 'X' } }, latency_ms: 1 });
    // BASE_ENV (test) with no USAGE_LEDGER_FILE → disabled by default in tests.
    expect(config.usageLedgerFile).toBeNull();
    const app = appWith(erp, streamingProvider(), config);
    await withCookie(request(app).post('/ai/client-agent/chat')
      .send({ clientId: 'c-1', message: 'hi' }));
    // No crash, and reportUsage still went out.
    expect(erp.posts.some((p) => p.path === '/api/ai/usage/service/ingest')).toBe(true);
  });
});

// ── MPS-01: model allowlist (boot-time, fail-fast) ────────────────────────────

describe('MPS-01 — paid models are refused at boot', () => {
  test('a paid default model without an allowlist refuses to boot', () => {
    expect(() => load({ ...BASE_ENV, AI_PRIMARY_MODEL: 'openai/gpt-4o' }))
      .toThrow(/Refusing paid models|ALLOW_PAID_MODELS/);
  });

  test('ALLOW_PAID_MODELS=true is the explicit accept', () => {
    const cfg = load({ ...BASE_ENV, AI_PRIMARY_MODEL: 'openai/gpt-4o', ALLOW_PAID_MODELS: 'true' });
    expect(cfg.AI_PRIMARY_MODEL).toBe('openai/gpt-4o');
  });

  test('an explicit allowlist pins the surface exactly', () => {
    expect(() => load({
      ...BASE_ENV,
      AI_PRIMARY_MODEL: 'openai/gpt-4o',
      AI_ALLOWED_MODELS: 'meta/llama-3:free, openai/gpt-4o',
      AI_FALLBACK_MODEL: 'meta/llama-4:free', // not on the list
    })).toThrow(/does not include/);

    const cfg = load({
      ...BASE_ENV,
      AI_PRIMARY_MODEL: 'openai/gpt-4o',
      AI_FALLBACK_MODEL: 'openai/gpt-4o-mini',
      AI_ALLOWED_MODELS: 'openai/gpt-4o, openai/gpt-4o-mini',
    });
    expect(cfg.AI_PRIMARY_MODEL).toBe('openai/gpt-4o');
  });
});

// ── MPS-01: the provider never mills unknown usage into fake zeros ────────────

describe('MPS-01 — provider usage capture on the streamed path', () => {
  function sse(body, chunks, { ok = true, status = 200 } = {}) {
    const encoder = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i++]));
        } else {
          controller.close();
        }
      },
    });
    return Promise.resolve({
      ok,
      status,
      body: stream,
      json: async () => body,
    });
  }

  test('stream:true with a usage chunk yields exact tokens and usageKnown=true', async () => {
    const provider = createOpenRouterProvider({
      config,
      fetchImpl: async (url, init) => {
        expect(JSON.parse(init.body).stream).toBe(true);
        expect(JSON.parse(init.body).usage).toEqual({ include: true });
        return sse(null, [
          ': OPENROUTER PROCESSING\n\n',
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
          'data: {"usage":{"prompt_tokens":45,"completion_tokens":7,"model":"m"}}\n\n',
          'data: [DONE]\n\n',
        ]);
      },
      timeoutMs: 500,
    });
    const deltas = [];
    const out = await provider.generate({
      model: 'openai/gpt-oss-120b:free', messages: [{ role: 'user', content: 'x' }], onDelta: (c) => deltas.push(c),
    });
    expect(out.content).toBe('Hello there');
    expect(deltas).toEqual(['Hello', 'Hello there']);
    expect(out.usage).toEqual({ prompt: 45, completion: 7 });
    expect(out.usageKnown).toBe(true);
  });

  test('missing usage is null + usageKnown=false, never a silent zero', async () => {
    const provider = createOpenRouterProvider({
      config,
      fetchImpl: async () => sse(null, [
        'data: {"choices":[{"delta":{"content":"He"}</span>}]}\n\n',
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
        'data: [DONE]\n\n',
      ].map((c) => c.replace('</span>', ''))),
      timeoutMs: 500,
    });
    const out = await provider.generate({
      model: 'm:free', messages: [{ role: 'user', content: 'x' }],
    });
    expect(out.content).toBe('Hello');
    expect(out.usage).toEqual({ prompt: null, completion: null });
    expect(out.usageKnown).toBe(false);
  });

  test('junk lines do not kill the stream; a stream that dies yields AI_STREAM_FAILED', async () => {
    const badFetch = async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        pull(c) {
          c.enqueue(new TextEncoder().encode('data: not-json\n\n'));
          c.error(new Error('conn dropped'));
        },
      }),
    });
    const provider = createOpenRouterProvider({ config, fetchImpl: badFetch, timeoutMs: 500 });
    await expect(provider.generate({
      model: 'm:free', messages: [{ role: 'user', content: 'x' }],
    })).rejects.toMatchObject({ code: expect.stringMatching(/AI_STREAM_FAILED|AI_EMPTY/) });
  });

  test('non-ok before the stream keeps the typed provider error with status', async () => {
    const provider = createOpenRouterProvider({
      config,
      fetchImpl: async () => sse({}, ['data: {}'], { ok: false, status: 429 }),
      timeoutMs: 500,
    });
    await expect(provider.generate({
      model: 'm:free', messages: [{ role: 'user', content: 'x' }],
    })).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR', status: 429 });
  });
});

// ── MPS-02: registry endpoints are the live ERP paths ─────────────────────────

describe('MPS-02 — attendance/payments endpoints moved with the ERP', () => {
  test('the tools call the pt-os paths and the ERP answers feed the answer', async () => {
    const erp = fakeErp(async (p) => {
      if (p === '/api/pt-os/clients/c-1/attendance') return { data: { data: [{ date: '2026-10-12', status: 'present' }] }, latency_ms: 1 };
      if (p === '/api/pt-os/clients/c-1/payments') return { data: { data: [{ amount: 4000 }] }, latency_ms: 1 };
      if (p.endsWith('/snapshot')) return { data: {}, latency_ms: 1 };
      return { data: { data: { name: 'X' } }, latency_ms: 1 };
    });
    const app = appWith(erp, streamingProvider());

    const res = await withCookie(
      request(app).post('/ai/client-agent/chat')
        // Planner phrase "attendance" → getClientAttendance; "payments due" → getClientPayments.
        .send({ clientId: 'c-1', message: 'Show recent attendance and payments due for this client' }));

    expect(res.status).toBe(200);
    const paths = erp.calls.map((c) => c.path);
    expect(paths).toContain('/api/pt-os/clients/c-1/attendance');
    expect(paths).toContain('/api/pt-os/clients/c-1/payments');
    expect(paths.some((p) => p.includes('/api/clients/'))).toBe(false); // never the dead paths
  });
});

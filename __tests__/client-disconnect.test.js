'use strict';
// Audit P1-4 — a client that hangs up aborts the upstream generation.
//
// Before this, closing the panel left the model call running to completion:
// tokens were spent, usage was reported, and the heartbeat kept writing to a
// dead socket. The test uses a real HTTP socket because the disconnect signal
// is a transport event (`res.on('close')` with the response unfinished), and a
// fake request object would prove nothing about it.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { buildApp } = require('../src/app');
const { load } = require('../src/config');

const ledgerFile = path.join(os.tmpdir(), `disconnect-${process.pid}-${Date.now()}.jsonl`);

const config = load({
  NODE_ENV: 'test',
  AI_API_KEY: 'test-key',
  ERP_BACKEND_URL: 'https://erp.example.test',
  SERVICE_AUTH_SECRET: 'x'.repeat(48),
  ALLOWED_ORIGINS: 'https://app.example.test',
  USAGE_LEDGER_FILE: ledgerFile,
});

/** ERP answers everything the turn needs, and records what was written. */
function fakeErp() {
  const posts = [];
  return {
    posts,
    get: async (p) => {
      if (p === '/api/features') return { data: { data: { ai_suite: true } }, latency_ms: 1 };
      if (p === '/api/ai/usage/service/quota') {
        return { data: { data: { over: false, enforcement_enabled: false } }, latency_ms: 1 };
      }
      if (p.includes('/snapshot')) return { data: { data: {} }, latency_ms: 1 };
      return { data: { data: { name: 'Rahul Sharma' } }, latency_ms: 1 };
    },
    post: async (p, body) => {
      posts.push({ path: p, body });
      return { data: { ok: true }, latency_ms: 1 };
    },
  };
}

/** A provider that never answers — until the caller's signal aborts it. */
function hangingProvider() {
  const state = { calls: 0, aborted: false };
  let resolveAbort;
  const abortedOnce = new Promise((resolve) => { resolveAbort = resolve; });

  const provider = {
    name: 'fake',
    generate: async ({ signal }) => {
      state.calls += 1;
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          state.aborted = true;
          resolveAbort();
          const e = new Error('cancelled');
          e.code = 'AI_ABORTED';
          reject(e);
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        return undefined;
      });
    },
  };

  return { provider, state, abortedOnce };
}

const waitFor = async (check, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met in time');
};

const readLedger = () => (fs.existsSync(ledgerFile)
  ? fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

/** Start the app on a real socket, hand back the pieces a test needs. */
async function start(erp, provider) {
  const server = http.createServer(buildApp({ config, erp, provider }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** A request that stays open until the test destroys the socket. */
function send(port, route, body) {
  const req = http.request({
    host: '127.0.0.1',
    port,
    path: route,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'token=user-jwt-alpha',
      'Content-Length': Buffer.byteLength(body),
    },
  });
  req.on('error', () => {}); // the destroyed socket surfaces as ECONNRESET
  req.end(body);
  return req;
}

describe('P1-4 — closing the panel cancels the turn', () => {
  afterAll(() => {
    if (fs.existsSync(ledgerFile)) fs.unlinkSync(ledgerFile);
  });

  test('the stream stops, and the ledger records a cancellation', async () => {
    const erp = fakeErp();
    const { provider, state, abortedOnce } = hangingProvider();
    const server = await start(erp, provider);

    try {
      const req = send(server.port, '/ai/client-agent/chat/stream',
        JSON.stringify({ clientId: 'c-1', message: 'How is this client doing?' }));

      await waitFor(() => state.calls === 1);
      req.destroy();

      await abortedOnce;
      expect(state.aborted).toBe(true);

      // Recorded as cancelled, not as an answer and not as usage.
      await waitFor(() => readLedger().some((r) => r.outcome === 'client_disconnected'));
      const rows = readLedger().filter((r) => r.outcome === 'client_disconnected');
      expect(rows).toHaveLength(1);
      expect(rows[0].code).toBe('CLIENT_DISCONNECTED');

      expect(erp.posts.filter((p) => p.path === '/api/ai/usage/service/ingest')).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  test('the JSON route aborts too, and does not write to the dead socket', async () => {
    const erp = fakeErp();
    const { provider, state, abortedOnce } = hangingProvider();
    const server = await start(erp, provider);

    try {
      const req = send(server.port, '/ai/client-agent/chat',
        JSON.stringify({ clientId: 'c-1', message: 'How is this client doing?' }));

      await waitFor(() => state.calls === 1);
      req.destroy();

      await abortedOnce;
      await waitFor(() => readLedger().some((r) => r.outcome === 'client_disconnected'));

      expect(erp.posts.filter((p) => p.path === '/api/ai/usage/service/ingest')).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

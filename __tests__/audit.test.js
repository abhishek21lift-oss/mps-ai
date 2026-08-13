'use strict';
// §28, §29 — every AI database interaction must be auditable, and the audit
// trail must not itself become a place sensitive data lives.
//
// Two properties are being defended here and they pull against each other:
//
//   ENOUGH to reconstruct who accessed which client, when, through which tool,
//   and whether they were refused — including the enumeration pattern of one
//   actor probing many client ids.
//
//   NOT SO MUCH that the log is a second copy of the medical notes it exists to
//   audit access to. The trainer's question is free text into which client
//   names, injuries and phone numbers get typed; tool results are the records
//   themselves. Neither belongs here.

const { createAudit, actorFor } = require('../src/platform/audit/log');
const {
  fakeErp, okErp, appWith, post, fakeAuditSink, fixedClock, configWith, ERP_ERR,
} = require('./helpers');

const config = configWith();

function auditing() {
  const sink = fakeAuditSink();
  return { sink, audit: createAudit({ config, sink }) };
}

describe('the actor is pseudonymous, stable and non-reversible', () => {
  const secret = 'x'.repeat(48);

  test('the same token always yields the same actor', () => {
    expect(actorFor('tok-a', secret)).toBe(actorFor('tok-a', secret));
  });

  test('different tokens yield different actors', () => {
    expect(actorFor('tok-a', secret)).not.toBe(actorFor('tok-b', secret));
  });

  test('the token itself never appears in the actor', () => {
    const token = 'header.payload.signature-that-is-a-live-credential';
    const actor = actorFor(token, secret);
    expect(actor).not.toContain('signature');
    expect(token).not.toContain(actor);
    expect(actor).toMatch(/^[a-f0-9]{16}$/);
  });

  test('rotating the secret rotates the actor', () => {
    expect(actorFor('tok-a', secret)).not.toBe(actorFor('tok-a', 'y'.repeat(48)));
  });

  test('no token is "anonymous", not a hash of undefined', () => {
    expect(actorFor(null, secret)).toBe('anonymous');
  });
});

describe('an answered request is recorded', () => {
  test('with the tools, model, tokens, latency and the client asked about', async () => {
    const { sink, audit } = auditing();
    const { app } = appWith({ erp: okErp({ weight: 78.4 }), audit, clock: fixedClock() });

    await post(app, { clientId: 'c-rahul', message: 'Summarize this client' });

    const req = sink.events.find((e) => e.event === 'ai_request');
    expect(req).toMatchObject({
      audit: true,
      agent: 'client',
      clientId: 'c-rahul',
      outcome: 'answered',
      status: 200,
      used_fallback: false,
    });
    expect(req.actor).toMatch(/^[a-f0-9]{16}$/);
    expect(req.tools_ok).toBeGreaterThan(0);
    expect(req.tokens_prompt).toBe(10);
    expect(req.latency_ms).toEqual(expect.any(Number));
    expect(req.ts).toEqual(expect.any(String));
  });

  test('every tool invocation is recorded with its arguments', async () => {
    const { sink, audit } = auditing();
    const { app } = appWith({ erp: okErp(), audit, clock: fixedClock() });

    await post(app, { clientId: 'c-1', message: 'What are his dues?' });

    const tools = sink.events.filter((e) => e.event === 'ai_tool_call');
    expect(tools.length).toBeGreaterThan(1);
    expect(tools.map((t) => t.tool)).toContain('getClientProfile');
    for (const t of tools) {
      expect(t.args).toEqual({ clientId: 'c-1' });
      expect(t.ok).toBe(true);
    }
  });

  test('truncation is recorded exactly, not inferred', async () => {
    const erp = fakeErp(async (path) => {
      if (path.endsWith('/attendance')) return { data: 'row\n'.repeat(20_000), latency_ms: 1 };
      if (path.endsWith('/snapshot')) return { data: { ok: 1 }, latency_ms: 1 };
      return { data: { data: { name: 'R' } }, latency_ms: 1 };
    });
    const { sink, audit } = auditing();
    const { app } = appWith({
      erp,
      audit,
      clock: fixedClock(),
      config: configWith({ MAX_TOOL_RESULT_CHARS: '2000', MAX_CONTEXT_CHARS: '4000' }),
    });

    await post(app, { clientId: 'c-1', message: 'How is his attendance?' });

    const req = sink.events.find((e) => e.event === 'ai_request');
    // Named precisely — "something was truncated" is not actionable six weeks
    // later when someone asks why an answer hedged.
    expect(req.truncated_tools).toContain('getClientAttendance');
    expect(req.context_chars).toBeLessThanOrEqual(4000);
  });
});

describe('refusals are recorded at warn, so enumeration surfaces', () => {
  test('a cross-tenant 404 produces a denial event', async () => {
    const { sink, audit } = auditing();
    const { app } = appWith({ erp: fakeErp(async () => ERP_ERR(404)), audit, clock: fixedClock() });

    const res = await post(app, { clientId: 'c-other-tenant', message: 'summary' });

    expect(res.status).toBe(404);

    const denial = sink.events.find((e) => e.event === 'ai_denied');
    expect(denial).toMatchObject({
      level: 'warn',
      clientId: 'c-other-tenant',
      code: 'NOT_FOUND',
      status: 404,
    });

    const req = sink.events.find((e) => e.event === 'ai_request');
    expect(req).toMatchObject({ outcome: 'denied', status: 404 });
  });

  test('one actor probing many client ids is reconstructible from the trail', async () => {
    const { sink, audit } = auditing();
    const { app } = appWith({ erp: fakeErp(async () => ERP_ERR(404)), audit, clock: fixedClock() });

    for (const id of ['c-1', 'c-2', 'c-3', 'c-4']) {
      await post(app, { clientId: id, message: 'summary' }, 'the-same-token');
    }

    const denials = sink.events.filter((e) => e.event === 'ai_denied');
    expect(denials).toHaveLength(4);
    // One actor, four distinct targets — the shape of enumeration.
    expect(new Set(denials.map((d) => d.actor)).size).toBe(1);
    expect(new Set(denials.map((d) => d.clientId)).size).toBe(4);
  });

  test('a 403 is recorded as a denial, not as a failure', async () => {
    const { sink, audit } = auditing();
    const { app } = appWith({ erp: fakeErp(async () => ERP_ERR(403)), audit, clock: fixedClock() });

    await post(app, { clientId: 'c-x', message: 'summary' });

    expect(sink.events.find((e) => e.event === 'ai_denied')).toMatchObject({ status: 403 });
  });
});

describe('what must never be written to the audit trail', () => {
  test('not the bearer token, the question, or any retrieved record', async () => {
    const SECRET_QUESTION = 'Does Rahul Sharma still have that rotator cuff injury?';
    const RECORD = 'diagnosed with a partial supraspinatus tear';
    const TOKEN = 'jwt-header.jwt-payload.jwt-signature';

    const { sink, audit } = auditing();
    const { app } = appWith({
      erp: okErp({ injuries: RECORD }),
      audit,
      clock: fixedClock(),
    });

    await post(app, { clientId: 'c-1', message: SECRET_QUESTION }, TOKEN);

    const dump = JSON.stringify(sink.events);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain('jwt-signature');
    expect(dump).not.toContain(SECRET_QUESTION);
    expect(dump).not.toContain('rotator cuff');
    expect(dump).not.toContain(RECORD);
    expect(dump).not.toContain('supraspinatus');
    // The client's NAME is a record too — the opaque id is what belongs here.
    expect(dump).not.toContain('Rahul Sharma');
    // But the trail is still useful: the id and the tools are present.
    expect(dump).toContain('c-1');
    expect(dump).toContain('getClientProfile');
  });

  test('the model answer is not copied into the trail', async () => {
    const { sink, audit } = auditing();
    const provider = {
      name: 'fake',
      seen: [],
      generate: async () => ({
        content: 'His outstanding balance is 4,500 rupees.',
        model: 'm',
        usage: { prompt: 1, completion: 1 },
        latency_ms: 1,
      }),
    };
    const { app } = appWith({ erp: okErp(), provider, audit, clock: fixedClock() });

    await post(app, { clientId: 'c-1', message: 'balance?' });

    expect(JSON.stringify(sink.events)).not.toContain('4,500');
  });
});

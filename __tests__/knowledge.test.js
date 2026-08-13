'use strict';
// Studio knowledge retrieval — the RAG wiring.
//
// RUNBOOK stage 5 describes this as two changes: register the tool, pass a
// non-null knowledgeBase. The tests here exist because those two alone are not
// only insufficient, they are a REGRESSION — and nothing in the suite caught
// that, because every existing assertion about RAG stops at the classifier.
//
// What ragAvailable does on its own is REMOVE honest refusals: RAG_QUERY stops
// short-circuiting on "I don't have your policy documents", and
// DATABASE_PLUS_RAG drops the directive that says the same thing. If no
// retrieval follows, the model answers a policy question from the client's
// snapshot with no policy in front of it and no caveat — a fabricated policy
// stated as the studio's own.
//
// So the assertions below are mostly not "does it retrieve". They are "when it
// cannot retrieve, does it still say so".

const {
  configWith, fakeErp, fakeAuditSink, appWith, post, systemOf, contextOf, fixedClock,
} = require('./helpers');

const RAG_ON = configWith({ AI_KNOWLEDGE_ENABLED: 'true' });

const POLICY_Q = "What's our cancellation policy?";
const MIXED_Q = 'According to our refund policy, which of his cancelled sessions this month qualify?';
const RECORDS_Q = 'When does his package expire?';

const KNOWLEDGE_PATH = '/api/ai/knowledge/search';
const isKnowledge = (c) => c.path.startsWith(KNOWLEDGE_PATH);

/**
 * An ERP that answers the knowledge search with whatever it is given, and
 * everything else the way okErp does.
 */
const erpWithKnowledge = (knowledge) => fakeErp(async (path) => {
  if (path.startsWith(KNOWLEDGE_PATH)) return { data: { data: knowledge }, latency_ms: 1 };
  if (path.endsWith('/snapshot')) return { data: {}, latency_ms: 1 };
  return { data: { data: { name: 'Rahul Sharma' } }, latency_ms: 1 };
});

const SOME_CHUNKS = {
  chunks: [{
    content: 'Cancellations require 24 hours notice.',
    title: 'Studio Policy Handbook',
    category: 'policy',
    document_id: 'doc-1',
    chunk_index: 0,
    similarity: 0.82,
  }],
  documents_available: 3,
  scope: 'organization',
};

describe('the knowledge base is only consulted when there is one', () => {
  test('off by default — a policy question still short-circuits honestly', async () => {
    const { app, erp, provider } = appWith({ erp: erpWithKnowledge(SOME_CHUNKS), clock: fixedClock() });

    const res = await post(app, { clientId: 'c-1', message: POLICY_Q });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/don't have your studio's policy documents/i);
    // Nothing was retrieved and no model was called: the honest answer is a
    // fact about this service, and it costs nothing to state.
    expect(erp.calls.filter(isKnowledge)).toHaveLength(0);
    expect(provider.seen).toHaveLength(0);
  });

  test('on: the same question retrieves from the studio library instead', async () => {
    const { app, erp } = appWith({
      erp: erpWithKnowledge(SOME_CHUNKS), config: RAG_ON, clock: fixedClock(),
    });

    const res = await post(app, { clientId: 'c-1', message: POLICY_Q });

    expect(res.status).toBe(200);
    const calls = erp.calls.filter(isKnowledge);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].path, 'https://erp.test').searchParams.get('q')).toBe(POLICY_Q);
    // Forwarded under the CALLER's token, like every other read — the ERP
    // resolves the studio from it and answers requireStaff from it.
    expect(calls[0].userToken).toBe('user-jwt-alpha');
  });

  test('a records question never touches the library, even with RAG on', async () => {
    // Cost and minimisation both: "when does his package expire?" has no policy
    // in it, and sending the trainer's question to an embedding model to
    // discover that is a charge against the studio's quota for nothing.
    const { app, erp } = appWith({
      erp: erpWithKnowledge(SOME_CHUNKS), config: RAG_ON, clock: fixedClock(),
    });

    await post(app, { clientId: 'c-1', message: RECORDS_Q });

    expect(erp.calls.filter(isKnowledge)).toHaveLength(0);
  });

  test('a mixed records-and-policy question retrieves both halves', async () => {
    const { app, erp } = appWith({
      erp: erpWithKnowledge(SOME_CHUNKS), config: RAG_ON, clock: fixedClock(),
    });

    await post(app, { clientId: 'c-1', message: MIXED_Q });

    expect(erp.calls.filter(isKnowledge)).toHaveLength(1);
    // ...and the client reads still happened alongside it.
    expect(erp.calls.some((c) => c.path.includes('c-1'))).toBe(true);
  });
});

describe('the retrieved policy reaches the model as fenced, attributed text', () => {
  test('the passage and its document are in the context block', async () => {
    const { app, provider } = appWith({
      erp: erpWithKnowledge(SOME_CHUNKS), config: RAG_ON, clock: fixedClock(),
    });

    await post(app, { clientId: 'c-1', message: POLICY_Q });

    const ctx = contextOf(provider);
    expect(ctx.content).toContain('Cancellations require 24 hours notice.');
    expect(ctx.content).toContain('studio policy documents');
    // Nothing to apologise for: the classifier's no-policy directive is gone
    // because there IS a policy in front of the model now.
    expect(systemOf(provider)).not.toMatch(/no access to policy documents/i);
  });
});

/* ── The three silences ──────────────────────────────────────────────────────
   These are the reason the ERP endpoint returns documents_available at all, and
   the reason this wiring is more than a boolean. An assistant told only that
   the result was empty reports "the studio has no refund policy" about a studio
   that has one — it just has not uploaded it. */

describe('an empty library and an empty result are different answers', () => {
  const directiveOf = (provider) => systemOf(provider);

  test('nothing uploaded: says the library is empty, not that no policy exists', async () => {
    const { app, provider } = appWith({
      erp: erpWithKnowledge({ chunks: [], documents_available: 0, scope: 'organization' }),
      config: RAG_ON,
      clock: fixedClock(),
    });

    await post(app, { clientId: 'c-1', message: POLICY_Q });

    const system = directiveOf(provider);
    expect(system).toMatch(/NOT UPLOADED any policy documents/i);
    expect(system).toMatch(/may well have a written policy that simply is not in the app/i);
    expect(system).toMatch(/Do not state, summarise, paraphrase or infer what any policy says/i);
  });

  test('uploaded but irrelevant: says nothing covers it, not that none exists', async () => {
    const { app, provider } = appWith({
      erp: erpWithKnowledge({ chunks: [], documents_available: 4, scope: 'organization' }),
      config: RAG_ON,
      clock: fixedClock(),
    });

    await post(app, { clientId: 'c-1', message: POLICY_Q });

    const system = directiveOf(provider);
    // Whitespace-tolerant: the directive is wrapped prose, and the sentence
    // under test spans a line break.
    expect(system).toMatch(/none of them contain a passage relevant/i);
    expect(system).toMatch(/not that the studio\s+has no policy, which you do not know/i);
  });

  test('retrieval failed: says it could not check, and still answers the records half', async () => {
    const erp = fakeErp(async (path) => {
      if (path.startsWith(KNOWLEDGE_PATH)) {
        const e = new Error('ERP responded 503');
        e.status = 503;
        throw e;
      }
      if (path.endsWith('/snapshot')) return { data: {}, latency_ms: 1 };
      return { data: { data: { name: 'Rahul Sharma' } }, latency_ms: 1 };
    });

    const { app, provider } = appWith({ erp, config: RAG_ON, clock: fixedClock() });
    const res = await post(app, { clientId: 'c-1', message: MIXED_Q });

    expect(res.status).toBe(200);
    const system = directiveOf(provider);
    expect(system).toMatch(/could not be reached for this answer/i);
    expect(system).toMatch(/Do not state, summarise, paraphrase or infer what any policy says/i);
  });

  test('a found passage carries no directive at all', async () => {
    const { app, provider } = appWith({
      erp: erpWithKnowledge(SOME_CHUNKS), config: RAG_ON, clock: fixedClock(),
    });

    await post(app, { clientId: 'c-1', message: POLICY_Q });

    const system = directiveOf(provider);
    expect(system).not.toMatch(/NOT UPLOADED/i);
    expect(system).not.toMatch(/could not be reached/i);
    expect(system).not.toMatch(/none of them contain a passage/i);
  });
});

describe('cost and privacy at the boundary', () => {
  test('a long question is truncated to the ERP cap, not refused', async () => {
    // The alternative is a BAD_ARGS that silently costs the trainer the policy
    // half of their answer for typing too much.
    const long = `${'refund policy '.repeat(80)}?`;
    expect(long.length).toBeGreaterThan(500);

    const { app, erp } = appWith({
      erp: erpWithKnowledge(SOME_CHUNKS), config: RAG_ON, clock: fixedClock(),
    });

    const res = await post(app, { clientId: 'c-1', message: long });

    expect(res.status).toBe(200);
    const [call] = erp.calls.filter(isKnowledge);
    expect(call).toBeDefined();
    const q = new URL(call.path, 'https://erp.test').searchParams.get('q');
    expect(q.length).toBeLessThanOrEqual(500);
  });

  test('the audit records the query length, never the question itself', async () => {
    // The audit stream pseudonymises the actor on purpose. Writing the
    // trainer's free text into it would undo part of that for no investigative
    // gain — a length is enough to spot a pasted document.
    const sink = fakeAuditSink();
    const { createAudit } = require('../src/platform/audit/log');
    const { app } = appWith({
      erp: erpWithKnowledge(SOME_CHUNKS),
      config: RAG_ON,
      clock: fixedClock(),
      audit: createAudit({ config: RAG_ON, sink }),
    });

    await post(app, { clientId: 'c-1', message: POLICY_Q });

    const call = sink.events.find((e) => e.tool === 'searchStudioKnowledge');
    expect(call).toBeDefined();
    expect(call.args).toEqual({ q_chars: POLICY_Q.length, topK: null });
    expect(JSON.stringify(sink.events)).not.toContain('cancellation policy');
  });
});

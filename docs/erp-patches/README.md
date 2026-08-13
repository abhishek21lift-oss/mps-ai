# Patches for `619-erp-backend`

**These do not belong to this repository.** They are changes to the ERP that
this service depends on, kept here only because the session that wrote them
could read `619-erp-backend` but was not authorised to push to it, and an
unpushed commit in an ephemeral container is a commit that no longer exists
tomorrow.

Apply them in a checkout of the ERP, not here:

```bash
cd /path/to/619-erp-backend
git checkout -b claude/ai-knowledge-search
git am < /path/to/mps-ai/docs/erp-patches/0001-ai-knowledge-search.patch
npx jest src/__tests__/aiKnowledge.search.test.js
```

Delete a patch once it has landed upstream. A patch file that outlives its merge
is a trap: the next person to read this directory cannot tell whether it is
pending work or a fossil, and applying it twice is a confusing failure.

---

## 0001 — `GET /api/ai/knowledge/search`

**Status:** written and tested against `619-erp-backend` @ `3c841d2`; **not
pushed** (no push credential in that session). 21 tests passing, lint clean.

**Why it exists.** `retrieveContext()` is reachable only from inside
`routes/ai.js`, so the ERP's own AI Coach is the only thing that can be grounded
in a studio's uploaded SOPs, guides and policies. This service answers policy
questions too, and with nothing to retrieve it can only say *"I don't have your
policy documents"* — correct, and less useful than the answer already sitting in
the library.

**What it adds.** One read endpoint on the existing `/api/ai/knowledge` router,
returning the studio's own chunks with the document each came from. No answer
generation and no summarising — a retrieval endpoint that paraphrases is a
second place for a policy to be quietly reworded.

Decisions worth reviewing rather than assuming:

- **`requireStaff`, not `requireRole('admin','manager')`.** Uploading, deleting
  and reindexing are custodial acts over a shared resource and stay restricted.
  *Reading* what a policy says is what the policy is for, and the people asking
  "how long is the notice period?" mid-shift are trainers and reception.
  `member` is still excluded.
- **A platform-wide `super_admin` gets an empty result**, not every tenant's
  documents. A similarity search across the whole platform is not a query anyone
  should be able to run, and `retrieveContext()` already fails closed the same
  way on a null org.
- **`documents_available` is returned alongside the chunks.** This is the
  difference between "this studio has uploaded no policies" and "nothing in the
  policies covers that". An assistant told only that the result was empty will
  report the first as the second — which is how "we have no refund policy" gets
  said about a studio that has one.
- **`q` capped at 500 characters, `topK` clamped to 10.** The route sits inside
  `requireAiQuota()` and embedding cost scales with what is sent, so a pasted
  document must not be chargeable to the studio.
- **Retrieval failures answer empty rather than 500**, matching the AI Coach's
  own posture — a cold embedding model should not take the search box down.

### Once it lands

On this side the remaining work is small, because the branch was built ahead of
it and is already tested:

1. Register a `searchStudioKnowledge` tool in `platform/tools/registry.js` over
   `GET /api/ai/knowledge/search`.
2. Pass a non-null `knowledgeBase` into `createClientAgent` (`app.js`).

That flips the classifier's `ragAvailable` branch, which already exists and is
covered — `router.test.js` asserts both the `ragAvailable: true` and the
`false` paths today. `RAG_QUERY` stops short-circuiting and starts retrieving;
`DATABASE_PLUS_RAG` drops its "I don't have your policy documents" directive.

See [`../ERP-INTEGRATION-FACTS.md`](../ERP-INTEGRATION-FACTS.md) §5.

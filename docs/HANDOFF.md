# Handoff

You are continuing work that was done in an earlier session which could **read**
`619-erp-backend` and `619-erp-frontend` but could not push to either. If you
have both repos attached, the first job is to land two patches that are already
written and tested.

Read this file, then [RUNBOOK.md](./RUNBOOK.md). Do not re-derive the analysis —
it is in [ERP-INTEGRATION-FACTS.md](./ERP-INTEGRATION-FACTS.md) and
[DECISIONS.md](./DECISIONS.md).

---

## Where things stand

`mps-ai`, branch `claude/clone-32ymkj`, pushed. **461 tests, 14 suites, lint
clean.** The service boots and serves; it has never run against a real ERP or a
real model.

Two patches wait in `docs/erp-patches/`, both `git format-patch` output:

| Patch | What | Priority |
|---|---|---|
| `0003-staff-only-routers.patch` | Gates ten ERP routers behind `requireStaff` | **Do this first — live privilege issue** |
| `0001-ai-knowledge-search.patch` | Adds `GET /api/ai/knowledge/search`, unblocks RAG | After 0003 |

### 0003 is the one that matters

`requireStaff` went in for `/api/pt-os` and stopped there. Ten routers still
have the old shape, so a **client-portal login** can read its own studio's staff
data: `GET /api/clients` returns `SELECT c.*` over up to 1000 rows — names,
mobiles, emails, balances, notes, injuries — plus `/api/reports/revenue` and
`/api/reports/dues`.

Not a cross-tenant leak; `tenantScope()` holds. A privilege one.

Verified safe before gating: **the client portal calls exactly one endpoint,
`/api/me`.** No screen under `app/(bare)/member`, `/client` or `/member-login`
touches any router in the patch.

Apply order and verification commands are in RUNBOOK.md stages 1 and 5. Delete
each patch file once it lands — a patch that outlives its merge is a trap.

---

## Things you should not re-litigate

These were decided with reasons; changing them needs a reason, not a preference.

**Studio-wide questions stay in the ERP's assistant** (DECISIONS.md D1). The ERP
already has `lib/ai/tools.js` — tenant-scoped, role-declared, with `revenue_summary`
and `dues_summary` restricted to admin/manager. Building a second set here means
two tool layers over one database, and the copy nobody watches is the one that
drifts. This service goes *deeper on one client*, not wider.

**The intent classifier is not a security control.** `UNAUTHORIZED_REQUEST`
states a fact about capability ("no tool here returns other clients"), never
entitlement ("you may not see that") — this service cannot read the caller's
role. Authorisation runs first on every turn, before the classifier's opinion is
consulted. If you find yourself relying on a regex to keep data safe, stop.

**This service holds no role model and must not acquire one.** The ERP resolves
role from Postgres per request and returns 403; the tool layer relays that as a
denial. A second role model here would be the drift problem again.

**`prepare()` is shared between the buffered and streaming paths on purpose.**
That ordering — classify, authorise, short-circuit, plan, retrieve, budget,
fence — *is* the security design. A second copy is the one that ends up missing
a step.

---

## The method that kept working

Six documented claims about neighbouring repos turned out wrong once the source
could actually be read — including one security claim, and one that would have
made the product return 401 to every real request while all 300+ tests passed.

**Take a written claim and check it against source.** That is what found:

- the SSE contract mismatch (the frontend was already written against a
  different one)
- cookie auth (the browser cannot send a Bearer header — the cookie is
  `httpOnly` and `sameSite:'strict'`)
- the planner matching no inflected word at all — 6 of 26 realistic questions
- `/api/progress`, then nine more routers, ungated
- no `.dockerignore`, in a service whose security story is "it holds nothing
  worth stealing"

If a doc here asserts something about the ERP or the frontend, treat it as
unverified until you have opened the file it describes.

---

## Not verified — do not repeat these as fact

| Claim | Why it is open |
|---|---|
| `.dockerignore` keeps `.env` out of the image | Ignore rules checked against Docker's `fnmatch` semantics, but **the image was never built** — CLI present, no daemon. RUNBOOK 4.4 is the one command that settles it. |
| The nginx and compose layout in RUNBOOK stage 3 | Inferred from three repos; nobody saw the VPS. The backend's `infra/nginx/README.md` says that folder is a template, not the live config. |
| Anything about real-world behaviour | 461 tests, every one against a fake ERP and a fake model. Nobody has seen this answer a real question about a real client. |

That last one is the largest gap and no amount of further work in this repo
closes it. Fakes cannot tell you whether the free-tier model respects the
grounding rules under a long client note, whether `MAX_TOOL_RESULT_CHARS: 6000`
truncates constantly on a four-year member, or whether `grounding.unverified`
fires often enough on *correct* answers to get ignored — which is the exact
failure it was designed against.

---

## If you want the next piece of work

In rough order of value:

1. **Land 0003.** Then 0001, then the two-line RAG wiring in RUNBOOK stage 5.
2. **Run it for real** against a staging ERP with one real client, and read the
   answer rather than the test output.
3. **`grounding`** exists and the frontend has a slot for it, but no UI renders
   it yet. Check `619-erp-frontend`'s Ask AI panel before building anything.
4. Open decisions that are the owner's, not yours: making `client_id` required
   on the nine `/api/progress` GETs; trainer-level object authorisation
   (`requireTrainerOwnership` exists and is mounted nowhere); where feedback and
   eval results would be stored, given this service is deliberately stateless.

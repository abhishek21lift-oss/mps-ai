# Decisions

Short records of choices that would otherwise be re-litigated by whoever reads
this next, or — worse — quietly reversed by someone who never knew they were
choices.

---

## D1 · Studio-wide questions stay in the ERP's assistant

**Date:** 2026-08-13 · **Status:** accepted · **Supersedes:** the Phase 5/6 plan
in [PHASE-0-DISCOVERY.md](./PHASE-0-DISCOVERY.md) §13

### Context

The original brief asked for studio-wide tools here — `get_revenue`,
`get_dashboard_metrics`, `get_expiring_memberships`, `get_trainer_performance`
and so on — plus a role model deciding which role may run which tool.

That plan was written before `619-erp-backend` could be read. Once it could, it
turned out the ERP **already has all of it**:

- `lib/ai/tools.js` — a tool layer built on the same design decisions as this
  service, including choosing application-layer pattern matching over
  model-driven function calling for the same stated reason (free-tier models
  emit `tool_calls` unreliably).
- Every tool tenant-scoped through the same `tenantScope()` every other route
  uses, and **role-declared**: `revenue_summary` and `dues_summary` are
  restricted to `admin`/`manager`, while `client_stats`, `find_client`,
  `attendance_summary` and `trainer_roster` also admit `trainer` and
  `reception`.
- Denials reported honestly rather than dropped, so the model can say what it
  could not see instead of fabricating around it.

See [ERP-INTEGRATION-FACTS.md](./ERP-INTEGRATION-FACTS.md) §6 for the full
inventory.

### Decision

**This service does not build studio-wide tools.** It stays a single-client
agent and invests in depth on that one client. Studio-wide questions are
answered by the assistant in the main app.

The intent classifier's `UNAUTHORIZED_REQUEST` response points there explicitly
rather than dead-ending, so the boundary reads as a signpost rather than an
obstruction.

### Why

The reason is not that duplicated work is wasteful. It is that **two tool layers
over one database means two places a tenant predicate or a role list can be
edited, and the copy nobody is looking at is the one that goes wrong.**

That is the same argument this service already makes for not re-implementing
`orgWhere()`, and for holding no role model of its own. Applying it to
`orgWhere()` and then not applying it to an entire second tool layer would be
inconsistent in the direction that costs a cross-tenant leak.

The brief's own §11 says it plainly: *"DO NOT duplicate functionality that
already exists. Reuse the strongest existing abstractions."*

### Consequences

- A user has two assistants: one for the client in front of them, one for the
  studio. Accepted; mitigated by the redirect in the refusal text.
- Phase 5 (studio tools) is **closed as won't-build-here**, not deferred.
- Phase 6 (role gating) is **satisfied by design**: this service cannot read a
  role, the ERP resolves it from Postgres per request, and a role-gated endpoint
  returns 403 which the tool layer relays as a denial rather than an outage.
  Building a second role model here is explicitly rejected by this decision.
- If the two assistants should later merge, the direction is to expose the ERP's
  existing tools as read endpoints and register tools over them
  (ERP-INTEGRATION-FACTS §6, option B) — **not** to reimplement them here.

---

## D2 · Depth over breadth: the training-log tools

**Date:** 2026-08-13 · **Status:** accepted · **Follows from:** D1

Having declined to widen, the useful direction is deeper on the one client. Two
tools were added over endpoints verified to exist:

| Tool | ERP endpoint |
|---|---|
| `getClientTrainingAnalytics` | `GET /api/pt-os/workout-log/analytics?client_id=&weeks=` |
| `getClientVolumeSummary` | `GET /api/pt-os/workout-log/volume-summary?client_id=&group_by=` |

These are the first tools to pass the client as a **query parameter** rather
than a path segment. That is the ERP's shape for them, not a choice made here,
and the tenant boundary is unchanged: `/workout-log/analytics` calls
`clientInOrg()` and answers 404 for a client outside the caller's organisation,
exactly as the by-id routes do.

`analytics` was chosen partly for what it refuses to do. Its own source comment:

> *Everything returned is either MEASURED from the log or a range the studio
> stored. Nothing is modelled. There is deliberately no "fatigue score" and no
> "recovery percentage" — those would be invented numbers printed beside real
> ones in the same typeface, and a trainer would have no way to tell them apart.*

That is the same standard this service holds itself to, which makes it a safe
thing to ground an answer in.

### `as_of` is deliberately not sent

The endpoint accepts one, and the ERP has its own `studioToday()`. Supplying
ours would give a single request two opinions about what day it is — the same
class of bug as two opinions about the active tenant, and rejected for the same
reason.

---

## D3 · The intent classifier is not a security control

**Date:** 2026-08-13 · **Status:** accepted

Recorded because it is the easiest thing here to misread, and misreading it in
the safe-looking direction is what would make it dangerous.

`UNAUTHORIZED_REQUEST` states a fact about **capability** ("no tool here returns
other clients"), never about **entitlement** ("you may not see that"). This
service cannot make the second kind of statement: the JWT carries
`{ id, token_version }` and there is no key here to verify it with, so it cannot
read the caller's role at all.

Keyword classification fails in both directions and the suite tests both:
a paraphrase that slips through is classified `DATABASE_QUERY` and **still**
retrieves only the one authorised client; a legitimate question that is
over-refused costs usefulness, never confidentiality.

**Authorisation runs first on every turn**, before the classifier's opinion is
consulted — including for smalltalk, including for turns that will short-circuit.
Anyone tempted to skip the ERP read "because the message is obviously harmless"
should note that "obviously harmless" is a regex verdict, and a regex is not an
authorisation decision.

---

## D4 · One studio-scoped tool, enumerated by name

**Date:** 2026-08-13 · **Status:** accepted · **Refines:** [D1](#d1--studio-wide-questions-stay-in-the-erps-assistant)

Recorded because it moves a boundary the test suite was enforcing absolutely,
and the next person to hit that suite deserves to find a reason rather than a
weakened regex.

### Context

RUNBOOK stage 5 asks for a `searchStudioKnowledge` tool over the ERP's
`GET /api/ai/knowledge/search`, so policy questions can be answered from the
studio's own uploaded SOPs instead of refused. Four tests refused it:

| Test | Asserted |
|---|---|
| `redteam 01` | every tool's schema contains `clientId` |
| `redteam 15`, `26` | every tool name starts with `getClient` |
| `security.test.js` | the same, as part of the closed tool surface |

`redteam.test.js` anticipates this moment in a comment: an earlier version of 01
demanded every tool take *exactly* `['clientId']`, and the author noted that
failing it "would have pushed whoever hit it toward loosening the check rather
than reading it."

### Decision

The tool is registered, and the invariant is **re-expressed rather than
relaxed**:

- **Unchanged and absolute:** no tool may take a parameter that names a tenant.
  `/org|tenant|studio|branch|company|location|user|role|trainer/` still applies
  to every schema including this one, which takes `{ q, topK }`.
- **Unchanged and absolute:** no tool is a write.
- **Narrowed:** "every tool is a single-client read" becomes "every tool is a
  single-client read except those in `STUDIO_DOCUMENT_TOOLS`", a list in
  `__tests__/helpers.js` asserted by value to be exactly
  `['searchStudioKnowledge']`.

A second studio-scoped tool therefore fails `redteam 01a` and arrives back at
this decision, which is the point. An exception a test names by hand stays
auditable; a pattern that happens to admit the next tool does not.

### Why this one is admissible under D1

D1 keeps studio-wide questions in the ERP's assistant because **two tool layers
over one database drift**, and the copy nobody watches is the one that rots.
This tool is not a second implementation of anything: retrieval lives in the
ERP's `retrieveContext()`, has exactly one implementation, and this calls it.
Building a second retriever here is what D1 forbids, and is not what happened.

The properties the single-client rule protects also hold:

- it returns **no client's records**, so it cannot leak one client to another;
- it reads documents owned by the **studio**, not by any person in it;
- the ERP resolves the organisation from the forwarded user token and guards the
  route with `requireStaff`, so it exposes nothing the trainer asking could not
  already open under Settings → AI Knowledge;
- its results are fenced as untrusted stored data on the same path as every
  other tool result — `redteam 26`'s injection case covers it unchanged.

### Consequences

`getClient` as a prefix is no longer a load-bearing security property; it is a
naming convention for the client reads. The property that carries weight is the
enumeration in `STUDIO_DOCUMENT_TOOLS`, and anyone auditing the tool surface
should read that list first.

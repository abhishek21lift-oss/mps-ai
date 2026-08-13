# ERP integration facts

Verified against `abhishek21lift-oss/619-erp-backend` @ `3c841d2` by reading the
source. Everything here replaces an inference in
[PHASE-0-DISCOVERY.md](./PHASE-0-DISCOVERY.md), which was written when the ERP
could not be read.

**Read this before building any new tool.** A tool whose endpoint does not exist
fails at runtime as a 404, which the agent then reports as fact — the exact
fabrication the grounding rules exist to prevent.

---

## 1. Corrections to earlier documents

| Earlier claim | Reality |
|---|---|
| "The ERP does not verify `X-Service-Auth`" | **Wrong.** `middleware/serviceAuth.js` is mounted globally at `server.js:327`. Constant-time compare over SHA-256 digests, fails closed on missing config. |
| "No trainer-level client restriction exists anywhere in the ERP" | **Too broad.** Lists and dues *are* trainer-scoped. **By-id client reads are not** — which is the set this service uses, so the conclusion held even though the reason was overstated. See SECURITY.md §7. |
| "No existing RAG implementation" | **Wrong.** A full knowledge base exists — see §5. |
| "No existing agent/tool architecture to reuse" | **Wrong.** The ERP has its own AI layer with tenant-scoped, role-gated tools — see §6. |

## 2. Tenancy — confirmed

- Tenant column is **`organization_id`**; the boundary table is `organizations`.
- `tenantScope(req)` (`lib/tenant-db.js`) returns `{ isSuperAdmin, orgId, applyFilter }`.
- `orgWhere(req, params, col)` (`pt-os.routes.js:73`) appends ` AND <col> = $N`.
- `clientInOrg(req, clientId)` gates child records whose own tables carry no
  `organization_id` — the parent client **is** the tenant boundary for those.
- Fail-closed: a tenant user with no org resolves to `orgId = null`, and
  `organization_id = NULL` matches no rows, so they see nothing rather than
  leaking across tenants.
- A `super_admin` targets an org with the **`x-org-id`** header, or operates
  platform-wide with no filter when it is absent. This service never sends it.
- Postgres RLS is layered underneath: `auth.js` sets the `app.org_id` GUC from
  the same resolution, and `db/pool.js` wraps `pool.connect` as
  `tenantScopedConnect`.

## 3. Roles — confirmed

```
super_admin · admin · manager · staff · trainer · reception · receptionist · member
```

`STAFF_ROLES` (`middleware/rbac.js`) is everything except `member`, written as an
allow-list rather than a deny-list because the failure modes are not symmetric —
a forgotten role gets a visible 403, whereas a forgotten entry in a deny-list
gets the whole studio.

`/api/pt-os/*` is mounted behind `auth, requireStaff`, so `member` accounts
(created by the hundred through client logins) cannot reach it.

**This service holds no role model and must not acquire one.** It cannot read
the caller's role — the JWT carries `{ id, token_version }` only — and the ERP
re-resolves role from Postgres on every request. Role enforcement therefore
arrives as a 403, which the tool layer already relays as a denial rather than an
outage.

## 4. Endpoints available for studio-wide tools

All verified present. Guards are as mounted.

| Endpoint | Guard | Returns |
|---|---|---|
| `GET /api/reports/revenue?from&to&year` | `auth` | `{ count, total, total_incentives }` — **aggregated in SQL** |
| `GET /api/reports/dues/summary` | `auth` | outstanding totals + risk bands, **no LIMIT**, trainer-scoped for trainers |
| `GET /api/reports/dues` | `auth` | top 100 debtors — a table, **not a total** |
| `GET /api/reports/monthly` | `auth` | monthly rollup |
| `GET /api/reports/revenue-target` | `auth` | target vs actual |
| `GET /api/reports/trainer-summary` | `auth` + `adminOnly` | per-trainer performance |
| `GET /api/reports/trainers` | `auth` + `adminOnly` | trainer list with metrics |
| `GET /api/pt-os/clients` | `auth` + `requireStaff` | client list — **trainer-scoped for trainers** |
| `GET /api/pt-os/trainers` | `auth` + `requireStaff` | trainers in the org |

The whole `/api/reports` router sits behind the `insights` feature gate, and
`/api/pt-os` behind `requireStaff`. A studio without `insights` gets a gate
error, which a tool must relay rather than interpret.

Two traps worth naming, both already solved server-side:

- **`/dues` is not a total.** It returns the top 100 debtors. A UI once summed
  those rows and presented the result as the studio's outstanding balance, which
  silently became "outstanding among the hundred who owe most" past 100 debtors.
  `/dues/summary` exists precisely because of that. **A revenue or dues tool must
  use `/dues/summary`.**
- **Aggregate in SQL, never in the model.** `/reports/revenue` already returns
  `COUNT`/`SUM`. Handing the model rows to add up is both the slow way and the
  wrong way — §23 of the brief says so, and the endpoint already complies.

## 5. RAG — it exists

- Documents: `POST /api/ai/knowledge` (upload, `admin`/`manager`),
  `GET /api/ai/knowledge` (list), `POST /api/ai/knowledge/:id/reindex`.
- Categories: **`sop`, `guide`, `policy`** — exactly the §13 static-knowledge
  layer.
- Ingestion: `lib/ai/textExtract.js` → `lib/ai/chunk.js` → `lib/ai/embeddings.js`.
- Retrieval: **`retrieveContext({ organizationId, query, topK, similarityThreshold })`**
  in `lib/ai/knowledgeBase.js` — tenant-scoped by `organizationId`.
- Gated on the `ai_knowledge_base` feature flag plus `requireAiQuota()`.

**The blocker for Phase 7 is narrow and specific:** `retrieveContext` is called
only from inside `routes/ai.js`. There is **no HTTP endpoint that returns
knowledge chunks**, so this service cannot reach it.

What would unblock it — one new ERP route:

```
GET /api/ai/knowledge/search?q=<query>&topK=<n>
  auth + requireStaff
  → { chunks: [{ text, documentId, documentTitle, category, similarity }] }
  implemented as: retrieveContext({ organizationId: orgParam(req), query: q })
```

Tenant scoping comes free — `retrieveContext` already takes `organizationId` and
`orgParam(req)` already resolves it the same way every other route does. Once
that lands, Phase 7 in this service is: register one tool, pass a non-null
`knowledgeBase` to `createClientAgent`, and the classifier's `ragAvailable`
branch — already written and already tested — starts routing to it.

**That endpoint is now written.** It is in
[`erp-patches/0001-ai-knowledge-search.patch`](./erp-patches/0001-ai-knowledge-search.patch)
— 21 tests passing against the ERP source, but **not pushed**, because the
session that wrote it could read `619-erp-backend` and not write to it. It
guards with `requireStaff` rather than `admin`/`manager`, and returns
`documents_available` alongside the chunks so an empty result can be told apart
from an empty library. See [`erp-patches/README.md`](./erp-patches/README.md).

## 6. The ERP already has an AI layer

This is the finding that most affects what should be built here.

`routes/ai.js` (950 lines) provides `/api/ai/chat`, `/workout/generate`,
`/diet/generate`, `/progress/analyze`, `/fitness-testing/analyze`,
`/business/insights`, plus conversation storage, usage and model stats.

`lib/ai/tools.js` (410 lines) is a tool layer built on the **same** design
decisions as this service — application-layer pattern matching rather than
model-driven function calling, chosen for the same reason (free-tier models emit
`tool_calls` unreliably), with every tool tenant-scoped and **role-declared**:

| ERP tool | Roles permitted |
|---|---|
| `client_stats` | admin, manager, trainer, reception |
| `find_client` | admin, manager, trainer, reception |
| `attendance_summary` | admin, manager, trainer, reception |
| `trainer_roster` | admin, manager, trainer, reception |
| `search_exercises` | admin, manager, trainer |
| **`revenue_summary`** | **admin, manager** |
| **`dues_summary`** | **admin, manager** |

Note that financial tools are already restricted to `admin`/`manager` — the §18
role model the brief asks for, already built, already enforced where the data is.

It also already refuses correctly: *"an unauthorized match is NOT silently
dropped — it's reported back as a denial so the model can tell the user
honestly, instead of fabricating an answer using data the requester can't see."*

### What this means for Phases 5 and 6

Building a studio-wide agent here would **duplicate a working, tenant-scoped,
role-gated implementation** — and the brief's own §11 says *"DO NOT duplicate
functionality that already exists; reuse the strongest existing abstractions."*

The risk is not wasted effort, it is drift. Two AI tool layers over one database
means two places where a tenant predicate or a role list can be edited, and the
copy nobody is looking at is the one that goes wrong. That is the same argument
this service already makes for not re-implementing `orgWhere()`.

Three options, and the choice is a product decision rather than a technical one:

| | Approach | Trade-off |
|---|---|---|
| **A** | Studio questions stay in the ERP's `/api/ai/chat`; this service keeps its single-client depth | No duplication. Two assistants for a user to choose between. |
| **B** | Expose the ERP's tools as read endpoints; this service registers tools over them | One assistant. Needs ERP work; role checks stay where the data is. |
| **C** | Reimplement studio tools here over `/api/reports/*` | Fastest to ship, and the one that creates the second copy. **Not recommended.** |

Under **B**, the endpoints in §4 already cover revenue, dues, monthly, trainers
and the client list — so much of it needs no new ERP code at all, only the
decision to route through them.

## 7. Confirmed shapes this service depends on

- JWT payload is `{ id, token_version }` — no role, no org. Confirmed.
- `pt-os` routes return `{ data: ... }`; `clients`/`payments` return bare bodies.
  The agent already tolerates both (`agent.js:47`).
- Soft deletes are pervasive (`deleted_at IS NULL`). Any new tool reads through
  an endpoint that already applies it — do not add a second opinion.
- Money is INR; the ERP formats with `en-IN`. The studio timezone default
  (`Asia/Kolkata`) matches.

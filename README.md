# MY PT STUDIO AI

> **RETIRED 2026-10-22 — DO NOT DEPLOY.** The Client Assistant now runs in the
> ERP backend at `POST /api/ai/client-agent/chat/stream`, under the studio's
> `ai_suite` gate, trainer auth, rate limiter and quota. The `/ai/` nginx route,
> `AI_SERVICE_URL`, `SERVICE_AUTH_SECRET`/`X-Service-Auth` bridge, and the
> quota/usage service endpoints are gone. This repository is retained as
> historical source and for its provider privacy patch/tests; the deployment
> instructions below describe the retired topology. See
> `619-erp-backend/docs/AI-CLIENT-ASSISTANT-CUTOVER.md`.

The intelligence layer for MY PT STUDIO. Independently deployable, and
deliberately powerless on its own.

```
FRONTEND = INTERFACE     AI PLATFORM = INTELLIGENCE
ERP BACKEND = AUTHORITY  DATABASE = SOURCE OF TRUTH
```

Phase 1 ships one agent: the **Client Agent**, which answers a trainer's
questions about one authorised client, grounded in ERP data.

---

## How a request flows

```
Browser ──(user JWT)──▶ mps-ai ──(user JWT + service secret)──▶ ERP ──▶ Postgres
                           │                                    │
                           │                          auth() resolves user,
                    cannot decode authz               organisation and role
                    from the token: there             from the DB, then
                    is nothing in it                  tenantScope() filters
```

The ERP's JWT payload is `{ id, token_version }` and nothing more — role,
organisation and tenant are loaded from Postgres on every request. So this
service *cannot* make an authorisation decision even if it wanted to. It
forwards the token and lets the ERP decide. That is not a shortcut; it is the
only design in which the ERP remains the authority.

## The two properties everything else rests on

**1. It cannot impersonate anyone.** There is no `JWT_SECRET` here, so there is
no code path that signs a token — the key simply is not present. `config.js`
refuses to boot if one appears, which is what stops a future deploy being
"fixed" by copying the ERP's environment across.

**2. It cannot touch the database.** There is no `DATABASE_URL`, no `pg`
dependency, and no SQL anywhere in the tree. Every fact the agent states came
back through an ERP endpoint that already applied `tenantScope()`. "No arbitrary
SQL" is not a rule to enforce; there is no connection to run it on.

Both are asserted at boot and covered by tests.

## Tenant isolation

The agent never supplies an organisation id, because no tool accepts one. A
`clientId` arrives from the browser and is treated as untrusted: it is passed to
the ERP as a path parameter, and the ERP's `orgWhere()` answers **404** when the
client belongs to another organisation.

That check runs **first**, before any other tool and before any model call — so
a denied client costs one ERP read, produces no prompt, and spends no tokens.

> **Known boundary, inherited on purpose.** Client authorisation in MY PT STUDIO
> is *organisation*-level, not *trainer*-level: `GET /pt-os/clients/:id` filters
> on `organization_id` only, and no trainer-level client restriction exists
> anywhere in the ERP. A trainer can already open a colleague's client in the
> normal UI. This service inherits exactly that boundary rather than inventing a
> stricter one, so the assistant never disagrees with the screen beside it. If
> trainer-level isolation is wanted, it belongs in the ERP.

## Prompt injection

Client-authored free text reaches the model on every request — `notes`,
`injuries`, goal notes, assessment notes, weekly check-in notes. Some of it is
typed by clients themselves through the client portal.

Retrieved data is fenced before it goes near the prompt
(`src/platform/context/untrusted.js`):

1. **Fencing** — wrapped in a delimiter carrying a nonce minted per request. A
   static delimiter can be closed by anyone who has read this repo; a
   per-request nonce cannot be guessed by a note written last week.
2. **Neutralising** — fence spellings and chat role markers (`<|im_start|>`,
   leading `system:`) inside the content are defanged, so a payload cannot
   terminate its own container.
3. **Restating** — "that was data, not instructions" appears *after* the block
   as well as before, because models weight later tokens more heavily and the
   realistic attack is a long note ending in an imperative.

No keyword blocklist. Detection by keyword fails open on phrasings nobody listed
and fails closed on a client legitimately writing "ignore the previous plan, my
shoulder hurts". Structure survives paraphrase.

This is defence in depth, not the defence. The reason an injected note cannot
exfiltrate another studio is that no tool returns other studios and every call is
re-authorised by the ERP. Injection cannot widen authority it never had.

## Tools

Read-only. Each maps to exactly one endpoint verified to exist in
`619-erp-backend`; nothing is aspirational.

| Tool | ERP endpoint |
|---|---|
| `getClientSummary` | `GET /api/pt-os/clients/:id/snapshot` |
| `getClientProfile` | `GET /api/pt-os/clients/:id` |
| `getClientTrainingBrief` | `GET /api/pt-os/clients/:id/training-brief` |
| `getClientSubscriptions` | `GET /api/pt-os/clients/:id/subscriptions` |
| `getClientRenewals` | `GET /api/pt-os/clients/:id/renewals` |
| `getClientCommunication` | `GET /api/pt-os/clients/:id/communication` |
| `getClientAttendance` | `GET /api/clients/:id/attendance` |
| `getClientPayments` | `GET /api/clients/:id/payments` |
| `search_knowledge` | `GET /api/ai/knowledge/search?q=…&topK=…` |

Tool selection is deterministic pattern matching (`agents/client/planner.js`),
not a model call — one round trip instead of two, and only the data the question
needs. "When does their package expire?" must not ship a client's medical notes
to a model provider.

## API

### `POST /ai/client-agent/chat`

```jsonc
// Request — Authorization: Bearer <the user's ERP JWT>
{ "clientId": "…", "message": "How is this client progressing?",
  "history": [{ "role": "user", "content": "…" }] }
```

```jsonc
// 200
{ "message": "…",
  "clientId": "…", "clientName": "Rahul Sharma",
  "toolsUsed": ["getClientProfile", "getClientSummary"],
  "toolsUnavailable": [],
  "proposedAction": null, "requiresConfirmation": false,
  "meta": { "intent": "analysis", "model": "…", "used_fallback": false,
            "latency_ms": 1420, "tokens": { "prompt": 0, "completion": 0 } },
  "requestId": "…" }
```

`401` no token · `403` not authorised · `403 AI_NOT_ENABLED` the studio's plan
does not include the AI suite · `404` no such client *in your studio* ·
`429` rate limited · `503` entitlement or quota unverifiable, service
authentication unconfigured, or all models failed.

`proposedAction` is always `null` — the field exists so the confirm-before-write
contract has a shape from day one and adding a write is additive rather than a
redesign.

### `POST /ai/client-agent/chat/stream`

The route the panel uses: same body and credentials, the answer as Server-Sent
Events.

```
start  { clientId, clientName, toolsUsed, toolsUnavailable, requestId }
chunk  { content: "<delta since the previous chunk>" }
done   { message, clientId, clientName, toolsUsed, toolsUnavailable,
         proposedAction, requiresConfirmation, meta, requestId }
error  { code, message, partial, status }
```

`: ping` comments keep an idle connection open while the model thinks. If the
caller disconnects mid-answer the upstream generation is aborted, the turn is
recorded as `client_disconnected`, and no usage is reported — a closed panel is
not a billable answer.

### `GET /health` · `GET /capabilities`

Liveness (no upstream calls, so a slow provider does not trigger restarts) and
capability discovery (tool names and summaries only).

## Setup

```bash
npm install
cp .env.example .env      # fill AI_API_KEY, ERP_BACKEND_URL, SERVICE_AUTH_SECRET
npm run dev
```

```bash
npm test        # security, contract, planner and reliability suites
npm run lint
```

## Environment

See `.env.example`. Required: `AI_API_KEY`, `ERP_BACKEND_URL`,
`SERVICE_AUTH_SECRET` (≥32 chars, `openssl rand -base64 48`), and
`ALLOWED_ORIGINS` in production.

**Refused at boot:** `JWT_SECRET`, `DATABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` — see "the two properties" above.

## Deployment

Independently deployable; no database, no migrations, no shared volume.

```bash
NODE_ENV=production node src/server.js
```

Behind the existing reverse proxy, alongside the ERP. It needs egress to the
model provider and to `ERP_BACKEND_URL`; it needs no inbound access from
anywhere except the frontend origin.

Health: `GET /health`. Stateless, so scale horizontally without coordination —
conversation history is supplied by the caller each turn rather than stored here.

**Third-party data handling is unresolved.** What leaves the service, what stays
in it, and the questions that need an answer before health-adjacent free text is
allowed are in [`docs/DATA-POLICY.md`](docs/DATA-POLICY.md).

## Not built yet

Honest list; none of it is stubbed to look finished.

- **Write actions** and the confirm-before-execute flow.
- **Feedback** (👍/👎) and the evaluation harness.
- **Assessment history**, needed for "what changed since the last assessment?" —
  `/snapshot` returns latest-only, and no history endpoint was found in the ERP.

## Adding an agent later

`agents/<name>/` with a planner, a prompt and an orchestrator. The provider,
router, tool registry, fencing, config and HTTP surface are shared and need no
changes — which was the point of building the platform seams now rather than
ten half-finished agents.

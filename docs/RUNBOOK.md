# Runbook — getting this into production

Ordered by dependency and by risk. Stage 1 is a live privilege fix and does not
depend on anything else here; do it first even if you never deploy the AI
service.

Every command below is meant to be run as written. Where something could not be
verified from this session, it says so rather than guessing.

**Verified on:** Node v22.22.2, npm 10.9.7. The repo declares `>=20`; the
Dockerfile pins `node:20-alpine`.

---

## Stage 0 — What exists right now

| Where | What | State |
|---|---|---|
| `mps-ai` branch `claude/clone-32ymkj` | 18 commits, 44 files, 461 tests | pushed |
| `docs/erp-patches/0003-staff-only-routers.patch` | ERP privilege fix | **not applied** |
| `docs/erp-patches/0001-ai-knowledge-search.patch` | ERP RAG endpoint | **not applied** |

The two patches live in this repo only because the session that wrote them could
read `619-erp-backend` but not push to it. They are ordinary
`git format-patch` output.

---

## Stage 1 — Apply the privilege fix to the ERP

**Do this first.** It is independent of the AI service entirely — worth doing if
`mps-ai` never ships.

### 1.1 Apply

```bash
cd /path/to/619-erp-backend
git fetch origin && git checkout -b claude/staff-only-routers origin/main
git am < /path/to/mps-ai/docs/erp-patches/0003-staff-only-routers.patch
```

### 1.2 Verify

```bash
npx jest src/__tests__/staffOnlyRouters.test.js     # 35 tests
npx eslint src/server.js
```

Then the regression check. The full ERP suite needs a live Postgres and Redis;
the subset that reads `server.js` does not:

```bash
npx jest $(grep -rl "server\.js" src/__tests__ | tr '\n' ' ')
```

Expect **173 passing**. Baseline before the patch is 138 — the difference is the
35 new ones. If you have a database available, run the whole suite instead.

### 1.3 What it changes

Ten routers gain `auth, requireStaff`: `clients`, `progress`, `reports`,
`trainers`, `payments`, `attendance`, `expenses`, `invoices`, `communication`,
`search`.

Before it, a **client-portal login** could call `GET /api/clients` and receive
`SELECT c.*` over up to 1000 `pt_clients` rows — names, mobiles, emails,
balances, notes, injuries — plus `/api/reports/revenue` and `/api/reports/dues`.
Not a cross-tenant leak; `tenantScope()` held. A privilege one.

### 1.4 The check that made it safe

The client portal calls **exactly one endpoint: `/api/me`**. No screen under
`app/(bare)/member`, `/client` or `/member-login` in `619-erp-frontend`
references any router touched. Re-run it yourself if you want:

```bash
cd /path/to/619-erp-frontend
grep -rn "api/clients\|api/reports\|api/progress" \
  "src/app/(bare)/member" "src/app/(bare)/client" "src/app/(bare)/member-login"
# expect: no output
```

### 1.5 Deploy

Normal ERP deploy. Watch for `403 FORBIDDEN "This area is for studio staff."` in
the logs — a burst of them means a staff screen you use is hitting a router
nobody expected. That would be a real finding, not a false alarm.

---

## Stage 2 — Merge the AI service branch

Nothing here reaches production until Stage 4, so this is safe to do any time.

```bash
cd /path/to/mps-ai
git fetch origin && git checkout claude/clone-32ymkj
npm ci
npm test          # 461 passing, 14 suites
npm run lint      # clean
```

### Worth reviewing rather than skimming

| File | Why |
|---|---|
| `src/lib/requestToken.js` | accepts the `token` cookie; without it every request from the real product was a 401 |
| `src/agents/client/planner.js` | the stem fix — 6/26 realistic questions matched before it, 26/26 after |
| `src/platform/grounding/check.js` | new: checks the answer's figures against retrieved records |
| `.dockerignore` | new: `.gitignore` never applied at build time |
| `docs/DECISIONS.md` | why studio-wide questions stay in the ERP's assistant |

---

## Stage 3 — Decide how the frontend reaches the AI service

**This is the one genuine gap, and it is in a file I wrote.**

`docker-compose.snippet.yml` says to paste the `ai` service into
`/opt/myptstudio/619-erp-backend/docker-compose.yml` so it can reach the API as
`http://api:5000`. That part is right.

What it missed: **the frontend is a different compose project.** It is deployed
from `/opt/myptstudio/docker-compose.yml` (frontend `DEPLOYMENT.md`), while
`api`, `worker` and `redis` live in the backend's file. Different project,
different network — so the frontend container **cannot** resolve `http://ai:4100`.

Binding `127.0.0.1:4100` does not help either: a container reaching the docker
bridge gateway arrives on a different host interface, which a loopback binding
refuses.

### Recommended: route `/ai/` through the existing `api` vhost

This matches what the frontend already does. It reaches the backend at
`NEXT_PUBLIC_API_URL` (`https://api.myptstudio.com`) — back out through nginx —
so the AI service can use the same door.

Add to the `api.myptstudio.com` server block (`infra/nginx/` in the backend
repo — **diff against the live file first, that folder is a template**):

```nginx
location /ai/ {
    proxy_pass         http://127.0.0.1:4100;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;

    # Streaming. Without these, an SSE answer arrives all at once at the end,
    # or not at all — which is the failure the streaming endpoint exists to
    # avoid.
    proxy_buffering    off;
    proxy_cache        off;
    proxy_read_timeout 300s;
}
```

Then set on the **frontend** container:

```
AI_SERVICE_URL=https://api.myptstudio.com
```

`next.config.js` rewrites `/ai/:path*` → `${AI_SERVICE_URL}/ai/:path*`, so the
final URL is `https://api.myptstudio.com/ai/client-agent/chat/stream`.

`AI_SERVICE_URL` is **not** a `NEXT_PUBLIC_*` variable, so it is read at runtime
— a restart picks it up, no rebuild. (`NEXT_PUBLIC_API_URL` *is* build-time.
They behave differently; the frontend's `DEPLOYMENT.md` says so.)

### Alternative: one shared external network

If you would rather keep it off the public hostname, declare an external network
in both compose files and attach `ai` and `frontend` to it, then
`AI_SERVICE_URL=http://ai:4100`. More moving parts, and it means two compose
projects share a lifecycle concern. I would take the nginx route.

> **Not verified from this session.** I could read both repos but never saw the
> box. Confirm the live nginx config and the two compose paths before applying.

---

## Stage 4 — Deploy the AI service

### 4.1 Secrets

```bash
# On the VPS, in the .env beside the backend compose file:
SERVICE_AUTH_SECRET=$(openssl rand -base64 48)
```

The same value must be set for **both** the ERP and the AI service — the ERP's
`middleware/serviceAuth.js` compares them, and rejects a mismatch loudly rather
than ignoring it. Rotating one and forgetting the other is a visible outage on
the next request, which is the intended behaviour.

`AI_API_KEY` reuses the ERP's existing `OPENROUTER_API_KEY`. One account, one
bill.

### 4.2 Paste the service block

Copy the `ai:` service from `docker-compose.snippet.yml` into the backend's
compose file. **Diff first** — the live file may already differ from the repo.

Set deliberately rather than accepting the default:

| Variable | Note |
|---|---|
| `STUDIO_TIMEZONE` | defaults to `Asia/Kolkata`. If the studio is elsewhere, every "this month" answer is quietly wrong. |
| `AI_ALLOWED_ORIGINS` | exact scheme+host of the frontend. `*` is refused at boot. |
| `MAX_TOOL_RESULT_CHARS` / `MAX_CONTEXT_CHARS` | 6000 / 24000 defaults are fine to start. |
| `AI_RATE_LIMIT_MAX` | 30/min per token. |

### 4.3 Build and start

```bash
cd /opt/myptstudio/619-erp-backend
docker compose build ai
docker compose up -d ai
docker compose logs -f ai      # expect: mps_ai_started
```

### 4.4 Verify the image does not carry a secret

**Do this once.** I added `.dockerignore` but could not prove it here — this
environment has a Docker CLI and no daemon.

```bash
docker run --rm --entrypoint sh mps-ai-ai -c 'ls -a /app; cat /app/.env 2>/dev/null'
# expect: no .env, no node_modules from the host, no .git
```

If a `.env` appears, stop and check `.dockerignore` reached the build context.

### 4.5 Smoke test

```bash
curl -s http://127.0.0.1:4100/health          # {"status":"ok","service":"mps-ai"}
curl -s http://127.0.0.1:4100/capabilities    # 11 tools
```

Then through the whole path, from a browser logged into the app:

```
POST https://myptstudio.com/ai/client-agent/chat/stream
{ "clientId": "<a real client id>", "message": "Summarize this client" }
```

Expect `event: start` with `toolsUsed` populated, then `chunk` frames, then
`done` carrying the whole `message` and a `grounding` block.

**If you get 401 with a valid session:** the cookie is not arriving. That means
the request went cross-origin instead of through the Next rewrite — check
`AI_SERVICE_URL` and the nginx `location /ai/`.

**If the answer arrives all at once after a minute:** `proxy_buffering off` is
missing from the nginx block.

---

## Stage 5 — Turn on RAG (optional, after Stages 1–4)

```bash
cd /path/to/619-erp-backend
git checkout -b claude/ai-knowledge-search origin/main
git am < /path/to/mps-ai/docs/erp-patches/0001-ai-knowledge-search.patch
npx jest src/__tests__/aiKnowledge.search.test.js     # 21 tests
```

Deploy the ERP, then on this side — two changes, and the branch was built ahead
of them:

1. Register a `searchStudioKnowledge` tool in `src/platform/tools/registry.js`
   over `GET /api/ai/knowledge/search`.
2. Pass a non-null `knowledgeBase` into `createClientAgent` in `src/app.js`.

That flips the classifier's `ragAvailable` branch, which already exists and is
already tested both ways in `__tests__/router.test.js`. `RAG_QUERY` stops
short-circuiting and starts retrieving; `DATABASE_PLUS_RAG` drops its "I don't
have your policy documents" directive.

Upload documents at **Settings → AI Knowledge** (`admin`/`manager` only). Until
something is uploaded, `documents_available: 0` lets the assistant say "your
studio has not uploaded any policies" rather than "no policy covers that" —
different sentences, and the patch exists partly to keep them different.

---

## Rollback

| Stage | How |
|---|---|
| 1 | revert the commit, redeploy. Routers return to `auth`-only. |
| 4 | `docker compose stop ai`. The frontend's `/ai/*` rewrite 404s; nothing else notices. |
| 5 | revert; the classifier returns to the short-circuit path on its own. |

Stage 3's nginx block is inert with the container stopped.

---

## After it is live

Watch the audit stream — it is tagged `audit: true` and refusals log at `warn`:

```bash
docker compose logs ai | grep audit_denied
```

One `actor` against many `clientId`s is the shape of enumeration. The `actor` is
an HMAC of the bearer token, so joining it back to a person is done against the
ERP's own request log — deliberately, since the ERP is the only party that ever
knew.

Also worth a periodic look: `truncated_tools` in `audit_ai_request`. A tool that
truncates on most requests means `MAX_TOOL_RESULT_CHARS` is too low for that
studio's data, and answers are hedging more than they need to.

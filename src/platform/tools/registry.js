'use strict';
// The tool registry. A tool that is not registered here cannot be run.
//
// This is the enumeration §30 and §31 turn on: there is no executeSQL, no
// runCommand, no generic HTTP fetch. A tool is a named function over ONE known
// ERP endpoint, and run() will not execute anything it cannot find by name in
// this map. The model never supplies a URL, a table, or a query — only a tool
// name and validated arguments.
//
// Each tool declares:
//   name        stable identifier the agent selects by
//   summary     what it returns, in the words the model sees
//   args        zod schema — arguments are validated, not trusted
//   endpoint    (args) => path on the ERP. The ONLY place a path is built.
//   label       provenance shown to the model when the result is fenced
//
// Deliberately absent: any notion of which organisation or trainer may run the
// tool. That decision belongs to the ERP, which makes it from the forwarded
// user token on every call. Duplicating it here would create a second
// authorisation model to keep in step with the first — and the copy that drifts
// is always the one nobody is looking at.

const { z } = require('zod');
const logger = require('../../lib/logger');

/** Client ids in this system are opaque strings; reject shapes that are not. */
const ClientId = z.string().trim().min(1).max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'clientId must be an opaque id');

/**
 * Build a query string from already-validated values.
 *
 * Used only by endpoints that take the client as `?client_id=` rather than as a
 * path segment. Values reaching here have passed the tool's zod schema — an
 * enum, a bounded integer, or ClientId — so this is encoding, not sanitising.
 * URLSearchParams is used anyway rather than string concatenation, because the
 * next person to add a tool should not have to know that distinction.
 */
function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const TOOLS = new Map();

function define(tool) {
  if (TOOLS.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
  TOOLS.set(tool.name, Object.freeze(tool));
  return tool;
}

/* ── Client read tools ───────────────────────────────────────────────────────
   Every endpoint below was verified to exist in 619-erp-backend before being
   registered. Nothing here is aspirational: a tool whose endpoint does not
   exist would fail at runtime as a 404 the agent would then report as fact,
   which is precisely the fabrication §14 forbids. */

define({
  name: 'getClientSummary',
  summary: 'Overall snapshot: latest measurements, assessments, active goal, personal records, last session, recent weekly check-ins.',
  label: 'client snapshot',
  args: z.object({ clientId: ClientId }),
  endpoint: ({ clientId }) => `/api/pt-os/clients/${encodeURIComponent(clientId)}/snapshot`,
});

define({
  name: 'getClientProfile',
  summary: 'Profile and commercial status: name, contact, package end date, days remaining, outstanding balance, dues status.',
  label: 'client profile',
  args: z.object({ clientId: ClientId }),
  endpoint: ({ clientId }) => `/api/pt-os/clients/${encodeURIComponent(clientId)}`,
});

define({
  name: 'getClientTrainingBrief',
  summary: 'Training readiness: PAR-Q, posture and mobility findings, lifestyle, current goal, assigned programme, recent sessions.',
  label: 'training brief',
  args: z.object({ clientId: ClientId }),
  endpoint: ({ clientId }) => `/api/pt-os/clients/${encodeURIComponent(clientId)}/training-brief`,
});

define({
  name: 'getClientSubscriptions',
  summary: 'PT packages and subscriptions held by this client, including validity.',
  label: 'subscriptions',
  args: z.object({ clientId: ClientId }),
  endpoint: ({ clientId }) => `/api/pt-os/clients/${encodeURIComponent(clientId)}/subscriptions`,
});

define({
  name: 'getClientRenewals',
  summary: 'Renewal history for this client.',
  label: 'renewals',
  args: z.object({ clientId: ClientId }),
  endpoint: ({ clientId }) => `/api/pt-os/clients/${encodeURIComponent(clientId)}/renewals`,
});

define({
  name: 'getClientAttendance',
  summary: 'Attendance records for this client.',
  label: 'attendance',
  args: z.object({ clientId: ClientId }),
  endpoint: ({ clientId }) => `/api/clients/${encodeURIComponent(clientId)}/attendance`,
});

define({
  name: 'getClientPayments',
  summary: 'Payment history for this client.',
  label: 'payments',
  args: z.object({ clientId: ClientId }),
  endpoint: ({ clientId }) => `/api/clients/${encodeURIComponent(clientId)}/payments`,
});

define({
  name: 'getClientCommunication',
  summary: 'Logged communication history with this client.',
  label: 'communication history',
  args: z.object({ clientId: ClientId }),
  endpoint: ({ clientId }) => `/api/pt-os/clients/${encodeURIComponent(clientId)}/communication`,
});

/* ── Training depth ──────────────────────────────────────────────────────────
   These take the client as a QUERY parameter rather than a path segment, which
   is the ERP's own shape for them, not a choice made here.

   The tenant boundary is unchanged and still theirs: /workout-log/analytics
   calls clientInOrg() and answers 404 for a client outside the caller's
   organisation, exactly as the by-id routes do. Neither tool accepts an
   organisation, and neither could express one. */

define({
  name: 'getClientTrainingAnalytics',
  summary: 'Measured training analytics from the workout log: attendance against plan, strength trend, muscle-group coverage, and days since each muscle was last trained.',
  label: 'training analytics',
  args: z.object({
    clientId: ClientId,
    // The ERP clamps this to 1..52 itself; bounded here too so an
    // out-of-range value is a BAD_ARGS locally rather than a silent clamp
    // upstream that makes the answer describe a different window than asked for.
    weeks: z.coerce.number().int().min(1).max(52).default(12),
  }),
  // `as_of` is deliberately NOT sent. The ERP has its own studioToday(), and
  // supplying ours would give one request two opinions about what day it is —
  // the same reason this service does not re-implement orgWhere().
  endpoint: ({ clientId, weeks }) => `/api/pt-os/workout-log/analytics${qs({ client_id: clientId, weeks })}`,
});

define({
  name: 'getClientAssessmentHistory',
  summary: 'Past fitness assessments in date order, most recent first — measurements, test results and trainer notes as recorded on each date.',
  label: 'assessment history',
  args: z.object({
    clientId: ClientId,
    // Six is enough to answer "what changed since the last assessment?" and to
    // show a trend, without shipping years of body-composition and health notes
    // to a model provider to answer a question about the last two.
    //
    // The ERP's own ceiling is 200. This is deliberately far stricter: it is the
    // caller's job to ask for what it needs, not to take what it is allowed.
    limit: z.coerce.number().int().min(1).max(24).default(6),
  }),
  // client_id is REQUIRED here, and that is load-bearing rather than tidy.
  // On the ERP side it is optional, and a request that omits it returns every
  // assessment in the organisation. That would put other clients' body
  // composition and health notes into a prompt about one client. The schema
  // above makes omitting it impossible; the test suite asserts the parameter is
  // in every URL this tool builds.
  endpoint: ({ clientId, limit }) => `/api/progress/assessments${qs({ client_id: clientId, limit })}`,
});

define({
  name: 'getClientVolumeSummary',
  summary: 'Training volume per week or month, aggregated in the database — total load and session count over time.',
  label: 'training volume',
  args: z.object({
    clientId: ClientId,
    groupBy: z.enum(['week', 'month']).default('week'),
  }),
  endpoint: ({ clientId, groupBy }) => `/api/pt-os/workout-log/volume-summary${qs({ client_id: clientId, group_by: groupBy })}`,
});

/* ── Studio knowledge ────────────────────────────────────────────────────────
   The one tool here that is NOT about a single client.

   Every other tool takes a clientId and answers from that client's records.
   This one takes a QUERY and answers from the studio's uploaded policies, SOPs
   and contracts — documents that belong to the studio rather than to anybody in
   it. That difference is why the agent runs it on its own line rather than
   through planTools(), which builds `{ clientId }` arguments for everything it
   returns.

   Tenancy is unchanged and still the ERP's: /api/ai/knowledge/search resolves
   the organisation from the forwarded user token, returns only that studio's
   chunks, and answers a platform-wide super admin with an empty result rather
   than every tenant's documents. It is guarded by requireStaff, so a client
   portal login cannot reach it — internal SOPs are not member-readable.

   Nothing here widens what this service may see. It reads what the trainer
   asking the question could already open in Settings → AI Knowledge. */
define({
  name: 'searchStudioKnowledge',
  summary: 'The studio\'s own uploaded policies, SOPs, guides and contracts: the passages most similar to a question, each with the document it came from. Use it to say what the studio\'s written policy actually says, and quote it rather than paraphrasing.',
  label: 'studio policy documents',
  args: z.object({
    // 500 mirrors the ERP's own MAX_QUERY_CHARS. The caller truncates rather
    // than relying on this to reject: a trainer who types a long question
    // should get a retrieval against the first 500 characters, not a BAD_ARGS
    // that silently costs them the policy half of their answer.
    q: z.string().trim().min(1).max(500),
    // The ERP clamps to 10 and defaults on undefined. Bounded here too so an
    // out-of-range value is a local BAD_ARGS rather than a silent clamp.
    topK: z.coerce.number().int().min(1).max(10).optional(),
  }),
  endpoint: ({ q, topK }) => `/api/ai/knowledge/search${qs({ q, topK })}`,
});

function get(name) {
  return TOOLS.get(name) || null;
}

function list() {
  return [...TOOLS.values()].map((t) => ({ name: t.name, summary: t.summary }));
}

/**
 * Run one registered tool.
 *
 * Returns a RESULT OBJECT for both success and failure rather than throwing on
 * denial. A 403 or 404 from the ERP is information the agent must be able to
 * state plainly ("you don't have access to that client"); turning it into an
 * exception would collapse it into a generic failure and invite the model to
 * guess at what went wrong.
 */
async function run({ name, args, erp, userToken, requestId }) {
  const tool = get(name);
  if (!tool) {
    // Unreachable from the model — the agent only selects from list() — but
    // this is the enforcement point, so it refuses by name rather than assuming
    // the caller got it right.
    logger.warn({ tool: name, requestId }, 'tool_not_registered');
    return { ok: false, tool: name, code: 'UNKNOWN_TOOL', message: `No such tool: ${name}` };
  }

  const parsed = tool.args.safeParse(args || {});
  if (!parsed.success) {
    // 400, not 403. A malformed id is the caller's mistake, and reporting it as
    // an authorisation failure sends a frontend author looking for a permission
    // problem that does not exist.
    return {
      ok: false,
      tool: name,
      status: 400,
      code: 'BAD_ARGS',
      message: parsed.error.issues.map((i) => i.message).join('; '),
    };
  }

  try {
    const { data, latency_ms } = await erp.get(tool.endpoint(parsed.data), { userToken, requestId });
    return {
      ok: true,
      tool: name,
      label: tool.label,
      data,
      latency_ms,
      // Recorded for the audit trail and the context budget. Cheap here, and
      // the alternative is re-serialising the same payload downstream.
      chars: typeof data === 'string' ? data.length : JSON.stringify(data ?? null).length,
    };
  } catch (err) {
    // 401 and 403 are different answers and must not be flattened into one.
    // "Your session expired, sign in again" and "you may not see this client"
    // call for different things from the person reading them, and only the
    // first is fixable by the user.
    let message;
    if (err.status === 404) {
      message = 'Not found, or not visible to you.';
    } else if (err.status === 401) {
      message = 'Your session has expired. Please sign in again.';
    } else if (err.status === 403) {
      message = 'You are not authorised to see this.';
    } else {
      message = 'That information could not be retrieved right now.';
    }

    return {
      ok: false,
      tool: name,
      code: err.status === 401 ? 'UNAUTHENTICATED' : (err.code || 'TOOL_FAILED'),
      status: err.status,
      message,
    };
  }
}

module.exports = { define, get, list, run, TOOLS, ClientId };

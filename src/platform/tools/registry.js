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
    return {
      ok: false,
      tool: name,
      code: 'BAD_ARGS',
      message: parsed.error.issues.map((i) => i.message).join('; '),
    };
  }

  try {
    const { data, latency_ms } = await erp.get(tool.endpoint(parsed.data), { userToken, requestId });
    return { ok: true, tool: name, label: tool.label, data, latency_ms };
  } catch (err) {
    return {
      ok: false,
      tool: name,
      code: err.code || 'TOOL_FAILED',
      status: err.status,
      message: err.status === 404
        ? 'Not found, or not visible to you.'
        : err.status === 403 || err.status === 401
          ? 'You are not authorised to see this.'
          : 'That information could not be retrieved right now.',
    };
  }
}

module.exports = { define, get, list, run, TOOLS, ClientId };

'use strict';
// Budgets for what may enter a prompt.
//
// Before this existed, `JSON.stringify(erpResponse)` went into the context with
// nothing between it and the model. `maxTokens` caps the COMPLETION; nothing
// capped the INPUT. A client with four years of attendance, or a payments
// history a hundred rows long, built a prompt whose size was set by the data
// rather than by us — which §24 and §44 both rule out, and which is a cost and
// availability problem before it is anything else.
//
// ── Truncation must be announced ─────────────────────────────────────────────
//
// The important part is not the cut, it is telling the model about the cut.
// Silently handing over the first 6,000 characters of an attendance history and
// asking "how many sessions did they miss?" produces a confident, precise,
// wrong number — the model counts what it was given and has no way to know it
// was given a prefix. A truncated result that is LABELLED truncated produces
// "based on the most recent N records I can see…", which is the honest answer.
//
// So every function here returns the fact of truncation alongside the text, and
// the caller is expected to put it in front of the model.

/** Cut on a line boundary where one is nearby, so a JSON row is not halved. */
function truncate(text, maxChars) {
  const s = String(text);
  if (s.length <= maxChars) {
    return { text: s, truncated: false, originalChars: s.length, keptChars: s.length };
  }

  let cut = s.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf('\n');
  // Only prefer the line boundary if it is not throwing away most of the budget.
  if (lastNewline > maxChars * 0.6) cut = cut.slice(0, lastNewline);

  return {
    text: cut,
    truncated: true,
    originalChars: s.length,
    keptChars: cut.length,
  };
}

/**
 * Apply a per-result cap, then a total cap across results in order.
 *
 * Results are processed in the order given, so a caller should pass the most
 * important first — the profile before the communication log. A result that
 * does not fit in the remaining budget is reported as dropped rather than
 * silently omitted, for the same reason truncation is announced: the model must
 * be able to say what it could not see.
 *
 * @param {Array<{tool: string, label: string, data: unknown}>} results
 * @param {{maxPerResult: number, maxTotal: number}} budget
 */
function applyBudget(results, { maxPerResult, maxTotal }) {
  const kept = [];
  const dropped = [];
  let used = 0;

  for (const r of results || []) {
    if (!r) continue;

    const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 1);
    const capped = truncate(body, maxPerResult);

    const remaining = maxTotal - used;
    if (remaining <= 0) {
      dropped.push({ tool: r.tool, reason: 'context budget exhausted' });
      continue;
    }

    // Second cut, against whatever is left of the total rather than the
    // per-result cap.
    const fitted = capped.keptChars <= remaining
      ? capped
      : { ...truncate(capped.text, remaining), originalChars: capped.originalChars };

    used += fitted.keptChars;
    kept.push({
      tool: r.tool,
      label: r.label,
      body: fitted.text,
      truncated: fitted.truncated || capped.truncated,
      originalChars: capped.originalChars,
      keptChars: fitted.keptChars,
    });
  }

  return { kept, dropped, usedChars: used };
}

module.exports = { truncate, applyBudget };

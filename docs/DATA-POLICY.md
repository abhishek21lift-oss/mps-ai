# Data handling: what leaves this service, and what is not yet known

Status: **the third-party data question is UNRESOLVED.** This file separates
what the code does (verified, line by line) from what the model provider does
with the data (not verified from any source in this repository). It is not a
privacy notice, a legal opinion, or a compliance claim — and no part of this
service should be described as compliant on the strength of it.

## What the service sends, per turn

One HTTPS request to `https://openrouter.ai/api/v1/chat/completions`
(`src/platform/provider/openrouter.js`):

- the system prompt, the conversation history the browser re-sends each turn,
  and the trainer's question;
- the JSON returned by whichever tools the planner ran for that turn
  (`getClientProfile`, `getClientTrainingBrief`, `getClientSummary`,
  `getClientPayments`, `getClientSubscriptions`, `getClientRenewals`,
  `getClientAttendance`, `getClientCommunication`), and, for a
  policy/methodology question, the passages returned by `search_knowledge`.

Those tool payloads are not anonymous: the profile carries name and contact,
and the training brief carries PAR-Q, posture/mobility findings and lifestyle
notes. The knowledge passages are the studio's own documents, not client data.

Headers are `Authorization: Bearer <AI_API_KEY>`, `Content-Type` and
`X-Title: MY PT STUDIO AI`. The end-user JWT is forwarded only to the ERP and
never to the model provider.

## What it does not send

- **No database.** The service stores no conversations; history comes from the
  caller and is discarded when the request ends.
- **No prompt content in logs.** Log lines name the event, request id, model,
  code and token counts — never the question, the answer or a client name.
- **Usage ledger** (optional JSONL, local): request id, outcome, model, token
  counts, latency, tool counts. No prompt text, no client identifier.
- **Usage report to the ERP** (`/api/ai/usage/service/ingest`): request id,
  outcome, model, token counts, latency, attempt count, and `replyChars` — a
  length, not the text.

## What is not known

| Question | State | Why |
|---|---|---|
| Does OpenRouter retain prompts/completions, and for how long? | **UNKNOWN** | No contract, DPA or account setting is present in this repository. |
| Are prompts or completions used for training — by OpenRouter, or by the upstream model provider it routes to? | **UNKNOWN** | Routing selects the upstream provider per request unless pinned, and terms differ per model and account tier. |
| Which sub-processors and regions are involved? | **UNKNOWN** | Same. |
| Do the default `:free` models carry different data terms from paid ones? | **UNKNOWN** (assume yes until read) | `config.js` defaults both slugs to `:free`; free endpoints are commonly offered on different terms. Not verified for this account. |

None of these may be filled in from memory, from another product's policy, or
from what a vendor page "generally" says. They have to be read from the
account's current terms — and a DPA, if one exists — for the exact model slugs
that run in production. The ERP's own AI gateway has its own arrangements; they
are out of scope here.

## Interim rule until that is answered

1. **No clinical free text.** Do not paste diagnoses, medication lists or
   narrative medical history into the assistant. The structured PAR-Q /
   training-brief fields the ERP already returns are health-adjacent, and are
   the ceiling until the table above is answered.
2. **Do not run production health traffic on the `:free` defaults.** Repointing
   `AI_PRIMARY_MODEL` / `AI_FALLBACK_MODEL` at an endpoint whose terms have been
   confirmed is a deliberate config change; `ALLOW_PAID_MODELS` and
   `AI_ALLOWED_MODELS` exist so it cannot happen by accident.
3. **A cancellation is not a retraction.** Closing the panel aborts the
   generation and bills nothing, but the prompt has already been sent. Treat
   the send as final.
4. **Record the answer here.** Whoever resolves the table writes the source
   (document, section, date) next to it. Until then, this file is the record
   that the question is open — not that it was answered.

## Questions to put to whoever holds the OpenRouter account

Copy this as one message; each line maps to a row above.

1. For this account, what is the retention period for prompts and completions,
   and can it be set to zero?
2. Are prompts or completions used to train models — by OpenRouter itself, or
   by the upstream provider a request is routed to? Does that differ between
   `:free` and paid endpoints?
3. Which upstream providers can serve `openai/gpt-oss-120b:free` and
   `nvidia/nemotron-3-ultra-550b-a55b:free`, and which sub-processors and
   regions may process the data?
4. Is a data-processing agreement available, and does it cover health data?

Record the reply next to the table above with its source — document title and
section, or the account setting it came from. "Support said it is fine" is not
a source that survives an audit.

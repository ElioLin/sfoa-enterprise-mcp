# ADR-0021: Request USER batch mutation and presentation/context composition

Date: 2026-09-09. Implementation authorized by P8-07. Acceptance evidence is tracked
in the P8-07 report, separately from independent Lightning and Agent UAT.

## Decision

Keep singular contracts. Add plural CREATE/UPDATE Tools using the installed
official SDK collection overloads, 1..200 same-object items, allOrNone=false by
default, API >=42 and no recursive SDK batching. Every item goes through the same
object-operation policy and managed-field resolver, with the same request USER.
Correlate SaveResult entries to optional unique clientReferenceIds and expose
explicit counts and item outcomes. Never retry an uncertain mutation.

Keep raw Salesforce evidence unchanged. Add a bounded USER presentation Tool
for Record Type-aware current Picklist labels and a bounded USER relationship
context filtered by CREATE governance. Neither is a permission or business engine.
Business phase ordering, scope completeness and intent reconciliation belong to
the canonical Playbook, propagated to Dify, WorkBuddy, WeCom and MCP instructions.

Model CREATE facts with source, value, trust and resolution status. Resolve only
actual USER dependencies under FLS using UI API optionalFields. Do not equate
managed DML defaults or post-save automation with initial Lightning facts.
Unsupported record-dependent containers remain UNKNOWN; no speculative runtime
reconstruction or persistence of unsaved page state is added.

Use existing P7 schema compatibly: one collection wire row, indexed bounded
submitted fields, real payload evidence, BATCH_DML_OUTCOME event counts and
explicit partial status in responseSummary/Admin. No enum migration is needed;
HTTP transport success is distinct from logical item success.

## Alternatives and consequences

- Reusing single Tools in a hidden loop would multiply wire requests and lose
  request-local allOrNone. SDK overloads already support the needed API.
- Mixing objects in a single Tool adds payload and governance complexity; agents
  group by object and proven dependency phase instead.
- Extending raw SOQL would break official evidence; presentation stays separate.
- Composition Hint lacks demonstrated need; schema labels/relationships and
  explicit user clarification remain authoritative.
- There is no cross-batch transaction or automatic rollback. UNKNOWN CREATE may
  remain unverifiable without a unique user-provided business key. Salesforce API
  limits and incomplete Dynamic Forms metadata remain explicit limitations.

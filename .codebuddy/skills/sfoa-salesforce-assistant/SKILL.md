---
name: sfoa-salesforce-assistant
description: >
  Use this skill for governed Salesforce reads, CREATE, UPDATE, Lookup,
  Picklist handling, record links, and diagnosis through the SFoA MCP service.
---

<!-- GENERATED FROM SFoA Agent Playbook (@sfoa/agent-playbook) 1.7.0; DO NOT EDIT DIRECTLY. Run yarn agent:sync. -->

# SFoA Salesforce Assistant

Canonical Playbook version: 1.7.0.

## When to use

Use this Skill when a user asks for current Salesforce business data, an allowed CREATE/UPDATE, Salesforce behavior diagnosis, Lookup/Picklist resolution, or a usable record link.

## Required workflow

1. Read [references/tool-workflows.md](references/tool-workflows.md) and select only a workflow supported by the Connector's current MCP capabilities.
2. Before mutation or diagnosis, read [references/safety-boundaries.md](references/safety-boundaries.md).
3. Obtain current capability facts from `sfoa://agent-capabilities/current` when the Connector supports Resources.
4. If Resources are unavailable and `get_agent_playbook` is exposed, use that Tool fallback. Never call an absent Tool.
# SFoA Salesforce Agent Playbook

Playbook-Version: 1.7.0
Workflow: ALL

## Runtime capabilities

- This is a distribution template. Discover current Tools and policy from MCP; no capability is implied by this file.
- Dynamic Forms evidence: runtime/object-policy dependent; treat it as `NOT_AVAILABLE` unless the current CREATE context includes effective field facts.

## BATCH — Bounded synchronous batch mutation

- Tool selection: 1 record uses the singular Tool; 2..200 independent records of one object prefer create_records or update_records when enabled. Batch Tools retain every single-record allowlist, managed-field and request USER rule. Never use DELETE or automatic UPSERT.
- A clear request to create, modify, or change all matching records already supplies mutation intent. Do not add confirmation merely because a batch is involved. Ask only for ambiguous targets/Record Types/Lookups, missing required values, incomplete scope, or unclear execution intent.
- Reuse action context for the same object, operation, Record Type and relevant field semantics. Prefer grouping by object + Record Type + relevant context. Different draft values that change Dynamic Forms, required dependencies or dependent Picklists require their own refinement; do not make identical metadata calls for every row.
- Each CREATE item carries its resolved recordTypeId and latest uiContextResolutionId when supplied. Never mix the Record Type of collected context with a different mutation RecordTypeId. DML fields always use API values and proven Lookup IDs.
- Use allOrNone=false by default for independent business records; allOrNone=true may protect a strongly related collection within one request. Neither setting creates a transaction across Tool calls or batches.
- For all matching records, prove the complete target scope before mutation: LIMIT, truncation, timeout, pagination or a missing completion indicator cannot prove all records were found. Continue bounded reads/pagination to establish completeness or stop and ask about scope. Never silently mutate a subset and report all complete.
- For an explicit scope over 200 records, split into bounded calls of at most 200, for example 500 becomes 200 + 200 + 100. Fix a finite plan from the known total; track total/processed/succeeded/failed/unknown throughout. Each batch is independent with no global allOrNone. Stop automatic continuation on any OUTCOME_UNKNOWN and verify state first; never loop indefinitely.
- Report SUCCESS only when all requested items have proven success. PARTIAL_SUCCESS means some items succeeded and some failed. Preserve clientReferenceId -> Salesforce recordId mapping from successful results; clientReferenceId is only correlation, never a Salesforce business field or idempotency key.
- If plural Tools are disabled, bounded singular calls may fulfill the same authorized business intent. Do not call an absent Tool or claim the entire business request is unsupported merely because batch execution is unavailable.

## COMPOUND — Complete the entire business intent

- Before mutation build a bounded internal intent checklist covering exactly the requested roots, child records and Lookup references. Do not create associated records the user did not request. One user intent is not necessarily one Salesforce record.
- Use get_record_relationship_context when enabled to identify current USER, CREATE-governed child objects and their relationship fields. Salesforce metadata supplies labels and structure; do not hardcode a business object, infer required children/cardinality, or invent a relationship. Ask when business role mapping is ambiguous.
- Resolve the whole intent, action contexts and required Lookups first. Create the root phase, obtain proven successful Salesforce IDs, then batch children by target object using those IDs. With multiple roots, assign unique clientReferenceIds, consume the explicit returned mapping, and set each child parent Lookup to the proven corresponding ID. Never guess mapping from names or result array positions.
- A failed or unknown root must not get children. No automatic DELETE or rollback across calls. A child failure does not erase a successful root; report each requested component and the overall partial result. An unknown result stops automatic continuation and requires independent USER verification.
- After all phases reconcile every checklist item against item-level Tool evidence. Root success is not business intent completion. Say creation complete only if every requested component succeeded; otherwise report PARTIAL_SUCCESS or OUTCOME_UNKNOWN with the remaining components.

## PICKLIST — Resolve Picklist and dependent values

- DML payloads, SOQL filters, Tool evidence and Audit use Salesforce raw API Value. Normal user-facing answers use current Salesforce Label, never a translation or guessed label. Raw values are default presentation only when the user explicitly asks for API values or for technical diagnosis.
- After raw SOQL, use resolve_field_display_values when enabled for displayed Picklist/MultiPicklist fields. Supply each record RecordTypeId, group mixed Record Types correctly, and resolve every A;B;C item separately. Current action-context API/Label pairs for the same field and Record Type may be reused. Preserve unresolved raw fallback with an explicit limitation; never call it a resolved Label.
- Whenever asking for a Picklist or multi-select Picklist value, show the bounded current valid choices returned by Salesforce action context for the active Record Type; never invent, translate, or normalize a stored Picklist API value.
- For dependent Picklists, confirm the controlling value first, apply the returned controller/dependency indexes, and show only values valid for that controller; never show the unfiltered dependent-value set.
- When Picklist evidence is unavailable, state that limitation and ask for confirmation rather than guessing.


## WorkBuddy identity

- Configure `Authorization: Bearer <USER_BOUND_TOKEN>`.
- Do not configure `X-Platform-User-Id`; the USER_BOUND token selects its Identity Route.
- Never request Salesforce credentials or pass identity selectors to Tools.

## MCP-managed fields

- Read current action context/capabilities before CREATE or UPDATE. Omit strict `PLATFORM_IDENTITY` and `AI_CREATED_MARKER` from questions, recommendations, and payloads. `PLATFORM_IDENTITY_FALLBACK` allows explicit user values resolved through LOOKUP. On CREATE match field API names to current required/editable facts: required and absent means ask once, explain the current-user default and wait; optional and absent means omit without asking. A default choice means omit the field without querying the current-user Lookup. Fallback is CREATE-only: never default it on UPDATE. Explicit Lookup changes use normal UPDATE + LOOKUP; never turn UPDATE into a CREATE form.

## Non-retryable uncertainty

For `MCP_DML_OUTCOME_UNKNOWN`, do not automatically retry. Verify with an independent USER read or report that the outcome remains unknown.

# Selected CREATE/UPDATE form context

`get_record_action_context.formContext` is the opt-in precise desktop path; omitted
calls retain the legacy response and Salesforce call counts. See the repository
design and fixed acceptance matrix in `docs/sfoa/RECORD_CHANGE_PRECISION_20261106.md`.

The context Provider owns bounded input/output schemas, selected standard-form
metadata resolution, deterministic field states, native Quick Action describe and
defaults, and optional recent-field statistics. It never mutates Salesforce.
The Host `FormDmlPreflight` checks a supplied form selection after governance and
managed-field preparation, then the existing deadline guard precedes dispatch.
Standard forms use the existing DML executor. Explicit native Create/Update Quick
Actions use one USER REST action request with the existing mutation observer and
definite-rejection versus unknown-outcome classification. Quick Action collection
execution is rejected; standard collections check each opted-in record.

The selected-form path lazily creates a separate, fixed DIAGNOSTIC scope solely
for current configuration reads. Its org must match the request USER org; USER
UI API remains the source of object/field access and record values. The temporary
scope closes in `finally` and the audit route is restored. Protocol/local/legacy
calls never create this scope. A request-local metadata Promise map can reuse the
same fresh configuration across a collection; it stores no evaluated USER draft
state and never survives the HTTP request. START/SUBMIT read or authoritatively
verify the current relevant configuration, never accepting a REFINE reference as
freshness proof. The existing Tool/request deadlines are unchanged; the precise
configuration/evaluation path has its own 45-second bound.

Two server-owned bounded caches reduce metadata latency. `FormMetadataCache`
allows only same-owner REFINE reuse (client/platform user/Salesforce USER plus
org/Profile/object/Record Type/action and app matching), with 32 entries, 16 MiB
total, 2 MiB per entry and 10-minute expiry. `PrecisionComponentCache` stores only
Profile app-default, application assignment and parsed FlexiPage projections
(32 entries, 4 MiB total, 1 MiB per entry). Every START/SUBMIT obtains current
Salesforce component ID/modification time and matches org/API/parser/type/fullName;
cold reads must have matching before/after revisions. Invalid/missing/epoch
revisions require fresh reads; a version change remains UNKNOWN. CustomObject
is always read fresh. Neither cache stores records, drafts, permissions,
Connections or evaluated field states. USER access and record facts remain live.

Explicit app wins; otherwise Profile.applicationVisibilities default is resolved
and checked against USER-accessible apps. No integration-default or last-used-app
substitution. Current Profile/CustomObject/CustomApplication and the winning
FlexiPage are read or revision-verified through SDK APIs; bounded directory reads join exact
identifiers. The old manual snapshot is not fresh proof for this contract.

Edit uses saved values plus patch. Field conditions use the draft; record-dependent
container conditions use saved values. New container semantics without proof stay
UNKNOWN. API, Page Layout, Dynamic Form and Quick Action required sources remain
separate. Critical unknown requiredness blocks readiness; irrelevant optional
unknown does not. Existing values and null/false/zero/absence remain distinct.
Native action Create requires an authoritative target Record Type; an absent
target is only resolved when USER ObjectInfo proves Master-only. An explicit
unchanged Update value can override an action preset and must be preserved.
Managed policy/injection cannot waive denied field write access or turn generated
fields into writable targets. Proven generated fields are not user-input obligations.
USER Describe `defaultedOnCreate` can discharge an absent CREATE API-only value
obligation as DEFAULT_ON_WRITE / SALESFORCE_DEFAULT_ON_WRITE. It cannot satisfy a
UI-required field, unresolved action preset, explicit empty/null or UPDATE value;
no fabricated initial value participates in visibility or the submitted payload.

`uiContextResolutionId` is unverified client correlation, never a permission or
approval token. P7 keeps counts/selection in summaries and protected fields/rules/
value provenance in lazy UI_CONTEXT payloads. Tool success is distinct from form
readiness. Both synchronous and asynchronous audit failures remain observational.

Effective requiredness is only proven when the resolved page is the page the
Record Type is assigned to. `coverage.requirednessIncomplete=true` (paired with
`requirednessIncompleteReason`) marks the two cases where it is not: the object
has a Record Type specific FlexiPage but this request resolved another page
(`RECORD_TYPE_PAGE_NOT_MATCHED`), or the whole resolution fell back to Page
Layout (`RESOLUTION_FALLBACK_*`). `crm-record-change` rule 44 forbids
`CHANGE_READY=true` on that signal; a detail-only Agent that ignores it will
save records with blank required fields, which is exactly what happened on the
`Account_Visit__c` 客户来访 records on 2026-11-09. Profile full names that
contain a slash are stored URL-encoded (`%2F`) in `Profile.fullName` while
FlexiPage assignments keep the raw name; `active-page.ts` decodes both sides
before comparing, otherwise every Record Type specific page is skipped.

Button-only requiredness is a separate form. `get_record_action_context` returns
`formContext.availableActions` on UPDATE — Salesforce's record-scoped
`/ui-api/actions/record/{id}` list, filtered to `QuickAction` and
`StandardButton`, capped at 30, with `evaluable` marking the actions this Tool
can resolve through `entry=QUICK_ACTION` (a Describe target on the same
object). Standard requiredness never proves a button's requiredness: resolve
the action by label, then read its own `missingRequired`. A failed actions read
sets `actionsError` and never fails the context call. Do not hardcode action or
child-object API names; child records come from the object's own
`childRelationships` and the role labels on them.

Precision is the default path. `SFOA_PRECISION_DEFAULT_FORM_CONTEXT` (default
true) makes a CREATE/UPDATE that omits `formContext` behave as
`{ entry: 'STANDARD', phase: 'START' }`, so the live selected-form read answers
instead of the snapshot. Callers that pass `formContext` keep their own choice.
When a defaulted request cannot resolve any selected form (status UNKNOWN with
formSource UNRESOLVED), the executor falls back to the snapshot context and adds
`PRECISION_FALLBACK_LEGACY_CONTEXT` to coverage warnings; an explicit
`formContext` never falls back. `sfoa_ui_snapshot` therefore only serves that
fallback path, and its refresh bound is `SFOA_UI_SNAPSHOT_REFRESH_TIMEOUT_MS`
(Admin, default 180s; the DB lease is the bound plus 60s). A real 203 refresh
measured ~160s, dominated by one Metadata read (~136s), so the old 120s bound
always timed out; the failure reason now carries the stage
(`SNAPSHOT_REFRESH_TIMEOUT_FLEXIPAGES` and similar) in `last_error`.

Focused gates: context `precision-*.test`, DML legacy suite, Host
`form-dml-preflight.test`/`form-context-facade.test` and native action integration,
Admin `FormContextEvidence`/`AuditTraceWorkbench` plus `precision-audit.spec.ts`.
Run broader server/P3/P4/P7/isolation and Skill checks after integration. Mock API
contracts, real API shape probes, actual Salesforce UI parity and actual agent
business acceptance are separate evidence levels; never substitute one for another.

# P8-07 runtime, batch and orchestration

`create_record` / `update_record` retain their singular schemas. Independently
governed `create_records` / `update_records` accept 1..200 same-object records and
reuse CREATE/UPDATE object authority. Public SDK array overloads issue one
POST/PATCH `/composite/sobjects`, with API >=42 and allowRecursive=false.
allOrNone defaults false; it never covers another request. No Bulk, DELETE,
UPSERT, global rollback or UNKNOWN retry exists. Managed fields resolve per item
before dispatch. Platform Lookup results are Promise-memoized only in the current
resolver/request; deadlines prevent late writes after preparation times out.

Batch outputs distinguish SUCCESS, PARTIAL_SUCCESS, FAILED and OUTCOME_UNKNOWN,
with total/succeeded/failed/unknown and indexed clientReferenceId outcomes. A
reference is never sent to Salesforce. Collection SaveResult order associates the
reference at the provider boundary; agents use the explicit returned mapping.
Malformed/incomplete responses are UNKNOWN; failed items never supply a parent ID.

P7 keeps one wire API row per collection. Batch submitted fields use explicit
`records[index].Field` keys in the compatible bounded scalar evidence column;
SALESFORCE_REQUEST/RESPONSE payloads retain bounded actual collection bytes.
BATCH_DML_OUTCOME records counts and partial metadata linked by publicApiCallId.
The compatible terminal enum remains unchanged; responseSummary has batch status
and counts, and the Admin Workbench shows PARTIAL_SUCCESS explicitly. Audit is
observational and fail-open; no synthetic per-item API rows are created.

`resolve_field_display_values` is a bounded USER read Tool. It resolves Picklist
and MultiPicklist API values from current UI API field/Record Type metadata,
retaining rawValue, displayValue, per-item status and unresolved raw fallback.
Limits: 200 values, 64 KiB input, 25 field/type groups, 5 seconds, 1 MiB per metadata
response and 256 KiB presentation output. Omitted Record Type means USER default;
mixed-type reads must supply each record's actual RecordTypeId. SOQL/filter/DML
evidence remains raw; normal answers use Salesforce labels.

`get_record_relationship_context` reads USER describe metadata for one root and
at most 20 CREATE-governed child relationships in 5 seconds. Child object and
relationship-field createability must both be true. It reveals possible schema
relationships, never required children or business cardinality. Composition Hint
is not implemented: no proven semantic gap justifies another configuration layer.

CREATE initial facts distinguish USER_EXPLICIT, SALESFORCE_CREATE_DEFAULT,
CURRENT_USER_FACT and TRUSTED_RUNTIME_DEFAULT. Explicit > Salesforce > runtime;
missing dependencies use UNRESOLVED provenance rather than claiming a supplied value.
trustedForVisibility and resolutionStatus remain separate. Managed DML defaults
are not proven Lightning defaults and are not used to decide visibility.
Only needed USER fields are requested through current USER UI API optionalFields
(25 fields, 32 KiB response, existing shared 3-second extra-read deadline). FLS
omission/failure/bounds remain UNKNOWN. P7 UI_CONTEXT payload carries provenance
and dependencies; main summaries contain counts. Unsupported record-dependent
containers remain UNKNOWN because field sections do not react to unsaved drafts.
USER/form-factor rules can be evaluated for supported container ancestry.

Canonical Playbook 1.7.0 owns BATCH/COMPOUND/PICKLIST guidance and all client
renderers. Complete the intent checklist, use proven parent IDs, prove complete
UPDATE scope, and split >200 into a finite request plan. A truncated query is not
permission to update a subset. Clear user mutation intent requires no second
batch confirmation. Disabled plural Tools permit bounded singular execution.

See `docs/sfoa/P8-07-IMPLEMENTATION-REPORT.md` for exact verification and external
UAT limitations. Fixture and guidance contract tests do not prove live LLM behavior
or equivalence with every Lightning page.

`node scripts/p8-07-live-batch.mjs` is an opt-in workspace validator, not a business
Tool. It requires the existing env-backed test object CREATE/UPDATE allowlist and
A/B USER routes; it does not copy or modify MySQL policy. It creates two test rows
per USER, verifies one collection request per CREATE/UPDATE, then cleans up only
proven test-owned IDs through the existing validator cleanup pattern. Missing
policy/fixtures are BLOCKED, never grounds for bypassing governance.

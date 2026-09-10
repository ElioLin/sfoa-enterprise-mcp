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

`isError` reports whether the Tool execution completed, not whether every record
succeeded: SUCCESS and PARTIAL_SUCCESS return `isError=false`, and only FAILED and
OUTCOME_UNKNOWN are Tool errors. A PARTIAL_SUCCESS already committed its successful
items, so treating it as a Tool error would route clients into a correction/retry
path that could duplicate CREATE; clientReferenceId is correlation, never an
idempotency key. Guidance requires re-preparing only the FAILED items in a new
batch, and never an automatic retry after OUTCOME_UNKNOWN.

`update_records` rejects two items for the same record before dispatch
(`MCP_DML_BATCH_DUPLICATE_RECORD_ID`). Comparison uses the 15-character canonical
identity because 15- and 18-character IDs of one record differ only by checksum;
one collection request cannot express two different updates to the same record.
The MCP Server host preflight runs this check right after input parsing and before
any Salesforce Connection acquisition, managed-field lookup or allowlist read, so a
duplicate batch costs no Salesforce round trip; `DmlExecutor.batch()` keeps the same
check as defense-in-depth for callers that bypass the host. Both layers share one
identity rule, code and message.

P7 keeps one wire API row per collection. Batch submitted fields use explicit
`records[index].Field` keys in the compatible bounded scalar evidence column;
requested fields use the same convention. SALESFORCE_REQUEST/RESPONSE payloads
retain bounded actual collection bytes. BATCH_DML_OUTCOME records counts and
partial metadata linked by publicApiCallId. The compatible terminal enum remains
unchanged; responseSummary carries `businessOutcome`, `batch` status, counts and
`partial`, and the Admin Workbench shows PARTIAL_SUCCESS explicitly. The audit
`result`/`outcome` still describe the Tool invocation, so a partial commit is never
recorded as a complete SUCCESS or a complete FAILED. Terminal audit request
summaries for batches report `batch`, `objectApiName`, `totalCount`, `allOrNone`
and the bounded union of requested field names, never `fieldCount=0` from reading
the singular `fields` shape. Audit is observational and fail-open; no synthetic
per-item API rows are created.

Diagnosing a batch DML audit row: `responseSummary.businessOutcome` is the
authority for the business mutation result, and `audit.result` / `audit.outcome` is
only the MCP Tool invocation terminal state. A `PARTIAL_SUCCESS` batch therefore
appears as `result=PASS` / `outcome=SUCCESS` with no failed event and no failed
Salesforce API row, because the collection POST itself returned 200 and only
individual items were rejected. Never summarize such a row as 全部成功 (the
successful items were committed, the rejected ones were not) and never as a
whole-Tool failure either. Both the Admin Workbench and `scripts/audit-trace.mjs`
report the batch business outcome as a distinct `BATCH_BUSINESS_OUTCOME` /
业务结果 status, and neither infers batch success from the terminal columns alone.
`OUTCOME_UNKNOWN` keeps priority: an unprovable commit state is never displayed as
SUCCESS and must never be retried automatically.

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
are not proven Lightning defaults and are not used to decide visibility, so the
server supplies no TRUSTED_RUNTIME_DEFAULT provider by default: Managed Lookup
resolution must not run as a side effect of observing Dynamic Forms. A
caller-supplied trusted provider stays read-only, request-USER and bounded, is
never overridden, and must prove its Lightning CREATE initial-value semantics.
A failure inside it is isolated: the affected dependencies become explicit
UNKNOWN facts with a bounded reason and the remaining resolution still computes;
only genuine metadata/snapshot failure keeps the existing whole-resolver
PAGE_LAYOUT fallback contract. Record-dependent CONTAINER visibility remains
UNKNOWN with CONTAINER_RECORD_UNSUPPORTED evidence.
Only needed USER fields are requested through current USER UI API optionalFields
(25 fields, 32 KiB response, existing shared 3-second extra-read deadline). FLS
omission/failure/bounds remain UNKNOWN. P7 UI_CONTEXT payload carries provenance
and dependencies; main summaries contain counts. Unsupported record-dependent
containers remain UNKNOWN because field sections do not react to unsaved drafts.
USER/form-factor rules can be evaluated for supported container ancestry.

Canonical Playbook 1.8.0 owns BATCH/COMPOUND/PICKLIST guidance and all client
renderers; Server Instructions, Dify Instruction, WorkBuddy System Prompt,
WorkBuddy Skill and the WeCom role setting render the same selection matrix and
must not drift. Complete the intent checklist, use proven parent IDs, prove
complete UPDATE scope, and split >200 into a finite request plan. A truncated
query is not permission to update a subset. Clear user mutation intent requires
no second batch confirmation.

Tool selection is capability-driven: both enabled — 1 record uses the singular
Tool, 2..200 use the plural Tool; singular only — 1 record uses the singular Tool
and 2..200 use bounded singular calls; plural only — 1 record uses the plural Tool
with exactly 1 item and 2..200 use it normally; neither — the operation is
unavailable. The Agent is never told to call a Tool absent from `tools/list`.

`get_record_relationship_context` is bounded evidence, not an exhaustive schema.
A `truncated=true` or `resolutionStatus=PARTIAL` result is non-exhaustive, so a
named relationship must never be reported as non-existent on that basis: continue
with the enabled bounded metadata capability, then ask the user once if it is
still undetermined. Never widen recall by dumping the whole Org Schema.

See `docs/sfoa/P8-07-IMPLEMENTATION-REPORT.md` for exact verification and external
UAT limitations. Fixture and guidance contract tests do not prove live LLM behavior
or equivalence with every Lightning page.

`node scripts/p8-07-live-batch.mjs` is an opt-in workspace validator, not a business
Tool. It requires the existing env-backed test object CREATE/UPDATE allowlist and
A/B USER routes; it does not copy or modify MySQL policy. It creates two test rows
per USER, verifies one collection request per CREATE/UPDATE, then cleans up only
proven test-owned IDs through the existing validator cleanup pattern. Missing
policy/fixtures are BLOCKED, never grounds for bypassing governance.

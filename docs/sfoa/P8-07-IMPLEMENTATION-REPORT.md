# P8-07 implementation evidence

Status: READY_FOR_UAT_WITH_LIMITATIONS. Local engineering gates pass after the
documented fixes/retests. Live mutation and independent Lightning/Agent acceptance
are not complete; this report does not declare P8-07 COMPLETE.

## Baseline and pre-implementation review

Fetched GitHub origin/main on 2026-09-09 and created
`feature/p8-07-runtime-batch-orchestration` at
`5c623ef13a88f9e20e2cf897f56b213ebcb2994e`.
The pre-existing untracked OpenClaw deployment guide is excluded from this work.

Git branch: `feature/p8-07-runtime-batch-orchestration`. Implementation commit:
`8a27b3bb020fd63c11ca39a2006e05d7ff63e435`. Doctor delivery fix and successful
committed-HEAD smoke: `f3173af3bfbda33e99a810a00e794b2aae7445f2`.
The final evidence-only commit changes this report/verification record; runtime,
Skill source and generated artifact bytes are those verified above.
The complete [81-file manifest](P8-07-CHANGED-FILES.txt) includes code,
tests, canonical documentation and generated artifacts; no environment file,
credential, dependency or lockfile is part of this change.

- Dynamic Forms: `effective-ui-resolver.ts` already merges UI API Create Defaults
  with validated drafts. It loses provenance in that merge; the USER resolver
  supplies only SOAP identity/profile/language facts. `visibility.ts` recognizes a
  fixed USER field list and always rejects record-dependent container evaluation.
  The parser already propagates section/tab/accordion rules to their descendants.
  Managed DML defaults are resolved later in the host, not in the CREATE context.
  Post-save defaults must not be treated as Lightning initial values.
- Display: UI API action context has Record Type picklist values/labels, whereas
  display context contains field/layout metadata, not raw-value resolution. Official
  SOQL returns raw evidence. A separate bounded USER presentation Tool preserves it.
- Batch: pinned `@salesforce/core` 8.29.0 delegates to JSforce 3.10.13.
  Public `sobject(name).create(records, options)` and `update(records, options)`
  have typed array overloads returning SaveResult[]. On API >=42 they issue one
  POST/PATCH `/services/data/vXX.X/composite/sobjects`. Older versions silently use
  parallel singles, so batch must reject them. Set allowRecursive=false and validate
  1..200 before dispatch. allOrNone defaults false and covers this request only.
- Compound intent: canonical CREATE says call create_record once and UPDATE says
  exactly one target. There is no intent-completion checklist. Current USER describe
  childRelationships plus child field metadata can express structural relationships;
  bounded filtering by the existing CREATE allowlist avoids org-schema exposure.
  No evidence justifies adding Composition Hint or a business rule engine.

## Primary API references

- [Salesforce platform API comparison](https://developer.salesforce.com/blogs/2024/04/accessing-object-data-with-salesforce-platform-apis): collections support 200 writes and allOrNone.
- [Collection create](https://developer.salesforce.com/docs/platform/mobile-sdk/guide/ref-rest-apis-collection-create.html): request-local rollback.
- [Dynamic Forms considerations](https://help.salesforce.com/s/articleView?id=sf.dynamic_forms_considerations.htm&language=en_US&type=5): field sections do not react to unsaved edits. Preserve UNKNOWN for unproven record-dependent container initial semantics; USER/form-factor rules remain independently evaluable.

## Implementation and compatibility decisions

| Tool | Responsibility |
| --- | --- |
| `create_record` | One record; original schema and behavior, including optional Record Type/context ID |
| `update_record` | One proven target ID; original field and identity restrictions |
| `create_records` | 1..200 same-object records, per-row Record Type/context/reference, one collection CREATE |
| `update_records` | 1..200 same-object records with explicit IDs, one collection UPDATE |
| `resolve_field_display_values` | Current USER, Record Type-aware Picklist/MultiPicklist presentation only |
| `get_record_relationship_context` | Bounded USER relationship metadata filtered by existing CREATE governance |

There is no `BATCH_CREATE`/`BATCH_UPDATE` permission. Provider registries feed host
startup validation, effective Tool lists, `MCP_ENABLED_TOOLS`, Admin governance and
capabilities. Plural Tools are separately enabled but share the existing object
CREATE/UPDATE authority. Discovery, local Resources/Prompts and Playbook retrieval
do not initialize Salesforce Connections. Business DML never uses DIAGNOSTIC.

Every batch item passes allowlist checks and the existing Managed DML resolver.
Strict identity fields and AI markers override client values. User-overridable
fallback preserves explicit intent; CREATE-only fallback stays CREATE-only.
Managed Lookup results are cached only within the current request resolver. The
deadline guard prevents a late Lookup completion from dispatching a mutation.
No new permission engine, business-object special case or Composition Hint exists.

The SDK call is `connection.sobject(objectApiName).create(records, options)` or
`.update(records, options)`, where options are `{allOrNone, allowRecursive:false}`.
The request is POST or PATCH `/services/data/vXX.X/composite/sobjects`, maximum
200 records. API <42 is rejected to avoid the SDK's older per-record fallback.
One call means one **collection mutation** request; prior authentication, context
and managed Lookup reads are distinct observable calls, not hidden in that count.
`allOrNone=false` is default. `true` applies only to this Salesforce request.

The provider validates the entire SaveResult envelope before emitting proven IDs;
UPDATE IDs must match their input. Salesforce collection result order is associated
with clientReferenceId at this boundary, exercised with the pinned SDK wire fixture.
The Agent consumes explicit references, never guesses parent mapping from array
positions. Malformed/missing responses, transport exceptions and timeouts after
dispatch remain UNKNOWN without retry. Structured native rejection remains FAILED.

## CREATE facts and remaining Dynamic Forms boundary

The initial state records path, scalar value, provenance, trust and resolution:
USER_EXPLICIT > SALESFORCE_CREATE_DEFAULT > TRUSTED_RUNTIME_DEFAULT. CURRENT_USER_FACT
is a separate USER namespace; unavailable dependencies have UNRESOLVED provenance.
Null, false, zero, empty and missing remain distinct. Post-save Flow/Trigger values
and Managed DML values without proof of Lightning initialization are never used
as visibility authority.

Actual `$User.Field__c` dependencies are collected from normalized page metadata.
Reads use current USER UI API optionalFields: at most 25 additional fields, 32 KiB
response, within the existing shared three-second extra-read budget. Omitted FLS
fields, timeout and truncation stay UNKNOWN. There is no whole-User query or
Diagnostic fallback. Section/tab/accordion ancestry is already propagated by the
parser. USER/form-factor container rules are supported; record-dependent CREATE
container semantics remain conservatively UNKNOWN. API-required fields survive
UNKNOWN/hidden UI rules. OFF/SHADOW/Page Layout fallback retain legacy behavior.

## Raw/display separation

`run_soql_query` and its raw evidence contract are unchanged. The new presentation
Tool resolves current UI API Picklist labels per field and Record Type; mixed-type
rows carry their own RecordTypeId. MultiPicklist resolves each semicolon-separated
item and preserves explicit unresolved raw fallback. It never translates values.
Limits: 200 inputs, 64 KiB input, 25 field/type metadata groups, five-second reads,
1 MiB per metadata response, 256 KiB presentation output. Metadata failure returns
UNRESOLVED raw rows. API values remain the DML/filter/Audit authority.

## Audit

- Single: the existing submitted-fields and terminal contracts are preserved.
- Batch: one real wire API row, exact post-managed-field payload captured as bounded
  SALESFORCE_REQUEST evidence, and indexed submitted fields (`records[0].Field`).
  Each CREATE row can link its opaque UI context ID as unverified provenance.
- Partial: historical terminal enums remain compatible. `responseSummary` and
  `BATCH_DML_OUTCOME` carry `PARTIAL_SUCCESS`, total/success/failure/unknown counts,
  allOrNone, API type, latency and bounded first failure. Admin Workbench displays
  partial completion explicitly; HTTP 200 does not mean every record succeeded.
- Unknown: Tool timeout, request timeout and disconnect retain UNKNOWN without
  replay. Outer HTTP errors and terminal Audit include batch unknown counts.
  Transport loss cannot prove a Salesforce commit or rejection.
- Dynamic Forms: protected UI_CONTEXT payload includes dependency values and
  sources, criterion evaluation, FIELD/CONTAINER scope, unknown reasons and initial
  provenance. Main summaries contain counts/fallback/read bounds. Unrelated draft
  values are omitted. Payload retention/truncation uses existing P7 controls.

Audit remains observational and fail-open. Tests inject synchronous logger failures,
writer failures and transport failures; evidence cannot replace business outcomes.
No synthetic per-record Salesforce API rows or unbounded 200-row summaries are added.

## Agent before / after

These are canonical behavior contracts and fixture scenarios, not claims of live
LLM/New-page acceptance.

| Scenario | Before | After |
| --- | --- | --- |
| Default organization controls Dynamic Forms | Defaults were merged without provenance; custom USER dependencies could not resolve | Trusted Create Defaults and explicit draft precedence drive supported field rules; actual USER dependencies resolve within bounds; unproven container/default facts remain UNKNOWN |
| SOQL returns `COMPLETED` | Agent could expose API value directly | Resolve current Salesforce label (for example `已完成`) for normal business answers; DML/filter/raw evidence remain `COMPLETED`; unavailable label is explicitly unresolved |
| 客户拜访 root + 3 internal + 2 customer participants | Single-record guidance could stop after root | Complete requested checklist; resolve metadata/Lookups; create root; use its proven ID in two child batches; report six components, ordinarily three mutation calls; no hardcoded production objects |
| Update 50 records | Guidance required exactly one target | Prove the complete unambiguous set, group same-object semantics, one `update_records`; report actual success/failure counts |
| Update more than 200 records | Batch intent was unsupported | For 500 proven targets, finite 200 + 200 + 100 requests; track counters, disclose request-local transactions; stop continuation on UNKNOWN; never silently mutate a truncated subset |

Canonical Playbook 1.7.0 owns these behaviors. Deterministic renderers propagate
them to Server Instructions, Dify, WorkBuddy Skill/system prompt and WeCom role
settings. The Tool selection rules do not add a second batch confirmation when
the user's mutation intent and scope are already clear. Disabled batch Tools can
fall back to bounded singular calls. Root success alone never completes an intent;
partial child failure never triggers automatic root DELETE/rollback.

## Verification and regression

Validation ran on 2026-09-09/10. Exact commands, working directories, initial
failures and final retests are recorded in [P8-07-VERIFICATION.json](P8-07-VERIFICATION.json).
The lint scripts use TypeScript `--noEmit`; these packages do not declare a
separate `typecheck` script. Builds and lint both enforce their strict tsconfig.

| Workspace | build | lint / typecheck | test |
| --- | --- | --- | --- |
| `@sfoa/mcp-provider-sfoa-dml` | PASS | PASS | PASS, 40 |
| `@sfoa/mcp-provider-sfoa-context` | PASS | PASS | PASS, 80 |
| `@sfoa/agent-playbook` | PASS | PASS | PASS, 28 |
| `@sfoa/identity-runtime` | PASS | PASS | PASS, 75 |
| `@sfoa/control-plane` | PASS | PASS | PASS, 38 + 14 MySQL |
| `@sfoa/mcp-server` | PASS | PASS | PASS, 152 + P3 25 + P4 8 + P5 6 + P7 6 |
| `@sfoa/admin-api` | PASS | PASS | PASS, 25 |
| `@sfoa/admin-web` | PASS | PASS | PASS, 71 |

| Command | Result |
| --- | --- |
| `yarn workspace @sfoa/mcp-provider-sfoa-dml lint` | PASS |
| `yarn workspace @sfoa/mcp-provider-sfoa-dml test` | PASS, 40; nested Yarn Windows failure fixed by using the existing direct local TypeScript invocation pattern |
| `yarn workspace @sfoa/mcp-provider-sfoa-dml build` | PASS |
| `yarn agent:sync` / `yarn agent:check` | PASS, five generated Agent files |
| `yarn skill:sync` / `yarn skill:check` / `yarn skill:delivery` / `yarn skill:test` | PASS; 12 tests |
| `yarn skill:smoke` | PASS on `f3173af3bfbda33e99a810a00e794b2aae7445f2`; five required gates and expected missing-env Doctor behavior verified from 1,012 committed files |
| `yarn validate:p5` | PASS, including MySQL, three mocked browser E2E tests and one real fullstack browser test |
| `node dist/validation/upstream-compatibility.js` (server workspace) | PASS, no upstream Tool drift |
| `node dist/validation/p4-main.js` (server workspace) | PASS, live Salesforce |
| `node dist/validation/p3-main.js` (server workspace) | FAIL under current MySQL fixture assumptions; env-mode test run also FAIL on native validation |
| `node scripts/p8-07-live-batch.mjs` | BLOCKED, configured test object is not env-allowlisted; zero mutations |
| Independent Lightning/client business acceptance | BLOCKED, no supplied acceptance session |

The broad regression runner initially failed on old four-Tool/provenance/version
assertions and on an HTTP-client test expecting a Tool result for an SDK-level
201-record schema rejection. Corrected assertions and full affected-suite retests
pass. The unrelated-draft audit leak found during P4 regression was fixed by
retaining values only for visibility dependencies. A legacy P8-05 MySQL fixture
now explicitly disables the independent P8-06 channel, avoiding local-environment
contamination while preserving both runtime paths.

The first P7 load run hit HTTP 504 under concurrent local gates and left its test
process alive; it was terminated and retained as FAIL. The isolated rerun passed
all six tests, including 50/100/200 paired load with no failures or cross-Audit
binding. This is correctness evidence, not a production latency guarantee.

The first committed-HEAD Skill smoke exposed a pre-existing Doctor shape mismatch:
when the Playbook is not built, SKIPPED omitted the `problems` array required by
the toolkit contract. The canonical Doctor now returns an empty array for that
case, with no change to runtime authorization; all platform copies are synced.
The original smoke failure remains recorded alongside its committed retest.

The code tests cover Create Defaults/override/USER missing facts/bounds/fallback,
required-field survival, Picklist and mixed Record Types, 1/2/200/201 batch bounds,
allowlist denial, Managed Fields, Salesforce validation/sharing/FLS errors,
allOrNone, partial/unknown, duplicate references, request USER isolation, one SDK
wire call, root/child phases and explicit parent mappings. Guidance tests cover
complete UPDATE scope, ambiguous A/B/C, truncation, >200 continuation and no
unrequested children. These are not live LLM evaluations.

Regression checks include WeCom P8-06 discovery/call identity, BUNTU_TOKEN,
USER_BOUND/Internal routing, lazy USER/DIAGNOSTIC Connections, singular DML,
Record Type, Dynamic Forms/action context, SOQL raw evidence, P7, Tool Governance,
Admin UI, Dify and WorkBuddy generation. Real MySQL tests run against the existing
test database, not by changing production governance.

Live evidence currently distinguishes:

- P4 USER A/B action context and isolation, independent Diagnostic tooling and
  Metadata, and workspace cleanup: PASS.
- Additional live USER fact probe: `$User.Department` resolves through one bounded
  current USER UI API call; only resolution metadata, not its value, is published.
- P3 live mutation: Salesforce FIELD_CUSTOM_VALIDATION_EXCEPTION rejects the
  existing CREATE fixture, so successful UPDATE/forged-ID mutation gates cannot
  complete. Native authz-denial fixture is unavailable. No records were created.
- `node scripts/p8-07-live-batch.mjs`: BLOCKED before dispatch by
  MCP_DML_OBJECT_NOT_ALLOWED in the env-backed test policy. The validator does
  not synthesize an allowlist or change MySQL policy. Successful live collection
  mutation remains unverified; the real SDK/HTTP contract tests are separate PASS
  evidence. Test cleanup is limited to proven IDs created by that validator.
- Independent Lightning/New page comparisons and live Dify/WorkBuddy/WeCom Agent
  execution of the compound scenarios: BLOCKED, no acceptance session supplied.

## Remaining risks and acceptance

1. No transaction spans batches or parent/child Tool calls. Partial business
   completion requires explicit reporting and a subsequent authorized repair.
2. UNKNOWN CREATE can remain unverifiable without a unique business key. Never
   retry automatically or treat missing responses as rejection.
3. Salesforce synchronous requests cap at 200 and retain API quotas, CRUD/FLS,
   sharing, validation and automation limits. Existing HTTP/payload bounds still
   apply. Frequent larger workloads may justify future P8-xx Async Bulk DML.
4. Record-dependent container initialization, unsupported metadata/form factors,
   custom overrides and stale snapshots cannot be claimed to reproduce every
   Lightning page. They retain UNKNOWN/fallback evidence.
5. Schema relationships do not express all business cardinality/roles. Clarify
   genuinely missing semantics; no speculative Composition Hint was introduced.
6. Final P8-07 COMPLETE requires valid authorized live mutation fixtures and
   independent Lightning/client acceptance. This implementation does not waive
   those conditions because local contract tests pass.

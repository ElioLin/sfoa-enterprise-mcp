# P8-04 effective CREATE: operation and Audit diagnosis

AMEND-006 permits production implementation before independent New UI benchmarking.
Delivery is READY_FOR_UAT_WITH_LIMITATIONS, not final accuracy acceptance. The
authoritative implementation report is `docs/sfoa/P8-04-IMPLEMENTATION-REPORT.md`;
architecture is ADR-0019. Historical A-01 development stop instructions are superseded.

## Runtime and controls

`get_record_action_context` keeps the existing Page Layout algorithm. CREATE alone
may evaluate Dynamic Forms. Inputs `draftFields` and `refinement` are optional;
in ENFORCE, draft keys/types must match current USER ObjectInfo. OFF ignores DF
semantic validation; SHADOW records invalid drafts without changing the legacy result. Missing/null/false/zero/empty
remain distinct. The Agent can refine at most three times and must stop on stable
dependencies or `refinementLimitReached`. No conversation state is stored by this
contract; clients must preserve the refinement count.

MySQL runtime settings reuse current optimistic Admin updates:

- `dynamicFormsObjectPolicies`: <=25 unique exact object API names, each with
  `mode: OFF|SHADOW|ENFORCE` and optional `defaultApp`; no wildcard/global ENFORCE.
- `integrationDefaultSalesforceAppDeveloperName`: optional single App name, nullable.

These are deployment/integration settings in the existing single-org runtime;
snapshot rows are additionally org/object scoped. No process or cross-USER cache
of evaluated fields or draft values exists. Env/legacy hosting defaults OFF.
Existing managed Lookup fallback remains CREATE-only and preserves explicit values.

Explicit `X-Salesforce-App-Developer-Name` beats object default then integration
default. The USER `/ui-api/apps` must verify access and its AppDefinition/Metadata
join. Without an App, every accessible App must converge. `X-Salesforce-Form-Factor`
accepts Large/Medium/Small (default Large); Medium/Small conservatively fall back.
These headers select UI context, never Salesforce identity or permissions.

OFF adds no Metadata/USER/snapshot reads. OFF, SHADOW, resolved PAGE_LAYOUT and
all Page Layout fallbacks return the exact legacy Tool output, including coverage
and managed-field enrichment: no UI protocol or resolution ID. Only ENFORCE with
supported DYNAMIC_FORMS/validated MIXED and no fallback exposes uiContext and
uiContextResolutionId. SHADOW isolates all extra-work errors, including draft
semantics and synchronous/asynchronous Audit errors. ENFORCE retains structured
USER_INPUT_ERROR for invalid drafts; infrastructure/parser/evaluator errors remain
DYNAMIC_RESOLUTION_FAILURE fallbacks. Original USER UI API/input failures keep
their existing semantics. Resolver version P8-04.2 uses one 3s total extra-read
budget; underlying API cancellation is not guaranteed. No background work/cache.

## Refresh and stale snapshots

After deploying migration `012_p8_ui_snapshot`, the Admin page `/ui-context` allows
object policy/default App editing and one-object refresh. The authenticated API:

- `GET /admin/api/ui-context/snapshots` returns bounded summaries, no raw snapshot.
- `POST /admin/api/ui-context/<ObjectApiName>/refresh` with `{}` requires existing
  session, Origin and CSRF protections. Configuration comes only from Salesforce.

Refresh needs a verified, enabled DIAGNOSTIC route different from active USER
routes. It reads CustomObject, AppDefinition, Profile IDs/display names and Metadata
fullNames, relevant Record Types, CustomApplications and referenced FlexiPages via
the official SDK. DIAGNOSTIC never supplies USER FLS or performs business DML.
Application reads are at most two concurrent batches of ten. Bounds: 100 Apps,
500 Profiles, 200 RTs, 100 referenced pages, 1000 instances/page, 2 MiB/snapshot.

The single current row stores normalized JSON, hash, refresh timestamp/status/error
and parser version. `lastModified` is nullable because no authoritative aggregate
timestamp is obtained. No raw XML, history, user business rows or Git data source
is persisted. Admin wait is 120s; the 180s DB lease permits retry after abandonment.
Failure preserves the previous JSON/hash/refreshedAt. No background/lazy refresh.
Snapshots older than 24h, REFRESHING or FAILED are usable if their last data parses,
with SNAPSHOT_STALE evidence; missing/invalid data fall back. API cancellation is
not guaranteed, but abort checks prevent subsequent batches/late publication.

## Trace a created record back to its context

1. Start with `yarn ai:audit --trace <publicAuditId>` (or `--correlation`, `--user`,
   `--tool`, `--since`). A supplied runId is a client grouping hint, not an existing
   P7 column. Find the concrete publicAuditId; do not invent run/session joins.
2. In a CREATE trace locate `UI_CONTEXT_LINK`. NOT_PROVIDED means no deterministic
   cross-call source was supplied. CLIENT_PROVIDED_UNVERIFIED is explicitly untrusted.
3. Run `yarn ai:audit --ui-context <UUID> --since 24h --latest 20`. This read-only,
   parameterized event lookup finds source and linked calls. Expand `--since` only
   when needed. Match source USER/object/RT, time ordering and the latest refinement.
   A copied/forged ID or a missing/expired source is not verified provenance.
4. Inspect `UI_CONTEXT_RESOLVED` / `UI_CONTEXT_RESOLUTION_FAILED`: mode, usedForAgent,
   pageLayoutId, page, assignmentSource, snapshot hash/refreshedAt, parser/resolver,
   profile reference, App, form factor, coverage and fallback reason. The master
   Audit row carries the request identity reference. `usedForAgent` indicates that
   effective DF fields replaced the legacy result; OFF/SHADOW/PL/fallback are false.
   Their resolution IDs remain internal. Admin displays usedForAgent and
   SNAPSHOT_STALE alongside snapshot hash/refreshedAt. Layout fullName remains
   deferred: current refresh has no reliable Layout ID/name map; do not infer a
   name from Lightning Page or add a runtime Metadata lookup.
5. In Admin Audit detail open 页面上下文 and then 字段依据. Only explicit payload
   access loads bounded `UI_CONTEXT` fields/rules. These contain decision results,
   criterion kinds, required provenance and dependencies, never original draft
   values or rule literals. Respect P7 truncation/retention/partial evidence.
6. Compare the Context output and actual submitted DML evidence. The resolution ID
   never changes fields sent to Salesforce or authorizes a write. `create_record`
   makes no Metadata resolution call and preserves CRUD/FLS/validation behavior.

## Locate the failing layer

| Evidence | Investigate |
| --- | --- |
| APP_CONTEXT_REQUIRED / APP_CONTEXT_INVALID / APP_CONTEXT_ERROR | Explicit/default App, current USER access, unique DurableId/namespace/fullName join |
| USER_CONTEXT_ERROR / RECORD_TYPE_CONTEXT_ERROR | SOAP identity, Profile ID→Metadata fullName, available RT→developer fullName |
| ASSIGNMENT_RESOLUTION_ERROR / ASSIGNMENT_DEFAULT_INHERITANCE_UNKNOWN | Assignment priority/conflicts; compare the same USER/RT/App/New entry |
| SNAPSHOT_MISSING / SNAPSHOT_UNAVAILABLE / SNAPSHOT_STALE | Current row, lease/error/timestamp; refresh one selected object |
| PARSER_ERROR / FLEXIPAGE_* / UNREACHABLE_FIELDS / UNSUPPORTED_PAGE | Parser version, structural traversal, inherited/unsupported page |
| PENDING | Supported missing field dependency; reuse prompt values, then bounded refinement |
| UNKNOWN / VISIBILITY_EVALUATION_ERROR | Unsupported relationship/permission/container semantics; do not guess |
| Correct context, wrong question/recommendation | Agent extraction/recommendation; check canonical Playbook 1.6.0 and returned facts |
| Salesforce DML rejection | Existing P7 Salesforce error/fields; Dynamic Forms cannot bypass validation/Flow/Trigger |

Runtime supports field EQUAL/EQ, NE/NOT_EQUAL, GT/GE/LT/LE, CONTAINS, explicit null
operators, AND/OR and bounded booleanFilter. Missing right operands stay UNKNOWN.
Reliable USER Id/ProfileId/Profile.Name/UserType/language and form factor facts are
supported. Unavailable Permission facts, arbitrary relationships, record-dependent
container rules and inherited pages remain conservative. Custom New overrides are
detected and not evaluated; DF UPDATE is not enabled; READ is unaffected.

## Verification and UAT

Use `node scripts/p8-04-regression.mjs [workspace ...]` for direct local executables
when Windows nested Yarn shells fail. It preserves test process isolation (SIGTERM
tests require it). Logs live under ignored `.temp/p8-04-regression`.
`node scripts/p8-04-readonly-smoke.mjs --object <ObjectApiName>` reads one object's
configuration through DIAGNOSTIC and emits only counts/bytes/costs; it does not
persist snapshots, change policies, run DML or establish UI accuracy.

Real UAT follows `docs/sfoa/P8-04-UAT.md`: Page Layout equivalence, simple DF,
prompt/dependency visibility, USER/Profile/App variation and fallback. Preserve
100% Page Layout regression and final >=90% DF/Agent, >=95% RESOLVED accuracy gates.
Use Audit to classify HOTFIXes. Leave uncertain objects SHADOW/OFF and stop at
READY_FOR_UAT until the Maintainer completes actual Agent/UI acceptance.

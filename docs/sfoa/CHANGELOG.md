# SFoA Project Changelog

This changelog records SFoA baseline and architecture changes. Salesforce Upstream release history remains in its original package changelogs and Git history.

## 2026-10-09 — P10-T5: `get_platform_diagnostics`, a merged evidence timeline and a batch fixture that measured the platform

T5 delivers **GAP-M5**, the Tool an incident starts with. `get_platform_diagnostics` reads three
platform-status sources in one call — `SetupAuditTrail` (what changed), `AsyncApexJob` failed and aborted
(what broke), `CronTrigger` (what stopped firing) — and merges them onto **one clock** in
`alignment.timeline`, so "the nearest change above the symptom" is a position in a list instead of three
calls and three renderings reconciled by hand.
[ADR-0033](adr/ADR-0033-p10-platform-diagnostics-stall-rule-and-degradation-matrix.md) records the three
decisions the task left to the implementation: the **stall rule** (`SUSPECTED` requires a waiting literal
*and* a fire time more than 30 minutes past; an unfamiliar state is `INDETERMINATE` rather than healthy,
because this org holds zero `CronTrigger` rows and the vocabulary was never measured), the
**degradation matrix** (per-section `READ`/`UNAVAILABLE`, `totalCount: null` on unavailable — never 0),
and the **whitelist**, narrowed from ADR-0029 §4a's four objects to three standard-API ones.

**A zero-entry section has to be *evidenced*, or it is just a quiet lie.** The failure section carries a
window-independent status-vocabulary read beside its entries, so a zero-match filter is visibly a filter
that ran against a real table; a failed vocabulary read beside a zero match degrades the section to
`UNAVAILABLE`. The setup section carries the trail's **oldest retained row** as a measured bound — the
prompt's "~90 days" is not exposed to SOQL, so the hint states the line this org can actually show
(2026-04-13) instead of an assumed policy number.

**The live milestone's first failure is the most valuable thing in it.** The 04:06 UTC run's
`constructedFailure` gate failed with four problems because the fixture threw from
`Database.Batchable.execute` and the platform answered `Status: Completed` with `NumberOfErrors: 2` —
the framework contains a chunk's exception. Failing in `start` produces the real `Failed` row
(`ExtendedStatus` carries the first error), and that measurement now lives in the fixture's doc comment
and ADR-0033 §10. The 04:08 UTC re-run is `overall: PASS` with all fifteen gates `PASS`: 25 setup
changes of 450 in the window reproduced row-for-row (actor and action included), 25 timeline entries the
harness rebuilt identically, the widest input the schemas admit (168 hours, `limitPerSection: 100`)
answered inside both budgets (61 533 B of 262 144; 34 780 of 60 000 characters) with its truncation
declared per section, and the constructed `Failed` job reported with the right id, class, timestamp and
error count. Eleven audited calls over 24 hours are all `PASS`/`SUCCESS` under
`executionRole = DIAGNOSTIC` with `dmlRows = 0`, and the new `PLATFORM_DIAGNOSTICS` purpose sits beside
the identity layer's own rows and nothing else. The three runs are named by their UTC start time
throughout (03:45, 04:06, 04:08); their reports are the three `p10-t5-milestone-20261009-*.json` files
on the host, archived unedited and read out in
[`P10_T5_LIVE_EVIDENCE.md`](P10_T5_LIVE_EVIDENCE.md).

**ADR-0029 is revised rather than left stale.** §4a's T5 row now names the three objects and states the
narrowing, §5's T5 cell points at ADR-0033, and the prompt's T5 section gains a 修订注记 that records the
six corrections and definitions measurement forced: `ExtendedErrorStatus` is `ExtendedStatus`, the
`AsyncApexJob` window belongs in the query now that `CreatedDate` is measured filterable, a `Failed`
fixture must fail in `start`, `ApexLog` left the whitelist, the stall rule's conservative ladder
(`INDETERMINATE` as the default), and the retention hint's measured bound instead of an assumed ~90 days.

## 2026-10-09 — the `mcp-builder` developer Skill, and an explicit partition of `skills/*`

`skills/mcp-builder` imports the MCP server development guide from the maintainer's local Codex Skill
library: guidance for designing MCP servers and Tools — input/output schemas, annotations, pagination,
error messages, and an evaluation question set. The ten upstream files are byte-identical to the imported
source; `LICENSE.txt` retains `Copyright 2026 Anthropic, PBC` (Apache-2.0) and `PROVENANCE.md` records
their SHA-256 so the directory can be re-diffed against upstream. The Skill is advisory exactly the way
the maintainer Skill is — repository contracts, current code, and the maintainer Skill outrank it — and
`CLAUDE.md` and `AGENTS.md` route MCP server and Tool design work through it.

The suite invariant "every non-maintainer canonical Skill must be in `BUSINESS_SKILL_ALLOWLIST`" could not
hold two developer Skills, so the model is generalized instead of special-cased: `manage.mjs` names
`DEVELOPER_SKILL_NAMES` (`mcp-builder`, `sfoa-mcp-maintainer`), and `toolkit.test.mjs` now enforces that
`skills/*` partitions into developer Skills and the business allowlist, that every developer Skill stays
canonical, and that `assertBusinessSkillAllowed` refuses each one by name. A developer Skill still syncs
to the three development-client roots; `skill:runtime:sync` can never publish it to a business workspace.
The suite policy file `skills/sfoa-mcp-maintainer/references/skill-maintenance.md` documents the
partition, the provenance record, and the update procedure.

## 2026-10-09 — P10-T4: the metadata listing pair, two type names corrected by measurement, and a degradation contract that was dead on arrival

T4 delivers the metadata pair: `list_metadata_components`, a read-only Tool that enumerates a type's
components, and a widened `get_metadata_component_context`, whose `METADATA_CONTEXT_TYPES` allowlist grows
from eight types to twenty-one. The listing never returns content and the reader never enumerates; each
answer's hint names the other half by the name `tools/list` actually advertises.
[ADR-0032](adr/ADR-0032-p10-metadata-listing-pair-data-source-and-type-budget.md) records the two decisions
the task needed: the data source is Metadata API `listMetadata` for every type — the Tooling API has no
object that enumerates configuration uniformly, and `describe` answers for the *calling identity*, not the
org — and the budget is one global byte ceiling plus the reader's existing limits rather than a 22-row
per-type table of unmeasured numbers.

**The live milestone ran twice, and the first run failed — which is the most valuable thing in it.** Run 1
admitted the twenty-two types the prompt named and the org refused two: `allowlistCoverage` `FAIL`, 20
served. Run 2, with the allowlist corrected and a classifier fixed, is `overall = PARTIAL` with ten of
eleven gates `PASS`; `inactiveDefault` is `NOT TESTED` because this org holds no component in a `deleted`
manageable state. Both reports are kept, unedited
([`P10_T4_LIVE_EVIDENCE.md`](P10_T4_LIVE_EVIDENCE.md)).

**Two of the prompt's type names are not this API's names, and the run said so.** `SharingRule` answers
`INVALID_TYPE`; this org's `describeMetadata` declares **204** types and the plural `SharingRules` is among
them, listing 210 components. `CustomSetting` is not a Metadata API type at all — the capability it was
named for is already served by `CustomObject`, and the org's 8 custom settings appear 8-of-8 in the
`CustomObject` listing, so the removal is verified rather than assumed convenient. The allowlist is
therefore **twenty-one**, and ADR-0032 §8 records both corrections instead of applying them silently.

**The per-type refusal branch was dead code, and only a refusing type could say so.** jsforce namespaces
Metadata API error codes (`sf:INVALID_TYPE`, at the top level and again under `data`), and the shared
`readSalesforceFailure` validates codes against an identifier-shaped pattern that rejects the colon and
returns `null` rather than echo a string it cannot vouch for. So every code in
`METADATA_LIST_UNAVAILABLE_CODES` classified as `null`: run 1 reported both refusals as
`MCP_METADATA_LIST_FAILED` with `prerequisite: null` — a per-type authorization fact reported as a retryable
API failure. The degradation contract of ADR-0029 §3 was written, reviewed, unit-tested and **dead on
arrival**; its tests passed because they threw the shape the author had in mind. The fix strips the `sf:`
namespace inside `mapMetadataListFailure` — not by widening a sanitizer four other providers depend on — and
the unit tests now throw the measured shape (`errorCode` at the top level **and** under `data`), so the
namespace cannot be dropped again unnoticed.

**The pair is measured on the org's own bytes.** `listedInventory` compares the Tool's `ValidationRule`
listing (245 components) against an independent read on the same identity, by membership **and** order;
`pairRoundTrip` lists and reads back `APIS管理组%2F业务员` — chosen because it carries an escaped separator —
byte-exact, with the escaped name intact in the returned file path, because a decoded name addresses a
different component or none. A missing component is a structured refusal, never an empty success: the
failure that reads as "this component is empty". The byte budget is measured on a real Profile (5 763
bytes, `truncated: false`, declared limits equal to reported), and the surface gate counts **zero SOQL**
across every Tool-call window — the Metadata API is the only surface reached.

**The audit trail separates the halves by `purpose` alone.** `apiCategory` is `METADATA_API` for both Tools
and both call `/services/Soap/m/68.0` v68.0, so `METADATA_LIST` against `METADATA_RETRIEVE` is the only
field a P7 reader can use — which is why the listing carries its own value instead of reusing the reader's.
Every audited row is `executionRole = DIAGNOSTIC` / `identitySource = INTERNAL_SERVICE_HEADER`, and the two
reader rows that read `ERROR` are the missing-component gate's own probes, one per run: they have to fail
for the gate to pass. `sfoa_tool_control` holds no row for this Tool (nor for T3's `explain_field_access`),
so both runs grant it in memory rather than through the Console — recorded as an open item, not smoothed
over.

**Still owed**: the prompt's human Setup-page count cross-check (the machine half is done), a live leg for
`includeInactive`'s default (needs an org with a recycled component), a live truncation on an over-budget
Profile, and a second evidence source for `EscalationRule`'s `totalCount: 0`, which rests on `listMetadata`
alone because the Tooling API has no matching object on this org.

## 2026-09-30 — P10-T3: `explain_field_access`, the permission-attribution boundary, and the two FLS mechanisms the org actually has

T3 delivers GAP-M2: `explain_field_access`, a Tool that answers *why* a user can or cannot see or edit a
field by aggregating the layers Salesforce actually stores — the object permission, the `FieldPermissions`
rows and the permission sets that carry them, record-type visibility, and describe facts — into one
`sourceChain`. It is **read-only evidence aggregation and not a permission engine**: it never simulates or
predicts Salesforce's adjudication, it reports non-permission causes (a validation rule, a field
dependency, a read-only layout) as *presence hints* only, and when a layer cannot be read it answers
`INDETERMINATE` naming that layer rather than reporting absence as a denial.
[ADR-0031](adr/ADR-0031-p10-permission-attribution-target-boundary-and-indeterminate.md) records the
decisions, including the third state `INDETERMINATE` (`true | false | 'INDETERMINATE'`) and the
`targetUserId` boundary.

**The boundary is the subject query's scope, not a check before it.** `targetUserId` is admitted only for a
Salesforce user the deployment has configured as an enabled identity route, or for the requester; membership
is enforced by `Id = :id AND Username IN (:configured)` **inside** the query, so an Id outside the routes and
an Id that exists nowhere produce byte-identical refusals — the live run measured both at `refusalLength:
544`, `refusalTextsIdentical: true`, each costing exactly the one subject lookup. There is no branch that
could drift and no way to ask the Tool which Ids exist.

**The live milestone ran five times, and the three failures are the substance of the task.** Two mechanisms
of the platform's field-level security were measured rather than assumed: a `FieldPermissions` row
**cannot be created** with `PermissionsRead=false` (`FIELD_INTEGRITY_EXCEPTION`, "Read permission is required
for: Account.TickerSymbol"), and clearing Read on an existing row makes the platform **remove** it. So
"closing a field" is taking a row away, which is also the edit an administrator makes by unchecking Read in
Setup. That makes the Tool's answer *definite* rather than `INDETERMINATE` on the ordinary real
configuration — the profile is readable and has no row — which is why `profileBaselineReadable` is derived
from the parent list rather than from the rows. The full record, including what the run does not prove, is
[P10_T3_LIVE_EVIDENCE.md](P10_T3_LIVE_EVIDENCE.md).

**One defect found only by the run, and it was in the harness rather than in the product.**
`AdditiveToolPolicySnapshotSource` — the decorator the live milestone wraps the real policy snapshot source
in to grant the Tool without writing the Control Plane — did not forward the optional
`listConfiguredSalesforceUsernames`. Through the decorator the deployment therefore appeared to configure
**no** identity routes, and the Tool correctly refused every named target with
`MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED` before reading anything. Every unit test passed: fixtures call the
source directly, and the decorator existed only in the composition production uses. The product code was
right on both sides — the MySQL source implements the member, and defaulting an absent one to the empty set
is the fail-closed direction — and what made the defect expensive is that the report read as **a fact about
the deployment** rather than as a harness that had lost a method. An optional member on a policy interface
is an invitation to exactly this, and a fail-closed default turns the invitation into a silent one: the
wrong answer arrives wearing the shape of a correct one.

**Three more harness defects, each of which would have let a wrong result pass.** The report recorded the
platform's error *code* while dropping its message and jsforce's `errors[]`, which is what hid the
measurement above until it was fixed. The cleanup comparison looked in **one** direction — it asked "what is
here now that was not here before?", so a run that removed a row (207 snapshot lines → 206) reported
`drift: []` on an org it had altered; snapshot equality now means set equality in both directions. And the
restore had no way to put back a row the platform deleted, because it restored by an id that no longer
existed — the revert now re-reads the row and re-creates it when it is gone. A fourth, the report archiving
route usernames inside recorded SOQL, was fixed by masking at the point of recording; the audit deliberately
keeps the unmasked statement, because that is the deployment's own internal record.

**The §0.3 red line is measured on the wire, not asserted in a comment.** The milestone wraps the
Connection it hands the runtime and checks every statement the Tool issued against the executor's
Setup-layer whitelist: 25 statements over 5 windows, targets in
`FieldPermissions`/`ObjectPermissions`/`PermissionSet`/`PermissionSetAssignment`/`RecordType`/`User`, **zero
off-whitelist targets and zero business-object reads**. `fieldApiNames` is used only as a key into the
permission configuration.

**Final run: `overall = PASS`, exit 0, all fifteen gates `PASS`**, on the sandbox (CHN5S, API v68.0) with
the org restored to its pre-write snapshot line for line. The Tool is `DIAGNOSTIC`, default-disabled, with
`readOnlyHint: true`, and audited: twenty-eight rows across the five runs, every one
`executionRole = DIAGNOSTIC`, with the Tool's Salesforce calls carrying `purpose = PERMISSION_EXPLAIN`. All
twelve of its failure rows carry `MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED` — ten of them the boundary gate's own
probes, which have to fail for the gate to pass — so a red row on this Tool means the boundary working
rather than the Tool breaking. **Still owed**: the prompt's human Setup-page cross-check (the harness's is an
independent machine read of the same tables), and any live leg for `INDETERMINATE`, which remains
unit-tested only.

## 2026-09-30 — P10-T2: the debug log toolset, and two defects only a live org could find

T2 delivers GAP-M1 — the deterministic Apex/Flow exception chain — as three Tools on the fixed DIAGNOSTIC
identity: `set_trace_flag` (the only write, bounded to one `TraceFlag` and one `DebugLevel`),
`get_apex_logs`, and `get_debug_log_body`. All three are default-disabled, classified `DIAGNOSTIC`, and
audited through P7; their hints compose into one path so an agent that knows nothing about Apex can get
from "something threw" to a class and a line. [ADR-0030](adr/ADR-0030-p10-debug-log-toolset-governance-and-debuglevels.md)
records the governance decisions: the new **`DIAGNOSTIC_WRITE`** classification (`MUTATION` writes business
records, `ADMIN` changes who may do what — a Setup-layer diagnostic write is neither), three fixed
`DebugLevel` tiers under a reserved prefix with resolve-or-create, and the versioned Blob read keyed off
the log's **own** header version rather than the org's.

**The live milestone ran twice, and the first run's failure is the more valuable half of the evidence.**
Both runs remain in the audit trail, so audits `7699` (a correct write reported `verified: false`) and
`7711` (`get_apex_logs` → `MCP_APEX_LOG_READ_FAILED`) sit beside `7713`–`7716`, the run that closed the
loop with `overall = PASS` on all ten gates. The full record is
[P10_T2_LIVE_EVIDENCE.md](P10_T2_LIVE_EVIDENCE.md).

**Defect 1 — a `dateTime` filter was emitted as a quoted string literal.** `LastModifiedDate >= '…Z'` is a
*string* literal, and this org's Tooling API refuses one where a `dateTime` belongs: `INVALID_FIELD` —
"value of filter criterion for field 'LastModifiedDate' must be of type dateTime and should not be
enclosed in quotes". This is the one `dateTime` filter in the Toolset; every other use of the string
escaper quotes a real string or Id field and is correct. **The T0 probe could not have caught it**: its
`ApexLog` query carried no `WHERE` clause at all, so no `dateTime` literal had ever been sent to this org.
The Tool now emits the window bound through a `soqlDateTimeLiteral` helper that re-validates the shape and
emits it unquoted — safety is structural, because the only values passed in are produced in-process from
the clock, never from a caller or from org data.

**Defect 2 — a correct write was reported as unverified.** The requested expiration carried milliseconds
while Salesforce stores whole seconds and answers a re-read with the truncated value
(`…:47.000+0000` against a requested `…:47.812Z`), so the verification comparison was false *by the
sub-second remainder*. This is the mirror image of T1's finding — that run watched a write report success
on a row that survived; this one watched a write report **unverified** on a row that was correct. The
clock is now truncated to whole seconds so the request is expressible in the precision the platform keeps,
and the comparison is left exact, because a tolerance would also accept a genuinely short trace.

**The fixture was the reason both defects reached a live org**, which is the durable lesson: it echoed the
Tool's payload byte for byte, so it answered *more precisely than production* and could not fail a
comparison production fails. It now stores `TraceFlag` dates the way the org does — whole seconds, in the
`+0000` offset notation — and the suite asserts that a seeded millisecond instant is normalized on
storage, so no test can buy itself a kinder fixture.

**Two measured facts beyond T0's**, both strengthening claims T1 could only assert: the DIAGNOSTIC
identity **may run anonymous Apex** (never measured before, because the probe executed no code, and the
milestone gates every write leg on it), and `ApexLog.Status` for a *failure* is **the exception's own
text** — `Attempt to de-reference a null object` — not a localized label. So the status vocabulary is not
a two-value translation table missing its English side; it is free text that varies with the failure. Any
filter composed from a believed-in enum would drop the failing row silently, which is ADR-0029 §3's rule
in its strongest form.

**Audit separation is measured, not assumed.** `yarn ai:audit` shows all three Tools on the chain on
`executionRole = DIAGNOSTIC`, with the write's Salesforce calls carrying `TRACE_FLAG` and both reads
carrying `DEBUG_LOG` — the separation ADR-0029 §4d requires so the trail can answer "who opened a trace
on whom" on its own. Six connections collapsed to one distinct identity, and no credential material
appears in any row. `A-1` (cross-user `ApexLog` visibility) is still **not** exercised — the loop traces
the diagnostic identity itself — and remains a production deployment check.

`run_diagnostic_tooling_query` also gained the `FROM`/`USING` object check ADR-0029 §4b specified, on the
diagnostic allowlist and ahead of the platform's own refusal, which T1 identified as the one place a
pre-existing Tool met the §0.3.1 boundary in fact but not in letter.

## 2026-09-30 — P10-T1: the diagnostic capability probe, ADR-0029, and the four facts that change the design

P10 builds six Tools on the server-owned DIAGNOSTIC identity, and P9's lesson was that this identity's
reach must be **measured before it is designed against** — `get_org_limits` had been written on a belief
about what a routed identity could read, the live probe disproved it, and the Tool had to be re-homed
(ADR-0027). T1 is therefore the prerequisite: a systematic live probe, its findings, and
[ADR-0029](adr/ADR-0029-p10-diagnostic-identity-prerequisites.md).

**The probe measures the Connection the Tools will use, not a convenient one.** It opens the scope
through `snapshotDiagnosticRoute` over the runtime's own request-scope factory — the pairing
`http-server.ts` uses for a DIAGNOSTIC `tools/call` — because measuring a differently-built Connection
would answer a question nobody asked. Result: **36 `AVAILABLE` · 5 `DENIED` · 0 `ERROR`**, org
`Base Edition` on instance `CHN5S` at API v68.0, `probeMode: SANDBOX_WRITE_ALLOWED`. The five refusals
are all expected and four are the boundary evidence. Findings and inference are recorded in **separate
columns** in [P10_T0_LIVE_PROBE_FINDINGS.md](P10_T0_LIVE_PROBE_FINDINGS.md); P9 had to correct an
inference that had been written as fact, and the split is the structural fix for that.

**Four measured facts change the design.** Each carries a 修订注记 into the affected T2–T5 prompt
section with the original prompt text left intact:

1. **`set_trace_flag` cannot be create-only.** Creating a `TraceFlag` for an entity already traced with
   an overlapping window is refused with `FIELD_INTEGRITY_EXCEPTION`. The Tool's most ordinary call —
   "trace this user for the next hour" — fails the second time it is used, so it must be
   create-or-extend.
2. **The log parser must follow the log's own header version.** The org answers v68.0 while serving log
   bodies whose own headers read `54.0` and `56.0`.
3. **No P10 Tool may match on a human-readable label.** `ApexLog.Status` matched 1 row as `'Success'`
   and 8 as `'成功'`; `SetupAuditTrail.Section` and `Profile.Name` are translated too. Every one of
   these failures is silent — fewer rows, no error — which is the same class of harm the degradation
   contract addresses.
4. **`SetupAuditTrail` counts live in `totalSize`.** `SELECT COUNT(Id)` is refused (`MALFORMED_QUERY`)
   and `SELECT COUNT()` returns a record-less body, so code reading `records[0].expr0` would report
   zero against a real 260 911.

**What is available is mostly what the plan hoped — with one open question that is left open.** The
identity can read `ApexLog` (13 fields, body as a separate string call), `TraceFlag` (23 fields),
`DebugLevel`, `SetupAuditTrail`, `AsyncApexJob`, `CronTrigger`, the whole permission surface —
`FieldPermissions`, `ObjectPermissions`, `PermissionSetAssignment`, `PermissionSet`, `Profile`,
`RecordType` — and Metadata `listMetadata`. It can **create** a `CLASS_TRACING` flag on an `ApexClass`
and a `DEVELOPER_LOG` flag on **another user**, and create a `DebugLevel`; each was verified deleted by
re-reading. But the probe could only ever see `ApexLog` rows whose `LogUser` is the identity itself,
which is consistent with ownership alone and **does not demonstrate `View All Data`**. Whether it can
read another user's logs is written into the deployment list as prerequisite `A-1` rather than assumed
— the same self-correction P9 made about `limits()`, applied before the mistake instead of after.

**The red line is now measured on both halves, and only one of them is structural.** Through the
Tooling API the platform refuses business objects: `Lead`, `Account`, `Value_Bill__c` and `Order__c`
each answer `INVALID_TYPE` while `ApexClass` resolves as a control — and two of the four are **custom**
objects, which matters because the Tooling API does document custom-object support. But the **same
identity reads 955 `Lead` rows over the standard API**. So for `explain_field_access` and three of
`get_platform_diagnostics`' four sources, the hardcoded, unit-tested whitelist is the *entire*
guarantee rather than a second line of defence. That is why §0.3.1's rule is not stylistic.

**Re-reviewing the three pre-existing diagnostic Tools found one gap.** `get_org_limits` (quota
counters, no object or row) and `get_metadata_component_context` (hardcoded 8-type allowlist,
unit-tested) meet the boundary — the latter with one description-vs-behaviour item to verify, since its
description says "one component" while the retrieve may return dependent components. But
`run_diagnostic_tooling_query` takes **free-form Tooling SOQL** and validates only the statement shape,
never the object: it meets the red line in fact, because the platform refuses business objects, yet it
fails §0.3.1's letter. The narrow fix — a `FROM`/`USING` object check as a first line, with the
platform's refusal kept as the backstop, explicitly *not* a SOQL parser — is specified in ADR-0029 §4b
and assigned to T2. T1 adds no Tool behaviour.

**The enablement-surface decision says what is not true.** The option "diagnostic Tools enableable only
on the DIAGNOSTIC route" cannot be built: enablement is global (ADR-0027 already recorded this), the
diagnostic identity is a single deployment-wide row (`sfoa_diagnostic_config`, `id: '1'`), and no
caller-to-diagnostic binding exists anywhere in the schema. ADR-0029 therefore accepts the Console
data-surface declaration plus explicit Admin confirmation as P10's governance form, and specifies the
per-caller entitlement as the structural follow-up — as an **entitlement grant**, not a criteria test,
so a business-systems administrator is not silently excluded by holding a business route. Until it
lands, **"business users cannot call diagnostic Tools" is not true on this deployment**, and that is
stated rather than implied. The audit dual-identity requirement needs no new machinery: rows already
carry the caller's `platformUserId`, `executionRole` and the `salesforceUsername` that actually
executed, so ADR-0029 confirms it as a contract to assert at acceptance.

**The probe is kept, not deleted like P9's, and it found a defect in itself.** `probe:p10` is
re-runnable so a deployment can establish its own capability record. Its write legs are gated on the
org's own `IsSandbox` answer — the `P10_PROBE_WRITE_PROBES` variable can only force writes *off*, never
on — which is what makes a production run read-only by construction. Every write leg now re-reads to
confirm the row it created is gone, a check added because an earlier run reported
`cleanupSucceeded: true` on a `TraceFlag` that was still in the org, and the *next* run was then
refused by the leftover. One such flag (`005…IAE`, tracing the diagnostic identity's own user, open
until `2026-09-30T04:01:04Z`) was deliberately **not** deleted because it cannot be attributed with
certainty; it expires on its own.

## 2026-09-29 — P9-T5: Playbook 1.10.0, the data-analysis Skill, and a second gate defect found by running the acceptance

T5 closes the P9 plan. The seven Tools were already built and deployed; what was missing was the
Agent-facing contract that tells an Agent how to use them without lying about what it read, the Skill
that carries the same contract into the business workflow, and the end-to-end acceptance. Results in
[P9_ACCEPTANCE_REPORT.md](P9_ACCEPTANCE_REPORT.md).

**Playbook 1.10.0 — the data-completeness contract.** The plan's five points, all landing in the new
「数据查询与完整性」 section: a coverage declaration is **obligatory** for any conclusion drawn from
`query_records` or Bulk results (`fetched` against `totalSize`, and no whole-result claim while
`truncated` is true); Tool selection follows expected size (single-batch exploration may use
`run_soql_query`, anything past 2 000 rows or needing a coverage claim uses `query_records`, a full
export uses the Bulk pair); aggregate before detail; `list_sobjects` / `describe_sobject` before
writing a query whose field names are uncertain, and `describe` before retrying after
`INVALID_FIELD`; and `get_org_limits` ahead of a large job. `capabilities.ts` needed only the minimal
change — the new Tools are described, not given a new capability model, and the renderer is
untouched.

**A Skill, not a Tool, is what P9-5 actually needed.** `skills/sfoa-data-analysis` is a top-level
canonical Skill in the same shape as `sfoa-crm-core`: hard rules for the completeness declaration and
for what `truncated` forbids, the three escalation paths out of a truncated result (aggregate, Bulk,
narrow the scope), the rule that untrusted field content is data and never instruction, explicit
statistical scope (time window, filters, currency), and guidelines for COUNT-then-detail, `describe`
self-repair, a limits pre-check and locator discipline. It is registered in
`BUSINESS_SKILL_ALLOWLIST`, which is the single authorization source for runtime publication, and
present in the canonical, `.claude`, `.codebuddy` and `.agents` copies.

**The build order was the deployment defect, and it had been visible the whole time.** Playbook 1.9.0
was still being served by the test environment after the P9 Tools were deployed, because the version
reaches the two consumers by different routes: `@sfoa/admin-web` **inlines** it at build time, while
`sfoa-mcp-server` resolves it at **runtime** from `packages/sfoa-agent-playbook/dist`. Building the
frontend before the playbook therefore produced a green build, two `active` services and a stale
Agent page — nothing fails, the version is simply old. Rebuilding in dependency order fixed it, and a
second symptom surfaced underneath: rebuilt files under `sfoa-admin-web/dist` carry the default
SELinux label and nginx serves them as `500` until `restorecon -R` restores
`httpd_sys_content_t`. With both fixed, 1.10.0 is confirmed on all four surfaces that can report it,
each read rather than inferred — the playbook `dist`, the 小犇 instruction
(`Playbook-Version: 1.10.0`), the built Admin bundle, and the live `get_agent_playbook` Tool
description. Recorded in
[TEST_SERVER_DEPLOYMENT.md](TEST_SERVER_DEPLOYMENT.md#p9-t5-playbook-1100-data-analysis-skill-and-acceptance-deployment-2026-09-29).

**A second defect in the P9 live gate itself, and again found by running it.** The `orgLimits` gate
failed on two of three pre-fix runs with a disagreement of a few units on `DailyApiRequests`. The
cause is directional rather than random: that counter is advanced by the run's **own** API traffic,
the gate compares the Tool's reading to a reference reading taken around it, and the waiver it
already had could only excuse a disagreement it could witness as movement between the two reference
readings. Once the run's traffic stops, the reference readings agree and the waiver can never fire —
so a counter the harness had itself moved was reported as a defect in a correct Tool. The fix keeps
`max` strict and keeps the Tool's own `used === max - remaining` strict, and adds one bounded
tolerance of `max(5, ceil(ceiling × 1/10 000))` — scaled by the limit's ceiling rather than its
value, because `used` is a difference of two ceiling-sized numbers — with every waiver reported in
`toleratedMoves`. Two of the three post-fix runs waived by movement and one **only** by the new
tolerance (its two reference readings were identical), which is what shows both paths work. The
change is confined to the validation harness; no Tool, schema, audit summary or unit test changed.

**Acceptance — `overall: PASS`, all 11 gates, three consecutive runs.** Against the real org: Bulk
pages summing to 37 010 rows against an independent `COUNT()` of 37 010; a `query_records` probe that
declares `truncated: true / RESPONSE_BUDGET` instead of claiming the whole result; schema self-repair
after `MCP_SOBJECT_NOT_FOUND`; a SOSL search matching its predicted count; `get_org_limits` reading
73 limits and re-reading 73 with no mismatch on the DIAGNOSTIC identity; 34 of 34 audit snapshots
persisted with the queue drained; and 23 advertised Tools with `readOnlyAnnotations: true` and no
annotation offenders. The plan's 100 000-row floor was **not** met — no object in this org is near it
— and the run says so in its own output rather than being read as if it had been met.

The audit leg (`--latest 20 --since 24h` for the routed identity) shows all seven P9 Tools leaving
evidence: 210 audit rows against 210 distinct correlation ids in the window, 1 183 payload-evidence
rows of which 18 are the bounded truncated prefix, and no credential-shaped content — 0 matches for
JWT, bearer, refresh-token, access-token or client-secret patterns, agreeing with the live
`credentialSafety` gate's `matchedPatterns: []` over 2 801 044 bytes. Chain coverage is reported as
it is: the schema has no `sessionId`, `callId`, `parentCallId` or `spanId`, so the analyzer marks the
traces `PARTIAL` and this acceptance claims no per-session chain it cannot express. The identity was
resolved inside the querying process throughout, so no platform user id reached a command line.

**Failures that remain are pre-existing and are named, not absorbed.** `test:p7`'s HTTP OFF/ON gate
fails identically on `main` (`903f0a3`) with the same `MCP_REQUEST_TIMEOUT`; `validate:p2` and
`validate:p3` stop at a missing `SECOND_TEST_USER` in the local environment; and `yarn lint`'s 47
errors are all in the upstream `mcp-provider-code-analyzer` package, 25 files, none of them `@sfoa`.
Each is recorded with its evidence in the acceptance report rather than counted as a pass.

**The same contract was then carried to the host that consumes it.** The five surfaces above are all
server-side; an Agent reaches them through OpenClaw, so the workspace was synced in the same pass.
`skill:runtime:sync` published all three business Skills — the new `sfoa-data-analysis` (7
references) plus refreshed `sfoa-crm-core` and `sfoa-record-change` — with `runtime-check` reporting
`drift: []` and each SKILL.md byte-identical between canonical and workspace. The connector Skill
`sfoa`, which is the `skill:export` package and had been installed on 09-23 still announcing
Playbook **1.9.0 / 15 Tools**, was regenerated at **1.10.0 / 22 Tools**; only its `SKILL.md` changed
(the `mcp.json` next to it is byte-identical), and the old copy is kept as `SKILL.md.bak-1.9.0`.

Files are not visibility, so the allowlist was patched too: `sfoa-data-analysis` was absent from both
`skills.entries` and `agents.entries.main.skills`, which is why `openclaw skills check` reported it
as `Excluded by agent allowlist` — installed, and invisible to the model. `openclaw config patch`
(after a `--dry-run`, with the config backed up) added it to both, and the CLI's own verdict was that
the change does **not** need a restart, so the Gateway was not bounced
(`ActiveEnterTimestamp` unchanged at `2026-09-20 08:40:05 CST`). Visible-to-model went 5 → 6. The
connector Skill `sfoa` stays deliberately outside `main`'s allowlist, as before: `main` reaches the
MCP through the host-side registration, not through a second copy of the instructions. Human WeCom
UAT is still not executed and is not claimed.

**The temporary artifacts are gone and the local stack is back.** Every `.p9-*` file — injectors,
audit and coverage runners, gate logs, acceptance JSON — was deleted from the checkout's `.temp/` and
from the app tree, with `/tmp/p9-*` and the generated export package `out/`. What remains is what the
deployment record cites by path: the `incoming/` archives, the `backup/` backups, and the three
archive manifest listings at the deployment-tree root that the T1/T3/T4 sections name. The dev stack
that was stopped before the dependency install was restarted afterwards and `yarn ai:doctor` then
reads `services: PASS` with all three surfaces reachable, superseding the `NOT_RUNNING` recorded in
the acceptance report §5.4.

## 2026-09-29 — P9-T4 deployed to the test server, and four defects in the gate that reports it, found and fixed

`feature/p9-data-completeness` was deployed to `crm-ex-test02` **before T5**, on the decision that
T4 is independently verifiable. The two Bulk Tools are live behind Tool Governance and the gate
passes: 19 pages summing to **37 001** rows against an independent `COUNT()` of **37 001**, job
`750C5000004qTurIAE`, 27 720 ms, `apiUsage valid`. Full record in
[TEST_SERVER_DEPLOYMENT.md](TEST_SERVER_DEPLOYMENT.md#p9-t4-bulk-export-pair-deployment-2026-09-29).

Four defects were found by re-running the live gate and reading the audit record it produced, and
fixed:

- **The Tool inventory gate asserted one blanket `idempotentHint`.** `submit_bulk_query` declares
  `false` deliberately — a second submit creates a second job and spends `DailyBulkV2QueryJobs`
  again — and `MCP_ENGINEERING_RULES.md` licenses `true` only when repeated calls have no effect.
  The expectation is now stated **per Tool**, and a Tool absent from that map is treated as an
  offender, so a new additive Tool cannot inherit a green check by being unknown.
- **The gate discarded the audit-flush verdict** and now reports it as `auditPersistence`, combined
  into `overall`, with the pipeline's health counters. `close()` returns `flushed: false` under
  `MCP_AUDIT_FLUSH_TIMEOUT` rather than throwing, so a caller that ignored it could not tell
  "the evidence exists" from "these gates passed and nothing was recorded".
- **That verdict was computed but never exposed** on the success path's report literal, so the run
  reported `overall: PASS` off a gate the reader could not see.
- **The flush ran while the server could still be serving**, so the run's own last audit snapshot was
  refused and lost while the gate reported a clean trail. Fixed by closing the client and the server
  before flushing, and by requiring the shutdown to report `drained`. Evidence below.

**An `auditPersistence` PASS did not prove the trail was complete, and now does.** The gate closes the
audit pipeline to read the verdict, and the close could land while a request handler was still
finishing: `http-server.ts:524` offers a request's snapshot from the handler's `finally`, *after*
the call has resolved to the client. Late snapshots were refused with `MCP_AUDIT_PIPELINE_CLOSED`
and lost, and because the gate samples health at flush time the refusal never appeared in the
counters it reported. The four runs on the test server showed it: runs 1–2 recorded the
`schemaSelfRepair` probe's `MCP_SOBJECT_NOT_FOUND` row, runs 3–4 did not, and run 4 logged exactly
one refusal 401 ms *after* its flush succeeded. The counters reconciled with the rows
(`enqueuedSnapshots: 34` = 34 rows), which proved the snapshot was refused **before** enqueue
rather than dropped after it.

The fix (`b4e3453`) stops serving before asking the pipeline for its verdict: the success path awaits
`client.close()` and then `server.close()` before flushing. `server.close()` is the barrier that makes
the flush mean something — it does `Promise.allSettled([...activeRequests])` raced against
`max(requestTimeoutMs, toolTimeoutMs)`, and `activeRequests` holds the whole `handleRemoteRequest`
promise (`http-server.ts:183`), so the audit offer in its `finally` has run by the time the close
settles; both closes are memoized, so the outer `finally` closing them again costs nothing. The
verdict is read while the report is still being assembled, since the outer `finally` closes the
pipeline only after the value has been returned and a report that waited for it could never carry it.
`runAuditPersistence` now takes the `GracefulShutdownResult` and additionally requires
`drained === true`, so a clean flush over a short trail can no longer pass on its own; the refusal
path (no enabled route) reads its verdict before `closeQuietly` and passes `null`, because no server
was started there and that path is the one place the trail matters most — it is the only record that
the run was turned away rather than that it never started.

Verified live in the same deployment (`p9-live-validation.ts` sha256
`0e71c9c3d0c27e32fb77cc9c2df44cb1fe2a76bd6fe9fd55b9dd4fbc00fa531b`): `overall: PASS`, all 11 gates
PASS, **stderr empty — zero `MCP_AUDIT_PIPELINE_CLOSED`** against run 4's exactly one,
`auditPersistence {flushed: true, dropped: 0, enqueuedSnapshots: 34, persistedSnapshots: 34,
droppedSnapshots: 0, writerFailureCount: 0, shutdown: {drained: true, forcedConnections: false}}`,
and the DB independently agrees: 34 rows, ids 6683–6716, the last of them the restored
`6716 … describe_sobject ERROR MCP_SOBJECT_NOT_FOUND`. The deployed service was unaffected
throughout — a missing probe row was a gap in the harness's account of its own evidence, not a change
in what any Tool does.

**A claim in this deployment's first draft was falsified and removed rather than explained.** An
earlier commit and doc comment asserted the T4 run "wrote no audit rows at all", citing the newest
`audit_id` as 1344. That measurement came from the local checkout's `.env.local`, which points at
`127.0.0.1` rather than the shared Control Plane, so it could not have seen the run's rows. Against
the real database the run's 34 rows are present and the counters match. The commit message and the
doc comment were both rewritten (the commit was unpushed, so this corrected the record rather than
appending to it).

## 2026-09-29 — P9-T4 follow-up: the Bulk export gate's row floor becomes a stated scale, not a fixed number

The T4 acceptance run requires a live Bulk export over an object of **at least 100 000 rows**.
The deployment this gate was first run against cannot supply one, and that had to be established
before it could be recorded: `run_soql_query` was used to read `COUNT()` for **every one of the
org's 523 queryable objects**, and the largest was then re-read under each of the eight enabled
identity routes to rule out a sharing-limited answer. The result is in
[ADR-0028](adr/ADR-0028-p9-bulk-query-export-over-official-sdk.md) deviation 5: the largest
object in that org is `ContactShare` at **74 660** rows, the largest business object is `Contact`
at **37 496**, and 12 objects exceed 10 000. No object is within 25 % of the planned floor.

- **`P9_LIVE_BULK_MIN_ROWS` may lower the floor, and the run says so.** `p9-live-validation.ts`
  now resolves the floor per run and reports `minimumRows`, `minimumRowsSource` and
  `plannedMinimumRows` **together** — in the `bulkQuery` gate and at the top level of the report,
  because a `bulkQuery` PASS at 37 496 rows and one at 100 000 rows are different claims and a
  reader must not have to open the gate to tell which was made. A relaxed run therefore cannot be
  mistaken for the plan's requirement having been met, which it has **not** been.
- **The override is bounded below at 10 000 rows (five pages at the default 2 000-row page).**
  Below that the gate measures a single request with extra steps, and an override that can be set
  arbitrarily low is an override that can manufacture a green run; a value under the bound is
  refused before any Tool call rather than clamped.
- **The floor's purpose is the scale that satisfies it, not the number.** The gate's own rationale
  is that a short result set reaches its last page in a couple of calls and cannot distinguish a
  working walk from one that ends early by luck. `Contact` at 37 496 rows is 19 pages and 19
  cursor advances under the default page size, which meets that purpose; the literal 100 000 does
  not, and this entry does not claim otherwise.
- **No Tool behavior changed.** The change is confined to the live validation harness; the two
  Bulk Tools, their schemas, their audit summaries and every unit and protocol test are untouched
  and re-run green (`sfoa-mcp-server` **237/237**, lint clean).

## 2026-09-29 — P9-T4: the Bulk API 2.0 export pair, and a page that is never returned short

Closes GAP-D2 / P9-3 on `feature/p9-data-completeness` with the last two Tools of
`@sfoa/mcp-provider-sfoa-data`: `submit_bulk_query` creates a Bulk API 2.0 **query** job and
returns its `jobId`, and `get_bulk_query_results` polls that job's state and reads one page of
its result set per call. The gap they close is the one the first three P9 tasks leave open: a
REST SOQL query is capped at 2000 rows per page and its continuation cursor eventually stops, so
"every row of this object, and I can tell you how many" has no bounded path through
`query_records` at all. The design record is
[ADR-0028](adr/ADR-0028-p9-bulk-query-export-over-official-sdk.md).

- **`operation` is not an input, so the DML Bulk operations are structurally absent.** The
  submission's registered schema is `{ query }` and the provider always sends
  `operation: 'query'`. A Bulk ingest, upsert, update or delete is not rejected — there is no
  input through which it can be expressed, which is what makes `readOnlyHint: true` a claim
  about the code rather than about the review. The statement is the same SOQL the rest of the
  package accepts, and the submission is covered by the org object-usage guard for the reason
  `query_records` is: a Bulk job over an org-declared-unused object returns zero rows just as
  quietly, and an export is the answer an Agent is least likely to re-check.
- **The decision with the most consequence is that a cut page is re-read, never shortened.**
  The byte budget bounds a slice, and the obvious implementation — return the rows that fit plus
  the cursor — is **wrong** in a way specific to this API: `Sforce-Locator` points past the page
  Salesforce *served*, not past the rows that fit, so returning a cut page with that cursor
  silently skips every dropped row. When the budget cuts a page the Tool therefore re-requests a
  **smaller page from the same cursor** for exactly the number that fit; a smaller page is a
  prefix of the larger one, so the fitting count strictly decreases. The loop is bounded at
  `PAGE_FIT_ATTEMPTS = 5`, and a single row too wide to fit produces `MCP_BULK_SLICE_TOO_LARGE`
  with a suggestion to narrow the projection rather than a truncated answer. `maxRecords` is
  documented as an **upper bound, not a promise**.
- **Nothing about an export survives a request.** No table, no in-memory cache, no session: the
  job lives in Salesforce, the caller holds the `jobId` and the cursor, and every call re-states
  them. That is what keeps the pair compatible with the stateless HTTP runtime
  (`sessionIdGenerator: undefined`), and it is asserted by protocol test as well as by absence of
  any store.
- **Both facts the Tools need exist only in response headers, so the read goes through the SDK's
  own `Connection.request`.** `Sforce-Locator` is the paging cursor and `Sforce-Limit-Info` is
  the org's API-usage counter; neither appears in a body. The SDK's public `bulk2` surface cannot
  reach either — `QueryJobV2.result()` streams *every* page into one stream and keeps the cursor
  in a private field (no bounded page read at all), `createJob()` is ingest-only so it cannot
  create a query job and return just its Id, and `HttpApi` never exposes headers. `HttpApi` does
  `this._transport = options.transport || conn._transport`, so a wrapper passed as
  `connection.request(req, { transport })`'s second argument delegates the authenticated request
  unchanged and copies the headers out of the pending stream's `'response'` event. jsforce
  injects `Authorization` **before** the transport is reached, so this path never sees, holds or
  logs a credential; the URL is version-relative (`/jobs/query…`) and expanded by the SDK, so no
  instance URL or API version is assembled in the provider; and the P7 adapter still intercepts
  the request. The wrapper is typed against a structural `ObservableTransport`/`ObservablePending`/
  `ObservableResponse` declared in the provider rather than a deep import, so the package keeps
  `@salesforce/core` as its single declared SDK dependency. The one cast —
  `{ transport: observing } as unknown as RequestOptions` — exists because `Connection.request`
  publishes its options as `JsonMap`, a JSON value type that cannot name a function and therefore
  cannot describe an option the SDK's own code reads.
- **The export gets its own audit purpose rather than being filed as a SOQL query.** A new
  `SalesforceApiPurpose` value `BULK_QUERY` covers both halves, because a submission audited under
  one category and a result read under another would leave the trail unable to answer "what did
  this export cost and what did it read". The classifier already maps `/jobs/…` to `BULK_API`, so
  the purpose and the category now name the same surface instead of adjacent ones. The
  **submission** carries a statement and so stays bound to `DATA_SOQL` through
  `SOQL_STATEMENT_TOOLS`; the **result read** names a job Id rather than a statement and is
  deliberately absent from that map — recording a query that never reached Salesforce would be
  worse than recording none.
- **A failed job is an error, not an empty result.** While a job is still running, `locator`,
  `hasMore` and `complete` are **omitted** rather than reported `false`, because "there is no next
  page" and "there are no rows yet" are the same shape to a caller that reads only the fields and
  only one of them is true. A job the platform ended as `Failed` or `Aborted` is an `isError`
  result carrying the platform's own reason, because "the job failed" and "the job matched
  nothing" are opposite facts. A job belonging to another identity is refused by Salesforce and
  mapped to `MCP_BULK_ACCESS_DENIED` with the instruction to report the refusal — there is no
  cross-identity penetration and no attempt to work around it.
- **Quota is reported, not pre-flighted.** ADR-0026 planned a `get_org_limits` pre-flight for
  T4; ADR-0027 then measured that no business identity this deployment routes may read the
  `limits` resource and that the DATA Tools cannot borrow the diagnostic identity. This entry
  takes ADR-0027's option (b) literally: no pre-flight, and the quota fact reported is the one the
  Bulk response itself carries — `Sforce-Limit-Info`, parsed into
  `apiUsage { used, limit, remaining }`. An allowance refusal maps to `MCP_BULK_LIMIT_EXCEEDED`
  and names `get_org_limits` **only when the session advertises it**.
- **Four deviations from the plan's wording, recorded because the P9 convention requires it.**
  (1) `fetchedCumulative` is **omitted**: the plan listed it "if obtainable", and with no
  server-side state it is not obtainable honestly — the Tool cannot know how many rows earlier
  calls returned, and inventing a cumulative count from `numberRecordsProcessed` would be a
  completeness claim the export cannot support. `totalRecords` (the platform's own
  `numberRecordsProcessed`) and this page's `returnedCount` are reported instead, so the caller
  sums its own calls. (2) All three wire calls are REST calls through `Connection.request` rather
  than a mix with `bulk2.job(...).check()` for the state: `check()` cannot inject a transport, so
  it would capture neither header, and mixing two clients for one job would make the audit row
  set depend on which half of the pair is running. (3) No pre-flight, per the bullet above. (4)
  `get_bulk_query_results` is deliberately **not** a `HINT_TOOL_CANDIDATES` entry in the live
  validation: that list is what a `query_records` hint is scanned against, and the export gate
  reaches the Tool through the `jobId` the submission returned instead.
- **The two Tools are `READ`/`USER` and default-disabled**, registered as `'USER'` in
  `SFOA_DATA_TOOL_ROLES` and absent from `DEFAULT_ENABLED_TOOLS`: a Bulk query job belongs to the
  identity that created it, so the request's USER identity is the only scope that can read an
  export it started. `get_org_limits` moved out of this package in the T3 follow-up above, so
  every Tool in `@sfoa/mcp-provider-sfoa-data` is now `READ`/`USER` without exception. The Admin
  catalog entries are in `packages/sfoa-admin-api/src/tool-catalog.ts`; nothing here changes any
  official file, and no Tool parameter accepts a username, token, instance URL or API version.
- **Test coverage added.** Provider `mcp-provider-sfoa-data` **155/155** (+10 Bulk contract
  tests): the submission's exact request body and its four statement rules, the `{ query }`-only
  input shape, the state machine (`UploadComplete`/`InProgress` → no rows and no completeness
  claim; `JobComplete` → a page and a cursor; `Failed`/`Aborted` → a structured failure; an
  unknown state → `unknown`), cursor continuation, the two budgets and the same-cursor re-request,
  the failure-reason mapping, the access refusal on a foreign job, the `advertisedToolNames`
  gating of every hint, and the strict-input refusals (a malformed jobId, the literal `null`
  cursor, an out-of-range `maxRecords`). `sfoa-identity-runtime` **75/75** (+2 classifier rows
  pinning `/jobs/query` and `/jobs/query/<id>/results` to `BULK_API` with the API version and path
  preserved). `sfoa-mcp-server` **237/237**, of which `data-tool-runtime` **21/21** (+4 protocol
  tests): `tools/list` absence while disabled, a submit → fetch closed loop through the real
  Streamable HTTP runtime (asserting the Tool input key sets, the exact five-call URL sequence,
  the string-valued CSV records and the per-call `apiUsage`), both halves' `TOOL_TERMINAL`
  summaries in the P7 audit trail, the governance block on an org-declared-unused object before
  any Salesforce call, and a Failed job reported with the platform reason plus four wire-level
  refusals of the pagination rules.
- **The live export leg is written but has not been executed here: `未执行 live，待人工补验`.**
  The `bulkQuery` gate in `packages/sfoa-mcp-server/src/validation/p9-live-validation.ts` reads
  the org's own `COUNT(Id)` first, refuses to report anything but `NOT TESTED` below a
  **100 000**-row floor (`P9_LIVE_BULK_OBJECT` points it at an object large enough, defaulting to
  `P9_LIVE_OBJECT`), submits the export, polls to `JobComplete` while asserting the running states
  claim nothing, walks the cursor to exhaustion asserting each page's internal agreement and that
  its cursor advanced, and then compares the summed `returnedCount` with the count it read first —
  recording the elapsed time, the page count and the `apiUsage` the responses reported. The row
  floor exists because a short result set cannot distinguish a correct walk from one that ends
  early by luck. Until that run happens on a deployment with a routeable identity, the gate
  reports `NOT TESTED` and the run's `overall` is `PARTIAL`; **no part of the row-count
  cross-check is asserted from the unit suite**, and nothing in this entry should be read as
  evidence that it was. The `yarn ai:audit` and live `apiUsage` observations the T4 acceptance
  requires are outstanding for the same reason.
- **Docs.** `ARCHITECTURE.md` promotes the P9-T4 row from `planned` to shipped and records the
  pair's four properties, why the read goes through `Connection.request`, and the `BULK_QUERY`
  purpose; the provider `README.md` gains the two Tool rows plus a section on the two properties
  an Agent has to be able to rely on; `response-budget.ts`'s `DATA_MAX_QUERY_TEXT_CHARACTERS` note
  now says it bounds the text of a Bulk result page as well as `query_records`.

## 2026-09-28 — P9-T3 follow-up: `get_org_limits` moves to the DIAGNOSTIC identity

`get_org_limits` is no longer a Data Tool. It moves from
`@sfoa/mcp-provider-sfoa-data` to `@sfoa/mcp-provider-sfoa-context` and from `READ`/`USER` to
`READ`/**`DIAGNOSTIC`**, because the limits resource is an org configuration read that no
business identity in this deployment is granted, and the DIAGNOSTIC role exists exactly for that
class of read. `search_records`, the official `run_soql_query` and every
`packages/mcp-provider-dx-core` file are untouched. See
[ADR-0027](adr/ADR-0027-p9-org-limits-diagnostic-identity.md), which revises the parts of
ADR-0026 recorded in the T3 entry below.

- **The alternative was rejected on purpose.** ADR-0026 named two ways out — grant a routed
  identity `View Setup and Configuration`, or route one that has it. Both widen a **business**
  identity into org configuration, which inverts the reason the diagnostic scope is siloed from
  the business roles (ADR-0009). `limits()` returns org-level quota counters and no business
  records, so it belongs on the server-owned identity instead.
- **The T3 entry below overstated two things, and this corrects them.** Its claim that "granting
  the routed user that permission, or routing one that has it, turns the gate into a real `PASS`
  with no code change" is wrong on both halves: the code did change, and that permission grant is
  the specific widening this decision rejects. The remedy is now "configure and verify a
  Diagnostic identity", which is a Control Plane action. The refusal itself is still described
  correctly there: what was measured is that no identity SFOA could route was allowed the read,
  not that the org forbids it.
- **This is the first time the diagnostic-identity question is answerable.** ADR-0026 could only
  defer it to "one administrator request to `GET /services/data/v68.0/limits`". The Tool is now
  that request, on that identity, under the audit pipeline, and the live gate measures the answer
  rather than assuming it.
- **Three DIAGNOSTIC gates were inherited, and the inheritance is now pinned.** Routing, the
  startup check and the per-request preflight all derive from `SFOA_CONTEXT_TOOL_ROLES`, so no
  config or HTTP-layer code changed. Because nothing in `config.ts` names the Tool, the existing
  boot-check test now iterates all three diagnostic Tool names instead of two.
- **The executor stayed in the host, and the role guard is why.** A provider-side executor is
  handed a connection it cannot attribute — `RequestScopedOrgService` carries no connection role
  and the context package does not depend on `@sfoa/identity-runtime` — so it could never prove
  its scope is DIAGNOSTIC. All three diagnostic executors now share one exported
  `assertDiagnosticScope`, so the refusal wording cannot drift.
- **A remedy that would have silently disappeared.** `query_records` and `search_records` name
  `get_org_limits` in their exhausted-allowance hint only when `hasTool(...)`, and that set was
  the **Data subset** — which the Tool can no longer be in, making the check permanently false
  with no error and no failing test. The provider now takes `advertisedToolNames` from the
  session's `enabledTools`, which is also what ADR-0025 and ADR-0026 said the rule was all along.
- **The context error surface gained two optional fields.** `ContextRuntimeError` takes an
  optional `suggestion`, and the context error result emits `suggestion`/`salesforceErrorCode`
  only when set. Every existing context output schema is `.strict()` and only the limits schema
  declares them, so the six pre-existing Tools' outputs are byte-identical — pinned by test.
- **The live gate reads the Tool first and the reference second, both on the diagnostic
  Connection**, and asserts the Connection's username normalises to the configured diagnostic
  identity — which is what proves routing really produced a diagnostic scope. It is enabled only
  when the Control Plane carries an enabled, verification-passed diagnostic row: appending the
  Tool unconditionally would have made *every* `tools/call` in the run fail the preflight, taking
  all nine gates down instead of this one. `NOT TESTED` still never becomes `PASS`; what changed
  is that the gate can now tell "the org refuses its limits resource" apart from "this deployment
  has not configured the identity that could try".
- **The first live run of that gate found two comparison rules that were wrong, and both are
  fixed.** They are recorded here rather than in ADR-0027 because neither is a product decision:
  they are defects in the instrument, and the second one is not related to this move at all.
  - `get_org_limits` was compared to its reference reading **number-for-number**. The Tool's read
    and the reference read are two live reads of a counter the gate's own traffic consumes, so
    `DailyApiRequests.remaining` cannot be equal in both: the first run failed with `used` off by
    3. The comparison is now split by what may move — `max` is a quota ceiling and is compared
    strictly, the Tool's `used` is checked against its own `max - remaining` (time-independent, so
    an operand-order bug is still caught on a moving counter), and a `remaining`/`used`
    disagreement is re-read once and waived **only** where the org's own value moved between the
    two readings. What was waived is reported as `toleratedMoves`, so the tolerance is evidence
    rather than silence. The next two runs exercised both paths: one needed no re-read, the next
    waived three moving values, and `orgLimits` passed in both.
  - `describe_sobject`'s `truncated` was read as a statement about the field list alone. It is a
    document-level declaration covering fields, child relationships and picklists, so the gate
    failed any object whose fields fit while its children did not — `Lead` holds 101 fields under
    the 200-field default but 72 child relationships against a cap of 50. **Pre-existing and
    unrelated to this move**: the executor and its constants are untouched by it, and no earlier
    run recorded a `PASS` on an object of that shape. The gate now derives the expected value from
    the org's own counts.
- **The gate run itself.** Against a Control Plane holding an enabled, verification-passed
  diagnostic row: eight gates `PASS`, `orgLimits` `PASS` — the diagnostic identity read all 73
  limits on `GET /services/data/v68.0/limits` where every business identity this deployment can
  route was refused — and `queryRecords` `NOT TESTED` because the configured live object holds 3
  rows and cannot exercise the continuation walk. `overall` = `PARTIAL`. The P7 chain for the row
  is complete, carries `purpose = ORG_LIMITS` and `execution_role = DIAGNOSTIC`, holds no token or
  query text, and shows the same `IDENTITY_AUTHENTICATION`/`INVALID_TYPE` and `PARTIAL` capture
  status as every other Tool in the run — that status is this environment's normal state, not an
  effect of the move.
- **Recorded, not fixed:** enabling the Tool without a diagnostic identity makes every
  `tools/call` fail (`enableAllowed` keys off upstream drift, not diagnostic verification — a
  pre-existing hazard for the other two diagnostic Tools); `diagnosticReady` still names only the
  original two; and a context Tool now reads a constant named `DATA_MAX_RESPONSE_BYTES`. T4 must
  also change its plan rather than its wording — a USER-side quota pre-flight cannot work, and
  ADR-0027 recommends reporting the quota facts a Bulk job response carries instead.

## 2026-09-28 — P9-T3: `get_org_limits` and `search_records`, and an org that refuses its own limits

> **Revised by the entry above.** `get_org_limits` is no longer `READ`/`USER` and no longer in
> the data provider — see [ADR-0027](adr/ADR-0027-p9-org-limits-diagnostic-identity.md). The
> refusal this entry measures is described correctly; the remedies it names are not, and its
> "both `READ`/`USER`" wording applies to `search_records` alone now.

P9-T3 adds the last two read capabilities the official `@salesforce/mcp-provider-dx-core` does
not supply, both `READ`/`USER` and default-disabled: `get_org_limits` (GAP-D7, the prerequisite
T4 depends on) and `search_records` (GAP-D5). The official `run_soql_query` and every
`packages/mcp-provider-dx-core` file are byte-identical.

- **Probe first, then freeze.** ADR-0025's lesson — a claim about Salesforce's response shape can
  only come from Salesforce — was applied before the executors were frozen, and it paid for
  itself twice. `RETURNING Account` with no field list is legal but returns each record with
  nothing but `attributes` and `Id`, so `search_records` now always writes a field list
  (default `Id, Name`) and takes an optional `fields` input; and `attributes.sobjectType` is
  **absent**, so records are grouped by `attributes.type`. Both findings are in
  `docs/sfoa/P9_T3_LIVE_PROBE_FINDINGS.md` §4 and §3.
- **The limits resource is refused to every identity SFOA can currently route.** `Connection.limits()`
  fails with `API_DISABLED_FOR_ORG "limits resource is not enabled"`, identically for four enabled
  identity routes and for the raw REST path at API v68.0/v62.0/v58.0/v50.0, with `limits` absent
  from the ~50 root resources the org advertises. All four are integration identities of this one
  deployment sharing a profile shape, and **no administrator identity was tested** — so what is
  measured is that no identity SFOA can route is allowed the read, not that the org forbids it.
  The leading cause is a **missing permission rather than an org-wide switch**: `API Enabled` is
  provably present (the same identities run `query`/`describeGlobal`/`search`, and a missing
  `API Enabled` reports a different code, `API_CURRENTLY_DISABLED`), while `limits resource is not
  enabled` is what Salesforce returns when the connecting user lacks **View Setup and
  Configuration** — a read-only permission that would also explain the uniformity across four
  identities, since they share a profile. One administrator request to
  `GET /services/data/v68.0/limits` settles it. `get_org_limits` is therefore correct but
  **cannot return data through the identities this deployment routes**: its live gate is
  `NOT TESTED` and must never be `PASS`, because calling a refusal a pass would claim a read that
  never happened. Granting the routed user that permission, or routing one that has it, turns the
  gate into a real `PASS` with no code change. The gate does not skip the path: it calls the Tool
  once anyway and requires a structured `MCP_LIMITS_ACCESS_DENIED` with a suggestion, failing if
  anything else comes back. Until the permission question is settled the P9-3 → P9-4 dependency
  recorded in the gap analysis cannot be satisfied, so T4's quota pre-flight can only be
  best-effort.
- **A quota slot that is absent is reported as absent.** `highlights` carries exactly five slots
  (`dailyApiRequests`, `dailyBulkApiRequests`, `dailyAsyncApexExecutions`, `dataStorageMB`,
  `fileStorageMB`), written out in full in the schema so dropping one is a compile error, and
  all five are **always present**: an unmetered resource is `present: false, key: null` with null
  numbers — never omitted, never zeroed, because a missing slot and a zero allowance are
  indistinguishable to a reader of the other. `key` names the org key that actually filled the
  slot, since the Bulk allowance is `DailyBulkApiRequests` under Bulk API 1.0 and
  `DailyBulkV2QueryJobs` under 2.0. A numeric string is **not** coerced: the limits resource
  reports numbers, so a string means the payload is not the shape the Tool was written against,
  and coercing it would put an invented quota in front of a job-sizing decision. No readable
  entry at all is `MCP_LIMITS_READ_FAILED`, not `{limits: {}}` — an empty success invites "this
  org has no quota", the opposite of what the Tool exists to prevent.
- **SOSL completeness is withheld when it cannot be shown.** `SearchResult` carries only
  `searchRecords` — no `totalSize`, no `done`, no cursor (findings §2) — so `truncated` and
  `truncatedReason` are derived from whichever explicit cap the statement carried
  (`LIMIT_REACHED` | `PER_OBJECT_LIMIT` | `RESPONSE_BUDGET`) and `complete` is claimed only
  against an explicit cap that was not reached. `limitSource: 'UNSPECIFIED'` always reports
  `complete: false` with the reason and the fix. `MCP_ENGINEERING_RULES.md` §Pagination's
  `has_more`/cursor requirement cannot be met by SOSL and is satisfied the way `list_sobjects`
  satisfies it.
- **Refuse rather than silently rewrite.** `objects`/`fields`/`limit` alongside a complete
  `FIND` clause are refused, not ignored — the clause is the caller's own text, and a recognised
  parameter that does nothing leaves the caller unable to tell which applied. `{` and `}` are
  refused in a bare keyword rather than escaped, being the only characters that could terminate
  the brace group the Tool writes, and a bare keyword whose first word is `find` is read as a
  clause and refused, with the refusal naming the way out.
- **Two new audit purposes.** `SalesforceApiPurpose` gains `ORG_LIMITS` and `SOSL_SEARCH`
  instead of reusing `USER_QUERY`. The union is free-form at the storage layer
  (`sfoa_salesforce_api_call.purpose` is `VARCHAR(256)`), so both are additive with no migration
  and no Control Plane change. Neither sets `queryType`, so the Admin audit trace's SOQL count is
  unaffected — reusing `USER_QUERY` would file a quota read and a keyword search as SOQL queries,
  and the SOSL row would carry `query_type = NULL`, which the trace reads as a failed semantic
  capture. `jsforce-audit-adapter` is **not** touched: `/search` already lands as a clean,
  complete row, because the adapter's `emptySemanticEvidence()` returns before
  `recordSalesforceApiCaptureFailure()`.
- **The live run.** Route selected from the MySQL Control Plane and injected in-process, so the
  platform user id never reaches a command line or the transcript (`IntermediateTable__c`, org
  total 4449): **`overall: PARTIAL`**, with `toolInventory`, `requestIdentity`, `listSobjects`,
  `describeSobject`, `queryRecords`, `searchRecords`, `schemaSelfRepair` and `credentialSafety`
  all **PASS** over **12** request-scoped Connections and one Salesforce username. `orgLimits` is
  `NOT TESTED` with `{orgAnswer: 'API_DISABLED_FOR_ORG', toolErrorCode: 'MCP_LIMITS_ACCESS_DENIED',
  toolSalesforceErrorCode: 'API_DISABLED_FOR_ORG', denialIsStructured: true}` — `PARTIAL` for that
  reason alone. `searchRecords` PASSed both probes (`mode: KEYWORD`,
  `statementMatchesPrediction: true`, org count 1, `totalReturned` 1, `truncated: false`,
  `complete: true`, no mismatch): the unscoped probe at the Tool's maximum limit and the same term
  scoped to one object, each cross-checked against the org's own count for **the statement the
  Tool reported sending**, read over the same request-scoped Connection.
- **Audit evidence.** The live run produced an `ORG_LIMITS` row (`REST_API`, `FAILED`) and four
  `SOSL_SEARCH` rows (`REST_API`, `SUCCESS`), all with `query_type: NULL`, with the
  `search_records` rows carrying `requestSummary.summary = {search, objects, fields, limit}` and
  a chain of REQUEST → IDENTITY_PROVIDER → PLATFORM_USER → IDENTITY_ROUTE → SALESFORCE_USER →
  TOOLS_CALL → SALESFORCE_API → RESULT and no capture failure. No search term text is recorded —
  the summary carries the bounded token, not the value.
- **The harness needed the attachment ingress enabled to start at all.** A Control Plane that
  enables an attachment Tool and a runtime whose config has the ingress switched off refuse every
  request with `MCP_ATTACHMENT_CONFIGURATION_INVALID` before any Tool runs. The live driver bound
  the same ingress a deployment granting that Tool would. This is a **test-harness gap, not a
  product defect**, and it is recorded rather than fixed here so the P9-T3 diff stays scoped.
- **Regression set green.** `mcp-provider-sfoa-data` 131/131, `sfoa-mcp-server` 222/222,
  `test:p3` 25/25, `test:p4` 8/8, `test:p5` 6/6, `test:p7` 6/6, `validate:p4` PASS,
  `validate:upstream` `drift: []`, `skill:check` `drift: []`, `admin-api` 26/26,
  `identity-runtime` 75/75, `control-plane` 38/38, `mcp-provider-sfoa-dml` 46/46,
  `mcp-provider-sfoa-context` 83/83, `agent-playbook` 35/35, and all five touched SFoA
  workspaces lint clean. Root `yarn lint` / `yarn build` still fail inside the vendored
  `mcp-provider-code-analyzer` (`'eslint' is not recognized`), which this change does not touch.
- **Deviations from the plan's wording** (twelve, all recorded in ADR-0026): the added `fields`
  input and `mode`/`statement` outputs, `get_org_limits` needing no `enabledToolNames`,
  `fields` in the audit summary, `SOSL_MAX_STATEMENT_LENGTH`, the unverified alias table,
  §Pagination satisfied by cap-plus-counts, `resultsByObject` upgraded from bare arrays to object
  groups, the omitted per-object `label`, the two new purposes with the reasoning for leaving the
  query semantic channel alone, `measured`'s exact definition, and the leading-`find` refusal.

## 2026-09-28 — P9-T2 fix: a bare `COUNT()` is a value, not a row count — and the live gate now passes

Follow-up to the P9-T2 commit, and the resolution of the sentence that entry ends on. Running
the `queryRecords` live gate for the first time found a **real defect that every unit test had
agreed with**, plus a second defect in the gate itself. Both are fixed, and `yarn validate:p9`
now reports `overall: PASS`.

- **The defect: the Tool contradicted the advice it gives.** Salesforce answers a bare
  `SELECT COUNT()` with the value in `totalSize` and **no records at all** — verified live,
  `COUNT()` came back as `totalSize: 797, records: []` on `Account`, `4449` on
  `IntermediateTable__c` and `349` on `User`, so it is the response shape rather than a property
  of one count. The completeness rule read that value as a row count, so `fetched (0)`
  disagreed with `totalSize (4449)` and a **correct** count was reported as
  `complete: false, truncated: true, truncatedReason: PAGINATION_UNAVAILABLE`. That told the
  Agent that `COUNT()` — the one query ADR-0025 recommends as *the* fix for a truncated result —
  was itself truncated. The fix distinguishes a **scalar** aggregate (no `GROUP BY`) from a
  grouped one: `inspectSoqlQuery` now returns `grouped` alongside `aggregate`, the value is
  reported as a new `aggregateValue` field with `totalSize: null`, `complete` for that shape is
  `done` alone, and the hint names the value because `records` is legitimately empty.
  The carve-out is `aggregate && !grouped && fetched === 0 && totalSize !== null`: requiring
  `fetched === 0` keeps it off `SELECT COUNT(Id) total FROM X`, which returns one
  `AggregateResult` row and a `totalSize` of 1, and requiring `!grouped` keeps it off a grouped
  aggregate, which does have a row set and keeps the ordinary declared-short reading.
- **Why the unit tests missed it.** The stub Connection returned the shape the code assumed — an
  aggregate with a row and a matching `totalSize` — so every assertion held while the Tool was
  wrong against the org. A stub can only confirm that the code agrees with itself; a claim about
  *Salesforce's* response shape has to come from Salesforce. The unit suite now pins the live
  shape (`queryBatch([], { totalSize: 4449 })`), and the live gate cross-checks the scalar
  aggregate against the org's own bare `COUNT()` as well as against `COUNT(Id) total`.
- **The second defect was in the gate.** Its 500-row-cap assertion required exactly 500 rows
  back, which is true only for records narrow enough to fit the character budget. On
  `IntermediateTable__c` the cap fetches 500 and the payload budget returns 392, so the gate
  read correct behaviour as a failure. It now asserts the contract instead of a measurement —
  the cap bound fetching, the returned slice is declared, and the declared reason matches
  whether the payload cut it — and asserts that when the payload did cut it the hint names both
  bindings (`Truncated by MAX_ROWS + RESPONSE_BUDGET`). A gate that hard-codes a measurement
  becomes a false negative the moment the input object changes.
- **The live result** (route selected from the MySQL Control Plane and injected in-process, so
  the platform user id never reaches a command line or the transcript; `IntermediateTable__c`,
  org total 4449): `overall: PASS`, exit 0, with `toolInventory`, `requestIdentity`,
  `listSobjects`, `describeSobject`, `queryRecords`, `schemaSelfRepair` and `credentialSafety`
  all PASS over **9** request-scoped Connections, one Salesforce username, and 525 052 bytes of
  result scanned for token material with no match. `queryRecords` facts: the row budget set
  above the org's size fetched all 4449 rows over 3 pages with `done: true` and a declared
  `RESPONSE_BUDGET` cut to 392 (the character budget is the binding one for rows carrying an
  `attributes` block); the 500-row cap fetched 500 and declared `RESPONSE_BUDGET` with a hint
  naming no unadvertised Tool; and `SELECT COUNT()` returned `aggregate: true`, `complete: true`,
  `truncated: false`, `totalSize: null`, `aggregateValue: 4449` with no records — matching the
  org's independently-read bare `COUNT()` of 4449.
- **A documented deviation from the plan's wording.** `P9_EXECUTION_PROMPTS.md` asks the live
  check to confirm `fetched == COUNT()` **and** `truncated == false`; on this object the first
  holds and the second cannot, because 4449 rows cannot fit a bounded payload. That is the Tool
  working as designed and saying so, not a shortfall, and ADR-0025 now records the general rule
  — a gate asserts the contract, and completeness is `complete` when the answer *is* the result,
  which for a large detail set it is not.
- **Regression set green after the fix.** `mcp-provider-sfoa-data` 79/79 (+4: the live
  scalar-aggregate shape, the sibling `COUNT(Id) total` shape, a grouped aggregate that must
  still report `PAGINATION_UNAVAILABLE`, and a protocol test asserting the scalar aggregate in
  both the text and `structuredContent`), `sfoa-mcp-server` 216/216, `test:p3` 25/25,
  `test:p4` 8/8, `test:p5` 6/6, `test:p7` 6/6, `validate:p4` PASS, `validate:upstream` PASS with
  no drift, `skill:check` no drift.
- **ADR-0025 and ARCHITECTURE.md updated** with the scalar-aggregate shape, the two budget
  passes bounding the same `records` array and why, and the two findings above.

## 2026-09-28 — P9-T2: `query_records`, a SOQL Tool that consumes the continuation cursor and declares its own completeness

Closed GAP-D1 on `feature/p9-data-completeness` with the second Tool of
`@sfoa/mcp-provider-sfoa-data`. The defect it fixes is a silent one: the official
`run_soql_query` performs exactly one `connection.query(...)` and never reads `nextRecordsUrl`,
has no row budget, and the platform refuses `OFFSET > 2000`, so a result larger than one
batch comes back as the **first batch with nothing in the payload distinguishing it from a
complete answer**. An Agent that counts 2 000 rows out of 46 000 then reports a conclusion
about 2 000 rows as though it were a conclusion about the object. The design record is
[ADR-0025](adr/ADR-0025-p9-query-records-bounded-completeness.md).

- **The official Tool is byte-identical.** `query_records` is not a rename, an alias or a
  same-name replacement — it is a separate Tool with its own name, its own default-disabled
  grant and its own audit classification, so `run_diagnostic_tooling_query` (which depends on
  `run_soql_query`) and `validate:upstream` are unaffected. The tie-break an Agent needs lives
  in the **new** Tool's description, because it is the new Tool that has to justify itself.
- **Completeness is derived from evidence and withheld when the evidence is missing:**
  `complete = done && totalSize !== null && fetched === totalSize && !budgetCut`. A platform
  that reports `done: true` while handing back fewer rows than its own `totalSize` and no
  continuation cursor has declared the result incomplete; that is `PAGINATION_UNAVAILABLE` and
  the Tool must **not** report `complete`. A `totalSize` the platform never reported leaves
  completeness unconfirmable, and the hint says so and suggests re-running as `COUNT()`.
- **Every short answer names why, from a closed enum.** `MAX_ROWS` (the caller's budget — re-query
  higher or aggregate), `TIME_BUDGET` (the 60 s continuation-loop budget, which bounds the
  *continuation*, not the first batch the host already bounds), `RESPONSE_BUDGET` (the byte or
  character budget cut the returned slice), `PAGINATION_UNAVAILABLE` (nobody's to fix). When a
  response-budget cut follows a row- or time-budget stop, `truncatedReason` is `RESPONSE_BUDGET`
  because that is what the reader has to work around, while the hint names every binding
  (`Truncated by MAX_ROWS + RESPONSE_BUDGET`) so nothing about why fetching stopped is lost.
- **A hint may only name a Tool the session advertises.** The Provider passes the session's
  enabled Tool names into the executor, so `submit_bulk_query` (P9-T4) is recommended by name
  only when it is actually in `tools/list`; otherwise the hint says to ask an administrator.
  Naming a Tool the caller cannot see costs it a turn to discover that, which is worse than a
  hint naming no Tool at all. The same rule governs `get_org_limits` (P9-T3) in the
  quota error. A protocol test asserts the truncation hint matches neither name.
- **Two budgets, each measured in the unit it is consumed in.** The structured payload is
  bounded in bytes (262 144) because that is what the transport carries, the text the Agent
  reads in characters (60 000) because that is what the context window consumes, and both
  measure the **fully composed** output — including the hint and the truncation flags that
  make the result honest — so a payload can never be pushed over budget by its own explanation
  of why it is short. `trimToByteBudget`/`trimToCharacterBudget` now share one prefix search;
  the character pass is applied to the byte pass result, which is sound because both
  measurements grow with the prefix.
- **A finding about the enforcement split, asserted from both sides** (extends ADR-0024).
  `queryRecordsInputShape` is the raw `.shape` of a non-strict Zod object, so the **field-level**
  bounds do reach the wire — `maxRows: 0`, `maxRows: 50001`, a non-integer `maxRows` and an
  empty `query` are refused as invalid arguments and **no Connection is opened** — while the
  **statement rules** (no unterminated literal, no semicolon outside a literal, must begin with
  `SELECT`, no `FOR UPDATE`) need literal-aware scanning that a JSON Schema `pattern` cannot
  express, so they live in `superRefine` **and** are re-inspected by the executor, so a caller
  reaching the executor without the Tool's parse still cannot spend a Salesforce round trip on
  a statement the Tool refuses. Unknown keys stay inert: the schema has no identity parameter,
  so no credential key can select an identity. The default row budget is applied by the
  **executor**, not the schema, so `maxRows` omitted and `maxRows: 2000` are the same request by
  construction rather than by coincidence.
- **`INVALID_TYPE` is usually a data/Tooling split, not a typo.** The `INVALID_TYPE` /
  `INVALID_FIELD` mapping therefore names the **opposite** API in its suggestion
  (`useToolingApi=true` for a Tooling object, `false` for a business object), so a second
  attempt is informed instead of a repeat of the first. Five new structured codes carry the
  classes an Agent acts on differently: `MCP_QUERY_RECORDS_FAILED`, `MCP_QUERY_FIELD_INVALID`,
  `MCP_QUERY_MALFORMED`, `MCP_QUERY_LIMIT_EXCEEDED`, `MCP_QUERY_ACCESS_DENIED`.
- **Audit wiring reuses the official SOQL path rather than inventing a second one.**
  `DATA_TOOL_PURPOSES.query_records` is `USER_QUERY` under the same compile-enforced
  `Record<SfoaDataToolName, SalesforceApiPurpose>` map, and the host facade binds
  `runWithSalesforceQuerySemantic({queryType: 'DATA_SOQL'|'TOOLING_SOQL', soqlStatement})`
  around the **whole** Tool call, so a multi-page continuation is one audited query rather than
  unattributed API traffic. The statement is therefore recorded **once**, by that collector; the
  request summary carries only what it cannot show (`useToolingApi`, `maxRows`) and the response
  summary carries `totalSize`/`fetched`/`pages`/`complete`/`truncated`/`truncatedReason`.
  `query_records` runs the **same** org object-usage guard as the official path, so the two SOQL
  Tools cannot disagree about which objects are in use; a blocked query opens no Connection and
  is audited as a `GOVERNANCE`-sourced `BLOCKED`/`DENIED` event.
- **Live validation is a gate, not a ritual — and the gate reads the count from the org.**
  `packages/sfoa-mcp-server/src/validation/p9-live-validation.ts` gains a `queryRecords` gate
  (the report's `task` is now `T1+T2`) that checks the Tool's whole purpose against **the org's
  own `COUNT()`**, read over the same request-scoped Connection and never produced by the Tool:
  an uncapped walk must report `totalSize`/`fetched` equal to that count, `done: true` and a
  `complete` consistent with whether the response budget shortened the slice; a 500-row cap must
  report `fetched: 500`, `complete: false`, `truncatedReason: MAX_ROWS`, a non-empty hint and a
  hint naming no unadvertised Tool; `SELECT COUNT()` must come back `aggregate: true`, complete
  and untruncated against the same count. An object holding ≤2000 rows would exercise no
  continuation at all, so the gate reports **`NOT TESTED` with the reason** rather than a
  vacuous PASS — which is where it stood at this commit, because `P9_LIVE_PLATFORM_USER` is not
  present in `.env.local` and no live run had been made. The live run followed, and is recorded
  in the entry above it; it found a defect in this Tool and one in this gate, both now fixed.
- **Regression set green.** `mcp-provider-sfoa-data` 75/75 (+26: 20 executor tests, a
  continuation walk through the protocol, input-boundary and audit-trail protocol tests in
  `sfoa-mcp-server`), `sfoa-mcp-server` 216/216 (+5), `test:p3` 25/25, `test:p4` 8/8,
  `test:p5` 6/6, `test:p7` 6/6, `validate:p4` PASS, `validate:upstream` no drift. Every other
  SFoA workspace suite is green: `agent-playbook` 35/35, `identity-runtime` 75/75,
  `control-plane` 38/38, `mcp-provider-sfoa-dml` 46/46, `mcp-provider-sfoa-context` 83/83,
  `admin-api` 26/26. Build and lint clean across all nine workspaces.
- **Two live-input gates are `PARTIAL`/`FAIL` for an environment reason, recorded rather than
  papered over.** `validate:p2` reports `PARTIAL` and `validate:p3` reports `FAIL`, both with
  `Missing Live Inputs SECOND_TEST_USER`: each gate refuses at `main.ts` **before** any runtime
  code runs, so the result is a missing `.env.local` input and not a P9 behaviour. The same
  pre-existing environment debt noted in T1 is unchanged (`yarn install`'s `ENOENT … ignore`
  in the vendored `mcp-provider-api` tree; every SFoA script calls
  `node ./node_modules/typescript/bin/tsc` by explicit path, so it is off the gate path).
- **Architecture baseline updated.** `docs/sfoa/ARCHITECTURE.md` moves the `query_records` row
  from `planned` to `P9-T2` and records the completeness contract, the `PAGINATION_UNAVAILABLE`
  case, the closed truncation enum, the hint discipline and the shared guard / `USER_QUERY`
  purpose / request-scoped Connection, citing ADR-0025.

## 2026-09-24 — P9-T1: `@sfoa/mcp-provider-sfoa-data` skeleton with `list_sobjects` and `describe_sobject`

Opened the P9 data-completeness phase on branch `feature/p9-data-completeness` (from `main`
@ `d9f23a8`, the gap-analysis doc `903f0a3`) by shipping the new Provider package and its
first two read Tools. This is the first SFoA Provider whose capabilities come from the
**official jsforce SDK** rather than from a reused or wrapped upstream Tool; the upstream
audit is [ADR-0024](adr/ADR-0024-p9-data-provider-over-official-sdk.md).

- **The upstream-first obligation was discharged with a concrete inventory, not an
  assumption.** The pinned `@salesforce/mcp-provider-dx-core@0.10.0` `provideTools()` returns
  exactly 13 Tools, none of which is a describe, SObject-inventory, org-limit, SOSL or Bulk
  capability; `list_all_orgs` is the nearest name and lists CLI auth-cache orgs, not
  SObjects. The only official Provider packages installed anywhere in the workspace are
  `mcp-provider-api` and `mcp-provider-dx-core`, so no second official Provider could supply
  the gap either. Official Salesforce TypeScript is unmodified — in particular
  `run_soql_query` stays intact, because `run_diagnostic_tooling_query` depends on it.
- **Both Tools are default-disabled and Admin-enablable.** They are absent from
  `DEFAULT_ENABLED_TOOLS`, so they are invisible in `tools/list` and unaddressable in
  `tools/call` until an Admin enables them through the control-plane channel, after which
  they execute through the P7 audit pipeline. A default-disabled Tool is only shippable if an
  Admin can reach it, so `packages/sfoa-admin-api/src/tool-catalog.ts` now lists every
  `SFOA_DATA_TOOL_NAMES` entry as `READ`/`USER`/`enableAllowed: true`.
- **`list_sobjects` is a deliberate rename of the gap analysis' `describe_global`.** Naming
  the Tool after the SDK method would read as a variant of `describe_sobject` to a model
  choosing between them; `list_sobjects` returns an inventory, not a schema. Recorded in
  ADR-0024.
- **A finding about the official Provider API, recorded rather than papered over.**
  `McpToolConfig.inputSchema` is a `z.ZodRawShape`, so the SDK registers `z.object(shape)`:
  an unrecognised key is stripped, not rejected, and a provider-side `.strict()` never
  reaches the wire. Field-level constraints do hold at the protocol boundary, and the
  guarantee that matters is structural — the schema has no identity parameter at all, so a
  caller-supplied `username`/`accessToken`/`instanceUrl` cannot select an identity. Protocol
  tests assert both halves: an out-of-range limit or a relationship path is refused before any
  Connection opens, while a call carrying credential keys returns byte-identical output to the
  same call without them and still reads the request's single Salesforce user.
- **Audit classification is compile-enforced.** The host facade pins each Tool to a
  `SalesforceApiPurpose` through `Record<SfoaDataToolName, SalesforceApiPurpose>`
  (`OBJECT_SCHEMA`), so a future P9 Tool cannot reach the audit pipeline unclassified. A
  Provider that redefines a Data Tool name aborts composition with
  `MCP_PROVIDER_INITIALIZATION_FAILED` instead of silently overriding it.
- **Two defects found and fixed while writing the tests.** `mapDataFailure` re-classified the
  identity-unavailable error raised *inside* the executor, replacing the actionable
  `MCP_DATA_IDENTITY_UNAVAILABLE` code with a generic failure; it now short-circuits on an
  existing `DataRuntimeError`. And the codeless-failure fallback echoed the thrown message, so
  a socket error surfaced a `/services/data/v67.0/sobjects` path in the Agent-visible result;
  the Salesforce message is now repeated only when Salesforce reported an error code.
- **A third defect, found only by the live run: the reader trimmed org text.** The first
  `readString` helper trimmed every string it read. A real `describe()` of Account returned the
  picklist label `"Z1 不检查信用 "` (trailing space), and the Tool reported `"Z1 不检查信用"` —
  a string the org never declared. Five picklist labels across `Check_Rule__c`,
  `In_Approval_*__c` and `Risk_Level__c` were affected. No unit test could have caught this,
  because every fixture was written with text that had no surrounding whitespace to lose. The
  readers are now split by the role the text plays: **display facts** (object/field/picklist
  labels) are returned verbatim, and **identifiers** (API names, `referenceTo` targets, `type`,
  `keyPrefix`) are returned verbatim as well but with whitespace-only text treated as absent —
  such an entry is *dropped* rather than rewritten, because `"   "` is not an object the Agent
  can describe or query. A regression test asserts a whitespace-padded label and picklist value
  survive the round trip. Recorded in ADR-0024.
- **Live validation is a first-class gate, not a manual ritual.**
  `packages/sfoa-mcp-server/src/validation/p9-live-validation.ts` (`yarn validate:p9`) starts
  the **production** runtime against the local org — the real MySQL control plane, the real P7
  audit stack (`DatabaseRuntimeLogger` + `MySqlAuditBatchSink` + `AsyncAuditPipeline`) and the
  real identity runtime — then reads every returned fact back over the same request-scoped
  Connection with independent queries and reports `PASS`/`FAIL`/`NOT TESTED` per gate. It never
  writes to the Control Plane to make a gate pass: the Data Tools are granted by widening the
  in-memory policy snapshot for that process only. The platform user is supplied as
  `P9_LIVE_PLATFORM_USER` so no real employee ID enters the repository. Gates: `toolInventory`,
  `requestIdentity`, `listSobjects`, `describeSobject`, `schemaSelfRepair`, `credentialSafety`,
  `connections`.
- **Live evidence, org `Account`, routed identity `cynthia.chen@ningborunner.com.uat`,
  `overall: PASS`, 0 FAIL.** `list_sobjects`: 46 org objects match `Acc`; `limit=5` returned 5
  with `truncated: true` and a hint, `limit=46` returned all 46 with `truncated: false`; every
  `label`/`keyPrefix`/`custom`/`queryable`/`createable`/`updateable`/`searchable` fact matched
  the org, `factMismatches: []`. `describe_sobject`: 237 org fields and 142 child relationships;
  200 fields and 50 children returned, correctly flagged truncated; `fieldLimit=3` and
  `includeFields: false` both behaved as declared; all header, field and child facts matched
  (`fieldMismatches`, `childMismatches`, `headerMismatches` all empty). Self-repair: a
  nonexistent object returns `isError: true`, `errorCode: MCP_SOBJECT_NOT_FOUND`,
  `salesforceErrorCode: NOT_FOUND`, and a suggestion naming `list_sobjects`. Credential safety:
  6 results / 355 657 bytes scanned, no session-id, bearer, JWT, private-key, credential-field
  or stack-frame pattern matched. Connections: 6 Connections for 6 Tool calls, all through the
  single routed Salesforce user, `executionRole: USER` throughout.
- **The P7 audit chain was verified from MySQL, not assumed.** `yarn ai:audit --user … --latest
  12 --since 1h` reconstructs
  `REQUEST → IDENTITY_PROVIDER → PLATFORM_USER → IDENTITY_ROUTE → SALESFORCE_USER → TOOLS_CALL
  → SALESFORCE_API → RESULT` for all 12 calls of the two live runs, with `toolName`
  `list_sobjects`/`describe_sobject`, `executionRole: USER`,
  `identitySource: INTERNAL_SERVICE_HEADER`, and the expected `errorCode` on the negative case.
  `auditIntegrityStatus: PARTIAL` and `salesforceApiCaptureFailureCount: 2` are **baseline, not
  a P9 regression**: `run_soql_query`, `create_record`, `get_record_display_context` and
  `run_diagnostic_tooling_query` rows carry the identical counters, and `PARTIAL` is the
  dominant status for every Tool in this environment.
- **Architecture baseline updated.** `docs/sfoa/ARCHITECTURE.md` gains a
  `P9 Data Completeness Boundary` section: the request path, the shipped-versus-planned Tool
  table (only `list_sobjects`/`describe_sobject` are advertised today), the default-disabled
  governance and Admin-catalog requirement, the compile-enforced audit classification, and the
  org-fidelity rule for labels versus identifiers.
- **Regression set green.** `mcp-provider-sfoa-data` 49/49, `sfoa-admin-api` 26/26,
  `sfoa-mcp-server` 211/211 plus `test:p3` 25/25, `test:p4` 8/8, `test:p5` 6/6, `test:p7` 6/6.
  `validate:upstream` reports no drift.
- **Known environment debt, unchanged and not introduced here:** `yarn install` fails with
  `ENOENT … @typescript-eslint/eslint-plugin/node_modules/ignore` in the vendored
  `mcp-provider-api` tree. It does not block this work — the new workspace's `node_modules`
  and its `@sfoa/` junction are created before the failing point, and every SFoA script calls
  `node ./node_modules/typescript/bin/tsc` by explicit path, so the missing `.bin` shims that
  fail the vendored packages are not on the SFoA gate path.

## 2026-09-16 — Skill-02C attachment upload: probe gate closed, Tool shipped, audit defect fixed, test server deployed

Attachment upload round. Branch `feature/sfoa-attachment-upload`, cut from the Skill-02B
tip `ce800c2` (itself a descendant of `main` @ `3adae7b`; 02B changed no runtime code), with
the three probe commits cherry-picked on top — verified byte-equivalent by `git patch-id`.
Implementation `e685ba8`, fix `59cb040`. Pushed to `origin` on 2026-09-16
(`origin/feature/sfoa-attachment-upload`, documentation commits only above `59cb040`);
**not** merged into `main`. The probe branch was fast-forwarded at the same time.

- **Closed the Probe Verification Gate with real API evidence before writing any code.**
  Supplying a real business record (`a0fC5000000n9RxIAI`, `Account_Visit__c`) answered the
  three questions left pending and moved the verdict from `PARTIALLY VERIFIED` /
  `MORE PROBE REQUIRED` to `FEASIBLE` / `READY FOR ATTACHMENT TOOL DESIGN`: 18 gates,
  0 FAIL, 0 BLOCKED. Two SFoA behaviours it established shape the design — publishing with
  `FirstPublishLocationId` creates **two** links (the business-record `ShareType=V` one plus
  a `ShareType=I` self-link to the creator), which is why the Agent never needs
  `ContentDocumentLink`; and a well-formed but non-existent target returns **HTTP 201 with an
  unlinked file**, so a 201 alone never proves which record received the file and the
  reconciliation path for unknown outcomes stays mandatory. The target record was verified
  byte-identical before and after, by an independent read-only check rather than the probe's
  own report, and had zero `ContentDocumentLink` rows on both sides.
- **Shipped one new business Tool, `upload_files_to_record`, and no new Skill.** The input
  schema has exactly three properties — `objectApiName`, `recordId`, `attachmentRefs` — and
  deliberately no `content`, `base64`, `versionData`, `path`, `filePath` or `sourceUrl`, so
  the model cannot name a file, a host path or a URL. Attachment enablement is an independent
  policy channel and Tool inventory (`attachment_enabled`, migration `014`,
  `NOT NULL DEFAULT false`) rather than a member of `MCP_DML_ALLOWLIST_JSON`, because
  attaching a file is neither a CREATE nor a field UPDATE. The Files objects stay internal
  technical objects, never Generic DML targets, and never appear as business objects in the
  Admin Web policy list. No extension, MIME or size-limit mirror of Salesforce file rules
  exists in configuration, database or UI.
- **Completed the inbound half too.** The Attachment Bridge lives inside our own
  `sfoa-wecom-mcp-adapter` plugin; the **official WeCom plugin is not modified** and OpenClaw
  Core is not patched. The bridge forwards only media facts OpenClaw itself stamped below the
  configured staging root, never reads bytes into a string or buffer, never derives a path
  from model or user input and never fetches a media URL.
- **Found and fixed a real defect that the machine gates had missed.** Every *successful*
  upload published its file and then lost the entire P7 Audit snapshot — no master row, no
  terminal event, no API-call row, hence no record of the `ContentVersionId` just created;
  the only trace was `MCP_AUDIT_SNAPSHOT_REJECTED` in the server log. The recorder claimed
  `EXACT_HTTP` evidence together with an `OPERATION_ONLY` label, which the sink refuses
  non-retryably. Failures audited fine because they never reached Salesforce and so never
  recorded an API call, and no test inspected the snapshot the sink persists or ran the
  upload inside a request audit context. Fixed by removing the field from the evidence type
  so the invariant is structural, extracting the sink's database-free checks into an exported
  `assertAuditSnapshotPersistable` invoked before the transaction opens (same errors, order
  and retryability, so no behaviour change), and adding a gate that drives the real upload
  inside a request audit context and requires the finalised snapshot to satisfy that
  contract. Reintroducing the old field was confirmed to make the new gate fail, so the gate
  is real rather than vacuous.
- **Deployed to the test server, and verified against the live channel.** `59cb040`, archive
  sha256 `d2cc72d5…3ce06`, 1138/1138 files byte-verified after `rsync -a`. Four services
  active; `tools/list` returns the same 16 Tools on both the internal and the WeCom channel
  credential paths, and a **WeCom-credential `tools/call`** was verified executing the Tool
  (`identity_source=WECOM_HEADER`, `execution_role=USER`). Three real `ContentVersion`s were
  created on the test org: the pre-fix one has no audit row, both post-fix ones are audited.
  Per §九十五 those files were **not** auto-deleted. Production was not touched.
- Status and evidence: `docs/sfoa/SKILL_02C_IMPLEMENTATION_REPORT.md`; six operator-run UAT
  cases are prepared but **not executed**: `docs/sfoa/SKILL_02C_ATTACHMENT_UAT.md`.

## 2026-09-15 — Skill-02B final review, cross-Skill fact fix, and OpenClaw test-env deployment closure

Review + deployment round for Skill-02B; no new Skill capability. 02B branch is
`feature/openclaw-sfoa-record-change-02b`, base `main` @ `3adae7b`, review start
`5626163`, final `4b3b2ff`. 02A FINAL is `hotfix/openclaw-sfoa-record-change-02a-delivery`
@ `345b739`. 02B is **not** merged into `main` yet.

- **Found and fixed two stale cross-Skill facts.** Skill-02B made two statements in
  the co-visible `sfoa-crm-core` Skill factually wrong, and both are read in the same
  Agent turn as `sfoa-record-change`, so leaving them would let one Skill contradict
  the other: `references/mutation-boundaries.md` still described the readiness
  doctrine as covering "CREATE 与批量 CREATE" only, and
  `references/operating-principles.md` still claimed "当前只实现 Core；未来 eligible
  sfoa-record-change" — which would let an Agent skip `sfoa-record-change` entirely
  and invalidate the integrated UAT before it starts. Only those two facts were
  corrected; no Hard Rule text, no gate marker and no `sfoa-record-change` file
  changed. This deliberately widened the round's diff beyond the expected scope, with
  the reason recorded in the review report.
- **Verified the deployment gap instead of assuming it.** GitHub already had
  Skill-02B, but `/data/openclaw/workspace/skills/sfoa-record-change/` and the
  deployed `app/` tree were still Skill-02A: 7 files, still carrying
  `references/outcomes.md`, `SKILL.md` 9576 B / sha256 `c7354635…`, no UPDATE
  doctrine. Pushed does not mean deployed.
- **Deployed through the existing mechanism only.** Backed up the runtime Skill to
  `/data/openclaw/backups/20260915-095931-skill-02b-delivery/` and the two reachable
  app subtrees (`skills`, `docs`) rather than tarring the 5.6 G app tree that is
  mostly `node_modules` and `dist`. Packaged the commit with
  `git -c core.autocrlf=false -c core.eol=lf archive` (2,446,821 B, 1344 entries,
  sha256 `9cde9760…`, verified pure LF), confirmed the hash on the server, synced
  additively with `rsync -a` without `--delete`, and explicitly `rm`-ed the four
  retired `outcomes.md` copies that a non-deleting sync would otherwise leave behind.
  Republished canonical → runtime with the repo's own
  `manage.mjs runtime-sync --runtime-root /data/openclaw/workspace/skills`.
- **Byte-verified the result.** `diff -r` shows canonical == runtime for both
  business Skills (9 and 9 files); 22/22 doctrine probes hit in the deployed runtime
  copy; no `outcomes.md` anywhere. `manage.mjs validate`/`check` on the deployed tree:
  3 Skills `ok:true`, `drift: []`.
- **Business Agent visibility and maintainer isolation confirmed four ways.**
  `openclaw skills check --agent main` reports `Visible to model: 3` =
  `browser-automation`, `sfoa-crm-core`, `sfoa-record-change`;
  `agents.entries.main.skills` still carries `browser-automation` (array not
  overwritten); `skills.entries` holds exactly the two SFOA Skills, enabled;
  `sfoa-mcp-maintainer` is absent from the workspace directory, from `find`, from
  `skills check` and from the live gateway index, and `runtime-sync --canonical
  skills/sfoa-mcp-maintainer` is refused.
- **Corrected the Skill refresh semantics by measurement.** The 02A entry
  concluded that because the gateway caches the skill index (name + description), a
  description change needs a restart. Measured this round: with `skills.load` and
  `skills.watch` unset and no config change, the **live** gateway
  (`openclaw gateway call skills.status --json`, which answers from the running
  process) already returned the new 151-character description, and a fresh session
  applied the new body and the `TARGET_RESOLVED` gate. **No restart was needed.**
  Note also that `openclaw skills list` reads the workspace directly and emits no
  gateway log line, so it cannot prove what the running process holds, and
  `openclaw gateway restart` refuses under a non-default state dir (the owning unit
  is the system `openclaw-gateway.service`). Restart stays a fallback, never a
  routine step.
- **No service disruption.** `packages/` diff is 0, so nothing was rebuilt and none
  of `sfoa-mcp-server`, `sfoa-admin-api` or `openclaw-gateway` was restarted.
  `MCP Runtime changed: NO`.
- **Not done:** no real WeCom UAT and no Salesforce record was written; the session
  probe explicitly forbade any write tool. Status is
  `SKILL-02 IMPLEMENTATION COMPLETE · DEPLOYMENT COMPLETE · READY FOR INTEGRATED
  HUMAN UAT`, not `Skill-02 COMPLETE`. See
  `SKILL_02B_FINAL_REVIEW_REPORT.md`.

## 2026-09-15 — Skill-02B: UPDATE readiness + Batch mutation + Outcome reconciliation

Extends `sfoa-record-change` from CREATE-only to full record-mutation doctrine
(CREATE + UPDATE, single + batch, result reconciliation). No Runtime, MCP Tool,
Identity Route, WeCom chain, governance, Provider, migration or Salesforce data
change; `git diff main --stat -- packages yarn.lock packages/sfoa-control-plane/migrations
.env.example config integrations` is empty, so no rebuild and no service restart.

- **Audited the live contract before writing any doctrine.** Confirmed from source
  that `get_record_action_context` accepts `action=UPDATE` but rejects
  `draftFields`/`refinement` (`'draftFields and refinement are CREATE-only'`),
  requires `recordId`, refuses a `recordTypeId` that differs from the record's own
  type, returns `defaults: {}`, omits `availableRecordTypes`, and never runs the
  Dynamic Forms resolver (`coverage.dynamicFormsEvaluated` is `false`). Confirmed
  `update_record` is `.strict()` with no `recordTypeId`/`uiContextResolutionId`, and
  that `update_records` is `1..200` same-object with `allOrNone` defaulting to
  `false` and duplicate-target rejection at `MCP_DML_BATCH_DUPLICATE_RECORD_ID`
  (15-char identity, two-layer guard). The Skill respects this contract instead of
  inventing a CREATE-shaped UPDATE.
- **Added `update-readiness.md`** — `TARGET_RESOLVED` as the first gate, 0/1/multiple
  match handling, Target Population completeness (inheriting Core's
  `Claim Scope <= Evidence Scope`), Minimal Patch, `Read Facts != Mutation Intent`,
  the five-way `omitted / null / false / 0 / ""` distinction,
  `CREATE Required != UPDATE Missing Required`, no CREATE-default reapplication, no
  Owner fallback injection, Record Type scope, and the honest statement that
  Dynamic Forms UPDATE cannot be pre-computed.
- **Added `batch-mutations.md`** — per-record readiness with universal
  quantification, clarification before side effects, same-object grouping,
  per-record patches, the 1..200 bound, bounded sequential `>200` planning
  (500 → 200+200+100), no parallel dispatch, `allOrNone` policy, and
  `clientReferenceId` as correlation only — never an idempotency key.
- **Added `outcome-reconciliation.md`** — replaces `outcomes.md`; adds
  `FAILED != UNKNOWN`, read-back limits (`Current State Evidence != Transaction
  Outcome Evidence`), the independent-evidence reconciliation ladder, and the
  stop-later-batches rule.
- **Rewrote `SKILL.md`** — description now routes CREATE *and* UPDATE; hard rules
  23 → 37 with 14 new UPDATE/batch/outcome rules; a CREATE-vs-UPDATE difference
  table; per-operation `CHANGE_READY` summary; explicit out-of-scope list
  (Delete / Upsert / Merge / Metadata 管理 / 业务分析). `readiness-gate.md` now
  carries separate CREATE and UPDATE blocking tables, and `dynamic-forms.md`,
  `managed-lookups.md`, `lookup-and-picklist.md` and `create-readiness.md` gained
  their UPDATE boundaries.
- **Added `scripts/record-change-gates.mjs`** — an executable decision model so the
  gate asserts behaviour, not just doctrine text. It carries no Salesforce truth
  (no object names, Record Type IDs, Picklist values or field API names) and is a
  test oracle, never a Runtime component.
- **Machine gate 32 → 63 tests.** 14 UPDATE, 7 batch, 4 outcome and 4 CREATE
  regression tests added, including one that reads the shipped context and DML
  schemas to prove the CREATE-only inputs stay rejected on UPDATE. `yarn skill:test`
  63/63 pass; `skill:validate`/`skill:check`/`skill:delivery` all `ok:true` with
  `drift: []`, `untracked: []` and package completeness verified. CREATE regression
  PASS.
- **Runtime copy re-verified, not just re-generated.** Rehearsed the repo's own
  mechanism: `runtime-sync` publishes exactly `sfoa-crm-core` (9) +
  `sfoa-record-change` (9) = 18 files, `runtime-check` reports `drift: []` for both,
  and `runtime-sync --canonical skills/sfoa-mcp-maintainer` is refused with
  `No canonical Skill matches the business runtime allowlist`. No second sync
  system was introduced.
- **Not done:** no real WeCom UAT and no Salesforce record was written. The server
  publish to `/data/openclaw/workspace/skills/sfoa-record-change/` could not be
  performed from this workstation (no key-based SSH to `192.168.156.203`); the
  documented steps are in the implementation report §11. Status is
  `SKILL-02 IMPLEMENTATION COMPLETE — READY FOR INTEGRATED HUMAN UAT`, not
  `Skill-02 COMPLETE`. See `SKILL_02B_IMPLEMENTATION_REPORT.md` and
  `SKILL_02_INTEGRATED_HUMAN_UAT.md`.

## 2026-09-14 — Test server deployed at the Skill-02A tip; `main` fast-forwarded; LF archiving defect fixed

Deployed `hotfix/openclaw-sfoa-record-change-02a-delivery` @ `345b739` to the test
server and fast-forwarded `main` onto it. No Runtime, MCP Tool, Identity Route,
WeCom chain, governance, Provider or migration change; `packages/`, `yarn.lock`,
migrations and `.env.example` are byte-identical to the previously deployed
`3e19d9a`, so no rebuild and no service restart were performed.

- **Found and fixed a latent deployment-procedure defect.** The documented
  packaging command `git archive ... <sha>` re-applies `core.autocrlf`; on this
  Windows checkout (`core.autocrlf=true`) it rewrote every text file to CRLF, so
  the archive was **not** equivalent to the repository bytes. Measured on
  `skills/sfoa-record-change/SKILL.md`: 9576 B (LF, = git blob = OpenClaw runtime
  copy) versus 9643 B (CRLF) from a plain `git archive`. The old procedure is
  therefore why the deployed `skills/` tree carried CRLF. Corrected to
  `git -c core.autocrlf=false -c core.eol=lf archive`, documented in
  `TEST_SERVER_DEPLOYMENT.md` §3.1, and the whole deployed tree was re-synced to
  LF. This is a **false-drift source**: CRLF canonical makes `skill:runtime:check`
  report every file as drifted even though the Skill text is identical.
- **Verified the deployment byte-for-byte, not by inspection.** Built a SHA-256
  manifest of all 1102 tracked blobs at `345b739` and ran `sha256sum -c` against
  `/data/sfoa-enterprise-mcp/app`: 1102 OK, 0 FAILED, 0 MISSING. Also confirmed
  16/16 Skill files byte-identical to `/data/openclaw/workspace/skills/`
  (`skill:check` and `skill:runtime:check` both `drift: []`), and the machine gate
  `toolkit.test.mjs` at 32/32 both locally and on the deployed tree.
- **Deployed additively.** Used `rsync -a` without `--delete` from a staging
  extract, so server-only files survive: `.env.local`, `.idea`, `projects`,
  `.temp`, `.workbuddy`, `.codegraph/codegraph.db*`, `.claude/settings.local.json`,
  `node_modules` and every package `dist`. Procedure written up as §3.5.
- **`main` fast-forwarded** from `25a15ce` to `345b739` (0 commits on `main` the
  branch lacked, so no merge commit). This also brings the OpenClaw test-server
  baseline, WeCom→SFOA integration, concurrency/web-intelligence, multimodal and
  Skill-01/02A work onto `main`. Agent visibility unchanged:
  `agents.entries.main.skills` = `sfoa-crm-core`, `browser-automation`,
  `sfoa-record-change`; `sfoa-mcp-maintainer` remains outside the business
  workspace.
- **Not done:** no real WeCom UAT, and no Salesforce record was created. Status
  stays `READY FOR HUMAN UAT`, not `LIVE UAT PASSED`.

## 2026-09-14 — Skill-02A closure review: runtime drift fix, routing evidence, refresh semantics

Independent re-verification of the HOTFIX01 delivery against live server state and
runtime evidence. No Skill doctrine, Runtime, MCP Tool, Identity Route, WeCom
chain, governance, Provider or migration change; `packages/` diff is 0.

- **Fixed a runtime-copy drift that HOTFIX01 left behind.** File-by-file
  comparison of canonical against `/data/openclaw/workspace/skills/` showed
  `sfoa-crm-core/references/mutation-boundaries.md` out of sync: the deployed copy
  still told the Agent that `sfoa-record-change` "该 Skill 当前未实现", while
  canonical had already replaced that with the readiness-gate handoff. HOTFIX01
  redeployed only `sfoa-record-change` and never republished the `sfoa-crm-core`
  file changed by `0a006a3`, so one Agent turn could read two contradictory
  statements. Republished the runtime copy through the repo's own mechanism
  (`runtime-sync` restaged, then a directory publish — never `cp -r skills/*`),
  after backing up to `/data/openclaw/backups/20260914-skill-02a-crm-core-drift-fix/`.
  All 16 files are now byte-identical to canonical.
- **Executed the routing smoke that HOTFIX01 left open, with transcript
  evidence.** OpenClaw 2026.9.3 logs no per-turn skill injection (only config
  reloads; `skills curator status` has no usage records), so routing was proven
  from `openclaw agent --json`'s `systemPromptReport` plus the session
  transcript instead of from model replies. The model-visible skill index is
  exactly three entries (browser-automation, sfoa-crm-core, sfoa-record-change).
  "帮我创建一个 Salesforce 客户拜访申请" read both `sfoa-crm-core/SKILL.md` and
  `sfoa-record-change/SKILL.md`; "帮我查询今天的客户拜访" read only
  `sfoa-crm-core/SKILL.md`. The CLI turn exposes no SFOA MCP tools, so no
  Salesforce write was reachable on this path.
- **Recorded the session-refresh semantics.** With `skills.load` unset, a
  republished Skill body is picked up by a new session without a gateway restart
  (verified: the new canonical text was read, the retired text was not). Only the
  gateway's skill index (name + description) is cached, so a restart is required
  for a new Skill or a description change — not for a body change.
- **Confirmed the gate entry point, correcting an initial misreading.**
  `yarn skill:runtime:check` exits 0 on a clean copy, 1 with
  `drift=["references/outcomes.md: differs"]` on a mutated one, and 1 with an
  explicit refusal when `--runtime-root` is omitted. Requiring the root is
  deliberate — the OpenClaw workspace must never be guessed — and yarn forwards
  the documented parameter correctly, so this is not a defect.
- **Pushed the HOTFIX branch.** GitHub became reachable again during this round,
  so `hotfix/openclaw-sfoa-record-change-02a-delivery` is now on `origin`
  (`007cde8`). The HOTFIX01 push failure was an environment network interruption,
  not a change-related one.

## 2026-09-14 — Skill-02A HOTFIX01 delivery and runtime deployment closure

- Shorten the `sfoa-record-change` frontmatter description from 248 to 153
  characters on one line, keeping every routing signal (Salesforce, CREATE,
  Record Type, Dynamic Forms, required fields, Lookup/Picklist, Owner fallback,
  `sfoa-crm-core`, the create/apply trigger and the pure-read exclusion).
- Close the 02A/02B boundary: keep the CREATE batch safety floor (1..200,
  per-record readiness, no full replay after PARTIAL_SUCCESS, no CREATE replay
  after OUTCOME_UNKNOWN, no silent partial execution) and remove the >200 finite
  plan, `allOrNone` strategy and full outcome recovery from the 02A doctrine. The
  Skill now states its CREATE-only scope and forbids applying the CREATE form to
  UPDATE. The last company field name (`Source__c`) is removed so no company field
  rule remains in the Skill.
- Add `runtime-sync` / `runtime-check` to the maintainer toolkit and
  `yarn skill:runtime:sync` / `skill:runtime:check`: canonical → runtime only,
  driven by an explicit `BUSINESS_SKILL_ALLOWLIST`, refusing symbolic links,
  version-control metadata, credentials and executable scripts, and comparing
  recursive SHA-256 maps. `sfoa-mcp-maintainer` can never reach a business
  workspace, and a new business Skill requires an explicit allowlist entry.
- Extend the machine gate from 28 to 32 tests: description length and routing
  signals, retired-Tool and company-identifier guards, allowlist consistency, and
  runtime-copy isolation with drift detection. Skill-01 regression is unchanged.
- Deploy the runtime copy to `/data/openclaw/workspace/skills/sfoa-record-change/`
  (7 files, root-only backup at `/data/openclaw/backups/20260914-155313-skill-02a-delivery`),
  enable it in `skills.entries` and add it to `agents.entries.main.skills` while
  preserving `sfoa-crm-core` and `browser-automation`. All 7 server SHA-256 values
  match canonical; config validates; the Gateway restarted and WeCom
  re-authenticated. `openclaw skills check --agent main` reports exactly three
  model-visible Skills, and `sfoa-mcp-maintainer` is neither eligible nor visible.
- Document the OpenClaw business Skill entry point in `README.md` and the runtime
  deployment procedure in the maintainer Skill.
- No MCP Runtime, Identity Route, WeCom chain, governance, Provider, migration or
  Salesforce data change. The routing smoke was not executed; it is left to the
  human WeCom UAT.

## 2026-09-14 — Skill-02A `sfoa-record-change` (Readiness Kernel + CREATE)

- Add the second OpenClaw business Skill as canonical `skills/sfoa-record-change/`
  (short `SKILL.md` with 23 hard rules plus six references: readiness gate, CREATE
  readiness, Dynamic Forms, managed lookups, lookup/picklist, outcomes). It declares
  inheritance of every `sfoa-crm-core` hard rule and adds only the
  evidence-based `CHANGE_READY` mutation-readiness doctrine.
- The Skill is doctrine, not a workflow engine: it defines how to discover facts,
  how to verify them, what blocks a write and when evidence is sufficient. No new
  MCP Tool, no DB state, no Ready Token, no transaction state table, no workflow
  state machine, and no Runtime change.
- Core CREATE rules grounded in current code: `recordTypeSelectionRequired` and
  `availableRecordTypes` hard gate, `draftFields` + `refinement` 0..3 with
  `refinementLimitReached`, the four-state Dynamic Forms semantics
  (`VISIBLE`/`HIDDEN`/`PENDING`/`UNKNOWN`), Missing Required Checklist from
  `apiRequired` / `layoutRequired` / `effectiveRequired` / `requiredSource`,
  `PLATFORM_IDENTITY_FALLBACK` explicit-wins and omit-to-fallback, Lookup 0/1/multiple
  handling, Label-to-API-Value Picklist resolution, evidence truncation and
  `PARTIAL_SUCCESS` / `OUTCOME_UNKNOWN` no-replay safety.
- Extend the maintainer toolkit gate with 9 new tests: a label/content marker
  contract for all 23 readiness rules, per-reference content contracts, the abstract
  真人 UAT regression case (VISIBLE+effectiveRequired gap, `dependsOn` refinement,
  explicit owner over fallback), a no-hardcoding guard (no Salesforce ID literal, no
  frozen `RecordTypeId`/`DeveloperName`), and a business-suite separation gate proving
  no business Skill carries maintainer scripts or names the maintainer Skill.
- Update `sfoa-crm-core/references/mutation-boundaries.md` so the CREATE required-field
  and READY gate hand-off points at the now-existing professional Skill instead of
  describing it as unimplemented. No Core hard rule changed.
- MCP Runtime, Identity Route, WeCom identity chain, Tool/DML governance, official
  Provider code, migrations and Salesforce data are unchanged. Delivery stops at
  READY FOR HUMAN UAT; UPDATE readiness, complete batch grouping and full outcome
  reconciliation remain Skill-02B.

## 2026-09-06 — P8-04 effective CREATE implementation for UAT

- AMEND-006 moves independent New UI/Agent accuracy gates after implementation.
- Preserve Page Layout calculations; add request USER/Profile/RT/App-aware Dynamic
  Forms CREATE, four-state visibility, FLS/managed intersection and bounded drafts.
- Migration 012 adds one current-only snapshot table and a P7 UI_CONTEXT payload
  category. Reuse existing settings for exact per-object OFF/SHADOW/ENFORCE; default OFF.
- Add bounded independent DIAGNOSTIC Admin refresh, a thin policy/status page,
  on-demand Audit field evidence and optional context-to-CREATE provenance.
- Canonical Playbook 1.6.0 and generated clients teach effective field collection
  and at most three refinements. Existing managed Lookup fallback is preserved.
- Delivery stops at READY_FOR_UAT_WITH_LIMITATIONS; actual UI/Agent accuracy,
  service startup and selected live-object enablement remain Maintainer UAT work.

## 2026-09-06 — P8-04 baseline and A-01 feasibility entry (historical)

- Freeze a 12-task CREATE-only Dynamic Forms plan with exact Page Layout preservation,
  request USER authority, four-state uncertainty, P7 reuse and all accuracy gates.
- Source is managed-platform-user-lookup-fallback at `f60a134715d639b8129af0f3160549d52dec210d`;
  this delivery stops at read-only SFoA feasibility. No production behavior changes.
- A-01 COMPLETE — BLOCKED: verified v67 SOAP USER ProfileId, USER App inventory,
  six relevant pages, assignment shapes, Layout ID/name matches and Metadata costs;
  independent New UI precedence and mandatory same-RT/different-USER golden remain
  unverified. Three evidence-backed baseline amendments; no A-02 or ENFORCE.

## 2026-09-05 — Managed Lookup fallback HOTFIX01

- Restrict fallback to CREATE in Admin validation/UI, Runtime, and forward-only migration 011; preserve 010 checksums and user deployment history. Ordinary UPDATE never defaults omitted fallback fields.
- Reject duplicate client casing aliases before any lookup and align Action Context object matching with Runtime. Playbook 1.5.1 preserves explicit Lookup updates through the normal workflow.

## 2026-09-05 — User-overridable managed platform Lookup fallback

- Added opt-in PLATFORM_USER_LOOKUP_FALLBACK across Control Plane, Runtime, Admin, safe capabilities, and Playbook 1.5.0. Explicit keys preserve user values and skip default lookup; omission reuses the existing resolver. Strict Lookup and AI marker remain server-forced.
- Migration 010 extends existing ENUM/CHECK without changing configured rules. No identity, permission, Tool governance, DML allowlist, or official Provider changes.
- Added runtime, audit, Action Context, generated-contract, Admin, and MySQL migration regressions; see P6_DML_01_MANAGED_FIELDS.md.

## 2026-09-03 — MCP transport-probe classification and self-describing MCP_REQUEST_INVALID audits

- Diagnosed recurring `MCP_REQUEST_INVALID` ERROR rows as benign Streamable HTTP capability negotiation: each round, WorkBuddy/undici clients issue a non-POST probe against the POST-only `/mcp` endpoint (typically `GET /mcp` → 405), and every probe was previously persisted as an all-null ERROR audit row.
- MCP method probes (HTTP 405 raised by `assertMethod` for a non-POST method against the POST/GET-only endpoint) now respond 405 as before but no longer persist an `MCP_REQUEST_INVALID` audit row; the probe stays observable at the transport edge (reverse-proxy access log) and in the new `methodProbes` `RemoteMcpServerMetrics` counter.
- Genuine malformed-request terminal outcomes (unknown endpoint 404, non-JSON Content-Type 415, invalid/empty body 400, bad Content-Length) remain audited as `MCP_REQUEST_INVALID` but are now self-describing: they persist a pre-redacted short `error_message_safe` plus a bounded `request_summary_json` (method, path, HTTP version, content-type, client source) instead of null metadata.
- Added optional `errorMessageSafe` to the `RuntimeLogEvent` contract and carried it through every `DatabaseRuntimeLogger` persistence path (`createCall`, direct `append`, and the async/legacy `toAuditWrite`) so the pre-redacted safe message reaches the durable `error_message_safe` column.
- Added mcp-server and control-plane tests; the full `@sfoa/mcp-server` suite passes 88/88 and `@sfoa/control-plane` runtime-logger tests pass. No official Salesforce TypeScript file, migration, dependency, or lockfile change.

## 2026-09-03 — Admin identity routes: 用户名称 field, remark column, batch add, and auto-verification

- Added the required human-readable `user_name` (用户名称) display field to Admin identity routes and surfaced the previously stored optional `remark` (备注) as a table column, in the route search keyword scope, and in the Admin Web create/edit form. `user_name` is display metadata only; it never selects a Salesforce identity or appears in Audit identity fields.
- Added migration `009_identity_route_user_name.sql` (`user_name VARCHAR(128) NOT NULL AFTER platform_user_id`, existing rows backfilled to their `platform_user_id`), the runtime fail-closed `REQUIRED_COLUMNS` check, repository keyword search, and the MySQL schema snapshot.
- Added an Admin batch-import wizard: paste Excel/text rows (tab/comma/semicolon auto-detected; official 4-column `用户名称 / 平台用户 / Salesforce Username / 备注` header or positional 2/3/4-column fallback), review an editable per-row grid with in-batch and existing-route duplicate checks, then save up to 200 routes. Save is all-or-nothing and each accepted route atomically creates its USER_BOUND credential and Admin audit; batch responses never return plaintext tokens.
- Newly created identity routes automatically trigger Salesforce connectivity validation (single create runs it after the credential drawer closes; batch runs a bounded per-route verify). Verification results stay transient (no status column) and a per-row 验证 action remains for re-checks. Single edits re-verify only when the Salesforce Username changes.
- Added control-plane/admin-api batch contracts and endpoints (`POST /admin/api/routes/batch`, `POST /admin/api/routes/batch-verify`) with per-row results, raised the Admin JSON body bound for 200-row payloads, and added engineering Gates. No official Salesforce TypeScript file, dependency, lockfile, or business Tool surface changed.

## 2026-09-03 — P7-E2E Agent-Playbook read-scope clarification (1.2.0)

- Advanced the canonical Playbook to `1.2.0` so Agents never conflate the CREATE/UPDATE DML allowlist with read scope. `run_soql_query` may read any object the authenticated Salesforce user can read — Account, Opportunity, Contact, and custom objects included — even when that object is absent from the CREATE/UPDATE lists; those lists govern only `create_record` and `update_record`, never reads, and the sole read-side guard is the ORG_OBJECT_USAGE substitution rule (`MCP_SOBJECT_NOT_IN_USE`).
- Added the READ-scope statement both to the rendered Runtime-capabilities block and to the READ workflow rules so every surface carries it: full `sfoa://agent-playbook/current` Resource, `sfoa_salesforce_assistant` Prompt, `get_agent_playbook` fallback, generated Dify/WorkBuddy/Skill artifacts, and Admin preview.
- Updated source-contract tests across `@sfoa/agent-playbook`, `@sfoa/mcp-server`, and `@sfoa/admin-web` to the new version and asserted the read-scope wording; reran `yarn agent:sync`, `yarn agent:check`, and `yarn skill:check`. No official Salesforce TypeScript, migration, dependency, or lockfile change.

## 2026-09-01 — P7-08 HOTFIX02 command-entrypoint and reproducibility closure

- Verified the root `package.json` still carries every documented `skill:*` and `ai:*` entrypoint; none were lost.
- Hardened the clean-checkout `smoke` gate to rebuild its temporary checkout from committed `HEAD` bytes via `git archive` instead of copying working-tree files, so a dirty working tree can no longer be reported as a clean commit.
- Synced the P7-08 section of `P7_END_TO_END_AUDIT_BASELINE.md` with the approved Agent-native direction (advisory Skill, read-only local diagnostics, no business MCP Tool, `.env.local` internal-only).

## 2026-09-01 — P7-08 Agent-Native Maintainer Skill and Diagnostic Toolkit

- Added the advisory canonical `skills/sfoa-mcp-maintainer` with progressive references for architecture, repository/runtime flow, development, testing, operations, troubleshooting, database/Audit, acceptance diagnosis, and durable self-maintenance.
- Added generated project copies for Codex, Claude Code, and WorkBuddy/CodeBuddy plus dependency-free Windows Node validation, byte-identical sync/check, and disposable ZIP packaging.
- Added secret-safe Project Snapshot/Doctor, named read-only MySQL inspection, and a real migration-008 Audit Analyzer. Unsupported trace/session/call/span fields remain explicit; current route/governance is labeled contextual, Payload bodies are omitted, and token/identity output is redacted or masked.
- Added ADR-0017 and changed the P7-08 architecture from a public diagnostic MCP interface to a local developer/maintainer toolkit. No runtime package, migration, Salesforce call, public Tool, or production authorization surface was added.

## 2026-09-01 — P7-06 MCP request, response, and payload evidence implemented

- Reused the single bounded HTTP body read to persist typed `MCP_REQUEST` evidence before Identity, including real JSON-RPC Tool arguments without rereading or changing the request stream.
- Added a request-local bounded `ServerResponse` recorder for actual MCP wire bytes and `finish`/early `close`/write-failure facts while preserving Node return values, backpressure, response timing, and the separate logical Tool `responseSummary`. `finish` never claims client receipt.
- Extended the existing P7-04 JSforce adapter to capture non-GET request bodies and only the final safely available `HttpResponse.body`; no Salesforce response stream listener was added, OAuth payloads remain absent, and retry bodies bind only to the provable attempt.
- Activated the P7-01 Payload Evidence Snapshot contract with 256 KiB/item, 64 items/Audit, 1 MiB/Audit, MCP/error reservations, nullable unknown original size, exact UTF-8 stored size, background persisted-prefix SHA-256, and secret-safe fail-open capture.
- Extended the existing P7-03 transaction Writer to resolve Event sequence and Salesforce `publicApiCallId` within the same Audit before inserting Payload rows. Added migration 008 and explicit on-demand repository reads; ordinary Audit list/count queries and React AuditPage remain unchanged.
- Added success/identity/governance/error/timeout/disconnect/DML UNKNOWN, OAuth/retry/validation, 2 MiB, Queue Full/5s DB, 50/100/200 HTTP/MySQL isolation, wrong-binding/orphan, and paired small/large performance Gates. Added Salesforce API calls, synchronous Audit DB awaits, official Salesforce TypeScript edits, dependencies, P7-07 UI, and P7-08 diagnostics are all zero.

## 2026-08-31 — P7-05 SOQL and DML Audit Evidence implemented

- Added a nested, parallel-safe Salesforce semantic scope to the existing Request Audit AsyncLocalStorage store. High-level code supplies semantics only; the P7-04 wire adapter remains the sole Salesforce API row authority and binds evidence by exact `publicApiCallId`.
- Added readable bounded Data/Tooling SOQL, deterministic top-level object extraction, URL-decoded fallback, parsed Query counts/pagination flags, and failure-versus-zero-row semantics without reparsing or cloning response bodies.
- Added CREATE/UPDATE requested, actual managed, and exact submitted field evidence plus Salesforce result record IDs while preserving validation failures and `MCP_DML_OUTCOME_UNKNOWN` no-retry behavior.
- Added migration 007 for `has_next_records` and `submitted_fields_json`, and carried all semantic fields through the existing non-blocking P7-03 Queue/Writer/Batch Sink and repository contracts.
- Added nested lookup, parallel query, interleaved multi-Audit, 2,000-record, 100-field, long-SOQL, encoder-failure, DML validation/transport-unknown, MySQL, 50/100/200 isolation, and paired performance Gates. No official Salesforce TypeScript file, dependency, lockfile, MCP payload capture, Admin UI, or extra Salesforce API call was added.

## 2026-08-30 — P7-01 startup recovery and Buntu audit opt-in

- Added fail-closed recovery for the MySQL implicit-commit edge case where every migration 005 DDL object exists but its ledger row was not recorded. Recovery validates the complete required schema, indexes, and named constraints before recording the unchanged repository checksum; partial schemas still fail.
- Restored `MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED=true` as an explicit, default-off troubleshooting option. Only `BUNTU_TOKEN_VALIDATE` durable MySQL audit writes may carry `requestSummary.rawToken`; generic Runtime logs, HTTP errors, fallback logs, other identities/operations, and all other secret classes remain sanitized.
- Restored the authenticated Admin Audit detail warning/display for an opt-in raw Buntu token and added ADR-0016 plus regression coverage. P7-02 remains unstarted.

## 2026-08-29 — P7-01 end-to-end Audit data model implemented

- Established `P7_END_TO_END_AUDIT_BASELINE.md` as the authoritative P7-01 through P7-08 plan and added ADR-0015. P7-02 request context, asynchronous pipeline, Salesforce/MCP instrumentation, Workbench, and diagnostic Skill remain unstarted.
- Evolved the existing `sfoa_audit_log` ledger additively with public Audit UUID, fact-based kind, optional time bounds, safe error, and integrity state. Historical Tool-named flat events remain `RUNTIME_EVENT`; only explicit `createCall()` records claim one MCP Tool invocation.
- Added ordered `sfoa_audit_event`, typed `sfoa_salesforce_api_call` with SOQL/CREATE/UPDATE evidence, and bounded `sfoa_audit_payload_evidence` with same-Audit composite foreign keys and master-driven cascade retention semantics.
- Split the cohesive MySQL Audit implementation out of `mysql-repositories.ts`, retained the compatible `audits` interface, and added the `auditTraces` contract without changing the current Admin Audit API/UI flow.
- Added centralized recursive persistence sanitization, 16 KiB safe summaries, 256 KiB Payload Evidence, sanitized-content hashing, and UI defense in depth. At this historical revision raw Buntu token auditing was prohibited and migration 005 scrubbed the known historical field; ADR-0016 later supersedes only that blanket prohibition.
- Made the Admin Web project Gate use its already-proven 60-second bounded Vitest timeout; the former 30-second limit repeatedly expired in unchanged Ant Design/jsdom governance flows on this Windows host while the same assertions passed under the documented diagnostic bound.
- Fixed MySQL migration advisory locks to keep acquisition, DDL, metadata, validation, and release on one pinned pooled connection. Checksum calculation now records Git-LF canonical SQL and accepts only LF/CRLF-equivalent historical digests, without editing migrations or metadata. Empty/P6 upgrade, repeated/concurrent migration, legacy read, public ID, sequence, DML/SOQL, cross-Audit FK, CASCADE, payload/list isolation, secret, and Runtime fail-open regressions were added.
- Modified zero official Salesforce TypeScript files and added no dependency or lockfile change. Passing engineering Gates advances only to `IMPLEMENTED / AWAITING MAINTAINER REVIEW`, never whole-P7 completion.

## 2026-08-27 — P6-DML-01 trusted managed fields and explicit record-link origin completed

- Added one constrained `sfoa_dml_managed_field_rule` child model under the existing object DML policy, with parent-plus-target uniqueness, optimistic locking, durable Admin audit, and only `PLATFORM_USER_LOOKUP` plus CREATE-only `AI_CREATED_MARKER=true`. No business object/field/value seed, generic default engine, `CONSTANT`, metadata sync, or duplicated target object was added.
- Added request-scoped host resolution after the existing object/operation allowlist and before generic CREATE/UPDATE dispatch. Platform Lookup uses immutable authenticated `platformUserId`, the same USER Connection, exact-one bounded query, no cache, safe audit, case-insensitive server-wins semantics, and four stable fail-closed error codes.
- Closed the pre-dispatch timeout race: a slow managed Lookup that settles after the Tool deadline cannot dispatch a late mutation. Pre-dispatch failures are `FAILED`; only the existing public-SDK post-dispatch boundary can produce `MCP_DML_OUTCOME_UNKNOWN`.
- Advanced canonical Playbook to `1.1.0` and synchronized MCP Instructions/Resources/Prompt/Tool fallback, Action Context, generated Dify/WorkBuddy/Skill artifacts, Admin preview, and source-contract tests so Agents never request, recommend, send, override, derive, or guess managed values.
- Added Simplified-Chinese per-policy managed-rule UI with adaptive strategy forms, immediate API-name/duplicate/parent-operation validation, row-version conflict handling, disable/delete actions, mocked browser coverage, and retained screenshot evidence.
- Changed `get_record_links` to use only explicit credential-free HTTPS origin `SFOA_LIGHTNING_BASE_URL`. Missing configuration returns `MCP_RECORD_LINK_BASE_URL_NOT_CONFIGURED`; `Connection.instanceUrl`, Agent/client input, and guessed domains are not fallbacks.
- Added ADR-0014 and P6-DML-01 design/report records. Official Salesforce Provider/Tool TypeScript modifications remain zero; live Salesforce USER A/USER B/record-link runs remain explicitly `PENDING MAINTAINER` until executed with real credentials.

## 2026-08-26 — P6-Agent-01 canonical MCP-native Agent Playbook completed

- Added pure strict-TypeScript `@sfoa/agent-playbook` with Playbook version `1.0.0`, ten canonical sections, six workflow selectors, safe capability facts, and deterministic Server/Dify/WorkBuddy renderers.
- Added concise initialize Server Instructions, full `sfoa://agent-playbook/current` and request-scoped `sfoa://agent-capabilities/current` Resources, workflow Prompt `sfoa_salesforce_assistant`, and governed `get_agent_playbook` Tool fallback through the existing MCP SDK 1.18.2 public APIs.
- Added governed read-only `get_record_links`, bounded to 50 validated descriptors. It derives Lightning URLs only from the current request Connection's credential-free Salesforce origin and performs zero Salesforce API calls; clients cannot supply a host/base URL.
- Added deterministic `yarn agent:sync` / `yarn agent:check` generation for Dify instructions, WorkBuddy System Prompt, and the progressive-disclosure Skill; drift tests intentionally edit a fixture and prove nonzero check failure.
- Rebuilt Admin Agent Integration around MCP access, Playbook status, 小犇/Dify Buntu setup, WorkBuddy USER_BOUND setup, and MCP-native discovery. Removed stale shared-token/platform-Header guidance from Dify and WorkBuddy while retaining it for Internal/Inspector.
- Added Agent package, protocol, A/B policy-isolation, link injection/zero-API, Admin catalog, generator, identity-copy, generated-artifact, and UI source-contract regressions. Dynamic Forms evidence is explicitly `NOT_AVAILABLE`; no form engine or Salesforce permission replica was added.
- Added ADR-0013, design/implementation/report documentation, Dify/WorkBuddy setup guides, and updated baseline/architecture/test/upstream records. No official Salesforce TypeScript or Tool implementation is modified; no database migration or dependency upgrade is introduced.

## 2026-08-24 — P6-Entry OPT01 completed

- Converted all ordinary Admin Console navigation, page, form, state, validation, feedback, empty/loading, and error presentation to Simplified Chinese while preserving Salesforce/SFoA/MCP/API/Tool names, Error Codes, raw enums, JSON, REST, database, and MCP contracts. Applied the official Ant Design `zh_CN` locale and `zh-CN` date formatting.
- Added the presentation-only **智能体接入** route with safe Runtime configuration state, same-host/LAN/TLS guidance, temporary external URL examples, controlled `X-Platform-User-Id` warnings, Dify/WorkBuddy connector steps, and no secret or URL persistence.
- Added a deterministic Dify instruction generator driven by the current executable Tool catalog, database Tool state, DML object policy, and verified Diagnostic state. Unknown Tools are ignored and every exposed mutation Tool retains the `MCP_DML_OUTCOME_UNKNOWN` no-retry rule.
- Added the static Dify baseline, concise WorkBuddy System Prompt, and progressive-disclosure `.codebuddy/skills/sfoa-salesforce-assistant/` Skill with workflow/safety references. No prompt/Skill MCP Tool was added.
- Removed nested Yarn/Corepack calls from SFoA Gate scripts and made `validate:p5` invoke only project-local toolchain entry points; production code and dependencies are unchanged.
- Final evidence: Admin Web build and 32/32 tests, Admin API build and 12/12 tests, MCP Server build and 18/18 tests, mocked browser 1/1, real MySQL full-stack browser 1/1, and `yarn validate:p5` exit 0 in 709.65 seconds.
- Result: `P6-ENTRY OPT01 = PASS`; `P6 REAL-AGENT EVALUATION = READY`. Database migration, MCP protocol rename, Salesforce/MCP Runtime behavior change, and exposed secrets are all zero/none.

## 2026-08-24 — P5 Maintainer final acceptance and P6-Entry OPT01 authorization

- Recorded Maintainer final acceptance of the completed P5 Control Plane and its independent live Diagnostic closure.
- Authorized only P6-Entry OPT01: Admin zh-CN presentation, MCP connectivity guidance, deterministic Dify instructions, and the WorkBuddy Salesforce Skill.
- Kept P6 Real-Agent Evaluation unstarted until the OPT01 Gate passes. No P0–P5 evidence, Salesforce Runtime behavior, MCP Tool contract, database schema, or historical report was rewritten.

## 2026-08-24 — P5 local startup and sign-in reliability follow-up

- Reproduced the Windows `yarn p5:dev` failure as intermittent `Access is denied` / `spawn EPERM` while Yarn/Corepack, TypeScript, Vite, and esbuild process trees overlapped. The standalone services themselves remained healthy when started separately.
- Changed only the SFoA local launcher: backend compilation is sequential through each workspace's project-local TypeScript compiler; MCP and Admin API must become healthy/ready before Vite starts; the Vite proxy target comes from the resolved Admin configuration.
- Added fail-fast checks for occupied `8080`, `8081`, and `5173`, preserved nonzero startup failures, and added Windows child-process-tree cleanup so a failed peer cannot leave a misleading partial stack.
- Confirmed direct and Vite-proxied Admin readiness and a structured `MCP_ADMIN_AUTH_INVALID` response through the real API. The React login page now distinguishes an authentication rejection from an unreachable/empty development proxy response and gives an actionable readiness message.
- Added regression coverage for both structured invalid credentials and an empty proxy failure. No authentication rule, MCP Tool contract, database schema, Salesforce execution boundary, P5 acceptance status, or P6 scope changed.

## 2026-08-24 — P4/P5 final live closure completed

### Independent Salesforce Diagnostic closure

- Configured one real DIAGNOSTIC integration user that is case-insensitively distinct from both active USER routes. The exact identifier and all authentication material remain outside Git.
- Used the real authenticated Admin API, Origin/CSRF protections, MySQL Control Plane, P4 DIAGNOSTIC request scope, fresh JWT Connection, Tooling API, official `retrieve_metadata`, bounded metadata context, CWD restoration, and exact workspace cleanup. No mock or USER fallback was used.
- Persisted and queried correlated runtime audit proving a triggering `platformUserId`, the fixed Diagnostic username, `executionRole=DIAGNOSTIC`, official Tooling SOQL, and official metadata execution. Admin configuration/verification audit also persisted transactionally.
- Confirmed `run_soql_query`, `create_record`, `update_record`, and `get_record_action_context` remain USER-role Tools. Real USER A/B route verification and record-action context both passed with distinct identities and fresh Connections.

### Final validation

- `yarn workspace @sfoa/mcp-server validate:p4` exited 0 with `overall=PASS`: USER A/B context, identity isolation, Diagnostic Tooling, official metadata, bounds, and cleanup all passed against Salesforce API 67.0.
- `yarn validate:p5` then exited 0 in 463.41 seconds: five changed-code lints, Control Plane 12/12, MySQL 5/5 with zero skipped, Identity 27/27, MCP P5 5/5, Admin API 12/12, React 8/8/build, mocked browser 1/1, and real full-stack browser 1/1.
- Reconfirmed MySQL 8.0.30 application database `sfoa_enterprise_mcp`, isolated automated-test database `sfoa_enterprise_mcp_test`, seven reviewed tables, and both applied migration versions. Production does not require the test schema unless integration tests are deliberately run there.
- Added `P5_FINAL_ACCEPTANCE_CLOSURE.md` and finalized the loopback/static-Nginx/HTTPS-443 deployment contract without rewriting the historical PARTIAL reports.

### Result

`P4 = FINAL ACCEPTED`; `P5 = PASS / COMPLETE — AWAITING MAINTAINER REVIEW`; `P6 ENTRY GATE = READY`. P5 is not declared Maintainer-final-accepted, is not merged, and P6 implementation has not started.

## 2026-08-24 — P5-Closure HOTFIX01 completed with PARTIAL result

### Local database and repeatable startup

- Provisioned real local MySQL 8.0.30 databases `sfoa_enterprise_mcp` and `sfoa_enterprise_mcp_test` with isolated application grants. No credential was written to Git or acceptance evidence.
- Ran `db:create`, versioned migration, schema/checksum status, and non-force bootstrap. Both `001_p5_control_plane` and `002_p5_indexes` are applied; all seven tables and required indexes/constraints exist.
- Proved bootstrap conflict rejection, idempotence, and administrator-state preservation. The current USER-alias Diagnostic seed was rejected case-insensitively; no invalid Diagnostic row was created.
- Added one minimal `resolveSfoaProjectRoot(import.meta.url)` helper shared by MCP, Admin API, database CLI, and bootstrap. Root/package-CWD tests and compiled package-CWD launches prove all entry points load repository-root `.env.local` without a `process.cwd()` contract.
- Corrected mysql2 JSON decoding by requesting JSON strings at the driver boundary, retaining strict repository parsing instead of accepting ambiguous external objects.

### Runtime, Admin, and browser closure

- Added a real Streamable HTTP/MySQL runtime integration Gate for database A/B routing, missing/disabled/shared routes, dynamic Tool and independent CREATE/UPDATE policy changes, DELETE/UPSERT absence, unknown Tool fail-closed behavior, durable audit, request-scoped Connections, and real database-outage fail-closed behavior.
- Added deterministic mutation regressions proving audit append failure cannot turn a successful Salesforce CREATE into failure, trigger retry, or overwrite `MCP_DML_OUTCOME_UNKNOWN`; audit health degrades and redacted fallback logging runs.
- Added a non-mocked Playwright Gate and standard root command `p5:e2e:fullstack`: real browser, Vite proxy, real Admin API, and `sfoa_enterprise_mcp_test`, with direct database assertions for route create/edit, Tool toggle, DML policy, Admin audit, and system/migration state.
- Retained the existing `page.route` Playwright test and reclassified it accurately as mocked UI workflow/browser interaction E2E. Added explicit form accessibility labels and deterministic Ant Design portal cleanup.
- Verified real Admin security: 401, invalid password, rate limit, valid signed session, `HttpOnly`, `SameSite=Strict`, loopback development `Secure=false`, CSRF, Origin, expiry, logout, no-store, and secret-free responses.
- Started `yarn p5:dev` with MCP 8080, Admin API 8081, and Admin Web 5173; all required health/readiness/login endpoints passed and the runtime drained cleanly.

### Verification and regression

- Control Plane, Admin API, Admin Web, and MCP builds passed. Strict changed-code lint passed for Control Plane, Admin API, Admin Web, MCP Server, and Identity Runtime.
- Control Plane 12/12, MySQL 5/5 with zero skip, Identity 27/27, Admin API 12/12, Admin Web 8/8, mocked browser 1/1, and real full-stack browser 1/1 passed.
- Final `yarn validate:p5` exited 0 in 625.83 seconds and reran all of those local acceptance paths through the public aggregate command.
- Real P0, P1, P2, P3, and P4 USER regressions, original official stdio, project-local Inspector, and upstream zero-drift validation passed. Official Salesforce TypeScript modifications remain zero.
- Updated MCP package metadata/system phase display to P5, added final acceptance commands to `validate:p5`, and completed the P5 matrix, runbooks, root README preface, and `P5_FINAL_REPORT.md`.
- Frozen Yarn Classic installation still reproduces the historical Windows/nohoist nested-link failure. All P5 dependencies resolve and downstream Gates pass; this remains `KNOWN UPSTREAM DEBT`, not an SFoA lint/test waiver.

### Result

The configured Diagnostic username aliases an active USER route case-insensitively, and the database has no independent Diagnostic Integration User. A real `validate:p4` attempt exited 1 at the distinct-from-USER preflight before any Salesforce call. Real P4 Tooling and official metadata Diagnostic verification is therefore `NOT TESTED`; no mock is promoted. Baseline advances to `P5-BL-1.1` with `P5 = PARTIAL — AWAITING MAINTAINER REVIEW`. P5 is not merged and P6 remains prohibited.

## 2026-08-23 — P5 Admin Control Plane entered

### Phase transition

- Pushed the accepted P4 waiver commit to `feature/p4-diagnosis-runtime-context`.
- Fast-forwarded `main` from `4c3a45e` to `e6ae8d5` without squashing and pushed `origin/main`.
- Created `feature/p5-admin-control-plane` from updated `main` at `e6ae8d5`.
- Advanced the authoritative baseline to `P5-BL-1.0`; P5 is now `IN PROGRESS` and P6 remains prohibited.

### Architecture entry

- Added ADR-0011 for MySQL-backed SFoA governance/audit, the `env|mysql` compatibility boundary, immutable per-request policy snapshots, separate Control Plane/Admin API/Web workspaces, no Redis, and bootstrap session authentication rather than P5 SSO.
- MySQL is justified only for durable Admin-managed SFoA configuration and audit. It does not store Salesforce secrets or become a Salesforce permission authority.
- The default `env` mode preserves P0-P4 and official stdio regressions. `mysql` mode is authoritative and fails closed without environment fallback.
- P4 live DIAGNOSTIC closure remains deferred and mandatory before P5 final PASS.

## 2026-08-23 — P4 implementation accepted; live closure deferred; P5 development authorized

### Phase-Gate waiver

- Maintainer accepted the P4 implementation while preserving the historical `P4 = PARTIAL` result.
- The external-credential live DIAGNOSTIC Gate is deferred because `SFOA_DIAGNOSTIC_USERNAME` remains unavailable; real Tooling and metadata context are still `NOT TESTED`.
- Maintainer explicitly authorized P5 development. P5 cannot receive final PASS until the P4 live diagnostic closure is attempted again and evidence is recorded.
- If the credential remains unavailable, P5 implementation may complete but P5 must be reported `PARTIAL`. Any defect found by the live attempt must be fixed in P5 Closure with affected P4/P5 Gate reruns.

### Entry revalidation

- Clean P4 branch confirmed before generated test output.
- Context Provider tests: PASS, 10/10.
- P4 Host tests: PASS, 7/7.
- Identity Runtime tests: PASS, 26/26.
- `validate:upstream`: PASS with Provider API 0.6.0, dx-core 0.10.0, nine GA Tools, and `drift: []`.
- Strict changed-code lint: PASS for all six SFoA TypeScript workspaces.

### Baseline and decision record

- Advanced the baseline to `P4-BL-1.2`.
- Added ADR-0010 for the explicit waiver, P5 authorization, immutable historical result, and P5 final-result semantics.
- The waiver authorizes P5 development only; it does not authorize P6 or a P5 merge.

## 2026-08-23 — P4 diagnosis and runtime context implemented with PARTIAL live Gate

### Official and live capability audit

- Initialized the actual pinned dx-core Provider: 13 Tools, nine GA. Confirmed the GA `run_soql_query` Tool selects `connection.tooling.query()` only when requested and the GA `retrieve_metadata` Tool uses the DX project/filesystem path.
- Live-ran unchanged official `retrieve_metadata`: one 796-character status block, no `structuredContent` or XML, and 137 retrieved source files in the request workspace. This proved that a minimal same-request bounded file-content wrapper is required for stateless HTTP diagnosis.
- Initialized the actual Code Analyzer Provider: six Tools. Its Agent-selected absolute targets, durable local project, and process-global temp result file are not compatible with request-owned remote workspaces. Recorded `NOT REMOTE COMPATIBLE`; no Tool was exposed, copied, or rewritten.
- Exercised SFoA API 67.0 with both real USER routes. REST UI API Object Info, Create/Edit Layout, Create Defaults, and record-type Picklist/dependency calls passed. GraphQL `recordLayouts` also passed but is not required; ADR-0009 selects REST for the P4 runtime.

### Added

- New private `@sfoa/mcp-provider-sfoa-context` workspace with exactly three GA read-only Tools and stable structured outputs: USER `get_record_action_context`, DIAGNOSTIC `run_diagnostic_tooling_query`, and DIAGNOSTIC `get_metadata_component_context`.
- Server-owned `SFOA_DIAGNOSTIC_USERNAME` route using the existing Connected App/JWT configuration. Diagnostic Tools fail startup without it, create a fresh Connection/workspace per request, retain the triggering platform user in logs, and expose no identity/role/token/URL/filesystem switch.
- Official diagnostic adapters: Tooling query forces the unchanged official SOQL Tool to `useToolingApi=true`; metadata context creates an XML-escaped allowlisted manifest, invokes unchanged official retrieval, and reads only bounded UTF-8 files beneath the request source root.
- REST UI API record-action executor with available/default/record-derived Record Type handling; separate API/layout requiredness; field/layout editability; Salesforce defaults; record-type picklists/dependencies; labels/types/references/layout order; source coverage, call count, duration, bytes, warnings, and explicit truncation.
- Credential-pattern redaction for Tooling/metadata evidence and JSON-safe Bearer redaction regression coverage.
- `P4_AGENT_GUIDANCE.md`, `P4_FINAL_REPORT.md`, and ADR-0009.

### Security and scope

- USER official reads, UI context, CREATE, and UPDATE are blocked on DIAGNOSTIC scopes. Diagnostic Tools are blocked on USER scopes. A mixed batch remains USER-scoped and cannot turn a diagnostic identity into a business-record or mutation route.
- Metadata types are limited to CustomObject, CustomField, ValidationRule, Flow, ApexClass, ApexTrigger, Layout, and FlexiPage. Wildcards, client manifests/paths, deployment, permission assignment, anonymous Apex, normal business SOQL through DIAGNOSTIC, and DELETE remain absent.
- Added no Metadata Snapshot, Evidence Graph, Runtime Form Engine, FLS/Profile/Permission replica, Validation/Flow/Apex interpreter, Lookup Engine, database, Redis, token cache, Connection pool, Admin UI, or P5 capability.

### Verification

- Context Provider: PASS, 10/10. P4 Host: PASS, 7/7. Identity Runtime: PASS, 26/26. P3 Provider/Host: PASS, 17/17 and 18/18. P2 Host: PASS, 18/18.
- P4 real USER A/B record action context: PASS at API 67.0. Returned 111/79 fields with 28/23 API-required, 12/12 layout-required, 6/9 defaulted, and 32/21 picklist fields. Identity mismatch 0, Connection reuse 0, workspace cleanup 2/2.
- Real DIAGNOSTIC Tooling and metadata context: `NOT TESTED` because `SFOA_DIAGNOSTIC_USERNAME` is not configured.
- P3 live CREATE/UPDATE/native failure/forgery/cleanup, P2 live A/B/50-request load, P1 live A/B/20-concurrency, P0 live JWT/SOQL/official CustomObject metadata, P0 HTTP, original stdio, project-local Inspector, and upstream zero drift: PASS.
- Git Bash root build: PASS, 106.76 s. Root full tests: PASS, 419.58 s. All six SFoA strict TypeScript lints: PASS.
- Root lint reproduced exactly 47 unchanged official Code Analyzer errors / 0 warnings: `KNOWN UPSTREAM DEBT`; no SFoA file is affected.
- Frozen Yarn Classic install aborted on a nested `@typescript-eslint/.../ignore` ENOENT and removed generated `.bin` entries. Source/manifests/lockfile stayed unchanged; 513 ignored command shims were mechanically rebuilt from installed package manifests before stdio/build/tests passed. This remains `KNOWN UPSTREAM DEBT`.
- Official Salesforce TypeScript modifications: 0. Official Tool copies: 0. JSforce patches: 0. Root `package.json`/`yarn.lock` modifications: 0. Database/Redis/cache/pool additions: 0.

### Result

Baseline advanced to `P4-BL-1.1`. `P4 = PARTIAL`: all independent implementation and USER live evidence passed, but the key real fixed-DIAGNOSTIC evidence chain is not tested. P5 remains unauthorized.

## 2026-08-23 — P4 diagnosis and runtime context authorized

### Phase transition

- Maintainer review final-accepted P3, including `P3-CLOSURE HOTFIX01 = PASS` and `P3-CLOSURE HOTFIX02 = PASS`, and explicitly authorized P4.
- The clean P3 feature branch was revalidated before merge: Provider tests 17/17 PASS, Host tests 18/18 PASS, `validate:upstream` PASS with zero drift, and strict TypeScript lint PASS for all five SFoA workspaces.
- `feature/p3-generic-dml-allowlist` was fast-forwarded without squashing to `main` at `4c3a45e` and pushed to `origin/main`.
- `feature/p4-diagnosis-runtime-context` was created from the updated `main` at the same commit.

### Baseline

- Advanced the authoritative baseline to `P4-BL-1.0` with `P3 = FINAL ACCEPTED` and `P4 = IN PROGRESS`.
- P4 begins with the P4-00 official/SFoA capability audit. ADR-0009 must record actual official Provider/result/runtime evidence and live UI API support before any new Context Tool is implemented.
- No P4 capability is marked PASS at entry. DIAGNOSTIC identity, Tooling/metadata context, Record Action Context, GraphQL UI API, and Code Analyzer remote compatibility remain `NOT TESTED` until executed.

### Scope boundary

- P4 is read-only diagnosis/context. It does not add DELETE, UPSERT, Bulk DML, deployment, anonymous Apex, permission assignment, database, Redis, cache, pool, Metadata Snapshot, Evidence Graph, Runtime Form Engine, Salesforce permission replica, rule interpreter, Lookup Engine, Admin UI, or P5/P6 scope.
- Salesforce remains the authority, MCP returns governed deterministic facts, and the LLM retains reasoning and dialogue.

## 2026-08-23 — P3-Closure HOTFIX02 request-level mutation outcome safety completed

### Changed

- Added one minimal `MutationRequestState` per HTTP POST and a Provider-neutral `MutationExecutionObserver`. `DmlExecutor` marks CREATE/UPDATE immediately before the public SDK dispatch, after local input, policy, identity, Connection, and SObject preparation.
- An outer request timeout after mutation start now returns HTTP 504 JSON-RPC `MCP_DML_OUTCOME_UNKNOWN` with `retryable:false` and no-automatic-retry/read-before-another-mutation guidance. Pre-dispatch and read request timeouts remain `MCP_REQUEST_TIMEOUT`.
- Changed defaults to `MCP_REQUEST_TIMEOUT_MS=180000` and `MCP_TOOL_TIMEOUT_MS=120000`; configuration loading and direct Host startup fail closed with `MCP_RUNTIME_CONFIGURATION_INVALID` when request timeout is less than or equal to Tool timeout.
- Added bounded UNKNOWN logging fields for operation, outcome, mutation-start state, duration, and TOOL/REQUEST/TRANSPORT termination layer. Client disconnect after mutation start is logged without replay or cancellation claims.
- Reverified installed `@jsforce/jsforce-node@3.10.13`: default retry methods are exactly GET, PUT, HEAD, OPTIONS, and DELETE. CREATE POST and UPDATE PATCH are absent; JSforce was not patched or forked.

### Safety tests

- Added deterministic outer-timeout fixtures for CREATE and UPDATE, including late success after the client receives UNKNOWN. Each operation has one invocation, one completion, and zero automatic retry.
- Added pre-dispatch timeout, read-only timeout, allowlist denial, schema-validation, Tool-timeout, structured Salesforce rejection, and client-disconnect regressions.
- Added source-contract evidence for pinned JSforce POST/PATCH no-retry behavior and timeout-default parity with `.env.example`.

### Verification

- P3 Provider tests: PASS, 17/17. P3 Host tests: PASS, 18/18. P2 tests: PASS, 18/18. All five SFoA strict TypeScript lint commands: PASS.
- P3 live Salesforce: PASS for CREATE/UPDATE, required/validation/authorization failures, A/B identity isolation, Connection reuse 0, and exact cleanup 2/2.
- P2 live A/B/50-request load, P1 22/22/live, P0 9/9/live, P0 HTTP 1/1, upstream compatibility, original stdio, and project-local Inspector: PASS.
- Git Bash root build: PASS, 130.07 s. Root full tests: PASS, 519.71 s.
- Root lint reproduced exactly 47 unchanged official code-analyzer errors / 0 warnings: `KNOWN UPSTREAM DEBT`. No SFoA path is affected.
- Official Salesforce TypeScript modifications: 0. JSforce patches: 0. Root `package.json` and `yarn.lock` modifications: 0. Database/Redis/idempotency/retry/UPSERT/DELETE/P4 additions: 0.

### Result

`P3-CLOSURE HOTFIX02 = PASS`. Baseline advanced to `P3-BL-1.3`; P3 awaits final maintainer acceptance, and P4 has not started.

## 2026-08-23 — P3-Closure HOTFIX01 ambiguous mutation outcome safety completed

### Changed

- Added stable `MCP_DML_OUTCOME_UNKNOWN` Tool-level semantics for DML Tool timeout and mutation execution exceptions without reliable structured Salesforce rejection evidence.
- Restricted `MCP_SALESFORCE_DML_FAILED` to explicit unsuccessful Salesforce `SaveResult` values or trustworthy structured Salesforce `errorCode`/`message`/`fields` evidence, including the pinned JSforce error `data` body.
- Preserved the existing compact structured error shape. No client-visible correlation field or idempotency key was added; correlation, Tool, platform user, and Salesforce user remain in safe runtime logs.
- Updated `create_record` and `update_record` descriptions to state that mutations are non-idempotent, unknown outcomes must not be automatically retried, an independent read should verify state first, and the user must be told when state cannot be confirmed. `idempotentHint` remains `false`.

### Safety tests

- Explicit `REQUIRED_FIELD_MISSING` and `FIELD_CUSTOM_VALIDATION_EXCEPTION` remain `MCP_SALESFORCE_DML_FAILED`.
- Transport/ECONNRESET and unstructured SDK rejection fixtures return `MCP_DML_OUTCOME_UNKNOWN`; Provider CREATE/UPDATE invocation count remains one.
- CREATE and UPDATE Host timeout fixtures return structured UNKNOWN results with no-retry guidance. A late CREATE resolution completes after the timeout without any second invocation.
- `REQUIRED_FIELD_MISSING`, `FIELD_CUSTOM_VALIDATION_EXCEPTION`, and `INSUFFICIENT_ACCESS_OR_READONLY` continue to preserve bounded safe Salesforce code/message/fields.
- Timeout log assertions preserve correlation ID, Tool name, platform user ID, and Salesforce username under the new error code.

### Verification

- P3 Provider tests: PASS, 16/16. P3 Host tests: PASS, 10/10. All SFoA strict TypeScript lint: PASS.
- P3 live Salesforce: PASS for successful CREATE/UPDATE, required/validation/authorization failures, identity isolation, zero Connection reuse, and exact cleanup 2/2.
- P2 18/18 and live A/B/50-request load, P1 22/22/live, P0 9/9/live, P0 HTTP 1/1, upstream compatibility, original stdio, and project-local Inspector: PASS.
- Git Bash root build: PASS, 70.86 s. Root full tests: PASS, 284.67 s.
- Root lint reproduced exactly 47 unchanged official code-analyzer errors / 0 warnings: `KNOWN UPSTREAM DEBT`. No SFoA path is affected.
- Official Salesforce TypeScript modifications: 0. Root `package.json` and `yarn.lock` modifications: 0. Database/Redis/idempotency/retry/UPSERT/DELETE additions: 0.

### Result

`P3-CLOSURE HOTFIX01 = PASS`. Baseline advanced to `P3-BL-1.2`; P3 awaits final maintainer acceptance, and P4 has not started.

## 2026-08-22 — P3 minimal generic DML completed

### Added

- New private `@sfoa/mcp-provider-sfoa-dml` workspace with exactly `create_record` and `update_record`, strict input/output schemas, complete annotations, stable safe errors, and single-record SDK execution through request `OrgService`.
- Strict `MCP_DML_ALLOWLIST_JSON` Object-by-Operation parser/policy. Missing, blank, and `[]` deny all; malformed JSON, unknown fields/operations, DELETE, duplicate objects, and duplicate operations fail closed.
- Separate `DmlToolGovernancePolicy` and DML facade in the formal Host. Exact P3 Tool names require a matching operation rule; the accepted official P2 `MUTATION` classification remains forbidden.
- Twelve Provider tests, eight independent P3 Host/config/HTTP/identity tests, and a live P3 Salesforce validator with ID-bounded SDK cleanup outside production Tool registration.
- `P3_FINAL_REPORT.md`; architecture, Upstream boundary, baseline, matrix, environment example, and package documentation updates.

### Official reuse decision

- The actual pinned dx-core 0.10.0 Provider has no reusable generic CREATE/UPDATE Provider or Tool. Removed historical create-only source was not copied.
- Salesforce Hosted `platform/sobject-mutations` is not an embeddable Provider for the accepted request-scoped Connection path; it requires a separate hosted endpoint/OAuth model and SFoA availability remains not proven.
- ADR-0008 selects only pinned public single-record `Connection.sobject().create()` and `update()`. No raw REST, CLI, Auth Cache, custom OAuth, query-after-write, DELETE, UPSERT, or Bulk API is used.

### Verification

- Provider tests: PASS, 12/12. P3 Host/config/HTTP tests: PASS, 8/8. P2 historical regression: PASS, 18/18. Strict P3 Provider/Host lint: PASS.
- Live SFoA `tools/list`: exactly `create_record`, `update_record`. User A real CREATE and UPDATE: PASS. User B used B's Connection and preserved native `FIELD_CUSTOM_VALIDATION_EXCEPTION`; User B UPDATE against the validator-owned A record preserved `INSUFFICIENT_ACCESS_OR_READONLY`.
- Native invalid CREATE preserved `REQUIRED_FIELD_MISSING` under `MCP_SALESFORCE_DML_FAILED`. Forged platform/username fields could not change the authenticated route. Connection reuse: 0.
- Validator cleanup: PASS, exactly 2 attempted / 2 deleted / 0 failures; cleanup used only recorded IDs and no production DELETE Tool.
- `validate:upstream`: PASS with nine GA official Tools and zero drift. P2 live A/B plus 50-request load, P1 22/22 plus live A/B, P0 9/9 plus live SOQL/metadata, P0 HTTP 1/1, project-local Inspector, and original stdio all passed.
- Git Bash root build: PASS, 82.49 s. Root full tests: PASS, 356.86 s. Root lint reproduced exactly 47 unchanged official code-analyzer errors / 0 warnings as `KNOWN UPSTREAM DEBT`; all SFoA strict lint passed.
- The frozen Yarn Classic install reproduced the existing Windows nested `brace-expansion` link failure and removed generated `.bin` shims before aborting. The lockfile stayed unchanged; missing shims were mechanically regenerated from installed package manifests, after which stdio, root build, and root tests passed.
- Official Salesforce TypeScript modifications: 0. Official Tool copied/reimplemented: NO. Root `package.json`: unchanged. `yarn.lock`: unchanged. New database/Redis dependency: none.

### Result

`P3 = PASS / COMPLETE — AWAITING MAINTAINER REVIEW`. Baseline advanced to `P3-BL-1.1`. P4 has not started.

## 2026-08-22 — P3 minimal generic DML authorized

### Phase transition

- Maintainer review accepted `P2 = PASS / COMPLETE` and `P2-CLOSURE HOTFIX01 = PASS`, then authorized P3.
- The clean P2 branch at `f532c8a` matched its pushed remote. `validate:upstream` returned PASS with zero drift and the targeted P2 suite passed 18/18 immediately before merge.
- P2 was fast-forwarded without squashing to `main`, `main` was pushed, and P3 began on `feature/p3-generic-dml-allowlist` from that updated commit.

### Baseline decisions

- Baseline advanced to `P3-BL-1.0`; `P2 = PASS / COMPLETE — MAINTAINER ACCEPTED` and `P3 = IN PROGRESS`.
- P3 is limited to separate generic CREATE and UPDATE Tools behind strict Object-by-Operation allowlisting. Missing or empty configuration denies all; invalid, duplicate, DELETE, and unknown operations fail closed.
- P3 reuses the P1/P2 authenticated request scope and fresh `@salesforce/core` Connection. Salesforce remains the CRUD/FLS/sharing/validation/Flow/Trigger authority.
- DELETE, UPSERT, bulk DML, arbitrary REST, metadata mutation, Apex mutation substitutes, field-policy replication, database, Redis, caches, pools, and Admin UI remain out of scope.
- P3-00 must finish the official Provider/Hosted MCP/SDK audit and record the decision in an ADR before a new DML Provider is implemented.

### P3-00 official capability audit

- Actual dx-core 0.10.0 public exports, `provideTools()` implementation, Provider API surface, and repository history were inspected. No current generic CREATE/UPDATE or mutation Provider exists; the old `sf-create-record` implementation was removed upstream and will not be copied.
- Salesforce Hosted `platform/sobject-mutations` provides CREATE/UPDATE without DELETE, but is a fixed remote MCP service using a separate External Client App and OAuth/PKCE model. It cannot consume the current request-scoped Connection, includes relationship mutation, and SFoA/Alibaba Cloud support is not proven.
- ADR-0008 selects pinned `@salesforce/core@8.29.0` / JSforce single-record `sobject().create()` and `update()` through the existing P1/P2 request scope.
- ADR-0008 also selects a strict JSON-array environment/local allowlist because duplicate objects/operations can be detected without defining a custom configuration grammar.

## 2026-08-22 — P2 Closure HOTFIX01 upstream drift guard completed

### Added

- Actual public `DxCoreMcpProvider` inventory inspector and repeatable `validate:upstream` Gate for Provider/API/package version, Tool name, ReleaseState, input field/requiredness, and output-schema drift.
- Stable `MCP_UPSTREAM_TOOL_CONTRACT_DRIFT` startup/registration failure for enabled remote contract changes.
- Executable dx-core 0.10.0 contracts for all 13 Tools and explicit host/Agent argument ownership for `get_username`, `run_soql_query`, and `retrieve_metadata`.
- Seven inventory/contract test scenarios plus an optionality regression, exact remote-schema assertions, and four-field identity-forgery coverage. ADR-0007 supersedes ADR-0006's open-ended schema projection.

### Changed

- `RemoteToolFacade` now validates the complete audited surface and projects only `allowedAgentArguments`; official fields are no longer inherited merely because they are not host-owned.
- `OFFICIAL_PROVIDER_INVENTORY.md` is explicitly informational. `official-tool-catalog.ts` is the sole executable safety source.
- Hardened the request-timeout test so MCP initialize has a distinct timing margin and connection failure always closes server resources; this removed a root-suite load race without changing production timeout behavior.

### Verification

- Upstream compatibility: PASS; `DxCoreMcpProvider`, Provider API 0.6.0, dx-core 0.10.0, nine GA Tool names, and zero drift.
- P2 tests 18/18 and strict lint PASS; unknown Tool remains unclassified/invisible/uncallable; added/removed/renamed/requiredness/ReleaseState contract changes fail closed.
- P1 22/22 and live A/B PASS; P0 9/9 and live JWT/SOQL/metadata PASS; P0 HTTP 1/1 PASS.
- P2 live A/B, 50-request zero-leak load, official Tool calls, and project-local Inspector initialize/list/call PASS. The first P2 live attempt lacked `MCP_CLIENT_TOKEN`; a command-local non-persisted test token was supplied and the complete rerun passed.
- Original Salesforce stdio initialize/list/call PASS; Git Bash root build PASS in 94.94 s; root tests PASS in 325.05 s.
- SFoA changed-code lint PASS. Root lint reproduced exactly 47 unchanged official code-analyzer errors: `UPSTREAM_LINT_BASELINE = KNOWN UPSTREAM DEBT`.
- Official Salesforce TypeScript modifications: 0. Root `package.json`: unchanged. `yarn.lock`: unchanged. Official Tool copied/reimplemented: NO.

### Result

`P2-CLOSURE HOTFIX01 = PASS`. Baseline advanced to `P2-BL-1.2`; P3 remains not started pending maintainer final acceptance.

## 2026-08-22 — P2 remote runtime and Tool governance completed

### Added

- New `@sfoa/mcp-server` package with configurable stateless Streamable HTTP, internal Bearer authentication, authenticated platform-user Header routing, Host/Origin bounds, health/readiness, bounded request bodies, request/Tool timeouts, response-lifecycle cleanup, JSON-line logging, and graceful SIGINT/SIGTERM drain.
- Registration-time `ToolGovernancePolicy`, explicit official Tool inventory/classification, and low-intrusion `RemoteToolFacade` adapters that hide/inject `usernameOrAlias` and `directory` while retaining unchanged official `Tool.exec()`.
- Ten P2 unit/integration tests, real two-user/load/performance validation, and a project-local MCP Inspector proxy Gate.
- Official Provider inventory, client/reverse-proxy contracts, Chinese user test guide, Dify/WorkBuddy connection guide, ADR-0005, ADR-0006, and P2 final report.

### Verification

- Bearer/auth-order, A/B identity, official get_username/SOQL, invisible disabled Tools, startup fail-closed policy, remote schemas, 413, request/Tool timeouts, cleanup, and signal drain passed.
- Fifty interleaved real read-only requests passed with zero identity mismatch, cross-user leak, workspace leak, cleanup failure, Connection reuse, or error.
- Latest measured p50/p95: 50-request calls 1048.34/1147.25 ms; initialize 1354.90/1673.39 ms; tools/list 626.00/853.42 ms; get_username 1042.83/1147.25 ms; SOQL 952.72/1075.28 ms; JWT/Connection 872.98/1083.08 ms. No cache was added.
- Project-local MCP Inspector 0.15.0 passed initialize, enabled-only tools/list, and get_username tools/call for A and B.
- P2 10/10 tests and strict lint, P1 22/22 and live A/B, P0 9/9 and live Closure, P0 HTTP POC, original stdio, root build, and 394.13-second full root tests passed.
- Root lint reproduced exactly 47 unchanged official code-analyzer errors and no SFoA error: `UPSTREAM_LINT_BASELINE = KNOWN UPSTREAM DEBT`; `SFOA_CHANGED_CODE_LINT = PASS`.
- Salesforce CLI runtime, database, Redis, token cache, Connection pool, and DML dependencies remain absent. Official Salesforce TypeScript modifications: 0. Root manifest/lockfile changes: 0.

### Result

`P2 = PASS / COMPLETE — AWAITING MAINTAINER REVIEW`. Baseline advanced to `P2-BL-1.1`. P3 has not started.

## 2026-08-22 — P2 remote runtime and Tool governance authorized

### Phase transition

- Maintainer review accepted `P1 = PASS / COMPLETE` and authorized P2.
- The accepted P1 branch was rerun through build, 22/22 tests, strict lint, and live two-user validation, then fast-forwarded without squashing to `main` at `3d35ef6` and pushed.
- P2 development began from updated `main` on `feature/p2-remote-runtime-governance`; P3 remains prohibited pending the complete P2 Gate and maintainer review.

### Baseline decisions

- P2 adds a separate SFoA-owned production Streamable HTTP host; `@sfoa/identity-runtime` remains the request-scoped identity foundation and its P1 test host is not promoted unchanged.
- `platformUserId` remains the sole business identity authority after minimal internal Bearer client authentication.
- Tool governance is registration-time and default-deny. P2 remains read-only; mutation, admin, local-development, and unknown Tools are forbidden.
- P2 remains database-, Redis-, token-cache-, connection-pool-, Salesforce-CLI-runtime-, DML-, and Admin-UI-free.
- Baseline advanced to `P2-BL-1.0`; `P2 = IN PROGRESS`.

## 2026-08-22 — P1 request-scoped identity routing completed

### Added

- Private SFoA-owned `@sfoa/identity-runtime` workspace with immutable request context, `IdentityRepository`/in-memory implementation, resolver, fresh-JWT Connection factory, request-scoped OrgService/Services, official dx-core Provider composition, bounded request workspaces, CWD execution guard, stateless Streamable HTTP host, structured redacted logs, and stable error codes.
- Twenty-two unit/integration tests and one repeatable `validate:p1` live harness.
- Chinese `P1_USER_TEST.md` and `P1_FINAL_REPORT.md`.

### Verification

- `SECOND_TEST_USER` is now explicitly consumed and mapped to the B route; both real users passed fresh JWT and `Connection.identity()`.
- Official `get_username` and `run_soql_query` passed for A and B.
- A→B and B→A forged usernames, unknown routes, and missing platform identity were blocked before unintended Salesforce access.
- Twenty interleaved requests completed with zero identity mismatch, cross-user leak, or Connection reuse.
- Two concurrent official metadata requests serialized through the CWD guard, used distinct cleaned workspaces, and restored CWD.
- P1 build, 22/22 tests, strict lint, root build/full tests, original stdio, P0 HTTP, and P0 live runtime regressions passed.
- Salesforce CLI used by P1 runtime: NO. Database/Redis/cache/pool used: NO. Official Salesforce TypeScript changes: 0.
- Root lint continues to reproduce 47 unchanged official code-analyzer errors as `KNOWN UPSTREAM DEBT`; no new SFoA lint error exists.

### Result

`P1 = PASS / COMPLETE — AWAITING MAINTAINER REVIEW`. Baseline advanced to `P1-BL-1.1`. P2 was not started.

## 2026-08-22 — P1 request-scoped identity routing authorized

### Phase transition

- Maintainer review accepted `P0 = PASS` and authorized P1.
- P0 Closure commits `32469cd`, `d90163f`, and `e80d9fd` were fast-forwarded to `main` and pushed without squashing.
- P1 development began on `feature/p1-request-scoped-identity`; P2 remains prohibited pending the P1 Gate and maintainer review.

### Baseline decisions

- P1 uses an `IdentityRepository` interface plus an in-memory two-user mapping; no database, ORM, Redis, token cache, or connection pool is introduced.
- `platformUserId` is the only identity authority. Official Tool `usernameOrAlias` values are non-authoritative and must match the resolved request route.
- The maintainer had supplied `SECOND_TEST_USER`, but the P0-Closure loader did not consume it. Historical P0 execution remains unchanged; real second-user execution is mandatory in P1.
- Request and connection contracts reserve `ConnectionRole = USER | DIAGNOSTIC`. P1 implements only business-user `USER`; the fixed diagnostic user is deferred to P4 and is barred from business data operations.

## 2026-08-22 — P0-Closure live Gates completed

### Verification

- Fresh SFoA JWT through direct `@salesforce/core` Bearer authentication: PASS.
- Salesforce identity matched the configured username; direct Connection: PASS.
- Direct SOQL against the configured `Lead` object: 5 rows, PASS.
- Official `run_soql_query`: 5 rows, PASS.
- Official `retrieve_metadata` for the configured `CustomObject`: 135 retrieved files, PASS.
- Temporary Workspace lifecycle and Harness CWD restoration: PASS; official Tool CWD side effect remains documented.
- Stable Salesforce CLI v2 JWT login, org display, and read-only query: PASS.

### Result

`P0 = PASS`. No User Id, Org Id, token, or Salesforce record content was committed. The second-user isolation Gate remains P1, and P1 has not started.

## 2026-08-22 — P0-Closure Harness implementation

### Added

- Private `@sfoa/runtime-validation` workspace for fresh JWT, direct `@salesforce/core` identity/SOQL, official `run_soql_query`, official `retrieve_metadata`, temporary DX workspace, CWD observation/restoration, and console-only token diagnostics.
- Nine unit/integration tests covering configuration, redaction/token description, official Provider Tool registration/execution, and bounded temporary-workspace cleanup.
- `PROVIDER_COMPATIBILITY.md`, `P0_CLOSURE_USER_TEST.md`, and `P0_CLOSURE_REPORT.md`.
- Complete Closure variable names in `.env.example`; `.env.local`, private keys, and temporary Closure artifacts remain ignored.

### Environment and architecture

- Removed the stale missing `@salesforce/sfdx-scanner` plugin record using Salesforce CLI itself.
- Updated persistent user PATH to prefer the stable Salesforce CLI v2 shim; a newly opened terminal is required because the active Codex process retains its prior PATH snapshot.
- Declared Salesforce CLI diagnostic-only and fixed the production chain as direct JWT/OAuth through `@salesforce/core` and official Providers.
- Declared P0/P0-Closure database-free. P1 will begin behind an `IdentityRepository` interface and may use a memory/local test mapping before persistence is justified.
- Recorded the exact packaged stdio dx-core 0.9.8 and SFoA extension dx-core 0.10.0 version baselines; no package version was upgraded.

### Verification

- Closure Harness build PASS, unit tests 9/9 PASS, and strict TypeScript lint PASS.
- Original stdio initialize/list/call regression PASS against five selected Tools.
- Streamable HTTP initialize/list/call, 405, Origin rejection, and cleanup regression PASS (1/1).
- Reproduced 47 unchanged code-analyzer lint errors and normalized them as `UPSTREAM_LINT_BASELINE = KNOWN UPSTREAM DEBT`; `SFOA_CHANGED_CODE_LINT = PASS`.
- Repeated frozen Yarn install attempts still fail at a Yarn Classic Windows nested `brace-expansion` link; lockfile unchanged and targeted Closure Gates pass.

### Pending live inputs

- `.env.local` is absent. Fresh JWT, token/identity, Direct SOQL, official SOQL, official Metadata, and live CWD evidence remain `NOT TESTED`; P0 remains `PARTIAL PASS`.
- The second-user isolation Gate is assigned to P1 and is not required to close P0.

## 2026-08-22 — P0 baseline initialization

### Added

- Full official `salesforcecli/mcp` Git history with official remote named `upstream`.
- Associated the company GitHub repository as `origin` and prepared `main` to track `origin/main`.
- Environment baseline and Node/Yarn decision evidence.
- Project baseline, phase plan, Gate policy, architecture audit, MCP engineering rules, Upstream strategy, test matrix, and ADR directory.
- Root AI-agent contribution rules.
- Empty secret-safe `.env.example`.
- Private `@sfoa/streamable-http-poc` workspace composed only from public official Provider contracts.
- Original stdio Tool-schema, protocol, CLI, and HTTP POC evidence under `docs/sfoa/evidence`.
- ADR-0004 accepting Streamable HTTP by composition while retaining stdio.

### Environment

- Retained Node v24.13.0 because it satisfies Upstream current-LTS and `>=20` policy.
- Activated Yarn Classic 1.22.22 through existing Corepack.
- Did not install React, TypeScript, Vite, Ant Design, TanStack Query, React Router, Docker, Redis, or database clients globally or for P0.
- Recorded Salesforce CLI legacy PATH/stale-plugin issue and the usable direct v2.148.3 installation.

### Architecture

- Confirmed official Salesforce Tools use `@salesforce/core` and official Node SDKs rather than spawning `sf`.
- Confirmed official host authorization and Tool state are process-scoped.
- Identified `process.chdir(directory)` as the primary concurrent-HTTP safety constraint.
- Classified identity/auth as middleware/shared services and future DML as a Provider plus allowlist service.
- Recorded `retrieve_metadata` hard dependency on a writable DX project/workspace.
- Selected full-history **FULL FORK + EXTENSION** with zero official TypeScript patches.
- Classified the official Providers/Tools as reusable while the unchanged process-scoped host is only a partial production runtime base.

### Verification

- Clean Yarn install PASS; lockfile unchanged.
- Git Bash root build PASS; default PowerShell/cmd build exposes the official POSIX `cp` dependency.
- Final full workspace tests PASS, including Streamable HTTP initialize/list/call.
- Original stdio initialize, Tool list, and `get_username` call PASS through project-local Inspector.
- Root lint FAIL on 47 existing code-analyzer findings; official server, dx-core, and SFoA POC lint individually PASS.
- CLI and original MCP SOQL both reached the configured local SFoA authorization but failed because its refresh session is expired.

### Security

- Added ignore rules for local env files, JWT key formats, secrets directories, and Firecrawl cache.
- Kept all observed tokens and private-key material out of project files.

### Deferred / blocked by external inputs

- Run fresh SFoA JWT, successful SOQL, controlled metadata-component retrieval, and optional second-user Gates when inputs are supplied.
- Resolve or accept the existing Upstream code-analyzer lint baseline outside the P0 extension scope.

## 2026-09-08 — P8-06

Independent WeCom channel token, two-stage authentication, identity-less SDK discovery,
shared global governance snapshots, strict channel binding, safe readiness UI and
HTTP/MySQL/isolation regression coverage. See ADR-0020 and P8_06_WECOM_CHANNEL_DISCOVERY.md.

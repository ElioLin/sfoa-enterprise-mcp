# P10-T4 live milestone evidence (recorded 2026-10-09)

T4 delivers the metadata pair: `list_metadata_components`, a read-only Tool that enumerates a type's
components (the `list_sobjects` half of the pattern), and a widened `get_metadata_component_context`, whose
`METADATA_CONTEXT_TYPES` allowlist grows from eight types to twenty-one (the `describe_sobject` half). The
listing never returns content and the reader never enumerates — a caller walks the pair, and the hint on
each answer names the other half by the name `tools/list` actually advertises.

The unit and protocol suites prove the contract against fixtures. This page records the three things they
cannot: that the listing agrees with the org's own inventory row for row, that a name the org really stores
survives the round trip **byte-exact**, and that every type the allowlist promises is one this org will
actually list to the diagnostic identity — because "listability" is an authorization fact **per type**
(ADR-0029 §3 prerequisite `A-4`), not a property of the Tool.

**The milestone ran twice, and the first run failed.** Run 1 admitted the twenty-two types the prompt named
and the org refused two of them. Investigating *why* produced the T4 task's two substantive findings: two of
the prompt's type names are not this API's names (§4.1), and the Tool's per-type refusal branch was **dead
code** because jsforce namespaces Metadata API error codes and the shared classifier drops a namespaced code
to `null` (§4.2). Run 2, with the allowlist corrected and the classifier fixed, is the recorded result. Both
reports are kept, because a corrected allowlist with no record of what it corrected is the silent rename
this page refuses to perform.

**What the run found in the product, and what it found in the harness.** Unlike the T2 and T3 milestones,
every defect here is in **product** code — the allowlist's two names and the classifier are things a caller
would have hit — and the harness itself needed no repair between the runs. That is the mirror image of T3
and it is worth recording as such: the fixture suites could not have found either, because both are facts
about *this* org's Metadata API surface.

## 0. What was measured, on what, and how to read it

| | |
| --- | --- |
| Org | sandbox (`IsSandbox = true`), instance **CHN5S**, org id `00D************MAM`, API **v68.0** |
| Execution identity | the deployment's fixed DIAGNOSTIC identity — configured, enabled, `verificationStatus = PASS`, `c***@runner-corp.com.cn.uat`, platform user `08***48` |
| Mode | **`MEASURED`** — no sandbox gate is needed, because unlike T2 and T3 the milestone constructs nothing: it measures what the org already holds |
| Result | **run 2: `overall = PARTIAL`**, ten of eleven gates `PASS`, `inactiveDefault` `NOT TESTED` (no recycled component exists on this org to filter) |
| Host | the test server `192.168.156.203` (`crm-ex-test02`), built and run with Node **v22.23.1** |
| Reports | `/data/sfoa-enterprise-mcp/p10-t4-milestone-20261009-093817.json` (run 1, 13 624 bytes, `FAIL`) and `/data/sfoa-enterprise-mcp/p10-t4-milestone-20261009-095440.json` (run 2, 12 992 bytes, `PARTIAL`) |
| Harness | `packages/sfoa-mcp-server/src/validation/p10-t4-live-milestone.ts`, runnable as `yarn workspace @sfoa/mcp-server milestone:p10-t4` |
| Probe (second instrument) | `/data/sfoa-enterprise-mcp/p10-probe-20261009-100148.json` (58 543 bytes), `yarn workspace @sfoa/mcp-server probe:p10` |
| Tree measured | `sfoa-p10-t4-live-fix.tar.gz`, sha256 `ea3b8aea380d1d47aa21196d5d2fd85c692bb339b9edc2ddc874917c7fac2f12`, 1 277 entries, every one verified by `sha256sum -c` against an LF manifest before the run |

**Node version, corrected.** The T3 evidence page records the host as Node **v24.19.0**. That is not
reproducible: this host has no `nvm` and no second installation, and its only Node — `/usr/bin/node`, the one
the `yarn workspace … milestone:p10-t4` invocation resolves — answers **v22.23.1**. The T4 numbers on this
page were produced by that interpreter; the T3 line is left as written in its own page and this paragraph is
the correction. The milestone's report does not record a Node version of its own, so the version claim here
rests on the host's single installation rather than on a field of the run. Nothing in either run depends on a
v24-only feature, so the T3 result is not in doubt — what was wrong was the version claim, not the run.

**The milestone writes nothing to the Control Plane.** The grant that enables the two Tools is a snapshot
wrapper in `AdditiveToolPolicySnapshotSource`, exactly as T2 and T3 do it, so a passing run can never be a
run that quietly granted itself the Tool it is supposed to prove can be granted. The Control Plane's own
state on this deployment is the subject of §2.6, and it is the reason the wrapper exists.

**Every id, username and platform user in the report is masked where it is produced.** This page quotes the
masked values and no others. Component and type names are **not** masked and are quoted as the org stores
them, because the whole point of the pair is that those bytes survive: §2.2 is about a name that contains a
`%2F` and a Chinese path segment.

### The two runs

| Run | Started (UTC) | Report | Mode | Result | Failing legs |
| --- | --- | --- | --- | --- | --- |
| 1 | 01:38:26 | `…-093817.json` | `MEASURED` | **FAIL** | `allowlistCoverage` — 22 types declared, 20 served, `CustomSetting` and `SharingRule` refused |
| 2 | 01:54:53 | `…-095440.json` | `MEASURED` | **PARTIAL** | `inactiveDefault` `NOT TESTED` — measured, not failed (see §3) |

Run 1 is not a flaky run that a re-run happened to fix. It is the run that **measured** the two corrections,
and its report is the primary evidence for §4.1: `refused: ["CustomSetting", "SharingRule"]`, both
`structured: true`, both `errorCode: MCP_METADATA_LIST_FAILED` with `prerequisite: null` and
`salesforceErrorCode: null` — which is the second defect, and the reason the two are recorded together.

## 1. Gate results

Run 2's eleven gates. A gate is `PASS` only when every leg of it is; `NOT TESTED` never upgrades to `PASS`,
which is why the overall result is `PARTIAL` and not `PASS`.

| Gate | Result | What it establishes |
| --- | --- | --- |
| `toolInventory` | PASS | the session advertises **24** Tools, set-equal to the snapshot's grant, and the pair's advertised input keys are exactly the contracted ones with the right hints |
| `listedInventory` | PASS | `ValidationRule` listed **245** components, every one present in the harness's independent read, in the Tool's own sort order |
| `pairRoundTrip` | PASS | a name the org actually stores — `APIS管理组%2F业务员`, chosen *because* it carries an escaped separator — survives listing → reading byte-exact |
| `newTypeListing` | PASS | a type the widening admitted (`NamedCredential`) lists **3** components, and one of them reads back to a file |
| `missingComponent` | PASS | a component that does not exist is a **structured refusal**, never an empty success |
| `inactiveDefault` | NOT TESTED | none of `Profile`/`ValidationRule`/`Flow` holds a component this org marks inactive, so the default had nothing to filter (§3) |
| `budget` | PASS | the reader's declared budgets are the reported budgets, on a real `Profile`: 1 file, 5 763 bytes, `truncated: false` |
| `allowlistCoverage` | PASS | **21 of 21** allowlisted types served by this org; zero refusals, zero unstructured refusals |
| `surface` | PASS | 28 Tool-call windows, **zero SOQL statements**, and every type the Tool asked the org for is one the allowlist admits |
| `credentialSafety` | PASS | 28 Tool responses inspected for 2 live secrets, `offenders: []` |
| `auditPersistence` | PASS | 28 snapshots enqueued, 28 persisted, 0 dropped, queue drained and depth 0 |

### 1.1 The pair's advertised contract

The advertised inventory was **24 Tools**, asserted equal to the snapshot's grant by **set equality** rather
than containment — the same shape T2 and T3 use, and the reason a Tool that vanished from the session would
fail the gate instead of merely shrinking it.

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | advertised input keys |
| --- | --- | --- | --- | --- |
| `list_metadata_components` | `true` | `false` | `true` | `developerNamePrefix`, `includeInactive`, `limit`, `metadataType` |
| `get_metadata_component_context` | `true` | `false` | `true` | `fullName`, `metadataType` |

No Tool accepts a username, a directory, a manifest or an output path — asserted as a set equality on the
advertised keys, not as a scan for a list of forbidden names, so a **fourth** name cannot slip in unnoticed.
`manifest` is the one this pair must never accept: the server generates the single-member manifest itself.

### 1.2 The surface: two Metadata API calls and no SOQL at all

The harness brackets each Tool call and asserts only inside the bracket, so the scaffolding's own reads
cannot be folded into a claim about the Tool. The run bracketed **28 Tool-call windows** in total, and what
they show:

| | `list_metadata_components` | `get_metadata_component_context` |
| --- | --- | --- |
| SOQL statements | **0** | **0** |
| Salesforce calls the Tool made | `purpose = METADATA_LIST` | `purpose = METADATA_RETRIEVE` |
| Endpoint | `POST /services/Soap/m/68.0`, API v68.0 | `POST /services/Soap/m/68.0`, API v68.0 |
| `apiCategory` | `METADATA_API` | `METADATA_API` |

`surface.requestedTypes` is 21 with `offAllowlist: []`: the check is on the **wire**, which is the only place
that can see which type the Tool itself sent, since the schema can only refuse a type the caller named.

## 2. The allowlist, measured type by type

### 2.1 Every allowlisted type, run 2

One listing call per type, `limit: 1` — the gate asks only "does this org list this type to this identity?",
which is what `A-4` is a fact about. `totalCount` is the pre-slice count, so it is the type's real size on
this org even where the run returned a single row.

| Type | Status | `totalCount` | First component (as the org stores it) |
| --- | --- | ---: | --- |
| `CustomObject` | LISTED | 343 | `Account` |
| `CustomField` | LISTED | 6 946 | `Account.Account_Belong_Group__c` |
| `ValidationRule` | LISTED | 245 | `Account.Account_03_Required_Value` |
| `Flow` | LISTED | 239 | `Accept_Lead` |
| `ApexClass` | LISTED | 1 494 | `AcceptAdjustmentBatch` |
| `ApexTrigger` | LISTED | 71 | `AccountGradeApplicationTrigger` |
| `Layout` | LISTED | 651 | `Account-Account Layout` |
| `FlexiPage` | LISTED | 191 | `Account_Record_Page` |
| `EmailTemplate` | LISTED | **0** | — |
| `NamedCredential` | LISTED | 3 | `a2UJ400000037fWMAQ_Product_001` |
| `CustomMetadata` | LISTED | 864 | `AccountTermInfo_Schedulable_Share.X1000_10` |
| `QuickAction` | LISTED | 343 | `Account.AccountActiveApproval` |
| `RecordType` | LISTED | 183 | `Account.Account` |
| `DuplicateRule` | LISTED | 25 | `Account.Account_Name_Duplicate_Rule` |
| `AssignmentRule` | LISTED | **0** | — |
| `AutoResponseRule` | LISTED | 1 | `Case.示例个案自动响应规则` |
| `EscalationRule` | LISTED | **0** | — |
| `SharingRules` | LISTED | 210 | `Account` |
| `Workflow` | LISTED | 24 | `Account` |
| `PermissionSet` | LISTED | 42 | `CXG_Canvas_App_Assignment` |
| `Profile` | LISTED | 65 | `APIS健康管业OP` |

**A `LISTED` with `totalCount: 0` is an answer, not a gap.** `EmailTemplate`, `AssignmentRule` and
`EscalationRule` list successfully and hold nothing. The distinction the Tool draws is between that and a
type it could not look at, and §2.5 is the negative half of the same contract.

### 2.2 The round trip, on a name that would break if anything decoded it

The subject was not invented by the harness: it was taken **out of the listing**, preferring a name that
carries an escaped separator, because a decoded name addresses a *different* component — or none — and a
retrieve of the wrong component still succeeds.

```
listing:   Profile → fullName  APIS管理组%2F业务员
reader:    fullName echoed     APIS管理组%2F业务员   byteExact: true
           returnedFiles 1, returnedBytes 5 763, truncated false
           samplePaths: ["profiles/APIS管理组%2F业务员.profile-meta.xml"]
```

`chosenBecause: URL_ESCAPED_SEPARATOR` records that the run measured the case that matters rather than the
easy one, and `escapedNameInFilePath: true` is the proof that the bytes arrived undecoded: the name in the
path the org returned is the same escaped string. A reader that had decoded `%2F` into `/` would have asked
for a different profile, or for none.

### 2.3 A type the widening admitted

`NamedCredential` is one of the thirteen types the widening added (the original eight were `CustomObject`,
`CustomField`, `ValidationRule`, `Flow`, `ApexClass`, `ApexTrigger`, `Layout`, `FlexiPage`), and it was
measured rather than assumed:
independent read **3**, listed **3**, returned **3**, and `a2UJ400000037fWMAQ_Product_001` read back to one
file. A new type is a claim about this org, so the gate spends a call on it instead of extrapolating from the
eight types T0 had already probed.

### 2.4 The budget, measured on the type the prohibition names

The T4 prompt forbids returning an over-budget component, "Profile 类尤其". One real `Profile` was read and
both mechanisms were compared against the numbers the response **claimed**:

| | Declared | Reported | Outcome |
| --- | --- | --- | --- |
| `maxReturnedFiles` | 40 | 40 | 1 file returned |
| `maxFileBytes` | 65 536 | 65 536 | 5 763 bytes in the file |
| `maxTotalBytes` | 262 144 | 262 144 | 5 763 bytes total |
| `maxFileSummaries` | 100 | 100 | 0 omitted files |

`truncated: false` with `omittedFiles: 0` — the honest direction: this Profile fits, and the run says so
rather than declaring a bound it did not approach. The over-budget path itself (a component that does **not**
fit) is not exercised by this run; §3 records it.

### 2.5 A component that does not exist is a refusal, not an empty answer

`P10_T4_No_Such_Component` came back as `isError: true`, `errorCode: MCP_METADATA_CONTEXT_FAILED`,
`returnedFiles: 0`, `declared: true`. This gate exists because the failure it prevents **reads as success**:
`retrieve` answers an unknown member with an empty package rather than an error, so an adapter that returned
an empty file list as `success: true` would tell an investigator "this component is empty" when the truth is
"there is no such component". The two readings have opposite consequences, which is the same argument §2.1's
zero-count answers rest on.

### 2.6 Where the Tool's enablement actually lives on this deployment

Measured in the Control Plane (`sfoa_tool_control`), not inferred: **there is no row for
`list_metadata_components`** — and it is the only advertised Tool missing one, 23 rows covering the other
23 — and none for T3's `explain_field_access` either. T2's `get_metadata_component_context` row dates from
the **2026-08-26 seed** (`updatedAt` 2026-08-26T13:32:56Z). The P9-era enablements are visible as rows with
their own dates (`get_org_limits` 2026-09-28T17:25:11Z, `search_records` 2026-09-28T17:25:20Z).

So on this deployment both P10 Tools are **default-disabled and not enabled through the Console** — which is
the configured state, not a defect — and both live milestones prove them by granting them **in memory**
(§0). A reader of the audit (§5) is therefore reading a Tool that a real caller cannot reach yet, and a
reader of the Console sees it as a `METADATA_READ` entry carrying the A-4 declaration that can be enabled by
name. The Console's record is generated from `SFOA_CONTEXT_TOOL_NAMES`, so the widening needed no catalog
source change; the dependency line ("per-type readability of the allowlisted metadata types (A-4)") is the
one place an Admin is told that this Tool's prerequisite is a per-*value* fact rather than a per-Tool one.

## 3. What this run does not prove

- **`includeInactive`'s default was never exercised positively.** The gate probed `Profile` (65 entries, 0
  deleted), `ValidationRule` (245, 0) and `Flow` (239, 0): this org holds **no** component whose
  `manageableState` is `deleted`, so a run that called the Tool with the flag on and one that left it off
  would return the same listing. The default is unit- and protocol-tested; what is missing is an org with a
  recycled component in it. This is the single reason the overall result reads `PARTIAL`.
- **The over-budget path is not exercised.** §2.4 measures a Profile that *fits*. Nothing in this run made
  `trimToByteBudget` cut, so "Profile 类尤其" is satisfied as a measured non-event plus the reader's declared
  bounds, not as an observed truncation. A profile with thousands of field-level entries would be the case.
- **`EscalationRule`'s zero has one evidence source.** ADR-0032's Consequences records this: `AssignmentRule`
  and `AutoResponseRule` were cross-checked against the Tooling objects of the same name (0 and 1, both
  agreeing), but the Tooling API has **no** `EscalationRule` object on this org, so its `totalCount: 0` rests
  on `listMetadata` alone. A false zero here is indistinguishable from a true one — the exact failure mode
  §1.2's wire check exists to make impossible on the *refusal* side, and it cannot help on this one.
- **One org, one identity, one API version.** Everything here is CHN5S through the fixed DIAGNOSTIC identity
  at v68.0. A production org's per-type authorization profile can differ type by type, and `A-4` is precisely
  the kind of fact that differs per org — which is why it is declared per type rather than assumed.
- **The Console's enablement was not performed.** §2.6's catalog claims are read from the deployment's
  database and from the catalog code; nobody opened the Console and enabled either Tool, and no live call
  went through the real gateway without the in-memory grant. Same shape as T3's outstanding human Setup
  check, and recorded as an open item (§6).
- **`manageableState` is recorded but never asserted as a live/inactive signal on this run.**
  `INACTIVE_MANAGEABLE_STATES` is unit-tested against fixtures; §3's first bullet explains why no live
  component on this org could contradict it.

## 4. What the live run found

Both findings are in **product** code, and neither was reachable from a fixture. §4.1 is about the org's
Metadata API surface; §4.2 is about the shape Salesforce's errors actually arrive in.

### 4.1 Two of the prompt's type names are not this API's names

Run 1 admitted the twenty-two types the T4 prompt listed and the org refused two of them. Both refusals were
**structured** (`structured: true`) — the degradation contract held — and both said the same thing:
`INVALID_TYPE: Unknown type`. The measurement:

- **`SharingRule` is `SharingRules`.** The singular answers `INVALID_TYPE: Unknown type:SharingRule`. This
  org's `describeMetadata` declares **204** types, and the plural is among them: it lists **210** components
  (`Account`, `CXG__DataLibrary__c`, `Project_Proposal__c`, …). The Metadata API has also used `SharingSet`
  historically, and this org answers `Cannot use: SharingSet in this organization` — so the plural is the
  name that serves the capability and the historical alias is not a substitute.
- **`CustomSetting` is not a Metadata API type at all.** It answers `INVALID_TYPE: Unknown type:CustomSetting`
  and appears in none of the 204 declared types. The capability the prompt named it for — a custom-settings
  inventory — is **already served by `CustomObject`**, which is on the allowlist: this org holds **8** custom
  settings (`GlobalSetting__c`, `SkipTrigger__c`, `OAToken__c`, `File_Import_Max_Row__c`, …) and **8 of 8
  appear in the `CustomObject` listing**. Substituting a third type to keep the count at twenty-two was
  rejected: it would widen the allowlist past the prompt's own list without a question for the new entry to
  answer.

So the allowlist is **twenty-one**, and ADR-0032 §8 records the two corrections rather than applying them
silently. Two details are worth keeping: the **first measurement of `CustomSetting` was vacuous** — an
earlier probe used `EntityDefinition.CustomSettingsType`, which answers `INVALID_FIELD`, so it produced
"0 of 0" and proved nothing; it was thrown away and re-measured as `SELECT QualifiedApiName FROM
EntityDefinition WHERE IsCustomSetting = true`. And the `CustomObject` cross-check is what makes the removal
defensible rather than merely convenient: the capability is verified present, not assumed transferable.

### 4.2 The per-type refusal branch was dead code, and only a refusing type could say so

This is the run's most valuable finding, and it is the reason the two defects are recorded together: run 1's
refusals were structured, but they were structured **wrongly**.

`METADATA_LIST_UNAVAILABLE_CODES` is the set of Salesforce codes that mean "this org will not list this type
to this identity" — the codes that turn a failure into `MCP_METADATA_TYPE_UNAVAILABLE` with
`prerequisite: 'A-4'`, which is the whole degradation contract of ADR-0029 §3. Run 1 reported both refusals
as **`MCP_METADATA_LIST_FAILED` with `prerequisite: null` and `salesforceErrorCode: null`**: a per-type
authorization fact reported as a retryable API failure. Reading the shape the org actually produced showed
why:

```
error.errorCode  = 'sf:INVALID_TYPE'     ← at the top level
error.data.errorCode = 'sf:INVALID_TYPE' ← and again under `data`
```

jsforce **namespaces** Metadata API error codes with an `sf:` prefix. The shared reader
(`readSalesforceFailure` in `mcp-provider-sfoa-data`) validates every code against
`ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/u` — identifier-shaped, no colon — and returns `null`
rather than echo a string it cannot vouch for. That is correct behaviour for a sanitizer four other Tools
depend on, and it made **every code in the set** classify as `null`, so the branch that produces
`MCP_METADATA_TYPE_UNAVAILABLE` could never be reached.

The fix strips the `sf:` namespace **inside `mapMetadataListFailure`** — at the one place that has to
classify — rather than widening a sanitizer whose strictness the other providers rely on. Both branches now
also carry `salesforceErrorCode`, so a reader sees the code even when the classification is the generic one.
The unit tests had not caught it because they threw bare codes; they now throw the measured shape
(`errorCode` at the top level **and** under `data`, message `INVALID_TYPE: Unknown type:…`), and the two
regression tests are the ones that would fail if the namespace were ever dropped again.

**Why this is the argument for live gates.** The degradation contract was written, reviewed, unit-tested and
**dead on arrival**. Its unit tests passed because they tested the shape the author had in mind rather than
the shape the org sends. Only an org that refuses a type could say so — and then only a reporter that keeps
the platform's own code, which run 1 did.

### 4.3 A second instrument agrees, on the probe's own terms

The P10 diagnostic probe iterates the Tool's exported constant, so the widening extended it by construction:
the run after the fix reports `METADATA_ALLOWLIST_COVERAGE` with `allowlistSize: 21` and the twenty-one names
written out, plus **one `METADATA_LIST_<TYPE>` step per type — 21 of 21 `AVAILABLE`**. Totals for the probe:
**60 steps, 55 `AVAILABLE`, 5 `DENIED`, 0 `ERROR`**, exit code 0.

The five `DENIED` steps are not T4 defects and are worth naming so a later reader does not chase them: four
are the red line's own business-object probes (`SELECT Id FROM Lead` / `Account` / `Value_Bill__c` /
`Order__c` through the Tooling API — all `INVALID_TYPE: sObject type … is not supported`, which is the
boundary working), and one is `TOOLING_TRACE_FLAG_CREATE_USER_SELF` answering
`FIELD_INTEGRITY_EXCEPTION` ("a tracking flag already covers this entity") because the org already had a
flag on that user — environment state, not a regression.

## 5. Audit verification (P7)

Read with `yarn ai:audit --tool <Tool> --since 24h --latest 20` against the same database the runtime
writes to. **Every row is `executionRole = DIAGNOSTIC` and `identitySource = INTERNAL_SERVICE_HEADER`.**

| | `list_metadata_components` | `get_metadata_component_context` |
| --- | --- | --- |
| Rows in the 24-hour window | the reader's cap filled: `limit: 20`, 20 rows returned, so the window's earlier rows were cut — run 1's calls and run 2's pre-sweep calls | **8** — under the cap, so this is the window's whole content |
| Tool-level tally | 20 × `PASS`, `errorCode` none | 6 × `PASS`, 2 × `ERROR`/`MCP_METADATA_CONTEXT_FAILED` |
| Salesforce calls recorded | 20 × `purpose = METADATA_LIST` | 24 × `purpose = METADATA_RETRIEVE` (3 per row) |
| Endpoint | `/services/Soap/m/68.0`, v68.0 | `/services/Soap/m/68.0`, v68.0 |
| Identity-layer calls beside them | 20 × `IDENTITY_TOKEN_EXCHANGE` + 40 × `IDENTITY_AUTHENTICATION` | 8 × `IDENTITY_TOKEN_EXCHANGE` + 16 × `IDENTITY_AUTHENTICATION` |
| `occurredAt` span of the archive | 01:55:07.483 → 01:55:29.900 (run 2's coverage sweep) | 01:38:29.760 → 01:55:03.982 (both runs) |

- **The purpose split is the only thing that distinguishes the halves.** Both Tools call the same endpoint
  with the same `apiCategory = METADATA_API`; `METADATA_LIST` against `METADATA_RETRIEVE` is what the P7
  trail uses to tell a listing from a reading, which is why ADR-0032 §10 made the listing carry its own
  value instead of reusing the reader's.
- **The two `ERROR` rows are the `missingComponent` gate's own probes** — one per run, each
  `MCP_METADATA_CONTEXT_FAILED`, §2.5's designed refusal. **A run that produced no such row would have
  failed the gate**, exactly as T3's boundary probes work. Both are on the *reader*, which is correct: the
  probe asks the reader for a component that does not exist.
- **`auditPersistence` closed the loop on run 2**: 28 enqueued, 28 persisted, 0 dropped, `queueDepth: 0`,
  `writerState: STOPPED`, shutdown drained, `forcedConnections: false`.
- **The listing's Salesforce calls are 20 `METADATA_LIST` calls and no SOQL**, which is the audit-side
  confirmation of §1.2's wire gate: the pair reaches the Metadata API and nothing else.
- **No credential material in any response.** The milestone's own gate scanned all 28 Tool responses of
  run 2 for the live client token and access token (`secretsSearched: 2`, `offenders: []`).

Two properties of the trail are inherited from T2 and T3 rather than introduced here, and a later reader
should not mistake either for a T4 symptom:

- **`auditIntegrityStatus = PARTIAL` on every row.** The same status, and the same `evidenceIntegrity`
  detail, as the P9-era `query_records` rows. It reflects evidence this deployment does not capture (no agent
  or model context on these calls), not anything the metadata pair did.
- **`firstFailure` reports `INVALID_TYPE` on `SELECT Id FROM ScratchOrgInfo limit 1` (v51.0)** — jsforce's
  own connection warm-up probe, asking an org that is not a scratch org. It is why a row can carry the
  identity layer's failed warm-up beside a Tool call that succeeded; the Tool's own calls are the ones
  carrying `METADATA_LIST` / `METADATA_RETRIEVE`.

## 6. Open items carried out of T4

- **`includeInactive` needs an org with a recycled component** (§3). The default, the filter and the echo are
  unit- and protocol-tested; only a live positive case is missing, and it is what keeps run 2 at `PARTIAL`.
- **The over-budget truncation path has no live leg** (§3). A Profile large enough to make
  `trimToByteBudget` cut would exercise it; the gate measured a Profile that fits.
- **`EscalationRule`'s zero rests on one method** (§3, ADR-0032 Consequences). The Tooling API has no
  matching object on this org to cross-check against.
- **Neither P10 Tool is enabled through the Console** (§2.6). `explain_field_access` and
  `list_metadata_components` have no `sfoa_tool_control` row on this deployment; both milestones grant them
  in memory. Enabling one and calling it through the real gateway without the wrapper is the remaining
  end-to-end step.
- **The prompt's human cross-check — "与 org 界面数量核对"** — is half done. `listedInventory` in §2 is a
  machine comparison of the Tool's listing against an independent `metadata.list` read on the same identity,
  membership and order, which is the strongest check the harness can make alone. A person opening Setup and
  reading the count for a type is the other half, and it is the one the prompt names explicitly (the same
  item T3 carries).
- **`A-1`** — cross-user `ApexLog` visibility — remains a production deployment check (T2 §6), and `A-4`'s
  per-type answer is measured here **for this org only**; a production deployment re-measures it by running
  the same milestone.
- The throwaway probes used on the host while measuring §4.1 and §4.2 were removed from the host after the
  measurement; the reports and the audit rows are what they were for.

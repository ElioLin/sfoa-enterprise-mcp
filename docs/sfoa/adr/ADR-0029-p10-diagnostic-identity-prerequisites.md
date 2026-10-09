# ADR-0029: P10 diagnostic identity prerequisites, degradation contract and enablement surface

- Status: Accepted for P10
- Date: 2026-09-30
- Extends: ADR-0009 (the server-owned DIAGNOSTIC request scope), ADR-0027 (`get_org_limits` on the
  DIAGNOSTIC identity, and the first measurement of what that identity can read), ADR-0024/ADR-0025/ADR-0026
  (the P9 Tool contract: bounded completeness, explicit truncation, structured errors), ADR-0028
  (export over the official SDK)
- Evidence: [`docs/sfoa/P10_T0_LIVE_PROBE_FINDINGS.md`](../P10_T0_LIVE_PROBE_FINDINGS.md), produced by
  `packages/sfoa-mcp-server/src/validation/p10-diagnostic-probe.ts` (`yarn workspace @sfoa/mcp-server probe:p10`)

## Context

P9's lesson was that a design assumption about what a routed identity may read has to be measured
before anything is built on it. `get_org_limits` was designed against the belief that a business
integration identity could read `Connection.limits()`; the live probe disproved it for every identity
the deployment could route, and the Tool had to be re-homed onto the DIAGNOSTIC scope (ADR-0027).

P10's six Tools lean on that identity far harder than `limits()` did. They read the platform's
execution log, its trace configuration, its change ledger and its permission tables — the class of
read a business identity is refused by design — and one of them **writes**. So T1 measured the
prerequisites first, and this ADR is the record of what that measurement obliges.

Four findings change the design rather than merely confirming it, and each is carried into the T2–T5
sections of `P10_EXECUTION_PROMPTS.md` as a revision note with the original prompt text left intact:

1. **`set_trace_flag` cannot be create-only.** Creating a `TraceFlag` for an entity that is already
   traced with an overlapping window is refused with `FIELD_INTEGRITY_EXCEPTION`. The most ordinary
   call the Tool has — "trace this user for the next hour" — fails the second time it is used.
2. **The Apex log parser must follow the log's own header version.** Two distinct log format versions
   (54.0 and 56.0) were observed against a v68.0 org.
3. **No P10 Tool may match on a human-readable Salesforce label.** `ApexLog.Status` matched 1 row in
   English and 8 in the localized literal; `SetupAuditTrail.Section` and `Profile.Name` are translated
   too. Every one of these failures is silent — fewer rows, no error.
4. **`SetupAuditTrail` counts live in `totalSize`.** `SELECT COUNT(Id)` is refused outright and
   `SELECT COUNT()` returns a record-less body whose `totalSize` carries the number.

And one finding leaves a question open that this ADR has to handle honestly rather than close: the
probe could only ever see **ApexLog rows whose `LogUser` is the diagnostic identity itself**. That is
consistent with ownership alone and does **not** demonstrate `View All Data`. Whether the identity can
read logs written by *another* user is therefore a deployment check (§3), not an established fact —
the same self-correction P9 made about `limits()`, applied before the mistake instead of after.

## Decision

### 1. Minimum permission prerequisites, per Tool

`AVAILABLE` below means *measured on this deployment through the exact Connection the Tools open*, and
carries the probe's row. Nothing here is inferred from Salesforce documentation.

| P10 Tool | Surface it reads or writes | Prerequisite | Measured |
| --- | --- | --- | --- |
| `get_apex_logs` (T2) | Tooling `ApexLog` — 13 fields, all required ones present | `View All Data` **to see logs written by other users**; ownership alone suffices for its own | `AVAILABLE` for the identity's own logs; **cross-user visibility NOT ESTABLISHED** — see §3 |
| `get_debug_log_body` (T2) | `GET /tooling/sobjects/ApexLog/{id}/Body` | same as above; the body is not a SOQL field | `AVAILABLE` (string, 1 214 bytes / 25 lines sampled) |
| `set_trace_flag` (T2) | Tooling `TraceFlag` (write), `DebugLevel` (write), `ApexClass`/`User` (read, to resolve a target) | `Author Apex`-class trace administration; `DebugLevel` create | `AVAILABLE` — `CLASS_TRACING` on an `ApexClass` and `DEVELOPER_LOG` on **another user** both created and verified deleted; `DebugLevel` create verified deleted |
| `explain_field_access` (T3) | `FieldPermissions`, `ObjectPermissions`, `PermissionSetAssignment`, `PermissionSet`, `Profile`, `RecordType`, `User` | `Manage Users`-class visibility of other users' assignments | `AVAILABLE` **including a cross-user read by `AssigneeId`** (non-zero result — proof, not ambiguity) |
| `list_metadata_components` (T4) | Metadata API `listMetadata` over an allowlisted type set | Metadata API access | `AVAILABLE` for `ValidationRule` (245), `NamedCredential` (3), `Profile` (65); the other T4 types are **unmeasured** |
| `get_metadata_component_context` (T4, extended) | Metadata API retrieve over 8 (→22) allowlisted types | as above | `AVAILABLE` — already shipping |
| `get_platform_diagnostics` (T5) | `AsyncApexJob`, `CronTrigger`, `SetupAuditTrail`, `ApexLog` | read access to platform status objects | `AVAILABLE` for all four |
| `run_diagnostic_tooling_query` (existing) | Tooling SOQL SELECT | Tooling API access | `AVAILABLE` |
| `get_org_limits` (existing) | REST `GET /limits` | `View Setup and Configuration` | `AVAILABLE` — 73 keys, reproducing ADR-0027 |

Two measured constraints are prerequisites in their own right because a Tool that ignores them returns
a quietly wrong answer rather than an error:

- **`SetupAuditTrail` filterability is per field.** `CreatedDate`, `Action` and `CreatedById` filter;
  `Section` and `Display` do **not** (`INVALID_FIELD`, *"field 'Section' can not be filtered in a query
  call"*). A timeline narrowing by `Section` — the field whose name most suggests "just the Apex
  changes" — is not a narrowable view.
- **`CronTrigger` is genuinely empty on this org** (0 rows). Its emptiness is a fact, not a fault, and
  §4 is written so the two cannot be confused.

### 2. Nothing here is a code problem, so it is a deployment problem

The probe settles what code can settle. What it cannot is a permission the deployment has not granted,
and ADR-0026's failed remedy — "grant a business identity `View Setup and Configuration`" — is the
precedent for saying so plainly instead of widening an identity to make a read work.

**Org-admin prerequisites, none of which is solvable in code:**

| # | Prerequisite | Why code cannot supply it | If missing |
| --- | --- | --- | --- |
| A-1 | The diagnostic account can read **other users'** `ApexLog` rows (`View All Data` or equivalent) | Visibility is an org permission on the account, not a query the Tool can widen | `get_apex_logs` returns only the diagnostic account's own logs. Useless for support and **indistinguishable from a quiet org** unless §4 is implemented |
| A-2 | `ApexLog` retention long enough for the support window | Platform policy; not exposed to SOQL at all | Logs for the incident are already gone. The oldest retained row (2026-04-08 for `SetupAuditTrail`) is the only bound discoverable |
| A-3 | The diagnostic account's licence permits trace administration on other users | Licence/permission model | `set_trace_flag` cannot serve its primary use case. **Measured as working on this deployment**, so this is a re-check for other orgs, not a known gap |
| A-4 | The T4 metadata types beyond the three probed are retrievable by this identity | Per-type entitlement | `list_metadata_components` fails for that type only; per §4 it must say so per type |

**Production enablement preconditions and check steps** — to be run in order, on the production org,
before any P10 Tool is enabled there:

1. Configure the diagnostic identity and bring it to `verificationStatus = PASS`. This is the existing
   P6/P9 procedure and it already gates every diagnostic Tool at startup
   (`MCP_DIAGNOSTIC_CONFIGURATION_INVALID`) and on every `tools/call` (`assertDiagnosticSnapshotValid`).
2. **Run `probe:p10` against production with writes off.** It is read-only by construction there: the
   write legs are gated on the org's own `IsSandbox` answer and the `P10_PROBE_WRITE_PROBES` variable can
   only force *off*, never on. The output is the production capability record, and it is the reason the
   probe was kept in the repository rather than deleted like P9's was.
3. **Resolve A-1 explicitly.** Query `ApexLog` in production and check whether any row's `LogUser` is a
   user other than the diagnostic account. If none is visible, `get_apex_logs` is not fit for production
   support and A-1 must be granted before it is enabled — do not enable it and discover this from an
   empty result during an incident.
4. Re-run step 2 after any change to the diagnostic account's permissions, and record the output.
5. Enable Tools one at a time in the Console, under the §5 declaration.

### 3. A missing prerequisite is an error, never an empty result

The failure this contract exists to prevent is not a crash. It is a Tool that cannot read its source,
returns `[]`, and is read by an agent — and by the human reading the agent's summary — as **"there were
no anomalies"**. That is worse than an error, because it is actionable-looking. ADR-0026's
`MCP_LIMITS_READ_FAILED` set the precedent with the sentence *"an org that answered with nothing
readable is not an org without limits"*; this ADR makes it a contract across all six Tools.

**The contract.**

- **A Tool that cannot read a source it was asked about fails**, with a structured error naming the
  missing prerequisite, and never returns a successful result describing an absence:
  - `errorCode`: `MCP_DIAGNOSTIC_PREREQUISITE_MISSING`
  - `prerequisite`: the stable identifier from the §2 table (`A-1`, `A-2`, …) or the measured
    constraint it tripped (e.g. `APEX_LOG_CROSS_USER_VISIBILITY`)
  - `suggestion`: names the deployment-list entry — the §2 table is the deployment list, and this field
    points at it by identifier so an operator has one thing to read
  - the underlying Salesforce `salesforceErrorCode` when there is one
- **A source that is genuinely empty is a result, and says so as a fact.** `CronTrigger` returning 0
  rows is the correct answer on this org and must not be reported as a fault. The distinguishing
  information is *whether the source was read*, which is the next rule.
- **An aggregating Tool reports per-source status, not one global one.** `get_platform_diagnostics`
  fans out over four sources, so each section declares its own state — `READ` with a row count, or
  `UNAVAILABLE` with the prerequisite identifier. A single `success: true` over a payload where one
  section silently failed is exactly the ambiguity this contract removes. `get_apex_logs` and
  `get_debug_log_body` have one source each and fail whole.
- **Never filter on a human-readable label.** The localization finding (§Context 3) is the same class
  of silent-empty as a refused read, and the same rule covers it: match on the API enum, never on the
  translated label, and never present a translated label as a comparison key.
- **The contract is asserted by unit test, not by convention.** Each Tool's suite covers the
  prerequisite-missing path and asserts a structured error — and, for `get_platform_diagnostics`, one
  section `UNAVAILABLE` beside three `READ` sections.

### 4. The §0.3 red line, as a declaration with evidence

This section is the formal filing of the 2026-09-30 hard boundary. It states the whitelist per Tool,
the technical basis for each half of the guarantee, and the re-review of the three Tools that predate
it.

#### 4a. Query-target whitelist, per Tool

Hardcoded in the implementation and asserted by unit test; a query outside the row is a failure, not a
narrowing.

| Tool | Objects it may touch | API | Basis business rows are unreachable |
| --- | --- | --- | --- |
| `get_apex_logs`, `get_debug_log_body` | `ApexLog` | Tooling | Tooling API (measured) + whitelist |
| `set_trace_flag` | **write:** `TraceFlag`, `DebugLevel`; **read:** `ApexClass`, `User` | Tooling | Tooling API (measured) + whitelist; DML is structurally confined to two Tooling types ≤60 min |
| `explain_field_access` | `FieldPermissions`, `ObjectPermissions`, `PermissionSetAssignment`, `PermissionSet`, `Profile`, `RecordType`, `User` | Standard | **whitelist only** — see below |
| `get_platform_diagnostics` | `AsyncApexJob`, `CronTrigger`, `SetupAuditTrail` (**narrowed from four by ADR-0033** — see §5) | Standard | **whitelist only** |
| `list_metadata_components`, `get_metadata_component_context` | Metadata API types from a fixed allowlist | Metadata | Metadata carries component definitions, not records |
| `run_diagnostic_tooling_query` | any Tooling type | Tooling | Tooling API (measured) — **no whitelist in code; see 4b** |
| `get_org_limits` | none (quota counters) | REST `/limits` | No object, field, row or id in the payload |

**The guarantee is split by API, and the split has to be stated because only one half is structural.**

- **Through the Tooling API, the platform enforces it.** Measured on this deployment, through the
  diagnostic Connection, with a system-type control: `ApexClass` resolves and returns a row;
  `Lead`, `Account`, `Value_Bill__c` and `Order__c` each fail with `INVALID_TYPE`, *"sObject type '…' is
  not supported."* Two of those four are **custom** objects, which matters because the Tooling API does
  document custom-object support — the refusals are not a standard-object accident.
- **Through the standard API, nothing enforces it but our code.** The same identity read **955 `Lead`
  rows** over the standard API. The identity is not weak; the Tooling API is narrow. So for the Tools
  that use the standard API — `explain_field_access` and all three of `get_platform_diagnostics`'
  sources — the whitelist **is** the entire guarantee, and a future code path that reached the standard
  API with a business object would be stopped by nothing the org does.

That is why §0.3.1's "hardcoded and unit-test asserted" is not a stylistic rule. For half the surface
it is the only control that exists.

#### 4b. Re-review of the three pre-existing diagnostic Tools

| Tool | Compliant? | Finding |
| --- | --- | --- |
| `get_org_limits` | **Yes** | The payload is org quota counters — no object, field, row or record id. Measured 73 keys. Its executor already carries `assertDiagnosticScope` and maps refusals to `MCP_LIMITS_ACCESS_DENIED`. Nothing to change. |
| `get_metadata_component_context` | **Yes, with one item to pin** | Its type allowlist is hardcoded (`METADATA_CONTEXT_TYPES`, 8 types) and unit-tested, and Metadata carries component definitions rather than rows. The item to pin: the Tool's description says it retrieves *"one allowlisted component"*, while the implementation reads every metadata file the official retrieve produced under `force-app/main/default` (bounded to 40 files / 256 KiB). If a retrieve returns dependent components, more than one component's definition is returned. That is a **description-vs-behaviour mismatch to verify and correct**, not a red-line breach — metadata is Setup-layer either way. Assigned to T4, which owns that Tool. |
| `run_diagnostic_tooling_query` | **Meets the red line today; does not meet §0.3.1's letter** | Its input is a free-form Tooling SOQL `SELECT`, validated for single-statement and no `FOR UPDATE` but **not against an object whitelist**. Its safety rests entirely on the Tooling API's structural refusal — which §4a now measures across four business objects and a control, and which is a genuine guarantee. But §0.3.1 requires the query target to be in a hardcoded, unit-tested whitelist, and this Tool is the one diagnostic Tool where that is not true. |

**Proposed fix for `run_diagnostic_tooling_query`, and why it is a proposal rather than a patch.** The
Tool's value is that an operator can ask an arbitrary Tooling question during an incident; the fix must
not turn it into a fixed set of canned queries. The narrow fix is a **first-line object check**: extract
the top-level `FROM`/`USING` targets from the statement and refuse anything outside the diagnostic type
allowlist before the call reaches Salesforce, with the platform's own `INVALID_TYPE` remaining as the
backstop. It is defence in depth and it must be described as such — a regex over SOQL is not a parser,
and a crafted statement could evade the extraction. That is acceptable **only** because the backstop is
measured and structural: an evasion is answered with `INVALID_TYPE`, not with rows. Implementing it is
**not** T1's scope (T1 adds no Tool behaviour) and it is assigned to T2, which already opens this file's
neighbourhood for `set_trace_flag`, with this ADR as its specification.

#### 4c. Enablement surface: the decision

The prompt frames this as *hard architectural restriction* ("diagnostic Tools enableable only on the
DIAGNOSTIC route") **vs** *console data-surface declaration + explicit Admin confirmation*. The first
option as worded cannot be built, and saying so is more useful than picking it:

**Measured structure, from the code rather than from the plan.**

- Tool enablement is **global and deployment-wide**. In MySQL mode `enabledTools` is one set loaded from
  the Control Plane (`loadMySqlDiscoveryPolicySnapshot`); there is no per-route enablement to restrict.
  ADR-0027 already recorded this: *"Tool enablement is global, so 'operators may call it, business users
  may not' is not expressible here."*
- The diagnostic identity is a **single deployment-wide row** (`sfoa_diagnostic_config`, `id: '1'`).
  `snapshotDiagnosticRoute(snapshot, platformUserId)` pairs that one account with whatever caller made
  the request.
- **No caller-to-diagnostic binding exists.** `sfoa_identity_route` has no role or entitlement field, and
  `assertDiagnosticSnapshotValid` checks only that a diagnostic row *exists* — never who is calling.
  Any principal the gateway routes to this server executes as the diagnostic account once a diagnostic
  Tool is enabled.

So "enableable only on the DIAGNOSTIC route" presupposes a route-scoped enablement that this
architecture does not have. A faithful hard restriction would have to be a **new per-caller entitlement**
— a Control Plane column plus migration plus Console surface plus its own regression suite.

**Recommendation: the layers, in this order — and the order is the decision.**

1. **Console data-surface declaration + explicit Admin confirmation is accepted as P10's governance
   form.** The declaration must name the execution identity (*"this Tool reads system-layer data using
   the system diagnostic identity, regardless of which platform user calls it"*), the data surface, and
   the write privilege for `set_trace_flag`. It is a **field of the enablement action**, not a dismissible
   warning: enabling a diagnostic Tool without it is refused.
2. **A per-caller entitlement is recommended as the structural follow-up, and is specified but not
   built here.** It is the only form that makes *"a business user cannot use diagnostic Tools"* true, and
   §4c's measurements show nothing else does. It is deliberately **not** a T1 deliverable: it is a
   Control Plane schema change with its own migration and Console surface, and inventing it inside a
   capability-probe task would put unreviewed governance machinery into the codebase. Until it lands,
   **the sentence "business users cannot call diagnostic Tools" is not true on this deployment**, and
   the deployment relies on the MCP client token, the gateway's routing, and Tools being default-disabled.
   That residual is stated rather than implied, and it is the strongest negative consequence of this ADR.
3. **The `A-1` precondition (§3) is what the declaration must make an Admin confront**, because it is
   the prerequisite whose absence produces a plausible-looking empty result rather than a failure.

**Why the declaration rather than the restriction, as the primary layer.** The realistic failure is not
an attacker finding a diagnostic Tool; it is an Admin enabling a Tool that reads the platform's logs,
trace configuration and permission tables as a high-privilege account **without realising the execution
identity does not follow the caller**. The declaration sits at that exact decision point, and it is the
only layer whose cost is proportionate to a threat whose first line of defence is already the token and
the gateway.

**How either layer preserves the legitimate business-system-administrator scenario.** This is the
constraint the recommendation is judged on, and it is why the structural layer is specified as an
**entitlement grant** rather than as a criterion test:

- A criteria-based restriction — "only platform users bound to a `DIAGNOSTIC` route may call this" —
  would silently exclude the business-systems administrator, whose route is by definition a business
  route. That is the failure mode to avoid: it locks out exactly the person P10 exists to serve.
- An entitlement is a **grant on the caller**, default off. A business-systems administrator receives it
  the same way an operator does, and nothing about their being a business administrator blocks them. The
  restriction becomes "you must have been granted this", which distinguishes *who may act as the
  platform's diagnostic administrator* from *what kind of route you happen to hold* — the distinction the
  current architecture is missing and the one the red line actually needs.
- The declaration layer imposes no exclusion at all: it asks the Admin to confirm understanding once,
  and a business-systems administrator with Console access completes it in the same click an operator does.

#### 4d. Audit dual-identity contract: confirm, do not build

The prompt requires audit to record the caller and the execution identity together. **This is already
implemented** and the decision here is to confirm it as a contract rather than to add machinery.

`RequestAuditContext` carries `platformUserId` (the caller), `executionRole` (`USER | DIAGNOSTIC`) and
`salesforceUsername` (the identity that actually executed), and `http-server.ts` populates the last two
from the resolved scope via `withSalesforceRoute({ salesforceUsername, executionRole })` — so a
diagnostic call is recorded as `platformUserId = <caller>`, `executionRole = DIAGNOSTIC`,
`salesforceUsername = <the diagnostic account>` on the same row. `TOOL_TERMINAL` then records
`executionRole: DIAGNOSTIC` (verified end-to-end for `get_org_limits` by ADR-0027).

The contract, pinned for P10:

- **Every P10 Tool's audit row carries all three.** A row with `executionRole = DIAGNOSTIC` and no
  `platformUserId`, or the reverse, is a defect.
- **`salesforceUsername` is the field that proves the execution identity**, because it is read from the
  scope after routing rather than derived from the Tool's declared role. A Tool mis-registered as
  `DIAGNOSTIC` but served a USER scope would show a business username beside `executionRole: DIAGNOSTIC`,
  which is what makes the pair checkable rather than self-certifying.
- **`set_trace_flag`'s audit row is the one that matters most**, because it is the only write. Its
  `operation` and target must identify *which entity was traced*, so "who opened a trace on whom" is
  answerable from the audit alone.
- This is asserted at acceptance, not assumed: `yarn ai:audit` over the P10 Tool set, checking the
  caller and execution identity co-occur (§0.5).

### 5. Revision notes required in T2–T5

Per §0.3, the original prompt text stays intact and each affected section gains a 修订注记:

| Section | Revision |
| --- | --- |
| T2 (`set_trace_flag`) | Must be **create-or-extend**, not create: an overlapping create is refused with `FIELD_INTEGRITY_EXCEPTION` (measured). Must resolve-or-create its `DebugLevel`, because the org's only stored level (`SFDC_DevConsole`) has `ApexProfiling: INFO` — the sampling level. Carries the §4b fix for `run_diagnostic_tooling_query`'s object check. |
| T2 (`get_apex_logs`, `get_debug_log_body`) | The log parser must dispatch on the **log's own header version** (54.0 and 56.0 both observed against a v68.0 org). Neither Tool may filter on a `Status` literal. |
| T3 (`explain_field_access`) | `targetUserId` is **permitted by the org** (cross-user `PermissionSetAssignment` read proven non-zero), so its boundary is a design choice to make explicitly, not a permission wall. `describe` must never be used for a target user's FLS — it answers for the caller. |
| T4 (`list_metadata_components`) | Metadata entry shape is per type: `Profile` carries no `manageableState`. `fullName` values are localized and `%2F`-escaped and must round-trip unmodified. Each of the 19 new types must be measured, not assumed from the three probed. |
| T5 (`get_platform_diagnostics`) | Filter on `Action`, never `Section` (not filterable). Counts come from `totalSize`; `COUNT(Id)` is refused. Per-source status per §3, so a genuinely-empty `CronTrigger` is distinguishable from an unreadable one. **Implemented per ADR-0033**, which narrows the §4a whitelist to three standard-API objects (`ApexLog` dropped: the log surface belongs to the Tooling Tools), moves the `AsyncApexJob` window into SOQL now that `CreatedDate` is measured filterable, and corrects the prompt's `ExtendedErrorStatus` to `ExtendedStatus`. Its stall rule is conservative by construction: `SUSPECTED` needs a waiting literal *and* a fire time more than 30 minutes past, and an unfamiliar state is `INDETERMINATE` rather than healthy. A `Failed` fixture must fail in `start` — a throw from `execute` leaves the job `Completed`. |

## Consequences

### Positive

- The six Tools are designed against measured prerequisites instead of beliefs about them, and the four
  facts that would each have caused a silent defect are known before the code exists.
- The red line has a measured basis on both halves, including the half where nothing but our own
  whitelist enforces it — which is the half most likely to be eroded by a later change.
- `probe:p10` survives T1 as a re-runnable prerequisite check, so a deployment can establish its own
  capability record instead of inheriting this one.
- The degradation contract turns the worst failure mode — a confident empty result — into a structured
  error, and the one place where empty is *correct* (`CronTrigger`) stays distinguishable from it.
- The enablement-surface decision states what is not true today, instead of recommending a restriction
  that cannot be built and letting a reader assume it was.

### Negative

- **"Business users cannot call diagnostic Tools" is not true on this deployment.** Enablement is global
  and there is no caller-to-diagnostic binding; the layers that would make it true are the declaration
  (which changes behaviour at the decision point, not at the call) and a deferred entitlement. Until that
  entitlement lands, the boundary rests on the client token, the gateway and default-disabled Tools.
- **`A-1` is unresolved and cannot be resolved in code.** If the diagnostic account cannot read other
  users' logs in production, `get_apex_logs` is of limited use there, and the only defence against that
  being read as "the org is quiet" is the §3 contract.
- **`run_diagnostic_tooling_query` remains the one diagnostic Tool whose data surface rests on the
  platform rather than on our code**, and the fix for it is a hand-written `FROM`-clause check that is
  explicitly not a parser.
- **The probe leaves `ApexLog` rows** when its write legs run, because creating a `TraceFlag` traces
  something. They expire on their own, but T1/T2 evidence taken from log counts has to account for the
  instrument's own footprint.
- **One deployed `TraceFlag` for the diagnostic identity's own user was left open by an earlier run**
  (`005…IAE`, open until `2026-09-30T04:01:04Z`). It was not deleted because it cannot be attributed
  with certainty; the instrument defect that allowed a leak — a `destroy` returning success while the row
  survived — is fixed, and every write leg now re-reads to confirm absence.

## Rejected alternatives

- **Make `set_trace_flag` create-only, on the reading that a refusal is a rare edge case.** It is not:
  it is the second call of the Tool's most ordinary use, and the refusal is a hard error rather than a
  no-op.
- **Filter `ApexLog` on `Status = 'Success'` and treat the other rows as also-failures.** Measured: that
  literal matches 1 of 9 rows while the localized literal matches 8. The filter does not narrow the list,
  it truncates it.
- **Parse Apex logs against the org's API version.** Measured: the org answers v68.0 and serves logs
  whose own headers say 54.0 and 56.0.
- **Treat a zero-row source as a zero-finding result.** This is the failure §3 exists to prevent, and
  `CronTrigger` is the case that proves the contract needs *per-source status* rather than a blanket
  "empty is an error".
- **Grant the diagnostic account nothing further and infer its cross-user log access from the Tooling
  API's behaviour.** The probe could only read its own logs; inferring the rest is precisely the mistake
  ADR-0027 was written to correct.
- **Build the hard architectural restriction as worded.** There is no route-scoped enablement to
  restrict; the faithful version is a per-caller entitlement, which is specified in §4c and deliberately
  left out of a probe task.
- **Widen the probe to a scratch org to exercise a TraceFlag create on a clean entity.** The deployment's
  own org is a sandbox and answered every write leg the prompt asked for, including the one that matters
  most (another user's trace). A second org would have measured a different permission set and made the
  evidence less representative of where the Tools will run, not more.

## Gate

No new Tool ships in T1, so the gate is the probe and the documents:

- `probe:p10` runs to completion against the deployment, exits 0 (`0 ERROR`), and its report is the
  evidence this ADR cites. Its writes are gated on the org's own `IsSandbox` answer and every write leg
  reports `cleanupVerifiedAbsent`.
- It is registered as **`probe:p10`, not `validate:p10`.** Every `validate:*` script in this repository
  is a *gate*: it fails the build when a required property is violated. This probe's normal, successful
  outcome includes `DENIED` rows — five of them here, four of which are the red line working — so a gate
  that failed on them would be wrong, and one that passed on them would say nothing. It reports facts and
  exits nonzero only on `ERROR`, which is a fault in the probe rather than a finding about the org. T2–T6
  may still cite its output as a pre-check; calling it a `validate:*` script would have mis-described what
  a green run means.
- The probe has a unit suite covering its output structure and its desensitization, so a regression in
  the masking rules fails a test rather than leaking into a committed report.
- Findings and inference are in separate columns in [`P10_T0_LIVE_PROBE_FINDINGS.md`](../P10_T0_LIVE_PROBE_FINDINGS.md),
  and the four design-changing facts carry revision notes into T2–T5.
- The §4 contract becomes testable as each Tool lands: the object whitelist per Tool, the
  prerequisite-missing structured error, and the audit row carrying caller **and** execution identity.
  T6's acceptance closes on those, per §0.5.

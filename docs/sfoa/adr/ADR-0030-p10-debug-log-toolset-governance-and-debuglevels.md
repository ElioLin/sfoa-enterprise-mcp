# ADR-0030: The P10 debug-log Toolset — governance classification, DebugLevel strategy and log-body budget

- Status: Accepted for P10
- Date: 2026-09-30
- Extends: ADR-0029 (prerequisites, degradation contract, §0.3 red line), ADR-0027 (`get_org_limits` on the
  DIAGNOSTIC identity), ADR-0024/ADR-0025/ADR-0026 (bounded completeness, explicit truncation, structured
  errors), ADR-0009 (the server-owned DIAGNOSTIC request scope)
- Evidence: [`docs/sfoa/P10_T0_LIVE_PROBE_FINDINGS.md`](../P10_T0_LIVE_PROBE_FINDINGS.md) (§1 status
  localization, §3 the stored `DebugLevel`, §4 the record-less `COUNT` body), plus the T2 live milestone
  recorded in §7 below

## Context

T2 delivers the deterministic path the gap analysis calls **GAP-M1**: open a bounded trace, reproduce,
list what was written, read the body, and land on the class and line. Three Tools carry it —
`set_trace_flag` (the write), `get_apex_logs` and `get_debug_log_body` (the reads) — and their hints are
written as one chain rather than three independent suggestions, because the value of the set is that an
Agent with no Apex knowledge can follow it.

ADR-0029 settled what may be read, what a missing prerequisite looks like and where the write may happen.
`P10_EXECUTION_PROMPTS.md` deliberately left four things to be decided during implementation: the write's
governance classification ("按 0.3 全局约定由 ADR 定名"), the DebugLevel tier design ("几档、各字段值自定并在
ADR 说明取舍"), the log-body fetch path ("实测后选用并记录"), and the parser's depth. This ADR is the record
of those four decisions, plus the four places where T1's measurements — or a choice they forced — **overrode**
the prompt text. The prompt text is left intact in the plan; the override is recorded here.

## Decision

### 1. Governance classification: a new `DIAGNOSTIC_WRITE` for the write, `READ` for both reads

`set_trace_flag` is classified **`DIAGNOSTIC_WRITE`** in the Admin Console catalog, and the two reads
`READ`. This is not a label that changes runtime behaviour — the enablement gate for these three is
ADR-0029 §4c's upstream-status check (§6 below) — it is the declaration an Administrator reads before
enabling a Tool.

`DIAGNOSTIC_WRITE` is a **new** classification, added to `TOOL_CLASSIFICATIONS`, rather than a reuse of
`MUTATION` or `ADMIN`, because both of those already mean something else in the same table:

- `MUTATION` in this catalog means an official DML Tool that writes business records (`create_record`,
  `upload_files_to_record`). A trace flag is not a business record, and an Administrator who has learned
  what `MUTATION` means would be misreading this row.
- `ADMIN` means "changes who may do what" — permission sets, profiles, users. A trace flag changes what
  gets *logged*, not what is *permitted*.

So the classification is named for the surface rather than for the verb, and the name is the contract:
exactly two Tooling sObjects, `TraceFlag` and `DebugLevel`, no delete path, and no business sObject
reachable. `P2_ALLOWED_CLASSIFICATIONS` is untouched and still admits only `READ`/`METADATA_READ`, so the
new value cannot leak into the official-Tool safety gate — it is produced only by
`contextToolClassification` for SFoA-native Tools. The blast radius is four files: the classification
tuple, the Admin DTO union, the Console's label table, and the classifier itself.

The classification is asserted in tests, not merely chosen: the admin-API suite pins
`set_trace_flag` → `DIAGNOSTIC_WRITE` and both reads → `READ`, and `tool-contract.test.ts` pins the
annotations (`readOnlyHint: false` for the write, `true` for the reads). A write advertised as a read is
the one misreading this decision exists to prevent, and it is the misreading a future edit is most likely
to introduce.

### 2. DebugLevel: three tiers, resolve-or-create, `SFOA_P10_` prefix

**Why tiers rather than a level parameter.** A `DebugLevel` is a row of ten independent levels, and one
`TraceFlag` points at exactly one row. A caller asking for "more detail" would be making ten claims at
once; naming three prebuilt combinations makes the claim inspectable before the call rather than after.

| Tier | Purpose | Non-`NONE` fields |
| --- | --- | --- |
| `MINIMAL` | the cheapest tier that still records an uncaught exception and the class and line that raised it | 3 (`ApexCode` `INFO`, `System` `INFO`, `Validation` `INFO`) |
| `DEBUG` (default) | statement-level Apex detail plus database and callout summaries, without profiling counters | 6 (`ApexCode` `DEBUG`, `Callout` `INFO`, `Database` `INFO`, `System` `DEBUG`, `Validation` `INFO`, `Workflow` `INFO`) |
| `PROFILING` | the debug tier plus full Apex profiling | 7 (as `DEBUG`, with `ApexCode` `FINEST` and `ApexProfiling` `FINEST`) |

`NBA`, `Visualforce` and `Wave` are `NONE` in every tier. The T1 probe created a level with seven fields
and never exercised those three; `NONE` is the sObject's own default, so omitting them keeps every insert
payload a **subset** of what was measured. The tier catalog still states all ten fields, so a level that
someone edited by hand is reported as stored (see `readDebugLevelLevels`) rather than as intended.

`DEBUG` is the default because it is the cheapest tier that answers "what did this request do".
`MINIMAL` exists because the body is bounded: a `FINEST` log of a busy transaction does not fit, and the
truncation hint has to recommend something concrete rather than "ask for less". `PROFILING` exists because
this org's only stored level (`SFDC_DevConsole`) samples `ApexProfiling` at `INFO` — full profiling is
reachable *only* through a level this Tool creates.

**Resolve-or-create, keyed on the tier's own developer name.** Every tier is prefixed `SFOA_P10_`, so
resolution by name can never adopt — and then rewrite — a level an administrator built by hand. Repeated
calls converge on one row per tier instead of one row per call. `debugLevelCreated` in the output says
which happened, and for a reused level `debugLevelLevels` reports the org's stored values, so an operator
comparing a thin log against a `PROFILING` request can see exactly which field was not set.

### 3. The log body is a versioned Tooling Blob GET, parsed by the log's own header version

The body is fetched over `connection.request()` as
`/services/data/v<apiVersion>/tooling/sobjects/ApexLog/<id>/Body`, with the API version taken from the
Connection rather than hard-coded. The listing's `LogLength` is not an alternative path: it is a length,
and the probe confirmed the body endpoint is the only surface that returns the text.

The parser dispatches on the **log header's own version string**, never on the org's API version. Two
format versions (54.0 and 56.0) were observed against a v68.0 org, and a parser keyed to the org version
would have read one of them as an empty log. A version outside the measured set is still parsed, but
`validated` is `false` — so a reader can always tell a parse from a guess. A body whose first line is not
a debug-log header is not a failure and not a guess either: the text is returned verbatim,
`parseStatus` is `NOT_A_LOG`, and the hint says nothing could be parsed from it. A body that is *empty*
while the row still exists is a different fact and a real error
(`MCP_DEBUG_LOG_BODY_NOT_FOUND`, prerequisite `A-2`): the row survived and its text did not.

### 4. Four prompt instructions were overridden by T1's measurements, or by a measurement-shaped choice

These are recorded because the code now deliberately contradicts the plan text, and the reason has to be
findable from the code.

**(a) `status` is not an enum.** The prompt asked for "可选 status（枚举子集，如 SUCCESS/ERROR）". On this org
`ApexLog.Status` is translated: `Status = 'Success'` matched 1 retained row and the localized literal
matched 8. A closed English enum would therefore be a filter that silently drops most of its rows — a
failure with no error and no visible cause. So `status` is a free string matched against what the org
stores, the answer reports the values it actually saw in `observedStatuses`, and a filter that matched
nothing says the filter is why. ADR-0029 §3's "never match on a human-readable label" is the general rule;
this is its first application.

**(b) A log entry carries three identity fields, not one `logUser`.** The prompt's
`logs: [{ …, logUser, … }]` invites a display name where a filter needs an Id. The output carries
`logUserId` (what `userId` filters on), `logUserName` and `logUserUsername` — separated, so no caller has
to split an identity out of a label.

**(c) `set_trace_flag` is create-**or**-extend.** ADR-0029 §1: creating a second overlapping `TraceFlag`
for the same entity is refused with `FIELD_INTEGRITY_EXCEPTION`. The Tool finds an active flag for the
entity and extends it, reporting `previousExpirationDate` and `replacedExisting`, and it never shortens an
active trace. The refusal is still mapped, as a fallback for the race between the lookup and the insert,
and its message names the conflicting flag's Id.

**(d) The default tier does not carry profiling.** The prompt described the default tier as "含
ApexCode/ApexProfiling/Callout/Database/System/Validation 的合理组合". Profiling is split out into its own
tier instead. A profiling counter set is the single largest contributor to log size, and the default is
the tier most calls will get — folding it in would make the *common* case produce the logs most likely to
be truncated, which is the failure this Toolset exists to avoid. `PROFILING` exists for callers who
actually need counters, and §2 records why this org cannot get them from its stored level.

Two further consequences of the measurement are worth stating here because they change what an answer
means: `totalCount` may be **null** (the probe found `COUNT(Id)` returns a record-less body whose
`totalSize` carries the number — `readApexLogTotal` handles both forms), and the write reports
`verified: true/false` from a re-read, because the probe's own cleanup once reported success on a row that
survived. A successful write is a claim; the re-read is the measurement.

### 5. The body budget: segment-sized truncation, so a cut is a prefix

The host applies the deployment's response-byte budget with `trimToByteBudget`, which removes **whole
items** — and a body is one string, so the naive composition is all-or-nothing: a log one byte over the
budget comes back empty. The executor therefore slices the body into
`DEBUG_LOG_BODY_SEGMENT_CHARACTERS = 4 000`-character segments before the budget is applied, so the one
tested house mechanism does the measuring and the cut falls on a segment boundary and stays a **prefix**.
Segments are an internal device, not a wire format: the caller receives one `body` string.

`maxCharacters` (default 60 000, hard cap 120 000) is a separate, schema-level bound on how much a caller
may *ask* for, applied before segmentation; the budget decides how much of that actually fits alongside
the header summary in one response. The answer says which happened: `totalCharacters` and
`totalBytes` describe the whole log, `returnedCharacters`/`returnedBytes` describe what came back, and
`truncated` is true when they differ. A caller who needs the rest raises `maxCharacters`; there is no
offset parameter, because the deterministic path never needs one — the point of the chain is to land on a
class and line, which the header summary reports whether or not the body was cut.

When a body is cut, the hint names the tier to reopen the trace at (`MINIMAL`), which is the whole reason
that tier exists.

### 6. Enablement: for SFOA-native Tools the Console gate is upstream status, not classification

`buildAdminToolCatalog` computes `enableAllowed` for the official catalog as `safeClassification && …`,
where `safeClassification` admits only `READ` and `METADATA_READ`. SFOA-native Tool families (context,
DML, attachment) do **not** go through that rule: their classification is a declaration, and their
enablement gate is ADR-0029 §4c's upstream-status check. This is why `set_trace_flag` is both
`DIAGNOSTIC_WRITE` and enableable, and it is deliberate: if the classification were also the gate,
`DIAGNOSTIC_WRITE` on its own would make the Tool impossible to turn on, which is not a decision a label
should be able to make silently.

## Consequences

### Positive

- The write's blast radius is enumerable from the source: one `TraceFlag`, one `DebugLevel`, two field
  names, no delete path. A reviewer can check the red line by reading one file.
- The three hints compose into a closed loop, so an Agent that knows nothing about Apex can get from
  "something threw" to a class and line in four calls.
- Reuse-before-create keeps a shared org's `DebugLevel` count bounded at three regardless of how often
  the Tool is called.
- Every degradation is a structured error naming an ADR-0029 prerequisite (`A-1` cross-user `ApexLog`
  visibility, `A-2` retention, `A-3` trace administration), so "it returned nothing" never has to be
  interpreted.

### Negative

- Three fixed tiers cannot express a targeted combination ("profiling on, database off"). A caller with
  that need gets a larger log than they wanted rather than an error, which is the failure mode that is
  cheaper to notice.
- The `status` filter runs in memory over the scanned page rather than in SOQL, so its reach is bounded by
  the scan limit and is reported as `scannedCount` rather than implied.
- A localized org's status values are discovered per call; the Tool cannot tell a caller the vocabulary
  before it has looked.

## Rejected alternatives

- **A free-form `logLevel` object.** It would let a caller set ten fields at once with no record of what
  was intended after the fact. The tiers are few and named so the audit and the response can both say
  which one was asked for.
- **Creating one `DebugLevel` per call.** Names would have to be unique per call, the org would accumulate
  junk rows, and a "cleanup" Tool would then be needed — a second write path this decision exists to avoid.
- **A `status` enum of English values.** Measured to drop 8 of 9 rows silently (ADR-0029 §3).
- **Pushing the status filter into SOQL.** The same defect one layer down: the statement would be
  well-formed and the result would be wrong.
- **Truncating the body by byte budget alone.** With whole-item removal a body either fits or vanishes;
  segmenting keeps a partial answer and makes it pageable.
- **Reusing `DEBUG_LOG` as the purpose for the write.** ADR-0029 §4d requires the audit to answer "who
  opened a trace on whom" on its own; a write folded into the read purpose cannot be told from a read.

## Gate

T2 is accepted when: the provider and host suites pass; the three Tools are invisible until enabled and
route to the DIAGNOSTIC identity when they are; a runtime without a diagnostic identity refuses rather
than downgrades; duplicate registration is refused; and the live milestone in §7 completes on a
non-production org.

## 7. Live milestone evidence

Recorded 2026-09-30 on the test server's sandbox org (instance `CHN5S`, API v68.0, `IsSandbox = true`),
mode `CLOSED_LOOP`, `overall = PASS` with all ten gates passing. The full record — the gate table, the
four measured steps, the audit rows and the prerequisite status of `A-1`, `A-2` and `A-3` as observed —
is in [`docs/sfoa/P10_T2_LIVE_EVIDENCE.md`](../P10_T2_LIVE_EVIDENCE.md).

Two of this section's claims were settled by the run rather than by the design, and both are recorded
here because they are durable platform constraints and not incidental bugs:

### 7.1 A SOQL `dateTime` filter must be emitted unquoted

`get_apex_logs` failed live with `MCP_APEX_LOG_READ_FAILED`. The platform's own answer named the cause:
`INVALID_FIELD` — *"value of filter criterion for field `LastModifiedDate` must be of type dateTime and
should not be enclosed in quotes"*. A quoted literal is a **string** literal, and the Tooling API no
longer accepts one where a `dateTime` belongs. The Tool now emits the window bound through a
`soqlDateTimeLiteral` helper that re-validates the shape and emits it unquoted, while `LogUserId` and
every Id field stay quoted — the two are not interchangeable, and the measured accepted forms (unquoted
at second and millisecond precision, `COUNT(Id)` with an unquoted literal) are tabulated in the evidence
document, with `LAST_N_HOURS:1` recorded as refused.

The T0 probe could not have found this: its `ApexLog` query carried **no `WHERE` clause**, so no
`dateTime` literal had ever been sent to this org. A probe measures the surface it queries; a Tool that
filters is a different surface.

### 7.2 `TraceFlag` dates are second-precision in the request as well as in the answer

`set_trace_flag` reported `verified: false` on a correct write. The requested expiration carried
milliseconds and Salesforce stores whole seconds, so the verification comparison failed **by the
sub-second remainder**. The clock is now truncated to whole seconds before the window is computed, which
makes the request expressible in the precision the platform keeps and leaves the comparison exact — a
tolerance would also accept a genuinely short trace. §4's rule that a write is verified rather than
trusted is unchanged; what changed is that the comparison is now between two values of the same
precision.

The unit fixture was corrected with it: it used to echo the payload byte for byte, which made it *answer
more precisely than the org* and therefore unable to fail the comparison production fails. This is the
general lesson and the reason both defects reached a live sandbox — a fixture kinder than production
cannot guard the difference.

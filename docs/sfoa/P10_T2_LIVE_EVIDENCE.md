# P10-T2 live milestone evidence (recorded 2026-09-30)

T2 delivers the deterministic diagnostic chain — **open a trace → reproduce → list → read the body →
land on a class and line** — as three Tools: `set_trace_flag` (the only write), `get_apex_logs` and
`get_debug_log_body`. The unit and protocol suites prove the contract; this page is the record of the
one thing they cannot prove, which is that the chain closes against a real Salesforce org, with a real
trace, a real exception and the audit trail that follows it.

The milestone ran twice on the same day. **The first run failed and the second passed, and both runs are
still in the audit trail** — the write that reported `verified: false` (audit `7699`) and the listing
that failed with `MCP_APEX_LOG_READ_FAILED` (audit `7711`) sit beside the run that closed the loop
(audits `7713`, `7714`, `7715`, `7716`). The two defects they exposed were real product defects found by
measurement, not harness noise, and they are recorded in §4 with the fix that closes each.

## 0. What was measured, on what, and how to read it

| | |
| --- | --- |
| Org | sandbox (`IsSandbox = true`), instance **CHN5S**, org id `00D************MAM`, API **v68.0** |
| Execution identity | the deployment's fixed DIAGNOSTIC identity — configured, enabled, `verificationStatus = PASS`, `c***@runner-corp.com.cn.uat`, platform user `08***48` |
| Mode | **`CLOSED_LOOP`** — the org reported `IsSandbox = true`, which is the only thing that turns the write leg on |
| Result | **`overall = PASS`**, exit code 0, all ten gates `PASS` |
| Host | the test server `192.168.156.203` (`crm-ex-test02`), built and run with Node **v24.19.0** |
| Report | `/data/sfoa-enterprise-mcp/p10-t2-milestone-fix1.json` (10 799 bytes, masked at the point of production) |
| Harness | `packages/sfoa-mcp-server/src/validation/p10-t2-live-milestone.ts`, runnable as `yarn workspace @sfoa/mcp-server milestone:p10-t2` |

The milestone is not a throwaway, for the same reason the T0 probe is not: T3–T6 add Tools on the same
identity and the same org, and a future deployment can re-run this instead of re-trusting this page. It
writes nothing to the Control Plane — the grant that enables the three Tools is a snapshot wrapper in
`AdditiveToolPolicySnapshotSource`, so a passing run can never be a run that quietly granted itself the
Tools it is supposed to prove can be granted.

**Every id, username and platform user in the report is masked where it is produced**, so the report can
be kept beside the other `docs/sfoa` evidence. This page quotes those masked values and no others.

## 1. Gate results

| Gate | Result | What it establishes |
| --- | --- | --- |
| `toolInventory` | PASS | the three Tools are advertised, with exactly the contracted input keys and the right `readOnlyHint`, against the grant the snapshot declares |
| `writeLeg` | PASS | `set_trace_flag` opened a trace that a re-read confirmed active for the requested window |
| `reproduction` | PASS | the harness could cause the failure it needs (anonymous Apex, on the DIAGNOSTIC scope) |
| `listLeg` | PASS | `get_apex_logs` returned exactly the two rows this run wrote |
| `bodyLeg` | PASS | `get_debug_log_body` parsed the failing row's header and named the exception and its line |
| `hintChain` | PASS | the three hints compose into one path, naming only advertised Tools |
| `statusContrast` | PASS | the two rows carry different `Status` values, so the org distinguishes them |
| `closedLoop` | PASS | the four steps consumed each other's output |
| `credentialSafety` | PASS | no token or client secret appeared in any of the five Tool responses |
| `auditPersistence` | PASS | 5 snapshots enqueued, 5 persisted, 0 dropped, queue depth 0 |

The advertised inventory was **26 Tools**, asserted equal to the snapshot's grant by set equality rather
than by containment. The three T2 Tools appeared as:

| Tool | `readOnlyHint` | advertised input keys |
| --- | --- | --- |
| `set_trace_flag` | `false` | `durationMinutes`, `logLevel`, `tracedEntityId`, `tracedEntityKind` |
| `get_apex_logs` | `true` | `limit`, `status`, `timeWindowMinutes`, `userId` |
| `get_debug_log_body` | `true` | `logId`, `maxCharacters` |

No Tool accepts a username, a password, a token or an instance URL — the milestone asserts that as a set
equality on the advertised input keys, which is what makes it a property of the session rather than of
the source it was written from.

`run_diagnostic_tooling_query` was also advertised, because the Control Plane grant for this route
already enables it (T1/T3 work). That matters for one assertion below: the body hint is allowed to name
it, and does.

## 2. The closed loop, as measured

### Step 1 — `set_trace_flag` opened the trace

```json
{ "tracedEntityKind": "USER", "tracedEntityId": "005************IAE", "logType": "DEVELOPER_LOG",
  "debugLevelDeveloperName": "SFOA_P10_DEBUG", "debugLevelTier": "DEBUG", "debugLevelCreated": false,
  "replacedExisting": true, "previousExpirationDate": "2026-09-30T05:00:47.000+0000",
  "startDate": "2026-09-30T04:30:47.000+0000", "expirationDate": "2026-09-30T05:15:16.000+0000",
  "requestedDurationMinutes": 30, "verified": true, "executionRole": "DIAGNOSTIC", "api": "TOOLING" }
```

Three things in that block are the point rather than decoration:

- **`verified: true` after a re-read.** The Tool re-reads the row it wrote, because T1's probe watched a
  delete report success on a row that survived. A milestone that accepted an unverified write would be
  republishing the assumption that finding was made to kill.
- **`debugLevelCreated: false` and `replacedExisting: true`.** The `SFOA_P10_DEBUG` DebugLevel and the
  `TraceFlag` were both left behind by the first (pre-fix) run and are being reused and extended, which is
  the resolve-or-create behaviour of ADR-0030 §2 measured on a second run rather than asserted from the
  first.
- **`previousExpirationDate` ends in `.000+0000`.** This is the exact second whose milliseconds exposed
  defect 2 (§4.2): the org keeps whole seconds, renders them with a `+0000` offset, and does not
  round-trip the millisecond a naive request would carry.

### Step 2 — the reproduction

Anonymous Apex is the only Apex this harness can cause at will, so the reproduction is an anonymous block
whose third line de-references null. The control execution — a single `System.debug` — is what makes
"this row is the failure" a contrast rather than a label, and it doubles as the authority measurement
(if this identity may not run anonymous Apex, neither execution happens and every write leg is
`NOT TESTED` instead of failing for the wrong reason).

| | control | failing |
| --- | --- | --- |
| `compiled` | true | true |
| `success` | true | **false** |
| `exceptionTypeFragment` | — | `System.NullPointerException` |
| line / column | — | 3 / 1 |
| source lines | 1 | 3 |

That the DIAGNOSTIC identity may run anonymous Apex at all is a **new measured fact** — T1 never
measured it, because T1's probe did not execute code.

### Step 3 — `get_apex_logs` listed both rows

```json
{ "returnedCount": 2, "scannedCount": 2, "totalCount": 2, "truncated": false,
  "timeWindowMinutes": 15, "windowStartedAt": "2026-09-30T04:30:18.141Z",
  "observedStatuses": [ { "status": "Attempt to de-reference a null object", "count": 1 },
                        { "status": "成功", "count": 1 } ],
  "beforeCount": 0, "newIdsMasked": ["07L************MAG", "07L************MAW"] }
```

Which two rows are "the ones this run wrote" is settled by diffing against a listing taken *before* the
reproduction, not by trusting ordering: two rows written a second apart can share a `LastModifiedDate`,
and reading `logs[0]` as "the newest" would be a coin flip that passes half the time.

**A second vocabulary fact, and a stronger one than T0's.** T0 found that `Status` for a *successful*
execution is the localized `成功`, which is why the Tool does not push a caller-supplied status literal
into SOQL. The failing row's `Status` is neither `成功` nor an English label — **it is the exception's own
text, `Attempt to de-reference a null object`**. So the vocabulary is not a two-value translation table
missing its English side; it is free text that varies with the failure. Any filter composed from a
believed-in enum would drop the failing row silently, which is the exact defect ADR-0030 §2 exists to
avoid. `observedStatuses` reports what was actually seen, so a caller can compose a filter that will
match on this org instead of guessing one.

### Step 4 — `get_debug_log_body` located the failure

```json
{ "logIdMasked": "07L************MAG", "parseStatus": "PARSED", "logApiVersion": "68.0",
  "exceptionType": "System.NullPointerException", "lineNumber": 3, "columnNumber": 1,
  "apexClass": "AnonymousBlock", "validated": false,
  "bodyCharacters": 1542, "totalCharacters": 1542, "returnedCharacters": 1542,
  "totalBytes": 1554, "returnedBytes": 1554, "maxCharacters": 60000, "truncated": false,
  "logLength": 1554, "userDebugLineCount": 1, "stackFrameCount": 1, "executionFinished": true }
```

- **`apexClass` is reported as measured, not asserted by name.** Anonymous Apex frames as
  `AnonymousBlock`, which is a fact about how the harness reproduced the problem rather than about the
  parser; the *line number* is asserted, because a line a caller cannot rely on is the same as no answer.
- **The control row was read through the Tool as well** — `parseStatus: PARSED`, `fatalError: null`,
  `executionFinished: true`. The two rows are told apart by asking the Tool for both bodies and taking
  the one whose header carries a fatal error; nothing in the harness maps a status string to an
  interpretation.
- **The log's header version is 68.0, the org's own version.** T0 §1 recorded that the logs it found in
  the org were written by older API versions (54.0, 56.0) while the org serves v68.0; a fresh log is
  written at v68.0, which is what ADR-0030 §3's versioned Blob read keys off.

The hint for this step named `run_diagnostic_tooling_query` with a `SELECT Body FROM ApexClass …`
statement — allowed, because that Tool was advertised in this session (§1).

## 3. What this run does not prove

Stated because the loop closing is easy to over-read:

- **`A-1` (can the diagnostic identity read *another* user's `ApexLog` rows?) is still not exercised.**
  The milestone traces the diagnostic identity itself and lists only the rows that identity wrote, so the
  closed loop says nothing about cross-user visibility. T0 §2 measured that a `DEVELOPER_LOG` create on a
  *different* user succeeds, which is a different question from whether that user's logs can be read.
  This remains a production deployment check.
- **`A-2` (retention) is not exercised.** No purged body was met, so the "the log has aged out" path is
  covered by unit tests and by T0's retention measurement, not by this run.
- **`A-3` (trace administration) is exercised only in the direction used here** — creating, extending and
  re-reading a trace on the Tool's own identity. Removing a trace is not a capability this Toolset has,
  by design.
- **`statusContrast` proves the values differ, not what they mean.** The harness reports both values
  verbatim and asserts no translation anywhere.

## 4. The two defects the live run found

Both were found by running the chain, both were diagnosed by measurement rather than by reading, and
both are now pinned by a test that fails without the fix.

### 4.1 A `dateTime` filter was emitted as a quoted string literal

**Symptom.** `get_apex_logs` failed with `MCP_APEX_LOG_READ_FAILED` on the first live run. The wrapper did
not say which clause the platform had refused, so the root cause was measured with a throwaway probe
against the same scope, which produced the platform's own words:

```
INVALID_FIELD — value of filter criterion for field 'LastModifiedDate' must be of type dateTime
and should not be enclosed in quotes
```

**Root cause.** One line built the window bound with the string-literal escaping helper:
`LastModifiedDate >= '…Z'`. A quoted literal is a *string* literal, and the Tooling API at v68.0 no longer
accepts one where a `dateTime` belongs. Every other use of that helper quotes a genuine string or Id field
(`LogUserId`, `DebugLevel.DeveloperName`, `TraceFlag.TracedEntityId`, `Id`) and is correct — this was the
only `dateTime` filter in the Toolset.

**Why T1 could not have caught it.** The T0 probe's `ApexLog` query carried no `WHERE` clause at all
(`SELECT … FROM ApexLog ORDER BY LastModifiedDate DESC LIMIT 10`), so no `dateTime` literal had ever been
sent to this org. The clause only appeared when a Tool that needs a time window was written.

**The accepted form, measured** (the probe's variants, one clause apart from each other so the first
failure names the clause):

| Variant | Result |
| --- | --- |
| unquoted literal, second precision | `OK` |
| unquoted literal, millisecond precision | `OK` |
| unquoted literal + quoted `LogUserId` | `OK` |
| unquoted literal, millisecond + quoted `LogUserId` | `OK` |
| `COUNT(Id) total` with an unquoted literal | `OK`, `records[0].total` |
| `LAST_N_HOURS:1` | `REFUSED` `MALFORMED_QUERY` |

**Fix.** A `soqlDateTimeLiteral` helper beside the string escaper: it re-validates the shape it is given
and emits it **unquoted**. Safety is structural rather than incidental — the only values ever passed in
are produced in-process by `Date#toISOString()` from a window computed from the clock, so no part of the
emitted string can come from a caller or from org data. A value that is not a UTC instant is refused as
an internal error rather than interpolated.

**Pinned by.** `debug-log-context-executor.test.ts` and `debug-log-runtime.test.ts` now assert the
unquoted shape *and* assert its absence in the quoted form, so the regression is a two-way assertion
rather than a loosened regex.

### 4.2 A correct write was reported as unverified

**Symptom.** `set_trace_flag` returned `verified: false` on a write that had in fact succeeded — audit
`7699` records `{"verified": false, "replacedExisting": false}` on a create that left a working trace.

**Root cause.** The requested expiration carried milliseconds (`…:47.812Z`) while Salesforce stores whole
seconds and answers a re-read with the truncated value (`…:47.000+0000`), so the verification comparison
`stored >= requested` was false **by the sub-second remainder**. This is the mirror image of T1's finding:
T1 caught a write that reported success on a row that survived; this is a write that reported *unverified*
on a row that was correct.

**Fix.** The clock is truncated to whole seconds before the window is computed
(`Math.floor(Date.now() / 1_000) * 1_000`), so the request is expressible in the precision the platform
keeps. The comparison is left **exact** rather than nudged by a tolerance, because a tolerance would also
accept a genuinely short trace. `previousExpirationDate` in §2 step 1 is the stored value that proves the
platform's precision.

**Pinned by.** The fixture now stores `TraceFlag` dates the way the org does — whole seconds, rendered in
the `+0000` offset notation — where before it echoed the payload byte for byte. That is the reason these
two defects reached a live org at all: a fixture that answers *more precisely than production* cannot
fail a comparison production fails, and therefore cannot guard it. The suite now also asserts that a
seeded expiry carrying a JavaScript instant is normalized on storage, so no test can buy itself a kinder
fixture by seeding milliseconds, and that an org-notation (`+0000`) expiry is parsed as active rather
than as an unparseable epoch — which would have read as "long expired" and caused a second `TraceFlag` to
be created for an entity that already had one.

## 5. Audit verification (P7)

Read with `yarn ai:audit --tool <name> --latest N --since 45m` against the same database the runtime
writes to. The three Tools are on the chain, on the DIAGNOSTIC role, with the write on its own purpose:

| Audit | Tool | Result | Purpose carried by its Salesforce calls |
| --- | --- | --- | --- |
| `7713` | `set_trace_flag` | `PASS` / `SUCCESS` | `TRACE_FLAG` |
| `7714`, `7712` | `get_apex_logs` | `PASS` / `SUCCESS` | `DEBUG_LOG` |
| `7715`, `7716` | `get_debug_log_body` | `PASS` / `SUCCESS` | `DEBUG_LOG` |

- **`executionRole = DIAGNOSTIC` on every row**, `errorCode = null`, and the six Salesforce Connections
  the run opened collapsed to **one distinct username** — the fixed diagnostic identity. No Tool
  downgraded to the caller.
- **The purpose separation ADR-0029 §4d requires is measured, not assumed**: the write's calls carry
  `TRACE_FLAG`, both reads carry `DEBUG_LOG`. Every row also carries the connection's own
  `IDENTITY_TOKEN_EXCHANGE` / `IDENTITY_AUTHENTICATION` calls, which are the identity layer's, not the
  Tool's.
- **`responseSummary` matches the Tool's own answer** — `{"verified": true, "replacedExisting": true}` on
  `7713`, `{"truncated": false, "totalCount": 2, "scannedCount": 2, "returnedCount": 2}` on `7714`.
- **The pre-fix run is still visible**: `7699` records `{"verified": false}` on the write, and `7711`
  records `get_apex_logs` as `ERROR` / `MCP_APEX_LOG_READ_FAILED` with the underlying Salesforce call
  `FAILED` / `INVALID_FIELD`. Both defects and their absence therefore sit in one trail, which is what
  makes this a before/after rather than an assertion.
- **No credential material in any row.** The milestone's own gate scanned all five Tool responses for the
  live client token and access token (`secretsSearched: 2`, `offenders: []`), and the audit reader masks
  the username and platform user on output.

Two properties of the trail are worth recording so a later reader does not chase them:

- **`auditIntegrityStatus = PARTIAL` is the deployment norm, not a T2 finding.** P9-era
  `query_records` rows (`6975`–`6977`) carry the same status and the same `evidenceIntegrity` detail
  ("Evidence is incomplete or degraded; do not infer missing stages"). It reflects the evidence this
  deployment does not capture (no agent or model context on these calls), not anything the debug-log
  Tools did.
- **`firstFailure` reports `INVALID_TYPE` on `SELECT Id FROM ScratchOrgInfo limit 1` (v51.0).** That call
  is jsforce's own connection warm-up probe — it asks an org that is not a scratch org, gets the
  platform's refusal, and continues. It is why `salesforceApiCaptureFailureCount` is non-zero on every
  Tool call. It is not a call this Toolset makes and it is not a defect; the Tool's own calls in the same
  row all read `SUCCESS`.

## 6. Open items carried out of T2

- **`A-1`** — cross-user `ApexLog` visibility — is a production deployment check (§3).
- The `run_diagnostic_tooling_query` hint on a body that parsed from anonymous Apex names the synthetic
  class `AnonymousBlock`, so the suggested `SELECT Body FROM ApexClass` would return nothing for *that*
  frame. The hint is correct about what it can know (the class the top frame named); a caller reading a
  real exception gets a real class. Recorded here rather than fixed, because suppressing the hint for the
  synthetic name would remove it from the one scenario the hint is most useful in — a real failure whose
  frame is a real class.
- `apexlog-clause-probe.mjs`, the throwaway probe used to measure §4.1's accepted form, was removed from
  the host after the measurement; the measured table above is what it was for.

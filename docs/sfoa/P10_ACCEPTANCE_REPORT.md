# P10 acceptance report (2026-10-09)

The closing acceptance for the P10 diagnostic-depth plan, run against the branch tip and against the test
server that was deployed from it. Every number below was read from a run's own output or from the Control
Plane database; where a leg could not be executed it is named as not executed rather than counted as a
pass.

| | |
|---|---|
| checkout | `D:\GitProject\sfoa-enterprise-mcp`, branch `feature/p10-diagnostic-depth` @ `5aa270c` |
| test server | `crm-ex-test02` / `192.168.156.203`, app tree `/data/sfoa-enterprise-mcp/app` |
| deployed revision | archive `sfoa-p10-t6-5aa270c.tar.gz`, sha256 `07f72b26552ff5ea22d8e0dd22a2f1151a3fa534d1b1b690660dcbf6520474a3`, deployed whole and verified byte-identical on the files this acceptance changed |
| Control Plane | MySQL schema `sfoa_enterprise_mcp` |
| run reports | on the test server in `/data/sfoa-enterprise-mcp/`: `p10-validation-20261009-144019.json` (the cold run, sha256 `12c0535c…`), `p10-validation-20261009-135406.json` (the pre-fix `FAIL`, sha256 `b8758462…`), `p10-t2-rerun-135954.json` (sha256 `bfaeb6d0…`) |
| evidence pages | [P10_T0_LIVE_PROBE_FINDINGS.md](P10_T0_LIVE_PROBE_FINDINGS.md), [P10_T2](P10_T2_LIVE_EVIDENCE.md), [P10_T3](P10_T3_LIVE_EVIDENCE.md), [P10_T4](P10_T4_LIVE_EVIDENCE.md), [P10_T5](P10_T5_LIVE_EVIDENCE.md) |

## 1. What P10 delivered

Six Tools and one Skill, closing GAP-M1 to GAP-M6. Every Tool is **disabled by default**, carries the
`DIAGNOSTIC` role, executes on the server-owned diagnostic identity, and reaches an Agent only through an
explicitly enabled Control Plane route. All six live in the existing `@sfoa/mcp-provider-sfoa-context`
(`get_org_limits` was the package's P9 precedent), so P10 added no package.

| task | Tool | what it answers | ADR |
|---|---|---|---|
| T2 | `set_trace_flag` | open a time-boxed trace for a user or a class — the only write surface in P10, structurally confined to `TraceFlag`/`DebugLevel` with a ≤60-minute expiry | [ADR-0030](adr/ADR-0030-p10-debug-log-toolset-governance-and-debuglevels.md) |
| T2 | `get_apex_logs` | which logs exist in a window, for a user, with a status filter | [ADR-0030](adr/ADR-0030-p10-debug-log-toolset-governance-and-debuglevels.md) |
| T2 | `get_debug_log_body` | one log's body, bounded, with a parsed exception summary (class, line, stack) | [ADR-0030](adr/ADR-0030-p10-debug-log-toolset-governance-and-debuglevels.md) |
| T3 | `explain_field_access` | why a field is visible/editable for a target user — the authorization source chain | [ADR-0031](adr/ADR-0031-p10-permission-attribution-target-boundary-and-indeterminate.md) |
| T4 | `list_metadata_components` | which components of a type exist (fullName, state, last modified) | [ADR-0032](adr/ADR-0032-p10-metadata-listing-pair-data-source-and-type-budget.md) |
| T4 | `get_metadata_component_context` (widened) | a component's definition — allowlist 8 → 21 types | [ADR-0032](adr/ADR-0032-p10-metadata-listing-pair-data-source-and-type-budget.md) |
| T5 | `get_platform_diagnostics` | what changed, what broke and what stopped firing, merged onto one timeline | [ADR-0033](adr/ADR-0033-p10-platform-diagnostics-stall-rule-and-degradation-matrix.md) |

Two of those are not Tools. [ADR-0029](adr/ADR-0029-p10-diagnostic-identity-prerequisites.md) is T1's
deliverable: the diagnostic identity's measured prerequisites, written as a per-source enablement list so
a production deployment re-measures rather than inherits. The `sfoa-org-diagnostics` Skill is T6's: the
five-class decision tree (data / permission / configuration / code / platform), one deterministic
evidence path per class, the evidence-citation duty, the time-alignment routine, and the degradation and
indeterminacy semantics — synced to all four client locations and published to the Agent through Playbook
1.11.0.

**The prompt's §0.3 red line held in every task, and it was measured rather than assumed.** No P10 Tool
can reach a business record: the whitelist is hardcoded host-side, each Tool's unit suite asserts its own
data surface, and the live harness brackets every Tool call on the wire (T5's run: 23 statements, exactly
three distinct `FROM` targets, `offWhitelist: []`, `dml: []`). The T0 probe drove the boundary directly
and found the identity *can* reach business data through the standard API (`COUNT(Id)` on `Lead`: 955
rows) while the Tooling API structurally refuses `Lead`, `Account` and two custom objects with
`INVALID_TYPE` — which is why the red line rests on the API's refusal **plus** the Tool-code whitelist,
and why a future code path that reached the standard API from a diagnostic Tool would be stopped by
nothing the org does (T0 §9). The audit records the caller and the executing identity on the same row, so
"who used the diagnostic identity, and for what" is answerable from the trail (§6.1).

## 2. Local gates

Run in the checkout, sequentially and uncontended — the same discipline as P9, because the
timing-sensitive suites in this repository do not survive a contended machine. Node `v24.13.0`,
yarn `1.22.22`. The full battery ran on `b65f29d`. Two commits landed *after* it started
(`ecb992a`, `5aa270c` — the T2 trace-activation wait and its Skill note, touching
`packages/sfoa-mcp-server` and `skills/**`), so every gate those commits can reach was re-run at
the tip `5aa270c`; those rows are marked **†** and their readings come from the tip. Every row that is
not green is pre-existing and is separated out in §5.

| command | exit | verdict |
|---|---|---|
| `yarn build` | 0 | PASS — 255 s († 121 s at the tip) |
| `yarn lint` | 1 | FAIL — 47 errors in 25 files, every one in `packages/mcp-provider-code-analyzer` (upstream), §5.3 |
| `yarn test` (root, all workspaces) | 0 | PASS — 1 394 s; includes `sfoa-admin-web` 13 files / 84 tests, 504 s, with the Playbook 1.11.0 drift gates green (P9's version-bump red-suite lesson did not repeat: the drift gates were bumped with the playbook in the same commit) |
| `yarn workspace @sfoa/mcp-server test` | 0 | PASS — 392 tests († 392 at the tip, 162 s; the four new trace-activation tests among them) |
| `yarn workspace @sfoa/mcp-server test:p3` | 0 | PASS |
| `yarn workspace @sfoa/mcp-server test:p4` | 0 | PASS |
| `yarn workspace @sfoa/mcp-server test:p5` | 0 | PASS |
| `yarn workspace @sfoa/mcp-server test:p7` | — | failed in the battery under load and then hung; solo re-runs pass on both trees — §5.1 |
| `yarn workspace @sfoa/mcp-server validate:p2` | 2 | PARTIAL — `Missing Live Inputs SECOND_TEST_USER`, pre-existing, §5.2 |
| `yarn workspace @sfoa/mcp-server validate:p3` | 1 | FAIL — same missing input, pre-existing, §5.2 |
| `yarn workspace @sfoa/mcp-server validate:p4` | 0 | PASS (`overall: PASS`) |
| `yarn workspace @sfoa/mcp-server validate:upstream` | 0 | PASS |
| `yarn agent:check` | 0 | PASS — `Agent artifact check PASS (5 files)` († at the tip) |
| `yarn skill:check` | 0 | PASS — `drift: []` († at the tip) |
| `yarn skill:test` | 0 | PASS — 71 tests, 0 fail († tip-only, not part of the battery) |
| `yarn ai:snapshot` | 0 | PASS († tip-only) |
| `yarn ai:doctor` | 0 | PASS — `problems: []`; `services: PASS`, `mcp`/`adminApi`/`adminWeb` all `reachable: true`, `httpStatus: 200` († tip-only; P9's §5.4 `NOT_RUNNING` condition did not recur — the local stack was up) |
| `yarn workspace @sfoa/admin-web` vitest, full suite | 0 | PASS — re-run at the tip for completeness (not on the two commits' path): 13 files / 84 tests, 402.7 s. An earlier attempt in the loaded window hit the documented `GovernancePages` contention timeout — §5.4 |

## 3. Live acceptance

Run on the test server through the deployed runtime, against the real org. The phase gate
(`yarn workspace @sfoa/mcp-server validate:p10`, `src/validation/p10-live-validation.ts`) drives all
four live milestones in **one** process, each with its own Control Plane route and caller; it resolves
one enabled identity route from the Control Plane inside its own process, injects it into the
validation's environment and masks every identity value before printing, so no platform user id
appears on a command line, in shell history or in this report.

The cold run at `generatedAt 2026-10-09T06:40:30.202Z` (`p10-validation-20261009-144019.json`) ended
`overall: PARTIAL`. **The one cause is T4's documented `inactiveDefault` gap (`NOT TESTED`), not a
Tool refuting anything** — no P10 Tool failed a live leg in this run:

| milestone | mode | legs | verdict |
|---|---|---|---|
| T2 (trace toolset) | `CLOSED_LOOP` | 11 / 11 PASS | PASS |
| T3 (field attribution) | `CONSTRUCTED` | 15 / 15 PASS | PASS |
| T4 (metadata pair) | `MEASURED` | 10 PASS + `inactiveDefault` NOT TESTED (no recycled component on this org, §7) | PARTIAL |
| T5 (platform diagnostics) | `MEASURED` | 15 / 15 PASS | PASS |
| partialEnablement | — | 9 / 9 PASS | PASS |
| auditCoverage | — | 6 / 6 Tools | PASS |
| auditCredentialScan | — | 16 readings, 0 hits | PASS |
| credentialSafety · auditPersistence | — | 0 offenders; `flushed: true`, `dropped: 0`, `drained: true` | PASS |

**On enablement.** `enablementSource` says it in the run's own words: *"in-process additive snapshot:
the P10 Tools are enabled for this run only and the Control Plane holds no grant for them, so a green
run here is not a statement about any route's configuration."* The six Tools are granted in memory by
the gate; §7 carries the console-enablement step as still owed.

### 3.1 The three required scenarios

| scenario | evidence | verdict |
|---|---|---|
| a — Apex runtime exception: open trace → reproduce → pull log → locate class and line | `set_trace_flag` opened a verified `DEVELOPER_LOG` trace (`tracedEntityKind: USER`, DebugLevel `SFOA_P10_DEBUG`, tier `DEBUG`, bounded expiry) and the loop closed: 2 new rows for 2 expected, `get_debug_log_body` parsed `System.NullPointerException` in `AnonymousBlock` at **line 3** == `expectedLine: 3` | PASS |
| b — field not visible: `explain_field_access` outputs the authorization source chain | `SicDesc` on `Account` with `createdPermissionSetMasked: P1***55` — `visible: true`, `editable: true`, source chain `object-visibility` + `field-grants: 1 row(s) over 0 profile-owned and 1 standalone permission set(s)`, `conflicts: []`; the closed control agreed with an independent read of the org (`deniedToTheSubject: true`, 0 rows for the subject) | PASS |
| c — "it has behaved oddly since yesterday": change timeline alignment | `get_platform_diagnostics` over 24 h: the Tool's 25 setup changes and `totalCount: 654` matched an independent read exactly (`idsNotInTheOrg: []`, `timestampsMatchTheIndependentRead: true`), and the merged timeline held 27 entries == 27 implied by the sections with `disagreements: []` | PASS |

**Scenario a, in full.** The write leg is the phase's only write and it reports what it did:
`debugLevelCreated: false` (the DebugLevel of that developer name already existed) and
`previousExpirationDate: null` — so the flag itself was created fresh rather than an expired one being
renewed, which is why the activation leg below had a window to wait through at all. Before anything was
measured, that leg waited **103 635 ms across 19 polls in 2 rounds** until `get_apex_logs` showed its own
warm-up execution — so the pair being measured ran under a trace the run had *demonstrated* was
capturing. The listing
then reported `returnedCount: 3`, `scannedCount: 3`, `totalCount: 3`, `truncated: false` over a
15-minute window, with exactly the `expectedNewLogs: 2` new ids, and `observedStatuses` distinguishing
the failure (`Attempt to de-reference a null object`, 1) from the control (`成功`, 2). The body leg
parsed the failing row to API version `68.0` with `fatalErrorLength: 66`; `statusContrast` confirms
the org stores a distinct value for the two executions and asserts no translation of it. The
activation wait is itself a finding — §4 is why it exists and what it measured.

**Scenario b, in full.** Two controls establish the boundary: `SicDesc`, where the org's row was
removed and the Tool then reported the subject as denied, and `Account_Belong_Group__c`, which the org
already grants (`source: ALREADY_GRANTED_BY_THE_ORG` — an observation of the org, not of the Tool).
`boundary` is the honesty leg: an out-of-route target and a nonexistent one both come back as
`MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED` with **byte-identical refusal text**
(`refusalTextsIdentical: true`, `refusalLength: 544`, `carriesConclusion: false`), so the refusal
cannot be used to probe which users exist. `dataPlane` shows the Tool's whole wire surface for the
milestone: 25 statements over 5 windows, 6 distinct targets — the authorization tables —
`offWhitelist: []`. The cleanup leg reverted both constructed rows and the snapshot diff came back to
207 == 207 with `drift: []`.

**Scenario c, in full.** `sectionCoverage` read all three sections with none unavailable and reported
its own truncation (`SETUP_CHANGES`: 25 of 654). `asyncFailureFidelity` matched 2 failures against 2
independent rows and read the org's own status vocabulary (`["Completed","Failed"]`,
`vocabularyAgrees: true`). `scheduledJobFidelity` is explicitly `vacuous: true` — this org holds zero
`CronTrigger` rows — and hands its requirement to `emptySourceClarity`, which asserts the READ section
carries zero rows *and says so* (`cronTriggerCaveatMentionsTheEmptyTable: true`). `windowHonesty`
reports the window it actually used and `serverClockSkewMs: 1404`. The merged timeline is the required
alignment: every section entry appears once, the ordering is the contract's own comparator, and the
note says candidate rather than cause.

### 3.2 The partial-enablement leg, 9 / 9

The run also asks what the same server looks like when only **some** P10 Tools are enabled. Three were
requested (`set_trace_flag`, `get_apex_logs`, `get_platform_diagnostics`) and three deliberately were
not (`get_debug_log_body`, `explain_field_access`, `list_metadata_components`):

| leg | reading |
|---|---|
| `toolInventory` | 26 advertised Tools — the 23 pre-P10 Tools plus the requested three, nothing else |
| `disabledToolsAbsent` | the three disabled Tools appear nowhere in the advertised set (`leaked: []`) and no route pre-enabled a diagnostic Tool (`routePreEnabledDiagnosticsTools: []`) |
| `hintGating` | the three disabled Tools *are* named in the surface's text (`namesNotAdvertised`), and **no advertised Tool's hint names any of them** (`offenders: []`) — this is the cross-Tool hint gate: a hint may only name a Tool the same request advertises |
| `positiveControl` | `get_platform_diagnostics`' own hint still names `get_metadata_component_context`, which *is* advertised — so the gate is not passing by the hints being empty |
| `degradedBranch` | `get_apex_logs` still emits its "the log body is fetched separately, by log id" sentence while `get_debug_log_body` is off — degraded, not broken |
| `playbookStatusLine` | the playbook's status line enumerates exactly the five enabled diagnostic Tools (`listed` == `expected`) and says any Tool named but absent from it "is NOT enabled here — do not call it, do not promise it as a next step" |
| `sessionCompleted` | the session completed with exactly the three enabled Tools called (`callsAttempted`) |

### 3.3 Repeat runs and the pre-fix contrast

Two full phase runs exist and both are kept unedited: the pre-fix run at `05:54:06Z`
(`p10-validation-20261009-135406.json`, `overall: FAIL`) and the run above. The pre-fix FAIL is not
noise and is not deleted — it is the evidence §4 is built on, and the contrast between the two runs
is what identified the platform behaviour rather than a Tool defect. The single-leg T2 re-run at
`05:59:56Z` (`p10-t2-rerun-135954.json`, `overall: PASS`) is the third data point: its write leg found
the failed run's flag still in place and extended it rather than creating a new one
(`replacedExisting: true`, previous expiry `06:24:19`), and the whole milestone then passed with the
same readings — the same trace that had captured nothing a second after it was created was capturing
fine minutes later.

## 4. A defect the harness had, found by running the phase gate

**The phase gate's first full run failed, and the failure was real.** The run at `05:54:06Z`
(`p10-validation-20261009-135406.json`, kept unedited) returned `overall: FAIL`: T3 `PASS`, T5 `PASS`,
T4 `PARTIAL` (its documented `includeInactive` gap), and **T2 `FAIL` on five legs** — `listLeg`,
`bodyLeg`, `hintChain`, `statusContrast`, `closedLoop` — with `get_debug_log_body` consequently the one
Tool missing from `auditCoverage`. Read at face value it said: the trace was opened, the reproduction
executed, and `get_apex_logs` showed nothing new — the listing Tool refuting a claim about the org.

**What the listing actually showed.** A throwaway host-side script read the same `ApexLog` table through
the same diagnostic route and printed timestamps. The flag was created at `05:54:19`; the two executions
that followed a second later had left **no `ApexLog` rows at all** — not late, never, which the
listing leg's own 12 polls × 2.5 s could not have recovered either. The rest of the run supplied the
contrast: an execution 86 seconds later under the same flag *was* captured, and the standalone T2
re-run extended that same flag and passed end-to-end.

**So the defect was the harness's assumption, not the Tools'.** A newly created `TraceFlag` does not begin
capturing the moment it is returned: on this platform there is an activation delay of seconds to tens of
seconds, invisible to the Tool, the Schema and SOQL, and the milestone was executing its reproduction one
second after the write leg returned — inside that window. No amount of polling at the listing end can
recover a log the platform never wrote, which is why the fix could not be a longer wait on the existing
poll. The Tool contract is untouched by design: a human or an agent taking seconds to minutes between
"open the trace" and "do it again" never meets the window.

**Re-running the phase as-is would have hidden it.** The flag the failed run left open had long since
become effective, so an immediate re-run would have gone green while the defect stayed in the harness for
the next deployment to find.

**The fix: an activation gate measured with the Tool's own observable.** `p10-t2-live-milestone.ts` now
runs a `traceActivation` leg between the write leg and everything measured: up to two warm-up rounds, each
executing a throwaway `System.debug` anonymous block and polling `get_apex_logs` for its row
(≤18 polls per round, 5 s apart), and each round re-running the probe rather than merely waiting longer
precisely because a warm-up that itself ran before activation can never appear. The listing is re-taken
after activation, so the warm-up's own rows fall on the *before* side of the measurement and cannot
disturb the exact-two-new-rows assertion or the body leg's search for the one fatal row. Every downstream
leg now gates on `measurable` — the run's own statement that the trace was capturing.

**An unmeasured leg is `NOT TESTED`, and it says what was measured.** When activation never happens the
gate reports `NOT TESTED` with the measurement in the reason (`rounds`, `pollAttempts`, `waitedMs`,
`activation: NEVER_CAPTURED`) and the downstream legs report `NOT TESTED` rather than cascading `FAIL`s.
That is the milestone doctrine applied honestly: no Tool was asked anything, so nothing was refuted, and a
`FAIL` would blame `get_apex_logs` for a log the platform never wrote. Four unit tests
(`src/test/p10-trace-activation.test.ts`) cover the captured, never-captured and refused branches, the
last of which is the write-on-a-production-org case ADR-0029 forbids.

**The same edit closed a latent false `FAIL` in the read-only path.** On a non-sandbox org the write leg
is declined (`NOT TESTED`), and `bodyLeg`/`statusContrast` previously ran anyway against an empty
candidate set and would have failed — blaming the Tools for a write the deployment correctly refused.

**The operational half went into the Skill, because the same trap is waiting for an agent.** Hard Rule 6
already said a trace sees only the future; it now also says a fresh trace does not capture immediately,
and `references/trace-and-reproduction.md` gained §2.5 and a pitfall row: an empty listing right after
opening a trace is the activation delay **first**, not "no exception" and not "the reproduction missed" —
ask the user to do the same thing once more before reading anything into it. (Phrased qualitatively: Hard
Rule 12 forbids thresholds and environment-specific values in the Skill.)

## 5. Pre-existing failures, kept separate from P10

### 5.1 `test:p7` — the HTTP OFF/ON gate

In the battery at `b65f29d` it reported

```
✖ HTTP OFF/ON 50/100/200 Gate preserves outcomes and zero cross-audit binding (14913.939ms)
```

and after that line produced no further output and never exited — the open-handles hang P9 documented,
which is why that suite's summaries have to come from `--test-force-exit` re-runs. The battery run was
terminated at 258 s, so its own error diagnostics were never printed; the exit recorded for it is the
termination's, not the runner's verdict.

The same test command (the only difference being `--test-force-exit`, which affects teardown, not test
behaviour), run solo on both trees minutes apart:

| tree | result |
|---|---|
| `feature/p10-diagnostic-depth` @ `5aa270c` | 6 tests, **6 pass** — 31.4 s; the OFF/ON gate itself 11.1 s with `failures: 0` at 50/100/200 |
| `main` @ `0be4fef` | 6 tests, **6 pass** — 40 s; the gate itself 12.2 s |

So the failure is not deterministic and not bound to either tree: the battery saw it, solo runs on both
trees in this acceptance do not, and P9 saw it on both its branch and `main` (`main @ 903f0a3`),
including in a solo run, with `Error POSTing to endpoint (HTTP 504): MCP_REQUEST_TIMEOUT` — a request
deadline expiring, the shape load and host state produce. P10 changes nothing on this path:
`git diff main...HEAD -- packages/sfoa-mcp-server/src/p7-test` is empty, and the branch's only
shared-code change is additive union members in `request-audit-collector.ts` (compile-time only). The
honest reading is that this gate remains a known pre-existing, condition-dependent failure — observed
again by P10's battery, neither introduced nor fixed by P10.

### 5.2 `validate:p2` / `validate:p3`

Both stop at `Missing Live Inputs SECOND_TEST_USER` — the local `.env.local` has no second test
identity, so the two-user legs cannot run. `p2` reports `PARTIAL` (exit 2) and `p3` `FAIL` (exit 1).
Neither reaches the code under test, and both read exactly as P9 measured them.

### 5.3 `yarn lint`

47 errors, `exit 1`, all of them under `packages/mcp-provider-code-analyzer` — 25 files, all
`@typescript-eslint` (`no-explicit-any` and one `no-unused-vars`). No `@sfoa` package contributes an
error. The tally is identical to P9's, and P10 added none.

### 5.4 The `GovernancePages` timing expiration under contention

The first completeness re-run of the admin-web suite at the tip produced a non-green reading that is
worth naming rather than smoothing over: while the machine was saturated (IDE and antivirus active,
vitest forking a worker per file), one case —
`keeps stop and permanent delete behind explicit confirmations and exposes delete only for disabled routes` —
hit the suite's own bounded timeout (60 490 ms against `testTimeout: 60_000` in
`packages/sfoa-admin-web/vite.config.ts`), and its file took 289 s. The evidence that this was the load,
not the code: run alone, the same file passes **14 / 14** in 185 s; re-run, the full suite passes
**13 files / 84 tests** in 402.7 s, `exit 0` — the same reading the root run at `b65f29d` produced
(504 s, §2).

This is the repository's documented contention pattern, not a logic failure: `P6_AGENT_01_REPORT.md`
("three existing `GovernancePages` timing expirations" at the old default timeout, passing under the
60 s diagnostic timeout), `P6_ID_01_HOTFIX01_REPORT.md` ("while the machine was saturated"),
`TEST_MATRIX.md` ("the isolated timed test passed"), and `SKILL_02C_IMPLEMENTATION_REPORT.md`
("60 s 超时…判定为资源竞争，非逻辑失败"). The 60 s bound exists because this machine's antd/jsdom
governance flows need more than the stock timeout; it refuses genuine hangs, and crossing it under
load is its known false-alarm mode. P10's only `sfoa-admin-web` changes are one localization label
and two Playbook-version assertions; the page code and the test are untouched by the branch.

## 6. Audit acceptance

The plan's audit criterion — **every new Tool on the chain, and a credential-pattern scan at zero
hits** — is a leg of the phase gate itself, run in-process on the test server against the shared
Control Plane. Each Tool's own `yarn ai:audit --tool … --since … --latest 20` chain walk is carried on
its task's evidence page (T2 §Audit, T3 §Audit, T4 §Audit, T5 §Audit); this section is the
phase-level roll-up.

**A caution that shaped the method.** `sfoa_audit_log.request_summary_json` holds a raw Buntu JWT on
its `<none>` rows, so nothing here selected that column's contents. The credential scan is a
`COUNT(*) … WHERE <column> LIKE <pattern>` over named columns — it counts matches and never reads a
value into the report, and the coverage leg reads only `tool_name`, `id`, `platform_user_id` and the
masked identity the gate resolved in its own process. No platform user id was placed on a command
line, and the run masks it (`08***48`) before printing.

**How attribution works.** The gate takes `MAX(id)` as a watermark *before* the first Tool call, then
counts rows with `id > watermark`, so the coverage below is exactly this run's traffic and cannot be
satisfied by an older run's rows.

### 6.1 Every P10 Tool left a trail

| Tool | rows in the run's window | required because |
|---|---|---|
| `set_trace_flag` | 1 | T2 write leg PASS (the trace write is sandbox-only) |
| `get_apex_logs` | 22 | T2 mode `CLOSED_LOOP` — the list leg always runs |
| `get_debug_log_body` | 2 | T2 body leg PASS |
| `explain_field_access` | 6 | T3 mode `CONSTRUCTED` |
| `list_metadata_components` | 24 | T4 mode `MEASURED` |
| `get_platform_diagnostics` | 5 | T5 mode `MEASURED` |

`missing: []` — all six are present. The counts are the Tools' own call counts including the poll
loops (T2's activation wait alone accounts for a large share of `get_apex_logs`), which is why they
are larger than the milestone's user-visible call count.

**Caller and executing identity are on the same row.** The phase gate proves the caller half by
construction — every reading above is scoped to the platform user it injected — and the task evidence
pages carry the other half from the rows themselves: T3's audit section reads all 28 of its rows as
`identitySource = INTERNAL_SERVICE_HEADER` with `executionRole = DIAGNOSTIC` and exactly one distinct
Salesforce username (the fixed diagnostic identity), so no Tool downgraded to the caller's own
credentials; T4's page reads the same on every row it inspected. Refused calls are audited as refusals —
T3's two boundary refusals carry `result: ERROR` / `outcome: FAILED` with the same
`MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED` the caller saw, and a `requestSummary.summary` that names what was
asked without revealing whether the user exists.

### 6.2 No credential-shaped content

Four patterns × four columns, scoped both to the run's window and to the whole table:

| pattern | what it would find | run-scoped | all-time |
|---|---|---|---|
| `%Bearer %` | an Authorization header value | 0 | 0 |
| `%eyJ%.eyJ%` | a JWT with header and payload segments | 0 | 0 |
| `%sfoa_ub1_%` | a user-bound MCP token | 0 | 0 |
| `%PRIVATE KEY%` | a PEM private key marker | 0 | 0 |

Columns scanned: `request_summary_json`, `response_summary_json`, `error_message_safe` on
`AUDIT_LOG`, and `safe_payload` on `PAYLOAD_EVIDENCE` — 16 readings, every one zero. The scan is
pattern-based, so what it establishes is that those four shapes are absent from those columns, in the
run and in the table; it is not a proof about arbitrary token formats. Alongside it, each milestone
inspected the Tool **responses** it received for secrets it had itself supplied (T2 3 responses,
T3 6, T4 28, T5 4) with `offenders: []` everywhere, and the phase-level `credentialSafety` leg reports
the same over its own three.

### 6.3 The chain persisted, and it says so

`auditPersistence` at phase level: `flushed: true`, `dropped: 0`, `enqueuedSnapshots: 3` ==
`persistedSnapshots: 3`, `queueDepth: 0`, `writerFailureCount: 0`, `droppedSnapshots: 0`, and the
shutdown barrier reports `drained: true` with `forcedConnections: false`. Every milestone carries the
same leg against its own larger count (T3 6/6, T4 28/28, T5 4/4) — the flush barrier the P9 fix
required is in the phase harness (`client.close → server.close → assert drained → flush`) and is what
makes these readings evidence rather than a hope.

Not re-run for T6: a phase-level `yarn ai:audit --user … --latest 20 --since 24h` trace walk in P9's
§6.1 shape, with the chain's field-availability map. The per-Tool walks live on the task evidence
pages; the phase-level walk as a single human-facing review is named in §7.

## 7. Not executed

The P9 standard: a leg that was not run is named as not run, and no unexecuted item is written as done.
Everything below is carried in full on its own task's evidence page; this is the phase-level roll-up.

**Deployment-level, and the one that matters most.**

- **No P10 Tool has been enabled through the Control Plane console.** All six are granted *in memory* by
  the milestones' snapshot wrapper; no `sfoa_tool_control` row exists for any of them on this deployment.
  The milestones prove the Tools and prove that the grant path can carry them; enabling one through the
  real gateway and calling it as an ordinary caller is the end-to-end step still owed
  (T3 §6, T4 §6, T5 §6).
- **`A-1`, cross-user `ApexLog` visibility.** Every log the diagnostic identity could read was its own
  (`LogUser` = the identity), which is consistent with ownership alone and does not demonstrate
  `View All Data`. [ADR-0029](adr/ADR-0029-p10-diagnostic-identity-prerequisites.md) therefore carries it
  as a production enablement check rather than an established fact (T0 §3, T2 §6, T4 §6).
- **The production TraceFlag write probe.** ADR-0029 forbids writing a trace flag outside a sandbox, so
  the write path is measured on the sandbox only (T0 §2).
- **Production readability of every P10 data source** — `SetupAuditTrail`, `AsyncApexJob`, `CronTrigger`,
  the metadata types, the permission tables. Measured *for this org and this identity*; a production org
  answers for itself by running the same milestones (T4 §6, T5 §6).

**Live legs that no run has driven.**

- **The stall rule's positive case** (`get_platform_diagnostics`): needs an org with a populated
  `CronTrigger` and a genuinely late schedule; this org holds zero rows. The three assessments are
  fixture-tested only (T5 §6).
- **The `UNAVAILABLE` / `totalCount: null` branch**: needs a source or identity that refuses one of the
  three reads; unit-tested only (T5 §6).
- **`explain_field_access`'s `INDETERMINATE`**: no live scenario made a layer unreadable (T3 §6).
- **Both budget ladders** on `get_platform_diagnostics`: nothing has yet made the byte or text ladder
  cut; the widest admitted answer sat at 61 533 B of 262 144 (T5 §6).
- **`includeInactive` on `list_metadata_components`**: needs an org with a recycled component; the
  default, the filter and the echo are unit- and protocol-tested (T4 §6).
- **The over-budget truncation path on the metadata pair**: no live input was large enough to make the
  trim cut (T4 §6).
- **The `Aborted` literal** (`AsyncApexJob`): never observed in a vocabulary read (T5 §6).
- **The human half of two cross-checks.** T3's "compare against the Setup page" and T4's "count the
  components in the UI" are each half done: the machine halves are in the evidence pages, the
  person-at-Setup halves are owed by construction — a harness cannot open Setup (T3 §6, T4 §6).
- **`Account.Name` reading as `visible: false`** on this org (no `FieldPermissions` row for a field
  everyone can see), and a `FieldPermissions` row's two spellings of the field name. Both are recorded
  rather than smoothed over, because each is a way the contract could be described wrongly to a customer
  (T3 §6).
- **`EscalationRule`'s zero count** rests on a single method (no Tooling counterpart on this org to
  cross-check against) (T4 §6).

**An acceptance activity that was not repeated.**

- **A phase-level `yarn ai:audit --user … --latest 20 --since 24h` trace walk**, in the shape P9's
  §6.1 used. The per-Tool walks are on the task evidence pages and the phase gate's own two audit legs
  are in §6, so the criterion is covered; the single human-facing phase-level review is what T6 did
  not add.

**Known and deliberately not worked around.**

- **One constructed `AsyncApexJob` row is not cleanable** and the next T5 run inherits it; the gate is
  built to pass in that state rather than to false-fail, and the report states it rather than hiding the
  row the Tool's filter exists to show (T5 §6, ADR-0033 Consequences).
- **The `get_apex_logs` hint on an `AnonymousBlock` body** names the synthetic class, so its suggested
  `SELECT Body FROM ApexClass` would return nothing for that frame. Recorded rather than suppressed,
  because suppressing it would remove the hint from the case it is most useful in (T2 §6).
- **The prompt's T5 改进空间 was deliberately left unexplored** (extra Tooling sections, paging the
  timeline, an Agent-facing playbook entry for the Tool). Recorded as open decisions, not unfinished
  work (T5 §6, ADR-0033 Consequences).

## 8. Conclusion

P10's six Tools and one Skill are built, unit- and protocol-tested, deployed to `crm-ex-test02` behind
Tool Governance and default-disabled, and the phase gate drives all four live milestones in one process
against the real org. Three milestone scenarios are closed on live evidence: the Apex-exception loop
(trace → reproduce → body → `expectedLine: 3`), the field-attribution chain with its two boundary
refusals, and the merged change timeline whose 25 `SetupAuditTrail` rows and `totalCount: 654` agree
with an independent read. The audit criterion is met in-process: all six Tools on the chain, four
credential patterns at zero across four columns, and a flush barrier that reports `drained: true` —
the P9 fix is what makes those readings measurements rather than hopes.

The verdict is `overall: PARTIAL`, and the honesty of that word is the point: the only non-PASS leg is
T4's `includeInactive`, which needs a recycled component this org does not have and is recorded as
NOT TESTED rather than waved through. §7 carries the rest of what was not executed, including the one
deployment step still owed — enabling a P10 Tool through the Control Plane console and calling it as an
ordinary caller.

Running the acceptance found a real defect, and fixing it is part of the delivery: a freshly created
`TraceFlag` does not capture immediately, and the T2 gate was measuring inside that window. The fix
waits for a fresh capture before judging (measured: 2 warm-up executions, 19 polls, 103 635 ms), the
pre-fix `FAIL` and the post-fix `PASS` are both in the record, and the Skill now teaches the delay so
an agent reading an empty listing right after opening a trace asks for a second reproduction instead of
concluding "no exception". The same edit closed a latent false `FAIL` in the read-only path, where the
body legs would have blamed the Tools for a trace write the deployment had correctly declined (§4).

Everything the plan asked to leave behind is in place: Playbook 1.11.0 with the diagnostics contract,
the `sfoa-org-diagnostics` Skill synced to all four client locations, the GAP analysis's P10 table
marked delivered with its ADR numbers, and both CHANGELOGs. The pre-existing failures are unchanged and
measured (§5): the p7 gate fails under battery load and passes solo on both trees, `validate:p2`/`p3`
still stop at the missing second identity, and lint's 47 upstream errors are untouched. None of them is
in P10's surface.

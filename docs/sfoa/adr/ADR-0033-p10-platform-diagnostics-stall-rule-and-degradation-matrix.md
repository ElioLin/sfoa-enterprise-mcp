# ADR-0033: `get_platform_diagnostics` — the stall rule, the degradation matrix, and the three-source whitelist

- Status: Accepted for P10
- Date: 2026-10-09
- Extends: ADR-0029 (§0.3's role/data red line, §3's degradation contract, §4a's per-Tool query whitelist and
  the T5 row it declared, §4d's audit self-answerability rule, §5), ADR-0025/ADR-0026 (bounded
  completeness, an explicit `truncated`, structured errors), ADR-0009 (the server-owned DIAGNOSTIC request
  scope), ADR-0030/ADR-0031/ADR-0032 (the T2–T4 Toolsets and the shape decisions this Tool repeats)
- Evidence: [`P10_T0_LIVE_PROBE_FINDINGS.md`](../P10_T0_LIVE_PROBE_FINDINGS.md) §4 (field-level
  filterability) and §5 (`CronTrigger` measured empty), the T5 probe's window measurements
  (`/data/sfoa-enterprise-mcp/p10-t5-probe-20261009-115829.json`, §6 below), and the T5 live milestone
  recorded in §11

## Context

T5 delivers **GAP-M5**: `get_platform_diagnostics`, the Tool an incident *starts* with. It answers one
question — **"what changed, and when, relative to when it broke"** — by reading three platform-status
sources in a single call and merging them onto one clock: the setup audit trail (`SetupAuditTrail`), the
failed and aborted asynchronous jobs (`AsyncApexJob`), and the scheduler's current state (`CronTrigger`).
The other P10 Tools answer follow-up questions; this one exists so that an Agent does not have to make
three calls and reconcile three clocks itself.

Five measured facts shaped the design before any code was written, and each of them is the reason for one
of the decisions below:

- **`CronTrigger` is empty on the reference org, so the stall rule has no positive live case.** T0 §5 and
  the T5 probe both measured **zero rows**, and the T5 probe confirmed the aggregate form is accepted
  (`SELECT State, COUNT(Id) total FROM CronTrigger GROUP BY State` answers with zero groups rather than a
  refusal). The state vocabulary of a *populated* `CronTrigger` therefore could not be measured — and the
  one thing a stall flag must never do is read an unfamiliar literal as healthy.
- **Filterability is per field, and the most tempting field is the refused one.** T0 §4 measured
  `CreatedDate`, `Action` and `CreatedById` filterable on `SetupAuditTrail` and **`Section` and `Display`
  refused** (`INVALID_FIELD`: "field 'Section' can not be filtered in a query call"). `Section` is the
  field whose name most suggests "narrow to Apex changes", and it is also localized (`Apex 类`,
  `管理用户`) — so it is reported and never matched on.
- **Counting is per object, and the object's own spelling is the wrong one.**
  `SELECT COUNT(Id) FROM SetupAuditTrail` is refused (`MALFORMED_QUERY`); the argument-less `COUNT()` is
  accepted and returns an **empty `records` array with the number in `totalSize`** (probe: 19 404 rows
  org-wide, 448 inside a 24-hour window). Nothing in the response names a field, so a reader that assumes
  `expr0` gets `undefined` and reports 0.
- **`AsyncApexJob.CreatedDate` filterability was unmeasured when T5 began, and the section said so.** The
  first implementation carried only the measured `Status` filter, windowed the rows in memory, and
  documented that its total was "what a bounded scan could establish". The T5 probe measured the date
  filter and the exact conjunction the Tool sends, so §6 below is the record of the window moving into
  the query.
- **ADR-0029 §4a: on the standard API, the whitelist is the entire guarantee.** The same DIAGNOSTIC
  identity that cannot see a `Lead` through the Tooling API **read 955 `Lead` rows** through the standard
  API. All three of this Tool's sources are standard-API reads, so unlike the debug-log Toolset it has no
  structural backstop at all.

## Decision

### 1. The stall rule: `SUSPECTED` needs a waiting literal *and* lateness past a 30-minute grace, and `INDETERMINATE` is the default

The rule is a pure function of the fields the org returned
(`packages/mcp-provider-sfoa-context/src/scheduled-job-stall.ts`), it is unit-tested across every shape
including the ones this org cannot produce, and it is stated in full here because the prompt requires it
to be "保守，宁可标注「疑似」不给武断结论":

| Reading | Assessment | Why |
| --- | --- | --- |
| `State` ∈ {`WAITING`, `QUEUED`, `READY`, `BLOCKED`} **and** `NextFireTime` passed by more than **30 minutes** | `SUSPECTED` | Both facts are the platform's own: it calls the job waiting, and its own clock says the fire time is past. |
| `State` ∈ {`ACQUIRED`, `EXECUTING`} | `NOT_SUSPECTED` | The job is running now. A long run is a different diagnosis and this Tool does not judge one. |
| `State = 'DELETED'` | `NOT_SUSPECTED` | The schedule no longer exists; that is not a schedule that stopped firing. |
| Waiting literal, `NextFireTime` still ahead or less than 30 minutes late | `NOT_SUSPECTED` | A scheduler is allowed to be late. Flagging minutes-late jobs would spend the flag's credibility on scheduler lag. |
| Anything else — an unrecognized `State`, a missing or unparseable `NextFireTime`, `PAUSED`-like states | `INDETERMINATE` | **The default, not a leftover.** This Tool has never measured the state vocabulary (the reference org holds no `CronTrigger` row), so an unfamiliar literal is reported as a gap rather than read as healthy; and a paused schedule fires nowhere, which is an administrator's decision this Tool cannot read. |

Three properties are deliberate rather than incidental:

- **The flag is never a verdict.** Every `SUSPECTED` reason is a fact the org returned plus the rule
  that fired, and the second reason sentence ends "This is a flag to investigate, not a diagnosis: the
  platform says the schedule has not fired, and this Tool does not know why." The T5 prohibition
  「禁止把「疑似卡滞」表述为确定结论」 is enforced at the only place the flag is produced.
- **The grace window is 30 minutes, flat.** Chosen to be uninteresting: the platform's own scheduler lag
  is seconds, a long-running job holds its trigger in a *running* state rather than a waiting one, and a
  job half an hour late while the platform still calls it waiting is late in a way no healthy reading
  explains. A larger window would hide real stalls; a smaller one would flag lag.
- **The rule does not compare across calls.** It does not use `TimesTriggered` as history (one snapshot
  has none), and it does not treat a missing `PreviousFireTime` as evidence — a job created inside the
  window legitimately has none. `PreviousFireTime` is reported because a reader wants it.

The consequence is recorded as a fact rather than glossed: **on this org the rule is vacuous** — zero
`CronTrigger` rows means every one of the three assessments has a unit-test fixture and none has a live
positive case. The live milestone gates the *section* (a READ section with a count of zero and a caveat)
and reports the stall leg as vacuous; the rule's live proof is a future org with a populated scheduler.

### 2. The degradation matrix: per-section state, a nullable count, and a zero that is *evidenced*

ADR-0029 §3's aggregator clause is the shape of the whole answer. `success: true` on this Tool means "the
aggregation ran and every requested section declared its state" — **never** "every source was read". Each
of the three reads is wrapped on its own, and the matrix is:

| Situation | Section state | What it carries |
| --- | --- | --- |
| Source read, rows found | `READ` | entries, the window's true `totalCount`, `truncated` |
| Source read, genuinely no row | `READ` with `totalCount: 0` | a caveat saying *why* it is empty (the `CronTrigger` caveat names the empty table) |
| Permission refusal on the source | `UNAVAILABLE` | `prerequisite` = "`<Object>` readability on the diagnostic identity", `errorCode` = `MCP_DIAGNOSTIC_PREREQUISITE_MISSING`, `totalCount: null`, a reason sentence |
| Any other read failure on the source | `UNAVAILABLE` | `errorCode` = `MCP_PLATFORM_DIAGNOSTICS_READ_FAILED`, `prerequisite: null`, `totalCount: null` |
| The count or the oldest-retained bound alone fails | section stays `READ` | the number degrades to `null` **with a caveat** — a bound a reader wants is not the evidence itself |
| The status-vocabulary read fails beside a **non-zero** match | section stays `READ` | a caveat; the entries are the evidence |
| The status-vocabulary read fails beside a **zero** match | `UNAVAILABLE` | nothing then establishes that the `Failed`/`Aborted` filter matched nothing rather than the wrong literals |
| The Connection itself cannot be opened / the identity guard refuses | the **call** fails | `MCP_DIAGNOSTIC_PREREQUISITE_MISSING` — there is no section state yet to report |

`totalCount` is typed `number | null` and `null` on `UNAVAILABLE`, never `0`. That typing is the one
place where a wrong type would undo the entire contract, because a consumer reading `0` as "there were
none" would turn an unreadable source back into a silent empty result.

The two "evidence" mechanisms are the part a careless implementation would omit:

- **The status vocabulary** (`SELECT Status, COUNT(Id) total FROM AsyncApexJob GROUP BY Status`) is a
  second, window-independent read reported beside the entries. It is what makes a zero-entry failure
  section *evidenced*: the filter visibly ran against a real table. The probe measured this org
  translating at least one status vocabulary (`ApexLog.Status`, T2 §1), so a filter that matched zero
  rows could otherwise be a filter matching the wrong literals — and the last row of the matrix above is
  exactly that case.
- **The oldest retained row** (`SELECT Id, CreatedDate FROM SetupAuditTrail ORDER BY CreatedDate ASC
  LIMIT 1`, probe: `2026-04-13T01:02:03.000+0000`) bounds how far back the trail reaches, because
  Salesforce exposes no retention policy to SOQL. The hint states it, which is the prompt's改进空间 item
  「若 probe 发现 SetupAuditTrail 保留期短…在 hint 中提示窗口与保留期的关系」 answered as a measured
  bound rather than an assumed 90 days.

### 3. The whitelist is `['SetupAuditTrail', 'AsyncApexJob', 'CronTrigger']`, and `ApexLog` was dropped from §4a's T5 row on purpose

ADR-0029 §4a declared T5's objects as `AsyncApexJob`, `CronTrigger`, `SetupAuditTrail`, `ApexLog`
("Standard + Tooling"). The shipped whitelist is the three standard-API objects, and the narrowing is a
decision:

- **The log surface already has a better-scoped owner.** `get_apex_logs` and `get_debug_log_body` exist,
  they read `ApexLog` through the Tooling API (structurally enforced), and they treat a log *body* as the
  artifact it is — streamed, bounded and summarised by exception. A merged timeline cannot carry log
  bodies without spending the budget this answer shares with three sections on rows an Agent can already
  fetch deliberately.
- **The Tooling half was never this Tool's.** §4a's row was written when `AsyncApexJob`'s date
  filterability was unmeasured and a Tooling fallback was conceivable. The T5 probe settled the date
  filter (§6), so the Tool is a standard-API Tool with no Tooling surface at all — and the hint, when
  `get_apex_logs` is advertised, points at it by name instead of duplicating it.

Because nothing enforces the standard API (the 955-`Lead` measurement), the whitelist *is* the whole
guarantee, and it is enforced the way §4a requires: `PLATFORM_DIAGNOSTICS_STANDARD_OBJECTS` is
hardcoded, and a unit test scans the executor's **compiled source** for every `FROM` target and asserts
it is on the list — plus a live gate that brackets all four Tool calls of the milestone run and asserts
that no statement inside a bracket named anything else and that **no statement was a write**
(`dml: []`, `offWhitelist: []`).

### 4. The window is enforced in SOQL where the filter is measured, and its two edges are two clocks

`windowHours` (default 24, bounds 1–168 as the prompt fixes them) produces `{from, to, hours}` where `to`
is the moment of the call and `from = to − hours`. What the window *means* is per section, and the
answer says so rather than implying one meaning:

- **`SetupAuditTrail` and `AsyncApexJob` are history**: both are narrowed in SOQL on a
  measured-filterable `CreatedDate` with an unquoted `dateTime` literal (`CreatedDate >= 2026-…Z`), so
  「禁止超窗口回传」 is a property of the statement and not of an in-memory filter — and the in-memory
  filter is kept as well, because a filter that silently disappears is a filter nobody notices losing.
- **`CronTrigger` is current state, not history.** The window does not narrow the section at all; it
  only decides which jobs reach the merged timeline (a `SUSPECTED` job enters at the fire time it missed,
  every other job at the time it last fired). A window therefore cannot make the section report a *past*
  stall, and the input schema's description says exactly that.
- **The upper edge is stamped by this server's clock, not the org's**, and the live gate records how far
  the harness's clock sat from that stamp when it read it — **1 316 ms** on the reference run, which is
  the call's own round trip rather than a clock disagreement (server and harness share one host there).
  The org is a genuine second clock domain: measured **14.7 s behind the host** (an unauthenticated HTTP
  `Date` read), and the run's own stamps agree — the job its fixture submitted carries an org-side
  `CreatedDate` ~15 s earlier than the host-side instant of the submit, and the previous run's fixture
  cleanup is the newest `SetupAuditTrail` row of a window computed two minutes later. A window edge is
  therefore honest only to that order, which is immaterial at 24 h and is why the note names the two
  clocks instead of promising a boundary. Rows newer than `to` on the org's clock are *kept* (the newest
  change is the one an incident is read for). That is the only direction the honesty rule can be
  satisfied in: dropping a row because two clocks disagree would hide evidence in the name of a boundary.

### 5. The dual budget: entries before fields, then a text budget that drops detail before it drops the timeline

The prompt requires the double budget and per-section `truncated`; the implementation is a ladder rather
than a single cut:

1. **The structured payload** is bounded by `DATA_MAX_RESPONSE_BYTES` (256 KiB, the runtime-wide
   constant). The ladder halves every section that is still above one entry, largest first, so it reaches
   the floor in ~log₂ steps and no rung can be larger than the one above it; then the whole ladder is
   retried with the **field-clip** step on, which shortens the two unbounded strings (`Display`,
   `ExtendedStatus`) and the scheduled job's free text at 500 characters.
2. **Both cuts are declared per section.** `truncated` is the union of "the window holds more than the
   section read" and "the budget cut what the section read", because a caller deciding whether to re-run
   cares about either; *which* one it was is in the section's caveats, and a clipped value's caveat says
   a value is shorter than what the org returned. The last rung (one entry per section, fields clipped)
   is unreachable for any input the schemas admit — the guard exists for a future unbounded field, not
   for a state a caller can provoke.
3. **The rendered text** is separately bounded (`PLATFORM_DIAGNOSTICS_MAX_TEXT_CHARACTERS`, 60 000
   characters — a context budget, not a transport one) and drops *by position*: per-entry detail first
   (it is a re-listing of what `structuredContent` carries in full), then the **earliest** timeline
   entries (an incident is read from the newest end), and the header, note and hint never. An Agent
   reading a shortened answer still learns which sections were read and what is on the timeline.

Per-section `truncated` therefore means "this section is not the whole window"; the caller's own
`limitPerSection` is not reported as a truncation, because a caller who asked for 25 of 400 rows already
knows it asked for 25.

### 6. The `AsyncApexJob` window moved into the query, and the probe is what moved it

The first implementation windowed the failure section **in memory** over a newest-first scan, and its
comment said why: `CreatedDate` filterability on `AsyncApexJob` was unmeasured, and an unmeasured filter
is an `INVALID_FIELD` that takes a whole section down. That made the section's total "what a bounded scan
could establish" rather than the window's own count.

The T5 probe (`p10-t5-probe-20261009-115829.json`, run 2026-10-09 03:58 UTC) measured the three shapes
that decision was waiting on — all `AVAILABLE`:

| Step | Statement shape | Measured answer |
| --- | --- | --- |
| `STANDARD_ASYNC_APEX_JOB_CREATED_DATE_FILTER` | `… WHERE CreatedDate >= <literal> ORDER BY CreatedDate DESC LIMIT 1` | 1 row, newest `2026-10-09T03:51:28.000+0000` |
| `STANDARD_ASYNC_APEX_JOB_WINDOW_COUNT` | `SELECT COUNT() FROM AsyncApexJob WHERE CreatedDate >= <literal>` | `totalSize` 93, empty `records` |
| `STANDARD_ASYNC_APEX_JOB_WINDOWED_FAILURE_QUERY` / `…_COUNT` | the exact `Status IN ('Failed','Aborted') AND CreatedDate >= …` conjunction | 0 rows / 0 — a filter that matched nothing, not a refusal |

Two separately-filterable fields do not make a filterable *conjunction*, which is why the probe sent the
wrapped statement itself. With that measured, the window moved into the query and the total comes from
the aggregate read; the probe steps stayed in `probe:p10` so a deployment re-measures the shapes instead
of inheriting this org's answer. The same probe round measured the windowed `SetupAuditTrail` query (25
rows, newest `2026-10-09T03:29:29.000+0000`), its `COUNT()` (448, empty `records`), and the `CronTrigger`
`GROUP BY State` form (accepted, zero groups).

### 7. The timeline: one clock, deterministic ties, built only from what the answer carries

`alignment.timeline` is the Tool's unique value and its subtlest contract:

- **Sorted on parsed instants, oldest first** — not on the strings, because the org's timestamps arrive
  in two spellings (`…Z` from this server's window, `…+0000` from jsforce's rendering) that sort
  differently as text. Ties break on the contract's section order and then on the entry id, so two
  identical calls produce byte-identical timelines: a diagnostic reading that reshuffles between calls
  is not evidence anyone can cite. The live gate rebuilds the expected timeline with the same comparator
  and requires the lists to be identical.
- **Each entry names its own section**, because the three sources are not comparable evidence: a setup
  change is somebody's action, a failure is an outcome, a scheduled line is either a fire or a due time
  the platform did not meet.
- **A scheduled job contributes at most one line**, worded differently for the two cases: `SUSPECTED`
  enters at the time it *was due to fire and did not*; everything else at the time it *last fired*.
- **Built from returned entries, not from everything read** — a timeline naming a row the answer does not
  carry would be a citation a caller cannot follow. The consequence is stated in the note: after a budget
  cut the timeline is a prefix of the window, not the window.
- **The note carries what a list cannot show**: that the nearest entry above a symptom is a candidate
  and not a cause; that a section is missing because it could not be read (never inferable from a shorter
  list); that a section is missing because *this call* did not ask for it — the same absence, a different
  remedy; that a cut happened at all; and that the window's two edges are two clocks.

### 8. The hint: the unavailable branch leads, and it may only name an advertised Tool

`platformDiagnosticsHint` (a pure function, unit-tested) applies the T2 rule — a hint may only name a
Tool the session's `tools/list` advertises — and then leads with the branch that matters: **if any
section is `UNAVAILABLE`, that is the first sentence**, naming the section and its missing prerequisite
and stating that the timeline is missing that evidence rather than the org being quiet. A timeline
*looks* complete; an unavailable section simply contributes no lines. That asymmetry is this Tool's own
failure mode and the hint is where it is said out loud. Behind it: a truncated answer, then an
all-empty window ("no change… but widen `windowHours` before concluding"), then the ordinary
candidate-not-cause guidance. The two Tool-naming branches (`get_metadata_component_context`,
`get_apex_logs`) are each gated on the advertised set and degrade to a sentence naming no Tool.

### 9. Governance: DIAGNOSTIC, default-disabled, host-side, its own audit purpose, out of the playbook

- `SFOA_CONTEXT_TOOL_ROLES` maps the Tool to `'DIAGNOSTIC'`; `assertDiagnosticScope` refuses it on a
  USER scope before a Connection is opened, and the facade refuses the route first — a USER call is
  audited `BLOCKED` and never reaches the executor (unit-tested both ways).
- **The executor is host-side**, unlike the metadata pair, for the §4a reason: the whitelist is the
  entire guarantee, so it is only meaningful in the code that also holds the `RequestScope` proving
  which route the Connection was opened for. The provider owns the contract, the schemas, the stall rule
  and the hint; the host owns the identity guard, the Connection, the query shapes, the degradation
  matrix and the budget.
- **`PLATFORM_DIAGNOSTICS` is its own audit purpose.** `apiCategory` is `STANDARD` for all three
  sources, and none of the existing purposes answers the question the row is read for: "who asked the
  platform what had recently changed and failed". Folding it into `DIAGNOSTIC_TOOLING` would name a
  Tooling call that never happened; into `PERMISSION_EXPLAIN`, a change-and-failure read under a
  permission heading (§4d's self-answerability test).
- The audit row records the call's own scope as sent — `windowHours`, the section list, the resolved
  counts and `timelineEntryCount` — so a row that cannot tell a one-hour incident read from a week-long
  one does not exist, and a partially-degraded call is legible as such from the audit alone.
- **Console catalogue:** `buildAdminToolCatalog` emits a `READ` entry structurally, and its dependency
  line names the three sources' readability on the diagnostic account rather than an ADR-0029 §2 letter
  (§2's `A-1`…`A-4` are the Tooling log surface and the Metadata API; this Tool reads neither).
- **Playbook:** not added, following T2–T4. The SFOA context Toolset is filtered out of the
  `OFFICIAL_TOOL_CATALOG` lookup, and the Tool is not in `AGENT_RECOGNIZED_TOOL_NAMES`, so no Dify/WeCom
  instruction carries it. Whether it should reach the Agent-facing playbook remains a separate,
  deliberate decision that has not been made.

### 10. The constructed failure: the platform's own batch semantics, measured

The T5 acceptance says "构造一个 Failed 的 AsyncApexJob（如抛异常的 batch 测试类）". The milestone
implements that on a sandbox, and the first live run measured why the obvious fixture is wrong:

- **An exception thrown from `Database.Batchable.execute` does *not* fail the job.** Measured: two chunks
  threw, the job's status was `Completed`, and `NumberOfErrors` came back `2` with a `null`
  `ExtendedStatus`. The framework contains a chunk's exception; the job is still "completed".
- **A failure raised in `start` fails the job.** The shipped fixture asserts false in `start` and the
  platform answered `Status = 'Failed'`, `NumberOfErrors = 1`, `ExtendedStatus = "First error: Assertion
  Failed: …"` — the row the failure section exists to report. The milestone's doc comment records the
  measurement, so a later edit that "simplifies" the fixture back to the `execute` form fails the gate
  with the reason attached.
- **An `ApexClass` with `AsyncApexJob` children can be deleted.** The leg deletes its fixture class
  whatever happened before (`cleanup.ok: true`, measured across both runs), and the class's
  create-and-delete is itself a pair of `SetupAuditTrail` rows (`createdApexClass` / `deletedApexClass`).
  What cannot be undone is the `AsyncApexJob` row: the platform exposes no delete for it, so the sandbox
  keeps one constructed `Failed` row until Salesforce ages it out (~7 days) — recorded here and in the
  evidence page because a re-run inside that window sees a non-empty failure section and reports
  `emptySourceClarity`'s async leg as not-measured rather than as a pass.

## Consequences

- **The stall rule has no live positive case on this org.** Its three assessments are unit-tested against
  every shape, and the live milestone records the section's zero-row state as a fact; the flag's live
  proof is a future org with a populated `CronTrigger`.
- **The three standard-API reads are unenforced by the org.** §4a measured it; §3 above is the
  mitigation. A future section or source added to this Tool inherits that property, which is why the
  whitelist's unit test scans the compiled source rather than a configuration value.
- **A section is only as good as its evidence reads.** The `SetupAuditTrail` count and the oldest-retained
  bound degrade to `null` with a caveat rather than failing the section, and the failure section treats a
  failed vocabulary read beside zero matches as `UNAVAILABLE` — the strictest reading of §3 available,
  and the reason its zero-entry answer is a claim the Tool can defend.
- **`truncated` is deliberately over-inclusive per section.** It cannot distinguish "the window is
  bigger" from "the budget cut it"; a consumer that needs the distinction reads the caveats. The
  alternative — two booleans whose meanings a caller must learn — was rejected as a shape nobody reads
  correctly under incident pressure.
- **One sandbox row is not cleanable.** Every run of the live milestone leaves its constructed
  `Failed` `AsyncApexJob` row behind for the platform's retention window. This is stated in the report
  and the evidence page rather than worked around, because the Tool's `Failed`/`Aborted` filter is
  exactly what makes it undeletable-and-visible.
- **Deliberately not decided here.** Whether additional sections should join the three (the prompt's
  改进空间 names recent `ApexClass`/`ApexTrigger` modification times via Tooling — not added, because a
  Tooling source would move this Tool onto the structurally-enforced API for some sections and the
  whitelist-only API for others, and that split needs its own decision); whether the timeline should
  support an offset/page rather than being a prefix under budget; and whether the Tool should reach the
  **Agent-facing playbook** (§9). All three are recorded as open, not as unfinished.

## 11. Live evidence

See [`P10_T5_LIVE_EVIDENCE.md`](../P10_T5_LIVE_EVIDENCE.md) for the runs, the per-gate measurements, the
audit rows, and the list of things the runs do not prove.

The milestone ran three times on the day it was recorded — 03:45, 04:06 and 04:08 UTC, named by start
time throughout — and **the middle run's `FAIL` is the most valuable thing in it**: the fixture that
threw from `execute` produced a `Completed` job and the `constructedFailure` gate failed with four
problems, which is how §10's batch semantics were measured. The re-run, with the fixture failing in
`start`, is `overall: PASS` with all fifteen gates `PASS`; the 03:45 run predates the constructed-failure
leg and carries fourteen. All three reports are kept unedited on the host.

All runs executed on the test server **192.168.156.203** under **Node v22.23.1**, against the sandbox
CHN5S (API v68.0) through the fixed DIAGNOSTIC identity (`verificationStatus = PASS`). The archives:

| Artifact | Path on the host | Size |
| --- | --- | ---: |
| Milestone report, 04:08 UTC (`PASS`, the final run) | `/data/sfoa-enterprise-mcp/p10-t5-milestone-20261009-120824.json` | 12 172 B |
| Milestone report, 04:06 UTC (`FAIL`, the fixture measurement) | `/data/sfoa-enterprise-mcp/p10-t5-milestone-20261009-120607.json` | 12 678 B |
| Milestone report, 03:45 UTC (`PASS`, before the constructed leg) | `/data/sfoa-enterprise-mcp/p10-t5-milestone-20261009-114508.json` | 10 724 B |
| T5 probe report (the window measurements of §6) | `/data/sfoa-enterprise-mcp/p10-t5-probe-20261009-115829.json` | 64 484 B |
| Audit export (`get_platform_diagnostics`, 24 h) | `/data/sfoa-enterprise-mcp/p10-t5-audit-get_platform_diagnostics.json` | 540 663 B |

The 04:08 run measured the three sections against the org's own rows (setup changes 25 of 450 in the
window, `vacuous: false`; the failure and scheduled sections empty and gated as such), merged 25 timeline
entries that the harness reproduced exactly, called the Tool at the widest input the schemas admit
(`windowHours: 168`, `limitPerSection: 100`) and stayed inside both budgets — 61 533 B of 262 144 B
structured and 34 780 of 60 000 characters of text — while declaring the per-section truncation that the
call's own `limitPerSection` produced (100 entries kept of 587 in the widest section), and constructed
the `Failed` job that the failure section then reported with the right id, class, timestamp and error
count. The audit trail carries 11 calls over 24 hours, every one `PASS`/`SUCCESS` under
`executionRole = DIAGNOSTIC` / `identitySource = INTERNAL_SERVICE_HEADER` with `dmlRows = 0`, and the
purpose split confirms §9: `PLATFORM_DIAGNOSTICS` beside the identity layer's own
`IDENTITY_AUTHENTICATION` / `IDENTITY_TOKEN_EXCHANGE` rows and nothing else — the export's object scan
lists `ScratchOrgInfo` and `Organization` beside the Tool's three objects, and both are the identity
layer's own warm-up probes, outside every Tool-call bracket.

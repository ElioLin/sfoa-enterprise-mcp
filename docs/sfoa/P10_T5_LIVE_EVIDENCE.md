# P10-T5 live milestone evidence (recorded 2026-10-09)

T5 delivers `get_platform_diagnostics`: one READ/DIAGNOSTIC call that merges three sources of platform
evidence — `SetupAuditTrail` change provenance, failed and aborted `AsyncApexJob` rows, and `CronTrigger`
scheduling state with a conservative suspected-stall flag — into a single time-ordered timeline, so that
"what changed just before this broke" is one call instead of three. This is the delivery of GAP-M5 and the
core of the P10 milestone's scenario (c).

The unit and protocol suites prove the contract against fixtures. This page records what they cannot:

- that each section's answer agrees with the org's own rows **row for row** — actor and action included —
  and that a section holding **zero** rows is an *evidenced* zero, not an unread one;
- that a `Failed` `AsyncApexJob` can be made to exist and that the section and the timeline really carry it.
  A failure section is the one section that cannot be measured against whatever the org happens to hold: it
  has to be constructed;
- that every statement on the wire is one of exactly three whitelisted objects, with no write, no
  outside-window row, and no quoted `dateTime` literal (§1.2).

**The milestone ran three times, and the middle run's `FAIL` is the most valuable thing on this page.** The
04:06 UTC run's fixture threw from `Database.Batchable.execute`; the platform answered `Status = 'Completed'`
with `NumberOfErrors = 2` and `ExtendedStatus = null`; the `constructedFailure` gate reported four problems
instead of a green light (§2.5). That is the platform's own batch semantics, measured — and it is why the
fixture now fails in `start`. The 04:08 UTC re-run is `overall: PASS` with all fifteen gates `PASS`.

**The whitelist is the entire guarantee here, and that is a measured property rather than a slogan.** All
three sources are standard-API objects, and ADR-0029 §4a measured that on the standard API the diagnostic
identity reads what it asks for — the same identity that is refused `Lead` on Tooling reads 955 rows of it
here. So §1.2's wire gate, which asserts exactly three `FROM` targets and no DML around **every** call the
run made, is the whole enforcement (ADR-0033 §3).

## 0. What was measured, on what, and how to read it

| | |
| --- | --- |
| Org | sandbox (`IsSandbox = true`), instance **CHN5S**, org id `00D************MAM`, API **v68.0** |
| Execution identity | the deployment's fixed DIAGNOSTIC identity — configured, enabled, `verificationStatus = PASS`, `c***@runner-corp.com.cn.uat`, platform user `08***48` |
| Mode | **`MEASURED`** — the Control Plane routed a verified Diagnostic identity, so the Tool was enabled in memory and every gate ran (the constraint §1.3 records) |
| Result | **run 04:08 UTC: `overall = PASS`**, all fifteen gates `PASS` |
| Host | the test server `192.168.156.203` (`crm-ex-test02`), built and run with Node **v22.23.1** |
| Reports | `/data/sfoa-enterprise-mcp/p10-t5-milestone-20261009-120824.json` (04:08, 12 172 B, `PASS`), `…-120607.json` (04:06, 12 678 B, `FAIL`), `…-114508.json` (03:45, 10 724 B, `PASS`) — all kept unedited |
| Harness | `packages/sfoa-mcp-server/src/validation/p10-t5-live-milestone.ts`, runnable as `yarn workspace @sfoa/mcp-server milestone:p10-t5` |
| Probe (second instrument) | `/data/sfoa-enterprise-mcp/p10-t5-probe-20261009-115829.json` (64 484 B), `yarn workspace @sfoa/mcp-server probe:p10` |
| Audit export | `/data/sfoa-enterprise-mcp/p10-t5-audit-get_platform_diagnostics.json` (540 663 B), read back with `yarn ai:audit` |
| Tree measured | `sfoa-p10-t5-live.tar.gz`, sha256 `211c0f97fdfaa3ac2e80fb39e2a37f71c1be0e291fffea77d08e87f22bb21248`, 1 332 entries, every one verified against an LF manifest (`3f4507ce5323c2e8b343e60aa7efe090dda9edf3cf06adc17aeb73768601a103`) before the run: `manifest_check=PASS`, `manifest_total=1332`, `manifest_bad=0` |

**What the run writes, and where.** Unlike T2–T4 the milestone does write — one Apex class into the sandbox,
so that a `Failed` `AsyncApexJob` can exist at all. The leg is gated twice: it refuses to run unless the org
answers `IsSandbox = true` (`sandbox: true` in the report), and it deletes the class it created
(`cleanup.ok: true`). What it cannot clean is stated in ADR-0033's Consequences: the `AsyncApexJob` row
survives the class that produced it for the platform's retention window, and the Tool's `Failed`/`Aborted`
filter is exactly what makes it undeletable **and** visible. §3 and §6 carry the consequence for a re-run.

**The milestone writes nothing to the Control Plane.** The grant that enables the Tool is a snapshot wrapper
in `AdditiveToolPolicySnapshotSource`, exactly as T2–T4 do it, so a passing run can never be a run that
quietly granted itself the Tool it is supposed to prove can be granted. §1.3 is the deployment's real state.

**Every platform user, org id and Salesforce username in the report is masked where it is produced.** This
page quotes the masked values (`08***48`, `00D************MAM`, `c***@runner-corp.com.cn.uat`) and no others.
The report does **not** mask record ids or the acting administrator's display name, so this page neither
reprints the fixture's own ids nor names the actor: §2.2 describes the actor as the org's single
administrator account, and the platform's action codes (which are what the measurement is about) are quoted
as they are.

### The three runs

| Run (UTC start) | Report | Mode | Result | Gates |
| --- | --- | --- | --- | --- |
| 03:45 | `…-114508.json` | `MEASURED` | **PASS** | 14 — this run predates the constructed-failure leg |
| 04:06 | `…-120607.json` | `MEASURED` | **FAIL** | 14 of 15; `constructedFailure` failed with four problems (§2.5) |
| 04:08 | `…-120824.json` | `MEASURED` | **PASS** | 15 of 15 |

The runs are named by their UTC start time throughout — this page, the ADR and both changelogs — because
only the three host reports exist and the local scratch names they were developed under do not survive the
session. Run 04:06 is not a flaky run a re-run happened to clear: it is the run that **measured** the
semantics §2.5 records, and its report is the primary evidence for them.

## 1. Gate results

Run 04:08's fifteen gates. Every leg of a gate has to hold for the gate to be `PASS`.

| Gate | Result | What it establishes |
| --- | --- | --- |
| `toolInventory` | PASS | the session advertises **24** Tools, set-equal to the snapshot's grant, with the Tool's advertised input keys exactly `limitPerSection` / `sections` / `windowHours` and the contracted hints |
| `sectionCoverage` | PASS | the default call: 3 sections requested, 3 `READ`, **0** unavailable, default window 24 h, hint and text non-empty |
| `setupChangeFidelity` | PASS | `SETUP_CHANGES` agrees with the harness's own `SetupAuditTrail` read: **25 of 450** in the window, ids present, timestamps identical and non-increasing, actor and action carried |
| `asyncFailureFidelity` | PASS | the failure section agrees with an independent read, and its **zero** is corroborated by the org's own status vocabulary |
| `scheduledJobFidelity` | PASS | `SCHEDULED_JOBS` against the independent read — `vacuous: true`, because the org holds no `CronTrigger` row (§2.4) |
| `emptySourceClarity` | PASS | both empty sources came back `READ` with count 0 rather than as failures, and the cron section says why it is empty |
| `windowHonesty` | PASS | the declared window spans exactly the requested 24 h and **no entry falls outside it**; the server's own clock skew is recorded |
| `mergedTimeline` | PASS | the timeline is **25 entries** the harness rebuilt from the independent reads, in the contract's order, ties included |
| `sectionSelection` | PASS | a two-section request returns those two and no more, and the note says the timeline covers a subset |
| `stallFlag` | PASS | the flag's count agrees with its rows, every flag is hedged, and no assessment disagrees with the published rule — `vacuous: true` on this org |
| `budget` | PASS | the widest input the schemas admit fits **both** budgets, and every truncated section is explicable |
| `constructedFailure` | PASS | a `Failed` `AsyncApexJob` was constructed in the sandbox and the Tool carried it into the section **and** the timeline |
| `surface` | PASS | 4 Tool-call windows, 23 statements, exactly three `FROM` targets, `offWhitelist: []`, `dml: []`, no quoted `dateTime` literal |
| `credentialSafety` | PASS | all 4 Tool responses inspected for the 2 live secrets, `offenders: []` |
| `auditPersistence` | PASS | 4 snapshots enqueued, 4 persisted, 0 dropped, queue drained and depth 0 |

### 1.1 The Tool's advertised contract

The advertised inventory was **24 Tools**, asserted equal to the snapshot's grant by **set equality**
rather than containment, so a Tool that vanished from the session would fail the gate rather than merely
shrink it.

| | |
| --- | --- |
| Advertised input keys | `limitPerSection`, `sections`, `windowHours` — asserted as a **set equality** on what the session advertises, not as a scan for forbidden names, so a fourth key cannot slip in unnoticed |
| `readOnlyHint` / `destructiveHint` | `true` / `false` |
| `idempotentHint` / `openWorldHint` | `true` / `true` |

No key accepts a username, a token, an org, a file path or a SOQL fragment — there is no parameter through
which a caller could widen the Tool past its three whitelisted objects, which is why §1.2 has to be a wire
assertion.

### 1.2 The wire surface: 23 statements, three objects, no writes

The harness brackets each Tool call and asserts only inside the bracket, so the scaffolding's own reads
cannot be folded into a claim about the Tool. The run bracketed **4 Tool-call windows**:

| Call | Sections asked | Statements | Windowed |
| --- | --- | ---: | ---: |
| default (24 h, limit 25) | all three | 7 | 4 |
| subset (24 h, limit 25) | `SETUP_CHANGES` + `ASYNC_FAILURES` | 6 | 4 |
| widest (168 h, limit 100) | all three | 7 | 4 |
| constructed (1 h, limit 25) | `ASYNC_FAILURES` | 3 | 2 |
| **total** | | **23** | **14** |

The seven statements of a full call are: the `SetupAuditTrail` rows, its window count, its oldest retained
row; the `AsyncApexJob` `Failed`/`Aborted` rows, the window-independent status vocabulary, its window
count; and the `CronTrigger` rows. The assertions over all 23:

- `distinctTargets` is exactly `["AsyncApexJob", "CronTrigger", "SetupAuditTrail"]` with `offWhitelist: []`
  — the check is on the `FROM` target the Tool actually sent, which the schema cannot police, since a
  caller never names an object at all;
- `dml: []` — no `INSERT`/`UPDATE`/`DELETE`/`UPSERT` statement anywhere in the run's brackets, so the
  write the fixture leg performs is visibly the harness's and not the Tool's;
- `quotedDateTimeLiterals: []` — every window bound travelled as a bare `dateTime`, the form the probe
  measured as accepted, rather than as a quoted string this org would have silently mis-filtered;
- `countIdOnSetupAuditTrail: []` — the counts use the argument-less `COUNT()` form the probe verified,
  because `COUNT(Id)` on this object is not the same measurement.

The audit trail corroborates the bracket from the other side: the four traces carry 10 / 9 / 10 / 6 captured
Salesforce calls, which is exactly 3 identity-layer rows (one token exchange, two authentication warm-ups)
beside 7 / 6 / 7 / 3 Tool statements (§5).

### 1.3 Where the Tool's enablement actually lives on this deployment

Measured in the Control Plane (`sfoa_tool_control`), not inferred: **there is no row for
`get_platform_diagnostics`** — 23 rows cover the other 23 advertised Tools — and none for T3's
`explain_field_access` or T4's `list_metadata_components` either. So on this deployment the P10 Tools are
**default-disabled and not enabled through the Console**, which is the configured state, not a defect, and
every P10 milestone proves its Tools by granting them **in memory** (§0).

The Console's structural catalogue does carry a `get_platform_diagnostics` entry — a `READ` /
`DIAGNOSTIC` entry generated from the Tool-name constant rather than hand-written, whose dependency line
names the three sources' readability separately so an Admin reads the per-section degradation as the
declared behaviour. The Tool is not in the Agent-facing playbook (ADR-0033 §9). A reader of §5 is therefore
reading a Tool a real caller cannot reach yet, and the remaining end-to-end step is the same one T3 and T4
carry: enable it in the Console and call it through the real gateway without the in-memory wrapper.

## 2. The three sections, measured

### 2.1 The default call: three sections, two of them empty

`sectionCoverage` asserts the shape the contract fixes, and it is worth reading as the answer an agent will
usually get — the default call on an org whose scheduled-job table is empty:

| Section | Status | Entries | `totalCount` | `truncated` | Caveats |
| --- | --- | ---: | ---: | --- | ---: |
| `SETUP_CHANGES` | `READ` | 25 | 450 | `true` | 0 |
| `ASYNC_FAILURES` | `READ` | 0 | 0 | `false` | 0 |
| `SCHEDULED_JOBS` | `READ` | 0 | 0 | `false` | 1 |

`readSectionCount: 3`, `unavailableSectionCount: 0`, window 2026-10-08T04:08:42.929Z →
2026-10-09T04:08:42.929Z, `hint` 777 characters, text 10 288 characters. The `SETUP_CHANGES` truncation is
the call's **own** `limitPerSection` (25 of 450), not the budget — a distinction §2.6 makes explicitly.

This org holds no failing async job and no scheduled job at all, which makes two of the three sections
exercises in the *empty* answer. That is the case ADR-0029 §3 is written about, and the next two sections
are how the run kept those zeros from being indistinguishable from an unread source.

### 2.2 `SETUP_CHANGES`: 25 of 450, row for row

The harness read the same window itself and compared, and the agreement is total: `independentRows: 25`,
`returnedEntries: 25`, `independentTotalCount: 450`, `toolTotalCount: 450`, `vacuous: false`,
`idsNotInTheOrg: []`, `entriesMissingARequiredField: 0`,
`timestampsMatchTheIndependentRead: true`, `timestampsNonIncreasing: true`.

| | |
| --- | --- |
| Newest row, tool and org | `2026-10-09T04:06:19.000+0000` — the same instant on both sides |
| Next row below the cut | `2026-10-09T03:15:55.000+0000`, `cutFallsAtATimestampBoundary: true` — the page boundary is a real timestamp, not a row split by a tie |
| Actor | the org's single administrator account, on every row of the window |
| Actions seen | `deletedApexClass`, `createdApexClass`, `changedQuickActionLayoutCustom`, `SetupEntityAccessAudit_Profile_ApexClass_EnabledCustom`, `SetupEntityAccessAudit_Profile_ApexClass_EnabledStandard` |

**The counts across the three runs are their own cross-check.** The window held **448** rows at 03:45 and
again at 04:06, and **450** at 04:08 — and the +2 is exactly the 04:06 run's fixture-class create and
delete, whose newest row (`04:06:19`) is the newest row of the 04:08 window. The 03:45 run predates the
fixture leg and so moved the count not at all. That is a ledger a fixture suite cannot produce: it says the
section is reading the org's real table, and that the harness's own writes are visible in it.

### 2.3 `ASYNC_FAILURES`: a zero that is evidenced, not assumed

The section returned nothing because the window held nothing — but "nothing matched the window" and "there
is nothing there at all" are different claims, and only one of them is safe to tell an investigator. The
gate establishes which by reading the org's whole **status vocabulary**, window-independent:

```
SELECT Status, COUNT(Id) total FROM AsyncApexJob GROUP BY Status
  → { Completed: 367 }        (the org, at 04:08)
```

`toolObservedStatusCounts: { Completed: 367 }`, `orgStatusVocabulary: ["Completed"]`,
`vocabularyAgrees: true`, `independentEntries: 0`, `independentTotalCount: 0`, `totalFromTheHarnessCount: 0`,
`toolTimestampsAreTheNewestRows: true`, `idsNotInTheOrg: []`. The table has **367 rows in it** — this is not
a source the identity cannot see — and not one of them is `Failed` or `Aborted`, so the zero is the org's
answer rather than the Tool's silence.

The vocabulary is also the reason ADR-0033 §2 makes a *failed* vocabulary read beside zero matches degrade
the section to `UNAVAILABLE`: with the corroboration gone, the zero would be precisely the unfalsifiable
claim this gate exists to prevent. And it is the measured half of §3's `Aborted` bullet: the literal has
never appeared on this org, in the vocabulary or in a row.

### 2.4 `SCHEDULED_JOBS`: the empty table, and a stall rule that is vacuous by construction

`CronTrigger` holds **0** rows on this org, so the section answered `READ` with `totalCount: 0` and one
caveat naming the empty table (`cronTriggerCaveatMentionsTheEmptyTable: true`), and the stall flag had
nothing to assess: `rows: 0`, `flagged: 0`, `reportedSuspectedStallCount: 0`,
`countAgreesWithTheRows: true`, `entryCapApplied: false`, `flaggedRowsArePastTheGrace: true`,
`everyFlagIsHedged: true`, `unrecognizedAssessments: []`, `disagreeingWithThePublishedRule: []`,
`sampleReasons: []` — `vacuous: true`, with the report's own vacuity reason naming the empty table.

**The rule this org could not exercise** (ADR-0033 §1): `SUSPECTED` requires **both** a waiting literal
(`WAITING`, `QUEUED`, `READY`, `BLOCKED`) **and** `now − NextFireTime` past a 30-minute grace; running
states (`ACQUIRED`, `EXECUTING`) and `DELETED` are `NOT_SUSPECTED`; and **everything else —
`INDETERMINATE` is the default**: an unrecognized `State`, a missing or unparseable `NextFireTime`, the
`PAUSED` family. That default is the "宁可标注「疑似」" rule taken to its conclusion: an assessment the Tool
cannot make is reported as blank rather than as health. The rule never compares `TimesTriggered` across
calls and never reads a missing `PreviousFireTime` as evidence, because neither survives a restart or a
retention boundary honestly.

Two things follow, and both are recorded rather than smoothed over: the three assessments are unit-tested
against every shape and **no live positive case exists** (ADR-0033 Consequences, §3 below); and the
`CronTrigger` state vocabulary was never observed live, which is exactly why an unrecognized literal must
degrade to `INDETERMINATE` instead of being guessed at.

### 2.5 The constructed failure: run 04:06 measured the platform, run 04:08 measured the Tool

This is the run's most valuable measurement, and it arrived as a failure. The fixture is one sandbox-only
Apex class (`SfoaP10T5FailingBatch`); the legs are: establish the class, submit it as a batch, poll
`AsyncApexJob` until it settles, ask the Tool for `ASYNC_FAILURES` over a 1-hour window, then delete the
class.

**Run 04:06 — the fixture threw from `execute`, and the platform answered `Completed`:**

| Field | Value |
| --- | --- |
| `jobStatus` | `Completed` |
| `jobNumberOfErrors` | 2 |
| `jobExtendedStatus` | `null` |
| `toolEntryFound` | `false` |
| `toolSectionStatus` / `toolSectionTotalCount` | `READ` / 0 |
| `timelineCarriesIt` | `false` |
| `cleanup.ok` | `true` |

The gate's four problems, verbatim:

```
The constructed job reached `Completed` rather than `Failed`.
The failure section did not carry the constructed job's own row.
The merged timeline did not carry the constructed entry.
The failure section counted the window as empty while it held the constructed row.
```

The Product's behavior is the finding: an exception escaping `Database.Batchable.execute` is caught **inside
the job**, so the job completes and the chunk's failures are counted (`NumberOfErrors = 2`) without an
`ExtendedStatus` first error. A `Failed` job comes from failing in **`start`** — measured on the re-run as
`Status = 'Failed'`, `NumberOfErrors = 1`, and
`ExtendedStatus = "First error: Assertion Failed: SfoaP10T5: this batch exists to fail."`. The fixture now
asserts in `start`, and both the doc comment and ADR-0033 §10 record the measurement so a later reader does
not "simplify" it back to the `execute` form — which would silently convert the gate's most important
assertion into a tautology that always passes.

**Run 04:08 — the same fixture, failing in `start`, observed through the Tool:**

| Field | Value |
| --- | --- |
| `state` / `sandbox` | `CONSTRUCTED` / `true` |
| `submitted` / `compiled` / `pollAttempts` | `true` / `true` / 20 |
| `jobStatus` | `Failed` |
| `jobNumberOfErrors` | 1 |
| `jobExtendedStatus` | `First error: Assertion Failed: SfoaP10T5: this batch exists to fail.` |
| `toolEntryFound` | `true` |
| `toolSectionStatus` / `toolSectionTotalCount` | `READ` / **1** |
| `timelineCarriesIt` | `true` |
| `timelineEntrySummary` | `Failed BatchApex SfoaP10T5FailingBatch, errors=1` |
| `windowAsked` / `sectionsAsked` | 1 / `["ASYNC_FAILURES"]` |
| `problems` | `[]` |

This is the leg that turns §2.3's evidenced zero into a positive measurement: with the fixture inside the
window, the same section that reported 0 of 367 rows now reports exactly the one row that failed, the
timeline carries it, and the caller's narrow window is honoured. The job's org-side `CreatedDate`
(`2026-10-09T04:08:32.000+0000`) also appears in §2.7 as one of the two anchors for the org's clock.

### 2.6 The dual budget, at the widest input the schemas admit

The widest call the schemas permit — `windowHours: 168`, `limitPerSection: 100` — was made, because a
budget that has only ever been measured on a small answer has not been measured:

| | Budget | Widest call | Default call |
| --- | ---: | ---: | ---: |
| Structured content | 262 144 B | **61 533 B** | 17 087 B |
| Text block | 60 000 chars | **34 780 chars** | — |
| Result envelope (reported, not gated) | — | 106 661 B | — |

`truncationObserved: true`, `truncatedSections: ["SETUP_CHANGES"]` with 100 entries kept of **587** — the
call's own `limitPerSection` doing the cutting, which is the ladder's first rung. The gate also refuses a
bare `truncated: true`: every truncated section must be explicable, either by a caveat or by
`totalCount > entries`, so a reader can always tell a short answer from a shortened one.

The budget is a **dual** one (ADR-0033 §5): entries are capped before fields, and the text block drops
detail before it drops the timeline — the timeline is the Tool's reason to exist, so it is the last thing
the budget is allowed to take. §3 records what this run therefore did **not** exercise.

### 2.7 Window honesty, and the org's second clock

`windowHonesty` asserts the declared window spans exactly the requested 24 hours, that the default is 24,
and that **no entry and no timeline line falls outside it** — `outsideWindow: []`. The check is
deliberately one-sided: it catches entries older than `from`, which is the failure a reader would never
notice, and tolerates instants just past `to` because the upper edge is stamped by this server rather than
by the org.

The run also records how far the harness's clock sat from that stamp when it read it: `serverClockSkewMs:
1 316`, which is the call's own round trip rather than a clock disagreement — the server and the harness
share one host here.

**The org is a genuine second clock domain, and that is now a measured fact rather than an assumption.** An
unauthenticated HTTP `Date` read of the instance answered **14.7 s behind the host**
(`salesforce_clock_minus_host_ms = −14 651.5`, rtt 329 ms), and the run's own stamps agree from two
independent directions:

- the constructed job's org-side `CreatedDate` is `04:08:32.000+0000`, while the host-side calls that
  preceded the fixture are stamped `04:08:42.360`–`04:08:45.380` — the submit happened *after* the wide
  call, and the org's stamp still reads ~15 s earlier;
- the 04:06 run's fixture cleanup is the newest `SetupAuditTrail` row of the 04:08 run's window, computed
  two minutes later, at `04:06:19.000+0000`.

This is why the window's edges are documented as two clocks (ADR-0033 §4) and why rows newer than `to` on
the org's clock are **kept** rather than filtered: an investigator reading a merged timeline cares that the
row happened, not that a 15-second disagreement about "now" put it on the far side of a boundary.

### 2.8 The merged timeline

The timeline is the Tool's unique value: the three sections merged into one ordered sequence so an agent can
read "the change immediately above the moment the symptom started".

`independentEntries` and `returnedEntries` agree at **25** (all of them `SETUP_CHANGES`, since the other two
sections hold nothing), `disagreements: []`, and the ordering is
`"reproduced, ties included: the instant, then the contract's section order, then the entry id — the same
comparator the executor sorts with."` Ties are the part that matters: two sources can stamp the same
second, and a comparator that left their relative order to the sort's stability would let the harness and
the Tool disagree on an answer that is "the same" only to a human.

The alignment note's job is to keep the Tool honest about what a timeline **is**: `noteSaysCandidateNotCause:
true` — the entry nearest a symptom is a candidate to investigate, not a cause, and the note says so. That
is the same discipline as §2.4's hedged stall flag, applied to the Tool's headline output.

### 2.9 The subset call

`sectionSelection` asked for two of the three sections and asserts the answer is a **subset**, not a
superset and not a silent full sweep: `requested` = `presentSections` = `["SETUP_CHANGES",
"ASYNC_FAILURES"]`, `readSectionCount: 2`, and `noteMentionsTheSubset: true`. The timeline on that call
carried only `SETUP_CHANGES` lines (`timelineSections: ["SETUP_CHANGES"]`) — because the failure section
held nothing in that window — and the note is what tells the reader the timeline covers a subset of the
sources, which is exactly the sentence that keeps a partial answer from reading like a complete one.

The audit's response summary for that call agrees from the outside — `{isError: false, readSectionCount: 2,
unavailableSectionCount: 0, timelineEntryCount: 25, truncated: true}` — the same 25 entries a caller saw on
a call that had asked for two of the three sources.

## 3. What this run does not prove

- **The `UNAVAILABLE` branch has no live leg.** Every call in all three runs reported
  `unavailableSectionCount: 0`. The degradation contract — a section that cannot be read degrades to
  `UNAVAILABLE` with `totalCount: null` and a named prerequisite, never to a silent zero — is unit- and
  protocol-tested only. Producing a live `UNAVAILABLE` needs an org that refuses one of the three sources
  to this identity, which this one does not.
- **The stall rule has no live positive case.** §2.4: `CronTrigger` is empty, so all three assessments are
  fixture-tested and the live gate is `vacuous`. The flag's live proof is a future org with a populated
  `CronTrigger` — ideally one whose schedule is genuinely late.
- **Neither budget ladder was climbed.** §2.6's widest call came in at 61 533 B of 262 144 and 34 780 of
  60 000. Truncation was observed only at the **entries** rung (`limitPerSection`); the byte ladder's
  field-clip rung and the text block's detail-drop rung were never reached. A window holding entries with
  much longer fields, or far more of them at the 100 cap, is what would exercise them.
- **The `Aborted` literal was never observed.** The org's entire vocabulary is `{Completed: N}` (§2.3), so
  the `Aborted` half of `Status IN ('Failed','Aborted')` is a filter the run never saw match. T5's
  acceptance names only `Failed`.
- **`hint`'s unavailable branch was never rendered live.** The hint leads with the unavailable section when
  one exists (ADR-0033 §8); with no unavailable section, only its other branches were produced. The
  777-character length was identical across all three runs.
- **The retention bound is one measurement.** The `SetupAuditTrail` hint reports the oldest row this org
  still holds (`2026-04-13T01:02:03.000+0000`) because Salesforce exposes no retention policy to SOQL. It
  is a measured bound, not a constant, and it moves as rows age out.
- **One org, one identity, one API version.** Everything here is CHN5S through the fixed DIAGNOSTIC identity
  at v68.0. Production readability for the three objects is a deployment check, not a property established
  here.
- **The Console's enablement was not performed.** §1.3: no `sfoa_tool_control` row exists; nobody enabled
  the Tool in the Console and no live call went through the real gateway without the in-memory grant.

## 4. What the live run found

### 4.1 The platform's batch semantics: `execute` vs `start`

§2.5 is the finding, and it is worth stating as a rule because it is the kind of fact a fixture suite can
never produce: **an exception thrown from `Database.Batchable.execute` does not fail the job.** The job
completes, `NumberOfErrors` counts the failed chunks, and `ExtendedStatus` stays `null`. Only a failure in
`start` produces `Status = 'Failed'` with a first error. Any future test or diagnostic that wants a Failed
`AsyncApexJob` has to fail in `start`; the fixture does, the doc comment says why, and ADR-0033 §10 records
the measurement.

It is also the argument for the gate's shape. The failure section's whole value is telling an investigator
"this job failed"; a run that constructed the wrong kind of failure would have produced a green gate and a
false claim about the Tool. Run 04:06 failed **correctly** — the gate held the platform's own verdict, which
is what a live gate is for.

### 4.2 The window belongs in SOQL, and the probe is what said so

The first implementation filtered by `Status` alone and opened the time window in memory, describing the
failure section's total as what a bounded scan could establish. The probe — the second instrument, run
before the milestone — measured that `AsyncApexJob.CreatedDate` **is** filterable on this org and that the
exact conjunction the Tool wants (`Status IN ('Failed','Aborted') AND CreatedDate >= …`) is accepted, along
with its count. The window moved into the query and the section's `totalCount` became the window's own
count (ADR-0033 §6).

Two general lessons from that: filterability is a per-field **and** per-conjunction fact — two fields each
being filterable does not make their conjunction filterable — which is why the probe sends the conjunction
itself rather than inferring; and the probe steps stay in `probe:p10` so the next deployment re-measures
instead of inheriting this org's answer.

### 4.3 The audit's `requestSummary` is an envelope, and the Tool's scope lives inside it

Verifying §1.2 from the audit alone has one trap worth recording, because it produced a wrong reading
before it was caught. The stored `requestSummary` is **not** the Tool's argument summary: it is an envelope
carrying agent/model context (`turnId`, `agentId`, `modelName`, `auditCapture`, `externalRunId`,
`modelProvider`, `conversationId`) with the Tool's own scope nested under `summary`. A reader who compares
the envelope's keys against the Tool's contracted input keys sees "unexpected keys" and an empty pick — a
false positive. Read at the right depth, every call carries exactly
`{windowHours, sections, sectionCount, limitPerSection}`, which is how §5's table was built. The nesting was
confirmed against an unrelated Tool's row from an earlier milestone (`get_apex_logs`, 2026-09-30), whose
envelope has the same eight keys and whose nested summary is its own
(`{limit, status, userId, timeWindowMinutes}`) — so this is the audit's general shape, not a T5 quirk.

### 4.4 No product defect, and what that says about the gates

Unlike T2–T4, **the live runs found no product defect**: the Tool answered every call with the right rows,
the harness's independent reads agreed row for row, the timeline reproduced exactly, and the one red gate
was the harness's own fixture being wrong about the platform (§4.1). The corrections the T5 period did
force are recorded in the task's 修订注记 — six of them, from the `ExtendedStatus` field name to the stall
rule's conservative ladder — and every one came from the probe or from a shape measurement rather than from
a broken answer.

That is the expected shape for a Tool whose sources are standard-API reads this org has already had probed:
its risk is not "will the query work" but "will an empty or degraded answer lie", which is what §2.3, §2.4
and §3 are about. The debt is concentrated in the branches a healthy org cannot visit.

## 5. Audit verification (P7)

Read with `yarn ai:audit --tool get_platform_diagnostics --since 24h --latest 20` against the same database
the runtime writes to. **Every row is `executionRole = DIAGNOSTIC`, `identitySource =
INTERNAL_SERVICE_HEADER`, `result = PASS` / `outcome = SUCCESS`.**

The eleven calls over the three runs — four per run from 04:06 on, three for the 03:45 run, which predates
the constructed leg:

| Run | Default | Subset | Widest | Constructed |
| --- | --- | --- | --- | --- |
| 03:45 | `7939` @ 03:45:26.697 | `7940` @ 03:45:28.096 | `7941` @ 03:45:28.942 | — |
| 04:06 | `7945` @ 04:06:25.572 | `7946` @ 04:06:27.510 | `7947` @ 04:06:28.429 | `7948` @ 04:06:33.746 |
| 04:08 | `7949` @ 04:08:42.360 | `7950` @ 04:08:44.249 | `7951` @ 04:08:45.380 | `7952` @ 04:08:50.657 |

Each row's `responseSummary` — `{isError, truncated, readSectionCount, timelineEntryCount,
unavailableSectionCount}` — is the caller's-eye view recorded server-side. It is identical across the three
runs, call shape for call shape:

| Call | `readSectionCount` | `timelineEntryCount` | `unavailableSectionCount` | `truncated` |
| --- | ---: | ---: | ---: | --- |
| default | 3 | 25 | 0 | `true` |
| subset | 2 | 25 | 0 | `true` |
| widest | 3 | 100 | 0 | `true` |
| constructed (04:06) | 1 | **0** | 0 | `false` |
| constructed (04:08) | 1 | **1** | 0 | `false` |

The two constructed rows are the FAIL and its fix, visible from the audit alone: the same call shape, one
returning an empty timeline and one carrying the entry, with the Tool `PASS` in both cases — because the
Tool was right both times and the harness's fixture was wrong the first time.

Cross-trace tallies over the archive:

| | |
| --- | --- |
| Salesforce API rows / DML rows | **99** / **0** |
| Purposes | **66 × `PLATFORM_DIAGNOSTICS`**, 22 × `IDENTITY_AUTHENTICATION`, 11 × `IDENTITY_TOKEN_EXCHANGE` |
| Method + category | 66 × `GET` `REST_API`, 22 × `GET` `UNKNOWN`, 11 × `POST` `OAUTH` |
| `objectApiName` | 33 × `AsyncApexJob`, 27 × `SetupAuditTrail`, 6 × `CronTrigger`, 11 × `Organization`, 11 × `ScratchOrgInfo` |
| Statements | `distinctStatements: 45`, `windowedStatementInstances: 40`, `quotedDateTimeLiterals: 0` |
| Credential scan (counts only) | jwt 0, bearer 0, rawTokenField 0, accessTokenField 0, refreshTokenField 0, passwordField 0, clientSecretField 0, privateKey 0 |

- **The purpose split is what makes the Tool's traffic separable from the identity layer's.** The three
  sections are standard-API reads, so `PLATFORM_DIAGNOSTICS` is its own value rather than a reuse of
  `DIAGNOSTIC_TOOLING` (which would name a Tooling call that never happened) or `PERMISSION_EXPLAIN` (which
  would file change-and-failure reads under a permissions heading). ADR-0033 §9, and the reason the tally
  reads as three clean bands — 66 Tool statements, 22 authentication rows and 11 token exchanges, with
  nothing else in it.
- **The two object names beside the whitelist are not the Tool's.**
  `objectNamesOutsideWhitelist = ["ScratchOrgInfo", "Organization"]` — `ScratchOrgInfo` is jsforce's own
  connection warm-up (`SELECT Id FROM ScratchOrgInfo limit 1`, which *fails* on a non-scratch org, and is
  the `firstFailure` below) and `Organization` is the identity layer's namespace probe
  (`Select Namespaceprefix FROM Organization`). Both sit **outside** every Tool-call bracket; §1.2's
  `offWhitelist: []` is the assertion about what the Tool itself sent, taken from inside the brackets.
- **The `PASS` rows and the failed warm-up coexist in one trace.** Inherited from T2–T4 and not a T5
  symptom: `firstFailure` reports `sequence: 3, rank: 1, source: SALESFORCE_API, status: FAILED,
  errorCode: INVALID_TYPE, title: IDENTITY_AUTHENTICATION`, and `auditIntegrityStatus = PARTIAL` on every
  row with `evidenceIntegrity.details = "Evidence is incomplete or degraded; do not infer missing stages."`
  Both reflect evidence this deployment does not capture on these calls, not anything the Tool did.
- **`auditPersistence` closed the loop on the final run**: 4 enqueued, 4 persisted, 0 dropped,
  `queueDepth: 0`, `writerState: STOPPED`, shutdown drained, `forcedConnections: false`.
- **No credential material in any response.** The milestone's own gate scanned all four Tool responses for
  the live client token and access token (`secretsSearched: 2`, `offenders: []`), and the export's own scan
  — the credential-scan row above — is clean across all 99 API rows.

## 6. Open items carried out of T5

- **A live positive case for the stall rule** (§2.4, §3). Needs an org with a populated `CronTrigger` and a
  schedule that is genuinely late; the three assessments are fixture-tested until then.
- **A live leg for `UNAVAILABLE` / `totalCount: null`** (§3). Needs an org or identity that refuses one of
  the three sources — the branch is the heart of ADR-0029 §3 and has only ever been exercised by tests.
- **Both budget ladders, and the field-clip rung in particular** (§2.6, §3). The widest admitted input was
  answered inside both budgets; nothing yet has made the byte or text ladder cut.
- **The `Aborted` literal** (§2.3, §3), and with it the `Failed`-and-`Aborted` conjunction's other half.
- **One sandbox row is not cleanable, and the next run inherits it** (ADR-0033 Consequences). The
  constructed `AsyncApexJob` survives its class for the platform's retention window, so a milestone re-run
  inside that window will find one pre-existing failure row: `emptySourceClarity`'s async leg becomes *not
  measured* (the gate is built to pass in that state rather than to false-fail) and §2.3's evidenced-zero
  reading is the version to compare against. The report and this page state it rather than working around
  it, because the Tool's filter is exactly what makes the row visible.
- **Console enablement is still the missing end-to-end step** (§1.3). No `sfoa_tool_control` row exists for
  this Tool, T3's or T4's; all three milestones grant in memory. Enabling one and calling it through the
  real gateway without the wrapper is the remaining proof.
- **Production readability of the three objects** (§3). `SetupAuditTrail`, `AsyncApexJob` and `CronTrigger`
  are measured readable **for this org and this identity**; a production org answers for itself by running
  the same milestone.
- **The prompt's 改进空间 remains deliberately unexplored** (ADR-0033 Consequences): extra sections
  (`ApexClass`/`ApexTrigger` modification times via Tooling) were not added, because a Tooling source would
  split the Tool across the structurally-enforced API and the whitelist-only one; the timeline is a
  prefix under budget rather than a page; and the Tool is not in the Agent-facing playbook. All three are
  recorded as open decisions, not as unfinished work.

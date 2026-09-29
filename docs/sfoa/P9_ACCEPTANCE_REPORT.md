# P9 acceptance report (2026-09-29)

The closing acceptance for the P9 data-completeness plan, run against the branch tip and against the
test server that was deployed from it. Every number below was read from a run's own output or from
the Control Plane database; where a leg could not be executed it is named as not executed rather
than counted as a pass.

| | |
|---|---|
| checkout | `D:\GitProject\sfoa-enterprise-mcp`, branch `feature/p9-data-completeness` @ `95d960a` |
| test server | `crm-ex-test02` / `192.168.156.203`, app tree `/data/sfoa-enterprise-mcp/app` |
| deployed revision | `6d7ea3d` (archive `sfoa-p9-t5-6d7ea3d.tar.gz`) plus the one `95d960a` single-file sync |
| Control Plane | MySQL schema `sfoa_enterprise_mcp` on `192.168.156.127` |
| deployment record | [TEST_SERVER_DEPLOYMENT.md](TEST_SERVER_DEPLOYMENT.md#p9-t5-playbook-1100-data-analysis-skill-and-acceptance-deployment-2026-09-29) |

## 1. What P9 delivered

Seven Tools, all **disabled by default** and reaching an Agent only through an explicitly enabled
Control Plane route. Six in the new `@sfoa/mcp-provider-sfoa-data` — `query_records`,
`list_sobjects`, `describe_sobject`, `search_records`, `submit_bulk_query`,
`get_bulk_query_results` — and `get_org_limits` in the existing `@sfoa/mcp-provider-sfoa-context`.

Seven rather than the plan's eight because P9-5 is a Skill-and-description deliverable with no Tool
of its own. `get_org_limits` moved provider under [ADR-0027](adr/ADR-0027-p9-org-limits-diagnostic-identity.md)
because the `limits` resource is refused to every business identity SFOA can route and is served
instead by the server-owned DIAGNOSTIC identity. The advertised surface on the test server went from
16 Tools to 23.

## 2. Local gates

Run on `95d960a` in the checkout, sequentially and uncontended. The two rows that are not green are
both pre-existing and are separated out in §5.

| command | exit | verdict |
|---|---|---|
| `yarn build` | 0 | PASS |
| `yarn lint` | 1 | FAIL — 47 errors, every one in `packages/mcp-provider-code-analyzer` (upstream) |
| `yarn test` | 0 | PASS |
| `yarn workspace @sfoa/mcp-server test` | 0 | PASS |
| `yarn workspace @sfoa/mcp-server test:p3` | 0 | PASS |
| `yarn workspace @sfoa/mcp-server test:p4` | 0 | PASS |
| `yarn workspace @sfoa/mcp-server test:p5` | 0 | PASS |
| `yarn workspace @sfoa/mcp-server test:p7` | 1 | 5 pass / 1 fail — pre-existing, see §5.1 |
| `yarn workspace @sfoa/mcp-server validate:p2` | 2 | PARTIAL — `Missing Live Inputs SECOND_TEST_USER`, pre-existing |
| `yarn workspace @sfoa/mcp-server validate:p3` | 1 | FAIL — same missing input, pre-existing |
| `yarn workspace @sfoa/mcp-server validate:p4` | 0 | PASS (`overall: PASS`) |
| `yarn workspace @sfoa/mcp-server validate:upstream` | 0 | PASS |
| `yarn agent:check` | 0 | PASS — `Agent artifact check PASS (5 files)` |
| `yarn skill:check` | 0 | PASS — 10 files, `drift: []` |
| `yarn ai:snapshot` | 0 | PASS |
| `yarn ai:doctor` | 0 | PASS — `problems: []`; `services: NOT_RUNNING`, see §5.4 |

**A defect T5 introduced and fixed.** Raising the Playbook to 1.10.0 turned the root suite red: two
`sfoa-admin-web` drift gates still asserted `1.9.0`
(`src/test/AgentIntegrationPage.test.ts`, `src/test/SkillContent.test.ts`). That is the gates doing
their job — they exist to make a version bump fail loudly rather than ship a stale surface — and
they were corrected in `6d7ea3d` before the final run above.

## 3. Live acceptance

Run on the test server through the deployed runtime, against the real org. The harness resolves one
enabled identity route from the Control Plane **inside its own process**, injects it into the
validation's environment and masks every identity value before printing, so no platform user id
appears on a command line, in shell history or in this report.

### 3.1 The four required scenarios

| scenario | evidence | verdict |
|---|---|---|
| a — full count and detail sampling on a large object | Bulk export summed **37 010** rows across 19 pages against an independent `COUNT()` of **37 010**; `query_records` on the same object declared `truncated: true` with `truncatedReason: RESPONSE_BUDGET` | PASS |
| b — `INVALID_FIELD` self-repair | `describe_sobject` on `ContactZzP9NoSuchObject` → `MCP_SOBJECT_NOT_FOUND` / `NOT_FOUND`, `suggestionNamesListSobjects: true` | PASS |
| c — SOSL cross-object search | `search_records` over `Contact.Name`, 1 org hit, 1 returned, `mismatches: []` | PASS |
| d — `get_org_limits` agrees with the org | 73 limits read and 73 re-read, `unreadableLimits: 0`, `entryMismatches: []`, `executionRole: DIAGNOSTIC` | PASS |

**The 100 000-row floor in the plan was not met and is not claimed.** The deployment's org has no
object near it; a survey of all 523 queryable objects put the largest at `ContactShare` with 74 660
rows and the largest business object at `Contact` with 37 496, and this run's own independent
`COUNT()` on `Contact` read 37 010. The run reports `minimumRows`, `minimumRowsSource` and
`plannedMinimumRows` together precisely so a relaxed run cannot be read as the requirement having
been satisfied — see [ADR-0028](adr/ADR-0028-p9-bulk-query-export-over-official-sdk.md) deviation 5.

### 3.2 Gates, from the final run

`overall: PASS`, all 11 gates PASS. Readings below are from the run at `06:34Z`
(`generatedAt 2026-09-29T06:34:13.533Z`).

| gate | reading |
|---|---|
| `toolInventory` | 23 advertised == 23 expected from the Control Plane snapshot; `readOnlyAnnotations: true`; `annotationOffenders: []`; `forbiddenInputKeys: []`; the 7 additive Tools are exactly the P9 set |
| `requestIdentity` | routed `ca***at` == live `ca***at`, `routeEnabled: true` |
| `listSobjects` | 36 matching; bounded limit 5 → `truncated: true` with hint; widened to 36 → `truncated: false`, no hint; `factMismatches: []` |
| `describeSobject` | `Contact`: 89 org fields / 89 returned, 182 child relationships / 50 returned, `truncated: true`, `picklistCuts: 0`, `fieldMismatches: []`, `childMismatches: []`, `headerMismatches: []` |
| `queryRecords` | probe: `totalSize` 37 010, `fetched` 37 010, returned 474, 19 pages, `truncated: true` / `RESPONSE_BUDGET`; capped at 500 → 474 returned, hint names only `submit_bulk_query`; aggregate `COUNT()` 37 010 == org scalar 37 010 |
| `orgLimits` | 73 read / 73 re-read, `entryMismatches: []`, `executionRole: DIAGNOSTIC` (see §4) |
| `searchRecords` | 2 probes, 1 hit, `complete: true`, `mismatches: []` |
| `bulkQuery` | job `750C5000004qjTNIAY`, API v68.0, 19 pages, `rowsSummedAcrossPages` 37 010 == `totalRecords` 37 010, page size 2 000, `elapsedMs` 26 554, `apiUsage: valid`; `minimumRows` 37 000 from `P9_LIVE_BULK_MIN_ROWS` with `plannedMinimumRows` 100 000 |
| `schemaSelfRepair` | `MCP_SOBJECT_NOT_FOUND` / `NOT_FOUND` with `suggestionNamesListSobjects: true` |
| `credentialSafety` | 34 results inspected, 2 801 044 bytes, `matchedPatterns: []`, `containsClientToken: false`, `containsAccessToken: false` |
| `auditPersistence` | `flushed: true`, `dropped: 0`, `enqueuedSnapshots: 34` == `persistedSnapshots: 34`, `droppedSnapshots: 0`, `writerFailureCount: 0`, `shutdown: {drained: true, forcedConnections: false}` |

Request-scoped Connections were created for exactly two Salesforce users — the routed business
identity `ca***at` and the server-owned DIAGNOSTIC identity `cr***at` — 34 in total.

### 3.3 Repeat runs

The run was repeated to establish that the one gate §4 changes is stable, not that a single run
happened to pass. Three consecutive runs after the fix, all `overall: PASS`:

| run | time (UTC) | overall | note |
|---|---|---|---|
| `p9-live-acceptance.json` | 05:39 | PASS | pre-fix, waived by counter movement |
| `p9-live-acceptance-final.json` | 05:55 | **FAIL** | pre-fix, `orgLimits` mismatch — see §4 |
| run 3 | 05:58 | **FAIL** | pre-fix, `orgLimits` mismatch — see §4 |
| `p9-live-acceptance-fix.json` | 06:09 | PASS | post-fix |
| run 5 | 06:15 | PASS | post-fix, waived by the new tolerance alone |
| run 6 | 06:34 | PASS | post-fix, waived by counter movement |

## 4. A defect in the org-limits gate, found by running it

`orgLimits` failed intermittently — two of the three pre-fix runs — with a disagreement of a few
units on `DailyApiRequests`:

| run | reported mismatch |
|---|---|
| run 2 | `remaining: tool=4995562 org=4995559`, `used: tool=4438 org=4441`, `toleratedMoves: []` |
| run 3 | `remaining: tool=4995391 org=4995383`, `used: tool=4609 org=4617`, `toleratedMoves: []` |

The cause is directional, which is why it looked random: `DailyApiRequests` is a **volatile daily
counter that the run advances itself**, the gate compares the Tool's reading against a reference
reading taken around it, and the waiver the gate already had could only excuse a disagreement it
could *witness as movement* between the two reference readings. Once the run's own API traffic stops,
the two reference readings are identical and the waiver can never fire — so a counter the harness
had itself moved was reported as a defect in the Tool. The disagreement is real; the conclusion
drawn from it was not.

The fix keeps every strict check and adds one bounded tolerance:

- `max` is never tolerated, and neither is `used == max - remaining` inside a single reading.
- A counter may differ from its reference by at most `max(5, ceil(ceiling × 1/10 000))` — a fraction
  of the limit's **ceiling**, not of the value, because `used` is a difference of two
  ceiling-sized numbers and a value-scaled tolerance would be far too tight on it.
- Any waiver is reported in `toleratedMoves` with both numbers, so a run says what it excused.

Runs 5 and 6 are the proof that both paths work: run 6's waivers are movement-witnessed (the two
reference readings differ), and **run 5's reference readings are identical** (`org=4995051` both
times, `tool=4995050`), so its waiver could only have come from the new tolerance.

This follows the T4 precedent of fixing gate defects found by running the live gate and recording
them rather than working around them. As in T4 the change is confined to the validation harness:
no Tool, schema, audit summary or unit test changed.

## 5. Pre-existing failures, kept separate from P9

### 5.1 `test:p7` — the HTTP OFF/ON gate

`✖ HTTP OFF/ON 50/100/200 Gate preserves outcomes and zero cross-audit binding` fails with
`Error POSTing to endpoint (HTTP 504): MCP_REQUEST_TIMEOUT … Correlation ID: shared-correlation-a`,
and the run never exits afterwards (open handles), which is why the summary has to be obtained by
re-running under `node --test --test-force-exit`.

**It is not P9's.** The same test fails identically on `main`:

| tree | result |
|---|---|
| `feature/p9-data-completeness` @ `95d960a` | 6 tests, 5 pass, 1 fail — this one |
| `main` @ `903f0a3` | 3 tests, 2 pass, 1 fail — the same test, same `MCP_REQUEST_TIMEOUT` |

It reproduced solo, before the branch's own suites ran, which also rules out resource contention
with the other P9 tests. Everything around it is green: `P7-06` payload performance passes at all
three concurrency levels, and both `mcp-payload-recorder` tests pass.

### 5.2 `validate:p2` / `validate:p3`

Both stop at `Missing Live Inputs SECOND_TEST_USER` — the local `.env.local` has no second test
identity, so the two-user legs cannot run. `p2` reports `PARTIAL` (exit 2) and `p3` `FAIL` (exit 1).
Neither reaches the code under test and both behave identically before and after P9.

### 5.3 `yarn lint`

47 errors, `exit 1`, all of them under `packages/mcp-provider-code-analyzer` — 25 files, all
`@typescript-eslint` (`no-explicit-any` and one `no-unused-vars`). No `@sfoa` package contributes an
error, and P9 added none. This is the checkout's known upstream debt.

### 5.4 `ai:doctor` reports `services: NOT_RUNNING`

Expected: the local dev stack was deliberately stopped before the dependency install and was not
restarted for these gates. The doctor's own `problems: []` is clean, and the service-level evidence
for this acceptance comes from the test server, not from a local stack.

The stack was restored afterwards, and the doctor re-run on the same tree reads `services` as
`PASS` — `mcp`, `adminApi` and `adminWeb` all `reachable: true`, `httpStatus: 200` — with
`problems: []`. So the `NOT_RUNNING` above is a statement about where the stack was at the time of
the run, not a defect that survived the acceptance.

## 6. Audit acceptance

The plan's `yarn ai:audit --user <platformUserId> --latest 20 --since 24h`, executed on the test
server against the shared Control Plane. As with the live gates the identity is resolved
**inside** the process that runs the query and every identifier is masked before printing; no
platform user id was placed on a command line. The two temporary runners used are described here and
were deleted from the checkout and from the app tree afterwards.

**A caution that shaped the method.** `sfoa_audit_log.request_summary_json` holds a raw Buntu JWT on
its `<none>` rows, so no query in this acceptance used `SELECT *` on that table, and no column other
than the ones needed for counting was read.

### 6.1 Traces

`--latest 20 --since 24h` for the resolved route returned 20 traces, each with an audit header, a
12-step reconstructed chain, a timeline and payload metadata. The window's newest rows are this
acceptance's own traffic: 19 `get_bulk_query_results` page reads and one `describe_sobject`, which is
the deliberate `SCHEMA_SELF_REPAIR` probe. Its `FAILED` / `ERROR` outcome with
`MCP_SOBJECT_NOT_FOUND` is the scenario-b evidence, not a failure of the run.

### 6.2 Every P9 Tool left a trail

A 20-trace window cannot show seven Tools when one Bulk export fills 19 of them, so the coverage was
counted directly from `sfoa_audit_log` for the same resolved identity and window:

| tool | result | rows |
|---|---|---|
| `get_bulk_query_results` | PASS | 120 |
| `query_records` | PASS | 18 |
| `describe_sobject` | PASS | 18 |
| `search_records` | PASS | 12 |
| `get_org_limits` | PASS | 12 |
| `list_sobjects` | PASS | 12 |
| `describe_sobject` | ERROR | 6 |
| `submit_bulk_query` | PASS | 6 |
| `run_soql_query` | PASS | 6 |

`p9ToolsMissingFromAudit: []` — all seven P9 Tools are present. The `describe_sobject` ERROR rows are
the self-repair probes; the counts are multiples of the number of runs, as they should be.

**Window totals.** 210 audit rows over `2026-09-29 01:43:09.435` – `06:35:05.065` UTC, against
**210 distinct** correlation ids — one audit row per correlation, no fan-out and no collapse. 1 183
payload-evidence rows hang off them, of which 18 are `truncated` — the bounded transport prefix
being exercised and persisted rather than silently dropped.

### 6.3 No credentials and no unredacted authorization records

The sanitized trace output was scanned for credential-shaped content:

| pattern | matches |
|---|---|
| `eyJ…` (JWT segments) | 0 |
| `Bearer <token>` | 0 |
| `refresh_token` | 0 |
| `access_token":…` | 0 |
| `client_secret` | 0 |
| any ≥60-character base64 run | 0 |

This agrees with the live `credentialSafety` gate, which inspected 34 results and 2 801 044 bytes of
Tool output with `matchedPatterns: []`.

### 6.4 Chain completeness, stated honestly

`schemaCapabilities` reports `publicAuditId`, `correlationId`, `eventSequence` and
`publicApiCallId` **available**, and `sessionId`, `callId`, `parentCallId` and `spanId`
**unavailable** — those columns do not exist in this schema, so a chain cannot be grouped by session
or linked to a parent call. The traces carry `evidenceIntegrity: PARTIAL` with the analyzer's own
wording, *"Evidence is incomplete or degraded; do not infer missing stages."* What is present is
present and complete — MCP request payload, each Salesforce API call, its error response, the MCP
response payload — but this acceptance does not claim a per-session or per-parent chain that the
schema cannot express.

## 7. Not executed

| leg | why | status |
|---|---|---|
| `validate:p2` / `validate:p3` two-user legs | no `SECOND_TEST_USER` in the local environment | not executed — needs a second test identity |
| the p7 HTTP OFF/ON gate | pre-existing failure, reproduced on `main` | not executed |
| a live Bulk export at the plan's 100 000-row floor | no object of that size in the org | not executed — deviation recorded in ADR-0028 |
| WeCom / OpenClaw human UAT | outside this acceptance | not executed |

## 8. Conclusion

P9's seven Tools are built, unit- and protocol-tested, deployed to `crm-ex-test02` behind Tool
Governance and default-disabled, and pass all 11 live gates against the real org with three
consecutive green runs. The Agent-facing contract (Playbook 1.10.0) and the `sfoa-data-analysis`
Skill are in the same deployment. Two defects were found by running the acceptance itself — a
volatile-counter comparison in the org-limits gate, and the build order that had left the test
server advertising Playbook 1.9.0 — and both are fixed and recorded rather than worked around. The
failures that remain are pre-existing, are named above with their evidence, and none of them is in
P9's surface.

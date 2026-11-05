# Local branch database and Admin Playbook distribution repair (2026-11-05)

- Diagnose the missing local 017 migration together with a foreign-branch 016 ledger; preserve the original database and use an explicitly selected isolated development database with verified configuration copies.
- Correct stale Admin distribution tests and document that Playbook upgrades require rebuilding the browser bundle independently of MCP and OpenClaw Skills. Retain the observed 203 web 1.12.0 omission and the separate 1.13.2 server/Skill evidence.
- Verification, deployment and rollback: [repair record](docs/sfoa/STARTUP_AND_PLAYBOOK_REPAIR_20261105.md). No Salesforce mutation, runtime permission or migration-guard relaxation.

# Agent materials, continuity and attachment outcomes (2026-11-04)

- Host task materials retain actual source/reading/original coverage across turns with requester/session isolation; Office basic reading stays in a thin host adapter.
- Playbook 1.13.0 and canonical Skills map relevant optional facts, separate planned/applied events, narrow duplicate checks to business identity and event meaning, preserve international numbers, and offer original archiving once without blocking record saves.
- Optional CREATE value assessment defaults off, reuses current facts without additional Salesforce requests, and preserves null/false/zero/absence and managed-policy provenance. It is not a DML gate.
- Attachment attempt states and migration 017 protect concurrent dispatch, distinguish recoverable explicit rejection from UNKNOWN, preserve individual outcomes on timeout, and clean retained bytes without erasing unknown outcomes.
- Existing query, direct/singular/batch/compound DML, attachment, diagnostic, identity, governance and managed-field capabilities remain. Actual validation/deployment status is tracked in [the delivery record](docs/sfoa/AGENT_MATERIAL_WORKFLOWS_DELIVERY.md); no production acceptance is implied.

# Business-task autonomy, material quality, related fields and business diagnosis (2026-10-26)

- Canonical Skills and Playbook 1.12.0 authorize task-relevant faithful synthesis and related completion in actual CREATE/UPDATE drafts. Minimal Patch means actual task changes; explicit narrow scope, strict managed fields, Salesforce authority and UNKNOWN/partial-success contracts remain.
- Configured applicable CREATE Owner fallback no longer requires a ritual question; multiple Record Types may be resolved from task/context/default before loading type-specific fields.
- UI API/Describe field help and constraints reach both text and structured outputs, including Dynamic Forms. Existing action context can continue truncated Picklist candidates without a new geography service. Field-access text prefers real labels and retains raw evidence.
- Diagnostic guidance defaults to business language, reuses logs/time and composes authorized evidence. A successful comparison order does not clear all current master-data issues or prove transaction-condition differences are the cause.
- Full Playbook reaches text-only clients; standard JSON mirrors avoid duplication in the source-traced native OpenClaw MCP projector. Attachment staging explicitly does not prove parsing/transcription.
- Recover client-truncated action context with optional task field projection; retain required/conditional fields and controllers. Refresh the final JSON mirror after Host enrichment so native OpenClaw does not duplicate stale Provider text.
- Add 18 synthetic payload/diagnosis cases, loopback mock DML and actual provider-input metadata observation. Test-server deployment, native same-model evaluation and trusted WeCom read-only acceptance are recorded separately from live write/media acceptance. See [delivery report](docs/sfoa/OPENCLAW_BUSINESS_AUTONOMY_DELIVERY.md).

# The Console gets a second account that cannot see everything — modules, a default-deny endpoint table, and an actor on the audit trail (2026-10-15)

- **`SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON` registers restricted Console accounts in the same config
  file as the Admin.** Each entry is exactly `{"username","password","modules"}`, `modules` is
  mandatory, and the plaintext-password convention is unchanged from `SFOA_ADMIN_PASSWORD`. No
  user-management module, no user table, no role hierarchy: the file is the authority, and a change
  needs an Admin API restart exactly like the Admin credentials it sits beside.
- **A Console module is an explicit path set, not a rank.** Nine ids in navigation order
  (`dashboard`, `identity-routes`, `tool-governance`, `dml-policies`, `diagnostic`, `ui-context`,
  `audit`, `system`, `agent-integration`) map to `(method, path pattern)` entries over the existing
  `/admin/api` surface. An endpoint matching no module is denied, whole segments only — `/audits/1/trace`
  is not reachable through an `/audits` grant — and the method participates, so a read grant never
  implies the write on the same path. Five read-only cross-module closures (the identity-route Drawer's
  `GET /system/settings`, the connector JSON's `GET /system/status`, `GET /tools` and the DML-policy
  list) are enumerated in one table and asserted by a test that fails if any other module reaches
  outside itself.
- **The bootstrap Admin is not a tier above the others — it is the one account the gate does not
  apply to.** `fullAccess: true` short-circuits authorization so the historical 404 (unknown path) and
  405 (wrong method) survive instead of collapsing into a denial that would misreport what it was.
  Restricted accounts get a blanket default-deny: 403 `MCP_ADMIN_FORBIDDEN`, written to stderr with
  the module and path and deliberately **not** persisted — a refused request is not an Admin action.
- **The Console derives its whole shape from `GET /admin/api/auth/me`.** `AdminSessionDto.modules` is
  required, the shell filters its navigation by it, `/` and the post-login redirect land on the first
  **held** module in navigation order rather than on a hard-coded `/dashboard`, and a pathless
  `ModuleGuard` route renders 403 in place of an unheld module — the page never mounts, so it never
  asks the API for its data. `AuthService.parse` rejects a session whose username is no longer
  configured, so deleting an account ends its live session on the next request rather than at cookie
  expiry.
- **Login limiting became per-account, because per-IP never was.** Behind nginx every browser
  collapses to `127.0.0.1`, which made the old bucket a global lockout; account buckets are now keyed
  by lowercased username and cleared on success, with a deliberately loose source backstop
  (`LOGIN_SOURCE_BACKSTOP_FACTOR = 20`) that is consumed before the body is read and never cleared.
- **The audit trail gained attribution, not volume.** Migration 015 adds `idx_sfoa_audit_actor`
  (`actor_admin, occurred_at DESC`) and 调用审计 exposes an `actorAdmin` filter on the existing search
  endpoint. Only `channel = 'ADMIN'` rows carry an actor, so the filter pairs with 审计类型 = 管理操作.
- **The change stops at the console.** No MCP Tool, Tool schema, provider, request lifecycle,
  governance snapshot, audit writer or Salesforce path is touched; the MCP endpoint's own
  authentication and authorization are unchanged and agents using the tools see no difference.
  Evidence: `packages/sfoa-admin-api` 43/43, new `module-paths`/`config`/`auth`/gate tests, new
  `ConsoleModules`/`ModuleAccess` Console tests, a `P5_ADMIN_SCOPED_ACCOUNT_REAL_HTTP=PASS` leg in the
  full-stack harness and a dual-account browser test in `admin-fullstack.spec.ts`. See
  [`ADR-0034`](docs/sfoa/adr/ADR-0034-scoped-console-accounts.md).

# SFoA production activation closed out — WeCom live, diagnostic Tools fired for real, and a DML gate taken down by a console click (2026-10-09)

- **The production WeCom channel is live.** The robot's `botId`/`secret` were patched into the two
  600-mode files in place (credential piped over an `ssh 'cat >'` stdin, `umask 077` temp file deleted
  immediately, `*.bak-pre-wecom-*` backups kept), `pendingOperatorCredentials` removed, gateway
  restarted. The log shows `WebSocket 已连接 → 认证成功 → 已认证` against
  `wss://openws.work.weixin.qq.com` with a 30-second heartbeat; `wecom-openclaw-plugin` flipped to
  enabled and the `wecom-send-*` Skills turned ready. Guide finding: `channels.wecom.*` is a
  **hot-reload prefix** — the gateway judged the change reloadable without a restart, which was still
  taken for a clean state — and
  `state/wecom-cli` initializes lazily (absent at activation time is not an anomaly).
- **The P10 §7 production self-verification leg is now fact.** On mysql mode the diagnostic identity
  lives in the database, not in `SFOA_DIAGNOSTIC_USERNAME` (that key is `env`-mode only,
  `config.ts:332`) — production's `diagnostic` config (id 1, `crm_admin2@runner-corp.com.cn`) was
  already enabled and `PASS`. An ordinary `USER_BOUND` caller then ran five read-only diagnostic Tools
  on the production gateway: `get_org_limits` (72 limits, 0 unreadable), `get_platform_diagnostics`
  (3/3 sections), `explain_field_access`, `list_metadata_components` (1,437 ApexClasses),
  `get_apex_logs` (the read executed; the window held zero rows) — every one PASS with
  `executionRole=DIAGNOSTIC` and its own audit row. `set_trace_flag` stays uncalled on production per
  ADR-0029, and `A-1` cross-user `ApexLog` visibility still stands as an enablement check — an empty
  window is not an ownership finding.
- **One console click bricked the whole MCP endpoint, and the trail found it.** Between the
  deployment's passing verification and the diagnostic run, **every** authenticated MCP POST returned
  500 `MCP_DML_CONFIGURATION_INVALID`. nginx's access log, an `ADMIN_ACTION` audit sweep and
  `rowVersion` arithmetic place the cause: a console administrator (172.70.1.156, the console's DML
  page) disabled production's only DML policy row at 17:42 CST. The DML governance whitelist is
  rebuilt from the database on every request and fails the endpoint closed when an enabled DML Tool
  has no matching operation — one unchecked 启用 box took reads and writes down together, and the
  console wrote that state without a warning. Restored the same evening (`enabled:true`, rowVersion
  4→5, audited, everything re-verified green). Recorded as pitfall #17, with the governance-correct
  alternative: to forbid production writes, disable `create_record`/`update_record` in Tool
  governance — not all DML rows.
- **Also observed and recorded:** identity routes needed no switch-on (18/18 enabled, 0 disabled, all
  credentials ACTIVE); the same source IP probed the gateway's :18789 three times without a token and
  was refused each time (`unauthorized conn`). Still owed: human UAT (WeCom message → reply → SFOA
  Tool → audit row, plus one attachment message).

# SFoA production deployment — P10 on `crm-mcp-prod`, 29 Tools live, and a byte-aligned OpenClaw (2026-10-09)

- **The production server jumped 123 commits to `main` @ `1dca49a`.** P8-07 → Skill-02C → P9 → P10
  with Agent Playbook **1.11.0**; migration `014_skill02c_attachment_upload.sql` (purely additive)
  applied **before** the restarts — both services assert a fully migrated ledger at startup, so
  migrations-before-restart is a hard rule. Eleven packages rebuilt in dependency order (the new
  `mcp-provider-sfoa-data` added to the documented order in
  [`PROD_SERVER_DEPLOYMENT.md`](docs/sfoa/PROD_SERVER_DEPLOYMENT.md) §6), admin-web built last so it
  inlines 1.11.0, then `chown` + `restorecon` — the exact step whose skip caused the 2026-09-09
  test-server 500.
- **The Tool face is 29/29, enabled through the Control Plane** (eighteen new rows + two flips via
  `PUT /admin/api/tools/<name>`, the same Admin API the console calls), matching `crm-ex-test02`
  exactly. Turning on `upload_files_to_record` surfaced the attachment governance gate the hard way —
  with no DML row carrying `attachmentEnabled=true`, **every** MCP POST fails closed
  (`MCP_ATTACHMENT_CONFIGURATION_INVALID`), a production outage until `Lead` was set
  `attachmentEnabled=true` through `PUT /admin/api/dml-policies/1`. The gate is now pitfall #16 and the
  six `MCP_ATTACHMENT_*` keys it needs are backfilled into `.env.example`.
- **Verified as an ordinary caller, not from inside the harness.** A Control-Plane-issued `USER_BOUND`
  credential (never printed) saw 29 Tools advertised and executed `list_sobjects` against the real org,
  leaving its own `MCP_TOOL_CALL`/`PASS`/`SUCCESS`/`USER_BOUND_TOKEN` audit row; `/admin/api/ready` UP
  on 8.0.39, console served, `GET /mcp` → 405 as the healthy GET signature.
- **OpenClaw arrived on production as the test server's byte-aligned twin**: 2026.9.5 (`ec9c1a1`) on
  pinned Node v24.19.0, identical systemd unit + sandbox drop-ins, the same SELinux `bin_t` rules (no
  AVCs) and 18789/tcp open on the LAN; adapter + patched WeCom/parallel plugin trees copied
  byte-for-byte; four business Skills identical, with the `sfoa` connector freshly exported at 1.11.0
  (the test server's 1.10.0 copy is a deliberate difference). A masked diff shows 198 config keys with
  exactly **8 intended differences**; the WeCom channel sits at `enabled:false` +
  `pendingOperatorCredentials:true` until the production robot's `botId`/`secret` land, and its
  credential path already probes clean (`MCP_PLATFORM_USER_REQUIRED` after client auth; a forged token
  gets `MCP_BUNTU_TOKEN_INVALID`). The model path answers HTTP 200 from production via the
  provider-block key — `credentials.json.modelApiKey` is stale on **both** servers and must not be
  trusted for rotation decisions. Still owed: the bot credentials, `SFOA_DIAGNOSTIC_USERNAME`, and
  human UAT.

# SFoA P10 activation incident — the console 500 from a skipped `restorecon`, fixed and recorded (2026-10-09)

- **The symptom pointed at the wrong layer.** After the activation rebuilt the admin-web bundle, nginx
  answered **500 on every path** (`/`, SPA deep links, assets, even `:9000/health`); the error log reads
  `stat() ".../dist/index.html" failed (13: Permission denied)` plus
  `rewrite or internal redirection cycle`, which looks like a server fault. The cause was the one step
  this repository's deployment guide makes standing for every admin-web rebuild —
  [`TEST_SERVER_DEPLOYMENT.md`](docs/sfoa/TEST_SERVER_DEPLOYMENT.md) §9.1 `restorecon`. The new files
  kept `default_t` labels (and a nonexistent Windows-mapped owner, `1651478:1049089`), Enforcing
  SELinux denied nginx the `stat()`, and the SPA fallback amplified the denial into the 500.
- **Fixed, verified, and recorded rather than smoothed over.** `chown -R root:root` + `restorecon -R`
  restored `httpd_sys_content_t` with the content untouched (`index.html` sha256 `0480fa94…` unchanged);
  `/`, `/agent-integration` and an asset answer 200 through `:9000` with the public Host and again from
  `http://crmmcptest.runner-corp.com.cn:9000`. The incident is recorded in the P10 report §9, and the
  deployment guide now carries the 500 signature beside the original 403 one — the "every rebuild" rule
  was skipped, not missing.

# SFoA P10 post-acceptance activation — the six Tools enabled on `crm-ex-test02`, the Skill published to OpenClaw, and the ordinary-caller leg §7 owed (2026-10-09)

- **The deployment runs the accepted tree.** The app tree on `crm-ex-test02` is byte-identical to
  `df6a889`, both services were restarted onto it (graceful drain; `:8080/health` and
  `:8081/admin/api/health` UP), and the admin-web bundle was rebuilt from the same commit and deployed
  over the 2026-09-29 build, so the console UI now serves the P10 build (previous bundle kept in
  `backup/`).
- **`sfoa-org-diagnostics` is published to the test server's OpenClaw** (2026.9.5). `runtime-sync`
  copied the Skill into `/data/openclaw/workspace/skills/` (`SKILL.md` sha256 `3dec5151…`, the
  repository's own bytes), one validated `openclaw config patch` added it to **both** allowlists
  (`skills.entries` and `agents.entries.main.skills`) and reported the change applies **without a
  gateway restart**, `runtime-check` reports `drift: []` for all four business Skills, and
  `openclaw skills check --agent main` lists it among the seven Skills ready and visible to the model.
- **All six Tools are enabled through the Control Plane.** The dry read first reproduced the report's
  claim exactly — no `sfoa_tool_control` row for any of the six — and each was then enabled through the
  Admin API the console itself calls (`PUT /admin/api/tools/<toolName>`), returning `enabled: true` with
  `rowVersion: "1"` and an `UPDATE_TOOL_CONTROL` admin-audit row. The enablement is global and read
  **per request**, so no restart was involved.
- **The ordinary-caller leg §7 owed is executed, against the deployed gateway.** One MCP session as the
  `USER_BOUND` credential of an existing enabled identity route (token and platform id never printed):
  `tools/list` advertised **29 Tools with all six P10 Tools present**; disabling `get_debug_log_body`
  through the Control Plane removed it from the **next** `tools/list` with no restart and re-enabling
  restored it, which is the proof that the Control Plane is the only grant source; `get_platform_diagnostics {}`
  returned `isError: false`, `success: true`, `executionRole: DIAGNOSTIC`, 3 sections read, 0
  unavailable; and the call's own audit row landed (`MCP_TOOL_CALL`, `PASS`/`SUCCESS`,
  `identitySource: USER_BOUND_TOKEN`).
- **`truncated: true` appeared for the first time and was read to its cause rather than reported as the
  budget ladder.** The probe shows the caller's own default cap, not a budget cut: 25 entries of a
  `totalCount: 659` window, an answer of **17 112 of 262 144 bytes** and **2 235 of 60 000 characters**,
  and no budget caveat on any section. §7's budget-ladder item therefore stays unexecuted. Recorded with
  it: the top-level hint names the response budget for either cause, so the per-section caveats are the
  discriminator. Report §9 carries the activation; §7 and §8 are left as history.

# SFoA P10 Diagnostic Depth — T6 the diagnostics Skill, Playbook 1.11.0, and an acceptance run that measured the platform (2026-10-09)

- Deliver **GAP-M6**: `sfoa-org-diagnostics`, the methodology the six P10 Tools exist to serve. Five
  symptom classes (data / permission / configuration / code / platform), **one deterministic evidence
  path per class**, and the duties that make a diagnosis checkable: cite the component `fullName`, the
  log line, the audit timestamp or the authorization chain — a conclusion without one is not a
  conclusion; ask *when it started* and align that instant against `get_platform_diagnostics` as the
  **first** move rather than the last; treat `INDETERMINATE`, `unavailable` and `totalCount: null` as
  what they say and never as health or zero. Six references beside `SKILL.md`, synced to `skills/`,
  `.agents/`, `.claude/` and `.codebuddy/`.
- Publish **Playbook 1.11.0** with the DIAGNOSTICS section and the six P10 Tools registered as
  recognition without enablement. `agent:sync` regenerated all five artifacts — `docs/agent/DIFY_AGENT_INSTRUCTION.md`
  now carries 1.11.0 — and `agent:check` passes.
- **The phase gate failed before it passed, and the failure was the harness's.** The first `validate:p10`
  run (`05:54:06Z`) came back `overall: FAIL`: T2's `listLeg`, `bodyLeg`, `hintChain`, `statusContrast`
  and `closedLoop` all failed, and `get_debug_log_body` was the one Tool missing from `auditCoverage`.
  Read at face value it said the listing Tool had refuted a claim about the org. A throwaway script
  reading the same `ApexLog` table through the same diagnostic route said otherwise: the flag was
  created at `05:54:19`, the two executions a second later had left **no rows at all** — not late,
  never — while an execution 86 s later under the same flag *was* captured, and the standalone T2
  re-run extended that same flag and passed end-to-end.
- **A fresh `TraceFlag` does not capture immediately, and the milestone was reproducing inside that
  window.** The delay is real, invisible to the Tool, the Schema and SOQL, and no longer a poll at the
  listing end can recover a log the platform never wrote. The fix is in the harness and nowhere else
  (`ecb992a`): a `traceActivation` leg runs a throwaway `System.debug` block, waits for its row to
  appear in `get_apex_logs`' own listing (≤2 rounds, ≤18 polls each, 5 s apart — a round re-runs the
  probe rather than waiting longer, because a warm-up that itself ran too early can never appear), and
  re-takes the listing so the warm-up's rows fall on the *before* side of the measurement. The Tool
  contract is untouched by design: a caller taking seconds to minutes between "open the trace" and "do
  it again" never meets the window.
- **"Never captured" is `NOT TESTED`, with the measurement in the reason.** No Tool was asked anything
  when the platform wrote no log, so nothing was refuted — the gate reports `rounds`, `pollAttempts`,
  `waitedMs` and `activation: NEVER_CAPTURED` and the downstream legs degrade instead of cascading
  `FAIL`s that would blame `get_apex_logs`. The same edit closed a latent false `FAIL` on a production
  org, where the read-only path previously ran the body and status legs against an empty candidate set
  after the write leg had been correctly declined. Four unit tests cover captured / never-captured /
  refused.
- **The operational half went into the Skill, because the same trap is waiting for an agent.** Hard
  Rule 6 now says a fresh trace does not capture immediately, and `trace-and-reproduction.md` gained
  §2.5 plus a pitfall row: an empty listing right after opening a trace is the **activation delay**
  first — ask the user to do the same thing once more before reading anything into it. Phrased
  qualitatively; Hard Rule 12 forbids thresholds and environment-specific values in the Skill.
- **The acceptance ran, and it is green everywhere it could run.** The cold `validate:p10` phase run
  (`06:40:30Z`, `p10-validation-20261009-144019.json`) ended `overall: PARTIAL` for exactly one
  reason — T4's documented `inactiveDefault` gap, reported as `NOT TESTED` because this org has no
  recycled component to make it measurable. T2 11/11, T3 15/15 and T5 15/15 PASS; partial-enablement
  9/9 including the **cross-Tool hint gate** (a hint may only name a Tool the same request
  advertises); `auditCoverage` 6/6 Tools on the run's own watermark; the credential scan 16 readings,
  0 hits; the persistence barrier `drained: true`, `dropped: 0`. The activation leg measured the very
  delay it was written for: **2 rounds, 19 polls, 103 635 ms** before the trace was demonstrably
  capturing, with the measured pair and the body leg then passing behind it. Local gates: `build`,
  `test` (root), `test` (mcp-server), `test:p3`/`p4`/`p5`, `validate:p4`, `validate:upstream`,
  `agent:check`, `skill:check` all exit 0; the four that are not green — `test:p7` (fails under
  battery load; solo re-runs pass on the branch tip and on `main`), `validate:p2`, `validate:p3`,
  `lint` — are pre-existing and kept separate in §5. The three required scenarios
  (Apex exception closed loop, field attribution, change-timeline alignment) each closed on live
  evidence. Full report: [P10_ACCEPTANCE_REPORT.md](docs/sfoa/P10_ACCEPTANCE_REPORT.md).
- **Still owed** (the P9 standard: named, not absorbed): no P10 Tool has been enabled through the
  Control Plane console — all six are granted in memory by the milestones; `A-1`, cross-user `ApexLog`
  visibility, remains a production check; the stall rule's positive case, the
  `UNAVAILABLE`/`totalCount: null` branch, both budget ladders and the `Aborted` literal still have no
  live leg; and the human halves of T3's and T4's Setup-page cross-checks are owed by construction.
  The full list is §7 of [P10_ACCEPTANCE_REPORT.md](docs/sfoa/P10_ACCEPTANCE_REPORT.md).

# SFoA P10 Diagnostic Depth — T5 `get_platform_diagnostics`: a merged evidence timeline, and a batch fixture that measured the platform (2026-10-09)

- Deliver **GAP-M5**: `get_platform_diagnostics`, the read-only Tool an incident starts
  with (`DIAGNOSTIC`, default-disabled, audited at its own `purpose =
  PLATFORM_DIAGNOSTICS`). One call reads `SetupAuditTrail` (what changed),
  `AsyncApexJob` `Failed`/`Aborted` (what broke) and `CronTrigger` (what stopped
  firing), and merges them onto **one clock** in `alignment.timeline` — "the nearest
  change above the symptom" becomes a position in a list instead of three calls and
  three renderings reconciled by hand.
- Land [ADR-0033](docs/sfoa/adr/ADR-0033-p10-platform-diagnostics-stall-rule-and-degradation-matrix.md):
  the **stall rule** (`SUSPECTED` needs a waiting literal *and* a fire time more than
  30 minutes past; an unfamiliar state is `INDETERMINATE`, never healthy, because this
  org holds zero `CronTrigger` rows and the vocabulary was never measured), the
  **degradation matrix** (per-section `READ`/`UNAVAILABLE`, `totalCount: null` — never
  `0` — on unavailable), and the **whitelist**, narrowed from ADR-0029 §4a's four
  objects to the three standard-API ones (`ApexLog` dropped: the log surface belongs to
  the Tooling Tools and the hint points at `get_apex_logs` by name).
- **A zero-entry section has to be *evidenced*.** The failure section carries a
  window-independent status-vocabulary read beside its entries, so a zero-match filter
  is visibly a filter that ran against a real table; a failed vocabulary read beside a
  zero match degrades the section to `UNAVAILABLE`. The setup section carries the
  trail's **oldest retained row** (`2026-04-13`) as a measured bound in the hint,
  because the prompt's "~90 days" is not exposed to SOQL.
- **The live milestone's middle run is the more valuable half.** The 04:06 UTC run's
  `constructedFailure` gate failed with four problems: the fixture threw from
  `Database.Batchable.execute` and the platform answered `Status: Completed` with
  `NumberOfErrors: 2` — the framework contains a chunk's exception. A failure raised in
  `start` produces the real `Failed` row (`ExtendedStatus` carries the first error), and
  that measurement now lives in the fixture's doc comment and ADR-0033 §10. The 04:08
  UTC re-run is `overall = PASS`, fifteen of fifteen gates; the 03:45 run predates the
  constructed leg and carries fourteen. All three reports are archived unedited in
  [P10_T5_LIVE_EVIDENCE.md](docs/sfoa/P10_T5_LIVE_EVIDENCE.md).
- **The whitelist is the entire guarantee on the standard API.** ADR-0029 §4a measured
  it — the DIAGNOSTIC identity that cannot see a `Lead` through Tooling read 955 rows
  of one through the standard API — so the whitelist is hardcoded host-side beside the
  `RequestScope`, a unit test scans the compiled executor for every `FROM` target, and
  the live gate brackets all four Tool calls: 23 statements, exactly three distinct
  targets, `offWhitelist: []`, `dml: []`.
- **The second clock is now a measured fact.** The org's clock runs **14.7 s behind the
  host's** (an unauthenticated HTTP `Date` read; the run's own stamps agree). That is
  why a job the fixture submitted carries an org-side `CreatedDate` earlier than the
  host-side calls that preceded the fixture — and why the answer's note names the two
  clocks rather than promising a window boundary.
- **Still owed**: a live positive case for the stall rule (needs a populated
  `CronTrigger`), a live leg for the `UNAVAILABLE`/`totalCount: null` branch and for
  both budget ladders (the widest answer sat at 61 533 B of 262 144), the `Aborted`
  literal (never observed in a vocabulary read), and the Console enablement path (no
  `sfoa_tool_control` row exists for this Tool).

# SFoA P10 Diagnostic Depth — T4 metadata listing pair, and the type allowlist corrected by measurement (2026-10-09)

- Deliver the metadata pair: `list_metadata_components`, a read-only Tool that
  enumerates a type's components (`METADATA_READ`, default-disabled, audited at
  its own `purpose = METADATA_LIST`), and a widened
  `get_metadata_component_context` allowlist, 8 → 21 types. The listing never
  returns content and the reader never enumerates; each answer's hint names the
  other half by the name `tools/list` actually advertises.
- Land [ADR-0032](docs/sfoa/adr/ADR-0032-p10-metadata-listing-pair-data-source-and-type-budget.md):
  Metadata API `listMetadata` as the source for every type (no Tooling object
  enumerates configuration uniformly, and `describe` answers for the *calling
  identity*, not the org), `manageableState` as the per-type-optional liveness
  field, and one global byte budget instead of a 22-row table of unmeasured
  numbers.
- **Two of the prompt's type names are not this API's names.** `SharingRule`
  answers `INVALID_TYPE`; this org's `describeMetadata` declares **204** types and
  the plural `SharingRules` is among them, listing 210 components. `CustomSetting`
  is not a Metadata API type at all — the capability is already served by
  `CustomObject`, and the org's 8 custom settings appear 8-of-8 in that listing.
  The allowlist is **twenty-one**, and both corrections are recorded rather than
  applied silently.
- **The per-type refusal branch was dead code, and only a refusing type could say
  so.** jsforce namespaces Metadata API error codes (`sf:INVALID_TYPE`, at the top
  level and again under `data`), and the shared `readSalesforceFailure` rejects
  the colon and returns `null` — so every code in `METADATA_LIST_UNAVAILABLE_CODES`
  classified as `null` and the ADR-0029 §3 degradation contract could never fire.
  Run 1 reported both refusals as `MCP_METADATA_LIST_FAILED` with
  `prerequisite: null`: a per-type authorization fact reported as a retryable API
  failure. Fixed inside `mapMetadataListFailure` (namespace stripped at the one
  place that must classify, not by widening a sanitizer four other providers
  depend on), with unit tests pinned to the measured error shape.
- **The live milestone ran twice; run 1's `FAIL` is the more valuable half.** Run 1
  (22 prompt types) failed `allowlistCoverage` at 20 served; run 2 (21 corrected
  types, classifier fixed) is `overall = PARTIAL`, ten of eleven gates `PASS` and
  `inactiveDefault` `NOT TESTED` — this org holds no component in a `deleted`
  manageable state. Both reports are archived unedited in
  [P10_T4_LIVE_EVIDENCE.md](docs/sfoa/P10_T4_LIVE_EVIDENCE.md), which also records
  the host as **Node v22.23.1** and corrects the T3 page's v24.19.0 claim.
- **The pair is measured on the org's own bytes.** 245 `ValidationRule` components
  matched against an independent read by membership *and* order; round trip of
  `APIS管理组%2F业务员` — chosen because it carries an escaped separator —
  byte-exact, with the escaped name intact in the returned path; a missing
  component is a structured refusal, never an empty success; the byte budget
  measured on a real Profile (5 763 bytes, `truncated: false`, declared limits
  equal to reported); **zero SOQL** across every Tool-call window.
- **Audit separates the halves by `purpose` alone** — both Tools call
  `/services/Soap/m/68.0` v68.0 with `apiCategory = METADATA_API`, so
  `METADATA_LIST` against `METADATA_RETRIEVE` is the only distinguishing field.
  Every row is `executionRole = DIAGNOSTIC` / `identitySource =
  INTERNAL_SERVICE_HEADER`; the two `ERROR` rows are the missing-component gate's
  designed refusals. `sfoa_tool_control` holds no row for this Tool (nor for T3's
  `explain_field_access`), so both runs grant it in memory.
- **Still owed**: the prompt's human Setup-page count cross-check, a live leg for
  `includeInactive`'s default (needs a recycled component), a live truncation on
  an over-budget Profile, and a second evidence source for `EscalationRule`'s
  `totalCount: 0`.

# SFoA P10 Diagnostic Depth — T3 permission attribution and the target-user boundary (2026-09-30)

- Deliver **GAP-M2**: `explain_field_access`, a read-only Tool that answers *why* a
  user can or cannot see or edit a field by aggregating the layers Salesforce
  actually stores — object permission, `FieldPermissions` rows and the permission
  sets carrying them, record-type visibility, describe facts — into one
  `sourceChain`. It is **evidence aggregation, not a permission engine**: it never
  simulates or predicts Salesforce's adjudication, non-permission causes (validation
  rule, field dependency, read-only layout) are *presence hints* only, and an
  unreadable layer yields `INDETERMINATE` naming that layer rather than being
  reported as a denial. `DIAGNOSTIC`, default-disabled, audited through P7.
- Land [ADR-0031](docs/sfoa/adr/ADR-0031-p10-permission-attribution-target-boundary-and-indeterminate.md):
  the `targetUserId` boundary, `INDETERMINATE` as a third state, the
  Setup-layer query whitelist, and the rule that `describe` can never decide a
  conclusion.
- **The `targetUserId` boundary is the subject query's scope, not a check before
  it.** Membership is enforced by `Id = :id AND Username IN (:configured)` inside
  the query, so an Id outside the deployment's routes and an Id that exists nowhere
  produce byte-identical refusals — measured live at `refusalLength: 544`,
  `refusalTextsIdentical: true`, one subject lookup each. No branch can drift and
  the Tool cannot be used to ask which Ids exist.
- **The live milestone ran five times; the three failures are the substance of the
  task.** Two FLS mechanisms were measured rather than assumed: a `FieldPermissions`
  row **cannot be created** with `PermissionsRead=false`
  (`FIELD_INTEGRITY_EXCEPTION`, "Read permission is required for:
  Account.TickerSymbol"), and clearing Read on an existing row makes the platform
  **remove** it. Closing a field is therefore taking a row away — the same edit an
  administrator makes in Setup — which is why the answer stays *definite* on the
  ordinary real configuration. Recorded in
  [P10_T3_LIVE_EVIDENCE.md](docs/sfoa/P10_T3_LIVE_EVIDENCE.md), including what the
  run does not prove.
- **One defect, found only by the run — and it was in the harness, not the product.**
  `AdditiveToolPolicySnapshotSource`, the decorator the milestone uses to grant the Tool
  without writing the Control Plane, did not forward the optional
  `listConfiguredSalesforceUsernames`, so through it the deployment appeared to configure
  **no** identity routes and the Tool correctly refused every named target before reading
  anything. Every unit test passed — fixtures call the source directly, and the decorator
  existed only in the composition production uses. A fail-closed default turned the silent
  loss into a report that read as a fact about the deployment.
- **Three more harness defects, each of which would have let a wrong result pass.** The
  report dropped the platform's own error message and jsforce's `errors[]`; the cleanup
  comparison looked in one direction, so a run that **removed** a row (207 snapshot lines →
  206) reported `drift: []` on an org it had altered; and the restore had no way back from a
  row the platform deleted, because it restored by an id that no longer existed. A fourth —
  route usernames archived inside recorded SOQL — was fixed by masking at the point of
  recording, while the audit deliberately keeps the unmasked statement as its own internal
  record.
- **The §0.3 red line is measured on the wire.** The milestone wraps the Connection
  it hands the runtime and checks every statement the Tool issued against the
  executor's Setup-layer whitelist: 25 statements, 5 windows, zero off-whitelist
  targets, zero business-object reads. `fieldApiNames` is only ever a key into the
  permission configuration.
- **Final run: `overall = PASS`, exit 0, all fifteen gates `PASS`** on the sandbox
  (CHN5S, API v68.0), with the org restored to its pre-write snapshot line for line
  and twenty-eight audit rows (`7833`–`7861`) all on `executionRole = DIAGNOSTIC`
  with the Tool's calls carrying `purpose = PERMISSION_EXPLAIN`. All twelve of its
  failure rows are `MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED`, ten of them the boundary
  gate's own probes — they have to fail for the gate to pass, so a red row on this
  Tool means the boundary working. **Still owed**: the prompt's human Setup-page
  cross-check, and any live leg for `INDETERMINATE`.

# SFoA P10 Diagnostic Depth — T2 debug log toolset and the live closed loop (2026-09-30)

- Deliver **GAP-M1**: `set_trace_flag` (the write), `get_apex_logs` and
  `get_debug_log_body`, all `DIAGNOSTIC`, all default-disabled, all audited through
  P7, with hints that compose into one path — open a trace → reproduce → list → read
  the body → land on a class and line. The write boundary is one `TraceFlag` and one
  `DebugLevel`; there is no delete path and no other object is reachable.
- Land [ADR-0030](docs/sfoa/adr/ADR-0030-p10-debug-log-toolset-governance-and-debuglevels.md):
  a new `DIAGNOSTIC_WRITE` classification (`MUTATION` means "writes business
  records" and `ADMIN` means "changes who may do what" — this is neither), three
  fixed `DebugLevel` tiers under a reserved prefix, and the versioned Blob read
  keyed off the log's **own** header version.
- **The live milestone closes the loop on the sandbox, and finding it required
  two real defects to be fixed first.** The first run failed and the second passed;
  both runs remain in the audit trail, so audits `7699` (`verified: false` on a
  correct write) and `7711` (`MCP_APEX_LOG_READ_FAILED`) sit beside `7713`–`7716`.
  Recorded in
  [P10_T2_LIVE_EVIDENCE.md](docs/sfoa/P10_T2_LIVE_EVIDENCE.md) with the audit rows.
- **A SOQL `dateTime` filter must be emitted unquoted.** `LastModifiedDate >= '…Z'`
  is a *string* literal, and the Tooling API refuses it: `INVALID_FIELD` — "should
  not be enclosed in quotes". T0 could not have found this because its `ApexLog`
  query carried **no `WHERE` clause**, so no `dateTime` literal had ever been sent.
- **`TraceFlag` dates are second-precision on the request side too.** A request
  carrying milliseconds is truncated by the platform, so `stored >= requested` failed
  by the sub-second remainder and a correct write reported `verified: false`. The
  clock is truncated to whole seconds and the comparison stays exact — a tolerance
  would also accept a genuinely short trace. The unit fixture was corrected with it:
  it had been echoing the payload byte for byte, answering **more precisely than the
  org**, which is why a fixture could not guard a comparison production fails.
- Two measured facts beyond T0's: the DIAGNOSTIC identity **may run anonymous Apex**
  (never measured before, because the probe executed no code), and `ApexLog.Status`
  for a failure is **the exception's own text** — `Attempt to de-reference a null
  object` — not a localized label. The vocabulary is therefore free text that varies
  with the failure, not a two-value translation table, which is the strongest form
  of ADR-0029 §3's "never filter on a human-readable label".
- `run_diagnostic_tooling_query`'s free-form Tooling SOQL now has the `FROM`/`USING`
  object check ADR-0029 §4b specified, on the diagnostic allowlist, ahead of the
  platform's own refusal.

# SFoA P10 Diagnostic Depth — T1 prerequisite probe (2026-09-30)

- Measure the diagnostic identity's real capability surface **before** building six
  Tools on it, because P9's cost of assuming was the `limits()` endpoint being
  refused to every business identity and `get_org_limits` having to be re-homed
  (ADR-0027). The probe runs the exact Connection the Tools run on —
  `snapshotDiagnosticRoute` over the runtime's own request-scope factory — and
  reports **36 `AVAILABLE` · 5 `DENIED` · 0 `ERROR`** with
  `probeMode: SANDBOX_WRITE_ALLOWED`. Findings and inference are recorded in
  separate columns in
  [P10_T0_LIVE_PROBE_FINDINGS.md](docs/sfoa/P10_T0_LIVE_PROBE_FINDINGS.md), because
  P9 had to self-correct an inference that had been written as a fact.
- Land [ADR-0029](docs/sfoa/adr/ADR-0029-p10-diagnostic-identity-prerequisites.md):
  the per-Tool permission prerequisites, the org-admin prerequisites that **no code
  can supply** with the production enablement check steps, the degradation contract
  (a missing prerequisite is a structured error naming it — **never a silent empty
  result**, which an agent reads as "no anomaly"), and the formal filing of the
  §0.3 red line with the per-Tool query whitelist.
- **Four measured facts change the design, and each becomes a 修订注记 in the
  affected T2–T5 prompt section** (original prompt text preserved):
  `set_trace_flag` must be **create-or-extend** — an overlapping `TraceFlag` create
  is refused with `FIELD_INTEGRITY_EXCEPTION`, so "trace me for an hour" fails the
  second time it is used; the Apex log parser must follow **the log's own header
  version** (54.0 and 56.0 both observed against a v68.0 org); no P10 Tool may
  match on a **localized label** (`ApexLog.Status` matched 1 row in English and 8 in
  the localized literal); and `SetupAuditTrail` counts live in `totalSize` while
  `COUNT(Id)` is refused outright.
- The red line is now measured on **both** of its halves, and only one is
  structural: through the Tooling API the platform refuses `Lead`, `Account`,
  `Value_Bill__c` and `Order__c` with `INVALID_TYPE` while resolving `ApexClass` as
  a control — but the **same identity reads 955 `Lead` rows over the standard API**.
  For `explain_field_access` and three of `get_platform_diagnostics`' four sources
  the hardcoded whitelist is therefore the *entire* guarantee, not a second line of
  defence.
- Re-review the three pre-existing diagnostic Tools. `get_org_limits` and
  `get_metadata_component_context` meet the boundary;
  `run_diagnostic_tooling_query` meets it *in fact* but not §0.3.1's letter — its
  free-form Tooling SOQL rests entirely on the platform's refusal with no
  object check in our code. The narrow fix is specified in ADR-0029 §4b and
  assigned to T2; T1 adds no Tool behaviour.
- Decide the enablement surface honestly. The option "diagnostic Tools enableable
  only on the DIAGNOSTIC route" **cannot be built**: enablement is global
  (ADR-0027 already recorded this), the diagnostic identity is a single
  deployment-wide row, and no caller-to-diagnostic binding exists. ADR-0029 accepts
  the Console data-surface declaration + explicit Admin confirmation as P10's
  governance form and specifies the per-caller entitlement as the structural
  follow-up, stating plainly that until it lands **"business users cannot call
  diagnostic Tools" is not true on this deployment**.
- Keep the probe, rather than deleting it like P9's: `probe:p10` is re-runnable, its
  write legs are gated on the org's own `IsSandbox` answer (the variable can only
  force writes *off*, never on), and every write leg now re-reads to confirm the row
  it created is gone — a check that exists because an earlier run reported
  `cleanupSucceeded: true` on a `TraceFlag` that was still there.
- **Open, and recorded as open:** the probe could only ever read `ApexLog` rows
  belonging to the diagnostic identity itself, which is consistent with ownership
  alone and does **not** demonstrate `View All Data`. Whether it can read another
  user's logs is a production deployment check (prerequisite `A-1`), not an
  established fact.

# SFoA P9 Data Completeness (2026-09-29)

- Add the `@sfoa/mcp-provider-sfoa-data` provider and its six read-only Tools —
  `query_records`, `list_sobjects`, `describe_sobject`, `search_records`,
  `submit_bulk_query`, `get_bulk_query_results` — plus `get_org_limits` in the
  existing `@sfoa/mcp-provider-sfoa-context` provider. **Seven** Tools, not the
  eight the P9 plan's wording implies: P9-5 is a Skill-and-description deliverable
  with no Tool of its own, so six of the six items that name a Tool contribute one
  each. Every one of the seven is **disabled by default** and reaches an Agent only
  through an explicitly enabled Control Plane route; the advertised surface on the
  test server went from 16 Tools to 23, with `readOnlyAnnotations` true and no
  annotation offenders (`MCP Runtime changed: YES`).
- Land the P9 divergence ADRs rather than silently deviating from the plan:
  [ADR-0024](docs/sfoa/adr/ADR-0024-p9-data-provider-over-official-sdk.md)
  (`describe_global` renamed `list_sobjects`, and a data provider that vendors no
  official code), [ADR-0025](docs/sfoa/adr/ADR-0025-p9-query-records-bounded-completeness.md)
  (`query_records` as a new Tool beside the untouched official `run_soql_query`
  rather than a wrapper of it),
  [ADR-0026](docs/sfoa/adr/ADR-0026-p9-org-limits-and-sosl-search.md) (SOSL search
  and the limits snapshot), [ADR-0027](docs/sfoa/adr/ADR-0027-p9-org-limits-diagnostic-identity.md)
  (`get_org_limits` on the Diagnostic identity, because the `limits` resource is
  org configuration a business identity cannot read) and
  [ADR-0028](docs/sfoa/adr/ADR-0028-p9-bulk-query-export-over-official-sdk.md)
  (Bulk API 2.0 export over the official SDK, with five recorded deviations).
- Record the one acceptance criterion the org cannot meet, instead of meeting it
  on paper: the plan's milestone asks for a "100 000-row real object" and no object
  in this org has one — a survey of all 523 queryable objects put the largest at
  `ContactShare` with **74 660** rows and the largest business object at `Contact`
  with **37 496**. The Bulk export gate runs at that real scale under
  `P9_LIVE_BULK_MIN_ROWS` and reports both the floor it used and the floor the plan
  asked for (`minimumRows` / `plannedMinimumRows`), and the override cannot be set
  below five pages, so a relaxed-floor PASS is never mistakable for a planned-floor
  one. Recorded as ADR-0028 deviation 5.
- Publish Playbook **1.10.0** with the data-completeness contract: the coverage
  declaration obligation for anything derived from `query_records`/Bulk results
  (`fetched` vs `totalSize`, and no whole-result claim while `truncated` is true),
  Tool selection by expected size, aggregate-before-detail, schema self-repair
  before retrying an `INVALID_FIELD`, and a limits check ahead of a large job. The
  five `agent:sync` generated artifacts (including the 小犇 instruction
  `docs/agent/DIFY_AGENT_INSTRUCTION.md`) carry `Playbook-Version: 1.10.0` and
  `agent:check` reports no drift.
- Add `skills/sfoa-data-analysis`, the business Skill the P9 contract needs: hard
  rules for the completeness declaration and for what `truncated` forbids, the
  three escalation paths out of a truncated result (aggregate, Bulk, narrow the
  scope), the rule that untrusted field content stays data, and explicit
  statistical scope; guidelines for COUNT-then-detail, `describe` self-repair,
  a limits pre-check and locator discipline. Registered in
  `BUSINESS_SKILL_ALLOWLIST` so the runtime publisher will accept it, and present
  in the canonical, `.claude` and `.codebuddy` copies.
- Fix a **defect in the P9 live gate itself**, found by running it: the
  `get_org_limits` gate waived a disagreement with the reference reading only when
  the org moved that counter between the gate's two reference readings. The
  counter is advanced by the run's own API traffic, so once that traffic stops the
  org stops moving and the waiver cannot fire — three runs of byte-identical code
  disagreed with their own reference reading by 4, 3 and 8 on `DailyApiRequests`,
  in both directions, and two of the three failed a correct Tool. The gate now
  also waives a disagreement within a small fraction of the limit's ceiling, keeps
  `max` strict, keeps the Tool's own `used === max - remaining` strict (so a
  swapped operand, a wrong key, a stringified number or a scale error still fail),
  and reports every waiver in `toleratedMoves` so a tolerated disagreement stays
  visible. This follows the T4 precedent: the gate is part of the deliverable, and
  a gate that fails a correct implementation cannot certify anything.
- Correct the two Playbook-version drift gates that the 1.10.0 bump moves
  (`AgentIntegrationPage.test.ts`, `SkillContent.test.ts`). They assert the
  published version on purpose — a page or generated Skill still naming an older
  Playbook must not pass unnoticed — and the previous bump, 1.8.0 → 1.9.0, updated
  the same two literals.
- Verified on the test server: the full P9 live acceptance is `overall: PASS`
  across all eleven gates, including a Bulk export whose summed page counts equal
  the org's own `COUNT()` (37 010 of 37 010 across 19 pages), a `query_records`
  probe that declares `truncated: true / RESPONSE_BUDGET` rather than claiming the
  whole result, schema self-repair after `MCP_SOBJECT_NOT_FOUND`, a SOSL search
  that matches its predicted count, and 34 of 34 audit snapshots persisted with the
  queue drained. Evidence and per-command results:
  [docs/sfoa/P9_ACCEPTANCE_REPORT.md](docs/sfoa/P9_ACCEPTANCE_REPORT.md).
- Sync the host that consumes the contract, not just the server that serves it.
  `skill:runtime:sync` published all three business Skills into the OpenClaw
  workspace — the new `sfoa-data-analysis` plus refreshed `sfoa-crm-core` and
  `sfoa-record-change` — with `runtime-check` reporting no drift and each SKILL.md
  byte-identical between the canonical tree and the workspace copy. The connector
  Skill produced by `skill:export`, still announcing **1.9.0 / 15 Tools** from its
  09-23 install, was regenerated at **1.10.0 / 22 Tools**; because files are not
  visibility, the Skill was also added to `skills.entries` and to the `main`
  Agent's allowlist, where its absence had made `openclaw skills check` report it
  as `Excluded by agent allowlist` — installed and invisible. The Gateway was not
  restarted (`openclaw config patch` reports this change does not need one; its
  `ActiveEnterTimestamp` is unchanged), and visible-to-model went 5 → 6. Human
  WeCom UAT remains **not executed** and is not claimed.

# SFoA Skill Export Package + Summary-Navigation Reference (2026-09-23)

- Add the zero-credential AgentSkills export generator
  (`skills/sfoa-mcp-maintainer/scripts/export-agent-skill.mjs`, exposed as the
  repo-level `export` action and `yarn skill:export`). It renders
  `out/sfoa-openclaw-package/` (`sfoa/SKILL.md` + `sfoa/mcp.json` + `README.md`)
  purely from `packages/sfoa-agent-playbook/src/capabilities.ts`
  (`AGENT_RECOGNIZED_TOOL_NAMES`), with a two-way drift check against the static
  `TOOL_PRESENTATION` table so the advertised tool surface can never silently
  diverge from the playbook. The generated `mcp.json` is URL-mode only — no
  `command`, no `env`, no Salesforce credentials anywhere in the package;
  identity resolution, Tool/DML governance and P7 audit remain server-side.
  Output is timestamp-free and byte-identical across reruns; `out/` is
  gitignored because the package is regenerable and must not become a second
  source of truth. Runtime tools, governance and schemas are unchanged
  (`MCP Runtime changed: NO`).
- Add `skills/sfoa-crm-core/references/summary-navigation.md` (routed from the
  Skill's reference list): the post-mutation summary and record-navigation
  template absorbed from the evaluated MuleRun Salesforce skill, hardened to
  this runtime — proven links only via `get_record_links` or tool-returned
  URLs, no self-assembled Lightning URLs, and summaries that stay consistent
  with per-item tool evidence (PARTIAL_SUCCESS / OUTCOME_UNKNOWN / deletions
  are never dropped or polished).
- Add `docs/sfoa/SFOA_SKILL_EXPORT_PACKAGE.md` recording the MuleRun evaluation
  verdict (absorb the packaging methodology and template; do not import the
  vendored `smn2gnt/MCP-Salesforce` server), the ownership finding that
  `.codebuddy/skills/sfoa-salesforce-assistant` is an `agent:sync` generated
  artifact and must not be canonicalized, the OpenClaw onboarding path that
  supplements (not replaces) `skill:runtime:sync`, and the removal story.
- Extend `skills/sfoa-mcp-maintainer/scripts/toolkit.test.mjs` with three
  `skill:export` gates: live-source parser drift detection (failure modes fail
  loudly), package generation invariants (URL-mode-only mcp.json, no
  credential variable names, hard-boundary markers, per-tool table rows,
  deterministic rerun), and output-root refusal paths.
- Guard the generator's output root. `exportAgentSkillPackage` cleared its
  target with `rm -rf` unguarded, so `--output .` deleted the entire checkout
  and `--output ..` its parent. `assertSafeOutputRoot` now accepts only the two
  Git-ignored regenerable roots (`out/<name>`, `.temp/<name>`) or a scratch
  directory outside the checkout, and refuses the project root, its ancestors,
  repository source directories, another Git working tree, the home directory
  and filesystem roots. Verified end to end: the three destructive cases refuse
  and leave the checkout intact.
- Anchor the `.gitignore` entry to `/out/`. The unanchored `out/` also ignored
  every nested `packages/*/out` build output — the same class of silent-ignore
  defect ADR-0017 records for the bare `lib` pattern.
- Name the trusted-link source explicitly (`TRUSTED_LINK_TOOL_NAMES`, pinned to
  `get_record_links` and drift-checked like `TOOL_PRESENTATION`) instead of
  deriving it from `AGENT_INFRASTRUCTURE_TOOL_NAMES`; the exported hard boundary
  had claimed `get_agent_playbook` was a link source, but it returns a
  capability snapshot. The generated README now also says plainly that
  "self-contained" means the package's own contents, not out-of-the-box
  connectivity — the endpoint still needs host-side registration.
- Re-sync the three platform copies of the maintainer Skill. The README typo
  fix was written into canonical after the copies had been synced, and the
  commit took the corrected canonical together with the stale copies, leaving
  `skill:check` failing at exit 1 (identical length, one character apart). Fixed
  by re-running `skill:sync`; `skill:check` is green (drift `[]` x3). The
  failure mode and its cause are recorded in
  `docs/sfoa/SFOA_SKILL_EXPORT_PACKAGE.md` §8 rather than papered over.

# SFoA Skill-02C Attachment Upload (2026-09-15)

- Add a governed `upload_files_to_record` Tool that publishes files an inbound
  channel already delivered onto one existing business record as Salesforce
  Files. It is host-native like `get_agent_playbook`: no Provider supplies it, so
  the governed and the discovery inventory are each given its descriptor
  explicitly, and a name collision with an upstream Provider fails closed rather
  than silently resolving in either direction. Governance that enables the Tool
  on a runtime with no Attachment Ingress bound — or with no attachment-enabled
  object — is refused by *both* servers with `MCP_ATTACHMENT_CONFIGURATION_INVALID`
  rather than advertised by discovery and refused on execution. Files reach
  Salesforce only through an opaque `att_…` reference that the SFOA Attachment
  Ingress minted for the requesting platform user — the schema has no `path`,
  `filePath`, `content`, `base64`, `versionData` or `sourceUrl`, so an Agent can
  name neither a file nor an arbitrary host path nor a URL.
- Add the SFOA Attachment Ingress: one controlled staging root, streaming metered
  writes under an opaque reference, requester-scoped resolution in which an
  unknown reference and another requester's reference raise the *same*
  `MCP_ATTACHMENT_NOT_OWNED`, containment re-derived when a file is opened so a
  tampered row cannot read outside the root, plus a TTL reaper and per-owner
  bounding. The ingress decides nothing about acceptability: no extension, MIME
  or size-limit mirror of Salesforce file rules exists in configuration, database
  or UI, so Salesforce stays the final authority on which files it accepts.
- Keep attachment enablement independent of CREATE/UPDATE. It has its own policy
  channel and Tool inventory rather than joining `MCP_DML_ALLOWLIST_JSON`, because
  attaching a file is neither a CREATE nor a field UPDATE and an object may
  legitimately accept files while accepting no record mutation. Migration `014`
  adds `attachment_enabled` as `NOT NULL DEFAULT false`, so an upgraded object
  does not suddenly accept attachments. The Files objects (`ContentVersion`,
  `ContentDocument`, `ContentDocumentLink`) stay internal technical objects that
  are never exposed as Generic DML targets.
- Publish as the requesting user through the REST multipart endpoint with
  `FirstPublishLocationId`, discover the `ContentDocumentId` through a platform
  query, and report one result per file under the P8-07 outcome model
  (`SUCCESS`/`FAILED`/`OUTCOME_UNKNOWN`/`NOT_ATTEMPTED` per file against an
  aggregate of `SUCCESS`/`PARTIAL_SUCCESS`/`FAILED`/`OUTCOME_UNKNOWN`). An unknown
  outcome stops the call, reports the remainder as `NOT_ATTEMPTED` and is never
  replayed; a proven failure may be retried file by file; the platform's own
  `errorCode` and message are preserved verbatim. A rejection Salesforce states
  in its own format is a proven failure, and only an answer Salesforce did not
  write leaves the outcome unknown.
- Extend the existing P7 audit and Tool governance instead of adding a channel:
  one terminal event per invocation carrying runId/traceId, source channel, the
  platform and mapped Salesforce user, the object and record, and per file the
  reference, name, MIME type, size, digest, Salesforce API path, ContentVersionId,
  ContentDocumentId, status, HTTP status and duration — and never a file byte, its
  base64 form, the raw multipart body, a staged path or a Bearer token.
- Fix a defect found while verifying the above: every *successful* upload
  published its file to Salesforce and then lost the whole P7 Audit snapshot, so
  the `ContentVersionId` it had just created was never recorded — and the only
  symptom was a missing row. The recorder set `visibility: 'EXACT_HTTP'` together
  with a non-null `operationName`, and the sink refuses that combination
  non-retryably, because `EXACT_HTTP` means the real wire facts were observed
  while `operationName` is the label for a call whose HTTP facts are unavailable.
  The field is now absent from the evidence type, so the invariant is structural
  rather than remembered; the sink's database-free checks are extracted into an
  exported `assertAuditSnapshotPersistable` that runs before the transaction
  opens (same errors, same order, same retryability, so no behaviour changes) and
  lets a Tool that records its own Salesforce calls be held to that contract
  without a database; and a gate now drives the real upload inside a request
  audit context and requires the finalised snapshot to satisfy it. Reintroducing
  the old field was confirmed to make that gate fail.
- Extend the existing `sfoa-record-change` Skill rather than adding a new one: a
  single activation line in `SKILL.md` and a new `references/file-attachments.md`
  holding the attachment doctrine (only attachment-enabled objects; create first;
  a CREATE `OUTCOME_UNKNOWN` forbids upload; an attachment `FAILED` does not undo a
  successful create; an attachment `OUTCOME_UNKNOWN` is never replayed; never
  invent a reference; never pass a path or URL).
- Add the OpenClaw Attachment Bridge inside our own `sfoa-wecom-mcp-adapter`
  plugin. The official WeCom plugin is **not** modified and OpenClaw Core is not
  patched; the bridge stages the files a conversation message carried and injects
  their references into the turn, gated by `attachmentBridgeEnabled` and by the
  host's `hooks.allowConversationAccess` grant. Verification and external UAT
  status: `docs/sfoa/SKILL_02C_IMPLEMENTATION_REPORT.md`.

# SFoA OpenClaw Skill Foundation (2026-09-13)

- HOTFIX01 (2026-09-14): promote evidence-scope and fact/inference boundaries to
  the CRM Core entry; document aggregate-first evidence, partial coverage and
  search-versus-fetch semantics. Add an editorial contract guard, separate from
  runtime and real WeCom acceptance. No MCP/identity/DML implementation changes.

- Establish the SFOA Skill Suite baseline and implement only `sfoa-crm-core`,
  with separate hard boundaries and flexible evidence/tool-selection guidance.
- Extend existing Skill delivery to multiple canonical sources without copying
  maintainer tooling into business Skills. Preserve maintainer-specific gates.
- Deployment, live invocation and WeCom acceptance status are recorded in
  `docs/sfoa/SFOA_CRM_CORE_SKILL.md`; local delivery does not imply runtime READY.
- Record the September 13 WeCom UAT failures and concrete CREATE field omissions.
  Compare configured models for actual Skill reads; select deepseek-flash for the
  test main Agent with existing multimodal settings preserved. Real-user retest
  remains pending; record-change is not yet released.

# SFoA P8-07 (2026-09-09)

- Add governed synchronous batch CREATE/UPDATE, explicit CREATE initial provenance,
  bounded USER facts, Picklist label resolution and generic relationship context.
- Propagate canonical batch/compound intent rules and expose partial/unknown P7
  counts. Verification and external UAT status: docs/sfoa/P8-07-IMPLEMENTATION-REPORT.md.

## SFoA unreleased — 2026-09-01

### Features

- P8-04: implement optional USER-aware effective CREATE context with deterministic Dynamic Forms visibility, one bounded current MySQL snapshot table, per-object OFF/SHADOW/ENFORCE, Admin refresh/status, P7 field evidence and context-to-CREATE provenance, and Playbook 1.6.0. AMEND-006 moves real UI/Agent accuracy to post-implementation UAT; default OFF and existing Page Layout/managed Lookup behavior remain protected.

- Implement P7-07 Audit Trace Workbench with a shared Admin trace Contract, deterministic first-failure timeline, full audit filters, Payload metadata/body separation, UNKNOWN/PARTIAL semantics, SOQL/DML evidence views, URL state, and Buntu identity compatibility.
- Implement P7-08 Agent-Native Maintainer Skill and local diagnostic toolkit with one canonical source, generated Codex/Claude/CodeBuddy copies, Windows-safe sync/check/ZIP packaging, Project Doctor/Snapshot, predefined read-only MySQL inspection, and secret-safe P7 Audit reconstruction. No business MCP Tool or Runtime hot-path behavior is added.
- Implement P7-09 lazy request-scoped Salesforce resource lifecycle. Local/route-only Tools and local MCP methods perform zero Salesforce authentication/API calls; Salesforce-dependent USER and DIAGNOSTIC requests create one Promise-memoized role-bound Connection with no cross-request cache and no Tool/identity/governance/Audit contract change.
- Guide Agents onto org custom objects for business records the org moved off unused Salesforce standard objects (Quote→Quote__c, QuoteLineItem→Quote_Product__c, Order→Order__c, OrderItem→Order_Product__c, Pricebook2→Pricebook__c, PricebookEntry→Pricebook_Entry__c, Contract→Contract__c). The single source is `@sfoa/agent-playbook` `ORG_OBJECT_SUBSTITUTIONS`, cross-checked against a recorded org inventory (`org-object-inventory`) that the package refuses to load when they drift; it renders a new playbook ORG_OBJECT_USAGE section into MCP instructions/Resources/`get_agent_playbook`/WorkBuddy/Dify guidance plus a `run_soql_query` Tool-description note. At execution the remote facade rejects a USER `run_soql_query` whose top-level object matches an unused standard with `MCP_SOBJECT_NOT_IN_USE` naming the replacement custom object, before any Salesforce Connection and without rewriting the query — so an unused standard can never silently return an empty result that an Agent would misread as "no such records". Diagnostic/Tooling queries are unaffected.

### Fixes

- CREATE Record Type selection excludes Master when a non-Master type is available to the current USER, including explicit context selection. A single business type loads its full CREATE context without an unnecessary question; Master-only objects/users retain their fallback. Playbook 1.6.1, MCP Instructions and generated clients share the rule; UPDATE/READ and DML authorization remain unchanged.

- P8-04 HOTFIX01: preserve exact legacy CREATE output in OFF/SHADOW/Page Layout/fallback; expose UI provenance only for enforced Dynamic Forms, isolate SHADOW draft and infrastructure errors, share one 3s extra-read budget, and retain internal Audit identity independently of Agent output. No new table, dependency, Tool or snapshot format.
- P8-04 HOTFIX01 closure: run Dynamic draft semantic validation only after resolution proves a supported Dynamic Forms/MIXED page with no fallback, so ENFORCE + PAGE_LAYOUT and every Page Layout fallback ignore an Agent draft they would not use while enforced Dynamic Forms still returns structured `MCP_RECORD_ACTION_CONTEXT_INVALID`. Adds four Tool-boundary regression cases (A–D) to the exact-legacy fixture suite.

- P8-04A-01 HOTFIX01: minimize public evidence into aliased fixtures, broaden read-only route/Profile candidate discovery, verify App identity joins, and document explicit integration App context plus manual New UI capture. A-01 remains COMPLETE — BLOCKED; no production package behavior, migration, snapshot or A-02 implementation changes.
- Eliminate mixed Control Plane/Admin API declarations and stabilize Windows Node test execution with Node 24's in-process test isolation mode.
- Close P7-08 maintainer Skill delivery: relocate helper modules from `scripts/lib` to `scripts/shared` (the root `.gitignore` `lib` pattern silently excluded them from commits) and add a Git trackability `delivery` gate plus a clean-checkout `smoke` proof so a fresh clone always carries the full Skill runtime.
- P7-09 HOTFIX01: replace the implicit `hostOwnedArguments.includes('usernameOrAlias')` Connection heuristic with an explicit `requiresSalesforceConnection` boolean on each remote Tool contract (get_username=false, run_soql_query/retrieve_metadata=true), enforced by an upstream-drift guard so no remote Tool falls back to guessing. Align the DML lazy-authentication failure onto the standard DML output contract (`success=false`/`errorCode`/redacted `message`). Pin the Tool `durationMs` as end-to-end latency including lazy auth/connection.
- Add a bounded in-process Buntu token validation cache. A Buntu bearer token is validated upstream once and then reused until its own `data.expiresAt` (captured by the validator contract) via a per-server SHA-256-fingerprint LRU (max 1000). A cache hit performs no upstream call and writes no `IDENTITY_VALIDATION` audit; concurrent identical-token requests collapse to a single validation. This reduces the per-POST validation audits of one MCP interaction only when the client reuses the same token across its POSTs. A client that issues a fresh token on every POST still receives one independent validation and one audit per POST — each such POST is a separate authenticated request and its audit is correct evidence; the cache deliberately never skips validating an unseen token. validate-token remains the identity authority, the Control Plane route is still read on every request (route disable/delete stays immediate), and token-level revocation is bounded by `expiresAt`. Failed or expiry-less validations are never cached; memory stays bounded by the LRU cap.

## [0.17.1](https://github.com/salesforcecli/mcp/compare/0.17.0...0.17.1) (2025-08-17)

# [0.17.0](https://github.com/salesforcecli/mcp/compare/0.16.1...0.17.0) (2025-07-29)

### Features

- **W-19147516:** replace sf-enable-tool with sf-enable-tools ([#128](https://github.com/salesforcecli/mcp/issues/128)) ([5f66de9](https://github.com/salesforcecli/mcp/commit/5f66de944fdb202e34999b81ccc169393e1d1bbf))

## [0.16.1](https://github.com/salesforcecli/mcp/compare/0.16.0...0.16.1) (2025-07-28)

### Bug Fixes

- **W-19105967:** better descriptions to prevent unneeded sf-list-tool calls ([#121](https://github.com/salesforcecli/mcp/issues/121)) ([863fec9](https://github.com/salesforcecli/mcp/commit/863fec9c667647492a9494ed0a60a8deb338d448))

# [0.16.0](https://github.com/salesforcecli/mcp/compare/0.15.4...0.16.0) (2025-07-28)

### Bug Fixes

- add sf-suggest-cli-command to core tools ([4657d72](https://github.com/salesforcecli/mcp/commit/4657d720588be0aee68fee84d1dbbe202ed314c6))
- check if index needs to be built when calling getAssets ([efb5c21](https://github.com/salesforcecli/mcp/commit/efb5c21d10a41f95b8775ba45c3f61f352acecd8))
- improve embedding and agent instructions ([f363772](https://github.com/salesforcecli/mcp/commit/f363772548805ccc83259583a4c00d0c3b5ce0b1))

### Features

- create weighted embedding text ([30b5ccf](https://github.com/salesforcecli/mcp/commit/30b5ccfa82176f11bccc9efe8a34bba09ccc7fd5))
- **W-18909741:** suggest sf command ([5ca1455](https://github.com/salesforcecli/mcp/commit/5ca1455d394a506017b5b341c64f41ef2f7706b7))

## [0.15.4](https://github.com/salesforcecli/mcp/compare/0.15.3...0.15.4) (2025-07-27)

### Bug Fixes

- **deps:** bump @jsforce/jsforce-node from 3.9.1 to 3.9.4 ([08b58a6](https://github.com/salesforcecli/mcp/commit/08b58a66f64e1eab737ce8eb7b5c1616ed124d71))

## [0.15.3](https://github.com/salesforcecli/mcp/compare/0.15.2...0.15.3) (2025-07-26)

### Bug Fixes

- **deps:** bump @salesforce/source-deploy-retrieve ([d85e3c0](https://github.com/salesforcecli/mcp/commit/d85e3c0499db0c14c26a5944b1d6066faaf9ffc3))

## [0.15.2](https://github.com/salesforcecli/mcp/compare/0.15.1...0.15.2) (2025-07-26)

### Bug Fixes

- **deps:** bump zod from 3.25.67 to 3.25.76 ([221c271](https://github.com/salesforcecli/mcp/commit/221c271d3c614992d768475110663d7bd163c867))

## [0.15.1](https://github.com/salesforcecli/mcp/compare/0.15.0...0.15.1) (2025-07-26)

### Bug Fixes

- **deps:** bump @salesforce/telemetry from 6.0.39 to 6.1.0 ([0244c4a](https://github.com/salesforcecli/mcp/commit/0244c4a09942739bcbc4ba561616894bf5a3f824))

# [0.15.0](https://github.com/salesforcecli/mcp/compare/0.14.3...0.15.0) (2025-07-24)

### Features

- add snapshot tool, add ability to monitor snapshot from resume tools ([50d54f4](https://github.com/salesforcecli/mcp/commit/50d54f4c03cbd6c05100a8352fedf7aec0fff075))
- delete scratch/sandbox ([61fb363](https://github.com/salesforcecli/mcp/commit/61fb363c05836fceb491a9462fc63f37ed3136f3))

## [0.14.3](https://github.com/salesforcecli/mcp/compare/0.14.2...0.14.3) (2025-07-22)

### Bug Fixes

- **deps:** bump form-data from 4.0.0 to 4.0.4 ([70c072e](https://github.com/salesforcecli/mcp/commit/70c072e02d7badf6cd6cfed40f78640a5ccec2f1))

## [0.14.2](https://github.com/salesforcecli/mcp/compare/0.14.1...0.14.2) (2025-07-19)

### Bug Fixes

- **deps:** bump @salesforce/source-tracking from 7.4.7 to 7.4.8 ([b1d5097](https://github.com/salesforcecli/mcp/commit/b1d50973ee26eab27239ad15a882d44e9b992428))

## [0.14.1](https://github.com/salesforcecli/mcp/compare/0.14.0...0.14.1) (2025-07-19)

### Bug Fixes

- **deps:** bump @oclif/core from 4.5.0 to 4.5.1 ([3a5c502](https://github.com/salesforcecli/mcp/commit/3a5c5029488cc68d3e5add9c9926118337a1e016))

# [0.14.0](https://github.com/salesforcecli/mcp/compare/0.13.2...0.14.0) (2025-07-15)

### Features

- Add Tooling API support to `sf-query-org` ([#95](https://github.com/salesforcecli/mcp/issues/95)) ([5b010f0](https://github.com/salesforcecli/mcp/commit/5b010f04c739be29eeafe2cf00ed6df2fc87b879))

## [0.13.2](https://github.com/salesforcecli/mcp/compare/0.13.1...0.13.2) (2025-07-13)

### Bug Fixes

- **deps:** bump @oclif/core from 4.4.1 to 4.5.0 ([6b3195a](https://github.com/salesforcecli/mcp/commit/6b3195a221fd1b56d90fb942bea2b05a31e675ec))

## [0.13.1](https://github.com/salesforcecli/mcp/compare/0.13.0...0.13.1) (2025-07-12)

### Bug Fixes

- **deps:** bump @modelcontextprotocol/sdk from 1.15.0 to 1.15.1 ([a869afe](https://github.com/salesforcecli/mcp/commit/a869afe7069960883abea18846dfa135c3433250))

# [0.13.0](https://github.com/salesforcecli/mcp/compare/0.12.0...0.13.0) (2025-07-08)

### Features

- sf-org-open ([b41d3bb](https://github.com/salesforcecli/mcp/commit/b41d3bbfce42083a8a018f310862372e1eed15a8))

# [0.12.0](https://github.com/salesforcecli/mcp/compare/0.11.4...0.12.0) (2025-07-07)

### Bug Fixes

- add core tools to cache ([0af8c10](https://github.com/salesforcecli/mcp/commit/0af8c10346298267c7640fde95e8f2c5e337600a))
- add tests and fix bugs ([6fded7c](https://github.com/salesforcecli/mcp/commit/6fded7c01123ff8d48cd47ce8d847ac5be90d3de))

### Features

- dynamic toolset discovery ([076512e](https://github.com/salesforcecli/mcp/commit/076512ee00883f174c833cb298530d5f667709fc))
- flat tool discovery ([084ad8f](https://github.com/salesforcecli/mcp/commit/084ad8f70e6d4b6fe6aa99e090e34f7a7a6921dd))
- make Cache thread safe and reorganize ([7e8af99](https://github.com/salesforcecli/mcp/commit/7e8af99417a85d790ed2022b5d47c3239f7f2a34))

## [0.11.4](https://github.com/salesforcecli/mcp/compare/0.11.3...0.11.4) (2025-07-06)

### Bug Fixes

- **deps:** bump @oclif/core from 4.4.0 to 4.4.1 ([44b0b27](https://github.com/salesforcecli/mcp/commit/44b0b277b1f3a24f274c5dbaf05697b24a338f7f))

## [0.11.3](https://github.com/salesforcecli/mcp/compare/0.11.2...0.11.3) (2025-07-05)

### Bug Fixes

- **deps:** bump @salesforce/source-tracking from 7.4.6 to 7.4.7 ([66740f7](https://github.com/salesforcecli/mcp/commit/66740f745dfb690cfd5a38ddce4a981b87b3ef45))

## [0.11.2](https://github.com/salesforcecli/mcp/compare/0.11.1...0.11.2) (2025-07-05)

### Bug Fixes

- **deps:** bump @salesforce/apex-node from 8.1.32 to 8.2.1 ([3c40acb](https://github.com/salesforcecli/mcp/commit/3c40acbce956a6d82b568e8f908b05d45ec451af))

## [0.11.1](https://github.com/salesforcecli/mcp/compare/0.11.0...0.11.1) (2025-07-03)

### Bug Fixes

- thread safe StateAgg ([0b0dc52](https://github.com/salesforcecli/mcp/commit/0b0dc52b60ada207fee7bc2edd8e6ddf4a13f687))
- use thread-safe ConfigAgg.clearInstance ([9970141](https://github.com/salesforcecli/mcp/commit/9970141d52d0472cea963c2beee23d13b00af2c0))

# [0.11.0](https://github.com/salesforcecli/mcp/compare/0.10.2...0.11.0) (2025-07-02)

### Features

- add rate limiting for tool calls ([e412a70](https://github.com/salesforcecli/mcp/commit/e412a70010253a7a3441902e2be4f5828c481a60))

## [0.10.2](https://github.com/salesforcecli/mcp/compare/0.10.1...0.10.2) (2025-06-29)

### Bug Fixes

- **deps:** bump @salesforce/agents from 0.15.2 to 0.15.4 ([2b1e732](https://github.com/salesforcecli/mcp/commit/2b1e732db324cc40bb0d6950fd53be5c7d3cc143))

## [0.10.1](https://github.com/salesforcecli/mcp/compare/0.10.0...0.10.1) (2025-06-28)

### Bug Fixes

- **deps:** bump @salesforce/source-tracking from 7.4.1 to 7.4.6 ([4aa6ea9](https://github.com/salesforcecli/mcp/commit/4aa6ea9493a6c64ae79db736e1e7c1ec75b9f360))

# [0.10.0](https://github.com/salesforcecli/mcp/compare/0.9.1...0.10.0) (2025-06-27)

### Features

- **apex-test:** add async,codecoverage,verbose,resume ([#75](https://github.com/salesforcecli/mcp/issues/75)) ([765f369](https://github.com/salesforcecli/mcp/commit/765f3690b49fe66bc3c680a937da669d94012ea8))

## [0.9.1](https://github.com/salesforcecli/mcp/compare/0.9.0...0.9.1) (2025-06-26)

### Bug Fixes

- don't finish process if no org is found ([bccd261](https://github.com/salesforcecli/mcp/commit/bccd261b6d649b2e39f676d8da98ec8002767199))

# [0.9.0](https://github.com/salesforcecli/mcp/compare/0.8.2...0.9.0) (2025-06-25)

### Features

- add experimental toolset ([69b923e](https://github.com/salesforcecli/mcp/commit/69b923e84970c9c43223bb95d3457451ce87aff4))

## [0.8.2](https://github.com/salesforcecli/mcp/compare/0.8.1...0.8.2) (2025-06-25)

### Bug Fixes

- properly detect absolute paths ([31da000](https://github.com/salesforcecli/mcp/commit/31da000123490d893674cc9317ce497f986f3c67))

## [0.8.1](https://github.com/salesforcecli/mcp/compare/0.8.0...0.8.1) (2025-06-25)

### Bug Fixes

- change apex testing tool name ([1f4d760](https://github.com/salesforcecli/mcp/commit/1f4d76032e3dca654c6e9fd13da69318669b11b7))

# [0.8.0](https://github.com/salesforcecli/mcp/compare/0.7.0...0.8.0) (2025-06-23)

### Features

- **W-18542403:** add tool annotations ([#61](https://github.com/salesforcecli/mcp/issues/61)) ([a0f50bc](https://github.com/salesforcecli/mcp/commit/a0f50bc1716dc8b3ca1f92f8204ba0a030e2bbe5))

# [0.7.0](https://github.com/salesforcecli/mcp/compare/0.6.3...0.7.0) (2025-06-23)

### Features

- add apex/agent testing capabilities to MCP ([c87b802](https://github.com/salesforcecli/mcp/commit/c87b802e038494f4a536ab7a3f5a4f242508b26b))

## [0.6.3](https://github.com/salesforcecli/mcp/compare/0.6.2...0.6.3) (2025-06-22)

### Bug Fixes

- **deps:** bump zod from 3.25.64 to 3.25.67 ([e2e7a42](https://github.com/salesforcecli/mcp/commit/e2e7a42a76972009ef19b95cd7768142180ab4ba))

## [0.6.2](https://github.com/salesforcecli/mcp/compare/0.6.1...0.6.2) (2025-06-22)

### Bug Fixes

- **deps:** bump @jsforce/jsforce-node from 3.8.2 to 3.9.1 ([378d68e](https://github.com/salesforcecli/mcp/commit/378d68e6d62a3a3c683a6efad4ea36d15e081713))

## [0.6.1](https://github.com/salesforcecli/mcp/compare/0.6.0...0.6.1) (2025-06-21)

### Bug Fixes

- **deps:** bump @salesforce/source-deploy-retrieve ([e4cc411](https://github.com/salesforcecli/mcp/commit/e4cc411616c12facc9ce54720fc21d6d544406f3))

# [0.6.0](https://github.com/salesforcecli/mcp/compare/0.5.0...0.6.0) (2025-06-20)

### Bug Fixes

- look for 'timed out' in the error message ([62959b6](https://github.com/salesforcecli/mcp/commit/62959b64abf3c10866ee4cc78e1c9028d872f720))

### Features

- add a tool for resuming long running operations ([b1a1c87](https://github.com/salesforcecli/mcp/commit/b1a1c879788e7dfaa2c82c82d7fbd00ab0d06819))

# [0.5.0](https://github.com/salesforcecli/mcp/compare/0.4.3...0.5.0) (2025-06-16)

### Features

- **W-18724886:** add logging ([#52](https://github.com/salesforcecli/mcp/issues/52)) ([b5dda36](https://github.com/salesforcecli/mcp/commit/b5dda369fd5cbec252bf4e3d6444fde8bf748344))

## [0.4.3](https://github.com/salesforcecli/mcp/compare/0.4.2...0.4.3) (2025-06-15)

### Bug Fixes

- **deps:** bump @salesforce/source-deploy-retrieve ([aae43cd](https://github.com/salesforcecli/mcp/commit/aae43cdcb95f85da6556685c71d29ed5411979d4))

## [0.4.2](https://github.com/salesforcecli/mcp/compare/0.4.1...0.4.2) (2025-06-15)

### Bug Fixes

- **deps:** bump @modelcontextprotocol/sdk from 1.12.1 to 1.12.3 ([f9d75be](https://github.com/salesforcecli/mcp/commit/f9d75be88870a3afe9bd0cfb2a7af1c1b9d55bc4))

## [0.4.1](https://github.com/salesforcecli/mcp/compare/0.4.0...0.4.1) (2025-06-14)

### Bug Fixes

- **deps:** bump zod from 3.25.42 to 3.25.64 ([483cb7a](https://github.com/salesforcecli/mcp/commit/483cb7a7b0076cb916ab35bf6a645028587c9703))

# [0.4.0](https://github.com/salesforcecli/mcp/compare/0.3.0...0.4.0) (2025-06-13)

### Features

- **W-18699160:** add telemetry ([#50](https://github.com/salesforcecli/mcp/issues/50)) ([1ab6dff](https://github.com/salesforcecli/mcp/commit/1ab6dffc75a9235facf9600ed5dbd8c6c393e359))

# [0.3.0](https://github.com/salesforcecli/mcp/compare/0.2.9...0.3.0) (2025-06-09)

### Bug Fixes

- list all orgs with default W-18717116 ([#41](https://github.com/salesforcecli/mcp/issues/41)) ([13f8d9d](https://github.com/salesforcecli/mcp/commit/13f8d9d240b61e51301fafe7adae2bb5ab714c92))
- report version at startup ([e53277a](https://github.com/salesforcecli/mcp/commit/e53277a01df7f0746b6c7574afe225a4480d9885))

### Features

- **W-18707407:** use oclif ([#40](https://github.com/salesforcecli/mcp/issues/40)) ([74ff246](https://github.com/salesforcecli/mcp/commit/74ff246c2e51e4ad535cfbbfcb0bc55aa46e3f16))

## [0.2.9](https://github.com/salesforcecli/mcp/compare/0.2.8...0.2.9) (2025-06-07)

### Bug Fixes

- **deps:** bump @salesforce/source-tracking from 7.3.25 to 7.4.1 ([23963a3](https://github.com/salesforcecli/mcp/commit/23963a3ade374160b2b092d399e1cdc83a5085b9))

## [0.2.8](https://github.com/salesforcecli/mcp/compare/0.2.7...0.2.8) (2025-06-01)

### Bug Fixes

- **deps:** bump @salesforce/core from 8.11.1 to 8.11.4 ([325c217](https://github.com/salesforcecli/mcp/commit/325c217dd5fb7df1aaa970b4572bed19324e2562))

## [0.2.7](https://github.com/salesforcecli/mcp/compare/0.2.6...0.2.7) (2025-05-31)

### Bug Fixes

- **deps:** bump @modelcontextprotocol/sdk from 1.12.0 to 1.12.1 ([f1f013d](https://github.com/salesforcecli/mcp/commit/f1f013d795f31e04983d7b6ed129324f769aa877))

## [0.2.6](https://github.com/salesforcecli/mcp/compare/0.2.5...0.2.6) (2025-05-31)

### Bug Fixes

- **deps:** bump zod from 3.25.28 to 3.25.42 ([84c6d87](https://github.com/salesforcecli/mcp/commit/84c6d87988c5d7674b05c0d24885e5e6a3292160))

## [0.2.5](https://github.com/salesforcecli/mcp/compare/0.2.4...0.2.5) (2025-05-30)

### Bug Fixes

- clean up the orgs section ([b8f2fa2](https://github.com/salesforcecli/mcp/commit/b8f2fa299bedf6763218ef9fec9222af33e5eff9))
- edits ([8206bb2](https://github.com/salesforcecli/mcp/commit/8206bb27edc73033ffb67516d76f19b3a7e35db9))
- first edit of README ([b80771a](https://github.com/salesforcecli/mcp/commit/b80771ac460e0a697f7ae63856f5bde1a279ace8))
- more editing ([4fa5fc8](https://github.com/salesforcecli/mcp/commit/4fa5fc825bdfc9a551b5417008c86655e4d18eb5))
- more edits ([7431210](https://github.com/salesforcecli/mcp/commit/7431210646f9fa8b2ab85fb2547a48fd2b3811bb))
- remove a tool, add info about Cline ([3eeeef7](https://github.com/salesforcecli/mcp/commit/3eeeef711f76779e1c65b951aaecb304e7673f6c))

## [0.2.4](https://github.com/salesforcecli/mcp/compare/0.2.3...0.2.4) (2025-05-30)

### Bug Fixes

- trim spaces ([#33](https://github.com/salesforcecli/mcp/issues/33)) ([faec308](https://github.com/salesforcecli/mcp/commit/faec308b31caf9c5a02a84fad345ee73c323905e))

## [0.2.3](https://github.com/salesforcecli/mcp/compare/0.2.2...0.2.3) (2025-05-30)

### Bug Fixes

- orgs flag ([2550fff](https://github.com/salesforcecli/mcp/commit/2550fff88b82a4bb99e302ae0ce92c5216f71c1b))

## [0.2.2](https://github.com/salesforcecli/mcp/compare/0.2.1...0.2.2) (2025-05-30)

### Bug Fixes

- remove sf-create-record tool ([#29](https://github.com/salesforcecli/mcp/issues/29)) ([9189053](https://github.com/salesforcecli/mcp/commit/9189053a0837bee28fb12487133b57c923959514))

## [0.2.1](https://github.com/salesforcecli/mcp/compare/0.2.0...0.2.1) (2025-05-29)

### Bug Fixes

- auth refactor ([d8e9fc1](https://github.com/salesforcecli/mcp/commit/d8e9fc13327df9f9f0f0e4730f120ab6478cce00))

# [0.2.0](https://github.com/salesforcecli/mcp/compare/0.1.0...0.2.0) (2025-05-29)

### Features

- add `sf-deploy/retrieve-metadata` tools W-18573019 ([#25](https://github.com/salesforcecli/mcp/issues/25)) ([db28795](https://github.com/salesforcecli/mcp/commit/db28795981fd80062f6a03cb7b53069754bbeb58))

# [0.1.0](https://github.com/salesforcecli/mcp/compare/0.0.9...0.1.0) (2025-05-29)

### Bug Fixes

- permset bugs, readme, more tests ([5207ada](https://github.com/salesforcecli/mcp/commit/5207ada2c6c329f0b447a8d3e0dcba4dd7919c48))

### Features

- adds assign permission and suggest username tools ([9470a1d](https://github.com/salesforcecli/mcp/commit/9470a1daf2a3d4a16338dcb196c9abcef86271ce))
- config cache ([bd4fe97](https://github.com/salesforcecli/mcp/commit/bd4fe97d83961fc03f66c5a90f47b14eb672fa05))
- toolsets, directory context, sf-get-username ([a00e332](https://github.com/salesforcecli/mcp/commit/a00e3324490fc59dda619e3a36e6d0118d6beb8f))

## [0.0.9](https://github.com/salesforcecli/mcp/compare/0.0.8...0.0.9) (2025-05-25)

### Bug Fixes

- **deps:** bump zod from 3.24.3 to 3.25.28 ([d0c0f2d](https://github.com/salesforcecli/mcp/commit/d0c0f2dd1ca3741bc9306c7eab2f8a5ddd29c9ff))

## [0.0.8](https://github.com/salesforcecli/mcp/compare/0.0.7...0.0.8) (2025-05-24)

### Bug Fixes

- **deps:** bump @jsforce/jsforce-node from 3.8.1 to 3.8.2 ([4d86942](https://github.com/salesforcecli/mcp/commit/4d86942025aefcb4a4f3f94475bec55c40fd84cb))

## [0.0.7](https://github.com/salesforcecli/mcp/compare/0.0.6...0.0.7) (2025-05-24)

### Bug Fixes

- **deps:** bump @salesforce/source-deploy-retrieve ([08bb6e6](https://github.com/salesforcecli/mcp/commit/08bb6e6c6264e5301c8e32e7632ecbd07bc022a9))

## [0.0.6](https://github.com/salesforcecli/mcp/compare/0.0.5...0.0.6) (2025-05-17)

### Bug Fixes

- **deps:** bump @jsforce/jsforce-node from 3.8.0 to 3.8.1 ([22e2eab](https://github.com/salesforcecli/mcp/commit/22e2eabc3a17fec1e2e809c645778acd31643a17))

## [0.0.5](https://github.com/salesforcecli/mcp/compare/0.0.4...0.0.5) (2025-05-02)

### Bug Fixes

- more tools, org selection, restructuring ([c7bd8d3](https://github.com/salesforcecli/mcp/commit/c7bd8d3eb5ef7c79d4d64dd94fe9d2a391a036fa))
- orgs args ([37a94a0](https://github.com/salesforcecli/mcp/commit/37a94a0c43b96f5ceefc4266440f7dbb952dddeb))
- scripts and server start ([f8c7c86](https://github.com/salesforcecli/mcp/commit/f8c7c86e8f8af9c9aad3f8ba79987ed7e21caaef))

## [0.0.4](https://github.com/salesforcecli/mcp/compare/0.0.3...0.0.4) (2025-04-26)

### Bug Fixes

- **deps:** bump @salesforce/core from 8.9.1 to 8.10.0 ([f460bff](https://github.com/salesforcecli/mcp/commit/f460bff8cba64969ccfa0cf2656cb5140ab05f55))

## [0.0.3](https://github.com/salesforcecli/mcp/compare/0.0.2...0.0.3) (2025-04-25)

### Bug Fixes

- **deps:** bump micromatch from 4.0.4 to 4.0.8 ([f64a166](https://github.com/salesforcecli/mcp/commit/f64a166b6c6a796da5b9adc9288a7f0474dc26e4))

## [0.0.2](https://github.com/salesforcecli/mcp/compare/0.0.1...0.0.2) (2025-04-25)

### Bug Fixes

- **deps:** bump braces from 3.0.2 to 3.0.3 ([7648323](https://github.com/salesforcecli/mcp/commit/764832387a22e5b6fbd08a9a0624048674902e5b))

## [0.0.1](https://github.com/salesforcecli/mcp/compare/b72b9dce44b9c97428574a3ce89043e1030c73f9...0.0.1) (2025-04-24)

### Bug Fixes

- commit for release ([b72b9dc](https://github.com/salesforcecli/mcp/commit/b72b9dce44b9c97428574a3ce89043e1030c73f9))
# SFoA P8-04 (2026-09-06, implementation in progress)

- AMEND-006 authorizes direct Dynamic Forms-aware CREATE implementation with
  default OFF, object-level rollout and lightweight current snapshots. Existing
  Page Layout behavior and post-implementation real UI/Agent accuracy gates remain.

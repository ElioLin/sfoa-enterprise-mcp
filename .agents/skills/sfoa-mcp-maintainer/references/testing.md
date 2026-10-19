# Testing and gates

Select gates from the changed boundary and record actual output. Never claim an unrun or credential-blocked gate passed.

## Maintainer Skill

```text
yarn skill:sync
yarn skill:check
yarn skill:delivery
yarn skill:test
yarn skill:smoke
yarn skill:package
yarn skill:export
yarn skill:runtime:sync  --runtime-root <openclaw workspace>/skills
yarn skill:runtime:check --runtime-root <openclaw workspace>/skills
```

`skill:export` is the one maintainer command here that is a **generator, not a gate**: it renders
the zero-credential AgentSkills distribution package under `out/`, which is Git-ignored and never a
source of truth. Its correctness is covered by `skill:test` (playbook-parser drift, zero-credential
`mcp.json`, byte-identical reruns, and the refusal to clear an unsafe `--output`), so no separate
gate command is needed. It does not touch the runtime, governance or schemas. Regenerate with
`yarn skill:export --endpoint <url>`; full design, output-root guard and removal story live in
`docs/sfoa/SFOA_SKILL_EXPORT_PACKAGE.md`.

`skill:test` is the single entry point for both business Skills: it holds the
`sfoa-crm-core` hard-boundary contract, the `sfoa-record-change` readiness
contract, the per-reference content contracts, the abstract CREATE UAT regression
case, the no-hardcoding and retired-Tool guards, the description bound, and the
runtime-copy allowlist/isolation gate. `skill:runtime:sync` publishes only the
explicit business allowlist in `manage.mjs` and refuses symbolic links,
version-control metadata, credentials and executable scripts; `skill:runtime:check`
compares recursive SHA-256 maps so a drifted runtime copy fails with exit code 1.
A new non-maintainer canonical Skill must be added to that allowlist explicitly, or
`skill:test` fails.

The tests cover canonical structure, sync/drift, portable ZIP, secret masking, SQL read-only guard, missing `.env.local`, DB unavailable, Audit not found/reconstruction, checked-in platform consistency, and Git delivery trackability. `skill:delivery` fails when a required Skill file is missing, Git-ignored, or untracked; `skill:smoke` rebuilds a clean checkout from committed `HEAD` bytes via `git archive` and reruns the Skill gates there, so the evidence comes from committed Git bytes rather than a possibly dirty working tree.

The CLI gates now cover all canonical `skills/*` directories. Multi-Skill tests
verify discovery, independent copies, drift cleanup, per-name ZIP contents,
generic validation failures and delivery for every checked-in Skill. These are
delivery tests, not proof of OpenClaw automatic selection or CRM behavior.
Business-Skill acceptance additionally needs actual Run Skill-read evidence,
positive/negative/explicit prompts and real WeCom UAT; do not label an offline
non-WeCom run as requester-scoped MCP end-to-end evidence.

## Focused workspaces

```text
yarn workspace @sfoa/control-plane lint
yarn workspace @sfoa/control-plane test
yarn workspace @sfoa/control-plane test:mysql
yarn workspace @sfoa/identity-runtime lint
yarn workspace @sfoa/identity-runtime test
yarn workspace @sfoa/mcp-server lint
yarn workspace @sfoa/mcp-server test
yarn workspace @sfoa/mcp-server test:p3
yarn workspace @sfoa/mcp-server test:p4
yarn workspace @sfoa/mcp-server test:p7
yarn workspace @sfoa/admin-api lint
yarn workspace @sfoa/admin-api test
yarn workspace @sfoa/admin-web test
yarn workspace @sfoa/admin-web build
```

## Aggregate and integration

```text
yarn lint
yarn test
yarn build
yarn p5:test
yarn p5:test:runtime:mysql
yarn p5:e2e
yarn p5:e2e:fullstack
yarn validate:p5
yarn workspace @sfoa/mcp-server validate:upstream
```

Root lint is known to reproduce unchanged upstream Code Analyzer debt. `SFOA_CHANGED_CODE_LINT` must still pass; never use upstream debt to waive a new SFoA finding. Windows Yarn Classic and the upstream POSIX `cp` build step have recorded environment debt; report the exact failing command rather than broadly declaring the repository broken.

P8-04 has `node scripts/p8-04-regression.mjs [workspace ...]` for all affected packages,
MySQL, P3/P4/P5/P7 and upstream validation using direct local executables. Keep
process isolation for the MCP server suite: its SIGTERM test conflicts with the
test runner itself under `--test-isolation=none`. Logs are ignored under `.temp`.
The Admin browser gate is `node node_modules/@playwright/test/cli.js test
e2e/p8-effective-ui.spec.ts` from `packages/sfoa-admin-web`; its backend is mocked,
while the Admin HTTP security and MySQL snapshot/payload tests cover those layers
separately. Real New UI/Agent accuracy remains [post-implementation UAT](p8-04-effective-create.md).

Live Salesforce, Inspector, stdio, HTTP, A/B identity, Diagnostic, and mutation gates are required when their boundary changes and credentials are available. Missing external conditions are `NOT TESTED`.

For Console authorization changes, three levels must all move together. The endpoint
table is unit-tested (`packages/sfoa-admin-api/src/test/module-paths.test.ts`): ids in
parity with `ADMIN_MODULE_IDS`, every module reaching at least one endpoint, method
sensitivity, whole-segment matching, unmapped endpoints denied, and no module reaching
outside itself except the enumerated read-only closures. The gate itself is covered in
`http-server.test.ts` against a scoped account, and the Console's behaviour in
`ConsoleModules.test.ts` / `ModuleAccess.test.tsx` (navigation filtered, 403 in place
with no API call for the forbidden module, landing on the first held module). The
real-backend leg is `P5_ADMIN_SCOPED_ACCOUNT_REAL_HTTP=PASS` inside
`scripts/p5-fullstack-e2e.mjs` plus the dual-account test in
`packages/sfoa-admin-web/e2e/admin-fullstack.spec.ts`. A passing browser test alone is
not evidence: the boundary is the Admin API, so a scoped account's direct request to a
module it does not hold must be shown refused.

For request-resource lifecycle changes, automated call-count evidence is mandatory: scope creation and local/protocol methods stay at zero; the first Salesforce operation creates one Connection; repeated/concurrent access in one scope stays at one; two scopes create two isolated Connections; Diagnostic execution creates only its DIAGNOSTIC Connection. Also cover lazy auth/Connection failure taxonomy and unused/failed/aborted cleanup.

## P11-A CI evidence

The tests workflow runs for main-target PRs, main pushes and manual dispatch after
merge. Linux and Windows each install frozen from a clean checkout, build every
workspace and execute the original default workspace tests. Linux also executes
P3/P4/P5/P7, ephemeral MySQL 8.0.30 Control Plane and runtime integration, Admin
browser/fullstack, stdio/upstream compatibility and Skill/Agent drift gates.
Java 11 is retained for upstream analyzer/PMD tests; it is not the MCP Node runtime.

Run yarn test:engineering for build-order/closure/cycle/failure propagation and
CI evidence tests. scripts/ci-run.mjs records actual exit codes and test counts;
--tests requires a positive passed count, --no-skips additionally rejects skipped,
cancelled or todo tests. Required MySQL gates use both; missing DB configuration
cannot turn an all-SKIP exit 0 into PASS. Reports contain bounded redacted output
in .temp/p11a-ci. No retries, continue-on-error, assertion changes or test removal
waive failures. Independent suites still execute after a failed suite if build
succeeded, while the job and final P11-A gate remain failed.

Real Salesforce Org E2E is a separate explicit opt-in workflow requiring the
sfoa-test-org environment. No real Org credentials are used by core CI.
Unrun Org/UAT gates remain NOT_TESTED/NOT_CONFIGURED.

`yarn lock:check` must pass before both cold CI installs. Its exact-selector check catches the workspace-manifest drift that the old URL-only lockfile lint and Classic frozen behavior missed. The 19 engineering tests cover this distinction and real all-skipped/partial-skipped suite rejection.

Analyzer test:e2e exercises the original stdio host against local PMD fixtures and needs no Salesforce credential. Keep it in both cold CI jobs; only DX Core real-Org E2E moves behind the isolated test-org opt-in workflow.

Node 22.23.1 accepts `--experimental-test-isolation=none`, not the later `--test-isolation=none` spelling. Control Plane and Admin API keep their existing none isolation via the compatible spelling (also accepted by Node 24); do not remove tests or change assertions to work around exit 9. MCP host default tests retain their existing process isolation.

P11-A 的 frozen install 后再运行一次标准 Yarn install 并检查 manifest/lock diff 为零，验证传递项也形成完整的 canonical lock；这一步若产生修改必须失败，不能把它作为 CI 自动补锁。

P11-A additionally loads scripts/node-test-lifecycle.mjs only in MCP test processes:
Node 22 exits/cancels a pending test that only awaits an unref deadline, while the
existing runtime intentionally unrefs those deadlines. The test bootstrap keeps
one handle until node:test after(), with native --test-timeout=300000 bounding a
real hang. Three subprocess tests prove assertion execution, nonzero failure and
nonzero timeout. Default MCP process isolation, none mode in validate:p5 and
P8's original concurrency/scopes stay unchanged. Never import this bootstrap in
normal server startup or alter runtime timeout semantics to accommodate tests.

CI fullstack generates and masks its own short-lived MCP_CLIENT_TOKEN in the
fullstack step, keeping internal_bearer authentication enabled. It uses no .env.local
or deployed credentials. Missing test configuration is a CI environment failure;
a stale migration expectation or ambiguous Playwright locator is a frozen test
failure. Record source/fixture provenance and the real nonzero result; P11-A
must not change their assertions or reduce the suites to obtain a green gate.

# Testing and gates

Select gates from the changed boundary and record actual output. Never claim an unrun or credential-blocked gate passed.

Material workflows additionally require actual Adapter hooks, original Office
files, requester/session/task isolation, coverage and expiry tests, plus real
attachment repository CAS/cleanup and timeout dispatcher tests. An optional
CREATE assessment must keep omitted/false output and Salesforce call counts
unchanged; true reuses facts and preserves null/false/0/absence and strict/fallback
managed differences. The maintainer readiness oracle is development-only: page
read-only is not a new FLS denial, hidden API-required survives, and same-name or
shared-phone candidates do not by themselves prove a duplicate business event.
Separate deterministic, real-model, actual-media, trusted-channel and Salesforce
read-back evidence. Six core model journeys need repeated runs; optional original
archiving invitations are counted separately from blocking clarification.

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

Material-workflow real-model runs use the adapter harness `--suite material --repeats 3`.
Record the executed Provider runtime roots separately from before/after guidance:
a shared runtime with synthetic SDK rows is a guidance comparison, not a runtime
or Salesforce end-to-end comparison. Keep all repetitions and semantic failures.
Fixture queries must reject unsupported fields/predicates; selected unset fields
return null. The process runner preserves actual exit code/signal: a complete
terminal result can precede a lingering CLI process, but a partial/error envelope
or a nonzero exit is not success. Use terminalReceipt.runId, never sessionId as runId.
OpenClaw 2026.9.5 also sets `meta.replayInvalid` after potential tool side effects:
retain it as replay-safety evidence, not a standalone current-execution failure.
This distinction never authorizes replaying an actual mutation.

On Windows, a loaded aggregate run can exceed the unchanged HTTP/P7 2s/1s budgets.
An isolated rerun or Linux pass is separate evidence and does not turn the failed
aggregate into a clean full pass. Do not weaken budgets or conflate load diagnosis
with real Salesforce/WeCom validation.

For that load diagnosis, capture workspace creation/cleanup latency and event-loop
delay separately from Tool latency; workspace work is real even when Salesforce is
a fixture. Register Audit writer cleanup before starting load fixtures so a failed
round cannot leave its timer alive. Keep the original failed run and record the
exact concurrency and budgets of each rerun. A later pass bounds reproducibility;
it does not identify the historical scheduler or filesystem culprit by itself.

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

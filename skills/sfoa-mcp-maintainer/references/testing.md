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
yarn skill:runtime:sync  --runtime-root <openclaw workspace>/skills
yarn skill:runtime:check --runtime-root <openclaw workspace>/skills
```

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

For request-resource lifecycle changes, automated call-count evidence is mandatory: scope creation and local/protocol methods stay at zero; the first Salesforce operation creates one Connection; repeated/concurrent access in one scope stays at one; two scopes create two isolated Connections; Diagnostic execution creates only its DIAGNOSTIC Connection. Also cover lazy auth/Connection failure taxonomy and unused/failed/aborted cleanup.

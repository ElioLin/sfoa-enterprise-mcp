# SFoA Project Changelog

This changelog records SFoA baseline and architecture changes. Salesforce Upstream release history remains in its original package changelogs and Git history.

## 2026-08-22 — P2 remote runtime and Tool governance authorized

### Phase transition

- Maintainer review accepted `P1 = PASS / COMPLETE` and authorized P2.
- The accepted P1 branch was rerun through build, 22/22 tests, strict lint, and live two-user validation, then fast-forwarded without squashing to `main` at `3d35ef6` and pushed.
- P2 development began from updated `main` on `feature/p2-remote-runtime-governance`; P3 remains prohibited pending the complete P2 Gate and maintainer review.

### Baseline decisions

- P2 adds a separate SFoA-owned production Streamable HTTP host; `@sfoa/identity-runtime` remains the request-scoped identity foundation and its P1 test host is not promoted unchanged.
- `platformUserId` remains the sole business identity authority after minimal internal Bearer client authentication.
- Tool governance is registration-time and default-deny. P2 remains read-only; mutation, admin, local-development, and unknown Tools are forbidden.
- P2 remains database-, Redis-, token-cache-, connection-pool-, Salesforce-CLI-runtime-, DML-, and Admin-UI-free.
- Baseline advanced to `P2-BL-1.0`; `P2 = IN PROGRESS`.

## 2026-08-22 — P1 request-scoped identity routing completed

### Added

- Private SFoA-owned `@sfoa/identity-runtime` workspace with immutable request context, `IdentityRepository`/in-memory implementation, resolver, fresh-JWT Connection factory, request-scoped OrgService/Services, official dx-core Provider composition, bounded request workspaces, CWD execution guard, stateless Streamable HTTP host, structured redacted logs, and stable error codes.
- Twenty-two unit/integration tests and one repeatable `validate:p1` live harness.
- Chinese `P1_USER_TEST.md` and `P1_FINAL_REPORT.md`.

### Verification

- `SECOND_TEST_USER` is now explicitly consumed and mapped to the B route; both real users passed fresh JWT and `Connection.identity()`.
- Official `get_username` and `run_soql_query` passed for A and B.
- A→B and B→A forged usernames, unknown routes, and missing platform identity were blocked before unintended Salesforce access.
- Twenty interleaved requests completed with zero identity mismatch, cross-user leak, or Connection reuse.
- Two concurrent official metadata requests serialized through the CWD guard, used distinct cleaned workspaces, and restored CWD.
- P1 build, 22/22 tests, strict lint, root build/full tests, original stdio, P0 HTTP, and P0 live runtime regressions passed.
- Salesforce CLI used by P1 runtime: NO. Database/Redis/cache/pool used: NO. Official Salesforce TypeScript changes: 0.
- Root lint continues to reproduce 47 unchanged official code-analyzer errors as `KNOWN UPSTREAM DEBT`; no new SFoA lint error exists.

### Result

`P1 = PASS / COMPLETE — AWAITING MAINTAINER REVIEW`. Baseline advanced to `P1-BL-1.1`. P2 was not started.

## 2026-08-22 — P1 request-scoped identity routing authorized

### Phase transition

- Maintainer review accepted `P0 = PASS` and authorized P1.
- P0 Closure commits `32469cd`, `d90163f`, and `e80d9fd` were fast-forwarded to `main` and pushed without squashing.
- P1 development began on `feature/p1-request-scoped-identity`; P2 remains prohibited pending the P1 Gate and maintainer review.

### Baseline decisions

- P1 uses an `IdentityRepository` interface plus an in-memory two-user mapping; no database, ORM, Redis, token cache, or connection pool is introduced.
- `platformUserId` is the only identity authority. Official Tool `usernameOrAlias` values are non-authoritative and must match the resolved request route.
- The maintainer had supplied `SECOND_TEST_USER`, but the P0-Closure loader did not consume it. Historical P0 execution remains unchanged; real second-user execution is mandatory in P1.
- Request and connection contracts reserve `ConnectionRole = USER | DIAGNOSTIC`. P1 implements only business-user `USER`; the fixed diagnostic user is deferred to P4 and is barred from business data operations.

## 2026-08-22 — P0-Closure live Gates completed

### Verification

- Fresh SFoA JWT through direct `@salesforce/core` Bearer authentication: PASS.
- Salesforce identity matched the configured username; direct Connection: PASS.
- Direct SOQL against the configured `Lead` object: 5 rows, PASS.
- Official `run_soql_query`: 5 rows, PASS.
- Official `retrieve_metadata` for the configured `CustomObject`: 135 retrieved files, PASS.
- Temporary Workspace lifecycle and Harness CWD restoration: PASS; official Tool CWD side effect remains documented.
- Stable Salesforce CLI v2 JWT login, org display, and read-only query: PASS.

### Result

`P0 = PASS`. No User Id, Org Id, token, or Salesforce record content was committed. The second-user isolation Gate remains P1, and P1 has not started.

## 2026-08-22 — P0-Closure Harness implementation

### Added

- Private `@sfoa/runtime-validation` workspace for fresh JWT, direct `@salesforce/core` identity/SOQL, official `run_soql_query`, official `retrieve_metadata`, temporary DX workspace, CWD observation/restoration, and console-only token diagnostics.
- Nine unit/integration tests covering configuration, redaction/token description, official Provider Tool registration/execution, and bounded temporary-workspace cleanup.
- `PROVIDER_COMPATIBILITY.md`, `P0_CLOSURE_USER_TEST.md`, and `P0_CLOSURE_REPORT.md`.
- Complete Closure variable names in `.env.example`; `.env.local`, private keys, and temporary Closure artifacts remain ignored.

### Environment and architecture

- Removed the stale missing `@salesforce/sfdx-scanner` plugin record using Salesforce CLI itself.
- Updated persistent user PATH to prefer the stable Salesforce CLI v2 shim; a newly opened terminal is required because the active Codex process retains its prior PATH snapshot.
- Declared Salesforce CLI diagnostic-only and fixed the production chain as direct JWT/OAuth through `@salesforce/core` and official Providers.
- Declared P0/P0-Closure database-free. P1 will begin behind an `IdentityRepository` interface and may use a memory/local test mapping before persistence is justified.
- Recorded the exact packaged stdio dx-core 0.9.8 and SFoA extension dx-core 0.10.0 version baselines; no package version was upgraded.

### Verification

- Closure Harness build PASS, unit tests 9/9 PASS, and strict TypeScript lint PASS.
- Original stdio initialize/list/call regression PASS against five selected Tools.
- Streamable HTTP initialize/list/call, 405, Origin rejection, and cleanup regression PASS (1/1).
- Reproduced 47 unchanged code-analyzer lint errors and normalized them as `UPSTREAM_LINT_BASELINE = KNOWN UPSTREAM DEBT`; `SFOA_CHANGED_CODE_LINT = PASS`.
- Repeated frozen Yarn install attempts still fail at a Yarn Classic Windows nested `brace-expansion` link; lockfile unchanged and targeted Closure Gates pass.

### Pending live inputs

- `.env.local` is absent. Fresh JWT, token/identity, Direct SOQL, official SOQL, official Metadata, and live CWD evidence remain `NOT TESTED`; P0 remains `PARTIAL PASS`.
- The second-user isolation Gate is assigned to P1 and is not required to close P0.

## 2026-08-22 — P0 baseline initialization

### Added

- Full official `salesforcecli/mcp` Git history with official remote named `upstream`.
- Associated the company GitHub repository as `origin` and prepared `main` to track `origin/main`.
- Environment baseline and Node/Yarn decision evidence.
- Project baseline, phase plan, Gate policy, architecture audit, MCP engineering rules, Upstream strategy, test matrix, and ADR directory.
- Root AI-agent contribution rules.
- Empty secret-safe `.env.example`.
- Private `@sfoa/streamable-http-poc` workspace composed only from public official Provider contracts.
- Original stdio Tool-schema, protocol, CLI, and HTTP POC evidence under `docs/sfoa/evidence`.
- ADR-0004 accepting Streamable HTTP by composition while retaining stdio.

### Environment

- Retained Node v24.13.0 because it satisfies Upstream current-LTS and `>=20` policy.
- Activated Yarn Classic 1.22.22 through existing Corepack.
- Did not install React, TypeScript, Vite, Ant Design, TanStack Query, React Router, Docker, Redis, or database clients globally or for P0.
- Recorded Salesforce CLI legacy PATH/stale-plugin issue and the usable direct v2.148.3 installation.

### Architecture

- Confirmed official Salesforce Tools use `@salesforce/core` and official Node SDKs rather than spawning `sf`.
- Confirmed official host authorization and Tool state are process-scoped.
- Identified `process.chdir(directory)` as the primary concurrent-HTTP safety constraint.
- Classified identity/auth as middleware/shared services and future DML as a Provider plus allowlist service.
- Recorded `retrieve_metadata` hard dependency on a writable DX project/workspace.
- Selected full-history **FULL FORK + EXTENSION** with zero official TypeScript patches.
- Classified the official Providers/Tools as reusable while the unchanged process-scoped host is only a partial production runtime base.

### Verification

- Clean Yarn install PASS; lockfile unchanged.
- Git Bash root build PASS; default PowerShell/cmd build exposes the official POSIX `cp` dependency.
- Final full workspace tests PASS, including Streamable HTTP initialize/list/call.
- Original stdio initialize, Tool list, and `get_username` call PASS through project-local Inspector.
- Root lint FAIL on 47 existing code-analyzer findings; official server, dx-core, and SFoA POC lint individually PASS.
- CLI and original MCP SOQL both reached the configured local SFoA authorization but failed because its refresh session is expired.

### Security

- Added ignore rules for local env files, JWT key formats, secrets directories, and Firecrawl cache.
- Kept all observed tokens and private-key material out of project files.

### Deferred / blocked by external inputs

- Run fresh SFoA JWT, successful SOQL, controlled metadata-component retrieval, and optional second-user Gates when inputs are supplied.
- Resolve or accept the existing Upstream code-analyzer lint baseline outside the P0 extension scope.

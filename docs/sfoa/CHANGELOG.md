# SFoA Project Changelog

This changelog records SFoA baseline and architecture changes. Salesforce Upstream release history remains in its original package changelogs and Git history.

## 2026-08-22 — P0-Closure runtime validation preparation

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

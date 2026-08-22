# P0 / P1 / P2 / P3 Gate Matrix

Allowed results: `PASS`, `PARTIAL`, `FAIL`, `NOT TESTED`, `KNOWN UPSTREAM DEBT`.

| Gate | Result | Evidence |
| --- | --- | --- |
| Git Runtime | PASS | `git version 2.50.0.windows.2`; executable resolved under `D:\Git` |
| Node Runtime | PASS | `node -v` and direct runtime expression both returned v24.13.0; Upstream requires current LTS / `>=20` |
| npm Runtime | PASS | `npm -v` returned 11.6.2 |
| Yarn Runtime | PASS | Corepack-activated Yarn 1.22.22; `yarn --version` passed; lockfile is Yarn v1 |
| Salesforce CLI | PASS | Stable v2.148.3 invocation, plugin cleanup, JWT login, org display, and read-only query pass; this already-open process still inherits the legacy 1.86.7 PATH snapshot until terminal restart |
| Upstream Clone | PASS | Full clone; `upstream` points to official URL; `origin` points to the supplied GitHub repository; HEAD `670234db...` |
| yarn install | PARTIAL | Original P0 clean install exited 0 in 1499.30 s; Closure frozen reinstall now reproducibly fails during Yarn Classic Windows linking at nested `brace-expansion`; lockfile unchanged and targeted Closure workspaces remain testable |
| yarn build | PASS | Git Bash `yarn build` exited 0 for every official workspace and the POC in 44.24 s; default PowerShell/cmd first failed because an official script requires POSIX `cp` |
| yarn test | PASS | Final worktree run exited 0 in 263.41 s; all official tests and the hardened POC integration test passed |
| yarn lint / Upstream baseline | KNOWN UPSTREAM DEBT | Direct reproduction reports 47 existing code-analyzer errors and 0 warnings; no SFoA-owned file is affected |
| SFoA JWT Auth | PASS | Closure Harness direct `AuthInfo.create({ oauth2Options })` completed fresh JWT Bearer authentication; token output was masked |
| SF CLI Query | PASS | Stable v2 CLI JWT login, org display, and `SELECT Id FROM Lead LIMIT 5` returned 5 rows |
| DX MCP initialize | PASS | Project-local Inspector connected to the original stdio server and completed protocol initialization |
| DX MCP tools/list | PASS | Original server returned 5 `core,data,metadata` Tool schemas; full result is `evidence/dx-mcp-tools-list.json` |
| run_soql_query | PASS | Closure Harness called the official `DxCoreMcpProvider` Tool with the fresh direct Connection and returned 5 rows |
| retrieve_metadata | PASS | Official Tool retrieved the configured `CustomObject` component in a disposable DX Workspace and produced 135 files |
| Multiple Users | NOT TESTED | Maintainer supplied `SECOND_TEST_USER`, but the historical P0-Closure loader did not consume it; no second-user operation occurred in P0. The mandatory execution was completed in P1. |
| Auth Architecture Audit | PASS | Source path documented in `ARCHITECTURE.md`: startup Cache -> AuthInfo list/filter -> AuthInfo -> Connection -> Tool |
| Streamable HTTP | PASS | Final Closure regression: official SDK Client passed initialize, `tools/list`, `tools/call get_username`, HTTP 405, untrusted-Origin 403, and cleanup assertions (1/1 test) |
| MCP Inspector | PASS | Project-local Inspector (no global install) listed schemas and called `get_username` (`isError=false`); live official SOQL was validated by the Closure Harness |

## Supplemental architecture checks

| Check | Result | Evidence |
| --- | --- | --- |
| Salesforce Tool call mode | PASS | dx-core uses `@salesforce/core`/official Node SDKs; no `sf` child process in Tool runtime |
| Provider API seam | PASS | `Services.getOrgService().getConnection(username)` is injectable into Provider Tool instances |
| Request-scoped readiness | PARTIAL | Seam exists, but official host Cache/Services/Tools are process-scoped and Tools mutate process CWD |
| Metadata workspace independence | FAIL | `retrieve_metadata` resolves `SfProject`, uses SourceTracking/SDR, and writes into the project package directory |
| stdio preservation | PASS | Official entry uses `StdioServerTransport`; no change is planned to remove it |

## P0-Closure Gate Matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| Fresh SFoA JWT | PASS | Closure Harness completed direct JWT Bearer authentication through `@salesforce/core`; token output was masked |
| Direct Connection | PASS | `Connection.create` and `Connection.identity()` completed successfully |
| Identity Match | PASS | Returned Salesforce username matched configured `SALESFORCE_USERNAME`; identifiers are not persisted |
| Token Acquisition | PASS | Non-empty opaque token was usable for identity and both SOQL paths; expiration was not provided by Salesforce |
| Direct SOQL | PASS | `SELECT Id FROM Lead LIMIT 5` returned 5 rows |
| Official `run_soql_query` | PASS | Official `DxCoreMcpProvider` Tool returned 5 rows using the same authenticated Connection |
| Temporary Metadata Workspace | PASS | Unit test creates minimal `sfdx-project.json`, manifest, source tree, counts files, and performs bounded cleanup |
| Official `retrieve_metadata` | PASS | Official Tool retrieved the configured `CustomObject` component in the temporary DX Workspace and produced 135 files |
| CWD Restore | PASS | Official Tool did not restore CWD; Harness observed the side effect and restored the original directory in `finally` |
| stdio Regression | PASS | Original `packages/mcp/bin/run.js` completed initialize, listed 5 Tools, and called official `get_username`; response content withheld |
| Streamable HTTP Regression | PASS | Existing POC passed initialize/list/call, 405, Origin rejection, and resource cleanup (1/1) |
| Upstream Lint Baseline | KNOWN UPSTREAM DEBT | Unchanged code-analyzer baseline reproduced at 47 errors, 0 warnings |
| SFoA Changed Code Lint | PASS | `@sfoa/runtime-validation` and `@sfoa/streamable-http-poc` strict TypeScript lint commands exited 0 |
| Provider Compatibility | PASS | Exact stdio 0.9.8 and extension 0.10.0 dx-core baselines are recorded; Provider registration/unit and both transport regressions pass |
| User Validation Harness | PASS | Build succeeds, 9/9 tests pass, missing-config output names all required values, errors are redacted, and live results are never persisted |

## P1 Request-Scoped Identity Gate Matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| User A Route | PASS | `p1-user-a` resolved only to the configured `SALESFORCE_USERNAME` route |
| User B Route | PASS | `p1-user-b` resolved only to the now-consumed `SECOND_TEST_USER` route |
| JWT A | PASS | Fresh direct `@salesforce/core` JWT/AuthInfo/Connection creation succeeded |
| JWT B | PASS | Fresh direct `@salesforce/core` JWT/AuthInfo/Connection creation succeeded |
| Identity A | PASS | `Connection.identity()` matched route A |
| Identity B | PASS | `Connection.identity()` matched route B |
| HTTP initialize | PASS | Official SDK Client initialized against stateless `POST /mcp` with request Header context |
| HTTP tools/list | PASS | Exactly `get_username`, `run_soql_query`, and `retrieve_metadata` were registered from a fresh official dx-core Provider |
| Official `get_username` A | PASS | Official Tool returned the route-A Salesforce username; response value was not persisted |
| Official `get_username` B | PASS | Official Tool returned the route-B Salesforce username; response value was not persisted |
| Official `run_soql_query` A | PASS | Safe `SELECT Id FROM <TEST_OBJECT> LIMIT 5` completed through route A |
| Official `run_soql_query` B | PASS | Safe `SELECT Id FROM <TEST_OBJECT> LIMIT 5` completed through route B |
| A → B Forgery | BLOCKED | `MCP_IDENTITY_CONTEXT_MISMATCH`; no B JWT/Connection was created for the forged call |
| B → A Forgery | BLOCKED | `MCP_IDENTITY_CONTEXT_MISMATCH`; no A JWT/Connection was created for the forged call |
| Arbitrary/alias mismatch | BLOCKED | Unit/integration adapter tests reject values outside the one resolved route |
| Unknown Route | BLOCKED | HTTP 403 / `MCP_IDENTITY_ROUTE_NOT_FOUND`; no JWT, Salesforce API, or Tool execution |
| Missing Platform User | BLOCKED | HTTP 401 / `MCP_PLATFORM_USER_REQUIRED`; blank/whitespace inputs also deny without fallback |
| Invalid Identity/Error Redaction | PASS | Authentication failure abstraction and config-path regression return stable errors without key path, token, assertion, or client secret |
| Concurrent A/B | PASS | 20 interleaved real requests; every request used a fresh request scope and Connection |
| Identity Mismatch | PASS (`0`) | Connection identity audit reported zero mismatches |
| Cross User Leak | PASS (`0`) | Official Tool results reported zero cross-route identities |
| Unknown Connection Reuse | PASS (`0`) | All 20 concurrent Connection objects were distinct |
| Metadata CWD Guard | PASS | Two concurrent official metadata calls used exclusive execution (`maxConcurrentExclusive = 1`) and restored CWD |
| Workspace Isolation | PASS | Two distinct request DX workspaces/manifests; both cleaned, no cross-workspace path allowed |
| Request Cleanup | PASS | Created workspace count equaled cleaned count; active count returned to zero after HTTP responses |
| CLI Runtime Dependency | PASS (`NONE`) | Static production-source test and live report: no `sf`, child process, CLI Auth Cache, or `sf org login` dependency |
| Database Dependency | PASS (`NONE`) | In-memory repository only; no SQL/ORM/Redis dependency or runtime use |
| Token/Connection Cache | PASS (`NONE`) | Fresh Connection per scope; live `Connection Reuse = 0` |
| `ConnectionRole` Boundary | PASS | `USER | DIAGNOSTIC` is reserved; P1 rejects DIAGNOSTIC before authentication and implements only USER |
| P1 Build | PASS | `yarn workspace @sfoa/identity-runtime build` exited 0 under strict TypeScript |
| P1 Tests | PASS | 22/22 unit and integration tests passed |
| SFoA Changed Code Lint | PASS | `@sfoa/identity-runtime`, P0 runtime validation, and P0 HTTP POC strict lint commands exited 0 |
| Root Build | PASS | All workspaces built using repository-local dependencies and Git Bash for the official POSIX `cp` script |
| Root Tests | PASS | `yarn test` completed all workspaces in 306.46 s after restoring Yarn-generated local shims removed by the known failed Windows reinstall; no source/lockfile change |
| Upstream Lint Baseline | KNOWN UPSTREAM DEBT | Root lint stops at the same 47 official code-analyzer errors; no SFoA file is included |
| Original stdio Regression | PASS | initialize, five-Tool list, and official `get_username` call passed; response content withheld |
| P0 Streamable HTTP Regression | PASS | 1/1 initialize/list/call, method/origin, and cleanup test passed |
| P0 Runtime Regression | PASS | 9/9 local tests and live JWT/identity/SOQL/official metadata Closure validation passed |
| Official Salesforce TypeScript Modified | PASS (`0`) | P1 diff contains no existing official package TypeScript path |
| Salesforce CLI Used by P1 | PASS (`NO`) | Live P1 report and static checks agree |
| Database Used by P1 | PASS (`NO`) | Live P1 report and dependency/source checks agree |

P1 dependency versions remain the verified set: MCP SDK 1.18.2, Provider API 0.6.0, dx-core 0.10.0, `@salesforce/core` 8.29.0, Node 24.13.0, and Yarn 1.22.22. No dependency upgrade was performed.

## P2 Remote Runtime and Tool Governance Gate Matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| Formal Remote Host | PASS | New `@sfoa/mcp-server`; stateless SDK Streamable HTTP `POST /mcp`, separate from P1 test Host |
| Network Binding | PASS | Defaults 127.0.0.1:8080 `/mcp`; config parser supports explicit host/port/path and requires exact allowed Host away from loopback |
| Health / Readiness | PASS | `/health` and `/ready` return `{"status":"UP"}` without JWT/Salesforce; provider/policy startup initialized before ready |
| Client Bearer Auth | PASS | SHA-256 digest + timing-safe comparison; missing/wrong token return stable 401 codes without secret echo |
| Disabled Auth Boundary | PASS | `MCP_AUTH_MODE=disabled` accepted only for 127.0.0.1/localhost/::1; non-loopback startup fails |
| Host / Origin Boundary | PASS | Exact rejection occurs before Connection; non-browser absent Origin remains valid |
| Platform User Contract | PASS | Only authenticated configured Header enters P1 resolver; body/query/Tool identity fields are non-authoritative |
| Auth Negative Matrix | PASS | no Bearer BLOCKED; wrong Bearer BLOCKED; no platform user BLOCKED; unknown route BLOCKED; all before unintended JWT |
| Tool Default Deny | PASS | Default `tools/list` exactly `get_username`, `run_soql_query`; disabled `retrieve_metadata`/`deploy_metadata` invisible |
| Startup Governance | PASS | unknown Tool -> `MCP_TOOL_NOT_AVAILABLE`; mutation/admin such as `deploy_metadata` -> `MCP_TOOL_DISABLED` |
| Tool Classification | PASS | Explicit READ/METADATA_READ/MUTATION/ADMIN/LOCAL_DEV/UNKNOWN catalog; no runtime name inference |
| `retrieve_metadata` Decision | PASS | Official reuse retained as available facade; disabled by default due DX project/manifest/source/filesystem/CWD contract |
| Mutation/Admin Boundary | PASS | P2 runtime/dependency/static tests expose no DML/deploy/admin Tool; forbidden classifications fail startup |
| Remote Schema Facade | PASS | `usernameOrAlias`, `directory`, `platformUserId` absent from SOQL remote schema; host injects route/workspace |
| Official Tool Delegation | PASS | Real official `get_username` and `run_soql_query` passed for A/B via unchanged `Tool.exec()` |
| A -> B / B -> A Body Forgery | BLOCKED | Extra platform/username/directory arguments were stripped; Connection records remained on Header route |
| Request Body Limit | PASS | Content-Length/streamed size > limit returns HTTP 413 / `MCP_REQUEST_TOO_LARGE` before Connection |
| Request Timeout | PASS | HTTP 504 / `MCP_REQUEST_TIMEOUT`, workspace cleanup, zero cleanup failures |
| Tool Timeout | PASS | Tool-level `isError: true` / `MCP_TOOL_TIMEOUT`, workspace cleanup; no false remote-cancellation claim |
| Response Lifecycle Cleanup | PASS | Host waits for response finish/close; concurrent test no premature empty response and created=cleaned |
| Graceful Shutdown | PASS | Direct drain test waits for in-flight Tool; SIGTERM test stops listening and logs STARTED -> DRAINED without `process.exit()` |
| User A | PASS | Real JWT/identity, initialize, official get_username and SOQL |
| User B | PASS | Real JWT/identity, initialize, official get_username and SOQL |
| 50-request A/B Load | PASS | 50 requests in five interleaved batches; identity mismatch 0, cross-user leak 0, workspace leak 0, cleanup failure 0, Connection reuse 0, errors 0 |
| 50-request Latency | PASS | n=50, p50 1048.34 ms, p95 1147.25 ms |
| Initialize Latency | PASS | n=4, p50 1354.90 ms, p95 1673.39 ms |
| tools/list Latency | PASS | n=4, p50 626.00 ms, p95 853.42 ms |
| get_username Latency | PASS | n=52, p50 1042.83 ms, p95 1147.25 ms |
| SOQL Latency | PASS | n=4, p50 952.72 ms, p95 1075.28 ms |
| JWT/Connection Latency | PASS | n=72, p50 872.98 ms, p95 1083.08 ms; no cache implemented |
| Official SDK Client | PASS | initialize/list/call A/B and 50 calls through SDK 1.18.2 |
| MCP Inspector | PASS | Project-local Inspector 0.15.0 proxy initialize, enabled-only list, get_username call for A and B |
| P2 Build | PASS | strict TypeScript build exited 0 |
| P2 Tests | PASS | 18/18 unit/integration tests, including HOTFIX01 inventory and contract drift cases |
| P2 Strict Lint | PASS | `@sfoa/mcp-server` `tsc --noEmit` exited 0 after final source changes |
| P1 Regression | PASS | 22/22, strict lint, live A/B identity/SOQL, 20 requests, metadata/CWD/workspace cleanup |
| P0 Runtime Regression | PASS | 9/9 and live Closure JWT/identity/direct+official SOQL/CustomObject metadata/CWD PASS |
| P0 HTTP POC Regression | PASS | 1/1 initialize/list/call PASS |
| Original stdio Regression | PASS | initialize, five-Tool list, official get_username call; response content withheld |
| Root Build | PASS | Git Bash `yarn build`, 94.94 s; all workspaces including P2 |
| Root Tests | PASS | `yarn test`, 325.05 s; all official and SFoA workspaces exited 0 |
| Upstream Lint Baseline | KNOWN UPSTREAM DEBT | Exactly 47 errors / 0 warnings, all under unchanged official code-analyzer; no SFoA path |
| SFoA Changed-Code Lint | PASS | P2, P1, P0 runtime and HTTP POC strict gates exited 0 |
| Dependency Install | KNOWN WINDOWS/YARN DEBT | Frozen Yarn Classic link failed at existing nested `brace-expansion`; lockfile unchanged; generated `.bin` shims were mechanically restored from installed package manifests before successful root/stdin regressions |
| Salesforce CLI Runtime | PASS (`NONE`) | Static dependencies/source and live reports; production uses direct `@salesforce/core` JWT |
| Database / Redis | PASS (`NONE`) | P1 in-memory repository only; no database/ORM/Redis package/runtime |
| Token Cache / Connection Pool | PASS (`NONE`) | 72 measured fresh creations; zero Connection reuse |
| Official Salesforce TypeScript Modified | PASS (`0`) | Diff from P1-accepted `main` contains no non-SFoA TypeScript path |
| Root Manifest / Lockfile Modified | PASS (`0`) | `package.json` and `yarn.lock` unchanged; exact accepted versions retained |

P2 version set: MCP SDK 1.18.2, Provider API 0.6.0, dx-core 0.10.0, `@salesforce/core` 8.29.0, Zod 3.25.76, Node 24.13.0, Yarn 1.22.22. No dependency upgrade was performed.

## P2 Closure HOTFIX01 Gate Matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| Actual official inventory exact match | PASS | Real public `DxCoreMcpProvider`; Provider API 0.6.0; dx-core 0.10.0; nine GA names; zero drift |
| Unknown official Tool | PASS | Simulated `future_unknown_tool` produces `UPSTREAM_REVIEW_REQUIRED`; it receives no classification and is absent from list/call |
| Enabled Tool added field | PASS | Simulated `run_soql_query.targetOrg` fails startup with `MCP_UPSTREAM_TOOL_CONTRACT_DRIFT` before schema registration |
| Host-owned field removed/renamed | PASS | Missing `usernameOrAlias` is rejected by the exact remote contract |
| Agent field removed/renamed | PASS | Missing `query` is rejected by the exact remote contract |
| Required/optional contract changed | PASS | `useToolingApi` changing from optional to required is rejected |
| ReleaseState changed | PASS | Audited GA Tool changing to NON_GA is rejected |
| Classification remains explicit | PASS | Unknown Tool annotations, description, and name cannot produce READ classification |
| Existing remote schemas | PASS | `get_username` excludes `directory`; SOQL exposes only `query`/`useToolingApi`; `retrieve_metadata` remains disabled by default |
| Identity forgery regression | PASS | Agent `usernameOrAlias`, `directory`, `platformUserId`, and Salesforce username inputs do not change the Header-authoritative route |
| Existing P2 security regression | PASS | Bearer, Host, Origin, body limit, request/Tool timeout, cleanup, and graceful shutdown tests passed |
| P2 package tests | PASS | 18/18, 33.18 s Node test duration; command exited 0 |
| P2 strict lint | PASS | Final `tsc --noEmit` exited 0 |
| Upstream compatibility command | PASS | `validate:upstream` returned `PASS` with `drift: []` |
| P1 regression | PASS | 22/22 plus real A/B validation, identity isolation, metadata/CWD/workspace cleanup |
| P0 runtime regression | PASS | 9/9 plus live JWT, identity, direct/official SOQL, metadata, and CWD restoration |
| P0 HTTP regression | PASS | 1/1 initialize/list/call and transport/security checks |
| P2 live validation | PASS | Real A/B official calls and 50 interleaved requests; zero mismatch, leak, reuse, cleanup failure, or error |
| Original Salesforce stdio | PASS | initialize, five-Tool list, and official `get_username` call |
| Streamable HTTP SDK/Inspector | PASS | initialize/list/call for A/B with project-local SDK client and Inspector 0.15.0 |
| Root build | PASS | All workspaces built in 94.94 s |
| Root tests | PASS | All workspaces passed in 325.05 s |
| SFoA changed-code lint | PASS | P2, P1, P0 runtime, and P0 HTTP strict checks exited 0 |
| Root lint | KNOWN UPSTREAM DEBT | Exactly 47 errors / 0 warnings in unchanged official code-analyzer; no SFoA error |
| Official Salesforce TypeScript diff | PASS | Zero modified official TypeScript files |
| Root manifest / lockfile diff | PASS | Root `package.json` and `yarn.lock` unchanged |
| P3 scope boundary | PASS | No DML, database, Redis, cache, pool, OAuth Server, Admin UI, or P3 capability was added |

## Result interpretation

- Credential/environment failures are not evidence that SFoA APIs are incompatible.
- A Gate remains `NOT TESTED` when a required external input is absent and no meaningful operation can be attempted.
- A protocol call returning an expected Tool-level `isError` can prove `tools/call` transport behavior, but not the Salesforce operation Gate.
- `KNOWN UPSTREAM DEBT` applies only to a reproduced unchanged Upstream finding. It never permits a new SFoA lint error.
- Final P0 status is set only after all mandatory live and locally runnable Gates complete.

## P0 overall result

`P0 = PASS`

All mandatory P0 live and local Gates are complete. The second Salesforce user was intentionally assigned to P1 and has now been exercised there; the reproduced Upstream lint debt plus Windows Yarn frozen-reinstall issue remain documented non-SFoA maintenance debt rather than live compatibility failures.

## P1 overall result

`P1 = PASS`

Both real users, all required official Tool paths, bidirectional forgery denial, unknown/missing denial, 20-request zero-leak isolation, concurrent metadata/CWD/workspace isolation, request cleanup, production no-CLI/no-database constraints, and required regressions passed. P1 is maintainer accepted.

## P3 Entry Gate Matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| P2 branch clean | PASS | Pre-merge `git status --short --branch` showed no worktree changes |
| P2 latest commit pushed | PASS | Local and remote P2 both resolved to `f532c8a95ce511f8f30af7dc87c56b883c360542` after `git fetch origin --prune` |
| P2 upstream compatibility | PASS | Fresh `validate:upstream`: dx-core 0.10.0, Provider API 0.6.0, nine GA Tools, `drift: []` |
| P2 targeted regression | PASS | Fresh P2 test run: 18/18 passed, 0 failed |
| P2 to main integration | PASS | `main` fast-forwarded from `3d35ef6` to `f532c8a` without squash and was pushed to `origin/main` |
| P3 branch isolation | PASS | `feature/p3-generic-dml-allowlist` created from updated `main` at `f532c8a` |
| P3-00 official capability audit | PASS | ADR-0008: actual pinned Provider/public exports/history, Hosted MCP endpoint/auth/SFoA boundary, and pinned Connection/SObject public types reviewed before implementation |
| P3 CREATE/UPDATE runtime | NOT TESTED | No P3 production implementation existed at phase entry |
| P3 live Salesforce mutation | NOT TESTED | No P3 live mutation was attempted at phase entry |

## P2 overall result

`P2 = PASS / COMPLETE — MAINTAINER ACCEPTED`

All mandatory P2 runtime, authentication, identity, governance, schema, request-bound, timeout/cleanup, graceful-shutdown, real A/B, 50-request, Inspector, official Tool, no-CLI/no-database/no-cache, zero-official-code-change, build/test/lint, P0/P1 regression, and HOTFIX01 upstream drift Gates passed. Maintainer review accepted P2 and authorized P3.

## P3 overall result

`P3 = IN PROGRESS`

Only the entry Git/Baseline Gates are complete. Implementation, protocol, identity, live Salesforce, cleanup, and regression results remain `NOT TESTED` until actually run.

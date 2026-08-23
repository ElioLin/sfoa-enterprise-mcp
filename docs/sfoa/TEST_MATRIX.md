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

## P3 Completion Gate Matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| Official DX MCP generic CREATE/UPDATE reuse | PASS | Actual dx-core 0.10.0 exports, 13 provided Tools, public Provider API, and history inspected; no current generic mutation Provider/Tool; removed create-only source was not copied |
| Hosted SObject Mutation decision | PASS | ADR-0008: separate hosted endpoint/ECA/OAuth model cannot consume the accepted request Connection; SFoA availability is NOT PROVEN, so P1/P2 were not refactored |
| Official SDK fallback | PASS | Production calls only pinned single-record `connection.sobject(name).create(fields)` and `update({Id,...fields})` |
| No DML configuration | PASS | `undefined`, blank, and whitespace parse to deny-all policy; unit and startup tests deny mutation |
| Empty DML configuration | PASS | `[]` produces deny-all policy and enabled mutation Tool startup fails closed |
| Unknown object | PASS | `MCP_DML_OBJECT_NOT_ALLOWED` before Connection retrieval or SDK mutation |
| CREATE-only object UPDATE | PASS | `MCP_DML_OPERATION_NOT_ALLOWED`; zero Connection/mutation calls |
| UPDATE-only object CREATE | PASS | `MCP_DML_OPERATION_NOT_ALLOWED`; zero Connection/mutation calls |
| Explicitly allowed CREATE | PASS | Unit/HTTP fixtures reached SDK once; live User A CREATE succeeded in SFoA |
| Explicitly allowed UPDATE | PASS | Unit/HTTP fixtures reached SDK once with separate `recordId`; live User A UPDATE succeeded in SFoA |
| DELETE in configuration | PASS | Strict Zod parser returns `MCP_DML_CONFIGURATION_INVALID`; it is never ignored |
| Unknown operation in configuration | PASS | UPSERT/MASS_UPDATE and every non-CREATE/UPDATE value fail configuration |
| Duplicate/unknown configuration | PASS | Duplicate object (case-insensitive), duplicate operation, empty operations, and unknown keys fail closed |
| Tool registration dual gate | PASS | Exact Tool name plus at least one matching configured operation required at startup |
| `tools/list` explicit surface | PASS | P3 live list was exactly `create_record`, `update_record`; default P2 list remains read-only |
| DELETE Tool | PASS | Absent from Provider inventory, Host registration, schemas, live list, and production SDK calls |
| UPSERT/UNDELETE/MERGE/Bulk Tools | PASS | Absent from inventory/list/source; static Provider test rejects forbidden method implementations |
| Arbitrary REST Tool/path | PASS | Absent from list/schema/source; production never calls `Connection.request()` |
| Official deploy/admin Tools | PASS | `deploy_metadata` and `assign_permission_set` still fail startup governance even with P3 Tools enabled |
| CREATE contract | PASS | Only explicit `objectApiName` plus 1..200 scalar `fields`; identity/org/token/directory/operation/version/path inputs absent |
| UPDATE contract | PASS | Separate 15/18-character `recordId`; empty fields, `fields.Id` (case-insensitive), nested/relationship/upsert inputs rejected |
| Deterministic output | PASS | Success text/structured content contain only `success: true`, `recordId`; no automatic SOQL/readback |
| User A CREATE identity | PASS | HTTP isolation fixture and live Gate used A route/Connection; live operation succeeded |
| User B CREATE identity | PASS | HTTP fixture used B route/Connection; live call reached Salesforce as B and preserved native `FIELD_CUSTOM_VALIDATION_EXCEPTION` |
| User A UPDATE identity | PASS | HTTP isolation fixture and live Gate used A route/Connection; live operation succeeded |
| User B UPDATE identity | PASS | HTTP fixture used B route/Connection; live call used B and preserved native `INSUFFICIENT_ACCESS_OR_READONLY` |
| Forged `platformUserId` | PASS | Body value could not change Header-authoritative A route; live forged CREATE remained A |
| Forged username/alias | PASS | Body username fields could not change B route; live forged UPDATE remained B |
| Cross-user Connection reuse | PASS | HTTP integration and live validator reported zero reused request Connections |
| Salesforce native validation | PASS | Live invalid Lead CREATE preserved `REQUIRED_FIELD_MISSING` under `MCP_SALESFORCE_DML_FAILED` |
| Salesforce native authorization | PASS | Live B UPDATE against the validator-owned A record preserved `INSUFFICIENT_ACCESS_OR_READONLY`; SFoA did not bypass Salesforce sharing/authorization |
| Salesforce error preservation/redaction | PASS | Stable outer code plus bounded safe Salesforce code/message/fields; Bearer/access-token fixture values redacted |
| Validator cleanup | PASS | Exactly 2 recorded IDs attempted, 2 deleted, 0 failures; SDK cleanup exists only in validation harness and performs no query-based delete |
| P3 Provider build/tests/lint | PASS | Strict build/lint; 12/12 tests, 0 failed |
| P3 Host build/tests/lint | PASS | Strict build/lint; independent P3 config/HTTP/security suite 8/8, 0 failed |
| P2 targeted regression | PASS | Historical P2 suite remains exactly 18/18, 0 failed |
| P2 A/B live regression | PASS | Official reads plus 50 requests: mismatch/leak/workspace leak/cleanup failure/Connection reuse/error all 0 |
| P1 regression | PASS | 22/22 plus live two-user JWT/identity/SOQL, 20 requests, metadata/CWD/workspace cleanup |
| P0 runtime regression | PASS | 9/9 plus live JWT/identity/direct+official SOQL/CustomObject metadata/CWD restoration |
| P0 Streamable HTTP | PASS | 1/1 initialize/list/call and transport/security assertions |
| Original Salesforce stdio | PASS | initialize, five-Tool list, and official `get_username` call; response content withheld |
| Project-local MCP Inspector | PASS | Inspector 0.15.0 initialize/list/call for A and B; no global install |
| P3 Streamable HTTP initialize/list/call | PASS | Official SDK Client initialized; live list returned two DML Tools; real calls reached Salesforce |
| Upstream compatibility | PASS | Provider API 0.6.0, dx-core 0.10.0, nine GA Tools, `drift: []` |
| Root build | PASS | Git Bash root build completed all workspaces in 82.49 s |
| Root tests | PASS | Full workspace test command completed in 356.86 s; all official and SFoA workspace tests exited 0 |
| SFoA changed-code lint | PASS | P3 Provider, P3 Host, P1 identity, P0 runtime, and P0 HTTP strict TypeScript lint exited 0 |
| Repository lint | KNOWN UPSTREAM DEBT | Exactly 47 errors / 0 warnings, all in unchanged official code-analyzer source/test/generated declarations; no SFoA path |
| Frozen dependency install | KNOWN UPSTREAM DEBT | Yarn Classic Windows nested `brace-expansion` link failure reproduced; root/lockfile unchanged; generated local bin shims restored mechanically before successful stdio/build/tests |
| Official Salesforce TypeScript modified | PASS | Zero existing official TypeScript paths in the P3 diff |
| Official Tool copied/reimplemented | PASS | None; SFoA owns two minimal Provider Tools over public SDK methods |
| Root manifest / lockfile | PASS | Root `package.json` unchanged; `yarn.lock` unchanged |
| Database / Redis / cache / pool | PASS | No new database, ORM, Redis, token-cache, or Connection-pool dependency/runtime |
| P4 scope boundary | PASS | No P4 diagnosis implementation or later-phase feature added |

## P3-Closure HOTFIX01 Gate Matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| Pinned SDK error-shape audit | PASS | Local `@salesforce/core@8.29.0` resolves `@jsforce/jsforce-node@3.10.13`; single-record request and `HttpApiError.data` paths inspected before classification changes |
| Explicit required-field rejection | PASS | Structured `REQUIRED_FIELD_MISSING` returns `MCP_SALESFORCE_DML_FAILED`, never UNKNOWN |
| Explicit validation rejection | PASS | Structured `FIELD_CUSTOM_VALIDATION_EXCEPTION` returns `MCP_SALESFORCE_DML_FAILED`, never UNKNOWN |
| Transport/network exception | PASS | ECONNRESET-style Promise rejection without structured Salesforce evidence returns `MCP_DML_OUTCOME_UNKNOWN` |
| Unstructured SDK rejection | PASS | SDK rejection without reliable Salesforce error body returns UNKNOWN; no Error-name/message guessing |
| CREATE Tool timeout | PASS | MCP Tool result is `success:false`, `MCP_DML_OUTCOME_UNKNOWN`, with explicit no-retry/read guidance |
| UPDATE Tool timeout | PASS | MCP Tool result is `success:false`, `MCP_DML_OUTCOME_UNKNOWN`, with explicit no-retry/read guidance |
| Late CREATE completion | PASS | Host returned UNKNOWN before the mock later resolved successfully; CREATE invocation count remained exactly one |
| Automatic CREATE retry | PASS | None in Provider, facade, or Host; timeout/network fixtures record one invocation |
| Automatic UPDATE retry | PASS | None in Provider, facade, or Host; timeout/network fixtures record one invocation |
| Existing rejection detail regression | PASS | Required, validation, and authorization fixtures preserve bounded safe Salesforce code/message/fields |
| UNKNOWN result secrecy | PASS | Static client message only; cause, stack, token, JWT, private key, client secret, and Connection are absent |
| Timeout log context | PASS | `correlationId`, `toolName`, `platformUserId`, and `salesforceUsername` asserted with `MCP_DML_OUTCOME_UNKNOWN` |
| Mutation Tool descriptions | PASS | Actual `tools/list` says non-idempotent, do not automatically retry, use a read-only Tool, and inform the user if unresolved |
| Mutation annotations | PASS | CREATE and UPDATE retain `idempotentHint:false`, `readOnlyHint:false`, `destructiveHint:true`, `openWorldHint:true` |
| P3 Provider tests | PASS | 16/16, 0 failed |
| P3 Host tests | PASS | 10/10, 0 failed, including real MCP client timeout/late-completion fixtures |
| P3 live Salesforce | PASS | Successful CREATE/UPDATE; required/validation/authorization failures; forgery isolation; Connection reuse 0; cleanup 2/2 |
| P2 regression | PASS | 18/18; live A/B and 50-request load had mismatch/leak/workspace leak/cleanup failure/reuse/error all 0 |
| P1 regression | PASS | 22/22 plus live A/B, 20 requests, metadata/CWD/workspace cleanup |
| P0 regression | PASS | 9/9 plus live JWT/identity/direct+official SOQL/CustomObject metadata/CWD restoration |
| P0 Streamable HTTP | PASS | 1/1 initialize/list/call |
| Upstream compatibility | PASS | Provider API 0.6.0, dx-core 0.10.0, nine GA Tools, `drift: []` |
| Original Salesforce stdio | PASS | initialize, five-Tool list, official `get_username` call |
| MCP Inspector | PASS | Project-local Inspector 0.15.0 initialize/list/call for A and B |
| Root build | PASS | Git Bash all-workspace build completed in 70.86 s |
| Root tests | PASS | Full all-workspace test command completed in 284.67 s |
| SFoA changed-code lint | PASS | DML Provider, Host, Identity, P0 runtime, and HTTP POC strict TypeScript lint exited 0 |
| Repository lint | KNOWN UPSTREAM DEBT | Exactly 47 errors / 0 warnings, all under unchanged official code-analyzer; no SFoA path |
| Database / Redis | PASS | No dependency or runtime added |
| Idempotency framework / retry queue | PASS | None added; no ledger, replay, distributed transaction, or automatic retry |
| UPSERT / DELETE | PASS | No Tool, parameter, SDK production call, or hidden entry added |
| Official Salesforce TypeScript modified | PASS | Zero official TypeScript paths in the Closure diff |
| Root manifest / lockfile modified | PASS | Root `package.json` and `yarn.lock` unchanged |
| P4 scope boundary | PASS | No Describe preflight, layout/UI API, context/diagnosis, or other P4 capability added |

## P3-Closure HOTFIX02 Gate Matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| Default timeout relationship | PASS | Code defaults are request 180000 ms and Tool 120000 ms; `requestTimeoutMs > toolTimeoutMs` |
| `.env.example` timeout parity | PASS | Example contains request 180000 ms and Tool 120000 ms; source contract test compares both values |
| Invalid timeout relationship | PASS | Equal and lower request deadlines fail config loading and direct server startup with `MCP_RUNTIME_CONFIGURATION_INVALID` |
| Request-scoped mutation state | PASS | One `MutationRequestState` is created inside each HTTP POST; no module/global mutable mutation state |
| CREATE dispatch boundary | PASS | Observer is marked immediately before the one public SDK `create()` call, after local gates and request Connection preparation |
| UPDATE dispatch boundary | PASS | Observer is marked immediately before the one public SDK `update()` call, after local gates and request Connection preparation |
| Read request timeout regression | PASS | Slow read-only Tool returns HTTP 504 `MCP_REQUEST_TIMEOUT`, never DML UNKNOWN |
| CREATE outer request timeout | PASS | Post-dispatch HTTP deadline returns JSON-RPC `MCP_DML_OUTCOME_UNKNOWN`, HTTP 504, and `retryable:false` |
| UPDATE outer request timeout | PASS | Post-dispatch HTTP deadline returns JSON-RPC `MCP_DML_OUTCOME_UNKNOWN`, HTTP 504, and `retryable:false` |
| Late CREATE completion | PASS | Client receives UNKNOWN before mock success; create invocation 1, completion 1, automatic retry 0 |
| Late UPDATE completion | PASS | Client receives UNKNOWN before mock success; update invocation 1, completion 1, automatic retry 0 |
| Timeout before mutation start | PASS | Delayed request Connection preparation returns `MCP_REQUEST_TIMEOUT`; CREATE/UPDATE invocation 0 |
| Allowlist denial before dispatch | PASS | `MCP_DML_OBJECT_NOT_ALLOWED`; mutation state remains NOT_STARTED and invocation count is 0 |
| Unknown/off-limits Tool before dispatch | PASS | `delete_record` and `deploy_metadata` do not mark mutation state and execute no mutation |
| Input validation before dispatch | PASS | Invalid Tool schema returns `MCP_DML_INPUT_INVALID`; observer is not marked |
| DML Tool-timeout regression | PASS | HOTFIX01 behavior remains `MCP_DML_OUTCOME_UNKNOWN` for CREATE and UPDATE |
| Explicit Salesforce rejection regression | PASS | Required, validation, and authorization error fixtures remain `MCP_SALESFORCE_DML_FAILED` with bounded safe details |
| Network/unstructured post-dispatch failure | PASS | Remains `MCP_DML_OUTCOME_UNKNOWN`; no Error-name/message guessing and no retry |
| No automatic mutation retry | PASS | Tool timeout, request timeout, transport failure, and late completion fixtures each execute CREATE/UPDATE exactly once |
| Pinned JSforce retry audit | PASS | Installed 3.10.13 source default is exactly GET/PUT/HEAD/OPTIONS/DELETE; POST and PATCH are absent |
| Client disconnect after mutation start | PASS | Socket-close fixture logs UNKNOWN with `terminationLayer=TRANSPORT`; invocation/completion 1 and replay 0 |
| Request UNKNOWN wire contract | PASS | HTTP 504, JSON-RPC -32001, stable message, `data.errorCode`, bounded correlation ID, and `retryable:false` |
| UNKNOWN safe logging | PASS | Correlation, Tool, operation, platform user, Salesforce username, duration, outcome, start state, and layer retained; no credential/Connection output |
| P3 Provider tests | PASS | 17/17, 0 failed, including pinned JSforce source contract |
| P3 Host tests | PASS | 18/18, 0 failed, including request timeout, late completion, disconnect, unknown/off-limits Tool, allowlist, identity, and Tool-timeout regressions |
| P3 live Salesforce | PASS | CREATE/UPDATE, required/validation/authorization failures, A/B isolation, Connection reuse 0, exact cleanup 2/2 |
| P2 tests | PASS | 18/18, including read Tool/request timeout and graceful shutdown |
| P2 live A/B/load | PASS | 50 requests; identity mismatch, cross-user leak, workspace leak, cleanup failure, Connection reuse, and error count all 0 |
| P1 tests/live | PASS | 22/22; two live users; 20 concurrent requests; identity mismatch/leak/reuse all 0 |
| P0 tests/live | PASS | 9/9 plus live fresh JWT, identity, direct/official SOQL, metadata, and CWD restoration |
| Streamable HTTP | PASS | P0 POC 1/1 plus P2/P3 SDK Client initialize/list/call paths |
| Upstream compatibility | PASS | Provider API 0.6.0, dx-core 0.10.0, nine GA Tools, `drift: []` |
| Original Salesforce stdio | PASS | initialize, five-Tool list, and official `get_username` call |
| MCP Inspector | PASS | Project-local Inspector 0.15.0 initialize/list/call for Users A and B |
| Root build | PASS | Git Bash all-workspace build completed in 130.07 s |
| Root tests | PASS | Full all-workspace test command completed in 519.71 s |
| SFoA changed-code lint | PASS | DML Provider, Host, Identity, P0 runtime, and HTTP POC strict TypeScript lint exited 0 |
| Repository lint | KNOWN UPSTREAM DEBT | Exactly 47 errors / 0 warnings, all under unchanged official code-analyzer; no SFoA path |
| Official Salesforce TypeScript modified | PASS | Zero official TypeScript paths in the HOTFIX02 diff |
| JSforce patched/forked | PASS | No installed dependency or lockfile patch; audit is read-only |
| Root manifest / lockfile modified | PASS | Root `package.json` and `yarn.lock` unchanged |
| Database / Redis / idempotency framework | PASS | None added; no ledger, queue, replay key, persistence, or distributed transaction |
| UPSERT / DELETE / Bulk DML | PASS | No Tool, schema parameter, SDK production call, or hidden entry added |
| P4 scope boundary | PASS | No DIAGNOSTIC, Describe, layout/UI API, context, field recommendation, or diagnosis capability added |

## P2 overall result

`P2 = PASS / COMPLETE — MAINTAINER ACCEPTED`

All mandatory P2 runtime, authentication, identity, governance, schema, request-bound, timeout/cleanup, graceful-shutdown, real A/B, 50-request, Inspector, official Tool, no-CLI/no-database/no-cache, zero-official-code-change, build/test/lint, P0/P1 regression, and HOTFIX01 upstream drift Gates passed. Maintainer review accepted P2 and authorized P3.

## P3 overall result

`P3 = PASS / COMPLETE — AWAITING MAINTAINER FINAL ACCEPTANCE`

P3 is a thin enterprise mutation gate over the accepted request-scoped Salesforce SDK path. CREATE/UPDATE, strict Object-by-Operation governance, Tool-level safe errors, identity isolation, native Salesforce validation/authorization, bounded validator cleanup, protocol surfaces, and all required regressions passed. DELETE and every prohibited substitute remain absent. P4 has not started.

## P3 Closure HOTFIX01 overall result

`P3-CLOSURE HOTFIX01 = PASS`

The Closure changes only outcome semantics and Agent retry safety. It adds no idempotency machinery, retry, database, Redis, UPSERT, DELETE, metadata/layout/context engine, or P4 capability. P3 may be recommended for final maintainer acceptance; merge and P4 authorization remain maintainer decisions.

## P3 Closure HOTFIX02 overall result

`P3-CLOSURE HOTFIX02 = PASS`

The request lifecycle now preserves UNKNOWN semantics across both Tool and outer HTTP deadlines after CREATE/UPDATE dispatch. Before dispatch and for reads, ordinary request timeout semantics remain unchanged. The operational timeout hierarchy is fail-closed, pinned JSforce does not retry POST/PATCH by default, and SFoA adds no retry, persistence, idempotency framework, prohibited mutation, official patch, or P4 capability. P3 may be recommended for final maintainer acceptance; merge and P4 authorization remain maintainer decisions.

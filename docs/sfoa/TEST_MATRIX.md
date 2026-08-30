# P0 / P1 / P2 / P3 / P4 / P5 Gate Matrix

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

`P3 = PASS / COMPLETE — MAINTAINER FINAL ACCEPTED`

P3 is a thin enterprise mutation gate over the accepted request-scoped Salesforce SDK path. CREATE/UPDATE, strict Object-by-Operation governance, Tool-level safe errors, identity isolation, native Salesforce validation/authorization, bounded validator cleanup, protocol surfaces, and all required regressions passed. DELETE and every prohibited substitute remain absent. Maintainer final acceptance authorized P4.

## P3 Closure HOTFIX01 overall result

`P3-CLOSURE HOTFIX01 = PASS`

The Closure changes only outcome semantics and Agent retry safety. It adds no idempotency machinery, retry, database, Redis, UPSERT, DELETE, metadata/layout/context engine, or P4 capability. P3 may be recommended for final maintainer acceptance; merge and P4 authorization remain maintainer decisions.

## P3 Closure HOTFIX02 overall result

`P3-CLOSURE HOTFIX02 = PASS`

The request lifecycle now preserves UNKNOWN semantics across both Tool and outer HTTP deadlines after CREATE/UPDATE dispatch. Before dispatch and for reads, ordinary request timeout semantics remain unchanged. The operational timeout hierarchy is fail-closed, pinned JSforce does not retry POST/PATCH by default, and SFoA adds no retry, persistence, idempotency framework, prohibited mutation, official patch, or P4 capability. P3 may be recommended for final maintainer acceptance; merge and P4 authorization remain maintainer decisions.

## P4 Entry Gate Matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| Maintainer authorization | PASS | Maintainer final-accepted P3 and explicitly authorized P4 in the supplied task authority |
| P3 branch cleanliness | PASS | `git status --short --branch` showed no changed or untracked files before transition |
| P3 Provider acceptance rerun | PASS | `yarn workspace @sfoa/mcp-provider-sfoa-dml test`: 17/17, 0 failed |
| P3 Host acceptance rerun | PASS | `yarn workspace @sfoa/mcp-server test:p3`: 18/18, 0 failed |
| Upstream compatibility rerun | PASS | Provider API 0.6.0, dx-core 0.10.0, nine GA Tools, `drift: []` |
| SFoA changed-code lint rerun | PASS | POC, runtime validation, identity runtime, DML Provider, and remote Host strict TypeScript lint all exited 0 |
| P3 history preservation | PASS | `main` fast-forwarded from `f532c8a` to `4c3a45e`; no squash or rewritten P3/HOTFIX commit |
| `origin/main` push | PASS | `git push origin main` advanced the remote from `f532c8a` to `4c3a45e` |
| Dedicated P4 branch | PASS | `feature/p4-diagnosis-runtime-context` created from updated `main` at `4c3a45e` |
| Official Provider capability audit | NOT TESTED | P4-00 pending; no result inferred from names or historical documentation |
| Official `retrieve_metadata` result audit | NOT TESTED | P4-00 must inspect actual same-request result and remote-workspace implications |
| Official Code Analyzer remote compatibility | NOT TESTED | P4-00 must initialize the actual Provider and inspect tools, ReleaseState, dependencies, filesystem, and cleanup compatibility |
| Live SFoA API version | NOT TESTED | P4-00 live Connection audit pending |
| UI API Object Info | NOT TESTED | Live USER-context endpoint audit pending |
| UI API Create/Edit Layout | NOT TESTED | Live USER-context endpoint audit pending |
| UI API Create Defaults | NOT TESTED | Live USER-context endpoint audit pending |
| UI API record-type Picklist | NOT TESTED | Live USER-context endpoint audit pending |
| GraphQL UI API / `recordLayouts` | NOT TESTED | Optional live capability audit pending; no project upgrade authorized |
| DIAGNOSTIC identity | NOT TESTED | Not implemented at baseline entry |
| Record Action Context | NOT TESTED | Not implemented at baseline entry |

## P4 Completion Gate Matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| P4-00 dx-core Provider inventory | PASS | Actual Provider initialized: 13 Tools, nine GA; Provider API 0.6.0 and dx-core 0.10.0 |
| Official `run_soql_query` primitive audit | PASS | Actual schema/implementation inspected; diagnostic adapter invokes unchanged `Tool.exec()` with fixed username/workspace and `useToolingApi=true` |
| Official `retrieve_metadata` result audit | PASS | Live run returned one 796-character status block/no structured content and wrote 137 files; CWD restored and workspace removed |
| Code Analyzer compatibility decision | PASS | Actual six-Tool Provider audited; absolute targets, durable project, and global-temp results establish `NOT REMOTE COMPATIBLE`; none exposed/copied |
| ADR before implementation | PASS | ADR-0009 records official/live audits and REST/adapter/Code Analyzer decisions |
| Live SFoA API version | PASS | Both USER Connections reported 67.0 |
| UI API Object Info | PASS | Live A/B labels, fields/types/required/editability, record types, and default type |
| UI API Create/Edit Layout | PASS | Live A/B REST calls with object/type/mode/Full/Large succeeded |
| UI API Create Defaults | PASS | Live A/B effective record type, Salesforce defaults, and Create Layout |
| UI API record-type Picklists | PASS | Live A/B values/defaults/controller maps/dependent `validFor` facts |
| GraphQL UI API capability | PASS | Live `recordLayouts` query returned zero GraphQL errors and visible edges; runtime use not required |
| Context Provider contract | PASS | Exactly three GA Tools, stable output schemas, complete read-only annotations, fixed role map |
| Context Provider tests | PASS | 10/10; CREATE/UPDATE Record Type, mismatch/availability, required/editable/default/picklist/reference/bounds/unsupported inputs |
| Diagnostic configuration | PASS | Optional while disabled; startup fails with `MCP_DIAGNOSTIC_CONFIGURATION_INVALID` when a diagnostic Tool is enabled without a username or when that username aliases a configured USER |
| Diagnostic request scope | PASS | Fresh fixed username Connection/workspace per request, triggering platform user retained, exact cleanup |
| Client role/identity switch absent | PASS | Schemas omit role, identity, credential, token, instance, arbitrary URL, directory, manifest, source/output path, and Tooling switch |
| Diagnostic Tooling-only route | PASS | Adapter forces official Tool input `useToolingApi=true`; SELECT-only/no semicolon/no record locking; 200 records/256 KiB bounds |
| Diagnostic business Tool denial | PASS | Official USER query and DML facades reject DIAGNOSTIC before underlying execution |
| USER diagnostic Tool denial | PASS | Context facade rejects diagnostic Tools on USER before underlying execution |
| Metadata allowlist and manifest ownership | PASS | Eight explicit types; server-created escaped manifest; no wildcard/client path/package XML input |
| Metadata path/UTF-8/size bounds | PASS | Request source root only; max scan 1000, return 40, 64 KiB/file, 256 KiB total, 100 summaries, explicit truncation |
| Metadata cleanup/CWD/concurrency | PASS | Correct path existence/CWD assertions, exact cleanup metrics, and max one concurrent official retrieve under guard |
| Diagnostic evidence credential redaction | PASS | Tooling Bearer JSON remains parseable and redacted; metadata PEM/JWT/access-token patterns redacted before output |
| P4 Streamable HTTP protocol | PASS | 7/7 P4 Host tests include exact six-Tool list, A/B UI context, fixed diagnostic routing, USER DML, cleanup, and logs |
| P4 live USER A Context | PASS | API 67.0, identity match, 111 fields, 28 API-required, 12 layout-required, 6 defaults, 32 picklist fields, 3 calls |
| P4 live USER B Context | PASS | API 67.0, identity match, 79 fields, 23 API-required, 12 layout-required, 9 defaults, 21 picklist fields, 3 calls |
| P4 live A/B isolation | PASS | Fresh Connections, distinct resolved users, identity mismatch 0, Connection reuse 0 |
| P4 live workspace cleanup | PASS | Created 2, cleaned 2, active 0 |
| Real diagnostic Tooling evidence | NOT TESTED | `SFOA_DIAGNOSTIC_USERNAME` is not configured |
| Real diagnostic metadata evidence | NOT TESTED | `SFOA_DIAGNOSTIC_USERNAME` is not configured; no mock result promoted to live PASS |
| P3 Provider regression | PASS | 17/17 |
| P3 Host regression | PASS | 18/18, including Tool/request timeout UNKNOWN and one-invocation/no-retry semantics |
| P3 live Salesforce | PASS | CREATE/UPDATE, required/validation/authorization/forgery, Connection reuse 0, cleanup 2/2 |
| P2 Host regression | PASS | 18/18 |
| P2 live A/B/50-load | PASS | Identity mismatch, cross-user leak, workspace leak, cleanup failure, Connection reuse, and errors all 0 |
| P1 tests/live | PASS | 26/26; live A/B, 20 requests, mismatch/leak/reuse 0, CWD/workspace/cleanup |
| P0 tests/live | PASS | 9/9; live JWT, identity, direct/official SOQL, official CustomObject metadata 135 files, CWD restore |
| P0 Streamable HTTP | PASS | 1/1 initialize/list/call |
| Original Salesforce stdio | PASS | Initialize, five-Tool list, official `get_username`; command completed in 122.95 s |
| Project-local Inspector | PASS | Inspector 0.15.0 initialize/list/call for A and B; command completed in 50.98 s |
| Upstream compatibility | PASS | Nine GA dx-core Tools and `drift: []` |
| Root build | PASS | Git Bash all-workspace build, 106.76 s |
| Root full tests | PASS | Complete all-workspace `yarn test`, 419.58 s |
| SFoA changed-code lint | PASS | Context, DML, Identity, Host, P0 runtime, and HTTP POC strict TypeScript all exited 0 |
| Repository lint | KNOWN UPSTREAM DEBT | Exactly 47 errors / 0 warnings under unchanged official Code Analyzer paths; no SFoA path |
| Frozen dependency install | KNOWN UPSTREAM DEBT | Windows Yarn nested `@typescript-eslint/.../ignore` ENOENT; source/manifests/lockfile unchanged; 513 ignored bin commands restored mechanically |
| Official Salesforce TypeScript modified | PASS | Zero existing official TypeScript paths in P4 diff |
| Official Tool copied/reimplemented | PASS | None; official SOQL/retrieve are invoked through public `Tool.exec()` |
| JSforce patched | PASS | No |
| Root manifest / lockfile | PASS | Root `package.json` and `yarn.lock` unchanged |
| Database / Redis / cache / pool | PASS | None added |
| Runtime Form / Evidence Graph / Snapshot / permission replica | PASS | None added |
| P5 scope boundary | PASS | No Admin UI, persistence, or P5 work started |

## P4 current result

`P4 = PARTIAL`

Audit, architecture, implementation, USER live context, security/protocol, P0–P3 regressions, build/tests, changed-code lint, and upstream boundaries pass. Real fixed-DIAGNOSTIC Tooling and metadata evidence remains `NOT TESTED` because an independent DIAGNOSTIC account is unavailable. P4 cannot be promoted to PASS from mock evidence. Maintainer later accepted the implementation and authorized P5 under ADR-0010 without rewriting this historical `PARTIAL` result.

## P5 Acceptance Matrix

Every row below uses only the Closure-authorized item results: `PASS`, `FAIL`, `NOT TESTED`, or `KNOWN UPSTREAM DEBT`. The overall phase result is stated separately because it depends on the external P4 prerequisite.

| Gate | Result | Evidence |
| --- | --- | --- |
| Git branch and history | PASS | Closure remained on `feature/p5-admin-control-plane`; baseline implementation commit `b2ea802` and earlier history were preserved; no reset, merge, or P6 work |
| P5 implementation inventory | PASS | Existing Control Plane, Admin API, Admin Web, MCP integration, and Identity integration reviewed; Closure made targeted fixes only |
| Repository-root resolution | PASS | `resolveSfoaProjectRoot(import.meta.url)` is shared by MCP, Admin API, database CLI, and bootstrap; no runtime `process.cwd()` root contract |
| Root-resolution tests | PASS | CWD=root/MCP package/Admin package and root-only `.env.local` resolve/load the same Control Plane configuration; out-of-layout input fails closed |
| Compiled package-CWD startup | PASS | `node dist/main.js` started both Admin API and MCP from their workspace directories while loading repository-root `.env.local` |
| Production database provisioning | PASS | `sfoa_enterprise_mcp` exists on local MySQL 8.0.30 |
| Integration database provisioning | PASS | `sfoa_enterprise_mcp_test` exists and is the only automated test target |
| Database creation/table evidence | PASS | Both schemas returned by `information_schema`; seven required application tables returned from `sfoa_enterprise_mcp` |
| Migration execution | PASS | `yarn db:migrate` and `yarn db:status`; `001_p5_control_plane` and `002_p5_indexes` both `APPLIED` |
| Migration checksums | PASS | Applied SHA-256 values match repository SQL files; mismatch is startup-fatal |
| Schema columns/constraints/indexes | PASS | Required schema validator passed; ten query indexes, three unique governance keys, and primary keys inspected in `information_schema` |
| Bootstrap source import | PASS | Normal non-force import wrote two routes, two Tool controls, zero DML, zero Diagnostic, and two runtime settings from valid P0–P4 source |
| Bootstrap administrator preservation | PASS | Second normal bootstrap wrote zero rows; no force mode used; conflicting USER/DIAGNOSTIC seed rejected before write |
| Admin credential configuration | PASS | Local scrypt password hash and independent >=32-character random session secret configured only in ignored local environment; no plaintext committed/output |
| Frozen dependency installation | KNOWN UPSTREAM DEBT | Yarn Classic Windows/nohoist nested `@typescript-eslint/.../ignore` ENOENT reproduced; source/manifests/lockfile unchanged; all P5 dependencies resolve and all downstream gates pass |
| Control Plane build | PASS | `yarn workspace @sfoa/control-plane build` |
| Admin API build | PASS | `yarn workspace @sfoa/admin-api build` |
| Admin Web build | PASS | Vite production build completed; size warning only |
| MCP Server build | PASS | `yarn workspace @sfoa/mcp-server build` |
| SFoA changed-code lint | PASS | Control Plane, Admin API, Admin Web, MCP Server, and Identity Runtime strict TypeScript lint all exited 0 |
| Control Plane unit tests | PASS | 12/12 |
| Identity Runtime tests | PASS | 27/27 |
| Admin API tests | PASS | 12/12 |
| Admin Web unit tests | PASS | 8/8 |
| MySQL integration tests | PASS | `test:mysql` connected to `sfoa_enterprise_mcp_test`: 5/5, zero skipped |
| Real Runtime MySQL mode | PASS | Actual Streamable HTTP runtime, MCP SDK client, request snapshots, and test MySQL executed; Salesforce calls used a deterministic non-business-data seam |
| MySQL identity A/B | PASS | Two platform users resolved through live database routes with isolated request scopes and no Connection reuse |
| Missing/disabled route | PASS | Both denied without environment fallback |
| Shared Salesforce account | PASS | Two platform users mapping to one Salesforce username is accepted by schema and runtime fixture |
| Dynamic Tool governance | PASS | Safe Tool enable appears on next `tools/list`; disable disappears on next request without MCP restart |
| Dynamic DML governance | PASS | Lead CREATE and UPDATE were independently enabled/disabled and affected the next request |
| DELETE/UPSERT absence | PASS | Neither Tool exists in executable runtime inventory or browser control surface |
| Unknown Tool fail-closed | PASS | Enabled `future_unknown_tool` database fixture never appeared in runtime; Admin returned `enableAllowed=false` |
| Runtime database outage | PASS | Real unreachable MySQL endpoint returned stable Control Plane unavailable behavior; no env fallback/default allow/cached dangerous policy |
| Runtime durable audit | PASS | Real MCP/MySQL requests persisted/queryable USER SOQL, blocked Tool, DML denial, record-context, and governed mutation fixtures |
| Mutation audit-failure regression | PASS | CREATE success survives audit append failure; one invocation/no retry, audit `DEGRADED`, fallback log; UNKNOWN is not overwritten by audit failure |
| Admin API startup | PASS | Real `yarn admin:api:dev` and compiled startup; health `UP`, ready `UP`, MySQL 8.0.30 schema ready |
| Admin unauthenticated/wrong-password behavior | PASS | Protected API 401; invalid credentials rejected |
| Admin login rate limit | PASS | Repeated bad logins reached bounded rate limit |
| Admin session cookie | PASS | Signed expiring `HttpOnly`, `SameSite=Strict`; documented loopback development cookie has `Secure=false` |
| Admin CSRF and Origin | PASS | Missing/invalid CSRF and invalid Origin rejected; exact allowed Origin accepted |
| Admin expiry/logout/no-store | PASS | Expired/revoked session rejected, logout passed, API responses `Cache-Control: no-store` |
| Admin secret response safety | PASS | API/health/system payloads contain no DB password, session secret, MCP bearer, JWT assertion/private key, or plaintext Admin password |
| Admin optimistic locking | PASS | Row-version conflict paths covered for managed resources |
| Admin transactional audit | PASS | Route/Tool/DML configuration writes and audit share one MySQL transaction; full-stack rows persisted/queryable |
| Mock UI workflow E2E | PASS | Existing Playwright `admin-control-plane.spec.ts`: 1/1; explicitly classified as mocked UI/browser workflow because it uses `page.route` |
| Full-stack browser E2E | PASS | 1/1 without `page.route`: Browser -> Vite proxy -> real Admin API -> `sfoa_enterprise_mcp_test`, including direct DB assertions |
| Full-stack identity route flow | PASS | Browser create/edit persisted and direct database row assertions matched |
| Full-stack Tool/DML flow | PASS | Browser Tool toggle and Lead CREATE/UPDATE policy changes persisted and were audited |
| Full-stack audit/system flow | PASS | Browser queried Admin audit and migration/runtime state from real API/database |
| P5 aggregate startup | PASS | `yarn p5:dev` started MCP 8080, Admin API 8081, and Admin Web 5173; graceful MCP drain released ports |
| P5 health endpoints | PASS | MCP `/health`, Admin `/health`, Admin `/ready`, and Web `/login` all returned expected HTTP 200/UP/schema-ready responses |
| Admin UI smoke excluding live Diagnostic | PASS | Login, Dashboard, Routes/create/edit, Tool Governance, DML Policies, Audit, System, and Logout passed on real full-stack flow; real route verification passed 2/2 through Admin backend |
| Admin Diagnostic live verify | NOT TESTED | Diagnostic page/mock interaction pass, but no case-insensitively distinct Salesforce Diagnostic account is configured |
| P4 live Tooling evidence | NOT TESTED | Real `validate:p4` attempt exited 1 before Salesforce with the stable distinct-from-USER preflight error; no USER route or mock promoted to live evidence |
| P4 live official metadata/bounded-context evidence | NOT TESTED | Same external credential blocker; P4 historical result remains `PARTIAL` |
| P4 non-Diagnostic regression | PASS | Context Provider 10/10, Host 7/7, live USER A/B record context and cleanup |
| P3 regression | PASS | DML Provider 17/17; Host 20/20; live CREATE/UPDATE/native failures/no-retry/cleanup |
| P2 regression | PASS | Host 18/18 plus authenticated Streamable HTTP, Host/Origin, governance, A/B 50-load, shutdown |
| P1 regression | PASS | Identity 27/27 plus live A/B, request scope, no Connection reuse, workspace isolation |
| P0 regression | PASS | Runtime 9/9, HTTP 1/1, fresh JWT/direct+official SOQL/official metadata/workspace cleanup |
| Original official stdio | PASS | initialize, five-Tool `tools/list`, and official `get_username` call |
| Project-local MCP Inspector | PASS | initialize/list/call for A/B in env compatibility mode |
| Upstream drift | PASS | Provider API 0.6.0, dx-core 0.10.0, nine GA Tools, `drift: []` |
| Official Salesforce TypeScript modified | PASS | Zero paths relative to audited commit `670234dbdca4d3fcdebd9d58b231e311fd34aeec` |
| Official Tool copied | PASS | No |
| JSforce patched | PASS | No |
| Salesforce permission replica | PASS | No |
| Metadata snapshot/evidence graph/runtime form engine | PASS | No |
| Redis/token cache/Connection pool | PASS | No |
| P5 documentation | PASS | Local/deployment runbooks updated; P5 matrix, changelog, baseline, README status, and final report completed |
| Aggregate `validate:p5` | PASS | Final public command exited 0 in 625.83 s; five lints, unit/integration/MySQL, mocked browser, and real full-stack browser Gates all completed |
| P6 scope boundary | PASS | No merge, Dify/WorkBuddy evaluation suite, or P6 implementation |

## P5 overall result

`P5 = PARTIAL — AWAITING MAINTAINER REVIEW`

All locally executable P5 implementation and full-stack Gates pass. The required P4 live DIAGNOSTIC Salesforce evidence is `NOT TESTED`, so P5 cannot be promoted to PASS/COMPLETE.

## P4/P5 Final Live Closure Acceptance Matrix — 2026-08-24

This later matrix preserves the historical P4/P5 PARTIAL evidence above and records the independent external Salesforce closure that supersedes the current status.

| Gate | Result | Evidence |
| --- | --- | --- |
| Independent Diagnostic identity | PASS | Primary USER, secondary USER, and fixed DIAGNOSTIC usernames are configured and case-insensitively distinct; exact values remain outside Git |
| MySQL USER/Diagnostic separation | PASS | Two enabled USER routes map to the two USER identities; enabled `sfoa_diagnostic_config` matches neither route |
| Real Admin authentication/CSRF/Origin | PASS | Real compiled Admin API login and guarded configuration mutations completed against `sfoa_enterprise_mcp` |
| Admin Diagnostic configuration/audit | PASS | Diagnostic save and verification persisted with transactional Admin audit |
| Fresh Diagnostic JWT and exact identity | PASS | Real `Connection.identity()` exactly matched the fixed configured DIAGNOSTIC username |
| Diagnostic Tooling API | PASS | Official `run_soql_query` in Tooling mode returned 5 bounded ApexClass records, not truncated |
| Official Diagnostic metadata retrieval | PASS | Official `retrieve_metadata` returned real `CustomObject` source through the P4 adapter |
| Bounded Metadata Context | PASS | 135 total files; 40 files and 34,371 bytes returned within the 40-file/262,144-byte aggregate bounds |
| Diagnostic CWD restoration | PASS | Live before/after process CWD matched after official metadata execution |
| Diagnostic workspace cleanup | PASS | Admin closure `created=1/cleaned=1/active=0`; formal validator `created=3/cleaned=3/active=0` |
| Triggering platform identity audit | PASS | Two correlated MCP audit rows retained non-empty triggering `platformUserId` values |
| DIAGNOSTIC execution boundary audit | PASS | Both correlated rows recorded the fixed username, `executionRole=DIAGNOSTIC`, and the expected official Tool names |
| USER Tool execution boundary | PASS | Admin catalog retained USER role for SOQL, CREATE, UPDATE, and record-action context; live A/B context also returned USER |
| USER A/B live isolation | PASS | Both route identity/context checks passed with distinct resolved users, fresh Connections, mismatch 0, reuse 0 |
| Formal P4 live validator | PASS | `yarn workspace @sfoa/mcp-server validate:p4`: exit 0, API 67.0, `overall=PASS` |
| P5 aggregate rerun | PASS | `yarn validate:p5`: exit 0 in 463.41 seconds after P4 closure |
| Admin current phase display | PASS | Real `/admin/api/system/status` returned P4 FINAL ACCEPTED, P5 PASS/COMPLETE awaiting Maintainer review, MySQL mode, database UP, and both migrations |
| P5 changed-code lint | PASS | Control Plane, Admin API, Admin Web, MCP Server, and Identity Runtime |
| P5 MySQL integration | PASS | 5/5 connected tests against `sfoa_enterprise_mcp_test`, zero skipped |
| P5 runtime/Admin/frontend tests | PASS | Control Plane 12/12, Identity 27/27, MCP P5 5/5, Admin API 12/12, React 8/8/build |
| Mock UI workflow E2E | PASS | Existing explicitly mocked Playwright workflow 1/1 |
| Real full-stack browser E2E | PASS | Browser -> Vite -> real Admin API -> `sfoa_enterprise_mcp_test`, 1/1 |
| Application database final state | PASS | MySQL 8.0.30, seven reviewed tables, both migrations applied in `sfoa_enterprise_mcp` |
| Test database isolation | PASS | `sfoa_enterprise_mcp_test` is limited to automated Gates and is not a production runtime requirement |
| Production port/exposure contract | PASS | Node listeners remain loopback 8080/8081, React is static, Vite is off, external access is HTTPS 443; 8080/8081/3306 are not public |
| Upstream and scope boundary | PASS | No official Tool copy/TypeScript or JSforce patch, permission replica, Redis/cache/pool, P5 merge, or P6 implementation |

## Current result after final live closure

```text
P4 = FINAL ACCEPTED
P5 = PASS / COMPLETE — AWAITING MAINTAINER REVIEW
P6 ENTRY GATE = READY
```

Codex does not claim `P5 MAINTAINER FINAL ACCEPTED`; the feature branch remains pending Maintainer review and P6 implementation remains unstarted.

## P5 local startup reliability follow-up — 2026-08-24

This follow-up does not rewrite the accepted P4/P5 evidence above. It records the targeted local-development correction made after reproducing a VS Code PowerShell startup failure.

| Gate | Result | Evidence |
| --- | --- | --- |
| Windows bundled launcher | PASS | `yarn p5:dev` used sequential project-local TypeScript builds and started MCP `8080`, Admin API `8081`, and Vite `5173` without the reproduced overlapping-process `Access is denied` / `spawn EPERM` failure |
| Occupied-port preflight | PASS | An already occupied MCP port produced an actionable `EADDRINUSE` error and process exit 1 before new service peers were started; the existing service remained available |
| Startup dependency order | PASS | MCP `/health` and Admin `/admin/api/ready` reached HTTP 200 before Vite was started; the launcher then reached `/login` before announcing the stack ready |
| Real Vite-to-Admin proxy | PASS | `http://127.0.0.1:5173/admin/api/ready` returned HTTP 200 through Vite to the real Admin API |
| Login error contract | PASS | Wrong credentials through the real Vite proxy returned HTTP 401 with structured `MCP_ADMIN_AUTH_INVALID`; an empty 502 fixture renders an actionable API-readiness message instead of the generic safe-failure text |
| Login regression tests | PASS | Admin Web unit suite passed 10/10, including structured-authentication and empty-proxy cases |
| Windows shutdown cleanup | PASS | `Ctrl+C` stopped spawned service trees and released `5173`, `8080`, and `8081` |
| Scope boundary | PASS | No MCP Tool, Admin security policy, MySQL schema, Salesforce identity/authorization behavior, official Salesforce TypeScript, accepted P5 status, or P6 implementation changed |

## Maintainer Acceptance Status Sync — 2026-08-24

This status record supersedes only the current phase label; it does not alter any historical P0–P5 Gate evidence above.

```text
P0 = FINAL ACCEPTED
P1 = FINAL ACCEPTED
P2 = FINAL ACCEPTED
P3 = FINAL ACCEPTED
P4 = FINAL ACCEPTED
P5 = FINAL ACCEPTED
P6-ENTRY OPT01 = AUTHORIZED / IN PROGRESS
P6 REAL-AGENT EVALUATION = NOT STARTED
```

## P6-Entry OPT01 Acceptance Matrix — 2026-08-24

This matrix advances only the current P6-Entry status. Historical P0–P5 results above remain unchanged.

| Gate | Result | Evidence |
| --- | --- | --- |
| Admin visible locale | PASS | All eight existing page surfaces plus `/agent-integration` use ordinary-admin Simplified Chinese; document language and date formatter are `zh-CN` |
| Ant Design locale | PASS | Root `ConfigProvider` uses official `zh_CN`; Pagination, Modal, Table, Empty, and Form locale regression passed |
| Navigation/page/button/status localization | PASS | Static and rendered regressions cover all navigation labels, primary page titles, login, buttons, and raw-enum-to-Chinese status mapping |
| Protocol/contract preservation | PASS | Tool names, Error Codes, REST paths, JSON properties, database columns/enums, and MCP schemas were not renamed or translated |
| Error UX | PASS | Common Error Codes map to Chinese explanations; expandable technical detail preserves Error Code, safe raw message, and Correlation ID |
| Safe Runtime configuration | PASS | Agent Integration displays only bind host, port, path, auth mode, allowed Hosts/Origins, Endpoint, and token configured state; secret-shaped fixture never renders |
| Same-host/LAN guidance | PASS | Unit/browser coverage proves 127.0.0.1 same-host wording, 0.0.0.0 allowed-Host/firewall warning, and supplied external URL examples |
| Production TLS guidance | PASS | UI and runbooks retain loopback Node listener behind Nginx/TLS and prohibit direct public 8080 guidance |
| Platform identity guidance | PASS | UI/docs distinguish one controlled fixed Header from per-end-user dynamic identity and defer trusted gateway/claim derivation |
| Dify deterministic generator | PASS | 12 generator regressions cover READ, CREATE, UPDATE, Context on/off, Diagnostic on/off, policy/tool disable, UNKNOWN safety, unknown Tool rejection, secret exclusion, and deterministic object policy |
| Dify baseline document | PASS | `docs/agent/DIFY_AGENT_INSTRUCTION.md` marks itself as baseline and defers current capability to the Admin-generated version |
| WorkBuddy System Prompt | PASS | Concise role/authority/MCP/identity/Skill/high-risk-DML prompt exists without duplicating the full Skill |
| WorkBuddy/CodeBuddy Skill | PASS | Valid name/description frontmatter, concise `SKILL.md`, two progressive-disclosure references, required Tool/UNKNOWN content, and no guessed `allowed-tools` |
| Database migration | PASS (`NO`) | No migration, table, column, or persistence for the temporary external URL was added |
| MCP/Salesforce Runtime behavior | PASS (`NO CHANGE`) | No MCP runtime source, Tool, Salesforce API, Connection lifecycle, identity route, or Diagnostic role changed |
| Admin Web build/tests | PASS | Standard workspace build passed; Vitest 6 files / 32 tests passed |
| Admin API build/tests | PASS | Standard workspace build passed; Node tests 12/12 passed |
| MCP Server build/tests | PASS | Standard workspace build passed; complete Node tests 18/18 passed |
| Mock browser E2E | PASS | Chromium 1/1; includes login/governance/audit, Agent Integration URL example, generated Dify instruction, Skill tab, and logout |
| Real full-stack browser E2E | PASS | Chromium 1/1 through React → Vite proxy → real Admin API → `sfoa_enterprise_mcp_test`; seven Admin audit rows verified |
| Aggregate `validate:p5` | PASS | Public `yarn validate:p5` exited 0 in 709.65 s with five lints, all unit/MySQL/P5 tests, both Admin browser Gates, and full-stack prerequisites |
| Secrets exposed | PASS (`0`) | Generator, network, System, browser, and Skill tests render placeholders/configured-state only; no token, password, JWT key, or session secret appears |

```text
P6-ENTRY OPT01 = PASS
P6 REAL-AGENT EVALUATION = READY
```

## P6-Agent-01 Acceptance Matrix — 2026-08-26

This matrix advances only P6-Agent-01. It preserves all historical P0–P5 and P6 identity evidence and does not mark the complete P6 phase finished.

| Gate | Result | Evidence |
| --- | --- | --- |
| Canonical Playbook | PASS | Pure `@sfoa/agent-playbook`; current version `1.1.0`; ten required sections and six workflow selectors |
| Single source of truth | PASS | MCP, Admin, Dify, WorkBuddy prompt/Skill, and checked-in references use deterministic renderers from the same definition |
| Playbook unit/drift tests | PASS | 6/6; includes sync success plus an intentional temporary generated-file edit that produces nonzero drift failure |
| `agent:sync` | PASS | Rewrote exactly five marked Dify/WorkBuddy/Skill artifacts |
| `agent:check` | PASS | Root script explicitly invokes the workspace `run check` script; five artifacts match exact UTF-8 output |
| Server Instructions | PASS | SDK Client initialize returns concise current Playbook `1.1.0`, identity/context/managed-field/link/UNKNOWN rules, and full-guidance discovery paths |
| Full Playbook Resource | PASS | `resources/list/read` exposes `sfoa://agent-playbook/current` with all workflows and Dynamic Forms limitation |
| Capability Resource | PASS | `sfoa://agent-capabilities/current` contains only safe request facts; concurrent A/B snapshots prove no Tool/object-policy leakage |
| MCP Prompt | PASS | `prompts/list/get` exposes `sfoa_salesforce_assistant`; workflow `CREATE` renders only canonical selection; invalid workflow is rejected |
| Tool-only fallback | PASS | `get_agent_playbook` is discoverable/callable with stable structured output, annotations, bounds flags, and zero Salesforce API calls |
| Trusted record links | PASS | `get_record_links` validates 1–50 descriptors, uses only explicit `SFOA_LIGHTNING_BASE_URL`, URL-encodes path segments, ignores injected host-shaped extras, never falls back to `Connection.instanceUrl`, and makes zero Salesforce API calls |
| Tool governance | PASS | Both infrastructure Tools are explicit READ/USER/GA/remote-compatible catalog entries; env defaults enable them and MySQL remains next-request DB authoritative |
| CREATE workflow | PASS | Context-first, evidence-only required fields, reliable defaults, 3–8 skippable recommendations, Picklist/dependency/Lookup resolution, single mutation, name/link result |
| UPDATE workflow | PASS | Unique target, relevant UPDATE context, CREATE-required distinction, minimum requested fields, single mutation, actual-change/link result |
| READ workflow | PASS | Bounded query, user-requested field priority, proven display/name link, concise one-record or 6–10-column multi-record output |
| DIAGNOSIS workflow | PASS | Requires complete verified Diagnostic chain and preserves USER-versus-DIAGNOSTIC evidence/authority boundaries |
| Dify / 小犇 renderer | PASS | Current safe Tool/DML/Diagnostic facts plus canonical rules; Buntu current-user bearer; no normal platform Header or identity Tool argument |
| WorkBuddy renderer/Skill | PASS | USER_BOUND bearer, no platform Header, generated prompt/Skill and two progressive-disclosure references |
| Admin Agent Integration | PASS | Existing Ant Design page now separates MCP, Playbook, 小犇/Dify, WorkBuddy, and MCP-native guidance with visible text/icon statuses and copy feedback |
| Admin API tests | PASS | 14/14, including explicit safe infrastructure Tool catalog contracts |
| Admin Web P6 focused tests | PASS | 5 files / 20 tests under the repository default timeout |
| Admin Web full diagnostic | PASS | 7 files / 33 tests with a 60-second diagnostic timeout; a prior default-timeout run had three existing GovernancePages timing expirations, and the isolated timed test passed |
| Admin Web production build | PASS | strict TypeScript plus Vite; 3,175 modules transformed; existing >500 kB chunk advisory only |
| MCP Server full tests | PASS | 50/50 on the final source, covering all three identity providers, governance, timeout/shutdown, upstream contract, and P6 protocol surfaces |
| Identity regression | PASS | 27/27 request-scoped identity/runtime tests |
| Historical phase regressions | PASS | P3 20/20; P4 7/7; P5 MySQL 5/5 |
| Changed-code lint | PASS | Agent Playbook, MCP Server, Admin API, and Admin Web strict TypeScript lint |
| Upstream compatibility | PASS | Provider API `0.6.0`, dx-core `0.10.0`, exact nine GA Tools, `drift: []` |
| MCP SDK | PASS | Exact existing `@modelcontextprotocol/sdk` `1.18.2`; no migration or dependency upgrade |
| Lockfile | PASS | `yarn.lock` content delta is zero |
| Dynamic Forms evidence | NOT AVAILABLE | Current action context has Page Layout/Record Type/Picklist/dependency facts but no Lightning Dynamic Forms evaluator |
| Runtime Form Engine | PASS (`NO`) | No form/visibility engine was created |
| Business-object hardcoding | PASS (`0`) | No object-specific field recommendation/workflow branch in new production source |
| Prompt database tables | PASS (`0`) | No migration, prompt table, editor, history, or publisher |
| Official Salesforce TypeScript modified | PASS (`0`) | All production changes are SFoA-owned composition/package paths; official Tool implementations remain unchanged |
| Dependency install environment | KNOWN WINDOWS DEBT | Pinned Yarn Classic linked all new local workspaces, but a forced root reinstall was interrupted by an `EBUSY` lock from the already-running local dev stack; package build/test/lint and zero lock delta independently passed |

```text
P6-Agent-01 = PASS / COMPLETE — AWAITING MAINTAINER REVIEW
P6 REAL-AGENT EVALUATION = READY / NOT STARTED
```

## P7-01 End-to-End Audit Data Model Acceptance Matrix — 2026-08-29

本矩阵只推进 P7-01；保留此前全部历史 Gate，不代表 P7-02～P7-08 已开始，也不代表 Maintainer 已验收。

| Gate | Result | Evidence |
| --- | --- | --- |
| Latest-main baseline | PASS | `git fetch origin`; local/remote `main` 均为 `c849e577`; 从该提交创建 `feature/p7-end-to-end-audit` |
| Control Plane lint/unit | PASS | strict TypeScript lint；21/21 unit tests |
| MySQL clean init/P6 upgrade | PASS | 8/8 connected integration tests；空库、001～005、P6→P7、重复/并发 migration 均通过 |
| Historical Audit compatibility | PASS | 旧 `sfoa_audit_log` 行继续由旧 DTO/列表读取；Admin Audit 页面无 schema 中断 |
| Audit master/children | PASS | 主记录、Event、Salesforce API、Payload Evidence 创建及读取通过 |
| Ordering/isolation/FK | PASS | audit-local sequence、同 Audit 组合 FK、cross-audit 拒绝、cascade 与 orphan 断言通过 |
| Payload/list isolation | PASS | 256 KiB bounded payload；普通列表不读取/Join Payload Evidence |
| Secret sanitization | PASS | 通用 secret-shaped key/value、Bearer/JWT/Authorization 与历史 Buntu `rawToken` 一次性清理测试通过；ADR-0016 仅允许显式 opt-in 的 Buntu 校验 durable 专用字段，其他 scope 会被 Repository 拒绝 |
| Audit fail-open regression | PASS | Repository 故障不会改变既有 Runtime Logger 结果；Salesforce mutation 原则未改变 |
| MCP Server | PASS | full serial 66/66；P3 20/20；P4 7/7；P5 MySQL Runtime 5/5；Identity Runtime 32/32 |
| Providers/Playbook | PASS | DML 17/17；Context 10/10；Agent Playbook 6/6 |
| Admin API | PASS | 18/18 |
| Admin Web | PASS | build 3,175 modules；35/35 tests（Windows/jsdom 项目级 60 秒 timeout） |
| Mock browser E2E | PASS | Chromium 1/1 |
| Real full-stack E2E | PASS | Chromium 1/1；React → Vite → real Admin API → MySQL；001～005；34 Audit rows |
| Fullstack diagnostic hardening | PASS | 子进程错误保留 bounded tail 并经 secret redaction；E2E 显式关闭遗留 raw-token flag |
| CodeGraph project support | PASS | 本地初始化；569 files、7,186 nodes、16,740 edges；数据库由 `.codegraph/.gitignore` 排除 |
| Upstream-owned Salesforce source | PASS (`0`) | 未修改官方 Salesforce Tool 实现 |
| Dependency/lockfile | PASS (`0`) | 未增加 P7/CodeGraph 项目运行时依赖；`yarn.lock` 无变化 |
| Known upstream debt | KNOWN | Vite >500 kB chunk advisory；Node/Yarn `url.parse()` deprecation；Windows 并发测试时序不稳定，完整 MCP suite 以串行 Gate 通过 |

实际执行命令包括：

```text
yarn workspace @sfoa/control-plane lint
yarn workspace @sfoa/control-plane test
yarn workspace @sfoa/control-plane test:mysql
node --test --test-concurrency=1 --test-force-exit packages/sfoa-mcp-server/dist/test/*.test.js
yarn workspace @sfoa/mcp-server validate:p3
yarn workspace @sfoa/mcp-server validate:p4
yarn workspace @sfoa/mcp-server validate:p5
yarn workspace @sfoa/mcp-provider-sfoa-dml test
yarn workspace @sfoa/mcp-provider-sfoa-context test
yarn workspace @sfoa/identity-runtime test
yarn workspace @sfoa/agent-playbook test
yarn workspace @sfoa/admin-api test
yarn workspace @sfoa/admin-web build
yarn workspace @sfoa/admin-web test
yarn p5:e2e
yarn p5:e2e:fullstack
yarn validate:p5
```

初次 aggregate 的最终 Fullstack 子 Gate 因本机 `.env.local` 遗留 `MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED=true` 正确 fail-fast；测试环境显式设为安全值后，独立 Fullstack Gate 以 exit 0 通过。一次后续 aggregate 暴露 Fullstack 的全局 `MySQL` strict locator 命中两个合法元素；限定到“运行概览”后，最终 `yarn validate:p5` 以 exit 0 在 619.67 秒完成，包含 Fullstack Chromium 1/1 与 34 条持久化 Audit 证据。

```text
P7-01 = IMPLEMENTED / AWAITING MAINTAINER REVIEW
P7-02–P7-08 = NOT STARTED
```

### P7-01 startup recovery / Buntu raw-token opt-in follow-up — 2026-08-30

生产开发库诊断确认 MySQL 已隐式提交完整 005 DDL，但 `sfoa_schema_migration` 缺少对应行。修复后的 runner 先验证完整 schema/index/constraint，再以仓库 checksum `d13af5565191b431bf218670bb1e9c7f071b7e5d041d56c3d5b88cd695e65013` 补登记；实际 `db:migrate` 与 `db:status` 均返回 PASS、001～005 全部 APPLIED。新增隔离库测试模拟并覆盖此状态。

`MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED=true` 现按 ADR-0016 恢复。测试必须证明：配置可启用、默认关闭、raw value 只到 durable Buntu validation write、错误 scope 被拒绝、fallback/HTTP/通用 Runtime 不含 raw value、持久化失败不改变认证结果、Admin 详情显示高敏警告。

本次实际结果：Control Plane lint/build PASS、unit 21/21、MySQL 8/8；MCP lint/build PASS、focused identity/security 21/21、完整包目录 suite 66/66；Admin API 18/18；Admin Web lint/build PASS、35/35；`yarn dev:sfoa` 在进程级 `MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED=true` 下启动到 ready 并正常 SIGINT；`yarn validate:p5` exit 0（545.87 秒），含 mock Chromium 1/1、real full-stack Chromium 1/1、001～005 与 34 条 Audit 证据。Vite >500 KiB、Node/Yarn `url.parse()`、既有 Ant Design deprecation/测试 CSS 警告仍为 upstream/project debt。

一次诊断命令从仓库根目录直接执行 `node --test packages/sfoa-mcp-server/dist/test/*.test.js` 得到 64/66；两项只因测试按当前目录读取包内 `src/runtime.ts`/`package.json` 而失败。改在 `packages/sfoa-mcp-server` 执行同一 suite 后为 66/66；该错误调用不作为代码 Gate PASS，也未被隐藏。

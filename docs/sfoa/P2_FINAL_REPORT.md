# P2 Final Report — Remote MCP Runtime & Tool Governance

Date: 2026-08-22

Final status: **P2 = PASS / COMPLETE — AWAITING FINAL MAINTAINER ACCEPTANCE**

Baseline: **P2-BL-1.2**

P3 status: **NOT STARTED**

Closure amendment: **P2-CLOSURE HOTFIX01 = PASS**. The executable dx-core inventory and three remote Tool contracts are now guarded against upstream name, ReleaseState, schema, requiredness, and version drift. ADR-0007 supersedes ADR-0006's open-ended schema projection. See `P2_CLOSURE_HOTFIX01_REPORT.md` for the implementation and final evidence.

## Executive Summary

P2 promotes the P1-proven request identity chain into a separate production-oriented remote Host without reopening the accepted identity design:

```text
controlled MCP client
  -> stateless Streamable HTTP
  -> Internal Bearer authentication
  -> authenticated platformUserId Header
  -> P1 IdentityResolver
  -> fresh JWT / request-scoped Connection
  -> registration-time Tool governance
  -> remote schema facade
  -> unchanged official Salesforce Tool.exec()
```

The new `@sfoa/mcp-server` passed configurable network binding, client authentication, Header-authoritative identity, default-deny/read-only Tool visibility, remote schema adaptation, body/request/Tool bounds, cleanup, graceful shutdown, two real Salesforce users, 50 interleaved requests, project-local MCP Inspector, official Tool execution, and all required P0/P1/root regressions.

HOTFIX01 additionally passed the real pinned Provider inventory Gate and 18/18 P2 tests. Unknown Tools remain invisible and uncallable; unknown official input fields cannot enter an Agent schema; enabled-contract drift fails startup with `MCP_UPSTREAM_TOOL_CONTRACT_DRIFT`.

P2 introduces no DML, mutation/admin exposure, OAuth Server, Admin UI, database, Redis, token cache, Connection pool, or Salesforce CLI runtime dependency. It changes zero official Salesforce TypeScript files and leaves root `package.json`/`yarn.lock` unchanged.

## Git State

- P1 accepted branch: `feature/p1-request-scoped-identity`.
- P1 accepted commit on `main`: `3d35ef6`.
- P1 merge method: fast-forward without squash; `origin/main` was pushed before P2 branch creation.
- P2 branch: `feature/p2-remote-runtime-governance`, created from updated `main`.
- P2 commits before this closure report:
  - `2d929e1 docs: enter P2 remote runtime phase`
  - `4bf3e41 feat: add governed remote MCP runtime`
  - `1256b65 fix: align official tool inventory`
  - `47dae01 docs: define P2 remote runtime contracts`
- The commit containing this report is the P2 closure/evidence commit.
- Remote branch target: `origin/feature/p2-remote-runtime-governance`.

No commit squashes P0/P1 history. No P2 work was committed on the accepted P1 branch.

## Architecture

P2 adds `packages/sfoa-mcp-server` and keeps `packages/sfoa-identity-runtime` as the P1 identity/request-scope foundation. The P1 validation Host is not promoted as the production Host.

The formal Host uses public APIs only:

- MCP SDK 1.18.2 `McpServer` and stateless `StreamableHTTPServerTransport`;
- Salesforce Provider API 0.6.0 `McpTool.getConfig()`/public Tool contracts;
- dx-core Provider 0.10.0;
- `@salesforce/core` 8.29.0 direct JWT/Connection;
- Zod 3.25.76.

Every POST owns a fresh Salesforce Connection, workspace, Provider Tool graph, MCP server, and transport. Response lifecycle—not just `handleRequest()` resolution—controls cleanup. This closes a concurrency race discovered by the P2 integration test: SDK 1.18.2 may return from `handleRequest()` before an asynchronous Tool response is finished.

Current decisions are ADR-0005 and ADR-0007; ADR-0007 supersedes ADR-0006's open-ended schema projection. ADR-0004 already existed from P0, so P2 preserved numbering history rather than overwriting it.

## Remote Runtime

Package: `@sfoa/mcp-server`.

Local commands:

```powershell
yarn workspace @sfoa/mcp-server build
yarn workspace @sfoa/mcp-server start
```

Defaults:

```text
MCP URL   http://127.0.0.1:8080/mcp
Health    http://127.0.0.1:8080/health
Readiness http://127.0.0.1:8080/ready
```

Configurable values:

```text
MCP_BIND_HOST
MCP_PORT
MCP_PATH
MCP_ALLOWED_HOSTS
MCP_ALLOWED_ORIGINS
```

LAN is opt-in:

```powershell
$env:MCP_BIND_HOST = '0.0.0.0'
$env:MCP_ALLOWED_HOSTS = '<local-ip>:8080'
yarn workspace @sfoa/mcp-server start
```

Then use `http://<local-ip>:8080/mcp`. The runtime never defaults to public listening. Non-loopback requires an exact allowed Host and active Bearer authentication.

`GET /health` checks process/runtime liveness. `GET /ready` checks loaded configuration, valid Tool policy, and initialized Provider inventory. Neither endpoint creates a JWT or calls Salesforce.

## Authentication

P2 uses:

```http
Authorization: Bearer <MCP_CLIENT_TOKEN>
```

`InternalBearerAuthenticator` hashes both tokens with SHA-256 and compares equal-length digests using `timingSafeEqual`. It never logs or returns the token.

Live results:

| Scenario | Result |
| --- | --- |
| No Bearer | HTTP 401 / `MCP_CLIENT_AUTH_REQUIRED`, BLOCKED before JWT |
| Wrong Bearer | HTTP 401 / `MCP_CLIENT_AUTH_INVALID`, BLOCKED before JWT |
| Correct Bearer, no platform user | HTTP 401 / `MCP_PLATFORM_USER_REQUIRED`, BLOCKED before JWT |
| Correct Bearer, unknown platform user | HTTP 403 / `MCP_IDENTITY_ROUTE_NOT_FOUND`, no fallback/JWT |
| Correct Bearer + User A | PASS |
| Correct Bearer + User B | PASS |

`MCP_AUTH_MODE=disabled` is supported only for `127.0.0.1`, `localhost`, or `::1`; disabled auth with `0.0.0.0`/non-loopback fails startup.

P2 intentionally does not build a complex OAuth authorization server. The shared Bearer authenticates the controlled MCP client; a future public-client/SSO gateway must derive and overwrite platform identity from a trusted authenticated claim.

## platformUser Contract

Default authoritative Header:

```http
X-Platform-User-Id: <platform user>
```

The Header name can be changed with `MCP_PLATFORM_USER_HEADER`. It is accepted only after Bearer authentication. The Host does not read Salesforce identity from:

- Tool `usernameOrAlias`;
- JSON-body `platformUserId`;
- query parameters;
- Salesforce username Headers;
- client-provided directory.

An optional `X-Correlation-Id` is observability-only. A/B live forgery tests placed the opposite `platformUserId`, `usernameOrAlias`, and `directory` in Tool arguments; the registered Zod shape stripped them and the Connection remained on the authenticated Header route. Both directions were BLOCKED from changing identity.

## Tool Governance

`ToolGovernancePolicy` separates official Provider availability from SFoA Agent visibility. P2 classification is explicit code, not runtime name inference:

```text
READ          configurable
METADATA_READ configurable
MUTATION      forbidden
ADMIN         forbidden
LOCAL_DEV     forbidden for remote Host
UNKNOWN       forbidden
```

Registration is default-deny. Only enabled, present, compatible, phase-allowed Tools are registered; therefore disabled Tools do not appear in `tools/list`.

Startup tests:

- enabled read Tool -> PASS;
- disabled official Tool -> invisible;
- `unknown_tool` -> startup `MCP_TOOL_NOT_AVAILABLE`;
- `deploy_metadata` -> startup `MCP_TOOL_DISABLED`;
- duplicate/invalid Provider policy -> fail closed.

No mutation/admin Tool is callable in P2. No CREATE/UPDATE/DELETE provider or Tool exists.

## Official Provider Inventory

`OFFICIAL_PROVIDER_INVENTORY.md` records eight official Provider families, their exact/grouped Tools, purpose, remote compatibility, filesystem/project/service dependencies, read/write nature, and P2 decision.

P2 initializes only the verified dx-core 0.10.0 Provider. Code Analyzer, LWC/Aura Experts, Mobile Web, DevOps, Scale Products, and Metadata Enrichment are inventoried future seams and remain denied. Their presence does not grant visibility.

The inventory source audit corrected two current Code Analyzer names (`create_custom_rule`, `get_ast_nodes_to_generate_xpath`) and removed one absent LWC legacy name. The executable catalog test prevents duplicates and covers these audited names.

## Remote Tool Schema Decision

Facade feasibility Gate: **PASS / IMPLEMENTED**.

Analysis confirmed that public `McpTool.getConfig()` exposes the raw Zod shape and MCP SDK `McpServer.registerTool()` accepts a derived raw shape. `RemoteToolFacade` can omit host-owned fields and inject them before delegation without official source changes or copied Tool implementation.

| Tool | Agent supplies | Host injects | P2 default |
| --- | --- | --- | --- |
| `get_username` | optional non-directory official inputs | `directory` | Enabled |
| `run_soql_query` | `query`, `useToolingApi` | `usernameOrAlias`, `directory` | Enabled |
| `retrieve_metadata` | manifest/source options | `usernameOrAlias`, `directory` | Disabled |

The Agent no longer needs to send either `usernameOrAlias` or `directory`. Core execution remains unchanged official `Tool.exec()` through the P1 adapter; SOQL/metadata/API/error parsing is not reimplemented.

## Enabled Tools

Default:

```text
get_username
run_soql_query
```

Live and Inspector `tools/list` returned exactly these two names.

## Disabled Tools

- `retrieve_metadata`: AVAILABLE facade, DISABLED BY DEFAULT. P1 proved official reuse, but it remains a developer Tool requiring DX project, manifest/source, filesystem writes, and CWD serialization. P4 may build a true Diagnosis Context instead of treating it as a general Agent default.
- `deploy_metadata`: MUTATION, forbidden.
- permission assignment, org creation/deletion/snapshot/test/admin Tools: ADMIN, forbidden.
- local org/open/code-analysis/LWC/Aura/mobile/scale/enrichment Tools: LOCAL_DEV, forbidden.
- DevOps mutations: MUTATION, forbidden; even DevOps reads need additional service/auth compatibility and remain unavailable.
- unknown future Tools: deny/fail startup until inventoried.

## Runtime Limits

Defaults:

```text
MCP_MAX_BODY_BYTES=1048576
MCP_REQUEST_TIMEOUT_MS=60000
MCP_TOOL_TIMEOUT_MS=120000
```

Body length is checked from `Content-Length` when present and while streaming. Oversize returns HTTP 413 / `MCP_REQUEST_TOO_LARGE` before Connection creation. Invalid method/content type/JSON and exact Host/Origin checks return stable bounded errors.

Host/Origin rejection precedes Bearer/platform/JWT. `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` are exact lists; wildcard Host is rejected. Non-browser clients may omit Origin.

## Timeout

- Tool timeout test: controlled official-contract Tool exceeded 30 ms; result was Tool-level `isError: true` containing `MCP_TOOL_TIMEOUT`; workspace active count returned to zero; cleanup failures 0.
- Request timeout test: controlled Tool exceeded 40 ms; HTTP client received 504 / `MCP_REQUEST_TIMEOUT`; workspace created=cleaned; cleanup failures 0.

The Host first writes the stable request-timeout response, then closes transport/server/workspace. It stops waiting and aborts local setup where possible. `@salesforce/core`/the official Tool path cannot guarantee cancellation of a Salesforce operation already accepted server-side, and P2 reports this limitation accurately.

## Graceful Shutdown

SIGINT and SIGTERM install one idempotent shutdown path:

1. mark not ready and stop accepting new requests;
2. close idle connections;
3. wait for active request promises up to the configured controlled bound;
4. force-close remaining HTTP connections only after that bound;
5. rely on idempotent request resource cleanup;
6. set `process.exitCode`; never immediately call `process.exit()`.

Tests passed both an in-flight Tool drain and a real SIGTERM event hook. Logs reported `STARTED` then `DRAINED`.

## Runtime Logging

JSON-line events include timestamp, correlation ID, optional platform user/Salesforce username, non-secret client ID, Tool name, duration, result, and stable error code. P2 deliberately excludes Bearer, Salesforce access token, JWT assertion, private-key data, full Tool inputs/results, and Salesforce Records.

No audit database is introduced.

## User A Result

PASS: direct identity, Remote initialize, enabled-only tools/list, official get_username, official bounded SOQL, Header authority, cleanup.

## User B Result

PASS: direct identity, Remote initialize, enabled-only tools/list, official get_username, official bounded SOQL, Header authority, cleanup.

No actual usernames, Salesforce User IDs, Org IDs, access tokens, or Records are persisted in this report.

## Concurrency / Load Result

Fifty real read-only `get_username` requests ran in five interleaved A/B batches of ten to exercise concurrency without stress-attacking SFoA.

| Metric | Result |
| --- | ---: |
| Requests | 50 |
| User A requests | 25 |
| User B requests | 25 |
| Identity mismatch | 0 |
| Cross-user leak | 0 |
| Workspace leak | 0 |
| Resource cleanup failure | 0 |
| Connection reuse | 0 |
| Error count | 0 |
| p50 | 1048.34 ms |
| p95 | 1147.25 ms |

All request Connections and workspace roots were unique; active workspace count returned to zero.

## Inspector Result

Project-local MCP Inspector 0.15.0 proxy passed:

- initialize;
- tools/list with enabled Tools only;
- get_username tools/call for User A;
- get_username tools/call for User B.

The automated Gate used Inspector's built-in Streamable HTTP proxy and custom Header forwarding. It did not install a global Inspector or upgrade the pinned project dependency.

## Performance

Latest live sample:

| Operation | n | p50 | p95 |
| --- | ---: | ---: | ---: |
| 50-request load call | 50 | 1048.34 ms | 1147.25 ms |
| initialize | 4 | 1354.90 ms | 1673.39 ms |
| tools/list | 4 | 626.00 ms | 853.42 ms |
| get_username | 52 | 1042.83 ms | 1147.25 ms |
| run_soql_query | 4 | 952.72 ms | 1075.28 ms |
| JWT/Connection creation | 72 | 872.98 ms | 1083.08 ms |

The sample is sufficient to quantify the fresh-JWT cost while staying bounded. It does not prove a cache is necessary. P2 retains fresh JWT/Connection per request and implements no token cache, Connection cache/pool, or Redis. Any future cache requires sustained production evidence, identity-keyed/expiry-aware design, isolation tests, and explicit maintainer approval.

## CLI Dependency

Production Salesforce CLI dependency: **NONE**.

P2 uses direct JWT through `@salesforce/core`. Static source/dependency tests reject CLI/Auth Cache/child-process usage in production. The project-local MCP Inspector child process exists only in a validation script and is not a production runtime dependency.

The original official stdio regression independently passed initialize, five-Tool list, and get_username call.

## Database Decision

Database: **NONE**.

P2 continues `IdentityRepository` + `InMemoryIdentityRepository`. There is no MySQL, PostgreSQL, Prisma, Drizzle, Redis, session store, audit DB, token cache, or Connection pool. Persistence remains deferred until durable routing/Admin management proves it is required.

## Official Code Diff

- Official Salesforce TypeScript modified by P2: **0**.
- Root `package.json` modified: **NO**.
- `yarn.lock` modified: **NO**.
- Official Tool implementation copied/reimplemented: **NO**.
- Official stdio behavior retained: **PASS**.

P2 changes only new/existing SFoA-owned package/docs/config paths. `UPSTREAM_STRATEGY.md` records the zero-patch result and LOW merge-risk target.

## Build / Test / Lint

| Gate | Result |
| --- | --- |
| P2 build | PASS |
| P2 tests | PASS, 18/18 |
| P2 upstream compatibility | PASS, zero drift |
| P2 strict lint | PASS |
| P1 tests | PASS, 22/22 |
| P1 strict lint | PASS |
| P1 live A/B | PASS |
| P0 Runtime tests | PASS, 9/9 |
| P0 live Closure | PASS |
| P0 Streamable HTTP POC | PASS, 1/1 |
| Original Salesforce stdio | PASS |
| Root build | PASS, 94.94 s |
| Root full tests | PASS, 325.05 s |
| SFoA changed-code lint | PASS |
| Repository-wide lint | KNOWN UPSTREAM DEBT: exactly 47 errors / 0 warnings, all unchanged official code-analyzer |

`yarn install --frozen-lockfile` reproduced the recorded Windows Yarn Classic nested `brace-expansion` link failure; `yarn.lock` remained unchanged. That failed install removed generated `.bin` shims. The shims were mechanically regenerated from the already installed packages' `package.json#bin` using the local npm `cmd-shim`; source and lockfile remained unchanged. Root build, root tests, stdio, and targeted Gates then passed. This remains installation/Upstream maintenance debt, not a P2 code waiver.

## Known Risks

1. The internal Bearer authenticates a controlled MCP client, not the individual human. Dynamic per-user Header mapping in deployed Dify/WorkBuddy must be verified or enforced by a trusted gateway.
2. Fresh JWT/Connection is the dominant measured latency component. No cache is added; revisit only from sustained evidence.
3. Salesforce server-side operations cannot be guaranteed aborted after a local timeout. P2 is read-only and reports the limitation.
4. Official metadata Tools call global `process.chdir()`. P1 serialization/restore remains in place; `retrieve_metadata` is default-off remotely.
5. Windows Yarn Classic frozen reinstall can remove generated shims before failing. This is reproducible environment debt; dependency versions/package manager remain frozen in P2.
6. Dify and WorkBuddy end-to-end real-Agent evaluation is P6, not a P2 PASS Gate. Their exact installed versions and dynamic Header behavior require client-side verification.

## Agent Connection Status

### Generic MCP client

Ready now: configure Streamable HTTP URL plus static `Authorization` and `X-Platform-User-Id`. This exact path passed SDK and Inspector Gates.

### Dify

Official current source supports stored static arbitrary MCP headers. For immediate P2 testing, create separate controlled A/B MCP provider configurations with static platform Headers. Dynamic workflow/user-variable interpolation into MCP Headers remains **NEEDS CLIENT-SIDE VERIFICATION**; an open July 2026 Dify feature request says it is not currently available.

### WorkBuddy

Official Tencent Cloud material demonstrates WorkBuddy-compatible Streamable HTTP `url` plus Bearer `headers`. Test separate A/B static configurations first. Acceptance of the custom platform Header in the exact deployed build and dynamic per-user mapping remain **NEEDS CLIENT-SIDE VERIFICATION**.

The complete instructions and official-source links are in `P2_AGENT_CONNECTION.md`. Full multi-step Agent evaluation remains P6.

## P2 Final Gate

```text
Remote Streamable HTTP Host                 PASS
configurable network binding                PASS
client bearer auth                          PASS
platformUser identity                       PASS
Tool Governance                             PASS
upstream inventory exact match              PASS
remote contract drift fail-closed           PASS
disabled Tool invisible                     PASS
Mutation/Admin Tool forbidden               PASS
request bounds                              PASS
timeout/cleanup                             PASS
graceful shutdown                           PASS
A/B isolation                               PASS
50 request zero-leak                        PASS
Inspector                                   PASS
SFoA official Tool                          PASS
Salesforce CLI runtime dependency           NONE
Database dependency                         NONE
Official Salesforce TypeScript changes      0
P2 build/test/strict lint                    PASS
P0/P1/root regressions                       PASS
```

Final determination: **P2 = PASS / COMPLETE — AWAITING FINAL MAINTAINER ACCEPTANCE**. **P2-CLOSURE HOTFIX01 = PASS**.

## P3 Recommendation

Do not start P3 until the maintainer accepts this report. After authorization:

1. Re-run the P2 read-only/A-B isolation baseline before mutation work.
2. Follow Upstream First: look for an existing official generic data capability; otherwise extend the public Provider API and official `@salesforce/core` data APIs with one minimal SFoA mutation Provider.
3. Expose CREATE and UPDATE only. Do not expose DELETE.
4. Require explicit object and operation allowlists; missing/empty configuration means DENY at startup and call time.
5. Reuse the authenticated P2 `RequestScope`; never accept Salesforce username, access token, or platform identity in Tool input.
6. Let Salesforce remain authoritative for CRUD, FLS, sharing, validation, Flow, Trigger, and native permissions. Do not build a parallel permission engine.
7. Define constrained Zod input/output schemas, structured content, stable action-oriented snake_case names, complete annotations, bounded results, and redacted Tool-level errors.
8. Add tests for A/B CREATE/UPDATE isolation, object/operation deny, absent-config deny, FLS/CRUD authorization failure, validation/Trigger errors, timeout/cleanup, idempotency semantics, and explicit DELETE absence.
9. Keep database/cache absent unless durable routing/allowlist administration or sustained latency evidence creates a separate reviewed requirement.
10. Add/supersede an ADR for the exact DML API/provider and allowlist contract before implementation is declared complete.

Maintainer choices required before P3 implementation: first allowed objects, CREATE/UPDATE operation matrix, allowlist configuration source, and audit-retention expectations. P2 does not decide or implement them.

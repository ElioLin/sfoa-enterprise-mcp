# P1 Final Report — Request-Scoped Salesforce Identity Routing & Multi-User Isolation

Status: **P1 = PASS / COMPLETE — AWAITING MAINTAINER REVIEW**

Report date: 2026-08-22

Audited Salesforce Upstream commit: `670234dbdca4d3fcdebd9d58b231e311fd34aeec`

## Executive Summary

P1 implements and validates the identity chain `platformUserId -> Salesforce username -> fresh JWT -> request-scoped Connection -> unchanged official Salesforce Provider Tool`. Two real Salesforce users passed direct identity and official Tool execution. Bidirectional username forgery, unknown routes, and missing platform identity were denied before unintended authentication or Salesforce access. Twenty interleaved A/B requests completed with zero identity mismatch, zero cross-user leak, and zero Connection reuse. Two concurrent official metadata operations were isolated by request workspaces and the exclusive CWD guard.

The implementation is a new SFoA-owned composition package. It introduces no database, Redis, Salesforce CLI runtime dependency, token cache, Connection pool, DML, DELETE, Admin UI, or Tool Governance. It modifies zero official Salesforce TypeScript files. P2 has not started.

## Git / Upstream State

| Item | Result |
| --- | --- |
| P0 Closure acceptance | Commits `32469cd`, `d90163f`, and `e80d9fd` were fast-forwarded to `main` without squash and pushed to `origin/main` |
| P1 branch | `feature/p1-request-scoped-identity`, created from the accepted `main` |
| P1 implementation commits | `ca97bce`, `79d3193`, `7b6cdf6`, `849c912`, `746e018` plus the closing documentation commit containing this report |
| Company remote | `origin = https://github.com/ElioLin/sfoa-enterprise-mcp.git` |
| Official remote | `upstream = https://github.com/salesforcecli/mcp.git` |
| Audited Upstream | `670234dbdca4d3fcdebd9d58b231e311fd34aeec` |
| Dependency upgrades | None |
| Root manifest/lock changes in P1 | None: root `package.json`, `yarn.lock`, and `.env.example` are unchanged from P0 Closure |

P1 retains the verified versions: MCP SDK 1.18.2, Provider API 0.6.0, dx-core 0.10.0, `@salesforce/core` 8.29.0, Zod 3.25.76, Node 24.13.0, and Yarn Classic 1.22.22.

## P1 Architecture

The new private workspace is `packages/sfoa-identity-runtime`. It composes only public official contracts and Provider packages:

```text
POST /mcp + trusted X-Platform-User-Id
  -> immutable RequestContext
  -> IdentityResolver
  -> IdentityRepository
  -> SalesforceIdentityRoute
  -> JwtConnectionFactory
  -> RequestScopedOrgService / RequestScopedServices
  -> new DxCoreMcpProvider
  -> RequestScopedToolExecutionAdapter
  -> unchanged official Tool
  -> SFoA
```

Every HTTP POST owns its Connection, workspace, OrgService, Services, Provider/Tools, MCP server, and Streamable HTTP transport. Response finish/close triggers idempotent cleanup. Identity does not live in process-global mutable state.

## Request Context

`RequestContext` is a frozen read-only value containing:

- `platformUserId`: trimmed, 1–128 characters, no control characters;
- `correlationId`: a safe supplied `X-Correlation-Id` or `crypto.randomUUID()`;
- `workspaceRoot`: an absolute request-owned directory created by the server.

Missing/blank platform identity returns `MCP_PLATFORM_USER_REQUIRED`. Invalid values fail without fallback. P1 treats the Header as trusted internal context only; client/platform authentication is a P2 responsibility.

## Identity Repository

`IdentityRepository.findByPlatformUserId()` is the persistence boundary. P1 uses `InMemoryIdentityRepository` with two routes loaded from ignored local configuration:

```text
p1-user-a -> SALESFORCE_USERNAME
p1-user-b -> SECOND_TEST_USER
```

Routes contain the platform ID, Salesforce username, credential-profile reference, allowed current-route aliases, and `ConnectionRole`; they never contain private-key text. Duplicate platform IDs and cross-route aliases are rejected. A future persistent repository can replace the in-memory implementation without changing the resolver, OrgService, or official Provider.

## Identity Resolver

`IdentityResolver` performs exactly one operation: resolve a normalized `platformUserId` through the repository. An absent route returns stable `MCP_IDENTITY_ROUTE_NOT_FOUND`. There is no default-user, admin-user, first-route, or `SALESFORCE_USERNAME` fallback.

## JWT Connection Factory

`JwtConnectionFactory` uses the P0-proven direct production path:

```text
route.salesforceUsername
  + SFOA_INSTANCE_URL
  + CONNECTED_APP_CLIENT_ID
  + JWT_PRIVATE_KEY_PATH
  -> AuthInfo.create({ oauth2Options })
  -> Connection.create({ authInfo })
```

It creates a fresh Connection per request scope. It does not spawn `sf`, read the Salesforce CLI Auth Cache, expose Token responses, or cache access/refresh Tokens. Authentication and Connection failures map to stable redacted error codes. The reserved `DIAGNOSTIC` role is rejected before authentication in P1.

## Request-Scoped OrgService and Services

Each `RequestScopedOrgService` contains exactly one resolved route and one Connection. `getConnection(usernameOrAlias)` accepts only that route's Salesforce username or an alias owned by the same route; all other values return `MCP_IDENTITY_CONTEXT_MISMATCH`.

`RequestScopedServices` supplies the official Provider API's `OrgService`, `ConfigService`, and no-op telemetry service for that one request. No global allowed-user collection, mutable current username, or process Cache is used.

## Official Provider Integration

For each POST, P1 creates `new DxCoreMcpProvider()` and calls `provideTools(requestScopedServices)`. It selects exactly these official GA Tools:

1. `get_username`
2. `run_soql_query`
3. `retrieve_metadata`

Their names, schemas, descriptions, and implementations remain official and unchanged. Identity and filesystem authority are enforced at the host/Services/execution-adapter boundaries.

The adapter treats Tool `usernameOrAlias` as non-authoritative, overrides `directory` with the request workspace, bounds `manifest`/`sourceDir` to that workspace, applies the CWD guard, redacts errors/results, and emits only the approved structured log fields.

## User A Result

**PASS.** The A platform route resolved to the locally configured primary Salesforce username. Fresh JWT/Connection creation succeeded; `Connection.identity()` matched the route. Official `get_username` and safe official `run_soql_query` succeeded. The real username, user/org identifiers, Token, and records are not persisted in this report.

## User B Result

**PASS.** `SECOND_TEST_USER` was explicitly consumed, used to construct the B route, and exercised against SFoA. Fresh JWT/Connection creation succeeded; `Connection.identity()` matched the B route. Official `get_username` and safe official `run_soql_query` succeeded. No real B identity value is committed.

This corrects the P0 input record without rewriting history: the maintainer had supplied `SECOND_TEST_USER`, but the P0-Closure loader did not consume it, so P0 legitimately did not execute a second user. P1 performed the missing mandatory live Gate.

## Forgery Tests

| Test | Result | Pre-call proof |
| --- | --- | --- |
| Header A + Tool username B | BLOCKED with `MCP_IDENTITY_CONTEXT_MISMATCH` | B Connection-audit count did not increase |
| Header B + Tool username A | BLOCKED with `MCP_IDENTITY_CONTEXT_MISMATCH` | A Connection-audit count did not increase |
| Unknown platform ID | BLOCKED with HTTP 403 / `MCP_IDENTITY_ROUTE_NOT_FOUND` | Total Connection-audit count did not increase |
| Missing platform Header | BLOCKED with HTTP 401 / `MCP_PLATFORM_USER_REQUIRED` | Total Connection-audit count did not increase |
| Arbitrary or other-route alias | BLOCKED by adapter/OrgService tests | Official Tool is not invoked for the forged target |

## Concurrency Results

The live harness sent 20 interleaved A/B official `get_username` requests. Each request scope also performed server-side `Connection.identity()` auditing.

| Metric | Result |
| --- | --- |
| Requests | 20 |
| Identity mismatch | 0 |
| Cross-user leak | 0 |
| Unknown Connection reuse | 0 |

Any non-zero value would have made P1 FAIL; no warning downgrade is permitted.

## Metadata / CWD Isolation

Two official `retrieve_metadata` calls were started concurrently. Both completed successfully, while `CwdExecutionGuard` recorded two exclusive executions and `maxConcurrentExclusive = 1`. The guard captured the prior process CWD, ran the official Tool under an exclusive host-wide lock, restored CWD in `finally`, and then released the lock.

Source-audited `get_username` and `run_soql_query` calls use the shared side of the guard because they do not consult CWD after their initial official `chdir`; metadata remains serialized in P1. This preserves useful read concurrency without pretending the global side effect is safe.

## Workspace Isolation

`RequestWorkspaceFactory` creates a unique OS temporary root per POST, validates every resolved path against that root, creates the minimal DX project/package structure, optionally writes the configured manifest, and removes only that root during cleanup. The concurrent metadata Gate observed two distinct roots, no manifest/workspace crossover, zero active roots after responses, and both filesystem roots absent after cleanup.

Client `directory` is always overridden. Relative `manifest`/`sourceDir` values must remain within the request root; absolute/outside paths are denied.

## Error Contract and Logging

Stable codes include:

- `MCP_PLATFORM_USER_REQUIRED`
- `MCP_IDENTITY_ROUTE_NOT_FOUND`
- `MCP_IDENTITY_CONTEXT_MISMATCH`
- `MCP_SALESFORCE_AUTH_FAILED`
- `MCP_SALESFORCE_CONNECTION_FAILED`
- `MCP_REQUEST_WORKSPACE_FAILED`
- `MCP_REQUEST_SCOPE_FAILED`
- `MCP_CONNECTION_ROLE_NOT_AVAILABLE`

Runtime JSON-line logs go to stderr and contain only correlation ID, platform ID, allowed Salesforce username, Tool name, duration, result, and error code. They omit access Tokens, assertions, private keys, full Tool results, and business records. Regression tests also prove unreadable private-key errors do not expose the configured path.

## CLI Dependency Result

`Salesforce CLI Used = NO` for the P1 runtime and validator. Production source has no `child_process`, `spawn('sf')`, CLI Auth Cache, or `sf org login` dependency. The CLI remains a separate P0 development diagnostic only.

## Database Decision

`Database Used = NO`. P1 installs no MySQL, PostgreSQL, Prisma, Drizzle, Redis, ORM, persistent identity store, Token cache, or Connection pool. This is deliberate: the Gate proves the replaceable request identity boundary before choosing persistence infrastructure.

## Build / Test / Lint

| Gate | Result |
| --- | --- |
| P1 build | PASS |
| P1 tests | PASS — 22/22 |
| P1 strict TypeScript lint | PASS |
| P1 live two-user validation | PASS — all mandatory Gates, 20 requests |
| Root build | PASS — all workspaces, 109.31 s |
| Root tests | PASS — all workspaces, 306.46 s |
| P0 runtime tests | PASS — 9/9 |
| P0 live runtime validation | PASS |
| P0 Streamable HTTP regression | PASS — 1/1 |
| Original stdio initialize/list/call | PASS — five Tools, official `get_username` response withheld |
| SFoA changed-code lint | PASS |
| Repository-wide lint | KNOWN UPSTREAM DEBT — root command stops on the same 47 official code-analyzer errors, 0 warnings |

The unchanged Windows Yarn Classic issue remains: a frozen reinstall can fail during nested `brace-expansion` linking and remove generated workspace `.bin` shims before aborting. `yarn.lock` remained unchanged. Final verification restored only the ignored generated shims needed by the installed packages; the root build and full root test then passed. This is recorded as environment/Upstream maintenance debt, not waived as an SFoA lint or test error.

## Upstream Modifications

P1 official Salesforce TypeScript modifications: **0**.

P1 changes are new `packages/sfoa-identity-runtime` files and SFoA documentation. No existing official package path, root manifest, lockfile, or `.env.example` changed in P1. Across the full SFoA fork, `.gitignore` remains the only audited Upstream-tracked integration-file modification and is already recorded in `UPSTREAM_STRATEGY.md`. Merge-risk target remains **LOW**.

## Known Risks

| Risk | Current containment | Next decision point |
| --- | --- | --- |
| Trusted Header is not end-user authentication | Loopback/internal P1 POC only; resolver remains authoritative | P2 authenticated gateway claim/token binding |
| Global `process.chdir()` | Shared/exclusive guard; metadata serializes and restores | Measure P2/P4 load before worker/process isolation |
| Fresh JWT/Connection per POST | Correct, deterministic, zero reuse/leak | Measure latency before any identity-keyed expiry-aware cache |
| In-memory route repository | Simple, replaceable, no secret duplication | Add persistence only for durable routing/Admin needs |
| Stateless per-POST Provider/server construction | Strong cleanup/isolation | Load-test before pooling; never pool mutable user identity casually |
| Provider release drift | Exact extension versions pinned and both transports regressed | Repeat compatibility matrix on any independent upgrade |
| Windows Yarn Classic link debt | Lockfile preserved; package/root Gates verified from local dependencies | Repair installer workflow separately; do not mix with identity code |
| `DIAGNOSTIC` misuse | Role is reserved but rejected in P1 | P4 fixed diagnostic user; prohibit business SOQL/query/CREATE/UPDATE |

## P1 Final Gate

`P1 = PASS`

All mandatory requirements are satisfied:

- real A→A and B→B Salesforce identity proof;
- official identity and read-only SOQL Tools for both users;
- bidirectional forged username denial before unintended JWT/API work;
- unknown/missing identity denial without fallback;
- 20-request concurrency with zero mismatch/leak/reuse;
- official metadata CWD/workspace isolation and cleanup;
- no Salesforce CLI or database runtime dependency;
- zero official Salesforce TypeScript changes;
- SFoA-owned build/test/lint and required P0/transport regressions pass.

P2 is explicitly not authorized by this result alone. Await maintainer review.

## P2 Recommendation

After explicit maintainer approval, P2 should productionize the remote host and Tool-governance boundary without reopening P1 identity semantics:

1. Replace the trusted test Header with an authenticated gateway-issued subject/claim. Normalize it once into the same immutable `platformUserId`; never accept Tool username as authority.
2. Add production HTTP controls: TLS/reverse-proxy contract, body/time bounds, cancellation, backpressure, host/origin/content-type enforcement, connection lifecycle, graceful shutdown, and per-identity rate limiting.
3. Add an explicit Tool allow/deny policy at host registration/execution. Start with the proven read-only Tool set. Do not implement P3 CREATE/UPDATE or DELETE in P2.
4. Define minimal audit events using the existing redacted log contract and correlation IDs. Do not log Tokens, assertions, private keys, full Tool results, or Salesforce business records.
5. Run protocol/security/load tests for malformed input, authorization failure, shutdown, cancellation, timeout, cleanup, A/B isolation under load, and metadata contention.
6. Measure fresh-JWT and per-POST Provider/workspace cost. Add an expiry-aware cache or isolated metadata workers only if data demonstrates the need and the cache key includes the authoritative identity boundary.
7. Keep `IdentityRepository` replaceable. Add durable storage only if production routing management requires it; database adoption must not alter the resolver/OrgService/Provider contracts.
8. Preserve the official stdio entry and exact Provider compatibility tests. Keep official Tool patches at zero unless a separately reviewed, evidence-backed Upstream change is unavoidable.
9. Keep `DIAGNOSTIC` unimplemented until P4. Its eventual fixed Integration User must be blocked from business SOQL, record queries, CREATE, and UPDATE.

No P2 implementation is included in this branch.

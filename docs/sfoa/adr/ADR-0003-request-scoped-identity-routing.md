# ADR-0003: Request-Scoped Salesforce Identity Routing

- Status: Accepted as P1 design baseline; implementation deferred to P1
- Date: 2026-08-22

## Context

The official server accepts `--orgs` at process startup, stores allowed org values in a singleton Cache, creates one Services object, and captures it in Tool instances. Many Tools change the process working directory. A remote server must concurrently serve platform users without allowing a request to select another user's Salesforce connection.

## Decision

Build a new Streamable HTTP host that authenticates the platform request and resolves `platformUserId` before Tool execution. For each stateless MCP request, create a request context, request-scoped `OrgService`, provider Tool instances, and MCP server. The OrgService resolves the configured Salesforce username/credential reference and supplies the Connection.

Do not use the upstream `--orgs` Cache as the remote authorization boundary.

Until official Tools stop mutating process CWD, wrap Tool execution in a global async mutex that captures, sets, and restores the working directory. Use a fixed runtime workspace for non-metadata Tools. Evaluate isolated child-process workers for concurrent metadata operations.

## Required flow

```text
authenticated HTTP request
  -> platformUserId
  -> IdentityResolver
  -> Salesforce username + credential reference
  -> JWT/OAuth TokenProvider
  -> request-scoped Connection
  -> official Provider Tool
```

## Consequences

- Identity cannot be changed merely by altering `usernameOrAlias` in a Tool call.
- Official Provider Tools remain reusable and unpatched.
- Stateless HTTP scaling is possible after external identity/config storage is introduced.
- The initial global CWD mutex limits concurrent Tool throughput.
- Metadata may require process isolation or an Upstream-safe directory adapter later.

## Alternative: per-user child-process pool

Map each platform identity to an isolated worker process that hosts official Tools. This naturally isolates Cache and CWD and supports parallelism across users, but increases memory, startup latency, supervision, eviction, and test complexity. Retain it as the fallback for metadata-heavy concurrency rather than the default P1 architecture.

## P1 validation

- User A and B resolve different Connections under concurrent load.
- A request cannot override its resolved username through Tool input.
- Missing mapping is DENY.
- Expired/revoked JWT yields an actionable redacted Tool error.
- CWD is restored after success, Tool error, timeout, and cancellation.

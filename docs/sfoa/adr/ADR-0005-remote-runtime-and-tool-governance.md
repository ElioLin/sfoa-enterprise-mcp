# ADR-0005: Remote Runtime and Tool Governance

- Status: Accepted for P2
- Date: 2026-08-22
- Supersedes: none
- Extends: ADR-0003 request-scoped identity routing and ADR-0004 Streamable HTTP composition

## Numbering note

The P2 brief proposed `ADR-0004-remote-runtime-and-tool-governance.md`, but ADR-0004 was already accepted in P0 for Streamable HTTP composition. Reusing that number would destroy architectural history, so this decision is ADR-0005.

## Context

P1 proved the authoritative route:

```text
platformUserId -> Salesforce username -> JWT -> request-scoped Connection -> official Tool
```

Its loopback validation Host deliberately trusted a test Header and exposed three selected Tools. Dify, WorkBuddy, and other controlled remote MCP clients need a production-oriented network host with client authentication, request bounds, stable cleanup, and a visible Tool set that is smaller than the complete official Provider inventory. P2 must remain read-only and must not introduce a database, cache, OAuth authorization server, Salesforce CLI runtime dependency, DML, or official Salesforce source patch.

## Decision

### Stateless Streamable HTTP

Create `@sfoa/mcp-server` as a separate SFoA package. Keep the official stdio command unchanged. For every `POST /mcp`, create a fresh request scope, Connection, Provider Tool set, `McpServer`, and stateless `StreamableHTTPServerTransport`; close all resources when the HTTP response finishes/closes or a timeout fires.

Stateless mode is selected because the business identity is request-scoped, the official SDK supports it without a session store, and P2 has no feature that needs server-side MCP sessions. It makes cross-request state and cross-user reuse explicit rather than implicit.

### Internal Bearer client authentication

Use `Authorization: Bearer <MCP_CLIENT_TOKEN>` for the current controlled internal-network clients. Compare SHA-256 token digests with `timingSafeEqual`; return stable 401 errors without echoing credentials. Only after Bearer success may the configured platform-user Header enter P1 `IdentityResolver`.

Do not build an OAuth authorization server in P2. OAuth/SSO would add issuer, client registration, redirect, token lifecycle, and claim-mapping infrastructure without a current public-client requirement. `MCP_AUTH_MODE=disabled` is development-only and startup-valid only on loopback.

### Registration-time default deny

Classify every inventoried official Tool explicitly as `READ`, `METADATA_READ`, `MUTATION`, `ADMIN`, `LOCAL_DEV`, or `UNKNOWN`. Register only names in `MCP_ENABLED_TOOLS` that are present in the active Provider, remote-compatible, and in a P2-allowed classification.

Do not register everything and reject later. `tools/list` is the Agent capability boundary: disabled Tools must be invisible. Unknown, incompatible, mutation, admin, and local-development configuration fails startup rather than being ignored.

Default enabled Tools are `get_username` and `run_soql_query`. `retrieve_metadata` remains composition-compatible but disabled by default because it needs a DX workspace and manifest/source context. Mutation/admin Tools remain forbidden.

### Mutations wait for P3

P2 exposes no CREATE, UPDATE, DELETE, metadata deployment, permission assignment, org administration, or DevOps mutation. P3 may add only explicit CREATE/UPDATE operations behind object/operation allowlists whose absent configuration means DENY. DELETE remains unavailable by default.

## Consequences

### Positive

- P1 identity isolation is preserved as the sole Salesforce routing authority.
- Remote clients see only the intended read-only surface.
- Health/readiness do not consume Salesforce JWTs.
- Request/body/tool timeouts, Host/Origin rejection, and auth failures occur before or within a bounded request resource lifecycle.
- No official Salesforce TypeScript file changes; Upstream sync remains low-risk.
- Future Providers can be added by inventory/classification/adapter review instead of Host redesign.

### Negative

- A shared internal Bearer authenticates the client, not an individual human. The controlled client is responsible for supplying an authentic platform-user claim until a trusted SSO gateway exists.
- Fresh JWT/Connection per request adds measurable latency.
- Stateless construction repeats Provider/server setup.
- A timed-out Salesforce SDK operation may continue server-side; P2 stops waiting and cleans local resources but cannot promise remote cancellation.

## Evidence

- P2 unit/integration tests cover authentication, startup governance, visible schemas, 413, request/tool timeouts, response-lifecycle cleanup, graceful drain, SIGTERM, and 50 interleaved A/B calls.
- Live validation passed two real identities, official `get_username` and SOQL, body-argument forgery resistance, 50-request zero-leak cleanup, and p50/p95 measurement.
- Project-local MCP Inspector 0.15.0 proxy passed initialize, tools/list, and tools/call for both users.
- Runtime dependencies contain no Salesforce CLI, database, Redis, token cache, connection pool, or DML package.

## Alternatives rejected

1. Promote the P1 test Host unchanged: rejected because it has no client authentication/governance/production configuration.
2. Add OAuth Server/SSO now: rejected as premature infrastructure for controlled internal clients.
3. Register all official Tools and reject at call time: rejected because Agents would see unsafe/unavailable capabilities.
4. Cache JWT/Connections now: rejected because measurement is required first and the observed p95 does not justify an unreviewed identity cache.
5. Patch the official Salesforce host: rejected because public Provider composition satisfies the requirement with lower merge risk.

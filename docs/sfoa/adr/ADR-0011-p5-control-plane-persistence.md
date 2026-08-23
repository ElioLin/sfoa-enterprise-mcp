# ADR-0011: P5 Control Plane Persistence and Admin Boundary

- Status: Accepted for P5 implementation
- Date: 2026-08-23
- Supersedes: ADR-0002 only for the Admin workspace location
- Extends: ADR-0002 React stack, ADR-0003 request identity, ADR-0005 Tool governance, ADR-0008 DML governance, ADR-0009 Diagnostic context, and ADR-0010 Phase-Gate waiver

## Context

P0-P4 deliberately kept routing and governance in environment or in-memory configuration while proving request isolation, remote MCP, allowlisted CREATE/UPDATE, and deterministic context. P5 is the first phase that requires human administrators to manage these values without process restarts and requires configuration changes plus runtime calls to remain durably auditable.

Environment files cannot provide optimistic concurrent editing, transactionally audited changes, bounded queryable history, schema versions, or dynamic next-request governance. A durable database is therefore now justified. The database must remain a Control Plane for SFoA-owned policy and must not become a replica of Salesforce authorization or business data.

## Decision

### Module boundary

Create three private Yarn Classic workspaces:

```text
packages/sfoa-control-plane  # contracts, MySQL, migrations, repositories, snapshots, audit
packages/sfoa-admin-api      # Admin authentication, REST API, verification, health/status
packages/sfoa-admin-web      # React Admin SPA
```

Pure DTO/schema exports used by the browser must remain free of Node-only imports. If that boundary cannot remain clean, split only the DTOs into a minimal contracts workspace rather than introducing a broad shared framework.

ADR-0002 suggested `apps/admin-web`; P5 uses the Maintainer-directed `packages/sfoa-admin-web` location so the existing `packages/*` workspace glob discovers it without adding an `apps/*` root workspace rule. The accepted React, TypeScript, Vite, Ant Design, TanStack Query, and React Router stack is unchanged.

### Persistence choice

Use MySQL 8.x with `mysql2` and Kysely when the repository-pinned dependency audit remains compatible. SQL is parameterized and isolated behind repository interfaces. A bounded MySQL pool is allowed; Salesforce Connection and token pools remain forbidden.

Versioned SQL migrations create only the tables needed now:

- `sfoa_identity_route`;
- `sfoa_tool_control`;
- `sfoa_dml_policy`;
- `sfoa_diagnostic_config`;
- `sfoa_runtime_setting`;
- `sfoa_audit_log`;
- `sfoa_schema_migration`.

MySQL may store Salesforce usernames and controlled metadata seeds, but never access/refresh tokens, JWT assertions, private-key contents/paths, passwords, Connected App secrets, MCP tokens, or raw Salesforce records.

### Authority and compatibility modes

`SFOA_CONTROL_PLANE_MODE=env|mysql` selects the authority. The default is `env` and preserves P0-P4 behavior from in-memory routes, `MCP_ENABLED_TOOLS`, `MCP_DML_ALLOWLIST_JSON`, and `SFOA_DIAGNOSTIC_USERNAME`.

In `mysql` mode, MySQL is authoritative for routes, Tool enabled state, DML policy, and Diagnostic username. Missing rows, invalid policy, unavailable database, and unknown enabled Tools fail closed. There is no environment fallback.

The executable audited Tool catalog remains the safety authority. Runtime visibility is:

```text
audited executable safe catalog
  INTERSECT database enabled state
  = actual tools/list
```

Database rows never define Tool classification, execution role, Agent/Host argument ownership, remote compatibility, release state, or upstream-drift acceptance.

### Dynamic consistency

At the start of each MCP HTTP request, load one immutable Control Plane snapshot covering the route and relevant Tool/DML/Diagnostic policy. That snapshot lives only for that request; the next request reads current database state. This gives consistent in-flight policy and restart-free changes without Redis or speculative caching.

Do not cache Salesforce Connections, JWTs, or tokens. Add a small in-process policy TTL only after measured MySQL latency proves it necessary and Maintainer review accepts the consistency tradeoff.

### Admin security

P5 does not implement enterprise SSO/OIDC. Use a bounded bootstrap Admin configured by `SFOA_ADMIN_USERNAME`, an `scrypt` password hash, and a separate `SFOA_ADMIN_SESSION_SECRET`. The API issues a signed, expiring `HttpOnly`, `SameSite=Strict` cookie; production HTTPS sets `Secure=true`.

Every Admin mutation requires an authenticated session, valid same-origin `Origin`, and CSRF token/header. Login has a bounded in-memory rate limiter. Admin responses use `Cache-Control: no-store`. Browser storage never receives Admin passwords, MCP tokens, database passwords, Salesforce credentials, session secrets, JWTs, or private-key data.

Admin/API and MCP runtime use separate listeners and authentication domains. `MCP_CLIENT_TOKEN` is never accepted as Admin authentication.

### Concurrency and audit

Every editable configuration row uses `row_version`. Updates compare the supplied version in the SQL `WHERE` clause; a mismatch returns HTTP 409 with `MCP_ADMIN_CONCURRENT_MODIFICATION`.

Admin configuration mutation and its safe audit record share one database transaction; audit failure rolls back the configuration change. Runtime Salesforce outcomes are different: if Salesforce mutation succeeds or becomes UNKNOWN and durable audit insertion then fails, the already-determined Tool outcome is preserved. The runtime falls back to its existing logger, increments/degrades audit health, never retries the Salesforce mutation, and never reports a misleading mutation failure.

Runtime audit stores bounded safe summaries. It does not store Salesforce field values, SOQL result rows, full records, authorization headers, credentials, or unrestricted metadata content.

### Salesforce boundary

Salesforce remains authoritative for CRUD, FLS, sharing, Profiles, Permission Sets, validation, Flow, Trigger, Page Layout/Record Type authorization, lookup filters, and business data. P5 configures only SFoA routes and governance. Unknown Tools, DELETE, UPSERT, MERGE, UNDELETE, Bulk DML, and permission-replica data are structurally unavailable.

## Consequences

### Positive

- Routing and governance become persistent, dynamically manageable, versioned, and auditable.
- P0-P4 regressions remain runnable without MySQL through default env mode.
- One request sees one coherent policy snapshot while new requests observe Admin changes.
- Admin and MCP authentication, hosts, and failure semantics remain separated.

### Negative

- Production adds MySQL availability, migration, backup, and pool operations.
- Runtime requests in MySQL mode add database latency until evidence justifies a small cache.
- Bootstrap Admin authentication is intentionally limited and must eventually be replaced or fronted by a trusted enterprise identity layer in a later approved phase.

## Rejected alternatives

1. Keep environment files as the Admin source: rejected because changes are not durable, transactional, queryable, optimistic-lockable, or auditable.
2. Store Salesforce permission state: rejected because it would create a stale second authority.
3. Add Redis now: rejected because per-request MySQL snapshots satisfy current consistency needs without another system.
4. Cache Salesforce Connections or tokens: rejected because P1-P4 isolation guarantees and measured evidence do not justify it.
5. Use Spring/RuoYi or migrate package managers: rejected because it duplicates the accepted Node/Yarn architecture and adds unnecessary infrastructure.
6. Implement OIDC/SSO in P5: rejected because bounded bootstrap Admin sessions meet the current internal Control Plane scope.
7. Put secrets in the browser or database: rejected because they remain server-owned environment/secret inputs.

## Gate

P5 completion requires env compatibility, MySQL-authoritative fail-closed runtime behavior, versioned migration evidence, repository and optimistic-lock tests, transactionally audited Admin changes, runtime audit outcome safety, Admin authentication/CSRF/Origin/rate-limit/security tests, React build/unit/E2E evidence, P0-P4 regression, and a renewed P4 live Diagnostic closure attempt. P6 and P5 merge remain prohibited pending Maintainer review.

# P5 Final Report — Closure HOTFIX01

- Report date: 2026-08-24
- Branch: `feature/p5-admin-control-plane`
- P5 implementation baseline: `b2ea802`
- Closure: Local Database, Runtime Startup & Full Acceptance Closure

## Result

`P5 = PARTIAL`

The P5 implementation, local MySQL provisioning, migrations, bootstrap, real MCP/MySQL runtime integration, authenticated Admin API, React application, browser-to-MySQL full-stack E2E, startup, security, audit, and P0–P4 independent regressions pass. P5 is not reported COMPLETE because the configured environment does not contain a Salesforce account that is case-insensitively distinct from both active USER routes for the fixed P4 DIAGNOSTIC role. The real P4 Tooling/metadata evidence chain is therefore `NOT TESTED`.

P5 has not been merged and P6 has not started. Maintainer review remains authoritative.

## Implementation inventory

| Area | Implemented responsibility |
| --- | --- |
| `@sfoa/control-plane` | Kysely/mysql2 persistence, versioned migrations, schema validation, idempotent bootstrap, governance snapshots, identity repository, Admin transactions, and durable runtime/Admin audit |
| `@sfoa/admin-api` | scrypt authentication, signed expiring sessions, CSRF/Origin/rate-limit enforcement, bounded Admin REST resources, route/diagnostic verification, health/readiness, and safe system status |
| `@sfoa/admin-web` | React/Vite/Ant Design/TanStack Query/Router console for login, dashboard, routes, Tool control, DML policies, Diagnostic, audit, system, and logout |
| `@sfoa/mcp-server` | MySQL-authoritative per-request policy snapshots, dynamic Tool/DML governance, request-scoped Salesforce execution, durable audit, fail-closed outage behavior, and P4 verification adapter |
| `@sfoa/identity-runtime` | MySQL-backed `platformUserId -> Salesforce username` resolution while retaining the accepted request-scoped Connection/workspace boundary |

The Closure made only targeted corrections: deterministic monorepo-root resolution, MySQL JSON decoding, test/accessibility stability, real MySQL runtime coverage, mutation-audit failure coverage, and a non-mocked full-stack browser Gate. No P5 architecture was rewritten.

## Architecture

```text
React Admin
    -> Vite/reverse proxy
    -> Admin API
    -> MySQL Control Plane

MCP Client
    -> MCP Runtime
    -> one immutable MySQL Policy Snapshot per request
    -> request-scoped Salesforce Connection
    -> unchanged official Tool / SFoA minimal Provider
```

MySQL stores SFoA-owned governance and safe audit only. It does not store Salesforce access tokens, JWT assertions, private keys, Profiles, Permission Sets, CRUD/FLS replicas, or metadata snapshots. Salesforce remains the business authorization authority.

## Project-root and configuration resolution

`resolveSfoaProjectRoot(import.meta.url)` now derives the repository root from the compiled module location below `packages/<workspace>`. Admin API, MCP runtime, database CLI, and bootstrap use the same helper and do not treat `process.cwd()` as a repository contract.

Tests changed CWD among the repository root, `packages/sfoa-mcp-server`, and `packages/sfoa-admin-api`, with `.env.local` present only at the repository root. Both application module locations resolved the same root and loaded the same Control Plane configuration. Compiled Admin API and MCP processes also started successfully from their individual package directories.

## Database

| Evidence | Actual result |
| --- | --- |
| MySQL server | `8.0.30`, local `MySQL80` service |
| Application database | `sfoa_enterprise_mcp` |
| Integration database | `sfoa_enterprise_mcp_test` |
| Database existence | Both names returned by `information_schema.schemata` |
| Charset/engine contract | `utf8mb4_0900_ai_ci`, InnoDB migrations |
| Migration `001_p5_control_plane` | `APPLIED`, SHA-256 `d2fce65818ad3374153063f44be10cedc5b55c67970bde5ca51d72749165faeb` |
| Migration `002_p5_indexes` | `APPLIED`, SHA-256 `3bafd5109af59869dde4d14db91d5e580dc4c41719a7bb1cd807975a404f4c0d` |

The application and test databases were actually created and migrated. `yarn db:create`, `yarn db:migrate`, and `yarn db:status` completed against the local server. Startup validates the known migrations, checksums, required tables, columns, and indexes.

Actual application tables:

```text
sfoa_schema_migration
sfoa_identity_route
sfoa_tool_control
sfoa_dml_policy
sfoa_diagnostic_config
sfoa_runtime_setting
sfoa_audit_log
```

Index evidence includes ten query indexes for audit time/correlation/error/result/user/Tool and enabled governance lookups, three unique governance keys (`platform_user_id`, `tool_name`, and `object_api_name`), and table primary keys. Migration schema validation also checks required constraints and column shapes.

### Bootstrap

The first normal bootstrap attempt correctly failed closed because the environment Diagnostic username aliases an active USER route case-insensitively. No conflicting Diagnostic row was written. A normal, non-force bootstrap with no Diagnostic seed then imported two identity routes, two Tool controls, zero DML policies, zero Diagnostic rows, and two runtime settings. A second normal bootstrap wrote zero rows, proving idempotence and preservation of administrator-owned state. `--force` was not used.

The final application database evidence contained two routes, two Tool controls, two runtime settings, and seven durable audit rows. No database password or Admin secret is present in this report.

### MySQL integration

`yarn workspace @sfoa/control-plane test:mysql` connected to `sfoa_enterprise_mcp_test` and passed 5/5 with zero skipped tests. The MySQL runtime test and full-stack browser harness also refuse an unrelated database name and derive/use only the `_test` schema.

## Runtime

The accepted `env` compatibility mode remains available for P0–P4 regressions. In `mysql` mode, identity routes, enabled Tools, CREATE/UPDATE policy, Diagnostic configuration, runtime settings, and durable audit are database-authoritative. An unavailable database produces the stable Control Plane unavailable response; there is no environment fallback, default allow, or cached dangerous policy.

The real Streamable HTTP runtime was started in MySQL mode and exercised through the MCP SDK client with the real test database:

- two platform users resolved through database routes to separate request scopes;
- a shared Salesforce username for two platform users remained a legal schema/runtime configuration;
- missing and disabled routes denied;
- enabling a safe Tool changed the next `tools/list`, and disabling it removed the Tool without restart;
- CREATE and UPDATE policy toggles changed the next request independently;
- DELETE and UPSERT remained absent;
- an enabled database row for `future_unknown_tool` was never executable, while Admin reported `enableAllowed=false`;
- a real database outage failed closed with the stable runtime Control Plane unavailable error.

The Salesforce executor is deterministic in this integration test so it cannot mutate business data; the MCP server, HTTP transport, request snapshots, repositories, and MySQL are real. Separate live Salesforce regressions cover the accepted USER JWT/identity/SOQL/CREATE/UPDATE paths.

## Admin

The real Admin API started from the repository and package CWDs. `/admin/api/health` returned `UP`; `/admin/api/ready` returned `UP` with MySQL `8.0.30` and both required migrations applied.

Real HTTP security evidence passed:

- unauthenticated protected API returned 401;
- an incorrect password was rejected and repeated failures reached the login rate limit;
- valid login issued a signed `HttpOnly`, `SameSite=Strict` session cookie;
- the documented loopback development contract omitted `Secure`; production configuration requires HTTPS and `Secure`;
- state-changing requests required a valid CSRF token and exact allowed Origin;
- invalid Origin was rejected;
- expired and logged-out sessions were rejected;
- API responses used `Cache-Control: no-store`;
- health, readiness, system, and resource responses exposed no database password, session secret, MCP bearer, JWT material, or plaintext Admin password.

Route, Tool, DML, Diagnostic, and runtime-setting changes use optimistic row versions. Each accepted Admin mutation and its Admin audit record execute in one MySQL transaction; an audit failure rolls back the configuration write.

## Frontend

Implemented pages: Login, Dashboard, Identity Routes, Tool Governance, DML Policies, Diagnostic, Audit, System, and Logout.

- React production build: PASS.
- React/Vitest tests: PASS, 8/8.
- mocked Playwright workflow: PASS, 1/1. It remains explicitly classified as UI workflow/browser interaction E2E because it intercepts `/admin/api/**`.
- real full-stack Playwright: PASS, 1/1. It contains no Admin API route mock and executes `Browser -> Vite proxy -> real Admin API -> sfoa_enterprise_mcp_test`.

The full-stack browser Gate logged in, loaded the dashboard, created and edited an identity route, toggled Tool control, changed Lead CREATE and UPDATE policies, queried Admin audit, inspected migrations/runtime state on System, verified database persistence directly, and logged out.

Accessibility labels were made explicit for route, DML, and Diagnostic forms. Test cleanup now removes Ant Design portals between cases; Playwright timeouts reflect the real multi-page workflow instead of masking failures.

## Startup and manual smoke

`yarn p5:dev` started all three processes together:

| Process | Endpoint | Result |
| --- | --- | --- |
| MCP runtime | `http://127.0.0.1:8080/health` | PASS — HTTP 200, `UP`, audit persistence `UP` |
| Admin API health | `http://127.0.0.1:8081/admin/api/health` | PASS — HTTP 200, `UP` |
| Admin API readiness | `http://127.0.0.1:8081/admin/api/ready` | PASS — HTTP 200, schema ready |
| Admin Web | `http://127.0.0.1:5173/login` | PASS — HTTP 200 SPA login shell |

The real browser/API/database smoke passed Login, Dashboard, Identity Routes create/edit, Tool Governance, DML Policies, Audit, System, and Logout. The live Admin route-verification backend passed both enabled USER routes with fresh JWT and `Connection.identity()`. The Diagnostic page rendering and mocked interaction pass, but its real verify action is `NOT TESTED` because no independent Diagnostic account exists.

## Audit

Real MCP/MySQL requests produced and queried safe audit events for USER SOQL, a blocked Tool, DML policy denial, `get_record_action_context`, and successful governed CREATE/UPDATE fixtures. Full-stack Admin operations produced queryable route, Tool, and DML policy audit rows. The production database also retained seven safe audit records from local startup/verification activity.

Deterministic mutation regressions prove:

- Salesforce CREATE success plus durable-audit append failure still returns CREATE success;
- the mutation is invoked once and is never automatically retried;
- audit health becomes `DEGRADED` and the redacted fallback logger runs;
- `MCP_DML_OUTCOME_UNKNOWN` remains the result when the mutation outcome is ambiguous, even if audit persistence also fails.

Audit payload checks reject tokens, JWT/private-key material, database credentials, session secrets, MCP bearers, raw Salesforce response bodies, and arbitrary mutation field values.

## P4 Closure

The local configuration contains an environment Diagnostic username, but it aliases an active USER route case-insensitively. The P5 database has no distinct Diagnostic configuration. This is intentionally rejected by bootstrap and runtime validation.

After the account was reconfirmed, the real `validate:p4` entry point was attempted in compatibility mode. It exited 1 before JWT/Salesforce execution with the stable safe message `SFOA_DIAGNOSTIC_USERNAME must be distinct from every configured USER Salesforce username.` This is correct preflight denial, not live Diagnostic execution.

`P4 LIVE DIAGNOSTIC = NOT TESTED`

Therefore the historical `P4 = PARTIAL` result remains unchanged and the P5 overall result must remain `PARTIAL`. No mock or USER-route execution is promoted to the missing fixed-DIAGNOSTIC Tooling/official-metadata evidence chain.

## Regression

| Gate | Result | Evidence summary |
| --- | --- | --- |
| P4 Context Provider | PASS | 10/10 |
| P4 MCP Host | PASS | 7/7 |
| P4 USER A/B record context | PASS | live request-scoped USER routes; distinct Connections; workspace cleanup |
| P3 DML Provider | PASS | 17/17 |
| P3 MCP Host | PASS | 20/20 including audit-failure regression |
| P3 live Salesforce | PASS | CREATE/UPDATE, native denials, no retry, cleanup |
| P2 MCP Host | PASS | 18/18 |
| P2 live HTTP/A-B/load/shutdown | PASS | initialize/list/call, security, 50-request isolation, drain |
| P1 identity runtime | PASS | 27/27 plus live A/B isolation and no Connection reuse |
| P0 runtime validation | PASS | 9/9 plus fresh JWT, direct/official SOQL, official metadata, cleanup |
| P0 Streamable HTTP | PASS | 1/1 |
| Original official stdio | PASS | initialize, five-Tool list, official `get_username` call |
| Project-local Inspector | PASS | initialize/list/call for A/B in compatibility mode |
| Upstream compatibility | PASS | Provider API 0.6.0, dx-core 0.10.0, nine GA Tools, `drift: []` |
| Official TypeScript modification | PASS | zero files relative to audited Upstream commit |

Upstream boundary review: official Tool copied = NO; JSforce patched = NO; Salesforce permission replica = NO; Metadata snapshot = NO; Runtime Form Engine = NO; Redis = NO; Salesforce token cache = NO; Salesforce Connection pool = NO.

## Dependency and quality gates

All P5 dependencies resolve in the existing project-local installation. Builds passed for Control Plane, Admin API, Admin Web, and MCP Server. Strict changed-code lint passed for Control Plane, Admin API, Admin Web, MCP Server, and Identity Runtime.

The final public aggregate command `yarn validate:p5` exited 0 in 625.83 seconds. It reran all five changed-code lints, Control Plane 12/12, real MySQL 5/5 with zero skip, Identity 27/27, MCP P5 5/5, Admin API 12/12, Admin Web 8/8, the mocked Chromium workflow 1/1, and the real full-stack Chromium/MySQL workflow 1/1.

`yarn install --frozen-lockfile` still reproduces the historical Windows Yarn Classic/nohoist nested-link failure, now at a nested `@typescript-eslint/.../ignore` path. Source, manifests, and `yarn.lock` were not changed by the failure. Missing ignored generated shims/files were repaired from already installed matching packages, after which official stdio and all P5 builds/tests passed. This remains `KNOWN UPSTREAM/INSTALL DEBT`; it is not used to waive any SFoA code error or missing P5 dependency.

## Known risks

1. The independent Salesforce Diagnostic Integration User is not configured. P4 live Tooling and official metadata verification remain `NOT TESTED`; this is the blocker to P5 COMPLETE.
2. A clean Windows Yarn Classic frozen reinstall is not currently reliable because of the reproduced Upstream/nohoist link debt. The reviewed lockfile and all resolved P5 dependencies are intact, but clean-machine installation needs a separate maintenance fix or CI environment evidence.
3. The Admin Web production build reports a large-chunk warning. The build and runtime pass; code splitting is an optimization risk, not an acceptance defect.
4. P5 bootstrap authentication is intentionally a single configured administrator, not SSO/RBAC. The Admin service must remain behind the approved private network/reverse proxy until a later explicitly authorized phase changes that decision.

## Final acceptance statement

All locally executable P5 Closure Gates passed, including the real Browser/Admin API/MySQL and MCP/MySQL chains. Because `P4 LIVE DIAGNOSTIC = NOT TESTED`, the only truthful project result is:

`P5 = PARTIAL — AWAITING MAINTAINER REVIEW`

This report does not authorize merge, final acceptance, or P6 work.

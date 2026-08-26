# P6 Diagnostic Deployment HOTFIX01 Report

## Root cause

MCP Runtime startup in MySQL Control Plane mode seeded only active USER-route
Salesforce usernames. It omitted the DB-owned Diagnostic Salesforce username
from `sfoa_diagnostic_config`, leaving official DX/Core diagnostic execution
dependent on another process having already populated the same local SFDX auth
store.

## Implementation

`@sfoa/mcp-server` now reads active Identity Route usernames and the Diagnostic
config concurrently from its own MySQL Control Plane repositories during
startup. The resulting username list is passed to the existing
`seedSfdxLocalAuthStore()` implementation. The shared seeder remains the sole
deduplication point and retains its existing best-effort, observable failure
semantics.

No Admin API request, Admin health probe, shared HOME requirement, environment
diagnostic username fallback, connection cache, database migration, or schema
change was added.

## Focused evidence

| Check | Result |
| --- | --- |
| MCP active route usernames seed | PASS |
| MCP diagnostic username seed | PASS |
| No diagnostic config | PASS |
| Diagnostic-only deployment | PASS |
| Duplicate username dedupe | PASS — existing `sfdx-auth-store` unit test proves one AuthInfo create/save for duplicate input; MCP source helper deliberately delegates dedupe to it |
| Admin API dependency | NONE |
| Shared HOME dependency | NONE |
| ENV mode regression | PASS — existing `configuredSfdxUsernames()` focused tests retain primary, secondary, and diagnostic config behavior |
| Admin API regression | BUILD ONLY — `@sfoa/admin-api` build passed; Admin source was unchanged |
| SFDX auth-store unit tests | PASS — 5/5 |
| MCP runtime focused tests | PASS — 5/5 |
| Identity Runtime build | PASS |
| MCP Server build | PASS |
| MCP Server changed-code lint | PASS |
| Database Migration | NO |
| `TEST_SERVER_DEPLOYMENT.md` modified | NO |
| Agent Playbook modified | NO |
| BUNTU modified | NO |
| USER_BOUND modified | NO |
| Official Salesforce TypeScript modified | 0 |

Commands executed:

```powershell
yarn workspace @sfoa/identity-runtime build
# from packages/sfoa-identity-runtime
node --test dist/test/sfdx-auth-store.test.js
yarn workspace @sfoa/mcp-server build
# from packages/sfoa-mcp-server
node --test dist/test/runtime-sfdx-seed-usernames.test.js
yarn workspace @sfoa/mcp-server lint
yarn workspace @sfoa/admin-api build
```

## Gate status

HOTFIX Implementation: **PASS**

REAL HEADLESS SERVER GATE: **PENDING MAINTAINER**

The pending live gate is intentionally outside this code hotfix: remove the
target process's local SFDX store, start MCP Runtime without Admin API, and
execute a real Diagnostic metadata path on the headless server.

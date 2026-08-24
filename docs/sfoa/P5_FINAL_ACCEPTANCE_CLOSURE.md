# P4/P5 Final Live Acceptance Closure

Date: 2026-08-24

Branch: `feature/p5-admin-control-plane`

Starting subject commit: `90b8834` (`fix: complete P5 closure HOTFIX01`)

## Result

```text
P4 = FINAL ACCEPTED
P5 = PASS / COMPLETE — AWAITING MAINTAINER REVIEW
P6 ENTRY GATE = READY
```

This closure does not claim `P5 MAINTAINER FINAL ACCEPTED`, merge P5, or start P6 implementation. The historical `P4 = PARTIAL` and `P5 = PARTIAL` reports remain unchanged; this document is the later evidence that closes their one outstanding external Salesforce Gate.

## Architecture boundary exercised

```text
React Admin
  -> authenticated Admin API
  -> MySQL Control Plane
  -> fixed DIAGNOSTIC request scope
  -> fresh Salesforce JWT Connection
  -> official Tooling/metadata Tools

MCP client
  -> MCP runtime
  -> immutable MySQL policy snapshot
  -> USER request scope
  -> fresh Salesforce JWT Connection
```

The live closure reused the existing official `run_soql_query` and `retrieve_metadata` Tools through the audited P4 adapters. It did not copy an official Tool, add a USER fallback, cache a Salesforce token/Connection, or add a Salesforce permission replica.

## Independent Diagnostic account

The real account identifier remains only in ignored `.env.local` and `sfoa_diagnostic_config`; it is intentionally omitted from Git evidence. Safe checks established:

- the configured primary USER, secondary USER, and DIAGNOSTIC usernames are all present and case-insensitively distinct;
- the two enabled MySQL USER routes resolve to the primary and secondary USER respectively;
- the enabled database Diagnostic configuration matches the server-owned DIAGNOSTIC account and does not match either active USER route;
- the account authenticated through the configured Connected App and JWT private key without Salesforce CLI/Auth Cache runtime use.

No business SOQL, CREATE, UPDATE, DELETE, or UPSERT was executed with the DIAGNOSTIC identity.

## Real Admin Diagnostic Verify

The real Admin API was started against `sfoa_enterprise_mcp`. A process-only random administrator password/session secret was used for the closure harness; neither was written to a file or emitted. Login, signed cookie, exact Origin, and CSRF checks guarded the configuration mutations.

| Evidence | Result | Detail |
| --- | --- | --- |
| Admin API startup/authentication | PASS | Real compiled Admin API and MySQL store |
| USER route alignment | PASS | Both active routes aligned with the current independent USER accounts |
| Diagnostic configuration save | PASS | Enabled row and bounded metadata seed persisted with transactional Admin audit |
| Fresh JWT and identity | PASS | `Connection.identity()` exactly matched the fixed configured Diagnostic username |
| Tooling API | PASS | Official `run_soql_query` with Tooling mode returned 5/5 bounded records, not truncated |
| Official metadata retrieval | PASS | `CustomObject` seed returned 40 of 135 files and 34,371 bounded bytes; expected truncation applied |
| CWD restoration | PASS | Live before/after process CWD matched |
| Workspace cleanup | PASS | `created=1`, `cleaned=1`, `active=0` |

## Execution boundary and audit

The Admin verification correlation produced two durable MCP audit rows, one for official Tooling SOQL and one for official metadata retrieval. Both rows recorded:

- a non-empty triggering `platformUserId`;
- the fixed configured Diagnostic Salesforce username;
- `executionRole=DIAGNOSTIC`;
- the expected official Tool name.

Admin audit also recorded the USER route update, Diagnostic configuration update, and Diagnostic verification. The real Admin Tool catalog continued to classify all of the following as `executionRole=USER`:

```text
run_soql_query
create_record
update_record
get_record_action_context
```

The formal live validator additionally exercised `get_record_action_context` for both USER routes and returned `executionRole=USER`, exact identity matches, fresh distinct Connections, zero identity mismatch, and zero Connection reuse.

## Formal P4 live validator

Command:

```text
yarn workspace @sfoa/mcp-server validate:p4
```

Result: `exit 0`, `overall=PASS`, Salesforce API `67.0`.

| Gate | Result | Evidence |
| --- | --- | --- |
| USER A record-action context | PASS | Identity match, USER role, 79 bounded fields |
| USER B record-action context | PASS | Identity match, USER role, 79 bounded fields |
| USER isolation | PASS | Fresh Connections, distinct resolved users, mismatch 0, reuse 0 |
| Diagnostic JWT/identity | PASS | Fixed DIAGNOSTIC scope authenticated successfully |
| Diagnostic Tooling API | PASS | 5 records returned, not truncated |
| Official metadata/bounded context | PASS | 135 total files, 40 returned, 34,371 of 931,495 bytes returned, truncated within policy |
| CWD restoration | PASS | Live closure harness observed exact restoration |
| Request cleanup | PASS | `created=3`, `cleaned=3`, `active=0` in the formal validator |

## P5 final regression

Command:

```text
yarn validate:p5
```

Result: `exit 0` in 463.41 seconds.

| Gate | Result |
| --- | --- |
| Five SFoA changed-code lint workspaces | PASS |
| Control Plane unit tests | PASS — 12/12 |
| Real MySQL integration | PASS — 5/5, zero skipped |
| Identity Runtime | PASS — 27/27 |
| MCP/MySQL runtime governance | PASS — 5/5 |
| Admin API/security | PASS — 12/12 |
| React production build | PASS |
| React unit tests | PASS — 8/8 |
| Mocked UI/browser workflow | PASS — 1/1 |
| Real Browser -> Vite -> Admin API -> MySQL E2E | PASS — 1/1 |

The rebuilt real Admin `/admin/api/system/status` endpoint returned MySQL mode, database `UP`, both migration versions, `P4=FINAL ACCEPTED`, and `P5=PASS / COMPLETE — AWAITING MAINTAINER REVIEW`.

The full-stack browser Gate used `sfoa_enterprise_mcp_test`, persisted route/Tool/DML changes, queried seven Admin audit rows, and reported both migration versions.

## Final database confirmation

MySQL version: `8.0.30`.

Application database: `sfoa_enterprise_mcp`.

Automated integration/full-stack database: `sfoa_enterprise_mcp_test`.

Both schemas contained:

```text
sfoa_schema_migration
sfoa_identity_route
sfoa_tool_control
sfoa_dml_policy
sfoa_diagnostic_config
sfoa_runtime_setting
sfoa_audit_log
```

`001_p5_control_plane` and `002_p5_indexes` were `APPLIED` in the application database with repository-matching checksums; both versions were also present after the isolated full-stack test migration.

Production deployment requires only the application schema. The test schema is not a production runtime dependency and is needed in a deployment environment only when an operator deliberately runs the integration/full-stack Gates there.

## Port and exposure contract

Development:

```text
MCP             127.0.0.1:8080
Admin API       127.0.0.1:8081
Vite Admin Web  127.0.0.1:5173
```

Production:

```text
MCP Node        127.0.0.1:8080
Admin API Node  127.0.0.1:8081
React Web       static Nginx files
Vite 5173       NOT RUNNING
External        HTTPS 443
```

The reverse proxy maps `/mcp` to MCP, `/admin/api/` to the Admin API, and serves the React distribution as static files. Ports `8080`, `8081`, and `3306` must not be publicly exposed.

## Remaining risks

- Yarn Classic frozen reinstall still reproduces the known Windows/nohoist linking debt; it did not waive any SFoA lint/test/runtime Gate.
- The Admin bootstrap account remains within the accepted private Control Plane trust boundary and must stay behind the HTTPS reverse proxy.
- The React build retains a non-fatal chunk-size warning; measure operator performance before adding code splitting.
- Fresh request-scoped Salesforce Connections remain intentional. No token/Connection cache is introduced.

## Maintainer handoff

All evidence required to close the independent P4 Diagnostic dependency and rerun P5 is present. P5 remains on its feature branch for Maintainer review. P6 work must wait for that review despite the entry evidence being ready.

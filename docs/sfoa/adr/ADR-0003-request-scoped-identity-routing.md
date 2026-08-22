# ADR-0003: Request-Scoped Salesforce Identity Routing

- Status: Accepted and validated (`P1 = PASS`)
- Date: 2026-08-22

## Context

The official server accepts `--orgs` at process startup, stores allowed org values in a singleton Cache, creates one Services object, and captures it in Tool instances. Many Tools change the process working directory. A remote server must concurrently serve platform users without allowing a request to select another user's Salesforce connection.

## Decision

Build a new SFoA-owned Streamable HTTP host that accepts a trusted upstream `platformUserId` context and resolves it before Tool execution. For each stateless MCP POST, create an immutable request context, a fresh JWT-backed Salesforce Connection, request-scoped `OrgService`/`Services`, official Provider Tool instances, an MCP server/transport, and a disposable request workspace. Close all request-owned resources after the response.

Do not use the upstream `--orgs` Cache as the remote authorization boundary.

Treat official Tool `usernameOrAlias` as non-authoritative. It may name only the resolved username or a request-owned alias. A mismatch fails with `MCP_IDENTITY_CONTEXT_MISMATCH` before the official Tool, JWT creation for the forged target, or any Salesforce call for that target.

Override the client-supplied `directory` with the request-owned workspace. Reject other path arguments that resolve outside that workspace. This preserves the official schema while preventing an agent from selecting server filesystem authority.

Until official Tools stop mutating process CWD, use one host-wide CWD execution guard. Source-audited `get_username` and `run_soql_query` calls may share the guard because they do not consult CWD after their initial `chdir`; metadata execution takes an exclusive global mutex, captures CWD, and restores it in `finally`. Metadata requests may serialize in P1. Evaluate isolated processes only if measured P2/P4 throughput justifies them.

Request/connection contracts reserve `ConnectionRole = USER | DIAGNOSTIC`. P1 routes only `USER`. `DIAGNOSTIC` is deliberately not implemented until P4, where it will use a fixed Diagnostic Integration User and will be forbidden from business SOQL, record query, CREATE, and UPDATE.

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

## Options considered

| Option | Isolation | Complexity | P1 decision |
| --- | --- | --- | --- |
| A. Reuse official process-scoped `--orgs` host | Insufficient: request identity is not bound to the singleton allowlist/Services graph | Low | Rejected for remote multi-user authorization |
| B. Request-scoped Services / OrgService composition | One route and Connection per POST; official Tools remain unchanged; CWD requires a guard | Moderate | **Selected** |
| C. One isolated process per user/request | Strong process/CWD isolation | High supervision, startup, memory, eviction, and RPC cost | Deferred fallback for measured metadata pressure |

## Workspace policy

| Policy | Result |
| --- | --- |
| Trust the client `directory` | Rejected: grants server filesystem path selection |
| Reject every `directory` mismatch | Secure but unusable for stateless clients that cannot know the newly generated workspace |
| Override with the request workspace | **Selected**: compatible with official required schemas and keeps filesystem authority server-side |

## Consequences

- Identity cannot be changed merely by altering `usernameOrAlias` in a Tool call.
- Official Provider Tools remain reusable and unpatched.
- Stateless HTTP scaling is possible after external identity/config storage is introduced.
- Metadata throughput is serialized in P1; source-audited identity/SOQL calls remain concurrent under the shared side of the CWD guard.
- Metadata may require process isolation or an Upstream-safe directory adapter later.

## P1 validation

- Both configured platform routes completed fresh JWT and `Connection.identity()` against two real Salesforce users.
- Official `get_username` and `run_soql_query` passed for both routes.
- A→B and B→A forged `usernameOrAlias` calls returned `MCP_IDENTITY_CONTEXT_MISMATCH` before a Connection for the forged target was created.
- Unknown and missing platform identities were blocked before JWT, Salesforce API, or official Tool execution.
- Twenty interleaved A/B requests completed with zero identity mismatches, zero cross-user leaks, and zero Connection reuse.
- Two concurrent official metadata requests serialized through the exclusive guard, used distinct workspaces, restored CWD, and cleaned both roots.
- Invalid-auth and configuration-path tests returned actionable stable errors without exposing private-key paths, tokens, JWT assertions, or client secrets.
- P1 production source has no Salesforce CLI/Auth Cache, database, Redis, token-cache, connection-pool, or child-process dependency.

The accepted implementation remains a P1 proof/runtime boundary, not the P2 production security perimeter. P2 must authenticate the upstream platform claim and add Tool governance without moving Salesforce identity authority back into Tool arguments.

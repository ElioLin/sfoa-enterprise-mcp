# ADR-0018: Lazy request-scoped Salesforce resource

- Status: Accepted for P7-09
- Date: 2026-09-01
- Supersedes: eager Salesforce Connection construction in ADR-0003's request-scope implementation

## Context

The remote HTTP runtime creates a fresh RequestScope and MCP server for every stateless request. Before P7-09, both USER and DIAGNOSTIC scope factories immediately called `SalesforceConnectionFactory.create(route)`, then read `connection.getApiVersion()` to construct the request workspace. This made local and route-only behavior—`initialize`, `tools/list`, Resources, Prompts, `get_username`, `get_agent_playbook`, and `get_record_links`—depend on JWT authentication, Connection bootstrap, and incidental Salesforce probes even though those operations need no Salesforce data.

The eager Connection also entered composition directly through `RequestScopedOrgService` and `ManagedDmlFieldResolver`. The observed P7 `CONNECTION_INITIALIZATION` failures were real attempts and could not be hidden or relabeled. The lifecycle root cause had to be removed without changing MCP endpoints, Tool contracts, identity routing, governance, DML semantics, Salesforce authorization, Audit semantics, or Agent instructions.

## Decision

Each RequestScope owns one `RequestScopedSalesforceConnection` implementing `SalesforceConnectionProvider`. Scope construction resolves identity and route, creates request context/workspace directories/Services, and composes the MCP server without creating a Salesforce Connection.

`getConnection()` stores the complete initialization Promise before awaiting it. The first caller performs the route-bound factory creation and applies the returned Connection's API version to the request workspace. Repeated and concurrent callers within that scope receive the same Promise/Connection. A rejected Promise is retained, so one request never repeats JWT after failure. Scope close marks the provider closed before workspace cleanup.

The provider is never static or global. Different HTTP requests, platform users, and USER/DIAGNOSTIC roles always own different providers and Connections. No username-keyed cache, process Connection pool, token cache, or cross-request retry is allowed.

`RequestScopedOrgService` receives the provider. Its route-only methods remain Connection-free; only `getConnection(usernameOrAlias)` validates the requested route and delegates. Workspace directories are created without a live API version; the minimal DX project and optional seed manifest are written from the actual `connection.getApiVersion()` during first initialization. Managed DML and Salesforce Tool facades receive the provider rather than a Connection.

Connection initialization for an allowed Salesforce Tool remains outside the existing Tool deadline, matching the previous timeout contract, and inside the outer HTTP request deadline. Role/governance checks precede acquisition. Official Provider `provideTools()` is retained unchanged because source and executable tests prove that it constructs Tool objects without requesting a Connection.

## Consequences

- Local/route-only Tools and local MCP methods perform zero Salesforce JWT, Connection, HTTP, ScratchOrgInfo, or Organization attempts.
- A Salesforce-dependent request creates exactly one role-bound Connection; repeated or concurrent consumers reuse it only inside that request.
- Lazy authentication/Connection errors now surface at Salesforce Tool execution with their existing safe taxonomy and correlation ID.
- P7 Audit semantics are unchanged: absent local Salesforce rows reflect absent calls, while actual Salesforce attempts retain complete evidence.
- No Tool name/schema/output, endpoint, identity source, Tool/DML policy, permission model, Agent guidance, Admin UI, dependency, migration, or official Salesforce TypeScript implementation changes.
- A local Tool with Salesforce API evidence is now a request-resource lifecycle regression.

## Rejected alternatives

1. Tool-name skip list: rejected because it patches symptoms and drifts as Tools change.
2. Global username-to-Connection map or pool: rejected because it violates request identity, credential freshness, audit attribution, concurrency, and USER/DIAGNOSTIC isolation.
3. Duplicate SFoA `get_username`: rejected because the unchanged official Tool already works through route-only OrgService methods.
4. Static hard-coded API version: rejected because the runtime already has an authoritative live Connection version and arbitrary drift is unnecessary.
5. Large Tool dependency-classification framework: rejected because the lazy resource plus existing audited remote contracts naturally establish acquisition without duplicating governance.

## HOTFIX01: explicit Connection dependency model

The initial implementation inferred a remote Tool's Connection need from `hostOwnedArguments.includes('usernameOrAlias')`. That couples resource acquisition to an input-authority field and would silently misclassify any future remote Tool whose host-owned fields change. HOTFIX01 replaces the inference with an explicit boolean `requiresSalesforceConnection` on `RemoteToolContract` / `OfficialToolPolicyRecord`:

- `get_username` = `false` (route-only; zero Connection).
- `run_soql_query` = `true` (exactly one, lazily at execution).
- `retrieve_metadata` = `true` (exactly one, lazily at execution).

Every `p2RemoteCompatible` Tool must declare this boolean; the upstream-contract drift guard rejects an omission, so no Tool falls back to guessing. The field is part of the audited remote contract and is pinned alongside the existing input/annotation/schema checks.

The DML facade's lazy authentication failure path is also brought onto the same DML output contract as other DML errors: `structuredContent` carries `success=false`, `errorCode`, and a redacted `message`, while the Correlation ID stays in the text content.

## Gate

Automated call counters must prove scope creation/local/protocol methods = 0, first Salesforce use = 1, repeated/concurrent same-scope use = 1, two scopes = 2 isolated Connections, and Diagnostic execution = 0 USER + 1 DIAGNOSTIC. Lazy auth/Connection failure, correlation/Audit preservation, unused/failed/aborted cleanup, P3/P4/P5/P7 regressions, MySQL integration, Agent artifacts, Skill gates, and applicable live Salesforce validators are recorded in `P7_09_REPORT.md` and `TEST_MATRIX.md`.

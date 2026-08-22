# ADR-0006: Adapt Remote Tool Schemas at the Host Boundary

- Status: Accepted for P2
- Date: 2026-08-22
- Extends: ADR-0003 and ADR-0005

## Context

Official Salesforce DX MCP Tools are developer Tools. Their schemas commonly expose technical arguments such as `usernameOrAlias` and `directory`. In SFoA Enterprise MCP those values are already decided by the authenticated HTTP request:

```text
platformUserId -> IdentityResolver -> Salesforce username
request correlation -> RequestWorkspace -> directory
```

Exposing those arguments to a remote Agent creates an ambiguous/unsafe contract and forces Dify/WorkBuddy to know local DX details. P2 may adapt only the remote schema and host-owned technical arguments; it must not copy or reimplement official SOQL/metadata behavior.

## Compatibility findings

The pinned public APIs permit a low-intrusion facade:

1. `McpTool.getConfig()` returns the official description, raw Zod input shape, optional output shape, and annotations.
2. MCP SDK 1.18.2 `McpServer.registerTool()` accepts a raw Zod input shape and builds the registered object schema.
3. The host can omit explicitly owned fields from that shape.
4. The callback receives validated remote input; the host injects the resolved username and request workspace.
5. `RequestScopedToolExecutionAdapter` performs the existing route/workspace checks and calls the unchanged official `McpTool.exec()`.

No private `@salesforce/mcp` host module and no official Tool source are required.

## Decision

Implement an explicit `RemoteToolFacade` for each remotely compatible Tool. The facade:

- exposes only the non-host-owned portion of the official Zod shape;
- provides remote-accurate descriptions and complete MCP annotations;
- injects `usernameOrAlias` from the resolved `SalesforceIdentityRoute`;
- injects `directory` from the per-request `RequestWorkspace`;
- delegates execution to the P1 adapter and unchanged official `Tool.exec()`;
- applies a Tool wait timeout and returns a stable Tool-level error;
- logs identifiers/duration/result but never full input/result records or credentials.

P2 facades:

| Tool | Hidden/injected arguments | Default |
| --- | --- | --- |
| `get_username` | `directory` | Enabled |
| `run_soql_query` | `usernameOrAlias`, `directory` | Enabled |
| `retrieve_metadata` | `usernameOrAlias`, `directory` | Disabled; composition retained |

The mapping is explicit code, not name-pattern inference. A Tool without an explicit host-argument policy cannot be enabled.

## Security behavior

An Agent may attempt to include `platformUserId`, `usernameOrAlias`, or `directory` as extra JSON Tool arguments. They are not in the registered object shape and are stripped before the facade receives validated input. The facade then injects host-owned values. The HTTP Header, after client authentication, remains the only identity input.

This is defense in depth: P1 adapter still verifies any injected official `usernameOrAlias` matches the resolved route and rewrites filesystem paths into the isolated workspace.

## Consequences

### Positive

- Remote Agents use a clean query-oriented schema.
- Official Tool implementation, Salesforce SDK calls, and error parsing remain unchanged.
- No Salesforce username or local directory must be sent by Dify/WorkBuddy.
- A repeatable adapter pattern exists for future official read Tools.

### Negative

- Every remotely enabled Tool needs an explicit host-owned argument review.
- An official schema change can require an adapter/test update.
- `retrieve_metadata` still requires meaningful client manifest/source inputs and global-CWD serialization, so hiding directory does not make it a general business-agent Tool.

## Rejected alternatives

1. Keep the full official remote schemas: technically workable but leaks non-authoritative identity/workspace choices into the Agent contract.
2. Reimplement SOQL or metadata APIs: rejected because it duplicates official Tools and their error handling.
3. Copy every official schema by hand: rejected as brittle; the facade derives the public portion from `getConfig()` and lists only fields to omit.
4. Patch official Tools to accept a request context: rejected because composition already works and official source modifications would raise merge risk.

## Gate

The facade is accepted only while all of the following hold: remote `tools/list` hides host-owned fields; body forgery cannot alter A/B routing; official `Tool.exec()` passes; official Salesforce TypeScript modifications remain zero; unknown/unreviewed Tools fail startup.

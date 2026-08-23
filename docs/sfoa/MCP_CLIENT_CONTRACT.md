# SFoA Remote MCP Client Contract

Protocol: MCP Streamable HTTP, stateless JSON responses.

Default endpoint: `POST http://127.0.0.1:8080/mcp`.

Default deadlines: `MCP_TOOL_TIMEOUT_MS=120000`, `MCP_REQUEST_TIMEOUT_MS=180000`. Startup fails closed when request timeout is less than or equal to Tool timeout.

## Required headers

```http
Authorization: Bearer <client token>
X-Platform-User-Id: <authenticated platform user>
```

Optional:

```http
X-Correlation-Id: client-generated-id
```

The platform Header name is configurable through `MCP_PLATFORM_USER_HEADER`. `X-Correlation-Id` accepts 1–128 ASCII letters, digits, `_`, and `-`; an absent/invalid value is replaced with a server UUID.

## Authority boundary

The Bearer token authenticates the controlled MCP client. Only after that succeeds does the Host accept the configured platform-user Header and resolve it through P1 `IdentityResolver`:

```text
authenticated HTTP client
  -> platformUserId Header
  -> IdentityRepository/IdentityResolver
  -> fixed Tool role selects USER route or server-owned DIAGNOSTIC route
  -> fresh request-scoped Connection
  -> governed official/SFoA Tool
```

Clients must not send, and the Host does not trust:

- Salesforce access tokens, passwords, refresh tokens, JWT assertions, or private keys;
- Salesforce username/alias headers;
- `platformUserId` in JSON body, Tool arguments, or query parameters;
- `usernameOrAlias` or `directory` Tool arguments.

P4 also rejects client authority fields such as `connectionRole`, diagnostic username, credential profile, instance URL, arbitrary REST URL, manifest/source/output path, or a Tooling API switch. A diagnostic Tool's registered name selects a fixed server-owned route; arguments cannot escalate a USER Tool. A JSON-RPC batch remains USER-scoped, so a diagnostic call in a mixed batch is blocked rather than receiving diagnostic authority.

The P2 facade hides `usernameOrAlias` and `directory` from the remote schemas and injects the authoritative route/workspace internally. Extra identity/workspace arguments sent anyway are stripped by the registered Zod object and cannot select a route.

## Visible Tools

Default `tools/list`:

```text
get_username
run_soql_query
```

`retrieve_metadata` remains available in the official composition but is disabled by default. Mutation, admin, local-development, incompatible, and unknown Tools cannot be registered in P2. A configured forbidden/unknown Tool fails process startup.

P3 may additionally expose exactly `create_record` and/or `update_record` only when the exact Tool name is enabled and the strict Object-by-Operation DML policy contains a matching operation. DELETE, UPSERT, arbitrary REST, deploy, and admin Tools remain absent or startup-denied.

P4 may additionally expose these independently enabled read-only Tools:

| Tool | Fixed role | Agent-visible input |
| --- | --- | --- |
| `get_record_action_context` | USER | `objectApiName`, `action=CREATE|UPDATE`, optional `recordTypeId`, UPDATE `recordId` |
| `run_diagnostic_tooling_query` | DIAGNOSTIC | One bounded Tooling API `SELECT` query |
| `get_metadata_component_context` | DIAGNOSTIC | One allowlisted `metadataType` and exact `fullName` |

The diagnostic Tools require a server-owned `SFOA_DIAGNOSTIC_USERNAME`; enabling either without it fails startup. Their presence does not expose the official business query, metadata filesystem, Code Analyzer, deployment, permission, Apex execution, or admin Tools under DIAGNOSTIC authority.

Example record-action call:

```json
{
  "objectApiName": "Opportunity",
  "action": "CREATE"
}
```

Example diagnostic calls:

```json
{
  "query": "SELECT Id, Name FROM ApexClass LIMIT 5"
}
```

```json
{
  "metadataType": "ValidationRule",
  "fullName": "Opportunity.Price_Must_Be_Positive"
}
```

Record-action output is bounded and distinguishes API requiredness, Page Layout requiredness, field create/update capability, layout create/update editability, Salesforce defaults, and record-type picklist/dependency facts. It is Page Layout/UI API context, not a complete Dynamic Forms/Lightning-page evaluation. When any coverage or picklist result is truncated, clients must not guess omitted values.

Example SOQL call arguments:

```json
{
  "query": "SELECT Id FROM Lead LIMIT 5",
  "useToolingApi": false
}
```

## HTTP and stable error contract

| Condition | HTTP/Tool result | Stable code |
| --- | --- | --- |
| Missing Bearer | HTTP 401 | `MCP_CLIENT_AUTH_REQUIRED` |
| Invalid Bearer | HTTP 401 | `MCP_CLIENT_AUTH_INVALID` |
| Missing platform user | HTTP 401 | `MCP_PLATFORM_USER_REQUIRED` |
| Unknown platform route | HTTP 403 | `MCP_IDENTITY_ROUTE_NOT_FOUND` |
| Disallowed Host/Origin | HTTP 403 | `MCP_HOST_NOT_ALLOWED` / `MCP_ORIGIN_NOT_ALLOWED` |
| Body exceeds bound | HTTP 413 | `MCP_REQUEST_TOO_LARGE` |
| Whole request timeout before mutation starts, or for a read Tool | HTTP 504 | `MCP_REQUEST_TIMEOUT` |
| Whole request timeout after `create_record` / `update_record` starts | HTTP 504 JSON-RPC error | `MCP_DML_OUTCOME_UNKNOWN` |
| Read Tool execution timeout | MCP Tool-level `isError: true` | `MCP_TOOL_TIMEOUT` |
| DML Tool execution timeout | MCP Tool-level `isError: true` | `MCP_DML_OUTCOME_UNKNOWN` |
| Runtime not ready | HTTP 503 | `MCP_RUNTIME_NOT_READY` |
| Forbidden/unknown enabled Tool at startup | Startup failure | `MCP_TOOL_DISABLED` / `MCP_TOOL_NOT_AVAILABLE` |
| Diagnostic Tool enabled without server username | Startup failure | `MCP_DIAGNOSTIC_CONFIGURATION_INVALID` |
| Tool invoked with the wrong fixed role | MCP Tool-level error or HTTP 403 before protocol execution | `MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED` |
| Invalid/unsupported record context | MCP Tool-level `isError: true` | `MCP_RECORD_ACTION_CONTEXT_INVALID` / `MCP_RECORD_ACTION_CONTEXT_UNSUPPORTED` |
| Record Type unavailable or mismatched | MCP Tool-level `isError: true` | `MCP_RECORD_TYPE_NOT_AVAILABLE` |
| Metadata context exceeds safe bounds | MCP Tool-level `isError: true` | `MCP_METADATA_CONTEXT_TOO_LARGE` |

The request-level unknown wire shape is:

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32001,
    "message": "[MCP_DML_OUTCOME_UNKNOWN] Outcome is unknown. ...",
    "data": {
      "errorCode": "MCP_DML_OUTCOME_UNKNOWN",
      "correlationId": "bounded-log-correlation-id",
      "retryable": false
    }
  },
  "id": null
}
```

Errors exclude Bearer/JWT/private-key material. Tool/HTTP timeouts stop waiting and release request resources; they do not claim to cancel a Salesforce server-side operation already accepted by Salesforce. Never automatically retry CREATE/UPDATE after `MCP_DML_OUTCOME_UNKNOWN`; verify Salesforce state through an independent read first and tell the user when verification is impossible. Correlation ID is only for log correlation, not an idempotency key or Salesforce commit-status lookup key.

If the client disconnects after mutation execution starts, no response can be delivered over the closed connection. The Host logs an unknown transport outcome and does not cancel, replay, or retry the mutation; the client must treat that interruption as unknown under the same read-before-another-mutation rule.

## Liveness

- `GET /health`: process alive and HTTP runtime initialized; returns `{"status":"UP"}`.
- `GET /ready`: configuration, Tool policy, and Provider startup initialization succeeded; returns `{"status":"UP"}`.

Neither endpoint generates a Salesforce JWT or calls Salesforce. Host/Origin validation still applies.

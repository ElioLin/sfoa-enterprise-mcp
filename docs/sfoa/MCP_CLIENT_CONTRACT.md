# SFoA Remote MCP Client Contract

Protocol: MCP Streamable HTTP, stateless JSON responses.

Default endpoint: `POST http://127.0.0.1:8080/mcp`.

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
  -> Salesforce username/JWT route
  -> fresh request-scoped Connection
  -> unchanged official Tool.exec()
```

Clients must not send, and the Host does not trust:

- Salesforce access tokens, passwords, refresh tokens, JWT assertions, or private keys;
- Salesforce username/alias headers;
- `platformUserId` in JSON body, Tool arguments, or query parameters;
- `usernameOrAlias` or `directory` Tool arguments.

The P2 facade hides `usernameOrAlias` and `directory` from the remote schemas and injects the authoritative route/workspace internally. Extra identity/workspace arguments sent anyway are stripped by the registered Zod object and cannot select a route.

## Visible Tools

Default `tools/list`:

```text
get_username
run_soql_query
```

`retrieve_metadata` remains available in the official composition but is disabled by default. Mutation, admin, local-development, incompatible, and unknown Tools cannot be registered in P2. A configured forbidden/unknown Tool fails process startup.

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
| Whole request timeout | HTTP 504 | `MCP_REQUEST_TIMEOUT` |
| Tool execution timeout | MCP Tool-level `isError: true` | `MCP_TOOL_TIMEOUT` |
| Runtime not ready | HTTP 503 | `MCP_RUNTIME_NOT_READY` |
| Forbidden/unknown enabled Tool at startup | Startup failure | `MCP_TOOL_DISABLED` / `MCP_TOOL_NOT_AVAILABLE` |

Errors include a correlation ID and exclude Bearer/JWT/private-key material. Tool/HTTP timeouts stop waiting and release request resources; they do not claim to cancel a Salesforce server-side operation already accepted by Salesforce.

## Liveness

- `GET /health`: process alive and HTTP runtime initialized; returns `{"status":"UP"}`.
- `GET /ready`: configuration, Tool policy, and Provider startup initialization succeeded; returns `{"status":"UP"}`.

Neither endpoint generates a Salesforce JWT or calls Salesforce. Host/Origin validation still applies.

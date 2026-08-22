# P2 Agent Connection Guide

Date checked: 2026-08-22.

Common endpoint and transport:

```text
URL:       http://<runtime-host>:8080/mcp
Transport: Streamable HTTP
```

Common headers:

```http
Authorization: Bearer <MCP_CLIENT_TOKEN>
X-Platform-User-Id: <platform user id>
```

The Agent never supplies Salesforce username, password, access token, JWT key, `usernameOrAlias`, or `directory`.

## Dify

Dify's current official source stores encrypted arbitrary MCP headers and passes them to its remote MCP client. Therefore a controlled static test configuration can carry both P2 headers. See Dify's official [`mcp_tools_manage_service.py`](https://github.com/langgenius/dify/blob/main/api/services/tools/mcp_tools_manage_service.py).

Conceptual server configuration:

```json
{
  "transport": "streamable_http",
  "url": "http://<runtime-host>:8080/mcp",
  "headers": {
    "Authorization": "Bearer <MCP_CLIENT_TOKEN>",
    "X-Platform-User-Id": "<platform-user-A>"
  }
}
```

Immediate P2 test:

1. Create one controlled MCP provider entry for User A with a static platform Header.
2. Confirm only `get_username` and `run_soql_query` appear.
3. Call `get_username` and a bounded SOQL query.
4. Create a separate test entry for User B and repeat.

Dynamic per-invocation mapping from Dify runtime/user variables into MCP headers is **NEEDS CLIENT-SIDE VERIFICATION**. Dify's July 2026 open feature request says static headers exist but runtime context cannot yet populate them: [Support Runtime Variables in MCP Server Headers #39272](https://github.com/langgenius/dify/issues/39272). Do not assume one static MCP provider entry can safely represent many Dify end users. Until the deployed Dify version proves a trusted dynamic mapping, use separate controlled entries for A/B validation or a trusted gateway that overwrites `X-Platform-User-Id` from authenticated Dify claims.

## WorkBuddy

Tencent Cloud's official TencentOS MCP guide shows WorkBuddy-compatible Streamable HTTP configuration with `url` and a `headers` object carrying Bearer Authorization: [TencentOS MCP Server client configuration](https://cloud.tencent.com/document/product/1397/132403). WorkBuddy Enterprise also documents that Agent MCP configuration is synchronized into the Agent manifest: [WorkBuddy Enterprise quick start](https://cloud.tencent.com/document/product/1831/134527).

Candidate controlled test configuration:

```json
{
  "mcpServers": {
    "sfoa-user-a": {
      "url": "http://<runtime-host>:8080/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_CLIENT_TOKEN>",
        "X-Platform-User-Id": "<platform-user-A>"
      }
    }
  }
}
```

Static arbitrary custom Header acceptance in the exact WorkBuddy build under test, and dynamic per-user mapping of `X-Platform-User-Id`, are **NEEDS CLIENT-SIDE VERIFICATION**. The official examples prove Streamable HTTP URL plus Bearer headers, but do not establish that a single multi-user Agent can derive the SFoA platform Header from its authenticated user on every invocation. First test A and B as separate controlled configurations; never fall back to putting platform identity or Salesforce credentials into Tool arguments.

## Generic Streamable HTTP MCP client

Any client that supports request headers can connect directly. The official MCP TypeScript SDK shape used by P2 validation is:

```ts
const transport = new StreamableHTTPClientTransport(
  new URL('http://127.0.0.1:8080/mcp'),
  {
    requestInit: {
      headers: {
        authorization: `Bearer ${clientToken}`,
        'x-platform-user-id': platformUserId,
      },
    },
  },
);
```

Then run `client.connect(transport)`, `client.listTools()`, and `client.callTool(...)`. This exact path passed for both real users and through the project-local MCP Inspector proxy.

## Network checklist

- Local client on the runtime host: keep `MCP_BIND_HOST=127.0.0.1`.
- LAN client: explicitly use `MCP_BIND_HOST=0.0.0.0`, exact `MCP_ALLOWED_HOSTS`, and Bearer auth.
- Reverse proxy: preserve `Authorization` and the platform Header; overwrite proxy-owned forwarding headers; see `P2_REVERSE_PROXY.md`.
- Never configure `MCP_AUTH_MODE=disabled` away from loopback; startup rejects it.
- Keep client tokens in the client's secret manager and `.env.local`, never prompts, Tool args, screenshots, or Git.

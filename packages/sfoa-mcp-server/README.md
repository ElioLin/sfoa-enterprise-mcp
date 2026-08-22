# SFoA P2 Remote MCP Server

`@sfoa/mcp-server` is the production-oriented P2 HTTP host. It composes the public Salesforce Provider API and `@sfoa/identity-runtime`; it does not promote the P1 validation Host or modify an official Salesforce Tool.

The default remote contract is stateless Streamable HTTP at `http://127.0.0.1:8080/mcp`, internal Bearer client authentication, an authenticated `X-Platform-User-Id` route, registration-time default-deny Tool governance, and the remote facades `get_username` plus `run_soql_query`. The facade removes host-owned `usernameOrAlias` and `directory` arguments and injects the request-scoped Salesforce route/workspace before invoking unchanged official `Tool.exec()`.

From the repository root:

```powershell
yarn workspace @sfoa/mcp-server build
yarn workspace @sfoa/mcp-server test
yarn workspace @sfoa/mcp-server lint
yarn workspace @sfoa/mcp-server validate:p2
yarn workspace @sfoa/mcp-server start
```

Copy `.env.example` to the ignored `.env.local`, set a strong `MCP_CLIENT_TOKEN`, and retain all real Salesforce/JWT values only in that ignored file or the current shell. See `docs/sfoa/P2_USER_TEST.md` and `docs/sfoa/MCP_CLIENT_CONTRACT.md` for the operator and client contracts.

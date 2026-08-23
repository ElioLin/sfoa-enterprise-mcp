# SFoA P3 Remote MCP Server

`@sfoa/mcp-server` is the production-oriented P3 HTTP host. It composes the public Salesforce Provider API, `@sfoa/identity-runtime`, and the SFoA generic DML Provider; it does not promote the P1 validation Host or modify an official Salesforce Tool.

The default remote contract is stateless Streamable HTTP at `http://127.0.0.1:8080/mcp`, internal Bearer client authentication, an authenticated `X-Platform-User-Id` route, registration-time default-deny Tool governance, and the remote facades `get_username` plus `run_soql_query`. Each facade requires the pinned official Tool contract to match the executable audit baseline, exposes only explicitly allowed Agent fields, injects host-owned identity/workspace fields, and then invokes unchanged official `Tool.exec()`.

P3 adds `create_record` and `update_record` only when each exact name is in `MCP_ENABLED_TOOLS` and `MCP_DML_ALLOWLIST_JSON` contains at least one matching Object-by-Operation rule. Missing/empty configuration denies all. Official mutation/admin Tools remain forbidden, and DELETE/UPSERT/arbitrary REST Tools do not exist.

P3-Closure HOTFIX01 maps a DML Tool timeout to structured `MCP_DML_OUTCOME_UNKNOWN`, not generic failure. P3-Closure HOTFIX02 extends the same safety contract to the outer HTTP request boundary: a request-local observer is marked immediately before the SDK CREATE/UPDATE call, so an HTTP timeout after that boundary returns HTTP 504 with JSON-RPC `error.data.errorCode=MCP_DML_OUTCOME_UNKNOWN` and `retryable=false`. A timeout before mutation dispatch, including a read-only request timeout, remains `MCP_REQUEST_TIMEOUT`.

The defaults are `MCP_TOOL_TIMEOUT_MS=120000` and `MCP_REQUEST_TIMEOUT_MS=180000`. Startup fails closed with `MCP_RUNTIME_CONFIGURATION_INVALID` when request timeout is less than or equal to Tool timeout. This ordering is an operational guard; request-local mutation awareness remains the safety boundary.

The Host does not cancel, replay, or retry the underlying Salesforce mutation. Agents must not automatically retry an unknown CREATE/UPDATE and should use an independent read before another mutation. Correlation, Tool, operation, request identity, outcome, and termination layer remain in safe logs only and are not idempotency or Salesforce commit-status keys. A client disconnect after mutation start cannot receive an error response, but it is logged as an unknown transport outcome and is never replayed.

From the repository root:

```powershell
yarn workspace @sfoa/mcp-server build
yarn workspace @sfoa/mcp-server test
yarn workspace @sfoa/mcp-server test:p3
yarn workspace @sfoa/mcp-server lint
yarn workspace @sfoa/mcp-server validate:upstream
yarn workspace @sfoa/mcp-server validate:p2
yarn workspace @sfoa/mcp-server validate:p3
yarn workspace @sfoa/mcp-server start
```

Copy `.env.example` to the ignored `.env.local`, set a strong `MCP_CLIENT_TOKEN`, and retain all real Salesforce/JWT values only in that ignored file or the current shell. See `docs/sfoa/P2_USER_TEST.md`, `docs/sfoa/MCP_CLIENT_CONTRACT.md`, `docs/sfoa/P3_FINAL_REPORT.md`, `docs/sfoa/P3_CLOSURE_HOTFIX01_REPORT.md`, and `docs/sfoa/P3_CLOSURE_HOTFIX02_REPORT.md` for the operator, client, mutation, outcome-safety, and validation contracts.

Run `validate:upstream` after every Salesforce upstream sync. Any difference returns `UPSTREAM_REVIEW_REQUIRED`; changes affecting an enabled remote Tool also fail production startup with `MCP_UPSTREAM_TOOL_CONTRACT_DRIFT`. New Tools and fields are never automatically classified or exposed.

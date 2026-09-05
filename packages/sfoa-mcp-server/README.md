# SFoA P6 Remote MCP Runtime

`@sfoa/mcp-server` is the production-oriented P6 HTTP runtime. It composes the public Salesforce Provider API, `@sfoa/identity-runtime`, the SFoA generic DML Provider, the SFoA deterministic Context Provider, the canonical Agent Playbook, and the MySQL Control Plane; it does not modify an official Salesforce Tool.

P7-02 creates one server-authoritative Request Audit Context for every definite `tools/call`. P7-03 binds one in-memory Collector to that same context, explicitly carries it across HTTP/SDK/EventEmitter boundaries, finalizes one immutable Snapshot at request completion, and performs only a non-blocking Queue offer on the request path. The background Writer owns batch MySQL persistence and bounded shutdown flush. P7-04/P7-05 add request-bound Salesforce wire and SOQL/DML facts. P7-06 reuses the single bounded body read for `MCP_REQUEST`, observes actual `ServerResponse.write/end` bytes without changing backpressure for `MCP_RESPONSE`, and records `finish` separately from early client `close`. Logical Tool result remains separate from transport fact, and no response waits for Audit persistence.

The default remote contract is stateless Streamable HTTP at `http://127.0.0.1:8080/mcp`, registration-time default-deny Tool governance, the official read facades `get_username` and `run_soql_query`, and the safe SFoA infrastructure Tools `get_agent_playbook` and `get_record_links`. Internal clients use a shared bearer plus authenticated `X-Platform-User-Id`; WorkBuddy uses a USER_BOUND bearer without that Header; 小犇/Dify uses its current Buntu bearer without that Header. Official facades require the pinned Tool contract to match the executable audit baseline, expose only explicitly allowed Agent fields, inject host-owned identity/workspace fields, and then invoke unchanged official `Tool.exec()`.

P6-Agent-01 publishes concise Server Instructions, `sfoa://agent-playbook/current`, request-scoped `sfoa://agent-capabilities/current`, Prompt `sfoa_salesforce_assistant`, and the Tool-only fallback. `get_record_links` derives up to 50 credential-free Lightning links from the configured trusted `SFOA_LIGHTNING_BASE_URL` and performs no Salesforce API call. All guidance comes from `@sfoa/agent-playbook` version `1.5.0`; Dynamic Forms evidence is `NOT_AVAILABLE` and no Runtime Form Engine is implemented.

P7-09 creates the request scope, route, Control Plane snapshot, local workspace directories, Services, and MCP server without Salesforce authentication. `initialize`, `tools/list`, Resources, Prompts, `get_username`, `get_agent_playbook`, and `get_record_links` therefore create zero Salesforce Connections/API attempts. The first allowed SOQL, DML, USER context, or DIAGNOSTIC Salesforce Tool initializes one role-bound Connection Promise for that HTTP request; no Connection is shared across requests or roles.

P3 adds `create_record` and `update_record` only when each exact name is in `MCP_ENABLED_TOOLS` and `MCP_DML_ALLOWLIST_JSON` contains at least one matching Object-by-Operation rule. Missing/empty configuration denies all. Official mutation/admin Tools remain forbidden, and DELETE/UPSERT/arbitrary REST Tools do not exist.

P4 adds three independently enabled read-only Tools. `get_record_action_context` always uses the request USER and verified REST UI API. `run_diagnostic_tooling_query` and `get_metadata_component_context` always use the fixed server-owned `SFOA_DIAGNOSTIC_USERNAME`; enabling either without that setting fails startup, and the setting must differ from every configured USER Salesforce username. The former forces the official `run_soql_query` primitive onto Tooling API, and the latter generates a server-owned manifest, invokes official `retrieve_metadata`, and returns bounded UTF-8 files before request cleanup. None accepts identity, role, token, URL, or filesystem authority. Code Analyzer is not remote-compatible and is not exposed.

P5 retains `env` compatibility mode and adds authoritative `mysql` mode. In MySQL mode, every HTTP request loads one immutable route/Tool/DML/Diagnostic/settings snapshot, so an accepted Admin change affects the next request without a runtime restart. Missing or unavailable database state fails closed with no environment fallback. Runtime/Admin events are durably audited, but an audit failure never reverses a successful Salesforce mutation or causes an automatic retry.

P3-Closure HOTFIX01 maps a DML Tool timeout to structured `MCP_DML_OUTCOME_UNKNOWN`, not generic failure. P3-Closure HOTFIX02 extends the same safety contract to the outer HTTP request boundary: a request-local observer is marked immediately before the SDK CREATE/UPDATE call, so an HTTP timeout after that boundary returns HTTP 504 with JSON-RPC `error.data.errorCode=MCP_DML_OUTCOME_UNKNOWN` and `retryable=false`. A timeout before mutation dispatch, including a read-only request timeout, remains `MCP_REQUEST_TIMEOUT`.

The defaults are `MCP_TOOL_TIMEOUT_MS=120000` and `MCP_REQUEST_TIMEOUT_MS=180000`. Startup fails closed with `MCP_RUNTIME_CONFIGURATION_INVALID` when request timeout is less than or equal to Tool timeout. This ordering is an operational guard; request-local mutation awareness remains the safety boundary.

The Host does not cancel, replay, or retry the underlying Salesforce mutation. Agents must not automatically retry an unknown CREATE/UPDATE and should use an independent read before another mutation. Correlation, Tool, operation, request identity, outcome, and termination layer remain in safe logs only and are not idempotency or Salesforce commit-status keys. A client disconnect after mutation start cannot receive an error response, but it is logged as an unknown transport outcome and is never replayed.

From the repository root:

```powershell
yarn workspace @sfoa/mcp-server build
yarn workspace @sfoa/mcp-server test
yarn workspace @sfoa/mcp-server test:p3
yarn workspace @sfoa/mcp-server test:p4
yarn workspace @sfoa/mcp-server test:p5
yarn workspace @sfoa/mcp-server test:p7
yarn workspace @sfoa/mcp-server test:p5:mysql
yarn workspace @sfoa/mcp-server lint
yarn workspace @sfoa/mcp-server validate:upstream
yarn workspace @sfoa/mcp-server validate:p2
yarn workspace @sfoa/mcp-server validate:p3
yarn workspace @sfoa/mcp-server validate:p4
yarn workspace @sfoa/mcp-server start
```

Copy `.env.example` to the ignored `.env.local`, set a strong `MCP_CLIENT_TOKEN`, and retain all real Salesforce/JWT/database values only in that ignored file or the current shell. See `docs/sfoa/P5_LOCAL_SETUP.md`, `docs/sfoa/P4_AGENT_GUIDANCE.md`, `docs/sfoa/MCP_CLIENT_CONTRACT.md`, and the phase reports for the current Control Plane, context, client, mutation, and outcome-safety contracts.

Run `validate:upstream` after every Salesforce upstream sync. Any difference returns `UPSTREAM_REVIEW_REQUIRED`; changes affecting an enabled remote Tool also fail production startup with `MCP_UPSTREAM_TOOL_CONTRACT_DRIFT`. New Tools and fields are never automatically classified or exposed.

Managed DML fields distinguish strict platform identity / AI marker from user-overridable platform Lookup fallback. See [managed field contract](../../docs/sfoa/P6_DML_01_MANAGED_FIELDS.md) for strategy priority and CREATE/UPDATE interaction.

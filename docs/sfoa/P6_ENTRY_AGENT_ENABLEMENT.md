# P6-Entry Agent Enablement

Status: `P6-ENTRY OPT01 = PASS`; P6-ID-01 USER_BOUND enhancement implemented and under final validation; `P6 REAL-AGENT EVALUATION` remains unstarted

> P6-ID-01 supersedes the OPT01 connector identity guidance below: WorkBuddy now uses a route-bound USER_BOUND bearer without `X-Platform-User-Id`. Legacy internal connectors retain the shared bearer plus trusted Header. See `P6_ID_01_USER_BOUND_CREDENTIAL.md`.

## Purpose and boundary

P6-Entry OPT01 prepares the accepted P5 Control Plane for Chinese administrators and controlled Dify/WorkBuddy evaluation. It adds presentation, connection guidance, deterministic client instructions, and a WorkBuddy/CodeBuddy Skill only.

It does not add or rename an MCP Tool, modify an MCP schema, add a Salesforce API, alter request-scoped Salesforce Connections, change Diagnostic roles, add a database migration, persist an external MCP URL, deploy Nginx, or open a firewall.

The operating model is:

```text
MCP          = trusted Tool capability
Instruction  = Agent global behavior
Skill        = Salesforce-specialized workflow and safety guidance
```

These layers are complementary and must not be collapsed into a `generate_prompt` or `generate_skill` MCP Tool.

## MCP network access

### Same host

The default Endpoint is:

```text
http://127.0.0.1:8080/mcp
```

`127.0.0.1` means the client must run on the same host as the MCP Runtime. A remote Dify or WorkBuddy Runtime cannot use its own loopback address to reach this host.

### LAN test

For deliberate private-LAN testing, configure locally and review before restart:

```dotenv
MCP_BIND_HOST=0.0.0.0
MCP_ALLOWED_HOSTS=<YOUR_LAN_IP>:8080
MCP_AUTH_MODE=internal_bearer
```

Then use:

```text
http://<YOUR_LAN_IP>:8080/mcp
```

Open TCP 8080 only in the applicable Windows/Linux Firewall and only to the required network sources. `0.0.0.0` means listening on all local interfaces; it does not automatically create route, firewall, security-group, reverse-proxy, or internet access.

### Production

Prefer TLS termination and keep Node on loopback:

```text
https://mcp.example.com/mcp
        ↓
Nginx/TLS
        ↓
http://127.0.0.1:8080/mcp
```

Do not expose port 8080 directly to the public network. Follow `docs/sfoa/P2_REVERSE_PROXY.md` and `docs/sfoa/P5_DEPLOYMENT.md`; this phase does not deploy Nginx.

## Connector configuration

For WorkBuddy, create an Identity Route and copy its generated configuration:

```text
Authorization: Bearer <USER_BOUND_TOKEN>
Transport: Streamable HTTP
```

The WorkBuddy JSON contains no platform Header. The USER_BOUND token resolves the current route's platform identity, and the authenticated credential Drawer can retrieve it repeatedly. Dashboard, Audit, System, and route-list responses do not receive the raw token.

`MCP_CLIENT_TOKEN` plus `X-Platform-User-Id` remains authoritative for Inspector, regressions, and trusted internal/gateway connectors. It is not required by WorkBuddy. A future `BUNTU_TOKEN` provider may authenticate Dify into the same principal boundary, but no Buntu API is implemented in this phase.

## Deterministic Dify instructions

The Admin UI generator consumes only:

- the audited executable Tool catalog;
- current database Tool enabled state;
- current enabled CREATE/UPDATE object policy;
- current Diagnostic enabled/verification state.

It calls no LLM. Unknown Tools do not enter the output. CREATE, UPDATE, context, and diagnosis workflows appear only when their current dependencies are available. Any effective DML capability always adds the `MCP_DML_OUTCOME_UNKNOWN` no-automatic-retry workflow.

The static baseline is `docs/agent/DIFY_AGENT_INSTRUCTION.md`; the Admin-generated output is authoritative for current runtime capability.

## WorkBuddy / CodeBuddy guidance

Recommended setup:

1. Configure a reachable `MCP_PUBLIC_URL`.
2. In **用户身份路由**, create the platform route; its USER_BOUND token is generated transactionally.
3. In the automatically opened **接入配置** Drawer, select **复制 WorkBuddy MCP JSON**.
4. Paste the JSON into a custom MCP Connector and save; add no identity Header.
5. Create or configure the Agent.
6. Add `docs/agent/WORKBUDDY_AGENT_SYSTEM_PROMPT.md` as the concise global System Prompt.
7. Install/enable `.codebuddy/skills/sfoa-salesforce-assistant/`.
8. Perform a read-only Test Run before any DML test.

The Connector supplies network/authentication/Tools. The System Prompt supplies global behavior. The Skill supplies Salesforce Tool workflows and safety boundaries. Connector configuration alone does not teach the Agent these workflows.

## Historical OPT01 Gate result

The original OPT01 Admin Web production build, 32/32 unit/content tests, 12/12 Admin API tests, 18/18 MCP Server tests, mocked Chromium workflow, real MySQL full-stack Chromium workflow, and `yarn validate:p5` all passed. At that historical OPT01 Gate no MCP Tool/schema, database migration, Salesforce API, identity lifecycle, Diagnostic role, or MCP Runtime behavior changed. P6-ID-01 subsequently adds the documented credential migration and identity-acquisition behavior without changing Salesforce Tool or Connection semantics. See `docs/sfoa/P6_ENTRY_OPT01_REPORT.md` and `docs/sfoa/P6_ID_01_REPORT.md`.

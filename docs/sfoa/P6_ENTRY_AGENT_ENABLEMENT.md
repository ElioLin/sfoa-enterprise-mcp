# P6-Entry Agent Enablement

Status: `P6-ENTRY OPT01 = PASS`; `P6 REAL-AGENT EVALUATION = READY`

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

Use placeholders in generated examples:

```text
Authorization: Bearer <YOUR_MCP_CLIENT_TOKEN>
X-Platform-User-Id: <PLATFORM_USER_ID>
Transport: Streamable HTTP
```

The Admin browser receives only whether `MCP_CLIENT_TOKEN` is configured. It never receives the token value.

`X-Platform-User-Id` is currently the authoritative Salesforce identity-routing input after controlled-client Bearer authentication. One controlled connector may use one fixed platform user during P6 tests. That is not equivalent to dynamic Salesforce identity for every Dify/WorkBuddy end user. A future multi-user edge must use a trusted gateway/authenticated claim to derive `platformUserId` and overwrite any inbound Header; that gateway is outside OPT01.

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

1. Create a custom MCP Connector.
2. Configure the reachable Streamable HTTP Endpoint.
3. Configure the Bearer Authorization Header.
4. Configure the controlled `X-Platform-User-Id` value.
5. Create or configure the Agent.
6. Add `docs/agent/WORKBUDDY_AGENT_SYSTEM_PROMPT.md` as the concise global System Prompt.
7. Install/enable `.codebuddy/skills/sfoa-salesforce-assistant/`.
8. Perform a read-only Test Run before any DML test.

The Connector supplies network/authentication/Tools. The System Prompt supplies global behavior. The Skill supplies Salesforce Tool workflows and safety boundaries. Connector configuration alone does not teach the Agent these workflows.

## Gate result

The Admin Web production build, 32/32 unit/content tests, 12/12 Admin API tests, 18/18 MCP Server tests, mocked Chromium workflow, real MySQL full-stack Chromium workflow, and final `yarn validate:p5` all passed. No MCP Tool/schema, database migration, Salesforce API, identity lifecycle, Diagnostic role, or MCP Runtime behavior changed. See `docs/sfoa/P6_ENTRY_OPT01_REPORT.md` for the complete evidence.

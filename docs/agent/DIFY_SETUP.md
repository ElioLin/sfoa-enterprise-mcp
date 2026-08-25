# 小犇 / Dify SFoA MCP Setup

Use an HTTPS-reachable SFoA Streamable HTTP endpoint in production.

## Connection

```text
MCP Server URL = https://mcp.example.com/mcp
Authorization Header = Bearer <CURRENT_USER_TOKEN>
Identity Source = BUNTU_TOKEN
X-Platform-User-Id = NOT_CONFIGURED
Transport = Streamable HTTP
```

`<CURRENT_USER_TOKEN>` is the current signed-in user's Buntu token. The MCP Server validates it on every request and routes only `data.userId` through the current Identity Route. Do not copy `MCP_CLIENT_TOKEN`, `USER_BOUND_TOKEN`, a Salesforce username, or a platform Header into this connector.

## Agent guidance

1. Let the client consume initialize Server Instructions.
2. Read `sfoa://agent-playbook/current` and `sfoa://agent-capabilities/current` when Resources are supported.
3. Use Prompt `sfoa_salesforce_assistant` with `CORE`, `READ`, `CREATE`, `UPDATE`, `DIAGNOSIS`, or `ALL` when Prompts are supported.
4. If Resources/Prompts are unsupported and `get_agent_playbook` is actually enabled, call that fallback Tool.
5. Copy the current Admin-rendered Dify instruction only when the client needs an explicit instruction field.
6. Run a read-only identity/data test before allowed CREATE/UPDATE tests.

The checked-in `DIFY_AGENT_INSTRUCTION.md` is generated capability-neutral reference content. The Admin output adds the current safe Tool/policy/Diagnostic facts.

Never automatically retry `MCP_DML_OUTCOME_UNKNOWN`; verify with an independent USER read or report the outcome unknown.

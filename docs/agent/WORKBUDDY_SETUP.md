# WorkBuddy SFoA MCP Setup

## Connection

Create or select the intended Identity Route in the authenticated Admin Console and copy its current USER_BOUND credential into the connector's secret store:

```text
MCP Server URL = https://mcp.example.com/mcp
Authorization Header = Bearer <USER_BOUND_TOKEN>
Identity Source = USER_BOUND_TOKEN
X-Platform-User-Id = NOT_CONFIGURED
Transport = Streamable HTTP
```

The bearer is bound to the route rather than a Salesforce username. Route remapping affects the next request; disabling the route denies the next request; credential regeneration permanently revokes the old bearer. Do not add a platform Header.

## System Prompt and Skill

1. Use `docs/agent/WORKBUDDY_AGENT_SYSTEM_PROMPT.md` as the concise global prompt.
2. Import the complete `.codebuddy/skills/sfoa-salesforce-assistant/` directory, including `references/`.
3. Prefer MCP Instructions/Resources/Prompt discovery when WorkBuddy exposes those surfaces.
4. Confirm `get_agent_playbook` and `get_record_links` in `tools/list` before relying on their fallback/link behavior.
5. Run a read-only Test Run before an allowed CREATE/UPDATE scenario.

The prompt and Skill are generated from Playbook `1.1.0`. Do not edit generated files manually; update the canonical TypeScript definition and run:

```powershell
yarn agent:sync
yarn agent:check
```

Never automatically retry `MCP_DML_OUTCOME_UNKNOWN`; verify with an independent USER read or report the outcome unknown.

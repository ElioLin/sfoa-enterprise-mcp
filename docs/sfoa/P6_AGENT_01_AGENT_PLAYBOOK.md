# P6-Agent-01 MCP-Native Agent Playbook

- Status: PASS / COMPLETE — awaiting Maintainer review
- Date: 2026-08-26
- Branch: `feature/p6-agent-playbook`
- Playbook version: `1.0.0`

## Delivered components

### Canonical package

`packages/sfoa-agent-playbook` is the single authored behavior source. Its production `src/` is strict, browser-safe TypeScript with no filesystem, network, database, Connection, identity-route, credential, or secret dependency.

It exports:

- `AGENT_PLAYBOOK_VERSION`;
- the ten accepted section names and six workflow selectors;
- safe, normalized `AgentCapabilities` facts;
- `renderServerInstructions`;
- `renderFullPlaybook`;
- `renderWorkflow`;
- `renderDifyInstruction`;
- `renderWorkBuddySkill`;
- `renderWorkBuddySystemPrompt`.

Unknown Tool names and invalid object API names are filtered before rendering. CREATE/UPDATE object facts are retained only when the matching Tool is effective. Diagnostic readiness requires both Diagnostic Tools plus current verified readiness. Dynamic Forms evidence is fixed to `NOT_AVAILABLE` because current P4 action context does not evaluate Dynamic Forms or the complete Lightning page.

### MCP protocol surfaces

Every request-scoped MCP Server is constructed with Playbook `1.0.0` Instructions and registers:

| Surface | Identifier | Availability |
| --- | --- | --- |
| Full Resource | `sfoa://agent-playbook/current` | always |
| Capability Resource | `sfoa://agent-capabilities/current` | always |
| Workflow Prompt | `sfoa_salesforce_assistant` | always |
| Playbook Tool fallback | `get_agent_playbook` | enabled Tool policy only |
| Trusted record links | `get_record_links` | enabled Tool policy only |

The capability Resource contains only `playbookVersion`, recognized `enabledTools`, effective CREATE/UPDATE object names, `diagnosticReady`, and `dynamicFormEvidence`. It contains no platform user, Salesforce username, route, instance host, Diagnostic username, database detail, credential, or secret. Each HTTP POST builds a fresh server and captures one immutable fact object, preserving the existing request-isolation boundary.

Both Tools are SFoA-owned, USER-role, READ-classified, GA, remote-compatible, bounded, annotated read-only/non-destructive/idempotent/closed-world, and visible in Admin governance. Environment mode defaults them on; MySQL mode continues to use the next-request database enabled state.

### Trusted record links

`get_record_links` accepts one to 50 strict `{ objectApiName, recordId, displayName? }` descriptors. It validates object API names and 15/18-character Salesforce IDs, obtains `Connection.instanceUrl` from the current request scope, and requires a credential-free HTTP(S) origin root. It returns:

```text
<trusted-origin>/lightning/r/<encoded-object>/<encoded-id>/view
```

No input field accepts a host/origin/base URL. The Tool makes no Salesforce or external API call. Invalid or missing trusted origins return Tool-level `MCP_TRUSTED_INSTANCE_URL_INVALID`; schema-invalid record input is rejected by MCP argument validation.

### Deterministic artifacts

`yarn agent:sync` builds the canonical package and rewrites exactly:

- `.codebuddy/skills/sfoa-salesforce-assistant/SKILL.md`;
- `.codebuddy/skills/sfoa-salesforce-assistant/references/tool-workflows.md`;
- `.codebuddy/skills/sfoa-salesforce-assistant/references/safety-boundaries.md`;
- `docs/agent/DIFY_AGENT_INSTRUCTION.md`;
- `docs/agent/WORKBUDDY_AGENT_SYSTEM_PROMPT.md`.

`yarn agent:check` compares exact UTF-8 content and fails on missing or edited files. Every file contains the canonical version and generated marker; the WorkBuddy marker appears after valid YAML frontmatter.

### Admin integration

The existing Ant Design `/agent-integration` page now separates:

1. MCP access and three distinct identity examples;
2. Agent Playbook version, current safe facts, and distribution status;
3. 小犇 / Dify Buntu bearer setup and current-fact Dify renderer;
4. WorkBuddy USER_BOUND setup, current-fact system prompt, and generated Skill;
5. MCP-native Instructions, Resources, Prompt, fallback, and record-link guidance.

Dify and WorkBuddy no longer receive the stale shared token plus platform Header instructions. Internal/Inspector continues to use that accepted path. Status tags include icons and text, copy actions produce visible success/error feedback, and the existing responsive card layout remains intact.

## Architecture and single source of truth

```text
AgentPlaybookDefinition 1.0.0 (pure TypeScript)
                  +
request-scoped safe capability facts
                  |
                  +--> MCP Server Instructions
                  +--> MCP Resources and workflow Prompt
                  +--> get_agent_playbook fallback
                  +--> Admin current-capability preview
                  +--> generated Dify instruction
                  +--> generated WorkBuddy prompt and Skill
```

The definition is the only authored workflow-rule source. Renderers may add client identity setup and current safe capability facts, but they do not copy or override the workflow rules. Generated Markdown is a reviewed distribution format, not another editable source.

## Versioning and client compatibility

`AGENT_PLAYBOOK_VERSION` is independent from MCP Server, Admin, Salesforce API, Provider, and package versions. A behavior-changing Playbook edit must deliberately advance this semantic version, rerun `yarn agent:sync`, pass `yarn agent:check`, and update protocol/generator tests before review.

Client support degrades without changing authorization:

| Client capability | Guidance path |
| --- | --- |
| initialize Instructions | concise core contract and discovery pointers |
| Resources / Prompts | full request-scoped Playbook/capability Resources and workflow Prompt |
| Tools only | governed `get_agent_playbook` fallback, once per first complex/workflow-changing task rather than every call |
| 小犇 / Dify | deterministic System Instruction plus normal MCP discovery |
| WorkBuddy | deterministic System Prompt and generated progressive-disclosure Skill |

No document claims that a Host must inject Instructions, Resources, or Prompts into model context. Dify and WorkBuddy adapters remain necessary for clients whose Host does not do so.

## Workflow rules

- **READ:** use bounded current Salesforce reads; prioritize user-requested fields, the proven display/name field and trusted hyperlink, then a small number of current context fields. Multi-record output uses roughly 6–10 useful columns; internal IDs are supporting detail rather than the primary label.
- **CREATE:** inspect current CREATE action context when available; separate current-evidence required fields, 3–8 skippable recommendations, and other optional fields; use reliable Salesforce defaults; show active Record Type Picklist choices; resolve dependencies and Lookups; call CREATE once; return the display name, link, and key created values.
- **UPDATE:** prove exactly one target; inspect only relevant UPDATE context; never treat CREATE-required fields as a full update form; send only fields explicitly requested; call UPDATE once; return the link and actual changes.
- **DIAGNOSIS:** proceed only when the two Diagnostic Tools and verified configuration are ready; keep DIAGNOSTIC metadata evidence separate from USER business-record data; distinguish evidence, inference, and uncertainty.
- **LOOKUP:** never guess an ID; use bounded candidates, accept only a proven unique target, and ask the user for zero/multiple results.
- **PICKLIST:** show current valid choices whenever asking; use the active Record Type; confirm the controller first and show only dependency-valid values.
- **ERRORS:** preserve Salesforce authority and safe Error Codes; never automatically retry `MCP_DML_OUTCOME_UNKNOWN`, and use independent read-only verification before any later mutation.

The Playbook contains no Quote, Lead, Opportunity, or customer-field branch. Field recommendations remain Agent reasoning over current Salesforce evidence, not a TypeScript or database whitelist.

## Dynamic Forms limitation

Current `get_record_action_context` supplies Record Type, Page Layout order/required/editability/defaults, Picklist choices, and dependency evidence. It does not evaluate Lightning Dynamic Forms or the complete Lightning page visibility engine. Every runtime capability reports `dynamicFormEvidence: "NOT_AVAILABLE"`; the Agent degrades to available action context plus user clarification and final Salesforce validation. No Runtime Form Engine or visibility-rule emulator was created.

## Identity contracts

```text
小犇 / Dify:  Bearer <CURRENT_USER_TOKEN> -> BUNTU_TOKEN -> data.userId
WorkBuddy:    Bearer <USER_BOUND_TOKEN>   -> current Identity Route
Internal:     Bearer <MCP_CLIENT_TOKEN> + X-Platform-User-Id
                                      |
                                      v
platformUserId -> Identity Route -> Salesforce username -> fresh Connection
```

None of the Playbook surfaces accepts a Salesforce username or platform identity as Tool authority.

## Governance and upstream result

No official Salesforce TypeScript implementation, official Tool, Provider API, JSforce implementation, or stdio host is modified. MCP SDK remains exact `1.18.2`; the implementation uses its existing public Instructions, Resource, Prompt, and Tool APIs. Root `package.json` gains only `agent:sync` and `agent:check`; the existing `packages/*` workspace discovers the new package and `yarn.lock` has no P6-Agent dependency delta.

No prompt table, prompt editor/history/publisher, database migration, business-object workflow, permission replica, Dynamic Forms evaluator, runtime form engine, DELETE, cache, or new external service is introduced.

P6-Agent-01 completion does not mark the whole P6 phase complete. Real 小犇 and WorkBuddy business-scenario evaluation remains a separate unstarted Maintainer Gate.

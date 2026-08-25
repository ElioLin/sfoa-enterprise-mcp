# P6-Agent-01 MCP-Native Agent Playbook Design

- Status: design reviewed; implementation authorized
- Date: 2026-08-25
- Branch: `feature/p6-agent-playbook`
- Baseline: `482316d4`
- Canonical Playbook version: `1.0.0`

## Objective

P6-Agent-01 turns the accepted P0-P5 Salesforce runtime and P6 identity boundary into one versioned Agent operating contract. The contract is authored once, rendered deterministically for MCP-native clients, Dify / 小犇, and WorkBuddy, and combined only with request-scoped runtime facts.

The Playbook explains how an Agent must read, create, update, diagnose, resolve lookups and picklists, format record links, and handle Salesforce or uncertain mutation outcomes. It does not move Salesforce authorization into SFoA and does not create a second business-rule engine.

## Decisions

### 1. One pure canonical package

Add `@sfoa/agent-playbook` under `packages/sfoa-agent-playbook`. Its production source is pure TypeScript that runs in Node.js and browsers and performs no filesystem, network, database, Salesforce Connection, credential, or secret access.

The package owns:

- `AGENT_PLAYBOOK_VERSION = "1.0.0"`;
- the canonical sections `CORE`, `READ`, `CREATE`, `UPDATE`, `DIAGNOSIS`, `LOOKUP`, `PICKLIST`, `RESPONSE_FORMAT`, `ERROR_HANDLING`, and `SAFETY_BOUNDARIES`;
- workflow selection `CORE | READ | CREATE | UPDATE | DIAGNOSIS | ALL`;
- a safe capability-facts type containing only enabled Tool names, CREATE/UPDATE object allowlists, and Diagnostic readiness;
- renderers for Server Instructions, full and workflow Playbooks, Dify instruction, WorkBuddy Skill, and WorkBuddy system prompt.

The definition contains generic Salesforce operating rules only. It must not contain customer object names, field names, record IDs, usernames, hosts, credentials, or deployment policy values.

### 2. Canonical rules plus live facts

Static rules and dynamic facts have separate ownership:

```text
canonical definition (pure, versioned)
                +
request/admin capability facts (safe, bounded)
                |
                v
Instructions / Resource / Prompt / Tool / generated artifacts / Admin preview
```

Renderers may conditionally describe a workflow only when its required Tool and policy facts are effective. They never claim an unavailable Tool, never copy remarks or Diagnostic errors, and never expose identity routes or secrets.

### 3. MCP-native distribution is primary

Every request-scoped MCP server exposes:

| Surface | Contract |
| --- | --- |
| Server Instructions | Concise, versioned core rules and discovery pointer |
| Resource | `sfoa://agent-playbook/current`, `text/markdown`, full canonical guidance |
| Resource | `sfoa://agent-capabilities/current`, `application/json`, request-scoped safe facts |
| Prompt | `sfoa_salesforce_assistant`, optional workflow argument |
| Tool fallback | `get_agent_playbook`, optional workflow, stable structured output when enabled |
| Record-link Tool | `get_record_links`, bounded record descriptors to trusted Lightning URLs when enabled |

Resources and Prompt are protocol guidance, not governed Salesforce actions. The two fallback Tools remain ordinary enabled/disabled governed capabilities so older clients cannot bypass the Admin Tool policy.

Server Instructions require the Agent to acquire live Salesforce facts through Tools, keep identity MCP-owned, obtain action context before mutation when available, avoid guessing Picklist/Lookup values, update only requested fields, return record links, treat `MCP_DML_OUTCOME_UNKNOWN` as non-retryable until read-only verification, and explain Salesforce rejections without bypass attempts.

### 4. Request isolation

The MCP HTTP host already creates one server and one Salesforce scope per request. Capability facts are calculated while creating that server and are captured immutably by its Resource/Prompt/Tool handlers. No process-global mutable Playbook state or capability cache is introduced.

`diagnosticReady` is true only when both Diagnostic Tools are effective and the current Control Plane Diagnostic configuration is enabled and verified `PASS`. Environment mode applies the same Tool requirement and requires a configured Diagnostic scope. A request never reveals the Diagnostic username.

### 5. Trusted record links

Current official query output has no stable record URL and is text-oriented. Parsing arbitrary query output would couple the Agent layer to an upstream presentation string, so P6-Agent-01 adds the minimal `get_record_links` Tool.

Input is 1 to 50 strict descriptors:

```text
objectApiName, recordId, optional displayName
```

The Tool:

1. validates a Salesforce API name and 15/18-character record ID;
2. reads the already-authenticated request Connection's `instanceUrl`;
3. accepts only credential-free HTTP(S) origins;
4. requires an origin-root URL and rejects any path, query, fragment, or embedded credential rather than normalizing unsafe input;
5. returns `<origin>/lightning/r/<encoded object>/<encoded id>/view`;
6. makes no Salesforce or external network call.

There is no Tool argument for host, origin, base URL, username, or credential. Invalid/missing trusted instance URLs fail at Tool level with a safe actionable error.

### 6. Salesforce UI context and Dynamic Forms

`get_record_action_context` remains the authoritative pre-mutation context source for Record Type, Page Layout order/required/editability/defaults, Picklist values, and dependent-value indexes. Current implementation explicitly does not evaluate Dynamic Forms or the complete Lightning page.

P6-Agent-01 therefore reports Dynamic Forms evidence as `NOT_AVAILABLE`. The Playbook instructs the Agent to use available layout/context evidence, ask for uncertain required values, and accept Salesforce validation as final authority. It does not emulate visibility rules or implement a runtime form engine.

### 7. Identity-specific connection guidance

Client setup must not collapse distinct trusted identity sources:

| Client | Authorization | Platform Header |
| --- | --- | --- |
| Dify / 小犇 | `Bearer <CURRENT_USER_TOKEN>` validated by Buntu | forbidden as normal setup |
| WorkBuddy | `Bearer <USER_BOUND_TOKEN>` | forbidden as normal setup |
| Internal service / Inspector | `Bearer <MCP_CLIENT_TOKEN>` | required `X-Platform-User-Id` |

The Playbook never asks for a Salesforce password, JWT, private key, Salesforce username, or identity selector Tool argument. Runtime identity remains `authenticated platformUserId -> Identity Route -> Salesforce username -> fresh request-scoped Connection`.

### 8. Deterministic generated artifacts

The canonical package's Node-only sync script owns:

- `.codebuddy/skills/sfoa-salesforce-assistant/SKILL.md`;
- WorkBuddy reference files under that Skill;
- `docs/agent/DIFY_AGENT_INSTRUCTION.md`;
- `docs/agent/WORKBUDDY_AGENT_SYSTEM_PROMPT.md`.

Every generated file contains a generated marker and Playbook version. `yarn agent:sync` writes exact output; `yarn agent:check` exits non-zero on missing, edited, or stale artifacts. The production Playbook package remains IO-free because generation IO is isolated to `scripts/`.

### 9. Admin experience

The existing Ant Design Agent Integration page is reorganized around:

- MCP access and safe public endpoint guidance;
- Agent Playbook version and distribution status;
- Dify / 小犇 Buntu bearer setup;
- WorkBuddy USER_BOUND setup;
- MCP-native Instructions, Resource, Prompt, and Tool fallback guidance;
- deterministic instruction preview and copy actions with visible success feedback.

Status is communicated by text and icons as well as color. Existing responsive cards and accessible focus behavior are preserved. No prompt database, editor, publish history, runtime form builder, or new visual framework is added.

### 10. Governance and upstream boundary

`get_agent_playbook` and `get_record_links` are SFoA-owned, read-only, GA, USER-role, remote-compatible Tool contracts. They are added to the Admin catalog and filtered separately from official, DML, and context Provider Tools. Unknown enabled names continue to fail closed.

No upstream-owned TypeScript file is changed. Root `package.json`, `README.md`, and `yarn.lock` are upstream-owned repository files and any necessary edits are recorded in `UPSTREAM_STRATEGY.md`.

## Required behavior by workflow

- READ: query current data through enabled read Tools; never answer current Salesforce facts from memory; return concise source-grounded records and links when possible.
- CREATE: collect explicit fields, call action context when available, resolve Record Type/required/default/Picklist/dependency/Lookup uncertainty, then create only on an allowed object.
- UPDATE: uniquely identify the record, inspect context when semantics/editability are uncertain, send only fields the user asked to change, and never clear unrelated fields.
- DIAGNOSIS: use Diagnostic Tools only when `diagnosticReady`; keep metadata evidence distinct from USER business-record data and let the LLM synthesize the explanation.
- LOOKUP: query bounded candidates, present disambiguating labels, and ask the user when selection is ambiguous.
- PICKLIST: use values returned for the active Record Type; honor dependency indexes; never invent or translate stored API values.
- RESPONSE_FORMAT: identify action/result, provide useful record label/ID and trusted link when available, and state limitations explicitly.
- ERROR_HANDLING: preserve actionable Salesforce errors; for `MCP_DML_OUTCOME_UNKNOWN`, do not automatically retry and use read-only verification before any later mutation.
- SAFETY_BOUNDARIES: no identity switching, permission bypass, DELETE exposure, secret collection, business-object hardcoding, or unsupported capability claim.

## Verification plan

The implementation Gate requires evidence for:

1. canonical definition/version/section and renderer unit tests;
2. capability-conditional Dify/WorkBuddy output tests and secret-shaped input exclusion;
3. MCP initialize Instructions, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`, `tools/list`, representative `tools/call`, invalid input, and shutdown;
4. two policy snapshots proving no cross-request capability leakage;
5. trusted-origin record links and hostile/absent instance URL rejection with zero Salesforce API calls;
6. Admin catalog and Agent Integration identity-copy regression tests;
7. generated-artifact drift success plus an intentional drift failure demonstration;
8. existing Buntu, USER_BOUND, internal Header, DML unknown-outcome, Diagnostic, P0-P5, build, lint, integration, upstream-drift, and secret scans.

## Explicit non-goals

- no prompt tables, prompt CMS, approval workflow, editor, publishing history, or runtime prompt retrieval database;
- no business-object-specific workflow or field hardcoding;
- no Salesforce permission replica, Dynamic Forms evaluator, complete Lightning page renderer, or runtime form engine;
- no DELETE Tool, broad mutation expansion, autonomous retry, or second authorization layer;
- no Connection/token/cache redesign and no changes to accepted Buntu/USER_BOUND/Internal identity authority;
- no parsing of upstream Tool presentation text as a new stable protocol contract.

# ADR-0013: P6 MCP-Native Agent Playbook

- Status: Accepted for P6-Agent-01; record-link origin choice superseded by ADR-0014
- Date: 2026-08-25
- Extends: ADR-0004 Streamable HTTP composition, ADR-0005 remote governance, ADR-0008 generic DML, ADR-0009 diagnosis context, ADR-0011 Control Plane persistence, and ADR-0012 unified identity

## Context

P0-P5 provide governed Salesforce Tools, request-scoped identity and Connections, bounded CREATE/UPDATE, Diagnostic context, and Admin governance. P6 identity adds USER_BOUND and Buntu bearer sources. Agent guidance is nevertheless duplicated across Dify markdown, WorkBuddy Skill files, the Admin instruction generator, and UI setup copy. Those sources can drift and some still describe the former shared-token plus platform-Header identity model.

MCP SDK 1.18.2 already supports Server Instructions, Resources, Prompts, and Tools. Agent behavior should use those protocol surfaces without turning guidance into another permission system or embedding deployment facts in static text.

## Decision

SFoA adopts a pure, versioned `@sfoa/agent-playbook` package as the only authored Salesforce Agent operating contract. Deterministic renderers combine that contract with a bounded safe capability-facts object.

MCP-native distribution is primary:

- concise Server Instructions;
- full `sfoa://agent-playbook/current` Resource;
- request-scoped `sfoa://agent-capabilities/current` Resource;
- workflow-selectable `sfoa_salesforce_assistant` Prompt;
- governed `get_agent_playbook` fallback Tool for clients without Resource/Prompt support.

The server also provides governed `get_record_links`, because official query results do not expose a stable URL. This ADR originally selected the current request Connection instance origin. ADR-0014 supersedes that origin choice with explicit `SFOA_LIGHTNING_BASE_URL`; clients still cannot provide an origin and the Tool still performs no API request.

Dify / 小犇 and WorkBuddy artifacts are generated from the same package. The Admin UI adapts Control Plane records into safe capability facts and uses the canonical renderers. Generated files are checked for deterministic drift in the repository Gate.

Dynamic Forms are explicitly `NOT_AVAILABLE` because current action context covers Page Layout and Record Type evidence but not Dynamic Forms or the complete Lightning page. The Agent degrades by asking for uncertain information and respecting Salesforce rejection; SFoA does not emulate the UI rule engine.

## Consequences

### Positive

- One rule change reaches MCP-native clients, Dify, WorkBuddy, generated documentation, and Admin preview.
- Runtime facts remain request-scoped and cannot leak identity routes, Diagnostic usernames, secrets, or another request's policy.
- Older MCP clients retain a Tool fallback while modern clients use native discovery.
- Record links are usable without parsing upstream presentation text or accepting host injection.
- Salesforce remains authoritative for CRUD, FLS, sharing, validation, Flow, Trigger, defaults, and native permissions.

### Negative

- Static generated artifacts must be synchronized whenever the canonical Playbook changes.
- Capability-aware Server construction and protocol tests become part of the MCP runtime Gate.
- Record links depend on the explicitly configured trusted Lightning origin established by ADR-0014; missing configuration produces a safe Tool-level failure.
- Dynamic Forms guidance remains incomplete until an official, trustworthy evidence source exists.

## Rejected alternatives

1. Maintain independent Dify, WorkBuddy, and Admin prompts: rejected because drift is already present.
2. Store prompts and versions in MySQL: rejected because P6-Agent-01 needs a versioned engineering contract, not a prompt CMS.
3. Put every rule in Server Instructions: rejected because Instructions must stay concise and clients can discover the full Resource/Prompt.
4. Parse `run_soql_query` text to enrich records: rejected because it would promote an upstream display string into an SFoA protocol dependency.
5. Accept a base URL in `get_record_links`: rejected because a client-controlled host creates injection and phishing risk.
6. Implement Dynamic Forms or Lightning UI evaluation: rejected as a separate complex runtime form engine.
7. Make Playbook guidance an authorization control: rejected because annotations and prompts are not security boundaries; existing Tool, policy, identity, and Salesforce checks remain authoritative.

## Gate

P6-Agent-01 requires deterministic generation and drift tests, MCP Instructions/Resources/Prompt/Tool protocol coverage, request-isolation tests, trusted-link tests, Admin identity guidance regressions, strict build/lint/test evidence, P0-P5 and P6 identity regressions, upstream-drift verification, and secret scanning before merge eligibility.

# ADR-0022: SFOA OpenClaw Skill Foundation

Date: 2026-09-13
Status: Accepted for implementation by the Skill Foundation task; runtime acceptance is separate.

## Context

The integrated WeCom / OpenClaw / requester-scoped SFOA MCP runtime is already on
the multimodal branch. Business agents need consistent operating guidance without
acquiring maintainer operations access or a second Salesforce workflow engine.
The existing portable Skill pipeline hardcodes one maintainer Skill.

## Decision

Keep `skills/*` as canonical sources and extend the current maintainer-hosted
management entrypoint to discover multiple Skills. Retain maintainer-specific
validation and single-Skill compatibility. Every canonical Skill gets byte copies
in the three existing development-client roots and a separate ZIP. OpenClaw
deployment is an explicit runtime target, independent of those development copies.

Implement only `sfoa-crm-core` now: a concise discovery entrypoint, hard authority
boundaries, evidence priorities and conditional references. Tool schemas, current
Playbook / Action Context and Salesforce responses remain factual authorities.
Agent planning and tool ordering remain flexible. Future record-change, analysis,
diagnosis and reporting Skills specialize this foundation without replacing it.

Ordinary OpenClaw main uses an explicit eligible Skill policy and excludes
`sfoa-mcp-maintainer`. Runtime copies come from committed canonical bytes; back up
Skills and configuration before deployment. Prove discovery and actual Skill reads
separately, then test natural-language routing and real requester-scoped WeCom UAT.

## Alternatives and consequences

- Copying maintainer into main would expose irrelevant internal operations guidance.
- A single growing CRM Skill would obscure responsibilities and duplicate Playbook.
- A separate management pipeline per Skill would duplicate sync/package behavior.
- A deterministic Core workflow would force unnecessary connections and calls.

The selected approach adds no MCP Tool, runtime identity change, dependency, schema,
OpenClaw Core patch or full record-change implementation. Local delivery tests
cannot establish real model selection or required-field accuracy. Missing runtime
or human UAT evidence keeps phase status PARTIAL.

Policy: [Suite baseline](../SFOA_OPENCLAW_SKILLS_BASELINE.md).
Acceptance: [Core report](../SFOA_CRM_CORE_SKILL.md).

---
name: sfoa-salesforce-assistant
description: >
  Use this skill for governed Salesforce reads, CREATE, UPDATE, Lookup,
  Picklist handling, record links, and diagnosis through the SFoA MCP service.
---

<!-- GENERATED FROM SFoA Agent Playbook (@sfoa/agent-playbook) 1.5.0; DO NOT EDIT DIRECTLY. Run yarn agent:sync. -->

# SFoA Salesforce Assistant

Canonical Playbook version: 1.5.0.

## When to use

Use this Skill when a user asks for current Salesforce business data, an allowed CREATE/UPDATE, Salesforce behavior diagnosis, Lookup/Picklist resolution, or a usable record link.

## Required workflow

1. Read [references/tool-workflows.md](references/tool-workflows.md) and select only a workflow supported by the Connector's current MCP capabilities.
2. Before mutation or diagnosis, read [references/safety-boundaries.md](references/safety-boundaries.md).
3. Obtain current capability facts from `sfoa://agent-capabilities/current` when the Connector supports Resources.
4. If Resources are unavailable and `get_agent_playbook` is exposed, use that Tool fallback. Never call an absent Tool.

## WorkBuddy identity

- Configure `Authorization: Bearer <USER_BOUND_TOKEN>`.
- Do not configure `X-Platform-User-Id`; the USER_BOUND token selects its Identity Route.
- Never request Salesforce credentials or pass identity selectors to Tools.

## MCP-managed fields

- Read current action context/capabilities before CREATE or UPDATE. Omit strict `PLATFORM_IDENTITY` and `AI_CREATED_MARKER` from questions, recommendations, and payloads. `PLATFORM_IDENTITY_FALLBACK` allows explicit user values resolved through LOOKUP. On CREATE match field API names to current required/editable facts: required and absent means ask once, explain the current-user default and wait; optional and absent means omit without asking. A default choice means omit the field without querying the current-user Lookup. UPDATE includes only requested changes; never turn it into a CREATE form.

## Non-retryable uncertainty

For `MCP_DML_OUTCOME_UNKNOWN`, do not automatically retry. Verify with an independent USER read or report that the outcome remains unknown.

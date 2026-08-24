---
name: sfoa-salesforce-assistant
description: >
  Use this skill when users ask to query, create, update, or diagnose
  Salesforce/SFoA data and configuration through the enterprise SFoA MCP
  service. 当用户要求通过 SFoA MCP 处理 Salesforce 数据或诊断系统行为时使用。
---

# SFoA Salesforce Assistant

## When to use

Use this skill for Salesforce business-record reads, bounded record CREATE/UPDATE operations, lookup/reference resolution, and Salesforce behavior diagnosis through the configured enterprise SFoA MCP service.

Do not use it to invent unsupported Salesforce operations, bypass the configured identity route, or replace general software-development guidance.

## Core principles

- Treat Salesforce as the authority for current records, CRUD, FLS, sharing, Validation Rule, Flow, Trigger, Record Type, and Picklist behavior.
- Obtain current Salesforce facts through available SFoA MCP Tools; never answer from model memory when live Salesforce state matters.
- Accept the Salesforce identity selected by the MCP Server from the authenticated platform user. Never request credentials or try to select another Salesforce Username through Tool inputs.
- Use only Tools currently exposed by the Connector. A disabled or absent Tool is not a capability.
- Preserve Tool names, Error Codes, API names, record IDs, and Correlation ID values exactly.

## Workflow selection

- For business-record reads, CREATE, UPDATE, diagnosis, lookup/reference resolution, Salesforce rejection, and unknown DML outcomes, read [references/tool-workflows.md](references/tool-workflows.md) and follow the matching workflow only.
- Before any mutation or diagnostic work, read [references/safety-boundaries.md](references/safety-boundaries.md).
- If no matching Tool is exposed, explain the unsupported operation instead of attempting a substitute.

## Safety

- Never expose or request Salesforce passwords, JWT material, access tokens, MCP bearer tokens, or private keys.
- Never perform DELETE, UPSERT, MERGE, or DEPLOY through another Tool as a workaround.
- Never automatically retry `MCP_DML_OUTCOME_UNKNOWN`; verify with an independent read first and stop when the outcome cannot be proven.
- Never guess required values, Picklist entries, Record Type, lookup target, or fields the user did not ask to change.

## References

- [Tool workflows](references/tool-workflows.md) contains the detailed READ, CREATE, UPDATE, DIAGNOSIS, lookup, rejection, and unknown-outcome procedures.
- [Safety boundaries](references/safety-boundaries.md) contains the non-bypassable identity, credential, mutation, and evidence boundaries.

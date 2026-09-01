---
name: sfoa-mcp-maintainer
description: Develop, debug, troubleshoot, investigate, operate, deploy, review, test, and audit the sfoa-enterprise-mcp TypeScript/React/MySQL repository, including Salesforce, MCP runtime, identity, Tool governance, DML, database, Admin, Agent Playbook, and P7 evidence work.
---

# SFoA MCP Maintainer

Use this Skill for engineering and operations work in `sfoa-enterprise-mcp`. It is **advisory project context, not a reasoning boundary**. Use other tools and approaches when they improve the investigation.

Current source code, runtime behavior, MySQL state, logs, P7 Audit evidence, Salesforce API responses, and tests outrank this Skill. When they conflict, investigate the difference, report verified facts, and update the Skill only if durable project knowledge changed.

## Start with evidence

1. Read the repository `AGENTS.md` and the relevant current baseline/architecture files it names.
2. Run `yarn ai:snapshot` to verify packages, scripts, migrations, and catalog sources from the checkout.
3. Run `yarn ai:doctor` when local runtime, database, Admin, or environment state matters.
4. Read only the references needed for the task below; inspect current code before deciding.
5. Preserve the accepted request-scoped identity, Salesforce authorization, Tool-governance, DML, and Audit fail-open boundaries unless the task intentionally changes them.

Never print or paste `.env.local`. The diagnostic scripts load it locally and report configured/missing state without returning secret values.

## Route by task

- Architecture or takeover: read [architecture.md](references/architecture.md), [repository-map.md](references/repository-map.md), and [runtime-flow.md](references/runtime-flow.md).
- MySQL, identity, governance, or P7 evidence: read [database-audit.md](references/database-audit.md). Use `yarn ai:db --report <name>` and `yarn ai:audit` before ad hoc SQL.
- Incident or bug investigation: read [troubleshooting.md](references/troubleshooting.md) and follow the evidence chain rather than assuming one layer caused the symptom.
- TypeScript/React/MCP implementation or review: read [development.md](references/development.md) and the nearest package `README.md` / `DEVELOPING.md`.
- Startup, health, deployment, and maintenance: read [operations.md](references/operations.md).
- Gate selection and verification: read [testing.md](references/testing.md).
- Skill or durable project-fact changes: read [skill-maintenance.md](references/skill-maintenance.md).
- The “Lead only; Account/Opportunity unavailable” validation case: read [acceptance-scenario.md](references/acceptance-scenario.md).

## Local diagnostic commands

```text
yarn ai:snapshot
yarn ai:doctor
yarn ai:db --report summary
yarn ai:db --report routes --user <platformUserId>
yarn ai:db --report tools --tool run_soql_query
yarn ai:db --report dml --object Lead
yarn ai:audit --trace <publicAuditId>
yarn ai:audit --correlation <correlationId>
yarn ai:audit --user <platformUserId> --latest 5 --since 24h
```

These tools are workspace-only maintainer utilities, not MCP Tools. Database access is restricted to predefined `SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN` operations inside a read-only transaction. Payload bodies are not loaded by default.

The current P7 schema has `publicAuditId`, `correlationId`, per-Audit Event sequence, and `publicApiCallId`. It does not have `traceId`, `sessionId`, `callId`, `parentCallId`, or `spanId`. `--trace` is only a user-facing alias for `publicAuditId`; keep unsupported fields explicitly unavailable.

## Durable safety boundaries

- Resolve remote identity from the authenticated principal to `platformUserId`, then the configured Salesforce route; Tool arguments never choose a Salesforce user.
- Salesforce remains authoritative for CRUD, FLS, sharing, validation, Flow, Trigger, and native permissions.
- Tool visibility and DML object/operation policy are independent. READ access through `run_soql_query` is not granted or restricted by DML policy.
- Generic mutation exposes CREATE and UPDATE only. Missing effective policy denies; unknown mutation outcome is never automatically retried.
- MySQL-mode governance is request-snapshotted and fail-closed. Runtime Audit persistence is asynchronous observational evidence and fail-open with respect to Tool/Salesforce results.
- Do not expose maintainer database or Audit diagnostics through the public business MCP server.
- Do not log access tokens, Buntu/USER_BOUND tokens, JWT/private-key material, database/Admin passwords, encryption/session secrets, or unredacted authorization records.

For a lasting architecture, package, schema, command, deployment, or troubleshooting change, update the canonical Skill, run `yarn skill:sync`, `yarn skill:check`, `yarn skill:delivery`, and `yarn skill:test`, then update the project baseline/changelog/ADR when required. `yarn skill:smoke` rebuilds a clean checkout from committed `HEAD` bytes (`git archive`) and reruns the gates there, so the evidence comes from committed Git bytes rather than a possibly dirty working tree.

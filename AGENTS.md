# SFoA Enterprise MCP agent bootstrap

This repository is `sfoa-enterprise-mcp`, an SFoA-owned enterprise runtime extending the official Salesforce DX MCP codebase.

For development, review, debugging, testing, deployment, operations, MySQL, Salesforce, identity, governance, DML, or P7 Audit work, read the project Skill at `.agents/skills/sfoa-mcp-maintainer/SKILL.md` and only the references relevant to the task.

The Skill is advisory context, not a reasoning boundary. Current source code, runtime behavior, database state, logs, P7 Audit evidence, Salesforce API responses, and tests are the facts. Investigate conflicts; do not blindly follow stale guidance.

Before planning or editing, also read:

1. `docs/sfoa/PROJECT_BASELINE.md`
2. `docs/sfoa/ARCHITECTURE.md`
3. `docs/sfoa/MCP_ENGINEERING_RULES.md`
4. `docs/sfoa/UPSTREAM_STRATEGY.md`
5. The nearest package `README.md` / `DEVELOPING.md`

Keep the upstream-first order: reuse an official Tool, extend the Provider/composition seam, reuse an official SDK, then add a minimal standard-API implementation. Avoid style-only edits to upstream-owned code. Record unavoidable upstream-file changes in `UPSTREAM_STRATEGY.md`.

Preserve request-scoped identity, Salesforce authorization, stdio and Streamable HTTP, strict TypeScript, default-deny Tool/DML governance, and Audit fail-open semantics. Runtime incidents should be investigated with P7 Audit evidence when available.

Never print or commit `.env.local`, passwords, access/Buntu/USER_BOUND tokens, JWT/private-key material, encryption/session secrets, or unredacted authorization records.

When durable architecture, package/schema topology, commands, deployment, or troubleshooting knowledge changes, update the canonical `skills/sfoa-mcp-maintainer`, project baseline/changelog/ADR as applicable, then run `yarn skill:sync`, `yarn skill:check`, and `yarn skill:test`.

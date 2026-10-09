# SFoA Enterprise MCP

Use `.claude/skills/sfoa-mcp-maintainer/SKILL.md` for repository development, review, debugging, testing, MySQL/Audit diagnosis, Salesforce/MCP operations, and deployment. Read only its task-relevant references; the canonical source is `skills/sfoa-mcp-maintainer/`.

For any task that designs, adds, changes, or reviews an MCP server, Tool, or Tool contract, first use `.claude/skills/mcp-builder/SKILL.md` as the design checklist (canonical source `skills/mcp-builder/`, imported upstream guidance recorded in `skills/mcp-builder/PROVENANCE.md`). Repository contracts, current code, and the maintainer Skill outrank it.

The Skill is advisory, not a reasoning boundary. Current code, runtime behavior, MySQL state, logs, P7 Audit evidence, Salesforce API responses, and tests outrank documentation. Investigate differences and update the canonical Skill only for durable project changes.

Also follow root `AGENTS.md`, the four required `docs/sfoa` baseline/architecture/rules/upstream files, and the nearest package docs before editing. Never print `.env.local` or expose passwords, tokens, JWT/private-key material, encryption/session secrets, or unredacted authorization records.

Use `yarn ai:snapshot` and `yarn ai:doctor` to verify the checkout/local state. Runtime diagnosis should use `yarn ai:audit` when P7 evidence exists. Generated `.claude`, `.agents`, and `.codebuddy` Skill copies must match the canonical source via `yarn skill:sync` / `yarn skill:check`.

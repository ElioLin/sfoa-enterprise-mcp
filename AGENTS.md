# SFoA Enterprise MCP Agent Rules

These rules apply to every human or AI contributor in this repository.

## Required reading

Before planning or editing code, read:

1. `docs/sfoa/PROJECT_BASELINE.md`
2. `docs/sfoa/ARCHITECTURE.md`
3. `docs/sfoa/MCP_ENGINEERING_RULES.md`
4. `docs/sfoa/UPSTREAM_STRATEGY.md`
5. The nearest package `DEVELOPING.md` and `README.md`

If a requested change conflicts with the baseline, update the baseline and changelog in the same change. If it changes an accepted architectural decision, add or supersede an ADR.

## Upstream first

Use this decision order:

1. Reuse an existing Salesforce DX MCP capability.
2. Extend the official Provider API with a new provider, adapter, middleware, or composition package.
3. Reuse an official `@salesforce/*` Node/CLI SDK.
4. Implement a minimal provider over a standard Salesforce API.
5. Add complex custom infrastructure only when the preceding options are demonstrably insufficient.

Do not duplicate an official Tool under a new business-flavoured name. Analysis and summarization belong to the LLM/agent unless deterministic server-side behavior is required.

Treat files present at upstream commit `670234dbdca4d3fcdebd9d58b231e311fd34aeec` as upstream-owned. Prefer new SFoA packages and files. Any modification to an upstream-owned file must be recorded in `docs/sfoa/UPSTREAM_STRATEGY.md` with file, reason, alternative, and merge risk.

## Engineering quality gates

- Use the repository-pinned Yarn Classic runtime and project-local dependencies.
- Never require globally installed TypeScript, React, Vite, or Ant Design.
- Keep TypeScript strict. Do not introduce `any`; validate external data as `unknown` with Zod or a type guard.
- Use async/await and explicit `Promise<T>` return types for I/O paths.
- Do not submit pseudocode or placeholder production implementations.
- Do not refactor official code merely for style or “clean code”. Upstream compatibility outranks aesthetic consistency.
- Before handoff, run the relevant install/build/test/lint/integration gates and record actual results. Never claim a gate passed without evidence.
- Keep `SFOA_CHANGED_CODE_LINT` green. Reproduced unchanged Salesforce lint findings may be recorded as `UPSTREAM_LINT_BASELINE = KNOWN UPSTREAM DEBT`, but never use that label to waive a new error.
- Preserve both stdio (local clients) and Streamable HTTP (remote clients).
- Do not start a later phase until the current phase Gate is reviewed.

## MCP Tool contract

Every new Tool must:

- Have a stable, action-oriented `snake_case` name and a precise description that matches behavior.
- Use constrained, described Zod input schemas; reject unknown or unsafe input where practical.
- Define `outputSchema` and return `structuredContent` when a stable structured result is useful. Also return concise text content for broad client compatibility.
- Set all applicable annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`. Annotations are hints, never authorization controls.
- Return Tool-level failures with `isError: true` and an actionable, non-secret-bearing message. Protocol errors are reserved for protocol failures.
- Bound list/query output, support pagination or cursors, report `has_more`/next cursor, and provide a clear truncation message.
- Avoid logging to stdout in stdio mode. Never log access tokens, JWTs, private keys, secrets, or unredacted authorization records.

Required MCP checks include initialize, `tools/list`, representative `tools/call`, invalid input, authorization failure, and transport shutdown. Use the project-local MCP Inspector or SDK client; do not require a global Inspector install.

## Identity and Salesforce authorization

The target route is `platformUserId -> Salesforce username -> JWT/OAuth -> request-scoped Connection -> official Tool`.

- Salesforce remains the authority for CRUD, FLS, sharing, validation rules, Flow, Trigger, and native permissions.
- Do not build a second Salesforce permission engine.
- Do not trust a client-supplied Salesforce username without resolving it through the authenticated platform identity.
- Do not use the upstream process-scoped `--orgs` cache as the final remote multi-user authorization boundary.
- Production Salesforce access must use direct JWT/OAuth through `@salesforce/core`; Salesforce CLI and its Auth Cache are development diagnostics only, not runtime dependencies.
- Be aware that current official Tools call `process.chdir(directory)`. Any concurrent HTTP host must isolate or serialize that global side effect until it is removed upstream or safely adapted.

## Mutations and secrets

- P3 mutations are limited to configured object/operation allowlists. Missing configuration means DENY.
- Initial scope allows CREATE and UPDATE only. DELETE is not exposed.
- Keep real values in `.env.local`, `.env.test.local`, or the current shell session.
- Never commit private keys, `.env.local`, access tokens, refresh tokens, connected-app secrets, or copied Salesforce auth files.
- `.env.example` contains names and empty examples only.

## Scope discipline

P0 is architecture and compatibility validation only. It must not create the production Admin UI, database schema, full identity router, DML provider, policy engine, metadata snapshot, evidence graph, runtime form engine, or complex RBAC.

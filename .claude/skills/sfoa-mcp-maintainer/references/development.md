# Development and review

## Change workflow

1. Clarify the behavior and affected authority boundary.
2. Inspect current code, tests, nearest package docs, and executable contracts.
3. Apply upstream-first reuse and identify the smallest cohesive change.
4. Preserve strict TypeScript, `unknown` validation, async/await, and explicit Promise return types on I/O.
5. Add unit/contract/error/isolation coverage proportional to risk.
6. Run package lint/test/build, MySQL integration when persistence changes, MCP protocol/live gates when runtime changes, and Admin browser gates when UI/API changes.
7. Check Audit impact and whether durable Skill/project documentation changed.

Reasonable refactoring is allowed when evidence justifies it. Do not preserve obsolete architecture merely because this Skill describes it; update the accepted baseline/ADR when the decision changes.

## MCP review points

- Stable action-oriented `snake_case` name, strict bounded Zod input, useful output schema/structured content, concise text compatibility, all applicable annotations.
- Tool-level actionable safe failures; protocol errors only for protocol failures.
- Registration-time visibility and authorization remain separate from annotations.
- List/query bounds, pagination/cursor, `has_more`, and explicit truncation.
- Stdio stdout remains protocol-only; HTTP auth/identity occurs before Salesforce scope creation.
- Keep Salesforce access behind the request-owned `SalesforceConnectionProvider`. Route/context/Control Plane/workspace-directory composition must not call `getConnection()`; only verified Salesforce-dependent execution paths may obtain it. Do not add Tool-name skip lists or cross-request caches.

## Data and UI review points

- MySQL migrations are forward-only and old migrations are never edited after release.
- Repository/API/UI share current contracts; optimistic row versions and transaction semantics remain explicit.
- Audit list/detail never load `safe_payload` eagerly.
- React changes cover loading, empty, error, narrow layout, URL/query state, and Chinese-first operator labels without obscuring technical codes.

Avoid new dependencies or abstractions without a demonstrated repeated use. Do not refactor official Salesforce code for style.

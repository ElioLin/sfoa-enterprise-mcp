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

## P11-A reproducible engineering (2026-10-19)

Use Node 22.23.1 and Yarn Classic 1.22.22 for MCP engineering/CI, matching the
MCP deployment record; OpenClaw's Node 24 is a separate toolchain. Run
`yarn install --frozen-lockfile --non-interactive`, then `yarn build` for all
workspaces or `yarn build:sfoa` for SFoA targets and their full prerequisite
closure. Both use scripts/build-workspaces.mjs: Yarn's actual workspace resolution,
TypeScript references and Wireit build prerequisites determine one stable sequential
plan. Published versions that do not match local workspaces remain published; an
explicit TypeScript reference only orders local artifacts and never changes linking.
Each original package build (including analyzer resource copies) is preserved.

On Windows run Yarn package scripts with Git Bash (npm_config_script_shell set to
the installed Git Bash executable) so upstream cp still works. No node_modules,
dist/lib, .wireit or tsbuildinfo is restored in CI. yarn p5:dev, validate:p5 and
p5:e2e:fullstack prebuild through the shared graph. See docs/sfoa/P11_PLAN.md and
docs/sfoa/P11A_IMPLEMENTATION_REPORT.md for the bounded phase and actual gates.

Before frozen installation, run `yarn lock:check`: Yarn Classic may resolve missing workspace selectors without saving them even with --frozen-lockfile. This engineering check covers exact root/workspace declaration keys and respects Yarn local/published resolution; it complements, rather than replaces, frozen installation and the post-install Git diff.

MCP test scripts, validate:p5 and P8 regression use a test-only Node 22 lifecycle
bootstrap plus a native 300000 ms timeout. They preserve existing test scopes,
concurrency and isolation. The three affected package manifests (Control Plane,
Admin API and MCP server) change scripts only; all version declarations remain
frozen. This bootstrap does not belong in production startup.

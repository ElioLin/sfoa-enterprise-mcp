# P7-08 Agent-Native Maintainer Skill & Local Diagnostic Toolkit — Report

- Status: `COMPLETE` (with HOTFIX01 delivery closure)
- Date: 2026-09-01
- Branch: `feature/p7-end-to-end-audit`

## Scope

P7-08 delivers a canonical, advisory `sfoa-mcp-maintainer` Skill plus a dependency-free local diagnostic toolkit (Project Snapshot, Doctor, read-only MySQL inspection, P7 Audit reconstruction) for Codex, Claude Code, WorkBuddy/CodeBuddy, developers, maintainers, and operators. It is **not** a business MCP Tool and adds no Runtime hot-path behavior. See ADR-0017.

## Delivery root cause (HOTFIX01)

The initial P7-08 commit (`b2e71fd`) was missing the toolkit helper modules:

- `skills/sfoa-mcp-maintainer/scripts/lib/project.mjs`
- `skills/sfoa-mcp-maintainer/scripts/lib/db.mjs`

and their three generated platform copies were therefore also incomplete. Root cause: the root `.gitignore` contains a bare `lib` pattern (intended for TypeScript compile output), which matches **any** directory named `lib` at any depth. `git check-ignore` confirmed `skills/sfoa-mcp-maintainer/scripts/lib/*` was ignored, and `git ls-files` confirmed the helpers were never tracked. Local tests passed because the files existed on the developer's working tree, but a fresh clone would fail on import.

## Fix

- Moved `scripts/lib/` → `scripts/shared/` (a name with no `.gitignore` collision); updated every `./lib/` import and `REQUIRED_FILES` across the toolkit and its test.
- Added a Git delivery/trackability Gate (`manage.mjs delivery` / `yarn skill:delivery`) that fails when a required Skill file is missing, Git-ignored, or untracked, and verifies the ZIP package is complete.
- Added a clean-checkout smoke validation (`yarn skill:smoke`) that rebuilds the repository from `git ls-files` into a temporary directory and re-runs the Skill gates, proving the deliverable does not depend on ignored/untracked developer files.
- `yarn skill:sync` regenerated the three platform copies byte-identically from canonical source.

No `.gitignore` exceptions were added; the helpers were relocated to a directory that is not a compile-output name.

## Skill gate results (all executed)

| Gate | Result |
| --- | --- |
| `yarn skill:validate` | PASS (21 files, 0 errors) |
| `yarn skill:sync` | PASS (3 platform copies written) |
| `yarn skill:check` | PASS (0 drift, byte-identical) |
| `yarn skill:delivery` | PASS (0 ignored, 0 untracked, package complete) |
| `yarn skill:test` | PASS (11/11) |
| `yarn skill:smoke` | PASS (tracked-only checkout: validate/sync/check/test/snapshot all exit 0) |
| `yarn skill:package` | PASS (portable ZIP, SHA-256 recorded) |
| `yarn ai:snapshot` | PASS (branch/commit/schema/tool catalog resolved) |
| `yarn ai:doctor` | PASS (DEGRADED with `--skip-db --skip-services`; env status only, no secret values) |

Read-only DB guard (`SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN` only; rejects DML/DDL/`INTO OUTFILE`/`FOR UPDATE`) is covered by `skill:test` and remains unchanged. Secret masking (`skill:test`) confirms no password/token/JWT/private-key material is emitted. `.env.local` is never printed.

## Product regression (bounded, unchanged product code)

The HOTFIX touches only Skill files and `package.json`; no product TypeScript/React changed.

| Suite | Result |
| --- | --- |
| Control Plane unit tests | PASS (33/33) |
| Control Plane MySQL tests (isolated test DB) | PASS (10/10) |
| Identity runtime tests | PASS (66/66) |
| MCP server `test:p7` | PASS (6/6, incl. performance gates) |
| Admin API tests | PASS (22/22) |
| Admin Web build | PASS |
| Control Plane lint (`tsc --noEmit`) | PASS |

### Known flaky gates (recorded, not fabricated)

- **Admin Web Vitest**: did not complete within a 300 s bound (killed at exit 124/143). This matches the previously recorded 2–3 ~60 s governance-page timeouts with no fixed assertion mismatch; it is a pre-existing flaky/startup gate, not introduced or fixed by P7-08.
- **`validate:p5` / full-stack E2E**: not re-run as an aggregate. Individual product suites above are green; the Admin Web Vitest timeout and prior Admin API `18081` readiness 90 s / Windows `Access is denied` startup observations remain pre-existing environment debt.

## Conclusion

P7-08 is `COMPLETE`. A fresh clone of this commit carries the full Skill runtime, the Skill gates are reproducible from tracked files alone, and the database read-only and secret-masking boundaries are preserved.

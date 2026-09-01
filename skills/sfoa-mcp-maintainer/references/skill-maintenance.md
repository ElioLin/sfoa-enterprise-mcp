# Skill maintenance

This Skill is a canonical, portable project artifact. Edit only `skills/sfoa-mcp-maintainer/`; `.agents`, `.claude`, and `.codebuddy` copies are generated.

## Update when durable facts change

Update for architecture, package/module topology, runtime/identity flow, Tool or DML governance model, Audit/DB schema, startup/test/deployment commands, or repeatedly useful troubleshooting knowledge. Do not encode a one-off bug, transient environment incident, user-specific data, or unverified hypothesis.

## Procedure

1. Verify the change in current code, migrations, runtime, tests, or accepted architecture.
2. Edit the smallest canonical reference and `SKILL.md` routing only if discovery/workflow changed.
3. Keep the entrypoint concise and move conditional detail to references.
4. Run `yarn ai:snapshot` and update stale facts.
5. Run `yarn skill:sync`, `yarn skill:check`, and `yarn skill:test`.
6. Run `yarn skill:delivery` to confirm every required source file and generated copy is Git-tracked and not ignored.
7. Run `yarn skill:package` when an uploadable artifact is needed. The ZIP under `.temp/skill-packages` is disposable, not source of truth.
8. Run `yarn skill:smoke` to prove the Skill gates pass from a fresh checkout rebuilt from committed `HEAD` bytes, with no reliance on developer working-tree or ignored/untracked files.
9. Update project baseline/changelog and add or supersede an ADR when the durable architectural decision changed.

The sync mechanism copies bytes rather than using symlinks for Windows 11 portability. `skill:check` compares recursive SHA-256 maps for all three platform copies. Never hand-edit generated copies. Shared helper modules live under `scripts/shared/` (not `scripts/lib/`): the root `.gitignore` ignores any `lib` directory, so helper modules there would be silently excluded from commits while local tests still pass. The `delivery` gate exists to catch that class of defect.

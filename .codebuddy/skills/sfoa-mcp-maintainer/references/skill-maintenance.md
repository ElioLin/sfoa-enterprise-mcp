# Skill maintenance

This Skill is a canonical, portable project artifact. Edit only `skills/sfoa-mcp-maintainer/`; `.agents`, `.claude`, and `.codebuddy` copies are generated.

## Multiple canonical Skills

The existing `manage.mjs` CLI discovers every direct directory under `skills/`.
Each directory must contain `SKILL.md` with a matching name and a nonempty inline
description; local Markdown links must remain inside the portable Skill.
Maintainer-specific required files, description coverage and advisory-boundary
checks are retained only for `sfoa-mcp-maintainer`. Business Skills do not acquire
its operations scripts or dependencies.

All canonical Skills sync to the same three platform roots with their own names.
`package` creates `.temp/skill-packages/<name>.zip` separately for each Skill.
Use `--canonical skills/<name>` for a single Skill; custom `--output` requires a
single selection. Existing single-Skill function defaults and root command names
remain compatible. Future Skills require no copied management scripts.

`skills/sfoa-crm-core` is business guidance for OpenClaw. Its runtime destination
is `/data/openclaw/workspace/skills/sfoa-crm-core`; deploy from canonical bytes,
back up existing Skills/configuration, verify the current OpenClaw configuration
schema and main eligible list, then validate actual Skill reads in Runs.
Development-client copies are not the business runtime allowlist: ordinary main
must not expose `sfoa-mcp-maintainer`. Suite policy and runtime evidence live in
`docs/sfoa/SFOA_OPENCLAW_SKILLS_BASELINE.md` and `SFOA_CRM_CORE_SKILL.md` in the repo.

`skills/sfoa-record-change` is the second business Skill (Skill-02: readiness
kernel + CREATE + UPDATE + batch mutation + outcome reconciliation). Its runtime
destination is `/data/openclaw/workspace/skills/sfoa-record-change`, and the
ordinary main allowlist carries it alongside `sfoa-crm-core` only. Business Skills
are guidance only: they carry no `scripts/` and no `agents/openai.yaml`, and they
must never name `sfoa-mcp-maintainer`. `toolkit.test.mjs` enforces both, plus a
label/content marker contract per readiness rule and a no-hardcoding guard, so a
business Skill cannot silently inherit the maintainer toolkit or freeze Salesforce
truth. Delivery report: `docs/sfoa/SKILL_02B_IMPLEMENTATION_REPORT.md`; the earlier
phase record is `docs/sfoa/SFOA_RECORD_CHANGE_SKILL.md`.

`scripts/record-change-gates.mjs` is the executable decision model behind the
Skill-02 machine gates. It exists so the gate asserts *behaviour* (target
resolution, minimal patch, per-record readiness, bounded sequential batches,
unknown-outcome reconciliation, CREATE regression) instead of only checking that
doctrine text is present. Two rules keep it honest: it must contain no Salesforce
truth (no object names, Record Type IDs, Picklist values or field API names — every
such fact is an input), and it is a test oracle only, never a Runtime component. If
the live runtime contract and the model disagree, the runtime wins and the model is
what gets fixed. Adding a business-Skill behaviour rule without a gate case here
leaves it unenforced.

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

## OpenClaw runtime copy

`skill:sync` targets development-client copies only. Publishing to a business Agent
uses the same `manage.mjs` CLI with an explicit runtime root:

```text
yarn skill:runtime:sync  --runtime-root /data/openclaw/workspace/skills
yarn skill:runtime:check --runtime-root /data/openclaw/workspace/skills
```

The direction is always canonical → runtime; a runtime copy is never the source of
truth and is never edited in place. Both actions iterate only
`BUSINESS_SKILL_ALLOWLIST` in `manage.mjs`, so `sfoa-mcp-maintainer` cannot reach a
business workspace and a new business Skill requires a deliberate allowlist entry
(`skill:test` fails otherwise). `runtime-sync` refuses symbolic links,
version-control metadata, credentials and executable scripts, and prints a
per-file SHA-256 map for server-side comparison. `runtime-check` fails with exit
code 1 on missing, unexpected or differing files.

Deploying also means updating the Agent policy, which is not a Skill file: the
ordinary business Agent needs `skills.entries.<name>.enabled = true` and its name
added to the non-empty `agents.entries.<agent>.skills` allowlist without dropping
existing legitimate entries.

Refresh semantics, corrected by measurement during the Skill-02B deployment (the
earlier assumption was stricter than reality):

- A **new** Skill needs the policy change above, and that config change itself
  invalidates the snapshot — the gateway logs `skills snapshot invalidated by
  config change (...)` and `config hot reload applied`.
- A **content or description change to an already-eligible Skill** did not require a
  restart: with `skills.load` unset and no watcher, the live gateway still returned
  the new description and a fresh session applied the new body. Restart is the
  fallback, not a routine step.
- Verify against the **running process**, not the filesystem. `openclaw skills list`
  reads the workspace directly and emits no gateway log line, so it cannot prove
  what the live process holds. Use
  `openclaw gateway call skills.status --json`, whose answer comes from the gateway
  and also reports `agentSkillFilter`.
- `openclaw gateway restart` refuses when the state dir or config path is
  non-default ("service management skipped"). The owning unit is the system
  `openclaw-gateway.service`, so the restart path is
  `systemctl restart openclaw-gateway`.

Confirm either way with `openclaw skills list --agent <agent> --json` and compare
`modelVisible` against the intended allowlist. Record the deployment, backup path,
SHA-256 comparison and `modelVisible` result in the phase report.

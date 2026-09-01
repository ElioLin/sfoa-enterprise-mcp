# ADR-0017: Agent-Native Maintainer Skill as a Local Workspace Toolkit

- Status: Accepted for P7-08 implementation
- Date: 2026-09-01
- Supersedes: the P7-08 baseline assumption that diagnostics should be public MCP Tools

## Context

P7-08 needs to help Codex, Claude Code, WorkBuddy/CodeBuddy, developers, maintainers, and operators take over and diagnose this repository. The original P7 outline described an operations-authorized diagnostic interface with MCP Tool contract requirements. The authorized P7-08 scope instead requires a project-local developer toolkit and explicitly forbids the path `business Agent -> public MCP -> internal MySQL`.

Three Agent clients use different project Skill locations. Maintaining three independent copies would drift, while symbolic links are unreliable in the primary Windows 11 environment. Diagnostics also need local `.env.local` access, but must not print credentials or mutate现场 evidence.

## Decision

`skills/sfoa-mcp-maintainer/` is the canonical portable Skill. A dependency-free Node.js manager validates it, copies it byte-for-byte to `.agents/skills`, `.claude/skills`, and `.codebuddy/skills`, rejects drift, and creates a disposable ZIP package. Generated copies are never edited directly.

The Skill is advisory project context, not a reasoning or architecture boundary. Current code, runtime behavior, database state, logs, P7 evidence, Salesforce responses, and tests have higher factual authority. Durable changes update the canonical Skill; one-off incidents do not.

Doctor, snapshot, database inspection, and Audit reconstruction run only from the local workspace. They are not registered with the MCP server, Admin API, or business Tool catalog. Database diagnostics use predefined bounded queries inside `START TRANSACTION READ ONLY`; the SQL guard permits only `SELECT`, `SHOW`, `DESCRIBE`/`DESC`, and `EXPLAIN SELECT`. Diagnostic code cannot perform DDL or DML.

Local environment parsing never emits values. Output recursively redacts secrets and tokens, masks platform/Salesforce identities, omits Payload bodies, and reports configuration as `configured`, `missing`, or `invalid`. This remains true even though ADR-0016 separately permits an explicitly configured raw Buntu token in the protected durable Audit store.

The analyzer follows the real migration-008 schema. It uses `publicAuditId`, `correlationId`, Event sequence, and `publicApiCallId`. `--trace` is a user-facing alias for `publicAuditId`; absent `traceId`, `sessionId`, `callId`, `parentCallId`, and `spanId` remain explicitly unavailable. Current governance/route rows are labeled contextual rather than historical proof.

## Consequences

- Codex, Claude Code, and WorkBuddy/CodeBuddy share one source of truth without symlinks.
- Maintainers can use real local MySQL and P7 evidence without adding a privileged production surface.
- The toolkit cannot alter database evidence; database development and migrations continue through the normal reviewed code path.
- P7-08 does not add a migration, runtime dependency, Salesforce API, business MCP Tool, or hot-path database await.
- `tools/list` and session/call/span evidence remain known P7 gaps and are not inferred.

## Rejected alternatives

1. Public diagnostic MCP Tools: rejected because it exposes an internal-MySQL path to business Agents and creates an unnecessary authorization surface.
2. Three independently maintained Skills: rejected because durable facts would drift.
3. Symbolic links: rejected for Windows portability and ZIP distribution.
4. Free-form SQL from CLI arguments: rejected because it weakens read-only guarantees and complicates safe evidence handling.
5. Copying `.env.local` into reports or process arguments: rejected because it exposes credentials.

## Gate

Canonical validation, three-platform sync/drift checks, ZIP generation, secret masking, read-only SQL rejection, missing environment, unavailable database, Audit-not-found, deterministic reconstruction, project Doctor/Snapshot, real MySQL schema/governance inspection, and repository build/test/lint/integration/validation results must be recorded.

## Post-implementation note (HOTFIX01)

The helper modules originally lived under `scripts/lib/`. The root `.gitignore` has a bare `lib` pattern (compile-output exclusion) that silently ignored that directory, so the helpers existed on a developer machine but were never committed. The helpers were moved to `scripts/shared/` and two durable guards were added: `skill:delivery` (Git trackability of every required Skill file and generated copy) and `skill:smoke` (rebuild a tracked-only checkout and re-run the Skill gates). This is a durable delivery fact, not a reasoning-boundary change; the advisory, secret-safe, read-only design described above is unchanged.

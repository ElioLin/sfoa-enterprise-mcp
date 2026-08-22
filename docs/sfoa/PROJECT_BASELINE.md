# SFoA Enterprise MCP Project Baseline

Baseline ID: **P0-BL-1.2**

Baseline date: 2026-08-22

Authority: This file is the single authoritative delivery-plan baseline for SFoA Enterprise MCP.

## Project vision

Provide an enterprise MCP runtime for Salesforce on Alibaba Cloud (SFoA) that Dify, WorkBuddy, Codex, Cursor, and other MCP-capable agents can use under the real Salesforce identity of the requesting platform user.

## Goals

- Reuse Salesforce's official DX MCP providers and official Node SDKs wherever possible.
- Route each authenticated platform user to a request-scoped Salesforce user connection.
- Let Salesforce enforce CRUD, FLS, sharing, validation, Flow, Trigger, and native permissions.
- Support stdio for local development and Streamable HTTP for remote agents.
- Provide explicit Tool governance and a minimal CREATE/UPDATE allowlist in later phases.
- Make architecture, tests, phase Gates, and Upstream divergence auditable by humans and AI agents.

## Non-goals

- Reimplementing Salesforce's permission engine.
- Building business-analysis Tools such as `pipeline_analysis` or `customer_analysis` when agents can compose generic data/metadata Tools.
- DELETE support in the initial mutation phase.
- Metadata snapshots, evidence graphs, runtime replicas, or a runtime form engine.
- Complex Vault, ABAC, approval, zero-trust, RBAC, database, Redis, or key-lifecycle platforms before a proven requirement.
- A production React Admin UI during P0.

## Architecture principles

1. **Upstream first:** REUSE, then EXTEND, then official SDK, then minimal standard API provider.
2. **Request identity is authoritative:** a remote request must not choose an arbitrary Salesforce username.
3. **Salesforce authorizes:** the runtime selects an identity; Salesforce decides what that identity can do.
4. **Composition over patching:** add SFoA hosts, providers, adapters, and middleware without rewriting official Tools.
5. **Generic capabilities over business analysis:** expose deterministic Salesforce operations and return evidence; let the agent reason.
6. **Bounded mutation:** CREATE/UPDATE only, with explicit object/operation allowlists; absent configuration means DENY.
7. **Two transports:** retain stdio and add Streamable HTTP through the official MCP TypeScript SDK.
8. **Evidence-based Gates:** PASS/PARTIAL/FAIL/NOT TESTED are backed by commands or source references.
9. **Simple until needed:** no database switch or Redis in the first version without an observed need.

## Technology baseline

| Layer | Baseline |
| --- | --- |
| Backend | Node.js current LTS, strict TypeScript, Salesforce DX MCP providers, official MCP TypeScript SDK, official `@salesforce/*` packages, Yarn Classic workspaces |
| Local transport | stdio |
| Remote transport | Streamable HTTP, stateless first |
| Future Admin UI (P5) | React, TypeScript, Vite, Ant Design, TanStack Query, React Router |
| Database | Undecided; no database is introduced in P0 |
| Cache | In-process only where safe; no Redis without a demonstrated requirement |
| Secrets | `.env.local`/shell session; no secrets or private keys in Git |

## Environment baseline

The authoritative machine record is `docs/sfoa/ENVIRONMENT_BASELINE.md`.

Current summary: Git, Node v24.13.0, npm 11.6.2, Yarn 1.22.22, project install/build/test, Inspector, original stdio protocol, and Streamable HTTP pass. Salesforce CLI is partial; Upstream root lint fails on existing code-analyzer errors.

## Upstream strategy

- Official repository: `https://github.com/salesforcecli/mcp.git`
- Remote name: `upstream`
- Company remote: `origin = https://github.com/ElioLin/sfoa-enterprise-mcp.git`
- Audited commit: `670234dbdca4d3fcdebd9d58b231e311fd34aeec`
- Default rule: no edits to official Salesforce implementation files unless an extension cannot satisfy a proven requirement.
- Detailed policy and divergence register: `docs/sfoa/UPSTREAM_STRATEGY.md`.

## Project phases and Gates

| Phase | Scope | Exit Gate |
| --- | --- | --- |
| P0 | Official DX MCP architecture and SFoA compatibility | Environment, pristine Upstream build/test/lint, architecture/auth audit, protocol schemas, SFoA JWT/SOQL/metadata evidence when credentials exist, HTTP POC, decisions and risks documented |
| P1 | Request-scoped identity routing | Authenticated `platformUserId` resolves to one Salesforce identity; concurrent-request isolation tests pass; no client-selected username escape |
| P2 | Remote MCP runtime and Tool governance | Streamable HTTP production host, stdio retained, Tool allow/deny governance, protocol/security/load tests |
| P3 | Minimal generic DML and object allowlist | Generic CREATE/UPDATE provider, absent config DENY, CRUD/FLS remains Salesforce-enforced, DELETE unavailable |
| P4 | Diagnosis and runtime context | Reuse official SOQL/metadata/Apex/code-analysis; only minimal new deterministic context capabilities |
| P5 | React Admin Console | Admin app for routing, allowlists, Tool control, audit, and system configuration; no Salesforce permission replica |
| P6 | Dify/WorkBuddy real-agent evaluation | Real client interoperability and stable, read-only multi-step evaluation suite pass |

Phase order may change only with a same-change update to this file, `CHANGELOG.md`, and an ADR when architectural.

## Phase Gates

- A later phase must not begin until the current phase result is reviewed.
- Required results are `PASS`, `PARTIAL`, `FAIL`, or `NOT TESTED` only.
- A missing external credential can yield `P0 = PARTIAL PASS` only when all independent engineering work is complete and the blocked Gates are explicit.
- Build, test, lint, and integration results must be rerun after material implementation changes.

## Current phase

`P0 — Official DX MCP Architecture & SFoA Compatibility Gate`

## Current status

`P0 = PARTIAL PASS — AWAITING MAINTAINER REVIEW`

All locally independent P0 engineering and architecture work is complete. SFoA live Gates require fresh JWT inputs; the only discovered local authorization has an expired refresh token. Root Upstream lint remains FAIL on 47 existing code-analyzer errors. P1 has not started and is not authorized by this status.

## P0 acceptance decisions

The authoritative evidence and answers are maintained in `P0_FINAL_REPORT.md`. Accepted P0 decisions are:

- Build the remote host as an SFoA-owned composition layer over official provider packages.
- Do not turn the upstream stdio command's process-scoped `--orgs` cache into the remote authorization boundary.
- Keep official Tools unchanged in P0.
- Address global `process.chdir()` safely at the host boundary before concurrent remote use.
- Treat `retrieve_metadata` as a DX project/filesystem operation, not a pure metadata read API.
- Retain the full-history repository and use **FULL FORK + EXTENSION**, with zero official TypeScript patches in P0.
- Add Streamable HTTP through public Provider composition; the P0 initialize/list/call Gate passed.
- Classify Salesforce DX MCP as a **PARTIAL** long-term Runtime Base: reuse Providers/Tools, not the unchanged process-scoped host for shared remote users.

## P0 result

`PARTIAL PASS`

- PASS: environment runtime (except CLI hygiene), full-history clone, install, build, full tests, original stdio initialize/list/call, Inspector, auth/provider architecture audit, and Streamable HTTP POC.
- FAIL: repository-wide Upstream lint (47 existing code-analyzer errors); CLI and official MCP SOQL against the expired local authorization.
- NOT TESTED: fresh SFoA JWT, successful live SOQL, controlled live metadata retrieval, and second-user isolation.
- Official Salesforce TypeScript files modified: 0. Upstream-tracked integration files modified: `.gitignore` only.

## P1 scope (planned; do not start during P0)

1. Define authenticated request context (`platformUserId`, correlation ID, immutable workspace reference).
2. Implement an identity resolver from platform user to configured Salesforce username and JWT material reference.
3. Implement a request-scoped `OrgService`/connection factory; never accept an arbitrary username from Tool arguments.
4. Build provider Tool instances per stateless HTTP request or equivalent isolated execution scope.
5. Wrap Tool execution with a working-directory isolation strategy; the P1 minimum is a global mutex plus restore, with child-process isolation evaluated for metadata/concurrency.
6. Add positive, negative, cross-user, concurrent, token-expiry, and no-route tests.
7. Record the final routing choice in a superseding/accepted ADR before implementation is declared complete.

P1 explicitly excludes the production DML provider, production Admin UI, complex policy engine, database redesign, and Redis.

## Known risks

| Risk | Impact | Current response |
| --- | --- | --- |
| Official host authorization is process-scoped | Cross-user leakage if reused naively over HTTP | New SFoA host and request-scoped Services |
| Official Tools call `process.chdir()` | Concurrent requests can race on global CWD | Serialize/restore initially; evaluate isolated worker processes |
| Provider registry is a static internal array | `@salesforce/mcp` is not a public embeddable host library | Consume public provider packages and build a thin host |
| Metadata retrieve requires an `SfProject` and writes files | Remote runtime needs workspace lifecycle | Design temporary/shared workspace adapter; do not implement in P0 |
| Upstream package versions can temporarily drift from local workspaces | A local provider change may not be the provider version bundled by `@salesforce/mcp` | Pin and record resolved versions; validate packaged server separately |
| Yarn v1 `nohoist` is expensive on Windows | Slow clean installs and CI | Preserve Upstream policy; use cache and measure, do not migrate package manager in P0 |
| Local Salesforce CLI path/plugin state is inconsistent | CLI-based Gate noise | Use direct v2 for P0 evidence and obtain user review for permanent cleanup |
| SFoA JWT inputs are absent | Live compatibility conclusion is incomplete | One consolidated credential request; mark blocked Gates accurately |
| Upstream root lint fails in code-analyzer | Repository-wide lint Gate is red despite official server/dx-core/POC lint passing | Do not patch 47 unrelated official findings in P0; track as Upstream baseline debt |

## Open questions

- Which SFoA connected app and private-key path should be used for the JWT Gate?
- Which object and metadata components are safe, stable P0 test targets?
- Is a second Salesforce user available for the multi-user Gate?
- Does the production WorkBuddy/Dify deployment pass a trustworthy platform-user claim directly, or require a gateway-issued token?
- For metadata operations, is per-request temporary workspace cost acceptable, or is a controlled per-user shared workspace required?

## Baseline change history

| Version | Date | Change |
| --- | --- | --- |
| P0-BL-1.0 | 2026-08-22 | Established project vision, non-goals, Upstream policy, technology baseline, phases, Gates, P1 draft scope, risks, and open questions. |
| P0-BL-1.1 | 2026-08-22 | Closed locally runnable P0 work as PARTIAL PASS; recorded build/test/protocol/HTTP passes, Upstream lint failure, expired SFoA authorization, final fork/extension decision, and P1 review boundary. |
| P0-BL-1.2 | 2026-08-22 | Associated the local `origin` remote with the supplied company GitHub repository and made `origin/main` the project branch tracking target. |

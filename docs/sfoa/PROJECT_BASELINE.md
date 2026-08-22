# SFoA Enterprise MCP Project Baseline

Baseline ID: **P2-BL-1.0**

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
| Database | P0/P0-Closure/P1/P2: none. P2 continues to use the P1 `IdentityRepository` contract and in-memory implementation; persistence is introduced only when durable routing or Admin configuration proves it is needed. |
| Cache | In-process only where safe; no Redis without a demonstrated requirement |
| Secrets | `.env.local`/shell session; no secrets or private keys in Git |

## Environment baseline

The authoritative machine record is `docs/sfoa/ENVIRONMENT_BASELINE.md`.

Current summary: Git, Node v24.13.0, npm 11.6.2, Yarn 1.22.22, P0 fresh SFoA JWT/direct/official SOQL/metadata, and P1 real two-user request isolation all pass. Original stdio and both Streamable HTTP regressions pass. The P1 production path uses direct `@salesforce/core` JWT and no Salesforce CLI or database. Upstream lint and Windows Yarn frozen-reinstall debt remain explicitly isolated.

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
| P0 | Official DX MCP architecture and SFoA compatibility | Environment, Upstream build/test and recorded lint baseline, architecture/auth audit, protocol schemas, live SFoA JWT/direct/official SOQL and one official CustomObject metadata retrieval, HTTP/stdio regressions, decisions and risks documented |
| P1 | Request-scoped identity routing | Authenticated `platformUserId` resolves to one Salesforce identity; concurrent-request isolation tests pass; no client-selected username escape |
| P2 | Remote MCP runtime and Tool governance | Streamable HTTP production host, stdio retained, Tool allow/deny governance, protocol/security/load tests |
| P3 | Minimal generic DML and object allowlist | Generic CREATE/UPDATE provider, absent config DENY, CRUD/FLS remains Salesforce-enforced, DELETE unavailable |
| P4 | Diagnosis and runtime context | Reuse official SOQL/metadata/Apex/code-analysis; only minimal new deterministic context capabilities |
| P5 | React Admin Console | Admin app for routing, allowlists, Tool control, audit, and system configuration; no Salesforce permission replica |
| P6 | Dify/WorkBuddy real-agent evaluation | Real client interoperability and stable, read-only multi-step evaluation suite pass |

Phase order may change only with a same-change update to this file, `CHANGELOG.md`, and an ADR when architectural.

## Phase Gates

- A later phase must not begin until the current phase result is reviewed.
- Required results are `PASS`, `PARTIAL`, `FAIL`, `NOT TESTED`, or `KNOWN UPSTREAM DEBT`. The last value is valid only for a reproduced, unchanged Upstream baseline and never for SFoA-owned changed code.
- A missing external credential can yield `P0 = PARTIAL PASS` only when all independent engineering work is complete and the blocked Gates are explicit.
- Build, test, lint, and integration results must be rerun after material implementation changes.

## Current phase

`P2 — Remote MCP Runtime & Tool Governance (IN PROGRESS)`

## Current status

`P0 = PASS / COMPLETE — MAINTAINER ACCEPTED; P1 = PASS / COMPLETE — MAINTAINER ACCEPTED; P2 = IN PROGRESS`

The repeatable Closure Harness completed Fresh JWT, direct `@salesforce/core` identity, Direct SOQL, official `run_soql_query`, official `retrieve_metadata` for one real CustomObject, temporary workspace cleanup, and CWD restoration. CLI v2 JWT/query cross-check also passed. The maintainer accepted P0-Closure and authorized P1 on 2026-08-22. P0 commits `32469cd`, `d90163f`, and `e80d9fd` were fast-forwarded to `main` without squashing before `feature/p1-request-scoped-identity` was created.

The maintainer had supplied `SECOND_TEST_USER`, but the P0-Closure configuration loader did not read it. Therefore the historical P0 matrix statement "`SECOND_TEST_USER` not supplied" was inaccurate as an input statement while remaining accurate that the second user was not exercised by P0. Historical reports are not rewritten to imply a test that did not occur. The P1 configuration now explicitly consumes `SECOND_TEST_USER`, constructs the second route, and the mandatory real two-user Gate passed.

The maintainer accepted P1 as `PASS / COMPLETE` on 2026-08-22 and authorized P2 Remote MCP Runtime & Tool Governance. The required P1 build, 22/22 tests, strict lint, and live two-user validation were rerun successfully on the accepted P1 branch before merge to `main`.

P1 was fast-forwarded without squashing to `main` at commit `3d35ef6` and pushed before `feature/p2-remote-runtime-governance` was created from that updated `main`. P2 preserves P1 identity routing and adds a separate production HTTP host, minimal internal Bearer client authentication, registration-time Tool governance, remote schema adaptation where the public Provider API permits it, request bounds/timeouts, graceful shutdown, and remote-client contracts. P2 remains read-only and database-free.

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
- Use `Node.js -> JWT/OAuth -> @salesforce/core -> AuthInfo/Connection -> official Provider` in production. Salesforce CLI is a development diagnostic/cross-check only and is not a production dependency.
- Require no database in P0/P0-Closure. P1 starts behind an `IdentityRepository` interface and may use an in-memory/local test mapping for the routing POC; persistence must not block request-scoped identity isolation.
- Pin and independently regress the verified Provider version sets in `PROVIDER_COMPATIBILITY.md`; never depend on accidental Yarn resolution.
- Normalize lint as `UPSTREAM_LINT_BASELINE = KNOWN UPSTREAM DEBT` plus `SFOA_CHANGED_CODE_LINT = PASS`.
- Close P0 live compatibility as PASS: Fresh JWT, Identity Match, Direct SOQL, official SOQL, official CustomObject Metadata, and CWD boundary restoration all passed. The official Tool's CWD side effect remains a P1/P4 concurrency risk because the Harness, not the official Tool, restored it.

## P0 result

`PASS`

- PASS: environment runtimes, full-history clone, original P0 install/build/test baseline, fresh SFoA JWT, direct Connection/Identity, Direct SOQL (5 rows), official `run_soql_query` (5 rows), official `retrieve_metadata` for a real CustomObject (135 files), temporary-workspace lifecycle, CWD boundary restoration, CLI v2 JWT/query cross-check, original stdio initialize/list/call regression, Streamable HTTP regression, auth/provider architecture audit, Provider compatibility baseline, Closure Harness tests (9/9), and SFoA changed-code lint.
- KNOWN UPSTREAM DEBT: repository-wide lint reproduces 47 existing code-analyzer errors; no SFoA change is among them.
- NOT TESTED: second-user request isolation and optional additional Metadata types (ValidationRule, Flow, ApexClass/ApexTrigger, Layout, FlexiPage); these are not P0 closure requirements.
- Official Salesforce TypeScript files modified: 0. Upstream-tracked integration files modified: `.gitignore` only.

## P1 scope (complete)

1. Define authenticated request context (`platformUserId`, correlation ID, immutable workspace reference).
2. Define an `IdentityRepository` interface and implement an identity resolver from platform user to configured Salesforce username and JWT material reference. An in-memory/local test mapping is sufficient for the P1 runtime POC.
3. Implement a request-scoped `OrgService`/connection factory; never accept an arbitrary username from Tool arguments.
4. Build provider Tool instances per stateless HTTP request or equivalent isolated execution scope.
5. Wrap Tool execution with a working-directory isolation strategy; the P1 minimum is a global mutex plus restore, with child-process isolation evaluated for metadata/concurrency.
6. Add positive, negative, cross-user, concurrent, token-expiry, and no-route tests.
7. Record the final routing choice and evidence in accepted ADR-0003 before implementation is declared complete.
8. Reserve `ConnectionRole = USER | DIAGNOSTIC` in request/connection contracts. P1 implements only `USER`. A fixed Diagnostic Integration User is deferred to P4 and must never execute business SOQL, record query, CREATE, or UPDATE.

P1 explicitly excludes the production DML provider, production Admin UI, complex policy engine, database-first redesign, and Redis. A persistent database is added only when routing management or Admin configuration actually requires it; it must not block the request-scoped runtime POC. P1 production/runtime tests must not depend on the local Salesforce CLI Auth Cache.

## P1 result

`P1 = PASS`

- Two real routes were created from `SALESFORCE_USERNAME` and the now-consumed `SECOND_TEST_USER`; both completed fresh JWT and `Connection.identity()` with exact route matches.
- The stateless P1 HTTP host exposed exactly the unchanged official `get_username`, `run_soql_query`, and `retrieve_metadata` Tools. Official identity and read-only SOQL calls passed for A and B.
- A→B and B→A forged usernames were blocked with `MCP_IDENTITY_CONTEXT_MISMATCH` before JWT/Connection creation for the forged target. Unknown and missing platform users were denied without fallback.
- Twenty interleaved requests completed with `Identity Mismatch = 0`, `Cross User Leak = 0`, and `Connection Reuse = 0`.
- Two concurrent official metadata calls serialized through the exclusive CWD guard, used distinct temporary DX workspaces, restored process CWD, and cleaned all request roots.
- `@sfoa/identity-runtime` build, 22/22 tests, and strict TypeScript lint passed. Root build and full workspace tests passed; original stdio, P0 Streamable HTTP, and P0 live runtime regressions also passed.
- Repository-wide lint still stops on 47 unchanged official code-analyzer errors: `UPSTREAM_LINT_BASELINE = KNOWN UPSTREAM DEBT`. `SFOA_CHANGED_CODE_LINT = PASS`.
- Salesforce CLI runtime dependency: none. Database/Redis/cache/pool dependency: none. Official Salesforce TypeScript files modified by P1: 0. Root `package.json`, `yarn.lock`, and `.env.example` were unchanged by P1.

P1 has received maintainer review and is accepted. P2 is authorized only on a new branch created from the updated `main`; no P2 implementation belongs on the P1 branch.

### P1 entry criteria — satisfied (historical)

- P0-Closure live Fresh JWT, Direct Connection, Identity Match, Direct SOQL, official SOQL, and at least one official CustomObject metadata retrieval are PASS.
- Original stdio, Streamable HTTP, and SFoA changed-code lint regressions remain PASS.
- The maintainer reviews `P0_CLOSURE_REPORT.md` and explicitly authorizes P1.

All three criteria are satisfied. The completed P1 Gate subsequently received maintainer review and P2 authorization.

## Known risks

| Risk | Impact | Current response |
| --- | --- | --- |
| Official host authorization is process-scoped | Cross-user leakage if reused naively over HTTP | P1 uses a new SFoA host and fresh request-scoped Services/Connection/Tools; P2 must authenticate the upstream claim |
| Official Tools call `process.chdir()` | Concurrent requests can race on global CWD | P1 shared/exclusive guard restores CWD and serializes metadata; evaluate isolated workers only from measured pressure |
| Provider registry is a static internal array | `@salesforce/mcp` is not a public embeddable host library | Consume public provider packages and build a thin host |
| Metadata retrieve requires an `SfProject` and writes files | Remote runtime needs workspace lifecycle | P1 uses one bounded disposable DX workspace per POST; avoid shared workspaces until proven necessary |
| Upstream package versions can temporarily drift from local workspaces | A local provider change may not be the provider version bundled by `@salesforce/mcp` | Pin and record resolved versions; validate packaged server separately |
| Yarn v1 `nohoist` is expensive on Windows | Slow clean installs and CI | Preserve Upstream policy; use cache and measure, do not migrate package manager in P0 |
| This already-open process still has the legacy Salesforce CLI PATH snapshot | CLI command may resolve 1.86.7 until terminal restart | Persistent user PATH now prefers the stable v2 shim; open a new terminal and verify v2.148.3. Production does not use CLI. |
| SFoA credentials are local-only | Credentials must remain out of Git and reports | `.env.local` is ignored; live Gates passed without persisting values or tokens |
| Upstream root lint fails in code-analyzer | Repository-wide lint Gate is red despite SFoA changed-code lint passing | Record `KNOWN UPSTREAM DEBT`; do not patch 47 unrelated official findings in P0 |
| Yarn Classic frozen reinstall hits a repeatable Windows `brace-expansion` link error | A from-scratch reinstall is not currently reproducible in this worktree and can remove generated `.bin` shims before failing | Preserve the unchanged lockfile; restore only local generated shims when needed; root build/full tests and targeted Gates passed; investigate separately from P1 identity correctness |

## Open questions

- What authenticated gateway claim/token will replace P1's trusted internal `X-Platform-User-Id` Header in P2?
- Is per-request JWT/Connection cost acceptable under P2 load, or is a strictly identity-keyed, expiry-aware cache justified by measurements?
- Is serialized metadata plus a per-request temporary workspace sufficient under measured load, or is process isolation justified?
- What P2 Tool allow/deny policy is required while keeping DML and mutation allowlists deferred to P3?

## Baseline change history

| Version | Date | Change |
| --- | --- | --- |
| P0-BL-1.0 | 2026-08-22 | Established project vision, non-goals, Upstream policy, technology baseline, phases, Gates, P1 draft scope, risks, and open questions. |
| P0-BL-1.1 | 2026-08-22 | Closed locally runnable P0 work as PARTIAL PASS; recorded build/test/protocol/HTTP passes, Upstream lint failure, expired SFoA authorization, final fork/extension decision, and P1 review boundary. |
| P0-BL-1.2 | 2026-08-22 | Associated the local `origin` remote with the supplied company GitHub repository and made `origin/main` the project branch tracking target. |
| P0-BL-1.3 | 2026-08-22 | Added P0-Closure Harness and user test flow; normalized lint debt, established exact Provider baselines, removed CLI/database from production/P0 assumptions, moved the second-user Gate to P1, and retained PARTIAL PASS pending live SFoA inputs. |
| P0-BL-1.4 | 2026-08-22 | Completed live SFoA JWT, identity, Direct/official SOQL, CustomObject metadata, CWD boundary, and CLI v2 cross-check Gates; upgraded P0 to PASS while keeping P1 unstarted and recording remaining Upstream/concurrency risks. |
| P1-BL-1.0 | 2026-08-22 | Recorded maintainer acceptance of P0, corrected the historical `SECOND_TEST_USER` input omission without rewriting P0 results, entered P1 on an isolated feature branch, retained a database-free in-memory repository, and reserved the non-implemented P4 `DIAGNOSTIC` connection role. |
| P1-BL-1.1 | 2026-08-22 | Closed P1 as PASS after real A/B JWT/identity and official Tool execution, bidirectional forgery denial, 20-request zero-leak concurrency, metadata/CWD/workspace isolation, request cleanup, stdio/HTTP/P0 regressions, zero official TypeScript patches, and SFoA changed-code lint; P2 remains unstarted pending maintainer review. |
| P1-BL-1.2 | 2026-08-22 | Recorded maintainer acceptance of P1 and authorization for P2 after rerunning the accepted P1 build, 22/22 tests, strict lint, and live two-user validation; P2 remains unstarted until its branch is created from updated `main`. |
| P2-BL-1.0 | 2026-08-22 | Fast-forwarded accepted P1 to `main`, created the dedicated P2 branch, and entered a read-only, stateless remote-runtime phase with internal Bearer authentication, default-deny Tool governance, bounded requests, no database/cache, and no official Salesforce TypeScript patch. |

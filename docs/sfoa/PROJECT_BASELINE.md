# SFoA Enterprise MCP Project Baseline

Baseline ID: **P4-BL-1.0**

Baseline date: 2026-08-23

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
| Database | P0/P0-Closure/P1/P2/P3: none. P3 continues to use the P1 `IdentityRepository` contract and in-memory implementation plus a strict environment-backed DML allowlist; persistence is introduced only when durable routing or Admin configuration proves it is needed. |
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

`P4 — Diagnosis & Runtime Context (IN PROGRESS)`

## Current status

`P0 = PASS / COMPLETE — MAINTAINER ACCEPTED; P1 = PASS / COMPLETE — MAINTAINER ACCEPTED; P2 = PASS / COMPLETE — MAINTAINER ACCEPTED; P2-CLOSURE HOTFIX01 = PASS; P3-CLOSURE HOTFIX01 = PASS; P3-CLOSURE HOTFIX02 = PASS; P3 = PASS / COMPLETE — MAINTAINER FINAL ACCEPTED; P4 = IN PROGRESS`

The repeatable Closure Harness completed Fresh JWT, direct `@salesforce/core` identity, Direct SOQL, official `run_soql_query`, official `retrieve_metadata` for one real CustomObject, temporary workspace cleanup, and CWD restoration. CLI v2 JWT/query cross-check also passed. The maintainer accepted P0-Closure and authorized P1 on 2026-08-22. P0 commits `32469cd`, `d90163f`, and `e80d9fd` were fast-forwarded to `main` without squashing before `feature/p1-request-scoped-identity` was created.

The maintainer had supplied `SECOND_TEST_USER`, but the P0-Closure configuration loader did not read it. Therefore the historical P0 matrix statement "`SECOND_TEST_USER` not supplied" was inaccurate as an input statement while remaining accurate that the second user was not exercised by P0. Historical reports are not rewritten to imply a test that did not occur. The P1 configuration now explicitly consumes `SECOND_TEST_USER`, constructs the second route, and the mandatory real two-user Gate passed.

The maintainer accepted P1 as `PASS / COMPLETE` on 2026-08-22 and authorized P2 Remote MCP Runtime & Tool Governance. The required P1 build, 22/22 tests, strict lint, and live two-user validation were rerun successfully on the accepted P1 branch before merge to `main`.

P1 was fast-forwarded without squashing to `main` at commit `3d35ef6` and pushed before `feature/p2-remote-runtime-governance` was created from that updated `main`. P2 preserves P1 identity routing and adds a separate production HTTP host, minimal internal Bearer client authentication, registration-time Tool governance, remote schema adaptation where the public Provider API permits it, request bounds/timeouts, graceful shutdown, and remote-client contracts. P2 remains read-only and database-free.

P2 completed on its dedicated feature branch. The production Host, authentication/order boundary, default-deny Tool governance, remote schema facade, health/readiness, request bounds/timeouts, graceful shutdown, A/B identity isolation, 50-request load, official SDK Client, project-local Inspector, official Tool, and P0/P1/root regressions all passed. P2 modifies zero official Salesforce TypeScript files and adds no CLI/database/cache/DML dependency. P3 remains prohibited until maintainer review accepts this Gate.

P2 Closure HOTFIX01 removes open-ended upstream schema inheritance before maintainer acceptance. The executable catalog now contains the audited dx-core Provider/package/API baseline, all 13 Tool name/ReleaseState/input-requiredness/output-schema contracts, and explicit host/Agent ownership for the three remote-compatible Tools. A real public-Provider compatibility Gate reports unrelated drift as `UPSTREAM_REVIEW_REQUIRED`; enabled contract drift fails startup with `MCP_UPSTREAM_TOOL_CONTRACT_DRIFT`. New Tools, classifications, Providers, and fields remain default-deny. P2 defaults, request identity authority, official `Tool.exec()`, read-only scope, and dependency boundaries are unchanged.

The maintainer accepted P2 and P2 Closure HOTFIX01 and authorized P3 on 2026-08-22. The accepted P2 branch was clean, its latest commit `f532c8a` matched `origin/feature/p2-remote-runtime-governance`, `validate:upstream` passed with zero drift, and the P2 targeted suite passed 18/18 immediately before entry. P2 was then fast-forwarded without squashing to `main`, pushed, and `feature/p3-generic-dml-allowlist` was created from the updated `main`.

P3 is complete on its dedicated branch and awaits maintainer review. The SFoA-owned Provider exposes only `create_record` and `update_record`, consumes the existing request-scoped `OrgService`/Connection, and checks a strict startup-loaded Object-by-Operation JSON policy before the pinned SDK calls Salesforce. Missing/empty policy denies all; invalid/duplicate/DELETE/unknown configuration fails closed. Live SFoA validation proved successful User A CREATE/UPDATE, User B request routing with native validation and record-authorization denial preserved, forged body identity resistance, native required-field failure, zero Connection reuse, and validator cleanup of exactly 2/2 recorded IDs. No DELETE/UPSERT/bulk/arbitrary REST Tool, field policy engine, database, Redis, cache, pool, CLI runtime, official Tool copy, or official Salesforce TypeScript patch was added.

Maintainer review accepted the P3 architecture and required only P3-Closure HOTFIX01 before final acceptance. The Closure distinguishes explicit structured Salesforce rejection from an ambiguous post-dispatch outcome. A returned Salesforce failure remains `MCP_SALESFORCE_DML_FAILED`; a DML Tool timeout, transport interruption, or SDK rejection without reliable structured Salesforce rejection evidence returns `MCP_DML_OUTCOME_UNKNOWN` with an explicit no-automatic-retry/read-before-retry instruction. Deterministic late-completion tests prove one invocation and zero automatic retry for CREATE and UPDATE. No idempotency store, retry queue, External ID, UPSERT, DELETE, database, Redis, token cache, or Connection cache was added.

Cross-layer review then found that the outer HTTP deadline could expire after SDK dispatch but before the DML Tool deadline. P3-Closure HOTFIX02 adds one minimal request-owned mutation state and marks it immediately before the public SDK CREATE/UPDATE call. An outer request timeout remains `MCP_REQUEST_TIMEOUT` while that state is not started, but becomes `MCP_DML_OUTCOME_UNKNOWN` after mutation start. Defaults are now request 180000 ms and Tool 120000 ms; startup rejects request timeout less than or equal to Tool timeout. The state is not a ledger or idempotency key, and the Host adds no retry, replay, persistence, or P4 capability.

The maintainer final-accepted P3 and authorized P4 on 2026-08-23. Immediately before the transition, the clean P3 branch passed Provider tests 17/17, Host tests 18/18, `validate:upstream` with zero drift, and strict lint for all five SFoA TypeScript workspaces. P3 was then fast-forwarded without squashing to `main` at `4c3a45e`, pushed to `origin/main`, and `feature/p4-diagnosis-runtime-context` was created from that exact commit. P4 begins audit-first: no diagnosis or runtime-context capability is treated as implemented until the official Provider and live SFoA capability audits support an ADR decision.

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

P1 has received maintainer review and is accepted. P2 was implemented only on the dedicated branch created from updated `main`.

## P2 result

`P2 = PASS / COMPLETE — MAINTAINER ACCEPTED`

- `@sfoa/mcp-server` provides configurable stateless Streamable HTTP with safe loopback defaults and explicit LAN enablement.
- Internal Bearer authentication uses timing-safe digest comparison. Missing/wrong Bearer, missing/unknown platform identity, and Host/Origin/body rejection occur before unintended Salesforce JWT creation.
- `tools/list` defaults to exactly `get_username` and `run_soql_query`. Unknown, mutation, admin, local-development, and incompatible Tool configuration fails startup. `retrieve_metadata` remains available but disabled by default.
- `RemoteToolFacade` hides/injects authoritative `usernameOrAlias` and request `directory`; unchanged official `Tool.exec()` remains the implementation.
- Real User A/B initialize, official get_username/SOQL, and bidirectional body-argument forgery resistance passed.
- Fifty interleaved real requests completed with identity mismatch, cross-user leak, workspace leak, cleanup failure, Connection reuse, and error count all equal to zero.
- Latest p50/p95: load 1048.34/1147.25 ms; initialize 1354.90/1673.39 ms; tools/list 626.00/853.42 ms; get_username 1042.83/1147.25 ms; SOQL 952.72/1075.28 ms; JWT/Connection 872.98/1083.08 ms. No token/Connection cache was justified or added.
- Request body 413, request timeout 504, Tool-level timeout, response cleanup, graceful drain, and SIGTERM hook passed automated tests. Timeout does not claim Salesforce server-side cancellation.
- Project-local MCP Inspector 0.15.0 passed initialize, enabled-only tools/list, and tools/call for both users.
- P2 tests 10/10, strict lint, root build, root full tests (394.13 s), P1 22/22/live, P0 9/9/live, P0 HTTP POC, and original stdio passed.
- Root lint reproduced exactly 47 unchanged official code-analyzer errors and no SFoA error: `UPSTREAM_LINT_BASELINE = KNOWN UPSTREAM DEBT`; `SFOA_CHANGED_CODE_LINT = PASS`.
- Salesforce CLI runtime dependency: none. Database/Redis/token-cache/Connection-pool dependency: none. Official Salesforce TypeScript modifications: 0. Root manifest/lockfile modifications: 0.
- P2 Closure HOTFIX01 exact dx-core inventory Gate passed with nine GA Tools and zero drift; unknown Tool, added field, removed host field, removed Agent field, optionality change, ReleaseState change, exact remote schema, and identity-forgery tests passed.
- Final HOTFIX regression evidence: P2 18/18, P1 22/22/live, P0 9/9/live, P0 HTTP 1/1, Inspector, original stdio, root build, root tests, and SFoA changed-code lint passed. Root lint reproduced exactly 47 unchanged official code-analyzer errors as `KNOWN UPSTREAM DEBT`.

## P3 scope (complete)

1. Complete the P3-00 official capability audit before implementing a new Provider: current pinned DX MCP Provider, Salesforce Hosted `platform/sobject-mutations`, then the pinned public `@salesforce/core` Connection API.
2. Expose two separate SFoA-owned generic Tools for CREATE and UPDATE only; DELETE, UNDELETE, UPSERT, MERGE, Bulk DML, arbitrary REST, and Apex mutation substitutes are structurally absent.
3. Apply strict `Object x Operation` governance from a human-readable environment/local JSON configuration. Missing or empty configuration denies all; invalid, duplicate, DELETE, or unknown operations fail closed.
4. Reuse the authenticated P1/P2 request scope and fresh Connection. Tool input cannot select `platformUserId`, username, instance URL, token, directory, API version, operation, or REST path.
5. Let Salesforce remain the sole authority for CRUD, FLS, sharing, validation, required fields, lookup filters, Flow, and Trigger behavior. P3 adds no field permission engine.
6. Register only the explicitly approved SFoA CREATE/UPDATE Tools. Official mutation, deploy, admin, local-development, and unknown Tools remain unavailable regardless of classification.
7. Add unit, protocol, identity-isolation, live Salesforce, cleanup, and P0/P1/P2 regression evidence. Any unavailable external permission condition remains `NOT TESTED`, never inferred as PASS.

P3 remains database-, Redis-, token-cache-, Connection-pool-, Salesforce-CLI-runtime-, Admin-UI-, and DELETE-free. The completed Gate received maintainer final acceptance before P4 began.

## P3 result

`P3 = PASS / COMPLETE — MAINTAINER FINAL ACCEPTED`

- P3-00 found no reusable generic CREATE/UPDATE Tool in the actual pinned dx-core Provider. Salesforce Hosted `platform/sobject-mutations` is not an embeddable Provider for the accepted request-scoped Connection architecture and its SFoA availability is not proven. ADR-0008 selects the pinned public `Connection.sobject().create()` / `update()` surface.
- `@sfoa/mcp-provider-sfoa-dml` implements exactly two one-record Tools. The Agent cannot select identity, instance URL, token, directory, operation, API version, or REST path; UPDATE keeps `recordId` separate and rejects `fields.Id`.
- `MCP_DML_ALLOWLIST_JSON` is a strict JSON array. Missing, blank, and `[]` deny all; unknown object/pair denies at execution; invalid JSON, duplicate object/operation, DELETE, and unknown operation fail startup.
- P3 Tool visibility requires both the exact Tool name in `MCP_ENABLED_TOOLS` and a matching configured operation. The accepted P2 official Tool classification policy was not broadened; deploy/admin/other mutation Tools remain denied.
- Provider tests passed 12/12 and P3 Host tests passed 8/8. The unchanged P2 suite remained 18/18.
- Live `tools/list` was exactly `create_record`, `update_record`. User A completed real CREATE and UPDATE. User B reached Salesforce through B's Connection and preserved `FIELD_CUSTOM_VALIDATION_EXCEPTION`; B UPDATE against the validator-owned A record preserved `INSUFFICIENT_ACCESS_OR_READONLY`. A separate invalid CREATE preserved `REQUIRED_FIELD_MISSING` as `MCP_SALESFORCE_DML_FAILED`.
- Live forgery, zero-Connection-reuse, and cleanup Gates passed. The validation harness deleted only the two IDs it recorded from that run; cleanup was 2/2 with zero failure and no DELETE Tool.
- P2 live A/B and 50-request load, P1 22/22 and live A/B, P0 9/9 and live metadata/SOQL, P0 HTTP 1/1, project-local Inspector, original stdio, root build, and root full tests passed.
- Root lint reproduced exactly 47 unchanged official code-analyzer errors and zero warnings: `UPSTREAM_LINT_BASELINE = KNOWN UPSTREAM DEBT`; every SFoA strict TypeScript lint passed.
- Official Salesforce TypeScript modified: 0. Official Tool copied/reimplemented: 0. Root `package.json` changed: 0. `yarn.lock` changed: 0. Database/Redis dependencies added: 0.

## P3 Closure HOTFIX01 result

`P3-CLOSURE HOTFIX01 = PASS`

- `MCP_SALESFORCE_DML_FAILED` now requires deterministic `SaveResult.success === false` or reliable structured Salesforce rejection evidence; safe Salesforce code/message/fields remain bounded and redacted.
- `MCP_DML_OUTCOME_UNKNOWN` covers DML Tool timeout and mutation execution exceptions without reliable rejection evidence. Its Tool result says the commit state is unknown, prohibits automatic retry, and directs the Agent to verify through an independent read.
- `create_record` and `update_record` descriptions explicitly state non-idempotence, no automatic retry after unknown outcome, read-before-retry, and user disclosure when state cannot be confirmed. `idempotentHint` remains `false`.
- Provider tests passed 16/16 and P3 Host tests passed 10/10, including transport failure, CREATE/UPDATE timeout, late CREATE completion, one invocation, zero retry, structured output, and correlation/identity log fields.
- P3 live, P2 18/18 and live A/B/50-load, P1 22/22/live, P0 9/9/live, P0 HTTP, original stdio, Inspector, upstream compatibility, root build/tests, and all SFoA changed-code lint passed. Root lint reproduced exactly 47 unchanged official code-analyzer errors as `KNOWN UPSTREAM DEBT`.
- Official Salesforce TypeScript modified: 0. Root manifest/lockfile modified: 0. Database/Redis/idempotency/retry/UPSERT/DELETE additions: 0. P4 remains unstarted.

## P3 Closure HOTFIX02 result

`P3-CLOSURE HOTFIX02 = PASS`

- Each HTTP POST owns a `MutationRequestState`; the DML Provider sees only a small `MutationExecutionObserver` and remains independent of HTTP implementation details. CREATE/UPDATE mark the request immediately before their SDK calls, after local input, allowlist, identity, Connection, and SObject preparation.
- Outer request timeout after mutation start returns HTTP 504 JSON-RPC `MCP_DML_OUTCOME_UNKNOWN` with `retryable:false` and explicit no-retry/read-before-another-mutation guidance. Timeout before start and read-only request timeout remain `MCP_REQUEST_TIMEOUT`.
- Defaults are `MCP_REQUEST_TIMEOUT_MS=180000` and `MCP_TOOL_TIMEOUT_MS=120000`; configuration and direct server startup fail closed with `MCP_RUNTIME_CONFIGURATION_INVALID` when request timeout is less than or equal to Tool timeout.
- Pinned JSforce 3.10.13 source and a regression contract test confirm default retries are only GET/PUT/HEAD/OPTIONS/DELETE; CREATE POST and UPDATE PATCH have zero default transport retry. JSforce is not patched or forked.
- Final P3 Provider tests passed 17/17 and P3 Host tests passed 18/18. Request/Tool/network timeout and late CREATE/UPDATE fixtures all invoked the mutation exactly once. Unknown/off-limits Tools never marked mutation start; client disconnect after start logged UNKNOWN at the transport layer without replay.
- P3 live, P2 18/18 and live A/B/50-load, P1 22/22/live, P0 9/9/live, P0 HTTP, original stdio, Inspector, upstream compatibility, root build/tests, and all five SFoA strict TypeScript lints passed. Root lint reproduced exactly 47 unchanged official code-analyzer errors / 0 warnings as `KNOWN UPSTREAM DEBT`.
- Official Salesforce TypeScript modified: 0. JSforce patched: NO. Root manifest/lockfile modified: 0. Database/Redis/idempotency/retry/UPSERT/DELETE/P4 additions: 0.

## P4 scope (in progress)

1. Audit the actual pinned official Providers, Tool inventory, ReleaseState, result shape, filesystem/service requirements, and request-workspace compatibility before adding any context implementation.
2. Validate the live SFoA API version and REST UI API Object Info, Create/Edit Layout, Create Defaults, record-type-aware Picklist, and optional GraphQL UI API support with request-scoped USER Connections.
3. Record the reuse/adapter/minimal-extension decision in ADR-0009 before implementation. Official `run_soql_query`, `retrieve_metadata`, and Code Analyzer implementations must not be copied.
4. Implement a server-owned, request-scoped DIAGNOSTIC route only for explicitly enabled read-only metadata/Tooling capabilities. Agent schemas must not expose identity, credential, role, token, instance, API-path, or filesystem authority.
5. Add only deterministic evidence/context Tools proven necessary by the audit. `get_record_action_context` must use the USER Connection and preserve separate API/layout requiredness, action editability, Salesforce defaults, record-type-aware picklists, coverage, warnings, and explicit truncation.
6. Keep diagnosis reasoning, missing-information decisions, optional-field selection, user dialogue, and error explanation in the LLM. P4 adds no Salesforce permission replica, Runtime Form Engine, Evidence Graph, Metadata Snapshot, rule interpreter, Lookup Engine, database, Redis, cache, pool, or new mutation.
7. Complete unit, protocol, authorization, identity-isolation, live SFoA, cleanup/CWD, performance-observation, Inspector, stdio/HTTP, P0-P3 regression, root build/test, and changed-code lint Gates. Unavailable live evidence is `NOT TESTED`, never inferred as PASS.

P4 is not authorized to enter P5. Its final result must be `PASS / COMPLETE — AWAITING MAINTAINER REVIEW`, `PARTIAL`, or `FAIL` based only on recorded evidence.

### P1 entry criteria — satisfied (historical)

- P0-Closure live Fresh JWT, Direct Connection, Identity Match, Direct SOQL, official SOQL, and at least one official CustomObject metadata retrieval are PASS.
- Original stdio, Streamable HTTP, and SFoA changed-code lint regressions remain PASS.
- The maintainer reviews `P0_CLOSURE_REPORT.md` and explicitly authorizes P1.

All three criteria are satisfied. The completed P1 Gate subsequently received maintainer review and P2 authorization.

## Known risks

| Risk | Impact | Current response |
| --- | --- | --- |
| Official host authorization is process-scoped | Cross-user leakage if reused naively over HTTP | P2 uses a separate Host, authenticated request Header, and fresh request-scoped Services/Connection/Tools; 50-request leakage metrics are zero |
| Official Tools call `process.chdir()` | Concurrent requests can race on global CWD | P1 shared/exclusive guard restores CWD and serializes metadata; evaluate isolated workers only from measured pressure |
| Provider registry is a static internal array | `@salesforce/mcp` is not a public embeddable host library | Consume public provider packages and build a thin host |
| Metadata retrieve requires an `SfProject` and writes files | Remote runtime needs workspace lifecycle | P1 uses one bounded disposable DX workspace per POST; avoid shared workspaces until proven necessary |
| Upstream package versions can temporarily drift from local workspaces | A local provider change may not be the provider version bundled by `@salesforce/mcp` | Pin and record resolved versions; validate packaged server separately |
| Official Tool inventory or schema drifts after upstream sync | A new/renamed Tool or field could bypass a manual mirror | Inspect the actual public Provider; fail the compatibility Gate for all drift; fail production startup when enabled contracts drift; whitelist Agent fields only |
| Yarn v1 `nohoist` is expensive on Windows | Slow clean installs and CI | Preserve Upstream policy; use cache and measure, do not migrate package manager in P0 |
| This already-open process still has the legacy Salesforce CLI PATH snapshot | CLI command may resolve 1.86.7 until terminal restart | Persistent user PATH now prefers the stable v2 shim; open a new terminal and verify v2.148.3. Production does not use CLI. |
| SFoA credentials are local-only | Credentials must remain out of Git and reports | `.env.local` is ignored; live Gates passed without persisting values or tokens |
| Upstream root lint fails in code-analyzer | Repository-wide lint Gate is red despite SFoA changed-code lint passing | Record `KNOWN UPSTREAM DEBT`; do not patch 47 unrelated official findings in P0 |
| Yarn Classic frozen reinstall hits a repeatable Windows `brace-expansion` link error | A from-scratch reinstall is not currently reproducible in this worktree and can remove generated `.bin` shims before failing | Preserve the unchanged lockfile; restore only local generated shims when needed; root build/full tests and targeted Gates passed; investigate separately from P1 identity correctness |
| Internal Bearer identifies a controlled MCP client, not an individual human | An untrusted client could lie in `X-Platform-User-Id` | Keep P2 internal/controlled; Dify/WorkBuddy dynamic per-user Header mapping requires client verification; a future trusted SSO gateway must overwrite the Header from authenticated claims |
| Fresh JWT/Connection adds about 0.87 s p50 / 1.08 s p95 in the latest run | Remote Agent latency and Salesforce auth traffic | Keep fresh-per-request isolation in P2; do not add a cache without sustained production evidence and a maintainer-approved identity-keyed/expiry-aware design |
| SDK or request timeout cannot guarantee Salesforce server-side cancellation | A P3 CREATE/UPDATE may commit after the Host stops waiting, and blind retry can duplicate non-idempotent work | P3-Closure HOTFIX01 covers Tool/SDK ambiguity; HOTFIX02 carries the same UNKNOWN/no-retry contract across the outer request boundary using request-local dispatch awareness. A disconnected client cannot receive the response, so the Host logs UNKNOWN and never replays. No retry/idempotency machinery is added. |

## P4 entry questions

- Which trusted platform claim will a future SSO/reverse-proxy layer map to `platformUserId` when the runtime is opened beyond controlled clients?
- Will Salesforce publish an embeddable generic mutation Provider, or prove Hosted MCP availability and request-identity compatibility for Salesforce on Alibaba Cloud, such that ADR-0008 should be revisited?
- Do sustained post-P2 production measurements—not this validation sample—ever justify an identity-keyed, expiry-aware Connection cache?
- Which deterministic diagnosis capability, if any, is actually missing after composing official SOQL/metadata/Apex/code-analysis Tools? P4-00 must answer this before implementation.
- Which REST UI API surfaces and GraphQL UI API fields are genuinely supported by the current live SFoA API version for the configured test users?
- Does official `retrieve_metadata` return Agent-consumable content in the same remote request, or only request-workspace paths that are removed after the response?
- Is the pinned official Code Analyzer Provider compatible with a disposable remote request workspace and complete local runtime dependencies, or must it remain unavailable?

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
| P2-BL-1.1 | 2026-08-22 | Closed P2 as PASS after authenticated stateless HTTP, default-deny/read-only Tool governance, remote schemas, bounds/timeouts/drain, real A/B and 50-request zero-leak validation, Inspector/official Tool/root regressions, measured fresh-JWT latency without cache, no CLI/database/DML dependency, and zero official Salesforce TypeScript changes; P3 remains unstarted pending maintainer review. |
| P2-BL-1.2 | 2026-08-22 | Closed P2 Closure HOTFIX01 with an actual public-Provider inventory Gate, one executable audited dx-core contract catalog, enabled-contract startup fail-closed behavior, Agent-field whitelist projection, ADR-0007, 18/18 P2 tests, full live/protocol/root regressions, zero official Salesforce TypeScript changes, and no P3 scope. |
| P3-BL-1.0 | 2026-08-22 | Recorded maintainer acceptance of P2 and HOTFIX01, reran zero-drift upstream validation and 18/18 P2 tests, fast-forwarded and pushed `main`, created the dedicated P3 branch, and entered minimal generic CREATE/UPDATE with strict Object-by-Operation default-deny governance and no DELETE. |
| P3-BL-1.1 | 2026-08-22 | Closed P3 as PASS after the official capability audit, thin two-Tool SDK Provider, strict default-deny Object-by-Operation policy, separate mutation Tool governance, stable safe error mapping, 12/12 Provider and 8/8 Host tests, real SFoA CREATE/UPDATE/validation/authorization/forgery/cleanup evidence, complete P0/P1/P2/root regressions, zero official TypeScript patches, and no DELETE/database/Redis/cache/pool; P4 remains unstarted pending maintainer review. |
| P3-BL-1.2 | 2026-08-23 | Closed P3-Closure HOTFIX01 with conservative ambiguous-outcome semantics, structured `MCP_DML_OUTCOME_UNKNOWN`, no-automatic-retry/read-before-retry Tool guidance, 16/16 Provider and 10/10 Host tests, full live/protocol/root regressions, zero official TypeScript changes, and no idempotency/retry/database/Redis/UPSERT/DELETE/P4 scope. |
| P3-BL-1.3 | 2026-08-23 | Closed P3-Closure HOTFIX02 with request-owned mutation-start awareness, outer-timeout UNKNOWN classification after SDK dispatch, 180000/120000 fail-closed timeout hierarchy, pinned JSforce POST/PATCH no-retry evidence, 17/17 Provider and 18/18 Host tests, complete live/protocol/root regressions, zero official/JSforce patches, and no persistence/retry/UPSERT/DELETE/P4 scope. |
| P4-BL-1.0 | 2026-08-23 | Recorded maintainer final acceptance of P3 and authorization of P4; reran the clean P3 17/17 Provider, 18/18 Host, zero-drift upstream, and five-workspace lint Gates; fast-forwarded/pushed `main` without squashing; created the dedicated P4 branch; and entered audit-first diagnosis/runtime context with no capability pre-claimed. |

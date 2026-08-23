# SFoA Project Changelog

This changelog records SFoA baseline and architecture changes. Salesforce Upstream release history remains in its original package changelogs and Git history.

## 2026-08-23 — P4 implementation accepted; live closure deferred; P5 development authorized

### Phase-Gate waiver

- Maintainer accepted the P4 implementation while preserving the historical `P4 = PARTIAL` result.
- The external-credential live DIAGNOSTIC Gate is deferred because `SFOA_DIAGNOSTIC_USERNAME` remains unavailable; real Tooling and metadata context are still `NOT TESTED`.
- Maintainer explicitly authorized P5 development. P5 cannot receive final PASS until the P4 live diagnostic closure is attempted again and evidence is recorded.
- If the credential remains unavailable, P5 implementation may complete but P5 must be reported `PARTIAL`. Any defect found by the live attempt must be fixed in P5 Closure with affected P4/P5 Gate reruns.

### Entry revalidation

- Clean P4 branch confirmed before generated test output.
- Context Provider tests: PASS, 10/10.
- P4 Host tests: PASS, 7/7.
- Identity Runtime tests: PASS, 26/26.
- `validate:upstream`: PASS with Provider API 0.6.0, dx-core 0.10.0, nine GA Tools, and `drift: []`.
- Strict changed-code lint: PASS for all six SFoA TypeScript workspaces.

### Baseline and decision record

- Advanced the baseline to `P4-BL-1.2`.
- Added ADR-0010 for the explicit waiver, P5 authorization, immutable historical result, and P5 final-result semantics.
- The waiver authorizes P5 development only; it does not authorize P6 or a P5 merge.

## 2026-08-23 — P4 diagnosis and runtime context implemented with PARTIAL live Gate

### Official and live capability audit

- Initialized the actual pinned dx-core Provider: 13 Tools, nine GA. Confirmed the GA `run_soql_query` Tool selects `connection.tooling.query()` only when requested and the GA `retrieve_metadata` Tool uses the DX project/filesystem path.
- Live-ran unchanged official `retrieve_metadata`: one 796-character status block, no `structuredContent` or XML, and 137 retrieved source files in the request workspace. This proved that a minimal same-request bounded file-content wrapper is required for stateless HTTP diagnosis.
- Initialized the actual Code Analyzer Provider: six Tools. Its Agent-selected absolute targets, durable local project, and process-global temp result file are not compatible with request-owned remote workspaces. Recorded `NOT REMOTE COMPATIBLE`; no Tool was exposed, copied, or rewritten.
- Exercised SFoA API 67.0 with both real USER routes. REST UI API Object Info, Create/Edit Layout, Create Defaults, and record-type Picklist/dependency calls passed. GraphQL `recordLayouts` also passed but is not required; ADR-0009 selects REST for the P4 runtime.

### Added

- New private `@sfoa/mcp-provider-sfoa-context` workspace with exactly three GA read-only Tools and stable structured outputs: USER `get_record_action_context`, DIAGNOSTIC `run_diagnostic_tooling_query`, and DIAGNOSTIC `get_metadata_component_context`.
- Server-owned `SFOA_DIAGNOSTIC_USERNAME` route using the existing Connected App/JWT configuration. Diagnostic Tools fail startup without it, create a fresh Connection/workspace per request, retain the triggering platform user in logs, and expose no identity/role/token/URL/filesystem switch.
- Official diagnostic adapters: Tooling query forces the unchanged official SOQL Tool to `useToolingApi=true`; metadata context creates an XML-escaped allowlisted manifest, invokes unchanged official retrieval, and reads only bounded UTF-8 files beneath the request source root.
- REST UI API record-action executor with available/default/record-derived Record Type handling; separate API/layout requiredness; field/layout editability; Salesforce defaults; record-type picklists/dependencies; labels/types/references/layout order; source coverage, call count, duration, bytes, warnings, and explicit truncation.
- Credential-pattern redaction for Tooling/metadata evidence and JSON-safe Bearer redaction regression coverage.
- `P4_AGENT_GUIDANCE.md`, `P4_FINAL_REPORT.md`, and ADR-0009.

### Security and scope

- USER official reads, UI context, CREATE, and UPDATE are blocked on DIAGNOSTIC scopes. Diagnostic Tools are blocked on USER scopes. A mixed batch remains USER-scoped and cannot turn a diagnostic identity into a business-record or mutation route.
- Metadata types are limited to CustomObject, CustomField, ValidationRule, Flow, ApexClass, ApexTrigger, Layout, and FlexiPage. Wildcards, client manifests/paths, deployment, permission assignment, anonymous Apex, normal business SOQL through DIAGNOSTIC, and DELETE remain absent.
- Added no Metadata Snapshot, Evidence Graph, Runtime Form Engine, FLS/Profile/Permission replica, Validation/Flow/Apex interpreter, Lookup Engine, database, Redis, token cache, Connection pool, Admin UI, or P5 capability.

### Verification

- Context Provider: PASS, 10/10. P4 Host: PASS, 7/7. Identity Runtime: PASS, 26/26. P3 Provider/Host: PASS, 17/17 and 18/18. P2 Host: PASS, 18/18.
- P4 real USER A/B record action context: PASS at API 67.0. Returned 111/79 fields with 28/23 API-required, 12/12 layout-required, 6/9 defaulted, and 32/21 picklist fields. Identity mismatch 0, Connection reuse 0, workspace cleanup 2/2.
- Real DIAGNOSTIC Tooling and metadata context: `NOT TESTED` because `SFOA_DIAGNOSTIC_USERNAME` is not configured.
- P3 live CREATE/UPDATE/native failure/forgery/cleanup, P2 live A/B/50-request load, P1 live A/B/20-concurrency, P0 live JWT/SOQL/official CustomObject metadata, P0 HTTP, original stdio, project-local Inspector, and upstream zero drift: PASS.
- Git Bash root build: PASS, 106.76 s. Root full tests: PASS, 419.58 s. All six SFoA strict TypeScript lints: PASS.
- Root lint reproduced exactly 47 unchanged official Code Analyzer errors / 0 warnings: `KNOWN UPSTREAM DEBT`; no SFoA file is affected.
- Frozen Yarn Classic install aborted on a nested `@typescript-eslint/.../ignore` ENOENT and removed generated `.bin` entries. Source/manifests/lockfile stayed unchanged; 513 ignored command shims were mechanically rebuilt from installed package manifests before stdio/build/tests passed. This remains `KNOWN UPSTREAM DEBT`.
- Official Salesforce TypeScript modifications: 0. Official Tool copies: 0. JSforce patches: 0. Root `package.json`/`yarn.lock` modifications: 0. Database/Redis/cache/pool additions: 0.

### Result

Baseline advanced to `P4-BL-1.1`. `P4 = PARTIAL`: all independent implementation and USER live evidence passed, but the key real fixed-DIAGNOSTIC evidence chain is not tested. P5 remains unauthorized.

## 2026-08-23 — P4 diagnosis and runtime context authorized

### Phase transition

- Maintainer review final-accepted P3, including `P3-CLOSURE HOTFIX01 = PASS` and `P3-CLOSURE HOTFIX02 = PASS`, and explicitly authorized P4.
- The clean P3 feature branch was revalidated before merge: Provider tests 17/17 PASS, Host tests 18/18 PASS, `validate:upstream` PASS with zero drift, and strict TypeScript lint PASS for all five SFoA workspaces.
- `feature/p3-generic-dml-allowlist` was fast-forwarded without squashing to `main` at `4c3a45e` and pushed to `origin/main`.
- `feature/p4-diagnosis-runtime-context` was created from the updated `main` at the same commit.

### Baseline

- Advanced the authoritative baseline to `P4-BL-1.0` with `P3 = FINAL ACCEPTED` and `P4 = IN PROGRESS`.
- P4 begins with the P4-00 official/SFoA capability audit. ADR-0009 must record actual official Provider/result/runtime evidence and live UI API support before any new Context Tool is implemented.
- No P4 capability is marked PASS at entry. DIAGNOSTIC identity, Tooling/metadata context, Record Action Context, GraphQL UI API, and Code Analyzer remote compatibility remain `NOT TESTED` until executed.

### Scope boundary

- P4 is read-only diagnosis/context. It does not add DELETE, UPSERT, Bulk DML, deployment, anonymous Apex, permission assignment, database, Redis, cache, pool, Metadata Snapshot, Evidence Graph, Runtime Form Engine, Salesforce permission replica, rule interpreter, Lookup Engine, Admin UI, or P5/P6 scope.
- Salesforce remains the authority, MCP returns governed deterministic facts, and the LLM retains reasoning and dialogue.

## 2026-08-23 — P3-Closure HOTFIX02 request-level mutation outcome safety completed

### Changed

- Added one minimal `MutationRequestState` per HTTP POST and a Provider-neutral `MutationExecutionObserver`. `DmlExecutor` marks CREATE/UPDATE immediately before the public SDK dispatch, after local input, policy, identity, Connection, and SObject preparation.
- An outer request timeout after mutation start now returns HTTP 504 JSON-RPC `MCP_DML_OUTCOME_UNKNOWN` with `retryable:false` and no-automatic-retry/read-before-another-mutation guidance. Pre-dispatch and read request timeouts remain `MCP_REQUEST_TIMEOUT`.
- Changed defaults to `MCP_REQUEST_TIMEOUT_MS=180000` and `MCP_TOOL_TIMEOUT_MS=120000`; configuration loading and direct Host startup fail closed with `MCP_RUNTIME_CONFIGURATION_INVALID` when request timeout is less than or equal to Tool timeout.
- Added bounded UNKNOWN logging fields for operation, outcome, mutation-start state, duration, and TOOL/REQUEST/TRANSPORT termination layer. Client disconnect after mutation start is logged without replay or cancellation claims.
- Reverified installed `@jsforce/jsforce-node@3.10.13`: default retry methods are exactly GET, PUT, HEAD, OPTIONS, and DELETE. CREATE POST and UPDATE PATCH are absent; JSforce was not patched or forked.

### Safety tests

- Added deterministic outer-timeout fixtures for CREATE and UPDATE, including late success after the client receives UNKNOWN. Each operation has one invocation, one completion, and zero automatic retry.
- Added pre-dispatch timeout, read-only timeout, allowlist denial, schema-validation, Tool-timeout, structured Salesforce rejection, and client-disconnect regressions.
- Added source-contract evidence for pinned JSforce POST/PATCH no-retry behavior and timeout-default parity with `.env.example`.

### Verification

- P3 Provider tests: PASS, 17/17. P3 Host tests: PASS, 18/18. P2 tests: PASS, 18/18. All five SFoA strict TypeScript lint commands: PASS.
- P3 live Salesforce: PASS for CREATE/UPDATE, required/validation/authorization failures, A/B identity isolation, Connection reuse 0, and exact cleanup 2/2.
- P2 live A/B/50-request load, P1 22/22/live, P0 9/9/live, P0 HTTP 1/1, upstream compatibility, original stdio, and project-local Inspector: PASS.
- Git Bash root build: PASS, 130.07 s. Root full tests: PASS, 519.71 s.
- Root lint reproduced exactly 47 unchanged official code-analyzer errors / 0 warnings: `KNOWN UPSTREAM DEBT`. No SFoA path is affected.
- Official Salesforce TypeScript modifications: 0. JSforce patches: 0. Root `package.json` and `yarn.lock` modifications: 0. Database/Redis/idempotency/retry/UPSERT/DELETE/P4 additions: 0.

### Result

`P3-CLOSURE HOTFIX02 = PASS`. Baseline advanced to `P3-BL-1.3`; P3 awaits final maintainer acceptance, and P4 has not started.

## 2026-08-23 — P3-Closure HOTFIX01 ambiguous mutation outcome safety completed

### Changed

- Added stable `MCP_DML_OUTCOME_UNKNOWN` Tool-level semantics for DML Tool timeout and mutation execution exceptions without reliable structured Salesforce rejection evidence.
- Restricted `MCP_SALESFORCE_DML_FAILED` to explicit unsuccessful Salesforce `SaveResult` values or trustworthy structured Salesforce `errorCode`/`message`/`fields` evidence, including the pinned JSforce error `data` body.
- Preserved the existing compact structured error shape. No client-visible correlation field or idempotency key was added; correlation, Tool, platform user, and Salesforce user remain in safe runtime logs.
- Updated `create_record` and `update_record` descriptions to state that mutations are non-idempotent, unknown outcomes must not be automatically retried, an independent read should verify state first, and the user must be told when state cannot be confirmed. `idempotentHint` remains `false`.

### Safety tests

- Explicit `REQUIRED_FIELD_MISSING` and `FIELD_CUSTOM_VALIDATION_EXCEPTION` remain `MCP_SALESFORCE_DML_FAILED`.
- Transport/ECONNRESET and unstructured SDK rejection fixtures return `MCP_DML_OUTCOME_UNKNOWN`; Provider CREATE/UPDATE invocation count remains one.
- CREATE and UPDATE Host timeout fixtures return structured UNKNOWN results with no-retry guidance. A late CREATE resolution completes after the timeout without any second invocation.
- `REQUIRED_FIELD_MISSING`, `FIELD_CUSTOM_VALIDATION_EXCEPTION`, and `INSUFFICIENT_ACCESS_OR_READONLY` continue to preserve bounded safe Salesforce code/message/fields.
- Timeout log assertions preserve correlation ID, Tool name, platform user ID, and Salesforce username under the new error code.

### Verification

- P3 Provider tests: PASS, 16/16. P3 Host tests: PASS, 10/10. All SFoA strict TypeScript lint: PASS.
- P3 live Salesforce: PASS for successful CREATE/UPDATE, required/validation/authorization failures, identity isolation, zero Connection reuse, and exact cleanup 2/2.
- P2 18/18 and live A/B/50-request load, P1 22/22/live, P0 9/9/live, P0 HTTP 1/1, upstream compatibility, original stdio, and project-local Inspector: PASS.
- Git Bash root build: PASS, 70.86 s. Root full tests: PASS, 284.67 s.
- Root lint reproduced exactly 47 unchanged official code-analyzer errors / 0 warnings: `KNOWN UPSTREAM DEBT`. No SFoA path is affected.
- Official Salesforce TypeScript modifications: 0. Root `package.json` and `yarn.lock` modifications: 0. Database/Redis/idempotency/retry/UPSERT/DELETE additions: 0.

### Result

`P3-CLOSURE HOTFIX01 = PASS`. Baseline advanced to `P3-BL-1.2`; P3 awaits final maintainer acceptance, and P4 has not started.

## 2026-08-22 — P3 minimal generic DML completed

### Added

- New private `@sfoa/mcp-provider-sfoa-dml` workspace with exactly `create_record` and `update_record`, strict input/output schemas, complete annotations, stable safe errors, and single-record SDK execution through request `OrgService`.
- Strict `MCP_DML_ALLOWLIST_JSON` Object-by-Operation parser/policy. Missing, blank, and `[]` deny all; malformed JSON, unknown fields/operations, DELETE, duplicate objects, and duplicate operations fail closed.
- Separate `DmlToolGovernancePolicy` and DML facade in the formal Host. Exact P3 Tool names require a matching operation rule; the accepted official P2 `MUTATION` classification remains forbidden.
- Twelve Provider tests, eight independent P3 Host/config/HTTP/identity tests, and a live P3 Salesforce validator with ID-bounded SDK cleanup outside production Tool registration.
- `P3_FINAL_REPORT.md`; architecture, Upstream boundary, baseline, matrix, environment example, and package documentation updates.

### Official reuse decision

- The actual pinned dx-core 0.10.0 Provider has no reusable generic CREATE/UPDATE Provider or Tool. Removed historical create-only source was not copied.
- Salesforce Hosted `platform/sobject-mutations` is not an embeddable Provider for the accepted request-scoped Connection path; it requires a separate hosted endpoint/OAuth model and SFoA availability remains not proven.
- ADR-0008 selects only pinned public single-record `Connection.sobject().create()` and `update()`. No raw REST, CLI, Auth Cache, custom OAuth, query-after-write, DELETE, UPSERT, or Bulk API is used.

### Verification

- Provider tests: PASS, 12/12. P3 Host/config/HTTP tests: PASS, 8/8. P2 historical regression: PASS, 18/18. Strict P3 Provider/Host lint: PASS.
- Live SFoA `tools/list`: exactly `create_record`, `update_record`. User A real CREATE and UPDATE: PASS. User B used B's Connection and preserved native `FIELD_CUSTOM_VALIDATION_EXCEPTION`; User B UPDATE against the validator-owned A record preserved `INSUFFICIENT_ACCESS_OR_READONLY`.
- Native invalid CREATE preserved `REQUIRED_FIELD_MISSING` under `MCP_SALESFORCE_DML_FAILED`. Forged platform/username fields could not change the authenticated route. Connection reuse: 0.
- Validator cleanup: PASS, exactly 2 attempted / 2 deleted / 0 failures; cleanup used only recorded IDs and no production DELETE Tool.
- `validate:upstream`: PASS with nine GA official Tools and zero drift. P2 live A/B plus 50-request load, P1 22/22 plus live A/B, P0 9/9 plus live SOQL/metadata, P0 HTTP 1/1, project-local Inspector, and original stdio all passed.
- Git Bash root build: PASS, 82.49 s. Root full tests: PASS, 356.86 s. Root lint reproduced exactly 47 unchanged official code-analyzer errors / 0 warnings as `KNOWN UPSTREAM DEBT`; all SFoA strict lint passed.
- The frozen Yarn Classic install reproduced the existing Windows nested `brace-expansion` link failure and removed generated `.bin` shims before aborting. The lockfile stayed unchanged; missing shims were mechanically regenerated from installed package manifests, after which stdio, root build, and root tests passed.
- Official Salesforce TypeScript modifications: 0. Official Tool copied/reimplemented: NO. Root `package.json`: unchanged. `yarn.lock`: unchanged. New database/Redis dependency: none.

### Result

`P3 = PASS / COMPLETE — AWAITING MAINTAINER REVIEW`. Baseline advanced to `P3-BL-1.1`. P4 has not started.

## 2026-08-22 — P3 minimal generic DML authorized

### Phase transition

- Maintainer review accepted `P2 = PASS / COMPLETE` and `P2-CLOSURE HOTFIX01 = PASS`, then authorized P3.
- The clean P2 branch at `f532c8a` matched its pushed remote. `validate:upstream` returned PASS with zero drift and the targeted P2 suite passed 18/18 immediately before merge.
- P2 was fast-forwarded without squashing to `main`, `main` was pushed, and P3 began on `feature/p3-generic-dml-allowlist` from that updated commit.

### Baseline decisions

- Baseline advanced to `P3-BL-1.0`; `P2 = PASS / COMPLETE — MAINTAINER ACCEPTED` and `P3 = IN PROGRESS`.
- P3 is limited to separate generic CREATE and UPDATE Tools behind strict Object-by-Operation allowlisting. Missing or empty configuration denies all; invalid, duplicate, DELETE, and unknown operations fail closed.
- P3 reuses the P1/P2 authenticated request scope and fresh `@salesforce/core` Connection. Salesforce remains the CRUD/FLS/sharing/validation/Flow/Trigger authority.
- DELETE, UPSERT, bulk DML, arbitrary REST, metadata mutation, Apex mutation substitutes, field-policy replication, database, Redis, caches, pools, and Admin UI remain out of scope.
- P3-00 must finish the official Provider/Hosted MCP/SDK audit and record the decision in an ADR before a new DML Provider is implemented.

### P3-00 official capability audit

- Actual dx-core 0.10.0 public exports, `provideTools()` implementation, Provider API surface, and repository history were inspected. No current generic CREATE/UPDATE or mutation Provider exists; the old `sf-create-record` implementation was removed upstream and will not be copied.
- Salesforce Hosted `platform/sobject-mutations` provides CREATE/UPDATE without DELETE, but is a fixed remote MCP service using a separate External Client App and OAuth/PKCE model. It cannot consume the current request-scoped Connection, includes relationship mutation, and SFoA/Alibaba Cloud support is not proven.
- ADR-0008 selects pinned `@salesforce/core@8.29.0` / JSforce single-record `sobject().create()` and `update()` through the existing P1/P2 request scope.
- ADR-0008 also selects a strict JSON-array environment/local allowlist because duplicate objects/operations can be detected without defining a custom configuration grammar.

## 2026-08-22 — P2 Closure HOTFIX01 upstream drift guard completed

### Added

- Actual public `DxCoreMcpProvider` inventory inspector and repeatable `validate:upstream` Gate for Provider/API/package version, Tool name, ReleaseState, input field/requiredness, and output-schema drift.
- Stable `MCP_UPSTREAM_TOOL_CONTRACT_DRIFT` startup/registration failure for enabled remote contract changes.
- Executable dx-core 0.10.0 contracts for all 13 Tools and explicit host/Agent argument ownership for `get_username`, `run_soql_query`, and `retrieve_metadata`.
- Seven inventory/contract test scenarios plus an optionality regression, exact remote-schema assertions, and four-field identity-forgery coverage. ADR-0007 supersedes ADR-0006's open-ended schema projection.

### Changed

- `RemoteToolFacade` now validates the complete audited surface and projects only `allowedAgentArguments`; official fields are no longer inherited merely because they are not host-owned.
- `OFFICIAL_PROVIDER_INVENTORY.md` is explicitly informational. `official-tool-catalog.ts` is the sole executable safety source.
- Hardened the request-timeout test so MCP initialize has a distinct timing margin and connection failure always closes server resources; this removed a root-suite load race without changing production timeout behavior.

### Verification

- Upstream compatibility: PASS; `DxCoreMcpProvider`, Provider API 0.6.0, dx-core 0.10.0, nine GA Tool names, and zero drift.
- P2 tests 18/18 and strict lint PASS; unknown Tool remains unclassified/invisible/uncallable; added/removed/renamed/requiredness/ReleaseState contract changes fail closed.
- P1 22/22 and live A/B PASS; P0 9/9 and live JWT/SOQL/metadata PASS; P0 HTTP 1/1 PASS.
- P2 live A/B, 50-request zero-leak load, official Tool calls, and project-local Inspector initialize/list/call PASS. The first P2 live attempt lacked `MCP_CLIENT_TOKEN`; a command-local non-persisted test token was supplied and the complete rerun passed.
- Original Salesforce stdio initialize/list/call PASS; Git Bash root build PASS in 94.94 s; root tests PASS in 325.05 s.
- SFoA changed-code lint PASS. Root lint reproduced exactly 47 unchanged official code-analyzer errors: `UPSTREAM_LINT_BASELINE = KNOWN UPSTREAM DEBT`.
- Official Salesforce TypeScript modifications: 0. Root `package.json`: unchanged. `yarn.lock`: unchanged. Official Tool copied/reimplemented: NO.

### Result

`P2-CLOSURE HOTFIX01 = PASS`. Baseline advanced to `P2-BL-1.2`; P3 remains not started pending maintainer final acceptance.

## 2026-08-22 — P2 remote runtime and Tool governance completed

### Added

- New `@sfoa/mcp-server` package with configurable stateless Streamable HTTP, internal Bearer authentication, authenticated platform-user Header routing, Host/Origin bounds, health/readiness, bounded request bodies, request/Tool timeouts, response-lifecycle cleanup, JSON-line logging, and graceful SIGINT/SIGTERM drain.
- Registration-time `ToolGovernancePolicy`, explicit official Tool inventory/classification, and low-intrusion `RemoteToolFacade` adapters that hide/inject `usernameOrAlias` and `directory` while retaining unchanged official `Tool.exec()`.
- Ten P2 unit/integration tests, real two-user/load/performance validation, and a project-local MCP Inspector proxy Gate.
- Official Provider inventory, client/reverse-proxy contracts, Chinese user test guide, Dify/WorkBuddy connection guide, ADR-0005, ADR-0006, and P2 final report.

### Verification

- Bearer/auth-order, A/B identity, official get_username/SOQL, invisible disabled Tools, startup fail-closed policy, remote schemas, 413, request/Tool timeouts, cleanup, and signal drain passed.
- Fifty interleaved real read-only requests passed with zero identity mismatch, cross-user leak, workspace leak, cleanup failure, Connection reuse, or error.
- Latest measured p50/p95: 50-request calls 1048.34/1147.25 ms; initialize 1354.90/1673.39 ms; tools/list 626.00/853.42 ms; get_username 1042.83/1147.25 ms; SOQL 952.72/1075.28 ms; JWT/Connection 872.98/1083.08 ms. No cache was added.
- Project-local MCP Inspector 0.15.0 passed initialize, enabled-only tools/list, and get_username tools/call for A and B.
- P2 10/10 tests and strict lint, P1 22/22 and live A/B, P0 9/9 and live Closure, P0 HTTP POC, original stdio, root build, and 394.13-second full root tests passed.
- Root lint reproduced exactly 47 unchanged official code-analyzer errors and no SFoA error: `UPSTREAM_LINT_BASELINE = KNOWN UPSTREAM DEBT`; `SFOA_CHANGED_CODE_LINT = PASS`.
- Salesforce CLI runtime, database, Redis, token cache, Connection pool, and DML dependencies remain absent. Official Salesforce TypeScript modifications: 0. Root manifest/lockfile changes: 0.

### Result

`P2 = PASS / COMPLETE — AWAITING MAINTAINER REVIEW`. Baseline advanced to `P2-BL-1.1`. P3 has not started.

## 2026-08-22 — P2 remote runtime and Tool governance authorized

### Phase transition

- Maintainer review accepted `P1 = PASS / COMPLETE` and authorized P2.
- The accepted P1 branch was rerun through build, 22/22 tests, strict lint, and live two-user validation, then fast-forwarded without squashing to `main` at `3d35ef6` and pushed.
- P2 development began from updated `main` on `feature/p2-remote-runtime-governance`; P3 remains prohibited pending the complete P2 Gate and maintainer review.

### Baseline decisions

- P2 adds a separate SFoA-owned production Streamable HTTP host; `@sfoa/identity-runtime` remains the request-scoped identity foundation and its P1 test host is not promoted unchanged.
- `platformUserId` remains the sole business identity authority after minimal internal Bearer client authentication.
- Tool governance is registration-time and default-deny. P2 remains read-only; mutation, admin, local-development, and unknown Tools are forbidden.
- P2 remains database-, Redis-, token-cache-, connection-pool-, Salesforce-CLI-runtime-, DML-, and Admin-UI-free.
- Baseline advanced to `P2-BL-1.0`; `P2 = IN PROGRESS`.

## 2026-08-22 — P1 request-scoped identity routing completed

### Added

- Private SFoA-owned `@sfoa/identity-runtime` workspace with immutable request context, `IdentityRepository`/in-memory implementation, resolver, fresh-JWT Connection factory, request-scoped OrgService/Services, official dx-core Provider composition, bounded request workspaces, CWD execution guard, stateless Streamable HTTP host, structured redacted logs, and stable error codes.
- Twenty-two unit/integration tests and one repeatable `validate:p1` live harness.
- Chinese `P1_USER_TEST.md` and `P1_FINAL_REPORT.md`.

### Verification

- `SECOND_TEST_USER` is now explicitly consumed and mapped to the B route; both real users passed fresh JWT and `Connection.identity()`.
- Official `get_username` and `run_soql_query` passed for A and B.
- A→B and B→A forged usernames, unknown routes, and missing platform identity were blocked before unintended Salesforce access.
- Twenty interleaved requests completed with zero identity mismatch, cross-user leak, or Connection reuse.
- Two concurrent official metadata requests serialized through the CWD guard, used distinct cleaned workspaces, and restored CWD.
- P1 build, 22/22 tests, strict lint, root build/full tests, original stdio, P0 HTTP, and P0 live runtime regressions passed.
- Salesforce CLI used by P1 runtime: NO. Database/Redis/cache/pool used: NO. Official Salesforce TypeScript changes: 0.
- Root lint continues to reproduce 47 unchanged official code-analyzer errors as `KNOWN UPSTREAM DEBT`; no new SFoA lint error exists.

### Result

`P1 = PASS / COMPLETE — AWAITING MAINTAINER REVIEW`. Baseline advanced to `P1-BL-1.1`. P2 was not started.

## 2026-08-22 — P1 request-scoped identity routing authorized

### Phase transition

- Maintainer review accepted `P0 = PASS` and authorized P1.
- P0 Closure commits `32469cd`, `d90163f`, and `e80d9fd` were fast-forwarded to `main` and pushed without squashing.
- P1 development began on `feature/p1-request-scoped-identity`; P2 remains prohibited pending the P1 Gate and maintainer review.

### Baseline decisions

- P1 uses an `IdentityRepository` interface plus an in-memory two-user mapping; no database, ORM, Redis, token cache, or connection pool is introduced.
- `platformUserId` is the only identity authority. Official Tool `usernameOrAlias` values are non-authoritative and must match the resolved request route.
- The maintainer had supplied `SECOND_TEST_USER`, but the P0-Closure loader did not consume it. Historical P0 execution remains unchanged; real second-user execution is mandatory in P1.
- Request and connection contracts reserve `ConnectionRole = USER | DIAGNOSTIC`. P1 implements only business-user `USER`; the fixed diagnostic user is deferred to P4 and is barred from business data operations.

## 2026-08-22 — P0-Closure live Gates completed

### Verification

- Fresh SFoA JWT through direct `@salesforce/core` Bearer authentication: PASS.
- Salesforce identity matched the configured username; direct Connection: PASS.
- Direct SOQL against the configured `Lead` object: 5 rows, PASS.
- Official `run_soql_query`: 5 rows, PASS.
- Official `retrieve_metadata` for the configured `CustomObject`: 135 retrieved files, PASS.
- Temporary Workspace lifecycle and Harness CWD restoration: PASS; official Tool CWD side effect remains documented.
- Stable Salesforce CLI v2 JWT login, org display, and read-only query: PASS.

### Result

`P0 = PASS`. No User Id, Org Id, token, or Salesforce record content was committed. The second-user isolation Gate remains P1, and P1 has not started.

## 2026-08-22 — P0-Closure Harness implementation

### Added

- Private `@sfoa/runtime-validation` workspace for fresh JWT, direct `@salesforce/core` identity/SOQL, official `run_soql_query`, official `retrieve_metadata`, temporary DX workspace, CWD observation/restoration, and console-only token diagnostics.
- Nine unit/integration tests covering configuration, redaction/token description, official Provider Tool registration/execution, and bounded temporary-workspace cleanup.
- `PROVIDER_COMPATIBILITY.md`, `P0_CLOSURE_USER_TEST.md`, and `P0_CLOSURE_REPORT.md`.
- Complete Closure variable names in `.env.example`; `.env.local`, private keys, and temporary Closure artifacts remain ignored.

### Environment and architecture

- Removed the stale missing `@salesforce/sfdx-scanner` plugin record using Salesforce CLI itself.
- Updated persistent user PATH to prefer the stable Salesforce CLI v2 shim; a newly opened terminal is required because the active Codex process retains its prior PATH snapshot.
- Declared Salesforce CLI diagnostic-only and fixed the production chain as direct JWT/OAuth through `@salesforce/core` and official Providers.
- Declared P0/P0-Closure database-free. P1 will begin behind an `IdentityRepository` interface and may use a memory/local test mapping before persistence is justified.
- Recorded the exact packaged stdio dx-core 0.9.8 and SFoA extension dx-core 0.10.0 version baselines; no package version was upgraded.

### Verification

- Closure Harness build PASS, unit tests 9/9 PASS, and strict TypeScript lint PASS.
- Original stdio initialize/list/call regression PASS against five selected Tools.
- Streamable HTTP initialize/list/call, 405, Origin rejection, and cleanup regression PASS (1/1).
- Reproduced 47 unchanged code-analyzer lint errors and normalized them as `UPSTREAM_LINT_BASELINE = KNOWN UPSTREAM DEBT`; `SFOA_CHANGED_CODE_LINT = PASS`.
- Repeated frozen Yarn install attempts still fail at a Yarn Classic Windows nested `brace-expansion` link; lockfile unchanged and targeted Closure Gates pass.

### Pending live inputs

- `.env.local` is absent. Fresh JWT, token/identity, Direct SOQL, official SOQL, official Metadata, and live CWD evidence remain `NOT TESTED`; P0 remains `PARTIAL PASS`.
- The second-user isolation Gate is assigned to P1 and is not required to close P0.

## 2026-08-22 — P0 baseline initialization

### Added

- Full official `salesforcecli/mcp` Git history with official remote named `upstream`.
- Associated the company GitHub repository as `origin` and prepared `main` to track `origin/main`.
- Environment baseline and Node/Yarn decision evidence.
- Project baseline, phase plan, Gate policy, architecture audit, MCP engineering rules, Upstream strategy, test matrix, and ADR directory.
- Root AI-agent contribution rules.
- Empty secret-safe `.env.example`.
- Private `@sfoa/streamable-http-poc` workspace composed only from public official Provider contracts.
- Original stdio Tool-schema, protocol, CLI, and HTTP POC evidence under `docs/sfoa/evidence`.
- ADR-0004 accepting Streamable HTTP by composition while retaining stdio.

### Environment

- Retained Node v24.13.0 because it satisfies Upstream current-LTS and `>=20` policy.
- Activated Yarn Classic 1.22.22 through existing Corepack.
- Did not install React, TypeScript, Vite, Ant Design, TanStack Query, React Router, Docker, Redis, or database clients globally or for P0.
- Recorded Salesforce CLI legacy PATH/stale-plugin issue and the usable direct v2.148.3 installation.

### Architecture

- Confirmed official Salesforce Tools use `@salesforce/core` and official Node SDKs rather than spawning `sf`.
- Confirmed official host authorization and Tool state are process-scoped.
- Identified `process.chdir(directory)` as the primary concurrent-HTTP safety constraint.
- Classified identity/auth as middleware/shared services and future DML as a Provider plus allowlist service.
- Recorded `retrieve_metadata` hard dependency on a writable DX project/workspace.
- Selected full-history **FULL FORK + EXTENSION** with zero official TypeScript patches.
- Classified the official Providers/Tools as reusable while the unchanged process-scoped host is only a partial production runtime base.

### Verification

- Clean Yarn install PASS; lockfile unchanged.
- Git Bash root build PASS; default PowerShell/cmd build exposes the official POSIX `cp` dependency.
- Final full workspace tests PASS, including Streamable HTTP initialize/list/call.
- Original stdio initialize, Tool list, and `get_username` call PASS through project-local Inspector.
- Root lint FAIL on 47 existing code-analyzer findings; official server, dx-core, and SFoA POC lint individually PASS.
- CLI and original MCP SOQL both reached the configured local SFoA authorization but failed because its refresh session is expired.

### Security

- Added ignore rules for local env files, JWT key formats, secrets directories, and Firecrawl cache.
- Kept all observed tokens and private-key material out of project files.

### Deferred / blocked by external inputs

- Run fresh SFoA JWT, successful SOQL, controlled metadata-component retrieval, and optional second-user Gates when inputs are supplied.
- Resolve or accept the existing Upstream code-analyzer lint baseline outside the P0 extension scope.

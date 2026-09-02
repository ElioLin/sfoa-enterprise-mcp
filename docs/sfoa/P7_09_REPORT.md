# P7-09 Lazy Salesforce Connection & Request Resource Lifecycle — Implementation Report

- Status: `COMPLETE` (P7-09 + HOTFIX01)
- Implementation date: 2026-09-01
- Final verification date: 2026-09-02
- HOTFIX01: explicit `requiresSalesforceConnection` dependency model + DML lazy-error contract + audit duration semantics (see §15)
- Branch: `feature/p7-end-to-end-audit`
- Architecture decision: ADR-0018

## 1. Root cause and previous lifecycle

The confirmed root cause was lifecycle composition, not any local Tool implementation. `RequestScopeFactory` and `DiagnosticRequestScopeFactory` called `connectionFactory.create(route)` before constructing Services or the MCP server. Workspace creation then called `connection.getApiVersion()`, making the Connection an eager constructor dependency. `RequestScopedOrgService` stored that Connection even though its route methods did not need it, and `provider-runtime.ts` passed `scope.connection` to `ManagedDmlFieldResolver` during server composition.

The old path was:

```text
authenticated request
  -> route / Control Plane snapshot
  -> JWT AuthInfo.create
  -> Connection.create
  -> AuthInfo ScratchOrgInfo / Organization probes
  -> workspace API version
  -> Services / Provider / MCP server
  -> local, route-only, or Salesforce Tool
```

Consequently every request—including `initialize`, `tools/list`, Resources, Prompts, `get_username`, `get_agent_playbook`, and `get_record_links`—could perform Salesforce work before the requested operation was known.

## 2. Dependency inventory: components that depended on eager Connection

| Component | Previous dependency | P7-09 result |
| --- | --- | --- |
| USER/DIAGNOSTIC RequestScope factories | direct `connectionFactory.create(route)` | install one request-owned lazy provider |
| RequestWorkspaceFactory | required `connection.getApiVersion()` at scope creation | directories first; live API version on first Connection |
| RequestScopedOrgService | constructor received `Connection` | constructor receives `SalesforceConnectionProvider`; route reads remain local |
| ManagedDmlFieldResolver | received `scope.connection` during composition | receives provider; lookup obtains Connection only when executed |
| Remote/DML/Context facades | depended indirectly on prebuilt Connection | allowed Salesforce execution obtains provider after authority checks |
| Diagnostic metadata adapter/verification | direct Connection/API version use | explicit `scope.getConnection()` only on Diagnostic execution |
| Admin route verification and live validators | direct `scope.connection` | explicit lazy getter |
| Official SOQL/metadata/DML/context consumers | OrgService or SDK Connection at execution | behavior retained; first execution creates one Connection |
| Official `get_username` | only route/default-org methods, but scope was eager | unchanged official Tool; now zero Connection |
| Agent guidance/local protocol methods | no direct Connection need, but scope was eager | zero Connection/API attempts |

Source inspection proved `DxCoreMcpProvider.provideTools(scope.services)` only constructs Tool instances. It does not call `OrgService.getConnection()` or perform live Salesforce probes. No upstream compatibility workaround or duplicate Tool was needed.

## 3. New lifecycle and lazy abstraction

`RequestScopedSalesforceConnection` implements `SalesforceConnectionProvider` and belongs to exactly one RequestScope:

```text
authenticated request
  -> route / Control Plane snapshot
  -> local RequestContext + workspace directories + Services
  -> request-owned lazy Salesforce provider
  -> Provider / MCP server composition
  -> local or route-only operation: no Salesforce
  -> first Salesforce-dependent operation:
       one initialization Promise
       -> JWT AuthInfo.create
       -> Connection.create
       -> workspace.setApiVersion(connection.getApiVersion())
  -> repeated/concurrent same-scope callers reuse that Promise/Connection
```

The resource stores the complete initialization Promise before awaiting. Failure is also memoized, preventing repeated JWT in one request. `close()` makes the resource unavailable before workspace cleanup. There is no static/global map, username cache, token cache, Connection pool, or cross-request/role sharing.

## 4. Workspace/API version decoupling

No new static Salesforce API version was introduced. `RequestWorkspaceFactory.create()` creates the bounded root, package, and manifest directories without `sfdx-project.json`. The first real Connection calls `workspace.setApiVersion(connection.getApiVersion())`, which writes the minimal DX project and optional seed manifest once. Metadata paths therefore retain the actual Connection version, while local requests never need a Connection merely to create a workspace.

## 5. OrgService and Managed DML

`RequestScopedOrgService` now holds the provider. `getAllowedOrgUsernames`, `getAllowedOrgs`, `getDefaultTargetOrg`, and `findOrgByUsernameOrAlias` use only route/context/instance URL. Only `getConnection(usernameOrAlias)` validates route authority and delegates. The unchanged official `get_username` remains the only username Tool; no `sfoa_get_username` was added.

`ManagedDmlFieldResolver` also holds the provider. `PLATFORM_USER_LOOKUP` obtains a Connection only when the lookup actually executes. The DML facade evaluates object/operation allowlist before initialization. Allowed DML initializes outside the pre-existing Tool deadline (matching prior timeout behavior) but remains inside the outer HTTP request deadline. DML outcomes, managed-field rules, allowlist, and UNKNOWN/no-retry semantics are unchanged.

## 6. USER/DIAGNOSTIC isolation

USER and DIAGNOSTIC scope factories use the same lazy primitive but create separate provider instances and routes. Automated P4 HTTP evidence proves `tools/list` creates neither role, a Diagnostic Tool adds exactly one DIAGNOSTIC Connection for the fixed username, and no USER Connection is created as a precursor. Two-scope and 50/100/200 request isolation suites retain distinct Connections, platform users, Salesforce usernames, correlation IDs, Audit contexts, and USER_BOUND/BUNTU identity facts.

## 7. Call-count acceptance

| Operation | Before | P7-09 expected/observed |
| --- | ---: | ---: |
| RequestScope creation / initialize | 1 | 0 |
| `tools/list` | 1 | 0 |
| Resources list/read | 1 | 0 |
| Prompts list/get | 1 | 0 |
| `get_agent_playbook` | 1 | 0 Connection / 0 API |
| `get_record_links` | 1 | 0 Connection / 0 API |
| unchanged official `get_username` | 1 | 0 Connection / 0 query |
| first `run_soql_query` in request | 1 | exactly 1 Connection / 1 query |
| CREATE or UPDATE HTTP request | 1 | exactly 1 Connection |
| Diagnostic Salesforce HTTP request | eager role scope | USER 0 / DIAGNOSTIC exactly 1 |

The before count follows directly from the old unconditional factory call. The after counts are asserted with recording factories, not elapsed-time inference. P2 live validation additionally passed 50 route-only `get_username` requests with zero identity/workspace/cleanup errors; only the direct/SOQL Salesforce paths contributed Connection measurements.

## 8. Salesforce behavior, errors, cleanup, and Audit

- Official `run_soql_query`, generic CREATE/UPDATE, USER record context, Diagnostic Tooling, and official Diagnostic metadata retain their existing execution contracts.
- Lazy JWT/Connection errors are converted through the existing `IdentityRuntimeError` taxonomy, retain correlation IDs, redact secrets, and surface as safe MCP Tool failures rather than undefined/generic errors.
- Unused providers create zero Connections. Failed Promises are memoized and cleanup-safe. Closing during initialization rejects the pending result and does not recreate a deleted workspace. HTTP timeout/disconnect and server-composition cleanup suites pass.
- P7 Audit code and semantics were not filtered, relabeled, or weakened. Local requests now have zero Salesforce evidence because there is no attempt. Actual Salesforce requests retain `IDENTITY_AUTHENTICATION`, `CONNECTION_INITIALIZATION`, wire API, SOQL/DML, Payload, and terminal evidence.

## 9. Contract and Agent compatibility review

| Surface | Result | Reason |
| --- | --- | --- |
| Agent Playbook | `NO CHANGE` | no Connection lifecycle instruction; `agent:check` passed 5 generated files |
| MCP Server Instructions | `NO CHANGE` | business workflow/authority semantics are unchanged |
| Dify / 小犇 Instruction | `NO CHANGE` | BUNTU identity and Tool workflow are unchanged |
| WorkBuddy Skill/System Prompt | `NO CHANGE` | USER_BOUND identity and Tool workflow are unchanged |
| Maintainer Skill | `UPDATED` | documents lazy/request-scoped/memoized/no-cross-request invariant, zero-local-call regression signal, tests, and troubleshooting |

Tool names, count, input/output schemas, annotations, endpoints, Streamable HTTP behavior, identity routing, USER_BOUND/BUNTU, Tool/DML governance, Salesforce permissions, Agent capabilities, and Admin UI are unchanged. `validate:upstream` passed with zero official Tool drift.

## 10. Automated and integration gates

| Gate | Result |
| --- | --- |
| Identity Runtime build/lint/test | PASS; 70/70 |
| MCP Server build/lint/test | PASS; 68/68 |
| MCP P3 | PASS; 22/22 |
| MCP P4 | PASS; 7/7 |
| MCP P5 | PASS; 5/5 |
| MCP P7 | PASS; 6/6 |
| MCP MySQL runtime | PASS; 1/1 |
| Control Plane lint/unit/MySQL | PASS; 33/33 and 10/10 |
| Admin API lint/test | PASS; 22/22 |
| Admin Web lint/build/Vitest | PASS; build and 42/42 (233.50 s) |
| Agent artifact drift | PASS; 5 files |
| Upstream Tool compatibility | PASS; zero drift |
| Skill validate/sync/check/delivery/test | PASS; 21 files, zero drift/untracked/ignored, 11/11 |
| Skill smoke | PASS for committed `HEAD c883a33`; by design it does not validate uncommitted P7-09 bytes |
| `git diff --check` | PASS |
| Root build/lint/test | KNOWN UPSTREAM WINDOWS DEBT: unchanged code-analyzer workspace cannot resolve bare `tsc`/`eslint`; SFoA gates above pass |
| `validate:p5` | PARTIAL: all lints, unit/MySQL, Identity, MCP P5, Admin API, Web build and Web 42/42 pass; mocked Chromium times out on pre-existing Audit Tool textbox locator |
| P5 mocked browser E2E | FAIL: same 180 s Audit Tool textbox locator timeout; no product timeout/code change made |
| P5 full-stack E2E | BLOCKED: Admin API readiness on `127.0.0.1:18081` timed out; no assertion executed |

## 11. Live Salesforce evidence

| Gate | Result |
| --- | --- |
| P2 env compatibility live | PASS: A/B initialize, list/schema, unchanged `get_username`, SOQL, forgery denial, 50 requests, zero cross-user/workspace/cleanup/Connection reuse |
| P4 live | PASS: USER context A/B, distinct USER Connections, DIAGNOSTIC Tooling, official metadata 135 files, workspace cleanup 3/3 |
| P1 live | PARTIAL: JWT/identity A/B, initialize/list, `get_username`, SOQL, 20 concurrency/isolation/cleanup pass; USER metadata fails because current USER cannot query `Organization`; CWD still serialized/restored |
| P3 live | BLOCKED BY CURRENT SALESFORCE BUSINESS RULE: both Lead CREATE paths return native `FIELD_CUSTOM_VALIDATION_EXCEPTION`; Connection reuse=0 and native validation preservation pass, but UPDATE/forgery record-dependent checks cannot run |

The P1 USER metadata error is isolated from P7-09 lifecycle behavior: real P4 metadata succeeds under the independent DIAGNOSTIC role, while the same P1 run proves USER JWT/SOQL and local zero-Connection paths. The P3 failure is a current org validation-rule fixture issue, not a generic DML/lazy Connection regression; deterministic P3 remote tests remain 22/22.

## 12. Modified implementation surface

Core source: identity-runtime lazy resource, RequestScope, OrgService, workspace, exports; MCP provider composition, remote/DML/context facades, managed-field resolver, Diagnostic adapters/verifiers; Admin/live validators. Tests cover call counts, concurrency, roles, failures, cleanup, HTTP protocol, DML, Audit, MySQL, and verification fixtures. Durable docs include ADR-0018, this report, architecture/project/P7 baselines, README/CHANGELOG/upstream strategy, package READMEs, TEST_MATRIX, and canonical/generated Maintainer Skill references.

No official Salesforce TypeScript implementation, migration, dependency, lockfile, Tool catalog, Agent artifact, Admin UI, permission model, or Salesforce business object policy was changed.

## 13. Risks and next steps

Residual compatibility risk is low and localized to initialization timing: a Salesforce authentication failure now occurs when the Salesforce Tool begins rather than during scope composition. Existing taxonomy, correlation, Audit, and outer request timeout are preserved. Rejected initialization remains one-attempt-per-request; a caller cannot retry within the same scope.

Operational follow-ups:

1. Repair the current USER metadata permission/fixture (`Organization` unsupported) if USER metadata validation remains required; do not weaken Diagnostic isolation.
2. Refresh the P3 Lead fixture or validation-rule-compatible data so the live CREATE/UPDATE/authz chain can run again.
3. Investigate the Admin mocked E2E Audit route/locator and full-stack Admin readiness as separate pre-existing test/runtime startup debt; do not change production timeout values to hide them.
4. Commit P7-09 and rerun `yarn skill:smoke` from the new committed HEAD to obtain clean-checkout proof for these exact Skill bytes.

## 14. Conclusion

`P7-09 = COMPLETE`.

The mandatory architecture objective is met: local/route-only/protocol requests create zero Salesforce Connections/API attempts; real Salesforce Tools create exactly one request- and role-bound memoized Connection; USER/DIAGNOSTIC and concurrent requests remain isolated; core remote/DML/Diagnostic/Audit regression suites pass. The recorded external Salesforce business-rule and Admin browser/startup failures are explicit follow-up risks, not hidden or misreported as PASS.

## 15. HOTFIX01 — Lazy Connection Contract & Final Closure

A closure HOTFIX, not a redesign. It does not revert the lazy `RequestScopedSalesforceConnection`, redo Identity Runtime, or change normal business-Agent usage. It replaces one implicit classification with an explicit contract, aligns the DML lazy-error output, and pins the audit duration semantics.

### 15.1 Explicit Connection dependency model (§3)

`RemoteToolFacade` previously used `remoteContract.hostOwnedArguments.includes('usernameOrAlias')` as a proxy for "needs a Salesforce Connection". That ties resource acquisition to an input-authority field and could silently misclassify a future remote Tool. It is replaced with an explicit `requiresSalesforceConnection: boolean` on `RemoteToolContract` / `OfficialToolPolicyRecord`:

| Tool | `requiresSalesforceConnection` |
| --- | --- |
| `get_username` | `false` (route-only; zero Connection) |
| `run_soql_query` | `true` (exactly one, lazily at execution) |
| `retrieve_metadata` | `true` (exactly one, lazily at execution) |

`RemoteToolFacade.execute` acquires the provider only when the field is `=== true`. A new upstream-drift test asserts every `p2RemoteCompatible` Tool declares an explicit boolean (no default guessing), and a second test proves the requirement no longer follows the host-owned `usernameOrAlias` authority field.

### 15.2 Local/route-only zero-Connection invariant (§4)

Unchanged from §7. Recording-factory tests assert Connection Factory create count **and** Salesforce HTTP attempt count (not result-only): `initialize` and `tools/list` create zero Connections; a Salesforce Tool failure creates one; the same MCP session and local Tool remain usable afterward.

### 15.3 Lazy Salesforce error contract (§5)

Formalized as a P7-09 controlled compatibility change. A lazy JWT/Connection failure surfaces as a Tool-level `isError: true` with `MCP_SALESFORCE_AUTH_FAILED` and the Correlation ID in text content. `lazy-connection-http.test.ts` proves the Tool error does not destroy the MCP session, remove the Tool list, require a reconnect, change the schema, or corrupt a subsequent local `get_username` call.

### 15.4 DML lazy-error output contract (§6)

`DmlToolFacade`'s `IdentityRuntimeError` path now returns the same DML output contract as `create_record`/`update_record` errors: `structuredContent.success=false`, `errorCode`, and a redacted `message`, with the Correlation ID in text content. `dml-http-integration.test.ts` asserts the lazy auth failure is parseable through that contract and attempts Connection creation exactly once.

### 15.5 Audit duration semantics (§7)

Chosen and documented: **Option A** — the Tool-level `durationMs` is end-to-end latency **including** lazy authentication/Connection initialization. Both `RemoteToolFacade` and `DmlToolFacade` start the `performance.now()` timer at `execute()` entry, before any provider acquisition, so a lazy auth/connection cost is part of the measured Tool duration, matching the prior eager-construction timing contract.

### 15.6 Live regression (§8, §9)

| Gate | Result |
| --- | --- |
| P4 Diagnostic live | PASS (real Salesforce, 89 s): USER record-action context A/B, distinct USER Connections, DIAGNOSTIC Tooling (5 records) and metadata (135 files), `connectionReuse=0`, cleanup 3/3 |
| P2 env READ live | NOT RE-RUN — the current checkout is `SFOA_CONTROL_PLANE_MODE=mysql` + `MCP_BUNTU_IDENTITY_ENABLED=true`; the env-mode P2 validator is rejected by the config guard (`BUNTU_TOKEN identity requires SFOA_CONTROL_PLANE_MODE=mysql`). MySQL identity routes are present (`ai:db --report routes`), but the P2 validator is env-mode-only. READ zero/one Connection counts remain proven by the recording-factory `lazy-connection-http.test.ts`. |
| P3 DML live | NOT RE-RUN — same env-mode/BUNTU conflict, plus `MCP_DML_ALLOWLIST_JSON` empty and the P7-09 recorded Lead `FIELD_CUSTOM_VALIDATION_EXCEPTION`; DML lazy-error contract remains proven by `dml-http-integration.test.ts` and `test:p3` (23/23). |

No timeout was inflated and no Audit failure was hidden to obtain these results; the two non-runs are recorded as such rather than as PASS.

### 15.7 Maintainer Skill and Agent surfaces (§10–§12)

Canonical Skill `architecture.md` and `runtime-flow.md` document the explicit dependency model. Agent Playbook, MCP Server Instructions, Dify/小犇, and WorkBuddy remain `NO CHANGE` (the dependency model is an internal resource-lifecycle contract, invisible to business Agents). `skill:sync`/`check`/`delivery`/`test` are rerun after this change; `skill:smoke` runs from the new committed HEAD.

### 15.8 Forbidden actions (§13)

No eager Connection, global/static cache, hard-coded Tool name, BUNTU_TOKEN/USER_BOUND/governance/permission/validation-rule/Admin-Web/business-Agent change, Audit-failure hiding, evidence deletion, or timeout inflation was performed.

### 15.9 Automated gates (§14)

Identity Runtime 71/71; MCP Server 70/70 + P3 23/23 + P4 7/7 + P5 5/5 + P7 6/6 + MySQL 1/1; Control Plane 33/33 + MySQL 10/10; Admin API 22/22; Admin Web 42/42; `validate:upstream` zero drift; `agent:check` 5 files; Skill validate/sync/check/delivery/test PASS; `git diff --check` PASS.

`P7-09 HOTFIX01 = COMPLETE`.

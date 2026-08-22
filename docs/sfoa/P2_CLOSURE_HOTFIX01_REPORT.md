# P2 Closure HOTFIX01 Final Report

Date: 2026-08-22

Branch: `feature/p2-remote-runtime-governance`

Baseline: `P2-BL-1.2`

Scope: Upstream Contract Drift Guard and Remote Schema Fail-Closed only. P3 was not started.

## 1. Implementation Summary

### New files

| File | Purpose |
| --- | --- |
| `packages/sfoa-mcp-server/src/upstream-drift.ts` | Inspect the real public dx-core Provider contract, compare it with the audited executable baseline, distinguish review-only drift from enabled-runtime drift, and validate exact remote Tool contracts |
| `packages/sfoa-mcp-server/src/validation/upstream-compatibility.ts` | Repeatable compatibility Gate that returns non-zero with `UPSTREAM_REVIEW_REQUIRED` when the installed official Provider differs from the audited baseline |
| `packages/sfoa-mcp-server/src/test/upstream-drift.test.ts` | Inventory, unknown Tool, added/removed/renamed field, requiredness, ReleaseState, startup, and explicit-classification regressions |
| `docs/sfoa/adr/ADR-0007-upstream-contract-drift-guard.md` | Records the whitelist projection and compatibility/runtime fail-closed decision; supersedes ADR-0006 |
| `docs/sfoa/P2_CLOSURE_HOTFIX01_REPORT.md` | Closure implementation, security, diff, and test evidence |

### Modified files

| File | Purpose |
| --- | --- |
| `packages/sfoa-mcp-server/src/official-tool-catalog.ts` | Make executable policy the single safety source; add dx-core Provider/package baseline, exact contracts for all 13 Tools, and explicit remote argument ownership for the three reviewed facades |
| `packages/sfoa-mcp-server/src/errors.ts` | Add stable `MCP_UPSTREAM_TOOL_CONTRACT_DRIFT` |
| `packages/sfoa-mcp-server/src/provider-runtime.ts` | Inspect/compare the real Provider at startup and fail when drift affects an enabled remote Tool |
| `packages/sfoa-mcp-server/src/remote-tool-facade.ts` | Validate the complete official contract and project Agent schemas from `allowedAgentArguments` only |
| `packages/sfoa-mcp-server/src/tool-governance.ts` | Require explicit upstream and remote contracts before a Tool can be enabled |
| `packages/sfoa-mcp-server/src/http-server.ts` | Wire the inventory source into runtime initialization; production still defaults to the real official Provider |
| `packages/sfoa-mcp-server/src/index.ts` | Export the drift inspection API |
| `packages/sfoa-mcp-server/src/test/http-integration.test.ts` | Assert exact existing remote schemas and four identity-forgery inputs |
| `packages/sfoa-mcp-server/src/test/timeout-shutdown.test.ts` | Keep the controlled Tool schema exact and remove a root-suite timing race without changing production behavior |
| `packages/sfoa-mcp-server/package.json` | Add package-local `validate:upstream`; no dependency or version change |
| `packages/sfoa-mcp-server/README.md` | Document the compatibility command and no-auto-exposure behavior |
| `docs/sfoa/OFFICIAL_PROVIDER_INVENTORY.md` | Define the Markdown inventory as informational and point safety decisions to executable policy |
| `docs/sfoa/ARCHITECTURE.md` | Record the final drift-guard flow and whitelist projection |
| `docs/sfoa/PROVIDER_COMPATIBILITY.md` | Add the upstream synchronization Gate |
| `docs/sfoa/UPSTREAM_STRATEGY.md` | Record zero official TypeScript changes and public Provider API reuse |
| `docs/sfoa/adr/ADR-0006-remote-tool-schema-adapter.md` | Mark the open-ended projection decision as superseded |
| `docs/sfoa/PROJECT_BASELINE.md` | Advance the accepted implementation baseline to P2-BL-1.2 while keeping P3 not started |
| `docs/sfoa/CHANGELOG.md` | Record HOTFIX01 behavior and actual Gate results |
| `docs/sfoa/TEST_MATRIX.md` | Add the Closure Gate matrix and final 18/18 evidence |
| `docs/sfoa/P2_FINAL_REPORT.md` | Add the HOTFIX01 closure amendment and current baseline |

No large architecture rewrite was performed. The existing P2 Host, P1 identity route, request scope, official Provider composition, and official `Tool.exec()` delegation remain intact.

## 2. Upstream Drift Architecture

```text
Official Provider
      ↓
Actual Tool Contract
      ↓
Drift Guard
      ↓
Explicit SFoA Governance
      ↓
RemoteToolFacade
      ↓
Tool.exec()
```

The actual inventory comes from the public `DxCoreMcpProvider` and public Tool APIs, not Markdown. It includes Provider/API/package versions, Tool names, ReleaseState, input keys and requiredness, plus publicly available output-schema capability and fields.

The comparison reports Provider/package changes and `ADDED`, `REMOVED`, `RELEASE_STATE_CHANGED`, or `SCHEMA_CHANGED`. Any drift makes the compatibility Gate require review. An unrelated added Tool does not stop production because it has no executable classification and cannot enter `MCP_ENABLED_TOOLS`; drift affecting an enabled remote Tool fails startup with `MCP_UPSTREAM_TOOL_CONTRACT_DRIFT`.

`RemoteToolFacade` validates the audited official surface before registration, then selects only explicit `allowedAgentArguments`. Host-owned arguments are injected from the authoritative request route/workspace. It never treats an unknown official field as Agent-safe.

## 3. Security Result

| Question | Answer |
| --- | --- |
| 新官方 Tool 是否会自动暴露？ | **NO** |
| 新 Tool 是否会自动分类？ | **NO** |
| 新 Tool field 是否会自动暴露？ | **NO** |
| identity argument 是否能影响 Salesforce route？ | **NO** |
| mutation/admin 是否仍被拒绝？ | **YES** |

Names, descriptions, annotations, and Provider presence are never authorization inputs. `platformUserId` remains Header/request-context authoritative, and Agent arguments cannot select a Salesforce username, org identity, directory, or route.

Error diagnostics contain only contract metadata such as Tool name, expected/actual schema surface, and Provider/package version. No access token, JWT assertion, private key, Bearer secret, or Salesforce record is included.

## 4. Complexity Review

| Area | Result |
| --- | --- |
| `http-server.ts` | Responsibilities remain clear; only initialization wiring was added, so no split was justified |
| `official-tool-catalog.ts` | Larger because it now holds the necessary audited executable data; this removes, rather than duplicates, security facts elsewhere |
| `provider-runtime.ts` | Provider construction remains here; compatibility inspection/service details moved to the independent drift module |
| `remote-tool-facade.ts` | Removed the duplicate host-owned map and consumes the catalog contract directly |
| `tool-governance.ts` | Keeps classification/default-deny logic and now checks for explicit contracts; no schema comparison logic is duplicated here |

The only new architecture unit is the bounded compatibility/drift module and its command. No codegen framework, dynamic authorization, custom Salesforce executor, or official Tool copy was introduced.

## 5. Upstream Diff

```text
Official Salesforce TypeScript changed: 0
Root package.json changed: NO
yarn.lock changed: NO
Official Tool copied/reimplemented: NO
```

The SFoA-owned package manifest changed only to add `validate:upstream`; dependencies and pinned versions are unchanged. All inspection and execution use public official APIs.

## 6. Test Matrix

| Gate | Result | Actual evidence |
| --- | --- | --- |
| Official inventory exact match | PASS | Real `DxCoreMcpProvider`; Provider API 0.6.0; dx-core 0.10.0; nine GA Tool names; `drift: []` |
| Unknown official Tool | PASS | `future_unknown_tool` triggers review, receives no classification, is not listed, and is not callable |
| Enabled Tool schema added field | PASS | Added `run_soql_query.targetOrg` fails startup with `MCP_UPSTREAM_TOOL_CONTRACT_DRIFT` |
| Host-owned field removed/renamed | PASS | Missing `usernameOrAlias` fails closed |
| Agent field removed/renamed | PASS | Missing `query` fails closed |
| Requiredness changed | PASS | Optional `useToolingApi` becoming required fails closed |
| ReleaseState changed | PASS | GA to NON_GA fails closed |
| Classification remains explicit | PASS | Unknown name/description/read-only annotations do not grant READ |
| Existing remote schemas | PASS | `get_username` hides `directory`; SOQL exposes only `query` and `useToolingApi`; `retrieve_metadata` stays disabled |
| Identity forgery regression | PASS | `usernameOrAlias`, `directory`, `platformUserId`, and Salesforce username inputs cannot alter the request route |
| P2 security regression | PASS | Bearer, Host, Origin, body limit, request/Tool timeout, cleanup, and graceful shutdown passed |
| P2 package tests | PASS | 18/18; final command exited 0 |
| P2 strict lint | PASS | Final `tsc --noEmit` exited 0 |
| Upstream compatibility Gate | PASS | Final `validate:upstream` exited 0 and reported no drift |
| P1 tests | PASS | 22/22 |
| P1 A/B live validation | PASS | Two real request routes, official Tool calls, forgery denial, isolation, CWD/workspace cleanup |
| P0 runtime tests/live | PASS | 9/9 plus live JWT, identity, direct/official SOQL, metadata, and CWD restoration |
| P0 Streamable HTTP POC | PASS | 1/1 initialize/list/call and transport checks |
| P2 live validation | PASS | Complete rerun with a command-local token; A/B and 50 requests had zero mismatch, leak, reuse, cleanup failure, or error |
| Original Salesforce stdio | PASS | initialize, five-Tool list, and official `get_username` call |
| Streamable HTTP initialize/list/call | PASS | Official SDK Client and project-local Inspector 0.15.0 passed for A/B |
| Root build | PASS | All workspaces built in 94.94 s |
| Root tests | PASS | All workspaces passed in 325.05 s |
| SFoA changed-code lint | PASS | P2, P1, P0 runtime, and P0 HTTP checks exited 0 |
| Root lint | KNOWN UPSTREAM DEBT | Exactly 47 errors / 0 warnings under unchanged official code-analyzer; no SFoA error |
| Official Salesforce TypeScript diff | PASS | Zero files |
| Root manifest and lockfile diff | PASS | Both unchanged |
| Forbidden scope audit | PASS | No P3, DML, database, Redis, token cache, connection pool, OAuth Server, Admin UI, or new Agent Tool |

No required Gate remains `NOT TESTED`. The initial P2 live invocation correctly did not claim success when `MCP_CLIENT_TOKEN` was absent; the complete non-persisted-token rerun is the PASS evidence above.

## 7. P2-Closure Decision

```text
P2-CLOSURE HOTFIX01 = PASS
```

Reason: the pinned official inventory matches exactly; unreviewed Tool and field changes remain denied; enabled remote contract drift fails closed; identity authority and all P2 security boundaries regress cleanly; no official Tool implementation or later-phase capability was introduced.

Maintainer recommendation:

```text
P2 = FINAL ACCEPTED
merge feature/p2-remote-runtime-governance -> main = YES, after final maintainer review
start P3 = YES, only after final acceptance and merge
```

HOTFIX01 itself does not start P3.

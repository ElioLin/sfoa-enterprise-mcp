# P4 Diagnosis & Runtime Context Final Report

Date: 2026-08-23
Baseline: `P4-BL-1.1`
Branch: `feature/p4-diagnosis-runtime-context`
Result: **P4 = PARTIAL**

P4 implemented the audited USER record-action context and the server-owned DIAGNOSTIC Tooling/metadata routes without copying an official Tool or adding a business-rule engine. Real API 67.0 USER A/B context, all static/protocol gates, P0–P3 live regressions, build, tests, and changed-code lint passed. The environment does not provide `SFOA_DIAGNOSTIC_USERNAME`, so a real diagnostic Tooling-to-metadata evidence chain is `NOT TESTED`; mocks cannot promote that key Gate to PASS. P5 is not authorized.

## 1. P4 Architecture

```text
                         MCP Request
                              |
                      platformUserId
                              |
                  +-----------+-----------+
                  |                       |
             USER Context          DIAGNOSTIC Context
                  |                       |
       Record data / UI API       Metadata / Tooling
       CREATE / UPDATE            diagnosis evidence
                  |                       |
                  +-----------+-----------+
                              |
                          Salesforce
```

The Host chooses the route from the registered Tool's fixed role, never from Tool arguments. Every HTTP POST receives a fresh JWT Connection, request scope, Services graph, Provider Tools, and bounded workspace. The triggering `platformUserId` remains in diagnostic log context while `salesforceUsername` records the fixed integration user that actually executed the request.

```text
get_record_action_context
  -> request USER OrgService/Connection
  -> REST UI API Object Info
  -> Create Defaults or UPDATE record + Edit Layout
  -> record-type Picklist Values
  -> bounded structured facts

run_diagnostic_tooling_query
  -> fixed DIAGNOSTIC scope
  -> server injects username + workspace + useToolingApi=true
  -> unchanged official run_soql_query Tool.exec()
  -> bounded structured records

get_metadata_component_context
  -> fixed DIAGNOSTIC scope
  -> server-generated one-component manifest
  -> unchanged official retrieve_metadata Tool.exec()
  -> read only request-owned source root
  -> UTF-8/size/file bounds + explicit truncation
  -> exact request cleanup
```

The production default remains `get_username,run_soql_query`. Every P4 Tool requires an exact `MCP_ENABLED_TOOLS` opt-in. Enabling either diagnostic Tool without `SFOA_DIAGNOSTIC_USERNAME`, or configuring that username to collide case-insensitively with a USER Salesforce username, fails startup with `MCP_DIAGNOSTIC_CONFIGURATION_INVALID`.

## 2. Official Capability Audit

The audit initialized the installed public Providers and inspected executable Tool contracts, ReleaseState, implementation behavior, filesystem requirements, and remote-workspace fit. The pinned versions are Provider API `0.6.0`, dx-core `0.10.0`, and `@salesforce/core` `8.29.0`.

| Capability | Result | Evidence and decision |
| --- | --- | --- |
| Official `run_soql_query` reused | PASS | Actual GA Tool inspected. Diagnostic adapter calls unchanged `Tool.exec()` and forces its Tooling flag, fixed username, and request directory. No query implementation was copied. |
| Official `retrieve_metadata` reused | PASS | Actual GA Tool inspected and live-executed. It wrote 137 source files, returned one 796-character status block, no `structuredContent`, no XML, and no usable file content/path for a later stateless call. The wrapper therefore reads bounded files in the same request. |
| Official Code Analyzer reused | NOT SUPPORTED | Actual Provider returned six Tools. Analysis accepts Agent-selected absolute targets and needs a durable local project; result querying accepts an absolute result file under process-global temp. This is not remote request-workspace compatible. It was not exposed, copied, rewritten, or supplemented with durable infrastructure. |
| UI API Object Info | PASS | Live API 67.0 A/B calls returned labels, fields/types/required/editability, record types, and default record type. A saw 138 fields/eight available record types; B saw 102 fields/two available record types during audit. |
| UI API Create/Edit Layout | PASS | Live REST Layout calls with object, record type, `Full`, `Large`, and Create/Edit modes succeeded for both users. |
| UI API Create Defaults | PASS | Live A/B responses supplied effective record type, Salesforce defaults, and Create Layout. |
| UI API Picklist | PASS | Live A/B record-type collections supplied labels/values/defaults, controller maps, and dependent `validFor` facts. |
| GraphQL UI API `recordLayouts` | PASS | API 67.0 live query returned zero GraphQL errors and visible layout edges. |
| GraphQL production dependency | NOT REQUIRED | REST UI API supplies all P4 Object Info/Layout/Create Defaults/Picklist facts through one verified surface; a second layout path adds no required coverage. |
| SFoA API version | PASS | Both configured USER Connections reported `67.0`. |
| Real DIAGNOSTIC Tooling execution | NOT TESTED | `SFOA_DIAGNOSTIC_USERNAME` is not configured. |
| Real DIAGNOSTIC metadata context | NOT TESTED | No diagnostic credential, so the required fixed-account live retrieval chain cannot be executed. |

ADR-0009 records the audit and was accepted before the P4 implementation decision. REST UI API is the runtime record-action surface; GraphQL is audited but not required.

## 3. Diagnostic Identity Boundary

| Question | Answer |
| --- | --- |
| Can Agent choose DIAGNOSTIC role? | NO |
| Can Agent provide diagnostic username, alias, token, instance, URL, or filesystem path? | NO |
| Can DIAGNOSTIC perform business SOQL through `run_diagnostic_tooling_query`? | NO; the official primitive is always called with `useToolingApi=true` |
| Can DIAGNOSTIC call the USER `run_soql_query` facade? | NO; blocked before official Tool execution |
| Can DIAGNOSTIC CREATE? | NO |
| Can DIAGNOSTIC UPDATE? | NO |
| Can DIAGNOSTIC DELETE? | NO; no DELETE Tool exists |
| Can USER Tool silently escalate to DIAGNOSTIC? | NO |
| Is a diagnostic Connection shared or cached? | NO; fresh per diagnostic HTTP request |

Single diagnostic `tools/call` requests select the server-owned route only when the enabled Tool name has a fixed DIAGNOSTIC mapping. A mixed JSON-RPC batch remains USER-scoped; diagnostic facades then reject execution. USER official/DML facades also reject any DIAGNOSTIC scope before calling their underlying Tool.

Schema tests prove that the three Context Tools expose none of `platformUserId`, role, username/alias, credential profile, access token, instance URL, arbitrary REST URL, directory, source directory, manifest, output path, or Tooling switch. HTTP tests send forged fields and prove that the MCP schema removes them without changing the selected route.

## 4. Record Action Context

`get_record_action_context` is read-only and always executes with the authenticated USER Connection.

It returns:

- effective, available Record Type and whether it is the user's default;
- separate `apiRequired` and `layoutRequired` facts;
- separate field createable/updateable and Page Layout create/update editability;
- Salesforce Create Defaults only, never model-generated defaults;
- record-type-aware picklist label/value/default and dependency indexes;
- field labels, data types, layout membership, section/order, relationship name, and references;
- coverage sources, API-call count, duration, source-response bytes, warnings, and explicit truncation.

CREATE uses the user's default record type unless an explicit available ID is supplied. UPDATE first reads the addressed record's actual record type and fails closed if an explicit ID disagrees. API-required fields are prioritized and cannot be silently dropped from a successful field-truncated response.

Final live Lead evidence:

| Fact | USER A | USER B |
| --- | ---: | ---: |
| Status | PASS | PASS |
| Returned fields | 111 | 79 |
| API-required | 28 | 23 |
| Layout-required | 12 | 12 |
| Layout members | 37 | 35 |
| Salesforce defaults | 6 | 9 |
| Picklist fields | 32 | 21 |
| UI API calls | 3 | 3 |
| Duration | 1624 ms | 1538 ms |
| Source response bytes | 715837 | 596947 |
| Explicitly truncated | true | true |

Both identities matched their route, Connections were distinct, `identityMismatch=0`, `connectionReuse=0`, and workspaces were cleaned 2/2 with zero active roots.

P4 does not support complete Dynamic Forms or Lightning component-visibility evaluation. Both `dynamicFormsEvaluated` and `completeLightningPageEvaluated` are explicitly false. Unsupported UI API objects return `MCP_RECORD_ACTION_CONTEXT_UNSUPPORTED`; Describe is not used to simulate a Page Layout or record-type context.

## 5. LLM Responsibility

| Responsibility | MCP | LLM |
| --- | --- | --- |
| Determine missing user input | NO | YES |
| Ask the user questions | NO | YES |
| Recommend optional business fields | NO | YES |
| Choose among ambiguous lookup records | NO | YES, with USER reads and dialogue |
| Explain the final diagnosis | NO | YES |
| Return Salesforce required/editable/default/picklist facts | YES | Consumes facts |
| Enforce CRUD/FLS/sharing/validation/Flow/Trigger | NO | NO; Salesforce does |

The Agent Guidance requires a follow-up question when a required field has neither a supplied value nor a Salesforce default. It prohibits guessing truncated picklist values and preserves P3 `MCP_DML_OUTCOME_UNKNOWN`: never automatically retry; verify with an independent USER read or tell the user the outcome remains unknown.

## 6. Runtime Form Boundary

| Capability | Added? |
| --- | --- |
| Metadata Snapshot | NO |
| Evidence Graph | NO |
| Runtime Form Engine | NO |
| FLS/Profile/Permission replica | NO |
| Validation Rule interpreter | NO |
| Flow interpreter | NO |
| Apex/Trigger execution or interpreter | NO |
| Lookup engine | NO |
| Dynamic Forms runtime | NO |
| Database / Redis / shared cache | NO |

Salesforce remains the runtime authority. P4 observes current public API facts and returns evidence; it does not recreate Salesforce behavior.

## 7. Tool Surface

The P4 protocol Gate configured and listed exactly the following Tools:

| `tools/list` name | Fixed execution identity | Notes |
| --- | --- | --- |
| `get_record_action_context` | USER | REST UI API facts only |
| `run_diagnostic_tooling_query` | DIAGNOSTIC | Official `run_soql_query` primitive, Tooling-only |
| `get_metadata_component_context` | DIAGNOSTIC | Official `retrieve_metadata` primitive, allowlisted/bounded wrapper |
| `run_soql_query` | USER | Existing business-record read facade |
| `create_record` | USER | Existing P3 allowlisted CREATE |
| `update_record` | USER | Existing P3 allowlisted UPDATE |

The production default `tools/list` remains only `get_username` and `run_soql_query`. The project-local Inspector confirmed the default initialize/list/call flow for both real users. P4 does not automatically enable context, metadata, Code Analyzer, mutation, admin, deploy, permission, test, org-management, or local-development Tools.

## 8. Upstream Diff

| Item | Result |
| --- | --- |
| Official Salesforce TypeScript changed | 0 |
| Official Tool copied/reimplemented | NO |
| JSforce patched | NO |
| Root `package.json` changed | NO |
| `yarn.lock` changed | NO |
| Database added | NO |
| Redis added | NO |
| Token/Connection cache or pool added | NO |

P4 adds only SFoA-owned package/Host/identity/docs paths plus `.env.example`. The public Provider API, official `Tool.exec()`, `@salesforce/core` Connection, REST UI API, and existing request CWD guard are the extension seams. The only historical upstream-owned modification remains `.gitignore` as already recorded in `UPSTREAM_STRATEGY.md`.

## 9. Test Matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| P4 Context Provider tests | PASS | 10/10; schemas, roles, annotations, record types, required/editable/default/picklist facts, bounds, unsupported UI API |
| P4 Host tests | PASS | 7/7; fixed routes, official adapters, schema/governance, A/B HTTP, metadata bounds/CWD/cleanup/concurrency |
| Identity Runtime tests | PASS | 26/26; fresh fixed diagnostic scopes, trigger-user correlation, USER/DIAGNOSTIC username separation, cleanup, JSON-safe credential redaction |
| Diagnostic configuration fail-closed | PASS | Disabled diagnostic Tools need no credential; enabled diagnostic Tool without username fails startup |
| Diagnostic cannot use business Tool | PASS | Official read and DML facades block DIAGNOSTIC before underlying execution |
| USER cannot use diagnostic Tool | PASS | Context facade blocks wrong-role execution before underlying execution |
| Official diagnostic delegation | PASS | Mock/executable contracts prove `run_soql_query` and `retrieve_metadata` `Tool.exec()` are invoked unchanged |
| Metadata allowlist/path/UTF-8/byte bounds | PASS | Type/fullName only; traversal/path fields absent; max 40 files, 64 KiB/file, 256 KiB total, explicit omission/truncation |
| CWD restoration and serialization | PASS | Correct non-tautological CWD assertions; concurrent metadata max active official call = 1 |
| Secret-bearing evidence redaction | PASS | Tooling JSON remains parseable while Bearer is redacted; metadata PEM/JWT/access-token patterns are redacted before output |
| P4 real USER A record context | PASS | API 67.0; expected identity; 111 fields; 3 calls; explicit truncation |
| P4 real USER B record context | PASS | API 67.0; expected identity; 79 fields; 3 calls; explicit truncation |
| P4 real USER isolation/cleanup | PASS | Distinct users/Connections, mismatch 0, reuse 0, created 2/cleaned 2/active 0 |
| Real diagnostic Tooling scenario | NOT TESTED | `SFOA_DIAGNOSTIC_USERNAME` absent |
| Real diagnostic metadata scenario | NOT TESTED | `SFOA_DIAGNOSTIC_USERNAME` absent; no mock promoted to live PASS |
| P3 Provider regression | PASS | 17/17 |
| P3 Host regression | PASS | 18/18 including Tool/request UNKNOWN and one-invocation/no-retry semantics |
| P3 live Salesforce | PASS | CREATE/UPDATE, required/validation/authorization/forgery, reuse 0, cleanup 2/2 |
| P2 Host regression | PASS | 18/18 |
| P2 live A/B and load | PASS | 50 requests; mismatch/leak/workspace leak/cleanup failure/reuse/error all 0 |
| P1 regression | PASS | 26/26 plus live A/B, 20 concurrent requests, CWD/workspace/forgery checks |
| P0 regression | PASS | 9/9 plus live JWT, identity, direct/official SOQL, official CustomObject metadata 135 files, CWD restore |
| P0 Streamable HTTP | PASS | 1/1 initialize/list/call |
| Original Salesforce stdio | PASS | initialize, five-Tool list, official `get_username`; 122.95 s command |
| Project-local MCP Inspector | PASS | Inspector 0.15.0 initialize/list/call for A and B; 50.98 s command |
| Upstream compatibility | PASS | Provider API 0.6.0, dx-core 0.10.0, nine GA Tools, `drift: []` |
| Root build | PASS | All workspaces under Git Bash; 106.76 s |
| Root full tests | PASS | Complete `yarn test`; 419.58 s |
| Six SFoA changed-code lints | PASS | Context, DML, Identity, Host, P0 runtime, and HTTP POC strict TypeScript all exited 0 |
| Repository lint | KNOWN UPSTREAM DEBT | Exactly 47 errors / 0 warnings, all under unchanged official Code Analyzer paths; no SFoA path |
| Frozen Yarn install | KNOWN UPSTREAM DEBT | Windows Yarn Classic aborted on nested `@typescript-eslint/.../ignore` ENOENT; source/manifest/lockfile unchanged; 513 missing ignored bin commands mechanically restored before successful stdio/build/tests |
| Official Salesforce TypeScript / Tool copy / JSforce patch | PASS | 0 / NO / NO |
| Root manifest / lockfile | PASS | Both unchanged |
| Database / Redis / cache / pool | PASS | None added |

## Final Gate

`P4 = PARTIAL`

All independent implementation, USER live, security, protocol, regression, build, test, lint, and upstream-boundary work is complete. The real fixed-DIAGNOSTIC Tooling and metadata evidence chain is a key P4 capability and remains `NOT TESTED` because the environment supplies no diagnostic integration username. Configure and authorize `SFOA_DIAGNOSTIC_USERNAME`, rerun `validate:p4`, and obtain a real Tooling discovery plus metadata retrieval before P4 can be considered for `PASS / COMPLETE — AWAITING MAINTAINER REVIEW`.

P5 has not started and is not authorized by this result.

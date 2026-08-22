# P0 Final Report — Official Salesforce DX MCP Architecture & SFoA Compatibility Gate

Status: **P0-CLOSURE UPDATE — P0 = PARTIAL PASS**

Audit date: 2026-08-22

Audited Upstream commit: `670234dbdca4d3fcdebd9d58b231e311fd34aeec`

## Executive summary

The official Salesforce DX MCP repository is a strong source of reusable Provider implementations, schemas, tests, and Salesforce SDK integrations. Its shipped stdio host is intentionally process-oriented: startup `--orgs`, registered Tool instances, Services, and Cache state are process-scoped, and several Tools mutate the process working directory. It must therefore not be exposed unchanged as a shared multi-user HTTP runtime.

The recommended direction is a thin SFoA-owned host and request-context layer that reuses the public official Provider packages. The official stdio command remains available for local clients. Streamable HTTP is added by composition with the official MCP TypeScript SDK. Request identity resolution and Salesforce connection construction are shared services/middleware, not agent-facing Tools. A generic CREATE/UPDATE capability belongs in one later SFoA Provider with a deny-by-default object/operation allowlist; DELETE is not needed.

Live SFoA compatibility is only partially proven. The machine contains an existing SFoA sandbox authorization, but its access/refresh session is expired. No fresh JWT inputs or second test user are present. This report distinguishes that credential state from a protocol or platform incompatibility. All locally independent engineering work is complete; root Upstream lint remains a real failure.

## Environment bootstrap

| Item | Result | Evidence |
| --- | --- | --- |
| Windows host | PASS | Windows 11 Professional build 28000, x64 |
| Git | PASS | 2.50.0.windows.2 under `D:\Git` |
| Node.js | PASS | v24.13.0; retained because Upstream requires current LTS / Node `>=20` |
| npm | PASS | 11.6.2 |
| Yarn | PASS | Corepack-activated Yarn Classic 1.22.22, matching the Yarn v1 lockfile and development guide |
| Salesforce CLI | PARTIAL | PATH selects legacy 1.86.7; a direct v2.148.3 installation works but both report a stale user-plugin manifest |
| MCP Inspector | PASS | Project-local Inspector initialized the original stdio server, listed schemas, and called Tools; no global installation |
| Python / Java | Optional only | Python runtime not established; Java 8 observed; neither is the TypeScript runtime prerequisite |

No global TypeScript, React, Vite, Ant Design, TanStack Query, or React Router installation was performed. No React application was created.

## Environment versions and installation actions

Installed or activated during P0:

- Yarn Classic 1.22.22 through the machine's existing Corepack.
- Project-local dependencies through the Upstream Yarn workspace workflow; clean install exited 0 in 1499.30 seconds and did not change `yarn.lock`.

Not installed:

- A replacement Node runtime, because the existing v24.13.0 satisfies Upstream.
- React or any future Admin UI dependency.
- Docker, Redis, database clients, Python, or Java.
- A global MCP Inspector or TypeScript compiler.

An official user-level npm install of Salesforce CLI v2.148.3 was attempted to repair the PATH-selected legacy CLI. It failed with `ECONNRESET` and did not replace or remove either existing CLI. An unversioned, shimless partial npm directory from that failed attempt was removed with npm's own uninstall command, after which both pre-existing CLIs were reverified. The already installed direct v2 executable is used for P0 CLI evidence.

## Upstream identity

| Item | Value |
| --- | --- |
| Repository | `https://github.com/salesforcecli/mcp.git` |
| Remote | `upstream` |
| Company remote | `origin = https://github.com/ElioLin/sfoa-enterprise-mcp.git` |
| Branch | `main`, tracking `origin/main` |
| Commit | `670234dbdca4d3fcdebd9d58b231e311fd34aeec` |
| Commit time | 2026-07-27T14:54:21-05:00 |
| Subject | `chore: default org clarification (#477)` |

The repository was cloned normally, retaining full Git history. It was not downloaded as a ZIP or reinitialized.

## Install, build, test, and lint

| Gate | Result | Notes |
| --- | --- | --- |
| `yarn install` | PASS | Exit 0 in 1499.30 s; lockfile unchanged |
| `yarn build` | PASS | Git Bash exit 0 for all official workspaces and POC; 44.24 s final run |
| `yarn test` | PASS | Final worktree run exited 0 in 263.41 s; all official tests plus hardened HTTP POC passed |
| `yarn lint` | FAIL | Official code-analyzer workspace has 47 existing source/test/generated errors; official server, dx-core, and POC lint separately pass |

```text
UPSTREAM_INSTALL = PASS
UPSTREAM_BUILD   = PASS
UPSTREAM_TEST    = PASS
UPSTREAM_LINT    = FAIL
```

Two preliminary install attempts exposed Windows-specific operational issues without modifying official TypeScript:

1. An `esbuild` postinstall spawn received a transient `EPERM`; subsequent direct and Node `spawnSync` execution of the same binary succeeded.
2. The Upstream `clean-all` command failed because `rimraf` rejects the literal Windows path segment `*.tgz` used by an example package clean script.

A workspace-bounded dependency cleanup was then performed with explicit verified paths before the successful clean install. The source tree was not reset or deleted. A separate Upstream ordering issue makes broad `eslint **/*.ts` scripts inspect generated declarations after build; cleaning generated example output exposed the remaining 47 source/test errors in code-analyzer rather than hiding them.

## Package architecture

```text
@salesforce/mcp (oclif stdio host)
  -> @salesforce/mcp-provider-api
  -> @salesforce/mcp-provider-dx-core
  -> code-analyzer / devops / metadata-enrichment / mobile / scale providers
  -> published LWC and Aura provider packages
  -> @modelcontextprotocol/sdk

Provider
  -> provideTools(Services)
  -> McpTool[]
  -> host filtering by Toolset / Tool name / release state
  -> McpServer.registerTool(...)
```

Important release drift: the source workspace `@salesforce/mcp-provider-dx-core` is 0.10.0 while the official server manifest declares exact version 0.9.8. The exact dependency does not satisfy the local workspace version, so source audit and packaged-server behavior must both be verified.

The official stdio path is:

```text
packages/mcp/bin/run.js
  -> oclif execute
  -> McpServerCommand.run
  -> parse --orgs / --toolsets / --tools
  -> process Cache.allowedOrgs
  -> SfMcpServer + Services
  -> static MCP_PROVIDER_REGISTRY
  -> provider.provideTools(services)
  -> server.registerTool
  -> StdioServerTransport
```

## Provider architecture

The public Provider API is the stable extension seam. It defines `McpProvider`, `McpTool`, Toolsets, release states, and injectable `Services` (`OrgService`, `ConfigService`, telemetry). `EXAMPLE-MCP-PROVIDER` confirms that a Provider can remain independent of the official host.

| SFoA capability | Classification | Decision |
| --- | --- | --- |
| `sfoa-auth` | Shared service / adapter | Credentials and Connections are cross-cutting runtime dependencies, not Tools |
| `identity-routing` | HTTP middleware + immutable request context | Bind authenticated `platformUserId` before Tool arguments are considered |
| `sobject-mutation` | New Provider + shared allowlist service | Agent-visible generic CREATE/UPDATE; absent object/operation config means DENY |
| `runtime-context` | Provider only for a proven deterministic gap, backed by shared context | First reuse generic SOQL/schema/metadata capabilities |
| `diagnosis-context` | Composition/shared service first | Reuse SOQL, metadata, Apex test, and code analysis; add a Tool only for a missing operation |

## Authentication architecture

Official Tool execution uses Salesforce Node libraries rather than spawning the `sf` CLI. The normal connection chain is:

```text
--orgs startup values
  -> process Cache allowlist
  -> AuthInfo.listAllAuthorizations()
  -> filter username / alias / default tokens
  -> AuthInfo.create({ username })
  -> Connection.create({ authInfo })
  -> Tool
```

`Org` is not an obligatory link. Tools that require org-level project behavior subsequently call `Org.create({ connection })`; SOQL uses the Connection directly.

Examples:

- `run_soql_query` calls `connection.query()` or `connection.tooling.query()`.
- `run_apex_test` creates `TestService(connection)` from `@salesforce/apex-node`.
- `retrieve_metadata` uses `SfProject`, `Org`, Source Tracking, ComponentSet, and SDR.
- Code Analysis uses the analyzer libraries/engines.
- The DevOps Provider spawns local Git commands for Git workflows, not `sf` for Salesforce Tool execution.

`--orgs` is a server-startup allowlist, not request authentication. Default-target tokens are re-resolved from `ConfigAggregator` during Tool calls and depend on the ambient working directory. One shared official host therefore cannot safely represent unrelated concurrent platform users.

## SFoA compatibility

| Gate | Result | Evidence |
| --- | --- | --- |
| SFoA endpoint resolution | PARTIAL | Existing local alias resolves an SFoA My Domain, with no hard-coded `login.salesforce.com` |
| Salesforce CLI JWT login | NOT TESTED | `SFOA_INSTANCE_URL`, username, client ID, and private-key path were not supplied |
| Salesforce CLI query | FAIL | Existing authorization cannot refresh because its session/refresh token is expired |
| Official MCP SOQL | FAIL | Original `run_soql_query` returned `isError=true` because the stored refresh authorization is expired; query did not execute |
| Official MCP metadata retrieve | NOT TESTED | Fresh authorization plus a controlled DX project/component target required |
| Second user | NOT TESTED | No second user supplied |

```text
SF_CLI_JWT_AUTH = NOT TESTED
SF_CLI_QUERY    = FAIL
```

The current failure is an authorization-expiry result, not proof of poor SFoA API compatibility.

## SOQL result

The direct v2 CLI attempted:

```sql
SELECT Id, Name
FROM Account
LIMIT 5
```

It failed before query execution while refreshing the expired local session. No record data was returned or stored. `SF_CLI_QUERY = FAIL (credential expired)`. The original MCP `run_soql_query` produced the same credential failure; a successful data Gate requires fresh JWT login.

## Metadata result and runtime constraints

Live component results remain untested. Static source audit establishes that `retrieve_metadata`:

1. Requires an absolute directory and changes process CWD.
2. Resolves a writable `SfProject` and project source API version.
3. Instantiates Source Tracking and builds a ComponentSet.
4. Requires source paths or a manifest for a non-source-tracking org.
5. Writes and merges retrieved files into the project's package directory.

It is therefore not a pure remote metadata query. The future runtime needs a bounded Temporary Workspace Adapter (minimal DX project, generated manifest, writable package directory, cleanup). P0 designs but does not implement that adapter.

| Metadata type | Live result | Reason |
| --- | --- | --- |
| CustomObject | NOT TESTED | Fresh JWT and controlled component name absent |
| ValidationRule | NOT TESTED | Fresh JWT and controlled component name absent |
| Flow | NOT TESTED | Fresh JWT and controlled component name absent |
| ApexTrigger / ApexClass | NOT TESTED | Fresh JWT and controlled component name absent |
| Layout | NOT TESTED | Fresh JWT and controlled component name absent |
| FlexiPage | NOT TESTED | Fresh JWT and controlled component name absent |

## Multi-user result

`Multiple Users = NOT TESTED` because `SECOND_TEST_USER` was not supplied. Static analysis is conclusive that the shipped host is process-scoped, not request-scoped: it captures one Services graph and Tool set, uses singleton Cache state, and several Tools call `process.chdir()`.

Two viable P1 designs were compared:

| Criterion | Request-scoped Provider host | Per-user child-process pool |
| --- | --- | --- |
| Upstream changes | None | None |
| Isolation | Strong for identity/Services; global CWD must be guarded | Strong process and CWD isolation |
| Performance | Better; low per-request object cost | Higher memory/startup, needs pooling |
| Complexity | Moderate | Moderate/high |
| Testing | Direct context/provider/concurrency tests | Adds lifecycle/crash/eviction tests |
| Merge risk | LOW | LOW |

Recommendation: request-scoped Provider host. Resolve platform identity before Tool execution, construct request-scoped Services/Connection, and instantiate the selected official Provider Tools in that scope. Initially serialize and restore CWD around affected Tools; evaluate child workers specifically for concurrent metadata workloads.

## Original Salesforce DX MCP protocol evidence

The project-local Inspector started the built official stdio server with only `core,data,metadata`, performed protocol initialization, and returned five schemas:

1. `get_username`
2. `resume_tool_operation`
3. `run_soql_query`
4. `deploy_metadata`
5. `retrieve_metadata`

`tools/call get_username` returned `isError=false`. `tools/call run_soql_query` reached the official Tool and returned a correctly formed Tool-level `isError=true` result for the expired refresh authorization. The Inspector process itself exited 0 for both calls. The complete Tool contract is stored in `evidence/dx-mcp-tools-list.json`.

The packaged official host resolved dx-core 0.9.8 as declared by `@salesforce/mcp`, while the POC deliberately exercised the local public Provider workspace 0.10.0. Both use MCP SDK 1.18.2. This validates the package-release drift risk and is why source and packaged behavior remain separate Gates.

## Streamable HTTP

A private P0 workspace under `packages/sfoa-streamable-http-poc` composes the public Provider API, official dx-core Provider, and the official MCP SDK. It retains the official stdio host untouched and uses stateless JSON-response Streamable HTTP on loopback with SDK host validation and DNS-rebinding protection.

The POC scope is intentionally limited to:

- core, data, and metadata GA Tools;
- `initialize`, `tools/list`, and one non-Salesforce `get_username` Tool call;
- a fresh MCP server, transport, Services graph, and Tool instances per POST;
- no production OAuth/JWT routing, session store, Admin UI, or DML.

Runtime result: **PASS**. Strict TypeScript build and workspace lint passed. The official SDK Client completed initialize/initialized, listed all five selected official Tools, called `get_username` with `isError=false`, verified GET rejection with 405, and rejected an untrusted Origin with 403. The final POC integration test passed after this hardening.

## Reuse matrix

| Capability | Official support | Decision | Reason |
| --- | --- | --- | --- |
| SOQL | `run_soql_query` GA | REUSE | Generic data and Tooling API query through Connection |
| Metadata Retrieve | `retrieve_metadata` GA | WRAP | Reuse operation, add controlled workspace lifecycle |
| Apex Test | `run_apex_test` GA | REUSE | Official Apex TestService integration |
| Code Analysis | GA analyzer Tools | REUSE | Do not duplicate official engines |
| Schema | Queryable through generic SOQL/Tooling metadata; no dedicated universal schema Tool in core | EXTEND | First wrap/reuse generic query; add only a proven deterministic schema gap |
| Create | No general allowlisted SObject create Tool in audited core | NEW PROVIDER | P3 generic CREATE with object/operation allowlist |
| Update | No general allowlisted SObject update Tool in audited core | NEW PROVIDER | P3 generic UPDATE with object/operation allowlist |
| Delete | Some org-management delete exists, but record DELETE is outside SFoA phase scope | NOT NEEDED | Initial mutation policy forbids DELETE |
| Runtime UI Context | No generic SFoA runtime UI context | EXTEND | Prefer existing data/metadata; add minimal deterministic context only when proven |
| Account Routing | Official `--orgs` is process-scoped | EXTEND | Request middleware/shared OrgService, not an agent Tool |
| Streamable HTTP | MCP SDK supports it; official host exposes stdio | WRAP | Thin SFoA host around public Providers; retain stdio |

## Upstream modification matrix

| Official tracked file | Reason | Change | Alternative | Merge risk |
| --- | --- | --- | --- | --- |
| `.gitignore` | Track authoritative SFoA docs and exclude local secrets/research cache | Allow `docs/sfoa`; ignore local env/key/PEM/secrets/Firecrawl paths | Force-add docs and use personal excludes | LOW |

Official TypeScript implementation changes: **0**. New SFoA documents and the POC package are extensions, not edits to official Tool code. The final install did not change `yarn.lock`; `.gitignore` is the only modified Upstream-tracked file.

## Risks

| Risk | Level | Response |
| --- | --- | --- |
| Process-scoped official host used for shared HTTP | HIGH if reused unchanged | New request-scoped SFoA host |
| Global `process.chdir()` in Tools | HIGH under concurrent calls | Fixed directories, serialize/restore initially, isolate metadata workers if needed |
| Metadata filesystem lifecycle | MEDIUM | Temporary Workspace Adapter design in later phase |
| Provider/server package-release drift | MEDIUM | Pin resolved versions and test source plus packaged host |
| Yarn v1 `nohoist` Windows cost | MEDIUM | Preserve Upstream policy; cache and measure rather than migrate during P0 |
| Current Salesforce CLI path/plugin hygiene | LOW/MEDIUM | Direct v2 for evidence; user-reviewed permanent repair later |
| Missing fresh SFoA JWT inputs | Gate blocker | Keep live results unclaimed and request inputs once |
| Upstream code-analyzer root lint failure | MEDIUM maintenance debt | Preserve the factual FAIL; do not patch 47 unrelated official findings during P0 |

## Recommended architecture and required answers

### Q1 — Is Salesforce DX MCP suitable as the long-term Runtime Base?

**PARTIAL.** Its Provider API, official Tools, schemas, SDK usage, and tests are an excellent capability base. The shipped process-scoped stdio host is not the production multi-user HTTP runtime unchanged.

### Q2 — Repository/runtime strategy

**FULL FORK + EXTENSION.** This project retains complete official history and Upstream sync while production behavior lives in new SFoA packages consuming public Provider contracts. The successful POC proves that this does not require private host imports or official Tool patches. If a separately released runtime package is later useful, it can still be built from the extension workspace without discarding the full-history integration repository.

### Q3 — SFoA compatibility

**PARTIAL.** Endpoint resolution works, but expired local credentials and absent JWT inputs prevent successful live SOQL/metadata proof.

### Q4 — Best request-scoped account routing design

Authenticated HTTP middleware resolves `platformUserId` to an immutable identity/credential reference; a request-scoped TokenProvider and `OrgService` create the Salesforce Connection; Provider Tool instances are created in the same request scope. Never accept arbitrary client-selected usernames as the authorization boundary. Serialize/restore global CWD initially and isolate metadata work when concurrency requires it.

### Q5 — Can Streamable HTTP be added with low intrusion?

**YES.** The runtime Gate passed through the official SDK and public Provider API, with no official Tool patch.

### Q6 — Expected official code modifications

**Zero official TypeScript files; very few repository-integration files.** P0 currently changes only `.gitignore` among official tracked files.

### Q7 — Upstream merge risk

**LOW**, provided production behavior remains in new packages and root/lockfile changes remain deliberate and tested.

## P0 result

`P0 = PARTIAL PASS`

Evidence supporting the result:

- Environment, full-history clone, Yarn install, build, full tests, original stdio initialize/list/call, project-local Inspector, auth architecture audit, and Streamable HTTP POC passed.
- Upstream root lint failed on 47 existing code-analyzer errors; no broad official-code cleanup was performed.
- The existing SFoA endpoint resolves, but CLI and original MCP SOQL both fail on the expired local authorization.
- Fresh JWT login, live metadata component retrieval, and the two-user live Gate remain untested because their required inputs were not supplied.

This status does not authorize P1. P0 awaits maintainer review.

### P0-Closure update — 2026-08-22

The Closure Harness, exact Provider compatibility baseline, temporary metadata workspace, original stdio regression, Streamable HTTP regression, and changed-code lint Gate now pass. Persistent user PATH prefers CLI v2.148.3 and the stale plugin entry is removed; Salesforce CLI is explicitly not a production dependency. Root code-analyzer lint is reclassified as `KNOWN UPSTREAM DEBT`, not hidden.

P0 remains `PARTIAL PASS` because `.env.local` is absent and the mandatory live Fresh JWT, identity, Direct/official SOQL, official Metadata, and CWD observations remain `NOT TESTED`. See `P0_CLOSURE_REPORT.md` and `TEST_MATRIX.md` for current authoritative evidence. A second user is now a P1 isolation Gate, not a P0 blocker.

## P1 detailed plan — planned only, do not start

1. Freeze an authenticated request-context contract: `platformUserId`, correlation ID, immutable workspace reference, and no client-selected Salesforce identity.
2. Define an Identity Resolver interface and a simple secret-safe mapping/config adapter; no database/Vault platform without a proven requirement.
3. Implement a JWT/OAuth TokenProvider and request-scoped `OrgService`/Connection factory with expiry-aware connection reuse only within a safe identity boundary.
4. Build the production Streamable HTTP host around public official Providers; retain the existing stdio entry unchanged.
5. Add an execution guard for Tools that mutate process CWD, with capture/set/finally-restore and a global async mutex; benchmark isolated workers for metadata.
6. Add identity tests: valid route, no route, forged username, user A/user B separation, parallel calls, token expiry, refresh failure, log redaction.
7. Add protocol tests: initialize, pagination-capable list behavior where relevant, schemas, Tool success/error contracts, cancellation/timeouts, malformed input, HTTP method/content-type/host checks.
8. Run real two-user SFoA read-only tests before P1 exit and record the accepted routing design in an ADR.

P1 excludes DML Provider implementation, Admin UI, database redesign, Redis, and complex policy/RBAC systems.

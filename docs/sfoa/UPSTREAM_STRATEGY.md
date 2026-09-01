# Upstream Strategy

## Repository identity

| Item | Value |
| --- | --- |
| Official repository | `https://github.com/salesforcecli/mcp.git` |
| Official remote name | `upstream` |
| Company remote | `origin = https://github.com/ElioLin/sfoa-enterprise-mcp.git` |
| Branch | `main` tracking `origin/main` |
| P0 audited commit | `670234dbdca4d3fcdebd9d58b231e311fd34aeec` |
| Commit timestamp | 2026-07-27T14:54:21-05:00 |
| Commit subject | `chore: default org clarification (#477)` |

The repository was cloned with full Git history. It was not downloaded as a ZIP and was not reinitialized.

## Integration policy

1. Keep `upstream` pointed only at the Salesforce repository.
2. Keep the company repository as `origin`; its current URL is the supplied GitHub repository.
3. Keep Salesforce-owned implementation files as close to Upstream as possible.
4. Put SFoA behavior in new packages, adapters, middleware, tests, docs, and applications.
5. Consume public official Provider packages and the Provider API rather than importing private host internals into production code.
6. If an Upstream change is unavoidable, keep it surgical and add it to the modification matrix below in the same change.
7. Never clean up or reformat unrelated Upstream code.

## Recommended source layout

P1 consolidates request identity, JWT/Connection construction, Services composition, HTTP hosting, and validation in one cohesive private workspace. Later providers/apps remain phase-gated:

```text
packages/
  sfoa-identity-runtime/     # P1 implemented request identity/JWT/Services/HTTP boundary
  sfoa-runtime-validation/   # P0 Closure Harness only
  sfoa-streamable-http-poc/  # P0 transport POC only
  mcp-provider-sfoa-dml/     # P3 generic CREATE/UPDATE tools
  mcp-provider-sfoa-context/ # P4 deterministic USER/DIAGNOSTIC context Provider
  sfoa-agent-playbook/       # P6 pure canonical Agent contract and renderers
  sfoa-admin-api/            # P5 authenticated Admin API
  sfoa-admin-web/            # P5 React Admin application
apps/
  # no SFoA runtime application is added under upstream apps/
```

Provider folders follow Upstream's `mcp-provider-*` rule. Non-provider SFoA packages are clearly prefixed and must not masquerade as official `@salesforce/*` packages.

## Sync procedure

When an upstream sync is requested:

```powershell
git fetch upstream --prune
git log --oneline --decorate --graph --left-right main...upstream/main
```

Then merge or rebase only according to the company branch policy that exists at that time. Before accepting the sync:

1. Review changes to Provider API, registry, Services, auth, Tool schemas, transports, SDK versions, and Node/Yarn policy.
2. Rerun install/build/test/lint.
3. Rerun stdio initialize/list/call and Streamable HTTP tests.
4. Rerun SFoA JWT/SOQL/metadata and A/B identity tests when credentials are available.
5. Update `PROJECT_BASELINE.md`, `TEST_MATRIX.md`, `CHANGELOG.md`, and ADRs when conclusions change.

P7-07 adds an SFoA-only unreleased entry at the top of upstream-owned `CHANGELOG.md` because the repository rules require phase-status changes to update the changelog. Alternative: record the change only in `docs/sfoa/P7_07_REPORT.md`; rejected because it would leave the required project changelog stale. Merge risk: low and localized to the file header; preserve upstream release history below it during rebases.

Do not execute `git reset --hard` or overwrite local SFoA work to sync Upstream.

## Package-release drift

The monorepo source and the versions bundled by `packages/mcp/package.json` can differ temporarily during release choreography. At the audited commit, the source workspace `@salesforce/mcp-provider-dx-core` is 0.10.0 while the server manifest declares 0.9.8. Because the exact dependency does not satisfy the workspace version, Yarn can resolve the published package instead of the local workspace.

Implications:

- Source audit and packaged-server behavior must both be checked.
- Patches to a provider workspace are not proof that the main server uses that patched workspace.
- SFoA packages must pin and record tested official package versions.
- Upstream sync review must compare package manifests and lockfile resolution, not just source directories.

## Upstream modification matrix

An “upstream-owned file” is any path tracked at the audited commit. New SFoA files are not upstream modifications.

| File | Reason | Change | Alternative considered | Merge risk |
| --- | --- | --- | --- | --- |
| `.gitignore` | Track the authoritative `docs/sfoa` baseline and `docs/agent` Playbook distributions while preventing local secrets, research cache, and Playwright run output from entering Git | Replaced broad `docs` ignore with explicit `docs/sfoa` and `docs/agent` exceptions; added `.env.*.local`, key/PEM, secrets, `.firecrawl`, Closure `.temp/`, and P5 browser-report/test-result ignores | Force-add docs on every clone and rely on personal excludes; rejected because it is not durable for AI agents | LOW |
| `README.md` | Make the enterprise fork's current phase, safety boundary, and operator entry points visible before the retained official README | Added a short SFoA status/setup preface and links to P5, P6, P7 Audit, and Dify/WorkBuddy setup; retained the official documentation below it | Leave the root README describing only the upstream stdio product; rejected because it misrepresents the checked-out runtime | LOW |
| `package.json` | Expose the Maintainer-required P5 lifecycle and P6 deterministic Agent artifact commands at the repository root | Added scripts only, including `agent:sync` and `agent:check`; retained the existing Yarn Classic `packages/*` workspace and `nohoist` policy | Require contributors to remember long workspace-specific commands or add another task-runner dependency; rejected because the small standard-library commands are clearer and dependency-free | LOW |
| `yarn.lock` | Lock the first approved P5 product/test dependencies for MySQL/Kysely, React Admin, and Playwright under Yarn Classic | Regenerated by repository Yarn 1.22.22 from exact P5 workspace manifests; no package-manager migration | Leave new dependencies unlocked or introduce npm/pnpm lockfiles; rejected because neither is reproducible or permitted | MEDIUM |

No Salesforce TypeScript implementation file was modified in P0, P0-Closure, or P1. All SFoA packages consume public Provider contracts only. P1 creates fresh `DxCoreMcpProvider` Tools from request-scoped Services and enforces identity/workspace/CWD policy at the host boundary. P1 changed no pre-existing official package path and did not change root `package.json`, `yarn.lock`, or `.env.example`; therefore it adds no Upstream modification-matrix row. The existing `.gitignore` row remains the only tracked Upstream-file divergence.

P2 also modifies **zero official Salesforce TypeScript files**. `packages/sfoa-mcp-server` is a new SFoA-owned composition package; the P2 edits to `packages/sfoa-identity-runtime`, `.env.example`, and `docs/sfoa` are all in SFoA-owned paths that did not exist at the audited Upstream commit. Root `package.json` and `yarn.lock` remain unchanged. Therefore P2 adds no Upstream modification-matrix row, and `.gitignore` remains the only tracked Upstream-owned divergence.

P2 uses only public contracts: `McpTool.getConfig()`, `McpServer.registerTool()`, public Provider construction, `@salesforce/core` Connection/JWT, and official `Tool.exec()`. Remote schema adaptation validates the audited official surface, projects explicit Agent-owned Zod fields, and injects request authority at the composition boundary; it copies no official Tool implementation. Merge risk remains LOW.

P2 Closure HOTFIX01 remains entirely in SFoA-owned package/tests/docs. It uses public `DxCoreMcpProvider.getName()`, `getVersion()`, `provideTools()`, and public Tool `getName()`/`getReleaseState()`/`getConfig()` to detect inventory and contract drift. Remote schemas are now projected from explicit Agent-field allowlists after exact audited surface validation. The hotfix modifies zero official Salesforce TypeScript files, copies no Tool, and does not change root `package.json` or `yarn.lock`; no modification-matrix row is required.

P3 also modifies **zero official Salesforce TypeScript files**. The new `packages/mcp-provider-sfoa-dml` workspace and the P3 additions to `packages/sfoa-mcp-server`, `.env.example`, and `docs/sfoa` are SFoA-owned paths. The existing root `packages/*` workspace glob discovers the new package, so root `package.json` and `yarn.lock` remain unchanged and no new Upstream modification-matrix row is required.

P3-00 inspected the actual pinned dx-core Provider/public API/history before choosing the extension. No current generic CREATE/UPDATE Provider is reusable; removed historical source was not copied. Salesforce Hosted `platform/sobject-mutations` uses a separate hosted endpoint and OAuth/External Client App model, does not accept the existing in-process request Connection, and has no proven SFoA availability. The minimal fallback uses only the pinned public `@salesforce/core`/JSforce single-record `Connection.sobject().create()` and `update()` methods. Production calls no raw REST, CLI, Auth Cache, DELETE/destroy, UPSERT, or Bulk API. Merge risk remains LOW.

P3-Closure HOTFIX01 also remains entirely in SFoA-owned Provider/Host/tests/docs. It classifies the public SDK's returned `SaveResult` and structured JSforce error body without patching or copying JSforce, `@salesforce/core`, the Provider API, or an official Salesforce Tool. The Closure changes zero official Salesforce TypeScript files, root manifest entries, and lockfile entries; it adds no dependency or Upstream modification-matrix row. Merge risk remains LOW.

P4 also modifies **zero official Salesforce TypeScript files**. The new `packages/mcp-provider-sfoa-context` workspace and P4 edits to `packages/sfoa-identity-runtime`, `packages/sfoa-mcp-server`, `.env.example`, and `docs/sfoa` are SFoA-owned paths. The existing root `packages/*` glob discovers the Provider, so root `package.json` and `yarn.lock` remain unchanged and no new Upstream modification-matrix row is required.

P4 reuses public seams only. `run_diagnostic_tooling_query` invokes unchanged official `run_soql_query` `Tool.exec()` with server-forced Tooling/identity/workspace inputs. `get_metadata_component_context` invokes unchanged official `retrieve_metadata` and adds only same-request bounded reading because the live official result returned status text while its useful source files existed only in the disposable workspace. `get_record_action_context` uses the public `@salesforce/core` Connection REST UI API surface verified against SFoA API 67.0. No official Tool, JSforce method, or Salesforce runtime implementation is copied or patched.

The actual Code Analyzer Provider was initialized and classified `NOT REMOTE COMPATIBLE` because its contracts accept absolute local targets and a durable/global-temp result file. P4 does not import or instantiate it in production, add it as an SFoA dependency, copy it, or create durable infrastructure around it. Merge risk remains LOW.

P5 modifies **zero official Salesforce TypeScript implementation files**. Product behavior remains in new `sfoa-control-plane`, `sfoa-admin-api`, and `sfoa-admin-web` workspaces plus surgical changes to the existing SFoA identity/HTTP composition packages. Official dx-core Tools remain unchanged: the runtime still invokes public Provider `Tool.exec()` and public `@salesforce/core` APIs. P5 does not patch JSforce, copy an official Tool, add a Salesforce permission replica, or expose Salesforce CLI/Auth Cache as a runtime dependency.

The root manifest and lockfile changes are the explicit P5 dependency/tooling exception authorized by the Maintainer. The existing `packages/*` glob already discovers all three P5 workspaces, so workspace topology is unchanged. Merge risk is concentrated in lockfile resolution and is controlled with exact new dependency versions, Yarn Classic gates, official stdio/upstream regressions, and the recorded Windows nested-link workaround; official source merge risk remains LOW.

P6-Agent-01 also modifies **zero official Salesforce TypeScript implementation files**. The new `sfoa-agent-playbook` workspace and changes to existing SFoA-owned MCP/Admin packages use public MCP SDK 1.18.2 Instructions, Resource, Prompt, and Tool APIs plus the existing request-scoped `@salesforce/core` Connection. No official Tool is copied or renamed, and no Provider API, dx-core, JSforce, stdio host, registry, Services, or Salesforce package is patched.

The root `package.json` row above is updated for the two deterministic generation commands. The existing `packages/*` glob discovers the new package. P6 adds no third-party version and produces no `yarn.lock` content delta. Generated Dify/WorkBuddy/Skill artifacts are SFoA-owned files, not upstream implementation changes. Official source merge risk remains LOW.

P6-DML-01 also modifies **zero official Salesforce TypeScript implementation files**. The migration, Control Plane/Admin contracts, managed-field resolver/facade, Agent capability adapters, tests, UI, and documentation all live in SFoA-owned paths. The existing generic `create_record`/`update_record` Provider and every official dx-core Tool remain unchanged. Resolution uses the public request-scoped `@salesforce/core` Connection already supplied by the host, then delegates to the unchanged generic DML Tool.

No third-party dependency, root manifest entry, or lockfile resolution changes for P6-DML-01. The explicit `SFOA_LIGHTNING_BASE_URL` is SFoA host configuration; it replaces a host inference without changing Salesforce or MCP SDK code. The only upstream-owned documentation delta is the already registered `README.md` preface update. Official source merge risk remains LOW.

P7-01 also modifies **zero official Salesforce TypeScript implementation files**. The additive migration, Audit contracts/sanitization/MySQL repository, compatibility changes, tests, and authoritative P7 documentation live in SFoA-owned paths. Existing official Tools, Provider API, dx-core, JSforce, stdio host, registry, and Salesforce packages remain unchanged. No dependency, root manifest, or `yarn.lock` change is introduced. The only upstream-owned documentation delta is covered by the existing root `README.md` matrix row. Official source merge risk remains LOW.

P7-03 modifies **zero official Salesforce TypeScript implementation files**. Request collection, immutable Snapshot creation, Queue/Writer batching, dedicated Audit database budget, Runtime lifecycle integration, tests, and authoritative documentation remain in SFoA-owned identity-runtime, control-plane, and MCP server composition paths. It introduces no dependency or lockfile change and no Salesforce API. The upstream-owned root `README.md` receives only the existing SFoA extension/status/link inventory update; no upstream runtime contract changes. Official source merge risk remains LOW.

## Changes that require a new matrix entry

- Root/package workspace configuration.
- Any file under an existing Upstream package.
- Existing CI workflows.
- Existing lockfiles.
- Official server CLI flags, registry, Services, authentication, Tool implementations, telemetry, or transport.

Generated build output and local dependencies are ignored and are not modification entries.

## Merge-risk target

Target: **LOW**

The target is achieved only if SFoA production behavior remains in new composition packages and official server behavior stays testable unchanged.

P0 observed Upstream maintenance issues that are recorded but intentionally not patched:

- a default Windows PowerShell/cmd build cannot find the POSIX `cp` invoked by the code-analyzer build script; the same root build passes under existing Git Bash;
- `clean-all` rejects a literal `*.tgz` path through Windows rimraf;
- broad `eslint **/*.ts` scripts inspect generated declarations after build;
- code-analyzer has 47 existing source/test/generated lint errors in the audited checkout.
- a failed Windows Yarn link attempt can remove workspace `.bin` shims before aborting; P1 final verification restored only ignored generated shims, then the root build and full workspace test command passed without source or lockfile changes.

P4 final verification reproduced the same class of Windows Yarn Classic installation debt at a different nested link target: `packages/mcp-provider-api/node_modules/@typescript-eslint/eslint-plugin/node_modules/ignore` failed with `ENOENT lstat`. The aborted install changed no source, manifest, or lockfile but removed generated command shims. Exactly 513 missing ignored commands were mechanically regenerated from the installed packages' `package.json#bin` declarations. Original stdio, root build, root full tests, Inspector, and targeted Gates then passed. This is environment/Upstream maintenance debt, not an SFoA source waiver.

These findings keep the repository-wide lint Gate red but do not justify a broad official-code cleanup inside the SFoA P0 compatibility change.

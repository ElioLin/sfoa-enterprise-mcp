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
  mcp-provider-sfoa-context/ # Proven missing context tools only
apps/
  admin-web/                 # P5 React application
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
| `.gitignore` | Track the authoritative `docs/sfoa` baseline and prevent local secrets/research cache from entering Git | Replaced broad `docs` ignore with a `docs/sfoa` exception; added `.env.*.local`, key/PEM, secrets, `.firecrawl`, and Closure `.temp/` ignores | Force-add docs on every clone and rely on personal excludes; rejected because it is not durable for AI agents | LOW |

No Salesforce TypeScript implementation file was modified in P0, P0-Closure, or P1. All SFoA packages consume public Provider contracts only. P1 creates fresh `DxCoreMcpProvider` Tools from request-scoped Services and enforces identity/workspace/CWD policy at the host boundary. P1 changed no pre-existing official package path and did not change root `package.json`, `yarn.lock`, or `.env.example`; therefore it adds no Upstream modification-matrix row. The existing `.gitignore` row remains the only tracked Upstream-file divergence.

P2 also modifies **zero official Salesforce TypeScript files**. `packages/sfoa-mcp-server` is a new SFoA-owned composition package; the P2 edits to `packages/sfoa-identity-runtime`, `.env.example`, and `docs/sfoa` are all in SFoA-owned paths that did not exist at the audited Upstream commit. Root `package.json` and `yarn.lock` remain unchanged. Therefore P2 adds no Upstream modification-matrix row, and `.gitignore` remains the only tracked Upstream-owned divergence.

P2 uses only public contracts: `McpTool.getConfig()`, `McpServer.registerTool()`, public Provider construction, `@salesforce/core` Connection/JWT, and official `Tool.exec()`. Remote schema adaptation omits host-owned Zod fields and injects request authority at the composition boundary; it copies no official Tool implementation. Merge risk remains LOW.

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

These findings keep the repository-wide lint Gate red but do not justify a broad official-code cleanup inside the SFoA P0 compatibility change.

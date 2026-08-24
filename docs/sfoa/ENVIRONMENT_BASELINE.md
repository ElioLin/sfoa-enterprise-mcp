# SFoA Enterprise MCP Environment Baseline

Baseline captured: 2026-08-21/22; P5 local environment updated 2026-08-24 (Asia/Shanghai)

Workspace: `D:\GitProject\sfoa-enterprise-mcp`

## Host

| Item | Observed value | Status |
| --- | --- | --- |
| Operating system | Microsoft Windows 11 Professional, 10.0.28000 (build 28000) | PASS |
| OS architecture | x64 / 64-bit | PASS |
| Process architecture | x64 | PASS |
| Shell | PowerShell | PASS |

## Required runtimes

| Runtime | Observed version | Primary executable path | Result | Notes |
| --- | --- | --- | --- | --- |
| Git | 2.50.0.windows.2 | `D:\Git\cmd\git.exe` | PASS | Git identity is configured; values are intentionally not copied into the repository. |
| Node.js | v24.13.0 | `D:\software\node.exe` | PASS | Meets `@salesforce/mcp` `>=20.0.0` and Upstream CI/development policy `lts/*` / current LTS. |
| npm | 11.6.2 | `D:\software\npm.cmd` | PASS | Used only where an official globally installed CLI requires npm; project dependencies remain Yarn-managed. |
| Yarn | 1.22.22 | `D:\software\yarn.CMD` | PASS | Activated through existing Corepack 0.34.5. Upstream has a Yarn v1 lockfile and explicitly requires Yarn v1. |
| MySQL | 8.0.30 | Windows service `MySQL80`, `127.0.0.1:3306` | PASS | P5 application and isolated `_test` schemas were provisioned, migrated, queried, and exercised; credentials remain local-only. |
| Salesforce CLI (current Codex process snapshot) | `@salesforce/cli/1.86.7-legacy.0`, embedded Node 18.15.0 | `D:\sfdx\bin\sf.cmd` | PARTIAL | This already-open process inherited the old PATH before Closure remediation. |
| Salesforce CLI (persistent user PATH / new terminals) | `@salesforce/cli/2.148.3`, embedded Node 24.18.0 | `C:\Users\61979\AppData\Local\sf\client\bin\sf.cmd` | PASS | Stable v2 shim is the first persistent user-PATH entry; direct version and plugin checks pass. Open a new terminal to inherit it. |

Additional executable locations observed:

- Git: `D:\Git\bin\git.exe` and the Codex bundled Git runtime.
- npm: `D:\software\npm` and `D:\software\npm.cmd`.
- Yarn: `D:\software\yarn` and `D:\software\yarn.CMD`.
- Salesforce CLI legacy: `D:\sfdx\bin\sf` and `D:\sfdx\bin\sf.cmd`.
- Salesforce CLI stable v2 shim: `C:\Users\61979\AppData\Local\sf\client\bin\sf.cmd`.
- Corepack: `D:\software\corepack.cmd`.
- winget: `C:\Users\61979\AppData\Local\Microsoft\WindowsApps\winget.exe`, version 1.29.280.

## Optional tools

| Tool | Observed value | Result | P0 impact |
| --- | --- | --- | --- |
| MCP Inspector | Project dependency `@modelcontextprotocol/inspector ^0.15.0` | PASS | Project-local CLI initialized/listed/called the original stdio server; no global install. |
| Python | WindowsApps launcher alias found; no working Python version returned; `py` is absent | NOT TESTED | Not a TypeScript runtime prerequisite. |
| Java | Java 8, 1.8.0_381 (additional JDK 19 paths also exist) | PARTIAL | Optional for this P0. Upstream CI uses Java 11 for code-analysis paths. |
| nvm-windows | Not found | NOT TESTED | No action; do not add a second version manager. |
| Volta | Not found | NOT TESTED | No action; do not add a second version manager. |

## Version strategy evidence

The Node/Yarn decision followed the required priority:

1. No `.nvmrc`, `.node-version`, root `packageManager`, or root `engines` pin exists.
2. `packages/mcp/package.json` and `packages/mcp-test-client/package.json` require Node `>=20.0.0`.
3. GitHub Actions use `node-version: lts/*` (including Windows CI).
4. `DEVELOPING.md` requires an up-to-date/current Node LTS.
5. `yarn.lock` is `yarn lockfile v1`; `packages/mcp/DEVELOPING.md` explicitly requires Yarn v1.

Node v24.13.0 was therefore retained. Yarn Classic 1.22.22 was activated with:

```powershell
corepack enable yarn
corepack install --global yarn@1.22.22
```

No global TypeScript, React, Vite, Ant Design, TanStack Query, or React Router installation was performed.

The original P0 project-local `yarn install` completed successfully in 1499.30 seconds and left `yarn.lock` unchanged. The installed MCP SDK resolved to 1.18.2 for both the packaged server and POC.

During P0-Closure, repeated `yarn install --frozen-lockfile --network-timeout 600000` attempts failed in Yarn Classic's Windows linking stage at `packages/mcp-provider-api/node_modules/@typescript-eslint/typescript-estree/node_modules/brace-expansion` with `ENOENT lstat`. Moving only that generated dependency directory aside and retrying reproduced the same error; `yarn.lock` remained unchanged. Closure therefore uses targeted workspace build/test/lint plus stdio/HTTP integration evidence and records the frozen reinstall as a separate environment debt, not as a Salesforce compatibility result.

P4 final verification again ran the repository-pinned Yarn Classic frozen install. After approximately eight minutes it aborted in the Windows link stage at `packages/mcp-provider-api/node_modules/@typescript-eslint/eslint-plugin/node_modules/ignore` with `ENOENT lstat`. No source, manifest, package lock, or `yarn.lock` changed. The aborted link removed generated workspace `.bin` commands; a local mechanical repair regenerated exactly 513 missing ignored commands from the already installed packages' `package.json#bin` declarations. Original stdio, Git Bash root build, full root tests, Inspector, and targeted P0–P4 Gates subsequently passed. The install remains `KNOWN UPSTREAM DEBT`, not an SFoA code exception.

P5 Closure reproduced the same nested `ignore` link debt. All new P5 dependencies were nevertheless present and resolved from the reviewed Yarn lockfile; final `yarn validate:p5` passed every changed-code, MySQL, Admin, UI, mocked-browser, and real full-stack-browser Gate in 625.83 seconds. No npm/pnpm/Yarn Berry migration or global frontend tool installation was used.

## Runtime verification

```text
node -v                         -> v24.13.0
npm -v                          -> 11.6.2
node -e "console.log(process.version)" -> v24.13.0
yarn --version                  -> 1.22.22
```

```text
NODE_RUNTIME = PASS
YARN_RUNTIME = PASS
MYSQL_RUNTIME = PASS
SALESFORCE_CLI_V2 = PASS
ACTIVE_PROCESS_PATH_REFRESH = PARTIAL
```

## Salesforce CLI remediation record

- The existing legacy CLI was not deleted.
- The CLI's own update index reported stable builds newer than the PATH-selected legacy CLI.
- A user-level official npm installation of `@salesforce/cli@2.148.3` was attempted because npm `latest` resolved to 2.148.3 and the global prefix was user-owned.
- The attempt failed with `ECONNRESET`; npm also reported non-fatal cleanup `EPERM` warnings. It did not replace the PATH-selected CLI. A later audit found an unversioned, shimless partial package directory created by this attempt; `npm uninstall --global @salesforce/cli` removed that exact residue and both pre-existing CLI installations were reverified.
- winget was not used: the search result contained an old `Salesforce.sfdx-cli` package and a non-Salesforce wrapper, not the current official `sf` v2 distribution.
- P0-Closure used the CLI's own `plugins uninstall @salesforce/sfdx-scanner` command to remove the stale missing-plugin manifest entry. The v2 `sf plugins` command now reports no installed plugins and no stale warning.
- The persistent user PATH was safely updated without administrator rights so `C:\Users\61979\AppData\Local\sf\client\bin` precedes the legacy directory. The current Codex process cannot inherit that change retroactively; a newly opened terminal resolves v2.148.3 first.
- The stable v2 CLI completed JWT login, `sf org display`, and a read-only `SELECT Id FROM Lead LIMIT 5` cross-check successfully. CLI output redacted the access token.
- Salesforce CLI remains a development diagnostic/authentication cross-check only. Production uses direct `@salesforce/core` JWT/OAuth and does not spawn `sf`.

## Local configuration policy

- Real values belong in `.env.local`, `.env.test.local`, or the current shell only.
- `.env.local`, `.env.*.local`, `*.key`, `*.pem`, `secrets/`, and `.firecrawl/` are ignored.
- `.env.example` contains names and empty/default examples only.
- No Salesforce access token, refresh token, JWT private key, or connected-app secret is committed.
- MySQL passwords, Admin password hash/session secret, and MCP client bearer also remain only in ignored local configuration or process memory and are omitted from evidence.

## P5 local Control Plane environment

| Evidence | Result |
| --- | --- |
| `sfoa_enterprise_mcp` existence | PASS |
| `sfoa_enterprise_mcp_test` existence | PASS |
| `001_p5_control_plane` | APPLIED; repository checksum matched |
| `002_p5_indexes` | APPLIED; repository checksum matched |
| Required seven-table schema/index validation | PASS |
| Non-force/idempotent bootstrap | PASS |
| Real MySQL integration | PASS, 5/5, zero skipped |
| Real MCP/MySQL runtime | PASS, including outage fail-closed |
| Real Browser/Admin API/MySQL E2E | PASS, Chromium 1/1 |

The configured Diagnostic Salesforce username matches one of the two enabled USER routes case-insensitively. It is therefore not an independent DIAGNOSTIC identity and is correctly rejected by bootstrap/request snapshot validation. A real `validate:p4` attempt exited 1 at this preflight before JWT/Salesforce execution. P4 live DIAGNOSTIC remains `NOT TESTED`; this environment fact forces the overall P5 result to remain `PARTIAL`.

## Existing SFoA authorization probe

The direct v2 CLI resolved an existing local SFoA sandbox alias and its SFoA My Domain. `sf org display` reported the authorization as disconnected because both the access/refresh session and refresh token are expired. A read-only `Account` SOQL probe therefore failed during token refresh, before Salesforce executed the query. The repository intentionally records neither the discovered username nor connected-app identifier.

This proves that local CLI configuration can resolve an SFoA endpoint, but it is not a successful JWT, API, or data compatibility Gate. Fresh JWT inputs remain required.

## Environment status

`P0-00 Environment Bootstrap = PARTIAL PASS`

The TypeScript development runtime and live SFoA compatibility path are ready. CLI v2 and plugin hygiene are resolved for new terminals; only the already-open process retains the former PATH snapshot. The additional Closure frozen-install linking failure remains reproducible, while all directly changed workspaces and both protocol transports pass their targeted Gates. `P0-00 Environment Bootstrap` remains `PARTIAL PASS` only for this non-runtime PATH snapshot/Yarn installation debt; the P0 live compatibility result is `PASS`.

## P0-Closure live runtime evidence

The direct Harness completed Fresh JWT, identity match, Direct SOQL, official `run_soql_query`, and official `retrieve_metadata` for one real CustomObject using the local `.env.local`. It returned 5 rows for the configured test object and retrieved 135 metadata files. No token, identity identifier, or record contents were persisted. The official metadata Tool did not restore CWD; the Harness restored it and reported the side effect.

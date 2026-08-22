# SFoA Enterprise MCP Environment Baseline

Baseline captured: 2026-08-21/22 (Asia/Shanghai)

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
| Salesforce CLI (`sf` on PATH) | `@salesforce/cli/1.86.7-legacy.0`, embedded Node 18.15.0 | `D:\sfdx\bin\sf.cmd` | PARTIAL | Starts, but reports a stale missing `@salesforce/sfdx-scanner` user-plugin entry. |
| Salesforce CLI (usable v2 installation) | `@salesforce/cli/2.148.3`, embedded Node 24.18.0 | `C:\Users\61979\AppData\Local\sf\client\2.148.3-ddda74a\bin\sf.cmd` | PARTIAL | Direct invocation works. It reads the same stale plugin manifest and is not the first `sf` on PATH. |

Additional executable locations observed:

- Git: `D:\Git\bin\git.exe` and the Codex bundled Git runtime.
- npm: `D:\software\npm` and `D:\software\npm.cmd`.
- Yarn: `D:\software\yarn` and `D:\software\yarn.CMD`.
- Salesforce CLI legacy: `D:\sfdx\bin\sf` and `D:\sfdx\bin\sf.cmd`.
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

The project-local `yarn install` completed successfully in 1499.30 seconds and left `yarn.lock` unchanged. The installed MCP SDK resolved to 1.18.2 for both the packaged server and POC.

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
SALESFORCE_CLI = PARTIAL
```

## Salesforce CLI remediation record

- The existing legacy CLI was not deleted.
- The CLI's own update index reported stable builds newer than the PATH-selected legacy CLI.
- A user-level official npm installation of `@salesforce/cli@2.148.3` was attempted because npm `latest` resolved to 2.148.3 and the global prefix was user-owned.
- The attempt failed with `ECONNRESET`; npm also reported non-fatal cleanup `EPERM` warnings. It did not replace the PATH-selected CLI. A later audit found an unversioned, shimless partial package directory created by this attempt; `npm uninstall --global @salesforce/cli` removed that exact residue and both pre-existing CLI installations were reverified.
- winget was not used: the search result contained an old `Salesforce.sfdx-cli` package and a non-Salesforce wrapper, not the current official `sf` v2 distribution.
- P0 commands that require current CLI semantics use the already present direct v2 command path. Permanent PATH cleanup is deferred for user review; no administrator bypass was attempted.

## Local configuration policy

- Real values belong in `.env.local`, `.env.test.local`, or the current shell only.
- `.env.local`, `.env.*.local`, `*.key`, `*.pem`, `secrets/`, and `.firecrawl/` are ignored.
- `.env.example` contains names and empty/default examples only.
- No Salesforce access token, refresh token, JWT private key, or connected-app secret is committed.

## Existing SFoA authorization probe

The direct v2 CLI resolved an existing local SFoA sandbox alias and its SFoA My Domain. `sf org display` reported the authorization as disconnected because both the access/refresh session and refresh token are expired. A read-only `Account` SOQL probe therefore failed during token refresh, before Salesforce executed the query. The repository intentionally records neither the discovered username nor connected-app identifier.

This proves that local CLI configuration can resolve an SFoA endpoint, but it is not a successful JWT, API, or data compatibility Gate. Fresh JWT inputs remain required.

## Environment status

`P0-00 Environment Bootstrap = PARTIAL PASS`

The TypeScript development runtime is ready. The only environment qualification is Salesforce CLI path/plugin hygiene; a direct current v2 installation is usable, while the default PATH still selects a legacy installation.

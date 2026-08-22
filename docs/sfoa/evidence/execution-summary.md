# P0 Execution Evidence Summary

Captured on 2026-08-22, Asia/Shanghai. Salesforce identifiers and tokens are intentionally redacted/omitted.

## Environment

| Command | Exit | Sanitized result |
| --- | ---: | --- |
| `git --version` | 0 | `git version 2.50.0.windows.2` |
| `node --version` | 0 | `v24.13.0` |
| `npm --version` | 0 | `11.6.2` |
| `yarn --version` | 0 | `1.22.22` |
| `node -e "console.log(process.version)"` | 0 | `v24.13.0` |
| PATH `sf --version` | 0 | legacy `@salesforce/cli/1.86.7-legacy.0`; stale user-plugin warning |
| direct v2 `sf --version` | 0 | `@salesforce/cli/2.148.3`; stale user-plugin warning |
| direct v2 `sf plugins` | 0 | no installed plugins; stale manifest references missing scanner 3.13.0 |

## Install / build / test / lint

| Command | Exit | Duration / result |
| --- | ---: | --- |
| `yarn install --network-timeout 600000` | 0 | 1499.30 s; lockfile unchanged |
| PowerShell/cmd `yarn build` | 1 | official code-analyzer build script calls POSIX `cp`, not on default PATH |
| Git Bash `yarn build` after POC type fix | 0 | 44.24 s; all official workspaces plus POC compiled |
| first Git Bash `yarn test` | 1 | all official tests passed; POC exposed premature transport cleanup |
| `yarn workspace @sfoa/streamable-http-poc test` after fix | 0 | 1/1 integration test passed |
| final Git Bash `yarn test` | 0 | 263.41 s; all workspace tests passed on the final worktree |
| root `yarn lint` after build | 1 | generated `dist/*.d.ts` included by broad example/code-analyzer glob |
| root `yarn lint` after generated example `dist` cleanup | 1 | code-analyzer has 47 existing source/test/generated lint errors (`no-explicit-any`, unused symbols) |
| `yarn workspace @salesforce/mcp lint` | 0 | PASS |
| `yarn workspace @salesforce/mcp-provider-dx-core lint` | 0 | PASS |
| `yarn workspace @sfoa/streamable-http-poc lint` | 0 | strict no-emit compile PASS |

Preliminary clean-install attempts also found a transient `esbuild` spawn `EPERM` and an Upstream Windows `clean-all` failure on the literal `*.tgz` path. Direct execution later proved the esbuild binary usable. The failed global CLI install left an unversioned, shimless npm directory; npm's own uninstall removed that exact residue and preserved both pre-existing CLI installations. No official source was changed to mask these results.

## Original stdio MCP / Inspector

Project-local `@modelcontextprotocol/inspector` was used; nothing was installed globally. The startup timeout was set to 180 seconds because registry/provider initialization takes roughly 50–60 seconds on this machine.

| Operation | Exit | Result |
| --- | ---: | --- |
| Inspector connect + `tools/list`, toolsets `core,data,metadata` | 0 | initialize PASS; 5 Tool schemas returned; 63.27 s |
| `tools/call get_username` | 0 | MCP result `isError=false`; 53.97 s |
| `tools/call run_soql_query` | 0 at Inspector process | MCP result `isError=true`; expired local refresh authorization; 56.19 s |

The complete 5-Tool contract is stored in `dx-mcp-tools-list.json`.

## Streamable HTTP POC

The SDK Client integration test executed initialize, initialized notification, `tools/list`, `tools/call get_username`, unsupported-GET handling, and untrusted-Origin rejection against a loopback stateless Streamable HTTP server. Its final run returned 1 pass, 0 failures; selected Tools came from the public official dx-core Provider.

## Salesforce CLI / SFoA

| Operation | Exit | Result |
| --- | ---: | --- |
| direct v2 `sf org display --target-org <local-alias> --json` | 1 | Alias and SFoA endpoint resolved; connected status reports expired access/refresh authorization |
| direct v2 `sf data query ... Account LIMIT 5 --json` | 1 | Failed during refresh-token authentication before query execution |
| `sf org login jwt` | Not run | Required instance URL, username, client ID, and private-key path absent |

No record data, authorization JSON, username, org ID, connected-app ID, access token, refresh token, or private-key material is stored in this repository.

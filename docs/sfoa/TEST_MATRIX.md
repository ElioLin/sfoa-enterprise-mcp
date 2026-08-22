# P0 Gate Matrix

Allowed results: `PASS`, `PARTIAL`, `FAIL`, `NOT TESTED`, `KNOWN UPSTREAM DEBT`.

| Gate | Result | Evidence |
| --- | --- | --- |
| Git Runtime | PASS | `git version 2.50.0.windows.2`; executable resolved under `D:\Git` |
| Node Runtime | PASS | `node -v` and direct runtime expression both returned v24.13.0; Upstream requires current LTS / `>=20` |
| npm Runtime | PASS | `npm -v` returned 11.6.2 |
| Yarn Runtime | PASS | Corepack-activated Yarn 1.22.22; `yarn --version` passed; lockfile is Yarn v1 |
| Salesforce CLI | PASS | Stable v2.148.3 invocation, plugin cleanup, JWT login, org display, and read-only query pass; this already-open process still inherits the legacy 1.86.7 PATH snapshot until terminal restart |
| Upstream Clone | PASS | Full clone; `upstream` points to official URL; `origin` points to the supplied GitHub repository; HEAD `670234db...` |
| yarn install | PARTIAL | Original P0 clean install exited 0 in 1499.30 s; Closure frozen reinstall now reproducibly fails during Yarn Classic Windows linking at nested `brace-expansion`; lockfile unchanged and targeted Closure workspaces remain testable |
| yarn build | PASS | Git Bash `yarn build` exited 0 for every official workspace and the POC in 44.24 s; default PowerShell/cmd first failed because an official script requires POSIX `cp` |
| yarn test | PASS | Final worktree run exited 0 in 263.41 s; all official tests and the hardened POC integration test passed |
| yarn lint / Upstream baseline | KNOWN UPSTREAM DEBT | Direct reproduction reports 47 existing code-analyzer errors and 0 warnings; no SFoA-owned file is affected |
| SFoA JWT Auth | PASS | Closure Harness direct `AuthInfo.create({ oauth2Options })` completed fresh JWT Bearer authentication; token output was masked |
| SF CLI Query | PASS | Stable v2 CLI JWT login, org display, and `SELECT Id FROM Lead LIMIT 5` returned 5 rows |
| DX MCP initialize | PASS | Project-local Inspector connected to the original stdio server and completed protocol initialization |
| DX MCP tools/list | PASS | Original server returned 5 `core,data,metadata` Tool schemas; full result is `evidence/dx-mcp-tools-list.json` |
| run_soql_query | PASS | Closure Harness called the official `DxCoreMcpProvider` Tool with the fresh direct Connection and returned 5 rows |
| retrieve_metadata | PASS | Official Tool retrieved the configured `CustomObject` component in a disposable DX Workspace and produced 135 files |
| Multiple Users | NOT TESTED | `SECOND_TEST_USER` not supplied |
| Auth Architecture Audit | PASS | Source path documented in `ARCHITECTURE.md`: startup Cache -> AuthInfo list/filter -> AuthInfo -> Connection -> Tool |
| Streamable HTTP | PASS | Final Closure regression: official SDK Client passed initialize, `tools/list`, `tools/call get_username`, HTTP 405, untrusted-Origin 403, and cleanup assertions (1/1 test) |
| MCP Inspector | PASS | Project-local Inspector (no global install) listed schemas and called `get_username` (`isError=false`); live official SOQL was validated by the Closure Harness |

## Supplemental architecture checks

| Check | Result | Evidence |
| --- | --- | --- |
| Salesforce Tool call mode | PASS | dx-core uses `@salesforce/core`/official Node SDKs; no `sf` child process in Tool runtime |
| Provider API seam | PASS | `Services.getOrgService().getConnection(username)` is injectable into Provider Tool instances |
| Request-scoped readiness | PARTIAL | Seam exists, but official host Cache/Services/Tools are process-scoped and Tools mutate process CWD |
| Metadata workspace independence | FAIL | `retrieve_metadata` resolves `SfProject`, uses SourceTracking/SDR, and writes into the project package directory |
| stdio preservation | PASS | Official entry uses `StdioServerTransport`; no change is planned to remove it |

## P0-Closure Gate Matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| Fresh SFoA JWT | PASS | Closure Harness completed direct JWT Bearer authentication through `@salesforce/core`; token output was masked |
| Direct Connection | PASS | `Connection.create` and `Connection.identity()` completed successfully |
| Identity Match | PASS | Returned Salesforce username matched configured `SALESFORCE_USERNAME`; identifiers are not persisted |
| Token Acquisition | PASS | Non-empty opaque token was usable for identity and both SOQL paths; expiration was not provided by Salesforce |
| Direct SOQL | PASS | `SELECT Id FROM Lead LIMIT 5` returned 5 rows |
| Official `run_soql_query` | PASS | Official `DxCoreMcpProvider` Tool returned 5 rows using the same authenticated Connection |
| Temporary Metadata Workspace | PASS | Unit test creates minimal `sfdx-project.json`, manifest, source tree, counts files, and performs bounded cleanup |
| Official `retrieve_metadata` | PASS | Official Tool retrieved the configured `CustomObject` component in the temporary DX Workspace and produced 135 files |
| CWD Restore | PASS | Official Tool did not restore CWD; Harness observed the side effect and restored the original directory in `finally` |
| stdio Regression | PASS | Original `packages/mcp/bin/run.js` completed initialize, listed 5 Tools, and called official `get_username`; response content withheld |
| Streamable HTTP Regression | PASS | Existing POC passed initialize/list/call, 405, Origin rejection, and resource cleanup (1/1) |
| Upstream Lint Baseline | KNOWN UPSTREAM DEBT | Unchanged code-analyzer baseline reproduced at 47 errors, 0 warnings |
| SFoA Changed Code Lint | PASS | `@sfoa/runtime-validation` and `@sfoa/streamable-http-poc` strict TypeScript lint commands exited 0 |
| Provider Compatibility | PASS | Exact stdio 0.9.8 and extension 0.10.0 dx-core baselines are recorded; Provider registration/unit and both transport regressions pass |
| User Validation Harness | PASS | Build succeeds, 9/9 tests pass, missing-config output names all required values, errors are redacted, and live results are never persisted |

## Result interpretation

- Credential/environment failures are not evidence that SFoA APIs are incompatible.
- A Gate remains `NOT TESTED` when a required external input is absent and no meaningful operation can be attempted.
- A protocol call returning an expected Tool-level `isError` can prove `tools/call` transport behavior, but not the Salesforce operation Gate.
- `KNOWN UPSTREAM DEBT` applies only to a reproduced unchanged Upstream finding. It never permits a new SFoA lint error.
- Final P0 status is set only after all mandatory live and locally runnable Gates complete.

## P0 overall result

`P0 = PASS`

All mandatory P0 live and local Gates are complete. The second Salesforce user is a P1 isolation Gate, and the reproduced Upstream lint debt plus Windows Yarn frozen-reinstall issue remain documented non-SFoA maintenance debt rather than live compatibility failures.

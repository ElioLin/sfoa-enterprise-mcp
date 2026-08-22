# P0 Gate Matrix

Allowed results: `PASS`, `PARTIAL`, `FAIL`, `NOT TESTED`.

| Gate | Result | Evidence |
| --- | --- | --- |
| Git Runtime | PASS | `git version 2.50.0.windows.2`; executable resolved under `D:\Git` |
| Node Runtime | PASS | `node -v` and direct runtime expression both returned v24.13.0; Upstream requires current LTS / `>=20` |
| npm Runtime | PASS | `npm -v` returned 11.6.2 |
| Yarn Runtime | PASS | Corepack-activated Yarn 1.22.22; `yarn --version` passed; lockfile is Yarn v1 |
| Salesforce CLI | PARTIAL | PATH resolves legacy 1.86.7 with stale-plugin warning; direct v2.148.3 starts successfully |
| Upstream Clone | PASS | Full clone; `upstream` points to official URL; `origin` points to the supplied GitHub repository; HEAD `670234db...` |
| yarn install | PASS | Clean `yarn install --network-timeout 600000` exited 0 in 1499.30 s; `yarn.lock` unchanged |
| yarn build | PASS | Git Bash `yarn build` exited 0 for every official workspace and the POC in 44.24 s; default PowerShell/cmd first failed because an official script requires POSIX `cp` |
| yarn test | PASS | Final worktree run exited 0 in 263.41 s; all official tests and the hardened POC integration test passed |
| yarn lint | FAIL | Root run reaches official `mcp-provider-code-analyzer` and reports 47 existing source/test/generated errors; official `mcp`, dx-core, and SFoA POC lint individually pass |
| SFoA JWT Auth | NOT TESTED | Required JWT inputs absent; discovered refresh-token authorization is expired |
| SF CLI Query | FAIL | Direct v2 CLI reached the configured SFoA alias but `SELECT Id, Name FROM Account LIMIT 5` failed before query execution because the stored access/refresh token is expired; fresh JWT authorization is required |
| DX MCP initialize | PASS | Project-local Inspector connected to the original stdio server and completed protocol initialization |
| DX MCP tools/list | PASS | Original server returned 5 `core,data,metadata` Tool schemas; full result is `evidence/dx-mcp-tools-list.json` |
| run_soql_query | FAIL | Original Tool executed through Inspector and returned `isError=true` because the stored refresh authorization is expired; no SOQL reached Salesforce |
| retrieve_metadata | NOT TESTED | Fresh JWT authorization and a controlled DX workspace/test component are required |
| Multiple Users | NOT TESTED | `SECOND_TEST_USER` not supplied |
| Auth Architecture Audit | PASS | Source path documented in `ARCHITECTURE.md`: startup Cache -> AuthInfo list/filter -> AuthInfo -> Connection -> Tool |
| Streamable HTTP | PASS | Official SDK Client passed initialize, `tools/list`, `tools/call get_username`, HTTP 405, and untrusted-Origin 403 handling over the stateless loopback POC |
| MCP Inspector | PASS | Project-local Inspector (no global install) listed schemas and called `get_username` (`isError=false`) and `run_soql_query` (expected credential error) |

## Supplemental architecture checks

| Check | Result | Evidence |
| --- | --- | --- |
| Salesforce Tool call mode | PASS | dx-core uses `@salesforce/core`/official Node SDKs; no `sf` child process in Tool runtime |
| Provider API seam | PASS | `Services.getOrgService().getConnection(username)` is injectable into Provider Tool instances |
| Request-scoped readiness | PARTIAL | Seam exists, but official host Cache/Services/Tools are process-scoped and Tools mutate process CWD |
| Metadata workspace independence | FAIL | `retrieve_metadata` resolves `SfProject`, uses SourceTracking/SDR, and writes into the project package directory |
| stdio preservation | PASS | Official entry uses `StdioServerTransport`; no change is planned to remove it |

## Result interpretation

- Credential/environment failures are not evidence that SFoA APIs are incompatible.
- A Gate remains `NOT TESTED` when a required external input is absent and no meaningful operation can be attempted.
- A protocol call returning an expected Tool-level `isError` can prove `tools/call` transport behavior, but not the Salesforce operation Gate.
- Final P0 status is set only after all locally runnable Gates and documentation checks complete.

## P0 overall result

`P0 = PARTIAL PASS`

All independent architecture, build, unit/integration, stdio, Inspector, and Streamable HTTP work is complete. The result is partial because Upstream root lint fails and fresh SFoA JWT, live metadata, and two-user inputs were not available; both CLI and original MCP SOQL probes fail on the expired local authorization.

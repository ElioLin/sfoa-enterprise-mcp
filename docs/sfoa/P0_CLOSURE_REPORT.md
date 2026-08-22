# P0-Closure Report — SFoA Live Runtime Gates

Report date: 2026-08-22 (Asia/Shanghai)

Branch: `feature/p0-closure`

Audited Upstream commit: `670234dbdca4d3fcdebd9d58b231e311fd34aeec`

## Executive Summary

P0-Closure adds and verifies every locally executable part of the live runtime acceptance path without modifying an official Salesforce TypeScript implementation. The new private Harness performs fresh JWT authentication directly with `@salesforce/core`, verifies identity and token usability, executes Direct SOQL, registers and calls the official dx-core Tools over MCP, creates a disposable writable DX project for official metadata retrieval, and restores CWD at its boundary.

The live SFoA variables are not present in `.env.local` or the current process. Consequently, Fresh JWT, Connection/Identity, Direct SOQL, official `run_soql_query`, official `retrieve_metadata`, and live CWD evidence are `NOT TESTED`. No prior CLI authorization or offline test is substituted. The evidence-supported final result therefore remains:

```text
P0 = PARTIAL PASS
```

## Inputs

| Input | State |
| --- | --- |
| `SFOA_INSTANCE_URL` | NOT PROVIDED |
| `SALESFORCE_USERNAME` | NOT PROVIDED |
| `CONNECTED_APP_CLIENT_ID` | NOT PROVIDED |
| `JWT_PRIVATE_KEY_PATH` | NOT PROVIDED |
| `SALESFORCE_ALIAS` | NOT PROVIDED |
| `TEST_OBJECT` | NOT PROVIDED |
| `TEST_METADATA_TYPE` | NOT PROVIDED |
| `TEST_METADATA_FULL_NAME` | NOT PROVIDED |

The Harness missing-input path lists all eight names together, returns exit code 2, and prints `P0 Closure Runtime Result: NOT TESTED`. It never prints or persists values that are not explicitly requested for the local console.

## Credential Validation Harness

Workspace: `@sfoa/runtime-validation`

User command:

```powershell
yarn workspace @sfoa/runtime-validation validate
```

Verified behavior:

- strict TypeScript build: PASS;
- tests: 9/9 PASS;
- changed-code lint: PASS;
- complete missing-variable diagnostics: PASS;
- direct use of `AuthInfo`/`Connection`, with no `sf` subprocess or CLI Auth Cache: implemented;
- official `DxCoreMcpProvider` Tool registration over an MCP in-memory client/server pair: PASS;
- error/token/private-key redaction tests: PASS;
- result persistence: none.

`SFOA_DEBUG_EXPOSE_TOKEN=false` is the default and masks token output. When the operator explicitly sets it to `true`, the complete access token is printed only to the current console. The Harness contains no evidence/results writer; full tokens must never be redirected or copied into Git, Markdown, JSON, logs, Issues, or chat.

## Fresh JWT Result

```text
SFOA_FRESH_JWT_AUTH = NOT TESTED
```

The implemented path is:

```text
SFOA_INSTANCE_URL + username + client id + private key
  -> AuthInfo.create({ oauth2Options })
  -> Connection.create({ authInfo })
```

It does not hard-code `login.salesforce.com`, save an auth record, or read the local CLI Auth Cache. Live execution is blocked only by absent inputs.

## Salesforce Identity Result

```text
DIRECT_SALESFORCE_CONNECTION = NOT TESTED
IDENTITY_MATCH = NOT TESTED
```

The Harness calls `Connection.identity()` and requires the returned username to match `SALESFORCE_USERNAME` case-insensitively. It is prepared to display User Id, Username, Org Id, and Instance URL in the local console; none were acquired or written to this report.

## Access Token Result

```text
TOKEN_ACQUISITION = NOT TESTED
```

For an opaque Salesforce access token, usability is proven by `Connection.identity()` and the query Gates; Salesforce's JWT assertion is not confused with an opaque returned access token. For JWT-shaped access tokens, only safe header/payload-derived metadata is inspected. Reports may contain Token Type, Expiration, Issuer, Audience, Subject, and Scope, but never the token itself.

## Direct Connection Result

The direct production-compatible path is implemented without Salesforce CLI:

```text
Node.js -> JWT/OAuth -> @salesforce/core -> AuthInfo / Connection
```

Runtime result: `NOT TESTED` because no Fresh JWT input is available.

## Direct SOQL Result

The Harness constructs only the bounded query:

```sql
SELECT Id
FROM <TEST_OBJECT>
LIMIT 5
```

It validates `TEST_OBJECT` as an API identifier, reports only object name, row count, and duration, and never writes Salesforce record content. Runtime result: `DIRECT_SOQL = NOT TESTED`.

## Official MCP SOQL Result

The Harness instantiates the official `DxCoreMcpProvider`, registers the returned official `run_soql_query` Tool in an MCP server, and invokes it through an SDK `Client`. It injects the same already-authenticated Connection through the public Provider `Services`/`OrgService` seam. No replacement query Tool exists.

```text
OFFICIAL_RUN_SOQL_QUERY = NOT TESTED
```

Official registration compatibility passes offline; the SFoA call requires the missing live inputs. The Harness reports Direct PASS/Official FAIL as a Provider/host integration problem and both FAIL as an authentication/connectivity/permission problem.

## Metadata Result

```text
OFFICIAL_RETRIEVE_METADATA = NOT TESTED
```

Official `retrieve_metadata` is registered successfully, but no live component target is configured. The P0 PASS minimum remains one successful real `CustomObject` retrieval. ValidationRule, Flow, ApexClass/ApexTrigger, Layout, and FlexiPage are optional additional evidence and remain `NOT TESTED`.

## Metadata Workspace Result

`TEMPORARY_METADATA_WORKSPACE = PASS` for the offline lifecycle test. The Harness creates a minimal project under the operating-system temporary directory with:

- `sfdx-project.json`;
- `force-app/main/default`;
- a generated `package.xml` containing exactly the configured type/full name;
- boundary-checked recursive cleanup limited to a direct OS-temp child with the Harness prefix.

This proves the validation fixture, not live Metadata API compatibility and not a production Workspace Manager.

The official Tool changes `process.cwd()` and does not restore it at the audited commit. The Harness captures `before`, observes the immediate post-Tool value, and restores `before` in `finally`. `CWD Restore = NOT TESTED` until an actual official live Metadata call runs. This global-state behavior remains a P1/P4 concurrency risk.

## Salesforce CLI Decision

Salesforce CLI is a development diagnostic and independent connectivity/auth cross-check only. It is not a production dependency.

The persistent user PATH now starts with `C:\Users\61979\AppData\Local\sf\client\bin`; the stable shim reports `@salesforce/cli/2.148.3` and `sf plugins` reports no installed/stale plugin. The active Codex process still resolves the inherited legacy 1.86.7 path. Open a new terminal and verify with:

```powershell
where.exe sf
sf --version
sf plugins
```

No administrator bypass or legacy installation deletion was performed.

## Database Decision

P0 and P0-Closure use no database. No database server, ORM, schema, Redis, or persistence package was introduced.

P1 begins with an `IdentityRepository` interface. A memory/local test mapping may validate `platformUserId -> Salesforce username` without blocking the request-scoped runtime POC. Persistence is introduced only when durable routing management or Admin configuration actually requires it.

## Provider Compatibility Matrix

The authoritative exact matrix is `PROVIDER_COMPATIBILITY.md`. The important split is:

| Runtime path | dx-core | Provider API | Salesforce Core | MCP SDK | Status |
| --- | --- | --- | --- | --- | --- |
| Packaged official stdio host | 0.9.8 | 0.6.0 | 8.29.0 | 1.18.2 | PASS |
| SFoA HTTP POC / Closure Harness | 0.10.0 | 0.6.0 | 8.29.0 | 1.18.2 | PASS for registration/transports; live SFoA Gates pending |

Production must pin a verified set and must not rely on accidental Yarn workspace/transitive resolution. P0-Closure performs no dependency upgrade.

## Lint Baseline Decision

```text
UPSTREAM_LINT_BASELINE = KNOWN UPSTREAM DEBT
SFOA_CHANGED_CODE_LINT = PASS
```

The unchanged official code-analyzer workspace reproduces 47 errors and 0 warnings. The Closure Harness and Streamable HTTP POC strict TypeScript lint commands both exit 0. Existing Upstream debt is not hidden and is not a release blocker unless an SFoA change adds or changes an error.

## Dependency Install Qualification

The original P0 clean install remains successful evidence. During Closure, frozen Yarn Classic reinstalls repeatedly failed on Windows while linking a nested `brace-expansion` directory under `mcp-provider-api`; `yarn.lock` remained unchanged. Targeted Harness and POC build/test/lint plus both transport regressions pass. This is tracked as environment/installation debt and is not misclassified as an SFoA protocol failure.

## stdio Regression

```text
STDIO_INITIALIZE = PASS
STDIO_TOOLS_LIST = PASS (5 Tools)
STDIO_TOOLS_CALL = PASS (official get_username; content withheld)
STDIO_REGRESSION = PASS
```

The regression launches the unchanged original `packages/mcp/bin/run.js` with `core,data,metadata` and no telemetry.

## Streamable HTTP Regression

```text
STREAMABLE_HTTP_REGRESSION = PASS
```

The existing POC passes initialize, `tools/list`, official `get_username` `tools/call`, HTTP 405, untrusted-Origin 403, and request resource cleanup. Result: 1/1 test PASS.

## P0 Final Gate

| Mandatory Closure Gate | Result |
| --- | --- |
| Fresh JWT | NOT TESTED |
| Direct Connection | NOT TESTED |
| Identity Match | NOT TESTED |
| Direct SOQL | NOT TESTED |
| Official `run_soql_query` | NOT TESTED |
| Official `retrieve_metadata` for one real CustomObject | NOT TESTED |
| stdio Regression | PASS |
| Streamable HTTP Regression | PASS |
| SFoA Changed Code Lint | PASS |
| Credential Validation Harness | PASS |

Final evidence-supported status:

```text
P0 = PARTIAL PASS
```

P0 may be upgraded to PASS only after the same Harness performs the mandatory live Gates successfully. No second user is required for P0 closure.

## P1 Entry Recommendation

**Do not enter P1 yet.** First configure `.env.local`, run the command in `P0_CLOSURE_USER_TEST.md`, review only non-sensitive console evidence, and update this report/matrix/baseline from actual results. Once all mandatory live Gates pass and the maintainer approves P0, P1 may begin with request-scoped identity routing and second-user isolation. P0-Closure has not implemented `platformUserId` routing.

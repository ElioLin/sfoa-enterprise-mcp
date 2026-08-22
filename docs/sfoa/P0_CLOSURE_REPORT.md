# P0-Closure Report — SFoA Live Runtime Gates

Report date: 2026-08-22 (Asia/Shanghai)

Branch: `feature/p0-closure`

Audited Upstream commit: `670234dbdca4d3fcdebd9d58b231e311fd34aeec`

## Executive Summary

P0-Closure adds and verifies the live runtime acceptance path without modifying an official Salesforce TypeScript implementation. The private Harness performed fresh JWT authentication directly with `@salesforce/core`, verified identity and token usability, executed Direct SOQL, registered and called the official dx-core Tools over MCP, created a disposable writable DX project for official metadata retrieval, and restored CWD at its boundary.

All mandatory live Gates completed successfully. The run used only local `.env.local` configuration; no values, tokens, record contents, or identity IDs were written to Git evidence. The evidence-supported final result is:

```text
P0 = PASS
```

## Inputs

| Input | State |
| --- | --- |
| `SFOA_INSTANCE_URL` | PROVIDED LOCALLY; value not persisted |
| `SALESFORCE_USERNAME` | PROVIDED LOCALLY; value not persisted |
| `CONNECTED_APP_CLIENT_ID` | PROVIDED LOCALLY; value not persisted |
| `JWT_PRIVATE_KEY_PATH` | PROVIDED LOCALLY; file readable; path not persisted |
| `SALESFORCE_ALIAS` | PROVIDED LOCALLY; value not persisted |
| `TEST_OBJECT` | PROVIDED LOCALLY; value not persisted |
| `TEST_METADATA_TYPE` | PROVIDED LOCALLY; value not persisted |
| `TEST_METADATA_FULL_NAME` | PROVIDED LOCALLY; value not persisted |

The Harness missing-input path remains covered by unit tests. The live run loaded all eight required values successfully and did not persist them.

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
- direct use of `AuthInfo`/`Connection`, with no `sf` subprocess or CLI Auth Cache: PASS;
- official `DxCoreMcpProvider` Tool registration over an MCP in-memory client/server pair: PASS;
- error/token/private-key redaction tests: PASS;
- result persistence: none.

`SFOA_DEBUG_EXPOSE_TOKEN=false` is the default and masks token output. When the operator explicitly sets it to `true`, the complete access token is printed only to the current console. The Harness contains no evidence/results writer; full tokens must never be redirected or copied into Git, Markdown, JSON, logs, Issues, or chat.

## Fresh JWT Result

```text
SFOA_FRESH_JWT_AUTH = PASS
```

The implemented path is:

```text
SFOA_INSTANCE_URL + username + client id + private key
  -> AuthInfo.create({ oauth2Options })
  -> Connection.create({ authInfo })
```

The live call completed in approximately 796 ms. It did not hard-code `login.salesforce.com`, save an auth record, or read the local CLI Auth Cache.

## Salesforce Identity Result

```text
DIRECT_SALESFORCE_CONNECTION = PASS
IDENTITY_MATCH = PASS
```

The Harness called `Connection.identity()` and the returned Salesforce username matched `SALESFORCE_USERNAME`. User Id, Org Id, and endpoint were verified in the local console but are intentionally not written to this report.

## Access Token Result

```text
TOKEN_ACQUISITION = PASS
```

The returned token was opaque, non-empty, and usable for identity and both SOQL paths. Salesforce did not provide an expiration value in this response, so expiration is recorded as not provided rather than invented. The agent run forced masked console output. Reports may contain Token Type, Expiration, Issuer, Audience, Subject, and Scope, but never the token itself.

## Direct Connection Result

The direct production-compatible path is implemented without Salesforce CLI:

```text
Node.js -> JWT/OAuth -> @salesforce/core -> AuthInfo / Connection
```

Runtime result: `PASS`; `Connection.identity()` completed successfully.

## Direct SOQL Result

The Harness constructs only the bounded query:

```sql
SELECT Id
FROM <TEST_OBJECT>
LIMIT 5
```

It validated `TEST_OBJECT` as an API identifier and executed against `Lead`: 5 rows in approximately 237 ms. It reported only object name, row count, and duration and never wrote Salesforce record content. Runtime result: `DIRECT_SOQL = PASS`.

## Official MCP SOQL Result

The Harness instantiates the official `DxCoreMcpProvider`, registers the returned official `run_soql_query` Tool in an MCP server, and invokes it through an SDK `Client`. It injects the same already-authenticated Connection through the public Provider `Services`/`OrgService` seam. No replacement query Tool exists.

```text
OFFICIAL_RUN_SOQL_QUERY = PASS
```

The official `DxCoreMcpProvider` returned 5 rows in approximately 213 ms. Direct and official paths agree, proving the same authenticated Connection reaches SFoA through the official Tool.

## Metadata Result

```text
OFFICIAL_RETRIEVE_METADATA = PASS
```

Official `retrieve_metadata` retrieved the configured real `CustomObject` component (`Lead`) successfully and generated 135 files in approximately 7.6 seconds. ValidationRule, Flow, ApexClass/ApexTrigger, Layout, and FlexiPage were not required for the P0 core Gate and remain `NOT TESTED`.

## Metadata Workspace Result

`TEMPORARY_METADATA_WORKSPACE = PASS` for both lifecycle and live retrieval. The Harness creates a minimal project under the operating-system temporary directory with:

- `sfdx-project.json`;
- `force-app/main/default`;
- a generated `package.xml` containing exactly the configured type/full name;
- boundary-checked recursive cleanup limited to a direct OS-temp child with the Harness prefix.

The live retrieval proves official Metadata compatibility for the tested component; this remains a validation fixture, not a production Workspace Manager.

The official Tool changed `process.cwd()` and did not restore it at the audited commit. The Harness observed the side effect and restored the original directory in `finally`: `CWD_RESTORE = PASS`, `officialToolRestored = false`, `harnessRestored = true`. This global-state behavior remains a P1/P4 concurrency risk.

## Salesforce CLI Decision

Salesforce CLI is a development diagnostic and independent connectivity/auth cross-check only. It is not a production dependency.

The persistent user PATH now starts with the stable v2 shim; direct v2.148.3 invocation reported no installed/stale plugin. The active Codex process still resolves the inherited legacy 1.86.7 path. The independent v2 CLI JWT login and read-only Lead query both passed. Open a new terminal and verify with:

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
| SFoA HTTP POC / Closure Harness | 0.10.0 | 0.6.0 | 8.29.0 | 1.18.2 | PASS including live SFoA JWT/SOQL/Metadata |

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
| Fresh JWT | PASS |
| Direct Connection | PASS |
| Identity Match | PASS |
| Direct SOQL | PASS |
| Official `run_soql_query` | PASS |
| Official `retrieve_metadata` for one real CustomObject | PASS |
| stdio Regression | PASS |
| Streamable HTTP Regression | PASS |
| SFoA Changed Code Lint | PASS |
| Credential Validation Harness | PASS |

Final evidence-supported status:

```text
P0 = PASS
```

All mandatory live Gates passed. No second user is required for P0 closure; second-user request isolation remains a P1 Gate.

## P1 Entry Recommendation

**P1 is now eligible for maintainer review, but has not started.** P0-Closure has not implemented `platformUserId` routing. After review, P1 may begin with request-scoped identity routing and second-user isolation.

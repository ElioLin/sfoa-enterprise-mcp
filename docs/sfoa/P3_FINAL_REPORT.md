# P3 Final Report — Minimal Generic DML & Object Allowlist

- Date: 2026-08-22
- Branch: `feature/p3-generic-dml-allowlist`
- Entry baseline: `P3-BL-1.0`
- Closure baseline: `P3-BL-1.1`
- Decision: `P3 = PASS / COMPLETE — AWAITING MAINTAINER REVIEW`
- P4 status: NOT STARTED

## Executive Result

P3 adds a thin enterprise mutation gate over the already accepted request-scoped Salesforce Connection. It does not rebuild Salesforce authorization or runtime behavior.

The production surface contains exactly two one-record Tools:

- `create_record`
- `update_record`

Both require explicit registration plus a strict Object-by-Operation allowlist. Missing/empty configuration denies all. DELETE, UNDELETE, UPSERT, MERGE, Bulk DML, arbitrary REST, metadata mutation, and Apex mutation substitutes are absent from Tool schemas and production implementation.

Real SFoA validation passed successful CREATE/UPDATE, A/B identity routing, body-forgery resistance, native required-field failure, native record-authorization denial, zero Connection reuse, and exact-ID cleanup. All P0/P1/P2/root regressions passed. No official Salesforce TypeScript file, root manifest, or lockfile changed.

## Architecture

```text
Agent
 ↓
Authenticated Request
 ↓
Identity Route
 ↓
P3 DML Governance
 ↓
Generic CREATE / UPDATE
 ↓
Request-scoped Connection
 ↓
Salesforce
```

The concrete path is:

```text
Authorization + X-Platform-User-Id
  -> P2 controlled-client authentication
  -> P1 IdentityResolver(platformUserId)
  -> fresh JWT and request-scoped Connection
  -> exact P3 Tool-name registration gate
  -> DmlAllowlistPolicy(Object x CREATE/UPDATE)
  -> connection.sobject(objectApiName).create(fields)
     or connection.sobject(objectApiName).update({ Id: recordId, ...fields })
  -> Salesforce CRUD/FLS/sharing/validation/Flow/Trigger
```

### Components

| Component | Responsibility |
| --- | --- |
| `@sfoa/identity-runtime` | Existing authoritative route, fresh JWT, request Connection, request `OrgService` |
| `@sfoa/mcp-provider-sfoa-dml` | Two generic Tools, strict contracts, policy check, narrow SDK calls, stable safe output/error mapping |
| `DmlToolGovernancePolicy` | Exact P3 Tool visibility; requires a matching configured operation |
| `MCP_DML_ALLOWLIST_JSON` | Startup-loaded, immutable Object-by-Operation rules |
| Salesforce | CRUD, FLS, sharing, required fields, validation rules, lookup filters, Flow, Trigger, native errors |

P2's official Tool classification policy was not broadened. `MUTATION` does not imply permission; official deploy/admin/other mutation Tools remain denied.

## Official Reuse Decision

| Question | Decision | Evidence |
| --- | --- | --- |
| Existing official DX MCP CREATE/UPDATE reusable? | NO | Actual pinned dx-core 0.10.0 exports, 13 supplied Tools, Provider API surface, and history contain no current generic CREATE/UPDATE Provider/Tool. Removed historical create-only source is not a public API and was not copied. |
| Salesforce Hosted SObject Mutation reusable in SFoA runtime? | NO | It is a separate hosted MCP endpoint with External Client App/OAuth/PKCE and cannot consume the current in-process request Connection. Replacing P1/P2 would add a second identity/session path. |
| Salesforce Hosted MCP availability for SFoA? | NOT PROVEN | Official documentation describes a global hosted endpoint; no official source proves Salesforce on Alibaba Cloud support. |
| Public Provider API reusable? | YES | `McpProvider`, `McpTool`, `Services`, and request `OrgService` are the composition seam. |
| Final SDK/API surface | `@salesforce/core@8.29.0` request `Connection`, public JSforce single-record SObject methods | Only `sobject().create()` and `sobject().update()` are called in production. |

Salesforce's Hosted SObject Mutations documentation confirms CREATE/UPDATE without DELETE, but its hosted authentication and endpoint model is different from SFoA's accepted architecture. ADR-0008 records the full decision and official references.

## Tool Surface

The final live Streamable HTTP `tools/list` returned, in order:

```text
create_record
update_record
```

### CREATE

```json
{
  "objectApiName": "Lead",
  "fields": {
    "LastName": "Test",
    "Company": "Example"
  }
}
```

### UPDATE

```json
{
  "objectApiName": "Lead",
  "recordId": "00Q000000000001AAA",
  "fields": {
    "Company": "Updated"
  }
}
```

The Agent schemas do not contain `platformUserId`, username/alias, Salesforce username, instance URL, token, directory, operation, API-version override, REST path, External ID, or relationship path. UPDATE rejects `fields.Id` case-insensitively and keeps `recordId` as the only record identity source. Fields must be a non-empty bounded object of JSON scalar values.

Success returns concise text plus matching structured content:

```json
{
  "success": true,
  "recordId": "00Q000000000001AAA"
}
```

No post-write SOQL/readback occurs.

### Structurally absent

```text
DELETE       = absent
UNDELETE     = absent
UPSERT       = absent
MERGE        = absent
Bulk DML     = absent
arbitrary REST = absent
deploy/admin = unavailable
```

## Object × Operation Governance

Configuration uses one optional shell/ignored-local JSON array:

```json
[
  { "objectApiName": "Lead", "operations": ["CREATE", "UPDATE"] },
  { "objectApiName": "Account", "operations": ["UPDATE"] }
]
```

The array format was selected over a custom grammar and a JSON object map. JSON needs no new parser language, and the array preserves duplicate object detection instead of letting `JSON.parse()` overwrite duplicate keys.

Rules:

- missing, blank, or `[]`: deny all;
- unknown object: `MCP_DML_OBJECT_NOT_ALLOWED`;
- known object but unconfigured pair: `MCP_DML_OPERATION_NOT_ALLOWED`;
- malformed JSON, duplicate object/operation, empty operations, unknown field, DELETE, or unknown operation: startup `MCP_DML_CONFIGURATION_INVALID`;
- enabling `create_record`/`update_record` without at least one matching operation rule: startup failure;
- object matching is case-insensitive to avoid casing bypasses.

There is no database, Redis, RBAC/ABAC framework, policy engine, or Admin UI. `DmlAllowlistPolicy` is the small future persistence seam.

## Identity Boundary

The request Header remains authoritative:

```text
X-Platform-User-Id
  -> IdentityResolver
  -> one Salesforce route
  -> one fresh request Connection
```

The Provider requests the only allowed username from the request `OrgService`; zero or multiple usernames fail closed. Body-supplied platform/username/token/URL values cannot select another route.

Automated HTTP tests passed A CREATE, B CREATE, A UPDATE, and B UPDATE with the correct independent mock Connections. The real org Gate additionally proved:

- User A CREATE: PASS and returned a record ID;
- User A UPDATE: PASS;
- User B CREATE: reached Salesforce through B and preserved native `FIELD_CUSTOM_VALIDATION_EXCEPTION`;
- User B UPDATE against the validator-owned A record: reached Salesforce through B and preserved native `INSUFFICIENT_ACCESS_OR_READONLY`;
- forged A `platformUserId`/username fields: remained A;
- forged B username fields: remained B;
- cross-user Connection reuse: 0.

## Permission Boundary

```text
SFoA controls Object × Operation
Salesforce controls CRUD/FLS/Sharing/Validation/Flow/Trigger
```

SFoA performs no describe-based field preflight, field allowlist, FLS replica, profile/permission-set resolver, layout engine, validation-rule interpreter, Flow interpreter, or Trigger interpreter.

Live evidence shows the boundary was not bypassed:

- successful CREATE and UPDATE under User A;
- native `REQUIRED_FIELD_MISSING` for an invalid CREATE;
- native `FIELD_CUSTOM_VALIDATION_EXCEPTION` under User B;
- native `INSUFFICIENT_ACCESS_OR_READONLY` for User B against User A's validator-owned record.

The Tool retained each safe Salesforce code/message/field list under the stable outer `MCP_SALESFORCE_DML_FAILED` error. It did not reinterpret these failures as an SFoA policy decision.

## Error Contract

Stable outer errors are:

```text
MCP_DML_OBJECT_NOT_ALLOWED
MCP_DML_OPERATION_NOT_ALLOWED
MCP_DML_INPUT_INVALID
MCP_DML_IDENTITY_CONTEXT_INVALID
MCP_SALESFORCE_DML_FAILED
```

Expected Tool failures return `isError: true`, concise text, and matching structured content. Salesforce errors are bounded and preserve safe code/message/field values. Bearer tokens, JWTs, PEM blocks, access/refresh tokens, client secrets, causes, and stacks are not returned. The redaction unit fixture passed.

Schema-invalid MCP arguments remain protocol invalid-parameter failures before Salesforce execution. Direct Provider execution also maps Zod input failures to `MCP_DML_INPUT_INVALID`.

## Live Cleanup

The production Provider contains no delete/destroy call. The independent validator tracks every successful CREATE result as `(platformUserId, objectApiName, recordId)` and cleans only those exact IDs with the official SDK after the Tool/transport checks.

Final live cleanup result:

```text
attempted = 2
deleted   = 2
failures  = 0
```

No cleanup SOQL, prefix search, bulk delete, or MCP DELETE Tool exists.

## Test Matrix

Only `PASS`, `FAIL`, `NOT TESTED`, and `KNOWN UPSTREAM DEBT` are used below.

| Gate | Result | Actual evidence |
| --- | --- | --- |
| P3 Provider tests | PASS | 12/12, 0 failed |
| P3 Host/config/HTTP tests | PASS | 8/8, 0 failed |
| P3 strict build/lint | PASS | Provider and Host `tsc --noEmit` exited 0 |
| Missing/empty/invalid allowlist | PASS | Deny-all or startup failure as specified |
| Object-by-Operation pairs | PASS | Allowed pairs execute; unknown object/unconfigured operation deny before Connection |
| Tool surface | PASS | Live list exactly two; DELETE/UPSERT/REST/deploy/admin absent |
| A/B identity and forgery | PASS | Correct request routes; zero cross-user Connection reuse |
| Live successful CREATE/UPDATE | PASS | User A real Lead CREATE and UPDATE |
| Live Salesforce validation | PASS | `REQUIRED_FIELD_MISSING` and `FIELD_CUSTOM_VALIDATION_EXCEPTION` preserved |
| Live Salesforce authorization | PASS | `INSUFFICIENT_ACCESS_OR_READONLY` preserved under User B |
| Live cleanup | PASS | 2/2 exact recorded IDs, 0 failures |
| Upstream compatibility | PASS | Provider API 0.6.0, dx-core 0.10.0, nine GA Tools, zero drift |
| P2 tests | PASS | 18/18, 0 failed |
| P2 live A/B/load | PASS | 50 requests; mismatch/leak/workspace leak/cleanup failure/reuse/error all 0 |
| P1 tests/live | PASS | 22/22 plus real A/B, 20 requests, metadata/CWD/workspace cleanup |
| P0 tests/live | PASS | 9/9 plus JWT/identity/direct+official SOQL/CustomObject metadata/CWD restoration |
| P0 Streamable HTTP | PASS | 1/1 initialize/list/call and transport/security assertions |
| Original Salesforce stdio | PASS | initialize, five-Tool list, official `get_username` call |
| MCP Inspector | PASS | Project-local 0.15.0 initialize/list/call for A and B |
| Root build | PASS | All workspaces, Git Bash, 82.49 s |
| Root tests | PASS | All workspaces, 356.86 s |
| SFoA changed-code lint | PASS | All SFoA strict TypeScript lint commands exited 0 |
| Repository lint | KNOWN UPSTREAM DEBT | Exact existing official code-analyzer baseline: 47 errors, 0 warnings; no SFoA path |
| Frozen Yarn install | KNOWN UPSTREAM DEBT | Existing Windows/Yarn nested `brace-expansion` link failure; lockfile unchanged; generated shims restored before final passing gates |

The initial root build after the failed frozen install exposed missing generated local command shims. Exactly those ignored `.bin` artifacts were regenerated from installed package manifest `bin` declarations. Source, manifest, and lockfile remained unchanged; original stdio, final root build, and root tests then passed.

## Upstream Diff

```text
Official Salesforce TypeScript changed: 0
Official Tool copied/reimplemented: NO
Root package.json changed: NO
yarn.lock changed: NO
New database dependency: NO
New Redis dependency: NO
```

P3 changes only SFoA-owned provider/host/config/docs paths. The existing root `packages/*` glob discovers the new workspace without a root manifest edit. The production package depends only on the pinned MCP SDK, Provider API, `@salesforce/core`, Zod, and the accepted SFoA identity/provider workspaces.

## Known Risks

1. The controlled-client Bearer does not authenticate the individual human. A future public deployment still needs a trusted gateway that derives and overwrites `X-Platform-User-Id` from authenticated claims.
2. SDK timeout cannot prove Salesforce server-side cancellation. A CREATE/UPDATE may commit after the Host stops waiting; these Tools are correctly annotated non-idempotent, and clients must not blindly retry a timed-out mutation.
3. The JSON allowlist is intentionally manual and local/environment-backed until durable Admin configuration is justified in P5.
4. A future official embeddable mutation Provider or proven Hosted MCP support for Salesforce on Alibaba Cloud requires a fresh ADR-0008 reuse review; it is not adopted automatically.

## P3 Decision

`P3 = PASS / COMPLETE — AWAITING MAINTAINER REVIEW`

P4 is not authorized or started by this report.

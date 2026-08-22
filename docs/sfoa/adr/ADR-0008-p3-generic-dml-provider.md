# ADR-0008: Use the Request-Scoped Salesforce SDK for P3 Generic DML

- Status: Accepted for P3
- Date: 2026-08-22
- Supersedes: none
- Extends: ADR-0003 request-scoped identity routing, ADR-0005 remote Tool governance, and ADR-0007 upstream contract drift guard

## Context

P3 needs a thin enterprise mutation gate for one-record CREATE and UPDATE. It must preserve the authoritative route:

```text
authenticated platformUserId
  -> P1 IdentityResolver
  -> fresh request-scoped Salesforce Connection
  -> Object x Operation allowlist
  -> Salesforce native authorization and automation
```

DELETE, UNDELETE, UPSERT, MERGE, Bulk DML, relationship mutation, arbitrary REST, metadata mutation, and Apex mutation substitutes are outside the phase. Before adding an SFoA Provider, P3-00 audited the pinned DX MCP Provider, Salesforce Hosted SObject Mutations, and the pinned official SDK surface in that order.

## P3-00 official capability audit

### Pinned Salesforce DX MCP Provider

The actual installed/public `@salesforce/mcp-provider-dx-core@0.10.0` package was inspected, not inferred from Tool names:

- Its only top-level exports are `DxCoreMcpProvider`, `directoryParam`, and `usernameOrAliasParam`.
- `DxCoreMcpProvider.provideTools()` returns 13 Tool classes. None is a generic SObject CREATE or UPDATE Tool, and there is no official record-mutation Provider in the pinned repository.
- The public Provider API offers the `McpProvider`, `McpTool`, and request `Services` composition contracts, but no generic DML implementation.
- The repository history contains an older pre-Provider `sf-create-record` Tool, removed by upstream commit `9189053` (`fix: remove sf-create-record tool (#29)`). It accepted a value string, used process/CLI-era identity selection, had no UPDATE operation or P3 allowlist, and is no longer a public capability. Deleted source is not a reusable API and will not be copied.

Decision: existing official DX MCP generic CREATE/UPDATE reusable: **NO**. The public Provider API is reusable as the extension seam.

### Salesforce Hosted `platform/sobject-mutations`

Salesforce's current [SObject Mutations reference](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/references/reference/sobject-mutations.html) documents CREATE and UPDATE with no DELETE, enforced under the authenticated user's object permissions and FLS. It is a fixed Salesforce-hosted MCP endpoint at `https://api.salesforce.com/platform/mcp/v1/...`, and it also exposes read/search/schema capabilities plus relationship-path child-record update.

The hosted-server [setup](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/setup-overview.html) and [External Client App](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/create-external-client-app.html) contracts require a separate MCP client connection, External Client App, `mcp_api`/`refresh_token` scopes, and OAuth 2.0/PKCE named-user authentication. The public documentation describes a remote MCP endpoint, not an embeddable Node Provider/package or an API that accepts SFoA's existing in-process `Connection`.

No official documentation proves Salesforce Hosted MCP availability for Salesforce on Alibaba Cloud. The documented endpoint is a Salesforce global service, while Salesforce's [Salesforce on Alibaba Cloud notice](https://help.salesforce.com/s/articleView?id=005318613&language=en_US&type=1) says Mainland China and Macau customers use Salesforce on Alibaba Cloud rather than Salesforce global services. Availability for SFoA is therefore **NOT PROVEN** and cannot be assumed.

Directly substituting the hosted server would:

- introduce a second authentication/session model that does not consume the P1 request-scoped Connection;
- bypass or require a new mapping around `platformUserId` authoritative routing;
- add a separate remote MCP hop and External Client App lifecycle;
- expose a fixed surface that includes relationship mutation outside P3;
- require a P1/P2 architecture change despite an already verified SDK path.

Decision: Salesforce Hosted SObject Mutation reusable inside the current SFoA runtime: **NO**. Its SFoA availability is **NOT PROVEN**. P3 will not refactor P1/P2 to proxy it.

### Pinned official SDK fallback

The pinned `@salesforce/core@8.29.0` public `Connection` extends the official `@jsforce/jsforce-node` Connection. Its installed public types and the [JSforce SObject API](https://jsforce.github.io/jsforce/classes/sobject.SObject.html) expose single-record:

```text
connection.sobject(objectApiName).create(fields)
connection.sobject(objectApiName).update({ Id: recordId, ...fields })
```

Both return a typed `SaveResult` with `success`, `id`, and structured Salesforce errors. This surface uses the already-authenticated request Connection, supports SFoA through the proven P0/P1 direct API route, and leaves CRUD/FLS/sharing/validation/Flow/Trigger enforcement in Salesforce.

Decision: use only these two single-record SDK methods. P3 production code will not call `Connection.request()`, Tooling DML, multi-record overloads, Bulk APIs, upsert, destroy/delete, CLI commands, CLI Auth Cache, or a new OAuth implementation.

## Tool decision

Create an SFoA-owned Provider package through the public Provider API with two stable Tools:

- `create_record`
- `update_record`

There is no current pinned official Tool-name conflict. Separate Tools make DELETE structurally absent; there is no generic `operation` input.

Each request constructs the Provider from the same request-scoped `Services`. The Provider requires exactly one allowed Salesforce username from that request's `OrgService`, then obtains the existing request Connection through `getConnection()`. No Tool argument can select a username, platform user, instance URL, token, directory, REST path, or API version.

## Allowlist decision

Use one optional local/environment value, `MCP_DML_ALLOWLIST_JSON`, parsed once at startup into an immutable policy. The shape is an array so duplicates remain observable:

```json
[
  { "objectApiName": "Lead", "operations": ["CREATE", "UPDATE"] },
  { "objectApiName": "Account", "operations": ["UPDATE"] }
]
```

The parser is strict and rejects unknown fields, invalid object API names, duplicate objects, duplicate operations, `DELETE`, and every unknown operation. A missing value or `[]` creates a deny-all policy. Object matching is normalized case-insensitively to avoid casing bypasses.

JSON was selected over a custom comma/colon grammar because it needs no new escaping/parser language and is directly Zod-validatable. A JSON object map was rejected because ordinary `JSON.parse()` silently overwrites duplicate keys, defeating the duplicate-failure requirement. No database, Redis, policy framework, or Admin UI is introduced. A small policy interface remains the future P5 replacement seam.

Tool visibility requires both:

1. the exact SFoA Tool name in `MCP_ENABLED_TOOLS`; and
2. at least one configured object allowing that Tool's operation.

Requesting a mutation Tool without a matching configured operation fails startup closed. This is separate from the official Tool classification policy; `MUTATION` never becomes a generally allowed P2 classification, and official deploy/admin/mutation Tools remain denied.

## Error and output decision

Both Tools return concise text plus matching structured content. Success contains only `success: true` and `recordId`. Expected failures use Tool-level `isError: true` and distinguish:

- `MCP_DML_OBJECT_NOT_ALLOWED`
- `MCP_DML_OPERATION_NOT_ALLOWED`
- `MCP_DML_INPUT_INVALID`
- `MCP_SALESFORCE_DML_FAILED`

Safe Salesforce `errorCode`, message, and field names are retained with bounded output. Tokens, JWTs, private keys, raw authorization records, causes, and stacks are never returned.

## Consequences

### Positive

- P3 is a thin Object-by-Operation gate over the proven official Salesforce SDK execution surface.
- P1/P2 identity authority and fresh Connection isolation remain unchanged.
- DELETE, UPSERT, relationship mutation, arbitrary REST, and Bulk DML are absent from both schema and implementation.
- Salesforce remains the only field-permission and business-rule engine.
- Official Salesforce TypeScript remains unchanged and no deleted Tool source is copied.

### Negative

- SFoA owns two small Tool classes and their stable outer error mapping because the pinned Provider has no reusable generic mutation Tool.
- Operators must maintain a strict one-line JSON value in environment/local configuration until P5 provides persistence/UI.
- A future official embeddable mutation Provider or proven SFoA Hosted MCP endpoint requires a new reuse review; it is not adopted automatically.

## Rejected alternatives

1. Restore/copy the deleted `sf-create-record` source: rejected because it is not a current public API, lacks UPDATE and P3 governance, and violates upstream-first composition.
2. Proxy Salesforce Hosted MCP: rejected because its SFoA support is not proven and its OAuth/session/fixed-tool model conflicts with the accepted request-scoped Connection architecture.
3. Use raw `Connection.request()` REST paths: rejected because the typed public SObject methods are narrower and prevent an arbitrary-REST escape.
4. One Tool with an `operation` enum: rejected because DELETE should be structurally absent, not a runtime enum branch.
5. Add field allowlists or preflight describe checks: rejected because Salesforce owns CRUD/FLS/validation and P3 must not duplicate them.
6. Add a database, Redis, RBAC/ABAC, or policy-engine framework: rejected as unnecessary for a strict startup-loaded allowlist.

## Gate

Acceptance requires allowlist/parser, Tool surface, request identity, Salesforce error, live permission, cleanup, protocol, P0/P1/P2 regression, changed-code lint, and upstream-diff evidence. Missing live permission conditions remain `NOT TESTED`; they cannot be simulated into PASS.

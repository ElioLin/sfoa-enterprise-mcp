# Architecture

Read this for system design, architectural review, or project takeover. Revalidate details in `docs/sfoa/ARCHITECTURE.md` and current source.

## System boundary

SFoA Enterprise MCP is an SFoA-owned composition layer over official Salesforce Provider APIs and `@salesforce/*` SDKs. The production HTTP runtime is `@sfoa/mcp-server`; the original official `@salesforce/mcp` stdio host remains for local compatibility.

```text
MCP client
  -> Streamable HTTP authentication
  -> authoritative platformUserId
  -> immutable MySQL policy snapshot
  -> Identity Route
  -> local request scope + lazy Connection provider
  -> first Salesforce-dependent operation: fresh JWT/AuthInfo/Connection
  -> governed official/SFoA Tool facade
  -> Salesforce
```

The LLM performs analysis. The server supplies deterministic operations and evidence. Salesforce remains the business authorization and automation authority.

## Major boundaries

- Identity: Internal bearer + trusted platform Header, USER_BOUND route token, or Buntu token validation all produce an authenticated principal. None permits a Tool argument to select a Salesforce username.
- Tool governance: executable catalog classification and upstream-contract drift checks remain code-owned; MySQL can enable only a known compatible Tool.
- DML governance: `create_record` and `update_record` require both Tool enablement and an enabled object-by-operation policy. No DELETE/UPSERT/Bulk/arbitrary REST Tool exists.
- Managed fields: only `PLATFORM_USER_LOOKUP` and CREATE-only `AI_CREATED_MARKER=true`; host values win over client fields.
- Context: USER `get_record_action_context`; server-owned DIAGNOSTIC `run_diagnostic_tooling_query` and `get_metadata_component_context`.
- Resource lifecycle: route, context, workspace directories, and Services are created per request; Salesforce JWT/Connection is deferred until first use, memoized as one Promise inside that scope, and never cached globally or shared between USER/DIAGNOSTIC requests. Workspace DX configuration receives the live API version only after that Connection exists.
- Connection dependency model: whether a remote (official business) Tool acquires the request-scoped Salesforce Connection is an explicit boolean `requiresSalesforceConnection` on its `RemoteToolContract` / `OfficialToolPolicyRecord`, never inferred from host-owned `usernameOrAlias`. `get_username` declares `false` (zero Connection); `run_soql_query` and `retrieve_metadata` declare `true` (exactly one, lazily at execution). A `p2RemoteCompatible` Tool that omits this boolean fails the upstream-contract drift guard.
- Audit: one request-local context/collector per definite `tools/call`; non-blocking queue and batch writer use a separate two-connection pool. Audit failure cannot change or retry a Tool/Salesforce outcome.
- Admin: separate authenticated Admin API and React Web; browser never receives Salesforce/database/runtime secrets.

## Upstream-first decision order

Reuse an official Tool, then extend the Provider API/composition seam, then use an official SDK, then implement a minimal standard Salesforce API provider. Modify upstream-owned code only with a recorded reason, alternative, and merge risk in `docs/sfoa/UPSTREAM_STRATEGY.md`.

## Known global-state risk

Official Tools call `process.chdir(directory)`. Request workspaces plus the shared/exclusive CWD guard contain that side effect. Do not introduce concurrent official metadata execution outside this boundary without proving isolation and restoration.

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

- Identity: Internal bearer + trusted platform Header, USER_BOUND route token, or Buntu token validation all produce an authenticated principal. None permits a Tool argument to select a Salesforce username. Buntu validation is reused in-process per token until the upstream `data.expiresAt`, which collapses the per-POST `IDENTITY_VALIDATION` audits of one interaction only when the client reuses the same token; a client that issues a fresh token per POST gets one independent validation and audit per POST (correct, not suppressible). validate-token stays authoritative and the identity route is re-read each request.
- Tool governance: executable catalog classification and upstream-contract drift checks remain code-owned; MySQL can enable only a known compatible Tool.
- Org object usage: this org declares a fixed set of Salesforce standard objects unused in favor of custom objects (Quote→Quote__c, QuoteLineItem→Quote_Product__c, Order→Order__c, OrderItem→Order_Product__c, Pricebook2→Pricebook__c, PricebookEntry→Pricebook_Entry__c, Contract→Contract__c). The single source is `@sfoa/agent-playbook` `ORG_OBJECT_SUBSTITUTIONS`, which feeds the playbook ORG_OBJECT_USAGE section and the `run_soql_query` Tool description. At execution the remote facade rejects a USER `run_soql_query` whose top-level object matches an unused standard with `MCP_SOBJECT_NOT_IN_USE` and the replacement custom object, before any Salesforce Connection is obtained and without rewriting the query; tooling queries are untouched. A separate recorded org inventory (`org-object-inventory.ts`) must stay in agreement with the registry or the package refuses to load.
- DML governance: `create_record` and `update_record` require both Tool enablement and an enabled object-by-operation policy. No DELETE/UPSERT/Bulk/arbitrary REST Tool exists.
- Managed fields: strict `PLATFORM_USER_LOOKUP` and CREATE-only `AI_CREATED_MARKER=true` retain server precedence. Opt-in CREATE-only `PLATFORM_USER_LOOKUP_FALLBACK` preserves case-insensitively present explicit keys unchanged and skips default lookup; omission reuses the same resolver. Migration 010 extends ENUM/CHECK; 011 restricts fallback to CREATE-only without rewriting rows or changing 010 checksums. Applicable duplicate client aliases fail before any query; Action Context and Runtime match object names case-insensitively. Playbook 1.5.1 exposes `PLATFORM_IDENTITY_FALLBACK`: required CREATE + absent asks once with current-user default explanation; optional + absent omits; UPDATE never defaults omitted fallback fields; explicit changes follow normal UPDATE + LOOKUP.
- Context: USER `get_record_action_context`; server-owned DIAGNOSTIC `run_diagnostic_tooling_query` and `get_metadata_component_context`.
- Resource lifecycle: route, context, workspace directories, and Services are created per request; Salesforce JWT/Connection is deferred until first use, memoized as one Promise inside that scope, and never cached globally or shared between USER/DIAGNOSTIC requests. Workspace DX configuration receives the live API version only after that Connection exists.
- Connection dependency model: whether a remote (official business) Tool acquires the request-scoped Salesforce Connection is an explicit boolean `requiresSalesforceConnection` on its `RemoteToolContract` / `OfficialToolPolicyRecord`, never inferred from host-owned `usernameOrAlias`. `get_username` declares `false` (zero Connection); `run_soql_query` and `retrieve_metadata` declare `true` (exactly one, lazily at execution). A `p2RemoteCompatible` Tool that omits this boolean fails the upstream-contract drift guard.
- Audit: one request-local context/collector per definite `tools/call`; non-blocking queue and batch writer use a separate two-connection pool. Audit failure cannot change or retry a Tool/Salesforce outcome.
- Admin: separate authenticated Admin API and React Web; browser never receives Salesforce/database/runtime secrets.

## Upstream-first decision order

Reuse an official Tool, then extend the Provider API/composition seam, then use an official SDK, then implement a minimal standard Salesforce API provider. Modify upstream-owned code only with a recorded reason, alternative, and merge risk in `docs/sfoa/UPSTREAM_STRATEGY.md`.

## Known global-state risk

P8-04 future Dynamic Forms CREATE work must read
`docs/sfoa/P8-04-DYNAMIC-FORMS-BASELINE.md` and
`docs/sfoa/P8-04A-01-FEASIBILITY-EVIDENCE.md`. The source is
`feature/managed-platform-user-lookup-fallback` at `f60a134715d639b8129af0f3160549d52dec210d`.
A-01 is COMPLETE — BLOCKED: configuration shapes are available, but activation/New
UI precedence and the mandatory same-RT different-USER golden are unverified.
Read-only reruns: `node scripts/p8-04a-feasibility.mjs` and `--targeted`; outputs are
sanitized dev evidence under `.temp`, never production snapshots. SOAP getUserInfo
works for USER ProfileId where User SOQL fails; `/ui-api/apps?formFactor=Large`
returns effective USER Apps. These facts do not authorize A-02 or ENFORCE.
HOTFIX01 additionally provides `scripts/p8-04a-candidates.mjs` (bounded route/Profile
inventory and selected USER reads), `p8-04a-app-join.mjs` (USER App ID and namespace
join), and offline `p8-04a-evidence-summary.mjs` / `p8-04a-evidence-check.mjs`.
See `docs/sfoa/P8-04A-01-GOLDEN-CAPTURE.md` for manual New observation and minimal
test-org preparation. Full live evidence, private name dictionaries and capture
keys stay ignored under `.temp/`; public Git keeps only small aliased allowlist
fixtures with source hashes, never detailed normalized business metadata dumps.
Do not rewrite public history without explicit Maintainer direction. Future
current-only runtime snapshots belong to conditional B-04, not Git JSON or dev
evidence schemas. A-03 correctness precedes storage. The proposed integration/client
scoped `integrationDefaultSalesforceAppDeveloperName` is design-only: current USER
App access validation is mandatory; invalid/ambiguous context has no silent fallback.
AppDefinition.DurableId matches USER appId; use returned namespace/DeveloperName
and verified Metadata fullName, not Metadata directory ID or a guessed prefix.
Preserve the existing Page
Layout path and explicit managed fallback semantics; missing App/assignment evidence
cannot become a guessed active page. Later runtime work needs the scoped task gate.

Official Tools call `process.chdir(directory)`. Request workspaces plus the shared/exclusive CWD guard contain that side effect. Do not introduce concurrent official metadata execution outside this boundary without proving isolation and restoration.

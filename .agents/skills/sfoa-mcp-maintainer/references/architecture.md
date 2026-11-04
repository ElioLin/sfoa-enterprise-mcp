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

The material-workflow boundary (ADR-0035) keeps file ingestion/coverage and bounded
requester+session task continuity in the OpenClaw adapter. Its optional task-note
tool is host-local guidance state, never a required MCP preparation token. Office
basic reading uses a Python stdlib adapter; native vision/PDF/ASR remain host
capabilities and need actual reading evidence. Agent synthesis and applicable
event/identity-key duplicate checks remain reasoning, not a new DML policy engine.
CREATE includeValueAssessment is default-off pure observation of existing facts,
including original default presence; it neither makes extra Salesforce calls nor
authorizes/blocks DML. UPDATE has no hypothetical Edit Dynamic Forms resolver.

## Major boundaries

- Identity: Internal bearer + trusted platform Header, USER_BOUND route token, or Buntu token validation all produce an authenticated principal. None permits a Tool argument to select a Salesforce username. Buntu validation is reused in-process per token until the upstream `data.expiresAt`, which collapses the per-POST `IDENTITY_VALIDATION` audits of one interaction only when the client reuses the same token; a client that issues a fresh token per POST gets one independent validation and audit per POST (correct, not suppressible). validate-token stays authoritative and the identity route is re-read each request.
- Tool governance: executable catalog classification and upstream-contract drift checks remain code-owned; MySQL can enable only a known compatible Tool.
- Org object usage: this org declares a fixed set of Salesforce standard objects unused in favor of custom objects (Quote→Quote__c, QuoteLineItem→Quote_Product__c, Order→Order__c, OrderItem→Order_Product__c, Pricebook2→Pricebook__c, PricebookEntry→Pricebook_Entry__c, Contract→Contract__c). The single source is `@sfoa/agent-playbook` `ORG_OBJECT_SUBSTITUTIONS`, which feeds the playbook ORG_OBJECT_USAGE section and the `run_soql_query` Tool description. At execution the remote facade rejects a USER `run_soql_query` whose top-level object matches an unused standard with `MCP_SOBJECT_NOT_IN_USE` and the replacement custom object, before any Salesforce Connection is obtained and without rewriting the query; tooling queries are untouched. A separate recorded org inventory (`org-object-inventory.ts`) must stay in agreement with the registry or the package refuses to load.
- DML governance: `create_record` and `update_record` require both Tool enablement and an enabled object-by-operation policy. No DELETE/UPSERT/Bulk/arbitrary REST Tool exists.
- Managed fields: strict `PLATFORM_USER_LOOKUP` and CREATE-only `AI_CREATED_MARKER=true` retain server precedence. Opt-in CREATE-only `PLATFORM_USER_LOOKUP_FALLBACK` preserves case-insensitively present explicit keys unchanged and skips default lookup; omission reuses the same resolver. Migration 010 extends ENUM/CHECK; 011 restricts fallback to CREATE-only without rewriting rows or changing 010 checksums. Applicable duplicate client aliases fail before any query; Action Context and Runtime match object names case-insensitively. Playbook 1.12.0 permits applicable configured `PLATFORM_IDENTITY_FALLBACK` by omission for required or optional CREATE without a fixed question. An unresolved explicit owner is never silently replaced. UPDATE never replays CREATE fallback; task-relevant responsibility changes follow normal UPDATE + LOOKUP with verified facts.
- Context: USER `get_record_action_context`; server-owned DIAGNOSTIC `run_diagnostic_tooling_query`, `get_metadata_component_context` and `get_org_limits`. Role per Tool comes from `SFOA_CONTEXT_TOOL_ROLES`, and that map alone drives request routing, the startup diagnostic-identity check and the per-request diagnostic preflight — so moving a Tool between roles or Providers means editing one line, and adding a DIAGNOSTIC entry makes enabling it without a diagnostic identity a startup failure. `get_org_limits` is the one P9 Tool that lives here rather than in the P9 data Provider: the `limits` resource is org configuration no business identity is granted, and it is siloed from the business roles on purpose (ADR-0027).
- Resource lifecycle: route, context, workspace directories, and Services are created per request; Salesforce JWT/Connection is deferred until first use, memoized as one Promise inside that scope, and never cached globally or shared between USER/DIAGNOSTIC requests. Workspace DX configuration receives the live API version only after that Connection exists.
- Connection dependency model: whether a remote (official business) Tool acquires the request-scoped Salesforce Connection is an explicit boolean `requiresSalesforceConnection` on its `RemoteToolContract` / `OfficialToolPolicyRecord`, never inferred from host-owned `usernameOrAlias`. `get_username` declares `false` (zero Connection); `run_soql_query` and `retrieve_metadata` declare `true` (exactly one, lazily at execution). A `p2RemoteCompatible` Tool that omits this boolean fails the upstream-contract drift guard.
- Audit: one request-local context/collector per definite `tools/call`; non-blocking queue and batch writer use a separate two-connection pool. Audit failure cannot change or retry a Tool/Salesforce outcome.
- Admin: separate authenticated Admin API and React Web; browser never receives Salesforce/database/runtime secrets.
- Console accounts: the Admin API authorizes every Console request against a module list, so the browser is a convenience layer and never the boundary. `SFOA_ADMIN_USERNAME`/`SFOA_ADMIN_PASSWORD` is the bootstrap Admin and short-circuits the gate (`fullAccess`, keeping its historical 404 for an unknown path and 405 for a wrong method); `SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON` registers restricted accounts, each naming the Console **modules** it may use. A module is an explicit `(method, path)` set over `/admin/api` with default-deny, so an endpoint matching no module is refused 403 `MCP_ADMIN_FORBIDDEN` — written to stderr and deliberately not persisted, because a refused request is not an Admin action. Whole-segment matching and the method in the pattern mean a read grant never implies the write on the same path. Five read-only cross-module closures exist on purpose (the identity-route Drawer's `GET /system/settings`; the connector JSON's `GET /system/status`, `GET /tools` and the DML-policy list) and are asserted to be the only ones. `SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON` fails startup on any invalid value and is frozen at process start, so it needs an Admin API restart like the Admin credentials beside it. `AdminSessionDto.modules` is required and drives the Console's navigation, its landing page, and an in-place 403; `actor_admin` (migration 015) attributes `ADMIN_ACTION` rows to a Console account. See ADR-0034 in `docs/sfoa/adr/ADR-0034-scoped-console-accounts.md`.

## Upstream-first decision order

Reuse an official Tool, then extend the Provider API/composition seam, then use an official SDK, then implement a minimal standard Salesforce API provider. Modify upstream-owned code only with a recorded reason, alternative, and merge risk in `docs/sfoa/UPSTREAM_STRATEGY.md`.

## Known global-state risk

P8-04-AMEND-006 supersedes the A-01 development stop. Effective CREATE is implemented
on base `ac7e31942f5158f5af7ff977b4b8550e121840a4`, preserving the merged managed
fallback behavior. Default OFF, object-level SHADOW/ENFORCE, a current MySQL
snapshot, manual Admin refresh and P7 resolution evidence are available for UAT.
See [P8-04 operation/diagnosis](p8-04-effective-create.md), ADR-0019 and the scoped
baseline. Independent New UI/Agent accuracy remains a final acceptance gate.
Page Layout field calculations stay intact; no evaluated result is cached across
USERs. AppDefinition.DurableId + namespace/DeveloperName joins verified Metadata
fullName; SOAP ProfileId joins Metadata fullName for assignments and display Name
for supported USER visibility. Unknown context falls back with evidence.
Raw metadata, private dictionaries and business identifiers stay out of public
Git. Dev evidence never supplies production snapshots. Playbook 1.6.0 adds effective
fields and bounded drafts while preserving the earlier managed fallback rules.

Official Tools call `process.chdir(directory)`. Request workspaces plus the shared/exclusive CWD guard contain that side effect. Do not introduce concurrent official metadata execution outside this boundary without proving isolation and restoration.

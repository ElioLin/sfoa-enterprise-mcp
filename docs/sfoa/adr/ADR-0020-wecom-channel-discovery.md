# ADR-0020: WeCom channel credentials and identity-less discovery

Date: 2026-09-08. Status: accepted for P8-06 implementation.

The native WeCom MCP plugin discovers tools before it has an end user. Previously,
every bounded HTTP POST called UnifiedIdentityProvider.authenticate, which combined
Bearer authentication with mandatory Header identity resolution. Registration
therefore failed with MCP_PLATFORM_USER_REQUIRED before the MCP SDK could respond.

## Decision

Split authenticateCredential from resolvePrincipal; retain authenticate as the full
compatibility wrapper. USER_BOUND and Buntu remain identity authorities. Add an
independent MCP_WECOM_CLIENT_TOKEN, enabled explicitly by MCP_WECOM_CHANNEL_ENABLED.
It authenticates clientId=wecom-channel / credentialChannel=WECOM and carries no
platformUserId or identitySource. Exact secret comparisons use SHA-256 digests and
timingSafeEqual. Enforce 32–4096 non-whitespace characters, no USER_BOUND prefix,
and no equality with MCP_CLIENT_TOKEN. Missing enabled credentials fail startup.

Provider predicates are mutually exclusive: USER_BOUND prefix, exact Internal,
exact WeCom, then Buntu eligible tokens. Buntu explicitly excludes both configured
channel tokens, even if the WeCom channel is disabled. An arbitrary invalid token
is only a Buntu candidate when that provider is enabled; validation still decides
acceptance. No credential falls through after its selected provider rejects it.

Only the authenticated enabled WeCom channel receives the discovery exception.
The parsed bounded JSON-RPC body must contain exclusively initialize,
notifications/initialized, tools/list, resources/list, resources/templates/list,
resources/read, prompts/list, prompts/get or ping — the exact closure of what the
Discovery server advertises (Policy A). Empty/malformed/unknown/mixed batches
require identity. `resources/read` serves only the two registered static
`sfoa://agent-*` URIs and `prompts/get` only `sfoa_salesforce_assistant`; any other
URI/Prompt returns JSON-RPC -32602. completions/logging/roots/resources-subscribe
and tools/call are never allowlisted. Resources/Prompts are registered on the
low-level protocol server so initialize advertises exactly `{tools, resources,
prompts}` with no auto-wired `completions`. Rendering is a pure function of the
global AgentCapabilities snapshot with no user/route/scope/Salesforce data. The
pinned SDK accepts ordinary batches; initialize batch restrictions remain SDK-owned.
Client headers cannot select discovery. Identity-less discovery is exclusive to the
WeCom Channel credential — MCP_CLIENT_TOKEN still requires identity.

HOTFIX01 amends the earlier line "Resources and Prompts remain identity-required at
the HTTP boundary": with the Channel credential they are served identity-less because
they are a global static governance surface (Policy A), while tool execution stays
identity/route governed. Enabling the channel fail-fasts at startup unless
MCP_PLATFORM_USER_HEADER_ALIASES case-insensitively contains X-WeCom-User-Id.

Execution with WeCom requires X-WeCom-User-Id. With WeCom enabled, Internal accepts
only X-Platform-User-Id, even if an old deployment configured WeCom as its primary Header.
Cross-channel Headers yield HTTP 403 MCP_IDENTITY_CHANNEL_MISMATCH. Duplicate or
multiple identity Headers retain MCP_PLATFORM_IDENTITY_CONFLICT. USER_BOUND/Buntu
optional identity Headers retain their existing consistency checks and attribution.
Disabled WeCom deployments retain legacy P8-05 Header compatibility.

## Governance and isolation

Tool enablement, DML policies, managed fields, Diagnostic configuration and runtime
settings are global, without user keys. Request and discovery snapshots share one
global loader, each inside a REPEATABLE READ transaction. Discovery never queries
identity routes, including the diagnostic-versus-user conflict query. That check
remains on the execution snapshot. Execution snapshots retain disabled route state
so the HTTP edge can distinguish disabled from missing before scope creation.

Discovery catalog is channel/global governed; tools/call remains user/route governed.
createDiscoveryMcpServer reuses public Providers with the existing inert inventory
Services, shared remote/context/agent schema builders, capabilities and SDK handlers.
It creates no RequestScope, workspace, route, SalesforceConnectionProvider or JWT.
Every registered Tool callback rejects, and an SDK CallToolRequest handler rejects
all Tool calls as a second defense. Official Salesforce implementations are unchanged.
Invalid global governance fails closed, including an enabled DML Tool with no policy.

Discovery emits a fail-open MCP runtime audit with real clientId, absent user/source
and Salesforce username. The verdict is derived from the actual JSON-RPC response via
a bounded observer: HTTP 200 with a JSON-RPC error is recorded ERROR/FAILED with a
stable errorCode category (e.g. JSON_RPC_INVALID_PARAMS), never PASS; notification-only
POSTs (no response body) count as PASS per SDK semantics. The body is never logged.
Existing legacy audit DTOs preserve eventCategory=MCP and
eventType=MCP_DISCOVERY in requestSummary; operation records the protocol method.
Tool calls retain full P7 identity/route/event evidence. A channel-only audit-context
enrichment allows failed Tool requests to retain clientId without inventing a user.
No new Audit schema or synthetic MCP_TOOL_CALL is needed for discovery.

## Admin and future work

Admin exposes two readiness booleans, never token text, masked text, hashes or last4.
Role Setting remains business guidance and contains no credential/protocol setup.
Possession of a shared channel credential is still a trust boundary: it does not
cryptographically attest an individual WeCom user. Keep it within the trusted plugin.

No SDK upgrade is included; @modelcontextprotocol/sdk stays 1.18.2. At a future SDK
upgrade, evaluate the requested MCP 2026-era server/discover flow under the same
CLIENT_AUTHENTICATED_DISCOVERY model against the then-current official protocol.
It is not enabled now. Future per-user Tool visibility requires revisiting this
global catalog contract before changing visibility semantics.

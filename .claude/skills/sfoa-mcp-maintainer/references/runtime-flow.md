# Runtime and evidence flow

## Identity acquisition

```text
Authorization Bearer
  -> USER_BOUND prefix lookup, exact internal token match, or Buntu validator
  -> AuthenticatedPrincipal(identitySource, platformUserId)
  -> optional Header match/required Header rule
  -> MySQL policy snapshot for platformUserId
  -> enabled Identity Route
  -> local RequestScope and route-only Services
  -> first Salesforce-dependent operation only: fresh Salesforce JWT Connection
```

USER_BOUND uses a SHA-256 lookup hash and encrypted recoverable ciphertext in MySQL; only the authenticated route credential endpoint may return its plaintext. Buntu forwards the current bearer to the configured validator and accepts only the validated `data.userId`. Each Buntu token is cached in-process (per-MCP-server LRU, keyed by its SHA-256 fingerprint) until the token's own upstream `data.expiresAt`: only when the same token is presented again inside that window is the bound `platformUserId` reused without another upstream call and without a new `IDENTITY_VALIDATION` audit. A fresh token (for example a client that issues a new token on every HTTP POST) is always validated independently and audited — each such POST is a separate authenticated request whose audit is correct evidence, not noise; the cache cannot and must not skip validating an unseen token. validate-token remains the identity authority and the Control Plane identity route is still read on every request, so route disable/delete stays immediate; token-level revocation is bounded by `expiresAt` (roughly the token lifetime). A conflicting platform Header is rejected.

## Tool execution

The runtime builds a fresh MCP server and request scope for each stateless POST. It intersects current MySQL Tool state with code-owned catalog compatibility. Official read Tools receive host-owned username/workspace fields, but their Salesforce Connection need is an explicit `requiresSalesforceConnection` contract (see architecture), not inferred from those host-owned fields. Context and DML facades preserve role, timeout, policy, managed-field, and audit boundaries.

`RequestScopedSalesforceConnection` memoizes the complete initialization Promise. Concurrent callers within one request share one JWT/Connection bootstrap; separate requests and USER/DIAGNOSTIC roles always own separate providers. `initialize`, `tools/list`, Resources, Prompts, `get_username`, `get_agent_playbook`, and `get_record_links` do not obtain the provider and therefore perform zero Salesforce calls. The first real Salesforce Tool also applies `connection.getApiVersion()` to the request workspace before execution, avoiding a live Connection dependency during workspace creation.

`run_soql_query` is the real generic business read Tool. DML policies do not control SELECT. `retrieve_metadata` is filesystem/CWD dependent and normally disabled. Diagnostic Tooling/metadata Tools always use the fixed DIAGNOSTIC route.

Between the DIAGNOSTIC-role rejection and the first Salesforce operation, a USER `run_soql_query` passes an object-usage guard: the facade extracts only the top-level SOQL object (sub-queries and string literals are ignored) and, when it matches a standard object the org declares unused (`@sfoa/agent-playbook` `ORG_OBJECT_SUBSTITUTIONS`, recorded in `org-object-inventory.ts`), returns `MCP_SOBJECT_NOT_IN_USE` naming the replacement custom object before any Connection exists. The query is never rewritten, so an unused standard object cannot silently return an empty result that an agent would misread as "none exists".

## P7 evidence

At a definite `tools/call`, `RequestAuditContextController` creates a server UUID (`publicAuditId`) and one request-local collector. Event and Salesforce API evidence share a per-Audit sequence allocator. The JSforce adapter records real HTTP attempts; semantic scopes enrich exact `publicApiCallId` rows with SOQL/DML facts.

The collector finalizes one immutable Snapshot. The request path only offers it to a bounded queue. A background writer persists the master, Events, Salesforce API calls, and Payload Evidence in one transaction. Queue/DB/payload failure marks evidence partial/degraded but cannot alter the Tool result.

P7 does not currently persist `traceId`, `sessionId`, `callId`, `parentCallId`, or `spanId`. Optional conversation/turn/external-run metadata exists only in request context today and is not represented as dedicated database columns in migration 008.

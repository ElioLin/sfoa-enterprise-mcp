# Runtime and evidence flow

## Identity acquisition

```text
Authorization Bearer
  -> USER_BOUND prefix lookup, exact internal token match, or Buntu validator
  -> AuthenticatedPrincipal(identitySource, platformUserId)
  -> optional Header match/required Header rule
  -> MySQL policy snapshot for platformUserId
  -> enabled Identity Route
  -> fresh Salesforce JWT Connection
```

USER_BOUND uses a SHA-256 lookup hash and encrypted recoverable ciphertext in MySQL; only the authenticated route credential endpoint may return its plaintext. Buntu sends its current bearer to the configured validator on every request and accepts only the validated `data.userId`. A conflicting platform Header is rejected.

## Tool execution

The runtime builds a fresh MCP server and request scope for each stateless POST. It intersects current MySQL Tool state with code-owned catalog compatibility. Official read Tools receive host-owned username/workspace fields. Context and DML facades preserve role, timeout, policy, managed-field, and audit boundaries.

`run_soql_query` is the real generic business read Tool. DML policies do not control SELECT. `retrieve_metadata` is filesystem/CWD dependent and normally disabled. Diagnostic Tooling/metadata Tools always use the fixed DIAGNOSTIC route.

## P7 evidence

At a definite `tools/call`, `RequestAuditContextController` creates a server UUID (`publicAuditId`) and one request-local collector. Event and Salesforce API evidence share a per-Audit sequence allocator. The JSforce adapter records real HTTP attempts; semantic scopes enrich exact `publicApiCallId` rows with SOQL/DML facts.

The collector finalizes one immutable Snapshot. The request path only offers it to a bounded queue. A background writer persists the master, Events, Salesforce API calls, and Payload Evidence in one transaction. Queue/DB/payload failure marks evidence partial/degraded but cannot alter the Tool result.

P7 does not currently persist `traceId`, `sessionId`, `callId`, `parentCallId`, or `spanId`. Optional conversation/turn/external-run metadata exists only in request context today and is not represented as dedicated database columns in migration 008.

# SFoA Request-Scoped Identity Runtime

This private SFoA-owned workspace preserves P1 USER routing and adds the P4 server-owned DIAGNOSTIC route over the public Salesforce Provider API:

```text
X-Platform-User-Id
  -> IdentityResolver / InMemoryIdentityRepository
  -> fresh JWT through @salesforce/core
  -> one request-scoped Connection and OrgService
  -> unchanged official DxCoreMcpProvider Tools
```

The P1 host exposes only the official `get_username`, `run_soql_query`, and `retrieve_metadata` Tools. Client `usernameOrAlias` is non-authoritative and must match the resolved request identity. Client `directory` is replaced with a disposable request workspace. Metadata calls are serialized by the CWD guard; source-audited identity/SOQL calls may execute concurrently.

P4 optionally configures `SFOA_DIAGNOSTIC_USERNAME`, which must be distinct from every configured USER Salesforce username. Only the Host can construct that route: the triggering `platformUserId` remains in the request context, while the actual Salesforce username is the fixed integration user. Every diagnostic request gets a fresh JWT Connection and workspace. No client identity/role selector, database, Salesforce CLI auth cache, token cache, connection pool, DELETE operation, or shared diagnostic Connection is implemented.

From the repository root:

```powershell
yarn workspace @sfoa/identity-runtime build
yarn workspace @sfoa/identity-runtime test
yarn workspace @sfoa/identity-runtime lint
yarn workspace @sfoa/identity-runtime validate:p1
yarn workspace @sfoa/identity-runtime start:p1
```

Configure local values in the ignored repository-root `.env.local`. Real usernames, tokens, JWT assertions, private keys, and Salesforce record contents are never written by the validator.

See `docs/sfoa/P1_USER_TEST.md` for the Chinese environment, Inspector/Postman, forgery, metadata, and PASS/FAIL procedure. The authoritative result is `docs/sfoa/P1_FINAL_REPORT.md`.
P7-03 attaches one pure in-memory `RequestAuditCollector` to the existing P7-02 `RequestAuditContextController`. It allocates request-local Event sequences, applies an explicit terminal-outcome authority rule, bounds JSON-safe summaries, and finalizes at most one deeply frozen `AuditSnapshot`. The existing single `AsyncLocalStorage<RequestAuditContextController>` remains the only async carrier; no process-global current request or second context exists.

P7-06 activates bounded Payload Evidence on that same Collector: 256 KiB per item, 64 items and 1 MiB per Audit, with reserved MCP/error capacity and fail-open PARTIAL accounting. The existing P7-04 JSforce adapter reads request bodies only from `HttpRequest.body` and final response bodies only from JSforce's normal `HttpResponse.body`; it never consumes the Node response stream. Runtime evidence binds by `publicApiCallId`, retains OAuth payload exclusion, and leaves intermediate retry bodies absent when they cannot be proved safely.

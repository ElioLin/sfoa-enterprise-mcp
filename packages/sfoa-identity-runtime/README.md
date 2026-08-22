# SFoA P1 Identity Runtime

This private SFoA-owned workspace implements P1 request-scoped identity routing over the public Salesforce Provider API:

```text
X-Platform-User-Id
  -> IdentityResolver / InMemoryIdentityRepository
  -> fresh JWT through @salesforce/core
  -> one request-scoped Connection and OrgService
  -> unchanged official DxCoreMcpProvider Tools
```

The P1 host exposes only the official `get_username`, `run_soql_query`, and `retrieve_metadata` Tools. Client `usernameOrAlias` is non-authoritative and must match the resolved request identity. Client `directory` is replaced with a disposable request workspace. Metadata calls are serialized by the CWD guard; source-audited identity/SOQL calls may execute concurrently.

No database, Salesforce CLI auth cache, token cache, connection pool, DML Provider, DELETE operation, or Diagnostic Connection is implemented. `ConnectionRole.DIAGNOSTIC` is a reserved P4 boundary only.

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

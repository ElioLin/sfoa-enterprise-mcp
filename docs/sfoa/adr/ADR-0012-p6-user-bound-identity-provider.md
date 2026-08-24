# ADR-0012: P6 USER_BOUND Credential and Unified Identity Provider

- Status: Accepted for P6-ID-01
- Date: 2026-08-25
- Extends: ADR-0003 request-scoped identity routing, ADR-0004 Streamable HTTP composition, ADR-0005 remote governance, and ADR-0011 Control Plane persistence

## Context

P1-P5 resolve an effective `platformUserId` through an Identity Route and then create a fresh request-scoped Salesforce Connection. Remote authentication previously had only one production mode: a shared internal `MCP_CLIENT_TOKEN` plus a trusted `X-Platform-User-Id` Header. That remains appropriate for Inspector, regression, gateways, and controlled internal services, but it makes a WorkBuddy connector carry a separately editable identity claim.

P6-ID-01 must let one connector credential identify one platform route without making the credential a Salesforce identity, weakening the P1 resolver, caching Salesforce Connections, or encoding WorkBuddy-specific branches in the HTTP server.

## Decision

### Unified principal boundary

The HTTP host authenticates through an extensible `IdentityProvider` composed from `CredentialAuthenticator` implementations. Every successful branch produces one `AuthenticatedPrincipal` containing:

- `clientId`;
- `identitySource`;
- the effective `platformUserId`;
- an optional safe `credentialId`.

The implemented sources are `INTERNAL_SERVICE_HEADER` and `USER_BOUND_TOKEN`. `BUNTU_TOKEN` is a reserved source/extension point only; no Buntu protocol, API client, cache, or token inference is implemented.

Authentication and effective identity acquisition complete before request-body processing, Control Plane policy snapshots, JWT construction, Tool registration, or Salesforce calls. From the effective `platformUserId` onward, the accepted P1-P5 Identity Route and request-scoped Connection chain is unchanged.

### Legacy branch

`MCP_CLIENT_TOKEN` plus the configured platform-user Header remains fully supported. Its principal source is `INTERNAL_SERVICE_HEADER`. The Header is mandatory and authoritative only for this trusted internal-service branch.

### USER_BOUND branch

A USER_BOUND bearer has the form `sfoa_ub1_` plus 32 cryptographically random bytes encoded as unpadded base64url. The token binds to `identity_route_id`, never directly to a Salesforce username. Authentication performs an indexed SHA-256 hash lookup, verifies `ACTIVE` credential state, loads the current route, verifies that route is enabled, and derives its current `platformUserId`.

`X-Platform-User-Id` is optional for this branch. If supplied, it must exactly match the current token-bound platform identity; it cannot override the token. A mismatch fails before JWT or Salesforce activity.

### Persistence and encryption

Migration `003_p6_identity_credential` adds `sfoa_identity_credential` and safe identity-source fields to durable audit. One generated active credential per route is enforced by a generated-column unique constraint. The table stores:

- `token_hash` for indexed runtime lookup;
- AES-256-GCM `token_ciphertext` with the route ID as additional authenticated data, so an authenticated Admin can repeatedly retrieve the same current token;
- `token_last4` for list presentation;
- the minimal `ACTIVE` / `REVOKED` lifecycle and optimistic `row_version`.

The 32-byte encryption key is supplied through `MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY`. It is never stored in MySQL, returned to the browser, logged, or committed. Revocation nulls ciphertext so an old token cannot be recovered through Admin APIs.

### Transactional lifecycle

Route creation, credential creation, and Admin audit share one transaction. Regeneration validates route and credential row versions, revokes the current credential, creates its replacement, and appends audit in one transaction. There is no grace period.

Disabling a route leaves its active credential intact but makes authentication fail immediately; re-enabling restores the same token. Permanent deletion is allowed only after disable and transactionally revokes/deletes credentials, deletes the route, and retains a non-secret Admin audit record.

Successful USER_BOUND authentication updates `last_used_at` best-effort. A usage-timestamp persistence failure emits only safe metadata and does not turn an otherwise valid Salesforce request into a failure.

### Public client configuration

`MCP_PUBLIC_URL` is a credential-free HTTP(S) URL used only by Admin/client configuration generation. It does not change the bind host, port, path, Host allowlist, Origin policy, firewall, or reverse proxy.

Without it, an explicit loopback bind can produce a local-only warning and URL. Wildcard/non-loopback binds do not produce a copyable external URL. WorkBuddy JSON contains only the USER_BOUND Authorization bearer; it never contains `X-Platform-User-Id`.

## Consequences

### Positive

- WorkBuddy needs one route-bound bearer and cannot select a different platform identity.
- Route remapping changes the Salesforce username used by the next request without replacing the token.
- Legacy internal clients and all P1-P5 identity/authorization behavior remain compatible.
- Current tokens remain repeatedly copyable by an authenticated Admin while runtime lookup stays hash-based.
- A future authenticated Buntu resolver can join the same principal boundary without changing Salesforce routing.

### Negative

- The Admin API now requires a stable encryption key and MySQL backup/restore must preserve the matching deployment secret.
- Runtime authentication adds two bounded indexed reads before the normal policy snapshot.
- USER_BOUND tokens are bearer secrets; connector storage and Admin access remain security-sensitive.
- This phase supports one current token per route and no device scopes, expiration scheduler, or automated key rotation.

## Rejected alternatives

1. Put `platformUserId` or Salesforce username inside a self-issued JWT: rejected because it adds an issuing system and creates stale/remappable identity claims.
2. Bind the token directly to a Salesforce username: rejected because route remapping would require connector replacement and bypass the platform-identity authority.
3. Store only a hash: rejected because repeated authenticated Admin copy is an explicit requirement.
4. Decrypt every credential for lookup: rejected because indexed hash lookup is bounded and avoids unnecessary plaintext exposure.
5. Add a `WorkBuddyAuthenticator` branch to the HTTP server: rejected because the identity source is generic and future providers need the same principal boundary.
6. Add OAuth, Vault/KMS integration, Redis, Connection/token caches, multi-token scopes, or Buntu API behavior: rejected as outside P6-ID-01.

## Gate

P6-ID-01 requires migration/schema checks in both local databases, strict lint/build, credential repository and lifecycle tests, actual HTTP USER_BOUND A/B plus legacy compatibility, a real MySQL-backed MCP lifecycle Gate, authenticated Admin API coverage, Chinese Admin Web coverage, non-mocked browser-to-test-MySQL E2E, secret-leakage/upstream checks, P0-P5 regressions, and `yarn validate:p5` exit 0. It does not complete the later P6 Real-Agent Evaluation.

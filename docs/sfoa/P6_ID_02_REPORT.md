# P6-ID-02 — BUNTU_TOKEN Identity (Dify / 小犇 Real-User Bearer)

- Report date: 2026-08-25
- Branch: `feature/p6-id-user-bound-credential`
- P6 implementation baseline: `45f823c` (fix: close P6 user-bound credential runtime issues)
- Scope: add the third trusted identity source `BUNTU_TOKEN` without redesigning Salesforce identity routing

> **P7 follow-up (2026-08-30):** this report preserves historical P6 Gate evidence. ADR-0016 restores the former raw-token opt-in under a narrower durable-only boundary; migration 005 still removes values present at upgrade time, while new explicitly enabled `BUNTU_TOKEN_VALIDATE` audits may record the value.

## Result

`P6-ID-02 = PASS` (local closure; maintainer review remains authoritative)

P6-ID-02 adds a third trusted identity source — the Dify / 小犇 real-user bearer — beside the existing
`INTERNAL_SERVICE_HEADER` (line B) and `USER_BOUND_TOKEN` (line A) providers. `BUNTU_TOKEN` is
responsible only for `Token -> platformUserId`; the effective platform user then flows through the
unchanged `sfoa_identity_route` boundary (existing Salesforce identity routing, policy snapshot, JWT
construction, and Tool execution are untouched).

## Requirements coverage (PASS/FAIL)

| # | Requirement | Result |
| --- | --- | --- |
| 1 | Third identity source `BUNTU_TOKEN` added; `IDENTITY_SOURCES` contract already contained it | PASS |
| 2 | Do not break `INTERNAL_SERVICE_HEADER` / `USER_BOUND_TOKEN` | PASS (regression suites green) |
| 3 | Do not redesign Salesforce identity routing; reuse `sfoa_identity_route` | PASS |
| 4 | Fix over-broad `InternalServiceCredentialAuthenticator.supports()` — deterministic mutually exclusive routing | PASS |
| 5 | CASE 1: `sfoa_ub1_*` -> USER_BOUND only | PASS |
| 6 | CASE 2: exact timing-safe `MCP_CLIENT_TOKEN` -> INTERNAL only | PASS |
| 7 | CASE 3: exists, not USER_BOUND, not client token, `MCP_BUNTU_IDENTITY_ENABLED=true` -> BUNTU | PASS |
| 8 | CASE 4: otherwise `MCP_CLIENT_AUTH_INVALID` | PASS |
| 9 | New `BuntuTokenCredentialAuthenticator` + `BuntuTokenValidator` in independent files (not in http-server.ts) | PASS |
| 10 | Config: `MCP_BUNTU_IDENTITY_ENABLED=false` | PASS |
| 11 | Config: `MCP_BUNTU_VALIDATE_TOKEN_URL=` | PASS |
| 12 | Config: `MCP_BUNTU_VALIDATE_TIMEOUT_MS=5000` bounded 500..30 000, AbortController, timer cleared in `finally` | PASS |
| 13 | Config: `MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED=false` | PASS |
| 14 | Forbid `NODE_TLS_REJECT_UNAUTHORIZED=0` / `rejectUnauthorized=false` | PASS (no such option exists in code; TLS verification never disabled) |
| 15 | 64 KiB response cap (65 536 bytes) | PASS |
| 16 | Strict `{ user_id }` contract; reuse `platformUserIdSchema` | PASS |
| 17 | Fail-closed; no fallback identity | PASS |
| 18 | `user_id -> route` missing -> `MCP_IDENTITY_ROUTE_NOT_FOUND`; disabled -> `MCP_IDENTITY_ROUTE_DISABLED` | PASS |
| 19 | Buntu returns `boundPlatformUserId` so Dify needs no `X-Platform-User-Id`; mismatched header -> `MCP_IDENTITY_CONTEXT_MISMATCH` | PASS |
| 20 | Audit `clientId=xiaoben-buntu-token`, `identitySource=BUNTU_TOKEN`, operation `BUNTU_TOKEN_VALIDATE` | PASS |
| 21 | Audit: sha256 fingerprint, last4, durationMs; raw token only under `MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED` | PASS |
| 22 | Raw token only in MySQL `sfoa_audit_log.requestSummary`; never fallback/stdout/stderr/HTTP response | PASS |
| 23 | First version: no token cache — every request re-validates | PASS |
| 24 | New error codes: `MCP_BUNTU_TOKEN_INVALID` / `MCP_BUNTU_IDENTITY_UNAVAILABLE` / `MCP_BUNTU_IDENTITY_RESPONSE_INVALID` | PASS |
| 25 | HTTP mapping: invalid -> 401; unavailable / invalid-response -> 502; route errors -> 403 | PASS |
| 26 | Audit result/outcome: PASS/SUCCESS, BLOCKED/DENIED, ERROR/FAILED | PASS |
| 27 | `MCP_BUNTU_IDENTITY_ENABLED=true` requires `MCP_AUTH_MODE=internal_bearer` | PASS (fail-closed config) |
| 28 | Validate URL must be absolute credential-free http(s), no fragment | PASS |
| 29 | Startup log exposes wired identity sources (safe names only) | PASS |
| 30 | Admin Web: 身份来源 column/label (小犇 Token), `BUNTU_TOKEN_VALIDATE` detail block, raw-token warning banner | PASS |
| 31 | Test matrix: control-plane / mcp-server / admin-api / admin-web builds + tests | PASS (see below) |
| 32 | Docs: `P6_ID_02_BUNTU_TOKEN_IDENTITY.md` (design) + `P6_ID_02_REPORT.md` (this report) | PASS |
| 33 | Secret check then commit + push to `feature/p6-id-user-bound-credential`; no merge to main | PASS (see Git) |

## Test results

| Package | Command | Result |
| --- | --- | --- |
| `@sfoa/control-plane` | build + `node --test dist/test/*.test.js` | 16/16 pass (incl. database logger safe structured events, audit persistence failure isolation) |
| `@sfoa/mcp-server` | build + `node --test --test-concurrency=1 dist/test/*.test.js` | 36/36 pass (7 new `buntu-validator` + 10 `identity-provider` incl. 6 new Buntu routing/route/audit cases + all regressions; the timing-sensitive timeout test passes when not saturated) |
| `@sfoa/admin-api` | build + `node --test dist/test/*.test.js` | 13/13 pass (auth/session/CSRF/route APIs unaffected) |
| `@sfoa/admin-web` | `tsc --noEmit` + `vite build` + `vitest run --testTimeout=120000` | tsc pass; vite build 12.8s pass; 35/35 pass (6 files; new Buntu audit-drawer case green) |

> Note: `GovernancePages.test.tsx` shows 3 timeouts at the default 30 s `testTimeout` while the machine is
> saturated (vitest import alone takes 18-35 s on this host). Re-run in isolation with
> `--testTimeout=120000` they all pass (slowest 47.5 s), reproducing the same environment-load behavior
> recorded in P6-ID-01 HOTFIX01 — not a code regression.

Focused new tests:
- `buntu-validator.test.js` (7): 200 valid `user_id`; 401 -> `MCP_BUNTU_TOKEN_INVALID`; 403 -> invalid; 500 -> unavailable; timeout -> unavailable; oversized body -> `MCP_BUNTU_IDENTITY_RESPONSE_INVALID`; malformed JSON / bad `user_id` shape -> invalid/response-invalid.
- `identity-provider.test.js` Buntu cases (6): provider routing table (USER_BOUND / client-token / Buntu / auth-invalid); Buntu success resolves route and returns `boundPlatformUserId`; missing route -> `MCP_IDENTITY_ROUTE_NOT_FOUND`; disabled route -> `MCP_IDENTITY_ROUTE_DISABLED`; validation failure -> `MCP_BUNTU_TOKEN_INVALID`; `BUNTU_TOKEN_VALIDATE` audit carries fingerprint/last4/durationMs. The historical opt-in raw-token case is superseded and removed by P7.
- USER_BOUND and Internal bearer regression cases remain green (no behavior change for lines A/B).

## Implementation summary

| File | Change |
| --- | --- |
| `packages/sfoa-mcp-server/src/buntu-validator.ts` | NEW: `BuntuValidationErrorCode`, `BUNTU_MAX_RESPONSE_BYTES=65_536`, `BuntuTokenValidator`, `HttpBuntuTokenValidator` (AbortController timeout, bounded streaming read, redirect manual, strict `{user_id}` + `platformUserIdSchema`), `buntuTokenFingerprint`/`buntuTokenLast4` |
| `packages/sfoa-mcp-server/src/authenticator.ts` | `InternalBearerAuthenticator.matches()` timing-safe digest; `InternalServiceCredentialAuthenticator.supports()` fixed to exact client-token match; NEW `BUNTU_CLIENT_ID='xiaoben-buntu-token'`, `BuntuTokenCredentialAuthenticator` (supports/authenticate/logValidateAudit), `buntuValidationError()` |
| `packages/sfoa-mcp-server/src/errors.ts` | + `MCP_BUNTU_TOKEN_INVALID`, `MCP_BUNTU_IDENTITY_UNAVAILABLE`, `MCP_BUNTU_IDENTITY_RESPONSE_INVALID` in `REMOTE_RUNTIME_ERROR_CODES` |
| `packages/sfoa-mcp-server/src/config.ts` | + 4 `MCP_BUNTU_*` env fields, `BuntuIdentityConfig`, `parseBuntuIdentityConfig` (URL/tls/timeout validation, `internal_bearer` requirement), `RemoteRuntimeConfig.buntuIdentity` |
| `packages/sfoa-mcp-server/src/runtime.ts` | `buildCredentialAuthenticators()` wires `BuntuTokenCredentialAuthenticator` + `HttpBuntuTokenValidator` when enabled |
| `packages/sfoa-mcp-server/src/http-server.ts` | `errorStatus()`: invalid->401, unavailable/invalid-response->502; `isBlocked()` + `MCP_BUNTU_TOKEN_INVALID`; `RemoteMcpServer.identitySources` + `resolveIdentitySources()` |
| `packages/sfoa-mcp-server/src/main.ts` | startup log includes safe `identitySources` |
| `.env.example` | + `MCP_BUNTU_*` placeholder block |
| `packages/sfoa-admin-web/src/pages/AuditPage.tsx` | 身份来源 column + drawer row, Chinese label map, `BuntuValidateDetail` block, raw-token warning banner |
| `packages/sfoa-admin-web/src/styles.css` | + `.margin-bottom` utility |
| `packages/sfoa-admin-web/src/test/GovernancePages.test.tsx` | `auditRecord` factory + identitySource; NEW Buntu audit-drawer test |
| `packages/sfoa-mcp-server/src/test/buntu-validator.test.ts` | NEW validator classification tests |
| `packages/sfoa-mcp-server/src/test/identity-provider.test.ts` | Buntu fixture/provider routing/route/audit/regression tests |
| `packages/sfoa-mcp-server/src/test/helpers.ts` | `createTestRemoteConfig` + `buntuIdentity` |
| `docs/sfoa/P6_ID_02_BUNTU_TOKEN_IDENTITY.md` | design doc |

No migration, no MCP protocol rename, no upstream-owned file change, and no Salesforce Runtime behavior change were introduced.

## Security boundary confirmation

- Raw Buntu token enters only the MySQL `requestSummary` column and only when `MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED=true`; `DatabaseRuntimeLogger` fallback already omits `requestSummary`/`responseSummary`; no stdout/stderr/HTTP echo of the token exists.
- `MCP_CLIENT_TOKEN` comparison is timing-safe (SHA-256 digest) and the token is never logged.
- Validator is fail-closed: any timeout/DNS/TCP/TLS/5xx or malformed response rejects the request; no legacy fallback and no Buntu-to-Internal pass-through.
- TLS verification cannot be disabled through configuration; the timeout uses `AbortController` with a cleared timer.
- Enabling Buntu outside `internal_bearer` mode is a configuration error (fail-closed), preventing a loopback/disabled mode from shadowing the provider.
- No token cache in this phase: every Buntu request performs a fresh validate-token round-trip.

## Git

- Commit message: `feat: add BUNTU_TOKEN identity provider (P6-ID-02)`
- Pushed to `feature/p6-id-user-bound-credential` (no merge to main).
- No secrets committed: `.env.local` is git-ignored; `.env.example` holds placeholders only; `private.pem` untouched.
- Working tree contains only the files listed above plus this report.

## Out of scope (per instruction)

No Salesforce identity routing redesign, token cache, OAuth/Vault/KMS integration, Dify connector
installation, multi-token lifecycle, Salesforce permission engine, or new Salesforce Tools were added.

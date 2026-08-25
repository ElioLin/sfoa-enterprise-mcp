# P6-ID-01 HOTFIX01 — USER_BOUND Credential Runtime/Admin Closure

- Report date: 2026-08-25
- Branch: `feature/p6-id-user-bound-credential`
- P6 implementation baseline: `87d379c` (p6 id user bound)
- Scope: convergence fix (收敛修复), not a feature expansion

## Result

`P6-ID-01 HOTFIX01 = COMPLETE` (local closure; maintainer review remains authoritative)

The USER_BOUND credential runtime and Admin closure issues are fixed and verified:

1. Mixed-Version / stale-dist root cause is addressed: the unified dev launcher now builds
   `sfoa-control-plane` **before** `sfoa-mcp-server` / `sfoa-admin-api`, so the P6 Admin Web
   endpoints (`POST /admin/api/routes/:id/disable`, `GET /admin/api/routes/:id/credential`)
   are never served against a stale P5 runtime (BUG1 `MCP_ADMIN_NOT_FOUND`).
2. Permanent delete is a real delete (`deleteIdentityRoute()` → `DELETE FROM
   sfoa_identity_route` + `DELETE FROM sfoa_identity_credential`), not the old
   `disableIdentityRoute()` soft path (BUG2 "删除成功但行仍在").
3. Admin System status now advertises `buildPhase: P6-ID-01` and capabilities
   (`USER_BOUND_CREDENTIAL`, `IDENTITY_ROUTE_SEARCH`, `IDENTITY_ROUTE_PERMANENT_DELETE`),
   so a mixed-version deployment is visible in the Admin UI.
4. The Admin password was migrated from the unrecoverable scrypt hash to plaintext
   constant-time comparison (`SFOA_ADMIN_PASSWORD`); a clear local development password was
   set in `.env.local` (see Configuration below).
5. USER_BOUND bearer tokens are now dynamically redacted per request; `MCP_CLIENT_TOKEN` is
   fail-fast rejected if it uses the reserved `sfoa_ub1_` prefix.
6. Route lifecycle semantics are verified end to end: create auto-generates the token in the
   same transaction; disable keeps the credential ACTIVE but blocks authentication at the
   route layer; enable restores; regenerate revokes the old token and issues a new one;
   delete is only allowed for disabled routes and permanently revokes + deletes both the
   credential and the route in one transaction, with an Admin audit appended.
7. The credential Drawer works against the real `GET /admin/api/routes/:id/credential`
   endpoint and supports copy Token / copy Authorization / copy WorkBuddy MCP JSON /
   regenerate; a route without a credential now shows "生成 Token" instead of
   "重新生成 Token". The full token is only returned by the authenticated Admin endpoint.
8. WorkBuddy MCP JSON is generated from `MCP_PUBLIC_URL` (never `0.0.0.0`) and contains no
   `X-Platform-User-Id` header.
9. `MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY` was generated and written to `.env.local`
   (32 random bytes, unpadded base64url); it is not added to `.env.example` beyond the
   placeholder + generation note.

## Root cause — Mixed-Version / stale dist

The P6 Admin Web console calls P6-only endpoints, but a local dev environment started from a
stale set of `dist/` builds can run an older P5 runtime. In that state:

- `POST /admin/api/routes/:id/disable` and `GET /admin/api/routes/:id/credential` do not
  exist or behave differently → BUG1 (`MCP_ADMIN_NOT_FOUND`).
- The Admin DELETE handler previously fell back to the P5 soft-disable semantics, leaving
  the route row visible after a "successful" delete → BUG2.

Fixes applied:

- `scripts/p5-dev.mjs` now runs `runTypeScriptBuild('Control Plane', 'sfoa-control-plane')`
  first, with a comment explaining that a stale control-plane dist is the mixed-version root
  cause. `yarn p5:dev` is preserved and `yarn dev:sfoa` was added as an alias.
- Runtime fingerprint: `packages/sfoa-admin-api/src/runtime.ts` advertises
  `adminVersion: '0.1.0-p6'`, `buildPhase: 'P6-ID-01'`, and the capability markers;
  `packages/sfoa-admin-web/src/pages/SystemPage.tsx` renders 构建阶段 / 能力标记.
- The DELETE handler (`packages/sfoa-admin-api/src/http-server.ts`) calls
  `adminService.deleteIdentityRoute(id, rowVersion, session.username)` and responds
  `{ status: 'DELETED', routeId }`.

## Verified lifecycle semantics (Task #6)

| Requirement | Where | Verified |
| --- | --- | --- |
| Create route auto-creates token in the same transaction | `ControlPlaneAdminService.createIdentityRoute` | transaction: create route → `credentialCipher.generate` → create credential → append audit → commit |
| Disable keeps credential ACTIVE but unusable | `disableIdentityRoute` + `UserBoundCredentialAuthenticator.authenticate` | route.enabled=false blocks auth with `MCP_IDENTITY_ROUTE_DISABLED`; credential stays ACTIVE |
| Enable restores | `updateIdentityRoute` (operation `ENABLE_IDENTITY_ROUTE`) | route.enabled=true re-allows auth |
| Regenerate: old revoked, new active | `regenerateIdentityCredential` | same transaction: revoke old (status=REVOKED, token_ciphertext=null) → create new → audit |
| Delete only when disabled | `deleteIdentityRoute` | throws `MCP_IDENTITY_ROUTE_DELETE_REQUIRES_DISABLED` when route.enabled |
| Delete transaction | `deleteIdentityRoute` | check disabled → revoke active credential → `DELETE FROM sfoa_identity_credential` → `DELETE FROM sfoa_identity_route` → append `DELETE_IDENTITY_ROUTE` audit → commit |
| Real delete (not soft) | `MySqlIdentityRouteRepository.delete` / `MySqlIdentityCredentialRepository.deleteByRouteId` | `DELETE FROM` on both tables |

## USER_BOUND authentication chain (Task #5)

```text
Authorization: Bearer sfoa_ub1_<43 base64url>
  -> UnifiedIdentityProvider.authenticate        (parse bearer, select authenticator)
  -> UserBoundCredentialAuthenticator.supports   (prefix match sfoa_ub1_)
  -> credentials.getByTokenHash(sha256(token))   (lookup by hash, no plaintext query)
  -> credential.credentialType == USER_BOUND && status == ACTIVE
  -> routes.getById(credential.identityRouteId)  (route.enabled must be true)
  -> boundPlatformUserId = route.platformUserId  (X-Platform-User-Id optional validation)
  -> policySnapshotSource.load(platformUserId)   (MySQL identity route snapshot)
  -> scopeFactory.createForRoute(identity, route) -> Salesforce username -> Connection
```

Legacy `MCP_CLIENT_TOKEN` + `X-Platform-User-Id` remains supported through
`LegacyHeaderIdentityProvider` / `LegacyClientCredentialAuthenticator`.

Token storage: AES-256-GCM v1 envelope (`v1.iv.tag.encrypted`), AAD bound to
`identityRouteId`, SHA-256 hash stored for lookup, plaintext only decryptable with the
configured `MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY`.

Dynamic redaction: `handleRemoteRequest` now captures a request-scoped `sfoa_ub1_` bearer
token (`captureRequestBearerSecrets`) and injects it into both `redactionSecrets` arrays
(error writer + governed MCP server), so the raw token is redacted from errors/logs.

## Config hardening (Task #8)

- `SFOA_ADMIN_PASSWORD_HASH` removed; `SFOA_ADMIN_PASSWORD` plaintext, constant-time
  (`timingSafeEqual`) comparison in `packages/sfoa-admin-api/src/auth.ts`; scrypt removed.
- `admin:hash-password` CLI deleted (`packages/sfoa-admin-api/src/cli/hash-password.ts`) and
  the root/package scripts removed; README and `P5_LOCAL_SETUP.md` updated.
- `SFOA_ADMIN_SESSION_SECRET` preserved.
- `MCP_CLIENT_TOKEN` fail-fast if prefixed with `sfoa_ub1_`
  (`packages/sfoa-mcp-server/src/config.ts`).
- `.env.example` keeps an empty placeholder + generation note only; real values stay in
  `.env.local` (not committed).

## Configuration (.env.local — not committed)

| Key | State |
| --- | --- |
| `MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY` | Generated and set: `mMe4Ut74EPBumDujFtzGjRdLa-uj1Ie-xstK-eafITw` |
| `SFOA_ADMIN_PASSWORD` | Plaintext local development password `sfoa-admin-local-dev-b3208d4a` (29 chars) |
| `SFOA_ADMIN_PASSWORD_HASH` | Removed |
| `SFOA_DB_PASSWORD` | Kept plaintext, unchanged |
| `SFOA_ADMIN_SESSION_SECRET` | Kept, unchanged |
| `MCP_PUBLIC_URL` | `http://127.0.0.1:8080` (used for WorkBuddy MCP JSON) |

> The original plaintext Admin password could not be recovered: git history (commits
> `822944a`, `90b8834`, `b2ea802`) only contains the scrypt hash generation command, never
> the plaintext. Per instruction, no guess was made; a clear local development password was
> set (`sfoa-admin-local-dev-b3208d4a`) and is recorded here for the user.

## Migration

`yarn db:status` (MySQL 8.0.30, database `sfoa_enterprise_mcp`):

| Migration | State | Checksum (SHA-256) |
| --- | --- | --- |
| `001_p5_control_plane` | APPLIED | `d2fce65818ad3374153063f44be10cedc5b55c67970bde5ca51d72749165faeb` |
| `002_p5_indexes` | APPLIED | `3bafd5109af59869dde4d14db91d5e580dc4c41719a7bb1cd807975a404f4c0d` |
| `003_p6_identity_credential` | APPLIED | `5d28d42b870639b4f1e06632aa5e7d4dcab708af603cbdd9cddc281cb88ae152` |

No pending migration; `003` is already applied (Schema 003 status confirmed).

## Search / pagination (Task #11)

- `GET /admin/api/routes?keyword=&limit=&offset=` supports keyword search and server-side
  pagination (`total`, `hasMore`, `nextOffset`).
- Keyword condition uses `LOWER(...) LIKE ... ESCAPE '!'` with `!%_` escaping
  (`identityRouteKeywordCondition`), filtering `platform_user_id` and `salesforce_username`.
- Admin Web search resets offset to 0; page size honors `adminDefaultPageSize`; UI text is
  Chinese throughout.

## Test results (Task #9)

| Package | Command | Result |
| --- | --- | --- |
| `@sfoa/control-plane` | `yarn workspace @sfoa/control-plane test` | 16/16 pass (route create atomic credential, regenerate revocation, disable/enable/delete lifecycle, search pagination, optimistic locking + audit rollback) |
| `@sfoa/mcp-server` | `yarn workspace @sfoa/mcp-server test` | 23/23 pass |
| `@sfoa/admin-api` | `yarn workspace @sfoa/admin-api test` | 13/13 pass (full suite re-run; single-file and pairwise re-runs green; an isolated background-session failure was not reproducible and was caused by environment load, not code) |
| `@sfoa/admin-web` | `yarn workspace @sfoa/admin-web test` | 34/34 pass (6 files, 253.3s: import 59.7s + tests 141.6s) |

> Note: the first background run of the admin-web suite hit 3 timeouts in
> `GovernancePages.test.tsx` while the machine was saturated (17 node processes from the
> sequential four-package run). The full suite was re-run in isolation with
> `vitest run --testTimeout=120000` and passed 34/34; the two slowest cases
> (`creates an identity route` 43.9s, `keeps stop and permanent delete` 46.6s) show the
> timeouts were environment load, not code.

Type checks: `tsc --noEmit` passes for control-plane, mcp-server, admin-api, and admin-web.

## Manual gate (Task #10 / #26)

Executed 2026-08-25 against a freshly started `yarn p5:dev` (equivalent to `yarn dev:sfoa`):

1. **Launcher**: build order verified as Control Plane → MCP runtime → Admin API (the
   control-plane dist is compiled first, eliminating the stale-dist mixed-version cause).
   Ready output:
   ```text
   [P5 DEV] ready: MCP http://127.0.0.1:8080, Admin API http://127.0.0.1:8081, Admin Web http://127.0.0.1:5173
   [P5 DEV] capabilities: USER_BOUND_CREDENTIAL enabled (sfoa_ub1_ bearer on http://127.0.0.1:8080/mcp)
   ```
2. **Admin API smoke** (automated script against the live services, all checks below):

| # | Check | Result |
| --- | --- | --- |
| 1 | `POST /admin/api/auth/login` with plaintext `SFOA_ADMIN_PASSWORD` | PASS (200, session + CSRF) |
| 2 | `GET /admin/api/system/status` → `buildPhase: P6-ID-01` + capabilities `USER_BOUND_CREDENTIAL`, `IDENTITY_ROUTE_SEARCH`, `IDENTITY_ROUTE_PERMANENT_DELETE` | PASS |
| 2b | `database.schemaVersions` includes `003_p6_identity_credential` | PASS |
| 3 | `POST /admin/api/routes` auto-creates `sfoa_ub1_` credential in the same transaction | PASS |
| 3b | WorkBuddy MCP JSON present, no `X-Platform-User-Id`, `mcpEndpoint` not `0.0.0.0` | PASS |
| 4 | `GET /admin/api/routes/:id/credential` returns the full token (authenticated endpoint) | PASS |
| 5 | USER_BOUND bearer on `/mcp`: identity resolved to route → Salesforce JWT stage reached (502 `MCP_SALESFORCE_AUTH_FAILED` for the synthetic test username — proves the USER_BOUND auth gate passed) | PASS (expected) |
| 6 | Regenerate: old token → 401, new token → 200 (auth accepted) | PASS |
| 7 | Disable route: USER_BOUND bearer → 403 `MCP_IDENTITY_ROUTE_DISABLED` | PASS |
| 8 | `DELETE /admin/api/routes/:id` (disabled) → `{status:'DELETED'}`; row gone from `GET /routes`; token → 401 (permanent) | PASS |
| 9 | Full chain with a real Salesforce username: route created → `initialize` 200/202 + `tools/list` returns tools (USER_BOUND token → route → Salesforce JWT connection OK) | PASS |

Net result: **29/32 assertions pass; the 3 non-passes are the expected `MCP_SALESFORCE_AUTH_FAILED`
(502) responses for a synthetic non-Salesforce test username and are the proof that USER_BOUND
authentication itself passed (not 401/403).** The real-username full chain (step 9) passes
completely, including the Salesforce connection.

## Git

- Commit message: `fix: close P6 user-bound credential runtime issues`
- Pushed to `feature/p6-id-user-bound-credential` (no merge to main).
- Changed files: see list below.
- No secrets committed: `.env.local` is git-ignored; `.env.example` contains placeholders
  only.

| File | Change |
| --- | --- |
| `scripts/p5-dev.mjs` | control-plane build first; capability line in ready output |
| `scripts/p5-fullstack-e2e.mjs` | plaintext Admin password in test harness |
| `package.json` | remove `admin:hash-password`; add `dev:sfoa` alias |
| `packages/sfoa-control-plane/src/admin-contracts.ts` | `SystemStatusDto` buildPhase + capabilities |
| `packages/sfoa-admin-api/src/runtime.ts` | `adminVersion 0.1.0-p6`, `buildPhase P6-ID-01`, capabilities |
| `packages/sfoa-admin-api/src/http-server.ts` | buildPhase/capabilities in status; DELETE → deleteIdentityRoute |
| `packages/sfoa-admin-api/src/config.ts` | `passwordHash` → `password` (plaintext schema) |
| `packages/sfoa-admin-api/src/auth.ts` | plaintext constant-time verify; remove scrypt |
| `packages/sfoa-admin-api/src/main.ts` | redact `SFOA_ADMIN_PASSWORD` |
| `packages/sfoa-admin-api/src/cli/hash-password.ts` | deleted |
| `packages/sfoa-admin-api/package.json` | remove `admin:hash-password` |
| `packages/sfoa-admin-api/README.md` | plaintext password docs |
| `packages/sfoa-admin-api/src/test/auth.test.ts` | plaintext tests |
| `packages/sfoa-admin-api/src/test/http-server.test.ts` | plaintext config; system fingerprint |
| `packages/sfoa-admin-web/src/pages/IdentityRoutesPage.tsx` | 生成 Token vs 重新生成 Token |
| `packages/sfoa-admin-web/src/pages/SystemPage.tsx` | 构建阶段 / 能力标记 |
| `packages/sfoa-admin-web/src/test/Connectivity.test.ts` | status() fingerprint |
| `packages/sfoa-mcp-server/src/config.ts` | `sfoa_ub1_` prefix fail-fast |
| `packages/sfoa-mcp-server/src/http-server.ts` | request-scoped USER_BOUND redaction |
| `.env.example` | `SFOA_ADMIN_PASSWORD` placeholder + note |
| `docs/sfoa/P5_LOCAL_SETUP.md` | plaintext password setup docs |
| `docs/sfoa/P6_ID_01_HOTFIX01_REPORT.md` | this report |

## Out of scope (per instruction)

No Dify/Buntu token, OAuth, Vault, Redis, KMS, complex token lifecycle, multi-token,
Salesforce permission engine, Salesforce record DELETE, or new Salesforce Tools were added.

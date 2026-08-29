# P6-ID-02 BUNTU_TOKEN Identity

Status: implemented; acceptance evidence is recorded in `P6_ID_02_REPORT.md`.

## Architecture

P6-ID-02 adds a third trusted identity source — the Dify / 小犇 real-user bearer (`BUNTU_TOKEN`) — without redesigning Salesforce identity routing. `BUNTU_TOKEN` is responsible only for `Token -> platformUserId`; the effective platform user still flows through the accepted P1-P5 `sfoa_identity_route` boundary:

```text
                        IdentityProvider
                              |
          +-------------------+-------------------+
          |                   |                   |
 Internal service        USER_BOUND          BUNTU bearer
 bearer                 route-bound         validate-token
 + trusted platform      token               -> data.userId
   Header                 (sfoa_ub1_*)       (only when enabled)
          |                   |                   |
          +-------------------+-------------------+
                              |
                  Effective platformUserId
                              |
                       Identity Route
                              |
                 current Salesforce Username
                              |
                   fresh JWT / Connection
                              |
                         Salesforce
```

The unified principal carries `clientId`, `identitySource`, `platformUserId`, and an optional safe `credentialId`. Buntu authentication completes before body processing, policy-snapshot loading, JWT construction, or Tool execution. `clientId=xiaoben-buntu-token`, `identitySource=BUNTU_TOKEN`.

Because the Buntu provider returns `boundPlatformUserId`, a Dify client supplies only the Buntu bearer; it does not need `X-Platform-User-Id`. If a platform Header is nevertheless supplied it must match the validated `data.userId` or authentication fails with `MCP_IDENTITY_CONTEXT_MISMATCH` (same rule as USER_BOUND).

## Deterministic provider routing

`UnifiedIdentityProvider` selects the first authenticator whose `supports(token)` is true. To keep the three providers mutually exclusive, deterministic and testable, `supports()` now implements the following closed decision table (timing-safe digest comparison for the internal client token):

| Case | Condition | Provider |
| --- | --- | --- |
| 1 | `token` starts with `sfoa_ub1_` | `USER_BOUND` |
| 2 | `token` exactly matches `MCP_CLIENT_TOKEN` | `INTERNAL_SERVICE_HEADER` |
| 3 | `token` exists, is neither case 1 nor 2, and `MCP_BUNTU_IDENTITY_ENABLED=true` | `BUNTU_TOKEN` |
| 4 | otherwise | `MCP_CLIENT_AUTH_INVALID` |

This fixes the previous over-broad `InternalServiceCredentialAuthenticator.supports()` ("token is not `sfoa_ub1_*` -> true"), which used to intercept Buntu tokens and fail them. `MCP_CLIENT_TOKEN` never enters logs; comparison is timing-safe via SHA-256 digests.

## Buntu validate-token contract

When the Buntu provider is selected, every request calls the remote validator once — there is no token cache in this phase:

```http
GET <MCP_BUNTU_VALIDATE_TOKEN_URL>
Accept: application/json
Authorization: Bearer <raw token>
```

The confirmed upstream contract (verified against the real Buntu service by the Maintainer, P6-ID-02 HOTFIX02):

```json
{
  "success": true,
  "data": {
    "userId": "<platform user id>",
    "userName": "...",
    "expiresAt": 1787640358
  }
}
```

Only `success` and `data.userId` participate in identity decisions:

- `data.userId` is the only identity primary key; it may arrive as a `string` (`"62001"`) or a safe integer `number` (`62001`), is normalized with `String(...)` when numeric, and must then pass the shared `platformUserIdSchema` (trimmed, 1..128 chars, no control characters). Floats, NaN, Infinity, booleans, objects, arrays, null, and the empty string are rejected.
- `data.userName` is display metadata only and must never be routed to a Salesforce username. The chain is always `data.userId -> platformUserId -> sfoa_identity_route -> Salesforce Username`.
- `data.expiresAt` is deliberately ignored; the validate-token API is the identity authority and the runtime never builds a second token-expiry rule.
- The legacy top-level `user_id` assumption is **wrong** and is not parsed. No recursive search for `userId` / `user_id` / `id` / `username` is performed.

Failures classify as follows:

| Observation | Error code | HTTP |
| --- | --- | --- |
| 401/403, or HTTP 2xx with `success: false` | `MCP_BUNTU_TOKEN_INVALID` | 401 |
| timeout / DNS / TCP / TLS / non-2xx upstream | `MCP_BUNTU_IDENTITY_UNAVAILABLE` | 502 |
| invalid JSON, body > 64 KiB, `success: true` without `data` / `data.userId`, or `userId` fails the platform schema | `MCP_BUNTU_IDENTITY_RESPONSE_INVALID` | 502 |

Every 401 response carries `WWW-Authenticate: Bearer` so MCP clients (including Xiaoben) can distinguish an authentication failure from an unavailable identity provider.

The validator is fail-closed: no fallback identity, no legacy pass-through, and Buntu is never treated as Internal. `MCP_CLIENT_AUTH_INVALID` remains the only outcome when no provider matches.

## Configuration

New variables in `MCP_AUTH_MODE=internal_bearer` mode (validated by `loadRemoteRuntimeConfig`):

```dotenv
MCP_BUNTU_IDENTITY_ENABLED=false
MCP_BUNTU_VALIDATE_TOKEN_URL=
MCP_BUNTU_VALIDATE_TIMEOUT_MS=5000
MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED=false
```

Validation rules:

- `MCP_BUNTU_IDENTITY_ENABLED=true` requires `MCP_AUTH_MODE=internal_bearer` (otherwise the Buntu provider would be shadowed by the loopback/disabled path).
- `MCP_BUNTU_VALIDATE_TOKEN_URL` is required when enabled; it must be an absolute credential-free `http(s)` URL with no query or fragment.
- `MCP_BUNTU_VALIDATE_TIMEOUT_MS` is bounded to 500..30 000 and applied with `AbortController`; the timer is cleared in `finally`.
- TLS verification is never disabled; `NODE_TLS_REJECT_UNAUTHORIZED=0` / `rejectUnauthorized=false` are forbidden.

Startup logs report the wired identity sources (safe names only), e.g. `USER_BOUND`, `INTERNAL_SERVICE_HEADER`, and — when enabled — `BUNTU_TOKEN`. The validate URL and any token are never logged.

## Audit and secret boundary

Every Buntu validation emits a `BUNTU_TOKEN_VALIDATE` audit record:

- `clientId=xiaoben-buntu-token`, `identitySource=BUNTU_TOKEN`;
- `requestSummary`: `provider: 'BUNTU'`, `tokenFingerprint` (sha256 digest), `tokenLast4`, and `validationUrl`; raw token is never included;
- `responseSummary`: `valid`, optional `httpStatus`, optional `upstreamSuccess` (the upstream `success` field, only when a parseable 2xx business response was received), and on success the normalized `userId` plus `userIdType` (`string` | `number`, the original JSON primitive type of `data.userId`). The upstream `userName` is never copied into the audit;
- `durationMs` covers the remote validate round-trip; `result`/`outcome` map to PASS/SUCCESS, or BLOCKED/DENIED on `MCP_BUNTU_TOKEN_INVALID`, or ERROR/FAILED on unavailable/invalid-response.

P7 security supersession (2026-08-29): raw Bearer-token persistence is permanently prohibited. The legacy `MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED` key remains accepted only as `false`; `true` fails startup validation. Migration `005_p7_end_to_end_audit.sql` removes the known historical `requestSummary.rawToken` field, while repository sanitization and the Admin UI provide defense in depth. The database fallback path and every stdout/stderr/HTTP response remain token-free by construction (`DatabaseRuntimeLogger` fallback never writes `requestSummary`/`responseSummary`).

## Admin presentation

The Audit page adds a "身份来源" column and drawer row with a Chinese label map (`INTERNAL_SERVICE_HEADER` -> 内部服务凭据, `USER_BOUND_TOKEN` -> 用户绑定 Token, `BUNTU_TOKEN` -> 小犇 Token). A `BUNTU_TOKEN_VALIDATE` record shows a dedicated detail block: 校验结果, 平台用户编号, 上游 HTTP 状态, 校验接口耗时, Token 尾号, Token Fingerprint, 校验时间, 校验接口地址. When the raw-token flag was enabled the drawer shows a warning banner ("原始 Token 已记录") and the raw value appears only inside the bounded JSON pre block.

## Error codes

New stable codes: `MCP_BUNTU_TOKEN_INVALID`, `MCP_BUNTU_IDENTITY_UNAVAILABLE`, `MCP_BUNTU_IDENTITY_RESPONSE_INVALID`. HTTP mapping: `MCP_BUNTU_TOKEN_INVALID` -> 401; the two upstream failures -> 502. Route resolution failures reuse `MCP_IDENTITY_ROUTE_NOT_FOUND` (403) and `MCP_IDENTITY_ROUTE_DISABLED` (403); `MCP_IDENTITY_CONTEXT_MISMATCH` applies to a mismatched bound header.

## Verification

Focused HOTFIX02 gate:

```powershell
yarn workspace @sfoa/mcp-server build
node --test dist/test/buntu-validator.test.js
node --test dist/test/buntu-safety.test.js
node --test dist/test/identity-provider.test.js
node --test dist/test/http-integration.test.js
```

Focused evidence: `dist/test/buntu-validator.test.js` (confirmed `{ success, data.userId }` contract and CASE 1-7 classification), `dist/test/buntu-safety.test.js` (redaction, 401 challenge, concurrency isolation), `dist/test/identity-provider.test.js` (provider routing, route resolution, audit, USER_BOUND/Internal regression), `dist/test/http-integration.test.js` (HTTP auth challenge). See `P6_ID_02_HOTFIX02_REPORT.md` for the actual PASS/FAIL record.

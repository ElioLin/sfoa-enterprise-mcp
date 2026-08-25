# P6-ID-02 HOTFIX02 — Real Buntu Response Contract & Xiaoben Live Compatibility

- Report date: 2026-08-25
- Branch: `feature/p6-id-user-bound-credential`
- P6-ID-02 implementation baseline: `a2aefba` (feat: add BUNTU_TOKEN identity provider (P6-ID-02))
- P6-ID-02 HOTFIX01 baseline: `63b9522` (fix: close Buntu identity concurrency and safety gaps)
- Scope: minimal contract-alignment HOTFIX, not a feature expansion

## Result

`P6-ID-02 HOTFIX02 = PASS` (deterministic focused tests, local closure)

`REAL XIAOBEN MCP = PENDING MAINTAINER RETEST` (no live Dify / 小犇 endpoint was contacted, per instruction)

## Root Cause

```
CURRENT VALIDATOR EXPECTED TOP-LEVEL user_id,
REAL BUNTU CONTRACT RETURNS data.userId
```

The validator implemented in P6-ID-02 (`buntu-validator.ts`) parsed `{ user_id }` at the
top level of the validate-token response body. The **real** Buntu (小犇 / Dify) service
does not return `user_id`; it returns a nested camelCase contract:

```json
{
  "success": true,
  "data": {
    "userId": "<platform user id>",
    "userName": "<display only, never routed>",
    "expiresAt": 1787640358
  }
}
```

Because `user_id` never appears in the real payload, every real token was classified as
`MCP_BUNTU_IDENTITY_RESPONSE_INVALID` (missing top-level `user_id`) — i.e. a working
Xiaoben deployment could never authenticate. HOTFIX02 aligns the validator with the
confirmed real contract.

## Real Buntu Contract

`CONFIRMED` (by the Maintainer against the real Buntu service; recorded in
`docs/sfoa/P6_ID_02_BUNTU_TOKEN_IDENTITY.md`):

| Field | Meaning | Identity role |
| --- | --- | --- |
| `success` | `true` = business accept, `false` = business rejection | `success: false` -> `MCP_BUNTU_TOKEN_INVALID` (401) |
| `data.userId` | platform user id, `string` or safe integer `number` | **the only identity primary key** |
| `data.userName` | display metadata only | never routed; never copied into audit |
| `data.expiresAt` | upstream token expiry | deliberately ignored; validate-token is the identity authority |

Constraints honored:

- Only `response.success` and `response.data.userId` participate in identity decisions;
  no recursive scan for `userId` / `user_id` / `id` / `username`.
- `userId` accepts `string` (non-empty) or safe integer `number`; floats, NaN, Infinity,
  booleans, objects, arrays, `null`, and the empty string are rejected.
- Numeric `userId` is normalized via `String(...)`, then validated by the shared
  `platformUserIdSchema` (trimmed, 1..128 chars, no control characters).
- The legacy top-level `user_id` format is **not** parsed (fail-closed, no compatibility shim).
- `expiresAt` is not interpreted; `userName` is never used for routing.
- No token cache: every request still re-validates.

## Error classification (unchanged semantics, corrected contract)

| Observation | Error code | HTTP |
| --- | --- | --- |
| 401/403, or HTTP 2xx with `success: false` | `MCP_BUNTU_TOKEN_INVALID` | 401 + `WWW-Authenticate: Bearer` |
| timeout / DNS / TCP / TLS / non-2xx upstream | `MCP_BUNTU_IDENTITY_UNAVAILABLE` | 502 |
| invalid JSON, body > 64 KiB, `success: true` without `data` / `data.userId`, or `userId` fails the platform schema | `MCP_BUNTU_IDENTITY_RESPONSE_INVALID` | 502 |

## Changes

| File | Change |
| --- | --- |
| `packages/sfoa-mcp-server/src/buntu-validator.ts` | schema from `{ user_id }` to `{ success, data: { userId } }`; `z.string().min(1)` + safe-integer union; `upstreamSuccess` / `userIdType` added to `BuntuValidationResult`; JSDoc documents the confirmed real contract |
| `packages/sfoa-mcp-server/src/authenticator.ts` | `BUNTU_TOKEN_VALIDATE` audit `responseSummary` now carries `upstreamSuccess` and `userIdType` alongside `valid` / `httpStatus` / `userId` |
| `packages/sfoa-mcp-server/src/http-server.ts` | every 401 now sends `WWW-Authenticate: Bearer` (guarded by `!response.headersSent` so streamed responses never throw `ERR_HTTP_HEADERS_SENT`) |
| `packages/sfoa-mcp-server/src/config.ts` | HOTFIX01 comment updated to the confirmed `data.userId` contract (no logic change) |
| `packages/sfoa-mcp-server/src/test/buntu-validator.test.ts` | fixtures moved to `{ success, data.userId }`; CASE 1-7 focused contract tests; legacy `user_id` rejected |
| `packages/sfoa-mcp-server/src/test/buntu-safety.test.ts` | new case: rejected Buntu token -> HTTP 401 with `WWW-Authenticate: Bearer` challenge, no token leak |
| `packages/sfoa-mcp-server/src/test/identity-provider.test.ts` | stub results carry `upstreamSuccess` / `userIdType`; `responseSummary` assertions; success=false audited as business rejection |
| `packages/sfoa-mcp-server/src/test/http-integration.test.ts` | 401 assertions now also check `www-authenticate: Bearer` |
| `docs/sfoa/P6_ID_02_BUNTU_TOKEN_IDENTITY.md` | contract section rewritten to the confirmed real contract; verification commands updated |
| `docs/sfoa/P6_ID_02_HOTFIX02_REPORT.md` | this report |

## Focused contract cases (buntu-validator.test.js)

| CASE | Input | Expected | Result |
| --- | --- | --- | --- |
| 1 | `200 { success: true, data: { userId: '62001' } }` | PASS, `userId='62001'`, `userIdType='string'` | PASS |
| 2 | `200 { success: true, data: { userId: 62001 } }` | PASS, `userId='62001'`, `userIdType='number'` | PASS |
| 3 | `200 { success: false, data: {...} }` | `MCP_BUNTU_TOKEN_INVALID` (401) | PASS |
| 4 | `200 { success: true }` (no data) | `MCP_BUNTU_IDENTITY_RESPONSE_INVALID` (502) | PASS |
| 5 | `200 { success: true, data: {} }` (no userId) | `MCP_BUNTU_IDENTITY_RESPONSE_INVALID` (502) | PASS |
| 6 | `200 { success: true, data: { userId: {} } }` (object) | `MCP_BUNTU_IDENTITY_RESPONSE_INVALID` (502) | PASS |
| 7 | `200 { success: true, data: { userId: 62001.5 } }` (float) | `MCP_BUNTU_IDENTITY_RESPONSE_INVALID` (502) | PASS |
| legacy | `200 { user_id: '62001' }` (old wrong format) | `MCP_BUNTU_IDENTITY_RESPONSE_INVALID` (no `success` -> contract error) | PASS |

## Test evidence

| Gate | Command | Result |
| --- | --- | --- |
| `@sfoa/mcp-server` build | package-local `node ./node_modules/typescript/bin/tsc -p tsconfig.json` | PASS (exit 0, 0 errors) |
| Focused tests | `node --test --test-concurrency=1 dist/test/buntu-validator.test.js dist/test/buntu-safety.test.js dist/test/identity-provider.test.js dist/test/http-integration.test.js` | **31/31 pass, 0 fail** (duration ~133 s) |

Focused coverage: Buntu validator contract (CASE 1-7, legacy rejection, HTTP
401/403/5xx/timeout/oversize, fingerprint/last4), Buntu safety (config fail-fast,
redaction CASE A-D, 401 `WWW-Authenticate` challenge, concurrency isolation ×4,
provider crosstalk), identity provider (provider routing, route resolution, Buntu
routing/fail-closed/audit, success=false audited as business rejection,
USER_BOUND / Internal regression), HTTP integration (401 challenge assertions).

Full P0-P5 regression was intentionally not run (per instruction). No real Buntu
(Dify / 小犇) endpoint was contacted.

## Security boundary confirmation

| Boundary | State |
| --- | --- |
| Token cache / Redis / OAuth / Gateway | NOT ADDED (0) |
| Official Salesforce TypeScript Provider modified | 0 |
| Upstream-owned files modified | 0 |
| `MCP_BUNTU_TOKEN=` static config | NOT ADDED |
| `expiresAt` interpreted / second expiry rule | NOT ADDED |
| `userName` mapped to Salesforce username | NOT ADDED |
| Legacy `user_id` compatibility shim | NOT ADDED (fail-closed) |
| Audit feature expansion beyond `upstreamSuccess` / `userIdType` | 0 |
| Real Buntu live validation | **NOT TESTED — BY MAINTAINER DECISION** (Maintainer Live Gate = REQUIRED) |
| Test tokens | `fake-buntu-token-*`, `TEST_CLIENT_TOKEN`, `sfoa_ub1_`-prefixed fixture — all fake, no real secrets |
| `.env.local` / real credentials | untouched |

## Git

- Commit message: `fix: align Buntu validator with real response contract`
- Branch: `feature/p6-id-user-bound-credential` (no merge to main)
- Secret scan of the commit diff: no real tokens, passwords, private keys, or
  `.env.local` values are included (fake fixtures only).

## Out of scope (per instruction)

No Buntu feature expansion, no OAuth Server, no `/register`, no Salesforce Tool
changes, no redesign of the USER_BOUND WorkBuddy identity line, no redesign of the
Identity Provider, no P0-P5 full regression, no admin-api / admin-web / control-plane
suites, no validate:p5, no Playwright, no real 小犇 live testing, no `.env.local` or
real credential changes, no new `MCP_BUNTU_TOKEN=` configuration.

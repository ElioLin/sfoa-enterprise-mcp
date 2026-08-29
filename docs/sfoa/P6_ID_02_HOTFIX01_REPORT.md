# P6-ID-02 HOTFIX01 — Buntu Identity Safety & Concurrency Closure

- Report date: 2026-08-25
- Branch: `feature/p6-id-user-bound-credential`
- P6-ID-02 implementation baseline: `a2aefba` (feat: add BUNTU_TOKEN identity provider (P6-ID-02))
- Scope: minimal closure HOTFIX (安全与并发收口), not a feature expansion

> **P7 security supersession (2026-08-29):** this report intentionally preserves the historical P6 HOTFIX result. P7 permanently removes the former raw-token audit switch: enabling it now fails startup, new Runtime audit never emits `rawToken`, and migration 005 scrubs the known historical field.

## Result

`P6-ID-02 IMPLEMENTATION = PASS`
`P6-ID-02 MAINTAINER LIVE GATE = PENDING`

Four gaps identified by code review are closed and verified with deterministic
focused tests. No Buntu feature was expanded, no new identity system was added, no
token cache/Redis/OAuth/Gateway was introduced, and no official Salesforce
Provider was modified.

## HOTFIX coverage checklist

| # | HOTFIX | Result | Where |
| --- | --- | --- | --- |
| 1 | Buntu raw bearer token enters request-local secret redaction (exception messages / safe errors / fallback errors → HTTP response, stdout, stderr, structured log all redacted); the historical rawToken switch evidence is superseded by P7 | PASS | `packages/sfoa-mcp-server/src/http-server.ts` — `captureRequestBearerSecrets()` now captures **every** Bearer token (USER_BOUND `sfoa_ub1_*`, BUNTU, plus legacy `MCP_CLIENT_TOKEN` as defense in depth) and is exported for tests |
| 2 | `MCP_BUNTU_IDENTITY_ENABLED=true` + `SFOA_CONTROL_PLANE_MODE != mysql` fails fast at configuration load (`MCP_RUNTIME_CONFIGURATION_INVALID`); the runtime can no longer start with a Buntu provider that was never wired | PASS | `packages/sfoa-mcp-server/src/config.ts` — added `BUNTU_TOKEN identity requires SFOA_CONTROL_PLANE_MODE=mysql.` fail-fast after `parseBuntuIdentityConfig` |
| 3 | `user_id` accepts `string` or safe-integer `number`, normalized via `String()` into the shared `platformUserIdSchema`; floats/NaN/Infinity/boolean/object/array/null rejected; no `z.coerce.string()`, no recursive scanning, no guessing from `data.user.id` | PASS | `packages/sfoa-mcp-server/src/buntu-validator.ts` — `z.union([z.string(), z.number().refine(Number.isSafeInteger)])` + explicit normalization |
| 4 | Deterministic three-layer concurrency isolation tests (provider / route / request-scope) plus provider no-crosstalk verification | PASS | `packages/sfoa-mcp-server/src/test/buntu-safety.test.ts` (new file, 9 tests) |

## HOTFIX 1 — redaction boundary (CASE A/B/C/D)

- CASE A (HTTP error response + request audit): a leaky validator that throws an
  exception message containing the raw Buntu token, and a leaky USER_BOUND stub, both
  produce responses containing `<redacted>` and never the raw token; the request-level
  audit events JSON contains neither token. **PASS**
- CASE B (text/log surface): `captureRequestBearerSecrets({ headers: { authorization: 'Bearer ...' } })`
  returns the Buntu token, `formatRemoteRuntimeError` redacts it, a simulated structured
  log line JSON contains no token, and empty/Basic authorization headers yield `[]`. **PASS**
- CASE C (`MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED=false`): the `BUNTU_TOKEN_VALIDATE` audit
  event's `requestSummary` carries no `rawToken` key and the events JSON contains no
  token. **PASS**
- CASE D (historical P6 `MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED=true` + simulated MySQL write failure): the
  durable sink receives `requestSummary.rawToken` (DB audit boundary, opt-in only), while
  the `DatabaseRuntimeLogger` fallback events never contain the token and always carry
  `requestSummary === undefined && responseSummary === undefined` with errorCode
  `MCP_AUDIT_PERSISTENCE_FAILED`. **PASS**

At the time of this historical HOTFIX, the rawToken audit switch still persisted the full
token only into the MySQL `BUNTU_TOKEN_VALIDATE` summary while the fallback logger stayed
safe. P7 supersedes that behavior completely: raw-token persistence is prohibited and the
legacy key is accepted only as `false`.

## HOTFIX 2 — configuration fail-fast matrix

| Scenario | Expected | Result |
| --- | --- | --- |
| `SFOA_CONTROL_PLANE_MODE=env` + `MCP_BUNTU_IDENTITY_ENABLED=true` | rejects `MCP_RUNTIME_CONFIGURATION_INVALID`, message contains `BUNTU_TOKEN identity requires SFOA_CONTROL_PLANE_MODE=mysql.` | PASS |
| `env` + Buntu disabled | loads | PASS |
| `mysql` (fake DB env) + Buntu disabled | loads | PASS |
| `mysql` + Buntu enabled | loads with `buntuIdentity.enabled=true` and the configured `validateTokenUrl` | PASS |

## HOTFIX 3 — user_id primitive compatibility

| Input `user_id` | Result |
| --- | --- |
| `'61979'` (string) | accepted → `'61979'` |
| `61979` (safe integer) | accepted → `'61979'` (normalized via `String()`) |
| `0` (safe integer) | accepted → `'0'` |
| `61979.5` (float) | rejected `MCP_BUNTU_IDENTITY_RESPONSE_INVALID` |
| `null`, `true`, `{}`, `[]` | rejected `MCP_BUNTU_IDENTITY_RESPONSE_INVALID` |
| `''`, `'has\u0000control'` | rejected (shared `platformUserIdSchema` rules) |
| missing key (2xx JSON object without `user_id`) | `MCP_BUNTU_IDENTITY_TOKEN_INVALID` |

Error classification is unchanged: absent `user_id` → TOKEN_INVALID; present but
wrong type/format → RESPONSE_INVALID.

## HOTFIX 4 — quantified concurrency results

All tests use per-token / per-user `setTimeout` delays to force deterministic
out-of-order completion, with `Promise.all` real concurrency inside each round
(no reliance on runner-level `--test-concurrency`).

| Layer | Setup | Volume | Mismatches | Result |
| --- | --- | --- | --- | --- |
| 1. Provider (`BuntuTokenCredentialAuthenticator`) | Token-A 120ms → user-A, Token-B 10ms → user-B, Token-C 70ms → user-C | **300 authentications** (100 rounds × 3) | **identity mismatch = 0** | PASS |
| 1. Completion order | per-round slice of `validator.completionOrder` | 100 rounds | every round completes `[B, C, A]` (真乱序) | PASS |
| 2. Identity route (`IdentityRouteRepository.getByPlatformUserId`) | route lookups delayed A=30ms / B=90ms / C=10ms | **300 route resolutions** (100 rounds × 3) | **route mismatch = 0**, identity mismatch = 0 | PASS |
| 3. Request scope / Connection (`scopeFactory.createForRoute` + injectable fake ConnectionFactory) | connection creation delayed SF-A=80ms / SF-B=10ms / SF-C=45ms | **90 request scopes + 90 connection identity checks** (30 rounds × 3) | **scope mismatch = 0, connection mismatch = 0** | PASS |
| 4. Provider crosstalk (USER_BOUND / INTERNAL / Buntu concurrent) | 25 rounds × 3 providers = **75 concurrent authentications** | 75 | 0 boundary crossings; Buntu validator saw exactly 25 × `fake-buntu-token-b`; USER_BOUND `tokenHashLookups = 25` (Buntu never triggers a USER_BOUND credential lookup) | PASS |

Layer 3 uses the existing injectable `SalesforceConnectionFactory` seam
(`RecordingConnectionFactory` subclass), so no production refactoring was required;
the deterministic Connection-level isolation is therefore genuinely exercised, not
waived.

## Shared mutable identity state audit

Production-source search for `currentToken / currentUser / currentUserId /
currentPlatformUserId / currentRoute / currentConnection / lastToken / lastUser`
assignments across `packages/sfoa-mcp-server/src` and
`packages/sfoa-identity-runtime/src`: **0 matches**. Identity state is
request-scoped or method-local; no process-scoped mutable identity fields exist.

## Test evidence

| Gate | Command | Result |
| --- | --- | --- |
| `@sfoa/control-plane` build | package-local `tsc -p tsconfig.json` | PASS (exit 0, 0 errors) |
| `@sfoa/mcp-server` build | package-local `tsc -p tsconfig.json` | PASS (exit 0, 0 errors) |
| Focused tests | `node --test --test-concurrency=1 dist/test/buntu-validator.test.js dist/test/buntu-safety.test.js dist/test/identity-provider.test.js` | **27/27 pass, 0 fail** (duration 88,750 ms) |

Focused coverage: Buntu validator contract (HTTP 2xx/401/403/timeout/oversize,
user_id compatibility, fingerprint/last4), Buntu safety (config fail-fast ×4,
redaction CASE A–D, concurrency ×4), and the USER_BOUND / INTERNAL bearer focused
regression (mixed-provider compatibility, USER_BOUND A/B identity + forgery
rejection, route lifecycle, Buntu routing/fail-closed/audit/denied-audit).

Full P0–P5 regression was intentionally not run (per instruction). No real Buntu
(Dify/小犇) endpoint was contacted.

## Security boundary confirmation

| Boundary | State |
| --- | --- |
| Token cache / Redis / OAuth / Gateway | NOT ADDED (0) |
| Official Salesforce TypeScript Provider modified | 0 |
| Upstream-owned files modified | 0 |
| `MCP_BUNTU_TOKEN=` static config | NOT ADDED |
| Audit feature expansion beyond rawToken switch | 0 |
| Real Buntu live validation | **NOT TESTED — BY MAINTAINER DECISION** (Maintainer Live Gate = REQUIRED) |
| Test tokens | `fake-buntu-token-a/b/c`, `TEST_CLIENT_TOKEN`, `sfoa_ub1_`-prefixed fixture — all fake, no real secrets |
| `.env.local` / real credentials | untouched |

## Git

- Commit message: `fix: close Buntu identity concurrency and safety gaps`
- Branch: `feature/p6-id-user-bound-credential` (no merge to main)
- Changed files:

| File | Change |
| --- | --- |
| `packages/sfoa-mcp-server/src/http-server.ts` | `captureRequestBearerSecrets` captures all Bearer tokens; exported for tests; docs |
| `packages/sfoa-mcp-server/src/config.ts` | Buntu + non-mysql Control Plane fail-fast |
| `packages/sfoa-mcp-server/src/buntu-validator.ts` | `user_id` string \| safe-integer union + normalization |
| `packages/sfoa-mcp-server/src/test/buntu-validator.test.ts` | float rejection case + string/safe-integer compatibility test |
| `packages/sfoa-mcp-server/src/test/buntu-safety.test.ts` | new: config fail-fast, redaction CASE A–D, 3-layer concurrency, provider crosstalk (9 tests) |
| `docs/sfoa/P6_ID_02_HOTFIX01_REPORT.md` | this report |

Secret scan of the commit diff: no real tokens, passwords, private keys, or
`.env.local` values are included (fake fixtures only).

## Out of scope (per instruction)

No Buntu feature expansion, no new identity system, no token cache/Redis/OAuth/Gateway,
no modification of official Salesforce Providers, no P0–P5 full regression, no real
小犇 live testing, no `.env.local` or real credential changes, no new
`MCP_BUNTU_TOKEN=` configuration, no audit feature expansion.

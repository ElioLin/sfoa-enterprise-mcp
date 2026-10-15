# ADR-0034: Scoped Console accounts — the module contract, the default-deny endpoint table, and the Console's own guard

- Status: Accepted for P11 (console access control)
- Date: 2026-10-15
- Extends: ADR-0017 (the Admin API boundary: signed session cookie, CSRF header, exact-Origin
  assertion, per-account login window), the P7 audit model (`channel = 'ADMIN'` ⇔
  `auditKind = 'ADMIN_ACTION'`, `actor_admin`), and the P6 Console navigation contract pinned by
  `packages/sfoa-admin-web/src/test/Localization.test.ts`
- Scope constraint: the requirement this ADR answers is **console account access only**. No Tool
  contract, no MCP-side read or write path, and no Tool behaviour changes; the single
  control-plane read path touched is the audit search filter in §5.

## Context

The Console has authenticated with **one fixed account** since P5: `SFOA_ADMIN_USERNAME` +
`SFOA_ADMIN_PASSWORD` from the Admin API configuration, compared in constant time, exchanged for a
signed `HttpOnly; SameSite=Strict` cookie. Whoever holds that password sees everything — all nine
pages, including Tool governance, DML policy, the diagnostic identity, and the UI context snapshots.

A second role, **BTIT**, now needs a Console account of its own. The requirement is explicit about
what it is not: because the Admin backend configures very few personnel roles, **there is to be no
user-management module** — no account table, no roles, no invitations, no password reset. The
account is configured in the configuration file next to the Admin account, and it may use exactly
five modules: 用户身份路由, 运行概览, 调用审计, 系统状态, 智能体接入.

Four facts about the existing system shaped every decision below, and each was measured rather than
assumed:

- **There is no authorization layer to extend.** The Admin API authenticates and then dispatches:
  `handleRequest` validates the session, asserts the Origin, asserts CSRF on mutations, and calls
  `dispatchAuthenticated`, whose router is a hand-rolled if-chain over `method + pathname`. Nothing
  between authentication and dispatch knows which page a caller is on. Every line of module
  authorization in this ADR is new.
- **nginx collapses the login client address.** The Console reaches the Admin API through a reverse
  proxy, so `socket.remoteAddress` is always `127.0.0.1`. The existing login limiter is keyed on that
  address, which makes it a **global** lockout: one account's failed attempts already stop every
  other account from signing in.
- **The Console navigation is a pinned contract.** `ADMIN_NAVIGATION` in
  `packages/sfoa-admin-web/src/components/AdminShell.tsx` is a nine-entry array whose labels
  `Localization.test.ts` asserts verbatim. A second list of "which page belongs to which module"
  would be a second thing to keep in step.
- **`actor_admin` is written but never read.** `sfoa_audit_log` has carried `actor_admin` since P7
  and the audit workbench renders it on a card, but no query filters on it — there was only ever one
  account, so there was nothing to filter by.

## Decision

### 1. A module is identified by its Console route, and the nine ids are the contract

`ADMIN_MODULE_IDS` (`packages/sfoa-control-plane/src/admin-contracts.ts`) lists the nine module ids
in Console navigation order:

```
dashboard · identity-routes · tool-governance · dml-policies · diagnostic ·
ui-context · audit · system · agent-integration
```

Each id is the Admin Web route without its leading slash, so no mapping table exists between "the
page at `/audit`" and "the module `audit`" — the route *is* the module. Adding a tenth page means
adding its id to this array, adding its path set in the Admin API (§2), and adding its route in the
Console; the Console derives the module a page belongs to from the path itself, so the guard covers
a new route without a second annotation.

`ADMIN_MODULE_IDS` order **is** navigation order, which `ConsoleModules.test.ts` pins against
`ADMIN_NAVIGATION`. The landing rule in §6 is written in terms of "the first module the account
holds", so if the two orders ever disagreed a scoped account would land on a page that is not its
first menu entry.

### 2. Authorization is an explicit endpoint table, default-deny

`packages/sfoa-admin-api/src/module-paths.ts` maps each module to the Admin API endpoints it owns,
addressed as HTTP **method + path pattern** (`:name` matches exactly one non-empty path segment):

| Module | Endpoints |
| --- | --- |
| `dashboard` | `GET /dashboard` |
| `identity-routes` | `GET·POST /routes`, `POST /routes/batch`, `POST /routes/batch-verify`, `POST /routes/:id/verify`, `POST /routes/:id/disable`, `GET /routes/:id/credential`, `POST /routes/:id/credential/regenerate`, `PUT·DELETE /routes/:id`, `GET /system/settings` |
| `tool-governance` | `GET /tools`, `PUT /tools/:toolName` |
| `dml-policies` | `GET·POST /dml-policies`, `GET·POST /dml-policies/:id/managed-fields`, `POST /dml-policies/:id/managed-fields/:ruleId/disable`, `PUT·DELETE /dml-policies/:id/managed-fields/:ruleId`, `PUT·DELETE /dml-policies/:id` |
| `diagnostic` | `GET·PUT /diagnostic`, `POST /diagnostic/verify` |
| `ui-context` | `GET /ui-context/snapshots`, `POST /ui-context/:objectApiName/refresh`, `GET /system/settings`, `PUT /system/settings/:key` |
| `audit` | `GET /audits`, `GET /audits/:id`, `GET /audits/:id/trace`, `GET /audit-payloads/:id` |
| `system` | `GET /system/status`, `GET /system/settings`, `PUT /system/settings/:key` |
| `agent-integration` | `GET /system/status`, `GET /tools`, `GET /dml-policies`, `GET /dml-policies/:id/managed-fields` |

The table is **default-deny**: `endpointModules(pathname, method)` returns the ids that grant an
endpoint, and an endpoint registered in the router with no table entry returns an empty list. A
scoped account is therefore refused for it — and, because the refusal happens before the router
runs, the caller cannot distinguish "this path does not exist" from "this path is not mine".

The method is part of the address, not decoration: `GET /tools` is `tool-governance` and
`agent-integration` while `PUT /tools/:toolName` is `tool-governance` alone. A path-only table would
have handed the instruction page the ability to toggle Tools.

### 3. Two modules deliberately repeat another module's read-only endpoints

`identity-routes` and `agent-integration` each own endpoints that nominally belong elsewhere,
because the page they render does not work without them:

- **`identity-routes` also reads `GET /system/settings`.** `IdentityRoutesPage` reads the
  `adminDefaultPageSize` runtime setting to size its own pagination; without it the page renders
  with the wrong page size.
- **`agent-integration` also reads `GET /system/status`, `GET /tools`, `GET /dml-policies` and
  `GET /dml-policies/:id/managed-fields`.** The instruction generator renders the live Tool catalog,
  the DML policies, and their managed-field rules into the paste-ready configuration it hands to an
  Agent. A page whose entire purpose is to describe the current governance state cannot be built
  from a module that may not read that state.

All five are **reads of configuration**. The write counterparts — `PUT /tools/:toolName`,
`POST /dml-policies`, the managed-field rule mutations — stay with `tool-governance` and
`dml-policies`, so an account granted 智能体接入 can describe the governance state and cannot change
it. `PUT /system/settings/:key` is shared by `system` and `ui-context` for the same reason: both
pages write runtime settings, and the key itself is still validated against
`adminRuntimeSettingKeySchema` by the router.

### 4. Inside a module an account has exactly the Admin's authority; the bootstrap Admin is unrestricted

There is **one privilege tier inside a module**: an account granted 调用审计 can read every audit
record, including its payload evidence, exactly as the Admin can. Distinguishing "BTIT may read the
actor's own actions" from "may read all of them" would need a second axis of privileges and is not
part of the requirement.

The bootstrap Admin (`SFOA_ADMIN_USERNAME` / `SFOA_ADMIN_PASSWORD`) is marked `fullAccess: true` and
`assertModuleAccess` returns before consulting the table. This is deliberate and load-bearing: the
Admin's 404 for an unknown path and 405 for a wrong method are **existing, tested behaviour**, and a
naive "the caller must own this endpoint" gate would convert both into 403. Keeping `fullAccess`
also means the deployment can enable scoped accounts on a running server without changing what the
Admin sees.

### 5. Configuration: a JSON array in the same file, validated fail-fast

```dotenv
SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON=[{"username":"btit","password":"…","modules":["dashboard","identity-routes","audit","system","agent-integration"]}]
```

`loadAdminApiConfig` builds `config.accounts` as the bootstrap Admin followed by these entries, and
`AdminSessionManager` matches credentials against that list in constant time per account (every
account's password is compared, and the matched account is the one whose username *and* password
matched, so a wrong password does not leak which usernames exist).

Startup **fails** — the process does not serve — when the value is not a JSON array, holds more than
16 accounts, has an entry that is not exactly `{username, password, modules}`, repeats a module id,
uses an unknown module id, omits `modules`, or reuses a username case-insensitively (including the
bootstrap Admin's). Fail-fast was chosen over "ignore the bad entry" because every alternative
failure mode is worse than not starting: an ignored entry is an account that silently does not
exist, and a defaulted `modules` is an account that silently has access.

`modules` is mandatory and never defaults, so the shape of the configuration states the privilege
explicitly. Passwords are plaintext in the file, matching the bootstrap Admin — the file is the
secret store (`.env.local`, mode 600, `etc_t` under SELinux) and the process holds no key material.

### 6. The Console filters, refuses in place, and lands on a page the account holds

The Console reads `session.modules` from `GET /auth/me` and does three things with it:

- **Navigation** renders only the entries whose module the session holds, in the pinned order.
- **Every protected route** passes through one pathless `ModuleGuard`, which derives the module from
  `useLocation().pathname` and renders a `403` `Result` **in place** — no redirect. The address bar
  keeps telling the truth about what was requested, and the forbidden page never mounts, so it never
  issues the API calls whose refusal would look like an error rather than a boundary.
- **`/` and the post-login landing** resolve to the first module of `ADMIN_MODULE_IDS` the account
  holds. A requested page the account cannot open — a bookmark, or a link a colleague shared — is
  dropped in favour of that page rather than answered with a "no access" screen immediately after a
  successful sign-in.

None of this is a security boundary: the Admin API authorizes every request again, so a forged or
truncated module list in the browser changes nothing but the caller's own UI.

### 7. A denied request is refused with 403 and logged to stderr, not persisted

`MCP_ADMIN_FORBIDDEN` (403) is written to stderr as a one-line `warn` JSON record carrying the actor,
method, path (bounded to 256 characters) and correlation id, and is **not** written to
`sfoa_audit_log`. Two reasons:

- A refusal that never reached a handler is not an admin **action**; the audit table's
  `channel = 'ADMIN'` rows exist to answer "who changed what", and a denial changes nothing.
- Persisting denials would let any authenticated scoped account write rows into the master audit
  table at will, which is a cheap way to grow the one table the project treats as evidence.

The stderr record keeps the refusal diagnosable from `journalctl` without that cost. The
authentication failures that precede it (`MCP_ADMIN_AUTH_INVALID`, `MCP_ADMIN_CSRF_INVALID`,
`MCP_ADMIN_ORIGIN_NOT_ALLOWED`) already behave this way.

### 8. Login is limited per account, with a loose per-source backstop

`handleLogin` consumes **two** buckets:

- a **per-account** bucket keyed on `username.toLocaleLowerCase('en-US')` (usernames are unique
  case-insensitively, so the key and the account table agree), cleared on success; and
- a **per-source** bucket that is consumed **before the request body is read** and is **never**
  cleared on success, because it counts traffic rather than credential failures.

The per-source bucket exists because the proxy makes every request come from `127.0.0.1`: without a
loose cap there, a flood is invisible to the per-account limiter. It is set to
`loginMaxAttempts × 20` so it cannot become the global lockout the per-account bucket was introduced
to remove.

### 9. The audit workbench can filter by actor, and the filter has an index

`AdminAuditQuery` gains `actorAdmin`, `AuditFilter` gains the matching optional field, and
`search()` adds `where('actor_admin', '=', …)`. Migration
**`015_admin_audit_actor_index.sql`** adds `idx_sfoa_audit_actor (actor_admin, occurred_at DESC)`,
shaped like the sibling audit indexes in `002_p5_indexes.sql` and registered in `REQUIRED_INDEXES`
so the startup schema check fails loudly if it is ever dropped. The Console's 审计工作台 exposes it
as 操作人（控制台账号） in 更多筛选.

`AuditFilter.actorAdmin` is optional and additive; no MCP-side read path sets it, so the Tool-facing
audit behaviour is unchanged. The field is only meaningful for `channel = 'ADMIN'` rows, because
only those carry an actor.

## Consequences

- **Enabling a scoped account is a configuration edit plus a restart.** The configuration is frozen
  at startup, like every other Admin API setting, so an account cannot be added or revoked on a
  running process. Revoking one is safe and immediate in effect for *new* sessions only in the sense
  that a live cookie whose account has disappeared stops resolving: `AdminSessionManager.parse`
  rejects a session whose username is no longer in `config.accounts`, so removing an entry ends that
  account's sessions at the next request.
- **A module's endpoint list is a maintenance surface.** Add an endpoint to a module's page without
  adding it to the table and the page breaks for scoped accounts with a 403 that looks like a bug;
  `module-paths.test.ts` pins the table's coverage of every module id, its method sensitivity and
  its whole-segment matching, but it cannot know what a page fetches. The Console's own module guard
  and the API table are checked against each other by the real-browser full-stack test.
- **`fullAccess` is a flag on one account, not a role.** There is no way to configure a second
  full-access account. If that is ever needed, the honest change is to make `modules` optional for a
  full-access entry, not to add a role model.
- **The 403 page names the configuration key.** The Console's refusal screen tells the reader that
  an administrator can add the module in `SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON`. This is intentional:
  the account holder is an internal colleague, and the alternative is a support round-trip to
  discover the same sentence.
- **`/auth/login` and `/auth/me` now return `modules`.** A client that ignores the field keeps
  working; the Console is the only consumer.

## Verification

- `packages/sfoa-control-plane`: `mysql.integration.test.ts` asserts an `actorAdmin` search returns
  only that actor's rows and zero for an account that never acted.
- `packages/sfoa-admin-api`: `config.test.ts` (the configuration matrix above),
  `auth.test.ts` (per-account credentials, per-account module resolution, removal invalidates live
  sessions), `module-paths.test.ts` (coverage, method sensitivity, segment matching, default-deny),
  and `http-server.test.ts` (a scoped account reaches eleven of its module's endpoints and is
  refused three times with `MCP_ADMIN_FORBIDDEN`, including a denied mutation carrying a **valid**
  CSRF token, while the bootstrap Admin keeps its 404).
- `packages/sfoa-admin-web`: `ConsoleModules.test.ts` (path→module, landing order, requested-page
  fallback), `ModuleAccess.test.tsx` (a scoped session renders only its modules, answers a forbidden
  page with the 403 screen and **no** API call, lands on its first module at `/`).
- `scripts/p5-fullstack-e2e.mjs` starts a real Admin API with a real scoped account and asserts over
  HTTP: cross-account password rejection, the module list, nine reachable endpoints, three refusals
  with the exact error code, two denied mutations with a valid CSRF token, one in-module mutation
  that reaches validation instead of the gate, and the actor-filtered audit read. It then runs a
  real-browser test (`admin-fullstack.spec.ts`) that signs in as the scoped account, checks the
  navigation, requests a forbidden page directly, and watches the 操作人 filter reach the API.

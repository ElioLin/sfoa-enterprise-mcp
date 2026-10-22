# ADR-0035: Salesforce embedded CRM chat — Apex certificate bootstrap, a controlled access service, and a trusted OpenClaw CRM channel

- Status: Accepted for CRM OpenClaw Phase 1 (local implementation; environment verification pending)
- Date: 2026-10-22
- Extends: the request-scoped identity rule (P1), the channel-credential pattern established by
  `MCP_WECOM_CLIENT_TOKEN` (P8-05/P8-06), and the P7 audit model (`identity_source`,
  `platform_user_id`, `salesforce_username`)
- Scope constraint: text chat only. No Salesforce Action/Apex Tool generation, no shared sessions,
  no CRM↔WeCom history merge, no attachments, no production deployment.

## Context

The WeCom robot → OpenClaw → SFOA MCP path already exists. The new requirement is a chat entry
*inside Salesforce*, while keeping OpenClaw and the existing MCP as the only execution path.

Three facts shaped the design:

- **The browser cannot be the identity authority.** A Salesforce user must be proved by Salesforce
  itself, not by a value the browser sends. Apex can read `UserInfo` and sign with a certificate
  whose private key never leaves Salesforce.
- **Salesforce cannot be assumed to reach the corporate intranet.** Apex does not call the access
  service; the browser does, over HTTPS. Apex only issues a short-lived bootstrap token.
- **OpenClaw already has the right extension seam.** A plugin can register a channel and a
  credentialed HTTP route, use the same `resolveAgentRoute` / `finalizeInboundContext` /
  `recordInboundSession` / `dispatchReplyWithBufferedBlockDispatcher` pipeline as the WeCom
  plugin, and read history through a separate Gateway-authenticated
  `trusted-operator` route backed by the official `sessions.get`; the user-facing
  turn/abort path does not expose the Gateway token.

## Decision

### 1. Apex signs a short-lived bootstrap token with an org certificate

`SfoaCrmChatIdentity.issueBootstrapToken()` reads `UserInfo` and signs
`v1.<base64url(payload)>` with `Crypto.signWithCertificate('RSA-SHA256', ..., certUniqueName)`.

- Claims: `iss`, `aud`, `orgId`, `userId`, `username`, `displayName`, `iat`, `exp`, `jti`.
- TTL 30–120 s (default 90 s), `jti` random UUID.
- The certificate and its private key live in Setup → Certificate and Key Management. Neither the
  Apex class nor the Custom Setting contains a private key.
- The Custom Setting holds only the endpoint, certificate Unique Name, issuer, audience and TTL.

### 2. The access service verifies against pinned material and consumes the jti atomically

A new SFoA-owned service (`packages/sfoa-crm-gateway`) is the only component that talks to both
the browser and OpenClaw.

- It pins the public certificate (optional SHA-256 fingerprint), issuer, audience and allowed
  Salesforce org ids. It never fetches a key from the token or a URL and never negotiates the
  algorithm.
- It validates time bounds and then inserts the `jti` into `sfoa_crm_bootstrap_nonce` (primary
  key). A duplicate is rejected; a service restart cannot make a consumed token reusable.
- It maps `(orgId, userId)` through an explicit `sfoa_crm_identity_binding` row to the existing
  `platform_user_id`, and requires the route's `salesforce_username` to equal the token's
  `username`. Missing/disabled binding or route denies; there is no first-match or admin fallback.
- It issues an opaque 15-minute chat token; only its SHA-256 is stored. Salesforce logout does not
  revoke it instantly; the maximum window is the token TTL. This limitation is documented rather
  than hidden.

### 3. The OpenClaw plugin is the trusted CRM channel adapter

`sfoa-crm-channel` registers channel `sfoa-crm` and an HTTP ingress protected by a separate service
Bearer. Only that ingress may set `SenderId`; the message body, prompt, tool arguments and model
output never carry identity authority.

- The plugin uses the official route/session/reply pipeline, so session keys come from OpenClaw.
- One CRM conversation id maps to one official session key; different conversations are
  independent.
- Turns for the same conversation are serialized; stop is scoped to the target run; timeout and
  disconnect produce explicit terminal/unknown states, never an automatic retry.
- History is read with `api.runtime.subagent.getSessionMessages(...)` (official `sessions.get`)
  behind a separate Gateway-authenticated, `trusted-operator` route. The access service holds a
  server-side `CRM_GATEWAY_HISTORY_TOKEN` for that route only; a dedicated read-only device token is
  preferred, the shared Gateway token is a documented fallback. The token is never a user identity
  and cannot dispatch arbitrary Gateway methods. Turn/abort/session-resolve use the independent
  service credential. The plugin does not read the OpenClaw session database directly.

### 4. MCP gets a fourth channel credential, not a new identity engine

`MCP_CRM_CLIENT_TOKEN` + `X-SFOA-CRM-User-Id` mirror the WeCom channel pattern. The CRM credential
can only use the CRM header; WeCom/Internal credentials cannot use it, and vice versa. The audit
source is `CRM_HEADER`. Tool visibility, DML policy, Salesforce authorization, stdio and the
existing WeCom/Buntu/UserBound paths are unchanged.

### 5. The access service stores ownership, not a second chat database

MySQL stores the binding, conversation ownership, session key mapping, run status and token
hashes. Chat text remains in OpenClaw. A run's events are buffered in memory only for reconnect;
after a service restart the run is `UNKNOWN` and the user is told to check history, not to resubmit.

## Consequences

- A real Salesforce user is proved by Salesforce, while OpenClaw and MCP keep their existing
  request-scoped identity semantics.
- The private key has exactly one home: Salesforce's certificate store. The access service only
  needs the public certificate.
- A compromised access service cannot call arbitrary Gateway methods; it can only use the CRM
  plugin's four endpoints.
- Cross-user access to conversations, history, runs and stop is denied at the access service; the
  plugin additionally trusts only the service credential.
- Cost: a new network entry (HTTPS/CORS/CSP), a new service to operate, and a MySQL migration.
- Limitation: MCP audit has no session/run id. Correlation is `platform_user_id + occurred_at`
  window + OpenClaw log run/session ids; it is not a hard foreign key and is documented as such.
- Limitation: the access service is not a multi-tenant sandbox. It relies on OpenClaw's existing
  agent workspace/tool policy; this phase deliberately opens no file/memory/subagent path.

## Alternatives considered

| Alternative | Rejected because |
| --- | --- |
| Apex calls the access service directly | Salesforce cloud cannot be assumed to reach the corporate intranet; browser HTTPS is the required path |
| Store an RSA private key in a Custom Setting | Violates “private key stays in controlled Salesforce configuration”; protected settings are also awkward to administer |
| Reuse `X-WeCom-User-Id` / the WeCom credential | Different identity namespace; a Salesforce user id is not a WeCom user id |
| Have the access service use the Gateway token to call `chat.send` or arbitrary Gateway methods | It would bypass the trusted channel sender injection and grant far more authority than a history-only read needs |
| Duplicate chat text in a new CRM database to avoid a history credential | It creates a second source of truth and violates the “reuse OpenClaw storage” boundary |
| First-use auto-binding by username/email | Ambiguous and unsafe; explicit `(org, user) → platformUserId` binding is required |
| Put chat text in a new CRM database | Duplicates OpenClaw's session store and creates a second source of truth |

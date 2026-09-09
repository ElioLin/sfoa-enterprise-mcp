# P8-05 WeCom Enterprise MCP Identity Channel

Adds the fourth identity channel (`WECOM_HEADER`) for the WeCom (企业微信) enterprise
intelligent-robot MCP plugin. WeCom injects an `X-WeCom-User-Id` request Header whose
value is the current WeCom user id; the runtime resolves it to the existing
`platformUserId -> sfoa_identity_route -> Salesforce Username` identity route.

P8-06 supersedes the original shared-credential registration flow. See
[P8-06 delivery and deployment](P8_06_WECOM_CHANNEL_DISCOVERY.md) and
[ADR-0020](adr/ADR-0020-wecom-channel-discovery.md).

## Channel model

| Channel | Credential | Identity source | Identity context | Audited `identitySource` |
| --- | --- | --- | --- | --- |
| Internal / legacy MCP client | `Bearer <MCP_CLIENT_TOKEN>` | Header | `X-Platform-User-Id` | `INTERNAL_SERVICE_HEADER` |
| WorkBuddy | `Bearer <USER_BOUND_TOKEN>` | Bound token | none required | `USER_BOUND_TOKEN` |
| Buntu / Dify | `Bearer <BUNTU_TOKEN>` | Buntu `validate-token` | none required | `BUNTU_TOKEN` |
| WeCom enterprise MCP plugin | `Bearer <MCP_WECOM_CLIENT_TOKEN>` | Header | `X-WeCom-User-Id` | `WECOM_HEADER` |

Credential source and identity source are distinct concepts. A WeCom request uses the
independent WeCom channel token as its **credential** but its **identity** comes from
`X-WeCom-User-Id`, so audit records `identitySource = WECOM_HEADER` — never a blanket
`INTERNAL_SERVICE_HEADER`.

Identity-less initialize/tools/list/notifications/initialized/ping authenticate only the WeCom channel and never resolve a user or Salesforce route. X-WeCom-User-Id is auto-injected by WeCom for execution.

## Request flow (execution)

```text
X-WeCom-User-Id
        -> platformUserId
        -> sfoa_identity_route
        -> Salesforce Username
        -> request-scoped Salesforce Connection (lazy, P7-09)
        -> existing Tool Governance
        -> Salesforce API
```

## Configuration

The primary platform Header stays `MCP_PLATFORM_USER_HEADER=X-Platform-User-Id`
(so the internal channel is unchanged). Partner channels are added as CSV alias
Header names:

```dotenv
MCP_PLATFORM_USER_HEADER=X-Platform-User-Id
MCP_PLATFORM_USER_HEADER_ALIASES=X-WeCom-User-Id
MCP_WECOM_CHANNEL_ENABLED=true
MCP_WECOM_CLIENT_TOKEN=<CHANGE_ME>
```

Parse rules (`MCP_RUNTIME_CONFIGURATION_INVALID` fails fast on any violation):

- CSV, may be empty/blank (no aliases);
- entries are trimmed and empty entries dropped;
- every entry must be a legal HTTP Header name (no whitespace/control characters);
- Header names compare case-insensitively; an alias must neither repeat the primary
  Header nor repeat an earlier alias.

The runtime allowlist becomes `[X-Platform-User-Id, ...aliases]`, which is the only set
of configured identity Headers. With channel binding enabled the two standard channel Headers are always checked for mismatch; arbitrary `X-*-User-Id` Headers are ignored.

## Security semantics

- `X-WeCom-User-Id` is **identity context, not a credential**. Bearer authentication
  always runs first and must succeed; a Header alone never authorizes an MCP call.
- Header names match case-insensitively.
- Values are validated with the same `platformUserId` rules used today (1–128 printable
  characters). No fuzzy/name/email/prefix inference ever happens.
- A request may carry **at most one** platform identity Header. Two different platform
  identity Headers — even with the same value — are denied fail-closed
  (`MCP_PLATFORM_IDENTITY_CONFLICT`, HTTP 403) because multiple identity sources make
  audit attribution ambiguous. A duplicated single Header is treated the same way.
- USER_BOUND and Buntu tokens are themselves the identity authority. A matching
  `X-WeCom-User-Id` is optional context that must agree; a mismatching one is denied
  (`MCP_IDENTITY_CONTEXT_MISMATCH`). A Header can never override a bound identity.
- Host/Origin governance is unchanged and remains fail-closed
  (`MCP_HOST_NOT_ALLOWED` / `MCP_ORIGIN_NOT_ALLOWED`). Never set `MCP_ALLOWED_HOSTS=*`.

## Audit

P7 Audit records the WeCom channel with `identitySource = WECOM_HEADER`,
`platformUserId = <X-WeCom-User-Id>`, the resolved `salesforceUsername`, `clientId`,
`correlationId`, Tool evidence, and outcome. Bearer tokens, credential encryption
secrets, and raw secrets are never logged.

## Admin Web

The identity-source label mapper shows `WECOM_HEADER` as **企业微信** in the Audit
pages.

## Database

`sfoa_audit_log.identity_source` is an `ENUM` introduced by migration `003` restricted
to the three legacy channels. Migration `013_p8_05_wecom_identity_channel.sql` extends
the ENUM with `WECOM_HEADER` (additive, same pattern as `012`). No historical migration
or checksum was changed. If the field had been a free `VARCHAR`/`TEXT` without a
`CHECK`/`ENUM`, no migration would have been required.

## Reverse proxy

Preserve `Authorization`, `X-WeCom-User-Id`, `Host`, and `Content-Type` end-to-end.
Pass `X-WeCom-User-Id` through from the WeCom gateway
(`proxy_set_header X-WeCom-User-Id $http_x_wecom_user_id;`). Never hardcode a fixed
user id. See `docs/sfoa/P2_REVERSE_PROXY.md`.

## Tests

Unit (`identity-provider`), HTTP integration (`http-integration`), and config-parse
(`auth-governance`) coverage exercises the WeCom success path, missing/invalid
credentials, missing identity, same/different Header conflicts, ambiguous duplicates,
case-insensitivity, invalid values, route not-found/disabled, USER_BOUND and Buntu
forgery regressions, audit identity source and no-secret, and Host governance.

## Non-goals

If a deployment's WeCom user ids live in a different namespace than existing
`platform_user_id` values, that is out of scope for P8-05: the correct future
architecture is an `identity_provider + external_user_id -> identity_route_id` mapping
(e.g. `WECOM | zhangsan`), not name/email/prefix inference in the runtime.

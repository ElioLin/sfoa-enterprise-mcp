# P6-ID-01 USER_BOUND Credential

Status: implemented; acceptance evidence is recorded in `P6_ID_01_REPORT.md`.

## Architecture

P6-ID-01 changes only how the effective platform identity is acquired. Salesforce identity routing and authorization stay on the accepted P1-P5 path:

```text
                        IdentityProvider
                              |
             +----------------+----------------+
             |                                 |
 Internal service bearer                 USER_BOUND bearer
 + trusted platform Header               route-bound token
             |                                 |
             +----------------+----------------+
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

 Future: BUNTU_TOKEN may resolve into the same principal boundary.
 No Buntu API behavior exists in P6-ID-01.
```

The unified principal carries `clientId`, `identitySource`, `platformUserId`, and an optional safe `credentialId`. Authentication completes before body processing, policy-snapshot loading, JWT construction, or Tool execution.

## Credential storage

Migration `003_p6_identity_credential` adds `sfoa_identity_credential`. A route normally has exactly one active `USER_BOUND` credential:

- the bearer is `sfoa_ub1_` plus 32 random base64url bytes;
- SHA-256 `token_hash` is the unique indexed runtime lookup key;
- AES-256-GCM `token_ciphertext` supports repeated Admin retrieval;
- `identity_route_id` is authenticated as AES additional data;
- `token_last4` is the only token fragment returned by route-list APIs;
- statuses are only `ACTIVE` and `REVOKED`;
- only one active credential per route is enforced in MySQL.

Set a stable 32-byte base64url key in the ignored `.env.local` or deployment secret store:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

```dotenv
MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY=<generated-value>
```

Never commit or log this key. Preserve the same key across restart/restore; otherwise existing ciphertext cannot be copied by Admin. Automated key rotation and multi-key decryption are intentionally outside this phase.

## Lifecycle

| Action | Route | Current credential | Next USER_BOUND request |
| --- | --- | --- | --- |
| Create route | configured state | generated in the same transaction | Uses the new route |
| Edit platform ID or Salesforce Username | updated | unchanged | Uses the latest route values |
| Disable route | disabled | remains `ACTIVE` | Rejected with `MCP_IDENTITY_ROUTE_DISABLED` |
| Re-enable route | enabled | unchanged | Original token works again |
| Regenerate | unchanged | old `REVOKED`, ciphertext removed; new `ACTIVE` | Old rejected, new accepted immediately |
| Delete disabled route | removed | revoked/deleted | Rejected as invalid before JWT/Salesforce |

Creation transaction: route + credential + `CREATE_IDENTITY_ROUTE` audit. Regeneration transaction: revoke old + create new + `REGENERATE_USER_BOUND_CREDENTIAL` audit. Delete transaction: verify disabled + revoke/delete credential + delete route + retain `DELETE_IDENTITY_ROUTE` audit. Optimistic route and credential versions prevent double regeneration.

Successful USER_BOUND authentication best-effort updates `last_used_at`. Failure of that timestamp update is logged as safe degradation and does not fail the Salesforce request.

## Legacy compatibility

Inspector, regressions, controlled internal services, and a future trusted gateway continue to use:

```http
Authorization: Bearer <MCP_CLIENT_TOKEN>
X-Platform-User-Id: <PLATFORM_USER_ID>
```

That source is audited as `INTERNAL_SERVICE_HEADER`. USER_BOUND is audited as `USER_BOUND_TOKEN`. A USER_BOUND request needs only Authorization. If it also supplies a platform Header, the value must match the current route or authentication fails with `MCP_IDENTITY_CONTEXT_MISMATCH`.

## MCP public URL

Configure the client-facing URL independently from the listener:

```dotenv
MCP_PUBLIC_URL=https://mcp.company.example/mcp
```

It must be credential-free HTTP(S), with no query or fragment. It is used only by Admin configuration output and never changes `MCP_BIND_HOST`, `MCP_PORT`, `MCP_PATH`, allowlists, firewall, DNS, TLS, or reverse-proxy behavior.

Fallback behavior:

| Runtime configuration | Admin result |
| --- | --- |
| `MCP_PUBLIC_URL` configured | Uses the configured URL |
| loopback bind and no public URL | Offers a local-only URL with a warning |
| wildcard/non-loopback bind and no public URL | No copyable external URL; asks the operator to configure `MCP_PUBLIC_URL` |

Never use `http://0.0.0.0:8080/mcp` as a client URL.

## WorkBuddy setup

The administrator flow is:

1. Open **用户身份路由**.
2. Select **新建身份路由**.
3. Enter platform user ID and Salesforce Username, then save.
4. The system creates the route and USER_BOUND token together and opens **MCP 接入配置**.
5. Select **复制 WorkBuddy MCP JSON**.
6. Paste it into a WorkBuddy custom connector and save.
7. Run a read-only test before DML.

Generated JSON is valid, pretty-formatted, and contains the current token:

```json
{
  "mcpServers": {
    "enterprise-salesforce": {
      "type": "http",
      "url": "https://mcp.company.example/mcp",
      "headers": {
        "Authorization": "Bearer <USER_BOUND_TOKEN>"
      },
      "disabled": false
    }
  }
}
```

Do not add `X-Platform-User-Id`, Salesforce Username, or an identity Tool argument to a WorkBuddy connector. The bearer resolves the current platform route.

## Admin APIs and search

- `GET /admin/api/routes?keyword=&limit=&offset=` returns true filtered `total`, `hasMore`, and `nextOffset`.
- `POST /admin/api/routes` atomically returns the new route and copy-ready credential.
- `GET /admin/api/routes/:id/credential` decrypts the current active token for an authenticated Admin.
- `POST /admin/api/routes/:id/credential/regenerate` uses route and credential row versions.
- `POST /admin/api/routes/:id/disable` stops new USER_BOUND requests.
- `DELETE /admin/api/routes/:id` requires a disabled route and a current row version.

The route-list, Dashboard, Audit, and System responses never contain raw tokens. Search is parameterized, case-insensitive under the schema collation, trimmed, bounded, and applies the identical platform-ID/Salesforce-Username filter to `COUNT(*)` and page selection.

## Audit and secret boundary

Runtime audit adds `identitySource` and `identityCredentialId`. Admin lifecycle audits include route/platform/Salesforce identifiers, credential ID, last four characters where useful, and operation outcome. They never contain the bearer, Authorization value, ciphertext, or encryption key.

Stable authentication errors include:

- `MCP_IDENTITY_CREDENTIAL_INVALID`;
- `MCP_IDENTITY_CREDENTIAL_REVOKED`;
- `MCP_IDENTITY_ROUTE_DISABLED`;
- `MCP_IDENTITY_CONTEXT_MISMATCH`.

Unauthenticated errors do not identify the owning route or platform user.

## Migration and validation

Run the additive versioned migration and status check:

```powershell
yarn db:migrate
yarn db:status
```

Automated integration and full-stack lifecycle tests derive and use only `sfoa_enterprise_mcp_test`; they refuse an unrelated database. The application database receives migrations but no destructive test cleanup.

Key evidence commands are:

```powershell
yarn workspace @sfoa/control-plane test
yarn workspace @sfoa/control-plane test:mysql
yarn workspace @sfoa/mcp-server test
yarn workspace @sfoa/mcp-server test:p5:mysql
yarn workspace @sfoa/admin-api test
yarn workspace @sfoa/admin-web test
yarn p5:e2e:fullstack
yarn validate:p5
```

See `P6_ID_01_REPORT.md` and `TEST_MATRIX.md` for the actual results. P6-ID-01 does not claim completion of P6 Real-Agent Evaluation.

# P5 Local Setup

This runbook starts the P5 MySQL Control Plane, remote MCP runtime, authenticated Admin API, and React Admin Console from a clean developer machine. It does not use Salesforce CLI authentication at runtime and does not place credentials in the browser.

## Prerequisites

- repository-pinned Yarn Classic 1.22.22 and a supported Node.js release;
- MySQL 8.x reachable from the developer machine;
- a Salesforce Connected App client ID, JWT private key file, and the required USER/DIAGNOSTIC Salesforce usernames for live gates;
- three free loopback ports: MCP `8080`, Admin API `8081`, and Vite `5173`.

Install from the repository root:

```powershell
yarn install --frozen-lockfile
```

Do not use npm or pnpm. Real values go only in the ignored `.env.local` or the current shell.

## 1. Provision the local databases

Use a MySQL administrator once. Replace the example password locally; never put it in Git.

```sql
CREATE DATABASE IF NOT EXISTS sfoa_enterprise_mcp
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS sfoa_enterprise_mcp_test
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'sfoa_app'@'127.0.0.1' IDENTIFIED BY '<local-strong-password>';
GRANT ALL PRIVILEGES ON sfoa_enterprise_mcp.* TO 'sfoa_app'@'127.0.0.1';
GRANT ALL PRIVILEGES ON sfoa_enterprise_mcp_test.* TO 'sfoa_app'@'127.0.0.1';
```

`yarn db:create` is also available when the configured development account has `CREATE DATABASE`; a normal runtime account does not need that global privilege. The automated MySQL integration harness derives the `_test` name and refuses an unrelated schema.

## 2. Configure `.env.local`

Copy `.env.example` to the ignored `.env.local`, then set at least:

```dotenv
SFOA_CONTROL_PLANE_MODE=mysql
SFOA_DB_HOST=127.0.0.1
SFOA_DB_PORT=3306
SFOA_DB_NAME=sfoa_enterprise_mcp
SFOA_DB_USER=sfoa_app
SFOA_DB_PASSWORD=<local-only>
SFOA_DB_SSL_MODE=disabled

SFOA_INSTANCE_URL=https://your-domain.my.salesforce.com
CONNECTED_APP_CLIENT_ID=<local-only>
JWT_PRIVATE_KEY_PATH=<absolute-local-path>
SALESFORCE_USERNAME=<user-a-salesforce-username>
SECOND_TEST_USER=<user-b-salesforce-username>

SFOA_ADMIN_USERNAME=admin
SFOA_ADMIN_PASSWORD=<local-only-plaintext>
SFOA_ADMIN_SESSION_SECRET=<independent-random-secret>
SFOA_ADMIN_ALLOWED_ORIGIN=http://127.0.0.1:5173
SFOA_ADMIN_COOKIE_SECURE=false

MCP_AUTH_MODE=internal_bearer
MCP_CLIENT_TOKEN=<independent-local-token>
MCP_PUBLIC_URL=http://127.0.0.1:8080/mcp
MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY=<independent-32-byte-base64url-key>
```

`MCP_CLIENT_TOKEN`, the identity-credential encryption key, the Admin session secret, the Admin password, the database password, and Salesforce material must all be independent values. `MCP_PUBLIC_URL` is only the connector-facing URL; it does not change the listener. In mysql mode, routes, Tool enablement, DML policy, and Diagnostic identity come only from MySQL. Missing/unavailable data denies the request; there is no environment fallback.

`SFOA_ADMIN_PASSWORD` is the plaintext Admin login password for local development; it is compared in constant time and is never stored as a hash in configuration. Put a real value only in the ignored `.env.local` and never commit it.

Generate a session secret with `node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))"`. Generate the independent AES key with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"`. Store both outputs only in `.env.local`.

## 3. Migrate and inspect the schema

```powershell
yarn db:migrate
yarn db:status
```

The migration command applies versioned files and records them in `sfoa_schema_migration`. Application startup validates known tables, columns, indexes, and migration versions but never silently repairs an unknown schema.

## 4. Bootstrap current environment governance

```powershell
yarn p5:bootstrap
```

This imports the current P1 A/B routes, audited enabled Tools, CREATE/UPDATE object policy, and optional Diagnostic seed. It is idempotent and does not overwrite later administrator changes. Development-only replacement is explicit:

```powershell
$env:NODE_ENV = 'development'
yarn p5:bootstrap --force
```

Read the warning and use `--force` only against the intended local project database. The command rejects force mode unless `NODE_ENV` is explicitly `development` or `test`.

## 5. Start the services

Choose one startup mode. Use three terminals for independent watch-style logs:

```powershell
yarn workspace @sfoa/mcp-server start
yarn admin:api:dev
yarn admin:web:dev
```

Or start all three with:

```powershell
yarn p5:dev
```

Before using the bundled command, stop any MCP, Admin API, or Admin Web instance started in another terminal. `p5:dev` requires exclusive access to `8080`, `8081`, and `5173`; it fails before starting peers when a port is occupied.

On Windows, the bundled launcher compiles the two backend workspaces sequentially with their project-local TypeScript compilers. It then starts MCP and Admin API, waits for their real health/readiness endpoints, and only then starts Vite with the resolved Admin API proxy target. This avoids overlapping Yarn/Corepack/Vite process trees and prevents a reachable login page from masking an unavailable Admin API. `Ctrl+C` stops the complete spawned process trees.

Check process and readiness separately:

```text
http://127.0.0.1:8081/admin/api/health  — Admin process alive
http://127.0.0.1:8081/admin/api/ready   — MySQL schema ready
http://127.0.0.1:8080/health            — MCP runtime health
http://127.0.0.1:5173/login             — Admin Console
```

Open the console with the exact configured origin, `http://127.0.0.1:5173/login`, rather than changing the host to `localhost`. Sign in with `SFOA_ADMIN_USERNAME` and the plaintext `SFOA_ADMIN_PASSWORD`.

### Startup and sign-in troubleshooting

Inspect only the three project ports:

```powershell
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in @(8080, 8081, 5173) } |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

Prefer `Ctrl+C` in the terminal that owns a stale process. After the ports are clear, start one mode and verify:

```powershell
Invoke-WebRequest http://127.0.0.1:8080/health -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:8081/admin/api/ready -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:5173/admin/api/ready -UseBasicParsing
```

- `MCP_ADMIN_AUTH_INVALID` means the browser reached the real Admin API but the submitted username/plaintext password did not match. Update only the ignored `.env.local` `SFOA_ADMIN_PASSWORD` and restart the Admin API.
- “The browser could not reach the Admin API” or “no structured response” means the API/proxy path is unavailable or a stale partial stack is running. Clear the project ports, restart once, and confirm both direct and Vite-proxied readiness.
- `cannot bind ... (EADDRINUSE)` identifies the occupied service and exits nonzero without stopping the process that already owns the port.

## 6. Configure the Control Plane

After login:

1. Create and verify Platform User → Salesforce username routes. Creation atomically generates one USER_BOUND credential and opens its copy-ready configuration. Shared Salesforce usernames are allowed; the enabled Diagnostic username must remain distinct.
2. Enable only Tools whose executable-catalog status allows it. An unknown, unsafe, unsupported, non-remote, or drifted Tool cannot be promoted by a database row.
3. Add object policy using only the CREATE and UPDATE toggles. Missing policy denies DML.
4. Configure the server-owned Diagnostic Salesforce username and an optional bounded metadata seed.
5. Run **验证 Diagnostic Connection**. This uses a fresh JWT and the real P4 DIAGNOSTIC request scope: exact identity, Tooling query, official metadata retrieval, bounded context, and cleanup.
6. Inspect durable MCP/Admin evidence under **调用审计**, then check migration/provider/configured-state under **系统状态**.

Only the authenticated **用户身份路由 → 接入配置** Drawer can retrieve and display a current USER_BOUND token. No Dashboard, Audit, System, other UI page, or list response can display it. JWT assertions, private-key contents/paths, database passwords, `MCP_CLIENT_TOKEN`, and the encryption key are never displayed.

## 7. Local gates

```powershell
yarn p5:test
yarn p5:test:runtime:mysql
yarn p5:e2e
yarn p5:e2e:fullstack
yarn validate:p5
```

`p5:e2e` is the mocked browser workflow test. `p5:e2e:fullstack` is the real React → Vite proxy → Admin API → `sfoa_enterprise_mcp_test` gate and contains no `page.route` API mock. `validate:p5` runs changed-code lint, unit/integration tests, both browser gates, and the real test-database paths. If database credentials or the P4 Diagnostic identity are absent, the corresponding gate must be recorded as `NOT TESTED`, never PASS.

## 8. Local, LAN, Dify, and WorkBuddy access

The default Streamable HTTP Endpoint is:

```text
http://127.0.0.1:8080/mcp
```

`127.0.0.1` is same-host only. A Dify or WorkBuddy Runtime on another machine cannot use its own `127.0.0.1` to reach this MCP process.

For a deliberate private-LAN test, review and set the following values in the ignored local environment file, then restart the Runtime yourself:

```dotenv
MCP_BIND_HOST=0.0.0.0
MCP_ALLOWED_HOSTS=<YOUR_LAN_IP>:8080
MCP_AUTH_MODE=internal_bearer
MCP_PUBLIC_URL=http://<YOUR_LAN_IP>:8080/mcp
```

Use `http://<YOUR_LAN_IP>:8080/mcp` only from a network-reachable client. The applicable Windows/Linux Firewall must allow TCP 8080 from the intended source. `0.0.0.0` listens on all local interfaces; it does not automatically create a route, firewall rule, security-group rule, reverse proxy, DNS record, or internet access. This guide never changes the firewall or `.env.local` automatically.

For WorkBuddy, configure `MCP_PUBLIC_URL`, then create a route under **用户身份路由**. Saving creates its route-bound token and opens **接入配置**. Copy the generated WorkBuddy JSON; it requires only:

```text
Authorization: Bearer <USER_BOUND_TOKEN>
Transport: Streamable HTTP
```

Do not add `X-Platform-User-Id`, Salesforce Username, or an identity Tool parameter to that WorkBuddy connector. Add the concise System Prompt from `docs/agent/WORKBUDDY_AGENT_SYSTEM_PROMPT.md`, install `.codebuddy/skills/sfoa-salesforce-assistant/`, and perform a read-only Test Run first.

Inspector, regressions, and controlled internal/Dify test connectors may continue using `MCP_CLIENT_TOKEN` plus one trusted `X-Platform-User-Id`. A future Buntu-authenticated Dify provider is only an extension point and is not implemented. For production TLS/reverse-proxy access and complete credential lifecycle guidance, follow `docs/sfoa/P2_REVERSE_PROXY.md`, `docs/sfoa/P5_DEPLOYMENT.md`, `docs/sfoa/P6_ENTRY_AGENT_ENABLEMENT.md`, and `docs/sfoa/P6_ID_01_USER_BOUND_CREDENTIAL.md`.

## Compatibility mode

Set `SFOA_CONTROL_PLANE_MODE=env` to run the historical P0–P4 harness with `.env` routes and allowlists. The Admin API itself is a P5 MySQL service; compatibility mode is for the MCP/upstream regression path, not an alternate unauthenticated Admin backend.

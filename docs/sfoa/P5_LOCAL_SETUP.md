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
SFOA_ADMIN_PASSWORD_HASH=<generated-below>
SFOA_ADMIN_SESSION_SECRET=<independent-random-secret>
SFOA_ADMIN_ALLOWED_ORIGIN=http://127.0.0.1:5173
SFOA_ADMIN_COOKIE_SECURE=false

MCP_AUTH_MODE=internal_bearer
MCP_CLIENT_TOKEN=<independent-local-token>
```

`MCP_CLIENT_TOKEN`, the Admin session secret, the Admin password, the database password, and Salesforce material must all be independent values. In mysql mode, routes, Tool enablement, DML policy, and Diagnostic identity come only from MySQL. Missing/unavailable data denies the request; there is no environment fallback.

Generate an Admin password hash using an ephemeral shell value:

```powershell
$sfoaAdminPlaintext = Read-Host 'Temporary Admin password'
$env:SFOA_ADMIN_PASSWORD_PLAINTEXT = $sfoaAdminPlaintext
try { yarn admin:hash-password } finally {
  Remove-Item Env:SFOA_ADMIN_PASSWORD_PLAINTEXT -ErrorAction SilentlyContinue
  $sfoaAdminPlaintext = $null
}
```

Copy only the emitted `scrypt$...` hash into `.env.local`. Generate a session secret with `node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))"`; store the output only in `.env.local`.

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

Use three terminals for the clearest logs:

```powershell
yarn workspace @sfoa/mcp-server start
yarn admin:api:dev
yarn admin:web:dev
```

Or start all three with:

```powershell
yarn p5:dev
```

Check process and readiness separately:

```text
http://127.0.0.1:8081/admin/api/health  — Admin process alive
http://127.0.0.1:8081/admin/api/ready   — MySQL schema ready
http://127.0.0.1:8080/health            — MCP runtime health
http://127.0.0.1:5173/login             — Admin Console
```

## 6. Configure the Control Plane

After login:

1. Create and verify Platform User → Salesforce username routes. Shared Salesforce usernames are allowed; the enabled Diagnostic username must remain distinct.
2. Enable only Tools whose executable-catalog status allows it. An unknown, unsafe, unsupported, non-remote, or drifted Tool cannot be promoted by a database row.
3. Add object policy using only the CREATE and UPDATE toggles. Missing policy denies DML.
4. Configure the server-owned Diagnostic Salesforce username and an optional bounded metadata seed.
5. Run **Verify Diagnostic Connection**. This uses a fresh JWT and the real P4 DIAGNOSTIC request scope: exact identity, Tooling query, official metadata retrieval, bounded context, and cleanup.
6. Inspect durable MCP/Admin evidence under **Audit**, then check migration/provider/configured-state under **System**.

No UI page can display access tokens, JWT assertions, private-key contents/paths, database passwords, or the MCP client token.

## 7. Local gates

```powershell
yarn p5:test
yarn p5:test:runtime:mysql
yarn p5:e2e
yarn p5:e2e:fullstack
yarn validate:p5
```

`p5:e2e` is the mocked browser workflow test. `p5:e2e:fullstack` is the real React → Vite proxy → Admin API → `sfoa_enterprise_mcp_test` gate and contains no `page.route` API mock. `validate:p5` runs changed-code lint, unit/integration tests, both browser gates, and the real test-database paths. If database credentials or the P4 Diagnostic identity are absent, the corresponding gate must be recorded as `NOT TESTED`, never PASS.

## Compatibility mode

Set `SFOA_CONTROL_PLANE_MODE=env` to run the historical P0–P4 harness with `.env` routes and allowlists. The Admin API itself is a P5 MySQL service; compatibility mode is for the MCP/upstream regression path, not an alternate unauthenticated Admin backend.

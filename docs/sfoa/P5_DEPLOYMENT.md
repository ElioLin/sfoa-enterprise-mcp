# P5 Production Deployment

P5 deploys a thin Control Plane around Salesforce authority. It requires four independently operated components:

1. the stateless MCP runtime, normally bound to loopback `8080`;
2. the authenticated Admin API, normally bound to loopback `8081`;
3. the static `@sfoa/admin-web` Vite build;
4. MySQL 8.x for SFoA configuration and safe durable audit.

It does not require Redis, a Salesforce Connection/token cache, Kubernetes, an OAuth server, or a second Salesforce permission model.

## Port and exposure contract

Development runs three processes:

```text
MCP             127.0.0.1:8080
Admin API       127.0.0.1:8081
Vite Admin Web  127.0.0.1:5173
```

Production runs only the two Node listeners plus static files:

```text
MCP Node        127.0.0.1:8080
Admin API Node  127.0.0.1:8081
React Web       static Nginx files
Vite 5173       NOT RUNNING
External        HTTPS 443
```

The reverse proxy maps `/mcp` to the loopback MCP listener, `/admin/api/` to the loopback Admin API, and the Admin frontend to the static React distribution. Never expose `8080`, `8081`, or MySQL `3306` directly to the public network.

## Build and migration order

1. Back up the current database.
2. Install the reviewed Yarn lockfile with `yarn install --frozen-lockfile`.
3. Build and test with `yarn validate:p5` in CI or an isolated release-validation environment; it includes the mocked browser workflow and real MySQL-backed full-stack browser Gate against `sfoa_enterprise_mcp_test`. The production runtime host does not require that test schema unless an operator deliberately runs these Gates there.
4. Run `yarn db:status`; review pending/unknown migration state.
5. Run `yarn db:migrate` before starting the new Admin API/MCP binaries.
6. Run `yarn db:status` again and retain its JSON output as deployment evidence.
7. Build the static UI with `yarn workspace @sfoa/admin-web build`.
8. Restart the Admin API, then MCP runtime; verify readiness/health before shifting traffic.

Application startup validates migrations and schema. It does not silently mutate an unexpected production schema.

## Process separation

- Run MCP and Admin API under separate low-privilege OS identities and process supervisors.
- Keep both Node listeners on loopback or a private service network; expose them only through the approved reverse proxy.
- Set `SFOA_CONTROL_PLANE_MODE=mysql` in production. A database outage intentionally makes governance unavailable/fail-closed.
- Never share `MCP_CLIENT_TOKEN` with `SFOA_ADMIN_SESSION_SECRET` or use it as Admin authentication.
- Do not mount Salesforce CLI auth caches into either process. Production Salesforce access is direct JWT/OAuth through `@salesforce/core`.
- Give the runtime write access only to its bounded disposable workspaces and configured private-key read access. Do not grant broad filesystem access.

## Reverse proxy and HTTPS

Serve the React build and Admin API on one HTTPS origin so exact-Origin and CSRF enforcement remain simple. A minimal Nginx shape is:

```nginx
server {
    listen 443 ssl http2;
    server_name sfoa-admin.example.com;

    root /opt/sfoa/admin-web/dist;
    index index.html;

    location /admin/api/ {
        proxy_pass http://127.0.0.1:8081/admin/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location = /mcp {
        proxy_pass http://127.0.0.1:8080/mcp;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location / {
        try_files $uri /index.html;
        add_header Cache-Control "no-cache";
    }
}
```

Expose MCP through its own approved route/client policy. Preserve its bearer, Host, Origin, size, request-timeout, and Tool-timeout controls; do not route Admin authentication through the MCP bearer.

Set:

```dotenv
NODE_ENV=production
SFOA_ADMIN_ALLOWED_ORIGIN=https://sfoa-admin.example.com
SFOA_ADMIN_COOKIE_SECURE=true
```

Production sessions then use the `__Host-` cookie prefix with `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`. Terminate only trusted HTTPS, configure HSTS at the edge, and do not make the Admin API reachable over public plaintext HTTP.

## Secret handling

Use the deployment platform's secret store or protected environment injection for:

- MySQL password;
- Salesforce Connected App client ID and JWT private key;
- MCP client token;
- Admin password hash and independent session-signing secret.

Restrict key-file permissions to the runtime identity. Never bake secrets into the Vite build, container image, Git, logs, health payloads, support bundles, or browser storage. The Admin API exposes only masked host/configured-state facts.

## MySQL

- Use MySQL 8.x with `utf8mb4`, InnoDB, encrypted transport (`required` or `verify_identity`) across a network, and a bounded application pool.
- Grant only the project schema privileges needed after migrations; use a separate deployment principal for schema changes when required.
- Configure server-side storage encryption and log/backup access controls appropriate to audit data.
- Monitor connection saturation, schema readiness, audit insert failures, storage growth, and backup age.
- Never point automated integration tests at `sfoa_enterprise_mcp`; their target must resolve to `sfoa_enterprise_mcp_test`.
- `sfoa_enterprise_mcp_test` is not required by a production deployment. Provision it only in CI or when an operator explicitly elects to run integration/full-stack tests in that deployment environment.

## Backup and restore

Back up schema, configuration, migration history, and audit together. A representative protected command is:

```powershell
mysqldump --single-transaction --routines=false --triggers=false --set-gtid-purged=OFF sfoa_enterprise_mcp > sfoa-enterprise-mcp.sql
```

Supply credentials through a protected MySQL login path or secret-injection mechanism, not a command-line password. Encrypt the output, restrict access, define retention, and regularly test restore into an isolated database. After restore, run `yarn db:status` and the mysql-mode gates before accepting traffic.

## Health and operations

Probe:

- `/admin/api/health` for liveness only;
- `/admin/api/ready` for database/schema readiness;
- MCP `/health` for runtime and audit-persistence state.

An audit persistence failure marks health `DEGRADED` and increments the failure metric. It must never turn an already successful Salesforce CREATE/UPDATE into a reported failure or trigger an automatic retry. Investigate and restore persistence without replaying the mutation.

Admin configuration writes and their audit event are one MySQL transaction, so audit failure rolls back configuration. Salesforce remains authoritative for CRUD, FLS, sharing, validation, Flow, Trigger, and native permission behavior.

## Rollback

Prefer forward-compatible application rollback after reviewing migration compatibility. Do not delete audit/configuration tables or manually rewrite `sfoa_schema_migration`. If a release cannot safely read the migrated schema, stop traffic, restore the reviewed pre-deployment backup into an isolated target, validate it, then perform an explicit controlled cutover.

# Operations

## Local setup and startup

Prerequisites are Node >=22 for the SFoA P5/P7 workspaces, Yarn Classic 1.22.x, and MySQL 8.x. Real values stay in ignored `.env.local` or protected environment injection.

```text
yarn install --frozen-lockfile
yarn db:migrate
yarn db:status
yarn p5:bootstrap
yarn p5:dev
```

Or start services separately:

```text
yarn workspace @sfoa/mcp-server start
yarn admin:api:dev
yarn admin:web:dev
```

Default development endpoints:

- MCP: `127.0.0.1:8080`, `/health`, Streamable HTTP `/mcp`.
- Admin API: `127.0.0.1:8081`, `/admin/api/health`, `/admin/api/ready`.
- Admin Web: `127.0.0.1:5173/login`; Vite proxies `/admin/api` to the Admin API.

`yarn ai:doctor` checks runtime/tooling/configured state, DB connectivity/schema, service reachability, and Git state without printing secret values.

## Deployment

Production uses two Node processes (MCP/Admin API), static Admin Web files, MySQL 8, and an HTTPS reverse proxy. Vite does not run in production. Keep Node listeners and MySQL off the public network. Apply reviewed migrations before application restart, verify `/ready` and `/health`, then shift traffic.

Use `SFOA_CONTROL_PLANE_MODE=mysql`; missing DB governance fails closed. Back up schema, migration ledger, configuration, credential ciphertext, and Audit together; preserve the matching identity encryption key separately. Do not mount Salesforce CLI auth cache. Production Salesforce uses direct JWT/OAuth through `@salesforce/core`.

Audit health may be `DEGRADED` while Tool/Salesforce results remain correct. Restore persistence without replaying mutations. Prefer forward-compatible rollback; never rewrite `sfoa_schema_migration` manually.

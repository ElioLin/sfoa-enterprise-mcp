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

Before applying migrations after switching branches, run `yarn db:status` and
compare the ledger with this checkout. `ai:doctor` connectivity/core-table PASS
does not prove every required migration is applied. A database can both lack a
new migration and contain a migration from a different feature branch. Do not
remove ledger rows or disable unknown-version rejection to make startup pass.
For an authorized separate local development database, migrate the new schema,
copy only the needed governance/configuration rows in dependency order, excluding
computed columns but retaining ordinary defaulted timestamps, then verify the
copied values. Keep the original database and back up `.env.local` before changing
only its database name; historical Audit remains in the original database.

## Deployment

For material workflows, apply migration 017_attachment_attempt_lifecycle before
loading the new control-plane/server. It additively extends attachment attempt
states and separates staged-byte cleanup from outcome evidence. Do not reset
historical FAILED, UPLOADING or OUTCOME_UNKNOWN to STAGED. A rollback can retain
the additive schema; old code safely refuses new states. Back up affected source,
dist, the actual loaded adapter and runtime Skills; deploy committed LF archives
through staging with non-deleting rsync, preserve app directory traversal and
check affected SELinux labels. The app adapter path is not proof of the Gateway
load path: inspect process config plus plugin registry and verify the loaded copy.
Keep business runtime Skills separate from generated development copies and the
independent skill:export package. Config/protocol/health checks are not business
acceptance. The test-server deployment guide and current task delivery report
contain the actual version and rollback evidence.

Playbook upgrades also require rebuilding and publishing `sfoa-admin-web`: the
browser imports the canonical package at build time. Restarting MCP/Admin API or
synchronizing runtime Skills cannot update an already-built web bundle. Validate
the served Agent Integration page/version and generated instruction text, the MCP
initialize/resource version, and canonical/runtime Skill hashes independently.
Back up existing web assets, stage the new build, publish hashed assets before
`index.html`, and verify HTTP access and SELinux labels. This static-only publish
does not require restarting Gateway or discarding its in-memory task state.

Production uses two Node processes (MCP/Admin API), static Admin Web files, MySQL 8, and an HTTPS reverse proxy. Vite does not run in production. Keep Node listeners and MySQL off the public network. Apply reviewed migrations before application restart, verify `/ready` and `/health`, then shift traffic.

Use `SFOA_CONTROL_PLANE_MODE=mysql`; missing DB governance fails closed. Back up schema, migration ledger, configuration, credential ciphertext, and Audit together; preserve the matching identity encryption key separately. Do not mount Salesforce CLI auth cache. Production Salesforce uses direct JWT/OAuth through `@salesforce/core`.

Audit health may be `DEGRADED` while Tool/Salesforce results remain correct. Restore persistence without replaying mutations. Prefer forward-compatible rollback; never rewrite `sfoa_schema_migration` manually.

For material-workflow migration 017, check the ledger and actual column before
rollback. If deployment stopped before applying it, move the newly introduced SQL
file into the task backup before starting the old runtime; otherwise its startup
migration check can reject the restored version. If applied, retain the additive
schema and upload/unknown outcome facts, never restore an old table snapshot to
make a reference reusable. The old runtime does not reap newly added statuses;
retain compatible cleanup or arrange original-byte expiry housekeeping.

203 can load the adapter from `/data/openclaw/plugins/sfoa-wecom-mcp-adapter`,
independent of the app checkout. Verify the actual loaded path and hashes after
deployment, canonical/runtime business Skills, and the independent `sfoa` export;
preserve that export's existing `mcp.json`. Never publish maintainer Skills to the
business runtime. A successful reload/discovery does not prove a fresh model read.

WeCom native MCP plugins require MCP_WECOM_CHANNEL_ENABLED=true and an independent
MCP_WECOM_CLIENT_TOKEN (32+ random characters, no USER_BOUND prefix, not equal to
MCP_CLIENT_TOKEN). Keep MCP_PLATFORM_USER_HEADER=X-Platform-User-Id and
MCP_PLATFORM_USER_HEADER_ALIASES=X-WeCom-User-Id. Restart Runtime/Admin API together.
The plugin Authorization is Bearer <MCP_WECOM_CLIENT_TOKEN>; WeCom injects its
user Header for execution. Discovery has no user/route/Salesforce access.

## Restricted Console accounts (ADR-0034)

`SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON` registers Console accounts that see only the
modules they are granted. Its value is a secret — one line of JSON carrying every
restricted account's plaintext password — so inject it whole from the secret store and
never echo it back. `modules` is mandatory and draws only on `dashboard`,
`identity-routes`, `tool-governance`, `dml-policies`, `diagnostic`, `ui-context`,
`audit`, `system`, `agent-integration`; an unknown id, a missing `modules`, a repeated
username, an account reusing `SFOA_ADMIN_USERNAME`, bad JSON, or more than sixteen
entries **fails startup**, so the Admin API stops serving rather than partially
applying. The value is read once at process start: changing it, or removing an account
(which ends that account's live session at its next request), requires an Admin API
restart.

Diagnosis follows the same split as the rest of the boundary. A module the account does
not hold answers 403 `MCP_ADMIN_FORBIDDEN` on every request, not only in the browser —
the Console simply never offers the page. Those refusals are **not** in
`sfoa_audit_log` (the table stays a record of actions), so ship the Admin API's stderr
to the platform log if a refusal needs to be reviewable; the module and path are in the
line. `actor_admin` (migration 015) records which Console account performed each
`ADMIN_ACTION`, exposed as the 操作人（控制台账号）filter in 调用审计, and it only ever
carries an actor for `channel = 'ADMIN'` rows. If a Console account works in the browser
but a hand-made API call to a page it *can* see fails, suspect the endpoint table in
`packages/sfoa-admin-api/src/module-paths.ts` rather than the session.

Two parsers read that config line and `process.env` wins: systemd's `EnvironmentFile=`
and the app's own `parseEnvFile`. Write the JSON single-quoted — systemd strips one
matching pair and keeps the rest literal, and `unquote()` does the same — then *verify*
they agree instead of assuming: compare the sha256 of the value in
`/proc/<admin-api-pid>/environ` with the sha256 of the file's parsed value (both
masked; never print the line). A mismatch means the service is running a value the file
does not contain, which is the failure mode a file-only check cannot see. Note that a
systemd probe of any env file must live somewhere systemd itself may read: under
Enforcing SELinux a file in `/tmp` is refused (`Failed to load environment files:
Permission denied`) even for root.

# SFoA P6 Admin Web

The React Admin Console manages SFoA-owned identity routing, Tool enablement, CREATE/UPDATE policy, Diagnostic configuration, safe settings, Audit and system status. Its Agent Integration page renders canonical Playbook `1.6.0`, distinguishes Buntu, USER_BOUND and Internal/Inspector setup, and previews Dify/WorkBuddy guidance. It never receives Salesforce tokens, JWT keys, database credentials or the MCP client secret.

P8-04 `/ui-context` edits exact per-object OFF/SHADOW/ENFORCE/default App settings
and displays/refreshes lightweight current snapshots. Audit detail adds 页面上下文
and collapsed, on-demand 字段依据; it does not load all payload bodies by default.
The focused browser gate is `node node_modules/@playwright/test/cli.js test
e2e/p8-effective-ui.spec.ts` from this package (mocked Admin API).

```powershell
yarn workspace @sfoa/admin-web dev
yarn workspace @sfoa/admin-web test
yarn workspace @sfoa/admin-web build
yarn workspace @sfoa/admin-web e2e
```

Vite proxies `/admin/api` to the loopback Admin API on port `8081`. Production deployment serves `dist/` behind HTTPS and reverse-proxies the same prefix to the Admin API.

Managed DML fields distinguish strict platform identity / AI marker from user-overridable platform Lookup fallback. See [managed field contract](../../docs/sfoa/P6_DML_01_MANAGED_FIELDS.md) for strategy priority and CREATE/UPDATE interaction.

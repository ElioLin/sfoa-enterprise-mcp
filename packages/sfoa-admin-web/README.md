# SFoA P6 Admin Web

The React Admin Console manages only SFoA-owned identity routing, executable Tool enablement, CREATE/UPDATE object policy, Diagnostic integration configuration, safe runtime settings, audit, and system status. Its Agent Integration page renders canonical Playbook `1.5.1`, distinguishes Buntu, USER_BOUND, and Internal/Inspector identity setup, and previews deterministic Dify/WorkBuddy guidance from current safe capability facts. It never receives Salesforce tokens, JWT keys, database credentials, or the MCP client secret.

```powershell
yarn workspace @sfoa/admin-web dev
yarn workspace @sfoa/admin-web test
yarn workspace @sfoa/admin-web build
yarn workspace @sfoa/admin-web e2e
```

Vite proxies `/admin/api` to the loopback Admin API on port `8081`. Production deployment serves `dist/` behind HTTPS and reverse-proxies the same prefix to the Admin API.

Managed DML fields distinguish strict platform identity / AI marker from user-overridable platform Lookup fallback. See [managed field contract](../../docs/sfoa/P6_DML_01_MANAGED_FIELDS.md) for strategy priority and CREATE/UPDATE interaction.

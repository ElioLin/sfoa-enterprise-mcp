# SFoA P5 Admin Web

The React Admin Console manages only SFoA-owned identity routing, executable Tool enablement, CREATE/UPDATE object policy, Diagnostic integration configuration, safe runtime settings, audit, and system status. It never receives Salesforce tokens, JWT keys, database credentials, or the MCP client secret.

```powershell
yarn workspace @sfoa/admin-web dev
yarn workspace @sfoa/admin-web test
yarn workspace @sfoa/admin-web build
yarn workspace @sfoa/admin-web e2e
```

Vite proxies `/admin/api` to the loopback Admin API on port `8081`. Production deployment serves `dist/` behind HTTPS and reverse-proxies the same prefix to the Admin API.

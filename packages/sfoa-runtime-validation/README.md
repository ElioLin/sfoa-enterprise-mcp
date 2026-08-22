# SFoA P0-Closure Runtime Validation

This private workspace validates the live P0 runtime path without using Salesforce CLI authentication state:

```text
JWT Bearer Flow
  -> @salesforce/core AuthInfo / Connection
  -> Salesforce identity and safe SOQL
  -> official DxCoreMcpProvider Tools
  -> temporary writable DX metadata workspace
```

Configure the repository-root `.env.local` from `.env.example`, then run:

```powershell
yarn workspace @sfoa/runtime-validation validate
```

The default output masks the access token. Setting `SFOA_DEBUG_EXPOSE_TOKEN=true` prints the complete token to the current console only. The harness never writes the token, Salesforce records, or identity values to evidence files.

This package is a P0-Closure validation utility. It is not the P1 identity router, a production MCP gateway, or a production workspace manager. It never spawns the `sf` executable.

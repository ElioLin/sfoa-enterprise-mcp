# SFoA Streamable HTTP P0 POC

This private workspace proves that the public Salesforce DX MCP Provider API can be hosted over the official MCP TypeScript SDK's stateless Streamable HTTP transport without modifying official Salesforce Tool implementations.

It registers GA Tools from the official `DxCoreMcpProvider` in the `core`, `data`, and `metadata` Toolsets. It binds only to `127.0.0.1`, enables JSON responses and DNS rebinding protection, and validates initialize, `tools/list`, and `tools/call` with the SDK Client.

This is not the production remote runtime. It deliberately omits production authentication, platform-user routing, OAuth/JWT lifecycle, persistent sessions, DML, and the Admin UI. Its local allowlist is process-scoped and exists only to exercise official Provider behavior.

```powershell
yarn workspace @sfoa/streamable-http-poc build
yarn workspace @sfoa/streamable-http-poc test
yarn workspace @sfoa/streamable-http-poc start
```

Optional local org allowlist for manual calls:

```powershell
$env:SFOA_POC_ORGS = 'an-alias-or-username'
```

Do not use `SFOA_POC_ORGS` as a remote authorization mechanism.

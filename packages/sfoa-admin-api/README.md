# SFoA P5 Admin API

The Admin API is a separate loopback-first Node process at `/admin/api`. It authenticates a bounded bootstrap administrator with the plaintext `SFOA_ADMIN_PASSWORD` compared in constant time, signed expiring HttpOnly/SameSite=Strict cookies, exact Origin checks, CSRF headers, login rate limiting, no-store responses, strict Zod input, optimistic locking, and transactionally audited configuration writes.

It never accepts `MCP_CLIENT_TOKEN` as Admin authentication and never returns database passwords, Salesforce tokens/JWTs, private-key contents/paths, or raw authorization records.

```powershell
yarn workspace @sfoa/admin-api test
yarn workspace @sfoa/admin-api lint
yarn workspace @sfoa/admin-api start
```

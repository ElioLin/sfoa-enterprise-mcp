# SFoA P5 Control Plane

`@sfoa/control-plane` owns only SFoA enterprise governance persistence and durable safe audit. It provides versioned MySQL 8 migrations, repository interfaces and MySQL implementations, immutable per-request policy snapshots, an idempotent environment bootstrap, and a resilient runtime audit adapter.

It does not execute Salesforce Tools, store Salesforce credentials or business records, replicate Salesforce permissions, depend on React, or provide DELETE/UPSERT/Bulk DML.

From the repository root:

```powershell
yarn workspace @sfoa/control-plane db:create
yarn workspace @sfoa/control-plane db:migrate
yarn workspace @sfoa/control-plane db:status
yarn workspace @sfoa/control-plane p5:bootstrap
yarn workspace @sfoa/control-plane test
yarn workspace @sfoa/control-plane lint
```

Real database values belong in the ignored `.env.local` or current shell. Production uses `SFOA_CONTROL_PLANE_MODE=mysql`; the default `env` mode remains the P0-P4 compatibility path.

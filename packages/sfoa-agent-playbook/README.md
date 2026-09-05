# `@sfoa/agent-playbook`

Pure TypeScript canonical Salesforce Agent operating contract for SFoA P6-Agent-01.

Production modules define Playbook version `1.5.1`, sections, safe capability facts, workflow selection, and deterministic renderers. They perform no filesystem, network, database, Salesforce Connection, credential, or secret access and can be consumed by both Node.js and browser builds.

The Node-only `scripts/sync-generated.mjs` adapter owns checked-in Dify and WorkBuddy artifacts:

```powershell
yarn agent:sync
yarn agent:check
```

Runtime callers must pass only effective Tool names, effective CREATE/UPDATE object allowlists, and Diagnostic readiness. Do not pass Control Plane remarks, usernames, route records, errors, or secrets.

Managed DML fields distinguish strict platform identity / AI marker from user-overridable platform Lookup fallback. See [managed field contract](../../docs/sfoa/P6_DML_01_MANAGED_FIELDS.md) for strategy priority and CREATE/UPDATE interaction.

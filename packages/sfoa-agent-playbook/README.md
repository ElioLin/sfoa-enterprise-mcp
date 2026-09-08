# `@sfoa/agent-playbook`

Pure TypeScript canonical Salesforce Agent operating contract for SFoA P6-Agent-01.

Version 1.6.1 excludes Master from CREATE choices when a non-Master type is
available to the current USER, while retaining Master-only creation without a
question. Version 1.6.0 added P8-04 effective CREATE fields, prompt-derived draft values,
PENDING/UNKNOWN handling, at most three refinements and optional context provenance.
The existing Page Layout and managed Lookup fallback workflows remain available.
Run `yarn agent:sync` and `yarn agent:check` at the root; generated client artifacts
must never be edited independently.

Production modules define Playbook version `1.6.1`, sections, safe capability facts, workflow selection, and deterministic renderers. They perform no filesystem, network, database, Salesforce Connection, credential, or secret access and can be consumed by both Node.js and browser builds.

Besides the checked-in Dify instruction and WorkBuddy Skill, `renderWeComRoleSetting(capabilities?)` deterministically renders the 企业微信智能机器人 (WeCom Smart Bot) recommended role setting (推荐角色设定). It is Chinese-first, capability-aware, and secret-free, written in business semantics for the assistant persona: it always acts for the current WeCom user under that user's Salesforce permissions. It deliberately carries no identity-implementation detail — the WeCom platform auto-injects the current user's identity header (`WECOM_HEADER` / `X-WeCom-User-Id`) at the enterprise MCP ingress per request — and it never reuses Buntu/USER_BOUND host semantics nor embeds any token the agent should hold or echo.

The Node-only `scripts/sync-generated.mjs` adapter owns checked-in Dify and WorkBuddy artifacts:

```powershell
yarn agent:sync
yarn agent:check
```

Runtime callers must pass only effective Tool names, effective CREATE/UPDATE object allowlists, and Diagnostic readiness. Do not pass Control Plane remarks, usernames, route records, errors, or secrets.

Managed DML fields distinguish strict platform identity / AI marker from user-overridable platform Lookup fallback. See [managed field contract](../../docs/sfoa/P6_DML_01_MANAGED_FIELDS.md) for strategy priority and CREATE/UPDATE interaction.

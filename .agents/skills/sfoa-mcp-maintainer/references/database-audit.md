# Database and P7 Audit

Use this for MySQL, identity route, Tool governance, DML policy, runtime setting, and Audit investigations. Migration SQL and current repository code are authoritative.

## Configuration

The Control Plane reads root `.env.local` plus the current process environment. Database keys are `SFOA_DB_HOST`, `SFOA_DB_PORT`, `SFOA_DB_NAME`, `SFOA_DB_USER`, `SFOA_DB_PASSWORD`, `SFOA_DB_SSL_MODE`, connection/queue limits, and connect timeout. Never print the file or put credentials on a command line.

Run:

```text
yarn ai:doctor
yarn ai:db --report summary
yarn ai:db --report schema
yarn ai:db --report routes --user <platformUserId>
yarn ai:db --report tools --tool <toolName>
yarn ai:db --report dml --object <ObjectApiName>
yarn ai:db --report runtime
yarn ai:db --report audit-stats
```

The toolkit uses predefined SQL only, validates the first statement as `SELECT`, `SHOW`, `DESCRIBE`, or `EXPLAIN SELECT`, rejects multi-statement/stateful reads, and starts a MySQL `READ ONLY` transaction.

## Current tables through migration 008

- `sfoa_schema_migration`: version, checksum, application time.
- `sfoa_identity_route`: case-sensitive `platform_user_id` to Salesforce username, enabled state, optimistic `row_version`.
- `sfoa_identity_credential`: USER_BOUND token hash/ciphertext/last4/lifecycle by route.
- `sfoa_tool_control`: exact Tool name and enabled state.
- `sfoa_dml_policy`: object, CREATE/UPDATE booleans, enabled state.
- `sfoa_dml_managed_field_rule`: policy child, target field, two accepted strategies, operation flags.
- `sfoa_diagnostic_config`: singleton fixed Salesforce username and verification state.
- `sfoa_runtime_setting`: allowlisted JSON settings (`auditRetentionDays`, `adminDefaultPageSize` in current contracts).
- `sfoa_audit_log`: compatible master ledger and P7 `MCP_TOOL_CALL` rows.
- `sfoa_audit_event`: ordered per-Audit execution facts and optional same-Audit parent.
- `sfoa_salesforce_api_call`: ordered real/operation-only Salesforce attempts, SOQL and DML semantics.
- `sfoa_audit_payload_evidence`: bounded request/response metadata and sanitized body, loaded only on explicit item access.

## Audit analyzer

```text
yarn ai:audit --trace <publicAuditId>
yarn ai:audit --audit <publicAuditId-or-numeric-id>
yarn ai:audit --correlation <correlationId> --latest 5
yarn ai:audit --user <platformUserId> --tool run_soql_query --since 24h
```

The analyzer returns sanitized root summaries, a merged Event/API timeline, deterministic first failure, payload metadata, and current route/Tool/DML context. Current governance state is labeled contextual because it is not historical proof of the state at invocation time. Payload bodies are not selected.

`--trace` aliases the real `publicAuditId`. `correlationId` is not an idempotency or Salesforce commit-status key. Missing unsupported trace/session/call/span fields stay `unavailable`.

One narrow historical exception exists: a maintainer may explicitly enable raw Buntu validation token persistence. The toolkit's recursive output redaction still treats raw token-shaped data as secret and does not display payload bodies by default.

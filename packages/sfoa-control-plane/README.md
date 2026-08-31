# SFoA P5-P7 Control Plane

`@sfoa/control-plane` owns only SFoA enterprise governance persistence and durable safe audit. It provides versioned MySQL 8 migrations, repository interfaces and MySQL implementations, immutable per-request policy snapshots, an idempotent environment bootstrap, and a resilient runtime audit adapter.

P7-01 evolves the existing `sfoa_audit_log` ledger without moving historical rows and adds normalized Event, Salesforce API Call, and bounded Payload Evidence tables. Existing Runtime/Admin callers keep the compatible `audits` repository; P7 trace persistence uses the separate `auditTraces` contract and cohesive MySQL audit module. Repository writes apply centralized secret redaction, summaries are bounded, Payload Evidence is capped at 256 KiB, and ordinary Audit lists never select the payload table.

P7-02 lets `DatabaseRuntimeLogger` consume the active request audit context and create exactly one `MCP_TOOL_CALL` with the context's server-generated public Audit ID. This reuses the existing final Runtime audit write; it adds no stage writes, Event insert, queue, batch writer, Salesforce API, Workbench API/UI, or diagnostic MCP Tool.

P7-03 production Runtime logging no longer awaits `AuditRepository.append` or `AuditTraceRepository.createCall`. It appends to the request Collector, offers one immutable Snapshot to a capacity-1000 Queue, and persists batches of up to 50 in a background Writer. The Writer uses a separate MySQL pool capped at two connections, retries twice with bounded exponential backoff, isolates non-retryable poison snapshots after batch rollback, and exposes bounded health counters. Admin transactional audit remains synchronous and unchanged.

P7-06 extends that same Snapshot transaction with bounded Payload Evidence. The Writer resolves request-local Event sequence and Salesforce `publicApiCallId` to same-Audit database IDs, rejects missing/cross-Audit bindings, and computes SHA-256 over the exact persisted secret-safe prefix. Migration 008 permits unknown original byte size to remain NULL. `listPayloadEvidence()` and `getPayloadEvidenceById()` are explicit on-demand reads; ordinary Audit search/count never selects or joins `safe_payload`.

From the repository root:

```powershell
yarn workspace @sfoa/control-plane db:create
yarn workspace @sfoa/control-plane db:migrate
yarn workspace @sfoa/control-plane db:status
yarn workspace @sfoa/control-plane p5:bootstrap
yarn workspace @sfoa/control-plane test
yarn workspace @sfoa/control-plane test:mysql
yarn workspace @sfoa/control-plane lint
```

Real database values belong in the ignored `.env.local` or current shell. Production uses `SFOA_CONTROL_PLANE_MODE=mysql`; the default `env` mode remains the P0-P4 compatibility path.

# ADR-0015: P7 End-to-End Audit Data Model

- Status: Implemented for P7-01; awaiting Maintainer review
- Date: 2026-08-29
- Extends: ADR-0011 Control Plane persistence, ADR-0012 unified identity, and ADR-0014 trusted managed DML fields

## Context

P5/P6 use `sfoa_audit_log` as a durable, flat audit ledger for Runtime events, identity validation, and Admin transactions. The Runtime logger treats persistence as a fail-open observational side effect, while Admin changes and their audit rows intentionally remain in one database transaction. Existing Admin API and React Audit surfaces query this table directly.

P7 must eventually reconstruct one ordered evidence chain for each definite MCP Tool invocation without inferring a multi-Tool Agent task. It needs normalized execution events, Salesforce API/SOQL/DML evidence, and bounded payload evidence. P7-01 is limited to the model, contracts, repositories, migration, compatibility, tests, and documentation; it must not prematurely add request context, AsyncLocalStorage, collectors, queues, Salesforce transport instrumentation, the React workbench, or diagnostic Tools/Skills.

## Decision

P7-01 evolves `sfoa_audit_log` as the compatible master ledger instead of replacing it. Every row receives a public UUID, a fact-based `audit_kind`, optional start/completion boundaries, a safe error message, and an integrity status. Only `MCP_TOOL_CALL` rows represent P7 Audit Calls; historical Admin, identity-validation, and generic Runtime rows remain distinguishable and queryable. Because old timeout/disconnect paths can emit multiple flat events carrying the same Tool name, `tool_name` alone is not proof of one invocation: historical/default Runtime append rows remain `RUNTIME_EVENT`, while only `createCall()` or an explicit kind creates a Tool-call master. Existing append callers keep their established contract and default to `PARTIAL` because P7-01 does not yet collect a complete trace.

Three normalized child tables are added:

1. `sfoa_audit_event` stores per-Audit ordered execution events and optional same-Audit parent relationships.
2. `sfoa_salesforce_api_call` stores per-Audit API calls plus typed SOQL and CREATE/UPDATE evidence, but never a large complete Salesforce response.
3. `sfoa_audit_payload_evidence` stores optional request/response evidence after centralized redaction with a 256 KiB stored-byte ceiling, truncation metadata, and a SHA-256 digest of the sanitized full content.

The numeric master key remains the internal FK. The UUID is the stable external identifier; Repository creation validates a UUID preallocated by a future request context and generates one only for compatibility callers that do not provide it. Event and API sequences are unique only within one Audit; no global sequence is introduced. Composite foreign keys bind Event parents, API-to-Event, and Payload-to-Event/API relationships to the same Audit, preventing cross-Audit evidence linkage at the database boundary. Deleting a master row for a future controlled retention job cascades through its evidence; P7-01 does not implement that job.

Trace counts are derived from child data rather than stored on the master row. Ordinary master-list queries select only `sfoa_audit_log` and never join or select raw payload evidence.

The Audit implementation moves into the cohesive `mysql-audit-repository.ts` domain module. The existing `audits` repository remains source-compatible for Runtime/Admin callers; the store additionally exposes `auditTraces` for P7 child operations. All JSON, endpoint, SOQL, error, and payload persistence crosses one centralized sanitization boundary. Historical Buntu `rawToken` evidence is removed by the migration, and new configuration cannot re-enable raw-token auditing.

The migration runner holds its MySQL advisory lock, migration statements, metadata writes, validation, and lock release on the same pinned pooled connection. This is required because MySQL advisory locks are connection-scoped. Migration checksums use Git's LF-normalized SQL as their canonical value and accept only the equivalent CRLF digest for historical Windows-run compatibility; no SQL-content checksum mismatch is waived and no applied row is rewritten.

## Consequences

### Positive

- Historical Audit IDs, Admin API queries, Runtime logging, and the current React Audit page remain compatible without a risky data move or dual-read path.
- Typed child records preserve queryability, ordering, and referential isolation without one unbounded JSON trace blob.
- Database composite FKs provide a final defense against cross-Audit linkage even if a future caller bypasses Repository checks.
- Payload size and secret controls are enforced at the persistence boundary, independent of future capture producers.
- The existing Runtime fail-open contract and Admin transaction semantics remain unchanged.

### Negative

- The master ledger contains both Tool calls and non-Tool historical audit kinds, so every P7 trace consumer must filter or validate `MCP_TOOL_CALL` explicitly.
- Counts require aggregation until a measured future read model justifies snapshots.
- Cascading retention can delete a full trace and therefore must be implemented later as a reviewed, master-row-driven operation.
- P7-01 provides storage capability but intentionally does not yet produce complete end-to-end traces.

## Rejected alternatives

1. Create a new Audit Call master table and migrate or union historical rows: rejected because it adds dual writes, data movement, API compatibility work, and rollback risk without a P7-01 benefit.
2. Store the complete trace in one JSON column: rejected because it weakens ordering/FK guarantees, harms indexed diagnostics, and lets large Salesforce responses dominate normal Audit queries.
3. Persist event/API/payload counters on every master row: rejected because asynchronous and fail-open persistence can make counters disagree with evidence.
4. Use a process-global current Audit or global sequence: rejected because concurrent cross-request leakage tolerance is zero.
5. Insert every event synchronously from the Tool path: rejected because Audit must not block or alter business outcomes; collection and asynchronous batch persistence belong to P7-03.
6. Add Audit calls manually inside every Tool: rejected because transparent Salesforce execution-layer instrumentation belongs to P7-04 and must automatically cover future Tools.
7. Retain optional raw Buntu token auditing: rejected because Authorization, bearer tokens, JWTs, private keys, secrets, passwords, and cookies are absolutely prohibited evidence.

## Gate

P7-01 requires clean initialization and P6-to-P7 migration against MySQL 8, legacy Audit readability, master/Event/API/Payload creation, per-Audit sequence behavior, database and Repository cross-Audit rejection, bounded payload and secret persistence tests, ordinary list isolation from payload data, Runtime Logger fail-open regressions, Admin API/UI compatibility, full package regressions, changed-code lint/build, and `validate:p5`. Passing engineering Gates advances only to `IMPLEMENTED / AWAITING MAINTAINER REVIEW`; it does not complete P7-01 or authorize P7-02 implementation.

# ADR-0016: Explicit Buntu Raw-Token Audit Opt-In

- Status: Implemented; awaiting Maintainer review
- Date: 2026-08-30
- Supersedes in part: ADR-0015's blanket rejection of optional raw Buntu token auditing

## Context

Operations sometimes require comparing the exact Buntu bearer value received by MCP with the upstream validation outcome. P7-01 originally converted the legacy configuration key into a startup prohibition and scrubbed historical values during migration 005. That prevented the requested troubleshooting workflow. A broad relaxation would expose authentication material through logs, errors, fallback sinks, unrelated audit operations, or other identity modes.

Separately, MySQL implicitly commits DDL. The production development database completed every 005 DDL statement but did not receive its migration-ledger row, so a retry failed on the first duplicate column while startup reported 005 missing.

## Decision

`MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED` remains `false` by default and accepts `true`. When enabled, the Buntu authenticator sends the raw value only through the dedicated `DatabaseRuntimeLogger.logBuntuTokenValidation()` method. The generic `RuntimeLogger` event contains only fingerprint/last-four metadata. The Audit Repository accepts the special evidence only when channel is `MCP`, identity source is `BUNTU_TOKEN`, and operation is `BUNTU_TOKEN_VALIDATE`; it persists the value as bounded `requestSummary.rawToken`. All mismatched uses fail validation. Durable and fallback audit failure remains observational and cannot alter authentication or Tool outcomes.

The authenticated Admin Audit detail may show the value with an explicit high-sensitivity warning. HTTP responses, stdout/stderr, fallback logs, generic audit producers, USER_BOUND tokens, MCP client tokens, JWTs, Authorization headers, cookies, private keys, passwords and secrets remain subject to centralized redaction.

For migration recovery, the runner may add the missing 005 ledger row only after the complete required schema, indexes and named constraints validate. Any partial state continues into the normal migration attempt and fails; no old migration file or checksum is changed.

## Consequences

- Operators regain exact-token evidence only after an explicit server-side opt-in and must treat Admin Audit access as high sensitivity.
- The database intentionally stores a live credential while enabled; retention, database access control and disabling the flag after troubleshooting are operational responsibilities.
- A sink failure still cannot leak the token to fallback logs or change request outcome.
- Fully completed 005 schemas recover idempotently; partial schemas are never falsely marked applied.

## Rejected alternatives

1. Remove all secret sanitization: rejected because the request authorizes one Buntu troubleshooting field, not arbitrary credential persistence.
2. Put raw token in the generic Runtime event: rejected because alternate/fallback loggers could expose it outside MySQL.
3. Automatically repair any duplicate-column migration failure: rejected because that could certify a partial schema.
4. Modify migration 005 to be statement-by-statement idempotent: rejected because it is already published and checksum stability is required.

## Gate

Configuration true/false parsing, dedicated durable persistence, scope rejection, generic/fallback/HTTP redaction, fail-open behavior, Admin warning/display, complete-schema ledger recovery, MySQL integration, package builds/tests, and startup must pass. This decision does not authorize P7-02.

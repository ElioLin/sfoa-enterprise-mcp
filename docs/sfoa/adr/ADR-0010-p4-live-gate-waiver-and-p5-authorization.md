# ADR-0010: Defer P4 Live Diagnostic Closure and Authorize P5 Development

- Status: Accepted by Maintainer
- Date: 2026-08-23
- Supersedes: none
- Extends: ADR-0009 diagnosis/runtime-context composition and the project Phase-Gate policy

## Context

P4 implementation, static security, protocol, regression, and real USER runtime-context Gates are complete. The only unexecuted key P4 evidence is the real fixed-DIAGNOSTIC chain:

```text
server-owned DIAGNOSTIC identity
  -> fresh JWT and Connection.identity()
  -> real Tooling API query
  -> official retrieve_metadata
  -> bounded metadata context
  -> workspace cleanup
```

The P4 environment does not configure `SFOA_DIAGNOSTIC_USERNAME`. Mocks prove composition and fail-closed behavior but cannot establish live Salesforce compatibility. The recorded P4 result therefore remains `PARTIAL`.

P5 introduces the durable SFoA Control Plane that owns Diagnostic username configuration and provides the governed verification entry point. Blocking all P5 development on an external credential would not reduce implementation risk in the independent database, Admin security, governance-persistence, or audit work.

Before this decision, the clean P4 branch was revalidated:

- Context Provider tests: 10/10 PASS;
- P4 Host tests: 7/7 PASS;
- Identity Runtime tests: 26/26 PASS;
- executable Upstream compatibility: PASS with zero drift;
- all six SFoA strict TypeScript lint commands: PASS.

## Decision

The Maintainer makes an explicit Phase-Gate waiver:

```text
P4 IMPLEMENTATION = MAINTAINER ACCEPTED
P4 LIVE EXTERNAL-CREDENTIAL GATE = DEFERRED
P5 DEVELOPMENT = AUTHORIZED
```

The historical result `P4 = PARTIAL` is preserved. It is not rewritten as PASS.

P5 must provide a Diagnostic verification path that uses the actual P4 DIAGNOSTIC request scope and code path. Before P5 final acceptance, that path must be attempted again and the evidence recorded in the P4/P5 reports and test matrix.

P5 final-result rules are:

1. P5 code, tests, UI, database, and runtime integration pass, and the real P4 diagnostic closure passes: P5 may be reported `PASS / COMPLETE — AWAITING MAINTAINER REVIEW`.
2. P5 implementation passes but a real Diagnostic credential remains unavailable: P5 must be reported `PARTIAL`, with implementation complete and the external live Gate pending.
3. A real Diagnostic attempt exposes a P4 implementation defect: fix it in P5 Closure and rerun every affected P4 and P5 Gate before reporting a result.

## Boundaries retained

- Salesforce remains the CRUD/FLS/sharing/validation/Flow/Trigger authority.
- P5 stores and audits SFoA-owned routing and governance configuration only.
- The Agent cannot select USER/DIAGNOSTIC identity, credentials, role, token, or filesystem authority.
- No mock or static test can substitute for the live Diagnostic evidence.
- The waiver authorizes P5 development only. It does not authorize P6 or a P5 merge.

## Consequences

### Positive

- Independent P5 engineering can proceed while preserving honest external-Gate semantics.
- The new Control Plane can supply the intended trusted configuration and verification workflow for closing P4.
- Historical evidence remains auditable rather than being rewritten after the waiver.

### Negative

- P5 can finish implementation yet remain `PARTIAL` for an external dependency.
- A late live P4 defect may require P5 Closure changes and broad regression reruns.

## Rejected alternatives

1. Promote P4 mocks to live PASS: rejected because they do not authenticate or execute against Salesforce.
2. Block all P5 work: rejected because the missing credential does not invalidate the accepted P4 implementation or independent P5 engineering.
3. Build a separate verification implementation: rejected because it could bypass the P4 role, official-Tool, workspace, and bounds path that requires closure evidence.

## Gate

P5 development may begin after the P4 history-preserving merge and dedicated branch creation. P5 final acceptance remains blocked until the real P4 diagnostic closure is attempted and evidence is recorded; unavailable credentials yield `NOT TESTED`, never PASS.

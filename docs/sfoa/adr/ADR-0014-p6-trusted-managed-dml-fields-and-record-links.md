# ADR-0014: P6 Trusted Managed DML Fields and Explicit Record-Link Origin

- Status: Accepted for P6-DML-01
- Date: 2026-08-27
- Extends: ADR-0008 generic DML, ADR-0011 Control Plane persistence, ADR-0012 unified identity, and ADR-0013 MCP-native Agent Playbook
- Supersedes: ADR-0013 only where it selected the current Salesforce Connection instance origin for record links

## Context

Some CREATE/UPDATE records need a platform-user Lookup and a server-owned AI-created marker. Asking an Agent to collect or derive those values would make untrusted prompt input an identity authority. Hardcoding object/field rules in a Tool would duplicate the generic DML path and create business-specific provider drift.

Separately, a Salesforce API Connection instance host is not necessarily the intended Lightning UI origin. Record links require an operator-selected, credential-free, trusted UI origin without accepting or guessing a client host.

## Decision

SFoA adds one constrained managed-field child model beneath the existing DML object policy. It supports only `PLATFORM_USER_LOOKUP` and `AI_CREATED_MARKER`; marker is CREATE-only and always writes `true`. The child references its parent instead of duplicating the target object. Parent-plus-target is unique, operations must be non-empty and within the parent allowlist, and all external data is validated at migration, Admin service, and Runtime boundaries.

The Runtime obtains managed rules in the same repeatable-read, deeply frozen request snapshot as Tool and DML policy. After the existing object/operation allowlist check and before public SDK mutation dispatch, a host facade resolves values from immutable `RequestContext.platformUserId` and the current request-scoped USER Connection. Lookup is bounded to two rows, exact-one is required, no result is cached, and the server-owned value overwrites any case-insensitive client copy.

Pre-dispatch failures are `FAILED`, not `UNKNOWN`. A timeout marks the pre-dispatch deadline so a late-settling Lookup cannot dispatch a mutation. `MCP_DML_OUTCOME_UNKNOWN` remains reserved for the existing post-dispatch ambiguity boundary.

Canonical Playbook and capability facts advertise safe rule descriptors and instruct Agents never to ask for, recommend, send, override, derive, or guess managed values. Action context marks managed targets, but remains evidence rather than authorization.

Record links use only explicit `SFOA_LIGHTNING_BASE_URL`. It must be an HTTPS origin root without credentials, path, query, or fragment. Missing configuration returns `MCP_RECORD_LINK_BASE_URL_NOT_CONFIGURED`. There is no fallback to `Connection.instanceUrl`, client input, headers, or guessed Salesforce domains.

## Consequences

### Positive

- Trusted identity data never comes from Tool arguments or Agent reasoning.
- Generic official/SFoA DML Tools remain unchanged and Salesforce still enforces native authorization and business rules.
- One policy snapshot governs both mutation availability and host-owned values without cross-request cache state.
- Pre-dispatch timeout behavior cannot cause a hidden late mutation.
- Lightning links use one reviewable deployment setting instead of an API-host inference.

### Negative

- Operators must configure the exact Lookup object/match field and ensure one Salesforce row per platform user.
- `get_record_links` is unavailable until a trusted Lightning base origin is configured.
- Managed-field changes take effect on the next request snapshot; there is deliberately no hot cache.

## Rejected alternatives

1. Generic constants, expressions, defaults, or metadata-driven automation: rejected as a second Salesforce rule engine and out of phase scope.
2. Agent-supplied platform identity or resolved record ID: rejected because the Agent/client is not an identity authority.
3. A new business-named mutation Tool: rejected because it duplicates the existing generic CREATE/UPDATE capability.
4. Patch the official Provider: rejected because the SFoA host composition point is sufficient.
5. Cache Lookup results or Connections: rejected because stale/cross-user state adds risk without measured need.
6. Derive the Lightning origin from `Connection.instanceUrl`: superseded because API and Lightning UI origins can differ.
7. Accept a link base URL from Tool input or guess a Salesforce domain: rejected for injection, phishing, and tenancy risk.

## Gate

The Gate requires migration/constraint tests, Admin CRUD/conflict/audit tests, CREATE/UPDATE resolver and server-wins tests, exact Lookup failure codes, allowlist-before-Lookup order, late-settlement no-dispatch proof, at least 50 alternating two-user resolver rounds with zero mismatch, at least 40 alternating full-facade rounds with zero mismatch, capability/action-context/generated-artifact parity, trusted-origin link tests, Admin UI/E2E evidence, previous identity/DML regressions, changed-code lint/build, and honest `PENDING MAINTAINER` status for all live Salesforce runs not executed locally.

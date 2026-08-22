# ADR-0001: Upstream Tracking and SFoA Extension Boundary

- Status: Accepted
- Date: 2026-08-22
- Decision owners: SFoA Enterprise MCP maintainers

## Context

The project must retain the complete Salesforce DX MCP history, remain able to consume future Salesforce fixes, and add remote identity routing, HTTP hosting, governance, DML, and an Admin UI. The official `@salesforce/mcp` package is primarily an oclif stdio executable; its registry and Services implementation are internal rather than a public embeddable server factory. The official Provider API and provider packages are public extension seams.

## Decision

Keep the official repository as `upstream` and retain its history. Implement SFoA production behavior in new SFoA-owned composition packages and applications. Consume the public Provider API and official provider packages. Do not make production code depend on private paths such as `@salesforce/mcp/lib/registry.js`.

Patch an official implementation file only when a new package/adapter cannot meet a proven requirement. Record every such patch in `UPSTREAM_STRATEGY.md`.

## Consequences

### Positive

- Official Tools and SDK behavior are reused.
- Upstream merges remain reviewable.
- Request-scoped Services and HTTP hosting can evolve independently of the local stdio CLI.
- Provider versions can be pinned and integration-tested explicitly.

### Negative

- The SFoA host must reproduce a small amount of Tool registration/composition logic through public APIs.
- Package-release drift between source workspaces and bundled `@salesforce/mcp` dependencies must be monitored.
- New extension packages add their own build/test/lint responsibility.

## Alternatives

1. Patch the official stdio command to add HTTP and request routing. Rejected because process-scoped Cache/Services/CWD behavior would require invasive changes.
2. Import private compiled host modules. Rejected because private paths are not a stable public contract.
3. Copy official Tools into SFoA packages. Rejected because it forks behavior and increases security/maintenance risk.

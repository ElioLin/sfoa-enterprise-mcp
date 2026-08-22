# ADR-0007: Guard Upstream Inventory and Remote Tool Contracts

- Status: Accepted for P2 Closure HOTFIX01
- Date: 2026-08-22
- Supersedes: ADR-0006 remote Tool schema adapter
- Extends: ADR-0005 remote runtime and Tool governance

## Context

ADR-0006 adapted an official Tool schema by removing explicit host-owned fields and exposing every remaining field returned by `McpTool.getConfig().inputSchema`. That kept the adapter small, but an upstream field addition would silently become Agent-visible. The official Tool inventory was also mirrored manually in code and documentation, so a rename, addition, removal, ReleaseState change, or schema change could escape review after an upstream sync.

P2 must remain read-only and default-deny. A new official Tool, annotation, description, or field is not evidence that SFoA has reviewed it for remote use.

## Decision

### One executable safety source

`packages/sfoa-mcp-server/src/official-tool-catalog.ts` is the sole safety source for:

- explicit Tool classification and P2 remote compatibility;
- dx-core Provider/package/API version baseline;
- audited Tool name, ReleaseState, input field names, required fields, and output-schema capability;
- the three remote contracts' host-owned and allowed Agent arguments.

Documentation is an informational snapshot and cannot authorize a Tool or field.

### Inspect the real public Provider

The compatibility inspector constructs the pinned public `DxCoreMcpProvider`, calls `getName()`, `getVersion()`, `provideTools()`, and each Tool's public `getReleaseState()`/`getConfig()`, and resolves the installed dx-core package manifest. It does not parse documentation or import private host internals.

The comparison reports `ADDED`, `REMOVED`, `RELEASE_STATE_CHANGED`, and `SCHEMA_CHANGED`, plus Provider/package version changes. The schema comparison intentionally covers the public security surface: input field names, required/optional status, and output-schema presence/fields. Exact package version remains part of the audited contract for deeper implementation changes.

### Separate review failure from production exposure

Any inventory drift makes the repeatable `validate:upstream` compatibility Gate return `UPSTREAM_REVIEW_REQUIRED` and a non-zero exit code.

An added, unconfigured Tool does not by itself stop the production Host. Registration remains the intersection of the explicit catalog, P2 classifications, remote compatibility, Provider presence, and `MCP_ENABLED_TOOLS`, so the new Tool is invisible and uncallable.

Any Provider/package/API, ReleaseState, removal, or schema drift that affects an enabled remote Tool fails production startup with `MCP_UPSTREAM_TOOL_CONTRACT_DRIFT`. Enabling a previously disabled remote-compatible Tool subjects it to the same check.

### Project remote schemas from a whitelist

`RemoteToolFacade` validates the complete official Tool contract before registration, then constructs the Agent schema from `allowedAgentArguments` only. It no longer exposes “all fields except host-owned fields.” Host-owned fields are injected only from the authoritative request route and request workspace.

Annotations, descriptions, names, and Provider presence never assign a classification or add an Agent field.

## Consequences

### Positive

- New official Tools and fields remain denied until maintainer review.
- Missing or renamed host/Agent fields and ReleaseState changes fail closed.
- The compatibility Gate gives upstream-sync reviewers deterministic add/remove/schema evidence.
- Catalog, governance, facade ownership, and audited dx-core inventory no longer maintain separate security mappings.
- Official Salesforce Tool implementation and `Tool.exec()` remain unchanged.

### Negative

- Upstream version/schema changes require an explicit catalog review even when semantically harmless.
- The catalog contains more audited data for the 13 dx-core Tools.
- Documentation can lag as prose, although that lag cannot alter runtime authorization.

## Rejected alternatives

1. Infer READ from names, annotations, or descriptions: rejected because upstream metadata is not authorization.
2. Automatically expose unknown non-host fields: rejected because field safety requires review.
3. Stop production for every unrelated added Tool: rejected because registration-time default deny already prevents exposure; the compatibility Gate still fails for review.
4. Parse Markdown inventory: rejected because documentation is not an executable Provider contract.
5. Patch or copy official Tools: rejected because public Provider/Tool APIs provide all required inspection and delegation seams.

## Gate

Acceptance requires exact pinned inventory PASS; added unknown Tool review detection; enabled added-field startup failure; missing host/Agent field and ReleaseState failure; exact remote `tools/list` schemas; identity-forgery regression; unchanged P2 security/cleanup gates; and zero official Salesforce TypeScript modifications.

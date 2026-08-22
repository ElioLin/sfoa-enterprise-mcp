# MCP Engineering Rules

Source basis:

- Anthropic `mcp-builder` engineering guidance (`SKILL.md`, MCP best practices, TypeScript server guide, and evaluation guide).
- Official MCP TypeScript SDK documentation and Streamable HTTP transport guidance.
- Salesforce DX MCP Provider API and current Tool implementations at the audited Upstream commit.

The guidance is an engineering standard, not a production runtime dependency.

## Tool selection

1. Prefer broad, composable Salesforce capabilities over narrow business-analysis Tools.
2. Reuse an official Tool when its semantics match. Do not create an alias with a business-specific name.
3. Add a workflow Tool only when it provides deterministic value that agents cannot reliably compose from generic operations.
4. Keep operations focused and atomic. Separate read, create, and update semantics when their authorization or annotations differ.
5. Prefix new cross-server Tool names with a stable service/domain identifier when collision is plausible; otherwise follow the established Salesforce registry naming.

## Tool contract

Every new Tool configuration must include:

- a stable, action-oriented `snake_case` name;
- a concise title;
- a description that states what the Tool does and does not do;
- clearly described inputs, constraints, defaults, and examples;
- a Zod input shape with size/range/enum constraints;
- all applicable annotations;
- an output schema when the output has a stable machine-readable form.

Use the modern SDK `registerTool` path. Do not introduce deprecated manual list/call handlers for new code.

## Input validation

- Validate every external identifier, URL, path, enum, array length, string length, and numeric range.
- Prefer strict Zod objects for SFoA-owned Tools. The upstream Provider API currently accepts raw Zod shapes; preserve compatibility when adapting official Tools.
- Treat Tool arguments as untrusted. A remote client-supplied Salesforce username is never proof that the caller may use that identity.
- Reject path traversal and use absolute workspace paths.
- Do not compose shell commands from Tool input.
- Parse external responses as `unknown` and validate before use.

## Output and structured content

- Return concise text content for compatibility with current clients.
- When a stable result exists, define `outputSchema` and return the same data in `structuredContent`.
- Keep field names/types consistent across related Tools.
- Avoid returning authorization records, tokens, private-key data, or noisy SDK internals.
- Convert large raw results into bounded, relevant slices without hiding that truncation occurred.

The current official dx-core Tools primarily return text and do not define output schemas. New SFoA Tools should improve this contract without rewriting official Tools in P0.

## Pagination and response limits

List/query Tools must:

- accept a bounded `limit` (typically default 20-50, hard maximum appropriate to the API);
- use a cursor or offset rather than loading all records;
- return count plus `has_more` and a next cursor/offset;
- support filters that reduce context;
- enforce a documented response character budget;
- set `truncated: true` and provide an actionable continuation message when truncation occurs.

SOQL supplied directly by the agent is an official generic capability. Governance should constrain identity, object/mutation scope, timeout, and response size without building a second query language.

## Annotations

Set all applicable hints deliberately:

| Annotation | Rule |
| --- | --- |
| `readOnlyHint` | `true` only when no external or local state changes |
| `destructiveHint` | `true` when data/files can be deleted, overwritten, or materially changed |
| `idempotentHint` | `true` only when identical repeated calls cause no additional effect |
| `openWorldHint` | `true` when the Tool interacts with external systems/entities |

Annotations are client hints. Server-side authentication, routing, allowlists, and Salesforce authorization remain mandatory.

## Error contract

- Return expected Tool execution failures as a Tool result with `isError: true`.
- Reserve JSON-RPC protocol errors for malformed/invalid protocol operations.
- State what failed, the safe next action, and which parameter/permission/configuration to check.
- Never include access tokens, refresh tokens, JWTs, private-key content, raw auth records, or stack traces in client-facing errors.
- Log internal correlation details server-side with redaction.
- Do not let telemetry or response instrumentation fail a Tool call.

## TypeScript rules

- Enable strict TypeScript.
- Do not use `any`; prefer specific types, generics, `unknown`, Zod parsing, and type guards.
- Give I/O functions explicit `Promise<T>` return types.
- Use async/await for network/filesystem operations.
- Centralize connection creation, error mapping, pagination, redaction, and output budgeting.
- Avoid speculative abstractions; shared code must have a demonstrated cross-Tool use.

## Transport rules

### stdio

- Retain stdio for local clients.
- Write protocol messages only to stdout; diagnostics go to stderr.
- Treat one stdio process as a local/process-scoped security boundary.

### Streamable HTTP

- Use Streamable HTTP for Dify, WorkBuddy, and other remote clients.
- Prefer a stateless server factory initially (`sessionIdGenerator: undefined`) unless a feature requires sessions/resumption.
- Validate authentication before creating request-scoped Salesforce services.
- Validate HTTP method, content type, host, and origin; enable DNS rebinding protections where supported.
- Bind local POCs to `127.0.0.1`, not `0.0.0.0`.
- Close the transport after each stateless response and clean up request-scoped resources.
- Do not add legacy standalone SSE for a new deployment; Streamable HTTP may use SSE internally when required by the protocol.

## Salesforce identity rules

- Resolve `platformUserId` from authenticated middleware, not Tool arguments.
- Resolve one configured Salesforce username/credential reference from that platform identity.
- Build or fetch a request-scoped `Connection` with bounded token caching and expiry handling.
- Pass that Connection through the Provider API `OrgService` seam.
- Let Salesforce enforce object/field/record access and automation.
- Tool allowlists govern which operation is exposed; they do not replace Salesforce permissions.

## Test layers

| Layer | Required coverage |
| --- | --- |
| Unit | Zod validation, identity mapping, allow/deny rules, error redaction, pagination, response budgets |
| Provider integration | Services injection, official Tool registration, Connection selection |
| MCP protocol | initialize, initialized notification, `tools/list`, valid/invalid `tools/call`, shutdown |
| Transport | stdio and Streamable HTTP, JSON mode, wrong method/content type, host/origin rejection |
| Salesforce live | JWT login, org display, SOQL, metadata workspace, token expiry, Salesforce permission denial |
| Multi-user | A/B identity isolation, concurrent requests, no cross-user Connection/cache leakage |
| Agent evaluation | Stable, read-only, multi-step questions with single verifiable answers |

Use the project-local Inspector or SDK client. A global Inspector installation is not a prerequisite.

## Evaluation rules

When P6 creates agent evaluations:

- create 10 independent, read-only, non-destructive, idempotent questions;
- require meaningful multi-step exploration rather than exact keyword lookup;
- use historical/fixed windows so answers are stable;
- make each expected answer a single directly comparable value;
- verify every answer by solving it with the MCP Tools;
- remove any evaluation that requires a write;
- keep exploratory calls bounded and paginated.

P0 protocol smoke tests are not the P6 evaluation suite.

## Definition of done for a new Tool

- Reuse assessment is documented.
- Input/output/error/annotation contract is complete.
- Strict TypeScript build passes.
- Unit, invalid-input, authorization, and integration tests pass.
- stdio and/or HTTP protocol call passes as applicable.
- No secrets appear in source, fixtures, logs, snapshots, or errors.
- Baseline/ADR/changelog are updated when scope or architecture changes.

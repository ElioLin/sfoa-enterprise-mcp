# SFoA P9 Data Provider

Private Provider API extension for Salesforce **data completeness**: schema discovery and
bounded, auditable reads. Every Tool reads through the request-scoped USER Connection
obtained from the request `OrgService`; nothing in this package self-authenticates, and no
Tool parameter can name a username, platform user, instance URL, token or API version.

| Tool | Salesforce surface | Purpose |
| --- | --- | --- |
| `list_sobjects` | `describeGlobal()` | SObject inventory with a prefix filter and a bounded page |
| `describe_sobject` | `describe()` | Field, picklist and child-relationship schema for self-repair |

T2–T4 add `query_records`, `get_org_limits`, `search_records` and the Bulk API 2.0 pair to
this same Provider. See [ADR-0024](../../docs/sfoa/adr/ADR-0024-p9-data-provider-over-official-sdk.md)
for the upstream audit that put these on the official jsforce SDK instead of a reused or
wrapped upstream Tool.

## Contract rules these Tools follow

- **Bounded everything.** Every Tool has a default and a hard limit, and reports
  `totalCount`/`returnedCount`/`truncated` rather than implying the answer is complete.
  `truncated: true` always carries a `hint` naming the next concrete step.
- **Response byte budget.** Results are trimmed to `DATA_MAX_RESPONSE_BYTES` (256 KiB)
  before returning, and the trim is measured against the fully rendered response — so the
  reported `truncated`/`hint` facts are inside the payload that was actually measured.
- **Structured errors.** Failures are `isError: true` with
  `{success: false, errorCode, message, suggestion?, salesforceErrorCode?}`. A message may
  repeat a Salesforce code and message only when Salesforce actually reported a code;
  otherwise the original error is attached as `cause` for operators and never echoed.
  Tokens, session IDs, private keys, JWTs and stacks are sanitized out.
- **No identity input.** The registered schema has no credential, identity or endpoint
  parameter, so an unrecognised key cannot change which Salesforce user is read.

## Why the input schema is not `.strict()` at the wire level

`McpToolConfig.inputSchema` is a `z.ZodRawShape`, so the SDK registers `z.object(shape)` and
an unrecognised key is stripped rather than rejected. Provider-side `.strict()` parses are
therefore a **second** line of defence behind the registered schema, not the first. The
guarantee that holds at the protocol boundary is field-level: an invalid object name or an
out-of-range limit is refused before any Connection is opened. This is asserted by
protocol test in `packages/sfoa-mcp-server/src/test/data-tool-runtime.test.ts`.

## Governance

These Tools are `READ` / `USER` and **default-disabled**: they are not in
`DEFAULT_ENABLED_TOOLS`. An Admin enables each one through the control-plane `enabledTools`
channel, after which it appears in `tools/list` and executes through the P7 audit pipeline.
A disabled Tool is invisible and unaddressable.

The Admin catalog entry lives in `packages/sfoa-admin-api/src/tool-catalog.ts` and is not
optional — a Tool absent from that catalog could never be enabled by any Admin.

## Development

```bash
yarn build      # tsc -p tsconfig.json
yarn lint       # tsc --noEmit
yarn test       # build, then node --test dist/test/*.test.js
```

Tests use stub `OrgService`/`Connection` fixtures (`src/test/data-fixtures.ts`). Because the
P7 audit adapter patches `Transport.prototype.httpRequest`, a stubbed Connection bypasses
wire-level audit by design; host-level audit is asserted separately in
`packages/sfoa-mcp-server/src/test/data-tool-runtime.test.ts` at the Tool terminal-event layer.

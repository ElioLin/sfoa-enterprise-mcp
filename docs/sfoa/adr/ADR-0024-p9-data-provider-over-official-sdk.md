# ADR-0024: Implement the P9 Data Tools as an SFoA Provider over the official jsforce SDK

- Status: Accepted for P9
- Date: 2026-09-24
- Supersedes: none
- Extends: ADR-0001 upstream extension boundary, ADR-0005 remote Tool governance, ADR-0007 upstream contract drift guard, ADR-0008 P3 generic DML provider

## Context

The September 2026 capability gap analysis records three P0 read gaps that make
Agent-driven Salesforce analysis structurally unreliable:

- **GAP-D1** — `run_soql_query` cannot consume `nextRecordsUrl`, the platform refuses
  `OFFSET > 2000`, and there is no row budget. Any dataset larger than one batch is
  therefore analysed **incompletely and silently**, because the Tool reports the first
  batch as if it were the answer.
- **GAP-D3** — there is no `describe` capability at all. An Agent cannot discover field
  names, types or relationships, and after an `INVALID_FIELD` it has no self-repair path
  except guessing again.
- **GAP-D9** — org governor limits are invisible, so an Agent cannot tell whether a large
  export will exhaust the daily API or bulk allowance before it starts.

P9 (`GAP-D1/D3/D5/D7/D9`) closes these with six capabilities. ADR-0001 and
`docs/sfoa/UPSTREAM_STRATEGY.md` require the reuse order **REUSE → EXTEND → official SDK**
to be audited against the pinned upstream before any SFoA implementation is written.

## Upstream-first audit

### Pinned official Provider

`@salesforce/mcp-provider-dx-core@0.10.0` was inspected directly, not inferred from names.
Its `provideTools()` returns exactly 13 Tool classes:

```text
assign_permission_set  create_org_snapshot  create_scratch_org  delete_org
deploy_metadata        get_username         list_all_orgs       open_org
resume_tool_operation  retrieve_metadata    run_agent_test      run_apex_test
run_soql_query
```

None of them is a describe, SObject-inventory, org-limit, SOSL search or Bulk API
capability. `list_all_orgs` is the nearest name and is unrelated: it lists **orgs in the
CLI auth cache**, not SObjects in an org.

### SFoA upstream inventory

`packages/sfoa-mcp-server/src/official-tool-catalog.ts` records the same 13 names and no
other upstream Tool. The only official provider packages installed anywhere in the
workspace are `@salesforce/mcp-provider-api` and `@salesforce/mcp-provider-dx-core`; the
remaining `@salesforce/*` entries are support libraries (core, agents, apex-node,
source-deploy-retrieve, …), not MCP Providers. There is no second official Provider that
could supply the missing capabilities.

`validate:upstream` reports no drift on this inventory.

### Pinned official SDK

The pinned `@salesforce/core@8.29.0` `Connection` extends the official
`@jsforce/jsforce-node` Connection and exposes the surface P9 needs:

```text
connection.describeGlobal()          -> SObject inventory
connection.describe(objectApiName)   -> fields, childRelationships, picklist values
connection.limits()                  -> org governor limits
connection.search(sosl)              -> cross-object SOSL
connection.bulk / Connection.bulk    -> Bulk API 2.0 query jobs
connection.query(soql).nextRecordsUrl / .queryMore(...)  -> continued batches
```

Every one of these consumes the **already-authenticated request-scoped Connection**, so
ADR-0003 identity routing and Salesforce-native CRUD/FLS/sharing enforcement are untouched.

Decision: official reusable describe/limit/search/bulk Tool — **NO**. Official embeddable
SDK for all six capabilities — **YES**.

## Decision

Build one SFoA-owned Provider, `@sfoa/mcp-provider-sfoa-data`, through the public
`McpProvider`/`McpTool`/`Services` seam, and implement every capability on the official
jsforce SDK. Official Salesforce TypeScript is **not modified**: `run_soql_query` stays
byte-identical and remains the dependency of `run_diagnostic_tooling_query`.

The Provider requires exactly one allowed Salesforce username from the request
`OrgService` and obtains the request Connection through `getConnection()`. **No Tool
parameter can name a username, platform user, instance URL, token or API version**, and no
Tool self-authenticates. In the registered schema there is no identity parameter at all,
so identity cannot be requested even by a malformed call.

### Toolset and naming

| Task | Tool | Official SDK surface |
| --- | --- | --- |
| T1 | `list_sobjects`, `describe_sobject` | `describeGlobal()`, `describe()` |
| T2 | `query_records` | `query()` + `nextRecordsUrl` / `queryMore()` |
| T3 | `get_org_limits`, `search_records` | `limits()`, `search()` |
| T4 | `submit_bulk_query`, `get_bulk_query_results` | Bulk API 2.0 |

> `get_org_limits` no longer lives in this Provider: it moved to
> `@sfoa/mcp-provider-sfoa-context` and to the server-owned `DIAGNOSTIC` role, because the
> `limits` resource is org configuration that no business identity is granted. The table above
> records this ADR's original scope; see
> [ADR-0027](ADR-0027-p9-org-limits-diagnostic-identity.md) for the revision. `search_records`
> and T4 are unaffected.

`list_sobjects` is a deliberate rename of the gap analysis' `describe_global`. The analysis
named the capability after the SDK method; the Tool is named after what the Agent gets
back. "describe global" is Salesforce-internal vocabulary that reads as a variant of
`describe_sobject` to a model choosing between the two, which is the wrong association —
`list_sobjects` returns an inventory, not a schema.

### Governance: default-disabled, Admin-enablable

All Data Tools are `READ`, `USER`, and **absent from `DEFAULT_ENABLED_TOOLS`**. An Admin
enables them through the control-plane `enabledTools` channel. They are registered in the
P9 package only for the names in that channel, so a disabled Tool is invisible in
`tools/list` and unaddressable in `tools/call`; enabled Tools run through the P7 audit
pipeline like every other Tool.

A tool that ships default-disabled is only shippable if an Admin can find and enable it, so
`packages/sfoa-admin-api/src/tool-catalog.ts` lists every `SFOA_DATA_TOOL_NAMES` entry with
`classification: 'READ'`, `executionRole: 'USER'` and `enableAllowed: true`. Without that
catalog entry the Tool would be advertised nowhere and permanently unenableable — the whole
default-disabled design would be dead code.

`provider-runtime.ts` excludes Data names from the official filter, and a Provider that
redefines a Data Tool name aborts composition with
`MCP_PROVIDER_INITIALIZATION_FAILED` rather than silently overriding it.

### Audit purpose

Data Tools carry no SOQL statement, so they do not use the query-semantic channel. The host
facade pins each Tool to a `SalesforceApiPurpose` in a compile-enforced
`Record<SfoaDataToolName, SalesforceApiPurpose>` map (`list_sobjects` and `describe_sobject`
→ `OBJECT_SCHEMA`), so a future P9 Tool cannot ship without its audit classification being
decided in the layer that owns the audit contract. `SalesforceApiPurpose` is stored as free
form `VARCHAR(256)`, so no migration is required.

Bounded request summaries (`objectApiName`, `filter`, ≤64 chars) stay in the clear because
they are schema identifiers, not user data; the Data Tools take no SOQL statement and
therefore have no query text to hash.

## Findings recorded from the official API

**`McpToolConfig.inputSchema` is a `z.ZodRawShape`, not a `z.ZodType`.** The official
declaration is `inputSchema?: InputArgsShape` with `InputArgsShape extends z.ZodRawShape`,
so the SDK registers `z.object(shape)` and the registered wire schema is permissive: a
caller that sends an unrecognised key gets it **stripped**, not rejected, and the Tool body
still runs. A provider-side `.strict()` Zod object cannot reach the wire.

This bounds what "strict Zod input" in `docs/sfoa/MCP_ENGINEERING_RULES.md` can mean, so
the Data Tools hold the guarantee on the axis that matters instead of claiming one they
cannot deliver:

- **Field-level constraints do hold at the protocol boundary.** A relationship path, an
  empty object name or an out-of-range limit fails the registered schema's `pattern`/
  `minLength`/`minimum`, so the call is refused as invalid arguments and no Connection is
  ever opened. This is asserted by protocol test.
- **Unknown keys are inert, not authoritative.** Because no identity parameter exists in
  the schema, a caller-supplied `username`/`accessToken`/`instanceUrl` cannot select an
  identity; the request identity stays fixed by the authenticated route. The protocol test
  asserts that a call carrying those keys returns byte-identical output to the same call
  without them and still reads the request's single Salesforce user.
- The Provider's own `.strict()` parse stays as a second line of defence for any caller that
  does not go through the registered schema.

**Whitespace in an org string is part of the fact, so the readers must not normalize it.**
The live validation run found this: the first `readString` helper trimmed every string, and a
real `describe()` of Account returned the picklist label `"Z1 不检查信用 "`. The Tool reported
`"Z1 不检查信用"` — a string the org never declared. The impact is not cosmetic: an Agent
matching a label for a human, or copying a picklist `value` into a later write, would be
working from a fact that does not exist.

The readers are therefore split by the role the text plays, rather than by one lossy helper:

- **Display facts** (object `label`/`labelPlural`, field `label`, picklist `label`) are
  reported **verbatim**, including surrounding whitespace; only an empty string means
  "absent", which is what the `?? apiName` fallbacks rely on.
- **Identifiers** (object, field, relationship and picklist API names, `referenceTo` targets,
  `type`, `keyPrefix`) are reported verbatim too, but are held to the stricter rule that text
  which is *whitespace only* is not an identifier at all. Such a payload entry is **dropped**,
  not rewritten: reporting `"   "` as an object name would advertise something the Agent
  cannot describe or query, so filtering an unactionable entry is honest where trimming a real
  value is not.

## Consequences

### Positive

- Six capabilities on the proven request-scoped Connection path; ADR-0003 identity
  authority and Salesforce-native permissions remain the only authorization engine.
- Official Salesforce TypeScript is unchanged, so upstream drift cannot be introduced here
  and `validate:upstream` stays clean.
- Compile-enforced audit-purpose mapping means a new Data Tool cannot silently land in the
  audit pipeline unclassified.
- An operator can grant read capability per Tool instead of per Provider.

### Negative

- SFoA owns the schema projection, truncation policy and error mapping for six Tools,
  because upstream supplies none of them.
- The registered input schema is permissive at the wire level (see Findings), so
  per-Tool strictness is a Provider-side property, not a protocol-enforced one. Any future
  rule that must be enforced **before** the Tool body runs has to be expressed as a
  field-level constraint, not as an object-level `.strict()`.
- Six more default-disabled Tools expand the Admin catalog surface and must be enabled
  deliberately before an Agent can use them.

## Rejected alternatives

1. **Wrap or fork `run_soql_query`** (the gap analysis' original P9-1 "EXTEND wrapper"
   wording): rejected because the official Tool is a dependency of
   `run_diagnostic_tooling_query`, so changing its behaviour would change the diagnostic
   route's contract as a side effect. P9 adds a new Tool instead and leaves the official
   one intact.
2. **Hosted Salesforce MCP for schema/query**: rejected on the same grounds as ADR-0008 —
   no proof of availability for Salesforce on Alibaba Cloud, and it introduces a second
   session model that bypasses request-scoped identity.
3. **Raw `Connection.request()` REST paths**: rejected; the typed SDK methods are narrower
   and avoid inventing an arbitrary-REST surface.
4. **Copy the deleted pre-Provider `sf-*` Tool sources**: rejected; they are not public API,
   use CLI-era identity selection, and have no governance.
5. **Reimplement schema/limits knowledge in SFoA configuration**: rejected; the org is the
   only authority on its own schema and limits, and a mirror would be wrong the moment a
   field is deployed.

## Gate

Acceptance per Tool: unit tests over a stub Connection, protocol tests for
disabled/enabled/refused-input/allowed, a live SFoA read whose facts match the org, a P7
audit evidence chain with no token or key material, and the P0–P8 regression set. Missing
live conditions stay `NOT TESTED`; they cannot be simulated into PASS.

The live read is executed by `packages/sfoa-mcp-server/src/validation/p9-live-validation.ts`
(`yarn validate:p9`), which starts the **production** runtime — the real MySQL control plane,
the real P7 audit stack and the real identity runtime — against the local org, and compares
every returned fact with an independent read over the same request-scoped Connection. It
grants the Data Tools to that run by *widening the in-memory policy snapshot*, so the local
Control Plane rows are never altered to make a gate pass.

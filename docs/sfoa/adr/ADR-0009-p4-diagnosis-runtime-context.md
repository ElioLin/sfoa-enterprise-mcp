# ADR-0009: Compose Official Diagnostic Primitives with REST UI API Context

- Status: Accepted for P4 implementation
- Date: 2026-08-23
- Supersedes: none
- Extends: ADR-0003 request-scoped identity routing, ADR-0005 remote Tool governance, ADR-0007 upstream contract drift guard, and ADR-0008 generic DML provider

## Context

P4 must give an Agent current Salesforce facts for diagnosis and record actions without turning MCP into a business-rule engine, permission replica, metadata cache, evidence graph, or runtime form engine. The accepted identity boundary is:

```text
authenticated platformUserId
  -> USER request scope for record/UI facts and DML
  -> server-owned DIAGNOSTIC request scope for Tooling/metadata facts
  -> Salesforce remains authoritative
```

Before implementation, P4-00 inspected the installed Provider implementations and exercised the current SFoA instance rather than assuming capability from names or documentation.

## P4-00 official capability audit

### Pinned Provider inventory

The installed versions remain:

- `@salesforce/mcp-provider-api@0.6.0`
- `@salesforce/mcp-provider-dx-core@0.10.0`
- `@salesforce/core@8.29.0`

Actual public Provider initialization returned 13 dx-core Tools, of which nine are GA. `get_username`, `run_soql_query`, and `retrieve_metadata` remain GA. Their public contracts have no output schema.

`run_soql_query` calls `connection.tooling.query()` when `useToolingApi` is true and `connection.query()` otherwise. It changes the process CWD to its `directory` input. Decision: keep the official Tool unchanged and use it as the internal primitive for a narrow diagnostic facade that owns username, directory, and `useToolingApi: true`.

`retrieve_metadata` resolves an DX project and manifest, changes process CWD, retrieves through the official Source Deploy Retrieve stack, writes source-format files, and returns status text only. A live request succeeded in 7.6 seconds, returned one 796-character text block with no `structuredContent` or XML, and wrote 137 retrieved files into the isolated request workspace. The workspace was then removed and CWD restored. Decision: keep the official Tool unchanged and add only a same-request bounded file-content adapter because a stateless remote Agent cannot read the cleaned workspace on a later call.

Actual `CodeAnalyzerMcpProvider` initialization returned six Tools. Its analysis flow requires Agent-selected absolute local targets and a durable local project, while result-querying reads an Agent-selected absolute result file written under the process-global temporary directory. Those contracts do not fit the stateless request-owned workspace or its cleanup/authority boundary. Decision: **NOT REMOTE COMPATIBLE**. P4 will not expose, copy, rewrite, or add infrastructure for Code Analyzer. The Agent can reason over bounded retrieved Apex/metadata source.

### Live SFoA UI API

Both configured USER routes authenticated as their expected identities against API version `67.0`. The controlled `Lead` audit produced:

- Object Info: **PASS** for labels, fields, field types/required/createable/updateable facts, record-type availability, and default record type. USER A received 138 fields and eight available record types; USER B received 102 fields and two available record types. These are recorded as observed Salesforce facts, not fabricated test differences.
- REST Layout for `Full` + `Create` and `Full` + `Edit`: **PASS** for both users with explicit object, record type, mode, and `Large` form factor.
- Create Defaults: **PASS** for both users, including effective record type, default field values, layout, and object info.
- Record-type Picklist Values: **PASS** for both users, including defaults, controller maps, and dependent `validFor` facts.
- GraphQL UI API introspection and `recordLayouts`: **PASS** with zero GraphQL errors; eight layouts were visible and the bounded query returned one edge.

GraphQL `recordLayouts` works, but P4 does not require it. At the verified API boundary, REST UI API already supplies Object Info, Create/Edit Layout, Create Defaults, and record-type Picklists through one consistent public surface. Choosing GraphQL only for layout would add a second query/schema path without increasing P4 coverage. Decision: use REST UI API for P4 record-action context; retain GraphQL as audited, **NOT REQUIRED** capability.

## Decision

### Tool surface and identity

P4 adds three explicit, independently enableable Tools:

- `get_record_action_context` — USER only; reads deterministic REST UI API facts.
- `run_diagnostic_tooling_query` — DIAGNOSTIC only; delegates to official `run_soql_query` while the Host forces Tooling API, the fixed diagnostic username, and the request workspace.
- `get_metadata_component_context` — DIAGNOSTIC only; generates a server-owned manifest, delegates retrieval to official `retrieve_metadata`, then returns bounded UTF-8 files from that same request workspace.

No P4 schema contains a platform user, Salesforce username/alias, connection role, credential profile, token, instance URL, arbitrary URL, directory, source directory, manifest path, or output path.

The Host selects execution scope from the registered Tool's fixed role mapping. A diagnostic Tool name can select only a fresh server-owned DIAGNOSTIC scope; an input field cannot select or override the role. USER Tool facades reject DIAGNOSTIC scopes and diagnostic facades reject USER scopes. This also prevents a mixed or malformed request from using a diagnostic Connection for business SOQL or DML.

### Diagnostic configuration

`SFOA_DIAGNOSTIC_USERNAME` is optional while both diagnostic Tools are disabled and must be distinct, case-insensitively, from every configured USER Salesforce username whenever supplied. A collision, or enabling either diagnostic Tool without the setting, fails startup with `MCP_DIAGNOSTIC_CONFIGURATION_INVALID`. P4 reuses the existing Connected App client ID and JWT private key because the current architecture and audit show no requirement for a second OAuth configuration. Each diagnostic Tool call creates a fresh Connection and bounded workspace; no Connection/token cache, pool, database, or Redis is added.

### Diagnostic query boundary

The diagnostic query schema accepts only a bounded SOQL `SELECT` string. The facade always injects `useToolingApi: true`; that switch is absent from the Agent schema. It parses and bounds the official result for stable structured output. It never calls the normal data query API, DML, anonymous Apex, or metadata deployment.

### Metadata context boundary

The initial metadata allowlist is:

```text
CustomObject
CustomField
ValidationRule
Flow
ApexClass
ApexTrigger
Layout
FlexiPage
```

The Agent supplies only `metadataType` and a validated Metadata API `fullName`. The server creates and XML-escapes the manifest. It reads only files created beneath the request-owned source directory, sorts them deterministically, accepts UTF-8 text only, and applies maximum file-count, per-file-byte, and total-byte limits. Truncation and omitted-file summaries are explicit. No snapshot, cache, filesystem Tool, arbitrary package manifest, or source-directory input is added.

### Record action context boundary

`get_record_action_context` uses the current USER Connection and REST UI API. CREATE resolves the default record type unless an explicit currently available record type is supplied. UPDATE derives the record type from the addressed record and fails closed when an explicit record type disagrees. The output preserves separate facts for API required, layout required, field createable/updateable, layout editability by action, Salesforce create defaults, record-type picklists and dependency data, labels/types/references, and layout membership/order.

Field and picklist output is bounded. Required fields have priority and are never silently dropped from a successful truncated result. Truncation, source coverage, API-call count, duration, response bytes, and the lack of complete Dynamic Forms/Lightning-page evaluation are explicit. Unsupported UI API objects fail with `MCP_RECORD_ACTION_CONTEXT_UNSUPPORTED`; Describe is not used to simulate a layout or record-type context.

The Tool returns facts only. It does not decide missing input, ask the user, recommend fields, resolve lookups, interpret Validation Rules/Flow/Apex, or invoke CREATE/UPDATE.

## Consequences

### Positive

- Official `run_soql_query` and `retrieve_metadata` implementations remain the execution primitives.
- DIAGNOSTIC authority is server-owned, read-only, request-scoped, and structurally unavailable to business query/DML Tools.
- The current USER's native UI API facts reach the LLM without a second permission or form engine.
- REST UI API covers all required P4 record-action facts at the verified SFoA API version.
- Context size and temporary filesystem exposure are bounded and observable.

### Negative

- SFoA owns narrow Provider/Host adapters because official Tool results do not expose remote-consumable metadata content or a diagnostic-only schema.
- Record-action context needs multiple live UI API requests and has no shared cache in P4.
- The Page Layout context is not a full Dynamic Forms or Lightning component-visibility evaluation.
- Code Analyzer is not exposed in the remote runtime.

## Rejected alternatives

1. Expose official `run_soql_query` with a diagnostic username or `useToolingApi` switch: rejected because the client could select identity or the normal business query path.
2. Expose official `retrieve_metadata` directly as the Agent diagnosis workflow: rejected because its source files disappear with the stateless request workspace and its schema accepts filesystem-oriented inputs.
3. Copy either official Tool: rejected because their public `Tool.exec()` seam is sufficient.
4. Use GraphQL only for layouts: rejected because the verified REST surface covers all P4 UI facts consistently.
5. Make Code Analyzer durable with shared temp files or a project cache: rejected because that expands filesystem authority and infrastructure beyond P4.
6. Build a permission engine, metadata snapshot, evidence graph, runtime form engine, Dynamic Forms evaluator, validation interpreter, or lookup resolver: rejected because Salesforce and the LLM retain those responsibilities.

## Gate

Acceptance requires Tool-contract, configuration, role-isolation, USER A/B, record-type, required/editable/default/picklist, bounded/truncation, metadata path/size/cleanup/CWD/concurrency, official-delegation, live diagnosis, protocol, P0-P3 regression, changed-code lint, and upstream-diff evidence. Missing real diagnostic credentials or controlled metadata scenarios remain `NOT TESTED`; they cannot be promoted to PASS by mocks.

# P4 Agent Guidance

This guide defines how an LLM/Agent should compose the P4 Salesforce facts. Salesforce remains the authority, MCP supplies governed facts and execution, and the LLM owns reasoning and dialogue.

## Authority and Tool roles

| Tool | Fixed role | Purpose |
| --- | --- | --- |
| `get_username` | USER | Confirm the Salesforce user resolved from the authenticated platform user |
| `run_soql_query` | USER | Read business records as the current Salesforce user |
| `get_record_action_context` | USER | Read the current user's effective record type, Page Layout/UI API, required/editable/default/picklist facts |
| `create_record` | USER | Perform one governed CREATE after the LLM has obtained the needed user facts |
| `update_record` | USER | Perform one governed UPDATE after the LLM has obtained the needed user facts |
| `run_diagnostic_tooling_query` | DIAGNOSTIC | Read Tooling API facts with the fixed server-owned integration user |
| `get_metadata_component_context` | DIAGNOSTIC | Retrieve one allowlisted metadata component through the official metadata Tool and return bounded source evidence |

The client never chooses `USER` or `DIAGNOSTIC`. Do not send a username, role, token, instance URL, directory, manifest, source directory, arbitrary URL, or `useToolingApi` switch to a P4 Context Tool. Diagnostic Tools may be unavailable until the operator enables them and configures `SFOA_DIAGNOSTIC_USERNAME`.

## CREATE workflow

```text
User request
  -> extract only values the user actually supplied
  -> get_record_action_context(action=CREATE)
  -> compare supplied values with Salesforce facts
  -> required value missing and no Salesforce default?
       YES -> ask the user
       NO  -> continue
  -> validate supplied picklist values against the returned record-type values
  -> resolve ambiguous lookups with USER run_soql_query and, if needed, ask the user
  -> create_record once
```

Use the default Record Type returned by Salesforce when the user did not choose one. If the request supplies `recordTypeId`, the Context Tool verifies that it is available to the current USER. Use a returned `defaultValue` only when Salesforce actually supplied it.

Do not invent values such as stage, close date, owner, account, or status. When `apiRequired` or `layoutRequired` is true, the user supplied no value, and `defaultValue` is null, ask the user. A field can be API-required without being layout-required, and vice versa; preserve that distinction.

## UPDATE workflow

Call `get_record_action_context` with `action=UPDATE` and the target `recordId`. The Tool derives the record's real Record Type. If an explicit `recordTypeId` is also supplied and differs, the Tool fails closed; do not silently switch the record type.

Use `fieldUpdateable` and `layoutEditableForUpdate` as separate Salesforce facts. They are not a local permission decision, and Salesforce still makes the final CRUD/FLS/sharing/validation decision when `update_record` executes.

## Picklists, references, and truncation

- Use picklist `value` for DML and `label` for conversation.
- Respect the returned Record Type, `controllerValues`, and each dependent value's `validFor` indexes.
- If a field or the overall coverage says `truncated=true`, never guess an omitted value. Narrow the task, query another authoritative source, or tell the user that the complete value domain was not returned.
- `referenceTo` and `relationshipName` describe lookup shape only. To resolve “the customer named Acme,” use USER `run_soql_query`; present ambiguous candidates to the user. P4 has no automatic lookup resolver.

## Diagnosis workflow

```text
User reports unexpected Salesforce behavior
  -> use USER reads for the affected record when authorized
  -> run_diagnostic_tooling_query for deterministic component discovery
  -> get_metadata_component_context for an identified allowlisted component
  -> compare the returned Tooling/metadata facts
  -> LLM explains the likely cause and clearly labels uncertainty
```

The diagnostic query is always Tooling API SELECT. It cannot switch to business-record SOQL. Metadata input is one allowlisted `metadataType` plus exact `fullName`; the server owns the manifest and workspace. Code Analyzer is not exposed in P4 because its installed contracts require untrusted absolute local paths and durable/global result files. Reason directly over bounded Apex/metadata evidence instead.

## Coverage boundary

`get_record_action_context` reports the effective REST UI API/Page Layout action context. It does not claim complete Lightning Record Page or Dynamic Forms evaluation. Read `coverage.sources`, `coverage.warnings`, `dynamicFormsEvaluated`, `completeLightningPageEvaluated`, and `truncated` before drawing a conclusion.

MCP does not determine missing business input, ask questions, recommend optional fields, execute Validation Rules, interpret Flow/Apex, or explain the final diagnosis. Those are LLM responsibilities based on the returned facts.

## Mutation UNKNOWN rule

If CREATE or UPDATE returns `MCP_DML_OUTCOME_UNKNOWN`:

1. Do not automatically retry.
2. Use a USER read-only Tool to verify Salesforce state when a reliable independent lookup is possible.
3. Retry only after the prior outcome is resolved and the user still authorizes the mutation.
4. If state cannot be verified, tell the user that the outcome remains unknown.

The correlation ID is for logs, not an idempotency key or Salesforce commit-status token.

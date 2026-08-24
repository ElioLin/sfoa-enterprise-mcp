# SFoA Tool Workflows

Follow only workflows whose exact Tool names are currently exposed by the configured MCP Connector.

## READ

1. Determine the smallest Salesforce business-data question that answers the user.
2. Call `run_soql_query` when it is available. Use bounded, relevant fields and rows.
3. Treat returned records as the only authority for current Salesforce data.
4. State when the Tool result is empty, truncated, denied, or insufficient. Do not fill gaps from model memory.

`get_username` may confirm the server-selected identity when exposed, but it never authorizes switching identity.

## CREATE

Use this workflow only when `create_record` is exposed and the requested `objectApiName` is enabled for CREATE by the current DML policy.

When `get_record_action_context` is exposed:

1. Extract only fields the user explicitly supplied.
2. Call `get_record_action_context` for the CREATE action.
3. Inspect Record Type availability, API Required, Layout Required, Salesforce Default, Picklist values, field createability, and layout editability separately.
4. Ask for required information that the user did not supply and Salesforce did not default.
5. Use only legal Salesforce-returned Picklist values.
6. Resolve Lookup candidates through USER read-only queries when needed.
7. Call `create_record` only after required information is complete.

When `get_record_action_context` is not exposed, do not pretend it was called. Ask about uncertain Record Type, required, Picklist, or Lookup values and never guess them before calling `create_record`.

## UPDATE

Use this workflow only when `update_record` is exposed and the target `objectApiName` is enabled for UPDATE by the current DML policy.

1. Uniquely identify the target Record through USER read-only evidence.
2. When field meaning or editability is uncertain and `get_record_action_context` is exposed, obtain UPDATE action context for the real Record.
3. Ask the user to resolve ambiguity. Never choose among multiple candidate records silently.
4. Send only fields the user asked to change. Do not copy unrelated record fields into the update.
5. Call `update_record` once.

## DIAGNOSIS

Use this workflow only when both `run_diagnostic_tooling_query` and `get_metadata_component_context` are exposed and the administrator has verified the Diagnostic chain.

1. Use `run_diagnostic_tooling_query` to discover relevant ValidationRule, Flow, Apex, or Metadata components.
2. Select the exact component supported by the evidence.
3. Use `get_metadata_component_context` for bounded component source/context.
4. When business-record state is needed, use USER `run_soql_query`; never use the DIAGNOSTIC account for business data.
5. Explain the cause by synthesizing Tool evidence. Do not claim that DIAGNOSTIC evidence is business-record data.

## LOOKUP / REFERENCE RESOLUTION

1. Identify the referenced object and the smallest identifying user-provided facts.
2. Use USER read-only `run_soql_query` to return bounded candidates.
3. If exactly one candidate is proven, use its Record ID.
4. If zero or multiple candidates remain, ask the user; never guess the lookup target.

## SALESFORCE REJECTION

When Salesforce rejects an operation through CRUD, FLS, sharing, Validation Rule, Trigger, Flow, required-field, lookup-filter, Picklist, or Record Type enforcement:

1. Preserve the real safe Salesforce Error Code and message.
2. Explain the rejection and the user-correctable information, when known.
3. Do not switch identity, use the DIAGNOSTIC account for the mutation, remove required controls, or seek another Tool to bypass Salesforce.

## DML OUTCOME UNKNOWN

For `MCP_DML_OUTCOME_UNKNOWN` after `create_record` or `update_record`:

1. Stop. Do not automatically retry the mutation.
2. Use an independent USER read-only Tool to verify Salesforce state when a reliable query is possible.
3. If evidence proves the mutation committed, do not execute it again.
4. If evidence proves it did not commit, retry only while the user's original intent remains valid.
5. If evidence cannot determine the result, tell the user the outcome is unknown and make no further mutation.

A Correlation ID supports troubleshooting only. It is not an idempotency key or Salesforce commit-status token.

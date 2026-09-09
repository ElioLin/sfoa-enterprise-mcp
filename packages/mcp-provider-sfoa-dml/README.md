# SFoA Generic DML Provider

`@sfoa/mcp-provider-sfoa-dml` supplies singular and bounded batch Salesforce CREATE
and UPDATE through public Provider/SDK APIs and the request-scoped USER Connection.
No CLI, Tooling DML, Bulk API, UPSERT or DELETE is exposed.

`create_record` and `update_record` retain their original one-record contracts.
`create_records` and `update_records` accept one object and 1..200 records with
optional unique clientReferenceId (<=128 characters), per-item CREATE recordTypeId
and uiContextResolutionId, and allOrNone (default false). Every item shares the
single-record CREATE/UPDATE policy and managed-field processing. Salesforce remains
the CRUD/FLS/sharing/validation/automation authority.

The array overload of `sobject().create(records, {allOrNone, allowRecursive:false})`
or `update` issues exactly one POST/PATCH `/composite/sobjects` request. API <42 and
>200 rows are rejected. There is no transaction between calls. Results contain
SUCCESS/PARTIAL_SUCCESS/FAILED/OUTCOME_UNKNOWN plus total/succeeded/failed/unknown
and correlated item outcomes. Unknown mutations are never automatically retried.

All four Tools are non-idempotent. An explicit structured Salesforce rejection returns `MCP_SALESFORCE_DML_FAILED`. A Tool/request timeout, transport interruption, or SDK exception without reliable Salesforce rejection evidence after dispatch returns `MCP_DML_OUTCOME_UNKNOWN`: do not automatically retry; first use an independent read-only Tool to verify Salesforce state and inform the user if the state cannot be confirmed. The Provider marks a request-local observer immediately before the public SDK CREATE/UPDATE call; it performs no automatic retry, replay, or post-write query.

The remote Host loads `MCP_DML_ALLOWLIST_JSON` from the shell or ignored `.env.local`. Missing or `[]` means deny all. Example:

```text
MCP_DML_ALLOWLIST_JSON='[{"objectApiName":"Lead","operations":["CREATE","UPDATE"]},{"objectApiName":"Account","operations":["UPDATE"]}]'
MCP_ENABLED_TOOLS=get_username,run_soql_query,create_record,update_record,create_records,update_records
```

Invalid JSON, unknown fields/operations, `DELETE`, duplicate objects, and duplicate operations fail startup. Enabling a DML Tool without at least one matching allowlist rule also fails closed.

From the repository root:

```powershell
yarn workspace @sfoa/mcp-provider-sfoa-dml build
yarn workspace @sfoa/mcp-provider-sfoa-dml test
yarn workspace @sfoa/mcp-provider-sfoa-dml lint
```

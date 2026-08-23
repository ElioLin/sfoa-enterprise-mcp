# SFoA P3 Generic DML Provider

`@sfoa/mcp-provider-sfoa-dml` is the P3 SFoA-owned Provider for one-record Salesforce CREATE and UPDATE. It uses the public Salesforce Provider API and the request-scoped `OrgService`/`Connection`; it does not use Salesforce CLI, raw REST paths, Tooling DML, Bulk APIs, UPSERT, or DELETE.

The only Tool names are `create_record` and `update_record`. Every call is checked against an immutable Object-by-Operation policy before the official `@salesforce/core` Connection invokes `sobject().create()` or `sobject().update()`. Salesforce remains responsible for CRUD, FLS, sharing, validation, Flow, Trigger, required fields, and lookup filters.

Both Tools are non-idempotent. An explicit structured Salesforce rejection returns `MCP_SALESFORCE_DML_FAILED`. A Tool/request timeout, transport interruption, or SDK exception without reliable Salesforce rejection evidence after dispatch returns `MCP_DML_OUTCOME_UNKNOWN`: do not automatically retry; first use an independent read-only Tool to verify Salesforce state and inform the user if the state cannot be confirmed. The Provider marks a request-local observer immediately before the public SDK CREATE/UPDATE call; it performs no automatic retry, replay, or post-write query.

The remote Host loads `MCP_DML_ALLOWLIST_JSON` from the shell or ignored `.env.local`. Missing or `[]` means deny all. Example:

```text
MCP_DML_ALLOWLIST_JSON='[{"objectApiName":"Lead","operations":["CREATE","UPDATE"]},{"objectApiName":"Account","operations":["UPDATE"]}]'
MCP_ENABLED_TOOLS=get_username,run_soql_query,create_record,update_record
```

Invalid JSON, unknown fields/operations, `DELETE`, duplicate objects, and duplicate operations fail startup. Enabling a DML Tool without at least one matching allowlist rule also fails closed.

From the repository root:

```powershell
yarn workspace @sfoa/mcp-provider-sfoa-dml build
yarn workspace @sfoa/mcp-provider-sfoa-dml test
yarn workspace @sfoa/mcp-provider-sfoa-dml lint
```

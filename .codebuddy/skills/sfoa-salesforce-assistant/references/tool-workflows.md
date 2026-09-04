<!-- GENERATED FROM SFoA Agent Playbook (@sfoa/agent-playbook) 1.3.0; DO NOT EDIT DIRECTLY. Run yarn agent:sync. -->

# SFoA Tool Workflows

Playbook-Version: 1.3.0

## READ — Read current Salesforce data

- Form the smallest bounded query that answers the user and call an enabled USER read Tool such as `run_soql_query`.
- For a general business read, call `get_record_display_context` first when it is enabled to learn the object name/display fields and its Record Type-aware Compact and View layout order, then choose SOQL fields from the user question plus that context instead of mechanically selecting every layout field. Layouts are priority evidence, not a fixed field allowlist: select a field the question or its meaning makes important even when the Compact or View layout omits it, as long as the authenticated user can read it.
- READ is never bounded by the CREATE/UPDATE allowlists or DML policy. `run_soql_query` may read any object the authenticated Salesforce user can read — including Account, Opportunity, Contact, and custom objects that are not CREATE/UPDATE-listed. The only read-side guard is the ORG_OBJECT_USAGE substitution rule, which rejects a small set of declared not-in-use standard objects with `MCP_SOBJECT_NOT_IN_USE`.
- Select fields in this order: fields the user asked for; the proven record display/name field and trusted link; high-value current layout/context fields; then a small number of question-relevant fields. Do not lead with an internal Record ID unless the user asks for it.
- For multiple records, prefer a concise table with roughly 6 to 10 useful columns and make the display/name field the link when a trusted record URL is available. For one record, lead with the linked display/name field and show only the key facts needed for the request.
- Recognize analytical queries and do not force record framing on them: for an aggregate or summary result (for example `SELECT StageName, SUM(Amount) FROM Opportunity GROUP BY StageName`) present the statistics directly — do not fabricate an Id, add a per-row record hyperlink, or apply record display context row by row.
- Do not assume every object uses a field named `Name`; use a display/name field only when current Salesforce evidence identifies it.
- Treat empty, truncated, denied, or insufficient Tool results explicitly; never invent missing records or fields.
- `get_username` may confirm the server-selected Salesforce identity when enabled, but it never authorizes identity switching.

## ORG_OBJECT_USAGE — Use the org object substitutions

- This org declares several Salesforce standard objects NOT in use; the business records they represent live in the listed custom objects. Target the custom object, never the unused standard object.
- - Standard `Contract` (合同信息 / 合同) is not used in this org — query custom object `Contract__c` (合同信息 / 合同) instead.
- - Standard `Order` (订单信息 / 订单) is not used in this org — query custom object `Order__c` (订单信息 / 订单) instead.
- - Standard `OrderItem` (订单行 / 订单产品) is not used in this org — query custom object `Order_Product__c` (订单行 / 订单产品) instead.
- - Standard `Pricebook2` (价格手册) is not used in this org — query custom object `Pricebook__c` (价格手册) instead.
- - Standard `PricebookEntry` (价格手册条目 / 价格本条目) is not used in this org — query custom object `Pricebook_Entry__c` (价格手册条目 / 价格本条目) instead.
- - Standard `Quote` (报价单 / 报价) is not used in this org — query custom object `Quote__c` (报价单 / 报价) instead.
- - Standard `QuoteLineItem` (报价产品 / 报价行 / 报价行项目) is not used in this org — query custom object `Quote_Product__c` (报价产品 / 报价行 / 报价行项目) instead.
- When a user asks about a concept handled by a substituted object, map the concept to the custom object API name before querying; do not rely on model memory of standard-object names or labels.
- A USER `run_soql_query` whose top-level object is a declared not-in-use standard object is rejected before execution with `MCP_SOBJECT_NOT_IN_USE` and the replacement custom object. On that error, retry against the replacement custom object.

## CREATE — Create a record

- Use `create_record` only when it is enabled and the requested object is in the effective CREATE allowlist.
- Collect only values the user supplied, then call `get_record_action_context` when available and inspect CREATE context: Record Type, API-required and layout-required fields, defaults, createability/editability, Picklists, and dependencies.
- Choose the Record Type from action context instead of the default by habit: when `availableRecordTypes` has exactly one entry, use it without an extra prompt; when it has several and the user has not uniquely and reliably named one, ask the user which Record Type to use and pass the chosen value as `recordTypeId` — never silently create under the default. A user phrasing that matches exactly one available Record Type may be used directly; an ambiguous match must be asked about. When the current identity has no available Record Type, stop and tell the user the record cannot be created; never create under an unavailable or guessed Record Type.
- Classify current evidence into required, recommended, and other optional fields. Required status may come only from current Salesforce API/layout/action context, Record Type, or dependency evidence; never invent business-required fields.
- Ask for required information that the user did not supply and Salesforce did not default. When context supplies a reliable default, explain it when useful and do not ask the user to re-enter it; never invent a default or necessary value.
- Exclude MCP-managed fields from required questions, optional recommendations, and the `create_record.fields` payload even when they appear required or editable in generic Salesforce context.
- Send only fields that belong to the target object. Never carry a field across objects — for example, do not write an Opportunity field such as `Opportunity_Summary__c` into a Lead `create_record`; every field must come from the target object's own current context.
- Recommend only 3 to 8 high-value optional fields when helpful, state that they may be skipped, and choose them from the user goal plus current visible/editable layout order, labels, types, Record Type, and safe Salesforce defaults. Exclude IDs, audit/system fields, auto numbers, formulas, and non-editable fields.
- Resolve ambiguous Lookups through bounded USER reads and use only Picklist values returned for the active Record Type.
- Call `create_record` once after the necessary information and user intent are clear.
- After proven success, return the display/name field when available, a trusted Lightning record link, and the key values actually created.

## UPDATE — Update a record

- Use `update_record` only when it is enabled and the target object is in the effective UPDATE allowlist.
- First identify exactly one target record through USER evidence; ask the user when zero or multiple candidates remain.
- Call `get_record_action_context` for UPDATE when field semantics or editability are uncertain and the context Tool is enabled.
- Do not turn one-field UPDATE into a CREATE form: CREATE-required fields are not automatically required on every UPDATE. Ask for an additional field only when current UPDATE context or Salesforce enforcement proves it is necessary.
- Send only fields the user asked to change. Never copy, clear, or rewrite unrelated business fields.
- Exclude MCP-managed fields from questions, recommendations, and the `update_record.fields` payload; the server-owned value wins if a client nevertheless supplies one.
- Call `update_record` once after target, changes, and user intent are clear.
- After proven success, return the target display/name field, a trusted record link when available, and only the fields actually changed.

## DIAGNOSIS — Diagnose Salesforce behavior

- Use Diagnostic workflow only when both Diagnostic Tools are enabled and the current Diagnostic configuration is verified ready.
- Discover a bounded ValidationRule, Flow, Apex, or Metadata component with `run_diagnostic_tooling_query`, then obtain exact component evidence with `get_metadata_component_context`.
- Use the USER `run_soql_query` path for business-record state. DIAGNOSTIC evidence is not business-record data and the Diagnostic identity must never perform business DML.
- Synthesize the cause from Tool evidence and distinguish evidence, inference, and remaining uncertainty.

## LOOKUP — Resolve Lookup and reference values

- Identify the referenced object and the smallest user-provided identifying facts.
- Use a bounded USER read to return candidate IDs and useful disambiguating labels.
- Use a candidate only when exactly one target is proven. Ask the user when no candidate or multiple candidates remain.

## PICKLIST — Resolve Picklist and dependent values

- Whenever asking for a Picklist or multi-select Picklist value, show the bounded current valid choices returned by Salesforce action context for the active Record Type; never invent, translate, or normalize a stored Picklist API value.
- For dependent Picklists, confirm the controlling value first, apply the returned controller/dependency indexes, and show only values valid for that controller; never show the unfiltered dependent-value set.
- When Picklist evidence is unavailable, state that limitation and ask for confirmation rather than guessing.

## RESPONSE_FORMAT — Return a usable result

- State the action attempted and its proven result in concise language grounded in Tool output.
- For records, use the proven display/name field as the primary label and, when possible, a Markdown hyperlink obtained through `get_record_links`; never invent a Salesforce URL. Keep raw Salesforce IDs internal in normal business answers — Record Id, OwnerId, AccountId, RecordTypeId, and Lookup IDs are queried for identity, dedupe, linking, and follow-up calls, not shown to the user. Surface a Record ID only when the user explicitly asks for it or a technical diagnosis requires it.
- Shape results from the actual data and the user goal rather than a fixed template: keep fields the user asked for (say when a requested field is empty), omit whole columns that are empty or irrelevant and were not requested, hide technical fields, and prefer values that matter to the current business question. Answer like a business-aware assistant, not a SOQL JSON dump.
- When calling `get_record_links`, send `records` as an array of objects each carrying `objectApiName` and the 15- or 18-character `recordId` (optionally `displayName`). The ID field name is `recordId`, never `id`, and no other keys are accepted.
- Preserve stable Tool Error Codes and Correlation IDs exactly and state truncation or unresolved ambiguity.
- In normal success answers, describe the business outcome and omit technical MCP marker/identity-field details unless the user explicitly asks for implementation or audit detail.

## ERROR_HANDLING — Handle Salesforce and uncertain outcomes

- Explain safe Salesforce rejection details from CRUD, FLS, sharing, Validation Rule, Trigger, Flow, required-field, Lookup filter, Picklist, or Record Type enforcement. Never change identity or bypass a rule.
- For `MCP_DML_OUTCOME_UNKNOWN`, stop and do not automatically retry `create_record` or `update_record`.
- Use an independent USER read to verify commit state when reliable evidence is possible. Do not mutate again if commit is proven; retry only if non-commit is proven and the original intent remains valid.
- If commit state cannot be proven, tell the user the outcome is unknown and make no further mutation. A Correlation ID is not an idempotency key.

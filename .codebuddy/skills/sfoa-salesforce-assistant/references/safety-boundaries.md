<!-- GENERATED FROM SFoA Agent Playbook (@sfoa/agent-playbook) 1.14.0; DO NOT EDIT DIRECTLY. Run yarn agent:sync. -->

# SFoA Safety Boundaries

Playbook-Version: 1.14.0

## ERROR_HANDLING — Handle Salesforce and uncertain outcomes

- Explain safe Salesforce rejection details from CRUD, FLS, sharing, Validation Rule, Trigger, Flow, required-field, Lookup filter, Picklist, or Record Type enforcement. Once the actual rejection and available evidence establish a missing independent business choice or conflict, stop equivalent diagnostics and ask the remaining questions together. A record request does not authorize changing identity, disabling or bypassing a rule.
- For `MCP_DML_OUTCOME_UNKNOWN` or batch OUTCOME_UNKNOWN, stop and do not automatically retry create_record, update_record, create_records or update_records. UPDATE can use bounded reads of known IDs; CREATE requires a user-provided uniquely queryable business key. Without unique proof, state that some or all records may have been created and do not duplicate CREATE.
- Use an independent USER read to verify commit state when reliable evidence is possible. Do not mutate again if commit is proven; retry only if non-commit is proven and the original intent remains valid.
- If commit state cannot be proven, tell the user the outcome is unknown and make no further mutation. A Correlation ID is not an idempotency key.

## SAFETY_BOUNDARIES — Safety boundaries

- Never request or expose Salesforce passwords, JWTs, private keys, access/refresh tokens, MCP bearer tokens, or Admin secrets.
- Never switch Salesforce identity, accept a client-supplied Salesforce username as authority, or use the Diagnostic account for business reads or mutations.
- Do not DELETE, UPSERT, MERGE, DEPLOY, or use Apex/Metadata/query/diagnostic Tools as a substitute for an unavailable operation.
- Do not build or infer a second Salesforce permission engine. Respect configured Tool governance and Salesforce enforcement.
- Do not hardcode object-specific required/recommended field lists or workflows; derive recommendations from current Salesforce context and the user goal.
- Never derive or guess a strict managed field value, current platform identity lookup record, or Salesforce record URL. Use MCP-managed mutation behavior for server values and `get_record_links` for URLs; resolve explicit user values for fallback fields only through the LOOKUP workflow.
- Trust only returned formContext facts for selected desktop CREATE/UPDATE and supported native Quick Actions. Missing assignments, unsupported requiredness conditions, custom forms and hypothetical Record Type changes stay explicit UNKNOWN. Legacy per-object Dynamic Forms modes and generic DML remain compatible; they do not prove the precise selected form was checked. Never turn PAGE_LAYOUT_FALLBACK into complete Dynamic Forms evidence. Salesforce validation remains authoritative.
- Do not create a Runtime Form Engine, Lightning visibility evaluator, prompt database, or business-rule database as a substitute for current Salesforce evidence.

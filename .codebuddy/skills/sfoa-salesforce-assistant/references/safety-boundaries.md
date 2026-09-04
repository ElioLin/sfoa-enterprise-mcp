<!-- GENERATED FROM SFoA Agent Playbook (@sfoa/agent-playbook) 1.3.0; DO NOT EDIT DIRECTLY. Run yarn agent:sync. -->

# SFoA Safety Boundaries

Playbook-Version: 1.3.0

## ERROR_HANDLING — Handle Salesforce and uncertain outcomes

- Explain safe Salesforce rejection details from CRUD, FLS, sharing, Validation Rule, Trigger, Flow, required-field, Lookup filter, Picklist, or Record Type enforcement. Never change identity or bypass a rule.
- For `MCP_DML_OUTCOME_UNKNOWN`, stop and do not automatically retry `create_record` or `update_record`.
- Use an independent USER read to verify commit state when reliable evidence is possible. Do not mutate again if commit is proven; retry only if non-commit is proven and the original intent remains valid.
- If commit state cannot be proven, tell the user the outcome is unknown and make no further mutation. A Correlation ID is not an idempotency key.

## SAFETY_BOUNDARIES — Safety boundaries

- Never request or expose Salesforce passwords, JWTs, private keys, access/refresh tokens, MCP bearer tokens, or Admin secrets.
- Never switch Salesforce identity, accept a client-supplied Salesforce username as authority, or use the Diagnostic account for business reads or mutations.
- Do not DELETE, UPSERT, MERGE, DEPLOY, or use Apex/Metadata/query/diagnostic Tools as a substitute for an unavailable operation.
- Do not build or infer a second Salesforce permission engine. Respect configured Tool governance and Salesforce enforcement.
- Do not hardcode object-specific required/recommended field lists or workflows; derive recommendations from current Salesforce context and the user goal.
- Never derive or guess a managed field value, platform identity lookup record, or Salesforce record URL. Use MCP-managed mutation behavior and `get_record_links` only.
- Dynamic Forms and complete Lightning page evaluation are not available in this phase; use available action context, ask about uncertainty, and let Salesforce validation remain authoritative.
- Do not create a Runtime Form Engine, Lightning visibility evaluator, prompt database, or business-rule database as a substitute for current Salesforce evidence.

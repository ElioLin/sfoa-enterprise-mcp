# P6-DML-01 Trusted Managed Fields, Agent Guidance, and Record Links

Status: implemented; deterministic and mocked integration Gates pass; live Salesforce Gates remain Maintainer-run.

Date: 2026-08-27

## Purpose

P6-DML-01 lets the MCP host write a very small set of trusted, centrally configured fields during the existing generic `create_record` and `update_record` flows. It also teaches every canonical Agent surface to omit those fields and changes record-link construction to use one explicit trusted Lightning origin.

This is not a generic default-value engine, Salesforce permission replica, metadata synchronizer, business-rule database, or runtime form engine. Salesforce remains authoritative for CRUD, FLS, sharing, required fields, defaults, Validation Rules, Flow, Trigger, Lookup filters, and Record Types.

## Accepted scope

One child model, `sfoa_dml_managed_field_rule`, belongs to an existing DML object policy. A rule contains only:

| Field | Meaning |
| --- | --- |
| `dml_policy_id` | Existing object policy; the object API name is not duplicated in the child row |
| `target_field_api_name` | Field whose value is owned by the MCP host |
| `strategy` | `PLATFORM_USER_LOOKUP` or `AI_CREATED_MARKER` |
| `apply_on_create` / `apply_on_update` | Operation scope, constrained by the parent policy |
| `lookup_object_api_name` / `lookup_match_field_api_name` | Required only for platform-user Lookup resolution |
| `enabled`, `remark`, `row_version`, timestamps | Governance, optimistic locking, and audit support |

The parent-plus-target unique constraint prevents duplicate rules. No production migration contains a business object, field seed, platform user, Salesforce username, record ID, or default business value.

### `PLATFORM_USER_LOOKUP`

- May apply to CREATE, UPDATE, or both, but only where the parent DML policy allows the same operation.
- Reads the immutable `RequestContext.platformUserId`; the Agent cannot supply or override it through Tool arguments.
- Uses the current request-scoped USER Salesforce `Connection` to execute one bounded query:

  ```sql
  SELECT Id FROM <lookupObject> WHERE <matchField> = '<trusted platformUserId>' LIMIT 2
  ```

- Zero matches returns `MCP_DML_MANAGED_LOOKUP_NOT_FOUND`.
- Two matches returns `MCP_DML_MANAGED_LOOKUP_AMBIGUOUS`.
- Query/shape/ID failure returns `MCP_DML_MANAGED_LOOKUP_FAILED`.
- The one proven Salesforce ID becomes the target field value.

### `AI_CREATED_MARKER`

- Applies to CREATE only.
- Writes the Boolean value `true`.
- Rejects UPDATE scope and Lookup configuration at the database, Admin service, and Runtime validation boundaries.

`CONSTANT` and every other strategy are intentionally not implemented.

## Runtime order and isolation

The mutation path is:

```text
authenticated request
  -> immutable platformUserId and request-scoped USER Connection
  -> Tool enabled-state and parent object/operation allowlist
  -> validate current managed-rule snapshot
  -> resolve trusted values with the same request Connection
  -> overwrite/remove any case-insensitive client copy of a managed target
  -> existing generic create_record/update_record Tool
  -> Salesforce authorization and business rules
```

The Control Plane reads enabled Tool, DML policy, and managed-rule rows in one repeatable-read Runtime snapshot. Objects and arrays are deeply frozen. There is no managed-field cache, mutable global current user, Connection pool, cross-request singleton, or retry queue.

The resolver validates all enabled rules for the target object before operation filtering. Bad persisted history therefore fails closed instead of being silently ignored. The host checks the existing object/operation allowlist before any managed Lookup query.

The server-owned value always wins. An Agent-supplied target field, including a casing variant, is removed or overwritten. Safe audit contains only target field API name, strategy, and whether an Agent value was overridden; it never contains the derived Lookup ID or platform identity value.

## Timeout and mutation outcome

Managed Lookup resolution occurs before mutation dispatch. A pre-dispatch validation, Lookup, or timeout failure is a normal failed Tool result and is never reported as `MCP_DML_OUTCOME_UNKNOWN`.

`Promise.race` cannot cancel an already running Salesforce query, so the facade records a pre-dispatch deadline and prevents a slow Lookup that settles later from dispatching a mutation. Only a timeout/interruption after the existing DML provider marks the public SDK mutation call as started may return `MCP_DML_OUTCOME_UNKNOWN`. The existing no-automatic-retry/read-before-another-mutation rule is unchanged.

## Agent contract

Canonical Playbook `1.1.0`, MCP Server Instructions, capability Resource, Prompt, governed Tool fallback, generated Dify instruction, WorkBuddy System Prompt/Skill, and Admin preview all state the same rule:

- managed fields are supplied by MCP;
- do not ask the user for them;
- do not recommend them;
- do not include or override them in CREATE/UPDATE fields;
- never derive or guess a platform Lookup record or marker value.

Capability facts expose only safe rule descriptors: object, target field, strategy, and operation scope. They expose no derived value, route, user ID, username, Lookup result, secret, or Lightning host.

`get_record_action_context` annotates managed fields so an Agent does not turn a Salesforce-required managed field into a user question. It does not change Salesforce metadata or create a second form engine.

## Trusted record links

`get_record_links` accepts only bounded record descriptors and makes no Salesforce API call. Its origin is exclusively `SFOA_LIGHTNING_BASE_URL`, which must be a credential-free HTTPS origin root with no path, query, or fragment.

- Missing/blank configuration: Tool-level `MCP_RECORD_LINK_BASE_URL_NOT_CONFIGURED`.
- Malformed or unsafe configured origin: startup/runtime configuration failure.
- `Connection.instanceUrl`, Agent input, request headers, object data, and guessed Salesforce domains are never fallbacks.

This section supersedes only the current-Connection-origin decision in ADR-0013; the rest of ADR-0013 remains accepted.

## Admin experience

Each DML object policy exposes its managed-rule count and a Simplified-Chinese management drawer. Forms adapt by strategy, validate Salesforce API-name syntax immediately, reject duplicate targets case-insensitively, fix marker scope/value, constrain child operations to the parent, and support create, update, disable, and delete with row-version conflict handling and durable Admin audit.

Screenshot: [P6-DML-01 managed-field drawer](evidence/p6-dml-01-admin-managed-fields.png).

## Deliberate exclusions

- No generic default-value or expression engine.
- No `CONSTANT`, client-supplied trusted value, metadata synchronization, object-specific seed, or business workflow.
- No target object duplication in the child row.
- No DELETE Salesforce Tool, cache, Redis, connection reuse, runtime form engine, or Dynamic Forms evaluator.
- No changes to official Salesforce Provider/Tool implementation files.

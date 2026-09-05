# P6-DML-01 Trusted Managed Fields, Agent Guidance, and Record Links

Status: implemented; deterministic and mocked integration Gates pass; live Salesforce Gates remain Maintainer-run.

Date: 2026-08-27; fallback capability update: 2026-09-05 (Playbook 1.5.1)

## Purpose

P6-DML-01 lets the MCP host write a very small set of trusted, centrally configured fields during the existing generic `create_record` and `update_record` flows. It distinguishes Strict Managed Value from Managed Fallback / Default Value on every canonical Agent surface and changes record-link construction to use one explicit trusted Lightning origin.

This is not a generic default-value engine, Salesforce permission replica, metadata synchronizer, business-rule database, or runtime form engine. Salesforce remains authoritative for CRUD, FLS, sharing, required fields, defaults, Validation Rules, Flow, Trigger, Lookup filters, and Record Types.

## Accepted scope

One child model, `sfoa_dml_managed_field_rule`, belongs to an existing DML object policy. A rule contains only:

| Field | Meaning |
| --- | --- |
| `dml_policy_id` | Existing object policy; the object API name is not duplicated in the child row |
| `target_field_api_name` | Field whose assignment priority is controlled by the configured strategy |
| `strategy` | `PLATFORM_USER_LOOKUP`, `PLATFORM_USER_LOOKUP_FALLBACK`, or `AI_CREATED_MARKER` |
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

### `PLATFORM_USER_LOOKUP_FALLBACK`

- Explicit client value > MCP platform-user fallback. Explicit means the target key exists case-insensitively in input.fields, including null, empty string, or an in-process undefined value. Canonicalizing the key never changes the value.
- When explicit, preserve it and do not execute the platform-user Lookup. A missing default mapping cannot block this path. Rule configuration is still validated first.
- When omitted, reuse the existing resolvePlatformUserLookup() with the same request-scoped USER Connection, platformUserId, LIMIT 2, and error codes.
- CREATE-only: applyOnCreate=true and applyOnUpdate=false are required by Admin, Runtime, and migration 011. It never automatically defaults a field on UPDATE; explicit Lookup changes still use normal Salesforce UPDATE. It is not a generic Default Value Engine and does not resolve person names.
- Existing input schemas and Salesforce validate explicit values; an invalid Lookup value fails transparently and is never silently replaced with the default.

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
  -> preserve explicit fallback values, otherwise resolve with the same request Connection
  -> strict strategies overwrite; fallback injects only when the target key is absent
  -> existing generic create_record/update_record Tool
  -> Salesforce authorization and business rules
```

The Control Plane reads enabled Tool, DML policy, and managed-rule rows in one repeatable-read Runtime snapshot. Objects and arrays are deeply frozen. There is no managed-field cache, mutable global current user, Connection pool, cross-request singleton, or retry queue.

The resolver validates all enabled rules for the target object before operation filtering. Bad persisted history therefore fails closed instead of being silently ignored. The host checks the existing object/operation allowlist before any managed Lookup query. Object matching in Action Context and Runtime is case-insensitive without rewriting the Salesforce input object name. More than one client casing alias for any applicable managed target returns MCP_DML_INPUT_INVALID before any managed Lookup or mutation; errors contain only the safe field API name.

| Strategy | Priority |
| --- | --- |
| PLATFORM_USER_LOOKUP | MCP server value > client value |
| PLATFORM_USER_LOOKUP_FALLBACK | explicit client value > MCP platform-user fallback |
| AI_CREATED_MARKER | MCP server marker > client value |

Safe request summaries contain only field names, strategies, and override flags, never Lookup IDs, platformUserId, or raw field values. An omitted fallback is recorded in managedFieldsApplied with agentValueOverridden=false. An explicit fallback value stays client-requested in existing P7 requestedFields evidence and is excluded from managedFields / managedFieldsApplied. Existing bounded P7 field-value evidence and central sanitization remain unchanged; no new audit model or sensitive summary fields are added.

## Timeout and mutation outcome

Managed Lookup resolution occurs before mutation dispatch. A pre-dispatch validation, Lookup, or timeout failure is a normal failed Tool result and is never reported as `MCP_DML_OUTCOME_UNKNOWN`.

`Promise.race` cannot cancel an already running Salesforce query, so the facade records a pre-dispatch deadline and prevents a slow Lookup that settles later from dispatching a mutation. Only a timeout/interruption after the existing DML provider marks the public SDK mutation call as started may return `MCP_DML_OUTCOME_UNKNOWN`. The existing no-automatic-retry/read-before-another-mutation rule is unchanged.

## Agent contract

Canonical Playbook 1.5.1, Server Instructions, capability Resource, Prompt, Tool fallback, Dify, WorkBuddy Skill/references, and Admin preview distinguish:

- PLATFORM_IDENTITY (strict PLATFORM_USER_LOOKUP): do not ask, recommend, submit, derive, or override.
- AI_CREATED_MARKER: do not ask or submit; server owns the marker.
- PLATFORM_IDENTITY_FALLBACK: match managedDmlFields[].fieldApiName to fields[].apiName case-insensitively in get_record_action_context. Use apiRequired/layoutRequired and operation-specific fieldCreateable/fieldUpdateable and layoutEditableForCreate/layoutEditableForUpdate facts. Never guess required status.

On CREATE, an already supplied person is resolved through the existing LOOKUP workflow using referenceTo and bounded USER SOQL: exactly one candidate permits its Salesforce Id; zero means report no match; multiple means ask for disambiguation. Never write a name into the Lookup field or repeat a required question already answered.

Required and absent: ask once, explain that another person may be specified and otherwise the current user will be used, and wait before mutation. A default/current-user choice means omit the field without querying the current-user Lookup Id. Optional and absent: omit without an extra question. Optional and explicitly supplied: resolve and submit that person.

UPDATE retains minimum mutation: only collect requested changes; never turn CREATE layout requirements into questions on every UPDATE. An omitted fallback field is never injected on UPDATE; explicit changes follow the normal UPDATE + LOOKUP workflow. Required/editable decisions belong to Salesforce Action Context and the Agent; Runtime handles only value priority.

Capabilities expose only object, target field, safe strategy, and operation scope; no mapping details, platform identity, Lookup result, or secret.

### Acceptance examples (synthetic automated evidence)

For Order_Owner__c configured as fallback and marked layoutRequired=true:

1. Current user Li Si; user specifies Zhang San: Agent uniquely resolves Zhang San; explicit Id reaches DML unchanged, platform lookup count is zero.
2. User omits owner: Agent asks once and explains the current-user default. User chooses default: Agent omits the field; Runtime resolves Li Si once and injects that Id.
3. Requested_By__c retains PLATFORM_USER_LOOKUP: even an explicit other Id is overwritten by the server value.

Runtime/facade and Playbook contract tests cover these decisions and payloads. They are not a claim of a live LLM conversation or a real Salesforce mutation.

## Configuration and migration

Migration 004 actually uses an ENUM and a strategy CHECK. New forward-only migration 010_managed_platform_user_lookup_fallback.sql appends the enum value and extends the lookup CHECK in one ALTER TABLE. It changes no existing row, enum ordinal, operation flag, or rule strategy. Historical migration files remain immutable. HOTFIX01 adds 011_managed_fallback_create_only.sql to constrain fallback to CREATE without changing 010 checksums. At inspection, both accessible development and persistent test ledgers had no applied 010; 011 is retained because this does not establish the state of every shared environment. If unsafe fallback UPDATE rows exist elsewhere, 011 fails without rewriting them; an administrator must explicitly correct their scope before rerunning migration.

Deploy the migration with the existing yarn db:migrate command before starting the upgraded services; distribute Playbook 1.5.1 with the Runtime/Admin build. In Admin → DML 策略 → the object's 托管字段 → edit the desired owner rule, select 当前平台用户 Lookup（创建缺省回填，可由用户指定）, retain the lookup object/match field, confirm CREATE-only scope, and save. Only explicitly selected rules change. Keep trusted identity fields on 当前平台用户 Lookup（强制托管）. Do not bulk-convert existing rules.

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

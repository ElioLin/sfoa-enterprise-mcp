# P8-07 HOTFIX01 UAT checklist

Status: READY_FOR_UAT. Every case below is an operator-run acceptance step against a real
Salesforce org and a real Agent client. Automated contract tests are *not* a substitute for
these cases; a case with no operator session is recorded BLOCKED, never PASS.

Scope note: this checklist closes the HOTFIX01 defects on top of P8-07. It does not add a new
feature phase and does not relax any production allowlist, Tool Governance rule, Validation
Rule, request-scoped USER identity or Dynamic Forms contract.

## Prepare

1. Confirm the deployed build is the HOTFIX01 commit on `hotfix/p8-07-agent-runtime-safety`
   merged forward, and that the migration ledger is unchanged by this hotfix (still ends at
   `013_p8_05_wecom_identity_channel`). No new migration is introduced.
2. Confirm the generated Agent artifacts carry Playbook **1.8.0**:
   `yarn agent:check` reports `Agent artifact check PASS (5 files)`.
3. Sync Playbook 1.8.0 into 小犇/Dify, WorkBuddy (system prompt + Skill) and the WeCom
   condensed role setting. Confirm the live Connector advertises the mutation Tools the case
   needs; the Agent must not be told to call a Tool absent from the live `tools/list`.
4. Pick an object, Record Type and USER combination that Salesforce actually permits. Record
   the real New entry point, form factor and observed fields *before* comparing with the
   resolved context.
5. Choose a safe, non-production, allowlisted and deletable test object for every mutation
   case. Do not widen the production allowlist for UAT.

## Cases and expected evidence

| Case | Check | Evidence to record |
| --- | --- | --- |
| UAT-01 Dynamic Forms default | Real Lightning New page fields vs `get_record_action_context` effective fields. For each compared field record visibility state, the source of the value (`SALESFORCE_CREATE_DEFAULT`, `USER_EXPLICIT`, `CURRENT_USER_FACT`, `TRUSTED_RUNTIME_DEFAULT`, `UNRESOLVED`) and whether the rule scope was FIELD or CONTAINER. Confirm no `PLATFORM_USER_LOOKUP` Salesforce read is issued merely to observe the page. Record-dependent CONTAINER visibility remains `UNKNOWN`/`CONTAINER_RECORD_UNSUPPORTED`: mark it **KNOWN LIMITATION**, never fake COMPLETE. | Sanitized case alias, object/RT/App/page alias, snapshot hash + parser version, resolution ID, observed New fields, resolved effective fields, per-field visibility + source + scope, `runtimeDefaultResolution` evidence, fallbackUsed |
| UAT-02 Picklist API value vs label | `run_soql_query` returns the raw API value (`COMPLETED`). `resolve_field_display_values` returns the current Salesforce label (`已完成`) for the same row. Any DML payload, SOQL filter and Audit record still carries `COMPLETED`. MultiSelect Picklist and a mixed-Record-Type set keep passing. | Raw row, resolved display row, resolutionStatus, the DML/filter string built from the raw value, Audit row |
| UAT-03 Compound CREATE | One business intent that is not one Salesforce record: create a root plus multiple internal-participant and multiple customer-participant records using generic objects only. Confirm the Agent builds a bounded intent checklist, creates the root first, uses the proven root ID in the child Lookups, reports every requested component, and never hardcodes a production business object or auto-deletes the root on child failure. | Prompt, checklist, child object list, per-phase Tool results, clientReferenceId→recordId mapping, final component reconciliation, Audit trace |
| UAT-04 Batch CREATE | A request for ≥2 records of one object produces exactly **one** collection CREATE request. An ID is returned per record and matches the correlation reference. | Tool arguments, `batch=true` request summary, counts, one COMPOSITE_API wire row, returned IDs |
| UAT-05 Batch UPDATE | A request for ≥2 proven target IDs produces exactly **one** collection UPDATE request, and an independent USER read verifies the submitted values. | Tool arguments, one COMPOSITE_API wire row, the USER read proving the values |
| UAT-06 Partial success | With one item deliberately rejected by a real Salesforce Validation Rule, confirm `status=PARTIAL_SUCCESS`, `success=false`, `isError=false` at the Tool boundary, per-item results and the original Salesforce errors. Confirm the Agent **does not resubmit the whole batch**, does not re-create committed records, and only re-prepares FAILED items when user intent still requires it and the cause is fixable. Confirm Admin Audit shows Tool-execution success *and* business `PARTIAL_SUCCESS` distinctly, and the AI Diagnostic view identifies partial success. Confirm an `OUTCOME_UNKNOWN` result is never auto-retried. | Tool result, Tool `isError`, Audit `result`/`outcome`/`responseSummary.businessOutcome`/`partial`, Admin Workbench rendering, the Agent's follow-up plan |
| UAT-07 Tool Governance matrix | With the plural mutation Tools enabled and the singular ones disabled, a single-record CREATE and a single-record UPDATE each succeed through the plural Tool carrying exactly 1 item. Repeat with both enabled, singular-only, and both disabled, and confirm the Agent only ever calls a Tool the live Connector advertises. | Connector Tool list per configuration, chosen Tool name, item count, result |

## Record and diagnose

For each case record a sanitized case alias, the USER/Profile alias, object/RT/App aliases,
snapshot hash/time/parser, `publicAuditId`(s), resolution ID, the original prompt facts, the
observed page/fields and the actual Agent questions/answers. Keep private identifiers,
screenshots and business values in approved private evidence; publish only sanitized counts
and aliases. Start `yarn ai:audit --trace <publicAuditId>` to follow the Audit chain.

Do not infer a successful DML commit from a context result, and never automatically retry an
unknown write. A case is PASS only on observed evidence; anything not executable in the
current environment is reported BLOCKED with the blocking reason.

## Known limitations carried into UAT

1. Record-dependent CONTAINER visibility (`$Record.Field` on SECTION/TAB/CONTAINER) stays
   `UNKNOWN` with `CONTAINER_RECORD_UNSUPPORTED` evidence. Lightning initial semantics for
   unsaved record values are not proven, and this hotfix does not guess them.
2. No trusted runtime-default provider is wired by the server. Managed DML values are real
   mutation defaults but do not prove Lightning New Page initial values, so the Dynamic Forms
   resolver answers UNKNOWN rather than claiming a default it cannot prove.
3. No transaction spans batches or parent/child Tool calls. Partial business completion is
   reported, not rolled back.
4. A live collection mutation requires an authorized, allowlisted, deletable test object and
   both configured USER routes. Without them the mutation cases are BLOCKED.

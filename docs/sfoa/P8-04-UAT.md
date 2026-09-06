# P8-04 real Agent / Salesforce New UI UAT

This is the post-implementation acceptance plan authorized by AMEND-006. Engineering
regressions and read-only configuration smoke are not a real UI accuracy score.
Maintainer starts the services and selects the objects/USERs; do not enable all objects.

## Prepare

1. Apply the normal forward migrations through 012 and deploy the built packages.
   The production database/services/policies were not changed by the implementation.
2. Verify the independent DIAGNOSTIC identity in Admin. In CREATE 页面上下文 add one
   selected object as SHADOW, configure the actual App DeveloperName and refresh.
   Confirm READY, parser P8-04.1, timestamp, page/source, App/Profile/RT scope.
3. Sync the generated Playbook 1.6.0 into 小犇/Dify and WorkBuddy; confirm the live
   Connector exposes `get_record_action_context` and permitted `create_record`.
4. Choose USER/RT/App combinations that Salesforce actually permits. Record the
   actual standard New entry point, form factor and observed fields before comparing.
5. Review SHADOW P7 evidence, then enable only that object as ENFORCE for real UAT.
   Restore SHADOW/OFF immediately for uncertain outcomes or Page Layout regression.

## Cases and expected evidence

| Case | Check |
| --- | --- |
| Page Layout-only object | Same RT, fields/order, required/editability, defaults, picklists/dependencies, lookup facts and managed fields before/after; zero runtime Metadata reads |
| Simple Dynamic Forms | Correct active page, visible required/optional candidates, readonly/FLS intersection; no LLM Metadata parsing |
| Prompt supplies dependency | Agent extracts existing facts into draftFields, does not ask again, refines and asks only missing effective required fields |
| Prompt lacks dependency | PENDING identifies dependsOn, Agent asks dependency first; hidden dependency/UNKNOWN is explained without guessing |
| Hidden required / API required | Hidden DF page-required is not asked; API universally-required semantics survive; managed rules remain strategy-aware |
| Two USERs / Profiles | Same permitted RT/App with differing assignments produces the corresponding distinct context; no draft/identity leakage |
| Different Apps | Explicit/default App verifies USER access; divergent unspecified Apps produce APP_CONTEXT_REQUIRED and PL fallback |
| Missing/stale/failed snapshot | Missing/invalid falls back; old usable snapshot warns; failed Admin refresh retains the previous data |
| Unsupported/custom UI | Custom New, Small/Medium, inherited pages and unsupported rules are reported; no guessed Dynamic Forms form |
| Bounded dialog | At most three refinements; stable dependencies/limit stop the loop with current resolved facts and unresolved evidence |
| Managed Lookup fallback | Explicit user value wins, required absent asks once with default choice, optional absent omits, UPDATE never defaults |
| Context→CREATE | Pass latest opaque ID; source and DML audit match USER/object/RT/time; absent ID is NOT_PROVIDED and DML still works |

## Record and diagnose

For each case record a sanitized case alias, USER/Profile alias, object/RT/App/page
aliases, snapshot hash/time/parser, publicAuditId(s), resolution ID, original prompt
facts, observed New fields, context fields and actual Agent questions/recommendations.
Keep private identifiers/screenshots/business values in approved private evidence;
publish only sanitized counts and aliases. Do not infer successful DML from a
context result or automatically retry an unknown write.

Start `yarn ai:audit --trace <publicAuditId>`, then follow `UI_CONTEXT_LINK` using
`yarn ai:audit --ui-context <UUID> --since 24h --latest 20`. Inspect Admin 页面上下文
and on-demand 字段依据; classify assignment/parser/visibility/snapshot/USER/App errors
separately from Agent extraction/recommendation and Salesforce DML rejection.
Client-supplied provenance is unverified until the source USER/object/RT/time match.
Missing/expired/truncated Audit is an evidence gap, not proof of page selection.

## Final acceptance thresholds (not yet measured)

- Page Layout regression: 100%; any regression must be fixed before acceptance.
- Dynamic Forms target: >=90%.
- RESOLVED accuracy target: >=95% against independent actual New UI.
- Agent extraction / required questions / optional recommendations: >=90%.

Use the exact metrics/denominators in the authoritative P8-04 baseline. Maintainer
decides HOTFIX, continued SHADOW/OFF for some objects, or P8-04 COMPLETE after real
evidence satisfies those gates. This delivery stops at READY_FOR_UAT.

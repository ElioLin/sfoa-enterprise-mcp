# P8-04 — Dynamic Forms-Aware Effective CREATE Context

Status: A-01 evidence collection; later tasks are not authorized in this delivery.
Date: 2026-09-06. Authority: this scoped baseline supplements PROJECT_BASELINE.md;
current source and verified SFoA evidence outrank historical descriptions.

## Git provenance

- Source Branch: `feature/managed-platform-user-lookup-fallback`
- P8_04_BASE_SHA: `f60a134715d639b8129af0f3160549d52dec210d`
- P8-04 Branch: `feature/p8-04-effective-ui-context`
- Fetched origin, checked out source, pulled ff-only, recorded HEAD, checked local
  and remote target-branch absence, then created this branch. No main integration.

## Outcome and non-negotiables

Salesforce supplies facts, deterministic MCP code interprets supported facts,
ordinary Agents understand the original prompt and organize the conversation.
After existing available Record Type selection, CREATE context must identify its
actual UI source for the request USER, object, Record Type, Profile, App and form
factor. Dynamic Forms supplies effective visible/editable/required fields and
dependencies; Agents reuse supplied values, ask only missing effective required
fields, and recommend about 3–8 relevant effective optional fields when available.
Hidden, non-createable, system and MCP-managed fields cannot become recommendations.
Existing managed fallback semantics (explicit user values preserved) remain intact.
Final writes continue through existing `create_record`.

1. Existing Page Layout fields/required/editability/defaults/picklists/Record Type
   behavior must regress at 100%; physically invoke the current implementation.
   Never convert Page Layout to a generic Dynamic Forms model and recalculate it.
2. SHADOW first, OFF by default; first runtime delivery accepts OFF/SHADOW only.
   Reserve ENFORCE as future vocabulary; reject attempts to configure it now.
   Shadow result/failure cannot change any production response or fail its request.
3. No LLM parsing of XML, assignment metadata or raw visibility expressions.
4. Effective evaluation is request USER aware. Never reuse evaluated results
   across users. Configuration reuse is distinct from evaluated-result reuse.
5. Visibility has VISIBLE/HIDDEN/PENDING/UNKNOWN. Missing draft dependencies are
   PENDING; unsupported criteria or missing authority evidence are UNKNOWN.
   Neither is guessed into VISIBLE/HIDDEN. Unknown page assignment is not Layout.
6. No Metadata DB tables, lake, repository, raw XML persistence, history, nightly
   org sync, new cache or dependencies without measured necessity.
7. Reuse P7 collector/events/API evidence and fail-open persistence; no second audit.
8. No new mandatory Agent Tool. Integrate eventually inside
   `get_record_action_context`; diagnostics stay dev-only.
9. Dynamic Forms CREATE only. No READ/UPDATE enforcement, DELETE, DML redesign,
   Flow/Validation/Apex simulator, arbitrary LWC/Aura/VF parser, or Lightning emulator.
10. No ENFORCE before all hard gates; object-level enablement only after acceptance.

Changing these boundaries requires `REQUIRES_MAINTAINER_DECISION`, not an amendment
that silently weakens a gate.

## Reviewed seams and design

Source references are repository-relative to the SHA above:

- `packages/mcp-provider-sfoa-context/src/record-action-executor.ts`: USER Object
  Info, 0/1/N Record Type selection, create-defaults and Picklist retrieval; separate
  apiRequired/layoutRequired, FLS, layout editability, defaults and ordering. The
  present output also includes createable non-layout fields: preserve it exactly.
- `.../src/ui-api.ts`: existing schemas, HTTP helper, layout facts and ID comparison.
- `packages/sfoa-mcp-server/src/context-tool-facade.ts`: role/timeout boundary,
  existing P7 purpose and safe managed-field enrichment. Keep enrichment intact.
- `packages/sfoa-identity-runtime/src/request-scope.ts`,
  `salesforce-connection-resource.ts`, `connection-factory.ts`: trusted route,
  lazy request-local Promise, fresh role-bound JWT Connection.
- `packages/sfoa-mcp-server/src/dml-managed-fields.ts`: fallback only on omitted
  CREATE fields, explicit null/value preserved, no UPDATE fallback; P7 semantic
  evidence retained. Migrations 010/011 and Playbook 1.5.1 are protected.
- `request-audit-context.ts`, `request-audit-collector.ts`,
  `jsforce-audit-adapter.ts` in identity-runtime: existing async carrier, bounded
  safe event summary, exact HTTP attempts and payload policy; no new audit schema.
- Existing official `retrieve_metadata` uses request workspace/CWD serialization.
  Assess direct official SDK Metadata reads for bounded facts before adding any
  adapter. DIAGNOSTIC configuration evidence must never substitute for USER FLS.

Prefer one cohesive resolver in the context package with pure parsing/evaluation
functions only where substantial logic merits them. Host supplies authorized
configuration evidence through its composition seam if that becomes necessary;
do not add four wrapper classes, another Provider, or a generic rules framework.
Record-page assignment and actual New-entry applicability are separate evidence
questions. Do not infer CREATE applicability merely from a RecordPage's existence.

## Planned contract (not implemented)

Keep resolution status (RESOLVED/AMBIGUOUS/UNRESOLVED) separate from form source
(PAGE_LAYOUT/DYNAMIC_FORMS/MIXED/CUSTOM_OVERRIDE/AMBIGUOUS/UNRESOLVED) and visibility.
Include reason codes such as APP_CONTEXT_REQUIRED and unsupported entry/criterion.
Missing App is resolvable only after a complete applicable-App set, defaults and
form factor all converge on the same effective page; missing inventory is unresolved.
Never guess Sales App. Only measured need can justify a small integration App setting.

Preserve field-instance order, section membership, ancestry and repeated instances.
Aggregate to effective field facts only after visibility/editability evaluation.
Required provenance is a set drawn from API/PAGE_LAYOUT/DYNAMIC_FORM (empty = NONE).
API universally required is retained regardless of hidden UI instances. Dynamic
page required is effective only for an active visible instance. Pending required
is conditional, never silently mandatory. FLS and managed policy remain separate
authorities, and hidden required cannot force an Agent question by itself.

Future bounded `draftFields` is only for verified field-dependent Dynamic Forms
rules, stateless per request, with explicit missing vs null/false/zero semantics.
Reuse current USER ObjectInfo, create defaults, Record Types, Picklists/dependencies,
lookup facts and managed fields. No extra Page Layout conversation step.

P7 safe summary should carry object/action/Record Type, request identity reference,
Profile, App/form factor, source, reliable Layout identity, Lightning page,
assignment provenance, resolver version, metadata version/hash when available,
resolved/hidden/pending/unknown counts, coverage, duration, mode and
`usedForAgent=false` in SHADOW. No raw XML or values in summary; values use existing
P7 payload redaction/bounds. Context-to-DML closure must distinguish proven linkage
from unavailable linkage; correlationId is not automatically a multi-call task ID.

## Acceptance tasks (12; no automatic phase advance)

| Task | Deliverable / exit evidence |
| --- | --- |
| A-01 | Read-only SFoA feasibility Q1–Q10, measured cost, baseline freeze, explicit GO/BLOCKED; stop this delivery here. |
| A-02 | Same future-production resolver seam, OFF/SHADOW only, unchanged outputs, bounded work and shadow-failure isolation; existing Layout bypass tests. |
| A-03 | Active page + source classification together; USER/Profile/RT/App/form-factor/default/override evidence, ambiguity, same-object different-user tests. |
| A-04 | P7 shadow event with production/shadow provenance, counts, coverage/cost, redaction and fail-open tests, no schema. |
| B-01 | Real-corpus Field Sections/instances/order/required/readOnly structural parser; MIXED and unsupported containment conservative. |
| B-02 | Minimal corpus-supported visibility AST/evaluation including USER/Profile/permission/form-factor only where verified; four-state and dependencies tests. |
| B-03 | Bounded iterative draft values, effective CREATE field contract, instance aggregation, API-required/FLS/managed-field invariants; shadow only. |
| B-04 | Cost benchmark; omit snapshot implementation unless measurements justify it; any snapshot limited to relevant normalized current pages, bounded refresh, no history/raw XML/full-org sync. |
| C-01 | Fixed real SFoA golden corpus and ordinary target-Agent benchmark against independent UI ground truth; source, fields, visibility, questions/recommendations gates. |
| C-02 | Only after accuracy gates pass, canonical Playbook update for ordinary target model, generated distributions and repeat benchmark. |
| D-01 | Acceptance review of every gate, then small object-level ENFORCE configuration; no global switch; rollback to OFF/SHADOW verified. |
| D-02 | Real authorized CREATE / P7 provenance closure with existing DML; actual context-used evidence and managed fallback regressions. |

Combines A-03/A-04 and B-02/B-03 of the suggested plan because assignment and
classification share evidence, and user criteria belong in the same bounded
evaluator. Cost assessment is mandatory; persistence implementation is conditional.
Agent benchmark begins on a dev harness before Playbook rollout, avoiding circular
acceptance. A-02 may begin only after A-01 GO and a new authorization.

## Accuracy protocol and hard gates

Freeze a versioned real SFoA corpus before scoring: USER/Profile/object/Record Type/
App/form factor/New entry/draft step plus independently observed expected page,
source, visible editable fields and required facts. Store sanitized labels and
metadata versions. Salesforce UI observations/maintainer-confirmed fixtures are
ground truth, never the resolver's own output. Include Layout, Dynamic Forms,
MIXED, App ambiguity, overrides, hidden required, unsupported and pending rules,
and mandatory same-object/same-RT/different-USER cases. Absent cases are NOT TESTED,
never a perfect score. Report numerators/denominators per scenario and overall;
zero denominators are N/A and cannot satisfy a gate.

| Metric | Definition and gate |
| --- | --- |
| Layout regression | Exact equality to baseline field facts/order/required/editability/defaults/Picklists/RT behavior over all Layout cases, 100% each. Timing variability is measured separately; no new SHADOW properties in output. |
| Form Source Accuracy | Correct source classifications / all truth-labelled source cases, unresolved counts wrong; PAGE_LAYOUT/DYNAMIC_FORMS/MIXED >=98%. Mandatory same-object/different-USER page AND source =100%. |
| Resolution Coverage | Complete RESOLVED Dynamic Forms cases / all in-scope Dynamic Forms golden cases, including unsupported/ambiguous cases in denominator, >=90%. No selective removal after scoring. |
| Effective Field Precision | Correct returned effective field names / all returned effective field names on RESOLVED cases, >=95%. |
| Effective Field Recall | Correct returned effective field names / expected effective field names on RESOLVED cases, >=95%. API-required exceptions tracked explicitly. |
| Required Accuracy | Correct required membership+provenance decisions / union of expected and returned field decisions on RESOLVED cases, >=95%; report required-set precision/recall too so optional negatives cannot conceal missed required fields. |
| Visibility Accuracy | Correct per-instance/section visibility decisions / all truth-labelled evaluated instances on RESOLVED cases, >=95%; per-state confusion matrix. |
| Conservative uncertainty | UNKNOWN/PENDING guessed VISIBLE or HIDDEN =0, including unresolved cases. |
| Agent Prompt Extraction | Correct assignable field/value pairs extracted / all truth-labelled assignable prompt pairs, >=90%; false-positive pairs also reported. |
| Required Question Accuracy | Correct ask/do-not-ask decisions / all golden field decisions, >=90%; report missing-required question precision/recall; no repeat questions for valid supplied values. |
| Optional Recommendation Accuracy | Relevant valid optional recommendations / all recommendations, >=90%; report case fulfillment and 3–8 count when enough relevant options exist; zero recommendations cannot pass. |
| Invalid recommendation | Hidden/non-createable/system/managed/unsupported field recommendations =0. |
| Main path | SHADOW changes production response =0; Shadow failure impacts production request =0. |

Use actual Xiaoben/WorkBuddy target ordinary model, record model/provider/version,
prompt, tools, corpus revision and repeated trial results (at least 3 per case).
Do not substitute developer GPT-6 Astra scores or LLM self-judging for the target
model and independent labelled evidence. Any unmet critical gate forbids ENFORCE.

## A-01 evidence and stop rule

See `P8-04A-01-FEASIBILITY-EVIDENCE.md` for Q1–Q10, environment/API version,
sanitized shapes, assignment precedence, missing App, override feasibility,
different-user golden availability, HTTP/API/bytes/latency/parse measurements,
storage recommendation and actual tests. No Salesforce writes or config changes.
Allowed output: docs, bounded dev-only reads, sanitized evidence; no runtime changes.
Final status is exactly COMPLETE — GO_TO_P8_04A_02, COMPLETE — BASELINE AMENDED / GO,
COMPLETE — BLOCKED, or INCOMPLETE. Missing core facts cannot be filled with guesses.

## Baseline Amendments

None at initial freeze. Append evidence-backed changes using Amendment ID, Task,
Original Assumption, Evidence, Decision, Reason and Impact. Non-negotiables and
accuracy denominators cannot be silently weakened.

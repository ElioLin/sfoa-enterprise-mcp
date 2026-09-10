# P8-07 HOTFIX01 report — Agent runtime safety and UAT closure

Status: **READY_FOR_UAT_WITH_LIMITATIONS** (never `P8-07_COMPLETE`).

All executable code gates pass on this branch. Live Salesforce collection mutation and
independent Dify/WorkBuddy/WeCom Agent acceptance are **BLOCKED** in this environment, so the
phase cannot be declared COMPLETE regardless of the code gates. Record-dependent CONTAINER
visibility remains a documented KNOWN LIMITATION.

## Git

| Item | Value |
| --- | --- |
| Source branch | `feature/p8-07-runtime-batch-orchestration` |
| Source HEAD | `7643755cf191d98f950b1ef69cdb47db488a472b` |
| Hotfix branch | `hotfix/p8-07-agent-runtime-safety` (created from the source HEAD, not from `main`) |
| Implementation commit | `4d4bacb4580954342f02cfd20126f4e7544677aa` |
| Report commit (evidence-only) | the commit that introduces this file — `git log -1 --format=%H -- docs/sfoa/P8-07-HOTFIX01-REPORT.md` |
| Changed files | 40 in `4d4bacb`, plus this report and `P8-07-UAT-CHECKLIST.md` in the report commit |

`git fetch --all --prune` failed with `Recv failure: Connection was reset` for both `upstream`
and `origin` — the same network restriction recorded in the P8-07 report. Work therefore
continued on the local HEAD `7643755`, which matches the stated latest P8-07 commit. **The
remote refs were not read; if `origin/feature/p8-07-runtime-batch-orchestration` has advanced,
this branch is based on the older local commit.**

### Changed files (`4d4bacb`)

Runtime and schemas:

- `packages/mcp-provider-sfoa-dml/src/tools/batch-records.ts`
- `packages/mcp-provider-sfoa-dml/src/dml-executor.ts`
- `packages/mcp-provider-sfoa-dml/src/schemas.ts`
- `packages/mcp-provider-sfoa-dml/src/errors.ts`
- `packages/sfoa-mcp-server/src/dml-tool-facade.ts`
- `packages/sfoa-mcp-server/src/dml-managed-fields.ts`
- `packages/sfoa-mcp-server/src/provider-runtime.ts`
- `packages/mcp-provider-sfoa-context/src/effective-ui-resolver.ts`
- `packages/sfoa-agent-playbook/src/{version,definition,renderer}.ts`

Tests:

- `packages/mcp-provider-sfoa-dml/src/test/{batch,compound}.test.ts`
- `packages/mcp-provider-sfoa-context/src/test/{effective-ui,p8-07-context}.test.ts`
- `packages/sfoa-mcp-server/src/test/{managed-dml-fields,managed-action-context,agent-guidance}.test.ts`
- `packages/sfoa-agent-playbook/src/test/{p8-07-guidance,playbook,generated-drift}.test.ts`
- `packages/sfoa-admin-web/src/test/{AgentIntegrationPage,SkillContent}.test.ts`

Canonical guidance, generated client artifacts and validator:

- `skills/sfoa-mcp-maintainer/references/{p8-07-runtime-batch,p8-04-effective-create}.md` (canonical)
- the three generated `.claude` / `.agents` / `.codebuddy` Skill copies of those two files
- `.codebuddy/skills/sfoa-salesforce-assistant/{SKILL.md,references/safety-boundaries.md,references/tool-workflows.md}`
- `docs/agent/DIFY_AGENT_INSTRUCTION.md`, `docs/agent/WORKBUDDY_AGENT_SYSTEM_PROMPT.md`
- `packages/sfoa-agent-playbook/README.md`, `packages/sfoa-mcp-server/README.md`
- `scripts/p8-07-live-batch.mjs`
- `docs/sfoa/P8-07-UAT-CHECKLIST.md` (new)

No environment file, credential, dependency, lockfile or migration is part of this change:
the migration ledger still ends at `013_p8_05_wecom_identity_channel`.

## Defects fixed

| # | Defect | Fix |
| --- | --- | --- |
| 1 | `PARTIAL_SUCCESS` was reported as a Tool error (`isError: output.status !== 'SUCCESS'`), so a client could route a partial commit into a correction path and resubmit records that already exist | `isBatchToolError` now returns true only for `FAILED` and `OUTCOME_UNKNOWN`. `PARTIAL_SUCCESS` keeps `isError=false` with `success=false`, `status=PARTIAL_SUCCESS`, succeeded/failed counts, item results and the original Salesforce errors. The Tool description and canonical BATCH rule state that successful items are committed, that a retry must be a new batch containing only the FAILED items, that OUTCOME_UNKNOWN is never auto-retried, and that `clientReferenceId` is correlation, never an idempotency key |
| 2 | The facade derived the whole outcome from `result.isError`, so Audit could show Salesforce `PARTIAL_SUCCESS` on a complete Tool `FAILED` (or a complete SUCCESS) | Tool execution status and business outcome are now separate: `result`/`outcome` describe the Tool invocation, while `responseSummary.businessOutcome` / `status` / `partial` carry what Salesforce actually did. The enum-migration-risky DB terminal column was left untouched; the compatible form is used. Admin Workbench already renders `batch.partial === true` as `批量操作：部分成功（PARTIAL_SUCCESS）` |
| 3 | `provider-runtime.ts` wired `ManagedDmlFieldResolver.resolve('CREATE', …)` as a server runtime-default provider. Those facts were always consumed with `trustedForVisibility=false`, so they could never change visibility, yet observing a Dynamic Forms page issued extra `PLATFORM_USER_LOOKUP` Salesforce reads and any Managed Lookup failure aborted the whole resolution into a PAGE_LAYOUT fallback | The server now wires **no** runtime-default provider (UNKNOWN is the honest answer when no provider is proven equivalent to Lightning initial values). The `EffectiveUiOptions.resolveRuntimeDefaults` extension point and its read-only / request-USER / bounded / explicit-provenance contract are preserved for a caller that has a proven provider. A failing provider is isolated: only the affected dependencies become explicit UNKNOWN facts and the rest of the resolution continues; only genuine metadata/snapshot failure keeps the existing whole-resolver PAGE_LAYOUT fallback |
| 4 | Tool selection guidance did not cover all four singular/plural enable combinations, so it could name a Tool that the live connection does not advertise | Canonical BATCH rule now states the full matrix (both / singular-only / plural-only / neither) for CREATE and UPDATE. The rule is worded protocol-neutrally ("Never call a Tool that the current connection does not advertise as enabled") so one canonical source renders consistently to all five client surfaces without leaking MCP implementation detail into the Chinese WeCom persona — a pre-existing P8-06 persona test forbids `tools/list` in that surface |
| 5 | `update_records` accepted two items for the same record; Salesforce commit order alone would decide the final value | `duplicateBatchRecordIds` compares the 15-character canonical identity (so 15- and 18-character forms of one record are duplicates) and `DmlExecutor.batch` rejects before any allowlist read, Connection lookup or dispatch with `MCP_DML_BATCH_DUPLICATE_RECORD_ID`, using the existing Salesforce ID validation |
| 6 | Batch terminal Audit read `input.fields` (undefined for a batch) and reported `fieldCount=0`, `fieldNames=[]`; managed-field evidence was a bare `applied.slice(0,200)` that lost the record index and correlation key | Request evidence is batch-aware: `batch`, `objectApiName`, `totalCount`, `allOrNone`, `fieldCountSemantics=BOUNDED_UNION_ACROSS_RECORDS` and the bounded union of requested field names (never the oversized payload — the Salesforce wire submitted payload stays authoritative). Managed-field evidence carries `appliedCount`, `truncated` and per-item `recordIndex` / `clientReferenceId`. The mutation executor was not refactored and Audit failure still cannot affect the main DML |
| 7 | Bounded or truncated relationship context could be read as proof that a requested relationship does not exist | Canonical COMPOUND rule: `truncated=true` / `resolutionStatus=PARTIAL` is non-exhaustive, never proof of absence. The Agent must continue with the enabled bounded metadata capability, then ask the user once if still undetermined, and must never widen recall by enumerating the whole Org Schema |

## Before / after

### Case A — batch CREATE, 10 records, 9 succeeded, 1 rejected

| | Before | After |
| --- | --- | --- |
| Tool result | `isError=true` for `PARTIAL_SUCCESS` | `isError=false`, `structuredContent.success=false`, `status=PARTIAL_SUCCESS`, `succeeded=9`, `failed=1`, item results and the original Salesforce error preserved in `content[0].text` and `structuredContent` |
| Agent behaviour | Tool-error framing made the whole batch look retryable | Guidance requires treating the 9 as committed, never resubmitting the batch, and re-preparing only the 1 FAILED item in a new batch when user intent still requires it and the cause is fixable. `clientReferenceId` is explicitly not an idempotency key |
| Audit | Tool terminal `FAILED` alongside Salesforce `PARTIAL_SUCCESS` | Tool invocation completed with `businessOutcome=PARTIAL_SUCCESS`, `responseSummary.partial=true`, `succeededCount=9`, `failedCount=1`; the Admin Workbench identifies partial success explicitly and never displays it as complete SUCCESS |

Proof that the 9 are not resubmitted is **behavioural, not a live run**: the deterministic
guidance test (`partial success guidance deterministically forbids resubmitting committed
items`) and the compound re-preparation test assert that only references outside the committed
set qualify for a new batch, and that the committed references do not appear in it. There is no
live LLM execution in this environment.

### Case B — a `PLATFORM_USER_LOOKUP` Managed rule whose Lookup fails

| | Before | After |
| --- | --- | --- |
| Salesforce reads | Observing an ENFORCE Dynamic Forms page resolved Managed DML defaults, issuing extra `PLATFORM_USER_LOOKUP` reads | No runtime-default provider is wired, so `get_record_action_context` performs no such read (asserted: `metadataCalls=0`, no lookup request) |
| Failure effect | A failed Lookup aborted the whole resolution into a PAGE_LAYOUT fallback | With a throwing provider injected directly, `formSource` stays `DYNAMIC_FORMS`, `dynamicFormsEvaluated=true`, `fallbackUsed=false`, `runtimeDefaultResolution={requested:1, resolved:0, reason:'PLATFORM_USER_LOOKUP_FAILED'}`, the dependent fields become `UNKNOWN`, and unrelated facts (`ApiRequired__c` required, `NoFls__c`/`Internal__c` not editable) are unaffected |
| Visibility | Untrusted values could pollute visibility evaluation | Facts with `trustedForVisibility=false` never drive visibility; a separate test confirms a genuinely trusted provider still contributes VISIBLE evidence |

### Case C — `create_record` disabled, `create_records` enabled, single CREATE

| | Before | After |
| --- | --- | --- |
| Guidance | Only the plural-disabled direction was specified | The singular-disabled direction is now specified: 1 record uses `create_records` with exactly 1 item; 2..200 use it normally |
| Regression | — | Rendered for all four combinations across `renderFullPlaybook`, `renderWorkflowReference` and `renderWeComRoleSetting`, containing the Tool names actually advertised, and never naming an unadvertised Tool |

## Verification

Validation ran on 2026-09-10 on `hotfix/p8-07-agent-runtime-safety` at `4d4bacb`.
Lint scripts in these packages are TypeScript `--noEmit`; there is no separate `typecheck`
script. Builds enforce the same strict tsconfig.

| Workspace | build | lint / typecheck | test |
| --- | --- | --- | --- |
| `@sfoa/mcp-provider-sfoa-dml` | PASS | PASS | PASS, 46 |
| `@sfoa/mcp-provider-sfoa-context` | PASS | PASS | PASS, 83 |
| `@sfoa/agent-playbook` | PASS | PASS | PASS, 34 |
| `@sfoa/identity-runtime` | PASS | PASS | PASS, 75 |
| `@sfoa/control-plane` | PASS | PASS | PASS, 38 + 14 MySQL |
| `@sfoa/mcp-server` | PASS | PASS | PASS, 153 |
| `@sfoa/admin-api` | PASS | PASS | PASS, 25 |
| `@sfoa/admin-web` | PASS (tsc --noEmit + vite build) | PASS | PASS, 71 (12 files) |

| Command | Result |
| --- | --- |
| `yarn validate:p5` | **PASS** — 5 workspace lints, control-plane 38 + test:mysql 14, identity-runtime 75, mcp-server test:p5 6, admin-api 25, admin-web build + 71, `p5:e2e` 3 passed, `p5:e2e:fullstack` 1 passed (`P5_ADMIN_SECURITY_REAL_HTTP=PASS`) |
| `yarn agent:sync` (`tsc` + `sync-generated.mjs --write`) | PASS |
| `yarn agent:check` (`sync-generated.mjs --check`) | PASS, `Agent artifact check PASS (5 files)` |
| `yarn skill:sync` | PASS, `fileCount 23`, 3 destinations |
| `yarn skill:check` | PASS, `drift []` |
| `yarn skill:delivery` | PASS, `trackedFileCount 1015`, `problems []` |
| `yarn skill:validate` | PASS |
| `yarn skill:test` | PASS, 12 tests |
| `yarn skill:smoke` | PASS — `skill:validate`, `skill:sync`, `skill:check`, `skill:test`, `ai:snapshot` ok; expected missing-env Doctor behaviour verified |
| `node --check scripts/p8-07-live-batch.mjs` | PASS (syntax) |
| `node scripts/p8-07-live-batch.mjs` | **BLOCKED** — no env-allowlisted, deletable test object and USER routes in this environment; zero mutations were attempted |
| MySQL/live P3 mutation gates | **BLOCKED** — the existing CREATE fixture is rejected by a real Salesforce Validation Rule and no authorized live mutation fixture is supplied. Not bypassed to manufacture a PASS |
| Independent Lightning New Page comparison (UAT-01) | **BLOCKED** — no operator session |
| Real Dify / WorkBuddy / WeCom Agent acceptance (UAT-03…UAT-07) | **BLOCKED** — no acceptance session |

One ad-hoc full `admin-web` run under concurrent load hit a load-induced 60-second test
timeout in `GovernancePages.test.tsx`. The file passes in isolation (13/13) and the full suite
passes 71/71 both inside `yarn validate:p5` and on an idle re-run. Recorded here rather than
silently dropped.

## HOTFIX COMPLETE gate

| # | Condition | State |
| --- | --- | --- |
| 1 | PARTIAL_SUCCESS is not a Tool error | PASS |
| 2 | FAILED / OUTCOME_UNKNOWN are still Tool errors | PASS |
| 3 | No whole-batch repeat after a partial CREATE | PASS (deterministic guidance + compound re-preparation tests) |
| 4 | Audit distinguishes Tool execution from a business PARTIAL outcome | PASS |
| 5 | Dynamic Forms no longer calls `ManagedDmlFieldResolver` for untrusted runtime defaults | PASS (no provider wired; source-scan guard + behavioural tests) |
| 6 | Managed Lookup failure cannot force an unrelated Dynamic Forms fallback | PASS |
| 7 | All four singular/plural enable combinations correct | PASS (CREATE and UPDATE) |
| 8 | Duplicate batch UPDATE IDs rejected before dispatch | PASS |
| 9 | No Picklist raw/display regression | PASS |
| 10 | No compound business hardcoding | PASS (generic `Root__c` / `InternalParticipant__c` / `CustomerParticipant__c` fixtures only) |
| 11 | Truncated/partial relationship is not treated as exhaustive absence | PASS |
| 12 | No P8-06 / Dify / WorkBuddy / WeCom / USER_BOUND / BUNTU / Audit / lazy-Connection regression | PASS |
| 13 | All executable automated tests PASS | PASS |
| 14 | All non-executable live UAT honestly marked BLOCKED | PASS (BLOCKED, never PASS) |

Conditions 1–14 hold, but gate condition 14 plus the phase rule mean the phase state is
**READY_FOR_UAT_WITH_LIMITATIONS**: no legal live Salesforce CREATE/UPDATE fixture and no real
Dify/WorkBuddy/WeCom Agent acceptance exists in this environment, and record-dependent
CONTAINER visibility remains UNKNOWN by design. `P8-07_COMPLETE` is explicitly not claimed.

## Remaining risks

1. The remote refs could not be fetched, so this branch may be based on a stale local P8-07 HEAD.
2. No live collection mutation has been proven end to end; the one-wire-request contract is
   covered by SDK/HTTP-level tests, not by a real Salesforce org in this environment.
3. Record-dependent CONTAINER visibility (`$Record.Field` on SECTION/TAB/CONTAINER) stays
   `CONTAINER_RECORD_UNSUPPORTED`/UNKNOWN. Lightning unsaved-record initial semantics are not
   guessed, per the explicit prohibition on speculating about Dynamic Forms Container semantics.
4. No transaction spans batches or parent/child Tool calls; partial completion is reported, not
   rolled back. Automatic rollback and automatic retry of UNKNOWN mutations remain out of scope
   by design.
5. The DB terminal-outcome enum was deliberately not migrated; partial success is carried in the
   compatible `responseSummary` shape. A future schema change could adopt a first-class enum.

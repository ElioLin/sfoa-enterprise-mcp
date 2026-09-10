# P8-07 HOTFIX02 report — Audit semantic consistency and pre-dispatch closure

Status: **READY_FOR_FINAL_UAT** (never `P8-07_COMPLETE`).

HOTFIX02 is a correctness close-out, not new P8-07 feature work. It changes two things that
misreported an already-implemented behaviour, adds the regression proof for both, and then
stops. No P8-07 design decision was revisited: the batch strategy, the public `create_record` /
`update_record` / `create_records` / `update_records` contract, Batch max 200, `allOrNone`,
request-scoped Salesforce USER, the DML allowlist, Managed Fields, the Picklist Display
Resolver, Relationship Context, Compound orchestration, Dynamic Forms visibility, P8-06 WeCom
identity, `BUNTU_TOKEN`, `USER_BOUND`, Internal identity, P7-09 lazy Connection and Salesforce
Validation/permissions are all untouched.

Live Salesforce and Agent acceptance are **BLOCKED** in this environment, so the phase state is
`READY_FOR_FINAL_UAT`, not `P8-07_COMPLETE`. Only real Salesforce + Agent UAT may claim that.

## Git

| Item | Value |
| --- | --- |
| Source branch (baseline) | `hotfix/p8-07-agent-runtime-safety` |
| Source HEAD | `933d6ff8d5c2b9bc103dcb8e8acb99050a8f6c79` |
| Hotfix branch | `hotfix/p8-07-final-uat-closure` (created from the source HEAD, not from `main`) |
| Implementation commit | `34c7a03335e4906b1815f926c58de93561e28a6b` |
| Report commit (evidence-only) | the commit that introduces this file — `git log -1 --format=%H -- docs/sfoa/P8-07-HOTFIX02-REPORT.md` |
| Pushed as | `origin/hotfix/p8-07-final-uat-closure` |

The remote HEAD was verified directly against the remote, not assumed:

```
$ git ls-remote origin refs/heads/hotfix/p8-07-agent-runtime-safety
933d6ff8d5c2b9bc103dcb8e8acb99050a8f6c79	refs/heads/hotfix/p8-07-agent-runtime-safety
```

`933d6ff` is the third of the three known HOTFIX01 commits (`4d4bacb`, `59eef46`, `933d6ff`),
so `hotfix/p8-07-final-uat-closure` starts from the authoritative remote tip and **no part of
this change was re-implemented from an older `main`**.

### Changed files

Source:

- `packages/mcp-provider-sfoa-dml/src/schemas.ts`
- `packages/mcp-provider-sfoa-dml/src/dml-executor.ts`
- `packages/sfoa-mcp-server/src/dml-tool-facade.ts`
- `packages/sfoa-admin-web/src/auditOutcome.ts` (new)
- `packages/sfoa-admin-web/src/localization.ts`
- `packages/sfoa-admin-web/src/components/StatusTag.tsx`
- `packages/sfoa-admin-web/src/pages/AuditPage.tsx`
- `packages/sfoa-admin-web/src/pages/audit/AuditTraceWorkbench.tsx`

Tests:

- `packages/sfoa-mcp-server/src/test/dml-batch-duplicate-preflight.test.ts` (new)
- `packages/sfoa-admin-web/src/test/AuditDisplayOutcome.test.tsx` (new)

Canonical guidance and generated copies (propagated by `yarn skill:sync`, never hand-edited):

- `skills/sfoa-mcp-maintainer/references/p8-07-runtime-batch.md`
- `skills/sfoa-mcp-maintainer/scripts/audit-trace.mjs`
- `skills/sfoa-mcp-maintainer/scripts/toolkit.test.mjs`
- the three generated `.claude` / `.agents` / `.codebuddy` copies of those three files

19 modified + 3 new files. No environment file, credential, dependency, lockfile, DDL or
migration is part of this change: the migration ledger is still untouched by HOTFIX02 and no
new migration was added.

## HF02-01 — Audit no longer reports a partial batch as a complete SUCCESS

The two semantics HOTFIX01 split at the persistence layer were still collapsed at the display
layer. `outcome` / `result` describe the **MCP Tool invocation terminal state**; for a batch the
**Salesforce business mutation result** lives in `responseSummary.businessOutcome`. A
`PARTIAL_SUCCESS` batch is recorded as `result=PASS` / `outcome=SUCCESS`, because the collection
POST returned 200 and only individual items were rejected — correct in the database, and
misleading on screen: the Audit list and the detail header both rendered a plain 成功.

The fix is a deliberately low-coupling display resolver, `packages/sfoa-admin-web/src/auditOutcome.ts`,
which both Audit surfaces consume and which never mutates `audit.outcome`:

| `responseSummary` | Displayed status |
| --- | --- |
| `batch=true` + `businessOutcome=PARTIAL_SUCCESS` | `PARTIAL_SUCCESS` (部分成功, warning tone) |
| `batch=true` + `businessOutcome=OUTCOME_UNKNOWN` | `UNKNOWN` (warning tone) |
| `batch=true` + `businessOutcome=FAILED` | `FAILED` (error tone) |
| `batch=true` + `businessOutcome=SUCCESS` | `SUCCESS` |
| anything else | the existing `outcome ?? result` |

`PARTIAL_SUCCESS` was added to the warning set in `statusTone` and to `STATUS_LABELS`, so the
tag reads 部分成功 with 原始值：PARTIAL_SUCCESS on hover — an operator never has to open the
internal JSON to tell a partial commit from a full one.

### Before / after — batch UPDATE, 10 records, 9 committed, 1 rejected

| Surface | Before | After |
| --- | --- | --- |
| Audit list status | 成功 — indistinguishable from a fully committed batch | 部分成功, warning tone |
| Audit detail header | 成功 | 业务结果：部分成功 (visual primary) with 工具执行：成功 as secondary text |
| Raw Tool outcome | `PASS` / `SUCCESS` | unchanged — still `PASS` / `SUCCESS` |
| Raw business outcome | `responseSummary.businessOutcome=PARTIAL_SUCCESS` | unchanged — both layers preserved |
| 问题定位 section | 未发现执行错误, contradicting the batch counts above it | 批量业务结果：PARTIAL_SUCCESS warning with the same 总数/成功/失败/未知 counts and 禁止整批重试 |
| 批量操作 counts Alert | 总数 10 · 成功 9 · 失败 1 · 未知 0 | unchanged |

No "top SUCCESS / below PARTIAL_SUCCESS" contradiction exists: when the business outcome and the
Tool outcome differ, the business outcome is the status tag and the Tool outcome is demoted to
secondary text. When they agree (a fully committed batch) no secondary text is rendered at all.

The `OUTCOME_UNKNOWN` path keeps its priority: an unprovable commit state is displayed as
UNKNOWN with the existing 操作结果未知（UNKNOWN）/ 避免直接重试 warning, and a test asserts that
even a row whose terminal column says `SUCCESS` is still displayed as UNKNOWN. `FAILED` still
displays as 失败. Non-batch audits, historical rows with a null `outcome`, and a
`responseSummary` that is not `batch: true` all keep their previous behaviour.

The DB terminal-outcome enum was **not** changed and **no migration was added**.

### §6 Audit filter — explicitly NOT supported in this round

The existing control-plane Audit filter contract (`adminAuditQuerySchema` plus
`mysql-audit-repository.ts`) is a strict zod object over plain MySQL columns; filtering is
`query.where('result', '=', …)` / `query.where('outcome', '=', …)`. `businessOutcome` is not a
column — it lives inside `response_summary_json` — so a filter for it would require a JSON
expression query and would enlarge the Control Plane/SQL contract. Per the HOTFIX02 instruction
to avoid that, **the `businessOutcome` Audit filter is deliberately not implemented**.

Minimum acceptance is met without it: the Audit list shows 部分成功, the Audit detail shows
部分成功, and an operator needs no access to the internal JSON to distinguish the three cases.

## HF02-02 — duplicate `update_records` rejected before Salesforce Connection acquisition

HOTFIX01 added the duplicate-ID rejection inside `DmlExecutor.batch()`, after the allowlist read.
That ordering already avoided a Salesforce round trip, but the request still passed through the
host facade's allowlist assert and connection acquisition path before reaching the executor.

`DmlToolFacade.executeCore()` now runs a preflight **immediately after** the
`createRecordsInputSchema.parse()` / `updateRecordsInputSchema.parse()` succeeds and **before**
the allowlist assert or `connectionProvider.getConnection()` / `managedFieldResolver.resolve()`:

```
assertNoDuplicateBatchRecordIds(this.operation, input);
```

The check reuses the existing `duplicateBatchRecordIds()` identity rule and the existing
`BATCH_DUPLICATE_RECORD_ID_CODE`; the duplicate algorithm was not rewritten. The only shared
addition is `duplicateBatchRecordIdMessage()` in `schemas.ts`, which both layers now use so the
host preflight and the executor cannot drift in code or wording. A dedicated `catch` branch
classifies the rejection at the host TOOL layer rather than TRANSPORT, and the existing batch
wrapper turns it into the unified batch error contract.

| | Before | After |
| --- | --- | --- |
| Rejection point | `DmlExecutor.batch()`, after the allowlist read | `DmlToolFacade.executeCore()` preflight, before the allowlist read and before any Connection acquisition |
| Error contract | `MCP_DML_BATCH_DUPLICATE_RECORD_ID`, `status=FAILED` | unchanged — `status=FAILED`, `isError=true`, `mutationStarted=false` |
| Salesforce Connection calls | 0 | 0 (asserted) |
| Managed-field lookup calls | 0 | 0 (asserted) |
| Salesforce mutation / dispatch calls | 0 | 0 (asserted) |
| Executor check | present | **preserved** as defense-in-depth for providers called directly |

The executor check was not deleted, per §8. `DmlExecutor.updateRecords()` reached directly still
rejects a duplicate batch.

### §9 lazy-Connection regression guard

`packages/sfoa-mcp-server/src/test/dml-batch-duplicate-preflight.test.ts` (6 tests) proves the
preflight costs no Salesforce work and that P7-09 lazy Connection has not regressed:

- 18-character and 15-character IDs of the same record are treated as duplicates and rejected
  with all counters at zero (`providerConnections`, `executorConnections`, `lookups`,
  `dispatches`, `mutationsStarted`);
- the unified batch error contract is exact (FAILED / 0 succeeded / 2 failed / 0 unknown) and the
  audit event is `result=ERROR`, `outcome=FAILED`, `terminalSource=TOOL`,
  `responseSummary.businessOutcome=FAILED`;
- a **non-duplicate** batch still acquires the Connection at both layers (1 + 1), performs 1
  lookup, 1 dispatch and 1 mutation — the zeroes above are the preflight working, not lazy
  Connection being broken;
- `create_records` is unaffected;
- a direct `DmlExecutor.updateRecords()` duplicate is still rejected with 0 connections and 0
  dispatches;
- the HF02-05 `isError` contract still holds: `PARTIAL_SUCCESS` → `false`, `FAILED` → `true`,
  `OUTCOME_UNKNOWN` → `true` (`MCP_DML_OUTCOME_UNKNOWN`).

## HF02-04 — Maintainer Skill audit interpretation

The maintainer Audit diagnostic read only `audit.result` / `audit.outcome` to judge DML success,
which is exactly the confusion HF02-01 removes from the UI.
`skills/sfoa-mcp-maintainer/references/p8-07-runtime-batch.md` now states that for batch DML
`responseSummary.businessOutcome` is the authority for the mutation result while
`audit.result` / `audit.outcome` is only the Tool invocation terminal state, that a partial batch
must never be summarized as 全部成功 nor as a whole-Tool failure, and that `OUTCOME_UNKNOWN`
keeps priority.

`scripts/audit-trace.mjs` gained a matching `BATCH_BUSINESS_OUTCOME` first-failure source
(placed after the event/API candidates and before the `audit.result !== 'PASS'` fallback), so a
partial batch whose collection POST succeeded and which therefore has **no failing event and no
failing Salesforce API row** is still diagnosed instead of reporting a clean run. The RESULT node
also carries `businessOutcome`. Two tests in `scripts/toolkit.test.mjs` cover the partial and the
fully committed cases.

The three generated `.claude` / `.agents` / `.codebuddy` Skill copies were propagated with
`yarn skill:sync` and verified with `yarn skill:check` (`ok: true`, `drift: []`); nothing was
hand-edited in a generated copy.

## HF02-06 — Dynamic Forms precedence confirmed, not modified

Confirmed by inspection and by the existing HOTFIX01 tests, and left unchanged: precedence is
`USER_EXPLICIT > SALESFORCE_CREATE_DEFAULT > trusted runtime defaults`; `$User` facts stay
bounded; a failing runtime provider is isolated to the affected dependencies while the rest of
the resolution still computes; `ManagedDmlFieldResolver` is **not** wired as a runtime-default
provider. Record-dependent SECTION/TAB/CONTAINER visibility remains
`CONTAINER_RECORD_UNSUPPORTED` / UNKNOWN. No visibility was guessed to make the phase look
COMPLETE, and `CONTAINER_RECORD_UNSUPPORTED` was explicitly **not** attempted.

## Verification

Validation ran on 2026-09-10 on `hotfix/p8-07-final-uat-closure` at
`34c7a03335e4906b1815f926c58de93561e28a6b`. Lint scripts in these packages are TypeScript
`--noEmit`; there is no separate `typecheck` script, and builds enforce the same strict tsconfig.

| Workspace | build | lint / typecheck | test |
| --- | --- | --- | --- |
| `@sfoa/mcp-provider-sfoa-dml` | PASS | PASS | PASS, 46 |
| `@sfoa/mcp-provider-sfoa-context` | PASS | PASS | PASS, 83 |
| `@sfoa/agent-playbook` | PASS | PASS | PASS, 34 |
| `@sfoa/identity-runtime` | PASS | PASS | PASS, 75 |
| `@sfoa/control-plane` | PASS | PASS | PASS, 38 + 14 MySQL |
| `@sfoa/mcp-server` | PASS | PASS | PASS, 159 (`src/test`) + `test:p3` 25 + `test:p4` 8 + `test:p7` 6 |
| `@sfoa/admin-api` | PASS | PASS | PASS, 25 |
| `@sfoa/admin-web` | PASS (tsc --noEmit + vite build) | PASS | PASS, 83 (13 files) |

| Command | Result |
| --- | --- |
| `yarn validate:p5` | **PASS** — exit code 0, so every gate in `scripts/validate-p5.mjs` passed: the workspace lints, control-plane `test` + `test:mysql`, identity-runtime, mcp-server `test:p5`, admin-api, admin-web build + test, `p5:e2e`, and `p5:e2e:fullstack`. The run reports the migration ledger ending at `013_p8_05_wecom_identity_channel` — HOTFIX02 added no migration |
| `yarn agent:sync` (`tsc` + `sync-generated.mjs --write`) | PASS — `Synchronized 5 Agent artifacts` |
| `yarn agent:check` (`sync-generated.mjs --check`) | PASS — `Agent artifact check PASS (5 files)` |
| `yarn skill:sync` | PASS — 23 files to 3 destinations |
| `yarn skill:check` | PASS — `ok: true`, `drift: []` |
| `yarn skill:delivery` | PASS — `trackedFileCount 1015`, `problems []`, `packageCompleteness true` |
| `yarn skill:validate` | PASS — `ok: true`, `fileCount 23` |
| `yarn skill:test` | PASS, 14 |
| `yarn skill:smoke` | PASS — `skill:validate`, `skill:sync`, `skill:check`, `skill:test`, `ai:snapshot` and the expected missing-env Doctor behaviour all ok |
| Real Salesforce collection mutation UAT | **BLOCKED** — no env-allowlisted live mutation fixture and no authorized org session in this environment. Not bypassed and not reported as PASS |
| Independent Dify / WorkBuddy / WeCom Agent acceptance | **BLOCKED** — no acceptance session |

The first `yarn agent:sync` invocation failed with a transient Windows `Access is denied` spawn
error; the immediate retry succeeded and `yarn agent:check` passed both times. Recorded rather
than silently dropped.

The first full `admin-web` run after the 问题定位 Alert change failed one assertion —
the new partial-batch warning repeats the same 总数/成功/失败/未知 counts as the pre-existing
`批量操作：部分成功` Alert, so `getByText` matched two nodes. The assertion now anchors on the
pre-existing Alert's unique full wording (including the `allOrNone` note), which both fixes the
ambiguity and proves that Alert is unchanged. Full suite re-ran 83/83.

## HOTFIX02 COMPLETE gate

| # | Condition | State |
| --- | --- | --- |
| 1 | The Audit list no longer shows a complete SUCCESS for a batch `PARTIAL_SUCCESS` | PASS |
| 2 | The Audit detail main status no longer shows a complete SUCCESS | PASS (业务结果 is the primary status) |
| 3 | Both the raw Tool outcome and `businessOutcome` are preserved | PASS |
| 4 | No DB migration was needed | PASS — terminal enum untouched |
| 5 | Duplicate `update_records` is rejected before Salesforce Connection acquisition | PASS |
| 6 | The executor duplicate check is retained | PASS |
| 7 | The preflight triggers no Managed Lookup / Connection / mutation | PASS (all counters 0) |
| 8 | `PARTIAL_SUCCESS` retry safety has not regressed | PASS |
| 9 | Dynamic Forms / Picklist / Compound / Tool Governance have not regressed | PASS |
| 10 | P8-06 / `BUNTU_TOKEN` / `USER_BOUND` / Internal identity have not regressed | PASS |
| 11 | All executable automated gates PASS, non-executable UAT honestly BLOCKED | PASS |

All eleven conditions hold. Because no live Salesforce mutation and no real Agent acceptance
exists in this environment, the phase state is **READY_FOR_FINAL_UAT**. `P8-07_COMPLETE` is
explicitly not claimed.

## Remaining known limitations

1. **The `businessOutcome` Audit filter is not supported** (§6 of this hotfix). Adding it would
   have required a JSON query over `response_summary_json` and enlarged the Control Plane/SQL
   filter contract. Listing and detail display are sufficient for the minimum acceptance.
2. Record-dependent CONTAINER / SECTION / TAB visibility remains `CONTAINER_RECORD_UNSUPPORTED`
   or UNKNOWN. `CONTAINER_RECORD_UNSUPPORTED` was explicitly out of scope for this hotfix and is
   left to real UAT or a later independent stage. It was not guessed at to make the phase look
   complete.
3. No live collection mutation has been proven end to end; the one-wire-request and preflight
   contracts are covered by SDK/HTTP-level and counter-based tests, not by a real Salesforce org
   in this environment.
4. Partial completion is reported, never rolled back. Automatic rollback and automatic retry of
   an `OUTCOME_UNKNOWN` mutation remain out of scope by design, and the Admin Web warning text
   states that an already committed record is not reverted.
5. The DB terminal-outcome enum was deliberately not migrated; partial success is carried in the
   compatible `responseSummary` shape and resolved at display time.
6. Nothing has been merged or deployed by this hotfix. `hotfix/p8-07-final-uat-closure` was
   created from the authoritative HOTFIX01 tip `933d6ff` and pushed as
   `origin/hotfix/p8-07-final-uat-closure`; no pull request has been opened, and merging is a
   separate, authorized step.

## UAT state

`READY_FOR_FINAL_UAT`. The remaining acceptance work is exactly what this hotfix could not
execute here: a real Salesforce collection CREATE/UPDATE against an allowlisted test object with
A/B USER routes, and independent Dify / WorkBuddy / WeCom Agent acceptance — including the
Case B check that a 10-record batch with 9 committed and 1 rejected reads as 部分成功 in both the
Audit list and the detail header, and a Case D check that an `OUTCOME_UNKNOWN` batch is never
presented or retried as a success.

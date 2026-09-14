# Skill-02A `sfoa-record-change` 交付报告

Report ID: SFOA-OPENCLAW-SKILL-02A · 2026-09-14

本报告记录 OpenClaw 第二个业务 Skill 的开发、审查与机器门禁证据。它同时是后续 Skill-02B 与真人 UAT 的输入。**机器门禁通过不等于行为验收通过。**

## A. 最新基线

| 项目 | 值 |
| --- | --- |
| Base Branch | `hotfix/openclaw-sfoa-crm-core-data-completeness` |
| Base Commit SHA | `ef6b4e25c9360727ed7e1d3737ab774f9cc08ab7` |
| 开发分支 | `feature/openclaw-sfoa-record-change-02a` |
| 实现 Commit | `0a006a375f5a017019c105a0a1603d98128977b7` |
| 报告 Commit | `25d67b916255a5fc3ee0f5943075f746099232f9` |
| 文档一致性 Commit | `fd880c6aae6070c8e680a582f4010b024b56ca38` |
| 当时 `origin/main` | `25a15ce4fbf642fd995a7e61ab3fc92be1616a97`（未合入本分支） |

本报告之后的纯文档提交不改变 `skills/sfoa-record-change/` 的任何 canonical 字节；Skill 交付以实现 Commit `0a006a3` 的 canonical 内容与 G 节记录的 SHA-256 为准。

执行 `git fetch --all --prune` 后核对：`origin` 为 `github.com/ElioLin/sfoa-enterprise-mcp.git`，`upstream` 为 `github.com/salesforcecli/mcp.git`。远端 `hotfix/openclaw-sfoa-crm-core-data-completeness` 与 `feature/openclaw-sfoa-skill-foundation` 的跟踪引用已被 prune（`origin/...: gone`），因此 Base 取本地最新真实代码状态 `ef6b4e2`（HOTFIX02 数据完整性），而不是已落后的 `main`。`feature/openclaw-sfoa-record-change` 不存在，未覆盖任何他人分支。

Base 相对 `main` 领先 99 个提交，包含 OpenClaw 基线、WeCom 链路、P8-04、P8-05/06、P8-07、Skill-01 与 HOTFIX01/02。本分支从该真实代码状态创建，未从旧 `main` 重建。

## B. 审查结果（以当前代码为最高事实来源）

审查的源码：`packages/mcp-provider-sfoa-context/src/{schemas,record-action-executor,effective-ui-contracts,effective-ui-resolver,visibility,create-initial-state}.ts`、`packages/mcp-provider-sfoa-dml/src/{schemas,dml-executor,allowlist}.ts`、`packages/sfoa-mcp-server/src/{dml-managed-fields,dml-tool-facade}.ts`、`packages/sfoa-agent-playbook/src/{definition,capabilities}.ts`、`packages/sfoa-admin-web/src/test/SkillContent.test.ts`。

### `get_record_action_context`

输入（`.strict()`）：`objectApiName`、`action`（`CREATE`/`UPDATE`）、`recordTypeId?`、`recordId?`、`draftFields?`、`refinement?`。

- CREATE 支持 `draftFields` + `refinement`；UPDATE 明确拒绝二者（`draftFields and refinement are CREATE-only`）。
- `recordId` CREATE 禁止、UPDATE 必需。
- `draftFields` 上限 200 key / 32768 字节；值域 `string|number|boolean|null`，missing 与 `null`/`false`/`0`/空串在语义上不同。
- `refinement` 为 `int().min(0).max(3)`。

输出关键字段（与本 Skill 直接相关）：`recordType{id,name,defaultForUser,available}`、`availableRecordTypes[]`、`recordTypeSelectionRequired`、`fields[]`、`uiContext`、`uiContextResolutionId`、`coverage`。

`fields[]` 每项：`apiName`、`label`、`dataType`、`apiRequired`、`layoutMember`、`layoutRequired`、`fieldCreateable`、`fieldUpdateable`、`layoutEditableForCreate`、`layoutEditableForUpdate`、`defaultValue`、`defaultValueTruncated`、`section`、`layoutOrder`、`relationshipName`、`referenceTo`、`picklist`、`visibilityState`、`requiredSource`、`effectiveRequired`、`effectiveEditable`、`optionalCandidate`、`conditionalRequired`、`dependsOn`、`sectionOrder`、`column`。

Prompt 中列出的返回字段全部真实存在，无需为匹配 Prompt 修改 Runtime。

### Record Type

`recordTypeSelectionRequired` 在多个可用候选时为 true，且该分支只读取 `UI_API_OBJECT_INFO`，跳过 Create Defaults / Picklists。`recordTypeSelectionRequired: false` 与完整事实只在单一候选或显式 `recordTypeId` 时返回。Master 在存在可用非 Master 类型时已从候选中排除。

### Dynamic Forms

- 四态枚举 `visibilityState` = `VISIBLE | HIDDEN | PENDING | UNKNOWN`。
- `PENDING` 出现在 `$Record.<field>` 依赖既不在 draft 中、也没有 initial fact 时；`dependsOn` 给出字段名。
- `UNKNOWN` 来自不支持的条件/操作符、缺失字段类型、`$Permission` 等不可用事实、`CONTAINER_RECORD_UNSUPPORTED`、类型不匹配或 booleanFilter 解析失败。
- `combineVisibility`：AND 含 HIDDEN → HIDDEN；OR 含 VISIBLE → VISIBLE；否则 UNKNOWN 优先于 PENDING。
- `conditionalRequired` = 该字段某个实例处于 `PENDING` 且该实例 `required`。
- `uiContext`：`mode`（`OFF|SHADOW|ENFORCE`）、`formSource`、`resolutionStatus`、`fallbackUsed`、`fallbackReason`、`coverage`（`COMPLETE|PARTIAL|NONE`）、`maxRefinements`（字面量 3）、`refinement`、`refinementLimitReached`（`refinement===3`）。
- `coverage.completeLightningPageEvaluated` 在 schema 中是字面量 `false`；legacy 与 selection-required 分支的 `dynamicFormsEvaluated` 也是 `false`。
- 关键工程事实：发生 PAGE_LAYOUT fallback 时返回的是 legacy 结果，`fields[]` **没有** `visibilityState` / `effectiveRequired` 等 effective 属性。本 Skill 因此把 fallback 单独处理，不假装做过 Dynamic Forms 判断。
- Runtime 不保存会话状态，refinement 计数由客户端保留。

### Managed Lookup

存在两套命名，必须区分：

| 层 | 取值 |
| --- | --- |
| Agent 可见能力（`managedDmlFields[].strategy`） | `PLATFORM_IDENTITY`、`AI_CREATED_MARKER`、`PLATFORM_IDENTITY_FALLBACK` |
| 配置/数据库规则（`ManagedDmlFieldRuleRecord.strategy`） | `PLATFORM_USER_LOOKUP`、`PLATFORM_USER_LOOKUP_FALLBACK`、`AI_CREATED_MARKER` |

`PLATFORM_IDENTITY_FALLBACK` 是业务 Agent 看到的名称，也是本 Skill 使用的名称；配置层的 `PLATFORM_USER_LOOKUP_FALLBACK` 是同一能力的规则侧枚举。`PLATFORM_IDENTITY_FALLBACK` 强制 CREATE-only（配置校验拒绝 applyOnUpdate）。

行为：显式提供该字段时值被保留并规范化到目标字段 API 名（显式优先，不被 fallback 覆盖）；省略时 Runtime 用**平台用户 ID**查询 `lookupObjectApiName.lookupMatchFieldApiName`（`LIMIT 2`），1 条则使用，0 条 → `MCP_DML_MANAGED_LOOKUP_NOT_FOUND`，≥2 条 → `MCP_DML_MANAGED_LOOKUP_AMBIGUOUS`，查询/响应/Id 异常 → `MCP_DML_MANAGED_LOOKUP_FAILED`。同一目标字段的大小写别名会被拒绝（`MCP_DML_INPUT_INVALID`）。

### Picklist / Lookup

- `picklist{controllerName, controllerValues, values[{label,value,default,validFor}], totalValues, returnedValues, truncated}`。
- Dependent Picklist 通过 `controllerName` + `controllerValues` + `validFor` 索引解析。
- Lookup 通过 `referenceTo` 得到可引用对象；Runtime 不解析 Lookup 值，需要 Agent 用有界 USER 读取得到唯一 ID。
- `resolve_field_display_values` 是真实的展示解析 Tool（bounded USER read），用于展示层 Label。

### DML

- 真实工具为 `create_record`、`create_records`、`update_record`、`update_records`。历史名称 `sf_prepare_record_change` / `sf_commit_record_change` 在当前代码中**不存在**，未使用。
- `create_record`：`objectApiName`、`recordTypeId?`、`uiContextResolutionId?`（uuid，仅 Audit provenance）、`fields`（1..200，禁止 `Id`）。`recordTypeId` 与 `fields.RecordTypeId` 冲突时被 schema 拒绝。
- `create_records`：`objectApiName`、`allOrNone`（默认 false）、`records[1..200]`，每项 `{recordTypeId?, uiContextResolutionId?, fields, clientReferenceId?}`；`clientReferenceId` 批内唯一。
- 单条输出 `{success, recordId?, errorCode?, message?, salesforceErrors?}`；批量输出含 `status` = `SUCCESS|PARTIAL_SUCCESS|FAILED|OUTCOME_UNKNOWN` 与 `total/succeeded/failed/unknown/results[]`。
- `isError` 只表示 Tool 执行是否完成：`SUCCESS`/`PARTIAL_SUCCESS` 为 false，`FAILED`/`OUTCOME_UNKNOWN` 为 true。
- `clientReferenceId` 只是关联键，从不下发到 Salesforce 字段，也不是幂等键。

### Audit

`uiContextResolutionId` 与 `uiContext.resolutionId` 一致，是 Audit provenance。它不改变授权、不改变 payload，`create_record` 不因此发起 Metadata 解析调用。只有 ENFORCE + 受支持 DYNAMIC_FORMS/MIXED 且无 fallback 时才暴露。

## C. 实现文件

### 新增

| 路径 | 原因 |
| --- | --- |
| `skills/sfoa-record-change/SKILL.md` | Canonical 入口：23 条 Hard Rules + 加载边界 + Guidelines + references 路由 |
| `skills/sfoa-record-change/references/readiness-gate.md` | `CHANGE_READY` 模型、blocking conditions 表、逐条记录就绪、证据优先级 |
| `skills/sfoa-record-change/references/create-readiness.md` | 当前 CREATE contract、Initial Fact Ledger、Record Type Hard Gate、Missing Required Checklist、Defaults、询问节奏、create_record/create_records 选择、抽象 UAT 回归案例 |
| `skills/sfoa-record-change/references/dynamic-forms.md` | 四态语义、PENDING、UNKNOWN 来源、Critical Dynamic Dependency、refinement 0..3、Evidence Completeness |
| `skills/sfoa-record-change/references/managed-lookups.md` | 三种 strategy、显式优先、omit→Runtime fallback、Lookup 错误码、Owner 与 Mutation Intent |
| `skills/sfoa-record-change/references/lookup-and-picklist.md` | Lookup 0/1/multiple、Lookup Filter、Label/API Value 分工、Dependent Picklist |
| `skills/sfoa-record-change/references/outcomes.md` | 单条与批量结果语义、UNKNOWN 不重放、PARTIAL_SUCCESS 只重备失败项、批次边界、汇报要求 |
| `docs/sfoa/SFOA_RECORD_CHANGE_SKILL.md` | 本报告 |

以上 7 个 Skill 文件由 `skill:sync` 生成同名副本到 `.agents/skills/`、`.claude/skills/`、`.codebuddy/skills/`，共 21 个生成文件。

### 修改

| 路径 | 原因 |
| --- | --- |
| `skills/sfoa-mcp-maintainer/scripts/toolkit.test.mjs` | 新增 9 个机器门禁（见 G 节），并新增 `exists` / `readdir` 导入 |
| `skills/sfoa-mcp-maintainer/references/skill-maintenance.md` | 记录业务 Skill 套件现为 `sfoa-crm-core` + `sfoa-record-change`，以及业务 Skill 不携带脚本/不命名 maintainer 的约束 |
| `skills/sfoa-crm-core/references/mutation-boundaries.md` | 修正过时描述：CREATE 必填与 READY Gate 的交接指向现已存在的专业 Skill，不再写“该 Skill 当前未实现” |
| `docs/sfoa/SFOA_OPENCLAW_SKILLS_BASELINE.md` | Skill-02 状态改为 02A 已交付 / 02B 未实现；更新 Runtime Copy 目标、main allowlist、自动选择覆盖范围 |
| `docs/sfoa/CHANGELOG.md` | 记录 Skill-02A 交付 |

### 删除

无。

**没有修改任何 TypeScript、SQL、migration、Provider、Identity、Tool Governance 或 Salesforce 数据文件。**

## D. Skill 架构

```text
skills/sfoa-record-change/
├── SKILL.md                      # 短、强约束、可被 deepseek-flash 快速读完
└── references/                   # 承载专业细节
    ├── readiness-gate.md
    ├── create-readiness.md
    ├── dynamic-forms.md
    ├── managed-lookups.md
    ├── lookup-and-picklist.md
    └── outcomes.md
```

- `SKILL.md` 只承担四件事：声明继承 Core、给出 23 条 Hard Rules、界定加载/不加载场景、路由 references。没有背景故事，没有学术论述。
- references 按任务读取，不要求每轮全读。
- 未使用跨 Skill 的 Markdown 链接（`validateSkill` 要求本地链接必须落在 Skill 目录内），因此与 Core 的继承关系用文字声明，机器门禁用特征串校验。
- 未复制 Core 的 Identity / Governance / Web Trust / Analytics 规则。

### 机器门禁

沿用 Skill-01 的既有机制，未另造部署系统：

- `manage.mjs validate/sync/check/delivery/package`（canonical 发现所有 `skills/*` 目录，每个 Skill 生成三个平台副本并做 SHA-256 漂移检查）。
- `toolkit.test.mjs` 内容契约：`CORE_HARD_RULE_MARKERS`（Skill-01 回归，未改动）+ 新增 `RECORD_CHANGE_HARD_RULE_MARKERS` 与 `BUSINESS_SKILL_NAMES`。
- Runtime Copy 目标：`/data/openclaw/workspace/skills/sfoa-record-change/`。canonical 始终是唯一事实来源，Runtime Copy 不反向维护。

## E. Hard Rules

写入 `SKILL.md` 的 23 条（机器门禁逐条校验标签 + 正文特征串）：

1. CHANGE_READY Gate：`CHANGE_READY != true` 不得 CREATE；它不是 Tool / DB 状态 / Token。
2. Context != Ready：调用过 Action Context 不等于表单已检查完成。
3. Record Type Gate：多候选无法唯一判断必须询问；不得因 default 静默替用户选择业务 Record Type。
4. Required Checklist：VISIBLE + `effectiveRequired` + 无显式值 + 无可信默认 → 必须询问；`apiRequired` 与可见性无关。
5. PENDING 必须继续解析：依赖已知写 draft + refinement，未知先问依赖；不得忽略 PENDING 直接 CREATE。
6. UNKNOWN 不得猜测成 VISIBLE/HIDDEN。
7. Critical Dynamic Dependency 未稳定时 `CHANGE_READY=false`。
8. HIDDEN 不询问、不推荐。
9. Refinement 上限：遵守 `refinement` 0..3 与 `refinementLimitReached`，不收敛就停并如实说明。
10. Initial Facts 不重复询问。
11. Default 必须有实时证据；Flow / Trigger 保存后补值不算。
12. 严格 managed（`PLATFORM_IDENTITY`、`AI_CREATED_MARKER`）不询问、不填写、不覆盖。
13. Owner Fallback：显式优先；required 且未指定时说明 fallback 语义；用户选择默认则省略字段交 Runtime fallback，不得自行查询 User ID。
14. 显式值 0 match / multiple match 不得偷偷 fallback。
15. Lookup 歧义不得猜、不得模型生成 ID；Lookup Filter 拒绝按 FAILED 处理，不自动换候选。
16. Picklist 必须用实时 API Value，不得硬编码 Label→API Value；Dependent 先解决 controller。
17. Evidence Completeness：截断/省略时不得宣称 Required 已验证完成；区分 Evidence Delivery Incomplete 与 Runtime Coverage Partial。
18. Batch 独立就绪：不得在用户补充 C 时让 A/B 已产生副作用。
19. `OUTCOME_UNKNOWN` / `MCP_DML_OUTCOME_UNKNOWN` 不得自动重放。
20. `PARTIAL_SUCCESS` 不得整批重试。
21. Mutation Intent 不扩大：不得为「补全」写入用户未要求的字段（尤其 Owner）。
22. 不硬编码 Required Fields、Record Type ID/DeveloperName、Picklist API Value、Lookup ID、公司字段规则。
23. Salesforce Validation / FLS / Sharing / Lookup Filter / Flow / Trigger / CRUD 为最终权威。

## F. CHANGE_READY

```text
CREATE blocking conditions（任一为 true → CHANGE_READY=false）
  Intent resolved / Object resolved / Record Type resolved
  Effective CREATE Context sufficiently resolved
  User explicit facts incorporated
  Critical Dynamic Form dependencies stable
  Required fields satisfied
  Submitted fields valid/editable per available evidence
  Lookup ambiguity resolved
  Picklist values normalized
  Managed field rules satisfied
  Evidence sufficient（未被截断的关键证据）
  User mutation intent still matches final payload
  Explicit user value resolution succeeded
```

只有全部 blocking condition 为 false 才 `CHANGE_READY=true`，之后才允许 `create_record` / `create_records`。

批量：`∀ intended record: CHANGE_READY(record) == true`，默认整批先不 dispatch。

明确不算 blocking condition：未调用某个 Tool、`coverage=PARTIAL` 本身、与本次 mutation 无关的 non-critical UNKNOWN、optional 字段为空、严格 managed 字段、存在 Salesforce default。

`CHANGE_READY` 是 Agent 的逻辑判断，不是 MCP Tool、不是数据库字段、不是事务状态、不是 Ready Token、不是 Workflow Engine。本轮**没有**新增任何 Runtime 存储或协议。

## G. Tests

### 机器门禁（`node --test skills/sfoa-mcp-maintainer/scripts/toolkit.test.mjs`）

28 tests / 28 PASS（Skill-01 时 19 → 新增 9 个测试用例，另有 1 个原有用例因新增 canonical Skill 而覆盖更多目标）。

| 门禁 | 结果 |
| --- | --- |
| CRM Core Hard Rules 内容契约（Skill-01 回归，未改动） | PASS |
| Data completeness reference 契约（Skill-01 回归） | PASS |
| `sfoa-record-change` SKILL.md 23 条 Hard Rules 标签 + 正文特征串 | PASS |
| Core 继承声明 + 六个 references 路由可达 | PASS |
| readiness-gate：blocking conditions、逐记录不变量、拒绝新增 Runtime 机制 | PASS |
| dynamic-forms：四态互不混淆、refinement 上限、Evidence Incomplete vs Coverage Partial、fallback 处理 | PASS |
| managed-lookups：三 strategy、显式优先、禁止静默 fallback、禁止客户端解析 User ID | PASS |
| create-readiness：Initial Facts 五来源、Record Type Gate、Missing Required Checklist、抽象 UAT 案例 | PASS |
| lookup-and-picklist：0/1/multiple、Label/API Value、dependent controller | PASS |
| outcomes：UNKNOWN 不重放、PARTIAL_SUCCESS 只重备失败项、clientReferenceId 非幂等键 | PASS |
| 无硬编码：无 Salesforce ID 字面量、无冻结 `RecordTypeId`/`DeveloperName` | PASS |
| 业务套件隔离：业务 Skill 无 `scripts/`、无 `agents/openai.yaml`、不命名 maintainer | PASS |
| canonical 结构校验 / sync / check / package / 多 Skill 独立同步 / 通用校验拒绝 | PASS |
| 平台副本与 canonical 逐字节一致 | PASS |
| delivery gate（Git tracking / ignore / package 完整性） | PASS |

### 按验收维度

| 维度 | 覆盖方式 | 结果 |
| --- | --- | --- |
| Record Type | 唯一 / 用户明确 / 多候选 block / 不静默用 default | PASS（契约测试） |
| Required | VISIBLE+effectiveRequired 缺失 → 不 ready；Prompt 已给不重复问；可信 default 不重复问 | PASS（契约测试） |
| Dynamic Forms | PENDING 已知 → refinement；未知 → clarification；refinement 后新 Required 进 checklist；HIDDEN 不追问；critical UNKNOWN block；non-critical 不机械 block | PASS（契约测试） |
| Owner | explicit unique → explicit wins；0 match → block 不 fallback；multiple → block；required fallback missing → 告知语义；用户选默认 → Runtime fallback；optional 不阻塞 | PASS（契约测试） |
| Lookup | 0 / 1 / multiple | PASS（契约测试） |
| Picklist | Label → API Value；dependent 先 controller | PASS（契约测试） |
| Evidence completeness | 截断/省略 → 不得 READY | PASS（契约测试） |
| CHANGE_READY | false 不得调用 create_record/create_records；true 才允许 | PASS（契约测试） |
| Skill-01 regression | Core 内容契约 + data-completeness 契约未改动且通过 | PASS |
| 业务 Agent 可见性 | 业务 Skill 不含 maintainer 脚本或名称 | PASS（仓库侧）；Runtime allowlist 属部署步骤 |

### 干净检出 Smoke

`clean-checkout-smoke.mjs` 在本 Windows 主机上因临时目录 `rm` 报 `EBUSY`（预先存在的环境问题，与本轮改动无关）而无法输出报告。改用等价手工流程：`git archive HEAD` → 解包到仓库外临时目录 → 依次执行同样 5 条 gate + doctor。

| Gate | 结果 |
| --- | --- |
| `skill:validate`（3 个 canonical） | PASS |
| `skill:sync` | exit 0 |
| `skill:check`（3 个 Skill，drift 空） | PASS |
| `skill:test` | 28 / 28 PASS |
| `ai:snapshot` | exit 0 |
| `ai:doctor --skip-db --skip-services` | `localEnvironment.exists=false`，`orgObjectUsage=SKIPPED`（缺 `.env.local` 是受支持状态） |

### 包与交付

`skill:package --canonical skills/sfoa-record-change` → 7 文件、41,427 字节、`sha256=759e51e8f616ed1e43806c21cdd4e2af46018a6c85ff110b12507adc2de52d0d`。`skill:delivery` 三个 Skill 均 `ok:true`，`untracked`/`ignored` 为空，`packageCompleteness:true`。

Canonical 文件 SHA-256 前缀：`SKILL.md` `6b10aff838d2`、`readiness-gate.md` `3fc5c3daf196`、`create-readiness.md` `afc655633631`、`dynamic-forms.md` `59fa6c293a1f`、`managed-lookups.md` `97c4a6b7531f`、`lookup-and-picklist.md` `b7506e90f64a`、`outcomes.md` `8d4a7418d2a9`。

### Workspace 回归（与本 Skill 契约相关的包）

本轮**没有改动任何 TypeScript**：`git diff ef6b4e2 HEAD -- packages/` 为 0 行，`packages/sfoa-mcp-server/src/dml-managed-fields.ts` 与 `packages/sfoa-mcp-server/src/test/managed-dml-fields.test.ts` 均未变更。因此下列运行是「未回归」证据，不是本轮的变更面。

本环境嵌套 Yarn shell 失败（既有 Windows Yarn 执行债，`docs/sfoa/PROJECT_BASELINE.md` 已记录），`yarn workspace <pkg> test` 报 `MODULE_NOT_FOUND`。改用 `node ./node_modules/typescript/bin/tsc -p tsconfig.json` 直接编译后运行 `node --test dist/test/*.test.js`：

| 包 | build | tests | pass | fail | 结论 |
| --- | --- | --- | --- | --- | --- |
| `@sfoa/mcp-provider-sfoa-context` | exit 0 | 83 | 83 | 0 | PASS（Action Context / Dynamic Forms / 可见性契约） |
| `@sfoa/mcp-provider-sfoa-dml` | exit 0 | 46 | 46 | 0 | PASS（DML schema / batch / allowlist 契约） |
| `@sfoa/agent-playbook` | exit 0 | 34 | 34 | 0 | PASS（Playbook 1.8.0 定义与渲染契约） |
| `@sfoa/mcp-server` | exit 0 | 159 | 113 | 0 | 0 FAIL；46 cancelled |

`@sfoa/mcp-server` 的 46 个 cancelled 全部集中在 `dist/test/managed-dml-fields.test.js`（该文件 47 个子测试，0 pass）。失败类型为 `cancelledByParent`，错误为 `Promise resolution is still pending but the event loop has already resolved`，栈指向 `packages/*/node_modules/signal-exit` 的多份副本在进程退出时互相干扰。逐文件运行确认其余 17 个测试文件全部 0 fail。

这是**预先存在的环境问题**（多份 `signal-exit` + Windows 进程退出时序），与 Skill-02A 无关：该测试文件由其未变更的 TypeScript 源编译而来，本分支对该文件与 `dml-managed-fields.ts` 的 diff 为 0 行。**未修改、未修复。** 影响是：`managed-dml-fields` 的运行时证据在本环境缺失，Skill 中关于 managed 字段与 Owner fallback 的描述依据的是源码审查（B 节）而非该测试文件的执行结果。

未执行：根级 `yarn lint` / `yarn build` / `yarn test`（嵌套 Yarn 失败）、`@sfoa/admin-web` 与 `@sfoa/admin-api` 套件、`@sfoa/control-plane` 的 MySQL 集成测试、`scripts/p8-04-regression.mjs` 与 `scripts/p8-07-live-batch.mjs`（需要 `.env.local`、MySQL 与真实 Salesforce 对象）。这些都不是本轮变更面。

## H. Runtime 修改

**Runtime unchanged.**

没有修改 `packages/**` 下任何文件，没有修改 migration、Identity Route、WeCom identity chain、P8-04/P8-05/P8-06/P8-07、Generic DML Runtime、Tool Governance、`create_record` / `create_records` schema、官方 Provider 代码或 Salesforce 数据。

本轮没有发现必须修 Runtime 才能让 Skill 正确的缺陷。以下两项是**观察到的风险**，未修改，按“先记录证据”处理：

### Runtime Defect（记录，未修复）

| 项 | 证据 | 为什么 Skill 无法解决 | 最小修复方向 | 回归风险 |
| --- | --- | --- | --- | --- |
| Action Context 的持久化 Tool text 仍约 30k 字符并含省略/截断标记，完整 MCP response（P7 未截断）与 Agent 可见文本之间存在信息损失 | `docs/sfoa/SFOA_SKILL_UAT_20260913.md`「传输与模型理解是两个独立问题」；0914 复测 `871e9fb0` 完整 payload 6715 未截断但文本仍约 30k | Skill 无法控制 Tool result 的序列化与传输；当前 Context Schema 也没有字段分页参数，不能在 Skill 中发明参数 | 在 MCP 层缩小 `structuredContent` + text 双份表示，或提供有界分页/字段选择 | 中：改变 Tool result 形状会影响现有 Agent 与 Admin 预览 |

本轮 Skill 对这一点采取的是**诚实约束**（Hard Rule 17 + `dynamic-forms.md` 的 Evidence Completeness Gate），而不是继续堆 Prompt。

## I. 已知限制

1. **DeepSeek 可能因 Tool result 过长丢失关键信息。** Action Context 的文本表示约 30k 字符且带截断标记。Skill 能强制「截断时不得宣称验证完成」，但**无法保证模型在长文本中不遗漏某个字段**。彻底解决需要 Runtime 侧的响应整形，不是 Skill 文本能覆盖的。
2. **Contract Test 只证明规则文本存在，不证明模型遵循。** 门禁是编辑守卫（防止规则被删除或掏空），不是行为验收。9 个新测试全部是内容契约。
3. **真人 UAT 未执行。** 需要真人经企业微信发起 CREATE，验证模型是否真的不再把「已调用 Action Context」当成「记录已准备完整」。
4. **Runtime Copy 部署。** 本轮只交付 canonical 与开发客户端副本；Runtime Copy 与 allowlist 在 HOTFIX01 完成，见下文。
5. **UPDATE 未覆盖。** 02A 只建立 CREATE doctrine。UPDATE readiness、UPDATE Record Type mutation、完整 Batch grouping、>200 策略、allOrNone doctrine、完整 PARTIAL_SUCCESS recovery 与 OUTCOME_UNKNOWN reconciliation 全部留给 02B。本 Skill 在 `managed-lookups.md` 与 `outcomes.md` 中明确写出这些边界，避免被误认为已覆盖。
6. **Picklist 截断与 UNKNOWN 容器语义无法由 Skill 消除。** `CONTAINER_RECORD_UNSUPPORTED` 类 UNKNOWN 在补齐前置字段后仍然存在；Skill 只能正确阻塞或如实说明，不能自行改成 VISIBLE/HIDDEN。
7. **`clean-checkout-smoke.mjs` 在本 Windows 主机上无法完成。** 临时目录 `rm` 报 `EBUSY`（疑似文件句柄释放延迟），报告被 cleanup 异常吞掉。本轮用等价手工流程取得证据；脚本本身的健壮性仍是一个未修项。
8. **仓库 Skill 侧可见性已回归。** 机器门禁证明业务 Skill 不携带也不命名 maintainer；服务器侧 allowlist 在 HOTFIX01 核对，见下文。
9. **`managed-dml-fields.test.js` 在本环境被整体取消（47 子测试 0 pass）。** 原因是多份 `signal-exit` 与 Windows 进程退出时序冲突，属预先存在的环境问题。因此本报告对 managed 字段 / Owner fallback 的描述只有源码审查证据，没有该测试文件的执行证据。修复该环境问题后可补跑以获得运行时证据。

## J. Skill-02A 最终状态

**READY FOR HUMAN UAT**

机器门禁全部 PASS、干净检出等价 Smoke PASS、无 Runtime 改动、Core 无回归。但这只表示可以进入真人企业微信 UAT，**不表示 COMPLETE**。

真人 UAT 必须验证的最小集合：

1. 用户自然语言「帮我创建一个客户拜访申请……」时，Agent 是否读取 `sfoa-record-change`。
2. VISIBLE + `effectiveRequired` 且无值的字段是否被提问（对应历史遗漏的「计划交谈事项」类字段）。
3. `PENDING` + `dependsOn` 是否先补前置再 refinement，而不是直接把依赖字段当全局必填。
4. 多 Record Type 时是否询问，而不是静默使用默认类型。
5. `PLATFORM_IDENTITY_FALLBACK` 字段是否按 explicit > fallback 处理，并说明「不指定就按当前用户」。
6. 是否在 `CHANGE_READY=false` 时确实没有调用 `create_record` / `create_records`。
7. 截断发生时是否如实说明未完成验证，而不是宣称「表单要求核对好了」。

---

# Skill-02A HOTFIX01 — Delivery + Machine Gate + Runtime Deployment Closure

Report ID: SFOA-OPENCLAW-SKILL-02A-HF01 · 2026-09-14

本轮不重新开发 Skill-02A、不进入 02B，只把已经正确的 Skill-02A 从「GitHub canonical implementation」收口为「canonical source + Machine Gate + OpenClaw Runtime Copy + Business Agent Visibility」。

## 基线

| 项目 | 值 |
| --- | --- |
| Base Branch | `feature/openclaw-sfoa-record-change-02a` |
| Base Commit SHA | `ef809145f1ae6335afa0127958935952512f0b27`（已存在于 `origin`） |
| HOTFIX Branch | `hotfix/openclaw-sfoa-record-change-02a-delivery` |
| 当时 `origin/main` | `25a15ce4fbf642fd995a7e61ab3fc92be1616a97` |
| `origin/hotfix/openclaw-sfoa-crm-core-data-completeness` | `ef6b4e25c9360727ed7e1d3737ab774f9cc08ab7` |

`git fetch --all --prune` 后确认 Base 分支的真实 HEAD 与本地一致，Skill-02A 的四个提交（`0a006a3`、`25d67b9`、`fd880c6`、`ef80914`）已在远端。HOTFIX 沿用仓库既有的 `hotfix/<topic>` 命名惯例。

## 本轮 diff 审查

`git diff ef6b4e2...HEAD --name-only` 只包含：

```text
skills/                     canonical Skill
.agents/skills/             .claude/skills/             .codebuddy/skills/     开发客户端生成副本
docs/sfoa/                  项目文档
```

**没有任何 Runtime 改动**：MCP Runtime、Identity Route、WeCom 链路、P8-04/05/06/07、Generic DML、Admin、Tool Governance、`create_record` / `create_records` schema 全部未触碰。因此本轮无需回退，也不存在「为匹配 Skill 而改 Runtime」的情况。

## 1. Description 收口

`SKILL.md` frontmatter `description` 由 **248 字符**收到 **153 字符**，保持单行：

```text
Salesforce CREATE 记录变更就绪与安全执行。新增、创建记录或发起申请时使用：Record Type、Dynamic Forms refinement、必填字段、Lookup/Picklist、Owner fallback、批量 CREATE；配合 sfoa-crm-core，不用于纯查询。
```

保留全部路由信号：`Salesforce`、`CREATE`、`Record Type`、`Dynamic Forms`、必填、`Lookup`、`Picklist`、`Owner`、`fallback`、`sfoa-crm-core`、新增 / 发起申请、`不用于纯查询`。机器门禁强制 `<= 160` 且逐项校验信号，删除任一信号即失败。

（参考：`sfoa-crm-core` 的 description 为 174 字符，本轮未改动 Core。）

## 2. 02A / 02B 范围收口

保留 02A 必须的安全底线：

```text
create_records 1..200、同对象
每条记录独立 CHANGE_READY
PARTIAL_SUCCESS 不整批重试，只重新准备真实失败项
OUTCOME_UNKNOWN 不自动重放
不静默只处理一部分并声称完成、不无限循环
```

收缩掉超出 02A 的细节：

| 位置 | 原内容 | 现在 |
| --- | --- | --- |
| `outcomes.md` | 「批次边界与安全」含 `500 → 200 + 200 + 100` 有限计划与 total/processed/succeeded/failed/unknown 全程跟踪 | 改为「如实说明当前无法在一次请求内完成 / 不静默只处理一部分 / 不无限循环」，并明确 >200 完整分批编排属后续阶段 |
| `create-readiness.md` | 只讲 Tool 选择 | 增加范围边界句：本节只负责选 Tool，>200 计划与 `allOrNone` 策略不自行设计 |
| `SKILL.md` | 无显式边界 | 增加 CREATE-only 边界段：UPDATE 就绪 / UPDATE 批量 / >200 编排 / `allOrNone` 策略 / 完整 Outcome recovery 不在范围内，且 **MUST NOT** 为 UPDATE 套 CREATE 整张表单 |

同时移除 Skill 中唯一的公司字段名 `Source__c`（抽象 UAT 案例改为「`dependsOn` 返回的『来源』类字段」），使 doctrine 不再携带任何公司字段规则。

## 3. Machine Gate

复用 Skill-01 的既有架构（`manage.mjs` + `toolkit.test.mjs`），未另造测试体系。测试由 28 增至 **32**。

新增 4 个门禁：

| 门禁 | 覆盖 |
| --- | --- |
| description 长度与信号 | 单行、`<= 160`、11 个路由信号、排除纯查询 |
| retired Tool 与公司标识 | `sf_prepare_record_change` / `sf_commit_record_change` 只允许出现在明确禁止语境；逐行拒绝 `__c` 形式的公司对象 / 字段 API 名 |
| allowlist 一致性 | 每个非 maintainer canonical Skill 必须显式出现在 `BUSINESS_SKILL_ALLOWLIST`，否则失败 |
| Runtime Copy 隔离 | 只发布白名单；拒绝符号链接、`.git`、凭据、可执行脚本；注入漂移必须被检出；`assertBusinessSkillAllowed('sfoa-mcp-maintainer')` 必须抛错 |

并补充了 3 个既有门禁的缺失标记：非 critical UNKNOWN 不机械阻塞、CREATE-only 边界、>200 编排归属后续阶段。

§6 列出的行为合同逐项对应：

| 行为合同 | 门禁 |
| --- | --- |
| CHANGE_READY=false → 禁止 CREATE | SKILL.md Hard Rule 1 标签 + 正文 |
| Context fetched != Ready | Hard Rule 2 |
| 多 Record Type 未解决 → block | Hard Rule 3 + `create-readiness.md` |
| default Record Type != 静默业务选择 | Hard Rule 3 + 「默认值不是用户业务意图的替代品」 |
| VISIBLE + effectiveRequired + missing → checklist | Hard Rule 4 |
| PENDING + dependency known → refinement | Hard Rule 5 |
| PENDING + dependency unknown → clarification | Hard Rule 5 |
| critical UNKNOWN → block | Hard Rule 7 |
| non-critical UNKNOWN → 不机械 block | `readiness-gate.md` 明确不算 blocking condition |
| refinement 上限 + critical unresolved → block | Hard Rule 9 |
| explicit user fact → 不重复询问 | Hard Rule 10 |
| trusted default → 不重复询问 | Hard Rule 11 |
| strict managed → 不问不写 | Hard Rule 12 |
| `PLATFORM_IDENTITY_FALLBACK` explicit > fallback | Hard Rule 13 |
| explicit lookup 失败 → 不 fallback | Hard Rule 14 |
| Lookup 0 / 1 / multiple | Hard Rule 15 + `lookup-and-picklist.md` |
| Picklist Label → 运行时 API Value | Hard Rule 16 |
| dependent Picklist 先 controller | Hard Rule 16 + reference |
| critical evidence truncated → 不 READY | Hard Rule 17 |
| PARTIAL_SUCCESS → 不整批重放 | Hard Rule 20 |
| OUTCOME_UNKNOWN → 不重放 CREATE | Hard Rule 19 |
| 无硬编码 Record Type ID / 字段规则 / Lookup ID / Picklist API Value | 无硬编码守卫 + 公司标识守卫 |
| 无 retired Tool | retired Tool 守卫 |

## 4. 可执行命令

沿用仓库 `skill:*` 命名惯例，只在 root `package.json` 增加两条与部署直接相关的脚本：

```text
yarn skill:validate                              # 全部 canonical Skill 结构与链接
yarn skill:test                                  # Skill-01 regression + Skill-02A contracts（32 tests）
yarn skill:sync && yarn skill:check              # 开发客户端副本 + 漂移检查
yarn skill:delivery                              # Git trackability / ignore / package 完整性
yarn skill:runtime:sync  --runtime-root <workspace>/skills
yarn skill:runtime:check --runtime-root <workspace>/skills
```

## 5. Runtime Copy 同步能力

`manage.mjs` 新增 `runtime-sync` / `runtime-check`，与既有 `sync` / `check` 并列：

- 唯一授权来源是 `BUSINESS_SKILL_ALLOWLIST = ['sfoa-crm-core', 'sfoa-record-change']`；`runtime-*` 动作只迭代该白名单，`sfoa-mcp-maintainer` 永远不进入。
- 方向固定 canonical → runtime，运行时不反向维护。
- 复制前拒绝符号链接、`.git` / `.ssh` / `secrets` / `node_modules` 段，以及 `.env`、`id_rsa`、`openclaw.json` 等凭据名与 `.mjs`/`.js`/`.sh`/`.ps1`/`.pem`/`.key` 等可执行或密钥扩展名。
- `runtime-sync` 输出逐文件 SHA-256，便于服务器侧比对；`runtime-check` 比对递归 SHA-256 映射，缺失 / 多余 / 内容不同都失败并置 exit code 1。
- 必须显式传 `--runtime-root`，避免猜测或误写本地路径。

验证（本地暂存目录）：sync 产出恰好两个白名单 Skill、`runtime-check` drift 为空；对 maintainer 调用被拒（`No canonical Skill matches the business runtime allowlist`）；注入漂移后 `SKILL.md: differs` 被检出。

## 6. OpenClaw Runtime 部署（已执行）

目标：`root@192.168.156.203`（`crm-ex-test02`），OpenClaw **2026.9.3 (1391f7c)**。

| 步骤 | 结果 |
| --- | --- |
| 备份 | `/data/openclaw/backups/20260914-155313-skill-02a-delivery/`，root-only，含 `openclaw.json` 与当时 `skills/` |
| 部署前 skills | 仅 `sfoa-crm-core`（9 文件） |
| 部署 | canonical → `/data/openclaw/workspace/skills/sfoa-record-change/`，7 文件，`root:root`，目录 755 / 文件 644 |
| 字节校验 | 7 个文件服务器侧 SHA-256 与 canonical 逐一相同 |
| 策略变更 | `skills.entries` 增加 `sfoa-record-change.enabled=true`；`agents.entries.main.skills` 由 `["sfoa-crm-core","browser-automation"]` 变为 `["sfoa-crm-core","browser-automation","sfoa-record-change"]`（既有合法项全部保留） |
| `openclaw config validate` | `Config valid: /data/openclaw/state/openclaw.json` |
| 重启 | `skills.load.watch` 未设置（无 watcher），故 `systemctl restart openclaw-gateway`；16:08:25 active |
| 渠道 | 16:08:32 `[wecom] Authentication successful` |

服务器侧 SHA-256：

```text
c7354635ca39…  SKILL.md
3fc5c3daf196…  references/readiness-gate.md
685ecc437bfb…  references/create-readiness.md
59fa6c293a1f…  references/dynamic-forms.md
97c4a6b7531f…  references/managed-lookups.md
b7506e90f64a…  references/lookup-and-picklist.md
06ca86c414f6…  references/outcomes.md
```

服务器侧 `sha256sum` 的 64 位完整值与 canonical 逐一相同；上表为便于阅读的 12 位前缀。

## 7. Business Agent 可见性

`openclaw skills check --agent main`：

```text
Total: 71
Eligible: 34
Visible to model: 3
Blocked by allowlist: 0
Excluded by agent allowlist: 68

Ready and visible to model:
  browser-automation
  sfoa-crm-core
  sfoa-record-change
```

`openclaw skills list --agent main --json` 的 `modelVisible` 与上表一致，`sfoa-record-change` 为 `eligible=true`、`modelVisible=true`、`blockedByAllowlist=false`、`source=openclaw-workspace`。

## 8. Maintainer 隔离

| 检查 | 结果 |
| --- | --- |
| `modelVisible` 含 maintainer | 无 |
| `eligible` 含 maintainer | 无 |
| `skills/` 中是否部署 | 只有 `sfoa-crm-core` 与 `sfoa-record-change` |
| 机器门禁 | 业务 Skill 无 `scripts/`、无 `agents/openai.yaml`、不命名 maintainer；`runtime-sync` 拒绝 maintainer |

## 9. 未执行项

**Routing Smoke（§13）未执行。** 本轮已完成 description 注册、eligible 与 `modelVisible` 核对，但没有产生一次真实的 routing 决策。原因：随后一次服务器只读检查命令被沙箱权限拒绝（涉及本机 SSH 私钥路径），按拒绝提示停止后续服务器操作，未重试。

因此「自然语言『帮我创建一个 Salesforce 客户拜访申请』同时命中 `sfoa-crm-core` + `sfoa-record-change`」以及「纯查询不强制加载 mutation doctrine」**尚未取得运行证据**。这两项应由真人企微 UAT 一并覆盖；不要把它写成 PASS。

## 10. HOTFIX01 最终状态

**READY FOR HUMAN UAT**

§20 的判定条件逐项成立：Skill doctrine 正确、02A 范围收口、description 收口、Machine Gate PASS（32/32）、Skill-01 regression PASS、canonical source PASS、Runtime Copy PASS（已部署并逐字节校验）、`openclaw skills check` PASS、业务 Agent 可见 `sfoa-crm-core` + `sfoa-record-change`、业务 Agent 不可见 `sfoa-mcp-maintainer`、Runtime 未改动。

保留的未完成项（不改变上述判定）：Routing Smoke 未执行（§9）；真人企微 UAT 未执行；Skill-02B 未开始。

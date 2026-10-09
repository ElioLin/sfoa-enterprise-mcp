# P10 诊断深化 — Claude Code 执行计划与任务 Prompt

文档日期：2026-09-30
依据：`docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md` 第 5 节「阶段 P10」（P10-0 至 P10-7）
前置：P9 已合并 `main`（`0be4fef`）。本阶段基于 `main` 开新分支。
执行方：Claude Code（本仓库工作区内执行）
本文档用法：按 T1 → T6 顺序，每次把一个任务的 Prompt 整段交给 Claude Code 执行；前一任务验收通过后再开始下一任务。

---

## 0. 拆分决策与全局约定

### 0.1 工具合并评估结论：**不合并，保留原方案 6 工具 + 1 skill + 前置 ADR**

按 `docs/sfoa/MCP_ENGINEERING_RULES.md` 的 atomic 原则逐对评估过所有合并候选：

| 候选合并 | 结论 | 理由 |
| --- | --- | --- |
| `set_trace_flag` 并入日志读取工具 | **必须独立** | 它是 P10 唯一的"写"操作（创建/更新 TraceFlag、可能创建 DebugLevel），`readOnlyHint=false`，与全部读工具注解不同；审计 purpose 也必须单独成类 |
| `get_apex_logs` + `get_debug_log_body` | **不合并** | 输出契约完全不同（结构化索引列表 vs 有界大文本正文，各自独立预算与截断语义）；错误路径不同（列表分页 vs 正文超预算/日志已被 Salesforce 清理）；P9 的 submit/fetch 双工具模式已验证 agent 完全能理解"列表→取详情"两步链 |
| `list_metadata_components` 并入 `get_metadata_component_context` | **不合并** | 两者是"列清单 vs 读内容"互补关系，与 P9 已验证的 `list_sobjects`/`describe_sobject` 同构 |
| `get_platform_diagnostics` 并入 Tooling 通用查询或其它工具 | **不合并** | 其价值恰在"一次调用 + 多源聚合 + 有界时间线 + 确定性"；靠 agent 手拼多条 Tooling SOQL 无法保证有界与结构化 |
| 全部 P10 工具合并为单一"诊断工具"（Headless 360 式 Discover/Dispatch） | **不合并** | 违背本项目"确定性工具 + default-deny 治理"的架构基石；agent 上下文压力已由 default-deny（按需启用）+ advertisedToolNames 动态 hint 解决，无需牺牲契约清晰度 |

保留 Claude Code 的设计自主权：见 0.4。

### 0.2 本阶段交付物一览

| 任务 | 内容 | 角色/治理 |
| --- | --- | --- |
| T1 | 分支 + 诊断能力 live probe + ADR（P10-0 权限前提） | — |
| T2 | `set_trace_flag` + `get_apex_logs` + `get_debug_log_body`（P10-1/2） | DIAGNOSTIC；set_trace_flag 为受控写 |
| T3 | `explain_field_access`（P10-3） | DIAGNOSTIC |
| T4 | `list_metadata_components`（P10-4）+ `get_metadata_component_context` 类型扩展（P10-5） | DIAGNOSTIC |
| T5 | `get_platform_diagnostics`（P10-6） | DIAGNOSTIC |
| T6 | `sfoa-org-diagnostics` skill（P10-7）+ Playbook 1.11.0 + 小犇指令 + 文档收口 + 整体验收 | — |

全部工具归宿 `@sfoa/mcp-provider-sfoa-context`（P9 已确立诊断工具在此包：`get_org_limits` 是现成接入范本），无需新建包。

### 0.3 全局约定（每个任务都必须遵守，Prompt 中不再重复展开）

- 分支：`feature/p10-diagnostic-depth`，基于 `main`（`0be4fef`）。六任务线性推进，禁止并行分支。
- 全部新工具：DIAGNOSTIC 角色（`SFOA_CONTEXT_TOOL_ROLES` 登记）、**默认禁用**（不进任何默认启用集，由 Admin 经控制面 enabledTools 显式启用）、经 P7 审计管道。
- **角色数据边界（2026-09-30 确立的硬红线，适用于全部 P10 工具）**：
  1. DIAGNOSTIC 工具只允许接触**系统层/Setup 层数据**：执行日志（ApexLog）、平台状态（AsyncApexJob/CronTrigger/SetupAuditTrail）、权限配置事实（FieldPermissions/ObjectPermissions/PermissionSet/Profile/RecordType）、元数据组件、TraceFlag/DebugLevel。**业务记录数据（Lead/Account/Opportunity 等对象行）结构性不可达**：任何 P10 工具的查询目标对象必须在上述白名单内，白名单硬编码于实现并经单测断言。
  2. 诊断账号持有 View All Data 等高权限（ApexLog 可见性的前提），因此**诊断工具绝不能成为绕过业务用户 FLS/sharing 读业务数据的后门**——这是本红线的深层原因。USER 角色工具（query_records 等）永远走业务用户自身身份，两类工具之间不存在数据面互通。
  3. `explain_field_access` 的边界定义：它以业务用户为**视角**聚合权限事实，但读取的数据全部是权限配置（Setup 层），不触碰任何业务记录；输出只含授权来源链等权限事实，不含业务字段值。
  4. 单测必须为每个 P10 工具断言其数据面（mock 层校验查询对象白名单，越界即拒绝）。
  5. **启用面治理（2026-09-30 追加）**：诊断工具技术上可被 Admin 启用在任何路由（default-deny 模型的统一行为），但实际执行身份**永远是诊断账号**（facade 层由 `route.connectionRole` 强制，不因调用路由而变）。治理要求：(a) 默认建议 Admin 仅在诊断/管理路由启用诊断工具；(b) 若一个工具被启用在业务用户路由上，Admin 控制台必须显示数据面声明（"该工具将使用系统诊断身份读取系统层数据"）并由 Admin 显式确认——这是 T1 的 ADR-0029 需要定夺的具体形态（硬性架构限制 vs 控制台声明确认，二选一或叠加，给出推荐与理由）；(c) 审计必须同时记录调用者（platformUserId）与执行身份（DIAGNOSTIC），使"谁通过诊断工具做了什么"始终可追溯。
  6. **反向边界**：USER 角色工具不得因新增诊断能力而获得任何升降权路径；`run_diagnostic_tooling_query` 等既有诊断工具同样受本红线约束（其 Tooling API 结构性查不到业务记录行，该性质必须保持并写入 ADR 说明）。
- `set_trace_flag` 的写面硬边界：仅允许对 Tooling 对象 **TraceFlag 与 DebugLevel** 做创建/更新，TraceFlag 必须带 ≤60 分钟的 ExpirationDate；对任何业务对象的 DML 在代码层结构性不可达。治理分类需新增（现框架 READ/METADATA_READ/MUTATION/ADMIN 不适配），分类名与边界由 T2 的 ADR 定夺（建议 `DIAGNOSTIC_WRITE`，白名单硬编码两个对象）。
- Upstream-first：全部经官方 SDK（jsforce Tooling API / Metadata API），不修改任何官方文件。
- 契约标准对齐 P9 产出（可直接参照其实现）：strict Zod 输入、annotations、`outputSchema` + `structuredContent`、双响应预算（byte/character）、`truncated` + 可执行 hint、结构化错误（errorCode + suggestion）、**hint 只能点名本会话 `tools/list` 实际广告的工具**（参照 sfoa-data 的 advertisedToolNames 模式）。
- 每任务测试层：单元（Zod/截断/错误映射/权限拒绝）+ 协议（未启用不可见、启用可调用）+ live SFoA + 审计验证（`yarn ai:audit`）+ 回归。提交规范 `type(scope): description` 小写。
- 任何与原设计的偏离：必须 ① 有实测依据 ② 写 ADR（编号顺延，当前至 ADR-0032）③ 在本文档对应任务节前加"修订注记"（**保留原 Prompt 原文不改**）④ CHANGELOG 记录。这是 P9 验证过的有效模式。
- **测试环境**：本仓库单测必须用系统 Node 24（`D:/software/node.exe` 或 yarn 默认链路）；受管 Node 22 的 node:test 与 timeout 类测试不兼容（P9 验收期间实测：同一文件 Node 22 下 47/47 挂起、Node 24 下 47/47 PASS）。

### 0.4 Claude Code 自主权（用户明确授权）

每个任务的 Prompt 末尾有「改进空间」一节，列出该任务内允许自主发挥的方向。原则：**确定性的部分（治理边界、身份、审计、默认禁用）不容偏离；概率性的方法与实现细节（内部结构、hint 措辞、探测脚本形态、更优的工具内部设计）鼓励自主优化**。任何改进若改变了对外契约或治理语义，走 0.3 的偏离流程。

### 0.5 P10 整体验收清单（T6 收口核对）

- [ ] `yarn build` / `yarn test` 全绿（Node 24）；`yarn workspace @sfoa/mcp-server test`、`test:p3/p4/p5`、`validate:p4`、`validate:upstream`、`yarn agent:check`、`yarn skill:check` 全过；已知 pre-existing 失败（`test:p7` HTTP gate、`validate:p2/p3` 缺 `SECOND_TEST_USER`、上游 code-analyzer lint）沿用 P9 验收报告 §5 的 main 分支对照口径，不得新增失败
- [ ] `validate:p10` 固化为 package.json 脚本（复用 p9-live-validation 架构，含 P9 修复的审计 flush 屏障：先 server.close 断言 `drained` 再 flush）
- [ ] 里程碑场景 (a) Apex 运行时异常闭环：开 trace → 复现 → 拉 log → 定位类/行号，全程 agent 无人工辅助
- [ ] 里程碑场景 (b) 字段不可见归因：`explain_field_access` 输出授权来源链且与人工核对一致
- [ ] 里程碑场景 (c) 变更溯源：「昨天起流程行为异常」→ `get_platform_diagnostics` 时间线对齐出 SetupAuditTrail 变更条目
- [ ] 审计：`yarn ai:audit --user <id> --latest 20 --since 24h` 覆盖全部新工具，凭据模式扫描为零命中
- [ ] **角色边界验证（0.3 红线）**：每个 P10 工具的数据面白名单单测通过（越界查询被拒绝）；实证诊断工具无法读取任何业务记录（如故意构造对 Lead/Account 的查询并确认结构性拒绝）；审计中调用者与执行身份（DIAGNOSTIC）同现；启用面治理形态已按 ADR-0029 落地并可演示
- [ ] Playbook 1.11.0 + `yarn agent:check` PASS；skill 四处同步（`skills/`、`.agents/`、`.claude/`、`.codebuddy/`）；CHANGELOG 更新；《P10 验收报告》落盘 `docs/sfoa/P10_ACCEPTANCE_REPORT.md`

---
---

## 任务 T1 — 分支 + 诊断能力 live probe + 权限前提 ADR（P10-0）

```
你是本仓库（D:\GitProject\sfoa-enterprise-mcp）的维护工程师，执行 P10 诊断深化阶段的前置任务。
本任务目标：建立任务分支，对 DIAGNOSTIC 固定账号在本部署 org 的真实能力面做一次系统性 live probe，把结果固化为 ADR（诊断账号权限前提与生产启用清单）。P9 的教训是：设计假设必须先经实测（当时 limits 端点对所有业务身份返回 API_DISABLED_FOR_ORG，迫使 get_org_limits 改道 DIAGNOSTIC——见 ADR-0027 与 docs/sfoa/P9_T3_LIVE_PROBE_FINDINGS.md）。P10 的六个工具对 DIAGNOSTIC 账号权限依赖更重，必须先探明。

## 必读（全部读完后才开始动手）
1. AGENTS.md、.agents/skills/sfoa-mcp-maintainer/SKILL.md（及其 references/database-audit.md、references/operations.md）
2. docs/sfoa/PROJECT_BASELINE.md、docs/sfoa/ARCHITECTURE.md、docs/sfoa/MCP_ENGINEERING_RULES.md
3. docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md 第 4.2 节（GAP-M1~M8）与第 5 节 P10 表
4. docs/sfoa/adr/ADR-0027-p9-org-limits-diagnostic-identity.md 与 docs/sfoa/P9_T3_LIVE_PROBE_FINDINGS.md（probe 方法与文档范本）
5. packages/sfoa-mcp-server/src/org-limits-context-executor.ts（DIAGNOSTIC 连接的 host 侧接入范本）
6. docs/sfoa/P9_ACCEPTANCE_REPORT.md（验收证据格式基准）

## 分支操作
1. git checkout main && git pull origin main（应在 0be4fef 或更新）
2. git checkout -b feature/p10-diagnostic-depth
3. yarn ai:snapshot 与 yarn ai:doctor 确认基线健康。

## Probe 内容（只读探测，不改动 org 配置；写不下任何 org 数据）
用一个独立脚本（建议 scripts/ 或包内 validation 目录，形态自定，参照 P9 probe 的产出文档格式）对 DIAGNOSTIC 身份逐项实测并记录：可用/拒绝（附 Salesforce 错误码）/该 API 版本行为：
1. ApexLog 查询：SELECT Id, ... FROM ApexLog（ApexLog 仅 owner 与持 View All Data 者可见——实测确认当前权限）
2. TraceFlag 查询与创建/更新能力：先 SELECT FROM TraceFlag；再在一个 scratch/sandbox org（严禁生产）尝试创建一条带 60 分钟 ExpirationDate 的 TraceFlag（若当前环境只有生产，本项标记 NOT PROBED 并说明原因）
3. DebugLevel 查询与创建：SELECT FROM DebugLevel；评估是否需要专用 DebugLevel（记录已有 Developer Name 清单，不创建）
4. SetupAuditTrail 查询：SELECT FROM SetupAuditTrail（变更溯源数据源）
5. AsyncApexJob / CronTrigger 查询：异步失败与调度卡滞数据源
6. FieldPermissions / ObjectPermissions / PermissionSetAssignment / PermissionSet（含 Profile 关联）查询：FLS 归因数据源（重点：诊断身份能否读到「其他用户」的权限分配——这决定 explain_field_access 的 targetUserId 边界设计）
7. RecordType 查询（explain_field_access 需要记录类型可见性事实）
8. Metadata API listMetadata（or Tooling 等价查询）对一个白名单类型的可用性
9. 记录 probe 中每个环节的实际错误码与消息（脱敏后入档）

## 产出
1. docs/sfoa/P10_T0_LIVE_PROBE_FINDINGS.md：逐项实测结果（格式参照 P9_T3_LIVE_PROBE_FINDINGS.md：身份、API 版本、结果、错误码、结论；区分「测量到的事实」与「推断」——P9 曾因把推断写成事实而自我纠正，本次直接按事实/推断分栏）
2. docs/sfoa/adr/ADR-0029-p10-diagnostic-identity-prerequisites.md：
   - 依据 probe 结论定义 P10 各工具的最小权限前提清单（如：ApexLog 可见需要 View All Data；代设 TraceFlag 需要的权限集合）
   - 明确「代码内无解、需 org 管理员在部署时授权」的项，以及生产启用的前提条件与检查步骤
   - 定义缺权限时各工具的降级行为契约：结构化错误（errorCode 指明缺哪个前提 + 指向 ADR 的部署清单），绝不静默返回空结果——空结果会被 agent 误读为「没有异常」
   - **角色与数据边界声明（0.3 红线的正式落档）**：(a) 逐工具列出查询目标对象的白名单，并声明业务记录数据结构性不可达的技术依据（如 Tooling API 不承载业务记录行、白名单硬编码）；(b) 复核既有诊断工具（`run_diagnostic_tooling_query`、`get_org_limits`、`get_metadata_component_context`）满足同一红线的现状证据，发现缺口则提出修复；(c) **启用面治理形态定夺**：硬性架构限制（诊断工具仅在 DIAGNOSTIC 路由可启用，启动/配置层校验）vs 控制台数据面声明确认，给出推荐、理由与实现要点（推荐需说明它如何保持 Admin 对"业务系统管理员"类合法场景的支持）；(d) 审计双身份记录（调用者 + 执行身份）的契约确认
3. CHANGELOG 增加条目。

## 测试与验证
- 本任务无新工具，不新增单测要求；但 probe 脚本若入库需有最小单测（输出结构/脱敏）。
- 回归：yarn build && yarn test（Node 24）；确认无新增失败。

## 提交
- chore(scripts): add the P10 diagnostic capability probe
- docs(sfoa): record the P10 probe findings and ADR-0029 prerequisites

## 禁止事项
- 禁止在生产 org 创建/修改任何配置（TraceFlag 创建仅限 scratch/sandbox；不可得则标记 NOT PROBED）；禁止打印 .env.local 或凭据；probe 结果入档前必须脱敏（无 token、无完整授权记录）。

## 改进空间（可自主发挥）
- probe 的脚本形态（一次性脚本 vs 可复跑的 validation 工具）自定；若做成可复跑工具，建议纳入 validate:p10 的前置检查。
- 若 probe 发现与原设计冲突的事实（如诊断身份连 SetupAuditTrail 都不可读），直接在 ADR 中提出替代数据源或降级设计建议，并在本文档 T2–T5 对应节加修订注记。
```

---
---

> **修订注记（T1 实测后加，2026-09-30；原 Prompt 原文保留不改）**
>
> 依据 `docs/sfoa/P10_T0_LIVE_PROBE_FINDINGS.md` 与 `ADR-0029`，本任务有三处必须调整：
>
> 1. **`set_trace_flag` 必须是「创建或延长」，不能只创建。** 对同一实体创建时间窗重叠的 TraceFlag 会被拒绝：`FIELD_INTEGRITY_EXCEPTION`（"跟踪标记正在跟踪此实体，其中开始和过期日期会重叠"）。即"给自己开 1 小时 trace"这一最常用调用第二次就会失败。先查现有 flag 覆盖窗口，命中则更新而非新建。
> 2. **`DebugLevel` 用「解析或创建」。** 本 org 只有一条存量 `SFDC_DevConsole`，其 `ApexProfiling: INFO`（采样档）；P10 需要完整 profiling 时必须自建（实测允许创建）。
> 3. **`run_diagnostic_tooling_query` 的对象检查由本任务补上**（ADR-0029 §4b 规格）：该工具输入是自由 Tooling SOQL，安全性完全依赖 Tooling API 的结构性拒绝，未满足 0.3.1 的「白名单硬编码并经单测断言」。加一层 `FROM`/`USING` 目标提取的前置校验，并把平台拒绝保留为兜底。
>
> 另：**日志解析器必须按日志自身头部版本分发**（本 org API 为 v68.0，实测日志头部出现 54.0 与 56.0 两种）；**任何查询都不得按 `Status` 文本字面量过滤**（英文 `'Success'` 命中 1 条、本地化命中 8 条）。

> **修订注记（T2 实施后加，2026-09-30；原 Prompt 原文保留不改）**
>
> 依据 `ADR-0030`，本任务有四处偏离原 Prompt 的写法，均有实测或已记录的依据：
>
> 1. **治理分类不是 `MUTATION`，而是新增的 `DIAGNOSTIC_WRITE`**（0.3 节建议名的采纳）。`MUTATION` 在本目录里指官方 DML 工具写业务记录，`ADMIN` 指改「谁可以做什么」；`set_trace_flag` 两者都不是——它写的是 Setup 层诊断配置，恰好是 `TraceFlag` 与 `DebugLevel` 两个 Tooling 对象。新增值只由 `contextToolClassification` 对 SFoA 原生工具产出，`P2_ALLOWED_CLASSIFICATIONS` 不变，因此不会漏进官方工具的 Agent 安全闸门。改动面四个文件：分类元组、Admin DTO 联合、控制台标签表、分类器本身。
> 2. **`get_apex_logs` 的 `status` 不是枚举**（0.3/ADR-0029 的「不得按人类可读标签过滤」）。本 org `ApexLog.Status` 是本地化的，英文枚举会静默丢掉约 89% 的行。改为按 org 实际存储值做字面匹配，并在 `observedStatuses` 回报实际见到的取值。
> 3. **日志条目拆成三个身份字段**（`logUserId` / `logUserName` / `logUserUsername`），取代原 Prompt 的单个 `logUser`：`userId` 过滤要的是 Id，而 `logUser` 这种写法会诱导调用方把显示名当标识使用。
> 4. **默认档位不含 profiling。** 原 Prompt 把 `ApexProfiling` 列进默认档，实测取舍是把它拆成独立的 `PROFILING` 档：profiling 计数是日志体积的最大来源，把它放进默认档会让最常见的调用产出最容易溢出的日志——正是本工具组要避免的失败。
>
> **另附两处实测修正（不是偏离，是缺陷；记于 ADR-0030 §7，证据见 `P10_T2_LIVE_EVIDENCE.md`）**：
>
> 1. **SOQL 的 `dateTime` 过滤必须不带引号。** `get_apex_logs` 首次实跑以 `MCP_APEX_LOG_READ_FAILED` 失败，平台原话是 `INVALID_FIELD`——`LastModifiedDate` 是 dateTime，不接受被引号包成字符串字面量。T0 probe 的 `ApexLog` 查询没有 `WHERE` 子句，因此从没向本 org 发过 dateTime 字面量，测不到这一条。现由 `soqlDateTimeLiteral` 校验后不加引号发出；`LogUserId` 等 Id/字符串字段仍加引号。
> 2. **`TraceFlag` 的日期在请求侧也是秒精度。** 首次实跑把一次正确的写报成 `verified: false`：请求带毫秒、平台只存整秒，判等差了亚秒余数。现把时钟截断到整秒后再算窗口，判等保持精确（不用容差，容差会连「真的短了」一起放过）。单测夹具同步改为按 org 的真实精度与 `+0000` 记法存储——夹具此前比生产「更精确」，因而无法失败在生产会失败的判等上，这正是两个缺陷能走到实跑的原因。

## 任务 T2 — Debug Log 三件套：set_trace_flag + get_apex_logs + get_debug_log_body（P10-1/2）

```
你是本仓库（D:\GitProject\sfoa-enterprise-mcp）的维护工程师，执行 P10 的核心诊断链路任务。
前置：T1 已完成（ADR-0029 已定义权限前提与降级契约；分支 feature/p10-diagnostic-depth）。先 git log --oneline -3 确认，再开始。

本任务目标：实现 Apex/Flow 运行时异常诊断的完整闭环工具组——开限时 trace（set_trace_flag）、列日志（get_apex_logs）、取正文（get_debug_log_body），并让三个工具的 hint 互相衔接成「开 trace → 复现 → 列表 → 正文 → 定位类/行号」的确定路径。这是差距 GAP-M1 的交付。

## 必读
1. docs/sfoa/adr/ADR-0029（T1 产出：权限前提、降级行为契约）
2. docs/sfoa/MCP_ENGINEERING_RULES.md（Tool contract / Pagination / Error contract / Annotations）
3. 契约与预算范本（P9 产出，直接参照其代码风格）：
   - packages/mcp-provider-sfoa-data/src/schemas.ts、response-budget.ts、salesforce-errors.ts、tool-results.ts
   - packages/mcp-provider-sfoa-context/src/tools/get-org-limits.ts 与 packages/sfoa-mcp-server/src/org-limits-context-executor.ts（DIAGNOSTIC 工具的 provider + host executor 两层接入范本）
   - packages/sfoa-mcp-server/src/context-tool-facade.ts（context 工具的 facade 包装与审计）
   - packages/sfoa-mcp-server/src/provider-runtime.ts 与 discovery-server.ts 中 context 工具的组合点
4. docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md 第 5 节 P10-1/2 行

## 实现内容
1. set_trace_flag（受控写，治理分类按 0.3 全局约定由 ADR 定名）：
   - 输入（strict zod）：tracedEntityKind: 'USER' | 'APEX_CLASS'（枚举）；tracedEntityId（15/18 位 Salesforce ID）；durationMinutes（默认 30，硬上限 60）；logLevel（枚举，映射到预置 DebugLevel 的 Developer Name，白名单硬编码；DEFAULT 为 DEBUG 级、含 ApexCode/ApexProfiling/Callout/Database/System/Validation 的合理组合，由实现定档并写入 ADR）。
   - 行为：经请求级 DIAGNOSTIC Connection 用 Tooling API 查找/复用既有同档 DebugLevel（找不到时才创建，Developer Name 带固定前缀防冲突），随后为 tracedEntity 创建或更新 TraceFlag（ExpirationDate = now + durationMinutes）。若该实体已有活跃 TraceFlag，覆盖更新而非叠加，并在输出里声明 replacedExisting。
   - 输出：structuredContent { traceFlagId, debugLevelDeveloperName, expirationDate, replacedExisting, hint }；hint 指引下一步（复现问题后调 get_apex_logs）。
   - 输出不得包含任何 DebugLevel/TraceFlag 之外的写操作痕迹；对业务对象无任何 DML 路径。
2. get_apex_logs（READ）：
   - 输入：可选 timeWindowMinutes（默认 60，硬上限 1440）、可选 userId（15/18 位，过滤 WhoId/LogUser）、可选 status（枚举子集，如 SUCCESS/ERROR 等 ApexLog 状态值）、可选 limit（默认 20，硬上限 100）。
   - 实现：Tooling API SELECT ApexLog，按 LastModifiedDate 倒序，有界截断。
   - 输出：structuredContent { logs: [{ id, logUser, application, status, operation, durationMilliseconds, logLength, lastModifiedDate }], totalCount, returnedCount, truncated, hint }；hint 指引用 get_debug_log_body 取正文。
3. get_debug_log_body（READ）：
   - 输入：logId（15/18 位）；可选 maxCharacters（默认 60000，硬上限遵守响应预算）。
   - 实现：取 ApexLog 正文（Tooling API Blob retrieve 或官方 SDK 等价路径，实现时确认 jsforce 的正确用法并实测），服务端解析日志头部生成结构化摘要：{ exceptionType, exceptionMessage, apexClass, lineNumber, stackSummary（有界） }——摘要解析尽力而为，解析不出时原样说明，不编造。
   - 输出：structuredContent { logId, headerSummary, body（有界截断）, totalBytes, returnedBytes, truncated, hint }；正文超预算时截断并给「收窄 logLevel 重开 trace」的建议。
   - 日志已被 Salesforce 清理/不存在时：结构化错误说明（ApexLog 有保留期，过期即删——这是平台行为不是缺陷），建议重开 trace 复现。
4. 三个工具按 SFOA_CONTEXT_TOOL_ROLES 登记 'DIAGNOSTIC'；provider 与 host 两层接入照 get_org_limits 范本；审计 purpose 扩展 identity-runtime 的 SalesforceApiPurpose 联合（参照 P9 增 ORG_LIMITS/SOSL_SEARCH/BULK_QUERY 的先例与注释风格，建议 TRACE_FLAG / DEBUG_LOG 两类，写操作 purpose 独立）。
5. 降级行为：按 ADR-0029 契约实现缺权限时的结构化错误（errorCode 说明缺哪个部署前提），绝不静默空结果。
6. Admin 控制台编目：参照 P9 在 packages/sfoa-admin-api/src/tool-catalog.ts 的做法登记三个工具（分类与 enableAllowed 按 ADR 结论）。

## 测试与验证
1. 单元测试：Zod 校验（durationMinutes 超限、非法 ID、logLevel 白名单外）；TraceFlag 复用/覆盖逻辑；列表截断；正文预算截断与头部摘要解析（mock 日志文本，含典型 EXCEPTION 堆栈样例）；缺权限降级错误；hint 不点名未广告工具（参照 P9 的 data-tool-runtime.test.ts 风格，packages/sfoa-mcp-server/src/test/ 已有 helper）。
2. 协议测试：未启用不可见；启用后 tools/list 与 tools/call 正常；duplicate 注册拒绝。
3. Live SFoA（sand教/scratch org 优先，遵循 ADR-0029 的生产禁令）：里程碑场景 (a) 完整闭环——set_trace_flag(某测试用户或类) → 触发一次带异常的 Apex（测试预置类）→ get_apex_logs 看到 ERROR 行 → get_debug_log_body 拿到正文且 headerSummary 命中异常类与行号。
4. 审计验证：yarn ai:audit --user <id> --latest 10 --since 1h，确认三工具入链、写操作 purpose 正确、无凭据泄漏。
5. 回归：yarn build && yarn test（Node 24）；yarn workspace @sfoa/mcp-server test、test:p3/p4/p5、validate:p4、validate:upstream。

## 提交
- feat(provider-sfoa-context): add the debug log toolset with a bounded trace flag writer
- test(sfoa-mcp-server): cover the debug log gates and protocol paths
- docs(sfoa): record ADR-00xx（治理分类与 DebugLevel 策略）and the live evidence

## 禁止事项
- 禁止对 TraceFlag/DebugLevel 之外任何对象开放写路径；禁止生产 org 写 TraceFlag（遵循 ADR-0029）；禁止接受 Salesforce username/token 参数；禁止静默空结果；禁止 hint 引用未广告工具。

## 改进空间（可自主发挥）
- DebugLevel 预置档位设计（几档、各字段值）自定并在 ADR 说明取舍；
- headerSummary 的日志解析深度自定（正则 vs 结构化解析），解析策略须有单测；
- 若发现更优的日志正文获取路径（jsforce/REST/Tooling Blob），实测后选用并记录；
- 若 probe 发现「为他人设 TraceFlag」权限在本部署不可得，可提出降级设计（如仅支持 APEX_CLASS 维度）并走偏离流程。
```

---
---

> **修订注记（T1 实测后加，2026-09-30；原 Prompt 原文保留不改）**
>
> 依据 `ADR-0029` §1/§5，`targetUserId` 的边界是**设计选择，不是权限墙**：诊断身份读**指定其他用户**的 `PermissionSetAssignment` 实测返回非零（跨用户读已被证明可行），`FieldPermissions`/`ObjectPermissions`/`PermissionSet`/`Profile`/`RecordType` 全部可读，`FieldPermissions.Parent.Name` 可单查询多态穿透（`attributes.type` 区分 PermissionSet/Profile）。
>
> 两条硬约束：
>
> 1. **目标用户的 FLS 绝不能取 `describe`。** describe 回答的是调用身份（诊断账号）自己的权限——Account 252 字段。把它混进目标用户的解释里，等于把诊断管理员的权限报成用户的权限。
> 2. **不得按本地化标签比较。** `Profile.Name` 在本 org 是中文（`系统管理员`、`标准用户`），`SetupAuditTrail.Section` 亦被翻译；`RecordType` 必须带 `IsActive` 事实（实测存在停用记录类型）。

> **修订注记（T3 实施后加，2026-09-30；原 Prompt 原文保留不改）**
>
> 依据 `ADR-0031`，本任务有五处偏离原 Prompt 的写法，均有实测或结构性依据：
>
> 1. **`userContext` 与 `recordTypeContext` 放在顶层，不放每个 `fields[]` 条目里。** 原 Prompt 的输出草案把它们写在字段条目内。二者描述的是**被解释的主体对象**（主体是谁、他对本对象的读写、记录类型可见性），同一次调用内不可能因字段而异；按字段复制等于把一段相同字节乘以字段数，而字段数上限正是 10。字段条目只保留逐字段会变的事实：`fieldApiName` / `describeFacts` / `grants` / `conclusion`。
> 2. **`includeRecordTypeContext: false` 时顶层键整个不出现**，而不是出现一个空数组。调用方必须能区分「我主动关掉了」与「我要求了但这一层读不到」——后者要落成 `availableToSubject: 'INDETERMINATE'`，并在 `sourceChain` 里点名缺的是哪一层。这正是本任务的 INDETERMINATE 语义。
> 3. **对象层读不到 ⇒ 全部字段 INDETERMINATE，不是「无授权」。** 实测：主体的 profile-owned 集在本对象上若没有 `ObjectPermissions` 行，`objectAccess.read` 就是 `null`。原 Prompt 没规定这种输入下 `conclusion.visible` 取什么。本任务的取值是 `'INDETERMINATE'` 且 `sourceChain` 写明 `object-visibility: unreadable`——把「读不到」当「没有授权」是本任务禁止事项第 4 条，而对象层恰恰是最容易被漏掉的那一层。
> 4. **`FieldPermissions.Field` 的两种存储拼写都发。** 本 org 实测存在只认裸名（`Name`）与只认限定名（`Account.Name`）两种存储；权限配置查询两种都发、再归一化回裸名，否则会静默漏掉一半的行。
> 5. **实跑的正/反控制不写死字段名，先量后用。** 原 Prompt 假定存在一个「全开放字段」可以直接当正面控制。实测不能假设：本 org 的 `FieldPermissions` 可能根本没有 `Account.Name` 这一行，此时 Tool 报 `visible: false` **是对的**（`profileBaselineReadable` 取「该字段在 profile-owned 父上有行」），而把 `Account.Name` 写死进断言的里程碑会把**自己假设的失败**报成 Tool 的缺陷。因此实跑改为：反面字段取自 org 自己的 `read=false` 行、正面字段取自 org 自己的 `read=true && edit=true` 行；org 没有时，在 **sandbox** 上构造一条，连同 `ObjectPermissions` 读行一起由「写前/写后快照相等」回滚。`ObjectPermissions` 行本身也是必须建立的前提——它缺失会让每个字段都 INDETERMINATE。非 sandbox 上一律不写，两个控制降级为 `NOT TESTED` 并指名 `ADR-0029`，整体 `PARTIAL`——这是 ADR-0029 要的结果，不是一次需要重跑的失败。
>
> **另有三处非偏离、但必须在实现里钉死的边界（同记于 `ADR-0031`）**：
>
> 1. **`targetUserId` 的边界是 SOQL 子句，不是前置检查。** 「路由外 Id」与「不存在的 Id」返回**逐字节相同**的拒绝（`MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED`，不含 Id、不含 correlation），因为成员判定写在 `Username IN (…)` 里而不是先读后比。这样「某 Id 是否在本部署路由内」不能从两种拒绝的差异里被问出来，成本也固定为恰好一条查询。
> 2. **目标用户的 FLS 绝不取 `describe`。** describe 回答的是调用身份（固定 DIAGNOSTIC 账号）自己的权限，把它混进目标用户的解释里等于把诊断管理员报成用户。字段级事实只来自权限配置表。
> 3. **muting permission set 是本工具的已知盲区，且写在每一条结论上。** 只按 `PermissionSetAssignment` 求并集，不扣减 muting 集；`MUTING_CAVEAT` 出现在**所有**结论的 `caveats` 里而不是只在阳性结论上——一个读者必须先知道才去找的 caveat 等于没有 caveat。
## 任务 T3 — explain_field_access 权限归因（P10-3）

```
你是本仓库（D:\GitProject\sfoa-enterprise-mcp）的维护工程师，执行 P10 的权限归因工具任务。
前置：T1（ADR-0029）、T2 已完成。分支 feature/p10-diagnostic-depth。

本任务目标：实现 explain_field_access——对「用户看不到/改不了某字段」类问题给出确定性归因：一次调用聚合多层权限事实，输出「可见/可编辑结论 + 授权来源链 + 冲突说明」。这是差距 GAP-M2 的交付。红线：它是只读证据聚合器，不是权限引擎，不模拟、不预判 Salesforce 裁决（Baseline 非目标 1）。

## 必读
1. docs/sfoa/adr/ADR-0029（重点：诊断身份对 FieldPermissions/PermissionSetAssignment 等对象的可读性实测结论）
2. docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md 第 5 节 P10-3 行；MCP_ENGINEERING_RULES.md
3. 参照：packages/mcp-provider-sfoa-context/src/schemas.ts（既有 zod 契约风格）、T2 落地的三件套实现与 host 接入、packages/mcp-provider-sfoa-data/src/describe-sobject-executor.ts（describe 事实的读取方式）
4. Salesforce 权限模型参考事实（实现前先实测核对，不凭记忆）：字段可见性 = FLS(FieldPermissions) 与对象 CRUD(ObjectPermissions) 与 RecordType 可见性的合取；授权来源 = Profile 直接授予 + 各 PermissionSet（含 muting 的反面）；Perm Set Licenses 可能介入

## 实现内容
1. explain_field_access（READ, DIAGNOSTIC）：
   - 输入（strict zod）：objectApiName（API 名模式）；fieldApiNames（1..10 个，数组去重）；targetUserId（可选，15/18 位）；includeRecordTypeContext（默认 true）。
   - targetUserId 安全边界（硬约束）：仅允许**当前平台身份路由内已配置的 Salesforce 用户**或当前请求用户自身；host 侧校验（参照 DataToolFacade 的 route 校验位置），拒绝任意 userId——这防止诊断工具变成任意账号权限侦察器。校验所需的「路由内用户集合」由 host 传入（实现时确认 identity-runtime 已有该能力，若无则在 host 侧以只读方式补齐并记录）。
   - 聚合事实（全部经 DIAGNOSTIC Connection，单次调用内完成，各源有界）：
     a) describe 的字段 createable/updateable（请求身份视角的 FLS 结果）
     b) FieldPermissions（该字段的 SobjectType+Field 维度的读/编辑授权清单：ParentId → 解析出 PermissionSet/Profile 名称）
     c) （targetUserId 提供时）PermissionSetAssignment 过滤出该用户的授权子集 → 结论改为「该用户视角」
     d) RecordType 可见性（includeRecordTypeContext 时）：该对象 RecordType 对（目标）用户是否可用
     e) 字段级其他拦截源的存在性提示：Validation Rule / Field Dependency / Layout 只读等只列为「可能的非权限原因」，不下结论
   - 数据面断言（0.3 红线的本工具实现）：本工具的**全部查询目标对象**限定为 describe/EntityParticle 事实 + FieldPermissions/ObjectPermissions/PermissionSet/PermissionSetAssignment/Profile/RecordType 等 Setup 层对象；实现中以常量白名单声明并在单测中断言，任何业务记录查询在本工具的代码路径中不存在——`fieldApiNames` 只作为权限配置的查询键，绝不用于读取字段值。
   - 输出：structuredContent { objectApiName, fields: [{ fieldApiName, describeFacts, grants: [{ parentType, parentName, permissionsRead, permissionsEdit }], userContext(可选：assignments 命中的授权子集与缺位), recordTypeContext(可选), conclusion: { visible: boolean|'INDETERMINATE', editable: boolean|'INDETERMINATE', sourceChain: string[], conflicts: string[], caveats: string[] } }], truncated, hint }
   - INDETERMINATE 语义：当某层事实因权限不可读（按 ADR-0029 降级契约）时，结论必须是 INDETERMINATE 并说明缺哪层——绝不把「查不到」当成「没有授权」。
   - 冲突说明典型场景：Profile 拒但 PermSet 准、对象不可见导致字段连带不可见、RecordType 不可用但 FLS 准——由实现枚举常见形态并单测。
2. 登记、host 接入、审计 purpose（建议 PERMISSION_EXPLAIN）、Admin 编目：照 T2 模式。
3. 输出预算：fields×grants 可能膨胀，遵守双预算 + 截断声明（参照 response-budget 模式）。

## 测试与验证
1. 单元测试：输入校验；grants 聚合逻辑（mock 多层权限数据：Profile 直授/PermSet 补授/muting 缺位/对象级缺失）；INDETERMINATE 降级；targetUserId 越界拒绝（不在路由集合内）；预算截断。
2. 协议测试：未启用不可见、启用可调用。
3. Live SFoA（里程碑场景 b）：构造一个「字段 FLS 对某用户关闭」的测试配置（sandbox），explain_field_access(带 targetUserId) 的 sourceChain 必须准确命中关闭它的 Profile/缺失的 PermSet，与人工在 Setup 页核对一致；再验证一个全开放字段的正面结论。
4. 审计验证与回归：同 T2 命令集。
5. 隐私检查：输出只含权限事实（对象/字段/授权集名称），不含任何业务记录数据；单测加一条断言。

## 提交
- feat(provider-sfoa-context): add explain_field_access with a route-scoped target user boundary
- test(sfoa-mcp-server): cover the permission explain gates
- docs(sfoa): record ADR-00xx（targetUserId 边界与 INDETERMINATE 语义）and live evidence

## 禁止事项
- 禁止做成权限模拟引擎或预测器；禁止接受路由外任意 userId；禁止输出业务记录数据；禁止把不可读层当作「无授权」。

## 改进空间（可自主发挥）
- sourceChain 的人类可读措辞与层级顺序自定；
- 可为高频追问预留 explain_object_access（对象级）的内部结构，但本任务只交付字段级——若实现中发现对象级顺手可得，先在 ADR 提案不实现；
- 聚合查询的批处理策略（单条 SOQL IN 查询 vs 逐字段）实测后自定。
```

---
---

> **修订注记（T1 实测后加，2026-09-30；原 Prompt 原文保留不改）**
>
> 依据 `docs/sfoa/P10_T0_LIVE_PROBE_FINDINGS.md` §7 与 `ADR-0029` §1/§4b：
>
> 1. **Metadata 条目的形状是「按类型不同」的。** `ValidationRule` 与 `NamedCredential` 的条目带 `lastModifiedByName`/`fileName`/`manageableState`，而 **`Profile` 没有 `manageableState`**。`list_metadata_components` 的输出契约必须把它建模为按类型可选，否则遇到 Profile 直接违约。
> 2. **`fullName` 是本地化的、且经过 URL 转义**（实测：`风控负责`、`WRN业务员%2F业务主管%2F市场开发`、`SHRN工程管理总监%2F项目经理`）。任何把 `fullName` 原样回传给后续 retrieve 的路径都必须逐字传递——把 `%2F` 解码成 `/` 会指向另一个组件。
> 3. **新增的 19 个类型必须逐个实测，不能从已探的 3 个外推。** 本次只探了 `ValidationRule`(245) / `NamedCredential`(3) / `Profile`(65)；每种类型的可读性是逐类型的授权事实。
> 4. **`get_metadata_component_context` 有一处描述与行为待核对**（ADR-0029 §4b）：其 description 说读取「一个白名单组件」，而实现会返回官方 retrieve 在 `force-app/main/default` 下产出的**全部**元数据文件（上限 40 文件 / 256 KiB）。若 retrieve 会带出依赖组件，则实际返回不止一个组件。这是描述与行为的不一致，需核实并修正（元数据仍属 Setup 层，不构成红线问题）。

> **修订注记（T4 实施后加，2026-10-09；原 Prompt 原文保留不改）**
>
> 依据 `ADR-0032`，本任务有八处偏离原 Prompt 的写法，均有实测或结构性依据：
>
> 1. **数据源固定为 Metadata API `listMetadata`，不做「按类型选 Tooling 或 listMetadata」。** 原 Prompt 把选择留给逐类型实测；实测与结构事实都指向同一个答案：Tooling 侧没有能统一枚举配置的对象（22 类会变成 22 套 schema 依赖），而 `describe` 回答的是**调用身份**的视角（T0 §6：`Account` describe 报 252 字段/199 createable，那是管理员账号的 FLS，不是 org 的配置）。`lastModifiedByName`/`fileName` 这类溯源字段也只有 listMetadata 给。代价被明确记录：逐类型可列性（A-4）与每次调用一次 Metadata API 往返。
> 2. **输出的 `state/active` 换成 `manageableState`，且按类型可选。** org 实际返回的字段名是 `manageableState`，且 **`Profile` 条目根本没有这个字段**（T0 §7）。`includeInactive` 的语义因此被钉死为 `manageableState === 'deleted'` 一条（`released`/`installed`/`unmanaged`/`deprecated`/`beta` 都是活状态），无该字段按「活」处理——这是唯一在 Profile 类上安全的读法。
> 3. **`developerNamePrefix` 不再沿用 `metadataFullNameSchema` 的 ASCII 形状校验。** 原 Prompt 的必读 2 要求「扩展时保持同等约束」，禁止事项也要求「禁止放宽 fullName 安全校验」。但那条 ASCII 白名单**拒绝本 org 实际存储的每一个名字**（`风控负责` 不是 ASCII），照搬会让本工具只能被喂一个真实 org 永远产不出的名字。改为**只校验安全性、不校验形状**（无控制字符、无 `..` 穿越、长度上限）；禁止事项在本意上被完整满足：prefix 只是对已列出条目的本地 `startsWith` 比较，永不进入 manifest、路径或查询，所以它放宽的字符集没有任何通往边界的路径。`fullName` 侧同理：逐字传递，永不解码。
> 4. **没有实现「类型专属预算（每类 maxBytes 可配置，Profile 类收紧）」。** 一张 22 类的预算表会是 22 个未经测量的数字。实际实现是一条全局字节预算（`MAX_DIAGNOSTIC_RESULT_BYTES`）加上读取侧既有的 `METADATA_CONTEXT_LIMITS`，并由 T4 live 里程碑在**真实 Profile** 上实测这两条边界（含超预算时的结构化拒绝），把「Profile 类尤其」这条禁令变成一条被测量的断言而不是一个常量。
> 5. **「Admin 编目：照 T2 模式」拆成两件事，一件已满足、一件是尚未做出的决定。**
>    - **控制台目录（admin-web）：已照 T2 模式落地。** `buildAdminToolCatalog` 从 `SFOA_CONTEXT_TOOL_NAMES` 结构性生成条目，`contextToolClassification()` 把它归为 `METADATA_READ`，`contextToolDependencies()` 声明其前置为「enabled Diagnostic configuration」与「per-type readability of the allowlisted metadata types (A-4)」；同时 `configureProviderRuntime` 把 SFOA context 工具滤出**官方目录查找**，因此它可按名字启用、无需改官方目录源。
>    - **Playbook／生成的 Agent 指令：不进入。** `deriveDifyInstructionFacts` 的 `availableTools` 由 `AGENT_RECOGNIZED_TOOL_NAMES` 过滤，该工具不在其中，所以 Dify/企微 侧生成的指令里没有它（T1/T2/T3 的三个工具同样如此）。是否把它加入 Playbook 的识别清单是**另一个尚未做出的决定**，本轮不替它作答。
>    - **本部署实测**：`sfoa_tool_control` 里没有 `list_metadata_components` 行（T3 的 `explain_field_access` 也没有，T2 的 `get_metadata_component_context` 行来自 2026-08-26 的种子），即默认关闭且未经控制台启用；两个 live 里程碑都在内存里授予快照后验证，未写控制面。
> 6. **原 Prompt 的两个类型名经实测被更正，白名单是 8 → 21 而不是 8 → 22。**（上一版修订注记把 `SharingRule` 列为「待实测项」，这里是实测结果。）
>    - **`SharingRule` → `SharingRules`。** 单数名实测返回 `INVALID_TYPE: Unknown type:SharingRule`；org 的 `describeMetadata` 声明的是 `SharingRules`，列出 **210** 条（`CXG__DataLibrary__c`、`Project_Proposal__c`…）。按修订注记的约定更正而非静默改名。
>    - **`CustomSetting` 移除。** 该名字不是 Metadata API 类型：`INVALID_TYPE: Unknown type:CustomSetting`，且 org 声明的 **204** 个类型里没有它。它想覆盖的能力（自定义设置清单）**已由 `CustomObject` 提供**——实测 org 有 8 个自定义设置（`GlobalSetting__c`、`SkipTrigger__c`、`OAToken__c`…），**8/8 都出现在 `CustomObject` 列表里**。另找一个类型来凑满 22 会被否决：那会超出原 Prompt 的类型清单，且没有它要回答的问题。
> 7. **`MCP_METADATA_TYPE_UNAVAILABLE` 的分类在实跑首次失败，缺陷已修。** jsforce 给 Metadata API 的错误码加了命名空间（`errorCode: 'sf:INVALID_TYPE'`，顶层与 `data` 各一份），而共享的 `readSalesforceFailure` 按其 `ERROR_CODE_PATTERN`（标识符形状，不含冒号）把带命名空间的码降为 `null`——于是 `METADATA_LIST_UNAVAILABLE_CODES` **一个都匹配不上**，逐类型的授权事实被报成可重试的通用失败、且不带 `prerequisite`。修法是在 `mapMetadataListFailure` 内剥掉 `sf:` 前缀（不拓宽那个四个 provider 共用的清洗器），并由单测用实测到的错误形状钉住。
> 8. **首次实跑的覆盖门禁即为 FAIL，且这个 FAIL 是设计要的结果。** 22 个类型里 20 个被服务、2 个被结构化拒绝，门禁判定「白名单声称了一个本部署不满足的逐类型授权事实」并失败——正是它该说的话。`EscalationRule` 的 `totalCount: 0` 只有单一证据来源（见证据页「本次运行不能证明什么」）。
>
> **另有一处非偏离、但沿用了原 Prompt 的建议**：审计 purpose 采用独立值 `METADATA_LIST`（与读取侧的 `METADATA_RETRIEVE` 相对）。因为两者 `apiCategory` 都是 `METADATA_API`，purpose 是审计里唯一能区分「列表」与「读取」的字段。

## 任务 T4 — list_metadata_components + get_metadata_component_context 类型扩展（P10-4/5）

```
你是本仓库（D:\GitProject\sfoa-enterprise-mcp）的维护工程师，执行 P10 的元数据读取面扩展任务。
前置：T1 已完成。T2/T3 建议已完成但非硬前置。分支 feature/p10-diagnostic-depth。

本任务目标：(a) 新工具 list_metadata_components——按类型列组件清单（与 get_metadata_component_context 构成「列表 vs 内容」互补，同 P9 的 list_sobjects/describe_sobject 模式）；(b) 扩展 get_metadata_component_context 的类型白名单（8 类 → 22 类）。

## 必读
1. docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md 第 5 节 P10-4/5 行；MCP_ENGINEERING_RULES.md
2. packages/mcp-provider-sfoa-context/src/schemas.ts（METADATA_CONTEXT_TYPES 白名单与 metadataFullNameSchema 的安全校验——路径穿越/分隔符拒绝，扩展时保持同等约束）、src/tools/metadata-component-context.ts 及其 executor
3. P9 参照：packages/mcp-provider-sfoa-data/src/list-sobjects-executor.ts 与 tools/list-sobjects.ts（列表型工具的截断/totalCount 契约范本）
4. ADR-0029 中关于 listMetadata 可读性的 probe 结论

## 实现内容
1. list_metadata_components（READ, DIAGNOSTIC）：
   - 输入（strict zod）：metadataType（扩展后的白名单枚举，见下）；developerNamePrefix（可选，API 名前缀模式校验）；includeInactive（默认 false——很多类型有 ManageableState/Active 维度）；limit（默认 50，硬上限 200）。
   - 数据源：按类型选 Tooling 查询或 Metadata API listMetadata（以 probe 实测可用者为准；两类行为差异在 ADR 记录——例如 Tooling 可给 lastModifiedBy 而 listMetadata 不给）。
   - 输出：structuredContent { metadataType, components: [{ fullName, ...(可用则附) state/active, lastModifiedBy, lastModifiedDate }], totalCount, returnedCount, truncated, hint }；hint 指引用 get_metadata_component_context 读单个组件内容。
2. get_metadata_component_context 白名单扩展（8 → 22 类）：增补 NamedCredential、CustomMetadata、CustomSetting、QuickAction、RecordType、EmailTemplate、DuplicateRule、AssignmentRule、AutoResponseRule、EscalationRule、SharingRule、Workflow、PermissionSet、Profile。
   - 注意：新类型未必是「单 fullName 对应多文件」的旧模型，逐类实测其 retrieve/查询行为；行为不符的类型（如 Profile 文件巨大）要加类型专属预算（每类 maxBytes 可配置，默认沿用现值，Profile 类收紧），超预算走既有截断契约。
   - 扩展白名单属于对外契约变化：单测同步更新枚举清单，ADR 记录各类型的实测行为与预算决策。
3. 登记、host 接入、审计 purpose（建议 METADATA_LIST 或并入现有 METADATA 相关类，依 T2 定下的原则）、Admin 编目：照 T2 模式。

## 测试与验证
1. 单元测试：类型枚举校验；前缀过滤；截断与 totalCount；新类型预算收紧；注入向量的继续拒绝（fullName 校验对新类型同样生效）。
2. 协议测试：未启用不可见、启用可调用。
3. Live SFoA：list_metadata_components(ValidationRule) 列出 org 真实清单并与 org 界面数量核对；取一个 fullName 用 get_metadata_component_context 读回内容（含一个新类型如 NamedCredential 或 DuplicateRule 的正反用例）。
4. 审计验证与回归：同 T2 命令集。

## 提交
- feat(provider-sfoa-context): add list_metadata_components and widen the context type allowlist
- test(sfoa-mcp-server): cover the metadata list gates
- docs(sfoa): record ADR-00xx（数据源选择与类型预算）and live evidence

## 禁止事项
- 禁止放宽 fullName 安全校验；禁止默认返回 inactive 组件（须显式 includeInactive）；禁止超预算回传大文件（Profile 类尤其）。

## 改进空间（可自主发挥）
- 「Tooling 查询 vs listMetadata」的逐类选型矩阵自定（实测驱动，ADR 存档）；
- 可为后续 explain_object_access 预留结构，但不实现；
- 前缀过滤的下推位置（服务端 LIKE vs 本地过滤）实测性能后自定。
```

---
---

> **修订注记（T1 实测后加，2026-09-30；原 Prompt 原文保留不改）**
>
> 依据 `docs/sfoa/P10_T0_LIVE_PROBE_FINDINGS.md` §4/§5 与 `ADR-0029` §1/§3/§5：
>
> 1. **按 `Action` 过滤，绝不能按 `Section`。** `SetupAuditTrail` 的可过滤性逐字段不同：`CreatedDate`/`Action`/`CreatedById` **可**，`Section`/`Display` **不可**（`INVALID_FIELD`："field 'Section' can not be filtered in a query call"）。而 `Section` 恰是名字上最像"只看 Apex 变更"的那个字段。另：`Action` 是稳定英文枚举（`changedApexClass`/`suOrgAdminLogin`），`Section` 被本地化（`Apex 类`/`管理用户`）。
> 2. **计数取 `totalSize`。** `SELECT COUNT(Id)` 被直接拒绝（`MALFORMED_QUERY`），`SELECT COUNT()` 虽被接受但返回**空 `records` 数组**，数字在 `totalSize`（实测 260 911）。读 `records[0].expr0` 会得到 `undefined` 并报成 0——既没有 `expr0` 也没有 alias。
> 3. **`CronTrigger` 在本 org 确实是 0 行**（无任何计划任务），这是**事实而非故障**。因此本工具必须**分源声明状态**（`READ` + 行数 / `UNAVAILABLE` + 缺失前提标识），不能用一个全局 `success: true` 覆盖"某一段其实没读到"。这正是 ADR-0029 §3 降级契约要区分的那一格。
> 4. 溯源窗口的诚实边界：`SetupAuditTrail` 现存最旧一行 `2026-04-08`，Salesforce 不向 SOQL 暴露保留策略；`AsyncApexJob` 实测可读（152 条 Completed、0 条 Failed/Aborted）。

## 任务 T5 — get_platform_diagnostics 变更溯源聚合（P10-6）

```
你是本仓库（D:\GitProject\sfoa-enterprise-mcp）的维护工程师，执行 P10 的平台诊断聚合任务。
前置：T1（ADR-0029）、T2 已完成。分支 feature/p10-diagnostic-depth。

本任务目标：实现 get_platform_diagnostics——单调用聚合最近 N 小时的多源平台证据（SetupAuditTrail 变更溯源、AsyncApexJob 失败、CronTrigger 卡滞），输出按时间线对齐的结构化证据表，支撑「异常时间点 × 变更记录」对齐定位法。这是差距 GAP-M5 的交付，也是 P10 里程碑场景 (c) 的核心。

## 必读
1. docs/sfoa/adr/ADR-0029（SetupAuditTrail/AsyncApexJob/CronTrigger 可读性结论）
2. docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md 第 5 节 P10-6 行；MCP_ENGINEERING_RULES.md
3. 参照：T2–T4 已落地的工具实现、response-budget 模式、packages/sfoa-mcp-server/src/test/ 既有 helper

## 实现内容
1. get_platform_diagnostics（READ, DIAGNOSTIC）：
   - 输入（strict zod）：windowHours（默认 24，最小 1，硬上限 168）；sections（可选枚举数组 ['SETUP_CHANGES','ASYNC_FAILURES','SCHEDULED_JOBS']，默认全部三节）；limitPerSection（默认 25，硬上限 100）。
   - 三节数据源与字段（以 probe 实测可读字段为准，查询前先用 describe 核对字段存在性——P9 教训：不凭文档假设 Salesforce 行为）：
     a) SETUP_CHANGES：SetupAuditTrail（Action、CreatedBy、CreatedDate、Section、DelegateUser 等），倒序有界
     b) ASYNC_FAILURES：AsyncApexJob 中 Status 为 Failed/Aborted 的记录（JobType、NumberOfErrors、ExtendedErrorStatus 等）
     c) SCHEDULED_JOBS：CronTrigger 关联 CronJobDetail，标注疑似卡滞（已到 nextFireTime 仍 QUEUED/WAITING 等形态，判定规则由实现定义并入 ADR——规则要保守，宁可标注「疑似」不给武断结论）
   - 聚合输出：structuredContent { window: { from, to }, sections: { setupChanges: { entries, totalCount, truncated }, asyncFailures: {...}, scheduledJobs: {...} }, alignment: { timeline: [按时间排序的合并证据条目，每条带 source 节标识], note }, truncated, hint }
   - alignment.timeline 是本工具的独特价值：把三节条目按时间合并成单一时间线，agent 直接在时间线上找「异常发生前最近的变更」。
   - 单节失败不拖垮整体：某源不可读（按 ADR-0029 降级契约）时该节置 unavailable 并说明原因，其余节正常返回；hint 提示缺失节的影响。
2. 登记、host 接入、审计 purpose（建议 PLATFORM_DIAGNOSTICS）、Admin 编目：照 T2 模式。
3. 响应预算：三节合计遵守双预算，超预算先收各节条目数再截断字段，truncated 声明具体到节。

## 测试与验证
1. 单元测试：窗口边界；节选择；卡滞判定规则（mock 各形态 CronTrigger）；单节降级不拖垮整体；时间线合并排序；预算截断到节。
2. 协议测试：未启用不可见、启用可调用。
3. Live SFoA（里程碑场景 c）：sandbox 中先由测试配置改动产生 SetupAuditTrail 条目，再调用工具确认：时间线含该条目且 CreatedBy/Action 正确；构造一个 Failed 的 AsyncApexJob（如抛异常的 batch 测试类）确认 ASYNC_FAILURES 命中。
4. 审计验证与回归：同 T2 命令集。

## 提交
- feat(provider-sfoa-context): add get_platform_diagnostics with a merged evidence timeline
- test(sfoa-mcp-server): cover the platform diagnostics gates
- docs(sfoa): record ADR-00xx（卡滞判定规则与降级矩阵）and live evidence

## 禁止事项
- 禁止把「疑似卡滞」表述为确定结论；禁止单节失败拖垮整体或静默空节；禁止超窗口回传。

## 改进空间（可自主发挥）
- 可增加更多节（如最近的 ApexClass/Trigger 修改时间，用 Tooling 查询）作为可选 section，实测可行后加入并在 ADR 记录；
- 时间线条目的精简字段策略自定（保 token 经济）；
- 若 probe 发现 SetupAuditTrail 保留期短（约 90 天），可在 hint 中提示窗口与保留期的关系。
```

---
---

## 任务 T6 — sfoa-org-diagnostics skill + Playbook 1.11.0 + 收口与整体验收（P10-7）

```
你是本仓库（D:\GitProject\sfoa-enterprise-mcp）的维护工程师，执行 P10 的收口任务。
前置：T1–T5 已完成并通过各自验收。分支 feature/p10-diagnostic-depth。

本任务目标：新建 sfoa-org-diagnostics skill（诊断决策树方法论）、Playbook 升级 1.11.0 并同步小犇指令、完成文档收口与 P10 整体验收。

## 必读
1. skills/sfoa-data-analysis/（P9 落地的 skill 格式与 Hard Rules 风格基准）与 skills/sfoa-crm-core/SKILL.md（canonical skill 格式）
2. packages/sfoa-agent-playbook/src/definition.ts、version.ts、capabilities.ts、renderer.ts（P9 的 DATA_COMPLETENESS 章节先例）；scripts/sync-generated.mjs（5 个生成物清单）
3. docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md 第 5 节 P10 里程碑验收与 0.5 节清单；CHANGELOG.md 与 docs/sfoa/CHANGELOG.md 的摘要/详录分工
4. T2–T5 全部 ADR（诊断工具的最终契约以 ADR 为准）

## 实现内容
1. skills/sfoa-org-diagnostics/SKILL.md（+ references/ 若需要，风格对齐 sfoa-data-analysis）：
   - Hard Rules 必须覆盖：
     a) 证据引用义务：诊断结论必须引用具体元数据证据（组件 fullName、日志行号、审计条目时间戳、授权来源链），无证据不得下结论
     b) 分类先行：症状先归类（数据/权限/配置/代码/平台），再走该类的确定性工具路径——把五类路径写成本 skill 的核心决策树：
        数据类 → query_records/describe_sobject；权限类 → explain_field_access；配置类 → list_metadata_components + get_metadata_component_context；代码类 → set_trace_flag → get_apex_logs → get_debug_log_body；平台类 → get_platform_diagnostics
     c) 时间对齐套路：「何时开始异常」先问清，异常时间点 × get_platform_diagnostics 时间线对齐是默认第一步
     d) INDETERMINATE 与降级语义：工具输出 INDETERMINATE/unavailable 时如实转述并指出缺失前提，不得脑补
     e) Untrusted 内容规则继承；Salesforce 权威规则继承（与 sfoa-crm-core 的关系声明：本 skill 只管诊断方法论，身份/治理/写入规则不重复）
     f) 无工具可用时（未启用/无权限）：如实报告需要 Admin 启用，不得用 run_diagnostic_tooling_query 手拼长查询替代确定性工具除非用户明确要求临时深挖
   - Guidelines：复现最小化建议（重开 trace 的时机）、日志保留期提醒、多假设并行时的证据优先级；
     **复现协作义务**（2026-09-30 补充）：TraceFlag 只对开启后的执行生效，历史异常不可回溯——set_trace_flag 成功后智能体必须主动向用户给出最小复现指引（操作步骤 + durationMinutes 窗口期）并等待复现后再调 get_apex_logs，不得开了 trace 就宣称「日志已就绪」；
     **无日志静态路径**：无法复现的历史问题，默认先走不依赖日志的证据链——get_platform_diagnostics（AsyncApexJob 失败记录与 SetupAuditTrail 时间线均不需要 trace）→ get_metadata_component_context 读代码/配置 → explain_field_access 权限归因；同步报错时用户看到的错误消息本身（校验规则名/类名）就是定位起点；日志是五类证据之一，不是诊断的前提。
2. Playbook 升级：definition.ts 新增 DIAGNOSTICS 章节（要点对齐上述决策树与证据义务），capabilities.ts 登记六个新工具（Recognition is not enablement 注释风格照旧），version.ts 1.10.0 → 1.11.0；playbook 单测更新；yarn workspace @sfoa/agent-playbook build && yarn agent:sync && yarn agent:check（5 生成物含小犇指令 docs/agent/DIFY_AGENT_INSTRUCTION.md 头部应为 1.11.0）。
3. skill 同步四处：skills/（canonical）、.agents/、.claude/、.codebuddy/（用仓库既有同步机制，勿手抄）。
4. 文档收口：CHANGELOG.md（摘要）+ docs/sfoa/CHANGELOG.md（详录）；MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md 的 P10 表标注已交付与 ADR 编号。
5. P10 整体验收（逐项留证，产出 docs/sfoa/P10_ACCEPTANCE_REPORT.md，格式对齐 P9_ACCEPTANCE_REPORT.md，包含「未执行项」诚实小节）：
   - 本地门禁全量（0.5 节清单，Node 24）；pre-existing 失败用 main 对照口径
   - validate:p10 固化为 package.json 脚本（参照 p9-live-validation 架构，必须包含 P9 修复的审计 flush 屏障：先 client.close → server.close → 断言 drained → flush，防 MCP_AUDIT_PIPELINE_CLOSED 丢证据）
   - 三条里程碑场景 live 复验：(a) Apex 异常闭环 (b) 字段归因 (c) 变更时间线对齐
   - 审计验收：全工具入链 + 凭据模式扫描零命中
   - 「部分启用」验证：只启用三个工具时，未启用工具不可见且其它工具 hint 不点名它们（跨工具 hint 门控）

## 提交
- feat(skills): add the sfoa-org-diagnostics skill
- feat(agent-playbook): publish playbook 1.11.0 with the diagnostics contract
- test(sfoa-mcp-server): fix the validate:p10 gate harness
- docs(sfoa): record the P10 acceptance evidence

## 禁止事项
- 禁止手改生成物（docs/agent/*、.codebuddy/skills/sfoa-salesforce-assistant/*）；禁止跳过 agent:check；禁止在 skill 中写环境特定值；禁止把验收未执行项写成已执行（P9 的诚实标准：pre-fix FAIL 与未执行项都要留痕）。

## 改进空间（可自主发挥）
- 决策树的呈现形式（单文件表格 vs references/ 分册）自定，以 agent 可执行性为先；
- 里程碑场景的测试夹具（预置异常 Apex 类等）形态自定；
- 若验收中发现跨任务的一致性问题（如 hint 门控在某工具缺失），直接修复并在 CHANGELOG 记录。
```

---
---

## 附：给用户的执行提示

1. **顺序执行**：T1 是硬前置（权限 probe 决定后续所有设计）；T2 → T3 → T4 → T5 之间无强依赖但建议线性；T6 收口。
2. **生产安全**：T1/T2 涉及 TraceFlag 写操作与权限探测，Prompt 已硬性限定 sandbox/scratch org；若执行环境只有生产 org，要求 Claude Code 标记 NOT PROBED 停下来，不得越界。
3. **环境提醒**：单测一律 Node 24（Node 22 会挂 timeout 类测试，P9 已实测）；yarn shim 间歇失败时改用 `D:/software/node.exe` 直跑 tsc/node --test。
4. **偏离处理**：Claude Code 的自主改进按 0.3 偏离流程（实测依据 + ADR + 本文档注记 + CHANGELOG），用户在验收时通过 ADR 与注记即可审计全部偏离。
5. **合并评估追溯**：本阶段「不合并」的完整论证在 0.1 节；若开发中发现新的合并收益，同样走偏离流程，不临时改案。

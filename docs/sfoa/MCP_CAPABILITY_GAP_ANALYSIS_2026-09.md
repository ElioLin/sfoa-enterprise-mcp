# Salesforce MCP 能力对标分析与增强路线图

文档日期：2026-09-24
分析基线：`main` @ P7-MAINTAINER-SKILL-BL-1.0（P7-09 完成，P8/P8-04/P8-07 交付在案）
对标对象：Salesforce 官方 DX MCP（上游 `salesforcecli/mcp` v0.30.x）、Salesforce Hosted MCP Servers（Standard + Headless 360 Beta + Data 360）、社区主流 Salesforce MCP（smn2gnt、tsmztech、advancedcommunities）
性质：分析建议文档，非 Baseline 变更。任何落地实施仍须按 `PROJECT_BASELINE.md` 的阶段 Gate 与 ADR 流程授权。

---

## 1. 结论摘要

**直接回答："我们目前是否具备交互 Salesforce 的所有功能（除开发部署之外）？"——不具备。**

当前服务是一个**最小可信读写面**：SOQL 单批查询 + CREATE/UPDATE（含批量）+ 记录变更就绪上下文 + 受限 Tooling 诊断 + 元数据组件上下文（8 种类型）。在"治理与身份安全"这个维度上我们**强于**几乎所有社区 MCP（default-deny、请求级身份、P7 审计证据链是官方 Hosted MCP 之外少有的）；但在"数据获取完整性"与"异常诊断确定性"两个维度上，存在明确缺口——恰好是本报告两个目标所在：

| 目标 | 现状结论 | 核心阻碍 |
| --- | --- | --- |
| 数据分析：不管多大数据都能准确分析 | **不达标** | `run_soql_query` 单批返回、无续查能力；无 Bulk Query；无 describe 自助探索；无 org limits；大数据集靠 skill 纪律约束而非运行时能力 |
| 异常诊断：精准通过元数据分析原因、给出方案 | **部分达标** | 已有 Tooling 通用查询与 8 类元数据上下文，但缺 debug log、权限归因、变更溯源、平台状态聚合等确定性工具，agent 只能手写 Tooling SOQL 拼证据 |

---

## 2. 现有能力盘点（已具备）

### 2.1 数据读写
- `run_soql_query`（官方原样复用，USER）：SOQL / Tooling API 查询，**单批执行**（约 2000 行/批），返回体含 `done`/`nextRecordsUrl` 字段但**无续查参数**——agent 拿到 nextRecordsUrl 无法消费；SOQL OFFSET 平台上限 2000，排序+WHERE 手工翻页易错。
- `create_record` / `update_record` / `create_records` / `update_records`（SFOA 自研，USER）：严格 Object×Operation allowlist，批量 1..200，UNKNOWN 语义与 no-retry 契约完整。DELETE/UPSERT/MERGE 结构性不存在（Baseline non-goal）。
- `upload_files_to_record`：附件上传（ingress ref 机制）。**无下载/读取**。

### 2.2 上下文与元数据
- `get_record_action_context` / `get_record_display_context` / `resolve_field_display_values` / `get_record_relationship_context`（USER）：UI API 驱动的 CREATE/UPDATE 就绪事实、布局展示事实，含 Dynamic Forms/FlexiPage 解析。这是**强于官方与社区 MCP** 的部分。
- `get_metadata_component_context`（DIAGNOSTIC）：白名单 8 类（CustomObject/CustomField/ValidationRule/Flow/ApexClass/ApexTrigger/Layout/FlexiPage）的源码级元数据读取，有界截断。
- `retrieve_metadata`（官方，默认禁用）：Metadata API retrieve，依赖 DX 项目工作区。
- `run_diagnostic_tooling_query`（DIAGNOSTIC）：任意 Tooling API SELECT（仅约束语法：SELECT 开头、单语句、无 FOR UPDATE、≤12000 字符），**能力上可手查任意 Tooling 对象，但没有任何确定性封装与诊断方法学**。

### 2.3 治理与证据（差异化优势）
- default-deny Tool Governance + DML Object×Operation policy（MySQL 快照、fail-closed）。
- 请求级身份（USER / DIAGNOSTIC 双角色，P7-09 lazy connection）。
- P7 端到端审计证据链（Event/API/Payload，Workbench 追溯）。
- Playbook 1.6.x + `sfoa-crm-core` / `sfoa-record-change` skills（变更就绪方法论成熟）。

---

## 3. 对标基线

### 3.1 Salesforce 官方 DX MCP（本项目上游）
v0.30.x 已演进为 **60+ 工具 / 15 个 toolsets**（Metadata、SOQL、Apex、LWC、Aura Migration、DevOps Center、Code Analysis、Mobile 等）。本项目 pin 在 dx-core 0.10.0，编目 13 个 dx-core 工具、远程仅启用 2 个。上游 Apex toolset 含**匿名 Apex 执行**与测试执行——本项目按治理策略全部 default-deny（符合预期，但意味着"能力面"与上游差距会持续扩大，需要定期重新评估编目）。

### 3.2 Salesforce Hosted MCP Servers（GA，官方托管）
Standard 服务器固定工具集：
- **SObject All / Reads / Mutations / Deletes**：全对象 CRUD + query + search（含 delete 工具集）。
- **Data 360**：统一客户数据查询（~200 API，search/payload_examples/execute 三工具 facade 架构）。
- **Tableau Next**：语义模型发现、KPI 查询、分析执行——**官方对"数据分析层"的答案**。
- **Headless 360（Beta，2026-07 起）**：**四个工具**（Discover / Describe / Dispatch / Dispatch-Readonly）+ 持续增长的 operations 库（语义搜索索引）。Beta 期覆盖 Setup 侧操作：用户全生命周期管理、Apex Trigger 读写、平台事件/CDC/事件中继、Named Credentials、Commerce Orders 等。方法论要点：**工具面小而稳定，能力库独立增长，agent 运行时通过 Discover 自发现**。

### 3.3 Headless 360 平台战略（TDX 2026）
60+ MCP 工具 + 30+ 预置 coding skills + AgentScript（确定性 agent 行为文件）+ Agent Fabric（上线前后治理）。数据面含 upsert/delete、invoke Flow、run Apex、**执行已保存报表（execute saved reports）**、Agentforce 会话管理。附带 Agentforce Coworker、DevOps Center MCP 等。

### 3.4 社区主流 Salesforce MCP
| 服务器 | 亮点能力（我们缺的） |
| --- | --- |
| smn2gnt/MCP-Salesforce（Python，179★） | SOSL、Tooling API、direct REST 通道、**bulk operations** |
| tsmztech/mcp-server-salesforce（TS，166★） | **聚合查询**（GROUP BY/HAVING 显式支持）、**字段级安全管理**、**匿名 Apex**、**debug logging**、多 org 切换 |
| advancedcommunities/salesforce-mcp-server（TS，41 工具） | **SOQL CSV/JSON 导出**、**debug logs 读取**、test runner、**read-only 模式**、org 限制 |

安全警示：社区另有 CVE-2026-26029（sf-mcp-server 命令注入 RCE，CVSS 7.5）案例——印证本项目"不引入任意 REST/任意进程通道"边界的正确性。

---

## 4. 差距分析

### 4.1 数据分析层（目标 1：任意规模数据全量准确分析）

| 编号 | 差距 | 影响 | 严重度 |
| --- | --- | --- | --- |
| GAP-D1 | `run_soql_query` 无续查：nextRecordsUrl 不可消费、OFFSET>2000 被平台拒绝、无 maxRows 保护 | **>2000 行数据集分析必然不完整**；agent 依赖 skill 纪律手工翻页，错误率高。这是目标 1 的头号阻碍 | P0 |
| GAP-D2 | 无 Bulk Query 2.0 | 百万行级全量导出不可能完成；"不管多大数据都准确分析"无运行时支撑 | P0 |
| GAP-D3 | 无 `describe_sobject` / `describe_global` | agent 无法自助探索 schema，字段名/类型/关系靠猜或靠 `get_record_action_context`（该工具只面向 CREATE/UPDATE 场景）；分析类查询报 INVALID_FIELD 后无法自我修正 | P0 |
| GAP-D4 | 聚合查询无显式支持与引导 | 聚合是大数据分析的合规路径（结果行少），但工具描述与 skill 均未引导，agent 常拉明细进上下文导致 token 爆炸与截断 | P0（skill+描述层）/P1 |
| GAP-D5 | 无 SOSL | 跨对象关键词检索（客户名模糊查找等）无法完成 | P1 |
| GAP-D6 | 无 Report/Dashboard 读取 | 组织沉淀的分析资产（报表）agent 用不上；官方 Headless 360 已含 execute saved reports | P2 |
| GAP-D7 | 无 `get_org_limits` | 大数据作业前无法预判 governor 约束（Bulk API 日配额、并发限制） | P1 |
| GAP-D8 | 无记录附件/长文本读取 | Case EmailMessage、Attachment/ContentVersion 正文不可读，文本类分析不完整 | P2 |
| GAP-D9 | 查询错误非结构化 | `run_soql_query` 失败只回错误文本，agent 难以程序化重试修正（DML 已结构化，query 没有） | P1 |

### 4.2 元数据异常诊断层（目标 2：精准根因分析）

| 编号 | 差距 | 影响 | 严重度 |
| --- | --- | --- | --- |
| GAP-M1 | 无 Debug Log / TraceFlag 工具组 | **Apex 运行时异常、Flow 运行错误的最直接证据拿不到**；agent 无法"打开 trace → 复现 → 拉 log → 定位堆栈"闭环，只能靠用户截图转述 | P0（诊断向） |
| GAP-M2 | 无权限/FLS 归因工具 | "用户看不到/改不了 X" 类问题占支持量大头；现需 agent 手拼 FieldPermissions + PermissionSetAssignment + Profile 多条 Tooling 查询，无确定性"该用户对该字段为何可见/可编辑"归因输出 | P0（诊断向） |
| GAP-M3 | 无 `list_metadata_components` | 无法按类型列组件清单（如全部 active ValidationRule / Flow / DuplicateRule），只能靠 Tooling query 且无截断契约 | P1 |
| GAP-M4 | `get_metadata_component_context` 类型面窄（8 类） | NamedCredential、CustomMetadata、CustomSetting、QuickAction、RecordType、EmailTemplate、DuplicateRule/AssignmentRule/EscalationRule、SharingRule、Workflow、PermissionSet/Profile 等常见异常源读不到 | P1 |
| GAP-M5 | 无平台状态/变更溯源聚合 | SetupAuditTrail（谁改了什么配置）、AsyncApexJob（失败 batch/queueable）、CronTrigger（调度卡死）、最近部署记录——**根因定位的黄金证据**（异常时间点 × 变更记录对齐）无工具支撑 | P0（诊断向） |
| GAP-M6 | 无诊断方法学 skill | 工具即使补齐，agent 仍需要"症状分类 → 证据路径 → 假设树 → 引用证据的结论"的可复用方法论；`sfoa-crm-core` 只有数据完整性规则，无诊断决策树 | P0（skill 向） |
| GAP-M7 | 诊断账号能力前提未定义 | ApexLog 仅 owner 与持 View All Data 者可见；为他人设 TraceFlag 需要额外权限。DIAGNOSTIC 固定账号的最小权限清单需要扩展并文档化 | P0（前置） |
| GAP-M8 | 无 `get_org_limits` | 诊断"作业卡住/被跳过"时需要 governor 证据 | P1 |

### 4.3 结构与方法论层面（对标 Headless 360 的启发）
1. **Discover/Describe/Dispatch 模式**：官方用"4 个稳定工具 + 语义可发现的 operations 库"解决能力增长与上下文膨胀的矛盾。我们已有同构雏形（catalog + governance + playbook），**不必照搬**；但新工具设计应遵循"每个工具覆盖一类确定性操作，输出带完整性声明（truncated/coverage）"的既有契约风格。
2. **Skill 形态差异**：Headless 360 的 skills 是"可执行操作封装"；我们的 skills 是 markdown 行为指导。二者不冲突——正确策略是：**确定性部分做成工具（Runtime 保证正确），概率性方法做成 skill（引导 agent 推理）**。这正是 PROJECT_BASELINE 架构原则 5（Generic capabilities over business analysis）的延续。
3. **上游差距管理**：上游已到 60+ 工具而编目停在 13 个。建议把"定期上游编目刷新 + 新能力远程兼容性评估"固化为低频维护任务（不等于启用）。

---

## 5. 增强建议：详细计划清单

> 通用约束（适用于每一项）：
> - 请求级身份、default-deny、DML policy、P7 审计边界不动摇；新工具默认禁用，由 Admin 显式启用。
> - Upstream-first：能走官方 SDK（jsforce `Connection.*`）就不手写 REST；`run_soql_query` 增强走 **SFOA wrapper**（新建 SFOA 数据 Provider 包装官方实现能力），不修改官方 TypeScript 文件，差异登记 `UPSTREAM_STRATEGY.md`。
> - 全部经 P7 审计管道，输出契约携带 `truncated`/`coverage`/`done` 完整性事实。
> - 每项验收 Gate：单测 + 协议 + 治理（未启用不可见/不可调用）+ live SFoA + P0–P7 回归。

### 阶段 P9：数据完备性（对应目标 1）

| # | 交付项 | 设计要点 | 角色/治理 | 上游策略 |
| --- | --- | --- | --- | --- |
| P9-1 | `run_soql_query` SFOA 增强（wrapper） | 有界自动翻页（默认 maxRows=2000，Admin 可配置上限，建议 50k）；输出结构化 `{records, totalSize, fetched, done, truncated, truncationHint}`；超限时返回前 N 行 + 统计摘要 + "用 bulk query / 聚合"指引；查询错误结构化（errorCode + 修正建议）；检测聚合查询（GROUP BY/HAVING/COUNT）并放宽翻页 | READ / USER | EXTEND（SFOA wrapper，官方文件零改动） |
| P9-2 | `describe_sobject` + `describe_global` | jsforce `describe()/describeGlobal()`；对象模式输出字段（类型/label/nillable/createable/updateable/picklist/referenceTo/relationshipName）+ childRelationships；全局模式输出对象清单；有界截断 | READ / USER | 官方 SDK |
| P9-3 | `submit_bulk_query` + `get_bulk_query_results` | Bulk API 2.0：提交异步查询作业 → 轮询/取结果；默认只回样本 + totalSize，可选分页取全量；PK chunking 支持；作业配额不足时报结构化错误（配合 P9-4） | READ / USER | 官方 SDK（jsforce bulk） |
| P9-4 | `get_org_limits` | `Connection.limits()` 全量快照；重点标注 API/bulk 并发与日配额 | READ / USER | 官方 SDK |
| P9-5 | 聚合引导（skill + 工具描述） | 在 `sfoa-data-analysis` skill（见 P11-1）与工具描述中固化："先 COUNT/GROUP BY 估量，再决定明细路径"；声明聚合天然防截断 | — | — |
| P9-6 | `search_records`（SOSL） | `Connection.search()`；跨对象 FIND 子句；结果有界 | READ / USER | 官方 SDK |

**P9 里程碑验收**：对 10 万行级真实对象完成一次"全量统计 + 明细抽样"分析且数据完整性声明可审计（totalSize == fetched || truncated==true 且有续查指引）；agent 在无人工辅助下通过 describe 自修正常见 INVALID_FIELD。

### 阶段 P10：诊断深化（对应目标 2）

| # | 交付项 | 设计要点 | 角色/治理 | 上游策略 |
| --- | --- | --- | --- | --- |
| P10-0 | DIAGNOSTIC 账号权限清单扩展（前置） | 为 Debug Log 链路定义最小权限：View All Data（ApexLog 可见）、View Setup、为指定用户设置 TraceFlag 所需权限；ADR 记录与生产启用前提 | — | — |
| P10-1 | `set_trace_flag` | 为指定平台用户或 ApexClass 设置限时（≤60min）TraceFlag + 预置 DebugLevel（映射 Salesforce Developer Name）；自动清理过期 flag 的只读检查 | DIAGNOSTIC / METADATA 类 | Tooling API（官方 SDK） |
| P10-2 | `get_apex_logs` + `get_debug_log_body` | 按时间窗/用户/状态列 ApexLog；单条 log 全文有界截断返回；输出含异常类/堆栈行号的结构化摘要（服务端解析 log 头部） | DIAGNOSTIC | Tooling API |
| P10-3 | `explain_field_access` | 输入 objectApiName + fieldName(s)（可选 targetUserId，仅限路由内已配置用户）；一次聚合 describe createable/updateable + FieldPermissions + PermissionSet/Profile 归属 + RecordType 可见性；输出"可见/可编辑结论 + 授权来源链 + 冲突说明"；只读证据聚合，不做权限模拟引擎 | DIAGNOSTIC | Tooling API 聚合 |
| P10-4 | `list_metadata_components` | 按 metadataType 列组件（fullName、状态、lastModifiedBy/Date）；类型白名单可配置；有界分页 | DIAGNOSTIC | Metadata API listMetadata / Tooling query |
| P10-5 | `get_metadata_component_context` 类型扩展 | 增补 NamedCredential、CustomMetadata、CustomSetting、QuickAction、RecordType、EmailTemplate、DuplicateRule、AssignmentRule、AutoResponseRule、EscalationRule、SharingRule、Workflow、PermissionSet、Profile | DIAGNOSTIC | 沿用现有机制 |
| P10-6 | `get_platform_diagnostics` | 单调用聚合最近 N 小时（默认 24h，≤168h）：SetupAuditTrail（配置/权限变更溯源）、AsyncApexJob 失败清单、CronTrigger/QUEUED/SCHEDULED 卡滞、最近部署/变更；输出按时间线对齐的证据表 | DIAGNOSTIC | 标准 + Tooling API 聚合 |
| P10-7 | `sfoa-org-diagnostics` skill | 诊断决策树：症状分类（数据/权限/配置/代码/平台）→ 每类确定性工具路径 → 假设树 → 结论必须引用元数据证据（组件 fullName、log 行、审计条目）；含"异常时间点 × SetupAuditTrail 变更对齐"标准套路；与 P7 审计 Workbench 的 MCP 侧证据衔接 | — | — |

**P10 里程碑验收**：三条真实诊断场景闭环——(a) Apex 运行时异常：开 trace → 复现 → 拉 log → 定位类/行号；(b) 字段不可见：explain_field_access 输出授权来源链且结论与人工核对一致；(c) "昨天起流程行为异常"：SetupAuditTrail 时间线对齐出变更记录。

### 阶段 P11：分析体验与长线项

| # | 交付项 | 设计要点 | 角色/治理 |
| --- | --- | --- | --- |
| P11-1 | `sfoa-data-analysis` skill | 数据完整性契约：任何分析结论必须声明覆盖率（fetched/totalSize）；truncated 时的三条路径（聚合→bulk→缩窗）；聚合优先；Untrusted 字段内容规则；统计口径显式化 | — |
| P11-2 | `run_report` / `list_reports` | Analytics REST API 执行已保存报表（带过滤参数）；权限敏感，默认禁用 | READ / USER |
| P11-3 | 记录附件/长文本读取 | ContentVersion/Attachment 正文下载（有界）；EmailMessage 文本 | READ / USER |
| P11-4 | Playbook 升级 | 新工具写入 `get_agent_playbook`（版本号递增），保持 drift Gate | — |
| P11-5 | 上游编目刷新机制 | 固化低频任务：跟踪上游 v0.30.x 新 toolsets（Apex 匿名执行、DevOps Center 等），评估远程兼容性并更新 `OFFICIAL_PROVIDER_INVENTORY.md`（默认仍 deny） | — |
| P11-6 | （观察项）operations 库模式 | 若业务操作沉淀增多，评估 Headless 360 式 Discover/Describe/Dispatch 封装；需新 ADR | — |

### 优先级与依赖关系

```
P10-0（诊断账号权限）──┬──> P10-1 ──> P10-2 ──┐
                        │                       ├──> P10-7（诊断 skill 收口）
P9-1（查询增强）────────┼──> P10-3              │
P9-2（describe）────────┘                       │
P9-3（bulk）依赖 P9-4（limits 配额可见）        │
P9 全部 ────────────────────────────────────────┴──> P11-1（分析 skill 收口）
```

建议顺序：**P9-1 → P9-2 → P9-4 → P9-3 → P10-0 → P10-1/2 → P10-6 → P10-3 → P10-4/5 → P9-6 → P10-7 + P11-1 → P11 其余**。
理由：P9-1/P9-2 是两个目标共同的基础设施（查询修正、schema 自助），性价比最高；P10-0 是诊断链路的合规前提，必须先走 ADR。

---

## 6. 风险与边界提醒

1. **大数据集与 token 经济**：翻页增强会放大结果体积。必须坚持"结构化 + 有界 + 截断声明"，禁止无 maxRows 的全量回传；bulk 结果避免整段进上下文（样本 + 统计 + 指引）。
2. **DIAGNOSTIC 权限扩张**：View All Data 与代设 TraceFlag 是真实权限扩张，须经 ADR、生产默认关闭、Admin 显式启用、P7 审计覆盖每次调用。
3. **不要复制官方工具实现**：P9-1 走 wrapper 而非改官方文件；P9-2/3/4/6 全部基于官方 SDK——符合 UPSTREAM_STRATEGY 的 REUSE/EXTEND/SDK 顺序。
4. **`explain_field_access` 不是权限引擎**：只做只读证据聚合与归因展示，权限裁决永远在 Salesforce（Baseline 非目标 1 的红线）。
5. **DELETE/UPSERT 仍为 non-goal**：官方 Hosted MCP 有 Deletes 工具集，但不构成推翻 Baseline non-goal 的理由；如业务确实需要，走独立的 Baseline 变更 + ADR 流程。
6. **能力面不等于启用面**：P9/P10 工具全部 default-deny，实际启用节奏由 Admin 按用户路由与场景控制——这是与官方/社区 MCP 的本质差异，也是卖点。

---

## 7. 一页结论

- **现有能力 ≈ 交互面最小可信集**：数据读写骨架、变更就绪上下文、受限诊断、完整治理审计；**不是**全功能交互面。
- **目标 1（数据完整性）**：差"翻页 + bulk + describe + 聚合引导"四件套（P9），全部有官方 SDK 支撑，工程风险低、收益立竿见影。
- **目标 2（元数据诊断）**：差"debug log + 权限归因 + 变更溯源 + 诊断方法学 skill"四件套（P10），其中 P10-0 权限前提需先过 ADR。
- **对标结论**：治理与身份维度我们领先社区、对齐官方 Hosted MCP；数据与诊断工具面落后官方 Headless 360 与头部社区项目约一个版本代差，按本计划 P9→P10→P11 三阶段可在不破坏任何既有边界的前提下补齐。

---
name: sfoa-record-change
description: Salesforce CREATE/UPDATE 记录变更就绪与安全执行。新增、创建、修改记录时使用：Record Type、Dynamic Forms、必填字段、最小 Patch、Lookup/Picklist、Owner fallback、批量变更；配合 sfoa-crm-core，不用于纯查询。
---

# SFOA Record Change

指导修订：Skill-02B — UPDATE Readiness + Batch Mutation + Outcome Hardening。

本 Skill 是 `sfoa-crm-core` 的专业化补充：**sfoa-record-change inherits all hard rules from sfoa-crm-core**（Identity Boundary、Tool Governance、Salesforce Authority、Mutation Intent、Unknown Outcome、Untrusted Content、Result Integrity、Claim Scope <= Evidence Scope、Fact != Inference、Full Population Analytics）。本 Skill 只增加「这条记录是否可以安全写入」的判断，不重复 Core 的身份、治理、Web Trust 与分析规则。两者联合生效，业务 Agent 同时可见。

事实优先级：**Salesforce / MCP Runtime Fact > Agent Playbook > sfoa-record-change > Model Assumption**。本 Skill 不定义 Salesforce 真相，只定义如何发现真相、如何验证真相、何时还不能写、何时证据已经足够写。

范围：**Salesforce Record Mutation（CREATE + UPDATE，单条 + 批量）**。不做业务分析、系统诊断、报表、Delete 与 Metadata 管理；这些各有其 Skill 或明确不在范围内。

## Hard Rules

1. **CHANGE_READY Gate** — `CHANGE_READY != true` 时 **MUST NOT** 调用 `create_record`、`create_records`、`update_record` 或 `update_records`。`CHANGE_READY` 是 Agent 基于当前证据的逻辑判断，不是 Tool、不是 DB 状态、不是 Token。CREATE 与 UPDATE 共用这一个概念，判断条件不同。
2. **Context != Ready** — 调用过 `get_record_action_context` **只**证明已获取上下文，**MUST NOT** 据此认为表单已检查完成或记录已准备完整。就绪必须由证据支持，不能由 Tool 调用次数支持。
3. **UPDATE != CREATE** — CREATE 问「新记录是否完整到可以存在」；UPDATE 问「是否明确知道改哪条记录、改哪些字段，且只改这些字段」。**MUST NOT** 把一条最小 UPDATE 展开成完整 CREATE 表单，**MUST NOT** 重新索要客户 / 来源 / 计划交谈事项 / Owner 等 CREATE 侧字段。
4. **Target before Patch** — UPDATE 的第一个 Gate 是 `TARGET_RESOLVED`：必须能指出**唯一**目标 Salesforce Record。目标未唯一解析时 **MUST NOT** 生成或提交 Patch。
5. **Minimal Patch** — UPDATE payload **MUST** 只包含用户真正要求改变的字段，加当前 Runtime 明确要求的最小必要结构。**MUST NOT** 因为查询到了某字段就把整个记录重新提交。
6. **Read Facts != Mutation Intent** — 查询出字段值**不等于**用户要求修改它。只有用户明确要求修改、或该字段是本次 mutation 的真实必要组成，才可以进入 Patch。**MUST NOT** 「查到什么就写什么」。
7. **`Omitted != null`** — `未提供` / `null` / `false` / `0` / `""` 是五种不同事实。字段未出现表示**不修改**；`null` 只在用户明确表达清空 / 取消选择且 Runtime 允许时才发送；`false` 与 `0` 是显式值，**MUST NOT** 因为看起来像「空」而删除；`""` 必须按当前字段语义与 Tool Contract 判断，**MUST NOT** 自动等同于 `null`。
8. **CREATE Required != UPDATE Required** — 一个字段在创建时 `required`，不构成记录已存在时本次 UPDATE 的必填。**MUST NOT** 因为本次 Patch 没提交该字段就要求用户重新提供，除非当前 Runtime / Salesforce 证据证明本次 UPDATE 本身要求它。
9. **无 CREATE 默认重放** — 更新时 omission 的语义是 preserve current value。**MUST NOT** 把 CREATE default 重新应用到 UPDATE。
10. **UPDATE Owner 不做 fallback 注入** — 用户没有要求改 Owner 时 **MUST NOT** 注入当前用户或任何值。显式指定 Owner 失败时 **MUST NOT** 自动 fallback。
11. **不得猜测标识值** — **MUST NOT** 凭名字猜 Salesforce Record ID、**MUST NOT** 模型生成 ID、**MUST NOT** 猜测 Picklist API Value。三者都必须来自当前 Runtime / Salesforce 实时证据。
12. **Record Type 不静默变更** — 普通 UPDATE 沿用记录当前 Record Type，**MUST NOT** 自动修改 `RecordTypeId`。用户明确要求变更时，先解析当前允许的候选并验证，再按 Runtime 能力决定是否需要验证；当 Runtime 无法预判变更后的 Dynamic Forms 状态时，**MUST** 承认该能力边界，由 Salesforce / Runtime 作为最终 authority，**MUST NOT** 自行模拟。
13. **Target 歧义不猜测** — 0 match 时 `CHANGE_READY=false`，**MUST NOT** 创建新记录替代 UPDATE，**MUST NOT** 猜测。单条意图下 multiple match 时 **MUST** clarification，**MUST NOT** 选择第一条 / 最新一条 / 名字最像的一条。
14. **Target Population 完整性** — 用户明确要求「所有符合条件的记录」时，目标是 Target Population，**MUST** 先证明查询范围完整。**MUST NOT** 只查一部分、改这一部分、再宣称「全部已更新」。
15. **Record Type Gate（CREATE）** — 只有唯一可用候选时可直接采用；用户业务语言能唯一映射到当前实时候选时可直接采用；多个候选且无法唯一判断时 **MUST** 询问并保持 `CHANGE_READY=false`。**MUST NOT** 因为存在 Salesforce default Record Type 就静默替用户选择业务 Record Type。
16. **Required Checklist（CREATE）** — `visibilityState=VISIBLE` 且 `effectiveRequired=true` 且没有显式值且没有可信默认值满足时，**MUST** 进入 Missing Required Checklist 并询问。`apiRequired=true` 与 UI 可见性无关，始终必需。
17. **PENDING 必须继续解析** — 与本次 mutation 相关的 `visibilityState=PENDING` 必须处理：`dependsOn` 事实已知就写入 `draftFields` 并 refinement；未知就先询问依赖。**MUST NOT** 看见 PENDING 就忽略并直接 CREATE。
18. **UNKNOWN 不得猜测** — `UNKNOWN` 不等于 `PENDING`，也不等于 `VISIBLE` 或 `HIDDEN`。**MUST NOT** 把 UNKNOWN 推断成任何一种可见状态。
19. **Critical Dependency** — 影响本次字段是否 Required / Editable / Visible、Required Checklist、Lookup 或 Picklist 依赖、当前字段是否合法的 unresolved 依赖属于 Critical Dynamic Dependency；未稳定时 `CHANGE_READY=false`。
20. **HIDDEN 不追问** — `visibilityState=HIDDEN` 的字段 **MUST NOT** 询问、**MUST NOT** 推荐。
21. **Refinement 上限** — 遵守当前 Runtime 的真实 contract（`refinement` 0..3、`refinementLimitReached`）。达到上限仍存在影响本次 mutation 的关键 unresolved dependency 时 **MUST** 保持 `CHANGE_READY=false`，并如实说明当前页面条件无法充分解析。
22. **Initial Facts 不重复询问** — 用户 Prompt 已经明确给出的事实 **MUST NOT** 无故重复询问；先把它转成当前 Schema 可证明的字段写入 draft 或 Patch。
23. **Default 必须有实时证据** — 只有实时 Salesforce / Runtime 证明的默认值才算满足。**MUST NOT** 用 Skill 或模型自己猜的默认值，**MUST NOT** 把 Flow / Trigger 保存后才可能补的值当作当前 Required 已满足。
24. **Managed Field 不可覆盖** — 严格 managed 字段（`PLATFORM_IDENTITY`、`AI_CREATED_MARKER`）**MUST NOT** 询问、**MUST NOT** 填写、**MUST NOT** 覆盖，由 Runtime 负责。
25. **Owner Fallback（CREATE）** — `PLATFORM_IDENTITY_FALLBACK`：用户显式指定时用户值优先；CREATE 时用户未指定且字段 required 时，**MUST** 用用户能理解的语言说明「可以指定其他人，不指定就按当前用户处理」并等待回答；用户选择默认/当前用户/我自己时 **MUST** 省略该字段交由 Runtime fallback，**MUST NOT** 自行查询并写入 Salesforce User ID。
26. **显式值失败不得 fallback** — 用户显式指定的 Owner / Lookup 0 match 或 multiple match 时 **MUST** 保持 `CHANGE_READY=false`。**MUST NOT** 偷偷改用 platform fallback 或另一个候选。
27. **Lookup 歧义** — 只有唯一证明的 Salesforce ID 才可写入。DML 阶段被 Lookup Filter 拒绝时按 FAILED 处理，**MUST NOT** 自动寻找其他候选重试。
28. **Picklist 实时解析** — 与用户沟通优先 Label，DML payload **MUST** 使用当前 Salesforce 真实 API Value。**MUST NOT** 硬编码 Label → API Value 映射。Dependent Picklist 先解决 controller，再只看当前 controller 合法的候选。
29. **Editable 证据是 UPDATE 的核心** — UPDATE **MUST** 关注 `fieldUpdateable` 与 `layoutEditableForUpdate`。当前证据证明字段不可更新时 **MUST NOT** 提交该字段，并如实说明当前 Salesforce 上下文不允许修改。**MUST NOT** 绕过 UI context 直接试 DML 探测。UI editability 证据与 DML authority 的关系以当前真实 Runtime Contract 为准。
30. **Evidence Completeness** — Tool result 明确表示 truncated / omitted / response incomplete / required evidence unavailable 时，**MUST NOT** 宣称所有 Required Fields 已验证完成，也 **MUST NOT** 在此之上给出 `CHANGE_READY=true`。区分 Evidence Delivery Incomplete 与 Runtime Coverage Partial。
31. **Batch 独立就绪** — 计划内每条记录独立判断 `CHANGE_READY`。只要还有一条未 ready，默认先不 dispatch 本批，**MUST NOT** 让用户仍在补充记录 C 时 A / B 已经产生 Salesforce 副作用，除非用户明确要求先处理可处理的部分。
32. **Batch 不得重放成功项** — `PARTIAL_SUCCESS` 时已成功项已经提交，**MUST NOT** 整批重发；只重新准备真实失败项，且必须先确认原 Mutation Intent 仍然有效。
33. **OUTCOME_UNKNOWN 不重放** — `OUTCOME_UNKNOWN` / `MCP_DML_OUTCOME_UNKNOWN` **MUST NOT** 自动重复 CREATE 或 UPDATE。只有真实独立证据才能把 UNKNOWN 改成 SUCCESS 或 FAILED，否则保持 UNKNOWN。
34. **Current State != Transaction Outcome** — 回读发现当前状态已满足期望值，最多证明**当前 desired state 已满足**，不一定证明刚才那次 transaction 成功。**MUST NOT** 把 Current State Evidence 当作 Transaction Outcome Evidence，也 **MUST NOT** 因为 UPDATE「看起来幂等」就自动重试（重复 UPDATE 可能再次触发 Flow / Trigger / Automation / Integration / Audit / Notification）。
35. **Mutation Intent 不扩大** — 用户没有要求的字段（尤其 Owner 与 Record Type）**MUST NOT** 为了「补全」而写入。CREATE 真正必需的 Required / Default 除外，且必须来自 Runtime authority。
36. **不硬编码** — **MUST NOT** 硬编码 Salesforce Required Fields、Record Type ID / DeveloperName、Picklist API Value、Lookup ID、Record ID、Owner ID 或公司字段业务规则；一切从当前 Runtime / Salesforce 实时发现。
37. **Salesforce 最终权威** — 尊重 Validation Rule、FLS、Sharing、Lookup Filter、Flow、Trigger、CRUD 与 Native Permission 的最终裁决。Skill 与 Playbook 都不能提升权限。

## CREATE 与 UPDATE 的关键差异

| 维度 | CREATE | UPDATE |
| --- | --- | --- |
| 关心的问题 | 新记录是否完整到可以存在 | 目标与字段是否明确、合法，且只有这些字段 |
| 第一个 Gate | Object / Record Type 解析 | `TARGET_RESOLVED`（唯一目标记录） |
| Action Context | `action=CREATE`，可用 `draftFields` / `refinement` | `action=UPDATE`，**必须**带 `recordId`；`draftFields` / `refinement` 被 Runtime 拒绝 |
| 核心 editable 证据 | `effectiveEditable`（Dynamic Forms） | `fieldUpdateable` / `layoutEditableForUpdate` |
| Required 语义 | 创建必需必须满足 | 创建必需**不**自动成为更新必需 |
| 默认值 | Create Defaults 可用 | UPDATE 不返回 defaults；omission = preserve |
| Record Type | 需要解析并选择 | 沿用记录当前 Record Type，不静默变更 |
| Owner fallback | CREATE 时按策略可用 | **不注入**；仅用户显式要求时才解析 |
| 批量语义 | 新建多条 | 每条可有**不同** Patch，不得互相复制字段 |

UPDATE 的 Dynamic Forms 预计算当前 **不可用**：Runtime 无法给出变更后 hypothetical 的 UI 状态。**MUST** 承认这一能力边界，由 Salesforce Validation / Flow / Trigger / Lookup Filter / DML Runtime 作为最终 authority，**MUST NOT** 用模型猜测补齐。

## CHANGE_READY 摘要

```text
CREATE:
Intent 明确 + Object 明确 + Record Type 已解析 + Effective Context 足以判断
+ Required Checklist 为空 + 提交字段可 create + Lookup 唯一 + Picklist 已归一
+ Managed 策略满足 + 证据完整 + Patch 与意图一致

UPDATE:
Intent 明确 + Object 明确 + TARGET_RESOLVED + Mutation scope 明确
+ Patch 只含意图字段 + 提交字段按当前证据 allowed/editable
+ Lookup 歧义已解决 + Picklist 已归一 + Managed 策略满足
+ Record Type 意图已解析（当适用）+ 无 critical 证据缺口 + Patch 与意图一致
```

所有 blocking condition 消失时 `CHANGE_READY=true`，此时才允许调用写入 Tool。完整阻塞清单见 [readiness-gate.md](references/readiness-gate.md)。

## 何时加载

创建、新增、修改、更新 Salesforce 记录；发起或变更申请；创建拜访申请、客户、商机；批量创建或批量更新同类记录；需要判断一次 CREATE / UPDATE 是否已经准备完成。

纯查询、统计、分析、诊断、闲聊、数学与一般网页搜索不要加载本 Skill；这些场景只需 Core。当请求同时包含读取与写入时，读取部分按 Core 执行，写入部分按本 Skill 的 Gate 执行。

本 Skill **不覆盖** Delete、Upsert、Merge、Metadata 管理与业务分析。遇到这些请求时如实说明边界，**MUST NOT** 用其他 Tool 变相实现。

## Guidelines / Heuristics

复杂 CREATE 优先考虑当前 `get_agent_playbook`；有效的 Playbook、Action Context 与 Record Context 可以在可信生命周期内复用，不必每轮重复获取。简单 UPDATE 如果当前已有足够新、足够可信的证据，允许复用而不必重新拉取全部 Context —— 这是 Guideline，不是 Hard Workflow。

什么时候需要重新查询 Record、什么时候 Context 仍可复用、什么时候一个简单 UPDATE 不需要复杂 Context、什么时候多个 clarification 可以合并、是否适合 singular / plural Tool、什么时候需要记录 before-state、什么时候需要向用户说明 broad batch impact、哪个 optional 字段值得提醒，均由 Agent 自主判断。

尽量在**当前 dependency layer 已经稳定**之后合并询问这一层真正缺失的字段；不要在还缺少前置条件时提前猜测并追问后续字段，也不要机械追求「整次 mutation 只能问一次」。用户明确说「把日期改成明天」本身已经是 Mutation Intent，**MUST NOT** 每次都要问「您确定吗」。只有目标范围不明确、范围来自模型推断、高影响字段、用户表达含糊、或 Patch 超出原始意图时才需要 clarification。

只有 Runtime evidence 才能提升事实可信度。用业务 Label 与用户沟通，重要 fallback / default 用用户能理解的语言说明，减少无意义 Tool Call。

## 按需要读取 references

- 就绪模型与全部阻塞条件（CREATE + UPDATE）：[readiness-gate.md](references/readiness-gate.md)
- CREATE 就绪、Initial Facts、Record Type、Required Checklist：[create-readiness.md](references/create-readiness.md)
- UPDATE 就绪、Target Resolution、Minimal Patch、Required/Default/Owner/Record Type：[update-readiness.md](references/update-readiness.md)
- Dynamic Forms 四态、PENDING、UNKNOWN、refinement、证据完整性：[dynamic-forms.md](references/dynamic-forms.md)
- Managed 字段与 Owner fallback：[managed-lookups.md](references/managed-lookups.md)
- Lookup 与 Picklist 解析：[lookup-and-picklist.md](references/lookup-and-picklist.md)
- 批量变更：分组、上限、分批、allOrNone、逐条就绪：[batch-mutations.md](references/batch-mutations.md)
- 写入结果、PARTIAL_SUCCESS、UNKNOWN 与核对：[outcome-reconciliation.md](references/outcome-reconciliation.md)

这些参考资料按任务使用，无需每轮全部读取。当前 Tool Schema、Tool Governance、Playbook 与 Salesforce 返回始终高于本 Skill 的任何描述；若本 Skill 与当前代码或运行时事实冲突，以运行时事实为准，并把差异当作 Runtime Defect 记录，而不是靠 Prompt 掩盖。

---
name: sfoa-record-change
description: Salesforce CREATE/UPDATE 记录变更就绪与安全执行。新增、创建、修改记录时使用：Record Type、Dynamic Forms、必填字段、最小 Patch、Lookup/Picklist、Owner fallback、批量变更、附件上传；配合 sfoa-crm-core，不用于纯查询。
---

# SFOA Record Change

指导修订：业务任务自主处理、材料提炼、关联补全与 Minimal Patch。

材料写入先读正文，再按字段 Label、帮助文本与类型分配：总结组织整体事实与进展，诉求记录客户明确期望或异议，后续计划记录待执行行动。不要把单纯的测试进度、数量未定等现状反复填进“客户诉求”，也不要把同一素材段落换几个词复制到全部字段。“样品还在测试”不是“测试通过”；“下周联系”保留时间窗口，不编造具体承诺日。

地域补全先分清公司所在地与拜访/收货等地点。明确迁址可联动改正省市；仅填空且现有公司地址与材料地名冲突时，先用上下文核对地点角色，仍无法消除冲突就集中询问。不能自行认定 CRM 旧值优先、材料一定只是拜访地，或把填空默认为迁址后先写再问。

用户授权的是业务任务：自主理解材料和上下文，选择适合字段，忠实提炼、语言优化、分类、标准化与可靠关联补全；任务相关 optional 和关联字段可以直接进入 CREATE/UPDATE payload，不以逐字段点名为前提。先利用已有信息和可用工具，仍有实质歧义、关键冲突或必须由用户决定的业务选择时才问。共同原则由当前可用的 sfoa-crm-core 承载；具体操作见 [材料与关联字段](references/material-and-related-fields.md)。

本 Skill 是 `sfoa-crm-core` 的专业化补充：**sfoa-record-change inherits all hard rules from sfoa-crm-core**（Identity Boundary、Tool Governance、Salesforce Authority、Mutation Intent、Unknown Outcome、Untrusted Content、Result Integrity、Claim Scope <= Evidence Scope、Fact != Inference、Full Population Analytics）。本 Skill 只增加「这条记录是否可以安全写入」的判断，不重复 Core 的身份、治理、Web Trust 与分析规则。两者联合生效，业务 Agent 同时可见。

事实优先级：**Salesforce / MCP Runtime Fact > Agent Playbook > sfoa-record-change > Model Assumption**。本 Skill 不定义 Salesforce 真相，只定义如何发现真相、如何验证真相、何时还不能写、何时证据已经足够写。

范围：**Salesforce Record Mutation（CREATE + UPDATE，单条 + 批量）**，以及**把平台已收到的文件附加到一条已存在的记录**（`upload_files_to_record`，独立授权 `attachmentEnabled`）。不做业务分析、系统诊断、报表、Delete 与 Metadata 管理；这些各有其 Skill 或明确不在范围内。

## Hard Rules

1. **CHANGE_READY Gate** — `CHANGE_READY != true` 时 **MUST NOT** 调用 `create_record`、`create_records`、`update_record` 或 `update_records`。`CHANGE_READY` 是 Agent 基于当前证据的逻辑判断，不是 Tool、不是 DB 状态、不是 Token。CREATE 与 UPDATE 共用这一个概念，判断条件不同。
2. **Context != Ready** — 调用过 `get_record_action_context` **只**证明已获取上下文，**MUST NOT** 据此认为表单已检查完成或记录已准备完整。就绪必须由证据支持，不能由 Tool 调用次数支持。
3. **UPDATE != CREATE** — CREATE 判断新记录能否完整存在；UPDATE 先解析目标与业务任务，再准备完成任务需要实际变化的字段。不要把局部 UPDATE 展开成完整 CREATE 表单。
4. **Target before Patch** — UPDATE 的第一个 Gate 是 `TARGET_RESOLVED`：必须能指出**唯一**目标 Salesforce Record。目标未唯一解析时 **MUST NOT** 生成或提交 Patch。
5. **Minimal Patch** — 只提交完成本次业务任务实际需要改变的字段，可含直接提供、忠实提炼、可靠关联推导的字段；不等于只提交用户念出的字段名，也不追求字段数量最少。不得复制整条查询记录重写；已知未变化字段不重发。
6. **Read Facts != Mutation Intent** — 已读材料、适用上下文和查询结果可用于完成已授权业务任务，包括任务相关 optional 与关联字段；查询到无关字段不构成修改理由。用户明确说「只改总结，其他不动」时按其限定执行。
7. **`Omitted != null`** — `未提供` / `null` / `false` / `0` / `""` 是五种不同事实。字段未出现表示**不修改**；`null` 只在用户明确表达清空 / 取消选择且 Runtime 允许时才发送；`false` 与 `0` 是显式值，**MUST NOT** 因为看起来像「空」而删除；`""` 必须按当前字段语义与 Tool Contract 判断，**MUST NOT** 自动等同于 `null`。
8. **CREATE Required != UPDATE Required** — 一个字段在创建时 `required`，不构成记录已存在时本次 UPDATE 的必填。**MUST NOT** 因为本次 Patch 没提交该字段就要求用户重新提供，除非当前 Runtime / Salesforce 证据证明本次 UPDATE 本身要求它。
9. **无 CREATE 默认重放** — 更新时 omission 的语义是 preserve current value。**MUST NOT** 把 CREATE default 重新应用到 UPDATE。
10. **UPDATE Owner 不重放 fallback** — CREATE fallback 不用于无关 UPDATE。业务任务涉及责任归属时可依据已验证事实解析；显式指定但解析失败的负责人不得偷换为当前用户。
11. **不得猜测标识值** — **MUST NOT** 凭名字猜 Salesforce Record ID、**MUST NOT** 模型生成 ID、**MUST NOT** 猜测 Picklist API Value。三者都必须来自当前 Runtime / Salesforce 实时证据。
12. **Record Type 与任务一致** — 普通 UPDATE 沿用当前 Record Type，不因顺带补全更改；业务任务确实涉及类型变化时，结合任务、真实候选与可用事实解析。当前 Runtime 不提供 UPDATE 后 Dynamic Forms 预计算，不自行模拟。
13. **Target 歧义先补证** — 0 match 不猜 ID、不创建替代 UPDATE；多个候选先用已有主体和业务事实缩小范围，仍不能唯一确定时才集中澄清，不取第一条/最新一条。
14. **Target Population 完整性** — 用户明确要求「所有符合条件的记录」时，目标是 Target Population，**MUST** 先证明查询范围完整。**MUST NOT** 只查一部分、改这一部分、再宣称「全部已更新」。
15. **Record Type Gate（CREATE）** — 结合业务任务、当前候选标签/描述及适用默认自主确定类型；多候选本身不要求提问，仍有实质业务歧义才问。保留先确定类型、再取得该类型字段的技术依赖，不强制两轮用户对话。
16. **Required Checklist（CREATE）** — `visibilityState=VISIBLE` 且 `effectiveRequired=true` 且没有合规任务草稿值（直接提供、忠实提炼或可靠关联）且没有可信默认值满足，先用可用读取补足，真正缺关键事实时，**MUST** 进入 Missing Required Checklist 并询问。`apiRequired=true` 与 UI 可见性无关，始终必需。
17. **PENDING 继续解析** — 与任务相关的依赖，优先复用材料、上下文与可用工具；已知值进入 draftFields 后 refinement，真正仍缺失且关键时再问。不要忽略影响本次提交的未决依赖。
18. **UNKNOWN 不得猜测** — `UNKNOWN` 不等于 `PENDING`，也不等于 `VISIBLE` 或 `HIDDEN`。**MUST NOT** 把 UNKNOWN 推断成任何一种可见状态。
19. **Critical Dependency** — 影响本次字段是否 Required / Editable / Visible、Required Checklist、Lookup 或 Picklist 依赖、当前字段是否合法的 unresolved 依赖属于 Critical Dynamic Dependency；未稳定时 `CHANGE_READY=false`。
20. **HIDDEN 不追问** — `visibilityState=HIDDEN` 的字段 **MUST NOT** 询问、**MUST NOT** 推荐。
21. **Refinement 上限** — 遵守当前 Runtime 的真实 contract（`refinement` 0..3、`refinementLimitReached`）。达到上限仍存在影响本次 mutation 的关键 unresolved dependency 时 **MUST** 保持 `CHANGE_READY=false`，并如实说明当前页面条件无法充分解析。
22. **Initial Facts 不重复询问** — 从提示、实际已读材料、适用上下文提炼业务事实，可靠关联结果也可进入当前真实字段的 draft/Patch。已知信息不重复问；附件引用或上传成功不证明已读正文。
23. **Default 必须有实时证据** — 只有实时 Salesforce / Runtime 证明的默认值才算满足。**MUST NOT** 用 Skill 或模型自己猜的默认值，**MUST NOT** 把 Flow / Trigger 保存后才可能补的值当作当前 Required 已满足。
24. **Managed Field 不可覆盖** — 严格 managed 字段（`PLATFORM_IDENTITY`、`AI_CREATED_MARKER`）**MUST NOT** 询问、**MUST NOT** 填写、**MUST NOT** 覆盖，由 Runtime 负责。
25. **Owner Fallback（CREATE）** — 已配置且适用的 PLATFORM_IDENTITY_FALLBACK 在无相反要求时直接采用：省略字段交给 Runtime，无需固定询问一次。任务指定其他责任人时先解析真实 Lookup ID；不自己查询当前用户 ID 来模拟平台身份。
26. **指定值失败不得 fallback** — 任务指定的 Owner / Lookup 未唯一解析时，先补足可用证据，剩余歧义才问；未解决时不得偷偷改用 platform fallback 或另一个候选。
27. **Lookup 歧义** — 只有唯一证明的 Salesforce ID 才可写入。DML 阶段被 Lookup Filter 拒绝时按 FAILED 处理，**MUST NOT** 自动寻找其他候选重试。
28. **Picklist 实时解析** — 与用户沟通优先 Label，DML payload **MUST** 使用当前 Salesforce 真实 API Value。**MUST NOT** 硬编码 Label → API Value 映射。Dependent Picklist 先解决 controller，再只看当前 controller 合法的候选。
29. **Editable 证据是 UPDATE 的核心** — UPDATE **MUST** 关注 `fieldUpdateable` 与 `layoutEditableForUpdate`。当前证据证明字段不可更新时 **MUST NOT** 提交该字段，并如实说明当前 Salesforce 上下文不允许修改。**MUST NOT** 绕过 UI context 直接试 DML 探测。UI editability 证据与 DML authority 的关系以当前真实 Runtime Contract 为准。
30. **Evidence Completeness** — Tool result 的 truncated / omitted / response incomplete / required evidence unavailable 影响本次必填、提交字段合法性、唯一性或适用依赖时，**MUST NOT** 宣称所有 Required Fields 已验证完成，也 **MUST NOT** 在此之上给出 `CHANGE_READY=true`。区分 Evidence Delivery Incomplete 与 Runtime Coverage Partial。
31. **Batch 独立就绪** — 计划内每条记录独立判断 `CHANGE_READY`。只要还有一条未 ready，默认先不 dispatch 本批，**MUST NOT** 让用户仍在补充记录 C 时 A / B 已经产生 Salesforce 副作用，除非用户明确要求先处理可处理的部分。
32. **Batch 不得重放成功项** — `PARTIAL_SUCCESS` 时已成功项已经提交，**MUST NOT** 整批重发；只重新准备真实失败项，且必须先确认原 Mutation Intent 仍然有效。
33. **OUTCOME_UNKNOWN 不重放** — `OUTCOME_UNKNOWN` / `MCP_DML_OUTCOME_UNKNOWN` **MUST NOT** 自动重复 CREATE 或 UPDATE。只有真实独立证据才能把 UNKNOWN 改成 SUCCESS 或 FAILED，否则保持 UNKNOWN。
34. **Current State != Transaction Outcome** — 回读发现当前状态已满足期望值，最多证明**当前 desired state 已满足**，不一定证明刚才那次 transaction 成功。**MUST NOT** 把 Current State Evidence 当作 Transaction Outcome Evidence，也 **MUST NOT** 因为 UPDATE「看起来幂等」就自动重试（重复 UPDATE 可能再次触发 Flow / Trigger / Automation / Integration / Audit / Notification）。

36. **不硬编码** — **MUST NOT** 硬编码 Salesforce Required Fields、Record Type ID / DeveloperName、Picklist API Value、Lookup ID、Record ID、Owner ID 或公司字段业务规则；一切从当前 Runtime / Salesforce 实时发现。
37. **Salesforce 最终权威** — 尊重 Validation Rule、FLS、Sharing、Lookup Filter、Flow、Trigger、CRUD 与 Native Permission 的最终裁决。Skill 与 Playbook 都不能提升权限。

## CREATE 与 UPDATE 的关键差异

| 维度 | CREATE | UPDATE |
| --- | --- | --- |
| 关心的问题 | 新记录是否完整到可以存在 | 目标与业务任务是否明确，实际变化字段是否适用且有依据 |
| 第一个 Gate | Object / Record Type 解析 | `TARGET_RESOLVED`（唯一目标记录） |
| Action Context | `action=CREATE`，可用 `draftFields` / `refinement` | `action=UPDATE`，**必须**带 `recordId`；`draftFields` / `refinement` 被 Runtime 拒绝 |
| 核心 editable 证据 | `effectiveEditable`（Dynamic Forms） | `fieldUpdateable` / `layoutEditableForUpdate` |
| Required 语义 | 创建必需必须满足 | 创建必需**不**自动成为更新必需 |
| 默认值 | Create Defaults 可用 | UPDATE 不返回 defaults；omission = preserve |
| Record Type | 需要解析并选择 | 沿用记录当前 Record Type，不静默变更 |
| Owner fallback | CREATE 时按策略可用 | 不重放 CREATE fallback；任务相关的责任变更按可靠事实解析 |
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
+ Patch 只含完成业务任务实际需要的变化字段 + 提交字段按当前证据 allowed/editable
+ Lookup 歧义已解决 + Picklist 已归一 + Managed 策略满足
+ Record Type 意图已解析（当适用）+ 无 critical 证据缺口 + Patch 与意图一致
```

所有 blocking condition 消失时 `CHANGE_READY=true`，此时才允许调用写入 Tool。完整阻塞清单见 [readiness-gate.md](references/readiness-gate.md)。

## 何时加载

创建、新增、修改、更新 Salesforce 记录；发起或变更申请；创建拜访申请、客户、商机；批量创建或批量更新同类记录；需要判断一次 CREATE / UPDATE 是否已经准备完成；用户发来文件并希望它落到某条记录上（用 `upload_files_to_record`，对象需已开启附件上传，见 [file-attachments.md](references/file-attachments.md)）。

纯查询、统计、分析、诊断、闲聊、数学与一般网页搜索不要加载本 Skill；这些场景不加载 record-change，按任务使用实际可用的 sfoa-org-diagnostics 或 sfoa-data-analysis，并配合 Core。当请求同时包含读取与写入时，读取部分按 Core 执行，写入部分按本 Skill 的 Gate 执行。

本 Skill **不覆盖** Delete、Upsert、Merge、Metadata 管理与业务分析。遇到这些请求时如实说明边界，**MUST NOT** 用其他 Tool 变相实现。

## Guidelines / Heuristics

复杂 CREATE 优先考虑当前 `get_agent_playbook`；有效的 Playbook、Action Context 与 Record Context 可以在可信生命周期内复用，不必每轮重复获取。简单 UPDATE 如果当前已有足够新、足够可信的证据，允许复用而不必重新拉取全部 Context —— 这是 Guideline，不是 Hard Workflow。

什么时候需要重新查询 Record、什么时候 Context 仍可复用、什么时候一个简单 UPDATE 不需要复杂 Context、什么时候多个 clarification 可以合并、是否适合 singular / plural Tool、什么时候需要记录 before-state、什么时候需要向用户说明 broad batch impact、哪个 optional 字段值得提醒，均由 Agent 自主判断。

业务目标已授权时，忠实提炼与可靠关联推导可直接写入。目标、关键事实或业务选择仍有实质歧义时才 clarification。

材料正文、适用上下文及可核验关联均可提供业务事实；Salesforce / Runtime 决定真实字段、存储值、权限与执行结果。

## 按需要读取 references

- 就绪模型与全部阻塞条件（CREATE + UPDATE）：[readiness-gate.md](references/readiness-gate.md)
- CREATE 就绪、Initial Facts、Record Type、Required Checklist：[create-readiness.md](references/create-readiness.md)
- UPDATE 就绪、Target Resolution、Minimal Patch、Required/Default/Owner/Record Type：[update-readiness.md](references/update-readiness.md)
- Dynamic Forms 四态、PENDING、UNKNOWN、refinement、证据完整性：[dynamic-forms.md](references/dynamic-forms.md)
- Managed 字段与 Owner fallback：[managed-lookups.md](references/managed-lookups.md)
- Lookup 与 Picklist 解析：[lookup-and-picklist.md](references/lookup-and-picklist.md)
- 批量变更：分组、上限、分批、allOrNone、逐条就绪：[batch-mutations.md](references/batch-mutations.md)
- 附件上传：`upload_files_to_record`、attachmentRef 归属、逐文件结果：[file-attachments.md](references/file-attachments.md)
- 写入结果、PARTIAL_SUCCESS、UNKNOWN 与核对：[outcome-reconciliation.md](references/outcome-reconciliation.md)

这些参考资料按任务使用，无需每轮全部读取。当前 Tool Schema、Tool Governance、Playbook 与 Salesforce 返回始终高于本 Skill 的任何描述；若本 Skill 与当前代码或运行时事实冲突，以运行时事实为准，并把差异当作 Runtime Defect 记录，而不是靠 Prompt 掩盖。

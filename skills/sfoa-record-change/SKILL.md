---
name: sfoa-record-change
description: Salesforce CREATE/UPDATE 记录变更就绪与安全执行。新增、创建、修改记录时使用：Record Type、Dynamic Forms、必填字段、最小 Patch、Lookup/Picklist、Owner fallback、批量变更、附件上传；配合 sfoa-crm-core，不用于纯查询。
display_name: "CRM 记录新建与修改"
display_name_en: "CRM Record Create & Update"
---

# CRM 记录新建与修改（SFoA Record Change）

指导修订：1.15.0 — 按钮动作（Quick Action）必填优先、缺失必填的询问与「无」确认、子表与参与人按真实结构落地。

按任务理解动作 → 综合实际已读材料 → 取得当前对象/Record Type/所选表单事实 → 映射与关联 → 适用查重 → 解决剩余实质歧义 → 执行和回执。CREATE/UPDATE 使用 `formContext`，默认标准入口；具体见 [精确表单流程](references/precise-forms.md)。可复用仍适用的上下文，但 CREATE 前 **MUST** 满足 Hard Rule 45 的«本次表单证据»；查询、纯附件或诊断不进入该表单流程。事前申请与事后纪要依据真实元数据和时态区分，不固定对象或三字段模板。多条收集时遵守“等我说完”；创建后补充/更正/归档沿工具证明的目标继续，不重新建单。

工具结果被客户端截断时，不把可见片段当完整字段表。利用已有字段定义，按任务调用 `get_record_action_context.fieldApiNames` 缩小响应；必填/条件必填与已知控制依赖仍保留，遗漏与未知字段在 coverage.fieldProjection 中说明。相关 Picklist 续取仍用 nextValueOffset，不为无关字段重复读取完整上下文。

材料写入先读正文，再按字段 Label、帮助文本与类型分配：总结组织整体事实与进展，诉求记录客户明确期望或异议，后续计划记录待执行行动。不要把单纯的测试进度、数量未定等现状反复填进“客户诉求”，也不要把同一素材段落换几个词复制到全部字段。“样品还在测试”不是“测试通过”；“下周联系”保留时间窗口，不编造具体承诺日。

地域补全先分清公司所在地与拜访/收货等地点。明确迁址可联动改正省市；仅填空且现有公司地址与材料地名冲突时，先用上下文核对地点角色，仍无法消除冲突就集中询问。不能自行认定 CRM 旧值优先、材料一定只是拜访地，或把填空默认为迁址后先写再问。

用户授权的是业务任务：自主理解材料和上下文，选择适合字段，忠实提炼、语言优化、分类、标准化与可靠关联补全；任务相关 optional 和关联字段可以直接进入 CREATE/UPDATE payload，不以逐字段点名为前提。先利用已有信息和可用工具，仍有实质歧义、关键冲突或必须由用户决定的业务选择时才问。共同原则由当前可用的 sfoa-crm-core 承载；具体操作见 [材料与关联字段](references/material-and-related-fields.md)。

本 Skill 是 `sfoa-crm-core` 的专业化补充：**sfoa-record-change inherits all hard rules from sfoa-crm-core**（Identity Boundary、Tool Governance、Salesforce Authority、Mutation Intent、Unknown Outcome、Untrusted Content、Result Integrity、Claim Scope <= Evidence Scope、Fact != Inference、Full Population Analytics）。本 Skill 只增加「这条记录是否可以安全写入」的判断，不重复 Core 的身份、治理、Web Trust 与分析规则。两者联合生效，业务 Agent 同时可见。

事实优先级：**Salesforce / MCP Runtime Fact > Agent Playbook > sfoa-record-change > Model Assumption**。本 Skill 不定义 Salesforce 真相，只定义如何发现真相、如何验证真相、何时还不能写、何时证据已经足够写。

范围：**Salesforce Record Mutation（CREATE + UPDATE，单条 + 批量）**，以及**把平台已收到的文件附加到一条已存在的记录**（`upload_files_to_record`，独立授权 `attachmentEnabled`）。不做业务分析、系统诊断、报表、Delete 与 Metadata 管理；这些各有其 Skill 或明确不在范围内。

## Hard Rules

1. **CHANGE_READY Gate** — `CHANGE_READY != true` 时 **MUST NOT** 调用 `create_record`、`create_records`、`update_record` 或 `update_records`。`CHANGE_READY` 是 Agent 基于当前证据的逻辑判断，不是 Tool、不是 DB 状态、不是 Token。CREATE 与 UPDATE 共用这一个概念，判断条件不同。
2. **Context != Ready** — 调用过 `get_record_action_context` **只**证明已获取上下文，**MUST NOT** 据此认为表单已检查完成或记录已准备完整。就绪必须由证据支持，不能由 Tool 调用次数支持。
3. **UPDATE != CREATE** — CREATE 判断新记录能否完整存在；UPDATE 先解析目标与业务任务，合并保存值检查所选 Edit 表单全部适用必填，再只提交实际变化字段。不要把局部 UPDATE 展开成完整 CREATE 表单；历史已空的 Edit 必填仍需补足。
4. **Target before Patch** — UPDATE 的第一个 Gate 是 `TARGET_RESOLVED`：必须能指出**唯一**目标 Salesforce Record。目标未唯一解析时 **MUST NOT** 生成或提交 Patch。
5. **Minimal Patch** — 只提交完成本次业务任务实际需要改变的字段，可含直接提供、忠实提炼、可靠关联推导的字段；不等于只提交用户念出的字段名，也不追求字段数量最少。不得复制整条查询记录重写；标准 UPDATE 的已知未变化字段不重发。原生 Quick Action 为覆盖动作预设所需的明确值，即使等于保存值也必须保留，不能当作无变化删除。
6. **Read Facts != Mutation Intent** — 已读材料、适用上下文和查询结果可用于完成已授权业务任务，包括任务相关 optional 与关联字段；查询到无关字段不构成修改理由。用户明确说「只改总结，其他不动」时按其限定执行。
7. **`Omitted != null`** — `未提供` / `null` / `false` / `0` / `""` 是五种不同事实。字段未出现表示**不修改**；`null` 只在用户明确表达清空 / 取消选择且 Runtime 允许时才发送；`false` 与 `0` 是显式值，**MUST NOT** 因为看起来像「空」而删除；`""` 必须按当前字段语义与 Tool Contract 判断，**MUST NOT** 自动等同于 `null`。
8. **CREATE Required != UPDATE Required** — 一个字段在创建时 `required`，不构成记录已存在时本次 UPDATE 的必填。**MUST NOT** 因为本次 Patch 没提交该字段就要求用户重新提供，除非当前 Runtime / Salesforce 证据证明本次 UPDATE 本身要求它。
9. **无 CREATE 默认重放** — 更新时 omission 的语义是 preserve current value。**MUST NOT** 把 CREATE default 重新应用到 UPDATE。
10. **UPDATE Owner 不重放 fallback** — CREATE fallback 不用于无关 UPDATE。业务任务涉及责任归属时可依据已验证事实解析；显式指定但解析失败的负责人不得偷换为当前用户。
11. **不得猜测标识值** — **MUST NOT** 凭名字猜 Salesforce Record ID、**MUST NOT** 模型生成 ID、**MUST NOT** 猜测 Picklist API Value。三者都必须来自当前 Runtime / Salesforce 实时证据。
12. **Record Type 与任务一致** — 普通 UPDATE 沿用当前 Record Type，不因顺带补全更改。`formContext` 可计算当前类型下保存值与草稿的 Edit 状态；类型切换后的假设表单仍不支持。任务涉及类型变化时说明能力边界，不自行模拟或静默改走其他入口。
13. **Target 歧义先补证** — 0 match 不猜 ID、不创建替代 UPDATE；多个候选先用已有主体和业务事实缩小范围，仍不能唯一确定时才集中澄清，不取第一条/最新一条。
14. **Target Population 完整性** — 用户明确要求「所有符合条件的记录」时，目标是 Target Population，**MUST** 先证明查询范围完整。**MUST NOT** 只查一部分、改这一部分、再宣称「全部已更新」。
15. **Record Type Gate（CREATE）** — 结合业务任务、当前候选标签/描述及适用默认自主确定类型；多候选本身不要求提问，仍有实质业务歧义才问。保留先确定类型、再取得该类型字段的技术依赖，不强制两轮用户对话。
16. **Required Checklist（CREATE）** — `visibilityState=VISIBLE` 且 `effectiveRequired=true` 且没有合规任务草稿值（直接提供、忠实提炼或可靠关联）且没有可信默认值满足，先用可用读取补足，真正缺关键事实时，**MUST** 进入 Missing Required Checklist 并询问。`apiRequired=true` 与 UI 可见性无关，始终必需。
17. **PENDING 继续解析** — 与任务相关的依赖，优先复用材料、上下文与可用工具；已知值进入 draftFields 后 refinement，真正仍缺失且关键时再问。不要忽略影响本次提交的未决依赖。
18. **UNKNOWN 不得猜测** — `UNKNOWN` 不等于 `PENDING`，也不等于 `VISIBLE` 或 `HIDDEN`。**MUST NOT** 把 UNKNOWN 推断成任何一种可见状态。
19. **Critical Dependency** — 未决事实确实可能改变所选表单的适用必填，或影响提交字段合法性及 Lookup/Picklist，且现有可靠证据无法消解时，属于 Critical Dynamic Dependency，保持 `CHANGE_READY=false`。即使 API 必填已满足，也不能跳过仍可能改变 UI 必填的 `criticalUnknown`。无关、未提交、非必填字段的 PENDING/UNKNOWN 显示条件不阻断。页面显隐/只读与 API 权限分别判断。
20. **HIDDEN 与 API 必填** — `visibilityState=HIDDEN` 的仅页面必填字段不追问、不推荐；`apiRequired=true` 仍须由草案、可信默认或适用 managed 满足，真实缺口才问。UNKNOWN/PARTIAL 是覆盖事实，不可当成完整空清单。
21. **Refinement 上限** — 遵守当前 Runtime 的真实 contract（`refinement` 0..3、`refinementLimitReached`）。达到上限仍存在影响本次 mutation 的关键 unresolved dependency 时 **MUST** 保持 `CHANGE_READY=false`，并如实说明当前页面条件无法充分解析。
22. **Initial Facts 不重复询问** — 从提示、实际已读材料、适用上下文提炼业务事实，可靠关联结果也可进入当前真实字段的 draft/Patch。已知信息不重复问；附件引用或上传成功不证明已读正文。
23. **Default 必须有实时证据** — 只有实时 Salesforce / Runtime 证明的默认值才算满足。**MUST NOT** 用 Skill 或模型自己猜的默认值，**MUST NOT** 把 Flow / Trigger 保存后才可能补的值当作当前 Required 已满足。
24. **Managed Field 不可覆盖** — 严格 managed 字段（`PLATFORM_IDENTITY`、`AI_CREATED_MARKER`）**MUST NOT** 询问、**MUST NOT** 填写、**MUST NOT** 覆盖，由 Runtime 负责。
25. **Owner Fallback（CREATE）** — 已配置且适用的 PLATFORM_IDENTITY_FALLBACK 在无相反要求时直接采用：省略字段交给 Runtime，无需固定询问一次。任务指定其他责任人时先解析真实 Lookup ID；不自己查询当前用户 ID 来模拟平台身份。
26. **指定值失败不得 fallback** — 任务指定的 Owner / Lookup 未唯一解析时，先补足可用证据，剩余歧义才问；未解决时不得偷偷改用 platform fallback 或另一个候选。
27. **Lookup 歧义** — 只有唯一证明的 Salesforce ID 才可写入。DML 阶段被 Lookup Filter 拒绝时按 FAILED 处理，**MUST NOT** 自动寻找其他候选重试。
28. **Picklist 实时解析** — 与用户沟通优先 Label，DML payload **MUST** 使用当前 Salesforce 真实 API Value。**MUST NOT** 硬编码 Label → API Value 映射。Dependent Picklist 先解决 controller，再只看当前 controller 合法的候选。
29. **UPDATE 可写事实** — `fieldUpdateable` 与 Salesforce 权限决定 API 能力，`layoutEditableForUpdate` / `formContext.fields[].writable` 表达所选表单状态。精确表单就绪约束不能被当作 FLS，也不能删除 `formContext` 绕过；不要反复试写探测权限。旧通用调用保持兼容，但不证明表单检查完成。
30. **Evidence Completeness** — Tool result 的 truncated / omitted / response incomplete / required evidence unavailable 影响本次必填、提交字段合法性、唯一性或适用依赖时，**MUST NOT** 宣称所有 Required Fields 已验证完成，也 **MUST NOT** 在此之上给出 `CHANGE_READY=true`。区分 Evidence Delivery Incomplete 与 Runtime Coverage Partial。
31. **Batch 独立就绪** — 计划内每条记录独立判断 `CHANGE_READY`。只要还有一条未 ready，默认先不 dispatch 本批，**MUST NOT** 让用户仍在补充记录 C 时 A / B 已经产生 Salesforce 副作用，除非用户明确要求先处理可处理的部分。
32. **Batch 不得重放成功项** — `PARTIAL_SUCCESS` 时已成功项已经提交，**MUST NOT** 整批重发；只重新准备真实失败项，且必须先确认原 Mutation Intent 仍然有效。
33. **OUTCOME_UNKNOWN 不重放** — `OUTCOME_UNKNOWN` / `MCP_DML_OUTCOME_UNKNOWN` **MUST NOT** 自动重复 CREATE 或 UPDATE。只有真实独立证据才能把 UNKNOWN 改成 SUCCESS 或 FAILED，否则保持 UNKNOWN。
34. **Current State != Transaction Outcome** — 回读发现当前状态已满足期望值，最多证明**当前 desired state 已满足**，不一定证明刚才那次 transaction 成功。**MUST NOT** 把 Current State Evidence 当作 Transaction Outcome Evidence，也 **MUST NOT** 因为 UPDATE「看起来幂等」就自动重试（重复 UPDATE 可能再次触发 Flow / Trigger / Automation / Integration / Audit / Notification）。

36. **不硬编码** — **MUST NOT** 硬编码 Salesforce Required Fields、Record Type ID / DeveloperName、Picklist API Value、Lookup ID、Record ID、Owner ID 或公司字段业务规则；一切从当前 Runtime / Salesforce 实时发现。
37. **Salesforce 最终权威** — 尊重 Validation Rule、FLS、Sharing、Lookup Filter、Flow、Trigger、CRUD 与 Native Permission 的最终裁决。Skill 与 Playbook 都不能提升权限。
38. **Requiredness Source** — `includeRequiredness` / `requiredChecklist` 表示必填定义，不是用户未提供清单。CREATE/UPDATE 的 `formContext` 按当前 USER、Record Type 与所选入口判定：DYNAMIC_FORMS/MIXED 用有效规则，PAGE_LAYOUT 用该动作布局，QUICK_ACTION 用动作自己的布局和预设。PAGE_LAYOUT_FALLBACK 不能证明动态表单完整。综合材料、草案、原始 defaults、managed 和已知当前值后只问真正缺失的必要信息；false/0/null/空字符串/属性缺失分别处理。系统、不可写、严格托管字段不反复索要；页面隐藏/只读不扩成 DML 权限。FIELD_CUSTOM_VALIDATION_EXCEPTION 按实际错误区分字段、跨字段或业务规则，不一律当缺必填或无限重试。
39. **Explicit Fact Coverage** — 提示词、已读材料与可信关联中的每个明确业务事实，**MUST** 先映射到当前 Record Type 的可写字段（按 label、section、inlineHelpText、类型与依赖），或明确标记 `NO_FIELD` / `NO_LEGAL_VALUE` / `LOOKUP_UNRESOLVED`。使用 `fieldApiNames` 投影后，**MUST** 检查 `coverage.fieldProjection.omittedFieldCatalog`；被省略字段不代表不存在，label/section 命中明确事实时必须补取。**MUST NOT** 把已能映射到结构化字段的事实只写进 Description。不得仅为匹配 Picklist 值改变业务类型；当前类型确实选错或多个类型在业务上都成立时，可结合事实重新选择。类型正确但没有合法值时说明限制，剩余实质选择集中询问，不静默降级。
40. **Phone / Mobile 与地域** — 按当前字段 label/help、明确用途及号码所属国家地区分类。中国大陆规则仅适用于大陆号码，不作为全球校验器；保留国际国家码、分机和数字，不截断、补位、编造或静默换字段。座机区号本身不证明公司城市/省份/国家；明确公司地点可可靠补全行政层级，手机号不推断地址。详见 [phone-and-mobile.md](references/phone-and-mobile.md)。
41. **指定归属人意图** — 用户说「以 X 的账号/名义创建」「归属给 X」时，**MUST NOT** 切换认证身份。先看当前 `managedDmlFields` 与字段 label：若配置了可用户指定的归属人/归属 Managed 字段（如 `PLATFORM_USER_LOOKUP_FALLBACK`），**MUST** 先调用 `get_record_action_context` 获取该对象/动作的字段描述，读取该托管字段对应字段的 `referenceTo` 确定目标对象（**MUST NOT** 默认按 `User` 解析），再在该目标对象上按姓名/工号等业务字段做有界查询，把唯一 Salesforce ID 写入该托管字段；**MUST NOT** 改用 `OwnerId` 或其他非托管字段代替。若 action context 不可用、字段描述缺失或 `referenceTo` 为空，**MUST** 先问，不得猜。若没有可用户指定的归属字段，或策略是 strict `PLATFORM_IDENTITY`，**MUST** 明确告知用户无法指定归属人/身份，只能按当前认证身份执行（获得用户确认后）。目标对象存在重名时先问哪一条，不得取第一条或猜 ID。详见 [managed-lookups.md](references/managed-lookups.md)。
42. **适用查重** — CREATE 围绕当前真实对象的业务身份/事件键，UPDATE 仅对实际变化且适用的身份值做有界 USER 查询；名称、共享电话、模糊匹配是候选，不直接证明重复。拜访结合客户、时间和事件，历史拜访不阻止新事件。先用已有事实消歧；实质同记录冲突或继续新建/改为更新/取消的独立选择才集中问，已有决定不重问；普通初始“新建”不代表已知后来发现的同记录证据后仍决定再建一份，未解选择应在保存前问；不能静默覆盖旧记录。无适用键、查询失败或截断如实说明限制，不统一阻断，也不声称全库唯一。见 [duplicate-check.md](references/duplicate-check.md)。
43. **Selected Form Contract** — CREATE/UPDATE 使用 `formContext`：默认 STANDARD，仅明确选择时使用原生 QUICK_ACTION；应用明确值优先，否则使用当前 USER 的 Profile 默认应用。START/REFINE 处理草稿与关键缺项；提交携带相同选择，由 MCP 自动 SUBMIT 复核当前配置。QUICK_ACTION 仅使用单条 create_record/update_record，不进入批量工具。`UNKNOWN`/`criticalUnknown` 不得以旧 API 路径绕过。近期可选建议不阻塞已就绪保存，按实际分子、分母、窗口和范围说明。见 [precise-forms.md](references/precise-forms.md)。
44. **必填性未证明即不得提交** — `coverage.requirednessIncomplete=true` 表示本次解析没有证明该 Record Type 的完整必填集合：可能是对象存在 Record Type 专属 Lightning 页面但本次解析到了别的页面（`RECORD_TYPE_PAGE_NOT_MATCHED`），也可能是动态表单解析回落到 Page Layout（`RESOLUTION_FALLBACK_*`）。此时 **MUST NOT** 把 `requiredChecklist` 当作完整清单，**MUST NOT** 据此给出 `CHANGE_READY=true`。**MUST** 先如实说明「当前表单必填校验不完整」，列出已确认的必填项，并请用户补充只在专属表单页出现的必填字段，或由用户明确确认按现有信息保存。该信号与 `coverage: PARTIAL`、`truncated`、`PENDING` 是不同事实，不能互相替代，也不能因为 `includeRequiredness` 已开启就认为必填已证明。
45. **CREATE 前必须有本次表单证据** — 调用 `create_record` / `create_records` 之前，**MUST** 在本轮对话中针对当前对象与**已确定的 Record Type** 调用过 `get_record_action_context`（不传 `formContext` 时服务端按 STANDARD START 处理）。下列任一情况都使先前证据失效，**MUST** 重新调用并在拿到结果后再决定：对象或 Record Type 变化；用户补充/更改了会改变条件必填的事实（来源、销售组织、Record Type 相关选择等）；上次调用之后已经发生过任何写入；上次调用没有返回 `formContext`（例如未选 Record Type 导致 `recordTypeSelectionRequired`）。**MUST NOT** 以「同一会话里前面查过」「上一次也是这样建的」「我记得这几个字段不用填」为由跳过本次取证——旧结论来自旧配置，必填集合可能已经变化。`missingRequired` 非空且无合规草稿值时，先补齐或追问，**MUST NOT** 直接建单。同一会话内重复为不同对象/类型取证时，同样各自独立执行本规则。
46. **按钮动作优先于主表单必填** — 当用户的任务语义对应记录上的一个**动作按钮**（例如总结、关闭、提交、加签、添加参与人等）时，**MUST** 先用 `formContext.availableActions`（UPDATE 上下文中由 Salesforce 按该记录实时返回）按 `label` 找到目标按钮，再以 `formContext: { entry: 'QUICK_ACTION', quickActionName }` 取得**该按钮自己的表单**及其 `missingRequired`；**MUST NOT** 用 STANDARD 主表单的必填集合替代按钮表单的必填判断，也 **MUST NOT** 因为主表单 READY 就认为按钮动作已就绪。写入时 **MUST** 携带同一个 `formContext`，由 preflight 复核。`availableActions` 为空或没有语义匹配项时，**MUST** 如实告知并询问用户指的是哪个动作，**MUST NOT** 猜一个 apiName。`evaluable=false` 的按钮（LWC 动作、或目标对象不是当前对象的创建型动作）本工具无法按其布局求解：**MUST** 说明这一限制，改用该业务对象的常规创建/更新路径（例如直接创建子记录），**MUST NOT** 声称已经通过该按钮写入。
47. **缺失必填的处理次序** — 当必填字段在材料中没有依据时：① 先按字段 label、help、类型与依赖在材料/上下文里再找一次；② 仍无则**集中一次**问用户（用中文字段名，不逐字段连问）；③ 用户明确表示没有或不适用的**文本 / 长文本**字段，**MUST** 先确认「这些字段是否可以统一填“无”」，得到肯定答复后才可写入「无」，并在回执中注明这是按用户确认填入的占位值。日期、数值、货币、百分比、Picklist、Lookup **MUST NOT** 用「无」或其他占位值填充，应保持为空并说明缺哪一项。
48. **子表与参与人** — 需要写明细/参与人时，**MUST** 先从 `describe_sobject` 的 `childRelationships` 识别父记录下的子对象，并按**子对象 label 与字段 label** 判断归属类别（如「我方/内部/员工」与「客户/外部/来访人」），**MUST NOT** 硬编码任何对象 API 名或假设某业务对象独有的结构。材料中每个参与人写一条子记录：父 lookup 指向刚创建的父记录，人员 lookup 指向 `Contact` 或 `User`。客户方人员 **MUST** 在父记录所属客户下按姓名查到**唯一** `Contact` 再写；查不到或重名先问，**MUST NOT** 猜 ID。写完后 **MUST** 按父记录回查子表条数并与材料核对，数量不符要说明；子对象不在 DML 白名单时必须明确报告，**MUST NOT** 静默跳过。

## CREATE 与 UPDATE 的关键差异

| 维度 | CREATE | UPDATE |
| --- | --- | --- |
| 关心的问题 | 新记录是否完整到可以存在 | 目标与业务任务是否明确，实际变化字段是否适用且有依据 |
| 第一个 Gate | Object / Record Type 解析 | `TARGET_RESOLVED`（唯一目标记录） |
| Action Context | `action=CREATE` + `formContext`，可用 `draftFields` / `refinement` | `action=UPDATE`，**必须**带 `recordId`；开启 `formContext` 后可用草稿 / refinement |
| 核心 editable 证据 | `effectiveEditable`（Dynamic Forms） | `fieldUpdateable` / `layoutEditableForUpdate` |
| Required 语义 | 所选新建表单适用必填必须满足 | 所选 Edit 表单全部适用必填，保存值已满足者不重复索要；创建必需不自动成为更新必需 |
| 默认值 | Create Defaults 可用 | UPDATE 不返回 defaults；omission = preserve |
| Record Type | 需要解析并选择 | 沿用记录当前 Record Type，不静默变更 |
| Owner fallback | CREATE 时按策略可用 | 不重放 CREATE fallback；任务相关的责任变更按可靠事实解析 |
| 查重 | 按对象的业务身份或事件键做有界查重；名称/共享电话只是候选，已有事实无法消解的实质同记录歧义才询问 | 已有目标不例行重复查重；仅对本次变化且适用的身份值核实，结合现有事实消歧（见 [duplicate-check.md](references/duplicate-check.md)） |
| 批量语义 | 新建多条 | 每条可有**不同** Patch，不得互相复制字段 |

UPDATE 的精确 Dynamic Forms 判断使用当前类型、保存值与 Patch；不支持的条件仍保留 UNKNOWN，Record Type 切换后的假设表单不可用。**MUST** 承认能力边界，由 Salesforce Validation / Flow / Trigger / Lookup Filter / DML Runtime 作为最终 authority，**MUST NOT** 用模型猜测补齐。

## CHANGE_READY 摘要

```text
CREATE:
Intent 明确 + Object 明确 + Record Type 已解析 + Effective Context 足以判断
+ 实际缺失的必要信息清单为空 + 提交字段可 create + Lookup 唯一 + Picklist 已归一
+ Managed 策略满足 + 已做适用查重，实质同记录歧义已解决，覆盖限制如实说明
+ 证据完整 + Patch 与意图一致

UPDATE:
Intent 明确 + Object 明确 + TARGET_RESOLVED + Mutation scope 明确
+ Patch 只含完成业务任务实际需要的变化字段 + 提交字段按当前证据 allowed/editable
+ Lookup 歧义已解决 + Picklist 已归一 + Managed 策略满足
+ Record Type 意图已解析（当适用）+ 无 critical 证据缺口 + Patch 与意图一致
+ 所选 Edit 表单适用必填已由保存值/真实变更满足，提交时保留 formContext
```

所有 blocking condition 消失时 `CHANGE_READY=true`，此时才允许调用写入 Tool。完整阻塞清单见 [readiness-gate.md](references/readiness-gate.md)。

## 何时加载

创建、新增、修改、更新 Salesforce 记录；发起或变更申请；创建拜访申请、客户、商机；批量创建或批量更新同类记录；需要判断一次 CREATE / UPDATE 是否已经准备完成；用户发来文件并希望它落到某条记录上（用 `upload_files_to_record`，对象需已开启附件上传，见 [file-attachments.md](references/file-attachments.md)）。

纯查询、统计、分析、诊断、闲聊、数学与一般网页搜索不要加载本 Skill；这些场景不加载 record-change，按任务使用实际可用的 sfoa-org-diagnostics 或 sfoa-data-analysis，并配合 Core。当请求同时包含读取与写入时，读取部分按 Core 执行，写入部分按本 Skill 的 Gate 执行。

本 Skill **不覆盖** Delete、Upsert、Merge、Metadata 管理与业务分析。遇到这些请求时如实说明边界，**MUST NOT** 用其他 Tool 变相实现。

## Guidelines / Heuristics

复杂 CREATE/UPDATE 优先考虑当前 `get_agent_playbook`；有效的 Playbook、字段结构与 Record Context 可在本任务可信生命周期内复用，不必每轮重复获取全部结构。新的创建/编辑任务以 formContext START 取得当前配置；问答中按相关依赖 REFINE，提交由服务器复核。普通读取和附件操作不做这些额外调用。

在上述新鲜度边界内，是否需要额外读取、怎样合并 clarification、是否适合 singular / plural Tool、怎样记录 before-state、何时说明 broad batch impact、哪些 task-related optional 字段值得提醒，由 Agent 根据事实判断。

业务目标已授权时，忠实提炼与可靠关联推导可直接写入。目标、关键事实或业务选择仍有实质歧义时才 clarification。

材料正文、适用上下文及可核验关联均可提供业务事实；Salesforce / Runtime 决定真实字段、存储值、权限与执行结果。

## 按需要读取 references

- 页面定位、Quick Action、动态问答、提交前复核、近期建议：[precise-forms.md](references/precise-forms.md)
- 就绪模型与全部阻塞条件（CREATE + UPDATE）：[readiness-gate.md](references/readiness-gate.md)
- CREATE 就绪、Initial Facts、Record Type、Required Checklist：[create-readiness.md](references/create-readiness.md)
- UPDATE 就绪、Target Resolution、Minimal Patch、Required/Default/Owner/Record Type：[update-readiness.md](references/update-readiness.md)
- Dynamic Forms 四态、PENDING、UNKNOWN、refinement、证据完整性：[dynamic-forms.md](references/dynamic-forms.md)
- Managed 字段与 Owner fallback：[managed-lookups.md](references/managed-lookups.md)
- Lookup 与 Picklist 解析：[lookup-and-picklist.md](references/lookup-and-picklist.md)
- Phone / Mobile 分类与中国大陆校验：[phone-and-mobile.md](references/phone-and-mobile.md)
- CREATE 敏感身份字段查重：[duplicate-check.md](references/duplicate-check.md)
- 批量变更：分组、上限、分批、allOrNone、逐条就绪：[batch-mutations.md](references/batch-mutations.md)
- 附件上传：`upload_files_to_record`、attachmentRef 归属、逐文件结果：[file-attachments.md](references/file-attachments.md)
- 写入结果、PARTIAL_SUCCESS、UNKNOWN 与核对：[outcome-reconciliation.md](references/outcome-reconciliation.md)

这些参考资料按任务使用，无需每轮全部读取。当前 Tool Schema、Tool Governance、Playbook 与 Salesforce 返回始终高于本 Skill 的任何描述；若本 Skill 与当前代码或运行时事实冲突，以运行时事实为准，并把差异当作 Runtime Defect 记录，而不是靠 Prompt 掩盖。

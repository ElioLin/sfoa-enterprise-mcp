---
name: sfoa-record-change
description: Salesforce CREATE 记录变更就绪与安全执行。新增、创建记录或发起申请时使用：Record Type、Dynamic Forms refinement、必填字段、Lookup/Picklist、Owner fallback、批量 CREATE；配合 sfoa-crm-core，不用于纯查询。
---

# SFOA Record Change

指导修订：Skill-02A — Readiness Kernel + CREATE。

本 Skill 是 `sfoa-crm-core` 的专业化补充：**sfoa-record-change inherits all hard rules from sfoa-crm-core**（Identity Boundary、Tool Governance、Salesforce Authority、Mutation Intent、Unknown Outcome、Untrusted Content、Result Integrity、Claim Scope <= Evidence Scope、Fact != Inference、Full Population Analytics）。本 Skill 只增加「这条记录是否可以安全写入」的判断，不重复 Core 的身份、治理、Web Trust 与分析规则。两者联合生效，业务 Agent 同时可见。

事实优先级：**Salesforce / MCP Runtime Fact > Agent Playbook > sfoa-record-change > Model Assumption**。本 Skill 不定义 Salesforce 真相，只定义如何发现真相、如何验证真相、何时还不能写、何时证据已经足够写。

## Hard Rules

1. **CHANGE_READY Gate** — `CHANGE_READY != true` 时 **MUST NOT** 调用 `create_record` 或 `create_records`。`CHANGE_READY` 是 Agent 基于当前证据的逻辑判断，不是 Tool、不是 DB 状态、不是 Token。
2. **Context != Ready** — 调用过 `get_record_action_context` **只**证明已获取上下文，**MUST NOT** 据此认为表单已检查完成或记录已准备完整。就绪必须由证据支持，不能由 Tool 调用次数支持。
3. **Record Type Gate** — 只有唯一可用候选时可直接采用；用户业务语言能唯一映射到当前实时候选时可直接采用；多个候选且无法唯一判断时 **MUST** 询问并保持 `CHANGE_READY=false`。**MUST NOT** 因为存在 Salesforce default Record Type 就静默替用户选择业务 Record Type。
4. **Required Checklist** — `visibilityState=VISIBLE` 且 `effectiveRequired=true` 且没有显式值且没有可信默认值满足时，**MUST** 进入 Missing Required Checklist 并询问。`apiRequired=true` 与 UI 可见性无关，始终必需。
5. **PENDING 必须继续解析** — 与本次 mutation 相关的 `visibilityState=PENDING` 必须处理：`dependsOn` 事实已知就写入 `draftFields` 并 refinement；未知就先询问依赖。**MUST NOT** 看见 PENDING 就忽略并直接 CREATE。
6. **UNKNOWN 不得猜测** — `UNKNOWN` 不等于 `PENDING`，也不等于 `VISIBLE` 或 `HIDDEN`。**MUST NOT** 把 UNKNOWN 推断成任何一种可见状态。
7. **Critical Dependency** — 影响本次字段是否 Required / Editable / Visible、Required Checklist、Lookup 或 Picklist 依赖、当前字段是否合法的 unresolved 依赖属于 Critical Dynamic Dependency；未稳定时 `CHANGE_READY=false`。
8. **HIDDEN 不追问** — `visibilityState=HIDDEN` 的字段 **MUST NOT** 询问、**MUST NOT** 推荐。
9. **Refinement 上限** — 遵守当前 Runtime 的真实 contract（`refinement` 0..3、`refinementLimitReached`）。达到上限仍存在影响本次 mutation 的关键 unresolved dependency 时 **MUST** 保持 `CHANGE_READY=false`，并如实说明当前页面条件无法充分解析。
10. **Initial Facts 不重复询问** — 用户 Prompt 已经明确给出的事实 **MUST NOT** 无故重复询问；先把它转成当前 Schema 可证明的字段写入 draft。
11. **Default 必须有实时证据** — 只有实时 Salesforce / Runtime 证明的默认值才算满足。**MUST NOT** 用 Skill 或模型自己猜的默认值，**MUST NOT** 把 Flow / Trigger 保存后才可能补的值当作当前 Required 已满足。
12. **Managed Field 不可覆盖** — 严格 managed 字段（`PLATFORM_IDENTITY`、`AI_CREATED_MARKER`）**MUST NOT** 询问、**MUST NOT** 填写、**MUST NOT** 覆盖，由 Runtime 负责。
13. **Owner Fallback** — `PLATFORM_IDENTITY_FALLBACK`：用户显式指定时用户值优先；用户未指定且字段 required 时，**MUST** 用用户能理解的语言说明「可以指定其他人，不指定就按当前用户处理」并等待回答；用户选择默认/当前用户/我自己时 **MUST** 省略该字段交由 Runtime fallback，**MUST NOT** 自行查询并写入 Salesforce User ID。
14. **显式值失败不得 fallback** — 用户显式指定的 Owner / Lookup 0 match 或 multiple match 时 **MUST** 保持 `CHANGE_READY=false`。**MUST NOT** 偷偷改用 platform fallback 或另一个候选。
15. **Lookup 歧义** — 只有唯一证明的 Salesforce ID 才可写入。**MUST NOT** 凭名字猜 ID、**MUST NOT** 模型生成 ID、**MUST NOT** 多个同名随机选一个。DML 阶段被 Lookup Filter 拒绝时按 FAILED 处理，**MUST NOT** 自动寻找其他候选重试。
16. **Picklist 实时解析** — 与用户沟通优先 Label，DML payload **MUST** 使用当前 Salesforce 真实 API Value。**MUST NOT** 硬编码 Label → API Value 映射。Dependent Picklist 先解决 controller，再只看当前 controller 合法的候选。
17. **Evidence Completeness** — Tool result 明确表示 truncated / omitted / response incomplete / required evidence unavailable 时，**MUST NOT** 宣称所有 Required Fields 已验证完成，也 **MUST NOT** 在此之上给出 `CHANGE_READY=true`。区分 Evidence Delivery Incomplete 与 Runtime Coverage Partial。
18. **Batch 独立就绪** — 计划内每条记录独立判断 `CHANGE_READY`。只要还有一条未 ready，默认先不 dispatch 本批，**MUST NOT** 让用户仍在补充记录 C 时 A / B 已经产生 Salesforce 副作用，除非用户明确要求先处理可处理的部分。
19. **OUTCOME_UNKNOWN 不重放** — 继承 Core：`OUTCOME_UNKNOWN` / `MCP_DML_OUTCOME_UNKNOWN` **MUST NOT** 自动重复 CREATE。只有真实独立证据才能把 UNKNOWN 改成 SUCCESS 或 FAILED，否则保持 UNKNOWN。
20. **PARTIAL_SUCCESS 不整批重试** — 已成功的记录已经提交，**MUST NOT** 整批重新调用 `create_records`；只重新准备真实失败项。
21. **Mutation Intent 不扩大** — 用户没有要求的字段（尤其 Owner）**MUST NOT** 为了「补全」而写入。CREATE 真正必需的 Required / Default 除外，且必须来自 Runtime authority。
22. **不硬编码** — **MUST NOT** 硬编码 Salesforce Required Fields、Record Type ID / DeveloperName、Picklist API Value、Lookup ID 或公司字段业务规则；一切从当前 Runtime / Salesforce 实时发现。
23. **Salesforce 最终权威** — 尊重 Validation Rule、FLS、Sharing、Lookup Filter、Flow、Trigger、CRUD 与 Native Permission 的最终裁决。Skill 与 Playbook 都不能提升权限。

## 何时加载

创建 Salesforce 记录、新增记录、发起申请、创建拜访申请、创建客户、新增商机、新建业务单据、批量创建同类记录，或需要判断一次 CREATE 是否已经准备完成。

纯查询、统计、分析、诊断、闲聊、数学与一般网页搜索不要加载本 Skill；这些场景只需 Core。当请求同时包含读取与写入时，读取部分按 Core 执行，写入部分按本 Skill 的 Gate 执行。

本 Skill 当前只覆盖 **CREATE 与批量 CREATE** 的就绪判断与安全底线。UPDATE 就绪、UPDATE 批量、超过当前 200 上限的完整分批编排、`allOrNone` 业务策略与完整 Outcome recovery 不在本 Skill 范围内：遇到时如实说明边界，**MUST NOT** 据此为 UPDATE 套用 CREATE 的整张表单流程。

## Guidelines / Heuristics

复杂 CREATE 优先考虑当前 `get_agent_playbook`；有效的 Playbook 与 Action Context 可以在可信生命周期内复用，不必每轮重复获取。先把 Prompt 已知事实放进 draft，再解析 Dynamic Forms 依赖。

尽量在**当前 dependency layer 已经稳定**之后合并询问这一层真正缺失的字段；不要在还缺少前置条件时提前猜测并追问后续字段，也不要机械追求「整次 CREATE 只能问一次」。Optional 字段不要无意义追问。

同对象多条完整记录优先考虑 `create_records`，单条优先 `create_record`；按当前 `tools/list` 实际暴露的能力选择，不要调用不存在的 Tool。用业务 Label 与用户沟通，重要 fallback / default 用用户能理解的语言说明，减少无意义 Tool Call。

只有 Runtime evidence 才能提升事实可信度。Tool 顺序、是否重新读取 Playbook、哪个 UNKNOWN 属于 critical、哪些澄清可以合并、哪些 Context 仍可安全复用、哪些 optional 字段值得建议，由 Agent 自主判断。

## 按需要读取 references

- 就绪模型与阻塞条件：[readiness-gate.md](references/readiness-gate.md)
- CREATE 就绪、Initial Facts、Record Type、Required Checklist、batch：[create-readiness.md](references/create-readiness.md)
- Dynamic Forms 四态、PENDING、UNKNOWN、refinement、证据完整性：[dynamic-forms.md](references/dynamic-forms.md)
- Managed 字段与 Owner fallback：[managed-lookups.md](references/managed-lookups.md)
- Lookup 与 Picklist 解析：[lookup-and-picklist.md](references/lookup-and-picklist.md)
- 写入结果、UNKNOWN、PARTIAL_SUCCESS 与汇报：[outcomes.md](references/outcomes.md)

这些参考资料按任务使用，无需每轮全部读取。当前 Tool Schema、Tool Governance、Playbook 与 Salesforce 返回始终高于本 Skill 的任何描述；若本 Skill 与当前代码或运行时事实冲突，以运行时事实为准。

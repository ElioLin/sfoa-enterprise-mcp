# CREATE Readiness

本文件是 CREATE 的 doctrine：如何发现事实、如何验证事实、什么条件阻塞写入。使用 [精确表单流程](precise-forms.md) 的 START/REFINE 与提交前复核；本任务有效字段结构可复用，不做无关调用。

## 当前 CREATE contract（以代码为准，不要凭记忆）

`get_record_action_context` 的 CREATE 输入：

| 输入 | 约束 |
| --- | --- |
| `objectApiName` | 必需，对象 API 名，不含关系路径 |
| `action` | 必需，`CREATE` |
| `recordTypeId` | 可选；显式给出时必须属于当前候选 |
| `recordId` | CREATE 禁止 |
| `formContext` | 默认选 STANDARD；明确原生 Quick Action 才传 QUICK_ACTION 与真实名称/来源 |
| `draftFields` | 可选；任务草稿值（提示、已读材料、可靠关联），用于条件可见性；missing 与 `null` / `false` / `0` / 空串不同 |
| `refinement` | 可选；初始 0，最大 3 |

`draftFields` 与 `refinement` 在开启 `formContext` 的 UPDATE 中也可使用，但保存值与 Patch 的合并规则不同，不能重放 CREATE defaults。`recordTypeSelectionRequired=true` 时 Create Defaults / Picklist 相关事实还没有加载。

CREATE 输出的关键字段：`recordType`、`availableRecordTypes`、`recordTypeSelectionRequired`、`fields[]`、`uiContext`、`uiContextResolutionId`、`coverage`。

`fields[]` 里与就绪判断直接相关的：`apiName`、`label`、`dataType`、`apiRequired`、`layoutRequired`、`fieldCreateable`、`layoutEditableForCreate`、`defaultValue`、`defaultValueTruncated`、`picklist`、`visibilityState`、`requiredSource`、`effectiveRequired`、`effectiveEditable`、`optionalCandidate`、`conditionalRequired`、`dependsOn`、`referenceTo`。

写入工具：`create_record`（1 条）与 `create_records`（同对象 1..200 条，`allOrNone` 默认 false，每项可带 `clientReferenceId` 作为批内关联键）。`create_record` 接受 `recordTypeId` 与 `uiContextResolutionId`；`uiContextResolutionId` 只是 Audit provenance，永远不改变授权或 payload，**MUST NOT** 自己编造。

## Initial Fact Ledger

先实际读取用户指定材料，再从自然语言、正文、转写及适用上下文抽取、忠实提炼并核验关联业务事实：对象线索、Record Type 语义、日期、客户、负责人、来源、计划交谈事项、参与人、状态、业务字段值、Lookup 语义、Picklist label。

把这些事实转成**当前 Salesforce Schema / Metadata 可证明的字段**后写入 draft。**MUST NOT** 硬编码字段映射；字段名必须来自当前 Action Context / ObjectInfo 证据。

Agent 侧的事实来源分类（**仅为 reasoning doctrine，不是 Runtime enum，也不新增数据库结构**）：

| 来源 | 含义 |
| --- | --- |
| `USER_EXPLICIT` | Runtime 的历史兼容标签：Agent 传入的 draftFields；不是逐字输入、正文已读或事实已核验的证明 |
| 材料提炼 / 可靠关联 | Agent 工作摘要可区分原事实、提炼与关联推导；不是新增 Runtime enum |
| `SALESFORCE_CREATE_DEFAULT` | 当前 Action Context 的 Create Defaults 证明的默认值 |
| `RECORD_TYPE_DEFAULT` | 当前 Record Type 证据证明的默认值 |
| `CURRENT_USER_FACT` | 当前 USER 事实（例如 `$User.*`），由 Runtime 读取证明 |
| `TRUSTED_RUNTIME_DEFAULT` | Runtime 提供的可信默认事实 |
| `MANAGED_RUNTIME_DEFAULT` | 由 managed 字段策略在写入时由 Runtime 提供，Agent 不参与 |
| `UNRESOLVED` | 没有可信来源；不得当成已提供 |

Runtime 自身的 `InitialFact.source` 枚举是 `USER_EXPLICIT`、`SALESFORCE_CREATE_DEFAULT`、`CURRENT_USER_FACT`、`TRUSTED_RUNTIME_DEFAULT`、`UNRESOLVED`。`RECORD_TYPE_DEFAULT` 与 `MANAGED_RUNTIME_DEFAULT` 只是 Agent 侧的概念；若当前代码没有对应的 Runtime 枚举，**MUST NOT** 声称 Runtime 产生了它。

draftFields 在可见性计算中覆盖默认值，这是草稿优先级而非事实可信度排名；材料事实与实际字段映射由 Agent 核对。明确任务输入、忠实提炼与可靠关联均可纳入草稿；冲突先核查时效、主体与上下文，关键冲突未解才问。保留 `false` / `0` / `null` / 未提供之间的差异。

## Record Type Hard Gate

处理 `recordTypeSelectionRequired`、default Record Type、用户明确指定、多个候选、唯一候选：

1. **唯一候选** — `availableRecordTypes` 只有一个合法候选时直接采用，不需要额外提问。非 Master 类型按当前 Playbook 要求把解析出的 `recordType.id` 作为 `recordTypeId` 传入，不要省略后落到别的 Salesforce 默认。
2. **用户明确指定且唯一映射** — 用户业务语言能唯一映射到当前实时候选时，使用该 Record Type。
3. **多个候选** — 用任务、候选标签/描述与适用默认自主确定，再用同一 recordTypeId 取该类型字段；技术两阶段不要求用户两轮对话。仍有实质业务歧义时才询问并保持 CHANGE_READY=false。
4. **Master** — 当前候选集在存在可用非 Master 类型时已经排除 Master。不要把它加回来，也不要在这个情况下选择它。只有当 Master 是唯一可用类型时才保留并使用它，且不需要询问。
5. **没有可用候选** — 停止并告知用户该记录当前无法创建；**MUST NOT** 在不可用或猜测的 Record Type 下创建。

适用默认可以结合任务支持类型选择，不能覆盖明确相反要求或掩盖业务歧义。

**MUST NOT** 在 Skill 中写死 Record Type ID、DeveloperName 或公司特定 Record Type；必须从 Runtime / Salesforce 实时发现。

## Missing Required Checklist

综合当前真实证据形成缺口清单：`apiRequired`、`layoutRequired`、Dynamic Forms Required（`requiredSource` 含 `DYNAMIC_FORM`）、`conditionalRequired`、以及 `effectiveRequired`。

必须满足的判定：

```text
VISIBLE + effectiveRequired=true + 当前没有合规任务草稿值（包括忠实提炼与可靠关联） + 没有可信默认值满足
→ 先用已有材料、上下文与可用读取解决，仍缺关键事实时进入 Missing Required Checklist
```

`apiRequired=true` 与 UI 可见性无关：即使字段在 UI 上 HIDDEN，API 必填语义仍然存在。合法草案值或适用默认/managed 可满足该值义务，但不能消除仍可能改变 UI 必填的 `criticalUnknown`。未决事实确实可能改变所选表单的适用必填，或影响提交字段合法性及 Lookup/Picklist，且现有可靠证据无法消解时，属于 Critical Dynamic Dependency，必须先解决。

同时要区分：

- `layoutRequired` 与 `apiRequired` 是两套独立来源，`requiredSource` 会同时列出 `API`、`PAGE_LAYOUT`、`DYNAMIC_FORM`。
- `conditionalRequired=true` 表示存在条件必填可能性，不代表当前已经缺值；如果条件可能改变本次所需值且现有可靠证据无法消解，则按 Critical Dependency 解析。已合法满足的值不会仅因页面条件未明而再问。
- `fieldCreateable=false` 的字段不能作为用户可写项；`effectiveEditable=false` 仅表示页面状态，不能单独否定已有 API 写权限。**MUST NOT** 通过反复试写去发现字段。
- 系统字段、公式字段、自动编号字段、只读字段不是用户问题。

**MUST NOT** 硬编码 Salesforce Required Fields，也不要为了「必填不漏」把所有 API-required 字段都拿来追问用户。

## 字段值的形态：业务事实，不是材料状态

必填缺口的收口只有三种，**MUST** 从中选一种，**MUST NOT** 发明第四种（把「材料没写」写成一句话塞进字段）：

| 收口 | 适用 | 写入的值 |
| --- | --- | --- |
| 集中一次问用户 | 任意类型，字段值确实影响业务记录 | 用户回答的业务事实 |
| 用户确认后填「无」 | 仅文本 / 长文本 | `无`，回执注明是按确认填入的占位值 |
| 省略字段 | 非必填字段 | 不提交（`omitted != null`，不主动清空） |

禁止写入的形态（元陈述 / 证据状态，不是业务事实）：

- `报告未记录客户品质情况。`
- `文档中未提及现场管理能力。`
- `材料未说明本次拜访的竞争对手。`
- 单独充当字段值的 `未获取到`、`无法确认`、`待补充`、`未知`、`暂无`、`无数据`、`N/A`

不禁止的对照项（含上述词但是业务事实）：`客户暂无采购计划`、`未知悉竞争对手方案`、`本次未涉及品质议题（经用户确认）`。

判定方法：读这句话，问「它描述的是**客户/业务发生了什么**，还是**我手上这份材料写了什么**」。后者一律不合格，即使语句通顺、看起来"如实"。

两条同样重要的推论：

1. **沉默 ≠ 否定**。材料没写客户品质问题，不代表「客户无品质问题」，也不代表「客户未反馈品质情况」。前者是编造结论，后者是编造事实来源。两者都比空着更糟。
2. **主语是业务方，不是材料**。合格写法的主语是「客户 / 我方 / 本次拜访」，而不是「报告 / 文档 / 材料 / 附件」。同一件事的业务化表达是允许的（如把材料里的技术细节归纳成「客户现用 A 产品，计划导入 B 替代」），但归纳的前提是材料真有这些事实。

对这些字段来说，一次提问的成本远低于一条长期污染报表的假数据；用户明确授权过「缺失项填无」时，按授权整批执行，不必逐字段确认。

## Requiredness Source（当前 USER + Record Type + action）

必填口径按当前 USER、Record Type、action 与所选入口的真实事实解析。精确 CREATE/UPDATE 使用 `formContext`：MCP 解析当前 active Lightning page 或动作自己的布局，UPDATE 合并保存值与 Patch。requiredChecklist 表示定义，不等于缺值问题清单；先比较材料、草案、原始 defaults、managed 与适用保存值。

- `DYNAMIC_FORMS` / `MIXED`：使用 action context 的 `effectiveRequired` / `requiredSource`；**MUST NOT** 把 page-layout-only 的 `layoutRequired` 当成有效必填。
- `PAGE_LAYOUT` / Default / Standard：使用当前 action 的 Record Type 页面布局 `apiRequired || layoutRequired`；CREATE 用 CREATE 的 action context，UPDATE 用 UPDATE 的 action context。
- `PAGE_LAYOUT_FALLBACK` / `CUSTOM_OVERRIDE` / `AMBIGUOUS` / `UNRESOLVED`：按页面布局必填处理，并明确说明 fallback 限制；不能把解析失败当成「没有必填」。
- **MUST NOT** 按布局名称取 XML，**MUST NOT** 用 UPDATE 布局判断 CREATE。
- `includeRequiredness=true` 时优先使用 `requiredChecklist`；未提供时按上述来源使用 `effectiveRequired` 或 `apiRequired/layoutRequired`。
- `requiredChecklist` 中 `writable=false` 的字段是系统/只读/当前 action 不可编辑字段，**MUST NOT** 向用户追问；只在它阻塞任务时说明限制。
- Validation Rule 导致 DML 报错（如 `FIELD_CUSTOM_VALIDATION_EXCEPTION`）需要按真实错误区分字段、跨字段或业务规则；不一律归为缺必填，不无限补问/重试。

## Explicit Fact Coverage

提示词、已读材料和可信关联中的每个明确业务事实，必须先形成事实账本并映射到当前 Record Type 的可写字段：

```text
fact → target field (label/section/inlineHelpText/type/dependency)
     → MAPPED | NO_FIELD | NO_LEGAL_VALUE | LOOKUP_UNRESOLVED
```

- 使用 `fieldApiNames` 投影前，先看当前 Record Type 的字段目录；投影后检查 `coverage.fieldProjection.omittedFieldCatalog`。
- 被省略字段不代表不存在；omitted catalog 中 label/section 命中明确事实时，必须补取该字段的 Picklist/default/layout facts。
- 已经能映射到结构化字段的事实 **MUST NOT** 只写进 Description。
- 不得仅为匹配 Picklist 值改变业务类型；当前类型确实选错或多个类型在业务上都成立时，可结合事实重新选择。当前类型正确但没有合法值时说明限制，剩余实质选择集中询问，不静默降级。
- 无法解析的 Lookup 按 [lookup-and-picklist.md](lookup-and-picklist.md) 处理；不要把姓名直接写入 Lookup Id 字段。

## Phone / Mobile

- 手机与电话按 [phone-and-mobile.md](phone-and-mobile.md) 结合适用国家地区分类；已确认中国大陆时，手机适用 `^1[3-9]\d{9}$`（可带 `+86`），座机适用区号 `0\d{2,3}` + 7-8 位本地号码（可带分机）。不能将此模式用于其他国家或未确认地区。
- 用户只说「电话/联系电话」时结合号码格式与材料语境判断字段；显式标签与格式冲突时先补证，仍影响正确写入的实质歧义才集中询问。
- 无效、位数不符或歧义时，先按适用国家与来源核对，仍无法解决才提示；**MUST NOT** 截断、补位、编造数字、把同一号码写入两个字段或静默换字段。
- 明确公司地址或已核实公司所在地能确定城市时，按 [phone-and-mobile.md](phone-and-mobile.md) 同时推断并写入对应的省份/国家；不得只填城市；手机号本身不含地域，**MUST NOT** 据此推断。

## 适用查重

按 [duplicate-check.md](duplicate-check.md) 用真实业务身份/事件键做有界 USER 查询，复用仍适用证据。同名、共享电话和模糊命中是候选，不直接证明同一记录；历史拜访不阻止新事件。先补证收窄，实质同记录冲突或独立业务选择才集中问，已有决定不重复。无键、查询失败或截断如实说明覆盖，不统一禁止写入；0 行不证明全库唯一。批内重复按事件语义判断，不静默 CREATE 转 UPDATE。

## Defaults

Required Field 如果已经被可信默认机制真正满足，不要重复询问。可信来源包括：当前 Create Defaults、Record Type 默认、Page 默认、可信 Runtime Default、Platform Identity Default、Managed Runtime Default。

```text
Skill 自己猜的默认值  →  不算
Flow / Trigger 保存后才可能补值  →  不算当前 Required 已满足
```

Default 必须有实时 Runtime / Salesforce evidence。`defaultValueTruncated=true` 时不得把该值当成可信默认。

## CREATE 确认单（Hard Rule 52 放行规则）

确认单是 CREATE 的最后一个用户可见 Gate：所有技术就绪条件满足后、调用 `create_record` / `create_records` 之前，**MUST** 把本次将要写入的全部字段赋值列成一张清单交给用户确认。`CHANGE_READY=true` 与 `formContext.status=READY` 都不能替代这一步。

### 清单内容

- 覆盖 payload 的**全部**字段：必填与选填都列出，不得只列必填。
- 每项三要素：中文字段名（label）、拟写入值、值来源（直接提供 / 材料提炼 / 关联推导 / 系统默认 / 托管策略）。
- 由可信默认值、`MANAGED_ON_WRITE` / `DEFAULT_ON_WRITE` 或 Owner fallback 满足的字段，写「按系统默认 / 托管写入，无需提供」——用户由此知道该项不会被追问、但会生效。
- Record Type 选择、查重结论与覆盖限制作为背景一并说明，用户可据此否决整单。
- 呈现用业务语言：Picklist 展示 label（写入时仍按 [lookup-and-picklist.md](lookup-and-picklist.md) 解析真实 API Value），Lookup 展示业务名称；不向用户堆砌 API 字段名。

### 合并轮次

- 有必填缺口时：Hard Rule 48 的集中提问与已确定赋值**合并为同一轮**——「以下为拟写入内容，其中 X、Y 待你补充；确认后我将按此创建」。用户补全并放行，即视为对本清单的确认。
- 无缺口时：确认单本身是唯一新增轮次，**MUST NOT** 再为形式补第二轮确认。
- 用户在确认轮修改字段值后，条件必填可能变化：回到 REFINE 重算，再呈现一次修订后的清单（受 refinement 上限约束）。

### 批量

`create_records` 按 [batch-mutations.md](batch-mutations.md) 分组呈现：同一批可共用一次确认，但每条记录的字段值逐条列出；一条记录未 ready 或未被确认，该记录不进本批。

### 豁免与边界

- 唯一豁免：用户在当前任务或会话中**明确**表示「不用确认，直接建」。**MUST NOT** 由 Agent 推断、默认、跨会话延续，或从「业务任务已授权」「材料已读」「字段值全部来自用户原话」推导豁免——用户逐字提供全部值时，确认单仍然呈现（它同时展示类型选择、默认值与托管项）。
- 确认发生在对话层：不新增 Runtime 结构、Tool 参数或审批 Token；DML 审计由既有 P7 记录承载。
- 与 `formContext` 的服务端 SUBMIT 复核分层：服务端复核配置与必填（`MCP_FORM_NOT_READY` 拦截），用户确认业务内容；两者互不替代，也不得用「服务端会复核」为由跳过用户确认。

## 与用户的询问节奏

不要机械追求「整次 CREATE 只能问一次」。正确语义是：**当当前 Dynamic Forms dependency layer 已经稳定时，一次性合并询问这一层真正缺失的字段。**

确认单（Hard Rule 52）按同样的节奏执行：缺口询问与已知赋值合并为一轮；用户放行即确认；不再为形式追加第二轮。

示例（抽象，不绑定具体公司对象与字段名）：字段 A 处于 `PENDING`，`dependsOn` 返回字段 B，而字段 B 未知。先从材料、已有上下文或可用读取解决字段 B，仍缺关键事实才询问。用户回答后写入 draft 并 refinement，字段 A 可能变成 VISIBLE + Required，此时再询问字段 A。这是正确行为。

**MUST NOT** 为了「只问一次」提前猜测后续字段。**MUST NOT** 把具体字段 API 名写进本 Skill；`dependsOn` 与 draft 的字段名一律来自当前 Action Context。

## create_record 还是 create_records

按当前 `tools/list` 实际暴露的能力与请求规模自主选择，不要调用不存在的 Tool：

- 1 条记录 → 优先 `create_record`。
- 同对象多条完整记录 → 优先 `create_records`。
- 只有 plural 可见时，1 条也可以用 `create_records` 携带恰好 1 项。
- 只有 singular 可见时，多条可用有界逐条调用。
- 两者都不可见 → 该操作当前不可用，如实说明。

**MUST NOT** 复制或假设历史工具（例如 `sf_prepare_record_change`、`sf_commit_record_change`）仍存在，除非当前最新代码证明它们是正式 Tool Contract。

每条 `create_records` item 携带自己的 `recordTypeId` 与最新 `uiContextResolutionId`（当 Runtime 提供时）。**MUST NOT** 把收集 Context 用的 Record Type 与实际提交的 `recordTypeId` 混用。

范围边界：本节只负责**选择哪一个 Tool**。批量分组、`>200` 的完整分批计划、`allOrNone` 业务策略与 batch recovery 见 [batch-mutations.md](batch-mutations.md) 与 [outcome-reconciliation.md](outcome-reconciliation.md)。

UPDATE 的写入工具选择同理（singular `update_record` / plural `update_records`），但就绪判据是 [update-readiness.md](update-readiness.md) 的 Target Resolution 与 Minimal Patch，**MUST NOT** 套用本文件的 CREATE 就绪流程。

## 真人 UAT 回归案例（抽象表达，不绑定 org 数据）

场景：用户要求创建一个「客户拜访申请」类记录，并已经提供了部分字段。

当前 Action Context 表现为：

- 「计划交谈事项」类字段：`visibilityState=VISIBLE`、`effectiveRequired=true`、`effectiveEditable=true`、无默认值。
- 「客户」类字段：`visibilityState=PENDING`、`conditionalRequired=true`，尚无合法草案或适用默认满足，`dependsOn` 返回「来源」类字段；该条件确实可能改变本次所需值。
- 「来源」类字段：初始未知。
- 「归属人」类字段：可见必填，受 `PLATFORM_IDENTITY_FALLBACK` 管理。

正确行为必须同时满足：

1. 不能漏掉可见必填的「计划交谈事项」类字段。
2. 不能忽略仍影响本次所需值的 `dependsOn` 返回的「来源」类字段依赖直接 CREATE；无关选填 PENDING 不套用本例。
3. 「来源」类字段得到之后 refinement，再判断尚未满足的「客户」类字段是否确实需要。
4. Owner 必须遵守 explicit > fallback。
5. 所有 blocking condition 消失后才允许 CREATE。

场景二：用户给了一份真实的会议记录，要求建单并推进到「已完成」，其中两个按钮必填字段在材料里完全没有对应内容（例如「客户品质情况」「客户对现场管理能力的评价」）。

正确行为必须同时满足：

1. 不得因为「记录创建成功、其他字段萃取质量不错」就顺手把这两个字段用一句话填上。
2. 不得写入任何以「报告 / 文档 / 材料」为主语的句子（如 `报告未记录客户品质情况。`），也不得反推成「客户未反馈」「客户无此问题」。
3. 必须集中一次提问，把两个中文字段名一次列全，并给出可直接采纳的建议：「若本次确实未涉及，我将填“无”，确认吗？」
4. 用户确认后写入「无」，回执注明这是按确认填入的占位值；用户改口提供内容时按真实内容写入。
5. 若这两项所在的按钮表单还缺其它字段，必须与本次写入一次提交（见 Hard Rule 50），不得先写一半。
6. CREATE 本身 dispatch 前按 Hard Rule 52 呈现完整字段赋值确认单（与缺口提问合并为一轮）；按钮动作写入前同样把该步骤全部字段一次性汇总，不先写一半。

**MUST NOT** 把具体 Object API Name、公司 Record Type ID 或具体 Picklist API Value 写进本 Skill。测试 fixture 使用抽象数据或仓库既有测试模式。

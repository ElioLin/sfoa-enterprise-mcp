# CREATE Readiness

本文件是 CREATE 的 doctrine：如何发现事实、如何验证事实、什么条件阻塞写入。它不是固定的 Tool 调用脚本，也不规定必须按某个顺序调用哪个 Tool。有效上下文可以复用，没有必要的调用可以跳过。

## 当前 CREATE contract（以代码为准，不要凭记忆）

`get_record_action_context` 的 CREATE 输入：

| 输入 | 约束 |
| --- | --- |
| `objectApiName` | 必需，对象 API 名，不含关系路径 |
| `action` | 必需，`CREATE` |
| `recordTypeId` | 可选；显式给出时必须属于当前候选 |
| `recordId` | CREATE 禁止 |
| `draftFields` | CREATE 专用，可选；任务草稿值（提示、已读材料、可靠关联），用于条件可见性；missing 与 `null` / `false` / `0` / 空串不同 |
| `refinement` | CREATE 专用，可选；初始 0，最大 3 |

`draftFields` 与 `refinement` 是 CREATE 专用。UPDATE 不允许照搬这套机制。`recordTypeSelectionRequired=true` 时 Create Defaults / Picklist 相关事实还没有加载。

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

`apiRequired=true` 与 UI 可见性无关：即使字段在 UI 上 HIDDEN，API 必填语义仍然存在。

同时要区分：

- `layoutRequired` 与 `apiRequired` 是两套独立来源，`requiredSource` 会同时列出 `API`、`PAGE_LAYOUT`、`DYNAMIC_FORM`。
- `conditionalRequired=true` 表示该字段在某个 PENDING 状态下曾经是必填；它只有在可见性解析为 VISIBLE 之后才成为问题。
- `fieldCreateable=false` 或 `effectiveEditable=false` 的字段不能作为用户可填项；**MUST NOT** 通过反复试写去发现字段。
- 系统字段、公式字段、自动编号字段、只读字段不是用户问题。

**MUST NOT** 硬编码 Salesforce Required Fields，也不要为了「必填不漏」把所有 API-required 字段都拿来追问用户。

## Requiredness Source（当前 USER + Record Type + action）

必填口径按当前 USER、Record Type 与 action 的真实可用事实解析。CREATE effective resolver 可解析 active Lightning page；UPDATE 不具备完整 Edit Dynamic Forms。requiredChecklist 表示定义，不等于缺值问题清单；先比较材料、草案、原始 defaults 与 managed。

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
- 当前 Record Type 没有合法 Picklist 值时，换一个可用候选 Record Type 或集中追问一次；不得静默降级。
- 无法解析的 Lookup 按 [lookup-and-picklist.md](lookup-and-picklist.md) 处理；不要把姓名直接写入 Lookup Id 字段。

## Phone / Mobile

- 手机与电话按 [phone-and-mobile.md](phone-and-mobile.md) 按适用国家地区分类；仅中国大陆手机匹配 `^1[3-9]\d{9}$`（可带 `+86`）；电话匹配区号 `0\d{2,3}` + 7-8 位本地号码（可带分机）。
- 用户只说「电话/联系电话」时按值的格式判断字段；显式标签与格式冲突时先问。
- 无效、位数不符或歧义时，插入前提示并确认；**MUST NOT** 截断、补位、编造数字、把同一号码写入两个字段或静默换字段。
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

## 与用户的询问节奏

不要机械追求「整次 CREATE 只能问一次」。正确语义是：**当当前 Dynamic Forms dependency layer 已经稳定时，一次性合并询问这一层真正缺失的字段。**

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
- 「客户」类字段：`visibilityState=PENDING`，`dependsOn` 返回「来源」类字段。
- 「来源」类字段：初始未知。
- 「归属人」类字段：可见必填，受 `PLATFORM_IDENTITY_FALLBACK` 管理。

正确行为必须同时满足：

1. 不能漏掉可见必填的「计划交谈事项」类字段。
2. 不能忽略 `dependsOn` 返回的「来源」类字段依赖直接 CREATE。
3. 「来源」类字段得到之后必须 refinement，再重新判断「客户」类字段。
4. Owner 必须遵守 explicit > fallback。
5. 所有 blocking condition 消失后才允许 CREATE。

**MUST NOT** 把具体 Object API Name、公司 Record Type ID 或具体 Picklist API Value 写进本 Skill。测试 fixture 使用抽象数据或仓库既有测试模式。

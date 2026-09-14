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
| `draftFields` | CREATE 专用，可选；已知 Prompt 值，用于条件可见性；missing 与 `null` / `false` / `0` / 空串不同 |
| `refinement` | CREATE 专用，可选；初始 0，最大 3 |

`draftFields` 与 `refinement` 是 CREATE 专用。UPDATE 不允许照搬这套机制。`recordTypeSelectionRequired=true` 时 Create Defaults / Picklist 相关事实还没有加载。

CREATE 输出的关键字段：`recordType`、`availableRecordTypes`、`recordTypeSelectionRequired`、`fields[]`、`uiContext`、`uiContextResolutionId`、`coverage`。

`fields[]` 里与就绪判断直接相关的：`apiName`、`label`、`dataType`、`apiRequired`、`layoutRequired`、`fieldCreateable`、`layoutEditableForCreate`、`defaultValue`、`defaultValueTruncated`、`picklist`、`visibilityState`、`requiredSource`、`effectiveRequired`、`effectiveEditable`、`optionalCandidate`、`conditionalRequired`、`dependsOn`、`referenceTo`。

写入工具：`create_record`（1 条）与 `create_records`（同对象 1..200 条，`allOrNone` 默认 false，每项可带 `clientReferenceId` 作为批内关联键）。`create_record` 接受 `recordTypeId` 与 `uiContextResolutionId`；`uiContextResolutionId` 只是 Audit provenance，永远不改变授权或 payload，**MUST NOT** 自己编造。

## Initial Fact Ledger

先从用户自然语言中抽取**已经明确提供**的业务事实：对象线索、Record Type 语义、日期、客户、负责人、来源、计划交谈事项、参与人、状态、业务字段值、Lookup 语义、Picklist label。

把这些事实转成**当前 Salesforce Schema / Metadata 可证明的字段**后写入 draft。**MUST NOT** 硬编码字段映射；字段名必须来自当前 Action Context / ObjectInfo 证据。

Agent 侧的事实来源分类（**仅为 reasoning doctrine，不是 Runtime enum，也不新增数据库结构**）：

| 来源 | 含义 |
| --- | --- |
| `USER_EXPLICIT` | 用户在 Prompt 中明确给出，或用户在澄清中确认 |
| `SALESFORCE_CREATE_DEFAULT` | 当前 Action Context 的 Create Defaults 证明的默认值 |
| `RECORD_TYPE_DEFAULT` | 当前 Record Type 证据证明的默认值 |
| `CURRENT_USER_FACT` | 当前 USER 事实（例如 `$User.*`），由 Runtime 读取证明 |
| `TRUSTED_RUNTIME_DEFAULT` | Runtime 提供的可信默认事实 |
| `MANAGED_RUNTIME_DEFAULT` | 由 managed 字段策略在写入时由 Runtime 提供，Agent 不参与 |
| `UNRESOLVED` | 没有可信来源；不得当成已提供 |

Runtime 自身的 `InitialFact.source` 枚举是 `USER_EXPLICIT`、`SALESFORCE_CREATE_DEFAULT`、`CURRENT_USER_FACT`、`TRUSTED_RUNTIME_DEFAULT`、`UNRESOLVED`。`RECORD_TYPE_DEFAULT` 与 `MANAGED_RUNTIME_DEFAULT` 只是 Agent 侧的概念；若当前代码没有对应的 Runtime 枚举，**MUST NOT** 声称 Runtime 产生了它。

优先级：`USER_EXPLICIT` > 有实时证据的 Salesforce / Record Type / Runtime default > 无来源。用户已明确提供的事实不得无故重复询问。保留 `false` / `0` / `null` / 未提供之间的差异。

## Record Type Hard Gate

处理 `recordTypeSelectionRequired`、default Record Type、用户明确指定、多个候选、唯一候选：

1. **唯一候选** — `availableRecordTypes` 只有一个合法候选时直接采用，不需要额外提问。非 Master 类型按当前 Playbook 要求把解析出的 `recordType.id` 作为 `recordTypeId` 传入，不要省略后落到别的 Salesforce 默认。
2. **用户明确指定且唯一映射** — 用户业务语言能唯一映射到当前实时候选时，使用该 Record Type。
3. **多个候选且无法唯一判断** — **MUST** 询问，`CHANGE_READY=false`。先给出当前真实候选，等用户选择后再用同一 `recordTypeId` 重新获取 Context。
4. **Master** — 当前候选集在存在可用非 Master 类型时已经排除 Master。不要把它加回来，也不要在这个情况下选择它。只有当 Master 是唯一可用类型时才保留并使用它，且不需要询问。
5. **没有可用候选** — 停止并告知用户该记录当前无法创建；**MUST NOT** 在不可用或猜测的 Record Type 下创建。

**默认值不是用户业务意图的替代品。** 存在 Salesforce default Record Type 不构成在多个真实业务候选之间静默替用户选择的理由。

**MUST NOT** 在 Skill 中写死 Record Type ID、DeveloperName 或公司特定 Record Type；必须从 Runtime / Salesforce 实时发现。

## Missing Required Checklist

综合当前真实证据形成缺口清单：`apiRequired`、`layoutRequired`、Dynamic Forms Required（`requiredSource` 含 `DYNAMIC_FORM`）、`conditionalRequired`、以及 `effectiveRequired`。

必须满足的判定：

```text
VISIBLE + effectiveRequired=true + 当前没有显式值 + 没有可信默认值满足
→ 一定进入 Missing Required Checklist
```

`apiRequired=true` 与 UI 可见性无关：即使字段在 UI 上 HIDDEN，API 必填语义仍然存在。

同时要区分：

- `layoutRequired` 与 `apiRequired` 是两套独立来源，`requiredSource` 会同时列出 `API`、`PAGE_LAYOUT`、`DYNAMIC_FORM`。
- `conditionalRequired=true` 表示该字段在某个 PENDING 状态下曾经是必填；它只有在可见性解析为 VISIBLE 之后才成为问题。
- `fieldCreateable=false` 或 `effectiveEditable=false` 的字段不能作为用户可填项；**MUST NOT** 通过反复试写去发现字段。
- 系统字段、公式字段、自动编号字段、只读字段不是用户问题。

**MUST NOT** 硬编码 Salesforce Required Fields，也不要为了「必填不漏」把所有 API-required 字段都拿来追问用户。

## Defaults

Required Field 如果已经被可信默认机制真正满足，不要重复询问。可信来源包括：当前 Create Defaults、Record Type 默认、Page 默认、可信 Runtime Default、Platform Identity Default、Managed Runtime Default。

```text
Skill 自己猜的默认值  →  不算
Flow / Trigger 保存后才可能补值  →  不算当前 Required 已满足
```

Default 必须有实时 Runtime / Salesforce evidence。`defaultValueTruncated=true` 时不得把该值当成可信默认。

## 与用户的询问节奏

不要机械追求「整次 CREATE 只能问一次」。正确语义是：**当当前 Dynamic Forms dependency layer 已经稳定时，一次性合并询问这一层真正缺失的字段。**

示例（抽象，不绑定具体公司对象与字段名）：字段 A 处于 `PENDING`，`dependsOn` 返回字段 B，而字段 B 未知。第一次只应该询问字段 B。用户回答后写入 draft 并 refinement，字段 A 可能变成 VISIBLE + Required，此时再询问字段 A。这是正确行为。

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

范围边界：本节只负责**选择哪一个 Tool**。超过当前 200 上限的完整分批计划、`allOrNone` 业务策略与复杂 batch recovery 属于后续阶段；遇到时只要求如实说明边界，不自行设计编排方案。

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

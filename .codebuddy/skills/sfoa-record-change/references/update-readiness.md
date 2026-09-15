# UPDATE Readiness

本文件是 UPDATE 的 doctrine：如何确定目标记录、如何确定用户真正要改的字段、什么时候还不能写。它是判断规则，不是固定的 Tool 调用脚本。简单 UPDATE 允许复用仍然可信的 Context；没有必要的调用可以跳过。

核心命题：

```text
Do we know exactly what record to change,
exactly what the user intends to change,
and only those fields?
```

## 当前 UPDATE contract（以代码为准，不要凭记忆）

`get_record_action_context` 的 UPDATE 输入：

| 输入 | 约束 |
| --- | --- |
| `objectApiName` | 必需，对象 API 名，不含关系路径 |
| `action` | 必需，`UPDATE` |
| `recordId` | **UPDATE 必需**；缺少时 Runtime 直接拒绝 |
| `recordTypeId` | 可选；给出时必须与 `recordId` 推导出的 Record Type 一致，否则 Runtime 拒绝，**不会**切换 Record Type |
| `draftFields` | 仅 CREATE。UPDATE 传入会被 Runtime 以「draftFields and refinement are CREATE-only」拒绝 |
| `refinement` | 仅 CREATE。同上 |

UPDATE 输出与 CREATE 的关键差别（都是当前代码事实，不是设计愿望）：

- **不返回** `availableRecordTypes`、`recordTypeSelectionRequired`：现有记录已经有 Record Type，不存在「选择」这一步。`recordType` 只描述当前生效的那一个。
- **不返回 defaults**：`defaults` 为空对象。UPDATE 的 omission 语义是 preserve，没有 Create Default 可套用。
- **不产生** `effectiveEditable` / `visibilityState` / `requiredSource`：这些 effective 属性属于 CREATE Dynamic Forms 路径。`dynamicFormsEvaluated` 恒为 `false`。
- `fields[]` 按 `fieldUpdateable` 过滤，并提供 `fieldUpdateable`、`layoutEditableForUpdate`（Page Layout Edit 模式），这是 UPDATE 侧的 editable 证据。
- 提供 `picklist`（按当前 Record Type），用于 Picklist / Dependent Picklist 归一。
- `coverage.warnings` 明确说明：该 coverage 是 Page Layout / UI API 的 action context，**不是**完整的 Dynamic Forms 或 Lightning 组件可见性求值。

写入工具：`update_record`（严格 1 条）与 `update_records`（同对象 1..200 条，`allOrNone` 默认 false，每项可带 `clientReferenceId`）。

```text
update_record  = { objectApiName, recordId, fields }
update_records = { objectApiName, allOrNone?, records: [ { recordId, fields, clientReferenceId? } ] }
```

两个 schema 都是 `.strict()`。`update_record` **没有** `recordTypeId` 与 `uiContextResolutionId` 参数：Record Type 变更只能通过 `fields` 中的 Record Type 字段表达，而且当前 Action Context 不会为它做变更后推演。

## Gate 1 — TARGET_RESOLVED

UPDATE **必须**先回答「到底改哪一条 Salesforce Record」。可接受的证据来源：

```text
明确 Record ID
当前会话刚创建/刚确认过的 Record（并有证据）
用户提供的唯一业务 Key
有界查询得到唯一结果
用户从候选中明确选择了一个
```

### 0 / 1 / Multiple

| 目标匹配 | 处理 |
| --- | --- |
| 0 match | `CHANGE_READY=false`。**MUST NOT** 猜测，**MUST NOT** 用创建新记录替代 UPDATE |
| 1 match（唯一证据） | `TARGET_RESOLVED`，可以继续准备 Patch |
| multiple match 且意图是单条 UPDATE | **MUST** clarification，`CHANGE_READY=false`。**MUST NOT** 选第一条、最新一条或名字最像的一条 |
| 用户明确说「所有符合条件的记录」 | 目标是 Target Population，走 [batch-mutations.md](batch-mutations.md)，不适用单条澄清 |

业务 Key 不唯一是常态，不是例外。同一个客户名、同一个主题在真实 org 里重复很常见；这正是必须澄清而不是猜的理由。

### Target Population 的完整性

一旦用户意图是批量范围，`TARGET_RESOLVED` 升级为「范围已被证明完整」：

```text
要求：查询覆盖真正符合条件的全部记录
```

`LIMIT`、截断、超时、缺少完成标志都不能证明「已经找全」。**MUST NOT** 只处理有界查询返回的那一部分然后宣称全部完成。这继承 Core 的 `Claim Scope <= Evidence Scope` 与 Full Population 原则。

## Gate 2 — Mutation Scope 与 Minimal Patch

**Minimal Patch** 是 UPDATE 的第二个 Gate。

确定用户**真正要求改变**的字段集合。

```text
Mutation Intent（用户要改什么）
≠
Read Facts（查询返回了什么）
```

判定规则：

- 用户明确点名的字段 → 进入 Patch。
- 用户没有提到、只是被查询顺带返回的字段 → **不进入** Patch。**MUST NOT** 「查到什么就 update 什么」。
- 某个字段之所以进入 Patch，只有当「用户要求」或「当前 Runtime 明确要求的最小必要结构」成立。后者必须有实时证据，**MUST NOT** 用 CREATE 侧的必填清单凑。

用户已明确提供的事实 **MUST NOT** 重复询问。用户说「把拜访日期改到下周三」时，目标与要改的字段都已经明确，直接进入预备，不需要再次确认。

## Gate 3 — Field 是否允许提交

UPDATE 的核心 editable 证据是 `fieldUpdateable` 与 `layoutEditableForUpdate`。

```text
当前证据证明字段不可更新
→ MUST NOT 提交该字段
→ 如实说明当前 Salesforce 上下文不允许修改该字段
```

**MUST NOT** 为了「试试看」而跳过 UI context 直接发 DML 探测；反复试写不是证据获取手段。

关于 UI editability 与 DML authority 的关系：当前 Runtime 的定位是 **UI context 是有效的可编辑性证据，Salesforce 仍是最终写入权威**。两者不是同一件事，也**不是**「UI 不可编辑就一定不能写」的单向规则：

- 证据明确显示字段不可更新时，**MUST NOT** 提交。
- 当页面布局与字段级权限出现分歧、或证据不足以判断时，**MUST** 如实说明证据状态，并以当前 Tool Contract / Salesforce 裁决为准，**MUST NOT** 自行发明一条「UI 优先」或「DML 优先」的规则。
- **MUST NOT** 建立一个 Skill 侧的权限引擎来重算可写性。

如果本 Skill 的这段描述与当前代码或 Runtime 行为冲突，以运行时事实为准，并把差异当作 Runtime Defect 记录。

## Omitted / null / false / 0 / ""

五种事实，五种处理：

| 事实 | 含义 | 处理 |
| --- | --- | --- |
| 字段未出现（omitted） | 不修改该字段 | omission = preserve current value。**MUST NOT** 转成 `null` |
| `null` | 清空该字段值 | 只有用户明确表达清空 / 删除该字段值 / 取消选择，且 Runtime 允许时才发送 |
| `false` | 显式布尔值 | 保留为显式值。**MUST NOT** 因为「看起来像空」而删除 |
| `0` | 显式数值 | 保留为显式值。**MUST NOT** 当作未提供 |
| `""` | 空字符串 | 按当前 Salesforce 字段语义与 Tool Contract 判断。**MUST NOT** 自动等同于 `null` |

最常见的错误是把「用户没提这个字段」实现成「把这个字段清空」。这两件事完全不同，后果是破坏用户没要求修改的数据。

## Required 语义

```text
CREATE Required  !=  UPDATE Missing Required
```

记录已经存在，创建期的必填缺口不是本轮的必填缺口。**MUST NOT**：

- 因为某字段「创建时必填」就在 UPDATE 时要求用户重新提供。
- 把整张 CREATE 表单当成 UPDATE 的前置检查。
- 因为本次没提交某必填字段就判定 UPDATE 不完整。

只有当**当前 Runtime / Salesforce 证据**证明本次 UPDATE 本身要求该字段时才需要它。判据来自当前 UPDATE path 的反馈，而不是 CREATE 的必填清单。

## Defaults

```text
更新时 omission = preserve current value
```

**MUST NOT** 把 CREATE default 重新应用到 UPDATE。UPDATE 的 Action Context 不返回 defaults，这本身就是 Runtime 的表达：没有可套用的 Create Default。

特别地，`PLATFORM_IDENTITY_FALLBACK` 是 **CREATE 专用**的 omission 行为。UPDATE 时用户没有要求修改 Owner，**MUST NOT** 重新注入当前用户或任何值。详见 [managed-lookups.md](managed-lookups.md)。

## Owner / Managed Lookup

| 情况 | 处理 |
| --- | --- |
| 用户没要求改 Owner | 不动该字段。**MUST NOT** 注入、**MUST NOT** 默认、**MUST NOT** 询问 |
| 用户明确要求改 Owner | 走 LOOKUP 流程：解析 → 候选 → 唯一匹配 → 验证 Lookup Filter → 写 Salesforce ID |
| 0 match | block，`CHANGE_READY=false` |
| multiple match | clarification，`CHANGE_READY=false` |
| 显式 Owner 解析失败 | **MUST NOT** 自动 fallback 到当前用户或任何其他候选 |

严格 managed 字段（`PLATFORM_IDENTITY`、`AI_CREATED_MARKER`）在 UPDATE 中同样**不可修改、不可覆盖、不可自行生成值**。即使用户要求，也按当前 Tool Governance / Runtime policy 返回真实限制。

## Lookup UPDATE

沿用统一规则，**MUST NOT** 随机选择、取第一条或模型生成 ID：

```text
0 match        → block
1 match        → 使用已证明的 Salesforce ID
multiple match → clarification
```

提交后若被 Lookup Filter 拒绝，按 FAILED 处理并如实报告，**MUST NOT** 自动换一个候选重试。

## Picklist / Dependent Picklist UPDATE

用户用业务 Label 交流，DML 用当前 Salesforce API Value。

```text
用户：把状态改成“已完成”
→ 从当前 Action Context 的 picklist.values[] 解析
→ Label 已完成 ↔ API Value（实时取得）
→ payload 写 API Value
```

**MUST NOT** 在 Skill 里硬编码任何 Label → API Value 映射。

Dependent Picklist 必须确认当前 controller 值（记录现有值，或用户本次同时修改的新值），再只看该 controller 下 `validFor` 允许的候选。**MUST NOT** 从全局 Picklist 候选里猜一个 API Value。

## Record Type 语义

```text
普通 UPDATE → 沿用记录当前的 Record Type，不询问，不改动
```

**MUST NOT** 重新执行 CREATE 的 Record Type selection，**MUST NOT** 自动写入 Record Type 字段。

用户明确要求变更 Record Type 时（例如「把这条申请改成客户来访」）：

1. 解析当前允许的 Record Type 候选。
2. 唯一解析用户目标；歧义时澄清。
3. 确认目标字段按当前证据可修改 / 当前 Runtime 允许。
4. 由 Salesforce / Runtime 作为最终 authority 裁决结果。
5. **MUST NOT** 自行模拟变更后的 Dynamic Forms 状态，**MUST NOT** 把 CREATE 的 `draftFields` / `refinement` 伪造到 UPDATE。

当前 Runtime 的 UPDATE Action Context 不会为新的 Record Type 做 hypothetical 推演，并且明确拒绝与 `recordId` 推导结果不一致的 `recordTypeId`。因此变更后的字段可见性与必填状态属于 **Salesforce 裁决**，不是 Skill 或模型可以预判的事实。如实说明这一点，而不是给用户一个模型编造的结论。

## Dynamic Forms 在 UPDATE 中的边界

**MUST NOT** 在 UPDATE 中建立一个假的 CREATE form completeness。

- 只有本次要修改的字段需要「当前有效、当前可更新、当前依赖关系可解析」。
- 用户修改 controller 类字段可能改变其他字段的 UI 显隐；**MUST NOT** 因此要求用户重新填写整张 CREATE 表单。
- 当前 Runtime **不提供** Dynamic Forms UPDATE 的预计算。Skill **MUST** 承认这个能力边界，**MUST NOT** 用模型猜补齐。
- 最终 authority 仍然是 Salesforce Validation、Flow、Trigger、Lookup Filter 与 DML Runtime。

## UPDATE 的 blocking conditions

以下任何一项为 true，`CHANGE_READY=false`：

| Blocking condition | 判定依据 |
| --- | --- |
| Intent 不是明确的 UPDATE | 用户意图未确定或实为其他操作 |
| Object 未确定 | 目标对象不可由当前 Runtime / Salesforce 证明 |
| Target 未解析 | 0 match，或单条意图下 multiple match 未澄清 |
| Target Population 范围未证明完整 | 查询有界且缺少完整证据，却要宣称全部已更新 |
| Mutation scope 不明确 | 不知道用户到底要改哪些字段 |
| Patch 含非意图字段 | 出现用户没要求且 Runtime 未证明必要的字段 |
| 字段不可更新 | 当前证据显示 `fieldUpdateable=false` 或 `layoutEditableForUpdate=false` 且用户要求修改它 |
| 值与字段类型不符 | 提交值无法作为当前字段类型的合法 Salesforce 值 |
| Lookup 歧义未解决 | 0 match 或 multiple match |
| Picklist 未归一 | 未解析成当前 Record Type 的真实 API Value |
| Dependent Picklist controller 未确定 | controller 值未知 |
| Managed 字段规则未满足 | 要求修改严格 managed 字段，或显式 Owner 解析失败 |
| Record Type 意图未解析 | 用户要求变更但候选 / 许可未确认 |
| 证据不足或被截断 | 关键的 UPDATE context 事实缺失 |
| Mutation Intent 与最终 Patch 不一致 | Patch 超出用户要求的范围 |

全部为 false 时才 `CHANGE_READY=true`，此时才允许 `update_record` / `update_records`。

## 明确不算 blocking condition

- 只因为「还没调用过某个 Tool」。证据已经足够时不需要为了形式完整再调用。
- 只用 CREATE 的必填清单来判断缺什么。
- 只因为 Runtime `coverage=PARTIAL`。`coverage` 描述解析范围；要看 critical 证据是否受影响。
- 只因为 optional 字段为空。
- 只因为存在 Salesforce 默认值或 managed fallback。UPDATE 不套用 CREATE 默认。
- 只因为记录当前 Record Type 是 Master 之类「看起来不理想」的类型。

## 与 CHANGE_READY 的关系

UPDATE 与 CREATE 共用 `CHANGE_READY` 这一个逻辑概念，**MUST NOT** 为此新增 DB 状态、新 Tool、新 Runtime Enum、State Table、Mutation Workflow DB 或 Patch Approval Token。本 Skill 始终只是 Agent Operating Doctrine。

## 真人 UAT 参考场景（抽象表达，不绑定 org 数据）

场景：用户在多轮对话中刚完成一条「客户拜访申请」类记录的创建，然后说「把刚才那个申请的拜访日期改到下周三」。

正确行为必须同时满足：

1. 复用会话证据解析出**唯一**目标记录；若上下文出现两条候选，**MUST** 澄清。
2. 只把日期类字段放入 Patch。
3. **MUST NOT** 重新索要客户、来源、计划交谈事项或 Owner。
4. **MUST NOT** 因为日期字段在创建时是必填就重新追问其他创建期必填字段。
5. **MUST NOT** 注入 Owner fallback。
6. **MUST NOT** 改动 Record Type。
7. 日期值必须解析成当前字段类型可接受的表示，而不是把中文日期原样写入。

**MUST NOT** 把具体 Object API Name、公司 Record Type ID 或具体 Picklist API Value 写进本 Skill。测试 fixture 使用抽象数据或仓库既有测试模式。

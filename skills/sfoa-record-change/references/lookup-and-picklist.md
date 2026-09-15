# Lookup and Picklist

## Lookup

字段是否可引用对象由当前 Action Context 的 `referenceTo` 决定；**MUST NOT** 从字段名或业务常识推断它指向哪个对象。

解析用有界 USER 读取（例如 `run_soql_query`）返回候选 Salesforce ID 与可区分的业务字段。**只有唯一证明的 ID 才可写入。**

| 情况 | 处理 |
| --- | --- |
| 1 match | 有真实证据得到唯一 Salesforce ID → 可以写入 |
| 0 match | **MUST NOT** 猜。`CHANGE_READY=false`，如实告知没有找到匹配记录 |
| multiple match | **MUST NOT** 选第一条。**MUST** 让用户澄清；`CHANGE_READY=false` 直到唯一 |

绝对禁止：

```text
凭名字猜 Salesforce ID
模型生成 ID
多个同名随机选一个
显式用户 lookup 失败后改用另一个候选
把姓名直接写进 Lookup Id 字段
```

如果 DML 阶段被 Salesforce Lookup Filter 拒绝，按 FAILED 处理并如实报告；**MUST NOT** 自行寻找其他候选自动重试。Salesforce 的 FLS / Sharing / Lookup Filter 是最终裁决。

server-managed lookup 见 [managed-lookups.md](managed-lookups.md)：严格 managed 字段不询问也不提交；`PLATFORM_IDENTITY_FALLBACK` 字段在用户显式指定时才由 Agent 解析。

## Picklist

用户交互优先 **Label**（例如用户说「客户」）。最终 DML payload **MUST** 使用当前 Salesforce 真实 **API Value**。

```text
Label = 客户
API Value = CUSTOMER
→ payload 写 CUSTOMER
```

不能直接写中文 Label，除非当前真实 Salesforce API Value 本身就是中文。解析必须通过实时 Metadata / Runtime resolution（当前 Action Context 的 `picklist.values[]` 或 `resolve_field_display_values`）。**MUST NOT** 硬编码 Label → API Value 映射。

Action Context 的 picklist 结构：`controllerName`、`controllerValues`、`values[{ label, value, default, validFor }]`、`totalValues`、`returnedValues`、`truncated`。

- 只使用**当前 Record Type**返回的候选。不同 Record Type 的 Picklist 候选可以不同。
- 向用户展示候选时给出当前有效的有界选项；**MUST NOT** 编造、翻译或自行归一化存储值。
- `picklist.truncated=true` 时表示候选被截断；**MUST NOT** 把截断后的集合当成完整候选，也不要因此猜测缺失值。

### Dependent Picklist

```text
先解决 Controller 字段
→ 再解析当前 controller 下合法的候选
```

用 `controllerName` 与 `controllerValues` / `validFor` 关系过滤。**MUST NOT** 拿完整全局 Picklist 列表让模型自己猜，也 **MUST NOT** 展示未过滤的 dependent 候选集。

Controller 值本身还没确定时，先确定 Controller —— 这和 Dynamic Forms 的 PENDING 依赖是同一类问题：先补前置条件，再重新解析，见 [dynamic-forms.md](dynamic-forms.md)。

### 展示与写入的分工

面向用户的回答使用 Label；SOQL 过滤、DML payload、Tool evidence 与 Audit 使用原始 API Value。只有用户明确要求 API Value 或技术诊断时才展示 raw value。

## UPDATE 场景的补充

UPDATE 不需要选择 Record Type，但 Picklist 候选仍然**依赖记录当前生效的 Record Type**：

```text
get_record_action_context(action=UPDATE, recordId=...)
→ 返回 recordType（当前生效的那一个，不是候选列表）
→ picklist.values[] 按该 Record Type 返回
```

**MUST NOT** 拿另一个 Record Type 的候选集来判断本次更新是否合法。

Dependent Picklist 在 UPDATE 中确认 controller 的方式是：记录当前的 controller 字段值，或用户本次同时正在修改的新 controller 值。**MUST NOT** 从全局 Picklist 候选里猜一个 API Value。

清空类意图要按 §Omitted / null 的规则处理：用户明确表达清空 / 取消选择时才发送清空语义；**MUST NOT** 把「没提这个 Picklist」实现成「把它清空」。

## 与 Change Readiness 的关系

以下任一情况都使 `CHANGE_READY=false`：

- Lookup 0 match 或 multiple match
- 显式用户指定的 Lookup 无法唯一解析
- Picklist 还没有解析成当前 Record Type 的真实 API Value
- Dependent Picklist 的 controller 尚未确定
- 提交字段的 `referenceTo` 与用户指定的对象不一致
- UPDATE 中提交了当前证据证明不可更新的字段（`fieldUpdateable=false` 或 `layoutEditableForUpdate=false`）
- UPDATE 中提交了用户并未要求修改的 Lookup / Picklist 字段

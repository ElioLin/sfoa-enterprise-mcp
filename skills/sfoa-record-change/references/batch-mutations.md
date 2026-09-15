# Batch Mutations

本文件覆盖 `create_records` 与 `update_records` 的批量 doctrine，重点是 `update_records`。

## 当前 batch contract（以代码为准）

| 事实 | 值 |
| --- | --- |
| 批量大小 | `records` 1..200（schema 硬上限） |
| 同对象 | 是。一次请求只能一个 `objectApiName` |
| 每项结构 | CREATE：`{ recordTypeId?, uiContextResolutionId?, fields, clientReferenceId? }`；UPDATE：`{ recordId, fields, clientReferenceId? }` |
| 每条字段 | 各自独立，**允许不同 Patch** |
| `allOrNone` | 可选，**默认 `false`**；只回滚**本次 Salesforce 请求**，永不跨 Tool 调用 |
| `clientReferenceId` | 可选，`1..128`，批内唯一；只做关联，**不是** Salesforce 字段，**不是**幂等键 |
| 重复目标 | `update_records` 对同一 Salesforce Record 的重复项会在 dispatch 前被拒绝（错误码 `MCP_DML_BATCH_DUPLICATE_RECORD_ID`） |
| 结果 | 批级 `SUCCESS` / `PARTIAL_SUCCESS` / `FAILED` / `OUTCOME_UNKNOWN`；逐条 `SUCCESS` / `FAILED` / `OUTCOME_UNKNOWN` |
| 分块 | **代码不在一次请求内自动分块**。超过 200 的拆分由 Agent 规划成多个有界调用 |

`MCP_DML_BATCH_DUPLICATE_RECORD_ID` 的判重以 15 位前缀为身份，因此同一个记录的 15 位与 18 位写法也会被识别为重复。这是 Runtime 已有的保护：**MUST NOT** 在 Skill 或 Agent 侧再实现一套重复检测逻辑，但 Agent 在 batch planning 中**应**避免生成重复目标。

工具选择按当前 `tools/list` 实际暴露的能力决定，**MUST NOT** 调用不存在的 Tool：

```text
1 条            → 优先 singular（create_record / update_record）
2..200 条同对象 → 优先 plural（create_records / update_records）
只有 plural    → 1 条也可用 plural 携带恰好 1 项
只有 singular  → 多条用有界逐条调用
都不可见        → 该操作当前不可用，如实说明
```

## Per-Record Readiness

批量就绪是**逐条**的：

```text
∀ record: CHANGE_READY(record) == true
```

**MUST NOT** 出现：

```text
9 条 Ready + 1 条 Not Ready = 整个 batch 大概 Ready
```

只要还有一条未 ready，默认**先不 dispatch 本批**。理由不是形式主义，而是避免用户还在补充信息时已经产生部分 Salesforce 副作用。

### Progressive execution 的例外

只有用户**明确**要求「能处理的先处理」这类 progressive execution 时才允许先提交可处理子集。此时：

- **MUST** 如实报告哪些已提交、哪些还没有。
- **MUST NOT** 让未 ready 的记录在后续被静默并入一个已经 dispatch 过的批次里重新提交。
- **MUST NOT** 把「先处理一部分」说成整体完成。

## Clarification 顺序

```text
A READY
B READY
C Owner ambiguous
→ 默认先解决 C，不要先更新 A/B
```

除非用户明确允许 progressive execution。目的是让用户补充信息的过程不产生任何 Salesforce 副作用。

## 同 Object 分组

一次请求只能一个对象。不同 Object **MUST** 按 Object 分组，**MUST NOT** 强行塞进一个 batch：

```text
对象 X 的 N 条 → 一次 update_records
对象 Y 的 M 条 → 另一次 update_records
```

组内可以继续按 Record Type / 相关字段语义 / Context 复用范围细分，以复用同一份 Action Context，但**不得**为了减少调用次数而把字段语义不同的记录混在一起造成误写。

## 每条可有不同 Patch

```text
同对象记录可以每条具有不同 Patch（前提：当前 Tool Contract 支持）
```

**MUST NOT**：

- 因为用 batch 就强行让所有记录更新相同字段。
- 把某条记录的字段值复制给其他记录。

每条的 `fields` 都从该条记录自己的 Mutation Intent 推导。

## 范围与上限

### ≤ 200

一次请求完成。

### > 200：有界顺序分批

固定一个**有限计划**，并全程跟踪 `total` / `processed` / `succeeded` / `failed` / `unknown`：

```text
500 records，limit=200
→ 200 + 200 + 100
```

```text
Batch 1
↓ 确认 outcome
Batch 2
↓ 确认 outcome
Batch 3
```

**MUST NOT** 一次性并行发送全部 batch：那会让一批的未知结果污染其他批的判定，并放大未知副作用的范围。

任意一批出现 `OUTCOME_UNKNOWN` 时：

```text
停止后续 batch
→ 先解析该批 outcome
→ MUST NOT 继续扩大未知副作用范围
```

**MUST NOT** 无限循环，**MUST NOT** 跨批次宣称全局原子事务 —— 跨 Tool 调用没有全局 `allOrNone`。

## allOrNone 策略

默认使用 `allOrNone=false`，保持每条结果可独立解释、可独立补救。

只有用户业务意图明确表达「这一批必须全部成功，否则全部不要修改」，或存在明确的强事务语义时，才考虑 `allOrNone=true`：

- **MUST NOT** 因为「看起来更安全」就自动设置 `allOrNone=true`。把独立业务记录绑成原子组会让单条业务失败连带回滚本来成功的记录。
- **MUST NOT** 向用户暗示跨多个分批可以实现全局原子事务。

`allOrNone=true` 的范围是**本次 Salesforce 请求**。这是当前 Runtime 的语义，**MUST NOT** 把它描述成跨 Tool 事务。

## clientReferenceId

用于把结果与输入记录可靠关联，尤其在 `result` 数组顺序不能作为映射依据时。

```text
clientReferenceId  !=  Salesforce idempotency key
clientReferenceId  !=  Salesforce 业务字段
```

- 必须用返回的显式 `clientReferenceId → recordId` 映射，**MUST NOT** 按数组位置猜对应关系。
- **MUST NOT** 因为存在 `clientReferenceId` 就认为 `UNKNOWN` 可以安全重试。UNKNOWN 后仍**禁止**自动重放，见 [outcome-reconciliation.md](outcome-reconciliation.md)。
- 批内必须唯一；Runtime 会拒绝重复的 `clientReferenceId`。

## 汇报

- 如实报告逐条结果与计数，结论范围**不得超过**证据覆盖的记录范围。
- **MUST NOT** 把一批的结论扩大到未提交的记录。
- 用户可见的回答使用业务 Label 与展示字段；技术值按 Core 的响应规则处理。

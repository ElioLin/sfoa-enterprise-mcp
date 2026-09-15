# Outcome Reconciliation

本文件覆盖写回结果的读取、逐条语义、`PARTIAL_SUCCESS`、以及 `UNKNOWN` 的核对 doctrine。

## 单条 `create_record` / `update_record`

输出为 `{ success, recordId?, errorCode?, message?, salesforceErrors? }`。没有 batch 的 `status` 枚举。

- `success=true` 且有 `recordId` → 该记录已写入。
- `success=false` 或 Tool 报错 → 没有成功证据；如实报告 `errorCode`、`message` 与 `salesforceErrors`，不要把失败说成完成。
- `MCP_DML_OBJECT_NOT_ALLOWED` / `MCP_DML_OPERATION_NOT_ALLOWED` / 输入校验错误表示**尚未 dispatch**，没有 Salesforce 副作用。这属于治理结果，**MUST NOT** 用其他通道、角色或工具绕过。
- `MCP_DML_OUTCOME_UNKNOWN` 或请求发出后超时 / 传输中断 → 提交状态不可证明。

## 批量 `create_records` / `update_records`

输出为 `{ success, status, total, succeeded, failed, unknown, allOrNone, errorCode?, message?, results[] }`，`results[]` 逐项给出 `index`、`clientReferenceId`、`success`、`status`、`recordId` 与错误信息。

| 批级 status | 含义 | 允许的动作 |
| --- | --- | --- |
| `SUCCESS` | 本请求全部成功 | 可以报告成功 |
| `PARTIAL_SUCCESS` | 部分已提交，部分失败 | 已成功项已提交，**MUST NOT** 整批重发 |
| `FAILED` | 本请求没有提交任何项 | 可以按真实失败原因重新准备 |
| `OUTCOME_UNKNOWN` | 提交状态不可证明 | **MUST NOT** 自动重试 |

逐条 `results[].status` 的下标与输入项一一对应，取值 `SUCCESS` / `FAILED` / `OUTCOME_UNKNOWN`。

`isError` 描述 Tool 执行是否完成，不描述每条业务记录是否成功：`SUCCESS` 与 `PARTIAL_SUCCESS` 是 `isError=false`，只有 `FAILED` 与 `OUTCOME_UNKNOWN` 是 Tool error。**MUST NOT** 因为 `isError=false` 就声称全部记录成功；**MUST** 以**逐项结果与计数**确认。

`allOrNone=true` 只回滚**本次 Salesforce 请求**，永远不覆盖其他 Tool 调用。`clientReferenceId` 只是批内关联键，**不是** Salesforce 业务字段，**不是** 幂等键。用返回的显式 `clientReferenceId → recordId` 映射，不要按数组位置猜对应关系。

## FAILED != UNKNOWN

```text
FAILED  = 有可信证据证明失败（未提交）
UNKNOWN = 无法证明成功或失败
```

两者**MUST NOT** 混淆：

- 把 `FAILED` 说成 `UNKNOWN` 会让用户以为写入可能已经发生，产生不必要的排查成本。
- 把 `UNKNOWN` 说成 `FAILED` 更危险：可能掩盖一条已经提交的记录，导致重复创建或重复更新。

必须逐条保留逻辑状态，而不是把整批压成一个结论。例如：

```text
A SUCCESS
B UNKNOWN
C FAILED
→ A 不重试
→ C 可在修复后单独重试
→ B 不得重试，直到 outcome 被解析
```

## UNKNOWN 不得自动重放

```text
UNKNOWN / OUTCOME_UNKNOWN / MCP_DML_OUTCOME_UNKNOWN
→ MUST NOT 自动重复 create_record / create_records / update_record / update_records
```

UPDATE 看似幂等并不构成重试许可。重复 UPDATE 可能再次触发：

```text
Flow
Trigger
Automation
Integration
Audit
Notification
```

这些副作用与「字段最终值相同」是两件事。因此：

```text
UNKNOWN → no automatic replay
```

即使本次请求是「把状态设置成某个值」这种结果看起来确定的操作，也**MUST NOT** 自动重放。

## UPDATE 的 Read-Back 优势与它的限度

UPDATE 通常已经知道 `recordId`，因此 UNKNOWN 后可以回读当前记录状态。这是 UPDATE 相对 CREATE 的优势，但**证据的解释必须谨慎**。

### Read-Back != Transaction Success

```text
用户要求：状态类字段 = 已完成
UNKNOWN 后回读发现：状态类字段 = 已完成
```

这最多证明：

```text
当前 Desired State 已满足
```

**不一定**证明刚才那次 UPDATE transaction 成功，因为：

- 该字段可能本来就是期望值（本次 UPDATE 是 no-op 或未生效）。
- 其他自动化、集成或用户可能同时修改了它。

因此：

```text
Current State Evidence  !=  Transaction Outcome Evidence
```

**MUST NOT** 把「现值符合期望」自动升级成「本次写入成功」。

## Outcome Reconciliation 流程

UNKNOWN 后可以尝试用**独立、只读**的证据确定结果：

```text
独立 Salesforce 只读查询
已知 Record ID（UPDATE 侧）
业务唯一 Key（CREATE 侧）
当前字段状态
已有 Audit evidence
```

判定：

| 证据情况 | 结论 |
| --- | --- |
| 独立证据足以证明写入已经发生 | `UNKNOWN → SUCCESS` |
| 独立证据足以证明写入没有发生 | `UNKNOWN → FAILED`，此时若原 Mutation Intent 仍有效，重试才变得 eligible |
| 证据不足以区分 | 保持 `UNKNOWN` |

**MUST NOT** 在证据不足时给出一个「大概成功」的结论。**MUST NOT** 用 Correlation ID、Audit ID 当作幂等键或成功证明。

证据不足时的正确行为：

- 如实告诉用户「部分或全部记录的状态无法确认」。
- 停止进一步写入。
- 说明需要什么信息或什么人工检查才能确认。

## PARTIAL_SUCCESS 处理

```text
真实成功的记录 → 报告成功
真实失败的记录 → 报告失败
真实未知的记录 → 报告未知
```

**MUST NOT** 整批重新调用写入 Tool，避免重复创建或重复更新已经成功的 Salesforce Record。只有在：

```text
用户意图仍要求完成剩余工作
且失败原因可修正
且原 Mutation Intent 仍然有效
```

时才准备一个**只包含真实失败项**的新批次。修复失败项时：

- 例如 Lookup 歧义、Validation 错误、非法 Picklist 都可作为「可修正原因」。
- **MUST NOT** 顺带重放成功项。
- **MUST NOT** 把未知项并入这次重试批次。

## Batch UNKNOWN 的停止规则

```text
Batch 1 SUCCESS
Batch 2 UNKNOWN
Batch 3 NOT SENT
→ 停止，不发送 Batch 3
→ 先解析 Batch 2 的 outcome
```

这是 `>200` 顺序分批的核心安全规则：**MUST NOT** 在存在未知结果时继续扩大未知副作用的范围。

## 批次边界与汇报

一次批量调用最多 200 项且同对象。用户要求的范围超过上限时按 [batch-mutations.md](batch-mutations.md) 拆分，并：

```text
如实说明这是一个多批次计划，不是单一事务
不静默只处理一部分并声称完成
不无限循环
```

**MUST NOT** 把多个 Tool 调用说成同一个事务。任意一批出现 `OUTCOME_UNKNOWN` 时停止自动继续，先验证状态。

## 汇报要求

- 用当前 Playbook 与 Core 的 Result Integrity 规则汇报：只说真实发生的事。
- `PARTIAL_SUCCESS` **MUST NOT** 被描述成「全部成功」，也 **MUST NOT** 被描述成整次 Tool 失败。
- `UNKNOWN` **MUST** 明确表述为未知，并说明已停止写入。
- 保留稳定的错误码与必要的纠正信息。
- 成功时返回可用的显示字段、可信记录链接（来自 `get_record_links`，不要编造 URL）与实际写入的关键值。
- 正常业务回答中把 Record Id、RecordTypeId、Lookup Id 等技术值留在内部，除非用户明确要求或需要技术诊断。

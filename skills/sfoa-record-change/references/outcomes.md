# Outcomes

本文件覆盖 CREATE 结果的最低安全底线。完整的 Batch Outcome recovery、UPDATE reconciliation 与 >200 的完整策略属于后续阶段，本 Skill 不做扩展。

## 单条 `create_record`

输出为 `{ success, recordId?, errorCode?, message?, salesforceErrors? }`。没有 batch 的 `status` 枚举。

- `success=true` 且有 `recordId` → 该记录已创建。
- `success=false` 或 Tool 报错 → 没有成功证据；如实报告 `errorCode`、`message` 与 `salesforceErrors`，不要把失败说成完成。
- `MCP_DML_OBJECT_NOT_ALLOWED` / `MCP_DML_OPERATION_NOT_ALLOWED` / 输入校验错误表示**尚未 dispatch**，没有 Salesforce 副作用。这属于治理结果，**MUST NOT** 用其他通道、角色或工具绕过。
- `MCP_DML_OUTCOME_UNKNOWN` 或请求发出后超时 / 传输中断 → 提交状态不可证明。

## 批量 `create_records`

输出为 `{ success, status, total, succeeded, failed, unknown, allOrNone, errorCode?, message?, results[] }`，`results[]` 逐项给出 `index`、`clientReferenceId`、`success`、`status`、`recordId` 与错误信息。

| status | 含义 | 允许的动作 |
| --- | --- | --- |
| `SUCCESS` | 本请求全部成功 | 可以报告成功 |
| `PARTIAL_SUCCESS` | 部分已提交，部分失败 | 已成功项已提交，**MUST NOT** 整批重发 |
| `FAILED` | 本请求没有提交任何项 | 可以按真实失败原因重新准备 |
| `OUTCOME_UNKNOWN` | 提交状态不可证明 | **MUST NOT** 自动重试 |

`isError` 描述 Tool 执行是否完成，不描述每条业务记录是否成功：`SUCCESS` 与 `PARTIAL_SUCCESS` 是 `isError=false`，只有 `FAILED` 与 `OUTCOME_UNKNOWN` 是 Tool error。**MUST NOT** 因为 `isError=false` 就声称全部记录成功；**MUST** 以逐项结果与计数确认。

`allOrNone=true` 只回滚**本次 Salesforce 请求**，永远不覆盖其他 Tool 调用。`clientReferenceId` 只是批内关联键，**不是** Salesforce 业务字段，**不是**幂等键。用返回的显式 `clientReferenceId → recordId` 映射，不要按数组位置猜对应关系。

## UNKNOWN 不得自动重放

继承 Core 的底线：

```text
UNKNOWN / OUTCOME_UNKNOWN / MCP_DML_OUTCOME_UNKNOWN
→ MUST NOT 自动重复 CREATE
```

如果 DML 已经 dispatch 而结果未知：

- **MUST NOT** 自动再调用一次 `create_record` 或 `create_records`。
- 可以根据已知的业务唯一事实做**独立读取**，查询 Salesforce 实际状态。
- 只有真实独立证据才能把 UNKNOWN 改成 `SUCCESS` 或 `FAILED`；否则保持 `UNKNOWN`。
- 无法证明时如实告诉用户「部分或全部记录可能已创建」，并停止写入。Correlation ID / Audit ID 都不是幂等键。

## PARTIAL_SUCCESS 处理

```text
真实成功的记录 → 报告成功
真实失败的记录 → 报告失败
```

**MUST NOT** 整批重新调用 `create_records`，避免重复创建已经成功的 Salesforce Record。只有在用户意图仍要求完成剩余工作、且失败原因可修正时，才可以准备一个**只包含真实失败项**的新批次。

## 批次边界与安全

- 一次 `create_records` 最多 200 项，且必须同对象。
- 用户要求超过当前上限时，先明确完整范围，再按当前 Playbook 制定有限计划（例如 500 → 200 + 200 + 100），并全程跟踪 total / processed / succeeded / failed / unknown。**MUST NOT** 无限循环。
- 任意一批出现 `OUTCOME_UNKNOWN` 时停止自动继续，先验证状态。
- **MUST NOT** 把多个 Tool 调用说成同一个事务。

## 汇报要求

- 用当前 Playbook 与 Core 的 Result Integrity 规则汇报：只说真实发生的事。
- `PARTIAL_SUCCESS` **MUST NOT** 被描述成「全部成功」，也 **MUST NOT** 被描述成整次 Tool 失败。
- 保留稳定的错误码与必要的纠正信息。
- 成功时返回可用的显示字段、可信记录链接（来自 `get_record_links`，不要编造 URL）与实际写入的关键值。
- 正常业务回答中把 Record Id、RecordTypeId、Lookup Id 等技术值留在内部，除非用户明确要求或需要技术诊断。

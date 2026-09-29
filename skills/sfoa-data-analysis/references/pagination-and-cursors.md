# Pagination and cursors — 谁持有游标，怎么消费

本文件展开 Entry Point 的 **Cursor Is Position, Not Offset** 与 **One Export Job Per Question, Read To Completion**。两条 Tool 的分页模型**不同**，混淆它们是这类错误的常见来源，所以先分清归属。

## 两种分页模型

| Tool | 谁持游标 | 调用方看得到游标吗 | 怎么读完 |
| --- | --- | --- | --- |
| `query_records` | **Tool 自己** | 看不到 | 在 `maxRows` 预算内自动续取；走不完就报 `truncated` 与原因 |
| `get_bulk_query_results` | **调用方** | 看得到（`locator` / `hasMore`） | 每次调用读一页，原样回传 `locator`，直到 `complete` 为真 |

**关键区分**：`query_records` **没有**游标参数。**MUST NOT** 为它编造 `cursor`、`page`、`offset`、`paginationToken` 之类的入参——它们不存在。想读更多只有两种办法：提高 `maxRows`（上限 50 000），或改走 Bulk。

反过来，`get_bulk_query_results` **没有**「帮我读完全部」的开关：读全是调用方的循环。

## `query_records` 的续取语义

- 工具从第一条语句开始，沿平台给的续取链一路读，**累计不超过 `maxRows`**（默认 2 000）。
- `pages` 是这次调用发出的往返次数（含第一批）。
- 停下来时 `truncatedReason` 说明是谁约束的（`MAX_ROWS` / `TIME_BUDGET` / `RESPONSE_BUDGET` / `PAGINATION_UNAVAILABLE`）。补救表见 [completeness-contract.md](completeness-contract.md)。
- **MUST NOT** 用「从顶部重跑同一语句」来模拟翻页——那会重复读一部分并跳过另一部分。要更多行，提高 `maxRows`；要覆盖全量，改走 Bulk。

## `get_bulk_query_results` 的游标纪律

- `jobId` 由 `submit_bulk_query` 返回，**服务端不保存作业状态**：`jobId` 与游标由调用方持有并回传。
- `locator` 是**位置，不是偏移量**。传回一个过期的游标会**从那个位置重读**，不会跳过去；也**没有**任何一页会被自动跳过。
- `locator` 为 `null` / `hasMore` 为 `false` 表示结果集已读完；字面量 `"null"` 不是合法游标，Tool 会拒绝它。
- `complete: true` 只表示**这一页是最后一页**，即 `records` 持有结果集的结尾——它不表示 `records` 里就是全量。
- 循环里 **MUST** 累计已读行数，并在结束时与 `totalRecords`（作业 `JobComplete` 后才可知）核对。只在 `state` 还是排队或运行中时，总量可能仍是 `null`。
- Bulk 结果是 CSV，**每个值都是字符串**：数字与布尔值需要按已知字段类型解释，**MUST NOT** 假定类型已经转换好。

## 作业生命周期

1. `submit_bulk_query` 提交 → 得到 `jobId` 与初始 `state`。作业异步执行，这一次**不返回行**。
2. `get_bulk_query_results` 用 `jobId` 读状态与结果页；作业未完成时通常先拿到 `state` 而 `records` 为空。
3. 作业到 `JobComplete` 后逐页读完；`numberRecordsProcessed` / `numberRecordsFailed` / `totalRecords` 成为可比对的数字。
4. 作业 `Failed` 或 `Aborted` 时，`stateMessage` 是 Salesforce 的解释，`MCP_BULK_JOB_FAILED` 表示作业本身结束而没有结果集——与 `MCP_BULK_RESULTS_FAILED`（作业没问题、是读结果那次失败）是两回事。**MUST NOT** 把两者混为一谈，因为下一步动作不同。

**一个作业回答一个问题。** **MUST NOT** 为同一个问题反复提交同一个语句；**MUST NOT** 把作业提交当成一次「刷新」。同一个问题已经有作业在跑时，继续读那个作业。

## 调用次数也是成本

每次读一页都是调用。因此：

- 页面大小 `maxRecords`（默认 2 000，上限 50 000）调大能减少往返，但要顾及单次响应的字节预算。
- 一个只需要总数或分布的问题，**MUST NOT** 通过读很多页来自己数——用聚合。
- 需要重复作业前先看配额，见 [quota-awareness.md](quota-awareness.md)。

## 不要做的事

- **MUST NOT** 自行推导、拼接、改写或「缩短」游标；`locator` 原样回传。
- **MUST NOT** 在未读完时把已读部分当作整个导出结果；未读完就停下，就必须声明覆盖不完整。
- **MUST NOT** 并发地对同一个作业开多个读取循环，然后合并结果——顺序与去重都无法保证。
- **MUST NOT** 因为某一页返回空就读成「结果集为空」：先看 `state` 与 `hasMore`，空页可能是作业尚在运行。

## 相关文件

- 截断原因与补救路径：[completeness-contract.md](completeness-contract.md)
- 什么时候该走 Bulk：[tool-selection.md](tool-selection.md)
- 配额前置检查：[quota-awareness.md](quota-awareness.md)

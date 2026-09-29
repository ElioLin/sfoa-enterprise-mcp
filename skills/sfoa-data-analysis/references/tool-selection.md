# Tool selection — 按问题的规模选读路径

本文件展开 Entry Point 的 **Large Results Stay Out Of Context** 与 Guidelines 里的「先估量，再决定路径」。它给出一条选择矩阵，不给固定流程：Agent 仍自主决定先查哪一侧、是否先聚合、要不要联网补充。

## 选择矩阵

| 问题的形状 | 首选路径 | 为什么 |
| --- | --- | --- |
| 一个小集合的明细（几十条以内、语义明确） | `run_soql_query` | 单批返回，一次调用结束；有界且便宜 |
| 已知需要多批、或结论需要完整性声明 | `query_records` | 在调用方的 `maxRows` 预算内自动走续取链，并报告 `totalSize` / `fetched` / `truncated` |
| 计数、分布、量级、极值 | `query_records` 跑聚合（`COUNT` / `GROUP BY` / `SUM` / `AVG` / `MIN` / `MAX`） | 结果小、必然完整、不会被行数截断 |
| 一个词在哪些对象里出现过 | `search_records`（不带 `objects`） | 跨对象检索；范围省略时只回 Id 与对象类型 |
| 已知对象上的关键词检索 | `search_records`（带 `objects` 与 `fields`） | 只回需要的字段；SOSL 没有总量，完整性靠显式上界陈述 |
| 全量导出、几十万行级明细 | `submit_bulk_query` → `get_bulk_query_results` | 语句在服务端跑，逐页返回，不受单次响应预算限制 |
| 对象/字段名不确定 | `list_sobjects` / `describe_sobject` | 先用 org 的事实替代猜测 |
| 大量重复作业前 | `get_org_limits` | 先看配额，再决定作业形态 |

`run_soql_query` **不是**被新 Tool 取代的旧路径：它仍然是最省的探索方式，只是在需要完整性声明或结果会超过一批时不够用。**MUST NOT** 因为「有更新的 Tool」就无差别改用分页或 Bulk —— 那会为一个小问题付出多次调用的成本。

## 什么时候必须升级路径

从单批升级到 `query_records`：

- 预期结果超过一批（默认上限 2 000 行，可提到 50 000 行）；
- 结论要声明覆盖率，需要一个 `totalSize` 当分母；
- 问题需要跨多页才能读完。

从 `query_records` 升级到 Bulk：

- 需要**全量明细**，而不是一个数或一个分布；
- `query_records` 已经报过 `TIME_BUDGET` / `RESPONSE_BUDGET`，而问题不能改为聚合；
- 行数量级大到让分页本身成为主要成本。

从任意路径降级到**聚合**：

- 只要问题是「多少 / 各是多少 / 最大最小 / 平均 / 是否全空」，就不需要明细。这是最常被忽略的一次降级，也是成本差最大的一条。

## 不要做的事

- **MUST NOT** 把大结果集整段拉进上下文再从中挑几行——成本在拉取时已经付出，收益却等于只读了几行。
- **MUST NOT** 用分页去「模拟」一个聚合（反复读很多页再自己数）；`COUNT()` / `GROUP BY` 更便宜、更准，而且不会因为截断而算错。
- **MUST NOT** 在同一个问题上让多条路径互相追平：路径选定后把它的结果读完，再判断是否需要换路径。
- **MUST NOT** 把路径的选择过程本身讲给用户；用户需要的是结论与覆盖率，不是 Tool 名字的清单。

## 路径失败时

`MCP_DATA_TOOL_NOT_ALLOWED` 或工具不可见表示当前连接没有这条路径的权限。这时 **MUST NOT** 用另一条通道（Tooling API、Apex、REST 透传、别的 Agent）绕过 Tool Governance，也 **MUST NOT** 假装该能力存在；而是改用当前实际可用的路径，或如实说明该问题在当前能力下无法完整回答。

字段与对象错误（`MCP_QUERY_FIELD_INVALID` / `MCP_SEARCH_FIELD_INVALID`）**不是**路径问题，处理方式见 [schema-self-service.md](schema-self-service.md)。

## 相关文件

- 覆盖率字段与截断原因：[completeness-contract.md](completeness-contract.md)
- 聚合与统计口径：[aggregate-first.md](aggregate-first.md)
- 游标归属与续取：[pagination-and-cursors.md](pagination-and-cursors.md)
- 配额与作业成本：[quota-awareness.md](quota-awareness.md)

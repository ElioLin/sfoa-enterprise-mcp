# Quota awareness — 配额前置检查与作业成本

本文件展开 Entry Point 的 **Quota Before A Repeated Job**。它是成本意识，不是审批流程：Agent 仍自主决定作业形态，只需要在作业**之前**看一眼事实。

## 为什么要前置

一次查询的代价看起来很低，但会叠加：分页把一次问题变成多次调用，每个问题各提交一次 Bulk 作业则会把配额吃空，让后面的调用者拿不到他们需要的额度。配额是**共享资源**，不是本次请求的私有预算。

## `get_org_limits`

`get_org_limits` 返回 org 的配额快照（API 调用额度、Bulk 作业额度等），由 **DIAGNOSTIC 身份**执行——它是可观测性的事实来源，不是业务数据。它受 Tool Governance 约束：当前连接没有启用时，**MUST NOT** 断言该快照已读过。

**MUST** 以**响应自身报告的用量**作为当前事实。**MUST NOT** 沿用记忆里、上一轮会话里或文档里的配额数字——配额按 24 小时滚动窗口变化，旧数字会误导作业决策。

## 什么时候先看

- 预计要跑**多次**查询，或要读很多页；
- 要**提交 Bulk 作业**（作业自身也消耗额度）；
- 上一个请求刚报过 `MCP_QUERY_LIMIT_EXCEEDED` / `MCP_BULK_LIMIT_EXCEEDED` / `MCP_SEARCH_LIMIT_EXCEEDED`；
- 同一个问题可能需要反复取数。

**不**需要为一次简单的单批查询先看配额——那会把一次调用变成两次。

## 提交时自带的配额事实

`submit_bulk_query` 的响应里带 `apiUsage`（`used` / `limit` / `remaining`），它来自平台在 Bulk 响应中返回的用量头。这是提交动作**本身**产生的配额事实，不需要额外调用。**MUST** 优先使用它，而不是再去单独查一次快照。

作业的配额与 API 调用的配额是**分开计**的：一个 Bulk 作业用得少，不代表 API 调用额度还剩很多，反之亦然。看快照时要看对那一项。

## 额度不足时

- 错误码 `MCP_QUERY_LIMIT_EXCEEDED` / `MCP_BULK_LIMIT_EXCEEDED` / `MCP_SEARCH_LIMIT_EXCEEDED` 表示平台因为额度或并发上限拒绝了请求。
- 此时 **MUST NOT** 立刻重试打卡；**MUST** 减少调用次数——一次聚合查询比翻很多页便宜，一次提交比每个问题各提交一次便宜。
- **MUST NOT** 为了「绕开额度」改用其它通道（Tooling API、Apex、REST 透传）——那既绕过治理，也不解决额度问题。
- 额度耗尽的结论 **MUST** 如实说明（「本次无法读取全部，原因是配额」），**MUST NOT** 用已有的一部分数据补成总体结论。

## 成本最低的写法

| 做法 | 相对成本 |
| --- | --- |
| 一次聚合回答「多少 / 分布」 | 最低 |
| 一次有界明细查询 | 低 |
| 多次分页读同一个问题 | 中 |
| 每问一次就提交一个 Bulk 作业 | 高 |
| 反复重试已失败的调用 | 最高，且不产生新信息 |

成本最低的写法通常也是**结论最可靠**的写法：聚合结果小、完整、不会被截断。把「先聚合再决定」当成省钱手段之外，也当成正确性手段。

## 不要做的事

- **MUST NOT** 把配额数字、额度上限或重置时间写进本 Skill 或缓存成长期事实。
- **MUST NOT** 在配额不明时假设它充足——不确定就说明不确定。
- **MUST NOT** 因为一次额度错误就放弃整个问题：先判断能否用聚合或更窄的范围在额度内回答。

## 相关文件

- 路径选择的成本维度：[tool-selection.md](tool-selection.md)
- Bulk 作业生命周期与调用次数：[pagination-and-cursors.md](pagination-and-cursors.md)
- 覆盖率声明（额度不足时必须声明 PARTIAL）：[completeness-contract.md](completeness-contract.md)

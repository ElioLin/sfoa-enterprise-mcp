# Completeness contract — 覆盖率、truncated 语义与三条补救路径

本文件展开 Entry Point 的 **Completeness Declaration**、**Partial Is Not The Whole** 与 **Three Remedies On Truncation**。它是**声明纪律**，不是固定查询流程：Agent 仍自主决定用聚合还是明细、走 Bulk 还是缩小范围、展示多少行。唯一硬要求是**结论带上它的覆盖率**。

## 每个结果都回答两个问题

一次读取之后，先问两个问题，再决定能说什么：

1. **Tool 报告的总量是多少？** —— 这是分母。
2. **我实际读到了多少、结果被截断了吗？** —— 这是分子与状态。

只有两者都有，才能形成总体结论。

| Tool | 总量字段 | 已读字段 | 状态字段 |
| --- | --- | --- | --- |
| `query_records` | `totalSize`（标量聚合时改在 `aggregateValue`） | `fetched`（返回给模型的为 `returnedCount`） | `truncated` / `truncatedReason` / `complete` / `done` / `pages` |
| `search_records` | 无总量（SOSL 不报总命中数） | `totalReturned` / `returnedCount` | `truncated` / `truncatedReason` / `complete` / `effectiveLimit` / `limitSource` |
| `get_bulk_query_results` | `totalRecords`（作业 `JobComplete` 后才可知） | `records` 的行数 / `returnedCount` | `state` / `complete` / `hasMore` / `locator` |
| `list_sobjects` | `totalCount` | `returnedCount` | `truncated` |
| `describe_sobject` | `totalFields` / `totalChildRelationships` | `returnedFields` / `returnedChildRelationships` | `truncated` / `fieldsIncluded` |

`fetched` 是**从 Salesforce 读到的行**，`returnedCount` 是**实际出现在 `records` 里的行**。两者只在响应预算把负载截短时不同。做覆盖率声明时用 `fetched` 对 `totalSize`；向用户说明「看到几行」时用 `returnedCount`。

## 覆盖率怎么陈述

合格（分子、分母、状态都在）：

```text
读取 37 001 / 37 001 行，完整（complete）。
读取 2 000 / 41 500 行，truncated（MAX_ROWS），结论只覆盖已读到的 2 000 行。
```

不合格（没有分母或没有状态）：

```text
共 41 500 条客户。          ← 分子缺，无法判断是不是读完了
以下分布基于查询结果。        ← 分母与状态都缺
```

第二种写法的问题不在格式，而在于它可能是在 2 000 / 41 500 行上说出来的。

## `truncated` 的四类原因，以及各自能否补救

`query_records` 的 `truncatedReason` 指明**约束来自哪里**，因为补救方式完全不同：

| 原因 | 含义 | 调用方能做什么 |
| --- | --- | --- |
| `MAX_ROWS` | 调用方自己设的 `maxRows` 上界先到（默认 2 000，单次上限 50 000） | 提高 `maxRows` 重查；或改用聚合 / Bulk |
| `TIME_BUDGET` | 续取链走的时间预算用尽 | 聚合、收窄 `WHERE`、或改走 Bulk |
| `RESPONSE_BUDGET` | 读到的行放不进一次响应（结构化负载或文本预算） | 减少字段宽度、减少分组数、或改走 Bulk 逐页读 |
| `PAGINATION_UNAVAILABLE` | 平台声明还有更多行却没给续取游标 | **调用方修不了**：只能改走聚合或 Bulk，且必须如实说明覆盖不完整 |

`search_records` 用另一组原因：`LIMIT_REACHED`（整体 `limit` 到顶）、`PER_OBJECT_LIMIT`（某个对象的 RETURNING 上界到顶）、`RESPONSE_BUDGET`。SOSL 没有总量可对，所以它的完整性只能由**显式上界**陈述，不能由推断得出。

Bulk 逐页读取没有「截断」一说：一页不是最后一页就是还有下一页（`hasMore` / `locator`）。未读完就停下，等于覆盖不完整，必须照样声明。

## 三条补救路径

结果不完整时，从这三条里选一条，并说明选了哪条：

1. **聚合** —— 问题本来只需要一个数或一个分布时，`COUNT()`、`COUNT(field)`、`GROUP BY`、`SUM`、`AVG`、`MIN`、`MAX` 的结果小到不可能被行数截断。这是最便宜的一条，优先考虑。
2. **导出** —— 问题确实需要明细全量时，`submit_bulk_query` 提交一次，再用 `get_bulk_query_results` 一页一页读到 `complete`。Bulk 的语句与 `query_records` 同一套 SOQL 规则。
3. **缩小范围** —— 收小时间窗、加过滤条件、限定对象或状态，把问题变成一个可以被完整读取的集合，再对**缩小后的集合**做总体结论（并说明该集合是什么）。

**MUST NOT** 的第四种做法：把上界当作答案（「最近 2 000 条就是全部」）、把一次抽样当总体、或者干脆不说覆盖率。三条路径都走不通时，如实说 **Analysis Coverage = PARTIAL** 并指明哪些范围没被覆盖。

## 状态词汇（Agent 内部使用，不要求原样输出）

| 状态 | 含义 |
| --- | --- |
| COMPLETE | 已读 = 总量，或平台明确报告结果集已读完 |
| PARTIAL | 只覆盖一部分（截断、未读完、权限或字段限制） |
| TRUNCATED_BY_CALLER | 被本次调用自己的 `maxRows` / `limit` 上界截断 |
| UNKNOWN | 平台未报告总量，覆盖程度无法从本次响应判定 |

`UNKNOWN` 是一个**要处理**的状态，不是一个可以忽略的状态：它通常意味着应当改写成 `COUNT()` 来确定分母，或换一条能报告总量的路径。

## 与其他规则的关系

- Entry Point 第 1–3 条给出义务与补救路径；本文件给出字段名与判据。
- 统计口径（时间窗、过滤条件、币种、分母）见 [aggregate-first.md](aggregate-first.md)。
- 游标与续取方式见 [pagination-and-cursors.md](pagination-and-cursors.md)。
- 覆盖范围的上位原则来自 `crm-core` 的 **Claim Scope <= Evidence Scope** 与 **Full Population Analytics**；本文件是这两条在 P9 读路径上的落地。

## 非目标

本文件不定义业务指标模型、口径字典或公司对象映射，也不把任何一次查询的字段或阈值固化下来。它只定义「怎么知道自己读了多少、能说什么」。

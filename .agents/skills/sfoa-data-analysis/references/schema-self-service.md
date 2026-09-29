# Schema self-service — 用 org 的事实替代猜测

本文件展开 Entry Point 的 **Schema From The Org, Not Memory**。它描述的是**核对**流程，不是固定的调用序列：Agent 可以跳过已经确定的部分，也可以在已有可知可信的 Schema 事实时直接写查询。

## 两个发现工具的分工

| Tool | 回答什么 | 关键输入 |
| --- | --- | --- |
| `list_sobjects` | 有哪些对象；每个对象是否 `queryable` / `searchable` / `createable` / `updateable`；对象 Label 与 keyPrefix | `filter`（对象 API 名前缀，可选）、`limit`（默认 50，上限 200） |
| `describe_sobject` | 一个对象有哪些字段：API 名、Label、类型、是否 `nillable` / `filterable` / `sortable`、`referenceTo`、`relationshipName`、Picklist 取值；以及子关系 | `objectApiName`、`includeFields`（默认 true）、`fieldLimit`（默认 200，上限 1 000） |

`list_sobjects` 的结果**总是**报告匹配到的对象总数（`totalCount`）与返回数（`returnedCount`），以及是否 `truncated`。看对象清单时要留意这个 `truncated`：它截断的是**对象清单**，不是记录。

`describe_sobject` 会说明 `fieldsIncluded` 与是否 `truncated`。字段非常多时先 `includeFields: false` 只看对象级事实，再用 `fieldLimit` 取需要的字段区间。

## 什么时候先 describe

- 投影里有一个字段名不确定（拼写、单复数、是不是自定义字段的 `__c` 后缀）；
- 不确定一个关系是父关系还是子关系，或者该用 `relationshipName` 还是 `referenceTo`；
- 需要 Picklist 的合法取值（做过滤或分组之前）；
- 需要知道某字段是否能作为过滤/排序条件（`filterable` / `sortable`）；
- 要判断一个对象到底能不能查（`queryable`）。

**MUST NOT** 凭记忆写上述任何一项。对象与字段的最终权威是 Salesforce，不是模型记忆，也不是本 Skill。

## 字段错误的自修复流程

`query_records` 把 Salesforce 的 `INVALID_FIELD` / `INVALID_TYPE` / `INVALID_SOBJECT` 等映射为 `MCP_QUERY_FIELD_INVALID`；`search_records` 对应 `MCP_SEARCH_FIELD_INVALID`。这类错误**不是死路，是 Schema 事实**。处理顺序：

1. **读错误**：消息说明「查询里有一个字段或对象 Salesforce 没有向本次身份暴露」，`salesforceErrorCode` 保留 Salesforce 原始错误码，`suggestion` 指向下一步。
2. **describe**：对相关对象调 `describe_sobject`，从返回的 `apiName` 列表里找出真实名字。
3. **改写并重试一次**：用真实 API 名修正投影，重试**一次**。
4. **仍然失败就停**：把错误与已核对到的 Schema 事实如实说出来，**MUST NOT** 继续换字段碰运气。

硬边界：

- **MUST NOT** 原样重试同一语句。
- **MUST NOT** 用一个猜的字段替换被拒绝的字段。
- **MUST NOT** 把 `INVALID_TYPE` 一律当成拼写错误：它常常意味着**读错了 API**（Tooling 对象走了数据 API，或反过来）。此时正确动作是切换 `useToolingApi`，而不是改字段名。错误的 `suggestion` 已经指出这一点。
- **MUST NOT** 因为字段被拒绝就认为「该字段不存在」并据此下结论——可能是本次身份的 FLS 或对象可见性所致，两种原因对结论的影响完全不同。

## 可查询性不等于可读性

`queryable: true` 只说明这个对象能出现在 `FROM` 里，**不**保证本次身份能看到所有行的所有字段。CRUD、FLS、Sharing 的裁决始终在 Salesforce。

因此：

- 查询返回的行数少于预期时，**MUST NOT** 直接断言「数据就是这些」；先确认是不是可见性造成的差异。
- 「查不到」与「没有权限查」是两种必须区分的结论。
- **MUST NOT** 用其它通道（Tooling API、Apex、REST 透传）绕过可见性。

## 不要做的事

- **MUST NOT** 把对象的字段清单、Picklist 取值或 Record Type 信息固化进本 Skill、查询模板或记忆里当作长期事实——它们是会变的 org 事实。
- **MUST NOT** 每次都用一次 describe 取整个对象：用 `filter` / `includeFields` / `fieldLimit` 把范围收到需要的那部分。
- **MUST NOT** 在已经确知 Schema 的情况下为形式完整而重复 describe。

## 相关文件

- 路径选择（什么时候需要 Schema 事实）：[tool-selection.md](tool-selection.md)
- 聚合与分组对字段类型的要求：[aggregate-first.md](aggregate-first.md)
- 字段内容不可信：[untrusted-field-content.md](untrusted-field-content.md)

# Summary & Navigation — 变更后的操作总结与记录导航

指导修订：Skill-Export Package — 吸收 MuleRun Salesforce skill 的总结/导航模板，改用 SFOA 可信链接来源。

当本轮对话发生过 CREATE / UPDATE / 批量变更（或用户要求回顾"刚才做了什么"）时，最终回复**MUST**包含一份操作总结。纯查询或分析不适用本文件。

## Hard Rules

- **Proven links only** — **MUST** 只使用 `get_record_links`（或变更 Tool 结果中直接返回的可信链接）生成记录 URL；**MUST NOT** 自行拼接 Lightning / Classic URL、猜测 instance 域名、从 `.env` 或历史对话读取 `SALESFORCE_INSTANCE_URL`。链接来源不可用时，给记录 ID 并说明"链接暂不可用"，不编造 URL。
- **Order follows execution** — 总结条目**MUST**按实际执行顺序排列（先创建的在前），不按重要性重排；每个条目标注实际结果（SUCCESS / PARTIAL_SUCCESS / OUTCOME_UNKNOWN）。
- **Result integrity applies to summaries** — 总结**MUST**与逐条 Tool 证据一致：`PARTIAL_SUCCESS` 必须列出成功子集与失败子集；`OUTCOME_UNKNOWN` 的条目必须保留未知状态，不得因"看起来成功了"而标记完成。
- **Deletion is not silently dropped** — 若本轮包含删除或失败回滚，**MUST**在总结中保留该条目（删除线 + ID + 原因），不得只展示成功的操作。

## 输出模板

> 以下为模板结构，非逐字脚本；按实际操作内容填充。`proven-url` 代表由 `get_record_links` 或变更结果直接返回的可信 URL；实际输出时把记录 Label 渲染为指向该 URL 的 Markdown 链接。

```markdown
已为您生成本轮操作总结：

1. 新建周报：WR-0042 销售周报 | FY2026 Q1 第6周 — proven-url
   - 写入的关键值摘要（1-2 行）

2. 新增拜访记录：价格与投标细节洽谈 — proven-url
   - 写入的关键值摘要（1-2 行）

3. 删除错误的拜访记录：~~与何XX的商业访谈（ID: 00Uxx…）~~
   - 删除原因摘要

4. 创建 周报 <> 商机关联：WRO-0041 — proven-url
   - Relation: WR-0042 …（proven-url） **<>** 某某智能 Digital Transformation Platform（proven-url）
```

## Guidelines / Heuristics

- 每条摘要 1-2 行，只写用户决策需要的信息（关键写入值、失败原因、剩余动作）；不罗列全部请求字段。
- 一条记录的多个字段变更合并为一个条目；批量变更按对象分组小计（如"共 12 条，成功 11 / 失败 1 / 未知 0"），失败与未知子项单独列出。
- 关联（Lookup / Junction）类结果用 `A <> B` 形式呈现两端记录。
- 用户在企微等受限客户端阅读时，链接文本用业务 Label；URL 本身不缩短、不转译。
- 若本轮只有读取操作但用户明确要求"给我链接"，仍从 `get_record_links` 取链接；无该 Tool 时按 [query-guidance.md](query-guidance.md) 处理。

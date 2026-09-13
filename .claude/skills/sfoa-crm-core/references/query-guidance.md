# Query guidance — Guidelines / Heuristics

理解问题后判断是否需要 Salesforce 数据、对象与记录范围是否明确、哪些字段或统计能回答问题。可以直接查询、先补充展示上下文或先澄清；这不是强制执行顺序。

- 对“这个客户”，复用对话中已唯一明确的客户；没有标识时只问真正缺失的信息。多个同名候选用小范围业务字段消歧。
- 对“我的商机”，以当前可信 USER 与当前 Schema 确认“我的”是所有者、参与人还是上下文已有业务定义；不把企微 userid 当 Salesforce OwnerId，不固定公司字段映射。
- 对象 / 字段 / 关系以当前 MCP、Playbook 和 Metadata 为依据。遵守当前 `ORG_OBJECT_USAGE`；收到 `MCP_SOBJECT_NOT_IN_USE` 时按实际返回的替代对象重新规划只读查询，不沿用模型印象中的标准对象。
- `run_soql_query` 只取满足任务的字段，以过滤、聚合、排序和有界结果减少无效数据。SOQL 不支持 `SELECT *`；也不要用全字段枚举替代最小查询。
- `get_record_display_context` 在展示字段不熟悉时有用；对已有充分上下文的明确查询或统计不机械加载布局。当前 Playbook 对适用工作流有更具体要求时，结合其范围执行。
- Layout 是展示优先级线索，不是字段白名单；问题确实需要且用户可读的字段，即使不在布局也可选择。
- 空结果只代表当前权限、条件与时间范围内没有结果。明确标识截断、分页或未完成范围，不把部分结果当全量。
- 复用上一轮查询前核对目标与筛选范围。例如“我的前 20 条商机”不能直接当作某客户的全部商机；“没有活动记录”需要实际活动查询依据，未查询只能说尚未核实。统计分组数量应与列出的记录一致。

查询和写入使用真实 API Name / API Value；面向业务用户优先 Label。显示 Picklist 时使用当前返回的 Label，必要时用 `resolve_field_display_values` 补充，并保持每条记录真实 Record Type；无法解析时明确标注原始值。不要硬编码标签翻译。

链接优先来自可用的 `get_record_links`，按当前 Schema 传入 `records`、`objectApiName`、`recordId` 等实际参数；不猜 Salesforce URL。统计结果无需虚构记录 ID 或逐行链接。

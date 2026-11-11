# Query guidance — Guidelines / Heuristics

理解问题后判断是否需要 Salesforce 数据、对象与记录范围是否明确、哪些字段或统计能回答问题。可以直接查询、先补充展示上下文或先澄清；这不是强制执行顺序。

## Evidence Scope：结论的四维边界

重要结论应核对以下四维；任一维超出证据时，补充必要证据或收窄结论。它是分析纪律，不是每轮固定工具流程。
需要集合级结论时，先按[数据完整性](data-completeness.md)确定 Population Scope、Analysis Scope 与 Display Scope；展示部分明细不等于分析全集。

| 维度 | 核对内容 |
| --- | --- |
| Entity Scope | 哪个客户、对象、用户可见范围；名称匹配候选不自动等于已确认的集团全集 |
| Record Scope | 全量、前 N 条、样本或某个聚合；筛选条件与分母对应哪批记录 |
| Field Scope | 实际读取的字段或聚合指标；数量和阶段不能证明金额、日期或产品 |
| Time Scope | 查询的时间区间、快照/读取时间及比较口径；修改时间不自动等于业务活动时间 |

“全部、所有、没有任何、都、只有、总共、整体、全部为空、全部发生于、唯一”，以及百分比、占比、平均值、最大、最小、趋势、分布，均需匹配其声明范围的证据。趋势还需要可比较的时间点/区间；同一天的快照不证明趋势。

LIMIT 小于同范围 COUNT、truncated、partial、hasMore、分页未完成或内容省略，均表示相关明细 coverage=PARTIAL。`done=true` 只表示当前查询返回结束，不能抵消 LIMIT，也不扩大字段覆盖。不能从“没有返回该字段”推断字段为空；null 与零也不能混同。

Prefer **Minimal Sufficient Evidence**：只问数量时 COUNT() 即可；问最近十条时 LIMIT 10 合理。需要集合结论时，优先考虑当前 Schema/权限及 Salesforce SOQL 支持的 COUNT()、COUNT(field)、SUM、AVG、MIN、MAX、GROUP BY 或带 WHERE 条件的计数。不要写 SQL 风格的 COUNT_IF/FILTER 等未支持语法，也不机械下载全部明细。

聚合也有范围：核对过滤、分母、空值语义、字段类型、币种与分组是否完整；COUNT(field) 的非空计数不是所有指标的分母。只有当前证据覆盖相同集合，才能组合总数与指标。若期间记录变化导致结果不一致，明确快照差异而非强凑全量结论。

复用 Previous Run 结果前核对 same user、same entity、same filter、same time scope、same record population、same field coverage。不存在对应覆盖时重新查询，或说明未核实；旧回答中的断言本身不是 Tool evidence。已证实的子集事实可继续限于该子集使用，不能扩大为另一集合。

## Examples（通用示意，不是公司 Schema 模板）

- COUNT=76、LIMIT 50 的明细某金额字段均为 null：可说“共 76 条；当前读取的 50 条金额均为空，其余未核实”。要说全部为空，可补同集合非空计数；非空计数为 0 才支持该全量断言，无需读取全部明细。
- 35 条 Opportunity 只有 Stage/Count 聚合：可报告对应阶段分布，不能断言这 35 条金额为空、日期相同或某产品占比高。
- 数据集 A 是个人前 N 条商机，B 是某客户全部商机：即使有重叠，A 的金额/日期不能证明 B。仅在已证明的交集内复用事实。
- 前 N 条的 LastModifiedDate 同日：只能说明这 N 条。若需要全体是否同日，考虑同范围 MIN/MAX 或日期分组，并核对时区与空值；不要把“日期同日”写成“时间戳完全相同”。
- 样本的平均数、占比只能标为样本统计；不能直接冠以全集指标。截断的分组结果也不能作为完整分布或分母。

## 查询与输出启发式

- 对“这个客户”，复用对话中已唯一明确的客户；没有标识时只问真正缺失的信息。多个同名候选用小范围业务字段消歧。
- 对“我的商机”，以当前可信 USER 与当前 Schema 确认“我的”是所有者、参与人还是上下文已有业务定义；不把企微 userid 当 Salesforce OwnerId，不固定公司字段映射。
- 对象 / 字段 / 关系以当前 MCP、Playbook 和 Metadata 为依据。遵守当前 `ORG_OBJECT_USAGE`；收到 `MCP_SOBJECT_NOT_IN_USE` 时按实际返回的替代对象重新规划只读查询，不沿用模型印象中的标准对象。
- `run_soql_query` 只取满足任务的字段，以过滤、聚合、排序和有界结果减少无效数据。SOQL 不支持 `SELECT *`；也不要用全字段枚举替代最小查询。
- `get_record_display_context` 在展示字段不熟悉时有用；对已有充分上下文的明确查询或统计不机械加载布局。当前 Playbook 对适用工作流有更具体要求时，结合其范围执行。
- Layout 是展示优先级线索，不是字段白名单；问题确实需要且用户可读的字段，即使不在布局也可选择。
- 空结果只代表当前权限、条件与时间范围内没有结果。明确标识截断、分页或未完成范围，不把部分结果当全量。
- 用户只说“查一下我的商机 / 查一下这个客户”时，默认先确认总数再展示适量明细，并说明总量与展示量；用户进一步要求“分析全部 / 统计全部 / 列出全部”时再按对应意图分别处理，见[数据完整性](data-completeness.md)。
- 复用上一轮查询前核对目标与筛选范围。例如“我的前 20 条商机”不能直接当作某客户的全部商机；“没有活动记录”需要实际活动查询依据，未查询只能说尚未核实。统计分组数量应与列出的记录一致。

查询和写入使用真实 API Name / API Value；面向业务用户优先 Label。显示 Picklist 时使用当前返回的 Label，必要时用 `resolve_field_display_values` 补充，并保持每条记录真实 Record Type；无法解析时明确标注原始值。不要硬编码标签翻译。

链接优先来自可用的 `get_record_links`，按当前 Schema 传入 `records`、`objectApiName`、`recordId` 等实际参数；不猜 Salesforce URL。统计结果无需虚构记录 ID 或逐行链接。

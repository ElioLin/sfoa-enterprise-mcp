# Data completeness — 三个 Scope 与全集结论

本文件展开 Core Hard Rule **Full Population Analytics**。它是分析纪律，不是固定查询流程：Agent 仍自主决定用 COUNT、GROUP BY、明细、是否补查、先查哪一侧以及展示多少。唯一硬要求是**最终结论必须有匹配范围的证据**。

## 三个 Scope

| Scope | 定义 | 例 |
| --- | --- | --- |
| Population Scope | 用户**真正询问**的记录全集 | “我的所有商机”（当前用户可见的全部商机）、“某客户全部商机”、“过去一年全部拜访记录” |
| Analysis Scope | 实际用于 COUNT / SUM / AVG / MIN / MAX / GROUP BY / 趋势 / 占比 / 业务判断的数据范围 | 对该客户 35 条商机执行 `GROUP BY Stage` 的全量聚合 |
| Display Scope | 最终向用户展示的明细记录数量 | Top 10、最近 20、前 50 |

三者可以不同，但方向是受限的：

```text
Display Scope  <  Population Scope    允许（并应说明）
Analysis Scope == Population Scope    集合级结论的必要条件
Analysis Scope  <  Population Scope   只在用户意图本身是部分范围时才允许，且必须标注为局部
```

**核心不变量**：只要输出的是全集结论（总数、整体情况、分布、占比、金额、日期范围、趋势、极值、是否为空），Analysis Scope 必须等于 Population Scope，或拥有等价覆盖完整 Population 的集合级证据。展示得少不代表分析得少；反过来，只展示得少也不能当作已经分析全集。

示意（不是公司 Schema 模板）：

```text
Population: 76
Analysis:   76 / 76 COMPLETE
Display:    10 / 76 TOP_N
```

对应回答形如“你共有 76 条商机；以下整体统计基于全部 76 条；下面仅展示最近 10 条”。

## Minimal Sufficient Full-Scope Evidence

满足 Analysis Scope = Population **不要求**把全部记录读进上下文，也**禁止**机械全量下载后再交给模型。优先使用 Salesforce / SOQL 集合能力，按用户真正问的指标选择最小充分证据：

| 用户问题 | 典型最小证据 |
| --- | --- |
| 一共有多少条 | 完整 Population 的 `COUNT()` |
| 各阶段/各状态多少条 | 完整 Population 的 `GROUP BY` 计数 |
| 金额情况 | 覆盖完整 Population 的金额聚合（如 `SUM` / `AVG` / `MIN` / `MAX`）与非空计数 |
| 某字段是否全空 | 完整 Population 的 `COUNT()` 与 `COUNT(field)` 对比 |
| 更新时间范围 / 是否同日 | 完整 Population 的日期 `MIN` / `MAX` 或按日期分组 |

具体 SOQL 必须依据**当前** MCP Tool、当前 Schema 与当前权限动态生成；不要把公司对象或字段硬编码进 Skill。也不要写 SQL 风格的 `COUNT_IF` / `FILTER` 等当前 SOQL 不支持的语法。若某种聚合当前不可用（例如不支持的计算字段或分组），可改用可用的等价查询，或按[Row-level 全量语义分析](#row-level-全量语义分析)分批覆盖。

聚合本身也有范围：核对过滤条件、分母、空值语义、字段类型、币种与分组完整性。`COUNT(field)` 是非空计数，不能当作所有指标的分母。只有证据覆盖相同集合时，才允许把总数与指标组合陈述。若期间记录发生变化导致前后不一致，说明快照差异，不强行凑成全量结论。

## NULL / Blank 结论

“全部 Amount 为空”“所有记录都没有该字段”“没有任何活动”是全集断言，必须有完整 Population 的对应证据。优先比较完整 Population 的**总记录数与非空字段数**：非空计数为 0 才支持“全部为空”。不要读取前 N 条看到空就推断全体为空，也不要把“没有返回该字段”当作空值。null 与零、空字符串不得混同。

## TOP_N / SAMPLE 是合法的

以下用户意图本身就是部分范围：最近 10 条、最大的 20 条、前 50 条、举几个例子、随机看一些。此时 Analysis Scope 可以等于 TOP_N / SAMPLE，**不必**为了形式完整去查全集金额或全集日期；同时必须让用户知道这是部分范围，不能标成全集。

## “查数据”的默认行为

用户只说“帮我查一下我的商机”时，不默认把几百上千条全部发到聊天界面。合理策略是：先确认总数，再展示适量明细，并说明“总共有 N 条，当前展示最近/最相关的 M 条”。用户进一步要求“分析全部 / 统计全部 / 列出全部”时，再按对应意图分别处理。

## “列出全部”与“分析全部”必须区分

- **分析全部**：优先集合级统计 + 必要的全覆盖分段分析，不需要展示全部明细。
- **列出全部**：记录数量合理时可以完整获取；数量很大时**不得静默截断**。应说明总量、说明聊天界面不适合展示全部，并提供分批展示或后续导出/报告能力。本条不实现企微文档写入。

## Row-level 全量语义分析

有些问题无法只靠聚合回答，例如“分析全部商机的描述，总结共同的风险原因”。这类问题需要覆盖完整 Population，可以分批查询、分区查询、按时间区间拆分、按业务字段拆分，直到 Analysis Coverage = COMPLETE。

拆分方式必须基于当前 Tool 与当前 SOQL 的真实能力。**禁止编造不存在的 `paginationToken`、`cursor`、`page` 等参数**；工具是否支持分页以当前 `tools/list` 与 Schema 为准。

如果当前能力无法完整覆盖（权限、字段不可读、对象不在使用中、查询上限或聚合不支持），必须明确 **Analysis Coverage = PARTIAL**，并告诉用户哪些范围没有被分析，而不是用已读部分代表全集。

处理大量明细时注意上下文预算：分批处理、保留中间统计、汇总结果，不要把全部原始内容一次送入模型。允许把获准的数据后处理或 Web 分析交给 Sub-Agent，但 requester-scoped SFOA MCP 必须由 Main Agent 调用，Sub-Agent 不得自行访问 Salesforce。

## Completeness 状态

Agent 内部使用的分析语义（不要求每次原样输出给用户）：

| 状态 | 含义 |
| --- | --- |
| COMPLETE | Analysis Scope 覆盖完整 Population |
| PARTIAL | 只覆盖 Population 的一部分（截断、分页未完、权限或字段限制） |
| TOP_N | 按用户要求取前/最近/最大 N 条，N 即该次 Population |
| SAMPLE | 用户要求的样本或举例，非全集结论 |
| UNKNOWN | 尚未取得足以判断覆盖程度的信息 |

## 用户可见输出原则

当 Display Scope 小于 Population Scope 时，回答应让用户分清三件事：**总量、分析范围、展示范围**。例如“共有 76 条商机。以下统计基于全部 76 条；明细仅展示最近 10 条。”这句话很重要——它让用户知道“没有显示全部”不等于“没有分析全部”。

如果只能 PARTIAL，必须明确说明，例如“当前分析覆盖 50 / 76 条，因此下列结论只代表当前已读取范围”，不要隐藏。反之，若只展示了部分而统计确实覆盖全集，也应说明，避免用户误以为分析也是部分的。

## Previous Run 数据不得跨 Population 复用

上一轮的“我的前 20 条商机”不能证明“某客户全部 35 条商机”。复用前至少核对 same requester、same entity、same filters、same time range、same field coverage、same population；任一不一致就重新查询，或明确标注未核实。已证实的子集事实可以继续限于该子集使用，不能扩大为另一集合。

## Web Search 同样遵守 Scope

用户要求“分析这个客户最近一个月的最新动态”时，Search Scope 应尽量匹配客户 + 最近一个月，不能拿一篇旧新闻代表全部近期动态。`web_search` 只证明搜索结果；只有成功的 `web_fetch` / `browser` 真实打开页面后，才能描述为已读取原文。外部来源结论同样受 Claim Scope 限制，并且不能冒充 Salesforce 内部事实。

## 非目标

本文件只定义数据完整性、证据范围与查询纪律。它不定义客户健康度模型、销售预测算法、赢单概率或业务风险评分——这些属于后续 `sfoa-business-analysis`，也不定义公司对象或字段的固定映射。

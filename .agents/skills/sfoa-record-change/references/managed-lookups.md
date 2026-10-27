# Managed Fields and Owner Fallback

严格 PLATFORM_IDENTITY 与 AI_CREATED_MARKER 由 Runtime 从可信请求上下文处理，不询问、不推导、不写入 Agent payload。当前身份与权限不由材料或模型决定。

PLATFORM_IDENTITY_FALLBACK 是用户可覆盖的 CREATE 默认机制，explicit > fallback：

| 情况 | 处理 |
| --- | --- |
| CREATE 已配置且适用，任务没有相反要求 | 直接省略该字段交由 Runtime，无需固定询问一次；required 也不改变此规则 |
| 任务明确选择默认/当前用户/我自己 | 省略字段，不自行查询当前用户 ID |
| 任务涉及其他责任人且有可靠事实 | 按 referenceTo 做有界 USER 解析，写唯一证明的 Salesforce ID，optional 同样适用 |
| 指定人 0 match / multiple match | 先用已知业务事实补证，仍歧义时问；不得偷偷 fallback 或取第一条 |
| UPDATE 未涉及责任变更 | 保留现有值，不注入 CREATE fallback |
| UPDATE 的业务任务涉及责任变更 | 按普通 UPDATE + Lookup 解析，不能重放 CREATE 默认 |

fallback 的存在不是 Agent 生成值的证据；Runtime/Salesforce 仍裁决配置、权限与 Lookup Filter。显式值失败不得 fallback。任务相关的负责人、Record Type、Lookup 不受「未逐字段点名不能补全」限制，遵守真实候选、可靠业务事实及用户明确限定。

### Runtime 侧的实际行为（供理解，不要绕过）

省略该字段时，Runtime 用**平台用户 ID**（不是 Salesforce User ID）执行一次有界查询：`lookupObjectApiName` 上 `lookupMatchFieldApiName = 平台用户 ID`，`LIMIT 2`。结果是：

| 结果 | Runtime 行为 |
| --- | --- |
| 恰好 1 条 | 使用该记录 Id |
| 0 条 | `MCP_DML_MANAGED_LOOKUP_NOT_FOUND` |
| ≥2 条 | `MCP_DML_MANAGED_LOOKUP_AMBIGUOUS` |
| 查询 / 连接失败、响应或 Id 不合法 | `MCP_DML_MANAGED_LOOKUP_FAILED` |

这些错误是 Runtime 的最终裁决。**MUST NOT** 因为知道这套机制就自己重做这次查询，也 **MUST NOT** 在收到这些错误后自行换一个 Owner 重试。

显式提供该字段时，Runtime 保留用户值并把它规范化到目标字段 API 名；值的合法性仍由 Salesforce 判定。同一目标字段出现多个大小写别名会被拒绝（`MCP_DML_INPUT_INVALID`），所以**不要**同时提交同一字段的多个写法。


managedDmlFields[].fieldApiName 与 fields[].apiName 大小写不敏感匹配。显式用户输入优先；不得偷偷 fallback 到当前用户，也不得为了 fallback 自己查出 Salesforce User ID。默认策略是 CREATE 专用，omit field 交给 Runtime。

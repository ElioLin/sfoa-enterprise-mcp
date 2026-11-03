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

### 用户说「以 X 的账号创建 / 归属给 X」

- **MUST NOT** 切换认证身份；这是 owner/attribution 业务字段，不是登录身份。
- 先看当前 `managedDmlFields` 与字段 label：若存在可用户指定的归属 Managed 字段（例如 `PLATFORM_USER_LOOKUP_FALLBACK`），**MUST** 先调用 `get_record_action_context`，读取该托管字段对应字段描述中的 `referenceTo` 确定目标对象（**MUST NOT** 默认按 `User` 解析），再在该对象上按姓名/工号等业务字段解析 X 的唯一 Salesforce ID，并写入该字段。若 action context 不可用、字段描述缺失或 `referenceTo` 为空，**MUST** 先问，不得猜。
- **MUST NOT** 改用 `OwnerId` 或其他非托管字段代替已配置的归属 Managed 字段。
- 若没有可用户指定的归属字段，或策略是 strict `PLATFORM_IDENTITY`，**MUST** 明确告知用户无法指定归属人/身份，只能按当前认证身份执行（获得用户确认后）。
- 目标对象重名时先问是哪一条；指定值失败不得 fallback。

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

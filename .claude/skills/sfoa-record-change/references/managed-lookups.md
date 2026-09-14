# Managed Fields and Owner Fallback

Runtime 会把一部分字段标为 MCP 管理字段。它们出现在当前 `get_agent_playbook` 的 `managedDmlFields[]` 中，结构为 `{ objectApiName, fieldApiName, operations, managedBy: 'MCP', strategy }`。

匹配方式：把 `managedDmlFields[].fieldApiName` 与当前 Action Context `fields[].apiName` **大小写不敏感**匹配。不要按字段名猜它是不是 managed。

三种 strategy 的行为完全不同，**MUST NOT** 混为一谈。

## 1. 严格 managed：`PLATFORM_IDENTITY` / `AI_CREATED_MARKER`

```text
Agent 不询问
Agent 不填写
Agent 不覆盖
Runtime 负责
```

即使 Salesforce context 把它们标成 required 或 editable，也 **MUST NOT** 把它们放进必填问题、可选推荐或 `fields` payload。不要为了让「必填不漏」而把它们算成用户缺口。

## 2. `PLATFORM_IDENTITY_FALLBACK`（CREATE 专用）

这条策略允许显式用户值，并在字段被省略时由 Runtime 用当前平台用户补齐。

### 用户明确指定了 Owner / 该字段

```text
解析用户指定对象
→ 唯一匹配
→ 提交用户指定的值
```

显式用户输入优先，**不会被 fallback 覆盖**。解析按 [lookup-and-picklist.md](lookup-and-picklist.md) 的 Lookup 规则：必须拿到唯一证明的 Salesforce ID，不能提交姓名。

### 用户明确指定，但 0 match / multiple match

```text
CHANGE_READY=false
```

**MUST NOT** 偷偷 fallback 到当前用户，也 **MUST NOT** 自动改用另一个候选。如实告诉用户该指定对象无法唯一解析，请补充或更正。

### 用户没有指定，且字段 required

需要让用户知道：可以指定其他 Owner；如果不指定，将按当前用户处理。**MUST** 询问一次并等待回答，**MUST NOT** 因为「存在 platform default」就直接调用 `create_record`。

用户选择「按默认 / 当前用户 / 我自己 / 不用指定」时：

```text
omit field
→ 由 Runtime fallback
```

**MUST NOT** 为了 fallback 自己查出 Salesforce User ID 然后强行写进 payload。

### 用户没有指定，且字段 optional

未指定时不应该无意义阻塞 CREATE，直接省略该字段。

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

## 3. 普通 Lookup

不是 managed 的 Lookup 字段按普通字段处理，遵守 [lookup-and-picklist.md](lookup-and-picklist.md)。`referenceTo` 给出可引用的对象。

## Owner 与 Mutation Intent

**MUST NOT** 因为 Skill 自己认为「Owner 应该填」就扩大用户 Mutation Scope。用户没有要求修改或指定 Owner 时，不要为了「补全」而去找一个 Owner 写入。CREATE 真正必需的 Required / Default 除外，且必须来自 Runtime authority。

UPDATE 场景：`PLATFORM_IDENTITY_FALLBACK` 是 CREATE 专用，**MUST NOT** 把它当成 UPDATE 的自动默认值。用户没有要求改动该字段时直接省略，不要询问 CREATE 式的必填问题。完整的 UPDATE doctrine 属于后续阶段，本 Skill 不做扩展。

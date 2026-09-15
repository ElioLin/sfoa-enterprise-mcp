# Readiness Gate

`CHANGE_READY` 是 **Evidence-Based Mutation Readiness**，不是 Tool-Call-Count-Based Readiness。它的唯一用途是回答一个问题：**现在可以把这条记录安全地交给 Salesforce 吗？**

`CHANGE_READY` 不是 MCP Tool、不是数据库字段、不是事务状态、不是 Ready Token，也不是新的 Workflow Engine。它是 Agent 在当前证据上的判断结论。当前 Runtime 没有为它增加任何存储或协议；不要向用户或下游声称存在这样的机制。

CREATE 与 UPDATE 共用这一个逻辑概念，但**判断条件不同**。**MUST NOT** 为 UPDATE 新增 DB 状态、新 Tool、新 Runtime Enum、State Table、Mutation Workflow DB 或 Patch Approval Token。本 Skill 始终只是 Agent Operating Doctrine。

```text
CHANGE_READY
=
Evidence-Based Mutation Readiness
```

而不是：

```text
「Tool 已经调用过，所以可以写」
```

## CREATE 的 blocking conditions

以下任何一项为 true，`CHANGE_READY=false`：

| Blocking condition | 判定依据 |
| --- | --- |
| Intent 未确定 | 用户意图不是明确的创建 / 新增 / 发起申请 |
| Object 未确定 | 目标对象不是当前 Runtime / Salesforce 可证明的对象 |
| Record Type 未确定 | `availableRecordTypes` 多个且用户未唯一指定，或 `recordTypeSelectionRequired=true` |
| Effective Context 未充分解析 | 缺少本次 mutation 需要的字段、必填、可写、依赖事实 |
| 用户显式事实未纳入 | Prompt 已给出的事实还没有进入 draft 或 payload |
| Critical Dynamic Dependency 未稳定 | 见 [dynamic-forms.md](dynamic-forms.md) |
| Required 未满足 | Missing Required Checklist 非空，见 [create-readiness.md](create-readiness.md) |
| 提交字段不可写 / 不合法 | 当前证据显示字段不可 create，或值类型与字段类型不符 |
| Lookup 歧义未解决 | 0 match 或 multiple match，见 [lookup-and-picklist.md](lookup-and-picklist.md) |
| Picklist 未归一 | 还没有解析成当前 Record Type 的真实 API Value |
| Managed 字段规则未满足 | 见 [managed-lookups.md](managed-lookups.md) |
| Evidence 不足或被截断 | 见 [dynamic-forms.md](dynamic-forms.md) 的 Evidence Completeness |
| Mutation Intent 与最终 payload 不一致 | payload 扩大了用户要求的范围 |
| 用户已显式指定但解析失败 | 例如显式 Owner / Lookup 0 match、multiple match |

## UPDATE 的 blocking conditions

| Blocking condition | 判定依据 |
| --- | --- |
| Intent 不是明确的 UPDATE | 用户意图未确定或实为其他操作 |
| Object 未确定 | 目标对象不可由当前 Runtime / Salesforce 证明 |
| Target 未解析 | 0 match，或单条意图下 multiple match 未澄清。见 [update-readiness.md](update-readiness.md) |
| Target Population 范围未证明完整 | 查询有界却要宣称「全部已更新」 |
| Mutation scope 不明确 | 不知道用户到底要改哪些字段 |
| Patch 含非意图字段 | 出现用户没要求且 Runtime 未证明必要的字段 |
| 字段不可更新 | 当前证据显示 `fieldUpdateable=false` 或 `layoutEditableForUpdate=false`，而用户要求修改它 |
| 值与字段类型不符 | 提交值不是当前字段类型的合法 Salesforce 值 |
| Lookup 歧义未解决 | 0 match 或 multiple match |
| Picklist 未归一 | 未解析成当前 Record Type 的真实 API Value |
| Dependent Picklist controller 未确定 | controller 值未知 |
| Managed 字段规则未满足 | 要求修改严格 managed 字段，或显式 Owner 解析失败 |
| Record Type 意图未解析 | 用户要求变更但候选 / 许可未确认 |
| Evidence 不足或被截断 | 关键的 UPDATE context 事实缺失 |
| Mutation Intent 与最终 Patch 不一致 | Patch 超出用户要求的范围 |

`CREATE required` 与 `UPDATE missing required` **不是同一个 blocking condition**。记录已存在时，创建期必填缺口不构成 UPDATE 阻塞。

全部 blocking condition 为 false 时才可以 `CHANGE_READY=true`，然后才允许调用对应的写入 Tool。

## 明确不算 blocking condition

- 只因为「还没调用过某个 Tool」。证据已经足够时不需要为了形式完整再调用。
- 只因为 Runtime `coverage=PARTIAL`。`coverage` 描述解析范围，不等于本次 mutation 不可行；要看 Critical Dependency 是否受影响。
- 只因为 `resolutionStatus=RESOLVED` 之外存在与本次 mutation 无关的 UNKNOWN。
- 只因为 optional 字段为空。Optional 不是必填。
- 只因为字段是严格 managed。严格 managed 由 Runtime 负责，不是 Agent 的缺口。
- 只因为存在 Salesforce default。默认值解决「值从哪来」，不解决「Record Type 是否等于用户业务意图」，也不构成 UPDATE 时把 CREATE default 重新套用的理由。
- 只因为 UPDATE 没有携带 CREATE 的完整表单。UPDATE 的 scope 由用户意图决定。

## 每条记录独立判断

`create_records` 与 `update_records` 的 readiness 都是逐条的：

```text
∀ intended record: CHANGE_READY(record) == true
```

只要有一条不满足，默认先不 dispatch 当前 collection：先把不满足的那条准备完成。**MUST NOT** 在用户还在补充记录 C 时让 A / B 已经产生 Salesforce 副作用。只有当用户明确要求「能处理的先处理」这类 progressive execution 时才分批提交，并且必须如实报告哪些已提交、哪些还没有。

分组、上限、`>200` 顺序分批、`allOrNone` 与 `clientReferenceId` 见 [batch-mutations.md](batch-mutations.md)。

## 证据优先级

比较冲突信息时按此顺序：

```text
Current Tool Result
→ Salesforce Response
→ Runtime Context / Action Context
→ Agent Playbook
→ sfoa-record-change
→ Model Prior Knowledge
```

Runtime 返回的字段名、枚举值、错误码与 Schema 高于本 Skill 的任何描述。若本 Skill 与当前代码或运行时事实冲突，以运行时事实为准，并把差异当作 Runtime Defect 记录，而不是靠 Prompt 掩盖。

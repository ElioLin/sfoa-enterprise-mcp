# Readiness Gate

`CHANGE_READY` 是 **Evidence-Based Mutation Readiness**，不是 Tool-Call-Count-Based Readiness。它的唯一用途是回答一个问题：**现在可以把这条记录安全地交给 Salesforce 吗？**

`CHANGE_READY` 不是 MCP Tool、不是数据库字段、不是事务状态、不是 Ready Token，也不是新的 Workflow Engine。它是 Agent 在当前证据上的判断结论。当前 Runtime 没有为它增加任何存储或协议；不要向用户或下游声称存在这样的机制。

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

全部 blocking condition 为 false 时才可以 `CHANGE_READY=true`，然后才允许 `create_record` / `create_records`。

## 明确不算 blocking condition

- 只因为「还没调用过某个 Tool」。证据已经足够时不需要为了形式完整再调用。
- 只因为 Runtime `coverage=PARTIAL`。`coverage` 描述解析范围，不等于本次 mutation 不可行；要看 Critical Dependency 是否受影响。
- 只因为 `resolutionStatus=RESOLVED` 之外存在与本次 mutation 无关的 UNKNOWN。
- 只因为 optional 字段为空。Optional 不是必填。
- 只因为字段是严格 managed。严格 managed 由 Runtime 负责，不是 Agent 的缺口。
- 只因为存在 Salesforce default。默认值解决「值从哪来」，不解决「Record Type 是否等于用户业务意图」。

## 每条记录独立判断

`create_records` 的 readiness 是逐条的：

```text
∀ intended record: CHANGE_READY(record) == true
```

只要有一条不满足，默认先不 dispatch 当前 collection：先把不满足的那条准备完成。**MUST NOT** 在用户还在补充记录 C 时让 A / B 已经产生 Salesforce 副作用。只有当用户明确要求「能处理的先处理」这类 progressive execution 时才分批提交，并且必须如实报告哪些已提交、哪些还没有。

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

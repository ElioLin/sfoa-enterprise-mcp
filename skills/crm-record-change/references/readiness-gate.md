# Readiness Gate

`CHANGE_READY` 是 **Evidence-Based Mutation Readiness**，不是 Tool-Call-Count-Based Readiness。它的唯一用途是回答一个问题：**现在可以把这条记录安全地交给 Salesforce 吗？**

`CHANGE_READY` 不是 MCP Tool、不是数据库字段、不是事务状态、不是 Ready Token，也不是新的 Workflow Engine。它是 Agent 在当前证据上的判断结论。`formContext.status` 是 MCP 本次计算的表单就绪事实，不替代业务意图、唯一目标与合法值判断，也不是写入凭证。

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
| Record Type 未确定 | 任务、真实候选及适用默认仍不能合理确定类型，或选定类型后尚未取得该类型字段 |
| Effective Context 未充分解析 | 缺少本次 mutation 需要的字段、必填、可写、依赖事实 |
| 用户显式事实未纳入 | Prompt 已给出的事实还没有进入 draft 或 payload |
| Critical Dynamic Dependency 未稳定 | 见 [dynamic-forms.md](dynamic-forms.md) |
| Required 未满足 | Missing Required Checklist 非空，见 [create-readiness.md](create-readiness.md) |
| 提交字段不可写 / 不合法 | 当前证据显示字段不可 create，或值类型与字段类型不符 |
| Lookup 歧义未解决 | 0 match 或 multiple match，见 [lookup-and-picklist.md](lookup-and-picklist.md) |
| Picklist 未归一 | 还没有解析成当前 Record Type 的真实 API Value |
| Managed 字段规则未满足 | 见 [managed-lookups.md](managed-lookups.md) |
| 实质同记录歧义 | 适用查重证据指向同一业务记录，已有材料无法消解且用户尚未决定继续新建/更新/取消 |
| Evidence 不足或被截断 | 见 [dynamic-forms.md](dynamic-forms.md) 的 Evidence Completeness |
| Mutation Intent 与最终 payload 不一致 | payload 超出业务任务或违反用户明确限定 |
| 用户已显式指定但解析失败 | 例如显式 Owner / Lookup 0 match、multiple match |

未决事实确实可能改变所选表单的适用必填，或影响提交字段合法性及 Lookup/Picklist，且现有可靠证据无法消解时，属于 Critical Dynamic Dependency；`criticalUnknown` 必须先解决，API 已有值不能替代该判断。

## UPDATE 的 blocking conditions

| Blocking condition | 判定依据 |
| --- | --- |
| Intent 不是明确的 UPDATE | 用户意图未确定或实为其他操作 |
| Object 未确定 | 目标对象不可由当前 Runtime / Salesforce 证明 |
| Target 未解析 | 0 match，或单条意图下 multiple match 仍未唯一解析。见 [update-readiness.md](update-readiness.md) |
| Target Population 范围未证明完整 | 查询有界却要宣称「全部已更新」 |
| Mutation scope 不明确 | 业务任务含义仍有实质歧义 |
| Patch 含非意图字段 | 出现任务外、无可靠依据或违反明确范围的字段 |
| 字段不可更新 | 当前证据显示 `fieldUpdateable=false`，而用户要求修改它 |
| 值与字段类型不符 | 提交值不是当前字段类型的合法 Salesforce 值 |
| Lookup 歧义未解决 | 0 match 或 multiple match |
| Picklist 未归一 | 未解析成当前 Record Type 的真实 API Value |
| Dependent Picklist controller 未确定 | controller 值未知 |
| Managed 字段规则未满足 | 要求修改严格 managed 字段，或显式 Owner 解析失败 |
| Record Type 意图未解析 | 用户要求变更但候选 / 许可未确认 |
| 所选 Edit 表单必填未满足 | 保存值加 Patch 后 missingRequired 非空，包含历史空值 |
| 关键表单证据未知 | criticalUnknown 可能改变当前入口适用必填 |
| Evidence 不足或被截断 | 关键的 UPDATE context 事实缺失 |
| Mutation Intent 与最终 Patch 不一致 | Patch 超出业务任务或违反用户明确限定 |

`CREATE required` 与 `UPDATE missing required` **不是同一个 blocking condition**。只由创建期定义推导的缺口不阻塞 UPDATE；当前所选 Edit 表单明确要求且保存值为空的字段仍须满足。

全部 blocking condition 为 false 时才可以 `CHANGE_READY=true`，然后才允许调用对应的写入 Tool。

## 明确不算 blocking condition

- 只因为「还没调用过某个 Tool」。证据已经足够时不需要为了形式完整再调用。
- 只因为 Runtime `coverage=PARTIAL`。`coverage` 描述解析范围，不等于本次 mutation 不可行；要看 Critical Dependency 是否受影响。
- 只因为 `resolutionStatus=RESOLVED` 之外存在与本次 mutation 无关的 UNKNOWN。
- 只因为 optional 字段为空。Optional 不是必填。
- 只因为无关、未提交、非必填字段的 PENDING/UNKNOWN 显示条件未决。影响所选表单适用必填的 criticalUnknown 必须停止，不能因 API 必填已有值就忽略 UI 必填的不确定性。
- 只因为查重 0 行。0 行只说明当前可见 / 查询范围内未发现，不证明全局唯一；它不阻塞 CREATE，但也不得被表述为「没有重复」。
- 只因为字段是严格 managed。严格 managed 由 Runtime 负责，不是 Agent 的缺口。
- 只因为多个 Record Type、optional 字段未被点名或值来自忠实提炼/可靠关联；这些不是追问理由。适用 CREATE fallback 可直接省略交由 Runtime，UPDATE 不重放默认。
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
→ crm-record-change
→ Model Prior Knowledge
```

Runtime 返回的字段名、枚举值、错误码与 Schema 高于本 Skill 的任何描述。若本 Skill 与当前代码或运行时事实冲突，以运行时事实为准，并把差异当作 Runtime Defect 记录，而不是靠 Prompt 掩盖。

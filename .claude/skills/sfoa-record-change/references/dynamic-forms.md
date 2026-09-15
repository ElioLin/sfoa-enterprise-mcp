# Dynamic Forms Doctrine

本文件处理 CREATE 的字段可见性与条件必填。它是本 Skill 最重要的专业部分：此前真人 UAT 的字段遗漏，根因不是没有调用 Action Context，而是**看见了 PENDING / VISIBLE 却没有继续解析**。

## 先确认这次是否真的用了 Dynamic Forms

CREATE 输出里的 `uiContext` 与 `coverage.dynamicFormsEvaluated` 才能说明本次是否使用了 Dynamic Forms：

- `uiContext` 存在且 `mode=ENFORCE`、`formSource` 为 `DYNAMIC_FORMS` 或 `MIXED`、`fallbackUsed=false` 时，`fields[]` 才带有 `visibilityState`、`effectiveRequired`、`effectiveEditable`、`requiredSource`、`dependsOn` 等有效属性。
- 发生 PAGE_LAYOUT fallback（`fallbackUsed=true`、`formSource=UNRESOLVED`、`resolutionStatus=UNRESOLVED`，或 `uiContext` 缺失）时，返回的是既有 Page Layout 结果，**没有** effective 属性。此时**MUST NOT** 假装做过 Dynamic Forms 判断，应按当前 Playbook 的 Page Layout 工作流处理，并如实说明 fallback 与 `fallbackReason`。
- `coverage.completeLightningPageEvaluated` 在当前 contract 中恒为 `false`。**MUST NOT** 声称整张 Lightning Page 已被 100% 完整解析。

## 四态语义

| 状态 | 含义 | 允许的动作 |
| --- | --- | --- |
| `VISIBLE` | 当前规则判定为可见 | 可以询问、可以推荐、可以提交 |
| `HIDDEN` | 当前规则判定为隐藏 | **MUST NOT** 询问、**MUST NOT** 推荐 |
| `PENDING` | 存在当前已知的 dependency，但依赖值还不在 draft 中 | **MUST** 继续解析或询问依赖 |
| `UNKNOWN` | 当前 Runtime 无法判定 | **MUST NOT** 猜测成 VISIBLE 或 HIDDEN |

`UNKNOWN` 不等于 `PENDING`。PENDING 表示「差一个已知输入」；UNKNOWN 表示「当前解析能力不足以判定」。

## PENDING 处理

```text
field.visibilityState == PENDING && dependsOn == [...]
```

- `dependsOn` 对应的事实**已经在用户 Prompt 中知道** → 自动写入 `draftFields`，带同一 `recordTypeId` 执行下一次 refinement，不要询问用户第二次。
- `dependsOn` 对应的事实**还不知道** → 询问依赖字段本身，不要询问依赖它的那个字段。
- 用户回答后 → 更新 draft → refinement → 重新获取 Effective Context → 重新判断。

```text
看见 PENDING → 忽略 → CREATE   ❌ 绝对禁止
```

`conditionalRequired=true` 表示该字段在 PENDING 状态下曾经是必填。它只有在可见性解析为 `VISIBLE` 之后才变成问题。

## UNKNOWN 处理

`UNKNOWN` 可能来自（以当前代码为准）：

- 当前解析器不支持的 condition 或 operator
- `unsupported=true` 或规则没有可评估 criteria
- 依赖的记录字段类型未知
- 依赖 `$Permission.*` 等当前不可用的事实
- 任意关系路径、record-dependent 表达式
- section / container 级的 record-dependent 规则（当前对未保存 draft 保守返回 UNKNOWN）
- 布尔过滤器无法解析或超出深度
- 比较时左右类型不匹配

**MUST NOT** 把 `UNKNOWN` 推断成 `VISIBLE` 或 `HIDDEN`。是否阻塞取决于下面的 Critical 判断。

## Critical Dynamic Dependency

一个 unresolved 状态属于 **Critical Dynamic Dependency**，当且仅当它可能改变：

- 本次字段是否 Required
- 本次要提交的字段是否 Editable
- 本次字段是否 Visible
- Required Checklist 的内容
- Lookup 依赖
- Picklist 依赖
- 当前字段是否合法

则 `CHANGE_READY=false`。

反之，如果只是与本次 mutation 无关的 non-critical UNKNOWN，并且 Runtime 已经足够证明：

- 当前真正 required 的字段已满足
- 当前 payload 合法
- 当前提交字段可写

则**不应该机械无限阻塞**。但必须遵守：**不能因为继续执行，就声称整个 Lightning Page 已被完整解析。**

## Refinement

使用当前 Runtime 真实允许的 contract，不要自己虚构次数。当前 contract 是 `refinement` 取值 `0..3`，`uiContext.maxRefinements=3`，`uiContext.refinementLimitReached` 在 `refinement=3` 时为 true。

```text
Initial Context
→ 已知依赖写入 draftFields
→ refinement + 1
→ 新 Context
→ 直到 Critical dependency 稳定，或达到 Runtime 上限
```

达到上限且仍存在影响本次 mutation 的关键 unresolved dependency 时：

```text
CHANGE_READY=false
不得 CREATE
```

并如实告诉用户：当前 Salesforce 页面条件仍无法充分解析，需要补充信息或无法安全执行。**MUST NOT** 让模型直接猜。

Runtime 不保存会话状态；refinement 计数由客户端自己保留。**MUST NOT** 假设存在跨调用的服务端状态。

## Evidence Completeness Gate

Tool result 明确表示以下任一情况时：

```text
truncated / omitted / response incomplete / required evidence unavailable
```

则：

- **MUST NOT** 宣称所有 Required Fields 已完成验证。
- **MUST NOT** 把 `CHANGE_READY=true` 建立在明显截断的关键证据之上。
- 应指出被截断的证据范围，并只对已覆盖部分下结论。

但不要写成「`coverage != COMPLETE` 就永远禁止 CREATE」。必须区分：

| 概念 | 含义 | 处理 |
| --- | --- | --- |
| Evidence Delivery Incomplete | Tool result 被截断 / 省略，Agent 看不到完整事实 | 不能宣称验证完成；必要时缩小范围重取 |
| Runtime Coverage Partial | Runtime 明确返回 `coverage=PARTIAL`，因为存在 PENDING / UNKNOWN 或 Picklist 截断 | 结合 Critical Dependency 判断是否阻塞 |

`coverage=PARTIAL` 本身不是永久阻塞；`coverage.truncated=true`、`defaultValueTruncated=true`、`picklist.truncated=true` 或 Tool 层截断标记表示关键证据不完整，必须按上面处理。

## 询问节奏

当**当前 dependency layer 已经稳定**时，一次性合并询问这一层真正缺失的字段。不要在同一层里把同一层可以一起问的字段拆成多轮，也不要为了「只问一次」提前猜测后续字段。Optional 字段不要无意义追问。

## UPDATE 中的边界

本文件的四态语义、PENDING 解析与 refinement 循环是 **CREATE 专用**机制。当前 Runtime 事实：

```text
get_record_action_context(action=UPDATE)
→ coverage.dynamicFormsEvaluated == false（恒定）
→ 不返回 visibilityState / effectiveRequired / effectiveEditable / requiredSource / dependsOn
→ 不返回 defaults
→ 不接受 draftFields / refinement
```

因此 UPDATE 中：

- **MUST NOT** 建立一个假的 CREATE form completeness，也 **MUST NOT** 要求用户重新填写整张 CREATE 表单。
- **MUST** 只关注本次要修改的字段是否「当前有效、当前可更新、当前依赖关系可解析」，判据是 `fieldUpdateable` / `layoutEditableForUpdate` 与字段自身类型。
- 用户修改 controller 类字段可能导致其他 UI 字段显隐变化。当前 Runtime **无法预计算**这种 hypothetical UPDATE context；该能力边界**MUST** 如实承认。
- 变更后真正生效的必填 / 校验 / 依赖结果由 Salesforce Validation、Flow、Trigger、Lookup Filter 与 DML Runtime 裁决。**MUST NOT** 用模型猜测补齐这个缺口，**MUST NOT** 为此新增一个 Form Engine。

UPDATE 的完整 doctrine 见 [update-readiness.md](update-readiness.md)。

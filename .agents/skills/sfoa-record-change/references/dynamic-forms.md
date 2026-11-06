# Dynamic Forms Doctrine

本文件处理所选 CREATE/UPDATE 表单的字段可见性与条件必填。按 [精确表单流程](precise-forms.md) 使用 `formContext`，检查全部适用必填并保留真实覆盖限制；无关可选未知不阻断。

## 先确认这次是否真的用了 Dynamic Forms

精确路径先看 `formContext.formSource/status/criticalUnknown`。DYNAMIC_FORMS/MIXED 使用当前有效页面，PAGE_LAYOUT 使用当前动作布局，QUICK_ACTION 使用动作自己的表单。不得按“有没有记录详细信息”先跳过混合页中的 Dynamic Forms。

兼容旧 CREATE 输出时，`uiContext` 与 `coverage.dynamicFormsEvaluated` 说明旧路径是否使用了 Dynamic Forms：

- `uiContext` 存在且 `mode=ENFORCE`、`formSource` 为 `DYNAMIC_FORMS` 或 `MIXED`、`fallbackUsed=false` 时，`fields[]` 才带有 `visibilityState`、`effectiveRequired`、`effectiveEditable`、`requiredSource`、`dependsOn` 等有效属性。
- 发生 PAGE_LAYOUT fallback（`fallbackUsed=true`、`formSource=UNRESOLVED`、`resolutionStatus=UNRESOLVED`，或 `uiContext` 缺失）时，返回的是既有 Page Layout 结果，**没有** effective 属性。此时**MUST NOT** 假装做过 Dynamic Forms 判断，也不能据此宣称精确表单已就绪；如实说明 fallback 与 `fallbackReason`。
- `coverage.completeLightningPageEvaluated` 在当前 contract 中恒为 `false`。**MUST NOT** 声称整张 Lightning Page 已被 100% 完整解析。

## 四态语义

| 状态 | 含义 | 允许的动作 |
| --- | --- | --- |
| `VISIBLE` | 当前规则判定为可见 | 结合实际缺口询问、推荐；提交仍需 API 写权限与合法值 |
| `HIDDEN` | 当前规则判定为隐藏 | 仅页面要求不询问、不推荐；API-required 仍独立必需 |
| `PENDING` | 存在当前已知的 dependency，但依赖值还不在 draft 中 | 影响本次必填、提交合法性或业务事实时继续解析；仍缺关键事实才问 |
| `UNKNOWN` | 当前 Runtime 无法判定 | **MUST NOT** 猜测成 VISIBLE 或 HIDDEN |

`UNKNOWN` 不等于 `PENDING`。PENDING 表示「差一个已知输入」；UNKNOWN 表示「当前解析能力不足以判定」。

## PENDING 处理

```text
field.visibilityState == PENDING && dependsOn == [...]
```

以下补证与 refinement 仅用于确实影响本次所需值或提交合法性的依赖。

- `dependsOn` 对应的事实**已从提示、实际已读材料、上下文或可靠关联中确定** → 自动写入 `draftFields`，带同一 `recordTypeId` 执行下一次 refinement，不要询问用户第二次。
- `dependsOn` 对应的事实**还不知道** → 先利用已有信息与可用读取补证，仍缺关键事实才问依赖字段，不先问依赖它的字段。
- 用户回答后 → 更新 draft → refinement → 重新获取 Effective Context → 重新判断。

```text
影响本次必填或提交合法性的 PENDING → 补足相关依赖 → 判断是否仍需澄清
仅无关选填字段的显示条件 PENDING → 保留覆盖限制，不阻断已充分确定的写入
```

`conditionalRequired=true` 表示存在条件必填可能性，不代表当前已经缺值。条件可能改变本次所需值且现有可靠证据无法消解时，才按 Critical Dependency 解析；已合法满足的值不会仅因页面条件未明而再问。

## UNKNOWN 处理

`UNKNOWN` 可能来自（以当前代码为准）：

- 当前解析器不支持的 condition 或 operator
- `unsupported=true` 或规则没有可评估 criteria
- 依赖的记录字段类型未知
- 依赖 `$Permission.*` 等当前不可用的事实
- 任意关系路径、record-dependent 表达式
- section / container 级缺少可证明的页面加载事实；UPDATE 使用已保存值，不能把未保存 draft 代入区块条件
- 布尔过滤器无法解析或超出深度
- 比较时左右类型不匹配

**MUST NOT** 把 `UNKNOWN` 推断成 `VISIBLE` 或 `HIDDEN`。是否阻塞取决于下面的 Critical 判断。

## Critical Dynamic Dependency

未决事实确实可能改变所选表单的适用必填，或影响提交字段合法性及 Lookup/Picklist，且现有可靠证据无法消解时，属于 **Critical Dynamic Dependency**，此时 `CHANGE_READY=false`。无关、未提交、非必填字段的 PENDING/UNKNOWN 显示条件不阻断已确定写入。

API 必填已有合法值并不能消除仍可能改变 UI 必填的 `criticalUnknown`。页面状态与 FLS 分别判断；精确契约在提交前验证所选表单，旧通用 API 仍兼容，但 Skill 不能删掉 formContext 绕过已发现的关键缺口。开发测试 oracle 只验证指导契约，不接入服务端充当判定器。

反之，如果只是与本次 mutation 无关的 non-critical UNKNOWN，并且 Runtime 已经足够证明：

- 当前真正 required 的字段已满足
- 当前 payload 合法
- 当前提交字段可写

则**不应该机械无限阻塞**。但必须遵守：**不能因为继续执行，就声称整个 Lightning Page 已被完整解析。**

## Refinement

使用当前 Runtime 真实允许的 contract，不要自己虚构次数。当前 contract 是 `refinement` 取值 `0..3`；精确路径从 START 进入 REFINE，最多三次。旧路径 `uiContext.maxRefinements=3`，`uiContext.refinementLimitReached` 在 `refinement=3` 时为 true。

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
不得 CREATE / UPDATE
```

并如实告诉用户：当前 Salesforce 页面条件仍无法充分解析，需要补充信息或无法安全执行。**MUST NOT** 让模型直接猜。

Runtime 不保存问答会话或草稿；refinement 计数由客户端保留。精确路径可用服务器返回的 `structuralContextRef` 在同一任务 REFINE 复用有界结构配置；这不包含 USER 字段事实或求值结果，不是跨任务会话状态。新任务 START 和真正提交的 SUBMIT 必须重新读取配置，或当次权威核验每个组件版本一致后复用；未经核验的缓存和 REFINE 引用不能替代提交检查。

## Evidence Completeness Gate

Tool result 明确表示以下任一情况时：

```text
truncated / omitted / response incomplete / required evidence unavailable
```

则：

- 若截断影响本次必填、提交字段合法性、唯一性或适用依赖，**MUST NOT** 宣称相关 Required Fields 已完成验证。
- **MUST NOT** 把 `CHANGE_READY=true` 建立在明显截断的关键证据之上。
- 应指出被截断的证据范围，并只对已覆盖部分下结论。

但不要写成「`coverage != COMPLETE` 就永远禁止 CREATE」。必须区分：

| 概念 | 含义 | 处理 |
| --- | --- | --- |
| Evidence Delivery Incomplete | Tool result 被截断 / 省略，Agent 看不到完整事实 | 不能将片段说成全集；影响本次相关字段验证时补取证据 |
| Runtime Coverage Partial | Runtime 明确返回 `coverage=PARTIAL`，因为存在 PENDING / UNKNOWN 或 Picklist 截断 | 结合 Critical Dependency 判断是否阻塞 |

`coverage=PARTIAL` 本身不是永久阻塞；`coverage.truncated=true`、`defaultValueTruncated=true`、`picklist.truncated=true` 或 Tool 层截断标记需要结合本次任务判断。影响本次必填、提交字段合法性、唯一性或适用依赖时补足相关证据；无关 optional 字段或已覆盖选择之外的候选被截断，不自动阻塞任务，也不能因此宣称全集完整。

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
- **MUST** 只关注本次要修改的字段是否「当前有效、具有 API 更新权限、相关依赖可解析」，以 `fieldUpdateable`、类型和真实约束判断；`layoutEditableForUpdate` 是页面事实，不单独否定 API 可写字段。
- 用户修改 controller 类字段可能导致其他 UI 字段显隐变化。当前 Runtime **无法预计算**这种 hypothetical UPDATE context；该能力边界**MUST** 如实承认。
- 变更后真正生效的必填 / 校验 / 依赖结果由 Salesforce Validation、Flow、Trigger、Lookup Filter 与 DML Runtime 裁决。**MUST NOT** 用模型猜测补齐这个缺口，**MUST NOT** 为此新增一个 Form Engine。

UPDATE 的完整 doctrine 见 [update-readiness.md](update-readiness.md)。

# 创建 / 编辑的精确表单上下文

使用当前工具 Schema 提供的 `formContext`。它适用于桌面标准 New/Edit 和原生创建/编辑 Quick Action；自定义 Flow/LWC/Visualforce 表单、移动端与未支持表达式不能冒充已验证。Skill 整理业务事实，MCP 确定页面、计算规则，Salesforce 执行权限与最终保存校验。

## 选择入口与上下文

1. 先确定对象与 CREATE/UPDATE。UPDATE 先以真实记录 ID 解决唯一目标；CREATE 按当前可用 Record Type 与任务语义选择，不因多候选固定追问。编辑沿用记录类型；当前能力不支持假设切换后的表单，不能靠模型模拟。
2. 默认 `formContext.entry=STANDARD`。只有用户明确要求某个原生 Quick Action，或可靠上下文已唯一指向它时，才用 `QUICK_ACTION` 并携带真实 `quickActionName`。明确动作时由其定义决定目标对象与固定 Record Type；若与业务意图冲突先说明，不能套用标准表单候选或因字段更少偷换入口。Quick Action 的 `sourceRecordId` 是来源记录，不能充当 CREATE 的目标 `recordId`。
3. 任务明确应用时传真实 `appDeveloperName`；否则由 MCP 查询当前用户的 Profile 默认应用并验证其可访问性。集成默认应用、最近使用应用、模型猜测均不能代替。应用或分配不明且影响必填时停止并说明缺口，不自行挑 Page Layout / Lightning Page。

## 草稿与多轮补足

首次 `get_record_action_context` 传 `formContext.phase=START`；将实际已知、按当前字段映射的事实放入 `draftFields`。UPDATE 同时传 `recordId`，MCP 合并保存值与 Patch，检查所选 Edit 表单全部适用必填；历史空值也可能成为本次缺项。已保存的有效值不重问，标准 UPDATE 不重发未变化值、不重放 CREATE 默认；原生 Quick Action 的明确预设覆盖值按下述例外保留。用户明确限定修改范围而当前表单要求补其他字段时，说明冲突并请用户决定，不能静默扩大范围或换入口规避。`formContext` 已包含值评估，不能同时传旧 `includeValueAssessment=true`。

`formContext.fields` 分开报告 `required`、`visibility`、`writable`、`valueState`、`valueSource`。`CLIENT_DRAFT` 只证明客户端提供草稿，不能证明用户原话或材料已读。`false`、`0` 是值；null、空字符串与未提供不同。严格 managed 字段仍由服务器处理；不能为消除缺项而猜托管值或把保存后 Flow/Trigger 当作当前值。

`MANAGED_ON_WRITE` / `MANAGED_POLICY` 表示当前已启用托管策略负责写入时补值，不是已经读取的字段值。START 可因此免除该字段的缺值追问；实际值由提交前解析后再校验。该策略不能充当 Dynamic Forms 初始值，也不能消除影响必填的 `criticalUnknown`。

`DEFAULT_ON_WRITE` / `SALESFORCE_DEFAULT_ON_WRITE` 表示 Runtime 已从当前 USER 的 Salesforce Describe 确认保存时默认机制。它只适用于 CREATE、属性未提供、仅 API 必填且无 UI 必填的值义务；`required=true` 仍保留，不变成可选字段。不为这项默认义务追问或自行注入 false 等值，也不把它当页面初始事实参与显隐。显式 null/空字符串、UI 必填和 UPDATE 不适用此豁免；仍按返回缺项和 `criticalUnknown` 处理。

控制值已有可靠事实时先自动补入草稿。确实缺少业务事实时集中询问；回答后保持同一入口/应用/记录类型，用 `phase=REFINE` 与递增 `refinement` 重新计算，最多 3 次。字段条件可随未保存草稿变化，区块条件依其页面加载事实计算，不能把两种语义混用。

若返回 `structuralContextRef`，只在同一任务、同一选择的 REFINE 原样携带。它复用短期结构配置，不复用草稿、USER 字段事实或已计算的显隐结论，也不是授权票据。`configurationSource=TASK_REUSE` 时 `verifiedAt` 仍是原始配置读取时间；引用过期、缺失或不匹配时 MCP 重新取证。新任务 START 与真正 DML 的 SUBMIT 必须重新读取配置，或当次权威核验每个组件版本一致后复用对应配置；未经核验的缓存与任务 REFINE 引用都不能绕过提交检查。

- `READY`：本轮支持范围内的表单检查已就绪；还需业务意图、Lookup/Picklist、最小 Patch 与实际权限成立。
- `NEEDS_INPUT`：从 `missingRequired` 找缺项，先用已读材料、保存值和可靠默认补足，只问真正缺失的必要信息。
- `UNKNOWN`：查看 `criticalUnknown`，当前证据可能改变必填判断，保持 `CHANGE_READY=false`。不得删掉 `formContext` 改走旧调用，也不得把 Page Layout 回退当完整动态表单。

无关可选字段的 UNKNOWN 不自动阻断；API 必填不因页面隐藏而消失。局部投影、截断或“工具成功”都不能证明完整表单已验证。达到 refinement 上限仍有关键缺口时，明确无法继续自动提交。

## 提交与配置变化

创建/编辑工具携带相同的 `formContext` 入口、应用和 Quick Action 来源选择。提交时移除 `recommendationFields`；服务器自动执行 `SUBMIT` 阶段重新取证，发现配置变化、缺项或关键未知时在实际写入前拒绝。无需另加一轮用户确认；也无需为了形式重复调用一次上下文工具。

`uiContextResolutionId` 原样传递用于审计关联，它是客户端提供的未核验关联，不是授权票据。`MCP_FORM_NOT_READY` / `MCP_FORM_CONTEXT_UNAVAILABLE` 表示提交前未就绪或证据不可用；按实际缺口补证后重新准备。已分派后 `MCP_DML_OUTCOME_UNKNOWN` 仍禁止自动重试。

原生 Quick Action 使用自己的动作布局、必填、固定目标 Record Type、父记录关系和 Salesforce 计算的预设值，不借用标准表单，也不由模型计算公式。QUICK_ACTION 仅使用单条 create_record/update_record，不进入批量工具；多条动作逐条准备、调用并保留每项结果，不能承诺跨调用 allOrNone。

原生 Quick Action 为覆盖动作预设所需的明确值，即使等于保存值也必须保留。例如保存值为“开启”、动作预设为“关闭”，用户明确要求仍为“开启”时，draftFields 与动作提交字段都保留“开启”；省略会允许动作采用“关闭”。标准 UPDATE 继续只提交实际变化字段；两种入口不能混用省略规则。

旧版通用 API 调用仍保持兼容，但它不证明已满足所选 UI 表单。工具不支持新契约时如实报告能力缺口，不能承诺相同精度。读取和写入间仍存在配置或记录并发变化窗口；只有真实 Salesforce 提交结果能证明保存结果。

## 可选建议与效率

任务材料已经支持的 optional 值可直接按真实字段映射，无需统计背书。统计推荐使用 `recommendationFields` 指定最多 25 个任务相关候选，再由 MCP 限制为当前可见、可写的可选字段。

默认证据是当前 USER 可读、同对象同 Record Type、最近 30 天创建记录的**当前非空值**；至少 20 个可用样本，非空比例至少 80%，最多推荐 3 项。阈值以实际工具结果为准，报告分子、分母、窗口及采样/截断范围。样本不足不扩窗、不跨类型，不称为“最近人工填写”。

已就绪且已授权的保存先执行，建议在保存后补充；若本来就缺必填需要问，可在同轮合并建议。统计结果不提升必填性，不额外增加确认轮次，不阻塞提交。复用本任务已验证字段结构，按依赖做 REFINE，不扫描全组织或反复读取无关字段。最终提交的新鲜度检查不能由旧快照替代。

# 创建与编辑表单精确上下文

状态：实现完成，自动化及真实只读 API 验证完成；原生界面对照和实际写入验收尚未完成。起点 `feature/agent-material-workflows@048eae03`；开发分支 `codex/record-change-precision`。

## 已确认范围

桌面标准 New/Edit（Page Layout、Dynamic Forms、混合页面）及明确选择的原生 Create/Update Quick Action。Flow、自定义 LWC/Visualforce 表单、移动端和任意 Apex 表达式解释不在首批支持范围。Skill 负责意图、业务事实整理、追问和建议；MCP 提供可验证的配置事实与确定性计算；Salesforce 保持 CRUD/FLS、共享和最终保存校验权威。

应用按任务明确应用、当前 USER 的 Profile 默认应用顺序选择，且验证 USER 实际可访问；集成默认应用和最后使用应用不能代替该事实。记录类型必须来自用户可用候选或编辑记录；Quick Action 的固定目标记录类型需核对。必须区分动作覆盖、Lightning 页面分配和 Page Layout 分配。混合页面的 New/Edit 使用 Dynamic Forms。

每个字段分别表达 API 必填、页面必填、条件状态、可写性、已有值与来源。UPDATE 合并已保存记录和最小 Patch，检查所选 Edit 表单全部适用必填，不能重放 CREATE 默认值。字段可见性使用当前草稿；区块可见性使用相应页面加载事实，无法证明的语义保留 UNKNOWN。重复字段实例、父容器与字段自身条件分别计算。影响必填的 UNKNOWN 阻止就绪；无关可选字段 UNKNOWN 不阻断。

建议统计仅使用当前 USER 可读、同对象同 Record Type、最近 30 天创建记录的当前非空值；至少 20 个可用样本、比例至少 80%、最多 3 个当前可见可写且与任务相关的可选字段。窗口/阈值可配置，样本不足不扩窗、不跨类型。报告样本数与分母，不称为最近人工填写。已就绪保存不等待建议查询。

## 代码边界

- 扩展现有 `get_record_action_context` 的可选 `formContext`，保留未启用时的原有行为与 API 调用数。新契约统一 CREATE/UPDATE 的表单解析、就绪和可选统计。
- `precision-metadata.ts` 只读取本次目标配置，DIAGNOSTIC 只读配置与 USER 业务事实保持隔离并验证组织一致。旧手动快照不充当新契约的新鲜度证据。
- `precision-standard.ts` 复用 FlexiPage 结构解析与四态条件计算；`precision-quick-action.ts` 使用原生动作描述、动作布局和 Salesforce 计算的默认值。
- `precision-recommendations.ts` 独立、只读、有界；不进入提交关键路径。
- 创建/编辑工具可携带相同表单选择，Host 在治理与托管字段处理后、实际分派前重新取证并检查。上下文 ID 只是审计关联，不是授权票据。未携带新契约的现有调用保持兼容。
- 初始与提交阶段读取当前相关配置或向 Salesforce 核验匹配的逐组件修改版本；不声称读取到写入具有配置事务锁。有界目录读取与独立读取并行，追问使用同任务结构引用。两层结构缓存均不保存记录值、草稿或已计算字段状态，具体上限见 [ADR-0036](adr/ADR-0036-selected-record-form-precision.md)。
- P7 使用既有事件与受保护按需 Payload，区分 Salesforce 观察事实、MCP 计算与客户端声明。审计故障仍 fail-open。

## 固定验收矩阵

下列场景在开发前锁定，不因实现困难删除。自动化通过与真实 Salesforce UI 对照通过分别报告。

| 场景 | 核对点 |
| --- | --- |
| Profile 默认应用与任务显式应用不同 | 可访问性、正确页面分配与事实来源 |
| 应用/Profile/Record Type/桌面分配组合 | 唯一匹配、继承/冲突不猜测 |
| 标准 Page Layout 新建与编辑 | 当前 USER 布局、全部必填、已有值与最小 Patch |
| 动态字段多轮条件 | null/空/false/0、AND/OR、依赖变化与新增必填 |
| Field Section 与字段条件不同 | 保存值/页面加载值和草稿值分离 |
| 混合页面及重复字段实例 | DF 优先、实例 OR、父子 AND |
| FLS 不可访问与隐藏 API 必填 | 不以 DIAGNOSTIC 权限代替 USER；明确缺口 |
| 原生 Create/Update Quick Action | 独立动作布局、固定 RT、预设公式与父记录 |
| 自定义覆盖或不支持条件 | 关键 UNKNOWN 不提交；无关可选未知不误阻断 |
| 近期可选建议 | 同 USER/对象/RT/窗口、样本分母、上限及不阻塞保存 |
| 配置在问答后变化 | 提交前重新计算，不沿用过期结论 |
| 审计与运行隔离 | 具体依据可查看；值按需读取；失败不改变执行结果 |
| 非创建/编辑及旧调用 | 调用数、身份、治理、超时、stdio/HTTP 无回归 |

真实 UI 验收要求同一用户、应用、记录类型、入口、记录和草稿状态逐项对照；首批场景必填漏判/误判均为零。关键 UNKNOWN 不能计为通过；覆盖率与准确率分别报告。尚未取得真实 UI 对照证据，不承诺任意未来配置的 100% 自动完成率。

## 已实现的关键行为

上下文返回 `READY / NEEDS_INPUT / UNKNOWN`、页面选择依据、字段必填/可写/显隐状态、值来源及剩余缺口。携带 `formContext` 的创建/编辑在 Host 分派前重新取证，客户端上下文 ID 不能代替检查。无该参数的旧调用保留原流程，查询、附件、诊断及协议发现不进入表单计算。

原生 Quick Action 有独立的动作布局、预设与父记录校验；无法证明目标 Record Type 时拒绝推断。仅单条工具执行原生动作，标准表单支持逐条检查后的集合写入。UPDATE 不重放新建默认值，并保留用于覆盖动作预设的显式原值。

USER Describe 补齐自动编号及默认值机制的证据。托管字段不能绕过 USER 写权限；已证明保存时赋值的缺省 CREATE API 必填字段标记 `DEFAULT_ON_WRITE`，不当成已有值参与显隐判断。显式 null/空值、页面必填和 UPDATE 不享受该替代。

审计按需展开字段、规则、依赖、值来源和配置新鲜度；工具调用成功与表单就绪分别显示。即使详细事件丢失，终态摘要中的未就绪状态仍会显示。摘要不提前暴露受保护字段值，审计失败不改变业务执行结果。

## 自动化验证记录

| 验证 | 结果与证据 |
| --- | --- |
| 全工作区构建 | 21 个工作区通过，`.temp/record-precision-final-build-complete.log` |
| Context 全套 | 316/316；包括旧 Dynamic Forms 精确基准比对，`.temp/record-precision-context-fixture-fix.log` |
| DML 全套 | 47/47，`.temp/record-precision-dml-final.log` |
| Host / P3 / P4 / P7 广泛回归 | 478 项中 477 通过；唯一失败为旧指导文案断言，更新测试后该文件 3/3 通过，无运行时代码变更。原日志 `.temp/record-precision-server-final-serial.log`，修复验证 `.temp/precision-guidance-focused-final.log` |
| P7 性能与隔离 | 原超时设置下 OFF/ON 50/100/200 并发门禁通过，零请求失败、零跨审计绑定；不据此声称整体性能提升 |
| MySQL 模式策略隔离（模拟存储） | 4/4，`.temp/record-precision-p5-policy-final.log`；本次未新增数据库迁移 |
| Admin 审计组件 | 19/19，`.temp/record-precision-ui-final.log` |
| 浏览器审计界面 | 1/1；桌面与 390px 窄屏截图已检查，`.temp/record-precision-browser-final.log` |
| Playbook | 48/48，5 份生成产物同步检查通过，版本 1.14.0 |
| Skills | sync/check/delivery 通过，完整测试 88/88，`.temp/record-precision-skill-*-final.log` |

保留失败历史：最初全量构建缺少当前 shell 的 Git `cp` 路径，使用本机 `D:\Git\usr\bin` 后解决，未修改上游构建实现；并行开发中的一次语法编译失败已修正。新增测试曾改变共享夹具的响应字节数，现恢复旧夹具，仅精确表单测试注入 CRUD 事实，未改旧基准期望。早期并发执行全部测试曾出现一次 P7 HTTP 504；后续单文件并发度运行门禁通过，未放宽超时，未将该次失败断言为已定位的性能根因。

## 真实只读取证与耗时

脱敏可复核结果保存在 [证据 JSON](evidence/record-change-precision-20261106.json)。使用已有的不同 USER/DIAGNOSTIC 路由，业务写入和配置写入均为 0。

- `Account_Visit__c`：Profile 默认应用 `CBU_CRM_PC`，命中 ORG_DEFAULT 的 `Account_Visit` Dynamic Forms，解析 52 个字段实例。
- 两次元数据测量：冷读 19.296 / 28.058 秒，重新核验版本后的读取 4.319 / 4.741 秒；前后结构一致。冷启动仍受 Salesforce 配置接口耗时影响，不作为已满足低延迟 SLA 的证据。
- 暖缓存完整 CREATE 4.511 秒、12 次 API 调用；3 个必填条件等待 `Source__c`，正确返回 UNKNOWN。两个 API 必填布尔字段经 Describe 证明保存时赋值，不再多问用户。
- 完整 UPDATE 7.680 秒、14 次 API 调用；10 个适用必填字段已有值，返回 READY，提交补丁为空；未调用保存接口。
- 真实多轮只读演示从 USER Picklist API 取一个有效值，仅作为 `SIMULATED_TEST_DRAFT`。首次完整 START 35.863 秒；同任务 REFINE 1.897 秒、6 次 API 调用，3 个未知条件降至 0：`Lead__c`、`Opportunity__c` 隐藏，`Account__c` 显示且必填。状态变为 NEEDS_INPUT，不冒充已经可以保存。首次临时探针因未接受 `{!Record.Source__c}` 原始语法失败，修正探针后通过，原失败证据保留。

这些结果证明真实配置读取、依赖重算和保守阻断行为。尚未进行同一用户/应用/记录类型下的原生 Lightning UI 逐字段对照、真实 Quick Action 创建/编辑保存、真实智能体端到端业务验收或生产部署。剩余验收继续沿用上面的固定矩阵，不能用 UNKNOWN、模拟接口或只读探针代替通过。

# OpenClaw 业务自主处理交付（2026-10-26～27）

## 基线与范围

- 实际拉取的 `origin/main`：`12df237f7ab03c4771109813b84f715a29e9e32d`。
- 工作分支：`codex/openclaw-business-autonomy`。未修改或合并暂停的 `feature/crm-openclaw-entry`。
- Canonical Playbook：`1.12.0`。四个 canonical 业务 Skill 位于 `skills/`；生成副本由命令生成。
- 工程验收包括源码、确定性测试、生成物以及测试服务器上的原生 OpenClaw mock DML 评测。可信企微请求身份的端到端验收另行标识，CLI 不冒充企微 requester。

## 规则审计

使用 `rg` 对 canonical Skill / references、Playbook definition / renderer、工具说明、生成模板、测试、开发副本与独立导出入口进行定向语义审查。下表归并同义限制，没有对所有 MUST 做全局替换。

| 位置 | 旧限制 | 决定 | 原因与最终语义 |
| --- | --- | --- | --- |
| record-change/SKILL.md 原第 35 条、managed-lookups.md | 用户未点名字段不得为补全而写入 | 删除 | 任务授权涵盖忠实提炼、规范化、可验证关联及相关 optional 字段，进入真实草稿与 payload |
| SKILL.md 第 3/5/6 条、UPDATE 表、CHANGE_READY、update-readiness / readiness-gate | Minimal Patch 等于只改用户说出的字段 | 改写 | 只提交完成本次任务实际变化的字段；尊重明确“只改总结” |
| create-readiness / create-initial-state 注释与 draftFields 工具说明 | Initial Facts 来源狭窄，USER_EXPLICIT 暗示用户逐字提供 | 改写 | 材料正文、可靠关联可入草稿；该枚举仅兼容草稿/可见性计算，不证明已读、已核验或逐字作者 |
| record-change 第 25 条、Playbook CREATE、renderer | required Owner fallback 必须先问一次并等待 | 改写 | 已配置且适用、无相反要求时省略字段交给 Runtime；指定负责人失败不能偷偷 fallback |
| create-readiness、definition / renderer | 多 Record Type 一律让用户选择、强制两轮对话 | 改写 | 用任务、标签/描述和适用默认选择，真歧义才问；保留先选类型再读类型字段的工具依赖 |
| record-change / lookup-and-picklist / Playbook UPDATE | 未逐项点名的 Lookup / Picklist / 责任人一律阻塞 | 改写 | 根据任务含义与验证事实处理，真实 ID、当前类型 API Value 与依赖仍必须适用 |
| definition CREATE、生成入口 | 只收用户给值；固定推荐 3–8 个 optional 字段 | 改写/删除 | 忠实提炼与相关补全；不为形式或低价值空白打断任务 |
| core / web-and-multimodal / mutation-boundaries / evidence-and-errors | 资料事实、合理推导自动视为未授权，只有 Runtime evidence 能提升可信度 | 改写 | 任务授权与事实来源分开；材料可支持任务写入，平台存储值/权限/结果由真实系统裁决 |
| dynamic-forms / readiness-gate / core evidence | 任意截断一律阻塞所有字段 | 改写 | 不把片段说成全集；只有影响本次必填、合法性、唯一性或依赖时补足相关证据 |
| org-diagnostics 及 references、DIAGNOSIS / DIAGNOSTICS | 公开技术分类、固定单一路线、固定先问时间/开 Trace | 改写 | 分类作内部参考，组合真实启用能力，复用适用日志与已知时间 |
| org-diagnostics / core / renderer / outcome-reconciliation | 系统诊断等于技术受众，强制 API/fullName/行号/内部 ID | 改写 | 默认真实业务标签；技术原值内部保留，明确技术请求时展开；业务单号/客户编码保留 |
| WORKFLOW_SECTION_MAP.DIAGNOSIS | 未接收 Lookup/Picklist 共享展示指导 | 补齐 | 诊断也需要 value→label 与业务名称，不自造标签或 SAP 代码含义 |
| record-change-gates / toolkit / Playbook 测试 | 测试固化逐字段授权、固定 fallback 提问 | 改写 | test oracle 表达任务范围和实际变化，不进入 Runtime，不作为新审批引擎 |
| DML、身份、批量与结果边界 | strict managed、CRUD/FLS/Sharing、默认拒绝、PARTIAL/UNKNOWN | 保留 | 系统契约有效；不重写整条记录、不将未给值当清空、不重放成功项、不用重复写试探未知结果 |

## 实际修改

**Skill 与 Playbook。** 共同原则放在 crm-core，record-change 增加材料与关联字段 reference：先读正文，再按主体、事实、诉求、异议、进展和行动组织到当前真实字段；允许专业化表达，但保留否定、条件、责任主体、计划与完成状态。地域区分公司、拜访、住所、收货角色。没有增加 Skill、通用规则引擎、数据库审批状态或 MCP 内置模型。

**MCP。** UI API / Describe 使用已有响应投影 `inlineHelpText`、`length`、`precision`、`scale`，缺失用 null，帮助文本每字段最多 2000 字符并报告截断；selection-only、Page Layout 和 Dynamic Forms 路径均保留。帮助文本是资料，不能改身份/权限。新增现有 action-context 的只读 `picklistValueOffsets` 续取：保持每字段 100 / 总计 500 候选等既有上限，显式保留 offset、依赖不完整与总数。它解决原先只有截断标记、无法取得后续候选的真实缺口，数据仍来自同次类型的 UI API；不是地名解析平台。文本字段用文本，Picklist 映射真实 API Value，Lookup 仍由授权查询取得真实 ID。

**标签。** 字段权限解释文本优先对象/字段/权限集真实标签，原始 API、grant、DIAGNOSTIC Describe 与 `executionIdentityView` 留在 structuredContent；对象标签复用已经读取的 Describe，没有新增逐字段请求，DIAGNOSTIC 布尔值不裁决目标 USER 权限。

**OpenClaw 消费。** get_agent_playbook 的 text 包含完整 structuredContent（包括 guidance）；Context / Data 成功 text 使用 SDK 风格的完整 JSON 镜像。测试机原生 `mcp-content-Dj8o6nFL.mjs` 已读取确认：投影 structuredContent 给模型，并仅删除与 `JSON.stringify(structuredContent, null, 2)` 完全相同的镜像。旧紧凑 JSON 会重复；本次使用该现有扩展点兼容文本客户端并避免原生重复，没有修改 OpenClaw Core。模型最终输入仍通过每次 Run 的原生 cache trace 检查，不以返回 JSON 替代。

**附件。** adapter 只挂载当前可信请求的附件引用，新增明确“元信息不证明正文或转写已读”的说明。文件上传无需强制解析；按材料创建必须取得实际解析/转写结果。通用 ASR / Office 解析没有搬入 Salesforce MCP。

## 确定性测试

修改前基线：Playbook `42/42`、Skill `71/71`；`yarn ai:snapshot` 记录了初始 clean main。

| 检查 | 当前结果 |
| --- | --- |
| Playbook test（含生成漂移） | PASS 42/42 |
| Context Provider build/test/lint | PASS 218/218；含 help/约束有值/缺失/截断、Dynamic Forms、续取和 text/structured 契约 |
| Data Provider build/test/lint | PASS 156/156 |
| Server build/test | PASS 392/392 |
| Server p3 / p4 / p5 / p7 | PASS 25 / 16 / 6 / 6；身份隔离、managed、拒绝、未知结果、MySQL 路由与 Audit 边界 |
| adapter tests | PASS 69/69；最新 runner/fixture 改动后复验结果在最终验收记录中更新 |
| Skill tests | PASS 75/75；最终生成与 Git delivery 复验后记录 |
| agent:sync / agent:check | PASS，5 个生成表面 |
| skill:sync / skill:check / skill:delivery / skill:export | 已执行；最终提交与 smoke 后记录 |

曾观察到两类环境问题，已保留原始失败日志：暂停分支留下的 8 个 orphan 编译测试文件（当前 main 无对应源码）已备份移出；中断期间的 Git 子进程/本机隧道失效不算源码或模型效果 PASS。之后的通过结果来自本次源码，不依赖那些旧编译测试。

## 真实 Agent 评测与前后样本

测试机：`crm-ex-test02`，OpenClaw `2026.9.5 (ec9c1a1)`；实际 main primary 为 `custom-192-168-155-105-3001/deepseek-flash`，fallback 为 qwen3-vl，thinking 为 max。实际进程 allowlist 包含四个业务 Skill。独立评测复用该模型/参数与工作区人格文件，只有 read 和同构 mock MCP，关闭真实 MCP / channel / plugin；每例独立状态，所有 CREATE/UPDATE 均经真实 generic DML Tool 到内存 SDK stub。

17 个固定样本涵盖材料、否定/多主体、厦门/杭州、迁址、地点角色、明确字段限制、同名/冲突/截断、API≠Label / Lookup / Record Type、Owner、业务/技术诊断。fixture 的 candidateFields/candidateReply 不进入 Agent 输入；人工审阅可接受多种忠实表达，问题次数来自真实转录。每例保存实际模型、runId、最终回复、工具参数、SDK dispatch 和最终模型上下文。参数断言与语义审阅分开。

已取得的基线真实结果（服务器本地 mock）：

- 厦门：旧版 run `499fddec-191e-4b2a-8e48-eaa9d5dc2942` 仅提交 `City=厦门`，回复国家/省份未填，可另行补充。
- Owner：旧版 run `51fcc5af-9884-4abc-9d2a-d2a4d326c707` 固定问“回复默认/当前用户，我就创建”，没有执行 CREATE。
- 材料：旧版 run `4f76452b-4bc7-4674-969e-176434b9c031` 已能忠实分配总结/诉求/计划；不能把此能力宣称为本次才首次实现。

本次新版结果、逐例语义复核和前后工具/问题次数将在当前服务器本地回合结束后写入本报告。之前使用跨机隧道的一批在本机中断后失去 mock 连接，保留为 FAILED_ENV，不纳入前后效果统计。

## 同步、运行验收与剩余边界

开发副本：`skill:sync` 生成 `.agents/.claude/.codebuddy`；Playbook 的 definition / renderer / version 同时维护，`agent:sync/check` 校验；独立 `sfoa` 包通过 `skill:export` 单独生成，四 Skill 的 runtime-sync 不负责这个包。maintainer Skill/脚本只留开发端，不向业务 Agent 发布。

运行发布按 `TEST_SERVER_DEPLOYMENT.md`：从提交归档 tracked LF 字节，核对包 hash，先备份目标源文件与 dist，再 rsync（不使用 --delete），保留服务器配置与 node_modules。按实际依赖构建 Playbook、Context、Data、Server；Admin Web 在 Playbook 后构建。四个业务 Skill 通过实际 workspace 的 `skill:runtime:sync/check` 更新，独立导出包与 adapter 使用已核实的插件路径；必要重启使用 systemd，不用会跳过非默认目录的 gateway restart。配置、凭据、身份策略与数据库模式不变。

运行验收分别记录：①文件同步；②gateway skills.status 进程可见；③新 Run 的 Skill 正文 read；④最终模型收到工具上下文；⑤实际 DML/业务回复。仅文件存在、CLI skills list 或风格相似不算第③～⑤层。可信 WeCom channel + requesterSenderId 仍是业务身份来源；CLI mock 没有 requester，不作为企微端到端。

PDF、Office、视觉与音频的部署可用性、实际解析正文是否进入当前轮次，以及测试发布的最终状态，将以本次服务器取证结果收口；缺少凭据、真实附件/转写入口或可信企微请求时标 NOT RUN/BLOCKED，不写为 PASS。生产发布不在本次授权范围。

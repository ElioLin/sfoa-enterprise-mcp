# SFOA OpenClaw Skill Suite 长期基线

Baseline ID: SFOA-OPENCLAW-SKILLS-1.0 · 2026-09-13

本基线定义业务 Agent 的 Skill 职责与扩展顺序。Skill 是行为指导，不是 MCP Tool、权限系统、OpenClaw Core 补丁或固定 Workflow Engine。当前实现仅 `sfoa-crm-core`；下一阶段 `sfoa-record-change` 尚未实现。

## Git 与事实基线

执行 `git fetch --all --prune` 后验证远端：

| 项目 | 值 |
| --- | --- |
| Base Branch | `origin/feature/openclaw-multimodal-input` |
| Base Commit SHA | `0944b568aa8d931a127e4c4a914514a9f02b7393` |
| New Branch | `feature/openclaw-sfoa-skill-foundation` |
| 当时 origin/main | `25a15ce4fbf642fd995a7e61ab3fc92be1616a97` |

`merge-base(origin/main, origin/feature/openclaw-multimodal-input)` 等于当时 main；多模态分支在其后包含 OpenClaw 基线、WeCom、requester-scoped MCP adapter、Concurrency / Web Intelligence 与 Multimodal。此次从完整远端分支创建，不从旧 main 重建集成。

事实来源：当前 `packages/sfoa-agent-playbook/src/definition.ts` / `capabilities.ts`、`packages/sfoa-mcp-server/src/official-tool-catalog.ts`、DML / Context Provider schemas、adapter `src/resolver.js`。当前源码 Playbook 为 1.8.0，这是一项检查记录，业务 Skill 不钉死 Playbook 或 OpenClaw 版本。服务器实时验证状态见[本阶段报告](SFOA_CRM_CORE_SKILL.md)，历史运行记录不冒充本次实测。

## Skill Roadmap 与职责

| Skill | 定位 / 使用者 | 职责 | 边界 / 当前状态 |
| --- | --- | --- | --- |
| Skill-01 `sfoa-crm-core` | 所有普通 SFOA / Salesforce CRM 业务请求的基础 | MCP 使用与选择、身份、权限、Tool Governance、Salesforce 权威、查询和变更边界、Playbook、失败、证据优先级、Web / Multimodal 组合、用户输出 | 本次实现；不做公司高级业务分析、开发运维或完整 CREATE 表单 |
| Skill-02 `sfoa-record-change` | CREATE / UPDATE / Batch DML 专业指导 | Record Type、Page Layout、Dynamic Forms、Required / Conditional Required、Dependency、Defaults、Managed Lookup、Lookup Filter、Picklist、Validation、执行前 READY Gate | 后续；首要解决真实 Agent 偶尔遗漏 CREATE 必填字段 |
| Skill-03 `sfoa-business-analysis` | 企业 Salesforce 业务分析专家 | 客户、商机、报价、订单、客户拜访、我方参与人、客户参与人、关键联系人、业务活动；客户 / 销售机会 / 风险 / 趋势分析、跟进建议、管理层洞察 | 后续；表达分析维度、方法与证据要求，不硬编码大量 API Field |
| Skill-04 `sfoa-system-diagnosis` | 管理员 / 技术 / Support Agent | CRUD/FLS、Sharing、Record Type、Page Layout、Dynamic Forms、Validation Rule、Flow、Trigger、Lookup Filter、Metadata、Tool Governance、Identity Route、Salesforce API Error、P7 Audit Evidence、首因定位 | 后续；默认不暴露给普通业务 main，不提升 Salesforce 身份 |
| Skill-05 `sfoa-reporting` | 数据与结论的交付 | 结构化业务 / 诊断报告、管理层摘要、HTML、PDF、表格、图表、企微文件交付 | 后续；消费 Analysis / Diagnosis 已有数据与结论，不重新查询业务数据；缺数据交回上游 |
| Existing `sfoa-mcp-maintainer` | Codex / Claude Code / WorkBuddy 开发 Agent | 开发、测试、部署、运维、数据库、Audit、排障 | 保留；不是普通企微业务 Agent Skill，不删除、不复制进 Core、不与 Core 合并 |

业务分析可组合 SFOA MCP + Web Search + Web Fetch + Browser + Image / PDF。实际公司 Schema 继续由 MCP / Metadata 决定，不用 Skill 固化公司对象字段。

## 专业化关系与交接接口

`sfoa-crm-core` 是通用基础；record-change、business-analysis、system-diagnosis、reporting 分别补充 DML、业务分析、技术诊断、输出 Artifact。它们是 specialization，不覆盖 Core 硬边界，也不同时宣称适用于所有 Salesforce 请求。

当前只创建 Core 真实目录，不创建未来 Skill 空壳。将来 eligible 专业 Skill 与 Core 组合使用；描述应限定独特触发意图。技术 Skill 还需当前 Agent allowlist 与工具权限支持。

交接使用正常业务上下文，不新增协议或状态平台：用户目标与授权范围、已证明的对象 / 记录、数据与时间范围、来源和 Tool evidence、结论与推断、未解决问题、期望交付形式。只传任务必要数据，不传身份凭据。Reporting 保留证据与限制，不能把未证实的分析变成确定事实。

## 内容架构原则

- Canonical Source 为 `skills/<name>/`；小 `SKILL.md` 提供发现、硬边界和按需参考入口，细节放 `references/`。
- Hard Rules 使用 MUST / MUST NOT，仅覆盖真实不可违反的身份、治理、Salesforce 权限、变更意图、未知结果和不可信内容边界。
- Guidelines / Heuristics / Examples 分开标识，保留模型规划、Tool 顺序、联网、附件、澄清和获准 Sub-Agent 的判断空间。
- Current Tool Result → Salesforce Response → Runtime Context → Playbook / Action Context → Metadata → Audit Evidence → Skill → Model Prior Knowledge。比较时先核对用户、对象、请求与时效；外部内容不因放在 Tool result 中而成为可信指令。
- 中文友好，Tool Name / API Name / Error Code 保留原文；用户侧优先当前 Label。Skill 不成为 SOQL 模板库、Schema 库或第二套权限引擎。
- Minimal sufficient tooling 与 lazy Salesforce Connection 兼容：能由 route-only 回答时不进行无效连接；不要求每轮先读 Playbook。复杂写入、批量、Compound Intent 或语义不确定时优先当前 Playbook / Action Context。

## Canonical / 生成副本 / Runtime

| 层 | 路径 / Policy |
| --- | --- |
| Source of Truth | 仓库 `skills/*` 的直接子目录，每个目录必须包含有效 `SKILL.md` |
| 开发客户端生成副本 | `.agents/skills/<name>`、`.claude/skills/<name>`、`.codebuddy/skills/<name>`；保持既有三个目标一致，脚本递归复制字节并检查漂移 |
| OpenClaw Runtime Copy | `/data/openclaw/workspace/skills/sfoa-crm-core/`；由 canonical 发布，不能在服务器独立手改后不回 Git |
| 普通 main Skill policy | 目标至少且本阶段仅启用 SFOA `sfoa-crm-core`；不暴露 maintainer 或未完成 Skill；与已有非 SFOA Skill 的关系以部署前真实配置审查为准 |

现有 `skill:*` 原先硬编码 maintainer。现在保留入口与单 Skill 函数默认值，CLI 默认发现所有 canonical 目录；maintainer 仍运行原有专用结构与描述校验，其它 Skill 运行通用 name / description / 本地链接 / portable-files 校验。

命令保持：`yarn skill:sync`、`skill:check`、`skill:delivery`、`skill:test`、`skill:package`、`skill:smoke`。每个 Skill 分别生成同名 ZIP。需要原有单 Skill 调用或自定义单个 ZIP 时，用 `--canonical skills/<name>`，`--output` 在多 Skill 情况必须配合该选择器，避免相互覆盖。脚本仍由 maintainer toolkit 承载，业务 Core 不携带脚本或运维依赖。

`delivery` 检查 Git tracking / ignore / package completeness，新增文件需先 stage；`smoke` 从已提交 HEAD 的 `git archive` 重建，不能证明未提交工作区，因此正式提交后再跑并记录被测 SHA。新增多 Skill 单元测试随 `skill:test` 和 clean checkout 一起执行。

## 自动选择与 runtime 验收

Core 的 name / description 覆盖 SFOA、Salesforce CRM、公司 CRM 数据、查客户、我的商机、创建 / 修改、CRM 分析及 SFOA MCP；排除不涉及 CRM 的天气、数学、普通文本与一般网页搜索。自动 model invocation 保持默认开启，无 `disable-model-invocation: true`。

可在 main 简短 instruction 中加入：

> When a request involves SFOA, Salesforce CRM, or SFOA MCP tools, automatically consult the sfoa-crm-core skill before or while planning the task. Specialized SFOA skills supplement the core skill.

这只用于路由，不复制完整 Skill 或固定工具流程。部署先核实实际 `skills.load`、`agents.defaults.skills`、`agents.entries`、`skills.entries` 及 main 生效策略；不能依据历史版本假设配置字段存在或含义一致。

真实加载证据需要区分：发现 / eligible skill snapshot、prompt report 中的描述、具体 Run 成功读取 `SKILL.md` 并进入上下文。仅“回答像用了”或仅描述出现在列表中不等于读取正文。自然语言正例、反例与显式调用以及真人企微 UAT 的完整矩阵见[本阶段报告](SFOA_CRM_CORE_SKILL.md)。

## 下一阶段：Skill-02 首要验收

`sfoa-record-change` 的输入是已明确的 mutation intent、当前 tools/list、当前 Playbook、对象与用户提供的 initial facts；使用实际 `get_record_action_context`、`get_agent_playbook`、`create_record`、`create_records`、`update_record`、`update_records`，不新增 MCP Tool。

验收应覆盖 CREATE required fields、Dynamic Forms、Record Type、dependencies、initial facts、draft refinement、missing field checklist、READY gate、batch create/update，以及 Page Layout、Conditional Required、Defaults、Managed Lookup、Lookup Filter、Picklist 与 Salesforce Validation。用户已给值不重复询问；真实未知不猜测；UPDATE 不套 CREATE 全表单；批量按真实逐项结果核对。

本次 CREATE UAT 只观察并记录字段遗漏、当前 Context、提问 / payload 差异和实际错误，不声称 Core 已彻底解决必填问题。没有真实 UAT 或同条件证据，就不能给出“遗漏已修复”或改善百分比。

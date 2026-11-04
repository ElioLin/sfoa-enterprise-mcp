# 材料工作流脱敏证据

本目录只包含逐项审阅后的白名单事实，不含凭据、认证记录、私有配置、原件引用值或真实客户正文。完整私有原始证据保留在 203 的任务 evidence 目录；本地原始日志在被 Git 忽略的 `.temp/agent-material-workflows/`。

| 文件 | 能证明什么 | 不能替代什么 |
| --- | --- | --- |
| `capabilities.json` | 同一已配置测试 requester 的实际工具/schema/策略/Playbook 和 runtime Skill hash | Salesforce 所有操作成功或完整业务权限 |
| `deployment.json` | 实际测试部署、失败预检、源/插件/Skill版本、备份、隔离负载及 committed smoke | 真实渠道/业务验收；本地失败聚合的干净 Full |
| `gateway-skill-read.json` | 新 Gateway run 实际只读 Skill，工具返回正文与运行文件 hash 相同 | 真人企微输入、写入或原件发布 |
| `materials.json` | 9 份真实合成原件入站、Office 读取、真实 ASR、独立视觉读取及失败 | 一条贯穿宿主/渠道/Agent/Salesforce 的完整链路 |
| `mixed-model.json` | 7 原件相关内容确实进入真实模型；3 轮、两独立事件、实际 Provider/合成 SDK 创建读回 | 重复稳定率、真实 Salesforce、企微或附件发布 |
| `deployment-1132.json` | 最新 94aa661 的 18 文件部署、备份、实际服务/插件/Skill 状态 | Salesforce 写入、生产发布或回滚演练 |
| `capabilities-1132.json` | 最新实际 29 工具、直接写入 schema、Playbook 1.13.2 与四份 Skill hash | 仅凭可见即认定业务成功 |
| `gateway-skill-read-1132.json` | 新 Gateway run 完整读回 1.13.2 Skill 与材料引用 | 真人渠道或端到端写入 |
| `model-comparison-1131.json` | 准确旧对照 15/18 → 17/18，保留样品来源事实错误 | 最终候选结果 |
| `candidate-model-1132.json` | 最终 18 任务的逐案语义、run/session、capture hash、48/48 选填及全部 29 查询错误 | 真实 Salesforce/企微、总体事实覆盖率或生产稳定性 |
| `final-comparison.json` | 冻结旧基线 18 次与新候选 18 次在同一旧 Provider 的比较 | 同时重跑基线、新后端整体对比 |
| `boundary-probes.json` | 六个补充边界各一次的自然输入/真实模型结果 | 每项三次稳定性、真实 Context/Salesforce 全链路 |
| `acceptance-matrix.md` / `.json` | 28 个最低场景对应具体测试、模型/材料/渠道层次和缺口 | 将未执行项拼成 Full 验收 |
| `clean-skill-smoke.json` | 最终实现/Skill 提交 7fdbaf3 的独立 Linux committed smoke，六门禁、80 测试通过 | 全包构建或真实业务验收；后续仅报告/证据提交未假装重跑 |

`PASS` 必须连同文件中的 scope 阅读。原始尝试、夹具限制、失败和未知结果保留；后续通过不回写旧结果。前五份文件及 1.13.1 对照是历史证据，不能重标为 1.13.2 执行；最新版本证据单独列名。

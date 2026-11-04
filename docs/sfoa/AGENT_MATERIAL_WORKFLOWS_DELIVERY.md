# 业务理解与材料工作流交付记录

状态：开发与验证进行中。确定性通过不等于真实材料、渠道或 Salesforce 业务验收。

## 基线与授权范围

- 2026-11-04 刷新 origin 成功；本地原工作区无未提交改动。
- 起点：`origin/feature/p0-agent-field-inference`，`61f8a0c11f7acb9d56f95762014335fd0c2aab05`；相对 origin/main ahead 1 / behind 0。
- 新分支：`feature/agent-material-workflows`。采用默认从原 feature 新鲜 tip 开发路径，未合并旧分支；新开发保持待评审，不发布生产。
- 用户授权四批连续实现、测试、独立提交和 192.168.156.203 测试部署。材料正文与上传授权分别处理；不新增 DML 前置 token 或统一批准状态。
- 读取任务书、AGENTS、maintainer / mcp-builder Skill、基线/架构/工程/上游策略及各改动包文档。

## 批次及提交

| 批次 | 范围 | 当前状态 | 提交 |
| --- | --- | --- | --- |
| 1 | 宿主真实读取、覆盖、任务材料连续性 | 实现冻结，Adapter 90/90 PASS | `1762f87` |
| 2 | 业务理解、字段映射、适用查重、指导分发 | Playbook 46/46、Skill 80/80 PASS | `76ab86e` |
| 2 可选增强 | CREATE includeValueAssessment，默认关闭，纯事实计算 | Context 237/237、Host 5/5 PASS | `d02e603` |
| 3 | 附件状态、明确失败恢复、并发与未知结果保护 | Control Plane 38/38、附件/HTTP 61/61、MySQL 18/18 PASS | 本提交 |
| 4 | 客户端分发、部署、真实模型/材料/渠道与回归 | 环境基线已读取 | 待提交 |

## 已取得证据

- 批次 1：DOCX/XLSX/CSV 真实本地文件读取、覆盖状态、材料累积、请求者/会话隔离和任务恢复；完整 Adapter 回归 90/90 PASS（`.temp/agent-material-workflows/adapter-batch1-final.log`）。图片/PDF/音频的宿主原生读取在没有执行证据时保持 UNKNOWN，不把暂存成功当成读取成功。
- 批次 2：Playbook 1.13.0 收敛材料任务、选填字段、国家/区号语境、API 必填、适用查重、最小 UPDATE 及可选归档指导。Playbook 46/46、Skill toolkit 80/80 PASS；canonical Skill sync/check/validate PASS，生成副本无漂移。日志分别为 `batch2-playbook-final.log`、`skill-test-final.log`、`skill-check-final.log`、`skill-validate-final.log`（`.temp/agent-material-workflows/`）。
- 可选 Context 增强：省略 `includeValueAssessment` 时保持输出与 Salesforce 调用数；CREATE 显式启用才增加已知值/默认值/必填事实，不形成写入门槛。Context 237/237、managed host 5/5 PASS；独立源码审阅未发现须修复项。保留 null/false/0/空值与不存在的区别，不把原始 defaults 的 UNKNOWN 猜成已满足。
- 批次 3：原子 claim、明确拒绝后受控恢复、UNKNOWN 不重放、超时停止后续文件、已成功结果保留、响应体断流和过期原件清理。最终串行 Control Plane 38/38、附件/企微 HTTP 61/61、真实 MySQL 18/18 PASS（`.temp/attachment-lifecycle/server-frozen.log`、`mysql-frozen.log`）。先前并行运行的时间争用失败日志保留，未算入通过数。迁移 017 采用追加状态/索引；回滚保留 schema 与 UNKNOWN 元数据，旧 runtime 不清理新增状态，须保留新版清理逻辑或按原 TTL 清理原件。

- 本地 `yarn ai:snapshot`、`yarn ai:doctor`：PASS；Node 24.13.0 / Yarn 1.22.22 / MySQL 8.0.30。业务服务本地未启动。
- 真实数据库 ledger 已存在 `016_crm_openclaw_chat`，本分支未包含该迁移；保留既有表与迁移，新增迁移避开编号，不重置共享库。
- 基线 Adapter 完整测试：71/71 PASS，日志 `.temp/agent-material-workflows/baseline-adapter.log`。其中旧 oracle 固定了文本清空/文件替换行为，新测试将更正并证明累计。
- 203 SSH 连接成功：`crm-ex-test02`；MCP/Admin/Gateway/nginx 均 active，Node 22.23.1 / Yarn 1.22.22 / OpenClaw 2026.9.5。
- 实际 OpenClaw 配置文件 `/data/openclaw/state/openclaw.json`；Gateway PID 2996434。主模型配置为 deepseek-flash，fallback qwen3-vl；这仅是配置事实，实际响应模型待 run 证据。
- `/usr/bin/pdftotext`、`/usr/bin/python3`、`/opt/asr/bin/sensevoice-transcribe` 存在；不据此声称实际文件读取或渠道通过。

## 仍须完成的验收

真实 tools/list/用户策略基线、实际插件加载位置及版本、逐批相关测试与提交、可选增强关闭兼容性、独立评审、备份和已提交 SHA 部署、runtime Skill hash、六条核心旅程各三次真实模型、原始文件读取、企微原生语音与文件音频分别验证、Salesforce 字段/关系/逐文件读回、脱敏证据和回滚命令。

任何受外部条件阻塞的项目将逐项记录为 PARTIAL / NOT TESTED / BLOCKED，不替换成服务健康或脚本退出码通过。

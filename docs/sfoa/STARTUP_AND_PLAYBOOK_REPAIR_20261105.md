# 本地启动与 203 Playbook 分发核对（2026-11-05）

接续 `feature/agent-material-workflows` / `b9b6a523544b080b4df751402cd5c07de1641bff`。本次处理本地启动失败和测试管理页面版本落后，不扩大既有 Salesforce 业务验收结论。

## 本地启动

本地实际连接 `127.0.0.1:3306/sfoa_enterprise_mcp`，不是 203 使用的数据库。启动报错中的迁移 017 **确实没有应用**，不是校验和漂移。此外，原库有 `016_crm_openclaw_chat`，当前材料工作流分支没有这份迁移；`db:status` 明确拒绝未知版本。因此仅执行 `db:migrate` 不是完整修复。

`ai:doctor` 当时显示数据库连接及核心表 PASS，并列出了迁移；这不代表当前分支全部迁移通过。没有删除原库迁移记录，也没有放宽启动检查或带入暂停的 CRM Chat 功能。

用户选择独立开发库后，在同一台本地 MySQL 建立 `sfoa_agent_material_workflows`，由现有 migration runner 应用当前分支全部 16 份迁移（001–015，加 017），随后复制并逐行核对配置：

| 配置表 | 行数 | 结果 |
| --- | ---: | --- |
| identity_route | 6 | 一致 |
| identity_credential | 6 | 一致；密文未展示或提交 |
| tool_control | 30 | 一致 |
| dml_policy | 4 | 一致 |
| dml_managed_field_rule | 4 | 一致 |
| diagnostic_config | 1 | 一致 |
| runtime_setting | 4 | 一致 |
| ui_snapshot | 1 | 一致 |

原库及历史 Audit 全部保留；新库没有复制旧 Audit、CRM Chat 表或原件引用。仅切换忽略文件 `.env.local` 的 `SFOA_DB_NAME`。原配置备份位于 `.temp/startup-version-20261105/env.local.before`，不入 Git。

准备过程有两次事务回滚：直接 `INSERT SELECT *` 遇到计算列；随后错误排除了带默认时间的普通列，逐行比对拒绝该副本。改为仅排除真正的 `GENERATION_EXPRESSION` 列后复制和比对通过，原库始终未写入。失败记录保留，不计为成功迁移验证。

`db:status`、启动检查通过；实际 `yarn dev:sfoa` 到达 ready，MCP health/ready、Admin ready、前端入口均 HTTP 200。真实 Chromium 登录本地管理页面后，Playbook 正文、Dify 和 WeCom 生成文本均为 1.13.2，无页面脚本错误或请求失败，退出登录 200。验证进程已由本轮自己的 SIGINT 停止，用户可重新执行 `yarn dev:sfoa`。

## 203 的版本差异

首次核对明确发现管理前端仍是 2026-10-29 的构建：域名和回环地址都提供 `index-DEVRE_9D.js` / `AgentIntegrationPage-CI34N_E8.js`，页面打包的 Playbook 为 **1.12.0**。这是上一轮遗漏 Admin Web 重建，不能归因于用户浏览器缓存。

其余运行层的本轮只读证据：

- Playbook 源码和 dist 均为 **1.13.2**；新的 MCP initialize 实际返回 1.13.2，tools/list 返回 29。该检查使用合法无身份企微 discovery，不冒充用户，也未查询/修改 Salesforce。
- `sfoa-crm-core` 10、`sfoa-record-change` 13、`sfoa-data-analysis` 8、`sfoa-org-diagnostics` 7，共 **38 文件**，服务器 app 和实际 `/data/openclaw/workspace/skills` 与基线 Git blob 的 LF 字节逐一一致。四个 Skill 的 Gateway 状态均 eligible/modelVisible=true。
- maintainer 没有发布给业务 Agent。独立 `sfoa` 重新生成的 1.13.2 正文与运行副本逐字节一致，既有 `mcp.json` 未改。工具清单或 discovery 不替代模型实际读取证据，既有真人材料验收仍见此前报告。
- Adapter 仍加载 `/data/openclaw/plugins/sfoa-wecom-mcp-adapter` 的 `9c4fda9`；MCP / Admin / Gateway PID 分别为 3046218 / 3046787 / 3759907。

Admin Web 将 Playbook 静态打包进浏览器资产。更新服务端 dist、同步 Skill、重启 MCP 均不会重建它。已修正 Admin 的旧版本/旧指引测试断言，补充维护文档的独立前端发布检查。

## 验证和发布记录

发布备份：`/data/sfoa-enterprise-mcp/backup/admin-playbook-1132-20261105T033105Z`，含旧 dist、被更新的三份测试、README 和回滚脚本。候选目录：`/data/sfoa-enterprise-mcp/staging-admin-playbook-1132-20261105T033105Z`。保留现有 hashed assets，先发布新 assets，再原子替换 `index.html`，检查权限与 SELinux；不重启 Gateway。

本地专题 15/15、维护 Skill 80/80 通过；sync/check/delivery 通过。首次专题 14/15、首次 Linux Admin 全量 94/95 的旧文案/旧版本断言失败保留。系统 Edge 的独立无界面测试启动失败；随后项目现有 Chromium 的本地真实页面验证通过，不能把 Edge 失败写成通过。

最终 Linux Admin 全量 **95/95**、TypeScript 检查和 Vite 构建通过。构建仅有现存大 chunk 提示。发布曾因脚本 PATH 缺少 `restorecon` 停在替换入口之前；保留失败后补全路径、完成 SELinux 标注和入口发布，没有重新运行已通过的测试来掩盖发布错误。

域名和回环地址现在均提供 `index-3O0UrNe6.js` / `AgentIntegrationPage-C9ZxVunh.js`，只含当前 Playbook 1.13.2。11:40 起的实际 Chromium 登录验证确认页面标题、完整 Playbook 正文、Dify 指令及 WeCom 角色文本均为 **1.13.2**；零脚本错误、零请求失败，Admin health/ready 200，退出登录 200。这是真实服务登录验证，不是 mock 页面。MCP/Admin/Gateway/nginx PID 均未改变，配置/凭据文件校验一致。

脱敏机器证据：[startup-version-20261105.json](evidence/startup-version-20261105.json)。本轮仅修正上述三份 Admin 测试与文档，前端由既有当前业务源码和 1.13.2 Playbook 重建；没有修改 MCP Tool、业务 Skill 内容或 Salesforce 记录。

本地证据根 `.temp/startup-version-20261105`；服务器证据根 `/data/sfoa-enterprise-mcp/evidence/startup-version-20261105`。受保护的配置备份和会话信息不进入公开证据。

## 回滚

本地：停止当前开发服务，将 `.env.local` 的 `SFOA_DB_NAME` 改回 `sfoa_enterprise_mcp`，并切回支持其 016 迁移的原分支；材料分支直接使用该原库仍会被正确拒绝。保留新库，不删表或改 ledger。备份可用于比较恢复配置，避免覆盖用户之后新增的配置。

203：执行上述备份目录的 `rollback.sh`，恢复旧入口、资源和对应测试/README，重新标注 SELinux 并检查 HTTP。旧版会重新显示 1.12.0；无需重启 MCP/Admin/Gateway。回滚未演练，不回退 MySQL，不触碰 Salesforce，不重放上传或写入。

此修复不改变此前材料工作流总体 **PARTIAL**：Gateway 重启持久化、原生材料覆盖回写、接受归档选择真实复测、原生语音及完整批量/复合验收仍按原记录保留。

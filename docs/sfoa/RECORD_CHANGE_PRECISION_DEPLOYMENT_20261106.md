# 精确创建/编辑表单：203 测试部署记录

2026-11-06，按用户授权发布 `codex/record-change-precision`，推送远端，**不合并**。应用源码为 `94f1833fc7690a232f39111bbbb09155e5b2ed2f`，Playbook **1.14.0**。后续提交只补充本部署记录、脱敏证据及维护指导，不改变运行时代码或业务 Skill。

## 发布内容

| 项目 | 实际结果 |
| --- | --- |
| 目标 | `crm-ex-test02` / `192.168.156.203`；应用 `/data/sfoa-enterprise-mcp/app` |
| 来源 | 已提交 Git LF 归档 `sfoa-app-94f1833.tar.gz`，4,407,572 B，SHA256 `2054045cfbac06297b88ca779ee45ce092b5df5f422f36a2a175445809ddc900` |
| 字节验证 | staging 和发布后的 app 共 **1496** 个 tracked 文件与 Git blob 一致；发布前没有未识别的源码漂移 |
| 构建 | 服务器重建 Playbook、Context、DML、MCP Server、Admin API；Admin Web 在暂存目录构建，再先发布 hashed assets、最后替换 `index.html` |
| 依赖 / 数据库 | 与服务器依赖、迁移文件一致；没有安装依赖、执行迁移或修改治理配置；`db:status` 通过，017 已应用 |
| MCP | PID **3848940**；initialize 为 **1.14.0**，工具仍 **29** 个；五个相关工具有可选 `formContext`，其他工具输入 Schema 与发布前一致 |
| Admin API | 最终 PID **3849530**；health/ready 正常。第二次重启用于下述管理会话密钥轮换 |
| Admin Web | `index-CTp8faou.js` / `AgentIntegrationPage-CK_3b5F2.js`，实际提供 **1.14.0**；静态资源权限及 SELinux 标签已恢复 |
| OpenClaw | 实际 workspace `/data/openclaw/workspace`；Gateway PID **3759907**，本次未重启；插件路径 `/data/openclaw/plugins/sfoa-wecom-mcp-adapter`，本次未修改 Adapter |
| 运行 Skills | 四业务 Skill **39** 文件逐字节一致：core 10、record-change 14、data-analysis 8、org-diagnostics 7；main 中四个均 `eligible/modelVisible=true` |
| 独立导出 | 单独重新生成 `sfoa/SKILL.md` 为 **1.14.0**；既有 `sfoa/mcp.json` 保持一致；其原有 `modelVisible=false` 未变 |
| Nginx | PID **1267856**，未重启；服务器 loopback 与测试域名的页面、资源、ready 返回 200 |

旧「CREATE 页面上下文」模块及对象策略保留。它仍服务未传 `formContext` 的旧 CREATE 路径；新业务 Skill 使用精确表单契约，不以旧快照作为新解析的配置来源。此次发布没有刷新或重设既有对象快照/策略。

## 验证证据

- Linux 精确表单专项：**101/101 PASS**；Linux Skills：**88/88 PASS**；`skill:check`、`skill:delivery`、`agent:check` 与数据库版本检查通过。开发阶段的更大范围测试及真实只读 Provider 结果见[实现报告](RECORD_CHANGE_PRECISION_20261106.md)，不混作本轮服务器测试数量。
- 发布前后实际 MCP 发现结果：同样 29 个工具；变化限定为 `get_record_action_context`、`create_record`、`update_record`、`create_records`、`update_records` 的表单输入；根层 `formContext` 非必填，批量通过逐条结构携带。无其他工具输入契约漂移。
- 实际 Gateway 新会话 `e1bea8eb-0ab5-4464-9aa2-958df347d2ac` 只调用 `read`，完整读取 `sfoa-record-change/SKILL.md` **25047 B** 和 `references/precise-forms.md` **7778 B**，正文与运行文件一致；模型回答版本 1.14.0，并说明不能去掉 `formContext` 绕过关键 UNKNOWN。没有发送渠道消息或调用 Salesforce 业务工具。
- 浏览器实际登录测试环境，确认 Canonical Playbook、Dify/WeCom 生成文本为 1.14.0，并检查审计与旧页面上下文入口。浏览器验证使用 SSH 转发的服务器 HTTP 服务；本机直接访问测试域名 9000 端口超时，因此不把该验证当作直连网络可用的证明。
- 脱敏汇总：[部署证据](evidence/record-change-precision-deployment-20261106.json)。服务器原始探针、构建/测试日志位于 `/data/sfoa-enterprise-mcp/evidence/precision-deploy-20261106`，私密登录/会话结果不进入 Git。

首次 Gateway 读取检查错误地假设 sessionId 对应磁盘 JSONL 文件；当前运行版本的 `agentMeta.sessionFile` 返回逻辑会话键。之后使用该新会话的实时 `chat.history` RPC，核对了两次实际读取及完整返回。早期路径检查失败保留，不能拿模型口头声明替代读取证据。

## 发布中断与管理会话处理

静态发布首次在 `restorecon` 处因 PATH 未含 `/usr/sbin` 中断，此时新 MCP 已健康，旧 Web 入口仍在。补齐 PATH 后从静态发布步骤继续，没有重复重启 MCP。

浏览器探针的未捕获网络异常包含临时 Admin Cookie。已立即只轮换 **`SFOA_ADMIN_SESSION_SECRET`** 并重启 Admin API，验证旧签名会话被拒绝（401），新登录和验证会话退出均为 200。其他环境变量逐值比较不变；OpenClaw 配置和独立 `mcp.json` 不变。**原有后台会话需重新登录。** 后续浏览器脚本仅记录错误类型/代码，不输出原始请求异常或 Cookie。

## 备份与回滚

备份目录：`/data/sfoa-enterprise-mcp/backup/precision-20261106T122626Z-94f1833`。包含旧源码、六个组件的 dist、五份运行 Skill、受保护的配置备份、原状态及 `rollback.sh`。源码归档与暂存目录保留，临时端口转发在验收结束后关闭。

回滚脚本恢复旧源码/dist/Skills，恢复 Web 标签并重启 MCP/Admin；**未实际演练**。没有数据库结构变更，不回滚数据库，不重放 Salesforce 操作。回滚必须保留已经轮换的管理会话密钥，**不得把备份中的旧 `.env.local` 或 `session-rotation-before.private` 恢复为运行配置**。现有回滚脚本不恢复这些配置。若后续版本已继续发布，应先核对版本和变更，不能直接覆盖。

本次没有 Salesforce CREATE/UPDATE/上传写入、真实原生 Quick Action 保存、逐字段原生 Lightning UI 对照或真人企微端到端业务 UAT，也没有生产发布。服务发布、协议与 Skill 加载验证不替代这些验收。

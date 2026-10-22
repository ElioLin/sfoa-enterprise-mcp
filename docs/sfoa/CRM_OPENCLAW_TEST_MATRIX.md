# CRM OpenClaw 一期测试矩阵

日期：2026-10-22
证据分层：`UNIT` / `MOCK` / `REAL_OPENCLAW` / `REAL_SALESFORCE` / `REAL_BROWSER` / `HUMAN_UAT`

状态口径：PASS 只代表所列层级通过；`PARTIAL` 表示部分层级通过；`NOT_VERIFIED` 表示没有取得该层证据。

| Gate | 要求 | 结果 | 证据 |
| --- | --- | --- | --- |
| G01 | 两仓库基线、分支规则、原有改动保留 | **PASS** | MCP 从 `origin/main@12df237` 建分支；CRM 保持 `uat@a55870a` 且本次只新增文件；CRM 既有 staged/untracked 未触碰 |
| G02 | 身份签发/验签、过期、重放、组织/接收方 | **PARTIAL** | UNIT/MOCK：接入服务 10 项 Apex token 测试、4 项聊天凭证测试全过；Apex 真实签名/测试 **NOT_VERIFIED**（未部署） |
| G03 | 文字、浏览器字段、工具参数不能改变执行用户 | **PASS（mock + REAL_OPENCLAW transport）** | CRM 插件 26 项、MCP HTTP 2 项、MCP 身份 12 项；隔离 Gateway turn 中 mock MCP 收到 `X-SFOA-CRM-User-Id=crm-e2e-user`，无 WeCom/Internal 头；真实 Salesforce 执行 **NOT_VERIFIED** |
| G04 | 两真实用户 OpenClaw→MCP→Salesforce 与权限差异 | **NOT_VERIFIED** | 未有真实 Salesforce 连接；隔离 Gateway 只到 mock MCP |
| G05 | 历史/流式/运行详情/停止/文件逐项拒绝跨用户 | **PASS（mock 层）** | `server.test.ts` 跨用户 conversation/history 404、run ownership；文件接口本期未开放 |
| G06 | 同用户多对话独立；刷新/服务重启恢复 | **PARTIAL** | UNIT/MOCK + REAL MySQL + REAL_OPENCLAW：两对话得到不同官方 sessionKey，历史从 OpenClaw 读取；真实服务重启恢复 **NOT_VERIFIED** |
| G07 | 断线、重复提交、并发、停止、未知结果 | **PASS（mock 层）** | 重复 `clientMessageId` 409 且不重派；忙 409；停止仅目标 run；超时/中断标记 UNKNOWN 不重试；真实断线 **NOT_VERIFIED** |
| G08 | CRM Agent 记忆/工作区/跨会话/子代理无已知旁路 | **PARTIAL** | 隔离 Gateway 用 `profile:minimal + bundle-mcp` 加载插件；未开放文件/记忆/子代理入口；完整工作区策略未审计 |
| G09 | 真实 SFoA 页面完成登录/发送/流式/历史/停止 | **NOT_VERIFIED** | LWC 仅静态语法检查；未部署、未在 Lightning 运行 |
| G10 | 既有企微、其他客户端、Tool/DML、stdio/HTTP、审计兼容 | **PARTIAL** | 企微/CRM 适配器 68 项、MCP 身份 23 项、CRM HTTP 2 项通过；完整 root/stdio/Inspector 回归未在本次全部重跑 |
| G11 | 构建、类型检查、必要测试、生成物一致 | **PARTIAL** | control-plane/identity-runtime/mcp-server/gateway 编译通过；MCP 全量 406/406、control-plane 38/38、gateway 24/24、插件 26/26、适配器 68/68；CRM Apex/LWC 未编译 |
| G12 | 部署、回退、CRM 变更清单与证据 | **PARTIAL** | 计划/报告/矩阵/changeset/deployment/manifest/destructive/证据齐备；沙盒未部署，无 Deployment ID |

## 实际执行的测试计数

| 层 | 命令 | 结果 |
| --- | --- | --- |
| MCP 全量 | `yarn workspace @sfoa/mcp-server test` | 406/406 PASS |
| control-plane | `yarn workspace @sfoa/control-plane test` | 38/38 PASS |
| MCP CRM 身份/配置 | `node --test packages/sfoa-mcp-server/dist/test/crm-channel.test.js` | 12/12 PASS |
| MCP HTTP | `node --test packages/sfoa-mcp-server/dist/test/crm-http-integration.test.js` | 2/2 PASS |
| MCP 既有身份 | `node --test packages/sfoa-mcp-server/dist/test/identity-provider.test.js` | 23/23 PASS |
| 接入服务 | `node --test dist/test/*.test.js`（gateway） | 23/23 PASS |
| 接入服务 MySQL | `node --test dist/mysql-test/*.test.js` | 1/1 PASS（合并运行 24/24） |
| OpenClaw 插件 | `node --test`（sfoa-crm-channel） | 26/26 PASS |
| OpenClaw 适配器 | `node --test`（sfoa-wecom-mcp-adapter） | 68/68 PASS |
| REAL_OPENCLAW 隔离 Gate | 独立 Gateway `:18790` + mock MCP `:18080` | PASS：插件注册、turn、session route、`sessions.get` 历史、`X-SFOA-CRM-User-Id` 到达 mock MCP |

## 未验证项与阻塞

1. **CRM Apex 未编译/未运行**：本地无 Apex 编译器，沙盒部署未获明确授权。需要在沙盒执行 `deploy validate` + `SfoaCrmChatIdentityTest`。
2. **真实证书签名未验证**：Apex 使用 `Crypto.signWithCertificate`；需要沙盒证书记录。接入服务侧验签已用自生成 RSA 密钥对覆盖。
3. **REAL_OPENCLAW 已部分验证**：隔离 Gateway 2026.9.5 已加载插件、完成真实模型 turn、官方 session route 与 `sessions.get` 历史；MCP 为 mock（只验证 header 注入），真实 Salesforce 不在该链路中。详见 [real-openclaw-gate.md](evidence/crm-openclaw/real-openclaw-gate.md)。
4. **REAL_SALESFORCE 未验证**：未对沙盒做 Apex 测试或真实 MCP 调用；未创建 CRM 绑定。
5. **REAL_BROWSER/UAT 未验证**：LWC/Aura 未部署；CSP/CORS/HTTPS 未实测。
6. **完整既有回归未全量重跑**：本次执行了受影响包的定向测试；root 全量/stdio/Inspector 未全部重跑。

## 基线/回归区分

- 固定基线失败：本次定向测试未复现新的既有失败。
- 历史报告提及、当前未复现：无新增声明。
- 本次新增回归：已执行范围内为 0；Apex/LWC 编译结果未知，不能声明 0。
- 环境阻塞：沙盒部署授权、Apex 编译/测试、隔离 OpenClaw 实例、浏览器 UAT。

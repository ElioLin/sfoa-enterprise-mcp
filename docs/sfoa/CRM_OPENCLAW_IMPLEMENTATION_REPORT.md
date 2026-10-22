# CRM OpenClaw 一期实现报告

日期：2026-10-22
分支：`feature/crm-openclaw-entry`（首个提交 `561bda4`，已推送 `origin`）
状态：**IMPLEMENTED_PENDING_ENVIRONMENT_VERIFICATION**

## 1. 目标与边界

新增 Salesforce 内聊天入口，复用现有 OpenClaw 和 SFOA MCP：

```text
Salesforce LWC（Utility Bar）
  -> Apex 当前用户身份签发
  -> CRM 聊天接入服务（本仓库新包）
  -> OpenClaw 可信 CRM 渠道插件（本仓库新增）
  -> OpenClaw 官方 agent run
  -> 现有 MCP（新增独立 CRM 渠道凭据/身份头）
  -> Salesforce（按真实用户权限执行）
```

本期只做文本聊天；不新增附件、语音、多模态、共享会话、Salesforce Action/Apex 自动生成，不修改 OpenClaw Core、企微官方插件或既有业务 Apex/Trigger/Flow。

## 2. 组件与文件

### 2.1 MCP 控制面

| 文件 | 作用 |
| --- | --- |
| `packages/sfoa-control-plane/migrations/016_crm_openclaw_chat.sql` | 审计枚举加 `CRM_HEADER`；5 张 CRM 表 |
| `packages/sfoa-control-plane/src/schema.ts` | Kysely 表类型 |
| `packages/sfoa-control-plane/src/migrations.ts` | schema 校验加入新表/索引 |
| `packages/sfoa-control-plane/src/crm-chat-repository.ts` | 绑定/一次性 nonce/聊天会话/对话/运行仓储 |
| `packages/sfoa-control-plane/src/contracts.ts` | `IDENTITY_SOURCES` 加 `CRM_HEADER` |

### 2.2 MCP 运行时

| 文件 | 作用 |
| --- | --- |
| `packages/sfoa-mcp-server/src/authenticator.ts` | `CrmChannelCredentialAuthenticator`、渠道绑定头校验、`CRM_HEADER` |
| `packages/sfoa-mcp-server/src/config.ts` | `MCP_CRM_CHANNEL_ENABLED`、`MCP_CRM_CLIENT_TOKEN`、CRM 头 alias 校验 |
| `packages/sfoa-mcp-server/src/runtime.ts` / `http-server.ts` | 凭据/身份源接线 |
| `packages/sfoa-mcp-server/src/main.ts` | 启动失败日志脱敏列表 |
| `packages/sfoa-identity-runtime/src/*` | 身份来源联合类型加 `CRM_HEADER` |

### 2.3 CRM 接入服务

新包 `packages/sfoa-crm-gateway/`：

| 文件 | 作用 |
| --- | --- |
| `src/config.ts` | 环境配置与 fail-fast 校验 |
| `src/apex-token.ts` | 钉住公钥/证书指纹的 RSA-SHA256 验签 |
| `src/chat-auth.ts` | 不透明聊天 token（SHA-256 存储）、限流 |
| `src/openclaw-client.ts` | 凭证化 HTTP 客户端 + 严格 SSE 解析 |
| `src/run-stream.ts` | 有界运行事件缓冲/重连 |
| `src/server.ts` | CORS、路由、归属、SSE、停止、运行生命周期 |
| `src/main.ts` | 启动/健康/清理/优雅关闭 |
| `src/cli/bind.ts` | 管理员显式身份绑定 |

### 2.4 OpenClaw

| 文件 | 作用 |
| --- | --- |
| `integrations/openclaw/sfoa-crm-channel/` | 新插件：CRM channel、凭证化 ingress、流式/停止/历史 |
| `integrations/openclaw/sfoa-wecom-mcp-adapter/` | 扩展 resolver：`sfoa-crm` + `X-SFOA-CRM-User-Id`；企微路径不变 |

### 2.5 CRM 工程（详见 changeset）

新增 Apex、Custom Setting、LWC、Aura wrapper、Permission Set 与精确 manifest；未修改既有业务组件。

## 3. 身份契约

### 3.1 Apex 引导 token

```
v1.<base64url(payload JSON)>.<base64url(RSA-SHA256 signature)>
```

签名输入是 `v1.<encodedPayload>` 的 UTF-8 字节。Payload：

| 字段 | 来源/规则 |
| --- | --- |
| `iss` | Custom Setting `Issuer__c`（默认 `sfoa-crm-apex`） |
| `aud` | Custom Setting `Audience__c`（默认 `sfoa-crm-gateway`） |
| `orgId` | `UserInfo.getOrganizationId()` |
| `userId` | `UserInfo.getUserId()` |
| `username` | `UserInfo.getUserName()` |
| `displayName` | `UserInfo.getName()`（空则 username） |
| `iat` / `exp` | 当前秒 / +TTL（30–120s，默认 90s） |
| `jti` | 随机 UUID v4 形态 |

Apex 使用 `Crypto.signWithCertificate('RSA-SHA256', input, certificateName)`；私钥由 Salesforce Certificate and Key Management 持有。浏览器不能传入用户/组织。

### 3.2 接入服务验签

- 只信任部署时钉住的公钥（证书 PEM 或裸公钥）；可选证书 DER SHA-256 指纹。
- 固定 issuer/audience/允许的 OrgId 列表；验证签名、`iat/exp`、最大 TTL、最大 age、30s 时钟偏差。
- 不接受 token 中的 URL/动态公钥、不降级算法。
- `jti` 写入 `sfoa_crm_bootstrap_nonce` 主键；重复兑换返回 409，服务重启不复用。

### 3.3 绑定与路由

```
(orgId, userId) --sfoa_crm_identity_binding--> platformUserId
platformUserId --sfoa_identity_route--> salesforceUsername
```

- 绑定必须显式创建；缺失/禁用 → 403，默认拒绝。
- 绑定前核对 route 已启用，且 route 的 `salesforce_username` 与 Apex token 的 `username` 逐字一致（忽略大小写）。
- 不使用昵称、模糊用户名或第一个匹配结果。
- 管理命令：`yarn workspace @sfoa/crm-gateway crm:bind ...`。

### 3.4 浏览器聊天凭证

- 32 字节随机不透明 token；浏览器内存持有。
- MySQL `sfoa_crm_chat_session` 只存 SHA-256、主体、过期时间、撤销时间。
- 默认 15 分钟；刷新页面必须重新走 Apex 签发 + 兑换。
- **Salesforce 退出登录不会即时撤销**；最大有效窗口是 `expiresAt`（默认 15 分钟），实现报告如实记录，不声称即时联动。

## 4. 会话与运行契约

| 概念 | 标识 | 存储 |
| --- | --- | --- |
| CRM 对话 | `conversationId`（UUID） | `sfoa_crm_conversation`；归属 org+user |
| OpenClaw 会话 | 官方 `resolveAgentRoute` 返回的 sessionKey | 对话行 `openclaw_session_key` |
| 单次运行 | `runId`（UUID） | `sfoa_crm_run`；`(conversation_id, client_message_id)` 唯一 |
| 浏览器消息 | `clientMessageId` | 运行行；重复提交不重派 |
| Apex 引导 | `jti` | 一次性 nonce 表 |
| 浏览器凭证 | 不透明 token | 会话表 SHA-256 |

- 同一 conversationId 永远得到同一个官方 sessionKey；不同对话独立。
- 聊天正文由 OpenClaw 会话存储持有；MySQL 不复制完整聊天库。
- 同一对话并发：插件返回 409 `CRM_CONVERSATION_BUSY`；接入服务在创建运行前也检查活动运行。
- 停止只作用于该对话的目标 run；界面明确“已完成的 Salesforce 写入不会因停止回答回滚”。
- 插件超时/断线/服务重启导致结果未知时，运行标记 `UNKNOWN`，不自动重试；提示先查历史。

## 5. 接入服务 HTTP API

基址由 Custom Setting `Endpoint__c` 提供（默认含 `/crm`）。

| 方法/路径 | 认证 | 作用 |
| --- | --- | --- |
| `POST /auth/exchange` | Apex token | 验签、消费 jti、绑定校验、签发聊天 token |
| `GET /me` | Chat token | 只读当前账号 |
| `GET /conversations` | Chat token | 自己的对话列表 |
| `POST /conversations` | Chat token | 新建对话 |
| `GET /conversations/:id` | Chat token | 自己的对话 |
| `GET /conversations/:id/messages` | Chat token | 官方 `sessions.get`（`subagent.getSessionMessages`）投影 |
| `POST /conversations/:id/messages` | Chat token | 发送；SSE 流式回答 |
| `GET /runs/:id/events?after=N` | Chat token | 有界事件重放/续流 |
| `POST /runs/:id/stop` | Chat token | 停止目标运行 |
| `GET /health` / `GET /ready` | 无 | 存活/依赖检查（不含秘密） |

SSE 事件：`run.accepted`、`run.started`、`message.delta`、`message.replace`、`message.final`、`run.completed`、`run.stopped`、`run.failed`、`stream.end`、`heartbeat`。

## 6. OpenClaw 插件契约

插件 `sfoa-crm-channel`：

- `api.registerChannel({ plugin })`：注册 `sfoa-crm` 渠道。
- `api.registerHttpRoute(...)`：
  - `POST /plugins/sfoa-crm/turn`（SSE，`auth:"plugin"`）
  - `POST /plugins/sfoa-crm/abort`（`auth:"plugin"`）
  - `POST /plugins/sfoa-crm/history`（`auth:"gateway"` + trusted-operator；只读 `sessions.get`）
  - `POST /plugins/sfoa-crm/session/resolve`（`auth:"plugin"`）
  - `GET /plugins/sfoa-crm/health`（`auth:"plugin"`）
- turn/abort/session/health 要求独立 service Bearer；凭证通过 SecretRef 解析，60s 缓存，不缓存身份。
- 使用官方 `resolveAgentRoute` → `finalizeInboundContext` → `recordInboundSession` → `dispatchReplyWithBufferedBlockDispatcher`。
- `SenderId = platformUserId`（由接入服务验证后注入）；`OriginatingChannel = "sfoa-crm"`；`CommandAuthorized=false`。
- 同一 sessionKey 的并发 turn 拒绝；`AbortController` 支持停止；中断/超时输出稳定状态。
- 历史走 `api.runtime.subagent.getSessionMessages({ sessionKey, limit })`，不直接读写 OpenClaw 会话数据库。
- turn/abort/session-resolve 使用独立 service token；history 使用单独的 Gateway 认证只读路由。接入服务仅在服务端持有 `CRM_GATEWAY_HISTORY_TOKEN`（优先专用只读 device token；共享 Gateway token 是文档化回退），只用于 `sessions.get`，不作为用户身份，也不能派发任意 Gateway 方法。
- 插件不持有 Gateway operator token。

## 7. MCP 渠道边界

- 新凭据 `MCP_CRM_CLIENT_TOKEN`；与 `MCP_CLIENT_TOKEN`、`MCP_WECOM_CLIENT_TOKEN` 必须互不相同。
- `X-SFOA-CRM-User-Id` 只在 CRM 凭据认证后可用；CRM 凭据不能使用 WeCom/Internal 头，反之亦然。
- 审计 `identity_source=CRM_HEADER`；仍走现有 Identity Route 和 Salesforce 权限。
- Tool 面、DML 治理、stdio/HTTP、WeCom/Buntu/UserBound 语义不变。
- 配置启用时缺少 token 或 alias、token 冲突、CRM 头作为 primary header 均 fail-fast。

## 8. 审计关联

现有 MCP 审计**没有** sessionId/runId/conversationId 字段（P7 只有 `publicAuditId`、`correlationId` 等）。因此：

- 强关联：CRM 运行记录（runId、sessionKey、开始/结束时间）↔ OpenClaw 日志中的 runId/sessionKey（插件不记录消息正文）。
- MCP 审计行：按 `platform_user_id + occurred_at` 时间窗 + tool_name 关联。
- 同一用户并发多对话时，时间窗可能重叠；不得把该关联表述为硬外键。此限制已在测试矩阵和部署文档中记录。

## 9. 安全与边界

- 浏览器不接触 Apex 私钥、Gateway token、数据库口令、MCP 渠道 token。
- 接入服务不接触 Salesforce 凭据；它持有的 Gateway 凭据仅用于 history 只读路由（优先专用只读 device token），不是用户身份，也不能调用任意 Gateway 方法。
- 跨用户对话/历史/运行统一 404；不暴露“存在但不属于你”。
- 不开放附件/文件接口；不共享 CRM 与企微上下文；不自动向企微回传。
- 子代理不继承 requester 身份；本期不依赖子代理执行 CRM 调用。
- 模型富文本按纯文本渲染；仅 `http(s)` URL 变成链接；不执行返回 HTML/脚本。
- 未知写入结果不自动重试；停止回答不回滚已完成写入。

## 10. 兼容性与未验证项

已保持：WeCom 路径、Internal/USER_BOUND/Buntu 身份、Tool/DML 治理、stdio/HTTP、审计 fail-open。
未修改：OpenClaw Core、企微官方插件、Salesforce 既有业务 Apex/Trigger/Flow、上游 Salesforce 文件。

未验证：

- Apex 编译/测试、证书实际签名、沙盒部署。
- 真实 Salesforce 双用户 OpenClaw→MCP→Salesforce 调用（隔离 Gateway 的 MCP 为 mock）。
- 真实浏览器 UAT、CORS/CSP/HTTPS/nginx 真机配置。
- 接入服务进程与真实插件/MySQL 的整链联调（当前分别以 HTTP 客户端测试与插件直连验证）。

已取得：隔离 OpenClaw 2026.9.5 中插件注册、真实模型 turn、官方 session route、`sessions.get` 历史与 `X-SFOA-CRM-User-Id` 到达 MCP mock 的证据；见 [real-openclaw-gate.md](evidence/crm-openclaw/real-openclaw-gate.md)。

这些均在测试矩阵中标记为 `NOT_VERIFIED`，不得以 mock 结果替代。

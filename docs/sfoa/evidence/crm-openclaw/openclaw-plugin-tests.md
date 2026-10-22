# OpenClaw CRM 渠道插件测试证据（2026-10-22）

工作目录：`D:\GitProject\sfoa-enterprise-mcp\integrations\openclaw\sfoa-crm-channel`

```text
node --test test/protocol.test.js      -> 9/9 PASS
node --test test/turn-service.test.js  -> 9/9 PASS
node --test test/ingress.test.js       -> 8/8 PASS
```

合计：**26/26 PASS**。

## 关键断言

- 身份只来自 ingress 验证后的 `platformUserId`；请求体里的 `senderId`/`userId`/`from`/`prompt` 不参与决策。
- 每轮使用官方 `resolveAgentRoute`，同一 `conversationId` 得到同一 sessionKey；不同对话得到不同 sessionKey。
- `finalizeInboundContext` 的 `SenderId`/`OriginatingChannel`/`SessionKey` 正确；`CommandAuthorized=false`。
- 同一对话并发第二轮返回 `CRM_CONVERSATION_BUSY`，dispatch 只调用一次。
- `stop` 只停止匹配的 `runId`；超时返回 `CRM_TURN_TIMEOUT` 并提示“不要直接重复提交”。
- SSE 帧严格 JSON；非法帧拒绝；history 只投影 user/assistant 文本，过滤 system/tool。
- ingress 缺失/错误 service token → 401；凭证不可解析 → 所有请求 401；busy 在 SSE 头之前返回 409。
- 默认只接受 loopback 调用（`allowRemoteService=false`）；非本机请求在认证前返回 `403 CRM_LOOPBACK_REQUIRED`。
- health/session resolve 通过 service token ingress；history 通过单独的 `auth:"gateway"` + trusted-operator 只读路由（`sessions.get`），默认仍只接受 loopback。

## 源码级兼容性核对（OpenClaw 2026.9.5 / ec9c1a1）

在测试服只读检查了安装包：

- `api.registerChannel({ plugin })` 与 `api.registerHttpRoute({ auth: "plugin", match: "exact" })` 存在。
- 官方分发模式使用 `channel.routing.resolveAgentRoute`、`channel.reply.finalizeInboundContext`、`channel.session.recordInboundSession`、`channel.reply.dispatchReplyWithBufferedBlockDispatcher`（WeCom 插件同款）。
- 插件运行时暴露 `subagent.getSessionMessages`（内部官方 `sessions.get`）；history 路由使用 Gateway 认证 + trusted-operator，接入服务仅在服务端持有 `CRM_GATEWAY_HISTORY_TOKEN`，不作为用户身份。
- 真实 2026.9.5 隔离 Gateway 已验证：`auth:"plugin"` 路由没有 `operator.read`，`gateway.request("chat.history")` 会失败；改为独立 Gateway 认证 history 路由后通过。该缺陷有真实日志与修复记录。
- `onPartialReply`、`abortSignal`、`deliver` 类型存在。

## 真实 Gateway

已在隔离 Gateway `2026.9.5` 中完成插件注册、turn、官方 session route 与 `sessions.get` 历史；MCP 为 mock。证据见 [real-openclaw-gate.md](real-openclaw-gate.md)。

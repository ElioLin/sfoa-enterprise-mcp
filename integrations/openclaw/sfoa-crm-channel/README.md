# @sfoa/openclaw-crm-channel

OpenClaw 插件：为 Salesforce 内嵌 CRM 聊天提供**可信渠道**。它不实现渠道传输、不调用 Salesforce、不改 OpenClaw Core。

## 注册内容

- Channel `sfoa-crm`。
- 凭证化 HTTP ingress：
  - `POST /plugins/sfoa-crm/turn` → SSE（service token）
  - `POST /plugins/sfoa-crm/abort`（service token）
  - `POST /plugins/sfoa-crm/history`（`auth:"gateway"` + trusted-operator；`sessions.get`）
  - `POST /plugins/sfoa-crm/session/resolve`（service token）
  - `GET  /plugins/sfoa-crm/health`（service token）
- 每个 turn 使用官方 `resolveAgentRoute` → `finalizeInboundContext` → `recordInboundSession` → `dispatchReplyWithBufferedBlockDispatcher`。
- `SenderId` 只来自 ingress 验证后的 `platformUserId`；`OriginatingChannel=sfoa-crm`；`CommandAuthorized=false`。
- 历史使用 `api.runtime.subagent.getSessionMessages(...)`（内部官方 `sessions.get`），不读会话数据库。接入服务只在服务端持有 `CRM_GATEWAY_HISTORY_TOKEN`（优先只读 device token），不作为用户身份。

## 配置

```json
{
  "plugins": {
    "entries": {
      "sfoa-crm-channel": {
        "config": {
          "serviceToken": { "secretRef": "sfoaCrmServiceToken" },
          "allowRemoteService": false,
          "maxMessageChars": 16000,
          "turnTimeoutMs": 600000
        }
      },
      "sfoa-wecom-mcp-adapter": {
        "config": {
          "mcpCrmClientToken": { "secretRef": "sfoaCrmMcpToken" }
        }
      }
    },
    "load": { "paths": ["/data/openclaw/plugins/sfoa-crm-channel"] }
  },
  "mcp": {
    "servers": {
      "sfoa-enterprise-mcp": { "url": "http://127.0.0.1:8080/mcp", "transport": "streamable-http" }
    }
  }
}
```

`serviceToken` 与接入服务 `CRM_OPENCLAW_SERVICE_TOKEN` 相同；`mcpCrmClientToken` 与 MCP 的 `MCP_CRM_CLIENT_TOKEN` 相同。两者都是服务凭据，不是用户身份。

## 测试

```bash
node --test
```

26 项：protocol 9、turn-service 9、ingress 8。

## 边界

- 默认只接受 loopback 接入服务（`allowRemoteService=false`）；跨机部署必须显式开启并承担 token 暴露面。
- 不改 OpenClaw Core / 企微插件 / `node_modules`。
- turn/abort/session-resolve 不把 Gateway operator token 交给接入服务；history 只使用服务端 `CRM_GATEWAY_HISTORY_TOKEN`（优先只读 device token），不作为用户身份。
- 同一对话并发 turn 返回 busy；stop 只作用于匹配的 run；未知结果不自动重试。
- 本期不开放附件/文件/语音。

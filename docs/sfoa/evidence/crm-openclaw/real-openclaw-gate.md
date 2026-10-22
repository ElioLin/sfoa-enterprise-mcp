# REAL_OPENCLAW 隔离验证（2026-10-22）

目标：在测试服 `crm-ex-test02` 上启动**独立** OpenClaw 实例，验证 CRM 渠道插件在真实 2026.9.5 Gateway 中的注册、turn、官方 session route、历史读取与 MCP transport 身份头注入。

## 隔离边界

| 项 | 值 |
| --- | --- |
| Gateway | OpenClaw `2026.9.5 (ec9c1a1)` |
| 端口 | `127.0.0.1:18790`（共享实例仍为 `:18789`） |
| State | `/data/openclaw-crm-test/state`（独立，验证后删除） |
| Channels | `{}`（**未加载/未启动企微长连接**） |
| Plugins | `sfoa-crm-channel`、`sfoa-wecom-mcp-adapter` |
| MCP | `http://127.0.0.1:18080/mcp` 上的 mock MCP（记录 header；不调用 Salesforce） |
| Model | 独立配置使用 `DeepSeekV32`；未修改共享模型配置 |

## 注册证据

Gateway 日志：

```text
[plugins] [sfoa-crm] channel registered; ingress /plugins/sfoa-crm/* accepts only the configured service credential
[plugins] [sfoa-enterprise-mcp] requester-scoped MCP connection resolver registered (url=http://127.0.0.1:18080/mcp)
[sfoa-crm] channel running (no inbound socket; HTTP ingress is credentialed)
[gateway] ready
```

`/plugins/sfoa-crm/health`（service token）：

```json
{"ok":true,"channel":"sfoa-crm","version":1,"activeTurns":0}
```

## 官方 session route

```json
{"conversationId":"22222222-2222-4222-8222-222222222222","sessionKey":"agent:main:sfoa-crm:default:direct:22222222-2222-4222-8222-222222222222","agentId":"main","accountId":"default"}
```

第二个对话：

```json
{"conversationId":"44444444-4444-4444-8444-444444444444","sessionKey":"agent:main:sfoa-crm:default:direct:44444444-4444-4444-8444-444444444444",...}
```

## Turn（真实模型 + mock MCP）

请求 `platformUserId=crm-e2e-user`，消息要求模型调用 `sfoa-enterprise-mcp` 的 `get_username`。

SSE 输出（节选）：

```text
event: run.started
data: {"runId":"11111111-1111-4111-8111-111111111111","sessionKey":"agent:main:sfoa-crm:default:direct:22222222-2222-4222-8222-222222222222","agentId":"main"}

event: message.delta ... "crm" ... "Header" ... "=" ... "***"
event: message.final
data: {"text":"crmHeader=***"}
event: run.completed
data: {"runId":"11111111-1111-4111-8111-111111111111","status":"COMPLETED","durationMs":2646}
```

> 模型输出中的 header 值被 OpenClaw 的脱敏层显示为 `***`；mock MCP 的原始 header 记录如下。

Mock MCP 收到的请求（每行一个请求）：

```text
{"method":"POST","url":"/mcp","authPresent":true,"crmHeader":"crm-e2e-user","wecomHeader":null,"platformHeader":null}
{"method":"POST","url":"/mcp","authPresent":true,"crmHeader":"crm-e2e-user","wecomHeader":null,"platformHeader":null}
{"method":"GET","url":"/mcp","authPresent":true,"crmHeader":"crm-e2e-user","wecomHeader":null,"platformHeader":null}
{"method":"POST","url":"/mcp","authPresent":true,"crmHeader":"crm-e2e-user","wecomHeader":null,"platformHeader":null}
{"method":"POST","url":"/mcp","authPresent":true,"crmHeader":"crm-e2e-user","wecomHeader":null,"platformHeader":null}
```

这证明：CRM 渠道的 `SenderId` 经 adapter resolver 以 `X-SFOA-CRM-User-Id` 到达 MCP 传输层，且没有 WeCom/Internal 头。

## 历史（真实 OpenClaw `sessions.get`）

`POST /plugins/sfoa-crm/history` 使用 Gateway 认证的 trusted-operator 路由：

```json
{"messages":[
  {"id":"history-0","role":"user","text":"请调用 sfoa-enterprise-mcp 的 get_username 工具，然后只回复工具返回的内容。","timestamp":1792631955778},
  {"id":"history-3","role":"assistant","text":"crmHeader=***","timestamp":1792631957632}
],"hasMore":false}
```

这证明 history 走插件运行时的 `api.runtime.subagent.getSessionMessages`（内部 `sessions.get`），没有直接读写 OpenClaw 会话数据库。

> 第一次尝试使用 `api.runtime.gateway.request("chat.history")` 失败：plugin-auth route 没有 `operator.read`。改为 separate `auth:"gateway"` + `gatewayRuntimeScopeSurface:"trusted-operator"` 的 history route 后通过。该真实缺陷已修复并记录。

## 清理与共享服务

```text
isolated-ports-closed
isolated dir removed: YES
shared openclaw-gateway: active (pid 2551332, :18789)
sfoa-mcp-server / sfoa-admin-api / nginx: active
```

隔离目录含测试 secrets 副本，验证后已整体删除；共享 OpenClaw、企微长连接、MCP/Admin/nginx 未重启、未修改。

## 层级声明

这是 **REAL_OPENCLAW + MOCK MCP**。没有调用真实 Salesforce；`REAL_SALESFORCE` 和 `REAL_BROWSER/UAT` 仍未验证。

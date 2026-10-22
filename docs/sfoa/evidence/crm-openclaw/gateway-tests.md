# CRM 接入服务测试证据（2026-10-22）

工作目录：`D:\GitProject\sfoa-enterprise-mcp\packages\sfoa-crm-gateway`

## 构建

```text
node .\node_modules\typescript\bin\tsc -p tsconfig.json -> exit 0
```

说明：新 workspace 尚未执行 `yarn install`；本地用 junction 链接已有的 `@sfoa/control-plane`、`zod`、`typescript`、`@types/node`。干净检出需由部署者执行一次 `yarn install`。

## 单元 / HTTP 测试

```text
node --test dist/test/*.test.js
```

结果：**23/23 PASS**。

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `apex-token.test.js` | 10 | RSA-SHA256 验签、篡改 payload/signature、错误密钥、过期/过老/未来签发、TTL 上限、issuer/audience/org 钉住、严格 claims、公钥加载 |
| `chat-auth.test.js` | 4 | 聊天 token 只存 SHA-256、过期、撤销、未知 token、滑动窗口限流 |
| `openclaw-client.test.js` | 5 | SSE 分片/注释/非法 JSON、service token 与请求体、409 映射、history/resolve/abort/health 端点 |
| `server.test.js` | 3 | 兑换→建对话→SSE 回答→历史→重复消息拒绝→跨用户 404；忙 409；停止仅作用于目标运行；终态不调用 abort |
| `config.test.js` | 1 | 精确 origin、OrgId、history 凭据、OpenClaw URL 与 TLS 配对的 fail-fast |

关键断言：

- 同一 Apex 引导 token 第二次兑换 → `409 CRM_BOOTSTRAP_REPLAYED`。
- 同一 `clientMessageId` 再次提交 → `409 CRM_DUPLICATE_MESSAGE`，且 OpenClaw turn 调用次数不增加。
- 同组织另一用户读取他人对话/历史 → `404 CRM_CONVERSATION_NOT_FOUND`（不区分“不存在/别人的”）。
- 流式回答事件包含 `run.accepted`、`run.started`、`message.delta`、`message.final`、`run.completed`、`stream.end`。
- 停止后运行状态 `STOPPED`，并写入 `completed_at`。
- 回答失败只返回稳定错误码与安全中文消息，不返回堆栈或内部异常文本。

## MySQL 仓储集成

```text
node --test dist/mysql-test/*.test.js
```

结果：**1/1 PASS**（本地 MySQL 8.0.30）。

覆盖：绑定 upsert（唯一键 org+user）、非一次性 jti 原子消费、聊天会话创建/触碰/撤销、对话归属查询、运行创建/重复 clientMessageId 拒绝、RUNNING→COMPLETED 终态不可覆盖、stale run 标记 UNKNOWN、过期工件清理。

合并运行 `node --test dist/test/*.test.js dist/mysql-test/*.test.js`：**24/24 PASS**。

## 未覆盖

- 真实 OpenClaw 插件进程中的 `api.runtime.subagent.getSessionMessages(...)` 已由隔离 Gateway 验证（REAL_OPENCLAW + MOCK MCP）；接入服务的 `CRM_GATEWAY_HISTORY_TOKEN` 真机配置仍待部署。
- 真实 Salesforce Apex 签名/证书未实测（接入服务侧验签已用自生成 RSA 密钥对覆盖）。
- 真实浏览器 SSE/CORS/CSP 未实测。

# @sfoa/crm-gateway

Salesforce 内嵌 CRM 聊天的**接入服务**。它不是 MCP Gateway，也不直接调用 Salesforce。

```text
LWC -> Apex 签发 v1 token -> 本服务验签/兑换 -> OpenClaw CRM 渠道插件 -> SFOA MCP -> Salesforce
```

## 职责

- 固定信任的 Apex 公钥/证书、issuer、audience、OrgId；RSA-SHA256 验签。
- `jti` 原子消费（`sfoa_crm_bootstrap_nonce`），重放 409。
- `(orgId,userId) → platformUserId` 显式绑定校验，route 必须启用且用户名精确匹配。
- 15 分钟不透明聊天 token；数据库只存 SHA-256。
- 对话归属、运行状态、重复 `clientMessageId` 防重、停止、SSE 续流。
- 通过独立 service Bearer 调用 OpenClaw CRM 插件的 turn/abort/session-resolve；历史读取使用单独的
  Gateway 只读路由（`auth:"gateway"` + trusted-operator），服务端持有
  `CRM_GATEWAY_HISTORY_TOKEN`，仅用于 history，不作为用户身份。
- 历史由插件的 `api.runtime.subagent.getSessionMessages`（内部 `sessions.get`）读取；不复制聊天库。

## 运行

```bash
yarn workspace @sfoa/crm-gateway build
yarn workspace @sfoa/crm-gateway test          # 23 unit/HTTP tests
yarn workspace @sfoa/crm-gateway test:mysql    # 1 local MySQL integration test
```

配置模板见 `.env.example`；部署步骤见 `docs/sfoa/CRM_OPENCLAW_DEPLOYMENT.md`。

## 管理员绑定

```bash
yarn workspace @sfoa/crm-gateway crm:bind \
  --org <orgId> --user <salesforceUserId> \
  --platform-user <platformUserId> \
  --salesforce-username <route's salesforce username>
yarn workspace @sfoa/crm-gateway crm:bind --list
```

## 安全边界

- 不接收浏览器传入的用户/组织；只接受 Apex 签名。
- 不接受动态公钥 URL 或算法降级。
- Salesforce 退出登录不会即时撤销聊天 token；最大窗口为 `CRM_CHAT_TOKEN_TTL_MS`（默认 15 分钟）。
- 跨用户对话/历史/运行统一 404；未知写入结果不自动重试。

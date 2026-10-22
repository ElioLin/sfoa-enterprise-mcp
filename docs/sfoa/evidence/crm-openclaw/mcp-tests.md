# MCP 侧测试证据（2026-10-22）

工作目录：`D:\GitProject\sfoa-enterprise-mcp`

## 构建

```text
yarn workspace @sfoa/control-plane build   -> exit 0
yarn workspace @sfoa/identity-runtime build -> exit 0
yarn workspace @sfoa/mcp-server build      -> exit 0
```

## CRM 渠道身份与配置

命令：

```text
node --test packages/sfoa-mcp-server/dist/test/crm-channel.test.js
```

结果：**12/12 PASS**。

覆盖：

- CRM 渠道凭据 + `X-SFOA-CRM-User-Id` → `CRM_HEADER`，主体 id 原样保留。
- CRM 凭据不能借用 WeCom 头或 Internal 头；WeCom/Internal 凭据也不能使用 CRM 头。
- 缺身份头、重复头、两个身份头、控制字符、超长 id、错误 Bearer 均拒绝。
- 配置启用必须同时具备独立 `MCP_CRM_CLIENT_TOKEN` 与绑定的 `X-SFOA-CRM-User-Id` alias；token 不得与 Internal/WeCom 相同；CRM 头不得作为 primary header。

## MCP HTTP 端到端（mock Salesforce Connection）

命令：

```text
node --test packages/sfoa-mcp-server/dist/test/crm-http-integration.test.js
```

结果：**2/2 PASS**。

覆盖：

- 真实 MCP Streamable HTTP 请求：CRM 凭据 + CRM 头 → Identity Route → `get_username` 返回 `user-a@example.test`。
- 审计快照携带 `identitySource=CRM_HEADER`、`platformUserId`、`salesforceUsername`。
- CRM 凭据配 WeCom/Internal 头、WeCom/Internal 凭据配 CRM 头、CRM 凭据无头 → 401/403，错误码分别为 `MCP_IDENTITY_CHANNEL_MISMATCH` / `MCP_PLATFORM_USER_REQUIRED`。

## 既有身份回归

命令：

```text
node --test packages/sfoa-mcp-server/dist/test/identity-provider.test.js
```

结果：**23/23 PASS**（Internal/USER_BOUND/Buntu/WeCom 既有断言未改变）。

## 全量 MCP 单元/HTTP 回归

命令：

```text
yarn workspace @sfoa/mcp-server test
```

结果：**406/406 PASS**（7 suites，约 175s），包含本次 CRM 渠道与既有 P2/P3/P4/P5/P8/P9 单元/HTTP 用例。

命令：

```text
yarn workspace @sfoa/control-plane test
```

结果：**38/38 PASS**（本次 schema/migration 变更后）。

## 说明

以上是 UNIT/MOCK 证据；`get_username` 使用测试身份运行时，没有调用真实 Salesforce。真实双用户链路见测试矩阵的 `NOT_VERIFIED` 项。

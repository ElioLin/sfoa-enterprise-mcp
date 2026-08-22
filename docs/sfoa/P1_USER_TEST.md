# P1 用户验证指南

本指南验证 P1 的请求级 Salesforce 身份路由。测试主机只监听本机回环地址，并在 P1 中把 `X-Platform-User-Id` 当作可信上游上下文；真正的平台认证、OAuth Gateway 和 Tool Governance 属于 P2，不应把这个测试 Header 直接暴露到公网。

## 1. 准备本地配置

在仓库根目录创建被 Git 忽略的 `.env.local`。不要把真实用户名、私钥、Token 或 JWT assertion 写入文档或提交。

| 变量 | P1 Live Gate | 说明 |
| --- | --- | --- |
| `SFOA_INSTANCE_URL` | 必需 | 不含凭据的 SFoA HTTPS 根地址 |
| `SALESFORCE_USERNAME` | 必需 | User A |
| `SECOND_TEST_USER` | 必需 | User B；缺失时单元测试可运行，但 P1 不得判定 PASS |
| `CONNECTED_APP_CLIENT_ID` | 必需 | 两名用户均获授权的 JWT Connected App Client ID |
| `JWT_PRIVATE_KEY_PATH` | 必需 | 私钥文件路径；文件必须留在 Git 之外 |
| `TEST_OBJECT` | 必需 | 安全只读查询对象，例如 `Lead` |
| `TEST_METADATA_TYPE` | 必需 | 受控 metadata 类型，例如 `CustomObject` |
| `TEST_METADATA_FULL_NAME` | 必需 | 对应的受控 component full name |
| `SALESFORCE_ALIAS` | 可选 | 仅属于 User A 当前 route 的本地别名 |
| `P1_PLATFORM_USER_A` | 可选 | 默认 `p1-user-a` |
| `P1_PLATFORM_USER_B` | 可选 | 默认 `p1-user-b` |
| `P1_CONCURRENT_REQUESTS` | 可选 | 默认并最少为 `20`，最大 `50` |
| `PORT` | 可选 | Test Host 默认 `3000` |

两名 Salesforce 用户共用本次测试的 instance、Connected App 和私钥配置，但每个请求都会以 route 中的 Salesforce username 创建 fresh JWT/Connection。P1 不读取 Salesforce CLI Auth Cache。

## 2. 执行自动验证

从仓库根目录运行：

```powershell
yarn workspace @sfoa/identity-runtime build
yarn workspace @sfoa/identity-runtime test
yarn workspace @sfoa/identity-runtime lint
yarn workspace @sfoa/identity-runtime validate:p1
```

`validate:p1` 会真实执行：

- A/B route、fresh JWT 与 `Connection.identity()`；
- 官方 `get_username` 和只读 `run_soql_query`；
- A→B、B→A 伪造 username 阻断；
- unknown/missing platform user 阻断；
- 至少 20 个 A/B 交错请求；
- 两个并发官方 `retrieve_metadata` 请求、CWD 串行保护、独立 workspace 和清理；
- 无效认证错误脱敏检查。

只有最后一行是 `P1 = PASS`，且 `Identity Mismatch`、`Cross User Leak`、`Connection Reuse` 都为 `0`，才表示 P1 Live Gate 通过。输出不会显示完整 Token、JWT assertion、私钥路径或 Salesforce 业务记录内容。

## 3. 启动 HTTP Test Host

```powershell
yarn workspace @sfoa/identity-runtime start:p1
```

默认地址：

```text
http://127.0.0.1:3000/mcp
```

每个 `POST /mcp` 都必须携带：

```text
X-Platform-User-Id: p1-user-a
```

或：

```text
X-Platform-User-Id: p1-user-b
```

可选携带格式安全的 `X-Correlation-Id`。格式不合格时服务端会生成 UUID。服务端只向 stderr 写结构化日志，不向 MCP stdio/stdout 写运行日志。

## 4. 使用 MCP Inspector

在 MCP Inspector 中选择 `Streamable HTTP`：

1. URL 填 `http://127.0.0.1:3000/mcp`。
2. 自定义 Header 填 `X-Platform-User-Id: p1-user-a`，连接并调用 `get_username`、`run_soql_query`。
3. 断开后改为 `p1-user-b`，重新连接并重复调用。
4. `tools/list` 应只包含 `get_username`、`run_soql_query`、`retrieve_metadata`。
5. A 的 `get_username` 应对应 `SALESFORCE_USERNAME`，B 应对应 `SECOND_TEST_USER`。

`run_soql_query` 使用：

```json
{
  "query": "SELECT Id FROM Lead LIMIT 5",
  "usernameOrAlias": "<当前 Header 对应的 Salesforce username>",
  "directory": "D:\\ignored-by-server",
  "useToolingApi": false
}
```

把 `Lead` 替换为本地 `TEST_OBJECT`。`directory` 是官方 schema 的必填参数，但 P1 会在执行边界将它覆盖成 request-owned workspace；客户端路径不是服务器文件系统权限。

## 5. 使用 Postman

为每个请求设置：

```text
POST http://127.0.0.1:3000/mcp
Content-Type: application/json
Accept: application/json, text/event-stream
X-Platform-User-Id: p1-user-a
X-Correlation-Id: postman-p1-a
```

初始化请求示例：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "postman", "version": "1.0.0" }
  }
}
```

Tool 调用示例：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "run_soql_query",
    "arguments": {
      "query": "SELECT Id FROM Lead LIMIT 5",
      "usernameOrAlias": "<User A username>",
      "directory": "D:\\ignored-by-server",
      "useToolingApi": false
    }
  }
}
```

如果 Postman 版本不方便完成 MCP 初始化生命周期，优先用 Inspector 或仓库内的 `validate:p1`；它们使用官方 MCP SDK Client。

## 6. 伪造与拒绝测试

在 Header 使用 `p1-user-a` 时，把 `usernameOrAlias` 改成 User B；反向再测试一次。两次都应返回 Tool-level error，并包含稳定 code：

```text
MCP_IDENTITY_CONTEXT_MISMATCH
```

阻断发生在目标用户 JWT 创建和 Salesforce API 调用之前。

未知 route：

```text
X-Platform-User-Id: does-not-exist
```

期望 HTTP 403 和 `MCP_IDENTITY_ROUTE_NOT_FOUND`。完全删除 Header 时，期望 HTTP 401 和 `MCP_PLATFORM_USER_REQUIRED`。空字符串或仅空白 Header 同样不得 fallback。

## 7. Metadata 与 workspace

调用 `retrieve_metadata` 时使用当前 route username，并传：

```json
{
  "usernameOrAlias": "<当前 route username>",
  "directory": "D:\\ignored-by-server",
  "manifest": "manifest/package.xml",
  "ignoreConflicts": true
}
```

服务端会把 `directory` 替换成当前请求的临时 DX project，并把相对 manifest 解析到该 workspace 内。绝对越界 manifest/sourceDir 会被拒绝。请求结束后 workspace 必须被清理，进程 CWD 必须恢复。

## 8. 判定规则

- `P1 = PASS`：两名真实用户、官方 Tools、双向伪造、unknown/missing、并发与 metadata 隔离全部通过。
- `P1 = PARTIAL`：例如 `SECOND_TEST_USER` 未配置或未真实验证；不得用单用户结果替代。
- `P1 = FAIL`：任何 identity mismatch、cross-user leak、错误连接复用、CWD/workspace 串线或敏感信息泄漏。

本流程不需要数据库、Redis、Salesforce CLI 登录、Token Cache 或 Connection Pool。

# P2 用户测试指南

本指南用于维护者在本机、局域网和 MCP Inspector 中验证 P2 正式 Remote Runtime。P2 只读，不提供 CREATE、UPDATE、DELETE、部署或管理类 Tool。

## 1. 准备环境

使用仓库固定运行时：Node 24.13.0、Yarn Classic 1.22.22。不要升级 MCP/Salesforce 依赖。

从仓库根目录复制示例配置：

```powershell
Copy-Item .env.example .env.local
```

在被 Git 忽略的 `.env.local` 中填写已有 P1/Salesforce 配置，并生成一个强随机客户端 Token：

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

把输出只写入：

```text
MCP_CLIENT_TOKEN=<随机值>
```

不要把 Token、JWT 私钥、Salesforce Access Token 或 `.env.local` 提交 Git。

P2 默认配置：

```text
MCP_BIND_HOST=127.0.0.1
MCP_PORT=8080
MCP_PATH=/mcp
MCP_AUTH_MODE=internal_bearer
MCP_PLATFORM_USER_HEADER=X-Platform-User-Id
MCP_ENABLED_TOOLS=get_username,run_soql_query
```

## 2. 构建与本地启动

```powershell
yarn workspace @sfoa/mcp-server build
yarn workspace @sfoa/mcp-server start
```

默认地址：

```text
MCP       http://127.0.0.1:8080/mcp
Health    http://127.0.0.1:8080/health
Readiness http://127.0.0.1:8080/ready
```

检查 liveness/readiness（不访问 Salesforce）：

```powershell
Invoke-RestMethod http://127.0.0.1:8080/health
Invoke-RestMethod http://127.0.0.1:8080/ready
```

预期均为：

```json
{"status":"UP"}
```

## 3. Header

每一个 MCP POST 必须携带：

```http
Authorization: Bearer <MCP_CLIENT_TOKEN>
X-Platform-User-Id: <platform user id>
```

可选：

```http
X-Correlation-Id: p2-manual-a-001
```

不要发送 Salesforce username、Salesforce Token、私钥、`usernameOrAlias` 或 `directory`。Agent 只需给 SOQL：

```json
{
  "query": "SELECT Id FROM Lead LIMIT 5",
  "useToolingApi": false
}
```

## 4. 认证负向测试

以下 PowerShell 示例只展示 Header 结构；请从当前 shell 或 `.env.local` 取得真实 Token，不要把它粘贴到日志/工单。

```powershell
$mcpUrl = 'http://127.0.0.1:8080/mcp'
$initialize = @{
  jsonrpc = '2.0'
  id = 1
  method = 'initialize'
  params = @{
    protocolVersion = '2025-06-18'
    capabilities = @{}
    clientInfo = @{ name = 'p2-manual'; version = '1.0.0' }
  }
} | ConvertTo-Json -Depth 8
```

验证：

| 场景 | 预期 |
| --- | --- |
| 无 `Authorization` | HTTP 401 / `MCP_CLIENT_AUTH_REQUIRED` |
| 错误 Bearer | HTTP 401 / `MCP_CLIENT_AUTH_INVALID` |
| 正确 Bearer、无平台用户 | HTTP 401 / `MCP_PLATFORM_USER_REQUIRED` |
| 正确 Bearer、未知平台用户 | HTTP 403 / `MCP_IDENTITY_ROUTE_NOT_FOUND` |
| 正确 Bearer、User A | initialize PASS |
| 正确 Bearer、User B | initialize PASS |

前三类请求不应产生 Salesforce JWT；运行日志不得出现 Bearer 值。

## 5. MCP Inspector

使用仓库本地 Inspector，不安装全局包：

```powershell
yarn mcp-inspector
```

在 Inspector 页面配置：

```text
Transport: Streamable HTTP
URL:       http://127.0.0.1:8080/mcp
```

添加 HTTP Header：

```text
Authorization: Bearer <MCP_CLIENT_TOKEN>
X-Platform-User-Id: <platform-user-A>
```

依次执行：

1. Connect/initialize。
2. `tools/list`：只能看到 `get_username`、`run_soql_query`。
3. `get_username`：返回 A 对应 Salesforce username。
4. `run_soql_query`：输入 `query` 和 `useToolingApi`，不得输入 username/directory。
5. 把平台 Header 换成 B，重新连接，重复上述调用。

仓库可重复自动化 Inspector 代理 Gate：

```powershell
yarn workspace @sfoa/mcp-server validate:inspector
```

该命令要求 `MCP_CLIENT_TOKEN`、P1 A/B 路由和 Salesforce JWT 配置已就绪。

## 6. 正式 P2 live validator

```powershell
yarn workspace @sfoa/mcp-server validate:p2
```

它会执行受控只读验证：

- Bearer/平台用户拒绝顺序；
- User A/B initialize、tools/list、官方 `get_username` 和 SOQL；
- A/B 在 Tool body 中伪造 `platformUserId`、`usernameOrAlias`、`directory` 不能改变 Header 路由；
- 50 次 A/B 交错只读请求；
- identity/cross-user/workspace/cleanup/connection-reuse/error 计数；
- initialize、tools/list、get_username、SOQL、JWT/Connection p50/p95。

测试只输出 Gate/延迟，不持久化 Salesforce Records。

## 7. 局域网测试

只有显式设置非 loopback 才允许远程访问：

```powershell
$env:MCP_BIND_HOST = '0.0.0.0'
$env:MCP_ALLOWED_HOSTS = '<local-ip>:8080'
yarn workspace @sfoa/mcp-server start
```

客户端 URL：

```text
http://<local-ip>:8080/mcp
```

注意：

- `MCP_AUTH_MODE=disabled` 与 `0.0.0.0` 组合会拒绝启动。
- 配置 `MCP_ALLOWED_HOSTS` 的值必须与客户端发送的 `Host` 完全一致（含非默认端口）。
- 如有浏览器 Origin，另设精确 `MCP_ALLOWED_ORIGINS`；不要使用通配符。
- Windows 防火墙/安全组开放端口属于部署操作，本仓库不会自动修改。
- 局域网仍应使用受控内网；正式跨网络部署应由 TLS Reverse Proxy 保护，参见 `P2_REVERSE_PROXY.md`。

## 8. 停止与清理

在运行终端按 `Ctrl+C`，或向进程发送 SIGTERM。预期日志顺序：

```text
STARTED
DRAINED
```

Runtime 先停止接收新请求，再等待在途请求到受控超时，清理 transport、MCP server、workspace 后关闭。它不直接调用 `process.exit()`。

## 9. 通过标准

- A 映射 A，B 映射 B；双向伪造不能改变路由。
- `tools/list` 只有显式 Enabled Tools。
- `deploy_metadata` 等写/管理 Tool 配入 `MCP_ENABLED_TOOLS` 时启动失败。
- 413、request timeout、Tool timeout 均返回稳定错误码。
- 50 次请求：identity mismatch、cross-user leak、workspace leak、cleanup failure、connection reuse、error count 全部为 0。
- Salesforce CLI runtime dependency = NONE；Database dependency = NONE。

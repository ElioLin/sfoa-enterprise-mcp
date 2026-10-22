# CRM OpenClaw 一期部署与回退

日期：2026-10-22
状态：本地实现完成；**未部署、未重启共享服务、未改动生产**。

## 0. 前置条件与授权

- 目标只允许沙盒/UAT：`runnergroup--uat.sandbox.my.sfcrmproducts.cn`（OrgId `00DC5000000lGFpMAM`）。生产未授权。
- 需要用户明确批准沙盒 metadata 部署与 Apex 测试。
- 需要维护窗口重启 `sfoa-mcp-server` 与 `openclaw-gateway`；本任务未执行。
- 浏览器必须能通过 HTTPS 访问公司内网接入服务；不能要求用户关闭浏览器安全机制。

## 1. Salesforce 证书（由管理员在 Setup 完成）

推荐在 Salesforce 内生成自签名证书，私钥不离开 Salesforce：

1. Setup → Security → Certificate and Key Management → **Create Self-Signed Certificate**。
2. Unique Name：例如 `SFOA_CRM_Chat_Signing`；Key Size 2048；保存。
3. 下载**公开证书**（`.crt`），不要导出含私钥的 keystore。
4. 在接入服务主机转换为 PEM 并计算指纹：

```bash
openssl x509 -inform DER -in SFOA_CRM_Chat_Signing.crt -out apex-signing-cert.pem
openssl x509 -in apex-signing-cert.pem -outform DER | sha256sum
```

5. 将 `apex-signing-cert.pem` 放到受控路径（例如 `/data/sfoa-enterprise-mcp/secrets/apex-signing-cert.pem`，公开证书可用 `0644`）。
6. 记录 SHA-256，填入 `CRM_APEX_CERT_SHA256`；轮换证书时同步更新接入服务配置并重启。

> Custom Setting 只保存证书 Unique Name，不保存私钥。Apex 使用 `Crypto.signWithCertificate('RSA-SHA256', input, certificateUniqueName)`。

## 2. 部署 CRM 元数据（沙盒，需授权）

CRM 工程没有 `sfdx-project.json`；推荐在**仓库外**建立一次性 source-format 部署目录，避免改动 CRM 工程：

```powershell
$temp = "C:\temp\crm-openclaw-deploy"
New-Item -ItemType Directory -Force "$temp\src","$temp\manifest" | Out-Null
Copy-Item -Recurse D:\GitProject\crm\runner-product\src\classes\SfoaCrmChatIdentity.cls* "$temp\src\classes\" -Force
Copy-Item -Recurse D:\GitProject\crm\runner-product\src\objects\SFOA_CRM_Chat_Config__c.object "$temp\src\objects\" -Force
Copy-Item -Recurse D:\GitProject\crm\runner-product\src\lwc\sfoaCrmChat "$temp\src\lwc\" -Force
Copy-Item -Recurse D:\GitProject\crm\runner-product\src\aura\sfoaCrmChatUtilityBar "$temp\src\aura\" -Force
Copy-Item -Recurse D:\GitProject\crm\runner-product\src\permissionsets\Sfoa_Crm_Chat_Access.permissionset-meta.xml "$temp\src\permissionsets\" -Force
Copy-Item D:\GitProject\crm\runner-product\manifest\crm-openclaw\package.xml "$temp\manifest\" -Force
@'
{ "packageDirectories": [{ "path": "src", "default": true }], "sourceApiVersion": "62.0" }
'@ | Set-Content "$temp\sfdx-project.json" -Encoding utf8
```

先做 check-only（强烈建议）：

```powershell
sf project deploy validate --manifest "$temp\manifest\package.xml" `
  --target-org <sandbox-alias> --test-level RunSpecifiedTests `
  --tests SfoaCrmChatIdentityTest --wait 30
```

通过后再部署：

```powershell
sf project deploy start --manifest "$temp\manifest\package.xml" `
  --target-org <sandbox-alias> --test-level RunSpecifiedTests `
  --tests SfoaCrmChatIdentityTest --wait 30
```

部署前必须显式核对目标 OrgId/实例，不要依赖含糊默认 Org。不要部署生产，不要全量 retrieve/推送。

## 3. Custom Setting 记录

Setup → Custom Settings → **SFoA CRM 聊天配置** → Manage → New（组织级），填写：

| 字段 | 值 |
| --- | --- |
| Enabled__c | true |
| Endpoint__c | `https://crm-chat.example.internal/crm`（实际接入服务基地址，含 `/crm`） |
| Certificate_Name__c | `SFOA_CRM_Chat_Signing`（证书 Unique Name） |
| Issuer__c | `sfoa-crm-apex` |
| Audience__c | `sfoa-crm-gateway` |
| Ttl_Seconds__c | 90 |

或使用 CLI（把值替换为实际值）：

```powershell
sf data create record --sobject SFOA_CRM_Chat_Config__c `
  --values "SetupOwnerId=00DC5000000lGFpMAM Enabled__c=true Endpoint__c=https://crm-chat.example.internal/crm Certificate_Name__c=SFOA_CRM_Chat_Signing Issuer__c=sfoa-crm-apex Audience__c=sfoa-crm-gateway Ttl_Seconds__c=90" `
  --target-org <sandbox-alias>
```

## 4. Permission Set 与入口

1. 将 `Sfoa_Crm_Chat_Access` 分配给需要使用的用户（最小范围；不要批量改 Profile）。
2. 打开目标 Lightning App → Setup → App Manager → 目标 app → Utility Bar → 添加 `sfoaCrmChatUtilityBar`；高度建议 480–560px。
3. 也可把 `sfoaCrmChat` 放到 Record/App/Home Page，但 Utility Bar 是首选。
4. 在 Setup → CSP Trusted Sites 添加接入服务 origin（如 `https://crm-chat.example.internal`），指令至少包含 `connect-src`。不要关闭 LWS/浏览器安全策略。

## 5. 接入服务部署

构建（在 MCP 工程）：

```bash
yarn workspace @sfoa/crm-gateway build
```

配置（示例，真实值只放受控 env；不要提交）：

```ini
CRM_BIND_HOST=127.0.0.1
CRM_PORT=8090
CRM_BASE_PATH=/crm
CRM_ALLOWED_ORIGINS=https://runnergroup--uat.sandbox.my.sfcrmproducts.cn
CRM_OPENCLAW_URL=http://127.0.0.1:18789/plugins/sfoa-crm
CRM_OPENCLAW_SERVICE_TOKEN=<与 OpenClaw 插件一致的随机值>
# 历史专用：Gateway 认证的只读路由（sessions.get）。优先专用只读 device token；
# 共享 gateway.auth.token 是文档化回退。只用于 history，不作为用户身份。
CRM_GATEWAY_HISTORY_TOKEN=<Gateway 只读 device token 或共享 Gateway token>
CRM_APEX_PUBLIC_KEY_PATH=/data/sfoa-enterprise-mcp/secrets/apex-signing-cert.pem
CRM_APEX_CERT_SHA256=<证书 DER SHA-256>
CRM_APEX_ISSUER=sfoa-crm-apex
CRM_APEX_AUDIENCE=sfoa-crm-gateway
CRM_APEX_ALLOWED_ORG_IDS=00DC5000000lGFpMAM
```

systemd 示例：

```ini
[Unit]
Description=SFoA CRM Chat Access Service
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/data/sfoa-enterprise-mcp/app
EnvironmentFile=/data/sfoa-enterprise-mcp/config/.env.local
ExecStart=/usr/bin/node /data/sfoa-enterprise-mcp/app/packages/sfoa-crm-gateway/dist/main.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

> `EnvironmentFile` 中必须包含 `SFOA_DB_*` 与 `CRM_*`。服务按 `EnvironmentFile` 的进程环境读取，不依赖 `.env.local` 的文件发现位置。

Nginx 反代（TLS 终止；必须关闭缓冲以支持 SSE）：

```nginx
location /crm/ {
    proxy_pass http://127.0.0.1:8090;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 660s;
    add_header X-Accel-Buffering no;
}
```

不要由 nginx 添加 `Access-Control-Allow-Origin`；CORS 由接入服务按精确 origin 处理。

健康检查：

```bash
curl -fsS http://127.0.0.1:8090/crm/health
curl -fsS http://127.0.0.1:8090/crm/ready
```

## 6. OpenClaw CRM 渠道插件

1. 复制 `integrations/openclaw/sfoa-crm-channel/` 到 `/data/openclaw/plugins/sfoa-crm-channel`（不要改 Core/node_modules/企微插件）。
2. 在 `/data/openclaw/secrets/credentials.json` 增加（值现场生成，不打印）：
   - `sfoaCrmServiceToken`：插件与接入服务共享的 service Bearer。
   - `sfoaCrmMcpToken`：MCP CRM 渠道凭据（同时写入 MCP 的 `MCP_CRM_CLIENT_TOKEN`）。
3. `plugins.load.paths` 增加插件路径；`plugins.entries`：
   - `sfoa-crm-channel.config.serviceToken` → SecretRef 到 `sfoaCrmServiceToken`。
   - `sfoa-crm-channel.config.allowRemoteService` 保持默认 `false`；只有接入服务与 Gateway 不在同一主机时才显式改为 `true`，并承担 service token 暴露面。
   - `sfoa-wecom-mcp-adapter.config.mcpCrmClientToken` → SecretRef 到 `sfoaCrmMcpToken`（企微 token 保持不变）。
4. **历史只读凭据**：`/plugins/sfoa-crm/history` 是 `auth:"gateway"` + `trusted-operator` 路由，调用官方
   `sessions.get`。接入服务必须配置 `CRM_GATEWAY_HISTORY_TOKEN`；优先由 Gateway 管理面签发专用只读
   device token，无法做到时才使用共享 `gateway.auth.token` 作为服务端回退。该凭据只用于 history，
   不能当作用户身份；history 路由仍默认只接受 loopback。不要在浏览器、LWC 或日志中出现它。
5. `openclaw config validate`；`openclaw plugins list` 应看到插件；`openclaw channels status` 应看到 `sfoa-crm`。
6. 插件注册需要重启 Gateway；在维护窗口执行 `systemctl restart openclaw-gateway`。不要激活第二条企微长连接。

插件健康（需 service token）：

```bash
TOKEN=$(...从 SecretRef 解析，不打印...)
curl -fsS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:18789/plugins/sfoa-crm/health
```

## 7. MCP 运行时启用

先迁移数据库：

```bash
yarn db:migrate
```

在 MCP 服务环境（`.env.local` 或 systemd EnvironmentFile）增加：

```ini
MCP_CRM_CHANNEL_ENABLED=true
MCP_CRM_CLIENT_TOKEN=<与 sfoaCrmMcpToken 相同>
MCP_PLATFORM_USER_HEADER_ALIASES=X-WeCom-User-Id,X-SFOA-CRM-User-Id
```

重启 `sfoa-mcp-server`（维护窗口）。启动日志应显示 `identitySources` 包含 `CRM_HEADER`；健康检查：

```bash
curl -fsS http://127.0.0.1:8080/health
```

WeCom 的 `MCP_WECOM_*` 保持不变；CRM 启用不会关闭企微。

## 8. 管理员身份绑定

对每个真实用户，先确认其现有 Identity Route 的 `platformUserId` 与 `salesforce_username`，再执行：

```bash
yarn workspace @sfoa/crm-gateway crm:bind \
  --org 00DC5000000lGFpMAM \
  --user 005XXXXXXXXXXXXXXX \
  --platform-user <现有工号> \
  --salesforce-username <该工号对应的 Salesforce Username> \
  --display-name "<显示名>"
```

- 缺失绑定 → 403 `CRM_IDENTITY_NOT_BOUND`，不会回退到管理员/上一个用户。
- 用户名不一致 → CLI 拒绝，防止绑错执行账号。
- 禁用：同一命令加 `--disable`。
- 查看：`yarn workspace @sfoa/crm-gateway crm:bind --list`。

## 9. 验证顺序

1. 接入服务 `/crm/health`、`/crm/ready`（DB/OpenClaw 均 UP）。
2. 插件 `/plugins/sfoa-crm/health`（service token）。
3. 沙盒 `SfoaCrmChatIdentityTest` 通过；部署 validate 通过。
4. 在真实 Lightning 页面打开 Utility Bar：显示当前账号；新建对话；发送只读查询；观察流式；停止；刷新恢复。
5. 两名真实用户各做一次只读查询，确认：
   - 返回结果与各自权限一致；
   - 提示“改用另一个用户/管理员”不改变执行主体；
   - MCP 审计 `identity_source=CRM_HEADER`、`platform_user_id` 正确、`salesforce_username` 正确。
6. 并发：两名用户同时发送；再 10–20 并发会话，检查无串号、无跨用户历史。
7. 审计关联：用 `yarn ai:audit --user <platformUserId> --since 24h` 或控制台按时间窗核对；插件日志中的 runId/sessionKey 与 CRM 运行记录关联。

## 10. 回退

按影响面从小到大：

1. **立即停用入口**：Custom Setting `Enabled__c=false`；Apex 拒绝签发新 token。已有聊天 token 最多 15 分钟内仍有效。
2. **移除 UI**：从 app Utility Bar 移除 `sfoaCrmChatUtilityBar`；取消 Permission Set 分配。
3. **停止接入服务**：`systemctl stop sfoa-crm-gateway`（或移除 unit）。
4. **MCP 关闭 CRM 渠道**：设置 `MCP_CRM_CHANNEL_ENABLED=false` 并重启 `sfoa-mcp-server`；企微/其他入口不受影响。
5. **OpenClaw 关闭插件**：禁用 `plugins.entries.sfoa-crm-channel`，移除 `mcpCrmClientToken`，重启 Gateway。
6. **删除绑定**：`DELETE FROM sfoa_crm_identity_binding WHERE ...`（先备份；只删本次创建的绑定）。
7. **删除 CRM 元数据**：先移除引用，再用 `runner-product/manifest/crm-openclaw/destructiveChanges.xml` 做 destructive deploy。不要删除既有业务组件。
8. **证书**：停用/删除 `SFOA_CRM_Chat_Signing`；同步移除接入服务公钥配置。轮换时两端必须一起更新。
9. **数据库**：迁移 016 是加性变更；无需要可不回滚。不要删除审计行；如需清理 CRM 表，先备份并按保留策略执行。

## 11. 需要用户集中完成的动作

- [ ] 明确批准沙盒 metadata 部署与 Apex 测试。
- [ ] 在 Salesforce 创建/确认签名证书，导出公开证书 PEM 与 SHA-256。
- [ ] 提供两名测试用户的 `platformUserId`、Salesforce User Id、Username 及绑定批准。
- [ ] 确认接入服务内网域名、TLS 证书、DNS、nginx 入口。
- [ ] 确认 Lightning 实际 origin（CSP/CORS）。
- [ ] 安排 `sfoa-mcp-server` / `openclaw-gateway` 重启窗口。
- [ ] 分配 Permission Set、添加 Utility Bar。
- [ ] 完成真人 UAT 与审计核对。

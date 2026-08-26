# 测试服务器部署指南（SFoA Enterprise MCP）

> 本文档基于**实际部署的测试服务器**（`crm-ex-test02` / `192.168.156.203`）归纳而成：目录布局、Nginx 位置、systemd 单元文件、本机打包部署流程、启动/停止/查看日志等命令，均与本次一起完成部署的服务器一致，可直接照抄执行。同时汇总了本次部署过程中踩过的所有坑及对应修复。

---

## 1. 本次部署概况

### 1.1 服务器信息（实际值）

| 项目 | 实际值 |
| --- | --- |
| 主机名 | `crm-ex-test02` |
| IP | `192.168.156.203` |
| 操作系统 | Rocky Linux 9，SELinux **Enforcing**（强制模式） |
| Node.js | `v22.23.1`（NodeSource RPM 安装） |
| Yarn | `1.22.22`（Classic；已 `corepack disable`） |
| 进程管理 | systemd（root 运行） |
| 共享 MySQL | `192.168.156.127:3306`，库 `sfoa_enterprise_mcp`，账号 `crm_user` |
| Salesforce 实例 | `https://runnergroup--uat.sandbox.my.sfcrmproducts.cn` |
| 诊断用户 | `crm_admin2@runner-corp.com.cn.uat` |
| 对外访问 | Admin Web `http://192.168.156.203/`，Admin API `/admin/api/`，MCP `/mcp` |
| 本机（开发） | Windows，项目位于 `D:\GitProject\sfoa-enterprise-mcp`，Git Bash 操作 |

### 1.2 部署形态（与生产一致的三进程结构）

```text
浏览器 / MCP Client
        │  HTTP 80
        ▼
      Nginx（监听 192.168.156.203:80）
        ├── /           静态 Admin Web（packages/sfoa-admin-web/dist）
        ├── /admin/api/* ───▶ Admin API   127.0.0.1:8081
        └── /mcp         ───▶ MCP Runtime 127.0.0.1:8080
        ▼
  共享 MySQL 192.168.156.127:3306 / sfoa_enterprise_mcp
```

两个 Node 服务监听：**MCP `8080`、Admin API `8081`**；浏览器通过 Nginx 访问前端和 API。

### 1.3 服务器目录布局（实际）

```text
/data/sfoa-enterprise-mcp/
├── app/                          ← 仓库根（解包后的项目目录）
│   ├── package.json
│   ├── yarn.lock
│   ├── packages/
│   ├── node_modules/
│   └── .env.local  →  ../config/.env.local   （软链）
├── config/
│   └── .env.local                ← 真实配置文件（系统维护，不入库）
└── secrets/
    └── private.pem               ← JWT 私钥（chmod 400）
```

关键点：

- **仓库根 = `/data/sfoa-enterprise-mcp/app`**（含 `packages/` 的那个目录）。应用按「模块路径里 `packages/` 往上一层」解析仓库根，因此运行时必须保持该结构。
- **配置文件单独放在 `/data/sfoa-enterprise-mcp/config/.env.local`**，用软链让 `app/.env.local` 指向它。这样重打包、覆盖 `app/` 目录不会动到配置。
- **私钥在 `/data/sfoa-enterprise-mcp/secrets/private.pem`**，`JWT_PRIVATE_KEY_PATH` 指向它（打包时 `--exclude='*.pem'`，私钥单独 `scp` 上传）。

---

## 2. 前置准备

### 2.1 本机（Windows / Git Bash）

- 已安装 Node.js（v24 可用）、Git Bash、Git。
- 项目在 `D:\GitProject\sfoa-enterprise-mcp`，当前分支 `feature/p6-agent-playbook`。
- 打包工具：Git Bash 自带 `tar`、`scp`；装 `rsync` 可选（方式三）。

### 2.2 服务器（Rocky Linux 9）

```bash
# Node.js 22 LTS（NodeSource RPM）
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs

# Yarn Classic 1.22.x（Node 自带 corepack 会走 Berry，务必先禁用）
sudo corepack disable
npm install -g yarn@1.22.22

# 网络/探测工具（可选）
sudo dnf install -y nmap-ncat mysql nginx

node -v        # 期望 v22.x
yarn -v        # 期望 1.22.x
git --version
```

> ⚠️ 若 `yarn -v` 显示 4.x/berry，是 corepack 拦截，`corepack disable` 后重装 `yarn@1.22.22`。

---

## 3. 从本机打包部署（本次实际使用的流程）

> 服务器**不需要 Git**。代码改动在本机开发，打包上传到服务器解压后构建运行。本次实际用的是**方式二（tar.gz + scp）**。

### 3.1 打包（Git Bash 本机执行）

```bash
cd /d/GitProject/sfoa-enterprise-mcp

tar --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='tmp' \
    --exclude='secrets' --exclude='.env.local' --exclude='*.pem' --exclude='*.key' \
    --exclude='*.tsbuildinfo' --exclude='.wireit' \
    -czf ../sfoa-deploy.tar.gz .
```

> **打包必须排除**：`node_modules`（Windows 原生二进制不能搬去 Linux，服务器重新 `yarn install`）、`.git`、`dist`（构建产物，服务器重新构建）、密钥/本地环境文件、以及 **`*.tsbuildinfo` / `.wireit`**（增量构建标记，带过去会导致 wireit 误判「已最新」跳过 emit，见 §13 坑 #3）。
>
> 压缩包输出到仓库**外层** `../sfoa-deploy.tar.gz`，避免「把压缩包写进正在归档的目录」导致 `tar: .: file changed as we read it`。若根目录已有失败残留的 `sfoa-deploy.tar.gz`，先 `rm -f`。

### 3.2 上传（Git Bash 本机执行）

```bash
scp ../sfoa-deploy.tar.gz root@192.168.156.203:/tmp/

# 单独上传环境与密钥（被排除在包外，且不入库）
scp D:/GitProject/sfoa-enterprise-mcp/private.pem root@192.168.156.203:/data/sfoa-enterprise-mcp/secrets/private.pem
```

> 若本机配置了 SSH 别名（如 `crm-test02`），把 `root@192.168.156.203` 换成别名即可。

### 3.3 服务器解压

```bash
mkdir -p /data/sfoa-enterprise-mcp/app
tar -xzf /tmp/sfoa-deploy.tar.gz -C /data/sfoa-enterprise-mcp/app
```

> 仅更新代码时，可增量 rsync（本机已装 rsync 时最方便）：

```bash
rsync -avz --delete \
  --exclude node_modules --exclude .git --exclude dist --exclude tmp \
  --exclude secrets --exclude .env.local --exclude '*.pem' --exclude '*.key' \
  --exclude '*.tsbuildinfo' --exclude '.wireit' \
  /d/GitProject/sfoa-enterprise-mcp/ root@192.168.156.203:/data/sfoa-enterprise-mcp/app/
```

### 3.4 服务器安装依赖（仅首次/依赖变化时）

```bash
cd /data/sfoa-enterprise-mcp/app
yarn install --frozen-lockfile
```

> 本仓库 `workspaces.nohoist=["**"]`，每个 workspace 有独立 `node_modules`，必须**在根目录整体安装**，不能只装单个包。依赖没变时跳过，`node_modules` 装一次后一直有效。

---

## 4. 数据库：使用共享库

- 共享库在 **`192.168.156.127:3306`**，库名 **`sfoa_enterprise_mcp`**，应用账号 **`crm_user`**（测试环境用 `%` 网段授权）。
- 本次数据来源：把本机库的 6 张治理表同步到共享库（`sfoa_identity_route`、`sfoa_identity_credential`、`sfoa_tool_control`、`sfoa_dml_policy`、`sfoa_diagnostic_config`、`sfoa_runtime_setting`），跳过 `sfoa_audit_log` 与 `sfoa_schema_migration`。
- **若从全新建库开始**，两种方式任选其一：
  1. 共享库上先建库建账号，再在服务器 `cd /data/sfoa-enterprise-mcp/app && yarn db:migrate && yarn p5:bootstrap`；
  2. 或在共享库一次性导入 `docs/sfoa/SFOA_ENTERPRISE_MCP_SCHEMA.sql`（含 001/002/003 迁移 + 迁移记录），之后跳过 `db:migrate`。

> ⚠️ **加密密钥必须与本地一致**：同步过去的 `sfoa_identity_credential` 密文是用本机 `MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY` 加密的。服务器 `.env.local` 必须配置**完全相同**的值，否则 USER_BOUND 凭证无法解密、后台读不出明文 Token。若服务器打算用新密钥，需到后台对这些路由「重新生成 Token」。

---

## 5. 配置 `.env.local`

### 5.1 放置方式（本次采用：config/ 单独放 + 软链）

```bash
# 1) 配置文件放 /data/sfoa-enterprise-mcp/config/.env.local（不在 app/ 里，重打包不覆盖）
mkdir -p /data/sfoa-enterprise-mcp/config
cp /data/sfoa-enterprise-mcp/app/.env.example /data/sfoa-enterprise-mcp/config/.env.local
vim /data/sfoa-enterprise-mcp/config/.env.local

# 2) 软链：应用只读「仓库根」的 .env.local（= app/ 下）
cd /data/sfoa-enterprise-mcp/app
ln -s ../config/.env.local .env.local
ls -la .env.local        # 应显示 lrwxrwxrwx ... -> ../config/.env.local
```

> 应用通过模块路径解析到仓库根（含 `packages/` 的目录 = `/data/sfoa-enterprise-mcp/app`），只读 `app/.env.local`。放 `config/` 里不会生效；软链让 `app/.env.local` 指向 `config/.env.local`，两全其美。**不要在 `app/` 下保留另一个 `.env.local` 实体文件**（历史曾因 `app/` 下残留带 CRLF 的旧文件导致配置「改了没用」）。

### 5.2 本次实际使用的关键配置项

```dotenv
# ── 运行模式（mysql 权威）──
SFOA_CONTROL_PLANE_MODE=mysql

# ── 共享 MySQL（实际 192.168.156.127 / crm_user）──
SFOA_DB_HOST=192.168.156.127
SFOA_DB_PORT=3306
SFOA_DB_NAME=sfoa_enterprise_mcp
SFOA_DB_USER=crm_user
SFOA_DB_PASSWORD=<共享库密码>
SFOA_DB_SSL_MODE=disabled            # 共享库未开 TLS 时
SFOA_DB_CONNECTION_LIMIT=10
SFOA_DB_QUEUE_LIMIT=100
SFOA_DB_CONNECT_TIMEOUT_MS=10000

# ── Salesforce 身份（mysql 模式下用户名由库内“身份路由”管理）──
SFOA_INSTANCE_URL=https://runnergroup--uat.sandbox.my.sfcrmproducts.cn
CONNECTED_APP_CLIENT_ID=<Connected-App-Client-Id>
JWT_PRIVATE_KEY_PATH=/data/sfoa-enterprise-mcp/secrets/private.pem

# ── Admin API（Nginx 反代 /admin/api/）──
SFOA_ADMIN_BIND_HOST=127.0.0.1
SFOA_ADMIN_PORT=8081
SFOA_ADMIN_ALLOWED_ORIGIN=http://192.168.156.203
SFOA_ADMIN_USERNAME=admin
SFOA_ADMIN_PASSWORD=<管理员密码，明文>
SFOA_ADMIN_SESSION_SECRET=<48字节base64url随机串>
SFOA_ADMIN_COOKIE_SECURE=false      # 内网明文 HTTP 时；生产 HTTPS 需 true
SFOA_ADMIN_SESSION_TTL_SECONDS=28800
SFOA_ADMIN_LOGIN_MAX_ATTEMPTS=5
SFOA_ADMIN_LOGIN_WINDOW_MS=900000

# ── MCP Runtime（Nginx 反代 /mcp）──
MCP_BIND_HOST=0.0.0.0
MCP_PORT=8080
MCP_PATH=/mcp
MCP_PUBLIC_URL=http://192.168.156.203/mcp
MCP_AUTH_MODE=internal_bearer
MCP_CLIENT_TOKEN=<内部服务Token，≥16字符>
MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY=<32字节base64url，与本地一致！>
MCP_PLATFORM_USER_HEADER=X-Platform-User-Id
MCP_REQUEST_TIMEOUT_MS=180000
MCP_TOOL_TIMEOUT_MS=120000
# 经 Nginx 反代后 Host/Origin 变为服务器 IP，必须显式放行，否则 403
MCP_ALLOWED_HOSTS=127.0.0.1:8080,localhost:8080,192.168.156.203
MCP_ALLOWED_ORIGINS=http://127.0.0.1:8080,http://localhost:8080,http://192.168.156.203

# ── 无头 Linux 钥匙串（本次根因修复；代码已自动引导，保留无副作用）──
SF_USE_GENERIC_UNIX_KEYCHAIN=true

# ── P6-ID-02 Buntu（按需开启）──
MCP_BUNTU_IDENTITY_ENABLED=true
MCP_BUNTU_VALIDATE_TOKEN_URL=<Buntu 校验接口>
MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED=false
```

### 5.3 密钥生成命令

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))"   # SFOA_ADMIN_SESSION_SECRET
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"   # MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY
node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))"   # MCP_CLIENT_TOKEN
```

### 5.4 配置文件的「三不要三必须」

| 规则 | 说明 |
| --- | --- |
| ❌ 不要 `source` 它 | `.env.local` 是 dotenv 格式，不是 shell 脚本；含空格/`<...>`/`$`/反引号/`\r` 的行会被 bash 当命令执行报 `: command not found`，且会把带 `\r` 的旧值灌进 shell 环境（`process.env` 优先级高于文件，污染后「文件改好了报错却不变」）。应用自己会读文件，无需 source。 |
| ❌ 不要保留 Windows CRLF | 本机 Windows 编辑后行尾是 `\r\n`，应用的解析器不剥 `\r`，值变成 `internal_bearer\r` 等导致枚举校验失败。传输前先转：`sed -i 's/\r$//' /data/sfoa-enterprise-mcp/config/.env.local`。 |
| ❌ 不要残留 `<...>` 占位符 | 逐个替换为真实值，尤其是密码、加密密钥、Token。 |
| ✅ 必须放在软链的 `app/.env.local`（指向 config/） | 应用只读仓库根的 `.env.local`。 |
| ✅ 改完后必须 `restorecon` | `sed -i`/覆盖写会重建文件、SELinux 标签退回 `default_t`，systemd 读 EnvironmentFile 会报 Permission denied。 |
| ✅ 必须让 `MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY` 与本地逐字符一致 | 否则已同步的 USER_BOUND 凭证无法解密。 |

```bash
# 改完配置后（每次覆盖写都必须执行）
restorecon -v /data/sfoa-enterprise-mcp/config/.env.local
ls -lZ /data/sfoa-enterprise-mcp/config/.env.local   # 必须显示 :etc_t，而不是 default_t
```

---

## 6. 构建（依赖顺序）

全新解包后所有 `dist` 都不存在（打包排除了 `dist`、无 postinstall 钩子），必须按**依赖顺序**完整构建。**顺序不能乱**：

```bash
cd /data/sfoa-enterprise-mcp/app
yarn workspace @sfoa/agent-playbook build
yarn workspace @salesforce/mcp-provider-api build        # 最底层，最容易漏掉！
yarn workspace @salesforce/mcp-provider-dx-core build
yarn workspace @sfoa/mcp-provider-sfoa-context build
yarn workspace @sfoa/mcp-provider-sfoa-dml build
yarn workspace @sfoa/identity-runtime build              # 依赖 provider-api / dx-core
yarn workspace @sfoa/control-plane build                 # 依赖 identity-runtime
yarn workspace @sfoa/mcp-server build                    # 依赖上述全部
yarn workspace @sfoa/admin-api build                     # 依赖 mcp-server
yarn workspace @sfoa/admin-web build                     # tsc + vite，产物在 packages/sfoa-admin-web/dist
```

> 不要用根目录 `yarn build`（并行跑会因依赖方 `dist` 未产出而竞态失败）。构建报缺某个 `@sfoa/*` / `@salesforce/mcp-provider-*` → 对应 workspace 没先构建；`@salesforce/mcp-provider-api` 是最底层。
>
> ⚠️ 已按顺序构建仍报 `TS2307 ... mcp-provider-api`（wireit 提示「is up to date ... tsconfig.tsbuildinfo」）→ 打包带了本地 `*.tsbuildinfo` 增量标记，误判已最新跳过 emit。清掉重建：
> ```bash
> find packages -name '*.tsbuildinfo' -type f -delete
> find packages -name '.wireit' -type d -prune -exec rm -rf {} + 2>/dev/null
> # 再按上面顺序重建
> ```

---

## 7. systemd 服务管理（本次实际用法）

### 7.1 单元文件（/etc/systemd/system/）

**`/etc/systemd/system/sfoa-mcp-server.service`：**

```ini
[Unit]
Description=SFoA Enterprise MCP Runtime
After=network.target

[Service]
Type=simple
WorkingDirectory=/data/sfoa-enterprise-mcp/app
EnvironmentFile=/data/sfoa-enterprise-mcp/config/.env.local
ExecStart=/usr/bin/node /data/sfoa-enterprise-mcp/app/packages/sfoa-mcp-server/dist/main.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/sfoa-admin-api.service`：** 同上，`Description` 换成 `SFoA Enterprise MCP Admin API`，`ExecStart` 换成 `packages/sfoa-admin-api/dist/main.js`。

> 本次部署两个服务**以 root 运行**（unit 里不写 `User=`）。这决定 SFDX 认证存储目录是 `/root/.sfdx`，且能读到 `secrets/private.pem`（`chmod 400`）。

### 7.2 注册并启动

```bash
systemctl daemon-reload
systemctl enable --now sfoa-mcp-server sfoa-admin-api
systemctl status sfoa-mcp-server sfoa-admin-api --no-pager
```

> 单元文件若改过（新增/删除环境变量等），都要先 `systemctl daemon-reload` 再 `restart`。

---

## 8. Nginx 反向代理与静态托管

- 安装：`sudo dnf install -y nginx && sudo systemctl enable --now nginx`。
- 配置位置：**`/etc/nginx/conf.d/*.conf`**（默认 `nginx.conf` 会 include 该目录；本次的 server 块放于此）。
- 对外只开放 **80 端口**（内网明文 HTTP）；8080/8081 仅服务进程监听，不直接暴露。

**本次实际使用的 server 块**（写入 `/etc/nginx/conf.d/sfoa.conf`，重载 `systemctl reload nginx`）：

```nginx
server {
    listen 80;
    server_name 192.168.156.203;
    client_max_body_size 20m;

    # React Admin Web（Vite 构建产物）
    root /data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist;
    index index.html;

    # ── Admin API ──
    location /admin/api/ {
        proxy_pass http://127.0.0.1:8081/admin/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 30s;
        proxy_send_timeout 180s;
        proxy_read_timeout 180s;
    }

    # ── MCP Streamable HTTP（关闭缓冲）──
    location = /mcp {
        proxy_pass http://127.0.0.1:8080/mcp;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ── SPA history 路由回退 ──
    location / {
        try_files $uri /index.html;
        add_header Cache-Control "no-cache";
    }
}
```

> **SELinux 配套**（见 §9）：静态目录需打 `httpd_sys_content_t` 标签；反代到 8080/8081 需 `setsebool -P httpd_can_network_connect 1`，否则分别报 403 / 502。

---

## 9. SELinux（Rocky 9 默认 Enforcing，本次踩坑最多）

### 9.1 静态 Admin Web 403（nginx 读不了 dist）

```bash
# 给 dist 打 httpd_sys_content_t 标签（semanage 规则持久，restorecon 应用）
semanage fcontext -a -t httpd_sys_content_t '/data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist(/.*)?'
restorecon -Rv /data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist

# 验证：index.html 的 context 应变为 httpd_sys_content_t
ls -lZ /data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist/index.html
```

> `semanage: command not found` 时先 `dnf install -y policycoreutils-python-utils`。
> 以后**每次重新构建 admin-web** 都要再跑一次 `restorecon -Rv`（新文件 context 又会退回 `default_t`）。

### 9.2 反代 502（nginx 连不上 8080/8081）

```bash
setsebool -P httpd_can_network_connect 1
getsebool httpd_can_network_connect   # 应显示 on
```

### 9.3 systemd 读环境文件失败（Result: resources / Permission denied）

```bash
# 把 .env.local 打上 etc_t 标签（systemd 和 node 进程才能读）
semanage fcontext -a -t etc_t '/data/sfoa-enterprise-mcp/config/.env.local'
restorecon -v /data/sfoa-enterprise-mcp/config/.env.local
ls -lZ /data/sfoa-enterprise-mcp/config/.env.local   # 应显示 etc_t
```

> ⚠️ **每次用 `sed -i` / 覆盖写 config/.env.local 后必须重跑 `restorecon`**——重建文件会丢标签。这是本次反复踩的坑。

---

## 10. 启动 / 停止 / 重启 / 查看日志（速查）

### 10.1 启动

```bash
systemctl start sfoa-mcp-server sfoa-admin-api
# 设置开机自启（已 enable 的无需重复）
systemctl enable --now sfoa-mcp-server sfoa-admin-api
```

### 10.2 停止

```bash
systemctl stop sfoa-mcp-server sfoa-admin-api
```

### 10.3 重启（改配置/换代码后）

```bash
systemctl restart sfoa-mcp-server sfoa-admin-api
systemctl status sfoa-mcp-server sfoa-admin-api --no-pager
```

### 10.4 查看状态

```bash
systemctl status sfoa-mcp-server sfoa-admin-api --no-pager     # 是否 active
systemctl is-active sfoa-mcp-server sfoa-admin-api             # 快速输出 active
ps -eo user,pid,args | grep -E 'sfoa-(mcp-server|admin-api)' | grep -v grep
```

### 10.5 查看运行时日志

```bash
# 实时跟踪（Ctrl+C 退出）
journalctl -u sfoa-mcp-server -f
journalctl -u sfoa-admin-api -f

# 最近 N 条
journalctl -u sfoa-mcp-server -n 100 --no-pager
journalctl -u sfoa-admin-api -n 100 --no-pager

# 按关键词过滤（如诊断验证失败）
journalctl -u sfoa-admin-api --since '-15 minutes' --no-pager | grep -iE 'verification|invalid_grant|NamedOrg|MCP_METADATA|correlation'

# 按时间窗
journalctl -u sfoa-mcp-server --since '2026-08-26 14:00:00' --until '2026-08-26 15:00:00' --no-pager
```

日志是 JSON 行：启动成功见 `"event":"sfoa_runtime_started"`、启动失败见 `"event":"sfoa_runtime_start_failed"` + `message`。

### 10.6 健康检查

```bash
curl -i http://127.0.0.1:8080/health            # MCP 运行时
curl -i http://127.0.0.1:8081/admin/api/ready   # Admin API（含 DB/schema 就绪）
curl -i http://192.168.156.203/admin/api/ready  # 经 Nginx 对外
curl -I http://192.168.156.203/                 # 前端首页
```

---

## 11. 验证（浏览器）

1. 打开 `http://192.168.156.203/login`，用 `SFOA_ADMIN_USERNAME` / `SFOA_ADMIN_PASSWORD` 登录。
2. 「系统状态」确认运行模式为 `mysql`、`MCP_PUBLIC_URL` 正确。
3. 「用户身份路由」新建路由 → 保存 → 自动生成 USER_BOUND 凭证并弹出「接入配置」。
4. 「诊断」配置用户名后运行「验证 Diagnostic Connection」→ 应 **PASS**。
5. 如需 WorkBuddy/Dify：复制 WorkBuddy JSON 到自定义连接器做只读测试调用。

---

## 12. 更新与重新部署

日常改动代码后的更新流程（本机 → 服务器）：

```bash
# 1. 本机：重新打包上传（§3.1/3.2），服务器解压（§3.3）
cd /d/GitProject/sfoa-enterprise-mcp
tar --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='tmp' \
    --exclude='secrets' --exclude='.env.local' --exclude='*.pem' --exclude='*.key' \
    --exclude='*.tsbuildinfo' --exclude='.wireit' \
    -czf ../sfoa-deploy.tar.gz .
scp ../sfoa-deploy.tar.gz root@192.168.156.203:/tmp/
# 服务器上：
tar -xzf /tmp/sfoa-deploy.tar.gz -C /data/sfoa-enterprise-mcp/app

# 2. 服务器：依赖没变就跳过 install
cd /data/sfoa-enterprise-mcp/app
# yarn install --frozen-lockfile   # 仅 package.json / yarn.lock 变化时

# 3. 有新迁移才跑（先 db:status 确认）
# yarn db:status && yarn db:migrate

# 4. 按依赖顺序重建（§6 的 10 条，只改单包也可只 build 它 + 依赖它的包）
# 5. 重启两个服务
systemctl restart sfoa-admin-api sfoa-mcp-server

# 6. 若构建了 admin-web，重打静态目录 SELinux 标签（§9.1）
restorecon -Rv /data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist

# 7. 验证
curl -s http://127.0.0.1:8081/admin/api/ready
curl -s http://127.0.0.1:8080/health
```

> 已按代码级自愈（方案B）部署后，**不需要**再手工种 `/root/.sfdx`，也不用手工加 `SF_USE_GENERIC_UNIX_KEYCHAIN=true`（代码在启动时自动引导 + 种子化）。若需验证自愈：`rm -rf /root/.sfdx` + 从 `.env.local` 删掉该行 → 重启 → `ls /root/.sfdx/*.json` 应出现各用户种子文件，浏览器诊断仍 PASS。

---

## 13. 本次部署踩坑记录（含修复）

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | `tar: .: file changed as we read it`（exit 1） | 压缩包写进了正在归档的目录 | 打包输出到仓库**外层** `../sfoa-deploy.tar.gz`；残留包先 `rm -f` |
| 2 | 构建报 `TS2307: Cannot find module '@sfoa/agent-playbook'` | 依赖 workspace 的 `dist` 未构建（打包排除了 dist），且构建顺序不对 | 按 §6 依赖顺序先构建依赖包 |
| 3 | 构建报 `TS2307 ... @salesforce/mcp-provider-api`（wireit 提示「is up to date」） | 打包把本地 `*.tsbuildinfo` / `.wireit` 带上了服务器，增量构建误判跳过 emit | `find packages -name '*.tsbuildinfo' -delete` 并删 `.wireit`，重建；打包 exclude 增加 `*.tsbuildinfo` / `.wireit` |
| 4 | `source .env.local` 报一堆 `: command not found` | `.env.local` 是 dotenv 格式不是 shell 脚本，部分行被当命令执行 | **不要 source**；应用自己读文件 |
| 5 | 启动报 `MCP_AUTH_MODE: Invalid enum value ... received 'internal_bearer\r'` | Windows CRLF，应用解析器不剥 `\r`，值带 `\r`，枚举校验 fail-closed | `sed -i 's/\r$//'` 整个文件；本机传输前先转行尾 |
| 6 | 文件已改干净仍报 `\r` | 之前 `source` 把带 `\r` 的值写进了 shell 环境，`process.env` 优先于文件 | `for v in $(env \| cat -A \| grep '\^M' \| cut -d= -f1); do unset "$v"; done`（或 `env -i ...`） |
| 7 | 配置放 `config/` 不生效 / 报了 `\r` 但 config/ 那份已改好 | 应用只读仓库根 `app/.env.local`；`app/` 下有残留旧文件 | `ln -s ../config/.env.local app/.env.local`，删除 `app/` 下实体旧文件 |
| 8 | 首页 403 `(13: Permission denied)` | SELinux：dist 是 `default_t`，nginx 只读 `httpd_sys_content_t` | `semanage fcontext -a -t httpd_sys_content_t` + `restorecon -Rv`（每次重建后重跑） |
| 9 | `/admin/api/`、`/mcp` 反代 502 | SELinux 禁止 nginx 发起网络连接 | `setsebool -P httpd_can_network_connect 1` |
| 10 | `systemctl status` 显示 `Unit ... could not be found` | `.service` 文件不在 `/etc/systemd/system/` | 重建到正确位置 + `systemctl daemon-reload` + `enable --now` |
| 11 | systemd 服务 `Result: resources` 崩溃循环 | SELinux 拦 systemd 读 `EnvironmentFile`（`default_t`） | `.env.local` 打 `etc_t` 标签；**每次覆盖写后重 `restorecon`** |
| 12 | 登录报 `MCP_ADMIN_ORIGIN_NOT_ALLOWED` | `SFOA_ADMIN_ALLOWED_ORIGIN` 还是本机开发值 | 改为 `http://192.168.156.203`，同时改 `MCP_ALLOWED_HOSTS/ORIGINS`，`restorecon` 后重启 |
| 13 | 系统诊断验证 `MCP_ADMIN_VERIFICATION_FAILED` | ① dx-core `retrieve_metadata` 按用户名查本地 SFDX store，`~/.sfdx/<user>.json` 缺失抛 `NamedOrgNotFoundError`；② 无头 Linux 上 `@salesforce/core` 的 Crypto 走 DBus SecretService 失败 → `orgs.write()` 静默 no-op → auth 文件写不进 | 设 `SF_USE_GENERIC_UNIX_KEYCHAIN=true`（改走文件钥匙串）+ 种子化 `/root/.sfdx/<user>.json`；**已代码级固化（方案B）**：启动自动引导 + 自动种子化，重部署/清 `.sfdx` 不再复发 |
| 14 | 验证失败页面只显示笼统 `MCP_ADMIN_VERIFICATION_FAILED`，看不到真实原因 | `safeVerificationError` 未识别 `ContextRuntimeError`，把 `MCP_METADATA_CONTEXT_FAILED` 等真实码吞掉 | **已代码级修复**：`safeVerificationError` 补 `instanceof ContextRuntimeError`，真实错误码（7 个）不再被吞 |
| 15 | 粘贴 `cat > /tmp/xx.cjs <<'EOF'` 后回车不执行 / 语法错 | 粘贴时带了 `>` 提示符或前导空格，heredoc 被截断/换行错位 | 整块**顶格**粘贴（每行无缩进），结束符 `EOF` 单独一行顶格，再另起一行执行 `node /tmp/xx.cjs` |

---

## 14. 常用命令速查

| 目的 | 命令 |
| --- | --- |
| 本机打包 | `cd /d/GitProject/sfoa-enterprise-mcp && tar ... -czf ../sfoa-deploy.tar.gz .`（见 §3.1） |
| 本机上传 | `scp ../sfoa-deploy.tar.gz root@192.168.156.203:/tmp/` |
| 上传私钥 | `scp D:/GitProject/sfoa-enterprise-mcp/private.pem root@192.168.156.203:/data/sfoa-enterprise-mcp/secrets/private.pem` |
| 服务器解压 | `tar -xzf /tmp/sfoa-deploy.tar.gz -C /data/sfoa-enterprise-mcp/app` |
| 安装依赖 | `cd /data/sfoa-enterprise-mcp/app && yarn install --frozen-lockfile` |
| 构建全部 | §6 的 10 条 `yarn workspace ... build`（依赖顺序） |
| 迁移 | `cd /data/sfoa-enterprise-mcp/app && yarn db:status && yarn db:migrate` |
| 治理引导 | `yarn p5:bootstrap` |
| 启动 | `systemctl start sfoa-mcp-server sfoa-admin-api` |
| 停止 | `systemctl stop sfoa-mcp-server sfoa-admin-api` |
| 重启 | `systemctl restart sfoa-admin-api sfoa-mcp-server` |
| 状态 | `systemctl status sfoa-mcp-server sfoa-admin-api --no-pager` |
| 实时日志 | `journalctl -u sfoa-mcp-server -f` / `journalctl -u sfoa-admin-api -f` |
| 最近日志 | `journalctl -u sfoa-mcp-server -n 100 --no-pager` |
| 健康检查 | `curl -i http://127.0.0.1:8080/health`、`curl -i http://127.0.0.1:8081/admin/api/ready` |
| 对外验证 | `curl -I http://192.168.156.203/`、`curl -i http://192.168.156.203/admin/api/ready` |
| 改配置后重打标签 | `restorecon -v /data/sfoa-enterprise-mcp/config/.env.local` |
| 重建 admin-web 后重打标签 | `restorecon -Rv /data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist` |
| 数据库查询 | `mysql -h 192.168.156.127 -P 3306 -u crm_user -p sfoa_enterprise_mcp -e "SELECT ..."` |

---

## 15. 参考文档

- 生产部署与 Nginx/HTTPS/备份：`docs/sfoa/P5_DEPLOYMENT.md`
- 本地开发启动与治理配置：`docs/sfoa/P5_LOCAL_SETUP.md`
- 反向代理与暴露模型：`docs/sfoa/P2_REVERSE_PROXY.md`
- 一键建库 SQL：`docs/sfoa/SFOA_ENTERPRISE_MCP_SCHEMA.sql`
- USER_BOUND 身份路由凭证生命周期：`docs/sfoa/P6_ID_01_USER_BOUND_CREDENTIAL.md`
- Buntu（小犇/Dify）真实用户身份：`docs/sfoa/P6_ID_02_BUNTU_TOKEN_IDENTITY.md`
- Dify / WorkBuddy 接入：`docs/agent/DIFY_SETUP.md`、`docs/agent/WORKBUDDY_SETUP.md`

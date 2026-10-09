# 生产服务器部署指南（SFoA Enterprise MCP）

> 本文档基于**实际搭建/部署的生产服务器**（`crm-mcp-prod` / `192.168.155.207`）归纳而成：首次从空机搭建、目录布局、Nginx 位置、systemd 单元文件、本机打包部署流程、启动/停止/查看日志等命令，均与本次实际部署的服务器一致，可直接照抄执行。同时汇总了本次搭建踩过的坑（重点：**出口网络受接入认证网关管控**，详见 §2.2 / §13）。

---

## 部署记录 · 生产激活收尾：企微通道上线 + 诊断工具实弹验证（2026-10-09 晚）

| 项 | 值 |
| --- | --- |
| 企微通道 | 按 §16.5 激活（用户提供的生产机器人 botId/secret，经 600 临时文件 + `ssh 'cat >'` 就地补丁）：`channels.wecom.enabled=true`、移除 `pendingOperatorCredentials`、`credentials.json` 补 `wecomBotId/wecomBotSecret`、双文件先备份 600。网关**先判定 `channels.wecom.*` 变更属热重载**（改配置即生效），本次仍按流程重启取干净状态 |
| 企微验收 | 重启后网关日志：`WebSocket 已连接 → 认证成功 → 已认证`（出站 `wss://openws.work.weixin.qq.com`）+ 30 秒心跳；插件 `wecom-openclaw-plugin` 转 enabled；`wecom-send-media`/`wecom-send-template-card` 等 wecom 系 Skill ready；监听 `192.168.155.207:18789`；近 400KB 日志 0 ERROR。`state/wecom-cli` 属按需懒初始化（激活时尚未生成，测试服亦为激活数日后出现） |
| 诊断工具（P10 §7「生产就绪」项落地） | 生产为 **mysql 模式：诊断身份在库内**（`diagnostic` 配置 id 1 = `crm_admin2@runner-corp.com.cn`，`enabled=true`，`verificationStatus=PASS`，`lastVerifiedAt 2026-10-09T09:42:20Z`）；**`SFOA_DIAGNOSTIC_USERNAME` 仅 env 模式需要**（`config.ts:332`），生产不需要、未写入 env。以普通 `USER_BOUND` 调用者实测 5 个只读诊断工具（`get_org_limits`/`get_platform_diagnostics`/`explain_field_access`/`list_metadata_components`/`get_apex_logs`）**全部 PASS**（`executionRole=DIAGNOSTIC`，逐条 `MCP_TOOL_CALL` 审计落行）；`set_trace_flag` 按 ADR-0029 未在生产调用 |
| DML 门禁事件 | 17:42:02（CST）一名控制台管理员（来源 172.70.1.156，控制台 DML 页面）将唯一 DML 策略行 `Lead` **取消启用**并保存（`PUT /admin/api/dml-policies/1`，审计 `UPDATE_DML_POLICY`）→ 因 `create_record`/`update_record` 处于启用，fail-closed 门禁令**全部**认证 MCP 请求 500 `MCP_DML_CONFIGURATION_INVALID`。17:48:28 以 rowVersion 4→5 恢复 `enabled=true`（审计留痕），17:57 复验全绿。分析见 §13 坑 #17 |
| 身份路由 | 18/18 enabled、0 disabled、凭据全部 ACTIVE（控制台「身份路由」页无可开启项）；库内诊断用户名与既有启用路由无冲突 |
| 安全观察 | 同一来源 172.70.1.156 当日 3 次未带 token 连接 `:18789`（09:47/09:48/09:50Z）均被网关 token 认证拒绝（`unauthorized conn`，无影响）；其余 WARN 均为既有预期项 |
| 仍待办 | 真人 UAT（企微消息 → 回复 → SFOA 工具 → 审计落行；再测一条带附件消息）——见 §16.7 |

---

## 部署记录 · P10 全量升级 + 迁移 014 + 29 工具启用 + OpenClaw 原生搭载（2026-10-09）

| 项 | 值 |
| --- | --- |
| 部署内容 | `main` @ `1dca49a`（P8-07 → Skill-02C → P9 → P10，自 `5c623ef` 起 **123 个提交**；Agent Playbook **1.11.0**）——与测试服 `crm-ex-test02` 同树；迁移 **014** `014_skill02c_attachment_upload.sql`（纯加性、可重跑） |
| 时间线 | 备份 16:52 → 解包/依赖/构建至 17:12:43（11 包全 OK，日志 `/root/deploy-build-1dca49a-r2.log`）→ 迁移 014 → 重启两服务（mcp-server 17:13:14 / admin-api 17:13:18 CST）→ 工具治理 → 普通调用者验证 17:22（审计行 `correlationId 835b22f6-…`）→ OpenClaw 网关启动 17:29:59 |
| 打包/上传 | 本机 `git -c core.autocrlf=false archive main` → tar.gz；**`scp` 在本机↔两端均无限挂起** → 改 `ssh host 'cat > file'` stdin 管道上传，逐文件 sha256 核对（§13 坑 #12） |
| 依赖 | `yarn install`（非 frozen）在服务器复现**确定性 ENOENT** → `node_modules` 自 203 全量镜像 + 手工软链新包 `@sfoa/mcp-provider-sfoa-data` ×3 处；`@salesforce/mcp-provider-dx-core` 缺失的 `.bin` 一并补齐（§13 坑 #13） |
| 构建 | 清 `*.tsbuildinfo` 后按依赖序重建 **11 个包**（新包 `mcp-provider-sfoa-data` 是既有构建序缺的一步，§13 坑 #14 + §6 已补）；admin-web 最后构建（内联 Playbook 1.11.0）；构建后 `chown -R root:root` + `restorecon -Rv` admin-web `dist`（现为 `httpd_sys_content_t`） |
| 配置 | `config/.env.local` 追加 **6 个 `MCP_ATTACHMENT_*` 键**（§13 坑 #15；`.env.example` 已回填）+ `/data/sfoa-enterprise-mcp/attachment-staging`（700）；与测试服 env **键名** diff 仅剩测试夹具；**无 `SFOA_DIAGNOSTIC_USERNAME`**——该键仅 `env` 模式需要（`config.ts:332`），生产的诊断身份在库内 `diagnostic` 配置（见顶部激活记录） |
| 数据库迁移 | 台账 **001–014 APPLIED**；两服务启动断言（要求全部迁移已应用）通过 |
| 工具治理 | 经控制面 Admin API（控制台同款 `PUT /admin/api/tools/<name>`）新增 18 行 + 翻转 `create_record`/`update_record`，启用至 **29/29**，与测试服 enabled 集完全一致。**附件门禁**：同批把唯一 DML 对象 `Lead` 置 `attachmentEnabled=true`（否则启用 `upload_files_to_record` 后全量 MCP POST fail-closed 500 `MCP_ATTACHMENT_CONFIGURATION_INVALID`，§13 坑 #16）——与测试服同构 |
| 验证（普通调用者） | `USER_BOUND` 凭证（控制面签发，非进程内注入）→ 部署网关 `tools/list` = **29**；`list_sobjects` 成功（61 个 Account 前缀对象、返回 5 条）+ 审计落行 `MCP_TOOL_CALL`/`PASS`/`SUCCESS`/`USER_BOUND_TOKEN`；`/health` 200、`/admin/api/ready` UP/8.0.39、nginx `/` 200、`GET /mcp` 405；Playbook 1.11.0 |
| OpenClaw | 与测试服同构搭载（2026.9.5 + 专用 Node v24.19.0；systemd/SELinux/防火墙/插件/Skill 逐项对齐，详见 **§16**）；`channels.wecom` 因**待生产机器人凭据**呈 `enabled:false` + `pendingOperatorCredentials:true`，凭据到位后按 §16.5 四步激活（**已于同日激活，见顶部记录**） |
| 回滚 | 见文末「回滚」；本次工件：`backup/sfoa-app-pre-1dca49a-20261009-165256.tar.gz`（3.74MB）+ `backup/env-local-pre-1dca49a-20261009-165256.bak`（600）；迁移 014 纯加性不回滚 |

---

## 部署记录 · 首次搭建 + 首版部署 P8-04 有效 UI 上下文 + 受管平台用户回退（2026-09-08）

| 项 | 值 |
| --- | --- |
| 部署内容 | 空生产服务器首次搭建（Rocky Linux 9.5 全新装机），部署 `main` @ `b3ed5af`（P8-04 有效 UI 上下文 + 受管平台用户回退；Agent Playbook **1.6.1**），与测试服务器 `main` @ `b3ed5af` 完全一致；全新空库首建 → 迁移 **001–012** |
| 打包/上传 | 本机 `git archive` `main` = `b3ed5af` → `sfoa-deploy-prod.tar.gz`（1.88MB，仅 tracked 源码，天然排除 node_modules/.git/dist/.env.local/*.pem/*.key）→ scp → 解压到 `app/`；本机 md5 `66e937a99cf6eefbfe0a85c8d97e7215`（入 `backup/` 作首版回滚包） |
| 依赖 | 服务器**无公网直连**（接入网关拦境外镜像）→ Node 22 与 npm/yarn 走 **Tencent Cloud 镜像**（`mirrors.cloud.tencent.com/nodejs-release` / `/npm`），nginx RPM 从测试服务器同构 RPM 直装；首次全量 `yarn install`（**非 frozen**，因提交的 `yarn.lock` 相对 package.json 陈旧，见 §13 坑 #6） |
| 数据库迁移 | 独立生产 MySQL `192.168.155.126:3306/sfoa_enterprise_mcp`（账号 `crm_user`，8.0.39，空库无表）应用**加性**迁移 **001–012**；台账 12 行 APPLIED，窗口 02:42:27–02:42:31 UTC |
| 配置 | `config/.env.local`（由本机 `secrets/prod/.env.prod` 上传）+ `secrets/private.pem`；均打 `etc_t` 标签；`app/.env.local → ../config/.env.local` 软链 |
| 构建 | 服务器按 §6 依赖顺序全量重建 10 个 workspace，全部 OK（控制平面依赖 identity-runtime 新 `UI_CONTEXT` 审计类型，须先自底向上重建再跑迁移） |
| 服务 | 新建 systemd 单元 `sfoa-mcp-server` / `sfoa-admin-api` + nginx `sfoa.conf`；mcp-server `sfoa_runtime_started` 10:51:53 CST，admin-api `sfoa_admin_started` 10:51:53 CST，三者 active 且开机自启 |
| SELinux | Enforcing；`semanage fcontext`：admin-web `dist` → `httpd_sys_content_t`，`config/.env.local` / `secrets/private.pem` → `etc_t`；`setsebool -P httpd_can_network_connect 1`；firewalld 仅放行 `http` |
| 备份 | 首版回滚包 → `/data/sfoa-enterprise-mcp/backup/sfoa-app-main-b3ed5af-20260908-initial.tar.gz`（1.88MB，仅源码） |
| 验证结果 | `/health` 200（auditPersistence UP，failureCount 0）；`/admin/api/ready` 200 `{"status":"UP","databaseVersion":"8.0.39"}`；nginx 对外 `/` 与 `/admin/api/ready` 均 200；`GET /mcp`→405（良性）；台账 **001–012 APPLIED**；`sfoa_ui_snapshot` 已建表；`sfoa_audit_payload_evidence.payload_type` ENUM 含 `UI_CONTEXT`；Agent Playbook **1.6.1**（agent-playbook dist 内嵌） |
| 合并 | 无合并动作：直接部署已合入的 `main`；本机 `main` = `origin/main` = `b3ed5af`，与测试/生产一致 |
| 回滚 | 停服 → 解回 `backup/` 首版包到 `app/` → 按 §6 重建 → 重启；DB 迁移纯加性不回滚（见 `skills/.../operations.md` 指引，不回写 `sfoa_schema_migration`） |
| 事后修正（同日 2026-09-08） | Admin 身份路由验证报 `MCP_SALESFORCE_AUTH_FAILED`。两处根因先后修复：① **AC 网关拦 Salesforce 出口**（TLS 证书链被截断）→ 用户网络侧放行 VM MAC 后 `Verify return code: 0`；② `SFOA_INSTANCE_URL` 原配成 `.lightning.` UI host（非 OAuth endpoint，`@salesforce/core` 报 `grant type not supported`）→ 改为组织 My Domain `https://runnergroup.my.sfcrmproducts.cn` 并重启两服务，`AuthInfo.create`+`Connection.identity()` 端到端 PASS（`wendy.wang@runner-corp.com.cn` 匹配）。详见 §13 坑 #10/#11 |

---

## 1. 本次部署概况

### 1.1 服务器信息（实际值）

| 项目 | 实际值 |
| --- | --- |
| 主机名 | `crm-mcp-prod` |
| IP | `192.168.155.207` |
| 操作系统 | Rocky Linux 9.5，SELinux **Enforcing**（强制模式） |
| Node.js | `v22.23.1`（Tencent 镜像 node 二进制解压至 `/opt/node-v22.23.1-linux-x64`，`/usr/bin/node` 软链） |
| Yarn | `1.22.22`（Classic；`npm -g install`，非 corepack） |
| Nginx | `1.20.1-28.el9_8.5.rocky.0.1`（AppStream RPM，同构 RPM 直装，见 §2.2） |
| 进程管理 | systemd（root 运行） |
| 独立生产 MySQL | `192.168.155.126:3306`，库 `sfoa_enterprise_mcp`，账号 `crm_user`（`databaseVersion 8.0.39`） |
| Salesforce 实例 | `https://runnergroup.my.sfcrmproducts.cn`（**组织 My Domain**，JWT Bearer 的 token endpoint/aud；`.lightning.` 只是 Lightning UI host，不能作 OAuth endpoint，见坑 #11） |
| Connected App | 生产 Connected App（Client ID 见 `config/.env.local`；JWT 公钥证书需上传 Salesforce） |
| 对外访问 | Admin Web `http://192.168.155.207/`，Admin API `/admin/api/`，MCP `/mcp`（内网明文 HTTP :80，同测试形态） |
| 本机（开发） | Windows，项目位于 `D:\GitProject\sfoa-enterprise-mcp`；JWT 私钥/公钥证书本地在 `secrets/prod/`（git-ignored） |

### 1.2 部署形态（与测试一致的三进程结构）

```text
浏览器 / MCP Client
        │  HTTP 80
        ▼
      Nginx（监听 192.168.155.207:80）
        ├── /           静态 Admin Web（packages/sfoa-admin-web/dist）
        ├── /admin/api/* ───▶ Admin API   127.0.0.1:8081
        └── /mcp         ───▶ MCP Runtime 0.0.0.0:8080
        ▼
  独立生产 MySQL 192.168.155.126:3306 / sfoa_enterprise_mcp
```

两个 Node 服务监听：**MCP `8080`、Admin API `8081`**；浏览器通过 Nginx 访问前端和 API。firewalld 仅对外放行 `80`。

### 1.3 服务器目录布局（实际）

```text
/data/sfoa-enterprise-mcp/
├── app/                          ← 仓库根（解包后的项目目录）
│   ├── package.json
│   ├── yarn.lock
│   ├── .npmrc                    ← registry=https://mirrors.cloud.tencent.com/npm/
│   ├── packages/
│   ├── node_modules/
│   └── .env.local  →  ../config/.env.local   （软链）
├── config/
│   └── .env.local                ← 真实配置文件（系统维护，不入库；SELinux `etc_t`）
├── secrets/
│   └── private.pem               ← JWT 私钥（chmod 600，SELinux `etc_t`）
└── backup/
    └── sfoa-app-main-b3ed5af-20260908-initial.tar.gz   ← 首版回滚包
```

关键点：

- **仓库根 = `/data/sfoa-enterprise-mcp/app`**（含 `packages/` 的那个目录）。应用按「模块路径里 `packages/` 往上一层」解析仓库根，运行时必须保持该结构。
- **配置文件单独放在 `/data/sfoa-enterprise-mcp/config/.env.local`**，软链 `app/.env.local → ../config/.env.local`。重打包、覆盖 `app/` 不碰配置。
- **私钥 `/data/sfoa-enterprise-mcp/secrets/private.pem`**，`JWT_PRIVATE_KEY_PATH` 指向它；公钥证书 `.crt` 在本机，已用于 Salesforce Connected App 上传（不在服务器上）。
- **`.npmrc` 固定 Tencent npm 镜像**：服务器无公网 registry 直连，所有 npm/yarn 拉包必须走该镜像（见 §13 坑 #4）。

---

## 2. 前置准备

### 2.1 本机（Windows / Git Bash）

- Node.js、Git Bash、Git；SSH 部署密钥 `~/.ssh/sfoa-prod01`（`root@192.168.155.207` 已配置）。
- JWT 对：私钥 `D:\GitProject\sfoa-enterprise-mcp\secrets\prod\private.pem`、公钥证书 `D:\GitProject\sfoa-enterprise-mcp\secrets\prod\sfoa-prod-jwt.crt`（CN=`sfoa-enterprise-mcp-production`，3650d）；**公钥证书由用户自行上传 Salesforce Connected App，私钥上传服务器 `secrets/private.pem`**。
- 配置模板 `D:\GitProject\sfoa-enterprise-mcp\secrets\prod\.env.prod`（git-ignored，→ 服务器 `config/.env.local`）。

### 2.2 服务器（Rocky Linux 9）—— ⚠️ 出口网络受限

生产 VM 所在网段的公网出口被**接入认证网关（AC Portal，`3.3.3.2`）管控**：对绝大多数公网镜像的 HTTPS 会被 302 到门户登录页；仅 **`mirrors.cloud.tencent.com`** 直通。因此：

```bash
# Node.js 22（Tencent 镜像 node 二进制，非 RPM）
curl -ksSL https://mirrors.cloud.tencent.com/nodejs-release/v22.23.1/node-v22.23.1-linux-x64.tar.xz -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /opt
ln -sf /opt/node-v22.23.1-linux-x64/bin/{node,npm,npx,yarn,corepack} /usr/bin/   # systemd ExecStart=/usr/bin/node
# Yarn Classic（Tencent npm 镜像）
npm install -g yarn@1.22.22 --registry=https://mirrors.cloud.tencent.com/npm/

# Nginx：dnf Rocky 源不可达 → 从测试服务器（同构 Rocky 9.5、可出网）下载同构 RPM 直装
#   测试服务器上：dnf download nginx nginx-core nginx-filesystem rocky-logos-httpd
#   拷到本服务器：rpm -Uvh *.rpm   （rocky-logos-httpd 是 Provides: system-logos-httpd 的依赖，勿漏）

# 目录 + 网络/探测
mkdir -p /data/sfoa-enterprise-mcp/{app,config,secrets,backup}
setsebool -P httpd_can_network_connect 1        # nginx 反代 8080/8081
firewall-cmd --permanent --add-service=http && firewall-cmd --reload
```

> 已装组件（无需再装）：`semanage`（policycoreutils）、`ncat`/`nc`。**`git`/`mysql` 客户端不装**（部署用 `git archive` 打包，本机另备 DB 访问）。
>
> ⚠️ **后续维护提醒**：Rocky dnf 源仍被网关拦截，服务器暂**无法做 `dnf` 安全更新 / 装新包**。根治需向网络管理员申请放行该 VM（MAC `00:50:56:94:ce:ff`）或提供内网 yum 镜像（见 §13 坑 #1）。届时 Node/npm 继续走 Tencent 镜像即可。

---

## 3. 从本机打包部署（本次实际使用的流程）

> 服务器**不需要 Git**。代码在本机开发，本机 `git archive` 打包上传服务器解压后构建运行。

### 3.1 打包（Git Bash 本机执行，`main` 分支）

```bash
cd /d/GitProject/sfoa-enterprise-mcp
git archive --format=tar.gz -o ../sfoa-deploy-prod.tar.gz main
```

> `git archive` 只含 **tracked** 文件，天然排除 `node_modules/.git/dist/.env.local/*.pem/*.key/secrets` 等不入库内容（比 `tar --exclude` 更不易漏）。`md5sum ../sfoa-deploy-prod.tar.gz` 与服务器备份内文件比对可验完整性。

### 3.2 上传（Git Bash 本机执行）

```bash
scp ../sfoa-deploy-prod.tar.gz root@192.168.155.207:/root/
# 单独上传私钥与配置（不在包内，不入库）
scp D:/GitProject/sfoa-enterprise-mcp/secrets/prod/private.pem root@192.168.155.207:/data/sfoa-enterprise-mcp/secrets/private.pem
scp D:/GitProject/sfoa-enterprise-mcp/secrets/prod/.env.prod   root@192.168.155.207:/data/sfoa-enterprise-mcp/config/.env.local
```

### 3.3 服务器解压 / 布局 / SELinux（首次一次性）

```bash
tar -xzf /root/sfoa-deploy-prod.tar.gz -C /data/sfoa-enterprise-mcp/app
ln -sfn ../config/.env.local /data/sfoa-enterprise-mcp/app/.env.local
chmod 600 /data/sfoa-enterprise-mcp/config/.env.local /data/sfoa-enterprise-mcp/secrets/private.pem

# SELinux 标签（semanage 规则持久，restorecon 应用）
semanage fcontext -a -t httpd_sys_content_t '/data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist(/.*)?'
semanage fcontext -a -t etc_t '/data/sfoa-enterprise-mcp/config/.env.local'
semanage fcontext -a -t etc_t '/data/sfoa-enterprise-mcp/secrets/private\.pem'
restorecon -Rv /data/sfoa-enterprise-mcp/config/.env.local /data/sfoa-enterprise-mcp/secrets/private.pem

# 保留首版回滚包
mv /root/sfoa-deploy-prod.tar.gz /data/sfoa-enterprise-mcp/backup/sfoa-app-main-b3ed5af-20260908-initial.tar.gz
```

### 3.4 服务器安装依赖（仅首次/依赖变化时）

```bash
cd /data/sfoa-enterprise-mcp/app
printf 'registry=https://mirrors.cloud.tencent.com/npm/\n' > .npmrc   # 关键：无公网 registry，必须指 Tencent
# 首次因提交的 yarn.lock 陈旧（antd/@types/node 等新 pin 无 lock 条目）用非 frozen；日常无变化可 frozen
yarn install --network-timeout 120000        # 完成后再跑一次 yarn install --frozen-lockfile 校验一致
```

> 本仓库 `workspaces.nohoist=["**"]`，每个 workspace 有独立 `node_modules`，必须**在根目录整体安装**。见 §13 坑 #6 关于陈旧锁文件的说明。

---

## 4. 数据库：使用独立生产 MySQL

- 独立生产库在 **`192.168.155.126:3306`**，库名 **`sfoa_enterprise_mcp`**，应用账号 **`crm_user`**（MySQL 8.0.39，`%` 网段授权，仅该库权限）。
- 本次为**全新空库**（0 表），直接服务器建表：

```bash
cd /data/sfoa-enterprise-mcp/app
yarn db:migrate        # 应用 001–012；台账 12 行 APPLIED
yarn p5:bootstrap      # 治理引导（本次 tools/settings 写入成功）
```

> 生产治理数据为空表起步（身份路由/凭证/Tool/DML 策略均需在 Admin 后台重建），与测试「从本机同步治理表」不同。加密密钥 `MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY` 为**生产独立新值**（本地 `secrets/prod/.env.prod` 中生成），生产后台生成的凭证用同一密钥加密，保持一致即可。

---

## 5. 配置 `.env.local`

### 5.1 放置方式（config/ 单独放 + 软链，见 §1.3 / §3.3）

应用只读仓库根 `app/.env.local`；软链指向 `config/.env.local`。**不要在 `app/` 下保留实体 `.env.local`**。

### 5.2 本次实际使用的关键配置项（值保密，仅示结构与真实 host/账号）

```dotenv
# ── 运行模式（mysql 权威）──
SFOA_CONTROL_PLANE_MODE=mysql

# ── 独立生产 MySQL（192.168.155.126 / crm_user）──
SFOA_DB_HOST=192.168.155.126
SFOA_DB_PORT=3306
SFOA_DB_NAME=sfoa_enterprise_mcp
SFOA_DB_USER=crm_user
SFOA_DB_PASSWORD=<生产库密码，勿外泄>
SFOA_DB_SSL_MODE=disabled            # 内网库未开 TLS 时
SFOA_DB_CONNECTION_LIMIT=10
SFOA_DB_QUEUE_LIMIT=100
SFOA_DB_CONNECT_TIMEOUT_MS=10000

# ── Salesforce 身份（mysql 模式下用户名由库内“身份路由”管理）──
SFOA_INSTANCE_URL=https://runnergroup.my.sfcrmproducts.cn   # 组织 My Domain，非 .lightning. UI host
CONNECTED_APP_CLIENT_ID=<生产 Connected-App-Client-Id>
JWT_PRIVATE_KEY_PATH=/data/sfoa-enterprise-mcp/secrets/private.pem

# ── Admin API（Nginx 反代 /admin/api/）──
SFOA_ADMIN_BIND_HOST=127.0.0.1
SFOA_ADMIN_PORT=8081
SFOA_ADMIN_ALLOWED_ORIGIN=http://192.168.155.207
SFOA_ADMIN_USERNAME=admin
SFOA_ADMIN_PASSWORD=<管理员密码，明文>
SFOA_ADMIN_SESSION_SECRET=<48字节随机串>
SFOA_ADMIN_COOKIE_SECURE=false      # 内网明文 HTTP；若以后上 HTTPS 需 true
SFOA_ADMIN_SESSION_TTL_SECONDS=28800
SFOA_ADMIN_LOGIN_MAX_ATTEMPTS=5
SFOA_ADMIN_LOGIN_WINDOW_MS=900000

# ── MCP Runtime（Nginx 反代 /mcp）──
MCP_BIND_HOST=0.0.0.0
MCP_PORT=8080
MCP_PATH=/mcp
MCP_PUBLIC_URL=http://192.168.155.207/mcp
MCP_AUTH_MODE=internal_bearer
MCP_CLIENT_TOKEN=<内部服务Token，≥16字符>
MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY=<32字节base64url>
MCP_PLATFORM_USER_HEADER=X-Platform-User-Id
# P8-05：启用企业微信 MCP Plugin 身份通道（可选）。X-WeCom-User-Id 仅作身份上下文，
# 仍需先通过 Bearer 认证；不得重复主 Header，非法值会在启动时 fail fast。
# MCP_PLATFORM_USER_HEADER_ALIASES=X-WeCom-User-Id
MCP_REQUEST_TIMEOUT_MS=180000
MCP_TOOL_TIMEOUT_MS=120000
# 经 Nginx 反代后 Host/Origin 变为服务器 IP，必须显式放行，否则 403
MCP_ALLOWED_HOSTS=127.0.0.1:8080,localhost:8080,192.168.155.207
MCP_ALLOWED_ORIGINS=http://127.0.0.1:8080,http://localhost:8080,http://192.168.155.207

# ── 无头 Linux 钥匙串（代码已自动引导，保留无副作用）──
SF_USE_GENERIC_UNIX_KEYCHAIN=true

# ── Buntu 身份（生产按需关闭）──
MCP_BUNTU_IDENTITY_ENABLED=false
```

> 本生产配置相比测试：**MCP_BUNTU_IDENTITY_ENABLED=false**（测试开、生产关）、`SFOA_DB_*` 指向生产库、`SFOA_INSTANCE_URL` 指向生产实例、origin/host 均含 `192.168.155.207`。已剔除仅测试环境的键。其余密钥为本机随机重生成的新值。

### 5.3 密钥生成命令（首次/换密钥时）

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))"   # SFOA_ADMIN_SESSION_SECRET
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"   # MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY
node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))"   # MCP_CLIENT_TOKEN
```

### 5.4 配置文件的「三不要三必须」

| 规则 | 说明 |
| --- | --- |
| ❌ 不要 `source` 它 | `.env.local` 是 dotenv 格式；应用自己读文件。 |
| ❌ 不要保留 Windows CRLF | Windows 编辑后行尾 `\r\n`，应用解析器不剥 `\r`，枚举校验 fail-closed。传输前 `sed -i 's/\r$//'`。 |
| ❌ 不要残留 `<...>` 占位符 | 逐个替换为真实值。 |
| ✅ 必须放在软链的 `app/.env.local`（指向 config/） | 应用只读仓库根的 `.env.local`。 |
| ✅ 改完后必须 `restorecon` | 覆盖写会重建文件、SELinux 标签退回 `default_t`，systemd 读 EnvironmentFile 报 Permission denied。 |
| ✅ 换环境文件后必须重启服务 | `systemctl restart sfoa-admin-api sfoa-mcp-server`。 |

```bash
# 改完配置后（每次覆盖写都必须执行）
restorecon -v /data/sfoa-enterprise-mcp/config/.env.local
ls -lZ /data/sfoa-enterprise-mcp/config/.env.local   # 必须显示 :etc_t，而不是 default_t
```

---

## 6. 构建（依赖顺序）

全新解包后所有 `dist` 都不存在（`git archive` 不含 dist、无 postinstall 钩子），必须按**依赖顺序**完整构建。**顺序不能乱**：

```bash
cd /data/sfoa-enterprise-mcp/app
yarn workspace @sfoa/agent-playbook build
yarn workspace @salesforce/mcp-provider-api build        # 最底层，最容易漏掉！
yarn workspace @salesforce/mcp-provider-dx-core build
yarn workspace @sfoa/mcp-provider-sfoa-context build
yarn workspace @sfoa/mcp-provider-sfoa-dml build
yarn workspace @sfoa/mcp-provider-sfoa-data build         # P9 新增包（缺此步会在下游 TS 引用处报错）
yarn workspace @sfoa/identity-runtime build              # 依赖 provider-api / dx-core
yarn workspace @sfoa/control-plane build                 # 依赖 identity-runtime（P8 UI_CONTEXT 审计类型）
yarn workspace @sfoa/mcp-server build                    # 依赖上述全部
yarn workspace @sfoa/admin-api build                     # 依赖 mcp-server
yarn workspace @sfoa/admin-web build                     # tsc + vite，产物在 packages/sfoa-admin-web/dist
```

> 不要用根目录 `yarn build`（并行跑会因依赖方 `dist` 未产出而竞态失败）。控制平面必须在 identity-runtime 之后构建，否则 `TS2322 'UI_CONTEXT'` 类型报错；**切树后的首次全量构建**同样先按本节顺序自底向上，再跑根 `yarn build` 才安全。

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

**`/etc/systemd/system/sfoa-admin-api.service`：** 同上，`Description` 换 `SFoA Enterprise MCP Admin API`，`ExecStart` 换 `packages/sfoa-admin-api/dist/main.js`。

> 两个服务**以 root 运行**（unit 不写 `User=`）。`ExecStart=/usr/bin/node`——Node 用 `/usr/bin/node` 软链到 `/opt/node-v22.23.1-linux-x64/bin/node`（见 §2.2），与测试 NodeSource RPM 落在 `/usr/bin` 的位置对齐。

### 7.2 注册并启动

```bash
systemctl daemon-reload
systemctl enable --now sfoa-mcp-server sfoa-admin-api nginx
systemctl status sfoa-mcp-server sfoa-admin-api --no-pager
```

> 单元文件若改过，都要先 `systemctl daemon-reload` 再 `restart`。

---

## 8. Nginx 反向代理与静态托管

- Nginx 1.20.1（RPM 直装，见 §2.2）；配置位置 `/etc/nginx/conf.d/*.conf`（默认 `nginx.conf` include）。
- 对外只开放 **80 端口**（内网明文 HTTP）；8080/8081 仅服务进程监听，不直接暴露。已删除默认 `default.conf`。
- SELinux 配套（见 §9）：静态目录 `httpd_sys_content_t`；反代需 `httpd_can_network_connect`。

**本次实际使用的 server 块**（写入 `/etc/nginx/conf.d/sfoa.conf`）：

```nginx
server {
    listen 80;
    server_name 192.168.155.207;
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
        proxy_set_header X-Platform-User-Id $http_x_platform_user_id;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 30s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
    }

    # ── SPA history 路由回退 ──
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

---

## 9. SELinux（Rocky 9 默认 Enforcing）

三条 `semanage fcontext` 持久规则 + `restorecon`（与测试完全一致）：

```bash
# 静态 Admin Web：nginx 可读
semanage fcontext -a -t httpd_sys_content_t '/data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist(/.*)?'
restorecon -Rv /data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist     # 每次重建 admin-web 后必跑

# systemd 读环境文件 + node 读私钥
semanage fcontext -a -t etc_t '/data/sfoa-enterprise-mcp/config/.env.local'
semanage fcontext -a -t etc_t '/data/sfoa-enterprise-mcp/secrets/private\.pem'
restorecon -v /data/sfoa-enterprise-mcp/config/.env.local /data/sfoa-enterprise-mcp/secrets/private.pem

# nginx 反代 8080/8081
setsebool -P httpd_can_network_connect 1
getsebool httpd_can_network_connect        # on
```

验证：`ls -lZ` 应分别见 `httpd_sys_content_t`（dist）与 `etc_t`（.env.local / private.pem）。`semanage` 已装（policycoreutils），无需再装。

---

## 10. 启动 / 停止 / 重启 / 查看日志（速查）

```bash
# 启动 / 自启
systemctl start sfoa-mcp-server sfoa-admin-api nginx
systemctl enable --now sfoa-mcp-server sfoa-admin-api nginx
# 停止 / 重启 / 状态
systemctl stop sfoa-mcp-server sfoa-admin-api
systemctl restart sfoa-admin-api sfoa-mcp-server
systemctl is-active sfoa-mcp-server sfoa-admin-api nginx
systemctl status sfoa-mcp-server sfoa-admin-api --no-pager
# 日志（JSON 行；启动成功见 "event":"sfoa_runtime_started" / "sfoa_admin_started"）
journalctl -u sfoa-mcp-server -f        # 实时
journalctl -u sfoa-admin-api -n 100 --no-pager
journalctl -u sfoa-mcp-server --since '-15 minutes' --no-pager
# 健康检查
curl -i http://127.0.0.1:8080/health            # MCP 运行时
curl -i http://127.0.0.1:8081/admin/api/ready   # Admin API（含 DB/schema 就绪）
curl -i http://192.168.155.207/admin/api/ready  # 经 Nginx 对外
curl -I http://192.168.155.207/                 # 前端首页
```

---

## 11. 验证（浏览器 / 接口）

1. `curl http://192.168.155.207/` 返回 Admin Web HTML；`/admin/api/ready` 200 `{"status":"UP","databaseVersion":"8.0.39"}`。
2. `curl http://192.168.155.207/mcp` 返回 **405**（MCP Streamable HTTP 对 GET 的良性应答，说明反代通）。
3. 浏览器打开 `http://192.168.155.207/login`，用 `SFOA_ADMIN_USERNAME` / `SFOA_ADMIN_PASSWORD` 登录。
4. 「系统状态」确认运行模式 `mysql`、`MCP_PUBLIC_URL=http://192.168.155.207/mcp`。
5. 「用户身份路由」新建路由 → 保存 → 生成 USER_BOUND 凭证（生产独立加密密钥）。
6. 「诊断」配置用户名运行「验证 Diagnostic Connection」→ 需先确认 **Connected App 已上传生产 JWT 公钥证书**；应 **PASS**。
7. 生产库空表起步，治理数据（路由/凭证/Tool/DML 策略/运行时设置）均在 Admin 后台按需配置；`p5:bootstrap` 已写入基础 tools/settings。

---

## 12. 更新与重新部署

日常改动代码后的更新流程（本机 → 服务器），与测试一致：

```bash
# 1. 本机打包上传（§3.1），服务器解压（§3.3）
cd /d/GitProject/sfoa-enterprise-mcp
git -c core.autocrlf=false archive --format=tar.gz -o ../sfoa-deploy-prod.tar.gz main
# scp 不可用（挂起，见 §13 坑 #12）→ 用 ssh stdin 管道上传，并核对 sha256
ssh root@192.168.155.207 'cat > /root/sfoa-deploy-prod.tar.gz' < ../sfoa-deploy-prod.tar.gz
sha256sum ../sfoa-deploy-prod.tar.gz
ssh root@192.168.155.207 'sha256sum /root/sfoa-deploy-prod.tar.gz'
ssh root@192.168.155.207 'tar --no-same-owner -xzf /root/sfoa-deploy-prod.tar.gz -C /data/sfoa-enterprise-mcp/app'

# 2. 服务器：依赖没变就跳过 install；变了则带 .npmrc 全量装
#    cd /data/sfoa-enterprise-mcp/app && yarn install --frozen-lockfile
# 3. 有新迁移才跑：yarn db:status && yarn db:migrate
# 4. 按依赖顺序重建（§6 的 11 条）
# 5. 重启两个服务
systemctl restart sfoa-admin-api sfoa-mcp-server
# 6. 若构建了 admin-web，重打静态目录标签
restorecon -Rv /data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist
# 7. 验证
curl -s http://127.0.0.1:8081/admin/api/ready
curl -s http://127.0.0.1:8080/health
```

> 服务器无法执行 `dnf`（Rocky 源被网关拦截，见 §13 坑 #1）：升级 Node/npm/nginx 需走 Tencent 镜像 / 同构 RPM 直装；**安全补丁与 dnf 更新待网络放行后补**。

---

## 13. 部署踩坑记录（含修复；#12–#17 为 2026-10-09 P10 部署与激活新增）

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | `dnf` 拉 Rocky 元数据失败：先是 `Curl error (60): EE certificate key too weak`，后是镜像 URL 里出现门户 HTML 片段 | 生产 VM 公网出口被**接入认证网关（AC Portal 3.3.3.2）**管控：境外/多数镜像被 HTTPS 302 到门户登录页，仅 `mirrors.cloud.tencent.com` 直通 | dnf Rocky 源不可用 → Node/nginx 改走可达渠道（§2.2）；**根治需网络侧放行该 VM MAC `00:50:56:94:ce:ff` 或给内网 yum 镜像**，否则 dnf 安全更新长期缺失 |
| 2 | 多数国内镜像（aliyun/tuna/ustc/huawei/sjtu…）都被 302 到门户 | 网关按目的地址放行，仅 Tencent Cloud 边缘直通 | 探测确认放行集：`curl -ksSL -o /dev/null -w '%{url_effective}'` 看是否落到 `ac_portal`；Node/npm 走 `mirrors.cloud.tencent.com` |
| 3 | nginx 装不上（dnf 不可用） | AppStream 源不可达 | 从测试服务器（可出网、同构 Rocky 9.5）`dnf download` 下载同构 RPM → scp → `rpm -Uvh`（见 §2.2） |
| 4 | `rpm -Uvh nginx*.rpm` 报 `Failed dependencies: system-logos-httpd is needed` | Requires 名是 `system-logos-httpd`，实际提供者是 `rocky-logos-httpd` 包 | 一并下载安装 `rocky-logos-httpd`（`Provides: system-logos-httpd`） |
| 5 | `yarn install` 报 `Couldn't find package "@types/node@22.16.5" ... on the "npm" registry`（约 12 处） | `npm_config_registry` 环境变量 yarn 1 **不生效**，仍用全局 `https://registry.npmjs.org/`（被网关拦截）；且提交的 `yarn.lock` 相对 package.json **陈旧**——`antd@6.6.1`/`@ant-design/icons@6.3.2`/精确 `@types/node@22.16.5` 等新 pin **无 lock 条目**，需联网解析 | 项目根写 `.npmrc`：`registry=https://mirrors.cloud.tencent.com/npm/`；跑**非 frozen** `yarn install` 让 yarn 补齐缺失 lock 条目（先备份原 `yarn.lock`）；另把 lock 内 `registry.yarnpkg.com` 前缀 sed 成 Tencent 镜像避免直连 |
| 6 | 提交的 `yarn.lock` 与 package.json 不一致（antd 6.6.1 / icons 6.3.2 / @types/node 22.16.5 无 lock 条目） | 功能分支升依赖后未重新生成锁文件（测试环境能装只因真实 npm registry 容错在线解析） | 生产已用非 frozen install 补齐并 `success Saved lockfile`（服务器侧自洽）；**建议后续在仓库提交一次 `yarn.lock` 再生成**，消除该漂移 |
| 7 | `systemctl start` 后服务 `activating` 循环，日志 `Failed to locate executable /usr/bin/node: No such file or directory`（203/EXEC） | Node 装在 `/opt`，只软链了 `/usr/local/bin`，而 unit `ExecStart=/usr/bin/node` | `ln -sf /opt/node-v22.23.1-linux-x64/bin/{node,npm,npx,yarn,corepack} /usr/bin/` 后重启（§2.2） |
| 8 | 手工装/改文件后标签退回 | 新文件 / 覆盖写默认 `default_t` | 每次覆盖 `config/.env.local`、重建 admin-web `dist`、更新 `private.pem` 后重跑 `restorecon`（§5.4 / §9） |
| 9 | （选）root `PATH` 里没有 `/opt/node-.../bin` | 非登录 ssh 无该目录 | 统一走 `/usr/bin` 软链；交互命令前 `export PATH="/usr/local/bin:$PATH"` 或直接 `node`（已软链） |
| 10 | Admin 验证用户身份路由报 `MCP_SALESFORCE_AUTH_FAILED`（TLS 阶段即断：`UNABLE_TO_VERIFY_LEAF_SIGNATURE`；`curl -sk` 则 302 到 `3.3.3.2/ac_portal/needauth.html`） | Salesforce 出口同样被 AC 网关管控：生产机只见 leaf-only 证书链、`Verify return code: 21`；同 host 在测试机 `0 (ok)`——按目的地址逐条拦 | 网络侧放行（同坑 #1 的 MAC ticket）后 TLS 恢复 `0 (ok)`。**与刷新令牌轮换/TTL、Client ID、私钥无关**（JWT Bearer 每次全新颁发、不用 refresh token） |
| 11 | 网络放行后验证仍失败，`@salesforce/core` 返回 `grant type not supported / client identifier invalid` | `SFOA_INSTANCE_URL` 错配成 `.lightning.` UI host（`runnergroup.lightning.sfcrmapps.cn`），它不是 OAuth token endpoint | 改成**组织 My Domain** `https://runnergroup.my.sfcrmproducts.cn`（DNS 可解析；同库连 app + 同私钥 + 同用户名即刻 `AuthInfo.create` 出 token、`identity()` 匹配 → PASS）。已改生产 `config/.env.local` 并重启两服务（2026-09-08） |
| 12 | `scp` 上传/下载在本机↔203、本机↔207 均**无限挂起**（无报错无进度，大包小包皆然） | 两端 sshd 上现代 `scp` 默认走 SFTP 子系统的路径有问题（`ssh` 本身正常） | 改 `ssh host 'cat > /path/file' < localfile` stdin 管道（或本机双 SSH `tar` 直管）；上传后逐文件 `sha256sum` 两端核对（§12 已同步改） |
| 13 | 服务器 `yarn install` 尾部**确定性 ENOENT**（P9 部署同款；yarn v1 + workspaces nohoist 链接器 bug） | 新 workspace 包在 `node_modules/@sfoa/*` 与各包内 `node_modules` 的链接结构装不全 | 从 203 全量镜像 `node_modules`（含根、各 `packages/*/node_modules` 与 `.bin`；dx-core 缺的 `.bin` 一并补），并手工软链 `@sfoa/mcp-provider-sfoa-data` ×3 处，再重跑该包 build |
| 14 | 按原 §6（10 包）顺序构建，下游 TS 引用报错（找不到新包产物） | P9 新增 workspace 包 `mcp-provider-sfoa-data` 未进文档构建序 | §6 已补为 **11 条**：`mcp-provider-sfoa-data` 在 `identity-runtime` 之前构建 |
| 15 | 附件功能所需 6 个 `MCP_ATTACHMENT_*` 键在 `.env.example` 中**不存在** | Skill-02C 引入配置时未回填 example（纯文档缺口） | 已回填 `.env.example`（含门禁注释与默认值）；生产按 §16/部署记录的实际值配置 |
| 16 | 启用 `upload_files_to_record` 后**所有** MCP POST 返回 500 `MCP_ATTACHMENT_CONFIGURATION_INVALID`（"requires at least one object with attachment upload enabled"）——等同线上故障 | 附件工具治理策略（每请求判定）要求 ≥1 条 `sfoa_dml_policy` 行 `attachmentEnabled=true`，否则整站 fail-closed；生产唯一 DML 对象 `Lead` 默认 FALSE | `PUT /admin/api/dml-policies/1` 将 `Lead` 置 `attachmentEnabled=true`（rowVersion 2→3，与测试服同构）；**今后启用任何附件类工具前先过此门禁** |
| 17 | 控制台把唯一 DML 策略行 `Lead` 取消「启用」并保存后，**全部**认证 MCP POST 立即 500 `MCP_DML_CONFIGURATION_INVALID`（"Configured Tool create_record requires at least one MCP_DML_ALLOWLIST_JSON object with CREATE."）——与该行 26 分钟前刚通过的全量验证矛盾 | DML 工具治理门禁**每请求**从库内策略重建白名单：只要 `create_record`/`update_record` 启用，就要求 ≥1 条 enabled 且含 CREATE/UPDATE 的 `sfoa_dml_policy` 行，否则整站 fail-closed（与坑 #16 的附件门禁同属一类每请求策略）；控制台写侧没有「此改动会让 MCP 端点整体不可用」的校验或提示 | 恢复：`PUT /admin/api/dml-policies/1`（携带当前 rowVersion，`enabled=true`）即恢复（本次 rowVersion 4→5 完成）。**若治理上要禁止生产写入**，正确做法是同时在工具治理里关闭 `create_record`/`update_record`（只保留读），而不是禁用全部 DML 行。审计链（`channel=ADMIN`、`UPDATE_DML_POLICY`）可定位操作者与时刻 |

---

## 14. 常用命令速查

| 目的 | 命令 |
| --- | --- |
| 本机打包 | `cd /d/GitProject/sfoa-enterprise-mcp && git archive --format=tar.gz -o ../sfoa-deploy-prod.tar.gz main` |
| 本机上传 | `scp ../sfoa-deploy-prod.tar.gz root@192.168.155.207:/root/` |
| 上传私钥/配置 | `scp D:/GitProject/sfoa-enterprise-mcp/secrets/prod/private.pem root@192.168.155.207:/data/sfoa-enterprise-mcp/secrets/private.pem`（配置同理 → `config/.env.local`） |
| 服务器解压 | `tar -xzf /root/sfoa-deploy-prod.tar.gz -C /data/sfoa-enterprise-mcp/app` |
| 安装依赖 | `cd /data/sfoa-enterprise-mcp/app && yarn install --frozen-lockfile`（.npmrc 已指向 Tencent） |
| 构建全部 | §6 的 11 条 `yarn workspace ... build`（依赖顺序） |
| 迁移 | `cd /data/sfoa-enterprise-mcp/app && yarn db:status && yarn db:migrate` |
| 治理引导 | `yarn p5:bootstrap` |
| 启动/停止/重启 | `systemctl start/stop/restart sfoa-mcp-server sfoa-admin-api` |
| 状态 | `systemctl status sfoa-mcp-server sfoa-admin-api --no-pager` |
| 实时/最近日志 | `journalctl -u sfoa-mcp-server -f` / `journalctl -u sfoa-admin-api -n 100 --no-pager` |
| 健康检查 | `curl -i http://127.0.0.1:8080/health`、`curl -i http://127.0.0.1:8081/admin/api/ready` |
| 对外验证 | `curl -I http://192.168.155.207/`、`curl -i http://192.168.155.207/admin/api/ready`、`curl -i http://192.168.155.207/mcp` |
| 改配置后重打标签 | `restorecon -v /data/sfoa-enterprise-mcp/config/.env.local` |
| 重建 admin-web 后重打标签 | `restorecon -Rv /data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist` |
| DB（本机侧） | `mysql -h 192.168.155.126 -P 3306 -u crm_user -p sfoa_enterprise_mcp -e "SELECT ..."` |

---

## 15. 参考文档

- 测试服务器部署指南（同构流程与更全的踩坑清单）：`docs/sfoa/TEST_SERVER_DEPLOYMENT.md`
- 生产部署与 Nginx/HTTPS/备份设计：`docs/sfoa/P5_DEPLOYMENT.md`
- 本地开发启动与治理配置：`docs/sfoa/P5_LOCAL_SETUP.md`
- 反向代理与暴露模型：`docs/sfoa/P2_REVERSE_PROXY.md`
- 一键建库 SQL：`docs/sfoa/SFOA_ENTERPRISE_MCP_SCHEMA.sql`
- USER_BOUND 身份路由凭证生命周期：`docs/sfoa/P6_ID_01_USER_BOUND_CREDENTIAL.md`
- Buntu（小犇/Dify）真实用户身份：`docs/sfoa/P6_ID_02_BUNTU_TOKEN_IDENTITY.md`
- Dify / WorkBuddy 接入：`docs/agent/DIFY_SETUP.md`、`docs/agent/WORKBUDDY_SETUP.md`
- 自研 OpenClaw adapter（企微 → SFOA MCP 桥）：`integrations/openclaw/sfoa-wecom-mcp-adapter/`

---

## 16. 生产 OpenClaw Gateway（2026-10-09 搭载，与测试服同构）

生产 OpenClaw 与测试服 `crm-ex-test02` **逐项对齐，仅环境主体参数化**；运行态（测试会话记忆、媒体、历史备份等）刻意不复制。本节记录安装来源、参数化差异与验收证据。

### 16.1 版本与安装（钉版本）

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- \
  --prefix /data/openclaw/runtime --version 2026.9.5 --node-version 24.19.0 --no-onboard
```

- OpenClaw **2026.9.5**（`ec9c1a1`）+ 专用 Node **v24.19.0**；`node` 与 `entry.js` 的 sha256 与测试服一致（node `bc17c508…`、entry.js `199a876f…`）。安装脚本默认 Node 版本会漂移，**必须显式 `--node-version 24.19.0`**。
- 目录：`/data/openclaw/{runtime,state,workspace,secrets,plugins,logs,temp,reports,backups}`；`state/` 700，`state/openclaw.json` 与 `secrets/credentials.json` 600。`state/wecom-cli` 不复制（按机器人归属，激活时为本生产机器人重建）。

### 16.2 systemd 与沙箱

- `openclaw-gateway.service` + drop-in `50-security.conf` / `60-writable.conf`：与测试服**逐字节一致**（sha256 已核）；`ExecStart=<runtime>/tools/node-v24.19.0/bin/node .../dist/entry.js gateway run --port 18789`。
- 环境：`HOME=/data/openclaw/state/home`、`OPENCLAW_STATE_DIR=/data/openclaw/state`、`OPENCLAW_CONFIG_PATH=.../state/openclaw.json`、`TMPDIR=/data/openclaw/temp`、`OPENCLAW_SERVICE_REPAIR_POLICY=external`。
- 沙箱：`ProtectSystem=strict` + `ReadWritePaths=/data/openclaw/{state,workspace,reports,temp,logs} /srv /opt`；`InaccessiblePaths=/data/sfoa-enterprise-mcp`（MCP 应用目录对 agent 不可见）。
- SELinux：`semanage fcontext -a -t bin_t` 两条（runtime 的 `openclaw` 包装与 node 二进制）+ `restorecon -Rv /data/openclaw/runtime`；启动后 audit 日志 **无新增 AVC**。
- 防火墙：`18789/tcp` public zone 常开（与测试一致）。企微通道是**出站** websocket，不依赖此端口；18789 是网关控制台/API。

### 16.3 插件与 Skill

- 自研 adapter `@sfoa/openclaw-wecom-mcp-adapter` 1.0.0：仓库 `integrations/openclaw/sfoa-wecom-mcp-adapter/` 的字节副本（sha256 与测试安装件逐一相同），经 `plugins.load.paths` 加载。
- npm 插件树自测试服**整体拷贝保字节**（避免重装丢失兼容补丁）：`@wecom/wecom-openclaw-plugin@2026.9.15`（含 3 处内核契约兼容补丁）、`openclaw-parallel-plugin@2026.9.5`、`state/plugin-skills/`、`state/npm/`。
- Skill：4 个业务 Skill 由 `yarn skill:runtime:sync --runtime-root /data/openclaw/workspace/skills` 写入（与测试逐文件 sha256 一致）；`sfoa` 连接器用 **1.11.0** 重新导出（`yarn skill:export`）——与测试服的 1.10.0 遗留件为**有意差异**（连接器必须描述本部署实际工具面）。两处 allowlist（`skills.entries` + `agents.entries.main.skills`）随配置携带；`sfoa` 连接器在两侧均刻意 **excluded**。
- 验收：`openclaw plugins list` 与测试同构（`wecom-openclaw-plugin` 已随 2026-10-09 通道激活转 enabled）；`openclaw skills list --agent main` 4 个业务 Skill + wecom 系 Skill 均 ready。

### 16.4 配置参数化（masked diff：198 键中与测试仅 8 处差异）

| 项 | 生产值 |
| --- | --- |
| `gateway.customBindHost` / `controlUi.allowedOrigins` | `192.168.155.207` / `http://192.168.155.207:18789` |
| `agents.entries.main.identity.name` | `CRM智能助手（正式环境）`（workspace `IDENTITY.md`/`AGENTS.md` 同步参数化） |
| `mcp.servers.sfoa-enterprise-mcp` | `http://127.0.0.1:8080/mcp`（streamable-http）+ 生产 `MCP_CLIENT_TOKEN`（明文于 600 配置内，同测试做法） |
| `channels.wecom` | **已激活（2026-10-09）**：`enabled:true`，botId(35)/secret(43) 明文于 600 配置内（同测试做法），`pendingOperatorCredentials` 已移除；`dmPolicy/groupPolicy=open` |
| 其余（模型 provider 4 模型、tools 策略、subagents、hooks、`session.dmScope=per-account-channel-peer`、attachments TTL 168h、skills allowlist 等 ~190 键） | 与测试 **byte 级一致** |

**模型 Key**：生效的是 `openclaw.json` 内嵌 `models.providers.custom-192-168-155-105-3001.apiKey`（2026-10-09 从生产对 `192.168.155.105:3001` 实测 **HTTP 200**，无需新 Key）；`secrets/credentials.json` 的 `modelApiKey` 是**旧 Key**（两服皆然，无效也不被使用）——换 Key 后以真实调用判定，勿以该文件或 `models status` 为准。

### 16.5 企业微信通道激活（2026-10-09 已完成；复发时照此四步）

```bash
# 1) /data/openclaw/state/openclaw.json：channels.wecom 写 botId/secret、enabled:true（移除 pendingOperatorCredentials）
# 2) /data/openclaw/secrets/credentials.json：补 wecomBotId / wecomBotSecret（600）
# 3) systemctl restart openclaw-gateway
# 4) 验证：journalctl/网关日志见 websocket 连接 openws.work.weixin.qq.com；真人消息 → 回复 → SFOA 工具调用 → 生产审计落行
```

- 实操（2026-10-09）：凭据经 `umask 077` 临时文件 + `ssh 'cat >'` 上传，服务器端 Node 脚本就地补丁两份 600 文件（先做 `*.bak-pre-wecom-<stamp>` 备份），临时文件即刻清除；补丁后网关**将 `channels.wecom.*` 判定为热重载前缀**（改配置即生效，无需重启），本次仍执行第 3 步重启以取干净状态。
- 重启后验收：`WebSocket 已连接 → 认证成功 → 已认证`（出站 `wss://openws.work.weixin.qq.com`）+ 30 秒心跳；插件 `wecom-openclaw-plugin` 转 enabled；`wecom-send-media`/`wecom-send-template-card` 等 wecom 系 Skill 随之 ready。
- `state/wecom-cli`（企微 CLI 运行时）为**按需初始化**：本次激活时尚未生成、测试服亦为激活数日后才出现，目录暂缺不属异常。如需企微文档/发送能力，另在企微后台按机器人「可使用权限」授权（7 天有效，测试环境同款流程）。

### 16.6 验收证据（2026-10-09）

- `systemctl is-active/is-enabled openclaw-gateway` = active/enabled；监听 `192.168.155.207:18789`；从测试服 `curl` 实测 **HTTP 200**。
- 启动日志 `gateway ready`：0 条 ERROR、3 条预期 WARN（非回环绑定提示、自建插件信任提示、`tools.fs.workspaceOnly=false` 提示——与测试一致；`workspaceOnly=false` 是刻意与测试对齐的开放档）。
- adapter 凭据层：以生产 `MCP_WECOM_CLIENT_TOKEN` 对 `127.0.0.1:8080/mcp` 发起 `initialize` → `401 MCP_PLATFORM_USER_REQUIRED`（**客户端认证已过、等待按消息注入请求者 `X-WeCom-User-Id`**——adapter 的设计行为）；负对照（伪造 token）→ `MCP_BUNTU_TOKEN_INVALID`。完整请求者链路留待真人 UAT。
- 模型通路：生产 → `192.168.155.105:3001` 实测 HTTP 200（见 16.4）。
- 企微通道（2026-10-09 激活，详见 §16.5）：ws 连接/认证/心跳见网关日志；`wecom-openclaw-plugin` enabled；wecom 系 Skill ready。
- 网关 token 认证抗探测：同日 3 次来自 172.70.1.156 的未带 token 连接全部被拒（`unauthorized conn`），无影响。
- 诊断工具（P10 §7「生产就绪」）：5 个只读诊断工具以普通 `USER_BOUND` 调用者实弹 PASS（见顶部激活记录）。

### 16.7 常用命令

```bash
export HOME=/data/openclaw/state/home OPENCLAW_STATE_DIR=/data/openclaw/state \
       OPENCLAW_CONFIG_PATH=/data/openclaw/state/openclaw.json TMPDIR=/data/openclaw/temp
export PATH=/data/openclaw/runtime/bin:/data/openclaw/runtime/tools/node-v24.19.0/bin:$PATH
openclaw --version                       # 2026.9.5 (ec9c1a1)
openclaw plugins list
openclaw skills list --agent main
systemctl restart openclaw-gateway && tail -f /data/openclaw/logs/gateway.log
```

**待办**：① ~~生产企微机器人 `botId` + `secret`~~ → **已完成**（2026-10-09 激活，§16.5）；② ~~`SFOA_DIAGNOSTIC_USERNAME`~~ → **已完成并纠正**：生产为 mysql 模式，诊断身份在库内 `diagnostic` 配置（id 1 = `crm_admin2@runner-corp.com.cn`，enabled + `verificationStatus=PASS`），该 env 键仅 env 模式需要、生产无需写入；6 个诊断工具已启用并经实弹验证（5 个只读 PASS；`set_trace_flag` 依 ADR-0029 未在生产写入）；③ 真人 UAT（企微消息 → 回复 → SFOA 工具 → 审计落行；再测一条带附件消息）——**仍待办**。

## P8-06 WeCom native MCP plugin

Configure the Runtime and Admin API with the same protected environment:

```env
MCP_PLATFORM_USER_HEADER=X-Platform-User-Id
MCP_PLATFORM_USER_HEADER_ALIASES=X-WeCom-User-Id
MCP_WECOM_CHANNEL_ENABLED=true
MCP_WECOM_CLIENT_TOKEN=<CHANGE_ME>
```

Replace the placeholder with an independent secret of at least 32 random characters;
never use MCP_CLIENT_TOKEN or a USER_BOUND token. Restart Runtime and Admin API.
In the WeCom plugin set Authorization to `Bearer <MCP_WECOM_CLIENT_TOKEN>`.
X-WeCom-User-Id is auto-injected by WeCom for Tool execution; do not configure a fixed
user. Saving/discovering tools does not require a user and does not access Salesforce.
Existing Internal clients retain MCP_CLIENT_TOKEN plus X-Platform-User-Id.
Keep Authorization and X-WeCom-User-Id intact through the existing reverse proxy.
See [P8-06 deployment/UAT](P8_06_WECOM_CHANNEL_DISCOVERY.md).

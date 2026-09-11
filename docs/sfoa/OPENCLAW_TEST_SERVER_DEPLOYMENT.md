# OpenClaw 测试服务器部署与验收记录（crm-ex-test02）

> 本文档记录 **OpenClaw Baseline** 在测试服务器 `crm-ex-test02`（`192.168.156.203`）上的实际部署与验收结果。
>
> 本阶段由 Codex 完成主体实施（2026-09-08 ~ 09-10），因额度耗尽未收口；**2026-09-11 由 Claude Code 接管现场完成复核、纠错、验收与记录**。文档中每一条结论都对应服务器或双端抓包的真实证据，**不存在未经实测的推断**。
>
> 本阶段范围严格限定为：
>
> ```
> Windows Browser → OpenClaw Control UI → OpenClaw Agent → DeepSeek
> ```
>
> **未接入企微、未接入 SFOA MCP、未改动身份链**（见 §17 边界）。

---

## 0. 结论摘要

| 项 | 值 |
| --- | --- |
| **总体状态** | **`READY`** |
| OpenClaw 服务端 Baseline | **READY** |
| Windows → `192.168.156.203:18789` 直连 | **READY（已修复，非上游阻断）** |
| 部署分支 | `feature/openclaw-test-server-baseline` |
| 部署日期 | 2026-09-09 ~ 2026-09-11（服务器）/ 2026-09-11（收口） |
| OpenClaw 版本 | `2026.9.3`（build `1391f7c`） |
| 唯一未闭环项 | Gateway 提示「remote model catalog downloaded; restart the Gateway to apply it」——**非缺陷**，模型列表刷新提示，见 §13.9 |

### 0.1 本阶段最重要的更正

Codex 的交接结论中，**网络阻断层的判断是错的**，本次已用双端抓包推翻并修复：

| 项 | Codex 的记录 | 本次实测（2026-09-11） |
| --- | --- | --- |
| 阻断位置 | 公司 VPN / Zero Trust / 上游 ACL | **服务器本机 firewalld** |
| 抓包结果 | 「完全没有收到 Windows 发往 18789 的数据包」 | **收到 4 个 SYN，无 SYN-ACK** |
| Windows 源 IP | `20.0.0.7` | **`172.70.1.165`**（`20.0.0.7` 已过期） |
| firewalld 规则 | `20.0.0.7/32 → 18789` | 同左 —— **正是这条过期规则导致阻断** |

**误导原因**：Codex 的 `tcpdump` 过滤器用了 `host 20.0.0.7`，而 Windows 实际源 IP 已变为 `172.70.1.165`，因此抓包为空，被误读为「上游阻断」。详见 §5。

---

## 1. 服务器基线

| 项 | 值 |
| --- | --- |
| hostname | `crm-ex-test02` |
| IP | `192.168.156.203/24`（网卡 `ens160`） |
| OS | Rocky Linux 9.8 (Blue Onyx) |
| SELinux | **`Enforcing`**（未关闭） |
| 内存 | 15 GiB（可用 ~11 GiB），Swap 7.9 GiB |
| 磁盘 | `/` 92 G 用 10%；`/data` 100 G 用 10% |
| 运行用户 | `root` |
| 既有服务 | SFOA MCP Runtime `:8080`、Admin API `:8081`、Nginx `:80`/`:9000` |

> 服务器 uptime 37 天；OpenClaw 未引入任何内核/网络栈变更。

---

## 2. OpenClaw

| 项 | 值 |
| --- | --- |
| 版本 | `OpenClaw 2026.9.3 (1391f7c)` |
| 运行时根目录 | `/data/openclaw`（`root:root` `700`） |
| Node 运行时 | **独立 Node `v24.19.0`** → `/data/openclaw/runtime/tools/node-v24.19.0/bin/node` |
| CLI | `/data/openclaw/runtime/bin/openclaw`（wrapper，`root:root` `711`） |
| State 目录 | `/data/openclaw/state`（`700`，**非** `~/.openclaw`） |
| 配置文件 | `/data/openclaw/state/openclaw.json`（`600`） |
| Workspace | `/data/openclaw/workspace` |
| Secrets 目录 | `/data/openclaw/secrets`（`700`） |
| 日志 | `/data/openclaw/logs/gateway.log`（10 MiB 轮转） |
| TMPDIR | `/data/openclaw/temp` |

**未使用系统 Node**，OpenClaw 与 SFOA 的 Node 运行时完全隔离，互不影响。

`openclaw config validate` → `Config valid: /data/openclaw/state/openclaw.json`。

---

## 3. Gateway

### 3.1 服务状态

| 项 | 值 |
| --- | --- |
| systemd 单元 | `openclaw-gateway.service` |
| `is-enabled` | **`enabled`** |
| `is-active` | **`active (running)`** |
| 启动时刻 | `2026-09-10 23:29:03 CST` |
| 内存占用 | 452.9 MB（峰值 607.8 MB） |
| 进程数 | **仅 1 个** `openclaw-gateway`（PID 1113567，PPID 1） |
| user 单元 | **无**（已确认不存在 system + user 双 Gateway） |

### 3.2 监听

```text
LISTEN  192.168.156.203:18789   openclaw-gateway
LISTEN  127.0.0.1:18789         openclaw-gateway
```

| 项 | 值 |
| --- | --- |
| `gateway.bind` | **`custom`** |
| `gateway.customBindHost` | `192.168.156.203` |
| `gateway.port` | `18789` |
| loopback 监听 | OpenClaw 官方行为保留 `127.0.0.1:18789` |
| `gateway.mode` | `local` |
| `gateway.tailscale.mode` | `off` |

### 3.3 认证与限流

| 项 | 值（实测） |
| --- | --- |
| `gateway.auth.mode` | **`token`** |
| token 存储 | **SecretRef**（非明文，见 §8） |
| `auth.rateLimit.maxAttempts` | `10` |
| `auth.rateLimit.windowMs` | `60000` |
| `auth.rateLimit.lockoutMs` | `300000` |
| `gateway.terminal.enabled` | **`false`** |
| `gateway.cliAgents.enabled` | `false` |

**认证反向测试**（2026-09-11）：

| 场景 | 结果 |
| --- | --- |
| 正确 token | ✅ 连接成功，`devices list` 正常返回 |
| 错误 token | ✅ 拒绝：`unauthorized: gateway token mismatch` |
| 无 token | ✅ 拒绝：`gateway url override requires explicit credentials` |

### 3.4 Control UI 安全项

| 项 | 值 |
| --- | --- |
| `gateway.controlUi.enabled` | `true` |
| `gateway.controlUi.allowedOrigins` | **`["http://192.168.156.203:18789"]`**（精确单条，**无 `*`**） |
| `dangerouslyAllowHostHeaderOriginFallback` | **`false`** |
| `dangerouslyDisableDeviceAuth` | **`false`**（设备配对强制开启） |

---

## 4. 浏览器 / Control UI 验收

验收方式：**Windows 本机 Playwright Chromium**（真实浏览器引擎，非 curl）。

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| HTTP 页面加载 | ✅ | `curl.exe` → `HTTP/1.1 200 OK`，`Content-Length: 19423` |
| 浏览器打开 | ✅ | URL → `http://192.168.156.203:18789/chat/main` |
| 界面语言 | ✅ **简体中文** | `document.documentElement.lang = "zh-CN"`，正文含 **103 ~ 133 个汉字** |
| 中文导航实际菜单 | ✅ | 「首页 / 仪表盘 / 自动化 / 插件 / 会话」 |
| 令牌认证 | ✅ | 输入 token 后页面由「此 Gateway 需要令牌」推进到设备配对阶段 |
| 设备配对 | ✅ | 见 §4.1 |
| WebSocket | ✅ | `ws://192.168.156.203:18789/` 已连接，**收到 47 帧** |
| 模型显示 | ✅ | 界面显示 `DeepSeekV32 (Custom Provider) · local` |
| **UI 内 Chat** | ✅ | 经界面发送 `只回复：OpenClaw Baseline OK`，**收到 `OpenClaw Baseline OK`** |
| 会话列表 | ✅ | 界面列出 `explicit:baseline-verify-20260911`、`explicit:toolpolicy-verify-20260911` 等真实会话 |
| console 错误 | ⚠️ 1 条 | 一个静态资源 404（无害，不影响功能） |

### 4.1 设备配对（Device Pairing）

**未使用任何「关闭设备身份校验」的绕过手段**，走官方流程：

```text
Windows Browser 首次访问
  → 页面提示「批准此浏览器」（已完成令牌认证，但 Gateway 尚未识别此浏览器）
  → 服务器执行 openclaw devices list        # 看到来自 172.70.1.165 的 pending 请求
  → 服务器执行 openclaw devices approve <requestId>
  → 浏览器刷新即完成连接
```

配对前后对比：

| 阶段 | Paired 列表 |
| --- | --- |
| 配对前 | `Paired (1)`：Codex 遗留的服务器本机浏览器（IP `192.168.156.203`） |
| 配对后 | `Paired (1)`：**Windows 管理端浏览器（IP `172.70.1.165`）** |

> 本次同时**撤销了 Codex 遗留的失效配对**（对应进程已在 §13.6 清理），配对表现只保留真实管理端。

### 4.2 明文 HTTP 的已知行为（非缺陷）

`isSecureContext = false`：经**明文 HTTP + 非 loopback** 访问时，浏览器不将其视为安全上下文，因此**不会自动持久化** bootstrap 令牌，需手工粘贴令牌（或使用 `openclaw dashboard` 输出的一次性 URL）。这是浏览器安全模型使然，属预期行为。

---

## 5. 网络（本次核心问题）

### 5.1 Windows 端网络事实

| 项 | 值 |
| --- | --- |
| 接口 | WLAN（Intel Wi-Fi 6 AX201） |
| IP | `172.70.1.165/16`（**DHCP**） |
| 网关 | `172.70.0.225` |
| DHCP 服务器 | `172.70.0.1`，**租期 4 小时**（实测 `08:17:41 → 12:17:41`） |
| 到 `192.168.156.203` 的下一跳 | `172.70.0.225`（经 WLAN，默认路由） |

> Windows **不在** `192.168.156.0/24` 网段，两端是**跨网段路由**关系。

### 5.2 服务器返回路径（排除非对称路由）

```text
default via 192.168.156.225 dev ens160 proto static metric 100
192.168.156.0/24 dev ens160 proto kernel scope link src 192.168.156.203

ip rule: 仅 0/32766/32767 三条默认表 —— 无策略路由
ip route get 172.70.1.165 → via 192.168.156.225 dev ens160 src 192.168.156.203
```

✅ 返回路径存在且唯一，**排除非对称路由**。

### 5.3 双端证据链（修复前 —— 决定性证据）

服务器 `tcpdump -ni any`（**未按源 IP 过滤**）：

```text
08:56:18.439845 ens160 In 172.70.1.165.65407 > 192.168.156.203.18789: Flags [S], seq 2141169058
08:56:19.450236 ens160 In 172.70.1.165.65407 > 192.168.156.203.18789: Flags [S], seq 2141169058
08:56:21.460463 ens160 In 172.70.1.165.65407 > 192.168.156.203.18789: Flags [S], seq 2141169058
08:56:25.471886 ens160 In 172.70.1.165.65407 > 192.168.156.203.18789: Flags [S], seq 2141169058
```

**SYN 到达服务器 → 服务器没有任何 SYN-ACK 回应。**

Windows 端同一时段：

| 端口 | `Test-NetConnection` | 服务器是否收到 SYN |
| --- | --- | --- |
| 22 (SSH) | ✅ `True` | ✅ 收到 |
| 9000 (Nginx) | ✅ `True` | ✅ 收到 |
| **18789** | ❌ `False` | ✅ **收到**（但被本机丢弃） |

### 5.4 阻断点定位

```text
链 filter_IN_public:
  ...
  jump filter_IN_public_allow
  ...
  reject with icmpx admin-prohibited

nft: ip saddr 20.0.0.7 tcp dport 18789 accept     ← 18789 仅此一条规则
firewall-cmd --list-ports → 9000/tcp              ← 18789 未在 ports 中开放
```

**结论：阻断发生在服务器本机 netfilter（firewalld `public` zone），不在上游网络设备。**

根因：规则源地址锁在 **`20.0.0.7/32`**（已过期），而 Windows 实际源 IP 是 **`172.70.1.165`** → 规则不匹配 → 落入 `reject with icmpx admin-prohibited`。

### 5.5 修复与修复后证据

规则调整为**按当前 WLAN 网段收窄**（经用户确认，未向整个 zone 开放）：

```bash
firewall-cmd --permanent --remove-rich-rule='rule family="ipv4" source address="20.0.0.7/32" port port="18789" protocol="tcp" accept'
firewall-cmd            --remove-rich-rule='rule family="ipv4" source address="20.0.0.7/32" port port="18789" protocol="tcp" accept'
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="172.70.1.0/24" port port="18789" protocol="tcp" accept'
firewall-cmd            --add-rich-rule='rule family="ipv4" source address="172.70.1.0/24" port port="18789" protocol="tcp" accept'
```

runtime 与 permanent **均已生效并核对一致**：

```text
firewall-cmd --list-rich-rules            → rule family="ipv4" source address="172.70.1.0/24" port port="18789" protocol="tcp" accept
firewall-cmd --list-rich-rules --permanent → （同上）
nft list ruleset | grep 18789             → ip saddr 172.70.1.0/24 tcp dport 18789 accept
```

**修复后双端证据**：

```text
09:06:07.881474 IP 172.70.1.165.52568 > 192.168.156.203.18789: Flags [S]
09:06:07.881557 IP 192.168.156.203.18789 > 172.70.1.165.52568: Flags [S.]   ← SYN-ACK
09:06:07.887974 IP 172.70.1.165.52568 > 192.168.156.203.18789: Flags [.]
...
SYN = 2, SYN-ACK = 2

Windows: Test-NetConnection 18789 → True
Windows: curl → HTTP 200 in 0.044s
```

### 5.6 ⚠️ 运维注意：源地址为 DHCP，存在漂移风险

Windows 的 WLAN 地址是 **4 小时租期的 DHCP**。当前规则放行 `172.70.1.0/24`：

- 只要租约仍落在 `172.70.1.x` → 正常；
- 若 DHCP 把 Windows 分配到 `172.70.1.0/24` **之外**（例如 `172.70.2.x`）→ **18789 会再次不可达**。

**届时处置**（不要直接对 zone 开放端口）：

```bash
# 1) 在 Windows 查当前实际源 IP
#    PowerShell: (Get-NetIPAddress -InterfaceAlias WLAN -AddressFamily IPv4).IPAddress
# 2) 在服务器按新源地址更新规则（runtime + permanent 各一次）
firewall-cmd --permanent --remove-rich-rule='rule family="ipv4" source address="172.70.1.0/24" port port="18789" protocol="tcp" accept'
firewall-cmd            --remove-rich-rule='rule family="ipv4" source address="172.70.1.0/24" port port="18789" protocol="tcp" accept'
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="<新网段>/24" port port="18789" protocol="tcp" accept'
firewall-cmd            --add-rich-rule='rule family="ipv4" source address="<新网段>/24" port port="18789" protocol="tcp" accept'
```

> **不要**使用 `firewall-cmd --add-port=18789/tcp`（等于向整个 zone 开放管理面）。
>
> 若需彻底消除漂移，应由网络管理员为管理端分配**固定 IP 或 DHCP 保留**，再把规则收窄为 `/32`。

### 5.7 未采用且本次明确禁止的方案

为完成任务而**未实施**以下任一做法（避免扩大 OpenClaw 管理面攻击面、避免影响现有 SFOA 服务边界）：

- ❌ 把 OpenClaw 挂到 `:9000/openclaw`
- ❌ 修改现有 SFOA Nginx 配置
- ❌ 新增公网入口 / 修改公网 DNAT
- ❌ 公网域名 / Cloudflare Tunnel / frp / ngrok / Tailscale Funnel

> 备选设计 **OPTION-B（Nginx 内网受限反代）**仅在最终报告中提出，**未经用户明确批准不实施**。首选方案仍是「公司内网策略允许 TCP 18789 直连」，本次已达成。

---

## 6. SELinux

| 项 | 值 |
| --- | --- |
| 当前模式 | **`Enforcing`**（**未**执行 `setenforce 0`） |

### 6.1 原始故障

```text
openclaw-gateway.service = failed
journal: status=203/EXEC
```

**真实原因**：OpenClaw 的 CLI / Node 二进制位于 `/data/...` 自定义路径，初始 SELinux 标签为 **`default_t`**，systemd 执行时被拒绝（`203/EXEC`）。

### 6.2 最终修复方式：自定义 fcontext（而非关闭 SELinux）

```bash
semanage fcontext -a -t bin_t '/data/openclaw/runtime/bin/openclaw'
semanage fcontext -a -t bin_t '/data/openclaw/runtime/tools/node-v24.19.0/bin/node'
restorecon -Rv /data/openclaw/runtime
```

`semanage fcontext -l -C` 实际登记：

```text
/data/openclaw/runtime/bin/openclaw                all files  system_u:object_r:bin_t:s0
/data/openclaw/runtime/tools/node-v24.19.0/bin/node all files  system_u:object_r:bin_t:s0
```

**验证**：

```text
ls -lZ /data/openclaw/runtime/bin/openclaw
  -rwx--x--x. root root unconfined_u:object_r:bin_t:s0
ls -lZ /data/openclaw/runtime/tools/node-v24.19.0/bin/node
  -rwxr-xr-x. 1000 1000 unconfined_u:object_r:bin_t:s0
ausearch -m AVC -ts recent  →  <no matches>
```

✅ OpenClaw 正常运行期间**无新的相关 AVC deny**。

---

## 7. systemd

### 7.1 单元文件

`/etc/systemd/system/openclaw-gateway.service`（`root:root` `644`，`systemd_unit_file_t`）：

```ini
[Unit]
Description=OpenClaw Gateway (LAN baseline)
After=network-online.target
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/data/openclaw
Environment=HOME=/data/openclaw/state/home
Environment=OPENCLAW_STATE_DIR=/data/openclaw/state
Environment=OPENCLAW_CONFIG_PATH=/data/openclaw/state/openclaw.json
Environment=OPENCLAW_SERVICE_REPAIR_POLICY=external
Environment=TMPDIR=/data/openclaw/temp
Environment=PATH=/data/openclaw/runtime/tools/node/bin:/data/openclaw/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
ExecStart=/data/openclaw/runtime/tools/node-v24.19.0/bin/node /data/openclaw/runtime/tools/node-v24.19.0/lib/node_modules/openclaw/dist/entry.js gateway run --port 18789
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78
TimeoutStartSec=90
TimeoutStopSec=330
KillMode=mixed
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

### 7.2 hardening drop-in

`/etc/systemd/system/openclaw-gateway.service.d/50-security.conf`：

```ini
[Service]
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/data/openclaw/state /data/openclaw/workspace /data/openclaw/reports /data/openclaw/temp /data/openclaw/logs
ProtectHome=true
CapabilityBoundingSet=
InaccessiblePaths=/data/sfoa-enterprise-mcp
```

| 关键点 | 说明 |
| --- | --- |
| `ProtectSystem=strict` | 整个文件系统只读，仅 `ReadWritePaths` 可写 |
| `InaccessiblePaths=/data/sfoa-enterprise-mcp` | ✅ **SFOA 项目目录对 Gateway 完全不可访问** |
| `CapabilityBoundingSet=`（空） | 无任何 Linux capability |
| `NoNewPrivileges=true` | 无法提权 |
| `ProtectHome=true` | 无家目录访问 |

### 7.3 安全评分

`systemd-analyze security openclaw-gateway.service` → **Overall exposure level: 6.2 MEDIUM**

> ⚠️ 评分未继续优化。剩余扣分项（`PrivateNetwork`、`SystemCallFilter`、`IPAddressDeny` 等）会**破坏 Gateway 的对外监听与模型出站**。**本阶段刻意不加**：Baseline 目标是「Gateway 正常 + Model 正常 + State 可写 + Secret 可读 + SFOA 目录不可达」，上述五条均已满足。

---

## 8. Secrets / SecretRef

### 8.1 迁移结果

| 项 | 值 |
| --- | --- |
| Secret 提供方 | `secrets.providers.baseline`（`source: file`） |
| 凭证文件 | `/data/openclaw/secrets/credentials.json` |
| 目录权限 | `/data/openclaw/secrets` → `700`，`root:root` ✅ |
| 文件权限 | `credentials.json` → `600`，`root:root` ✅ |
| 文件内键 | `gatewayToken`(64)、`modelApiKey`(51) —— **键名可见，值从未写入本文档/日志** |
| 引用方式 | `gateway.auth.token` 与 `models.providers.*.apiKey` 均为 **SecretRef**（`{source, provider, id}` 结构） |

### 8.2 明文清除验证

对 `openclaw.json` 做明文扫描（**只统计出现次数，不打印内容**）：

```text
/data/openclaw/state/openclaw.json          'sk-' 出现 0 次，明文 token 0 次，mode 600  ✅
/data/openclaw/state/openclaw.json.last-good 'sk-' 出现 0 次，明文 token 0 次，mode 600  ✅
```

✅ **活动配置中不再有任何明文 Gateway Token / Model API Key。**

### 8.3 ⚠️ 本次新发现并处置：5 个明文配置自动备份

迁移前 OpenClaw 自动留存的配置备份仍在活动 state 目录中，且**仍含明文密钥**：

| 文件 | `sk-` | 明文 token | 处置 |
| --- | --- | --- | --- |
| `openclaw.json.bak` | 1 | 1 | → 移入敏感备份目录 |
| `openclaw.json.bak.1` ~ `.bak.4` | 各 1 | 各 1 | → 移入敏感备份目录 |

**处置方式（移动而非删除，保留可回滚性）**：

```text
/data/openclaw/state/openclaw.json.bak* 
  → /data/openclaw/backups/20260910-baseline/state-config-plaintext-backups/   (700 / 600, root:root)
```

移动后复核：活动 state 目录**零明文**，`openclaw config validate` 通过，Gateway 仍 `active` 且两个监听正常。

### 8.4 敏感备份与处理规则

```text
/data/openclaw/backups/20260910-baseline/
  ├── SENSITIVE-BACKUP.txt                      ← 本次添加的显式敏感标记 (600)
  ├── openclaw.pre-secretrefs.json              明文：迁移前 gateway token + model API key
  ├── openclaw.json                             明文：迁移前配置
  ├── openclaw-before.tar.gz                    迁移前 state 归档
  ├── initial-secret.patch.json                 迁移用到的密钥材料
  ├── state-config-plaintext-backups/           本次从 state/ 归并的 5 个 .bak
  ├── openclaw-gateway.service / firewalld-*.txt / selinux-fcontext.before.txt
  ├── sfoa-mcp-server.before.txt / sfoa-admin-api.before.txt / nginx.before.txt
  └── sfoa-config.before.sha256 / sfoa-health.before.txt / patch-*.txt / secretrefs-*.txt
```

| 规则 | 值 |
| --- | --- |
| 备份目录权限 | `700`，`root:root` ✅ |
| 敏感文件权限 | `600`，`root:root` ✅ |
| 敏感标记 | `SENSITIVE-BACKUP.txt`（已添加，明文说明哪些文件含明文凭证） |
| **禁止** | 复制 / grep / 截图 / 粘贴进 Git、工单或聊天工具 |

> 备份**予以保留**（SecretRef 刚上线，保留迁移前回滚路径更稳妥）。待 Baseline 稳定运行、确认无需回退明文配置后，可整体删除该目录。

---

## 9. 模型

| 项 | 值 |
| --- | --- |
| Provider ID | `custom-192-168-155-105-3001` |
| Base URL | `http://192.168.155.105:3001/v1` |
| API 形态 | `openai-completions` |
| 模型 | `DeepSeekV32`（128k context） |
| 别名 | `local` |
| 默认模型 | `custom-192-168-155-105-3001/DeepSeekV32` |
| 凭据 | **SecretRef**（见 §8），`models status` 显示 `marker(secretref-managed)` |

### 9.1 回归结果（2026-09-11，最小消耗）

> 当前版本 `2026.9.3` 的 `openclaw models` **没有 `probe` 子命令**（实际子命令：`status` / `list` / `auth` / `scan` / `refresh` / `set` …）。等价的官方探测入口为 `openclaw models status` 与 `openclaw capability model run`。本次采用 **`models status` + 一次真实 Agent Chat** 作为最小回归。

| 步骤 | 结果 |
| --- | --- |
| `openclaw models status` | ✅ 默认模型/别名/SecretRef 状态正常 |
| `openclaw models list` | ✅ `custom-192-168-155-105-3001/DeepSeekV32  text  128k  default,configured,alias:local` |
| Agent Chat（CLI） | ✅ `status = ok`，回复 **`OpenClaw Baseline OK`** |
| 用量 | input 4483 / output 6 tokens，cost 0 |
| Agent Chat（浏览器 UI） | ✅ 经 Control UI 发送，同样收到 `OpenClaw Baseline OK` |
| `successfulToolNames` | **`[]`**（无工具调用） |

✅ **OpenClaw → Model Provider → DeepSeek → Agent 全链路真实可用，且未输出任何 API Key。**

---

## 10. Agent 安全（Tool Policy）

### 10.1 配置

```jsonc
"tools": {
  "profile": "minimal",
  "exec":    { "mode": "deny" },
  "elevated":{ "enabled": false },
  "deny":    ["*"]
},
"browser": { "enabled": false },
"gateway": { "terminal": { "enabled": false }, "cliAgents": { "enabled": false } }
```

### 10.2 无害安全测试

向 Agent 发送：

```text
请实际执行 uname -a。如果工具不可用，只回复 Tool unavailable。
```

| 验收项 | 结果 |
| --- | --- |
| Agent 回复 | ✅ **`Tool unavailable`** |
| `systemPromptReport.tools` | ✅ **`{"listChars": 0, "schemaChars": 0, "entries": []}`** —— **零工具** |
| `terminalReceipt.successfulToolNames` | ✅ `[]` |
| Gateway journal 中是否出现 exec 调用 | ✅ **没有**（唯一匹配 "tool" 的行就是回复文本本身） |

### 10.3 危险能力封锁清单

| 能力 | 状态 |
| --- | --- |
| `exec` | 🚫 `deny` |
| `process` / `write` / `edit` / `apply_patch` | 🚫 被 `deny: ["*"]` 覆盖 |
| `gateway` terminal | 🚫 `terminal.enabled = false` |
| `browser` | 🚫 `browser.enabled = false` |
| `nodes` / `cron` | 🚫 被 `deny: ["*"]` 覆盖 |
| `elevated` | 🚫 `enabled = false` |

✅ **业务 Agent 当前无 Shell、无文件系统修改、无服务器管理能力。**

> 备注：`systemPromptReport.skills` 仍注入了 skill 描述文本（约 6.7k 字符），但 **`tools.entries` 为空**，Agent 无任何可调用工具，故 skill 文本不构成能力。后续如需要可另行精简。

### 10.4 官方 Security Audit

```text
openclaw security audit --json
```

| 项 | 值 |
| --- | --- |
| `summary.critical` | **0** |
| `summary.warn` | **0** |
| `summary.info` | 1 |
| `secretDiagnostics` | `[]`（无密钥泄漏诊断） |

唯一 1 条 `info` 为 `summary.attack_surface`（攻击面摘要），非问题：

```text
groups: open=0, allowlist=0
tools.elevated: disabled
hooks.webhooks: disabled
hooks.internal: enabled
browser control: disabled
trust model: personal assistant (one trusted operator boundary), not hostile multi-tenant
```

✅ **0 critical / 0 warn**，达标。未通过关闭任何安全检查来掩盖问题。

---

## 11. 并发

| 项 | 值 |
| --- | --- |
| `agents.defaults.maxConcurrent` | **`8`** |

作为未来 10 ~ 20 人使用的保守 Baseline。**本阶段不做企微并发压测。**

---

## 12. SFOA 服务回归（确认零影响）

| 服务 | `is-enabled` | `is-active` | 端口 |
| --- | --- | --- | --- |
| `sfoa-mcp-server` | `enabled` | **`active`** | `0.0.0.0:8080` |
| `sfoa-admin-api` | `enabled` | **`active`** | `127.0.0.1:8081` |
| `nginx` | `enabled` | **`active`** | `:80` / `:9000` |

### 12.1 健康检查

| 检查 | 结果 |
| --- | --- |
| MCP `/health` | `200` |
| MCP `/mcp`（GET） | `405`（既有的良性方法探测，非故障） |
| Admin `127.0.0.1:8081/admin/api/health` | `200` |
| 经 Nginx `:9000` 的 `/admin/api/health` | `200` |
| 经 Nginx `:9000` 的 `/mcp`（无凭据） | `403`（预期：需鉴权） |
| Nginx `:9000` `/` | `200` |

### 12.2 时间线证明（未重启、未改动）

| 服务 | `ActiveEnterTimestamp` |
| --- | --- |
| `sfoa-mcp-server` | `2026-09-10 17:11:04 CST` |
| `sfoa-admin-api` | `2026-09-10 17:11:09 CST` |
| `nginx` | `2026-08-05 14:39:15 CST` |
| **OpenClaw 目录创建** | **`2026-09-10 23:24:03 CST`** |

✅ OpenClaw 部署（23:24 起）**晚于** SFOA 服务最后一次重启（17:11）**6 小时**，期间 SFOA 服务**从未被重启或修改**。Nginx 配置亦未改动（`proxy_pass` 仍指向 `127.0.0.1:8081/admin/api/` 与 `127.0.0.1:8080/mcp`）。

✅ **部署 OpenClaw 对 SFOA MCP / Admin API / Nginx 无任何影响。**

---

## 13. 运维手册

### 13.1 服务控制

```bash
systemctl status  openclaw-gateway --no-pager -l
systemctl start   openclaw-gateway
systemctl stop    openclaw-gateway
systemctl restart openclaw-gateway
systemctl is-enabled openclaw-gateway    # → enabled
```

### 13.2 日志

```bash
journalctl -u openclaw-gateway -f
journalctl -u openclaw-gateway --since '1 hour ago' --no-pager
tail -f /data/openclaw/logs/gateway.log      # 文件日志，10 MiB 轮转
```

### 13.3 配置

```bash
openclaw config validate
openclaw config file          # 打印配置路径
openclaw doctor               # 健康检查
openclaw doctor --json
```

### 13.4 安全审计

```bash
openclaw security audit
openclaw security audit --json
openclaw security audit --deep          # 含实时 Gateway 探针
```

### 13.5 模型

```bash
openclaw models status
openclaw models list
openclaw capability model run --help     # 一次性文本推理（本版无 models probe 子命令）
openclaw agent --agent main --session-id <id> --message '...' --timeout 90 --json
```

> ⚠️ `openclaw models status` 会**回显 API Key 的前缀/后缀**。请勿将输出粘贴进工单、聊天或 Git。

### 13.6 端口 / 进程 / 设备

```bash
ss -lntp | grep 18789
ps -ef | grep -i openclaw | grep -v grep
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject  <requestId>
openclaw devices remove  <deviceId>
```

### 13.7 防火墙

```bash
firewall-cmd --state
firewall-cmd --get-active-zones
firewall-cmd --list-all
firewall-cmd --list-rich-rules
firewall-cmd --list-rich-rules --permanent
nft list ruleset | grep 18789
```

> 源地址漂移处置见 §5.6。

### 13.8 SELinux

```bash
getenforce
ls -lZ /data/openclaw/runtime/bin/openclaw
semanage fcontext -l -C
ausearch -m AVC -ts recent
restorecon -Rv /data/openclaw/runtime     # 如需重新打标
```

### 13.9 已知待办（非缺陷）

**Gateway 提示需重启以应用模型目录更新**：

```text
2026-09-11T05:24:15 [gateway] remote model catalog downloaded; restart the Gateway to apply it
```

- 影响面：仅**可用模型列表**的刷新，**不影响已配置的 `DeepSeekV32` 与当前对话链路**；
- 本次**刻意不重启**：避免在验收窗口内扰动一个已验证正常的服务；
- 建议在下一次维护窗口执行 `systemctl restart openclaw-gateway`。

### 13.10 本次清理的遗留项

| 项 | 处置 |
| --- | --- |
| Codex 遗留 headless Firefox（PID 1119348，运行 9h34m，累计 CPU 2h52m，占用调试端口 `127.0.0.1:19222`） | ✅ 已终止，端口已释放 |
| 该 Firefox 对应的失效设备配对（IP `192.168.156.203`） | ✅ 已 `devices remove` |
| `/data/openclaw/state/openclaw.json.bak*` 明文备份 ×5 | ✅ 已归并至敏感备份目录（§8.3） |
| 本地 `.temp/openclaw-ops` 含密钥的临时文件 | ✅ 已删除（见 §18） |

---

## 14. 备份

| 路径 | 内容 |
| --- | --- |
| `/data/openclaw/backups/20260910-baseline/` | OpenClaw 迁移前全量现场（配置 / 单元文件 / firewalld / SELinux fcontext / SFOA 三服务状态与配置哈希 / SFOA 健康快照） |
| `/data/openclaw/backups/20260910-baseline/state-config-plaintext-backups/` | 本次归并的 5 个明文配置备份 |
| `/data/openclaw/backups/20260910-baseline/SENSITIVE-BACKUP.txt` | 敏感标记与处理规则 |

> ⚠️ **该目录含明文凭证**，权限 `700` / 文件 `600` / `root:root`，**严禁复制进 Git**。详见 §8.4。

SFOA 侧部署前备份（P8-07）见 `docs/sfoa/TEST_SERVER_DEPLOYMENT.md`。

---

## 15. 回滚

### 15.1 回滚 Control UI 的 LAN 暴露（最小回滚）

```bash
firewall-cmd --permanent --remove-rich-rule='rule family="ipv4" source address="172.70.1.0/24" port port="18789" protocol="tcp" accept'
firewall-cmd            --remove-rich-rule='rule family="ipv4" source address="172.70.1.0/24" port port="18789" protocol="tcp" accept'
# 如需恢复 Codex 原始规则：
# firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="20.0.0.7/32" port port="18789" protocol="tcp" accept'
# firewall-cmd            --add-rich-rule='rule family="ipv4" source address="20.0.0.7/32" port port="18789" protocol="tcp" accept'
```

### 15.2 回滚 OpenClaw 服务

```bash
systemctl stop openclaw-gateway
systemctl disable openclaw-gateway
```

### 15.3 回滚到迁移前的明文配置（**会重新引入明文密钥**）

```bash
systemctl stop openclaw-gateway
cp /data/openclaw/backups/20260910-baseline/openclaw.pre-secretrefs.json \
   /data/openclaw/state/openclaw.json
chmod 600 /data/openclaw/state/openclaw.json
openclaw config validate
systemctl start openclaw-gateway
```

### 15.4 回滚 systemd 单元

```bash
cp /data/openclaw/backups/20260910-baseline/openclaw-gateway.service \
   /etc/systemd/system/openclaw-gateway.service
systemctl daemon-reload
systemctl restart openclaw-gateway
```

### 15.5 回滚 SELinux 标签（仅在需要时）

```bash
semanage fcontext -d '/data/openclaw/runtime/bin/openclaw'
semanage fcontext -d '/data/openclaw/runtime/tools/node-v24.19.0/bin/node'
restorecon -Rv /data/openclaw/runtime
```

> ⚠️ 删除 fcontext 后 Gateway 将**回到 `203/EXEC` 启动失败**状态。**不要**用 `setenforce 0` 作为替代。

### 15.6 完全移除 OpenClaw（**破坏性，需用户明确批准**）

```bash
systemctl stop openclaw-gateway && systemctl disable openclaw-gateway
rm -f /etc/systemd/system/openclaw-gateway.service
rm -rf /etc/systemd/system/openclaw-gateway.service.d
systemctl daemon-reload
# 确认备份已归档后再删除（含明文凭证，注意销毁方式）
# rm -rf /data/openclaw
```

> 回滚**不涉及** SFOA：SFOA 服务、配置、Nginx 本次均未改动（§12.2）。

---

## 16. 验收

### 16.1 验收判定

| 判定 | 结果 |
| --- | --- |
| **OpenClaw 服务端 Baseline** | ✅ **`READY`** |
| **Windows 直连 LAN 浏览器路径** | ✅ **`READY`**（本次修复，**非** `EXTERNAL_NETWORK_BLOCKER`） |
| **总体** | ✅ **`READY`** |

> §38 预设的「服务器正常但 Windows 被上游 ACL 阻断 → `PARTIAL` / `BLOCKED`」情形**未发生**：本次查明阻断源为**服务器本机 firewalld 的过期源地址规则**，已修复并双端取证。

### 16.2 READY 七项门槛逐条核对（§39）

| # | 门槛 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | `Test-NetConnection` = True | ✅ | `TcpTestSucceeded = True` |
| 2 | `curl` = HTTP response | ✅ | `HTTP/1.1 200 OK`，0.044s |
| 3 | Browser UI = loaded | ✅ | `/chat/main` 加载成功 |
| 4 | Gateway Auth = passed | ✅ | 令牌登录成功；错误/无令牌均被拒绝 |
| 5 | Device Pairing = passed | ✅ | `devices approve` 后连接建立 |
| 6 | Chinese UI = passed | ✅ | `lang=zh-CN`，103 ~ 133 汉字 |
| 7 | Chat = passed | ✅ | UI 内发送并收到 `OpenClaw Baseline OK` |

**七项全部通过 → 判定 `READY`。**

---

## 17. 架构边界（本阶段到此为止）

```text
Windows Browser
      ↓
OpenClaw Control UI
      ↓
OpenClaw Agent
      ↓
DeepSeek
```

**本阶段明确未做**：

| 项 | 状态 |
| --- | --- |
| 企微插件 / Bot ID / WeCom Secret / WeCom WebSocket | ❌ 未安装、未配置 |
| OpenClaw 接入 `sfoa-enterprise-mcp` | ❌ 未配置 |
| `MCP_WECOM_CLIENT_TOKEN` / `X-WeCom-User-Id` | ❌ 未添加 |
| P8-05 / P8-06 / Identity Route / Salesforce Runtime | ❌ 未修改 |
| `sfoa-enterprise-mcp` 身份链 | ❌ 未改动 |

---

## 18. 本地临时文件与 Secret 卫生

| 项 | 状态 |
| --- | --- |
| `D:\GitProject\sfoa-enterprise-mcp\.temp\openclaw-ops` | 执行期临时目录 |
| 是否被 Git 跟踪 | ❌ **否** —— `.gitignore:60` 已忽略 `.temp/` |
| 本次产生的含密钥文件（`.gateway-token` / `.dashboard.json` / `.windows-bootstrap.url`） | ✅ **已删除** |
| Codex 既有脚本（`*.sh` / `*.cjs`）是否硬编码密钥 | ✅ **无**（扫描确认；`package-lock.json` 命中为 sha512 误报） |
| 提交前校验 | `git status` / `git diff` / `git diff --check` + secret 扫描，**不含 token / apiKey / password / secret / private key / SSH key** |

---

## 19. 与 Codex 交接记录的差异汇总

| # | Codex 记录 | 实测结论 | 处置 |
| --- | --- | --- | --- |
| 1 | 18789 被「公司 VPN / Zero Trust / 上游 ACL」阻断 | ❌ 实为**服务器本机 firewalld 过期源地址规则** | ✅ 已修复并双端取证 |
| 2 | tcpdump「完全没有收到 Windows 发往 18789 的数据包」 | ❌ SYN **一直有到达**；Codex 按过期源 IP `20.0.0.7` 过滤导致漏看 | ✅ 已用无源过滤抓包推翻 |
| 3 | Windows 源 IP = `20.0.0.7` | ❌ 现为 `172.70.1.165`（DHCP） | ✅ 规则已按新网段调整 |
| 4 | SecretRef 迁移完成 | ⚠️ 活动配置✅，但 state 下**5 个 `.bak` 仍含明文** | ✅ 已归并至敏感备份目录 |
| 5 | （未记录） | ⚠️ headless Firefox 孤儿进程运行 9h34m、占调试端口 | ✅ 已终止 + 撤销失效配对 |
| 6 | SELinux 已修复 | ✅ 复核一致：`Enforcing` + 自定义 fcontext → `bin_t` | 保留 |
| 7 | 安全配置（token / allowedOrigins / tool policy / maxConcurrent） | ✅ 复核全部一致 | 保留 |
| 8 | 模型链路可用 | ✅ 复核一致（CLI + UI 双通道） | 保留 |
| 9 | Security audit 0 critical / 0 warn | ✅ 复核一致（另有 1 条 info） | 保留 |

---

## 20. 最终问答（§44 八问）

### 1. OpenClaw 是否真正 `systemctl enabled` + `running`？

✅ **是**。`is-enabled = enabled`，`is-active = active (running)`，启动于 `2026-09-10 23:29:03`，且**全机仅一个 Gateway 进程**，不存在 system + user 双 Gateway。

### 2. `192.168.156.203:18789` 是否已 Windows → TCP 可达？

✅ **是**。`Test-NetConnection → True`，`curl → HTTP 200`，抓包见完整 `SYN → SYN-ACK → ACK → 数据`。

### 3. 此前无法访问时，究竟是哪一层阻断？

✅ **服务器本机 firewalld**（`public` zone 的 `filter_IN_public` → `reject with icmpx admin-prohibited`），根因是放行规则源地址锁定在过期的 `20.0.0.7/32`。

**判断依据为抓包证据**：SYN 已到达 `ens160` 却无 SYN-ACK ⇒ 包已进入主机、被本机 netfilter 拦下 ⇒ **不可能是 Windows / VPN / Zero Trust / 上游 ACL**。同时 `ip route` / `ip rule` / `ip route get` 证明返回路径唯一正常，排除服务器路由与非对称路由。**OpenClaw 与 SELinux 自始至终正常**（SELinux 为 `Enforcing` 且无 AVC deny）。

### 4. Control UI 是否中文 / Token 保护 / Device Pairing 保护？

✅ **三项全部满足**。`lang=zh-CN`（中文导航：首页/仪表盘/自动化/插件/会话）；`auth.mode = token` 且错误/无令牌均被拒绝；`dangerouslyDisableDeviceAuth = false`，Windows 浏览器经官方 `devices approve` 流程配对成功。

### 5. DeepSeek 是否真实可用？

✅ **是**。CLI 与浏览器 UI **双通道**均实测返回 `OpenClaw Baseline OK`；`models status` 显示 SecretRef 托管凭据；**未输出任何 API Key**。

### 6. Agent 是否真实无 Shell / 无文件系统修改 / 无服务器管理工具？

✅ **是**。`systemPromptReport.tools.entries = []`（零工具），`uname -a` 测试返回 `Tool unavailable`，journal 中无任何 exec 调用；`tools.deny = ["*"]`、`exec.mode = deny`、`elevated` 关闭、`browser` 关闭、`gateway.terminal` 关闭。

### 7. 部署 OpenClaw 是否对 SFOA MCP / Admin API / Nginx 造成影响？

✅ **无任何影响**。三服务均 `enabled` + `active`，健康检查全绿；且从时间线看，SFOA 服务最后一次重启（`09-10 17:11`）**早于** OpenClaw 部署（`09-10 23:24`）6 小时，期间未被触碰；Nginx 配置未改动。

### 8. OpenClaw Baseline 是否已足够进入下一阶段（官方企微插件 + Trusted requesterSenderId 验证）？

✅ **是**。服务端 Baseline 已收口：Gateway 常驻自启、认证与限流到位、工具面完全封闭、密钥全部 SecretRef 化、安全审计 0 critical / 0 warn、模型链路真实可用、`maxConcurrent = 8` 可支撑 10 ~ 20 人。

**进入下一阶段前建议先完成 2 件事**：

1. 在下一次维护窗口 `systemctl restart openclaw-gateway`，应用已下载的模型目录更新（§13.9，非阻塞）；
2. 由网络管理员为管理端分配**固定 IP 或 DHCP 保留**，把 §5.6 的防火墙规则收窄为 `/32`，彻底消除源地址漂移风险。

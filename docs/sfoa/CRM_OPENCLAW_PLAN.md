# CRM OpenClaw 一期计划

日期：2026-10-21 启动，2026-10-22 续接
建议分支：`feature/crm-openclaw-entry`（主工程）
状态：**IMPLEMENTED_PENDING_ENVIRONMENT_VERIFICATION**

本计划按任务书 M0–M5 推进。勾选只代表“本地实现/测试已完成”，不代表真实环境或 UAT 已通过。

## 一、基线与范围

| 项 | 值 |
| --- | --- |
| MCP 工程 | `D:\GitProject\sfoa-enterprise-mcp`，分支 `feature/crm-openclaw-entry`，基线 `origin/main@12df237` |
| CRM 工程 | `D:\GitProject\crm`，分支 `uat`，开始 HEAD `a55870a`（不新建/不切换分支） |
| OpenClaw | 测试服实际 `2026.9.5 (ec9c1a1)`；文档旧记 2026.9.3，以实测为准 |
| 交付提交 | `feature/crm-openclaw-entry`：`561bda4`、`91d0d0c`、`44887a1`；已推送 `origin` |
| Salesforce | 沙盒 `runnergroup--uat.sandbox.my.sfcrmproducts.cn`，OrgId `00DC5000000lGFpMAM`，API 68.0 |
| 本期范围 | 文本聊天；不做附件/语音/多模态、共享会话、Salesforce Action/Apex 自动生成、P11-A CI 治理 |

## 二、架构决策（摘要）

```text
Salesforce LWC
  -> Apex 当前用户身份签发（证书签名，90s token）
  -> CRM 接入服务（Apex 验签 + 一次性 jti + 短期聊天凭证 + 对话归属）
  -> OpenClaw CRM 渠道插件（ credentialed HTTP ingress, SenderId=platformUserId ）
  -> 现有 SFOA MCP（CRM 渠道凭据 + X-SFOA-CRM-User-Id -> Identity Route）
  -> Salesforce（按真实用户权限执行）
```

关键决定：

1. Apex 使用 `Crypto.signWithCertificate`，私钥留在 Salesforce 证书存储，不进入源码/Custom Setting/Git。
2. 接入服务固定信任 issuer/audience/org/公钥（可选证书 SHA-256 指纹），不接受动态公钥；jti 用 MySQL 主键原子消费。
3. 浏览器只持有 15 分钟不透明聊天 token（内存），数据库只存 SHA-256。
4. 身份绑定是显式的 `(salesforce_org_id, salesforce_user_id) -> platform_user_id`，默认拒绝，不按昵称/模糊用户名匹配。
5. 每个 CRM 对话映射到 OpenClaw 官方 `resolveAgentRoute` 产生的独立 sessionKey；正文留在 OpenClaw，MySQL 只存归属/运行状态。
6. OpenClaw 插件通过 `api.runtime.subagent.getSessionMessages(...)`（内部官方 `sessions.get`）读取历史。该 history 路由使用 `auth:"gateway"` + trusted-operator，接入服务仅在服务端持有 `CRM_GATEWAY_HISTORY_TOKEN`（优先只读 device token），不把它当作用户身份；turn/abort 仍走独立 service token。
7. MCP 侧新增独立渠道凭据 `MCP_CRM_CLIENT_TOKEN` 与 `X-SFOA-CRM-User-Id`，审计来源 `CRM_HEADER`；WeCom/Internal/UserBound/Buntu 路径不变。

## 三、任务清单

### M0 基线、接点、可运行契约

- [x] 读取 AGENTS/CLAUDE、maintainer Skill、四份 `docs/sfoa` 基线文档
- [x] 记录两工程分支/HEAD/工作区差异；MCP 从 `origin/main` 创建功能分支
- [x] 运行 `yarn ai:snapshot` / `yarn ai:doctor`（本地 15→16 migrations）
- [x] 核实 OpenClaw 2026.9.5 的插件 API、Channel/HTTP/网关扩展点
- [x] 核实沙盒 OrgId/实例/API 版本与两名已连接真实账号
- [x] 记录身份/会话/审计契约与未知项

### M1 Salesforce 入口与可信身份

- [x] Apex `SfoaCrmChatIdentity`（UserInfo 身份、证书签名、90s、jti）
- [x] Custom Setting `SFOA_CRM_Chat_Config__c`（Public；只含端点/证书名/issuer/audience/TTL）
- [x] 接入服务 Apex token 验签、时间/组织/接收方/一次性兑换
- [x] 短期聊天凭证签发/校验/过期/撤销
- [x] Apex 测试类、Permission Set、精确 manifest
- [x] **CRM 元数据已部署 UAT**：12 组件、`SfoaCrmChatIdentityTest` 7/7、0 错误（Deployment `0AfC5000005GP4PKAW`）
- [ ] 真实 Salesforce 证书创建/下载与实际签名（待用户执行）

### M2 可信 CRM 渠道与现有 MCP 真实调用

- [x] OpenClaw CRM 渠道插件：独立 channel id、凭证化 ingress、SenderId 注入
- [x] MCP 适配器：`sfoa-crm` 渠道 + CRM 凭据 + `X-SFOA-CRM-User-Id`
- [x] MCP 运行时：CRM 渠道凭据、`CRM_HEADER` 审计、配置 fail-fast
- [x] 显式身份绑定表 + 管理员绑定 CLI + 默认拒绝
- [x] 单元/HTTP 测试：渠道隔离、身份不可借用、审计来源
- [x] REAL_OPENCLAW 隔离 Gateway（mock MCP）验证：插件注册、turn、官方 session route、历史、`X-SFOA-CRM-User-Id` 到达 MCP
- [ ] **真实 OpenClaw → 现有 MCP → Salesforce 双用户只读验证**
- [ ] 真实账号并发/权限差异证据

### M3 多对话、流式体验与用户隔离

- [x] 每对话独立 ID + 官方 sessionKey 映射持久化
- [x] 对话/历史/运行/停止归属校验；跨用户统一 404
- [x] 流式 SSE（delta/replace/final）、停止、忙 409
- [x] 重复 `clientMessageId` 不重派；服务重启后未知结果不自动重试
- [x] 服务端运行状态缓冲（内存、有界、可重连）
- [x] LWC：只读当前账号、新建/历史/发送/流式/停止/刷新恢复、安全文本渲染
- [x] Aura Utility Bar wrapper
- [ ] **LWC 未在真实 Lightning 页面运行**
- [x] 真实 OpenClaw `sessions.get` 返回结构投影已验证（隔离 Gateway）
- [ ] 跨用户历史/文件/记忆/子代理路径的真实复核（本期未开放文件）

### M4 测试、真实集成与兼容性

- [x] MCP CRM 渠道 12 项 + HTTP 2 项；既有身份回归 23 项
- [x] 接入服务 23 项 + MySQL 仓储 1 项
- [x] OpenClaw 适配器 68 项；CRM 插件 26 项
- [x] REAL_OPENCLAW 隔离 Gateway（mock MCP）：turn + session route + history + header 注入
- [x] 本地迁移 016 + schema 校验
- [x] CRM 元数据部署 UAT + Apex 测试 7/7（Deployment `0AfC5000005GP4PKAW`）
- [ ] **真实双用户并发（10–20 规模）**
- [ ] **真实浏览器 UAT**
- [x] 未有本次新增回归（已执行范围内）

### M5 文档、变更集与最终交付

- [x] `CRM_OPENCLAW_PLAN.md`
- [x] `CRM_OPENCLAW_IMPLEMENTATION_REPORT.md`
- [x] `CRM_OPENCLAW_TEST_MATRIX.md`
- [x] `CRM_OPENCLAW_CRM_CHANGESET.md`
- [x] `CRM_OPENCLAW_DEPLOYMENT.md`
- [x] `docs/sfoa/evidence/crm-openclaw/`
- [x] CRM 精确 manifest + destructive manifest
- [x] 分支提交/推送（`561bda4` + 文档补记 `91d0d0c`/`44887a1`；未合并 main、未删除分支）
- [ ] 独立审查与用户 UAT

## 四、剩余事项（按优先级）

1. 在 UAT 创建专用签名证书（Setup → Certificate and Key Management），导出公开证书 PEM/SHA-256；填写 `Certificate_Name__c` 与 `Endpoint__c`，再将 `Enabled__c=true`。
2. 分配 `Sfoa_Crm_Chat_Access` Permission Set；把 `sfoaCrmChatUtilityBar` 加入目标 Lightning App 的 Utility Bar（不改既有 app 元数据可由管理员手工完成）。
3. 部署接入服务、OpenClaw CRM 插件、MCP CRM 渠道；执行 `crm:bind` 两名用户绑定；配置 `CRM_GATEWAY_HISTORY_TOKEN`。
4. 两名真实账号的只读/权限/并发验证，再 10–20 并发规模；不得复用企微长连接，不重启共享服务。
5. 在真实 Lightning 页面完成 Utility Bar/LWC UAT。
6. 视结果将状态提升为 `READY_FOR_UAT` 或记录 `BLOCKED`。

## 五、状态口径

- 当前不能称 COMPLETE：真实 Salesforce 业务调用、浏览器 UAT 仍未完成；入口默认禁用。
- 当前也不能称 READY_FOR_UAT：证书/接入服务/OpenClaw/MCP 未配置，真实链路未跑通。
- 本计划选择的交付状态是 **IMPLEMENTED_PENDING_ENVIRONMENT_VERIFICATION**；若后续发现运行缺陷，则按 `BLOCKED` 记录具体项。

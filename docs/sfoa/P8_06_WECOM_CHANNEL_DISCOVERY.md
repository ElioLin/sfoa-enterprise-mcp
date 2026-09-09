# P8-06 — WeCom Channel Credential 与无最终用户身份的 MCP Discovery

实施日期：2026-09-08 至 2026-09-09。设计决策见 [ADR-0020](adr/ADR-0020-wecom-channel-discovery.md)。

**P8-06 COMPLETE — 代码及所需自动化分项验收完成。实际企业微信 A/B UAT 待执行。**

## Git 与 Review

- BASE_COMMIT / origin/main：`7519b66eed8377a819650d96411926959e2cd8af`。
- 分支：`feature/p8-06-wecom-channel-credential`，由 fetch 后的最新 origin/main 创建。
- 最终提交 SHA：以本报告所在 feature 分支的 `git rev-parse HEAD` 与交付消息为准。
- 未直接在 main 开发，未 reset、force push 或修改真实环境凭据。
- Review 覆盖 authenticator、HTTP、runtime、config、provider-runtime、policy-snapshot，以及 Control Plane、Identity Runtime、Admin API/Web、Agent Playbook；检索任务指定的认证、协议方法、身份头与 snapshot 入口。

## 根因与两阶段认证

基线 HTTP 的 `executeMcpPost` 在 bounded JSON body 解析后，无条件调用
`UnifiedIdentityProvider.authenticate`。该方法同时完成 Bearer 认证和最终用户身份解析；
缺少身份头会在加载 RequestPolicySnapshot、Identity Route、RequestScope 和进入 SDK 之前抛出
`MCP_PLATFORM_USER_REQUIRED`。因此只有 Bearer 的企微插件注册握手无法到达 initialize/tools/list。

本次将凭据与最终用户分离：

```text
Discovery = authenticateCredential → global governance → discovery SDK server
Execution = authenticateCredential → resolvePrincipal → user route/snapshot → RequestScope → governed tool
```

保留 `authenticate` 作为完整执行路径兼容 wrapper。WeCom 凭据认证只产生
`clientId=wecom-channel`、`credentialChannel=WECOM`，不会产生 platformUserId 或 identitySource。
没有 synthetic user、假 Route 或共享 Salesforce 用户。

| Channel | Credential | 最终用户身份权威 |
| --- | --- | --- |
| Internal | MCP_CLIENT_TOKEN | X-Platform-User-Id |
| WorkBuddy | USER_BOUND_TOKEN (`sfoa_ub1_` family) | Token 绑定的 Identity Route |
| Dify / 小犇 | BUNTU_TOKEN | validate-token 返回的 userId |
| WeCom | MCP_WECOM_CLIENT_TOKEN | 企业微信自动注入的 X-WeCom-User-Id |

Provider supports 互斥：USER_BOUND 前缀、Internal exact、WeCom exact、其余符合条件的 Buntu 候选。
所有 exact 比较通过固定长度 SHA-256 digest + timingSafeEqual；Buntu 显式排除两个配置 Token，
即使 WeCom 尚未启用也不会吞掉已配置的 WeCom Token。Buntu 开启时，任意未知 Token 只能成为
Buntu 验证候选，其合法性仍由 validate-token 决定；未开启 Buntu 时直接 CLIENT_AUTH_INVALID。
USER_BOUND/Buntu 的可选身份头仍必须与其权威身份一致，不改 WorkBuddy/Dify 主链路。

## Discovery allowlist 与隔离

仅启用且认证成功的 WeCom Channel 可免最终用户身份：

| Method | 原因 |
| --- | --- |
| initialize | 当前 SDK 1.18.2 握手、协议版本与 capabilities |
| notifications/initialized | 完成当前握手通知 |
| tools/list | 全局治理工具目录 |
| ping | 纯协议健康探测 |

分类仅依据已 bounded/parsed 的 JSON-RPC body，客户端 `X-MCP-Discovery` 不起作用。
resources/list、resources/read、prompts/get、未知方法、空/畸形 batch 均要求身份。
当前 SDK 实测接受普通 batch；所有消息都在 allowlist 才可进入 Discovery。
混合 tools/list + tools/call 无身份时拒绝；initialize batch 的协议限制由 SDK 处理。
Internal 的 initialize 无身份仍返回 PLATFORM_USER_REQUIRED。

`RuntimeDiscoveryPolicySnapshot` 与 RequestPolicySnapshot 共享全局 loader，分别位于
REPEATABLE READ transaction 内。enabled tools、enabled DML policies、managed fields、
Diagnostic 与 runtime settings 的表均为全局配置，没有 per-user key。
Discovery 不执行 Diagnostic 与用户 Route 的冲突查询；执行快照继续保留该检查。

**Discovery catalog is channel/global governed; tools/call remains user/route governed.**

Discovery composition 使用现有 inventory Services、官方/自有 Provider、共享工具 schema
与 Agent capability/instructions builders，由 MCP SDK 处理协议。管理员禁用的工具不会返回；
重新启用后下一请求可见。启用 DML Tool 却没有有效 DML Policy 时仍 fail closed。
资源/Prompt capabilities 与执行 Server 保持一致，但 HTTP 不放宽其访问身份要求。
注册的每个 handler 和额外 SDK tools/call guard 都拒绝执行，返回
`MCP_DISCOVERY_EXECUTION_FORBIDDEN`，即使分类器未来误放也没有 Salesforce 访问路径。

真实 Node HTTP 测试对 initialize / notifications/initialized / tools/list / ping 断言：

| Side effect | 调用次数 |
| --- | ---: |
| 用户 snapshot / Identity Route lookup | 0 |
| scopeFactory.create / createForRoute | 0 / 0 |
| Salesforce Connection / JWT factory | 0 |
| Salesforce API / query / DML | 0 |

MySQL 测试另外在 SQL AST 层拦截所有 Identity Route 表访问，在 Diagnostic 配置启用时仍通过。
Discovery composition 无 diagnostic scope factory 或 SalesforceConnectionProvider。
完整 catalog 的 schema 与正常执行 server 深比较覆盖官方、Context、DML 和 Agent tools。

## Channel Binding 与 Audit

WeCom 启用时，WeCom Token + X-Platform-User-Id 与 Internal Token + X-WeCom-User-Id
均返回 HTTP 403 `MCP_IDENTITY_CHANNEL_MISMATCH`。Internal 只接受 X-Platform-User-Id，
旧配置把 WeCom 作为 primary header 也不能绕过绑定。
重复/多个身份头保留 PLATFORM_IDENTITY_CONFLICT。WeCom tools/call 缺头时返回
PLATFORM_USER_REQUIRED，Route、Connection、工具执行为零；有头时完整解析用户 Route。
不存在与停用 Route 分别返回 ROUTE_NOT_FOUND / ROUTE_DISABLED。

Discovery 安全审计示例（展示字段语义，不含凭据）：

```json
{
  "clientId": "wecom-channel",
  "platformUserId": null,
  "identitySource": null,
  "salesforceUsername": null,
  "operation": "tools/list",
  "result": "PASS",
  "requestSummary": { "eventCategory": "MCP", "eventType": "MCP_DISCOVERY" }
}
```

Runtime event 同时带 MCP/MCP_DISCOVERY 与 outcome=SUCCESS。现有 legacy Audit DTO
没有顶层 category/type 列，因此 durable runtime audit 在 requestSummary 保留这两个字段；
没有为 Discovery 伪造 MCP_TOOL_CALL。MySQL 实测 user/source/username 持久化为 null。

执行审计保留 P8-05/P7 语义，例如 `clientId=wecom-channel`、
`identitySource=WECOM_HEADER`、`platformUserId=user-a`、
`salesforceUsername=<Route A 的 Salesforce 用户>`。
Channel mismatch 的事件归类为 IDENTITY / DENIED，result=BLOCKED，
errorCode=MCP_IDENTITY_CHANNEL_MISMATCH；不是普通 MCP 错误。
Audit 失败继续 fail open。WeCom Token 不写 stdout/Audit/Admin API/Web，也不暴露 mask/last4。

## 管理页面与部署

Admin API 只新增 configured.wecomChannelEnabled 与
configured.wecomChannelCredentialConfigured 两个 readiness booleans。
“智能体接入 → 企业微信”显示独立 Channel Credential、插件共享但不绑定用户、自动身份注入、
工具发现与工具执行两个阶段，以及未启用提示。桌面/移动布局有浏览器测试。
Role Setting 继续保持业务指引，不加入凭据或 MCP 握手配置。

服务器配置：

```env
MCP_PLATFORM_USER_HEADER=X-Platform-User-Id
MCP_PLATFORM_USER_HEADER_ALIASES=X-WeCom-User-Id
MCP_WECOM_CHANNEL_ENABLED=true
MCP_WECOM_CLIENT_TOKEN=<CHANGE_ME>
```

部署时必须将 placeholder 替换为独立随机 secret（强制至少 32 个非空白字符，上限 4096），
不得等于 MCP_CLIENT_TOKEN 或带 sfoa_ub1_ 前缀。启用却未配置会启动 fail-fast。
默认不启用，便于按部署迁移；关闭时保留已有 P8-05 兼容行为。
企微插件 Authorization 填 `Bearer <MCP_WECOM_CLIENT_TOKEN>`，通过受控 HTTPS MCP URL 接入。
**X-WeCom-User-Id is auto-injected by WeCom.** 不手填用户、不添加共享 Route。
重启 MCP Runtime 与 Admin API 后检查 readiness。保留 Internal Token 给内部客户端。

## 验证结果

执行 `node scripts/p8-04-regression.mjs`：30/30 gates PASS（以 results.json 实际条目计数）。它在各 workspace 使用本地
TypeScript/Node/Vitest 可执行文件，对应实际 package scripts；未依赖 Windows Yarn 通配符转义。

| Workspace | 命令/覆盖 | 状态 |
| --- | --- | --- |
| sfoa-identity-runtime | build、lint、test | PASS |
| sfoa-control-plane | build、lint、test、test:mysql | PASS |
| mcp-provider-sfoa-context | build、lint、test | PASS |
| mcp-provider-sfoa-dml | build、lint、test | PASS |
| sfoa-agent-playbook | build、lint、test | PASS |
| sfoa-mcp-server | build、lint、test、test:p3、test:p4、test:p5、test:p7、validate:upstream | PASS |
| sfoa-admin-api | build、lint、test | PASS |
| sfoa-admin-web | lint、build、test | PASS |

上述 harness 实际命令（cwd 为对应 workspace）：

```text
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node --test-concurrency=1 --test dist/test/*.test.js
node --test-concurrency=1 --test dist/mysql-test/*.test.js
node --test-concurrency=1 --test dist/p3-test/*.test.js
node --test-concurrency=1 --test dist/p4-test/*.test.js
node --test-concurrency=1 --test dist/p5-test/*.test.js
node --test-concurrency=1 --test dist/p7-test/*.test.js
node dist/validation/upstream-compatibility.js
node node_modules/vite/bin/vite.js build
node node_modules/vitest/vitest.mjs run
```

| 额外命令 | 状态/证据 |
| --- | --- |
| yarn ai:snapshot / yarn ai:doctor | PASS；MySQL 8.0.30 可达，migrations 001–013 已安装 |
| node --test dist/test/wecom-discovery.test.js dist/test/identity-provider.test.js | PASS，最终 27/27，包含真实 Node HTTP、Provider 互斥、A–P 核心场景 |
| node --test --test-name-pattern=P8-06 dist/mysql-test/mysql.integration.test.js | PASS，Diagnostic 启用时仍零 Route SQL |
| node node_modules/vitest/vitest.mjs run src/test/Connectivity.test.ts src/test/InstructionGenerator.test.ts | PASS，16/16 |
| node --test dist/test/playbook.test.js | PASS，16/16；Role Setting 无新增凭据/协议术语 |
| node node_modules/@playwright/test/cli.js test e2e/wecom-channel.spec.ts | PASS；启用/未启用，桌面与 390px 手机布局 |
| node node_modules/@playwright/test/cli.js test e2e/admin-control-plane.spec.ts | PASS；修正旧夹具必填用户名称及现有 UI 标签 |
| node scripts/validate-p5.mjs（yarn validate:p5 的入口） | 单元、MySQL、Admin build、70/70 Web tests、3/3 browser tests PASS；命令最终 FAIL 于旧 fullstack 审计展示断言，已修正并单独复验 |
| node scripts/p5-fullstack-e2e.mjs（修正断言与隔离外部 JWT 后） | PASS；真实 React → Admin API → MySQL，路由/凭据生命周期、治理持久化与 35 条 Audit 证据 |
| node packages/sfoa-runtime-validation/dist/stdio-regression.js | PASS；initialize、5 tools、get_username |
| yarn build（普通 Windows PATH） | 初次 FAIL：未修改上游 Code Analyzer 的 POSIX cp 缺失 |
| yarn build（PATH 加入 D:\\Git\\usr\\bin） | PASS，完整 root build |
| yarn lint | FAIL / KNOWN UPSTREAM DEBT：未修改官方 Code Analyzer 的 47 项既有错误；所有受影响 SFoA lint PASS |
| yarn skill:sync / skill:check / skill:test / skill:delivery | PASS；12 Skill tests，3 平台副本同步，delivery 可追踪 |
| git diff --cached --check；本地凭据与暂存 diff 比对 | PASS；无 .env.local、真实 Token、私钥或测试产物进入提交 |
| 实际 WeCom A/B 会话与 Salesforce 权限 UAT | SKIPPED / NOT TESTED；需要真实企微插件与两位用户 |

本地日志保存在 ignored `.temp`，例如 `p8-04-regression/results.json`、
`p8-06-validate-p5-final.log`、`p8-06-fullstack-isolated.log`、`p8-06-root-build-posix.log`、`p8-06-stdio.log`。
汇总脚本沿用 P8-04 名称，但本轮 results 为 P8-06 工作树重新运行的证据。
首次 P5 汇总暴露过时浏览器夹具，已修正用户名称、精确标签、自动验证弹窗、审计展示与分页种子。
Admin 启动会为分页夹具的 25 个虚构用户尝试 seed auth store；原测试继承本机真实 JWT 配置，
导致独立复验出现启动超时。全栈测试现在使用 `.invalid` Salesforce host 和临时无效 key，
签名在本地失败，验证结果仍由真实 Admin API 返回，测试结束删除临时文件。
生产 JWT/seed 代码没有更改；测试不再需要外部 Salesforce 可用性。
修复仅影响最后的 fullstack gate，因此复验该 gate，而不重复已通过的全部前置 gates。
MCP/Admin 启动错误脱敏补充 WeCom Token 后，两包再次 TypeScript 编译通过。

## 企业微信实际 UAT checklist

本机自动化包含真实 HTTP + MySQL、四条认证路径及 recording Salesforce factory；
没有企业微信控制台/用户会话，下面实际平台 UAT 尚未执行：

1. 在企微插件 Authorization 中配置 `Bearer <MCP_WECOM_CLIENT_TOKEN>`。
2. 保存插件，确认 initialize/tools/list 成功，工具目录符合 Admin 当前启用配置。
3. 检查 Discovery Audit：clientId=wecom-channel，无 platformUserId/identitySource/Salesforce username，无 Salesforce API。
4. 用户 A 提问，确认自动注入 X-WeCom-User-Id=A；审计 user 与 Salesforce Route 都属于 A。
5. 用户 B 提问，确认自动注入 X-WeCom-User-Id=B；审计 user 与 Salesforce Route 都属于 B。
6. 对 A/B 可见性不同的已知记录做只读查询，确认 Salesforce 数据权限不串号；禁用 Route 后重试应拒绝。

## 后续设计边界

本次不升级 @modelcontextprotocol/sdk 1.18.2，不更改 JWT、CRUD/FLS、Query/DML Policy
或 Metadata Diagnostic 执行语义。未来 SDK 升级时，按届时官方协议验证所提及的
MCP 2026-era server/discover，并纳入同一个 CLIENT_AUTHENTICATED_DISCOVERY 安全模型；
当前不开放该方法。若未来工具可见性变成 per-user，必须重新设计全局 Discovery catalog 合约。

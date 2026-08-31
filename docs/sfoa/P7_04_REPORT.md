# P7-04 Salesforce API 透明审计实施报告

状态：**IMPLEMENTED / AWAITING MAINTAINER REVIEW**

日期：2026-08-31

本报告记录实现前调用路径盘点、最终实现、实际 Gate 与已知边界。该状态不表示 Maintainer 已完成验收，也不表示 P7-04 `COMPLETE`。

## 1. Salesforce 调用路径盘点

盘点使用当前分支源码、项目本地 CodeGraph 索引和实际安装依赖源码交叉确认。CodeGraph 同步结果为 571 files、7,225 nodes、16,757 edges；最终事实以源码和已安装包为准。

当前固定依赖为 `@salesforce/core@8.29.0`，其实际解析 `@jsforce/jsforce-node@3.10.13`。`@salesforce/core Connection` 继承 JSforce `Connection`。JSforce `query()`、`tooling.query()`、`request()`、`sobject().create()`、`sobject().update()` 和 Metadata/SOAP API 最终都调用同一 `Transport.httpRequest()`。

### Salesforce Call Path Matrix

| 调用来源 | 当前实际代码路径 | 实际传输 | 能否看到真实 HTTP | P7-04 方案 |
| --- | --- | --- | --- | --- |
| Request-scoped JWT/OAuth | `JwtConnectionFactory.create()` → `AuthInfo.create({ oauth2Options })` → Core `authJwt()` → JSforce `OAuth2.requestToken()` | OAuth 2 JWT Bearer / JSforce transport | YES | 统一 transport 记录 OAuth token 请求；不读取或保存 assertion、access token、private key、client secret |
| AuthInfo org capability discovery | Core `determineIfDevHub()` / `getNamespacePrefix()` | REST query / JSforce transport | YES | 统一 transport 自动记录；Purpose 为身份初始化，不新增 API |
| Connection API-version initialization（仅无固定版本时） | `Connection.create()` → `useLatestApiVersion()` → `request(/services/data)` | REST / JSforce transport | YES | 统一 transport 自动记录；不得额外调用版本接口 |
| `run_soql_query` | unchanged official `QueryOrgMcpTool.exec()` → `connection.query()` | REST query / JSforce transport | YES | `EXACT_HTTP`；Purpose `USER_QUERY` |
| `run_soql_query(useToolingApi=true)` | unchanged official Tool → `connection.tooling.query()` | Tooling REST / JSforce transport | YES | `EXACT_HTTP`；Purpose `USER_QUERY` 或诊断 facade 指定的 `DIAGNOSTIC_TOOLING` |
| `get_record_action_context` | `RecordActionContextExecutor` → `connection.request()`，访问 Object Info、Create Defaults、Record、Layout、Picklist endpoints | REST UI API / JSforce transport | YES | `EXACT_HTTP`；Purpose `RECORD_ACTION_CONTEXT`；每个真实请求各一条 |
| `run_diagnostic_tooling_query` | `OfficialDiagnosticToolingQueryExecutor` → unchanged official `run_soql_query` with `useToolingApi=true` | Tooling REST / JSforce transport | YES | `EXACT_HTTP`；Purpose `DIAGNOSTIC_TOOLING` |
| Managed platform-user lookup | `ManagedDmlFieldResolver.resolvePlatformUserLookup()` → `connection.query()` | REST query / JSforce transport | YES | `EXACT_HTTP`；Purpose `SERVER_MANAGED_LOOKUP`，与随后 DML 分开 |
| `create_record` | `DmlExecutor.create()` → `connection.sobject().create()` | REST sObject POST / JSforce transport | YES | `EXACT_HTTP`；Purpose `DML_CREATE` |
| `update_record` | `DmlExecutor.update()` → `connection.sobject().update()` | REST sObject PATCH / JSforce transport | YES | `EXACT_HTTP`；Purpose `DML_UPDATE` |
| `get_metadata_component_context` | `OfficialMetadataComponentContextExecutor` → unchanged official `retrieve_metadata` → SDR `MetadataApiRetrieve` → `connection.metadata.retrieve/checkRetrieveStatus()` | Metadata SOAP through the request Connection / JSforce transport | YES | `EXACT_HTTP`；Purpose `METADATA_RETRIEVE`；不伪造 URL，不添加 operation-only 重复行 |
| Direct remote `retrieve_metadata`（显式启用时） | unchanged official Tool → SDR/Metadata API | Metadata SOAP / JSforce transport | YES | `EXACT_HTTP`；Purpose `METADATA_RETRIEVE` |
| `get_username` | request-scoped `OrgService` route lookup | 无 Salesforce 网络请求 | N/A | 不产生 Salesforce API row |
| `get_record_links` | configured Lightning origin string composition | 无 Salesforce 网络请求 | N/A | 不产生 Salesforce API row |
| Buntu token validation | `HttpBuntuTokenValidator` → raw `fetch(validateTokenUrl)` | 非 Salesforce HTTP | YES，但不是 Salesforce | 明确排除，禁止被 Salesforce adapter 捕获 |
| SFDX local auth-store seed | startup `seedSfdxLocalAuthStore()` → `AuthInfo.create()` | OAuth/REST / JSforce transport | YES | 不在 MCP Tool Invocation 内、没有 request Audit ID；不写入 P7 Tool Audit，明确列为运维启动路径 |
| Official upstream stdio host | process-scoped CLI Auth Cache / official Providers | SDK；独立于 SFoA HTTP runtime | 取决于官方进程 | 保持原样作为回归目标；P7 request Collector 不修改官方 stdio 源码 |
| Salesforce CLI / child process | 生产 SFoA runtime 中不存在 | N/A | N/A | 无 operation-only 伪记录；验证脚本中的 Inspector/本地进程不是 Salesforce runtime API 路径 |

## 2. 透明观测边界选择

JSforce `ConnectionConfig` 没有公开 transport 注入字段；`@salesforce/core Connection.create()` 也只接受公开的 `connectionOptions`，不能传入自定义 transport。OAuth JWT 路径发生在 Connection 创建之前，而且 Core `AuthInfo.tryJwtAuth()` 内部直接构造 JSforce `OAuth2`，所以只装饰已创建 Connection 的 `_transport` 会漏掉 OAuth、Dev Hub 探测和 Namespace 查询。

因此 P7-04 选择一个 SFoA-owned、单模块集中的 JSforce adapter，在任何 request Connection 创建前一次性安装。`Transport.httpRequest()` 建立唯一 JSforce 观察 scope；实际网络 attempt 在该 scope 内通过 Node `http.request` / `https.request` 的公开返回 Contract 观察。只有 JSforce scope 存在时才捕获，因此 Buntu 和其他 HTTP 不会进入 Salesforce Audit。

不能只在 `Transport.httpRequest()` Promise 完成处记账：3.10.13 会在一个 Transport 调用内对 GET/PUT/DELETE 等重试。适配器在每个 wire attempt 开始时分配 `publicApiCallId` 与全局 request-local sequence；中间重试保留真实 status，最终 attempt 再从 JSforce 已自然生成的小错误响应取得 Salesforce error。Adapter 不读取或消费 Node response stream，不改变 retry、redirect、Response、Error 或 Promise 语义。

这是内部子路径 Contract，不会扩散到 Tool 代码。必须增加 JSforce Contract Drift Test，固定验证：

- 实际版本为 3.10.13；
- internal transport 模块仍可解析；
- `Transport.prototype.httpRequest` 仍返回原始 StreamPromise，Node request 仍返回原始 ClientRequest；
- query/request/create/update/tooling/UI/Metadata 路径不会重复捕获。

## 3. Raw HTTP、CLI 与 opaque Provider 结论

生产 SFoA-owned 代码没有直接 `fetch(instanceUrl + ...)`、Axios/Got Salesforce client 或 `sf` child process。Buntu raw fetch 是另一外部服务，不能因全局 patch 被误捕获；本设计不修改 `globalThis.fetch`。

当前远程 official Metadata 路径并不 opaque：SDR 使用请求内传入的真实 Connection，并最终进入 JSforce Metadata/SOAP transport。因此 P7-04 对该路径使用 `EXACT_HTTP`，不额外写 `OFFICIAL_PROVIDER/OPERATION_ONLY` 行。未来若引入真正 opaque 的 official/CLI operation，schema 会允许 URL、Method、Status 为 NULL，并要求真实 operation name；当前不会制造不存在的 URL。

## 4. 实现前覆盖结论

SFoA HTTP runtime 内已发现的 Salesforce 出站路径都汇入同一个可观察 transport。唯一不绑定 Tool Audit 的真实 Salesforce 启动路径是 local auth-store seed，因为它发生在接受 MCP Tool Invocation 之前，没有合法 Audit ID。该限制会在最终覆盖矩阵中继续披露。

## 5. 实现结果

### Evidence、分类与时序

- `SalesforceApiCallEvidence` 在网络 attempt 开始时取得 UUID、Audit ID、共享 request-local sequence、Salesforce Username、Purpose 与 startedAt。
- Event 与 API 共用一个 sequence allocator，因此未来时间线可以还原 Identity/Event/API/Tool 的交错；API 表不另建无法关联的时间轴。
- 独立 classifier 按 endpoint 确定 `OAUTH / REST_API / UI_API / TOOLING_API / COMPOSITE_API / BULK_API / APEX_REST_API / METADATA_API / SOAP_API / UNKNOWN`，同时解析真实 host、endpoint path 与 API version。
- Purpose 只由高层 scope 增强。没有 Purpose 时仍记录 `UNKNOWN`；OAuth endpoint 确定性覆盖为 `IDENTITY_TOKEN_EXCHANGE`。
- `EXACT_HTTP` 强制要求真实 Method、URL、Host、Path；`OPERATION_ONLY` 强制要求 operation name 且 HTTP facts 为 NULL。当前 Tool 路径全部是 `EXACT_HTTP`。

### 有界收集与失败优先

每个 Request 最多保留 256 条 Salesforce API Calls。溢出增加 `droppedSalesforceApiCallCount` 并把主 Audit 完整性设为 `PARTIAL`。数组已满后发生失败时，确定性替换最早的成功记录；若 256 条本身全部为失败，则继续丢弃并保留真实 dropped count。Snapshot summary 包含 limit、captured、dropped 与 capture failure count。

### Schema 与持久化

新增 migration `006_p7_salesforce_api_observability.sql`，没有修改 005。它增加 public API Call UUID、transport、visibility、真实 URL/host/path、operation、size/content type，并使 username/method/endpoint 可空；API category 通过 expand/update/shrink 从旧 Enum 迁移。历史 P7-03 API 行保守迁移为 `OTHER + OPERATION_ONLY + LEGACY_API_EVIDENCE`，原 endpoint 仅作为 legacy 值保留，不升级成虚假的 exact URL。

`MySqlAuditBatchSink` 在同一 transaction 内批量写 `sfoa_audit_log`、`sfoa_audit_event` 和 `sfoa_salesforce_api_call`。API 绑定错误、shape 错误或 insert 失败会使整个 Snapshot transaction 回滚。Request 主链只构造小 Evidence、append、finalize 和 non-blocking offer；新增同步 Audit DB await 为 0，没有第二套 Queue。

## 6. Salesforce API Audit Coverage Matrix

| Tool / path | Category | Visibility | Purpose | Gate |
| --- | --- | --- | --- | --- |
| JWT OAuth token exchange | OAUTH | EXACT_HTTP | IDENTITY_TOKEN_EXCHANGE | PASS |
| Core AuthInfo discovery / Connection init | REST_API | EXACT_HTTP | IDENTITY_AUTHENTICATION / CONNECTION_INITIALIZATION | PASS（透明 transport） |
| `run_soql_query` | REST_API | EXACT_HTTP | USER_QUERY | PASS |
| `get_record_action_context` | UI_API | EXACT_HTTP | RECORD_ACTION_CONTEXT | PASS |
| `run_diagnostic_tooling_query` | TOOLING_API | EXACT_HTTP | DIAGNOSTIC_TOOLING | PASS |
| managed platform-user lookup | REST_API | EXACT_HTTP | SERVER_MANAGED_LOOKUP | PASS |
| `create_record` | REST_API | EXACT_HTTP | DML_CREATE | PASS |
| `update_record` | REST_API | EXACT_HTTP | DML_UPDATE | PASS |
| `get_metadata_component_context` | METADATA_API | EXACT_HTTP | METADATA_RETRIEVE | PASS（实际 Metadata SOAP high-level Gate） |
| direct `retrieve_metadata` | METADATA_API | EXACT_HTTP | METADATA_RETRIEVE | PASS（同一官方 Connection seam） |
| Salesforce CLI / opaque Provider | N/A（当前 runtime 不存在） | N/A | N/A | NOT APPLICABLE；未伪造 OPERATION_ONLY |

## 7. 去重、失败、并发与数量 Gate

Focused mock Salesforce server 实际结果：

- query、raw request/UI、create、update、tooling、Metadata SOAP：6 个真实成功 HTTP requests，6 条 Evidence，Duplicate Capture = 0；返回值语义不变。
- JSforce GET 503、`maxRetries=2`：mock server 收到 3 个真实 HTTP attempts，Collector 得到 3 条且 status 均为 503；retry coalescing = 0。
- HTTP 400/401/403/404/429/500/503 保存真实 status；timeout、connection reset、caller abort 保存 `httpStatus=NULL` 与原始 transport error facts。
- OAuth 保存真实 token URL、POST、200 与 duration；Evidence 不包含 request/response body 或 headers，测试断言 access token、JWT assertion、client secret 均不存在。
- MySQL 50/100/200 Gate：Cross API Audit Leak = 0；Cross Salesforce Username Leak = 0；Cross URL Leak = 0；Cross Tool Leak = 0；Cross Audit Binding = 0；Orphan Salesforce API Call = 0；Duplicate API Capture = 0。
- P7 OFF 与 ON 每档每轮 mock server request count 都等于并发数，因此 P7-04 新增 Salesforce API = 0。

## 8. Paired benchmark

同一进程、同一 local mock Salesforce server，50/100/200 并发，每档 3 轮 paired OFF/ON；下表为三轮中位数。Heap delta 是无强制 GC 的进程采样，方向噪声较大，原始三轮 JSON 保留在 test output。

| 并发 | 模式 | p50 ms | p95 ms | p99 ms | throughput/s | heap delta bytes |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 50 | OFF | 79.910 | 84.435 | 84.488 | 497.317 | -1,018,136 |
| 50 | ON | 59.987 | 79.801 | 82.216 | 501.712 | 60,520 |
| 100 | OFF | 74.600 | 77.383 | 77.815 | 1,036.215 | 10,054,256 |
| 100 | ON | 84.768 | 87.979 | 88.044 | 830.189 | -2,078,528 |
| 200 | OFF | 99.521 | 101.318 | 101.449 | 1,475.711 | 17,753,920 |
| 200 | ON | 107.605 | 110.130 | 110.256 | 1,284.711 | -6,812,616 |

该本机 local-loop benchmark 没有隐藏退化：100 并发 ON p95 比 OFF 高约 13.7%、throughput 低约 19.9%；200 并发 ON p95 高约 8.7%、throughput 低约 12.9%；50 并发结果反向波动。主要新增工作是每 attempt UUID、URL classifier、bounded immutable Evidence、ALS lookup 与 Collector append。真实 Salesforce 网络延迟环境下占比预计更低，但该推断不是 Gate 事实，留给 Maintainer 在目标环境复测。结构 Gate（新增 API、同步 DB await、cross leak、duplicate、Audit 导致 Tool failure）全部为 0/PASS。

## 9. 安全边界

普通 Salesforce API Audit 不保存 HTTP headers、request body 或 response body。只从 JSforce 已自然形成的小错误 body 提取标准 error code/message。URL classifier 仅排除 `access_token`、`assertion`、`client_secret`、`refresh_token`、session/sid 等认证 query values，同时保留业务 query string。测试确认 Authorization、Access Token、JWT Assertion、Private Key、Client Secret、Refresh Token 与 Session ID 不进入 Evidence。

## 10. 实际命令与结果

| 命令 | 结果 |
| --- | --- |
| `codegraph sync .` + Salesforce symbol/caller queries | PASS；实现前 571 files / 7,225 nodes / 16,757 edges |
| `yarn workspace @sfoa/identity-runtime test` | PASS，53/53 |
| classifier / adapter / collector focused node tests | PASS，包含真实 wire retry、OAuth、失败状态、50/100/200 paired benchmark |
| `yarn workspace @sfoa/control-plane test` | PASS，31 tests |
| `yarn workspace @sfoa/control-plane test:mysql` | PASS，10 tests；包含 006 legacy upgrade 与 50/100/200 API persistence |
| `yarn workspace @sfoa/mcp-server test` | PASS，66 tests |
| `yarn workspace @sfoa/admin-api test` | PASS，18/18 |
| `yarn workspace @sfoa/admin-web test` | PASS，7 files / 35 tests |
| `yarn workspace @sfoa/admin-web build` | PASS，3,175 modules |
| `yarn workspace @sfoa/admin-web e2e` | PASS，mock Chromium 1/1 |
| `$env:HTTP_TIMEOUT='100'; node scripts/p5-fullstack-e2e.mjs` | PASS，real Chromium 1/1、migrations 001–006、34 Admin Audit rows；override 仅约束 25 个 `.invalid` 测试身份的启动预热等待 |
| `yarn validate:p5`（attempt 1） | FAIL EARLY / FIXED：200-concurrency OFF fixture inherited local `HTTP_PROXY=127.0.0.1:9910`；fixture explicitly sets `httpProxy:''`，focused Gate and later Identity 53/53 PASS |
| `yarn validate:p5`（attempt 2） | PARTIAL：five lint、Control 31/31、MySQL 10/10、Identity 53/53、MCP P5 5/5、Admin API 18/18、Admin Web build PASS；Admin Web 已完成 6 files / 28 tests 后，fork worker 启动失败，未产生 assertion failure |
| aggregate 未完成子 Gate 的 bounded continuation | PASS：Admin Web standalone 7 files / 35 tests、build、mock Chromium 1/1、real full-stack Chromium 1/1；未因基础设施 fork worker 波动第三次重跑完整 Aggregate |

Aggregate attempt 2 的 Admin Web worker 错误为 `Failed to start forks worker for InstructionGenerator.test.ts`；同一完整 suite standalone 随后 7/7 files、35/35 tests 通过，该文件 focused 1/1 file、7/7 tests 通过。首次 full-stack continuation 因 25 个 `.invalid` 分页身份逐个执行 auth-store seed，超过固定 90 秒 readiness 窗口；将该测试专用 Salesforce 请求 timeout 限为 100 ms 后，Admin security、real Chromium 1/1、001–006 migration 与 34 条 Admin Audit 持久化全部 PASS。这里按测试成本治理完整披露基础设施波动，不将 aggregate attempt 2 虚报为整体 exit 0。

Git branch：`feature/p7-end-to-end-audit`。实现提交、push 与最终 working tree 由提交后的 Maintainer handoff 提供（提交不能在自身内容中可靠记录自身 hash）。官方 Salesforce Provider Source Modifications = 0。

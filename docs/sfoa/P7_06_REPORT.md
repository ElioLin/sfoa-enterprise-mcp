# P7-06 MCP 入口、响应与载荷证据报告

日期：2026-09-01

分支：`feature/p7-end-to-end-audit`

状态：`IMPLEMENTED / AWAITING MAINTAINER REVIEW`

## 1. 结论

P7-06 已在 P7-01～P7-05 的既有 Request Audit Context、Collector、Async Queue、Background Writer、JSforce transparent adapter 和 SOQL/DML semantic scope 上补齐 MCP 与 Salesforce Payload Evidence。没有建立第二个 Audit Context/Collector、没有同步 Audit DB 写入、没有增加 Salesforce API、没有修改官方 Salesforce Tool，也没有实现 P7-07 React Workbench 或 P7-08 AI 诊断。

一次确定的 `tools/call` 现在可以按同一 Audit 还原：MCP 原始请求、Identity/Route/Governance/Tool Events、Salesforce wire attempt 与 SOQL/DML facts、Salesforce request/最终可证明 response payload、逻辑 Tool Result 摘要、真实 MCP wire response prefix，以及 `finish`/提前 `close`/write error 的传输事实。

## 2. MCP Request

捕获点位于 `http-server.ts` 的 bounded body read 和 JSON parse 之后、Identity Provider 之前。`readBoundedJsonBodySource()` 返回业务已经读取的 `value`、同一次读取产生的 `rawText` 和 UTF-8 byte size；Audit 复用该结果，不再次读取 `IncomingMessage`，也不改变 request stream 的 flowing/consumption 行为。

仅确定的单个 `tools/call` 建立 P7 Context 并记录 `MCP_REQUEST`。保存的是实际 JSON-RPC body 的 secret-safe bounded prefix，因此包含真实 `jsonrpc`、request id、method、tool name 和业务 `arguments`；channel 来自 Audit master，Content-Type 来自本次 HTTP request。普通 Payload sanitization 会移除 Authorization/Cookie/token/JWT/private key/client secret/password 等认证材料；Buntu raw-token 例外仍只存在于既有专用 durable identity-validation 路径。

## 3. MCP Logical Result 与 Transport Response

两类证据保持独立：

- `auditCall.responseSummary` 是 Runtime Logger 在 Tool terminal 形成的 bounded 逻辑结果摘要；后续 transport terminal 不会覆盖已经形成的 Tool Result。
- `MCP_RESPONSE` 是在当前 `ServerResponse.write/end` 边界旁路复制的实际 wire bytes prefix。Recorder 先调用原 Node primitive，再在剩余预算内复制；返回值、backpressure、throw、write 时序和发送路径均保持不变，不会先缓存完整 response 再发送。

Recorder 观察 `finish`、`close` 和 `error`：

| Transport fact | 记录语义 |
| --- | --- |
| `RESPONSE_FINISHED` | Node response 流正常结束，只证明服务器已把响应交给底层传输系统 |
| `CLIENT_DISCONNECTED` | `finish` 前发生 `close`，响应未被证明完整发送 |
| `WRITE_FAILED` | 原 `write/end` 或 response error 失败 |
| `UNKNOWN` | request finalization 时仍无法证明其他状态 |

每个 transport event 都保存 `clientReceiptConfirmed=false`。系统从不把 `finish` 描述为“客户端确认收到”。提前 close 时只保存已观察 prefix，并强制 `truncated=true`；不会重构或伪造完整响应。

Request timeout 与 transport status 是正交事实：例如 `MCP_REQUEST_TIMEOUT` 可作为主终态，同时实际 504 response 仍可记录 `RESPONSE_FINISHED`；如果 socket 提前关闭则记录 `CLIENT_DISCONNECTED`。Tool timeout、Tool error、Identity denial、Governance block 和 `MCP_DML_OUTCOME_UNKNOWN` 都经过同一个 definite-`tools/call` recorder。

## 4. Salesforce Payload

P7-06 复用 P7-04 的 JSforce observation：

- Request payload 来自 JSforce 已经形成的 `HttpRequest.body`；非 GET/HEAD 的 DML JSON 与 Metadata SOAP/XML 可保存 bounded prefix。GET SOQL 没有 body 时不创建空 JSON evidence。
- Response payload 只来自 JSforce 正常业务 Promise 已经产生的 `HttpResponse.body`；没有给 Node `IncomingMessage` 添加 `data` listener，没有消费或竞争 Salesforce response stream。
- OAuth attempt 继续只保留 P7-04 URL/method/status facts，request/response payload 均为零，避免 assertion、access token 或 client secret 扩散。

Retry 绑定保持诚实。每个 P7-04 wire attempt 先获得独立 `publicApiCallId`；开始下一 attempt 时，前一个 pending response 只落 status/size/content-type，不编造 body。JSforce 最终逻辑 `HttpResponse.body` 只绑定到仍可证明的最终 attempt。测试中的 `503, 503, 200` 只有第三条收到完整 `SALESFORCE_RESPONSE`；前两条 payload 为 NONE。

可取得的失败 body 使用 `ERROR_RESPONSE` 并绑定同一个 `publicApiCallId`。DML validation failure 保存 Salesforce error array；transport reset 没有可证明 body 时不伪造 `ERROR_RESPONSE`。2 MiB Salesforce response 的业务返回保持完整，Audit 只保存 bounded prefix。

## 5. Payload Bounds 与 Error Priority

Runtime 硬边界：

| Bound | 值 |
| --- | ---: |
| 单 Payload | 262,144 UTF-8 bytes |
| 单 Audit Payload 数量 | 64 |
| 单 Audit 全部 Payload | 1,048,576 bytes |
| Critical error reservation | 262,144 bytes + 1 slot |
| MCP core reservation | 262,144 bytes + 1 slot |

普通 Salesforce success evidence 只能使用前 512 KiB/62 slots；MCP core 可继续使用到 768 KiB/63 slots；error evidence 可使用完整 1 MiB/64 slots。因此早期 success payload 不会耗尽最后一份 Salesforce/MCP error evidence 预算。达到 count/byte ceiling 后立即 drop，递增 `droppedPayloadCount` 并使 `auditIntegrityStatus=PARTIAL`；不扩容、不等待数据库、不改变 Tool/Response。

截断、capture failure 或 payload drop 同样标记 `PARTIAL`。`storedSizeBytes` 是最终 `safePayload` 的精确 UTF-8 byte length。大型字符串不为 Audit 扫描完整内容；无法低成本知道原始大小时 `originalSizeBytes=NULL`。Migration `008_p7_payload_evidence_runtime.sql` 只把该列改为 nullable，005/006/007 未修改。

`contentSha256` 不在 request path 计算。Background Writer 对最终持久化的 secret-safe `safe_payload` 计算 SHA-256；它表示“已持久化安全载荷”的 Hash，不宣称是被截断原始响应的完整 Hash。

## 6. Association 与 Persistence

Runtime 不知道数据库自增 ID。Payload 使用以下稳定键：

- parent Audit：当前 `RequestAuditContext.auditId`；
- Event：当前 request-local `auditEventSequence`；
- Salesforce API：P7-04 `publicApiCallId`。

P7-03 Background Writer 在一个 Snapshot transaction 内依次写 master、Events、Salesforce API Calls，再查询本 transaction 的 `auditId + sequence -> event DB id` 与 `publicApiCallId -> API DB id` 映射，最后写 Payload Evidence。任何缺失或跨 Audit mapping 都使该后台 transaction fail-open 失败，绝不按“最新一条 API”猜测，也不会产生跨 Audit FK。真实 MySQL 50/100/200 Gate 证明 orphan=0、wrong API binding=0、cross payload marker leak=0。

Queue offer 仍为同步内存操作；Writer 使用既有独立 Audit pool。5 秒 sink Gate 中 Tool response `<2s`，Snapshot 后台完成；Queue Full/Writer/MySQL failure 只使 Audit DEGRADED/PARTIAL，Tool result、Salesforce result 和 retry count 不变。

## 7. 按需读取与 P7-07 数据准备

`AuditTraceRepository` 继续提供 `listSalesforceApiCalls()`、`listPayloadEvidence()`，并增加最小的 `getPayloadEvidenceById()`。普通 `AuditRepository.search()` 与 `countSince()` 只访问 `sfoa_audit_log`，不 SELECT/JOIN `safe_payload`；React AuditPage 未修改。

## P7-07 UX Readiness Contract

下一阶段可直接组合以下后端数据，不需要猜测无类型 JSON：

| UI 区域 | 已准备 Contract |
| --- | --- |
| 顶部概览 | Audit master 的 Tool/User/Salesforce User/Result/Duration；Event/API 详情可计算 API/SOQL/DML/Error count |
| Timeline | Event 与 API 共用 request-local sequence；Payload 可选绑定 Event sequence |
| API | P7-04 exact HTTP facts、Purpose、status、duration、size、error |
| SOQL | P7-05 query type/statement/totalSize/returnedRecords/done/hasNextRecords |
| DML | P7-05 operation/object/record/requested/managed/submitted fields |
| Request/Response | P7-06 typed `MCP_REQUEST`/`MCP_RESPONSE`，含 Content-Type、原始/保存大小、truncated、Hash |
| Error | MCP error wire response 与 Salesforce `ERROR_RESPONSE`，可绑定 Event/API |

Payload 支持按 Audit 分页列出、按 ID 单条按需加载；未来 UI 可以明确显示 truncated、复制 SOQL/API URL/Audit ID/Correlation ID，并按类型放入“请求/响应/错误”区域。P7-06 没有提前设计完整 BFF 或 React 工作台。

## 8. Isolation、Fault 与 Main Path Gates

实际通过：

- definite success、Identity failure、Governance block、Tool execution error、Tool timeout、Request timeout、DML UNKNOWN、client disconnect；
- SOQL small/large response、DML request、validation `ERROR_RESPONSE`、OAuth zero payload、retry final-attempt-only body；
- 2 MiB MCP response 与 2 MiB Salesforce response：业务结果完整，单 evidence <=256 KiB，truncated=true，总预算有界；
- 50/100/200 Collector/HTTP/MySQL：Cross MCP request/response leak=0，Cross Salesforce payload leak=0，Wrong API binding=0，Orphan payload=0；
- slow Audit DB 5s、Queue Full、Writer failure/MySQL down：Audit 导致 Tool failure=0，响应等待 Audit DB=0；
- OFF/ON connection/API counts 一致，P7-06 新增 Salesforce API=0；
- 普通 Audit list 加载 Payload=0；官方 Salesforce TypeScript 修改=0。

## 9. Performance

HTTP paired Gate 每个 50/100/200 并发运行三轮。下表为三轮平均，全部 failures=0：

| 并发 | OFF p50/p95/p99 ms | ON p50/p95/p99 ms | OFF/ON throughput |
| ---: | --- | --- | --- |
| 50 | 625.38 / 643.76 / 653.88 | 658.08 / 686.87 / 708.85 | 78.36 / 89.28 |
| 100 | 815.43 / 859.25 / 862.20 | 1042.55 / 1135.30 / 1139.10 | 117.46 / 93.27 |
| 200 | 1629.19 / 1854.10 / 1879.00 | 1583.19 / 1767.99 / 1773.48 | 106.31 / 112.32 |

该 HTTP run 的总 heap delta 为 196,316,816 bytes，CPU user/system 为 13,125,000/29,312,000 microseconds；它包含测试 client/server/1,060 Snapshot retain，不代表生产 steady-state heap。

独立 Payload microbenchmark 同样为三轮 paired；下表给出三轮中位数。`small` 使用小 JSON，`large` 使用 2 MiB response，ON 始终只保存 256 KiB prefix：

| Payload/并发 | OFF p50/p95/p99 ms | ON p50/p95/p99 ms | OFF/ON throughput | ON heap delta median |
| --- | --- | --- | --- | ---: |
| small/50 | .057/.284/.838 | .087/.119/.199 | 7,085.97 / 10,409.51 | 688,368 B |
| small/100 | .041/.090/.167 | .058/.088/.157 | 19,565.26 / 13,230.49 | 1,013,736 B |
| small/200 | .035/.066/.159 | .058/.203/.440 | 17,906.55 / 10,498.08 | 1,750,456 B |
| large/50 | .033/.112/.285 | 2.250/4.055/6.621 | 16,045.70 / 374.34 | 434,240 B |
| large/100 | .028/.043/.108 | 2.236/4.157/4.805 | 24,249.48 / 396.01 | 867,064 B |
| large/200 | .026/.045/.315 | 1.902/3.070/4.221 | 18,208.47 / 496.80 | 1,734,792 B |

这些是本机 synthetic results，原始每轮数据由测试输出 `P7_03_PERFORMANCE` 与 `P7_06_PAYLOAD_PERFORMANCE` 保留，不做美化。结构 Gate 比相对微基准更重要：无完整大 response Audit clone、无同步 DB await、无新增 Salesforce API、无业务失败。

## 10. 实际验证结果

| Suite | 结果 |
| --- | --- |
| Identity Runtime | 66/66 PASS |
| Control Plane unit | 31/31 PASS |
| Control Plane real MySQL | 10/10 PASS |
| MCP Server ordinary | 66/66 PASS；首次 65/66 为 50-way 单次 2s timeout，完整复跑通过 |
| MCP P3/P4/P5 | 22/22、7/7、5/5 PASS |
| MCP P7 focused | 6/6 PASS |
| Explicit timeout/error evidence | timeout-shutdown 5/5；request-mutation-outcome 6/6 PASS |
| Changed-code lint | identity/control/MCP 全部 exit 0 |
| Root `yarn test` | official Example 8/8 后，被 unchanged code-analyzer workspace 的 global `tsc` Windows debt 阻塞；不虚报 PASS |
| Project Aggregate | 首次因 Queue test 错把 fixture creation 纳入 `<50ms` 计时停止；修正计时范围后 Control 31/31。完整重启通过 lint、Control 31/31、MySQL 10/10、Identity 66/66、MCP P5 5/5、Admin API 18/18、Admin Web 35/35/build、mock Chromium 1/1；最后 real full-stack 首次 readiness timeout，独立有界续跑 1/1 PASS，migration 001–008、34 Admin Audit rows |

## 11. 已知边界

- `finish` 不是客户端收件确认；`clientReceiptConfirmed` 永远为 false。
- intermediate JSforce retry body 在不消费 Node stream 的前提下不可安全获得，因此保持 NONE。
- 大型 string 的完整 byte size 若无 Content-Length/已知 buffer size则为 NULL。
- 当前开发测试阶段允许业务字段明文；认证/基础设施 secret 的最低安全边界仍强制执行。
- 未实现 P7-07 UI、完整 Audit Trace Detail BFF、P7-08 Skill/LLM、RAG、Broker、Salesforce readback。

最终状态：

`P7-06 MCP入口、响应与载荷证据 = IMPLEMENTED / AWAITING MAINTAINER REVIEW`

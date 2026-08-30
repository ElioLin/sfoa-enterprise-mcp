# P7-03 请求级隔离与异步审计管道实施报告

Status: **IMPLEMENTED / AWAITING MAINTAINER REVIEW**

Date: 2026-08-30

Branch: `feature/p7-end-to-end-audit`

## 1. Tool Invocation 真正入口与生命周期

Streamable HTTP 的一次确定 `tools/call` 从 `handleRemoteRequest()` 进入，经 `executeMcpPost()` 解析 bounded JSON，在 Identity Provider 和 Salesforce Route 之前创建 P7-02 `RequestAuditContextController`。随后整个 authentication、policy snapshot、request-scoped Salesforce Connection、MCP SDK transport 和 `runAuditedToolInvocation()` callback 都在同一个既有 ALS Controller 下执行。

请求成功、Tool 错误、Governance 拒绝、Identity/Route/Connection 失败、Tool/Request timeout、post-dispatch UNKNOWN、client disconnect 和 Runtime exception 最终都回到 `handleRemoteRequest()` 的 `finally`。该边界在资源 cleanup 证据记录后显式调用 `finalizeRequestAudit(controller)`，最多产生并 offer 一次 Snapshot。Response/socket EventEmitter callback 不根据用户、时间或 Correlation ID 猜归属；它们闭包捕获 Controller，并通过 `runWithRequestAuditContext(controller, callback)` 显式恢复绑定。

## 2. Request Collector

P7-02 Controller 直接持有唯一 `RequestAuditCollector`，没有 `TraceContextV2`、第二套 ALS 或进程级 mutable current request。Collector 是纯内存对象，只负责：

- 使用 Controller 的 request-local allocator 分配 sequence；
- 保存 bounded、JSON-safe、不可变 Event；
- 保存当前 Audit 的 terminal candidate；
- 使用显式权威规则选择主终态；
- finalize 一个 Snapshot。

终态不是“首条/末条 logger 赢”。普通候选权威从 `IDENTITY`、`GOVERNANCE`、`TOOL`、`REQUEST` 到 `TRANSPORT` 递增；任何已确认 mutation dispatch 后的 `UNKNOWN` 最高，继续保持 `MCP_DML_OUTCOME_UNKNOWN` 与禁止自动重试语义。Cleanup 等后续日志为 Event-only，不覆盖主终态。

Identity 和 Salesforce Route 仍只通过 P7-02 类型化 enrichment API 补全。Collector 不访问 MySQL、Salesforce、网络、文件系统或 LLM。

## 3. Immutable Audit Snapshot

`AuditSnapshot` 包含：

- 一个 `auditCall`，其 `publicAuditId` 等于本次 `RequestAuditContext.auditId`；
- `auditEvents[]`；
- 当前必须为空的 `salesforceApiCalls[]`；
- 当前必须为空的 `payloadEvidence[]`。

摘要被限制为最多 6 层、每容器 64 项、每字符串 4096 字符和 512 个节点；循环引用变为安全标记。Snapshot、主记录、数组、Event 和嵌套 JSON 均深度冻结。Controller 第二次 finalize 返回 `undefined`；finalize 后的 Event append 返回 `false`，因此同一次 Tool Invocation 不可能重复 enqueue 主 Snapshot。

## 4. Queue 与 Writer

生产默认值：

| 项目 | 值 |
| --- | ---: |
| Queue capacity | 1000 |
| Batch size | 50 |
| Flush interval | 100 ms |
| Retry attempts | 2 |
| Backoff | 100 ms、200 ms |
| Shutdown flush timeout | 5000 ms |

业务路径只调用同步 `queue.offer(snapshot)`。Queue Full 或关闭后 offer 失败会立即 drop，不等待空位、不改变 Tool Result，并更新 `queueFullCount`、`droppedSnapshots`、`lastDropAt` 和 DEGRADED health。Fallback operational log 只含 Queue depth/capacity 与稳定 error code；fallback 自身同步或异步失败也不会逃逸。

后台 Writer 以一个 worker Promise 从 Queue drain Batch。正常 Batch 在一个 MySQL transaction 中批量插入主记录，按 server public Audit ID 回读数据库 PK，再批量插入 Event。这样同一 Snapshot 不会出现 orphan Event。整 Batch 对 DB/事务错误回滚；可重试错误在后台 bounded backoff 后 drop。不可重试 malformed Snapshot 先回滚整 Batch，再逐 Snapshot 隔离，使 poison entry 不会长期阻塞其他 Snapshot。P7-04/P7-05 数组非空会被当前 sink 明确拒绝，避免阶段越界。

Shutdown 顺序为：停止接收 MCP → drain active requests → 最多 5 秒 flush Queue → 最多 1 秒等待 Audit Pool destroy → 关闭主 Control Plane store。超时会把 Queue 和 in-flight Snapshot 计入 dropped/degraded，并继续关闭。

## 5. Dedicated Audit DB Pool

Audit Writer 使用独立 Kysely/mysql2 client，连接同一个数据库但 pool `connectionLimit=2`、内部 queue 最多 20。Control Plane Identity Route、Tool Governance 和 Admin 服务继续使用主 pool。Writer 本身只有一个消费循环，因此两条连接是小而有界的故障/事务预算，不会占满主 pool。

Admin 配置变更与 Admin Audit 的同事务强一致语义没有迁移到异步 Queue。没有 Request Audit Context 的 Runtime observational log 尽量进入异步 legacy entry；Buntu raw-token opt-in 仍只进入独立 `IDENTITY_VALIDATION` durable write，普通 Tool Snapshot/Event/fallback 不包含原始 Token。

## 6. Fail-Open 故障注入结果

| 场景 | 结果 |
| --- | --- |
| Writer throw / Audit DB down | bounded retry 后 DEGRADED/drop；Tool 正常 |
| Audit INSERT 模拟延迟 5 秒 | Tool response 未等待 sink；focused Gate 断言 `< 2000 ms`，sink 实际延迟 5000 ms |
| Queue Full | 第二个 offer 立即返回 false；Tool path `< 50 ms`；metrics 增加 |
| fallback 同步 throw | 未逃逸 Queue/Tool 路径 |
| poison Snapshot | Batch rollback 后逐 Snapshot 隔离；valid Snapshot 持久化 |
| shutdown in-flight timeout | 20 ms 测试超时有界；in-flight Snapshot 计为 dropped |
| CREATE 成功后 Writer failure | CREATE 仍成功，Salesforce create invocation=1 |
| DML post-dispatch UNKNOWN 后 Writer failure | `MCP_DML_OUTCOME_UNKNOWN` 保持，Salesforce create invocation=1 |

## 7. 并发与数据库一致性

Collector 的 Promise-interleaving Gate 分别运行 50、100、200 路。真实 MySQL dedicated-pool Gate 依次 batch persist 50、100、200 个 Snapshot（合计 350 个主记录、700 个 Event）。HTTP OFF/ON 基准采用两个 Runtime 配对交错执行，并为稳定测量各并发档执行两次；ON 共验证 710 个 Snapshot。

```text
Audit ID collision          = 0
Cross Audit Context Leak    = 0
Cross Platform User Leak    = 0
Cross Salesforce User Leak  = 0
Cross Tool Leak             = 0
Cross Correlation Binding   = 0
Cross Event Leak            = 0
Orphan Event                = 0
Duplicate MCP_TOOL_CALL     = 0
Cross Snapshot Binding      = 0
Tool Failure caused by Audit= 0
```

正常 HTTP Tool Snapshot 均证明：`1 Tool Invocation = 1 MCP_TOOL_CALL + 2 Events`（start + terminal）。Timeout、disconnect、cleanup 等场景可以产生更多 Event，但仍只有一个主 Snapshot。

## 8. 性能

相同 mock HTTP Tool 负载采用同时存活的 OFF/ON Runtime，预热后按 `OFF → ON → ON → OFF` 配对执行，表内为两个样本平均：

| 并发 | Mode | p50 ms | p95 ms | p99 ms | throughput req/s | failures |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 50 | OFF | 152.56 | 157.18 | 157.77 | 315.20 | 0 |
| 50 | ON | 193.68 | 199.66 | 200.09 | 249.28 | 0 |
| 100 | OFF | 366.32 | 376.81 | 377.59 | 265.00 | 0 |
| 100 | ON | 392.81 | 427.94 | 428.81 | 232.19 | 0 |
| 200 | OFF | 737.91 | 768.02 | 769.49 | 259.28 | 0 |
| 200 | ON | 768.27 | 831.60 | 833.04 | 239.05 | 0 |

同一 paired run 的进程级环境数据：CPU user 4,672,000 µs、system 11,281,000 µs、heap delta 96,135,888 bytes。该 CPU/memory 是 OFF+ON 两个同时存活 Runtime 的共享环境数，不伪装成单模式归因。ON/OFF Salesforce Connection 创建均为 714，额外 REST API 均为 0。ON p95 的绝对差为 42.48 / 51.13 / 63.58 ms；相对差随并发从约 27.0% 降到 13.6% 和 8.3%，没有随并发放大的退化曲线。该成本来自 request-local Event/Snapshot 分配与冻结；10,000 次独立 Collector+两 Event+finalize 微基准为 189.89 ms（约 0.019 ms/调用），HTTP tail 还包含 Windows workspace/SDK/GC 调度噪声。5 秒 Audit sink 未进入 Tool response。Maintainer review 决定是否冻结进一步的环境阈值，报告不将 raw data 美化为零开销。

结构性结果：

```text
P7-03 新增 Salesforce API                 = 0
Tool path Audit DB await                  = 0
Tool path Audit file I/O                  = 0
新增 Event per-stage DB INSERT            = 0
Audit DB 5s delay propagated to Tool      = 0
Audit-induced Tool failure / DML retry    = 0
```

生产源码依据：配置化 MySQL Runtime 构造带 Pipeline 的 `DatabaseRuntimeLogger`；该模式的 `log()` 只调用 `collectOrEnqueue()`，`finalizeRequestAudit()` 只 finalize/offer。旧的 `await createCall/append` 仅保留在“未注入 Pipeline”的兼容路径，供旧测试/Admin observational adapter 使用，不在配置化 MCP Runtime Tool 路径。

## 9. P7-04/P7-05/P7-06 接口准备

后续阶段继续复用唯一 Controller/Collector/ALS：

- P7-04 可通过受控 Collector API 填充 `salesforceApiCalls[]`；
- P7-05 可填充 bounded `payloadEvidence[]` 并沿用同一 Audit/Event sequence 与 Snapshot；
- Queue/Writer 已有多数组 batch seam，但 P7-03 sink 明确拒绝非空 future arrays；
- P7-06 在 MCP request/response 边界增加安全 capture，不改变 Salesforce Tool business schema；
- 不需要第二套 ALS、Kafka、Redis Streams 或新消息中间件。

## 10. 修改文件

- `packages/sfoa-identity-runtime/src/request-audit-collector.ts`：Collector、terminal authority、bounded immutable Snapshot。
- `packages/sfoa-identity-runtime/src/request-audit-context.ts`、`runtime-logger.ts`、`index.ts`：Controller 绑定 Collector、Runtime Event descriptor、exports。
- `packages/sfoa-control-plane/src/audit-pipeline.ts`：Queue、Writer、retry/drop/shutdown/health。
- `packages/sfoa-control-plane/src/mysql-audit-batch-sink.ts`：master/Event batch transaction 和 poison classification。
- `packages/sfoa-control-plane/src/database.ts`、`runtime-logger.ts`、`index.ts`：dedicated pool config、异步 Runtime adapter、exports。
- `packages/sfoa-mcp-server/src/http-server.ts`、`runtime.ts`：ALS/Emitter 边界、明确 finalize、health、生产 Pipeline/Pool lifecycle。
- `remote-tool-facade.ts`、`context-tool-facade.ts`、`dml-tool-facade.ts`、`agent-guidance.ts`、`authenticator.ts`：明确 Event/terminal descriptor；Buntu 保持独立范围。
- Identity/Control Plane/MCP P3/P7/MySQL tests：Collector、Queue/Writer、故障、DML、数据库和 50/100/200 Gates。
- `packages/sfoa-mcp-server/package.json`：增加 focused `test:p7` 命令；无 dependency 变化。
- `packages/sfoa-admin-api/src/test/http-server.test.ts`：同步扩展后的 Audit health fixture；生产 Admin transaction path 未改。
- README、P7 baseline、Project Baseline、Architecture、Test Matrix、Upstream Strategy：状态、架构和真实 Gate 记录。

官方 Salesforce Tool implementation 修改：0。依赖与 `yarn.lock` 修改：0。

## 11. 测试

最终真实命令与结果记录在 `docs/sfoa/TEST_MATRIX.md`。阶段 focused 结果包括：Identity Runtime 42/42、Control Plane 31/31、MySQL 9/9、MCP P7 2/2、P3 22/22、P4 7/7、P5 5/5、Admin API 18/18。MCP full 首次 65/66，仅 Windows 临时 workspace `rmdir EPERM`；只重跑失败用例后 1/1 PASS。Aggregate 首次在早期 Admin health mock typecheck 停止；修复受影响 fixture 并通过 Admin lint/18 tests 后，必要重启的完整 `yarn validate:p5` 以 exit 0、570.78 秒完成，包含 Admin Web 35/35、mock Chromium 1/1 和 real full-stack Chromium 1/1（34 Audit rows）。

## 12. Git

- Branch: `feature/p7-end-to-end-audit`
- 开发起点：`09782ef30c9e85abe9085769e11b59cff2b68bdb`，开始前与 origin 一致且 working tree clean。
- 实现 commit：`8cc157070d0948a2bd777cc005c909c6765cd618`（24 files，1,902 insertions，21 deletions）。
- 文档 commit：在本报告提交时生成；最终 SHA 在 Maintainer handoff/远端分支 HEAD 中给出，避免文档自引用导致 commit SHA 循环变化。
- 总变更范围：24 个代码/自动化文件 + 12 个 README/基线/ADR/报告文件；`.env`、ZIP、`yarn.lock` 变化均为 0。
- 预期 push 后状态：local HEAD = origin branch HEAD，working tree clean。

最终阶段声明只能是：

**P7-03 请求级隔离与异步审计管道 = IMPLEMENTED / AWAITING MAINTAINER REVIEW**

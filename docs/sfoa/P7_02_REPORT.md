# P7-02 请求级审计上下文实施报告

状态：`IMPLEMENTED / AWAITING MAINTAINER REVIEW`

分支：`feature/p7-end-to-end-audit`

## 1. Tool Invocation 真正入口

Streamable HTTP 入口为 `handleRemoteRequest()` → `executeMcpPost()` → `StreamableHTTPServerTransport.handleRequest()`。MCP SDK 将每个确定的 `tools/call` 分派到 `createGovernedMcpServer()` 注册的 Tool callback；Request Audit Context 正是在该 callback 执行前建立并承载到 callback 完成。单调用 HTTP 请求会在 body 解析后预建立同一 Context，因此 Identity Route、Governance、Salesforce 连接前失败仍可使用原 Audit ID 写主记录。响应 `finish`/`close` 后清理 request scope、server、transport 和 workspace，Context 不进入进程级全局 current state。

## 2. Request Audit Context

结构包含 `auditId`、`correlationId`、`startedAt`、`channel`、`clientId`、`toolName`、可空 operation/object/record、可空平台身份/credential/source、可空 Salesforce username/role，以及可空 conversation/turn/external run/agent/model provider/model name。Controller 只暴露 `withResolvedIdentity()`、`withSalesforceRoute()`、`withOperation()`、`nextSequence()` 和只读 `snapshot()`；不允许任意 key/value 注入。

HTTP body 确定 Tool 后由 Runtime 创建；Identity Provider 补全平台身份，Request Scope 补全 Salesforce Route，Tool input 只补充已经存在的 operation/object/record 事实。现有 Salesforce Tool schema 未增加 observability 参数。

## 3. Audit ID 与 Correlation ID

Audit ID 使用 Node `crypto.randomUUID()` 由服务器生成，客户端没有 Header 或 Tool argument 覆盖入口。它在一次 invocation 内保持不变，并作为 P7-01 `createCall(publicAuditId)` 的权威 ID。

Correlation ID 继续接受 1～128 位安全格式的上游值；缺失或不合法时服务器生成 UUID。Correlation ID 只用于关联，重复值不参与 Audit Context 复用。测试中 100 次调用只使用 5 个重复 Correlation ID，仍产生 100 个不同 Audit ID。

## 4. 并发安全

测试使用 `Promise.all()` 执行 100 路 invocation，并用不同延迟故意交错 Promise。真实结果：

```text
Audit ID collision = 0
Cross Audit Context Leak = 0
Cross Platform User Leak = 0
Cross Salesforce User Leak = 0
Cross Tool Name Leak = 0
Cross Correlation Mis-binding = 0
```

实现没有 `currentAuditId/currentUser/currentSalesforceUser` 等进程级 mutable global。Node `AsyncLocalStorage` 只承载一个 request-local Controller；它不收集 Event 或 Payload。

## 5. 可选客户端信息与安全

`X-Conversation-Id`、`X-Turn-Id`、`X-External-Run-Id`、`X-Agent-Id`、`X-Model-Provider`、`X-Model-Name` 均可缺失。值只接受字符串，删除控制字符并限制为 256 字符；它们只进入现有 bounded/sanitized Audit request summary。客户端无任何 Audit ID 输入字段。

## 6. Audit Call 一致性与 Fail-Open

MySQL Runtime 构造 `DatabaseRuntimeLogger` 时注入现有 P7-01 `AuditTraceRepository`。Logger 发现活跃 Context 后只尝试一次 `createCall()`，并把 `RequestAuditContext.auditId` 原样作为 `publicAuditId`。同一写入同时使用本 Context 的平台身份、identity source/credential、Salesforce username/role 和 Tool；测试按 public ID 回读并逐字段断言一致。

写入仍位于现有 Tool 终态 Runtime audit 路径，没有 Identity/Route/Tool 阶段 INSERT。Repository 或 fallback 失败仍被吞并，不改变 Tool/Mutation outcome，也不触发重试。

## 7. 性能与阶段边界

```text
新增 Salesforce API = 0
新增 Event DB INSERT = 0
新增阶段性 Audit INSERT = 0
新增同步文件/网络 IO = 0
新增第三方依赖 = 0
```

MySQL 模式将既有终态 flat Runtime audit write 替换为一次 `MCP_TOOL_CALL createCall()`；没有额外数据库往返。Env/Noop 模式保持原行为。

## 8. AsyncLocalStorage 技术审查与 P7-03 准备

当前 SDK Tool callback、Promise 链和 HTTP response EventEmitter 位于同一 Node 线程，Node ALS 可以传播。代码未使用 Worker Thread；child_process 只存在于与远程 Tool invocation 无关的开发/官方能力；Salesforce SDK Promise/callback 和 Metadata Workspace 的 CWD guard 未观察到脱离当前 async resource 的边界。P7-03 应复用此 carrier 接入 request-bound Collector，再在不可变 Snapshot 后接 bounded Queue/Batch Writer。若未来引入 Worker/child process，必须显式序列化 Snapshot，而不能假设 ALS 跨线程/进程传播。

本阶段的 ALS 只解决 Tool callback 到现有 Logger 的 Context 传递，避免修改每个 facade/official Tool 签名；没有提前实现 Collector、Queue、Async Writer、Batch Persistence 或 Salesforce interceptor。

## 9. 修改文件

- `packages/sfoa-identity-runtime/src/request-audit-context.ts`：Contract、受控 enrichment、sequence、薄 ALS carrier。
- `packages/sfoa-identity-runtime/src/index.ts`：导出 Context API。
- `packages/sfoa-identity-runtime/src/test/request-audit-context.test.ts`：100 路交错、重复 Correlation、缺失/恶意 metadata、稳定 ID/sequence。
- `packages/sfoa-mcp-server/src/http-server.ts`：确定 Tool 后预建 Context，Identity/Route 补全，错误路径复用。
- `packages/sfoa-mcp-server/src/provider-runtime.ts`：所有 Provider facade callback 的 invocation carrier。
- `packages/sfoa-mcp-server/src/agent-guidance.ts`：两个基础设施 Tool callback 的同一 carrier。
- `packages/sfoa-mcp-server/src/runtime.ts`：把现有 Trace Repository 注入 Runtime Logger。
- `packages/sfoa-control-plane/src/runtime-logger.ts`：一次 Context 对应一次 Audit Call，保持 fail-open。
- `packages/sfoa-control-plane/src/test/runtime-logger.test.ts`：Context/Audit Call ID 与身份一致性。
- README、Architecture、P7 baseline、Project baseline、Test Matrix：阶段状态与真实证据。

## 10. 测试

真实命令和完整结果记录在 `TEST_MATRIX.md`。定向结果：Identity 35/35、Control Plane 22/22、MySQL 8/8、MCP 66/66、P3 20/20、P4 7/7、P5 5/5；三个修改工作区 build/lint 均通过。

最终 Aggregate 首次运行通过所有后端、MySQL、Admin API、Admin Web build/unit 后，在既有 mock E2E 因 Drawer/Modal 同名 Close strict locator 失败。定位器限定到目标 Drawer 后，按测试成本治理只重跑失败的 mock E2E（1/1）和此前尚未执行的 full-stack E2E（1/1，34 Audit rows），均通过；没有重复运行完整 Aggregate。

最终状态：

`P7-02 请求级审计上下文（Request Audit Context） = IMPLEMENTED / AWAITING MAINTAINER REVIEW`

P7-03 未开始。

# P7-04 HOTFIX01 实施说明

状态：**P7-04 HOTFIX01 = IMPLEMENTED / AWAITING MAINTAINER REVIEW**

## 目标

本补丁只收口 P7-04 透明 Salesforce API 审计的两个真实边界问题，并做一项低风险性能优化；不进入 P7-05。

## 修复 1：长 SOQL / 长 URL 不得让 Audit Snapshot 落库失败

P7-04 新增的 `request_url` / `endpoint_path` 已经能够保存较长 URL，但兼容字段 `endpoint`
仍沿用 P7-01 的 1024 字符限制。原实现使用严格长度校验，真实 SOQL URL 超过 1024 字符时
会触发不可重试的 AuditBatchPersistenceError。

修复后：
- 完整事实继续保存在 `request_url` / `endpoint_path`；
- 旧兼容字段 `endpoint` 只保留最多 1024 字符；
- 不因兼容字段过短而丢失整条主审计、事件和 API 明细；
- 新增 MySQL 并发持久化 Gate，真实构造 >1024 字符 endpoint。

## 修复 2：长 Salesforce Error 不得让审计丢失

采集层允许 Salesforce Error Message 最长 2048 字符，而数据库字段
`salesforce_error_message_safe` 只有 1024 字符。原实现会对 1025~2048 字符错误抛出
持久化异常。

修复后错误摘要在持久化边界安全截断到 1024 字符。该字段本身就是摘要字段，截断不会改变
Salesforce 原始 Tool Error，也不会影响 MCP 业务结果。

## 优化 3：不为审计重新扫描大型 Salesforce Response Body

原实现为了 `responseSizeBytes` 对每个成功响应执行 `Buffer.byteLength(response.body)`。
大型 SOQL / Metadata Response 会产生额外 O(n) 扫描。

修复后：
- 优先读取真实 HTTP `Content-Length`；
- 没有 Content-Length 时 `responseSizeBytes = NULL`；
- Error Body 仍只在失败时用于 bounded Error Code/Message 提取；
- Request Body 仅对 Buffer 或 <=8KiB 的小字符串做长度计算，大 Body 不为审计额外扫描；
- 不改变 Response / Error / retry 语义。

## 变更范围

- `packages/sfoa-control-plane/src/mysql-audit-batch-sink.ts`
- `packages/sfoa-control-plane/src/mysql-test/mysql.integration.test.ts`
- `packages/sfoa-identity-runtime/src/jsforce-audit-adapter.ts`
- `packages/sfoa-identity-runtime/src/test/jsforce-audit-adapter.test.ts`

不修改 migration 005/006，不修改官方 Salesforce Provider，不增加 Salesforce API，不改变
P7-03 Async Queue/Writer，不修改业务 Tool。

## Focused Gate 结果

| Gate | 结果 |
| --- | --- |
| `yarn workspace @sfoa/identity-runtime test` | PASS，55/55；含 OAuth/REST/UI/Tooling/Metadata/DML、retry、长 Error 原始语义、Content-Length/NULL size、50/100/200 |
| `yarn workspace @sfoa/control-plane test` | PASS，31/31 |
| `yarn workspace @sfoa/control-plane test:mysql` | PASS，10/10 |
| `yarn workspace @sfoa/mcp-server test` | PASS，66/66 |
| `yarn workspace @sfoa/mcp-server test:p7` | PASS，2/2；production defaults：capacity 1000、batch 50、flush 100 ms |

真实 MySQL 50/100/200 Gate 每档都包含一条长 URL 与一条长 Error Snapshot。长 URL 的
`request_url`、`endpoint_path` 与输入逐值相等且保留尾部 request-specific marker；legacy
`endpoint` 等于完整 path 的前 1024 字符。1500 字符 Error 持久化为精确前 1024 字符。
每条主 Audit、两个 Event 和一个 API 子记录均存在；Orphan、Cross Audit/User/URL/Tool/Binding
与 Duplicate 均为 0。

## 性能 Gate

JSforce adapter 使用同一 local mock server，OFF/ON、50/100/200、每档三轮 paired；下表为
三轮中位数。Heap delta 没有强制 GC，方向噪声较大。

| 并发 | 模式 | p50 ms | p95 ms | p99 ms | throughput/s | heap delta bytes |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 50 | OFF | 373.498 | 398.443 | 400.172 | 99.499 | 4,853,152 |
| 50 | ON | 148.434 | 387.639 | 388.172 | 117.872 | 1,396,992 |
| 100 | OFF | 281.363 | 302.768 | 310.953 | 282.661 | -3,159,008 |
| 100 | ON | 423.204 | 426.992 | 451.373 | 181.983 | -1,287,008 |
| 200 | OFF | 464.868 | 678.530 | 678.734 | 256.053 | 8,784,728 |
| 200 | ON | 437.927 | 474.094 | 479.401 | 263.279 | -7,386,560 |

本机 adapter-only 样本抖动明显：100 并发 p95 `+41.03%`、throughput `-35.62%`；200
并发 p95 `-30.13%`、throughput `+2.82%`。不把反向改善解释为稳定优化，也不隐藏 100 档退化。

另以生产默认 Async Pipeline 参数运行 HTTP OFF/ON Gate，三轮平均结果如下：

| 并发 | OFF p50/p95/p99 ms | ON p50/p95/p99 ms | OFF/ON throughput/s | p95变化 | throughput变化 |
| ---: | --- | --- | --- | ---: | ---: |
| 50 | 388.83 / 409.41 / 413.53 | 390.21 / 419.01 / 421.10 | 122.21 / 122.76 | +2.34% | +0.45% |
| 100 | 704.59 / 756.01 / 760.63 | 798.07 / 821.57 / 825.54 | 131.45 / 122.07 | +8.67% | -7.14% |
| 200 | 1294.57 / 1342.87 / 1345.16 | 1304.33 / 1373.09 / 1376.52 | 148.62 / 144.19 | +2.25% | -2.98% |

Pipeline Gate 的进程环境总 heap delta 为 209,599,104 bytes（没有强制 GC，不能归因到单一
OFF/ON 模式）。与 HOTFIX 前 P7-04 报告的 100 并发 p95 `+13.7%` / throughput `-19.9%`、
200 并发 p95 `+8.7%` / throughput `-12.9%` 相比，production-pipeline 观测值收敛；仍由
Maintainer 判断目标环境性能是否可接受。

结构 Gate：新增 Salesforce API = 0；Duplicate Capture = 0；Cross Audit Leak = 0；同步
Tool-path Audit DB await = 0；五秒 Audit Writer 不延迟 Tool result。Aggregate 与 Git 范围如下。

## 最终 Aggregate

只执行一次：

```powershell
$env:HTTP_TIMEOUT='100'; yarn validate:p5
```

结果：**FAIL（test environment timeout override）**，不得虚报完整 PASS。五个 changed-code lint、
Control Plane 31/31、MySQL 10/10 均通过；Identity 执行到 53/55 时停止。为缩短 Full-stack 中
25 个 `.invalid` auth-store seed 的固定 90 秒 readiness 风险而设置的命令级 100 ms timeout，
也作用于 Aggregate 内的 JSforce local mock：high-level operation Gate 与 50/100/200 Gate 各出现
一个 `AbortError`。同一 Identity suite 在 Aggregate 前不带该覆盖已 55/55 PASS，生产断言失败 0。

按照“一次 Aggregate、基础设施/环境问题如实记录”的要求，没有连续重跑整个项目。Aggregate
在 Identity 处停止，因此其后 MCP/Admin/Web/browser 子 Gate 未由该命令执行；本 HOTFIX 已独立
完成 MCP 66/66 与 P7 pipeline 2/2，未修改 Admin API/Web。

## Git 范围

- Branch：`feature/p7-end-to-end-audit`
- Changed files：HOTFIX 源码/测试 4 个，加本报告 1 个
- Migration 005 diff：0
- Migration 006 diff：0
- Official Salesforce Provider Source Modifications：0
- `packages/sfoa-admin-api/src/tool-catalog.ts`：未修改、未纳入
- `packages/sfoa-admin-web/src/pages/ToolGovernancePage.tsx`：未修改、未纳入
- Commit、push 与最终 working tree：由提交后的 Maintainer handoff 确认

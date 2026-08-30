# P7-03 HOTFIX01 收口验证报告

Status: **P7-03 HOTFIX01 = IMPLEMENTED / AWAITING MAINTAINER REVIEW**

验证日期：2026-08-30
开发分支：`feature/p7-end-to-end-audit`

## 1. 修复范围

HOTFIX01 只为 P7-03 的请求级 Collector 增加事件数量上限，并强化相关测试：

- `MAX_REQUEST_AUDIT_EVENTS = 256`；
- 单次 Tool Invocation 的 Collector 数组最多保留 256 条 Event；
- 超出上限的 Event 不继续增长数组，`droppedEventCount` 逐条增加；
- 发生任何截断后，`auditIntegrityStatus = PARTIAL`；
- 上限已满后出现更高权威的 `MCP_DML_OUTCOME_UNKNOWN` 时，最终 Snapshot 用该终态 Event 替换一条普通 Event，Event 总数仍为 256；
- `requestSummary.auditCapture` 保存 `eventLimit`、`capturedEventCount`、`droppedEventCount`；
- P7 性能 Gate 改为每档 3 个 paired rounds，并报告绝对差和相对差；
- P5 MySQL Runtime 回归测试使用最长 5 秒的有界轮询等待异步审计最终一致，不改变业务请求或 Writer 行为。

未修改 migration 005、Queue、Writer、Dedicated DB Pool、官方 Salesforce Tool 或 Salesforce 调用链。

## 2. Event Bound Gate

测试产生 `256 + 100` 条普通 Event，再在上限后产生一个 `MCP_DML_OUTCOME_UNKNOWN`：

```text
eventLimit              = 256
普通事件写入后数组长度    = 256
普通事件 dropped         = 100
UNKNOWN 后数组长度       = 256
最终 droppedEventCount  = 101
capturedEventCount      = 256
auditIntegrityStatus    = PARTIAL
Audit Call outcome      = UNKNOWN
Audit Call errorCode    = MCP_DML_OUTCOME_UNKNOWN
最终 UNKNOWN Event      = PRESENT
```

截断 Snapshot 不会标记为 `COMPLETE`。终态 Event 替换后按原 sequence 排序，且 Snapshot 仍执行既有 deep freeze。

## 3. 50/100/200 隔离与数据库一致性

Identity Runtime Collector Gate、HTTP P7 Gate 和真实 MySQL Batch Gate 均通过。真实 MySQL Gate 批量持久化 50、100、200，共 350 个 Snapshot；三轮性能 Gate 中 P7 ON 另生成并验证 1,060 个 Snapshot。

```text
Audit ID collision          = 0
Cross Audit Leak            = 0
Cross Platform User Leak    = 0
Cross Salesforce User Leak  = 0
Cross Tool Leak             = 0
Cross Event Leak            = 0
Orphan Event                = 0
Duplicate MCP_TOOL_CALL     = 0
Cross Snapshot Binding      = 0
```

## 4. OFF / ON paired performance

配置：Queue capacity 1000、Batch size 50、Flush interval 100ms、Retry 使用默认值。每档 3 个 paired rounds，执行顺序交替为 OFF→ON、ON→OFF、OFF→ON。

### 三轮均值

| 并发 | 指标 | OFF | ON | 绝对差 ON-OFF | 相对差 |
| ---: | --- | ---: | ---: | ---: | ---: |
| 50 | p50 ms | 308.94 | 326.63 | +17.69 | +5.73% |
| 50 | p95 ms | 317.62 | 338.88 | +21.26 | +6.69% |
| 50 | p99 ms | 318.77 | 340.91 | +22.14 | +6.95% |
| 50 | throughput/s | 156.58 | 146.37 | -10.21 | -6.52% |
| 100 | p50 ms | 583.95 | 624.04 | +40.09 | +6.87% |
| 100 | p95 ms | 601.52 | 648.97 | +47.45 | +7.89% |
| 100 | p99 ms | 604.35 | 652.71 | +48.36 | +8.00% |
| 100 | throughput/s | 165.26 | 153.50 | -11.76 | -7.12% |
| 200 | p50 ms | 1040.51 | 1186.22 | +145.71 | +14.00% |
| 200 | p95 ms | 1129.10 | 1229.76 | +100.66 | +8.92% |
| 200 | p99 ms | 1131.36 | 1231.44 | +100.08 | +8.85% |
| 200 | throughput/s | 177.27 | 161.97 | -15.30 | -8.63% |

### 每轮 p95 原始数据（ms）

| 并发 | OFF 三轮 | ON 三轮 |
| ---: | --- | --- |
| 50 | 286.38 / 324.49 / 342.00 | 336.18 / 350.12 / 330.33 |
| 100 | 560.91 / 649.00 / 594.65 | 714.49 / 648.03 / 584.39 |
| 200 | 1036.60 / 1098.32 / 1252.38 | 1213.21 / 1223.47 / 1252.60 |

P95 在三个并发档位均有正向开销：`+6.69% / +7.89% / +8.92%`，但没有达到 Maintainer 指定的稳定、明显 `>10–15%` 观察线。200 并发 p50 为 `+14.00%`，应继续观察，但本次 P95 证据不要求启动 HOTFIX02。本次不建议实施 HOTFIX02；建议 Maintainer 后续在固定主机、隔离 CPU/网络抖动的环境复测高并发档位。

测试进程共享资源变化：CPU user 8,907,000 µs、CPU system 23,562,000 µs、heap delta 78,829,688 bytes；这些是 OFF/ON 共用进程数据，不虚构为单模式资源归因。

## 5. 故障隔离结果

| 场景 | 结果 |
| --- | --- |
| Audit DB Down / Writer throw | Tool 正常；Pipeline 进入 DEGRADED；请求不等待重试 |
| Writer 延迟 5 秒 | Tool 响应小于 2 秒，不等待约 5 秒 |
| Queue Full | Tool 正常；offer 非阻塞；drop/queueFull 指标增加 |
| CREATE 成功 + Audit 失败 | CREATE 结果保持成功；Salesforce Mutation 调用 1 次 |
| DML UNKNOWN + Audit 失败 | `MCP_DML_OUTCOME_UNKNOWN` 保持；Mutation 调用 1 次，无重试 |
| Client Disconnect after CREATE | UNKNOWN 证据保留；Mutation 不回放 |

## 6. 业务路径和 Salesforce 边界

```text
P7-03 HOTFIX01 新增 Salesforce API       = 0
Tool 请求路径 Audit DB await             = 0
Tool 请求路径 Audit file I/O             = 0
Official Salesforce Tool source changes  = 0
Migration 005 changes                     = 0
```

HOTFIX01 未修改生产 Queue/Writer 路径。请求侧仍只在内存记录 Event、finalize Snapshot 并执行非阻塞 Queue offer；Durable Audit DB 持久化仍由后台 Writer 完成。

## 7. 测试记录

| 命令 | 结果 |
| --- | --- |
| `yarn workspace @sfoa/identity-runtime test` | PASS，43/43；含 Event Bound 和 50/100/200 Collector Gate |
| `yarn workspace @sfoa/control-plane test` | PASS，31/31；含 Queue Full、Writer throw、DB down、5 秒慢 Writer |
| `yarn workspace @sfoa/control-plane test:mysql` | PASS，9/9；含真实 MySQL 50/100/200 Batch/FK Gate |
| `yarn workspace @sfoa/mcp-server test:p7` | PASS，2/2；含 5 秒慢 Writer及三轮 paired benchmark |
| `yarn workspace @sfoa/mcp-server test:p3` | PASS，22/22；含 CREATE/UNKNOWN + Writer failure 无重试 |
| `yarn workspace @sfoa/mcp-server test:p5:mysql` | PASS，1/1；验证异步审计有界最终一致等待 |
| `yarn validate:p5` | PASS，687.34 秒；lint、MySQL、后端、Web、Chromium、真实全栈 Gate 全部通过 |

首次 Aggregate 在 P5 MySQL Runtime 测试中因立即查询异步审计而缺少 `update_record/PASS` 记录。仅将该测试改为最长 5 秒的有界最终一致轮询；失败节点随后 1/1 PASS，必要的完整 Aggregate 重跑 PASS。

## 8. 修改文件

- `packages/sfoa-identity-runtime/src/request-audit-collector.ts`：事件上限、丢弃计数、PARTIAL 状态、权威终态 Event 保留及安全摘要。
- `packages/sfoa-identity-runtime/src/test/request-audit-context.test.ts`：精确 Event Bound / UNKNOWN Gate。
- `packages/sfoa-mcp-server/src/p7-test/audit-pipeline.integration.test.ts`：三轮 paired benchmark、原始样本及差值输出。
- `packages/sfoa-mcp-server/src/p5-test/mysql-runtime.integration.test.ts`：异步审计最长 5 秒有界最终一致轮询。
- `docs/sfoa/P7_03_HOTFIX01_REPORT.md`：本报告。

`packages/sfoa-admin-api/src/tool-catalog.ts` 和 `packages/sfoa-admin-web/src/pages/ToolGovernancePage.tsx` 未修改、未纳入提交。

## 9. 结论

**P7-03 HOTFIX01 = IMPLEMENTED / AWAITING MAINTAINER REVIEW**

未进入 P7-04。

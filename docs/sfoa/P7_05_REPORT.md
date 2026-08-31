# P7-05 SOQL 与 DML 审计证据报告

日期：2026-08-31

状态：`IMPLEMENTED / AWAITING MAINTAINER REVIEW`

分支：`feature/p7-end-to-end-audit`

## 1. 结论

P7-05 已在 P7-04 唯一 Salesforce Transport Fact 上实现 SOQL/DML 语义增强。一个真实 HTTP attempt 仍只由 P7-04 创建一条 `salesforceApiCalls[]` 记录；高层 Query/DML 代码不建行，只提供语义 scope。每份语义证据以 wire attempt 开始时分配的 `publicApiCallId` 精确绑定，Collector 只允许按该 UUID 更新已经存在的行，不存在“按 Audit 找最后一条 API”的逻辑。

实现没有增加 Salesforce API、没有解析成功响应 body、没有复制 Query records、没有同步等待 Audit MySQL、没有修改官方 Salesforce Provider/Tool TypeScript、没有实现 P7-06/P7-07/P7-08。

## 2. 开始前调用链与 CodeGraph 审查

最终 CodeGraph：577 files、7,456 nodes、16,965 edges、15.15 MB，索引为 up to date。

### 2.1 Semantic Enrichment Point Matrix

| 调用类型 | 高层原始事实 | Transport 唯一事实 | 结果增强点 | 绑定方式 |
| --- | --- | --- | --- | --- |
| Data SOQL | `RemoteToolFacade` 的原始 `input.query`、`useToolingApi=false` | P7-04 JSforce/Node HTTP attempt | JSforce Query 已解析 `response` event | scope 在 attempt 开始绑定 `publicApiCallId`，结果只 enrich 同一 UUID |
| Tooling SOQL | `RemoteToolFacade` 或 `ContextToolFacade` 的原始 query | 同上 | 同上 | 同上，`queryType=TOOLING_SOQL` |
| Managed lookup | `ManagedDmlFieldResolver` 构造的精确 SOQL | 独立真实 Query attempt | 已解析 Query result | 嵌套 `SERVER_MANAGED_LOOKUP` Query scope；结束后自动恢复外层 DML scope |
| Query failure | 原始 SOQL + 确定性主对象 | 失败 HTTP/transport attempt + Salesforce Error | 无结果计数增强 | counts 保持 `NULL`，不伪造 0 |
| URL fallback | P7-04 URL `q=` 解码 | 同一 attempt | 无可靠高层结果时不补计数 | 保留 SOQL/type/object，Integrity=`PARTIAL` |
| CREATE | facade 原始 Agent fields；resolver 实际 managed values | JSforce POST attempt | executor SaveResult `id` | executor dispatch scope 绑定 UUID；成功后按 UUID enrich record ID |
| UPDATE | 同上，record ID 来自已验证输入 | JSforce PATCH attempt | executor SaveResult | 同上；submitted fields 不含 JSforce 路由用 `Id` |
| DML validation | requested/managed/exact submitted payload | 确定 Salesforce 失败 attempt | 不补成功 ID | DML 语义与 Salesforce Error 同行保留 |
| DML UNKNOWN | exact submitted payload；UPDATE 预知 ID/CREATE 未知 ID | timeout/reset attempt | 无成功结果 | API attempt 保留，Audit master outcome 保持 `UNKNOWN`，不 retry |
| Parallel Query | 每个 `runWithSalesforceQuerySemantic()` 创建独立 ALS branch scope | 各自 wire attempt | 各自 parsed result | A scope UUID 只更新 A；B scope UUID 只更新 B |
| API cap/drop | 不创建语义行 | P7-04 256 cap 继续生效 | enrich missing UUID 失败开放 | 不增长数组，capture failure + `PARTIAL` |

静态盘点确认当前生产 Runtime 没有 `queryAll` 调用，因此 P7-05 只新增实际使用的 `DATA_SOQL` 与 `TOOLING_SOQL`，未提前加入 SOSL/GraphQL/Analytics 或未使用的 queryAll 枚举。

## 3. 语义上下文与精确绑定

`SalesforceCallSemanticScope` 是 P7-02 `RequestAuditContext` 同一个 AsyncLocalStorage store 的子字段，不是第二套 Request Context，也不是 global/singleton current state。`AsyncLocalStorage.run()` 用于 Query、DML 与 submitted-payload 子 scope；并行 Promise 分支继承各自的 immutable store，嵌套分支退出后恢复父 scope。

P7-04 `createWireAttempt()` 仍负责分配 API UUID 与 sequence。它读取当时的 semantic scope，并调用 `bind(publicApiCallId)`。Transport 完成后仍只有 `recordSalesforceApiCall()` 建立真实 API 行。Query result 和 DML SaveResult 只能调用 Collector 的 `enrichSalesforceApiCall(publicApiCallId, patch)`；该方法找不到 UUID 时记录 capture failure，绝不创建新行或退化为“最后一行”。

## 4. SOQL 证据

### 来源与主对象

第一优先取 facade/resolver 已持有的原始 SOQL string。第二优先才从真实 Request URL 的 `q=` 参数通过 WHATWG `URL.searchParams` 解码；fallback 因缺少完整高层绑定而标记 `PARTIAL`。SOQL 保留可复制文本，最大 65,000 UTF-8 bytes（ASCII 同为 65,000 字符）；超限安全截断并标记 `PARTIAL`，适配既有 MySQL `TEXT`。

主对象解析器只扫描引号与括号之外的顶层 `FROM <ApiName>`，因此 relationship subquery 的内部 FROM 不会被误认。无法可靠提取时返回 `NULL`，不猜测对象；SOQL 原文仍保留。

### 结果与分页

JSforce 3.10.13 在正常业务解析完成后发出 Query `response` event。审计只读取：

- `totalSize`
- `records.length` 作为本页 `returnedRecords`
- `done`
- `nextRecordsUrl` 是否存在作为 `hasNextRecords`

Transport adapter 没有为 P7-05 对成功 body 调用 `JSON.parse`，没有 stringify/clone/scan records。2,000-record Gate 的 Audit snapshot 中只出现 `returnedRecords=2000`，所有 record marker 均不存在。分页不聚合 session；未来 queryMore 的每个真实 HTTP call 仍应由 P7-04 独立记录。

SOQL 失败时 query type、原文、对象与 P7-04 Salesforce Error 保留，`totalSize/returnedRecords/done/hasNextRecords` 为 `NULL`。成功零行则明确为 `totalSize=0`、`returnedRecords=0`、`done=true`。

## 5. DML 证据

- Requested Fields：来自 `DmlToolFacade.execute()` 收到的原始 Agent/Tool `input.fields`，在 managed override 前捕获。
- Managed Fields：只从 `ManagedDmlFieldResolver` 返回的实际 `applied` target 及最终 resolved value 构造；不按字段名猜测。
- Submitted Fields：`DmlExecutor` 先生成一次实际 SDK dispatch fields，再把同一对象交给 observer scope 和 `sobject.create/update()`；不是 requested + managed 推算。
- CREATE Record ID：只来自 Salesforce SaveResult `result.id`；失败/UNKNOWN 为 `NULL`。
- UPDATE Record ID：调用前来自已验证 `input.recordId`，成功 SaveResult 可确认同一值；失败时仍保留。

字段证据是独立只读 scalar audit copy，不修改业务对象。每个 field map 最多 200 fields、单 string 4,096 chars、整体 16 KiB；超限截断并标记 `PARTIAL`。Date/object/undefined 等不在当前 DML scalar schema 内的异常值不会改变业务 payload，并会使证据降级。

Validation failure 与 transport reset Gate 均证明 submitted fields 保留。`MCP_DML_OUTCOME_UNKNOWN` 继续由既有 DML/Request terminal authority决定，mutation count=1、retry=0；P7-05 没有改变此业务语义。

## 6. 数据库与异步主链路

新增 migration：`007_p7_soql_dml_audit_evidence.sql`。

新增列：

- `has_next_records BOOLEAN NULL`
- `submitted_fields_json JSON NULL`

Migration 005/006 未修改。Schema、Contract、Repository、in-memory test store、MySQL repository 与 P7-03 Batch Sink 已贯通。Batch Sink 不再把已有 semantic columns 固定写成 NULL。普通 Audit list 仍不 JOIN 这些字段；P7-03 capacity-1000 Queue、batch-50 Writer、独立 pool、retry/drop/health/fail-open 机制保持唯一持久化路径。业务请求主链路新增同步 Audit DB await = 0。

## 7. Isolation、Fail-open 与数据量 Gate

- Nested scope：managed Contact lookup 与后续 CREATE 各自得到正确 purpose/type/fields。
- Parallel Query：`Promise.all(Query A, Query B)` 的 SOQL、对象与 result counts 未交换。
- Interleaved：Audit 1 的 A/B/C 与 Audit 2 的 X/Y 无 SOQL/object/record/field/API cross binding。
- 50/100/200：三轮每档，cross SOQL/DML/record/object/API binding leak=0，duplicate=0，orphan=0。
- Long SOQL、100-field DML、100 KB value：Snapshot 保持 bounded；原业务对象未变化；Integrity=`PARTIAL`。
- 2,000 records：只读取数组 length，records copy into Audit=0。
- Parser/encoder/missing scope/dropped row：业务 callback/result 保持；semantic capture 降级为 `PARTIAL`。
- MySQL semantic write failure：继续由既有 asynchronous Writer poison/fail-open Gate 隔离，不改变 Tool/Salesforce result。

## 8. Salesforce API 数量与性能

公平 paired benchmark 使用相同 GET Query / PATCH DML workload，OFF 侧无 Request Audit context，ON 侧增加 P7-05 scopes；每个 50/100/200 round 的 mock Salesforce request count 均满足 OFF=ON=concurrency。新增 Salesforce API = 0。

三轮中位数：

| Concurrency | Mode | p50 ms | p95 ms | p99 ms | Throughput/s | Heap delta median bytes |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 50 | OFF | 84.865 | 103.984 | 104.065 | 423.638 | 4,426,336 |
| 50 | ON | 56.241 | 74.893 | 78.497 | 522.799 | 6,165,864 |
| 100 | OFF | 56.813 | 78.430 | 78.656 | 1,072.997 | -2,992,872 |
| 100 | ON | 78.041 | 102.366 | 113.274 | 799.252 | 507,856 |
| 200 | OFF | 134.666 | 163.102 | 170.574 | 1,033.145 | -6,845,384 |
| 200 | ON | 129.699 | 162.173 | 164.538 | 1,059.485 | -1,969,760 |

Heap delta 是未强制 GC 的进程级噪声指标，报告原值而不伪装成精确 allocation。结构上 SOQL、三份 field map 与 API arrays 均有硬上限；Query records 不进入 Snapshot。完整三轮 raw output 由测试输出 `P7_05_PAIRED_BENCHMARK` 保留。

## 9. 测试命令与结果

已执行：

```text
codegraph sync .
yarn build
yarn test
yarn workspace @sfoa/identity-runtime build
yarn workspace @sfoa/identity-runtime test
node --test packages/sfoa-identity-runtime/dist/test/jsforce-audit-adapter.test.js
node --test packages/sfoa-identity-runtime/dist/test/request-audit-context.test.js
yarn workspace @sfoa/mcp-provider-sfoa-dml build
yarn workspace @sfoa/mcp-provider-sfoa-dml test
yarn workspace @sfoa/control-plane build
yarn workspace @sfoa/mcp-server test
yarn workspace @sfoa/mcp-server test:p3
yarn workspace @sfoa/mcp-server test:p7
yarn workspace @sfoa/mcp-server build
yarn workspace @sfoa/control-plane test
yarn workspace @sfoa/control-plane test:mysql
```

Focused results：Identity Runtime 63/63（含 JSforce semantic 14/14、Request context/bounds 14/14 与 50/100/200 paired Gate）；DML provider 18/18；MCP Server 66/66；P3 UNKNOWN 22/22；P7 pipeline/performance 2/2；Control Plane 31/31；real isolated MySQL 10/10。四个受影响 SFoA package build 与 changed-code strict TypeScript lint 均 PASS。

最终且仅一次 root Aggregate `yarn test` 在 official example workspace 8/8 PASS 后，进入未修改的 `@salesforce/mcp-provider-code-analyzer` 时因其 Windows script 直接调用未声明的全局 `tsc` 而提前停止；root `yarn build` 由同一 upstream script 基线阻断。结果记为 `KNOWN UPSTREAM WINDOWS INFRA DEBT`，不伪报 PASS，也未按测试成本治理重启第二轮 Aggregate。P7-05 自有 package builds、focused suites、并发、性能与真实 MySQL Gate 均独立通过；官方 TypeScript、manifest 与 lockfile 未为规避该环境问题而修改。

## 10. Changed files

Production：

- `packages/sfoa-identity-runtime/src/request-audit-context.ts`
- `packages/sfoa-identity-runtime/src/request-audit-collector.ts`
- `packages/sfoa-identity-runtime/src/jsforce-audit-adapter.ts`
- `packages/sfoa-mcp-server/src/remote-tool-facade.ts`
- `packages/sfoa-mcp-server/src/context-tool-facade.ts`
- `packages/sfoa-mcp-server/src/dml-managed-fields.ts`
- `packages/sfoa-mcp-server/src/dml-tool-facade.ts`
- `packages/sfoa-mcp-server/src/provider-runtime.ts`
- `packages/mcp-provider-sfoa-dml/src/dml-executor.ts`
- `packages/sfoa-control-plane/migrations/007_p7_soql_dml_audit_evidence.sql`
- `packages/sfoa-control-plane/src/{contracts,repositories,schema,migrations,mysql-audit-repository,mysql-audit-batch-sink}.ts`

Tests：identity semantic/context tests、DML executor test、Control Plane migration/in-memory/MySQL tests。

Docs：`P7_END_TO_END_AUDIT_BASELINE.md`、`TEST_MATRIX.md`、`PROJECT_BASELINE.md`、`ARCHITECTURE.md`、`CHANGELOG.md`、本报告。

Root manifest、`yarn.lock`、官方 Salesforce Provider/Tool TypeScript changes = 0。

## 11. Git 与阶段边界

Branch：`feature/p7-end-to-end-audit`。Commit 与 push 后 remote HEAD/clean-tree evidence 由最终交付消息给出；报告不嵌入自引用 commit hash，避免文档改动反复改变该 hash。

P7-06 MCP request/response capture、P7-07 React Workbench、P7-08 AI diagnostics/RAG/Judge、before/after SOQL、DELETE、Kafka/Redis/new broker 均未实现。

最终声明仅为：

`P7-05 SOQL与DML审计证据（SOQL & DML Audit Evidence） = IMPLEMENTED / AWAITING MAINTAINER REVIEW`

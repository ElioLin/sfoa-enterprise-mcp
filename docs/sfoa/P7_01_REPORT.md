# P7-01 全链路审计数据模型实施报告

状态：`IMPLEMENTED / AWAITING MAINTAINER REVIEW`

代码基线：`main@c849e577`

开发分支：`feature/p7-end-to-end-audit`

本报告记录已经实现并实际验证的 P7-01。它不授权 P7-02～P7-08，也不把整个 P7 标记为完成。

## 1. 当前架构审查

- **现有 Audit 数据模型**：`sfoa_audit_log` 是 P5/P6 的单表追加账本，既包含 Admin、身份与 Runtime 事件，也承载现有 Audit List DTO。它没有单次 Tool Invocation 的有序 Event、Salesforce API 或 bounded Payload 关系。
- **Repository**：`ControlPlaneRepositories.audits` 提供兼容追加/搜索；MySQL 实现此前位于持续膨胀的 `mysql-repositories.ts`。P7 将 Audit 高内聚实现拆至 `mysql-audit-repository.ts`，原导出路径保持兼容。
- **Runtime Logger**：现有 Runtime 以 fail-open 方式追加安全摘要。由于 timeout/disconnect 可能为一次调用产生多个扁平事件，P7-01 不把旧 Runtime 行推断成 MCP Tool Call，也未接入 Collector。
- **Admin API**：继续消费旧 Audit DTO、分页与过滤 Contract；本次没有提前建设 Trace Workbench API。
- **React Audit UI**：仍是现有列表/简单详情。仅增加对历史 Buntu secret-shaped 内容的防御性脱敏，未重做工作台。
- **衔接方式**：选择演进 `sfoa_audit_log` 为兼容主表，增加明确的 `auditKind`、public ID、时间与完整性字段；新 Trace Repository 独立写入 Event/API/Payload 子表。旧调用方保持原接口，新调用方可显式 `createCall()`。

## 2. P7 完整计划基线

权威计划见 `P7_END_TO_END_AUDIT_BASELINE.md`。摘要如下：

| Phase | 目标与实施内容 | 前置依赖 | 验收 Gate | 明确不做 |
| --- | --- | --- | --- | --- |
| P7-01 | 兼容主表、Event/API/Payload 模型、Contract、Repository、migration | P6 main 基线 | migration、兼容、隔离、secret、fail-open、全回归 | Runtime Collector、ALS、Queue、Workbench |
| P7-02 | request audit context、Audit/Correlation/身份/Tool/序号 | P7-01 Maintainer review | 单请求生命周期与上下文传播测试 | 异步批写与 transport 全覆盖 |
| P7-03 | AsyncLocalStorage、request-bound collector/connection、snapshot、queue、batch、fail-open | P7-02 | 50/100/200 并发零串审计；DB/Queue/Payload 故障隔离；P7 On/Off 性能 | Kafka、Redis Streams、业务反压 |
| P7-04 | 统一 Salesforce 执行层透明捕获 REST/Data/UI/Tooling/Metadata | P7-03 | 新 Tool 自动获得 API 证据；无额外 Salesforce API | 每 Tool 手写重复 Audit |
| P7-05 | SOQL/DML 专用事实证据 | P7-04 | query/result/error 与 CREATE/UPDATE 字段/响应证据准确、bounded | 权限复制、业务成功推断 |
| P7-06 | MCP 请求摘要、最终 Tool 结果、返回客户端摘要分层 | P7-02～05 | 可区分 Salesforce outcome 与 MCP response | Conversation/业务任务聚合 |
| P7-07 | 中文优先单页 Trace Workbench、timeline/API/SOQL/DML/waterfall/raw JSON | P7-01～06 API 完整 | URL 状态、错误定位、复制 ID、可访问性与前端回归 | 重做整个 Admin UI |
| P7-08 | 只读运维诊断接口与 SFoA Troubleshooting Skill | P7-01～07 | 最小权限、诊断包安全边界、异常搜索与 API 证据 | 普通业务用户天然审计权、LLM Judge/评分 |

所有阶段共同红线：请求级零泄漏、Audit fail-open、性能隔离、只记录事实、统一 redaction/bounded capture。

## 3. P7-01 实际完成内容

- `migrations/005_p7_end_to_end_audit.sql`：兼容演进主表并新增三个明细表、约束、索引与历史 raw-token 清理。
- `contracts.ts`、`repositories.ts`、`schema.ts`：新增 Audit Call/Event/Salesforce API/Payload Evidence 类型、写入输入、查询与数据库 row schema。
- `mysql-audit-repository.ts`：独立实现兼容 Audit 与 Trace Repository；集中进行大小限制、sanitization、same-audit 关系写入。
- `mysql-repositories.ts`、`store.ts`、`index.ts`：组合并重导出拆分后的 Audit 实现，保持现有 import 兼容。
- `audit-sanitization.ts`：统一 secret-shaped key/value 与自由文本净化；禁止明显 Authorization/Bearer/JWT/private-key/secret 样本持久化。
- `migrations.ts`：migration advisory lock 固定单连接；跨 LF/CRLF 只接受语义相同文件 checksum，实际 SQL 改动仍拒绝。
- MySQL/unit/Admin/MCP/UI tests：覆盖迁移、兼容、关系、隔离、bounded payload、安全、fail-open 与既有页面/Runtime 回归。
- Buntu Runtime/config/docs：ADR-0016 将原始 Bearer 审计恢复为默认关闭的专用排障开关；只有 Buntu 校验的 durable MySQL 路径可写入，通用日志/fallback/HTTP 仍脱敏。历史已知 `rawToken` 在 migration 升级时执行一次净化。
- `.codegraph/.gitignore`：项目可使用本机 CodeGraph 索引，数据库不进入 Git；没有引入运行时依赖。

## 4. 数据库 Schema

### 主表 `sfoa_audit_log`

保留全部历史列，新增 `public_audit_id`（UUID unique）、`audit_kind`、`started_at`、`completed_at`、`error_message_safe`、`audit_integrity_status`。计数不在主表冗余存储；未来按明细聚合或专用查询获得。历史行不搬迁、不伪装为完整 Tool trace。

### `sfoa_audit_event`

保存 audit-local `sequence`、可空 parent、category/type/name、时间/耗时/status/error/safe summary。`UNIQUE(audit_id, sequence)`；parent 使用 `(audit_id, parent_event_id)` 组合关系，防止 Audit A 指向 Audit B。

### `sfoa_salesforce_api_call`

保存 audit-local sequence、执行 Salesforce 用户、API category/HTTP/endpoint/version/purpose/result/error，以及 SOQL 与 DML 专用标量/小 JSON 证据。完整 Salesforce Response 不进入此表。

### `sfoa_audit_payload_evidence`

保存 payload 类型/content type、原始/存储大小、truncated、可选 SHA-256 与 bounded safe payload；Event/API 可空组合 FK 必须属于同一 Audit。Payload 上限 256 KiB，普通主表列表不选择或 Join 此表。

### FK、索引与 retention

主表删除对子表 `CASCADE`；子表跨 Audit 组合 FK 拒绝串链。索引覆盖主表时间、Correlation、平台/Salesforce 用户、Tool/result/error/channel，以及子表 audit+sequence、error、API category/status。`auditRetentionDays` 保留为未来策略输入；P7-01 不实现清理 Job。

## 5. 兼容性说明

- 旧 Audit **不迁移、不删除**，原 `sfoa_audit_log` 与历史 ID 保持。
- 原 `audits.append/search`、Admin API DTO、分页/过滤继续兼容；新 Trace 能力通过独立 Contract 暴露给未来阶段。
- Admin Audit UI 继续可用，没有要求明细表存在数据；未知值保持空/UNKNOWN。
- P5/P6 Identity Route、Tool Governance、DML Policy、Diagnostic、Playbook 与 Runtime Audit 回归均通过。
- 未修改官方 Salesforce Tool 实现、Provider SDK 或 Salesforce transport。

## 6. 测试结果

完整命令与逐项结果见 `TEST_MATRIX.md`。最终证据包括：Control Plane unit 21/21、MySQL 8/8、MCP full serial 66/66、P3 20/20、P4 7/7、P5 5/5、DML 17/17、Context 10/10、Identity 32/32、Playbook 6/6、Admin API 18/18、Admin Web 35/35/build、mock E2E 1/1、full-stack E2E 1/1。2026-08-30 follow-up 的 `yarn validate:p5` 以 exit 0 在 545.87 秒完成。

已识别但不归因于 P7 的 debt：Vite 大 chunk advisory、Node/Yarn `url.parse()` deprecation、Windows 下重型 jsdom/Ant 与并发 Node tests 的时序波动。P7 修改文件的 strict TypeScript Gate 通过。首次 aggregate 最终子 Gate 暴露本机遗留 raw-token flag；隔离测试配置后真实 full-stack 通过。

## 7. 风险与遗留项

- **并发串审计 / global mutable state**：P7-01 没有 Collector，因此没有新增“当前 Audit”全局变量；真正的 50/100/200 并发零泄漏 Gate 属于 P7-03。
- **大 Payload**：Repository 已硬限制并独立表存储；Runtime capture 尚未开始，P7-03/04 必须避免复制与同步写阻塞。
- **Repository 膨胀**：Audit MySQL 实现已领域拆分，未继续塞入聚合文件；不再为其它领域制造抽象。
- **Migration**：001～004 未修改；005 通过 clean/P6 upgrade/repeated/concurrent Gate。跨平台 checksum 只兼容换行差异。
- **索引**：依据已知列表/trace 查询设置；生产规模 selectivity 与 retention 仍需在 P7-03 benchmark 复核。
- **Fail-open**：现有 Runtime Logger contract 未破坏；P7-01 Repository 本身仍可抛错供调用方观察，P7-03 writer 必须吞并隔离 audit side-effect failure。
- **本机配置**：`MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED` 默认应为 `false`。仅在授权排障窗口设置为 `true`；这会把可直接认证的 Buntu Token 写入 MySQL 并在 Admin 审计详情显示，应在排障结束后关闭并按运维策略清理相关记录。
- **Migration 中断恢复**：MySQL DDL 会隐式提交。若 005 的全部结构已存在但台账行缺失，迁移器在完整验证列、索引和命名约束后补登记原 checksum；任何部分完成状态仍失败关闭。

## 8. 下一步：仅 P7-02 请求级审计上下文

P7-02 建议先定义不可变 `RequestAuditContext`：预分配 `publicAuditId`、Correlation ID、可信请求身份、Tool、已解析 Salesforce 用户、audit-local sequence allocator 与 request-scoped collector 接口。入口只创建一次，上下文随现有 request boundary 显式传递；不得使用进程级 mutable global，也不得在此阶段接入 Queue 或全 Salesforce transport。

验收应覆盖同一请求 ID 稳定、不同请求 ID/sequence 独立、身份与 Tool 不可被下游覆盖、异常/timeout/disconnect 的 snapshot 语义，以及没有 Context 时保持旧 Runtime fail-open。P7-02 通过 Maintainer review 前，不开始 P7-03。

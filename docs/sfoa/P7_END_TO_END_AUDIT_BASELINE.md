# P7：全链路审计与智能诊断权威基线

Baseline ID: **P7-E2E-AUDIT-BL-1.5**

Baseline date: 2026-09-01

Authority: 本文件是 P7（End-to-End Audit & AI-Assisted Diagnostics）的唯一权威需求、阶段边界和验收计划基线。任何 Codex、Claude Code 或其他开发智能体在规划或修改 P7 前，必须先完整读取本文件，并继续遵守 `AGENTS.md`、`PROJECT_BASELINE.md`、`ARCHITECTURE.md`、`MCP_ENGINEERING_RULES.md` 与 `UPSTREAM_STRATEGY.md`。

## 1. 正式目标

P7 为每一次确定的 MCP Tool Invocation 建立可信、完整、有顺序、可追溯的执行证据，使管理员未来能够还原：

```text
Agent 调用 MCP
  -> MCP 请求与身份解析
  -> Salesforce 身份路由
  -> Tool 治理
  -> Tool 执行
  -> Salesforce API / SOQL / DML
  -> Salesforce 返回
  -> MCP 内部处理
  -> MCP 最终返回 Agent
```

P7 只记录系统能够证明的事实。一条 P7 调用主记录严格对应一次 MCP Tool Invocation，不把多个 Tool 自动推断成一个 AI 业务任务。

## 2. 明确非目标

P7 不建设或引入：

- 智能体可靠性评分、综合可靠性百分比或 LLM Judge；
- 对整个 AI 最终业务任务成功与否的推断；
- 对模型主观意图、决策原因或用户意图的推断；
- 业务知识库、RAG、Domain Action 或业务对象专用工作流；
- Conversation ID 强制要求；
- Kafka、Redis Streams 或 OpenTelemetry 强依赖；
- Salesforce 权限副本、官方 Tool 复制或官方 Salesforce Tool 实现修改；
- DELETE、UPSERT、Bulk DML 或新的业务变更能力。

未知事实必须保持 `UNKNOWN` / `NULL`，不得用推断值补齐。

## 3. 不可破坏红线

### 3.1 请求级绝对隔离（Strict Request Isolation）

多用户、多并发下，审计不得串联或复用其他请求的：

- 平台用户、Tool、Salesforce Username；
- SOQL、Salesforce API、Payload、Event；
- Collector、请求上下文或 Salesforce Connection。

不得使用进程级 mutable global 保存“当前用户”“当前审计”或“当前 Collector”。并发串审计容忍度为 **0**；任何 `crossAuditLeak > 0` 都是阻断级缺陷。

### 3.2 审计失败开放（Audit Fail-Open）

Runtime 审计是 observational side effect。MySQL insert、未来 Queue、Payload 处理、Writer 或 fallback 失败均不得：

- 改变已确定的 Tool 结果或 Salesforce mutation outcome；
- 导致 CREATE / UPDATE 重复执行；
- 触发 MCP 自动重试；
- 把原本成功的 Salesforce 调用改成失败。

继续保持：**Audit failure never reverses a successful Salesforce mutation**。

Admin 配置变更与其 Admin 审计继续使用 P5 已接受的同事务强一致语义；该语义不得被错误套用到已执行的 Salesforce Runtime mutation。

### 3.3 审计性能隔离（Audit Performance Isolation）

P7 不得：

- 为审计增加额外 Salesforce API；
- 每产生一个 Event 就同步执行一次 MySQL INSERT；
- 因数据库慢、Payload 写入或 Queue Full 阻塞 Tool Response；
- 让 Audit Writer 占满业务 Control Plane 连接池；
- 通过 Queue 反压 MCP 请求。

P7-03 必须建立异步批量写入与 fail-open 路径；P7-01 只建立可支撑该路径的数据模型与 Repository Contract，不接入运行时收集管道。

### 3.4 只记录可证明事实

审计可以记录已经发生并有直接证据的请求、身份解析、治理判断、API 调用、Salesforce 返回、内部处理和 MCP 返回。审计不得推断 Agent 意图、跨 Tool 业务任务、业务成功率或可靠性分数。

### 3.5 安全与净化（Redaction / Sanitization Contract）

除下述经维护者明确批准的小犇排障例外外，任何审计表、日志、fallback、Payload Evidence 或诊断包都不得保存：

- Authorization Header、Bearer Token、Cookie / Set-Cookie；
- JWT、Private Key、Client Secret；
- 数据库密码、Admin Session Secret、MCP Client Token；
- USER_BOUND 原始 Token、其他 Buntu Token 载荷或其他可直接认证的机密。

`MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED=true` 是唯一批准的高风险例外：它只允许 `channel=MCP`、`identitySource=BUNTU_TOKEN`、`operation=BUNTU_TOKEN_VALIDATE` 的 MySQL 主审计记录写入 `request_summary_json.rawToken`，默认必须为 `false`。原始值不得进入通用 RuntimeLogger、stdout/stderr、HTTP 错误响应或 audit fallback；写入失败必须 fail-open。Admin 审计详情可以在明确高敏警告下显示该值。任何其他 operation/source/channel 尝试使用此专用 Repository 字段必须拒绝。Migration 005 对升级当时的历史 `rawToken` 仍执行一次清理；显式启用后产生的新记录不受该一次性清理影响。

除此窄例外外，P7 继续使用统一、集中、可测试的净化 Contract。明显 secret-shaped 字段和值必须在 Repository 持久化边界前被删除或替换为固定 redaction 标记。JWT、Authorization Header、MCP Client Token、USER_BOUND Token、密码、私钥等均不得因本例外被放宽。

Salesforce 大 Payload 必须 bounded capture。不得用一个无限大 JSON 字段替代关系模型，也不得无限复制 Salesforce 数据到 MySQL。

## 4. P7 数据模型总览

```text
sfoa_audit_log（兼容主账本 / Audit Call 主记录）
  1 ── N sfoa_audit_event
  1 ── N sfoa_salesforce_api_call
  1 ── N sfoa_audit_payload_evidence

sfoa_audit_event
  1 ── N 子 Event（可空 parentEventId，同一 audit 强约束）
  1 ── N Salesforce API Call（可空关联）
  1 ── N Payload Evidence（可空关联）

sfoa_salesforce_api_call
  1 ── N Payload Evidence（可空关联）
```

### 4.1 现有主表兼容决策

P7-01 选择 **方案 A：演进现有 `sfoa_audit_log`**，不创建替代主表、不删除旧表、不搬迁历史行。依据：

1. P5/P6 Runtime Logger、Admin 事务审计、Dashboard、Admin Audit API 与 React 页面都直接依赖现表；
2. 旧历史行已经有稳定数字主键和查询索引；
3. 新建主表会引入双写、历史迁移、API union 查询和更高回滚风险；
4. 添加公共 Audit ID、时间边界、完整性状态和独立子表即可建立 P7 扩展点。

现表同时保留历史 Admin/身份验证/Runtime 事件。为避免语义混淆，P7-01 增加可证明的 `auditKind` 判别：

- `MCP_TOOL_CALL`：一行严格对应一次 MCP Tool Invocation 或明确的调用尝试；
- `ADMIN_ACTION`：P5/P6 Admin 配置事务审计；
- `IDENTITY_VALIDATION`：例如 Buntu Token 验证事实；
- `RUNTIME_EVENT`：不能证明为 Tool Invocation 的兼容 Runtime 事件。

只有 `MCP_TOOL_CALL` 行称为 P7 Audit Call。P7 不把其他类型伪装成 Tool 调用。历史 flat Runtime 在超时/断连时可能为同一次 Tool 调用写出多个事件，因此 `tool_name` 不是“一行 = 一次调用”的充分证据。Migration 只把可证明的 Admin/身份验证行回填为专用类型，其余历史行保持 `RUNTIME_EVENT`；只有新 `createCall()` 或显式 `auditKind` 才能建立 `MCP_TOOL_CALL` 主记录。

### 4.2 主记录物理字段与派生字段

保留全部现有字段，并在 P7-01 物理增加：

- `publicAuditId`：外部稳定 UUID；旧行由 migration 补齐；Repository 可校验并接受未来 Request Context 预先生成的 UUID，兼容 append 未提供时再生成；
- `auditKind`；
- `startedAt`、`completedAt`（未知时为 `NULL`）；
- `errorMessageSafe`；
- `auditIntegrityStatus = COMPLETE | PARTIAL | DEGRADED`。

`eventCount`、`salesforceApiCount`、`soqlCount`、`dmlCount`、`payloadEvidenceCount` 暂不冗余存储。它们以后通过子表聚合或异步快照接口获得，避免计数器与明细在 fail-open/批量写入场景下失配。普通主表列表不得 JOIN Payload 表。

完整性语义：

- `COMPLETE`：当前调用所要求的审计证据全部持久化；
- `PARTIAL`：模型阶段、截断或缺少部分预期证据，但未证明 Writer 故障；
- `DEGRADED`：已观察到审计处理、Queue、Writer 或持久化故障。

P7-01 尚未接入全链路 Collector，因此旧 Runtime/Admin `append` 默认保持 `PARTIAL`，不得虚报 `COMPLETE`。

### 4.3 执行事件（Audit Event）

字段至少包括：

- `id`、`auditId`、每 Audit 独立的 `sequence`；
- 可空 `parentEventId`，且数据库/Repository 必须保证父子属于同一 Audit；
- `eventCategory`、`eventType`、`eventName`；
- `startedAt`、`completedAt`、`durationMs`；
- `status`、`errorCode`、`safeSummaryJson`、`createdAt`。

`UNIQUE(auditId, sequence)` 是顺序事实的数据库 Gate。Sequence 从 1 开始，绝不使用 global sequence。

### 4.4 Salesforce API Call

字段至少包括：

- `id`、`auditId`、可空且同 Audit 的 `auditEventId`、每 Audit 独立 `sequence`；
- `salesforceUsername`、`apiCategory`、`httpMethod`、`endpoint`、`apiVersion`、`purpose`；
- `startedAt`、`completedAt`、`durationMs`、`httpStatus`、`result`；
- `salesforceErrorCode`、`salesforceErrorMessageSafe`；
- SOQL：`queryType`、`soqlStatementSafe`、`totalSize`、`returnedRecords`、`done`；
- DML：`dmlOperation`（仅 CREATE / UPDATE）、`objectApiName`、`recordId`、`requestedFieldsJson`、`managedFieldsJson`。

完整 Salesforce Response 大 JSON 不写入此表；需要时只进入 bounded Payload Evidence。

### 4.5 Audit Payload Evidence

字段至少包括：

- `id`、`auditId`、可空且同 Audit 的 `salesforceApiCallId` / `auditEventId`；
- `payloadType = MCP_REQUEST | MCP_RESPONSE | SALESFORCE_REQUEST | SALESFORCE_RESPONSE | ERROR_RESPONSE`；
- `contentType`、`originalSizeBytes`、`storedSizeBytes`、`truncated`；
- 可空 `contentSha256`、`safePayload`、`createdAt`。

P7-01 只实现模型、Contract、bounded Repository 持久化与安全测试，不实现 Runtime Payload Capture。`safePayload` 有硬上限；普通 Audit 列表和 Dashboard 查询不得选择或 JOIN 它。

### 4.6 FK、删除与保留策略

- 三类明细通过 FK 绑定主记录；删除主记录用于受控 retention 时级联删除明细；
- Event 父子、API→Event、Payload→Event/API 使用同 Audit 复合 FK，数据库直接阻止跨 Audit 关联；
- Repository 不提供任意明细删除能力；
- `auditRetentionDays` 继续作为未来 retention 目标，P7-01 不实现删除任务；
- retention 将以主记录时间为切点，由父级删除触发级联，不按 Payload 独立清理导致孤儿。

## 5. 分阶段计划与 Gate

### P7-01 全链路审计数据模型（本次实施）

目标：建立兼容主记录、Event、Salesforce API Call、Payload Evidence 的关系模型与严格持久化 Contract。

实施内容：

- additive MySQL migration、schema validator、Kysely schema；
- 主记录兼容扩展与公共 Audit ID；
- 分域 Audit Repository，不继续把新领域实现堆入 `mysql-repositories.ts`；
- bounded sanitization、Contract 与 Repository；
- 旧 Admin Audit API/DTO/React 页面继续可用；
- migration、兼容、FK、隔离、sequence、Payload、secret、fail-open 自动化测试；
- 项目基线、测试矩阵、架构/变更记录和 README 链接。

前置依赖：P5 Control Plane、P6 identity/DML migrations 已在最新 `main`；P0-P5 已 final accepted，P6 已合并到 `main` 的 Git 事实由分支历史确认。

验收 Gate：本文件第 7 节及 `TEST_MATRIX.md` 的 P7-01 实际命令全部有真实结果；Maintainer review 前状态只能是 `IMPLEMENTED / AWAITING MAINTAINER REVIEW`。

不做：Request Context、AsyncLocalStorage、Collector、Queue、Salesforce transport instrumentation、Audit Workbench、Diagnostic MCP/Skill。

### P7-02 请求级审计上下文（Request Audit Context）

目标：为一次 MCP Tool Invocation 建立不可变 Audit ID、Correlation ID、身份、Tool、Salesforce 用户与 sequence 分配上下文。

实施内容：请求级 Contract、Audit ID 生命周期、按 Audit 单调 sequence allocator、身份/Tool 固化、明确未开始/已开始/已完成边界。

前置依赖：P7-01 schema/Repository Maintainer review 通过。

验收 Gate：并发请求的 Context 引用、Audit ID、身份、Tool 与 sequence 互不串联；无进程级当前用户/当前审计 global；stdio 与 HTTP 回归通过。

不做：异步 Queue、Salesforce transport 全面插桩、UI 工作台、诊断 Skill。

Maintainer 结果（2026-08-30）：`COMPLETE`。Runtime 在确定的 `tools/call` 入口生成 UUID Audit ID，Correlation ID 独立继承/生成；身份与 Salesforce Route 通过类型化 API 补全。一个极薄的 Node.js `AsyncLocalStorage` 仅把 Context 传入现有 Tool callback/Runtime Logger。100 路 Promise 交错 Gate 的 Audit ID collision 与所有 cross-context leak 均为 0。

### P7-03 请求级隔离与异步审计管道

目标：建立 Request-bound Collector、Snapshot、异步 Queue、Batch Persistence 与完整 fail-open/performance 隔离。

实施内容：AsyncLocalStorage 或等效请求上下文、request-bound collector/Connection、不可变 Audit Snapshot、bounded queue、批量 Writer、drop/degrade 指标和独立连接预算。

前置依赖：P7-02 请求上下文 Gate。

验收 Gate：第 6 节并发、故障和性能 Gate 全部通过；Queue Full 不反压业务；审计失败不改变 Tool/Mutation outcome。

不做：UI 工作台、AI 诊断 Tool、可靠性评分。

Maintainer 结果（2026-08-31）：`COMPLETE`（包含 HOTFIX01 收口验证）。P7-02 Controller 直接持有唯一纯内存 Collector；Runtime Log 映射为 request-local Event，并依据显式 `IDENTITY < GOVERNANCE < TOOL < REQUEST < TRANSPORT` 权威层级及 post-dispatch UNKNOWN 最高优先级选择主终态。HTTP 请求完成时最多 finalize/enqueue 一次深度冻结、bounded、JSON-safe Snapshot。容量 1000 的非阻塞 Queue、batch 50 / interval 100 ms 的后台 Writer、2 次指数退避、5 秒有界 shutdown flush、独立最多 2 连接 Audit Pool 和完整 health metrics 已接入。正常 Tool 路径只做内存 append/finalize/offer，不等待 Audit DB。P7-04 正式启用 Salesforce API 数组；Payload 数组仍保持空；Admin 同事务审计保持同步。

### P7-04 Salesforce API 透明审计

目标：统一 Salesforce 执行层自动记录 REST、Data、UI、Tooling、Metadata、CLI/Workspace 相关操作。

实施内容：在既有公共 Provider/SDK composition seam 增加透明 adapter/instrumentation；所有新增 Tool 只要使用统一执行层即可自动获得审计。

前置依赖：P7-03 Collector/Queue；必须完成 official Provider/SDK seam 审查。

验收 Gate：覆盖各 API category 的成功、失败、超时、UNKNOWN、身份隔离和零额外 Salesforce API；官方 Tool 实现修改为 0。

不做：每个 Tool 手工重复 Audit、复制官方 Tool、业务分析 Tool。

Maintainer 结果（2026-08-31）：`COMPLETE`。源码 + CodeGraph + pinned dependency 盘点确认 request-scoped OAuth、REST/Data、UI、Tooling、DML 和 Metadata SOAP 都进入 JSforce 3.10.13。单一 SFoA adapter 以 `Transport.httpRequest()` 建立 JSforce-only scope，并按真实 Node HTTP attempt 捕获 retry/redirect；高层只提供 Purpose。每 attempt 在开始时绑定 Audit UUID 与共享 request-local sequence。独立 classifier、256 条上限、失败优先替换、migration 006、同一 P7-03 Async Writer persistence 及 OAuth/failure/duplicate/50-100-200/MySQL/performance Gates 已实现。完整路径矩阵、性能原始数字和限制见 `P7_04_REPORT.md`。

### P7-05 SOQL 与 DML 审计证据

Maintainer 结果（2026-08-31）：`COMPLETE`。P7-05 以同一 Request Audit ALS 中的嵌套语义 scope 为高层载体，以 P7-04 wire attempt 的 `publicApiCallId` 为唯一绑定键；Query 只读取 JSforce 已解析结果的计数，DML 分别从 facade、真实 managed resolver 与 executor 最终 payload 获取 requested/managed/submitted evidence。Migration 007、异步 Batch Sink、Data/Tooling/zero/failure/pagination、CREATE/UPDATE/validation/UNKNOWN、nested/parallel/50-100-200/bounds/fail-open/performance Gates 已实现；完整证据见 `P7_05_REPORT.md`。

目标：在透明 API 证据上提供专用、可检索、bounded 的 SOQL 与 CREATE/UPDATE 事实。

实施内容：SOQL 原文安全捕获、类型/用途/totalSize/returned/done/error；DML 对象/record/requested/managed/response/error；保留 UNKNOWN/no-retry 边界。

前置依赖：P7-04 统一 Salesforce 执行层。

验收 Gate：敏感信息净化、bounded capture、无额外查询、CREATE/UPDATE 一次调用/零自动重试、Managed Field 值不越权泄露。

不做：DELETE、业务成功推断、字段权限副本、DML readback。

### P7-06 MCP 入口与响应审计

目标：区分 Salesforce API 结果与 MCP 最终返回给客户端的内容。

实施内容：MCP 请求安全摘要、Tool 最终结果、MCP 响应安全摘要、传输终止层和 Payload Evidence 关联。

前置依赖：P7-03；与 P7-04/P7-05 的 API 证据关联 Contract 稳定。

验收 Gate：成功/失败/blocked/timeout/disconnect/UNKNOWN 场景均能还原；不保存 Authorization/Cookie；响应捕获不延迟客户端。

不做：Conversation 聚合、Agent 意图推断、完整未净化 Prompt 持久化。

实施结果（2026-09-01）：`IMPLEMENTED / AWAITING MAINTAINER REVIEW`。HTTP body 只 bounded read/parse 一次并复用 raw source；`MCP_REQUEST` 在 Identity 前记录。Bounded response recorder 旁路观察真实 `write/end` bytes 与 `finish/close/error`，保持逻辑 Tool `responseSummary` 与 transport facts 分离，且从不把 `finish` 描述为客户端确认收到。P7-04 adapter 只从 JSforce 已形成的 `HttpRequest.body` / 最终 `HttpResponse.body` 获取 Salesforce payload，不消费 Node response stream；retry body 只绑定最终可证明 attempt。Collector 强制 256 KiB/item、64 items、1 MiB/Audit，并为 error/MCP core 各保留 256 KiB；Writer 在同一 transaction 解析 sequence/public UUID 后落库并对持久化 prefix 计算 SHA-256。Migration 008、success/identity/governance/error/timeout/disconnect/UNKNOWN/OAuth/retry/2MiB/Queue/slow DB/50-100-200/MySQL/performance Gates 已实现，详见 `P7_06_REPORT.md`。

### P7-07 审计调用链工作台（Audit Trace Workbench）

目标：把当前 Drawer 详情升级为单页主从工作台。

实施内容：左侧审计列表、右侧当前 Audit；顶部摘要、顺序时间线、Salesforce API 列表、SOQL/DML 专用视图、错误定位、耗时瀑布、格式化请求/响应、Raw JSON 按需展开、复制 ID、URL 保存选择状态。

前置依赖：P7-01～P7-06 数据/API 完整；Admin API 权限与分页设计通过。

验收 Gate：普通列表不加载 Payload；中文优先标签（可加英文）；键盘/可访问性、URL 深链、bounded fetch、错误节点定位和浏览器 E2E 通过。

不做：多页面跳转式详情、只显示英文标签、AI 聊天 UI。

### P7-08 Agent-Native Maintainer Skill 与本地只读诊断工具集

目标：提供项目工作区内只读的 **Agent-native SFoA MCP Maintainer Skill 与本地诊断工具集**，主要服务 Codex、Claude Code 与 WorkBuddy/CodeBuddy，以及 Developer、Maintainer 和 Operator。Skill 是 advisory context，不是 reasoning boundary；诊断程序只读取本地工作区与现场证据，不向普通业务 Agent 暴露内部 MySQL，也不新增 public business MCP diagnostic Tool；`.env.local` 只由本地诊断程序内部读取，DB 诊断保持 read-only。

实施内容：以一个 canonical portable Skill 提供渐进式项目知识；通过 Windows-compatible Node.js 脚本生成三种客户端副本和 ZIP；提供 Project Snapshot、Doctor、预定义 MySQL inspection 与 P7 Audit reconstruction。工具只读取本地工作区与现场证据，不注册成业务 MCP Tool。

前置依赖：P7-07 已形成稳定 Audit read model；本阶段以本地工作区权限代替新增远程运维授权面。该调整由 ADR-0017 记录，避免 `business Agent -> public MCP -> internal MySQL`。

验收 Gate：canonical structure、三平台 byte-identical sync/check、ZIP、secret masking、只读 SQL guard、缺失 env/DB unavailable/Audit not found、正常链路重建、真实 schema/governance/Audit 检查以及仓库既有门禁有实际证据。诊断不泄密、不改 MySQL/Salesforce、不伪造缺失字段、不推断 Agent 意图。

不做：业务/公共 MCP 诊断 Tool、可靠性分数、LLM Judge、自动修复/自动变更、普通用户天然运维权限、自由输入 SQL。

实施结果（2026-09-01）：`COMPLETE`（含 HOTFIX01 交付收口）。canonical Skill、Codex/Claude/CodeBuddy project copies、同步/漂移/打包脚本、Doctor、Snapshot、只读 DB Inspector 与 P7 Audit Analyzer 已实现。Analyzer 按真实 migration 008 使用 `publicAuditId`、`correlationId`、Event sequence 和 `publicApiCallId`；不存在的 trace/session/call/span 字段明确显示 unavailable。HOTFIX01 修复交付完整性缺陷：helper 模块由 `scripts/lib` 迁移到 `scripts/shared`（根 `.gitignore` 的裸 `lib` 规则曾静默排除 `lib/` 目录，导致本地测试通过但 `project.mjs`/`db.mjs` 未进入 commit）；新增 `skill:delivery` Git trackability Gate 与 `skill:smoke` clean-clone 冒烟验证，确保新 clone 始终携带完整 Skill 运行依赖。HOTFIX02 强化 clean-clone 证明：`skill:smoke` 改用 `git archive HEAD` 从 committed bytes 重建临时 checkout（而非复制 working tree），使 dirty working tree 无法冒充可复现 commit。完整命令、测试和验收分析见 `P7_08_REPORT.md`。

### P7-09 Lazy Salesforce Connection 与 Request Resource Lifecycle

目标：把 USER/DIAGNOSTIC Salesforce Connection 从 RequestScope eager initialization 改为 lazy、request-scoped、Promise-memoized resource，同时保持全部 MCP、Tool、身份、治理、DML、权限、Agent 与 Audit 业务语义不变。

实施内容：RequestScope 先完成平台认证、route、Control Plane snapshot、context、workspace directories、Services 与 MCP composition；第一次实际 Salesforce-dependent execution 才执行 JWT/`Connection.create`，并用真实 `getApiVersion()` 完成 workspace DX config。OrgService route-only 方法、official `get_username`、local infrastructure Tools 和非 Salesforce MCP methods 不取 Connection。相同 scope 并发调用共享一个 initialization Promise；不同请求及 USER/DIAGNOSTIC 永不共享。

验收 Gate：scope/local/protocol call count 为 0；SOQL/CREATE/UPDATE 第一次使用为 1 且同请求不重复；Diagnostic 为 USER 0、DIAGNOSTIC 1；lazy failure taxonomy/correlation/Audit、unused/failed/abort cleanup、两用户并发隔离、P3/P4/P5/P7/MySQL/Agent/Skill/live 回归有真实结果。Audit 不过滤或改写失败；local Salesforce row 为 0 只能来自没有实际调用。

不做：Tool-name skip、global Connection cache/pool、重复 `get_username`、Tool schema/Agent workflow、Salesforce 权限或 Admin UI 变更。

实施结果（2026-09-01）：`COMPLETE`。架构和证据见 ADR-0018 与 `P7_09_REPORT.md`。

HOTFIX01（2026-09-02）：`COMPLETE`。收口而非重设计——把远程 Tool 的 Connection 依赖从 `hostOwnedArguments.includes('usernameOrAlias')` 隐式推断改为 `RemoteToolContract.requiresSalesforceConnection` 显式布尔（`get_username=false`、`run_soql_query/retrieve_metadata=true`），由 upstream-drift guard 强制每个 `p2RemoteCompatible` Tool 必须声明、禁止默认猜测；DML lazy-auth 失败改走标准 DML 输出契约（`success=false`/`errorCode`/redacted `message`，Correlation ID 在 text）；Tool `durationMs` 固定为含 lazy auth/connection 的端到端时延（Option A）。Live 回归：P4 Diagnostic 真实 Salesforce PASS；P2/P3 因当前 mysql+BUNTU checkout 与 env-mode 校验器不兼容记为 NOT RE-RUN（记录型 factory HTTP 测试仍证明 READ 0/1 Connection 契约）。

## 6. P7-03 后续强制并发、故障与性能 Gate

### 6.1 Concurrent Audit Isolation Gate

覆盖多平台用户、多 Salesforce 用户、不同 Tool/SOQL/Object，以及 50 / 100 / 200 并发。必须同时满足：

```text
Cross User Audit Leak = 0
Cross Salesforce User Leak = 0
Cross SOQL Leak = 0
Cross API Leak = 0
Orphan Event = 0
Orphan API = 0
Cross Payload Leak = 0
Connection Cross-user Reuse = 0
```

### 6.2 Audit Failure Isolation Gate

模拟 Audit DB 慢/Down、Batch Insert Error、Queue Failure、Payload Failure。必须证明：

- Salesforce Read 正常；
- CREATE / UPDATE 正常；
- Tool Outcome 不变；
- 自动重试为 0；
- 不产生可感知审计等待。

### 6.3 Audit Performance Gate

相同负载比较 P7 On / Off：p50、p95、p99、throughput、CPU、memory。P7 不允许造成明显 P95 退化；具体数值阈值由 P7-03 在基准环境和 Maintainer review 中冻结，不能由开发 Agent自行美化。

## 7. P7-01 自动化测试要求

P7-01 至少覆盖：

1. migration 可执行；
2. 空数据库从 001 初始化到 P7；
3. 当前 P6 schema（001～004）升级到 P7；
4. 旧 `sfoa_audit_log` 数据仍可读取；
5. Audit Call 创建；
6. Event 创建；
7. Salesforce API Call 创建；
8. Payload Evidence 创建；
9. FK/CASCADE/RESTRICT 策略正确；
10. auditId 隔离正确；
11. Audit A 子记录不能关联 Audit B；
12. `auditId + sequence` 唯一与每 Audit 独立行为正确；
13. 大 Payload 不参与普通列表查询；
14. Sensitive Field Contract 阻止明显 secret 样本持久化；
15. Repository 异常不改变现有 Runtime Logger fail-open；
16. 历史 Admin Audit API/DTO 与 React Audit 页面继续可用。

同时运行 Control Plane、MCP Server、Admin API、Admin Web 及当前可执行 `validate:p5` 回归 Gate。任何缺少外部条件的 Gate 必须记录 `NOT TESTED` 或真实失败，不得推断 PASS。

## 8. 状态矩阵

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| P7-01 全链路审计数据模型 | COMPLETE | Maintainer 独立审查通过 |
| P7-02 请求级审计上下文 | COMPLETE | Maintainer 独立审查通过 |
| P7-03 请求级隔离与异步审计管道 | COMPLETE | Maintainer 已完成主体实现及 HOTFIX01 收口验证 |
| P7-04 Salesforce API 透明审计 | COMPLETE | Maintainer 独立审查通过 |
| P7-05 SOQL 与 DML 审计证据 | COMPLETE | Maintainer 独立审查通过 |
| P7-06 MCP 入口与响应审计 | COMPLETE | Maintainer 独立审查通过 |
| P7-07 审计调用链工作台 | IMPLEMENTED / AWAITING MAINTAINER FINAL REVIEW | Admin read model 与 React Workbench 已实现 |
| P7-08 Agent-Native Maintainer Skill 与诊断工具集 | COMPLETE | canonical Skill、本地只读诊断、三平台同步与打包已实现；HOTFIX01 修复 `scripts/lib` 被 `.gitignore` 排除的交付缺陷并新增 delivery/smoke Gate；不新增业务 MCP Tool |
| P7-09 Lazy Salesforce Connection 与 Request Lifecycle | COMPLETE | request-scoped Promise memoization；local/route-only/protocol Salesforce calls = 0；Salesforce/Diagnostic 按请求按角色首次使用创建一次；HOTFIX01 显式 `requiresSalesforceConnection` 契约 + DML lazy-error 契约 + duration Option A |

P7-08 工程 Gate 与 HOTFIX01 clean-clone Gate 全部通过后，P7-08 已按 Maintainer 授权更新为：

`P7-08 = COMPLETE`

P7-09 的核心 call-count、并发、失败、cleanup 与业务回归 Gate 通过后更新为：

`P7-09 = COMPLETE`

P7-08 的 COMPLETE 不代表整个 P7 已完成：P7-07 仍为 `IMPLEMENTED / AWAITING MAINTAINER FINAL REVIEW`，不得自行宣布整个 P7 COMPLETE。

## 9. 变更管理

- 已发布 migration 001～007 永不修改；P7-06 使用下一序号 `008_p7_payload_evidence_runtime.sql`；
- 任何本基线冲突必须在同一变更更新本文件、`PROJECT_BASELINE.md`、`TEST_MATRIX.md`、`CHANGELOG.md`，架构决策改变时新增或 supersede ADR；
- P7-01 不修改官方 Salesforce TypeScript；如不可避免，必须先更新 `UPSTREAM_STRATEGY.md` 修改矩阵并接受 Maintainer review；
- 所有真实 secret 继续只存在于 ignored local environment 或部署 secret store；测试只能使用明显虚构且必须被净化的样本。

# P7-07 审计调用链工作台（Audit Trace Workbench）实施报告

> 状态：IMPLEMENTED / AWAITING MAINTAINER REVIEW  
> 基线：P7-06 完成后的 `feature/p7-end-to-end-audit`

## 1. 本次目标

把旧的“审计列表 + 720px Drawer + JSON 摘要”升级为真正面向管理员排障的全链路工作台，并保持 P7-01～P7-06 已建立的运行时审计旁路不变。

## 2. 后端读取模型

新增 `GET /admin/api/audits/:id/trace`：

- 返回主审计；
- Event；
- Salesforce API；
- SOQL / DML 结构化字段；
- Payload **元数据**；
- 计数摘要；
- 确定性的第一失败节点。

不进行 LLM 根因推断。

新增 `GET /admin/api/audit-payloads/:id`：仅管理员真正点击 Payload 时读取正文。

`listPayloadEvidenceMetadata()` 明确不 SELECT `safe_payload`，避免打开一条 Audit 就从 MySQL 读取全部 256 KiB Payload 正文。

## 3. 审计搜索增强

新增可选筛选：

- Audit ID；
- Outcome；
- Object API Name；
- Record ID；
- Audit Kind；
- Audit Integrity Status。

普通列表仍只访问 `sfoa_audit_log` 主表，不 JOIN Event/API/Payload。

## 4. 前端工作台

### 左侧调用列表

- 紧凑调用卡片；
- 时间、Tool、结果、平台用户 → Salesforce 用户、耗时、错误码；
- 快速筛选：全部 / 失败 / 已阻止 / UNKNOWN；
- 高级筛选折叠；
- URL 保存筛选与 `selected`，刷新/前进后退不丢当前审计。

### 右侧调用详情

- 3 秒概览：Tool、Outcome、用户、对象、Record、耗时、API/SOQL/DML/Error 数量、审计完整性；
- PARTIAL / DEGRADED 显著告警；
- 第一失败节点 + 一键跳转；
- Event + Salesforce API 统一 sequence 时间线；
- Timeline 快速过滤：全部 / 错误 / API / SOQL / DML / MCP；
- Salesforce API 表格 + CSS 耗时条，不增加图表依赖；
- SOQL 专用卡片 + 一键复制；
- DML Requested / Managed / Submitted 三列字段对比；
- Payload 元数据卡片，正文点击后 lazy load；
- JSON 正文格式化、复制、截断提示。

ADMIN_ACTION / IDENTITY_VALIDATION / RUNTIME_EVENT 保持简洁详情，不强行套 MCP Tool 全链路。

## 5. UX / 性能约束

- 列表与详情独立 React Query；
- 普通 Audit List 不加载 Event/API/Payload；
- Trace Detail 不加载 Payload 正文；
- Payload 正文单条按需读取；
- Timeline 默认折叠复杂详情；
- 不引入 ECharts / virtualization 等新依赖；
- 中文标签优先；
- 1200px+ 左右分栏，较窄屏幕自动降级为上下布局。

## 6. 未改变的运行时边界

本阶段只修改 Admin Read Model / Admin Web：

- 不修改 MCP Tool；
- 不修改 Request Audit Collector；
- 不修改 Async Audit Queue / Writer；
- 不增加 Salesforce API；
- 不在 MCP 请求关键路径增加 DB await；
- 不修改 migration 005～008（如 P7-06 已到 008）。

## 7. 建议验证

```bash
yarn workspace @sfoa/control-plane lint
yarn workspace @sfoa/control-plane test
yarn workspace @sfoa/admin-api lint
yarn workspace @sfoa/admin-api test
yarn workspace @sfoa/admin-web test
yarn workspace @sfoa/admin-web build
```

建议再用真实审计数据手工验收：

1. 成功 CREATE：能够看到托管 Lookup SOQL → CREATE → Requested/Managed/Submitted → MCP Response；
2. Validation Failure：顶部第一失败节点直达 DML/API Error；
3. UNKNOWN：明确显示 UNKNOWN，不描述为失败；
4. Payload > 256 KiB：明确“已截断”；
5. PARTIAL：顶部显著提示证据不完整；
6. 打开 Trace Detail 时确认网络请求中不返回 `safePayload`，点击 Payload 后才出现正文请求。

## 8. 下一步

P7-07 通过 Maintainer Review 后进入 P7-08：智能诊断接口与 SFoA MCP 异常排查技能。

# Skill-02C 附件上传 — 真人 UAT 用例

Status: **READY FOR HUMAN ATTACHMENT UAT**。以下每个用例都是操作者在**真实 Salesforce org** 与**真实 Agent 客户端**（企微）上执行的验收步骤。自动化契约测试**不能**替代这些用例；没有真人执行记录的用例记为 **BLOCKED**，**不得**记为 PASS。

本清单**不**新增功能范围，也**不**放宽任何生产允许列表、Tool Governance 规则、request-scoped USER 身份或 Dynamic Forms 契约。

---

## 0. 前置准备

1. **确认部署版本**为 `feature/sfoa-attachment-upload` @ `59cb040`，且 4 个服务均为 `active`：
   `sfoa-mcp-server`、`sfoa-admin-api`、`openclaw-gateway`、`nginx`。
2. **确认迁移已应用**：`sfoa_dml_policy.attachment_enabled` 列存在且为 `NOT NULL DEFAULT FALSE`；`sfoa_attachment_staging` 表存在。
   **先确认既有对象全部仍是 `FALSE`** —— 这一条用来证明「升级后既有对象不会突然全部允许附件」。
3. **确认附件开关**：Runtime 侧 `MCP_ATTACHMENT_INGRESS_ENABLED=true`；OpenClaw Adapter 侧 `attachmentBridgeEnabled=true`。**两侧需同时开启**，只开一边不产生可用能力。
4. **在 Admin Web「DML 策略」页为目标对象开启「附件上传」开关**，并确认 CREATE/UPDATE 开关的状态符合该用例需要。UAT-03 需要一个**未开启**该开关的对象。
5. **准备两个真实平台用户**（UAT-04 需要）：两个用户都要在 `sfoa_identity_route` 中有有效身份路由，且都能在企微中与机器人对话。记录两者的 platform user id 别名（**不入库明文**）。
6. **选一个可安全测试的业务对象与记录**，例如 `Account_Visit__c`。**不要**为 UAT 放宽生产允许列表。
7. **准备企微测试会话**，确认当前 `tools/list` 已广告 `upload_files_to_record`。
8. **确认暂存根为空**：`/data/sfoa-enterprise-mcp/attachment-staging/staged/` 应为 0 个文件。

---

## 1. 用例与期望证据

| # | 用例 | 检查 | 需记录的证据 |
| --- | --- | --- | --- |
| **UAT-01** | **单文件正常路径** | 在企微发 1 个文件 + 「把这个文件加到 `Visit-004209`（`a0fC5000000n9RxIAI`）上」。确认：Agent 未读取文件内容即可上传；Tool 返回聚合 `SUCCESS`、`succeeded=1`、逐文件 1 条 `SUCCESS`；记录 Lightning 页面的 **Files 相关列表出现该文件**；Audit 含真实的 `ContentVersionId` 与 `ContentDocumentId`。**同时确认该记录上出现两条 link**（业务记录 `ShareType=V` + 创建者 `ShareType=I`）—— 这是 SFoA 的真实行为，不是缺陷。 | 提示词原文、Tool 入参（三个字段）、Tool 返回全文、`publicAuditId`、`ContentVersionId`、`ContentDocumentId`、记录 Files 列表截图（私密证据）、`staging/` 目录已归空的检查结果 |
| **UAT-02** | **多文件单记录** | 一次发 **3 个**文件 + 「都加到 `Visit-004209` 上」。确认聚合 `SUCCESS`、`succeeded=3`、逐文件 3 条 `SUCCESS`，且记录上出现 3 个文件。确认 Agent 是**一次** `upload_files_to_record` 调用带 3 个 ref，而不是 3 次单独调用。 | Tool 入参（`attachmentRefs` 数组长度 3）、3 条逐文件结果、记录上 3 个文件、Audit 中 3 组 `ContentVersionId`/`ContentDocumentId` |
| **UAT-03** | **对象未开启 `attachmentEnabled`** | 对一个**未开启**「附件上传」的对象执行同样请求。确认返回 `MCP_ATTACHMENT_OBJECT_NOT_ALLOWED`，**且 Salesforce 侧 0 文件创建**（用独立查询确认该对象上没有新增 `ContentDocumentLink`）。确认**不需要**为此时先解析 ref（策略闸门先于 ref 解析）。 | 请求、错误码全文、Salesforce 侧 `ContentDocumentLink` 计数前后对比、Audit 行 |
| **UAT-04** | **跨用户引用复用** | 用户 A 正常暂存得到一个 `att_…` 引用（**不要**消费它）。让用户 B 在同一会话/同一 Agent 上提交该引用。确认返回 **`MCP_ATTACHMENT_NOT_OWNED`**；用一个**完全不存在的**假 ref 重试，确认返回**同一个**错误码。确认错误文本中**不泄露**文件存在性、文件路径、文件名或用户 A 的任何标识；确认 Salesforce 侧 0 文件创建。 | 用户 A 的 ref 别名（脱敏）、用户 B 的请求、两个错误码对比（必须相同）、错误文本逐字、Salesforce 侧 0 新增、Audit 中两条记录 |
| **UAT-05** | **过期引用** | 用户正常暂存得到一个 ref，**等待超过 TTL**（默认 900 s）后提交上传。确认返回 `MCP_ATTACHMENT_EXPIRED`；确认该文件已被 reaper 清理（`staging/` 中不存在）；确认 Salesforce 侧 0 文件创建。**另外确认**：TTL 是基础设施生命周期，**不是**任何 Salesforce 文件策略 —— 已成功发布到 Salesforce 的文件**不因 TTL 到期而被删除**。 | 暂存时间、提交时间、错误码、`staging/` 目录状态、之前成功上传的 Salesforce 文件仍存在的证据 |
| **UAT-06** | **先 CREATE 后上传 + 拒绝传播** | 同一轮内：(a) 先让 Agent 创建一条新记录，确认 CREATE 返回 `SUCCESS` 后**才**上传附件到该新记录。确认 Agent **不会**在 CREATE 结果未知时上传（若模型声称已创建，要求它给出真实的 `recordId` 证据）。(b) **若** Salesforce 因类型或大小拒绝了某个文件（**自然发生时才核验，不要刻意构造超大文件**），确认 Salesforce 的真实 `errorCode` 与 `message` **原样**出现在 MCP Audit 与 Agent 回复中，且**记录创建本身仍报 `SUCCESS`**（附件 FAILED 不等于记录创建失败）。 | 提示词、CREATE 结果与 `recordId`、上传结果、若发生拒绝则记录原始 `salesforceErrorCode`/`salesforceMessage` 与 Audit 中的对应行、Agent 最终回复 |

---

## 2. 每个用例都要记录与诊断

对每个用例记录（**脱敏**）：用例别名、用户/Profile 别名、对象别名、记录别名、`publicAuditId`、Tool 入参、Tool 返回、真实时间戳、以及 Agent 的实际追问与回答。

用 `yarn ai:audit --trace <publicAuditId>` 跟踪审计链。

**审计卫生必须逐用例复核**（§五十五）：确认 Audit 中**不存在** file bytes、base64、raw multipart body、Bearer token、暂存区绝对路径、文件内容。发现任一即该用例 **FAIL**。

私密标识、截图与业务数据留在受控私密证据里；只发布脱敏后的计数与别名。

---

## 3. 判定规则

- 用例**只在**有观测证据时记为 PASS；当前环境无法执行的一律记为 **BLOCKED** 并写明阻塞原因。
- **不得**从「上下文解析成功」推断 DML 已提交。
- **不得**自动重试 unknown 写入。
- **不得自动删除用户刚刚成功测试的 Salesforce File。** UAT 产生的文件按用户指示保留；需要清理时由操作者显式决定。
- 若某个文件被 Salesforce 拒绝，这是**真实证据**而不是失败：把它记下来，它证明了「Salesforce 是文件接受的最终裁决者」这一设计前提。

---

## 4. 带入 UAT 的已知限制

1. **`OUTCOME_UNKNOWN` 与 `PARTIAL_SUCCESS` 未在真实链路上复现过。** 机器门禁通过决策模型验证语义；真实故障注入属 UAT 范围。UAT 中若自然出现，请完整记录。
2. **`FirstPublishLocationId` 为「格式合法但不存在」时，Salesforce 返回 HTTP 201 并创建一个未链接的文件。** 因此 HTTP 201 本身**不证明**文件挂到了哪个记录；UNKNOWN 必须走对账路径。这不是缺陷，是 SFoA 行为差异。
3. **v1 只支持单记录 × 1..N 文件**（`MAX_ATTACHMENTS_PER_CALL = 10`）。**不支持**：既有文件 relink、版本更新、删除、下载、公开链接。
4. **文件接受规则完全由 Salesforce / SFoA 决定。** SFoA 侧**没有**扩展名 allowlist、**没有** MIME allowlist、**没有** Salesforce 大小上限镜像。任何「SFoA 应该接受什么文件」的疑问都必须以 Salesforce 的真实响应为准。
5. **`Attachment Bridge` 的部署面是两侧开关。** 只开 Runtime 侧或只开 Adapter 侧都不会产生可用能力；UAT 前请按 §0.3 两侧都确认。
6. **`yarn skill:runtime:check` 必须在服务器上运行**；在 Windows 检出上运行会解析出错误路径并报假的 missing Runtime Copy。

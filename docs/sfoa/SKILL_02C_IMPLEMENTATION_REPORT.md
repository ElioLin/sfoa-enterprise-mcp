# Skill-02C 实施报告 — SFOA Attachment Upload Capability

> 状态：**SKILL-02C IMPLEMENTATION COMPLETE / READY FOR HUMAN ATTACHMENT UAT**
>
> 本文只记录**已用真实代码、真实门禁与真实 Salesforce API 验证过**的事实。凡属推断、未执行或未验证的内容，均显式标注。

---

## 0. 结论摘要

| 项 | 结果 |
| --- | --- |
| Probe Verification Gate | **PASS** — 6/6，真实 API evidence，无 blocking SFOA difference |
| 新业务 Tool | `upload_files_to_record`（唯一新增，复数形式） |
| 新业务 Skill | **无** — 扩展 `skills/sfoa-record-change/`，新增 `references/file-attachments.md` |
| Official WeCom Plugin 是否修改 | **NO**（见 §10） |
| 文件接受策略是否镜像到 SFoA | **NO ×3**（无扩展名/MIME/大小 allowlist，见 §7） |
| 是否把 Files 对象暴露给 Generic DML | **NO** |
| Identity 模型 | **requester-scoped Salesforce user = YES**（非固定集成账号） |
| 实施过程中发现并修复的真实缺陷 | **1 个**：成功上传会静默丢失整条 P7 Audit snapshot（见 §9） |
| 机器门禁 | 全部 PASS（见 §8） |
| 回归 | Skill-01 / Skill-02 CREATE・UPDATE・Batch・Outcome 全 PASS |
| 测试服部署 | 已完成（`59cb040`），生产未触碰 |
| Git | 分支 `feature/sfoa-attachment-upload` 已 push（`origin` = `ed887c1`）；**未**合入 `main` |

---

## 1. Probe Verification Gate（§二–§五）

正式开发前的强制关卡。**只有真实 API evidence 才算 PASS。**

| Gate | 判定 | 依据 |
| --- | --- | --- |
| REAL API TEST | **YES** | 对真实 SFoA org 发起真实 REST 调用；脚本 `scripts/sfoa-attachment-capability-probe.mjs`，sha256 `6558c99d…62aaac`（两次运行同一 sha256，脚本未在两次之间被修改，因此结论归因于「补上了目标记录」而非「换了仪器」） |
| CONTENT_VERSION_CREATE | **PASS** | `POST /services/data/v<ver>/sobjects/ContentVersion` multipart 二进制上传 → HTTP 201，`ContentVersion` `068C5000000yCkfIAE` |
| FIRST_PUBLISH_LOCATION_ID | **PASS** | `FirstPublishLocationId=<业务记录>` 被接受，`ContentDocument` `069C5000000wTw5IAE` 自动创建（`ContentDocument` 本身 `createable=false`，只能由 Salesforce 自动生成） |
| BUSINESS_RECORD_LINK | **PASS** | `ContentDocumentLink` `06AC50000019k7uMAA` → `LinkedEntityId=a0fC5000000n9RxIAI`，`ShareType=V`、`Visibility=AllUsers`；反向查询 `ContentDocumentLink WHERE LinkedEntityId='a0fC5000000n9RxIAI'` 返回该行，即业务记录自身能看见该文件 |
| AUTH | **current project Salesforce identity** | 身份路由 `08548` → 真实 Salesforce 用户 `005C8000003yL1eIAE`；未使用固定集成账号、未使用 admin token、未使用 system user |
| NO BLOCKING SFOA DIFFERENCE | **PASS** | 全部差异已记录并已转化为设计约束（见 §7、§11），无一项阻塞实现 |

运行判定：**`PASS` — 18 gates, 0 FAIL, 0 BLOCKED**。

| 项 | 值 |
| --- | --- |
| 目标记录 | `a0fC5000000n9RxIAI` — `Account_Visit__c`，`Name = Visit-004209` |
| 目标由谁指定 | **操作者**（本次为该记录的属主），probe 从不自行即兴选目标 |
| 原始 evidence | `docs/sfoa/evidence/sfoa-attachment-probe-target-2026-09-15.json` |
| 前后状态 | `docs/sfoa/evidence/sfoa-attachment-probe-target-state-2026-09-15.json` |
| 完整 probe 记录 | `docs/sfoa/SFOA_ATTACHMENT_CAPABILITY_PROBE.md`（§18 为关卡收口轮） |

**Gate 结论**：`FEASIBILITY: FEASIBLE`（原为 `FEASIBLE WITH LIMITATIONS`）→ `READY FOR ATTACHMENT TOOL DESIGN`。
**未出现** `ATTACHMENT IMPLEMENTATION BLOCKED`，因此正式开发按 §六 起推进。

### 1.1 Probe 找到的两条必须踩住的 SFOA 事实

1. **`FirstPublishLocationId` 会创建两条 link，不是一条。** 除了到业务记录的 `ShareType=V`，还会有一条到创建者的 `ShareType=I` 自链（§8 默认行为，不被 `FirstPublishLocationId` 抑制）。设计后果：**Agent 永不需要操作 `ContentDocumentLink`** —— 上传调用本身已经交付了链接能力。这是 §十四「不把 `ContentDocumentLink` 暴露给 Generic DML」的独立佐证。
2. **HTTP 201 本身不证明文件挂到了哪个记录。** 格式合法但不存在的 `FirstPublishLocationId` 会返回 **HTTP 201 并照样创建一个未链接的文件**（该文件由同一次运行跟踪并清除）。格式非法则返回 HTTP 400 `MALFORMED_ID` + 0 副作用。因此 §九 的 UNKNOWN 对账路径是**必需**的，不能被 201 代替。

### 1.2 Probe 阶段的清理与「记录保持原样」

| 检查 | 前 | 后 |
| --- | --- | --- |
| 目标记录字段（`Id`/`Name`/`LastModifiedDate`/`LastModifiedById`） | baseline | **逐字节一致**（`LastModifiedDate` 仍为 `2026-09-14T09:35:01.000+0000`） |
| 目标上的 `ContentDocumentLink` 行数 | 0 | **0** |
| `ContentVersion` 残留（`Title LIKE 'SFOA%Probe%'`） | 0 | **0** |

前后状态由**独立的只读前后检查**确认，不是 probe 的自述。清理删除了 2 个 `ContentDocument` 根（各 HTTP 204），级联使 `contentVersionRemaining` / `contentDocumentLinkRemaining` / `contentDocumentRemaining` 归 0/0/0。业务记录本身从未被修改、从未被删除。

---

## 2. Git

| 项 | 值 |
| --- | --- |
| Base branch | `main` |
| Base SHA | `3adae7b6abcdf53d12d2878aa4f79d055bebf2a1`（`docs(sfoa): state that main and the test server share one commit`） |
| 分支点 | Skill-02B tip `feature/openclaw-sfoa-record-change-02b` @ `ce800c20fc59a77f11778728073c1af2bf2cefa1`（本地 = `origin`，已 push） |
| 02C branch | `feature/sfoa-attachment-upload` |
| 功能 Final SHA | **`59cb040cb01c3ff8fcf7d08a2c81c64a9afcee43`**（功能实施 + Audit 缺陷修复的最后一个代码提交） |
| 分支 tip | 承载**本报告**的文档提交（`59cb040` 之上仅有纯文档提交：本报告、UAT 清单、部署记录及其 SHA 说明；无任何代码改动）。不在此处钉死具体 SHA，理由同 `ce800c2`：钉死的 tip SHA 会被下一次文档提交立即作废 |
| Push 状态 | **已 push 到 `origin`**（`2026-09-16`）。推送后分支 tip 与本地一致（`git ls-remote --heads origin` 可核）；**不在此处钉死 tip SHA**，理由同上。**未**合入 `main` |

### 2.1 Base 判定依据（§一「不要假定历史 Prompt 中的 commit 仍然最新」）

`git fetch --all --prune` 后：

- `main` = `origin/main` = `origin` = `3adae7b`。
- `3adae7b..ce800c2` 有 6 个提交（`2b6c91d` → `5626163` → `4b3b2ff` → `9f3167f` → `a00017f` → `ce800c2`），即 Skill-02B 的完整交付链，其 tip 已推送到 `origin/feature/openclaw-sfoa-record-change-02b`。
- **02B 对运行时代码的改动 = 0**：`git diff 3adae7b..ce800c2 -- packages yarn.lock .env.example config integrations` 输出为空；02B 只动了 `skills/`、三处生成副本与 `docs/sfoa/`。
- 因此从 `main` 到 `59cb040` 的**运行时代码差异全部来自 02C**，02B 不引入任何需要重启服务的变更。

用户选定「**基于 02B tip + cherry-pick probe**」，故分支构成为：

```text
ce800c2 (02B tip, = origin)
  ├─ e711a90  feat(probe): add the SFoA attachment capability probe      ← cherry-pick of 3f323a1
  ├─ ad619d9  docs(sfoa): record the attachment capability probe result   ← cherry-pick of 6f6d8aa
  ├─ c0f0bfa  docs(sfoa): close the attachment probe gate …               ← cherry-pick of 66a86c7
  ├─ e685ba8  feat(skill): add the Skill-02C attachment upload capability (71 files)
  └─ 59cb040  fix(audit): keep a successful attachment upload's Audit snapshot persistable (3 files)
```

三个 probe 提交是**逐字节 cherry-pick**，用 `git patch-id --stable` 核对：

| 02C 分支提交 | patch-id | 原提交（probe 分支） | patch-id | 一致 |
| --- | --- | --- | --- | --- |
| `e711a90` | `d3d2b5fe6765` | `3f323a1` | `d3d2b5fe6765` | ✔ |
| `ad619d9` | `9953e1b0a0a9` | `6f6d8aa` | `9953e1b0a0a9` | ✔ |
| `c0f0bfa` | `9508546099e3` | `66a86c7` | `9508546099e3` | ✔ |

### 2.2 `feature/sfoa-attachment-capability-probe` 的分支状态（已核实，非分叉；已推送）

推送前核实：本地 `66a86c7`，`origin` `6f6d8aa`，`git log 本地..origin/…` 为**空** —— 即本地**严格领先 origin 一个提交**，是普通 fast-forward，**不是分叉**，不存在需要 reconcile 的冲突历史。该提交的内容已通过上述 cherry-pick 进入 02C 分支。

```text
git push origin feature/sfoa-attachment-capability-probe
  6f6d8aa..66a86c7  feature/sfoa-attachment-capability-probe -> (fast-forward)
```

现 `origin/feature/sfoa-attachment-capability-probe` = `66a86c7`。

---

## 3. 变更文件清单（按区域）

范围 `ce800c2..59cb040`（02C 自身贡献），共 **76 个文件**，其中 9 个是 `yarn skill:sync` 生成的平台副本。

| 区域 | 文件数 | 内容 |
| --- | --- | --- |
| `packages/sfoa-mcp-server` | 24 | 附件能力主体：`attachment-upload.ts`（Salesforce 调用与逐文件结果）、`attachment-ingress.ts` + `attachment-ingress-route.ts`（入站端点与属主解析）、`attachment-multipart.ts`（流式 multipart）、`attachment-policy.ts`（策略闸门）、`attachment-tool.ts` / `attachment-tool-facade.ts` / `attachment-tool-governance.ts`（Tool 契约、执行门面、治理）、`config.ts`（六个 `MCP_ATTACHMENT_*` 项）、`provider-runtime.ts` / `discovery-server.ts`（宿主原生 Tool 注入两处清单）、`agent-guidance.ts`、`errors.ts`、`index.ts`、`http-server.ts`、`runtime.ts`、`policy-snapshot.ts` 及 4 个测试文件 |
| `packages/sfoa-control-plane` | 13 | `migrations/014_skill02c_attachment_upload.sql`（`attachment_enabled` + `sfoa_attachment_staging`）、`mysql-audit-batch-sink.ts`（纯校验器提取，§9）、`mysql-repositories.ts`（staging 仓储）、`repositories.ts` / `schema.ts` / `contracts.ts` / `admin-contracts.ts` / `admin-service.ts` / `bootstrap.ts` / `migrations.ts` 及 4 个测试文件 |
| `docs` | 7 | 本报告、Probe 报告、ADR-0023、两份 probe evidence JSON、`PROJECT_BASELINE.md`、`CHANGELOG.md`、`TEST_SERVER_DEPLOYMENT.md` |
| `integrations/openclaw` | 6 | 入站桥接：`src/attachments.js`、`src/index.js`、`openclaw.plugin.json` 及 3 个测试文件 |
| `packages/sfoa-agent-playbook` | 5 | `capabilities.ts` / `definition.ts` / `renderer.ts` / `version.ts` + 测试 —— `attachmentEnabledObjects` 能力事实 |
| `packages/sfoa-admin-web` | 5 | `DmlPoliciesPage.tsx`（既有策略页新增「附件上传」列与开关）+ 4 个测试 |
| `packages/sfoa-admin-api` | 2 | `tool-catalog.ts`（Tool 登记）+ 测试 |
| `packages/sfoa-identity-runtime` | 1 | `request-audit-collector.ts`（附件调用所需的 api-call 记录形状） |
| `skills/sfoa-record-change` | 2 | `SKILL.md`（仅一行极短激活语）+ 新增 `references/file-attachments.md` |
| `scripts` | 1 | `sfoa-attachment-capability-probe.mjs`（probe 仪器，随 cherry-pick 进入） |
| `CHANGELOG.md` | 1 | 根 changelog |
| `.claude` / `.agents` / `.codebuddy` | 9 | `yarn skill:sync` 生成的平台副本（**非手写**） |

**`skills/sfoa-crm-core/` 与 `skills/sfoa-mcp-maintainer/` 的业务内容未变**，只随生成副本同步。

---

## 4. `upload_files_to_record` 完整契约

Tool 名：`upload_files_to_record`（**只有复数形式**，不存在单数变体）。
唯一实现入口：`AttachmentToolFacade`（`attachment-tool-facade.ts`）；`attachment-tool.ts` 中的 Tool 对象只承载名字/schema/release state，其 `exec()` 故意抛出 `MCP_TOOL_NOT_AVAILABLE`，不是执行路径。

### 4.1 输入 schema（逐字来自 `packages/sfoa-mcp-server/src/attachment-tool.ts`）

```ts
export const MAX_ATTACHMENTS_PER_CALL = 10;

const attachmentRefSchema = z.string().trim().regex(
  /^att_[A-Za-z0-9_-]{24}$/u,
  'must be an attachment reference returned by the SFoA Attachment Ingress',
);

export const uploadFilesInputSchema = z.object({
  objectApiName: z.string().trim().min(1).max(128)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/u, 'must be a Salesforce object API name without a relationship path')
    .describe('API name of the object that owns the target record, for example Opportunity.'),
  recordId: z.string().trim().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u, 'must be a 15- or 18-character Salesforce record id')
    .describe('Id of the existing record the files are attached to. The record must already exist.'),
  attachmentRefs: z.array(attachmentRefSchema).min(1).max(MAX_ATTACHMENTS_PER_CALL)
    .describe('Opaque references from the inbound channel, in the order they should be attached. Never invent one.'),
}).strict();
```

**只有三个属性。** 刻意**不存在**：

| 不存在的字段 | 关闭的失败模式 |
| --- | --- |
| `content` / `base64` / `versionData` | 文件字节永不经过 LLM 上下文 |
| `path` / `filePath` / `localPath` | 任意文件读取（Agent 无法指定路径） |
| `sourceUrl` / `url` | SSRF（Runtime 永不代替调用方去取 URL） |
| `fileName` / `mimeType` | 调用方无法伪造文件身份；文件名与类型由 ingress 从真实入站事实派生 |
| `allowedExtensions` / `maxFileSize` 等 | 不建立 Salesforce 接受规则的镜像（§7） |

`.strict()` 使未知字段成为硬错误，而不是被静默忽略。

### 4.2 输出 schema

```ts
success, status, objectApiName, recordId,
totalCount, succeeded, failed, unknown, notAttempted,
errorCode, message,
results[]: { index, attachmentRef, fileName, status,
             contentVersionId, contentDocumentId, httpStatus,
             errorCode, salesforceErrorCode, salesforceMessage, durationMs }
```

`status`（聚合）∈ `SUCCESS | PARTIAL_SUCCESS | FAILED | OUTCOME_UNKNOWN`
`results[].status`（逐文件）∈ `SUCCESS | FAILED | OUTCOME_UNKNOWN | NOT_ATTEMPTED`

### 4.3 Tool description（模型可见文本，逐字）

```text
Attach one or more files to one existing Salesforce record. Files arrive from the
conversation channel as opaque attachmentRef values; pass them through unchanged and
never invent one. The object must be configured for attachment upload in SFoA
governance, and the target record must already exist — create the record first and only
upload once the create is known to have succeeded. This tool reports one result per
file, so a partial upload is reported as PARTIAL_SUCCESS rather than as a clean success
or a clean failure. If a file comes back OUTCOME_UNKNOWN the runtime stops and reports
the remaining files as NOT_ATTEMPTED; do not replay them, because Salesforce may already
have published the file.
```

### 4.4 `isError` 契约（与 P8-07 一致）

| 聚合结果 | `isError` | 理由 |
| --- | --- | --- |
| `SUCCESS` | `false` | — |
| `PARTIAL_SUCCESS` | **`false`** | 执行已完成，业务结果不完整；与 `create_records`/`update_records` 同一契约 |
| `FAILED` | `true` | — |
| `OUTCOME_UNKNOWN` | **`true`** | 执行**未完成**，与批量 DML 的未知批结果同构 |

---

## 5. 策略闸门顺序（§二十九）

```text
1. resolve identity        （requester-scoped Salesforce 身份；失败 → 身份类错误）
2. resolve target          （recordId 必须属于 objectApiName；Salesforce 侧读取校验）
3. attachmentEnabled       （目标对象策略；关闭 → MCP_ATTACHMENT_OBJECT_NOT_ALLOWED）
4. resolve attachmentRef   （ingress 中按 ref 查找；未知 → 与「非属主」同一错误码）
5. validate ownership / lifetime（属主 + 未过期；失败 → MCP_ATTACHMENT_NOT_OWNED / MCP_ATTACHMENT_EXPIRED）
6. Salesforce upload       （POST ContentVersion，multipart 流式）
```

顺序是契约的一部分：**身份先于一切**，**对象策略先于 ref 解析**，**Salesforce 上传永远最后**。
闸门 1–5 任一失败都不会产生任何 Salesforce 侧副作用。

`recordId` 与 `objectApiName` 的一致性由 Salesforce 侧真实读取校验（`ATTACHMENT_TARGET_VALIDATION`），不是本地格式猜测。

---

## 6. 错误码（沿用本项目既有命名风格）

| 错误码 | 触发 |
| --- | --- |
| `MCP_ATTACHMENT_INPUT_INVALID` | 入参不满足 schema |
| `MCP_ATTACHMENT_OBJECT_NOT_ALLOWED` | 目标对象未开启 `attachment_enabled` |
| `MCP_ATTACHMENT_TARGET_INVALID` | `recordId` 不属于 `objectApiName`，或记录不可见 |
| `MCP_ATTACHMENT_NOT_OWNED` | ref 属于其他请求者（**与「ref 不存在」返回同一码**） |
| `MCP_ATTACHMENT_EXPIRED` | ref 已过 `expiresAt`，或状态不再是 `STAGED` |
| `MCP_ATTACHMENT_TOO_LARGE` | 超过运行时暂存上限（基础设施上限，非 Salesforce 规则） |
| `MCP_ATTACHMENT_STAGING_FAILED` | 入站写入受控暂存区失败 |
| `MCP_ATTACHMENT_PATH_INVALID` | 暂存路径逃逸出受控根 |
| `MCP_ATTACHMENT_UPLOAD_FAILED` | Salesforce 明确拒绝（保留其 `errorCode`/`message`） |
| `MCP_ATTACHMENT_OUTCOME_UNKNOWN` | 无法确定 Salesforce 是否已创建文件 |
| `MCP_ATTACHMENT_INGRESS_DISABLED` | 入站端点未启用 |
| `MCP_ATTACHMENT_CONFIGURATION_INVALID` | 运行时附件配置非法 |

**「ref 不存在」与「ref 属于别人」返回同一个 `MCP_ATTACHMENT_NOT_OWNED`** —— ingress 刻意不做存在性预言机（§二十六）。

---

## 7. File Policy：三个 NO（§十二–§二十）

| 问题 | 答案 |
| --- | --- |
| 是否新增 `allowedExtensions` 数据库字段/UI？ | **NO** |
| 是否新增 `allowedMimeTypes` 数据库字段/UI？ | **NO** |
| 是否新增 `salesforceMaxFileSize` 数据库字段/UI？ | **NO** |

**Salesforce / SFoA 是文件接受的最终裁决者。** SFoA 侧只保留**基础设施**边界，且写在 `config.ts` 的注释里明确它**不是**文件接受策略：

```ts
export const DEFAULT_ATTACHMENT_TTL_MS = 900_000;              // 15 分钟
export const DEFAULT_ATTACHMENT_MAX_FILE_BYTES = 26_214_400;   // 25 MiB
export const DEFAULT_ATTACHMENT_MAX_FILES_PER_OWNER = 50;
export const DEFAULT_ATTACHMENT_REAP_INTERVAL_MS = 300_000;
```

`MCP_ATTACHMENT_MAX_FILE_BYTES` 是**暂存区资源保护**（防止无界磁盘/内存占用），不是「Salesforce 会不会收」的判断；它的文档注释明确写了「deliberately no extension list, no MIME allowlist and no Salesforce-size mirror here」。

### 7.1 Files 对象是内部技术对象，永不是 Generic DML 业务对象

`ContentVersion` / `ContentDocument` / `ContentDocumentLink` **不在** `create_record` / `create_records` / `update_record` / `update_records` 的可操作对象列表中，且**不以任何形式**出现在 Admin Web 的 DML 策略业务对象列表中。

理由（同时由 probe 证实）：`ContentDocument.createable=false`，它只能由 Salesforce 在上传时自动创建；`ContentDocumentLink` 的链接能力已由 `FirstPublishLocationId` 交付（§1.1），暴露它只会增加风险而不增加能力。

### 7.2 `attachmentEnabled` 是独立能力，且默认关闭

`packages/sfoa-control-plane/migrations/014_skill02c_attachment_upload.sql`：

```sql
ALTER TABLE sfoa_dml_policy
  ADD COLUMN attachment_enabled BOOLEAN NOT NULL DEFAULT FALSE AFTER allow_update;
```

- **`DEFAULT FALSE` 是刻意的**：所有已存在的对象升级后**保持今天的行为完全不变**，操作者必须显式把一个对象 opt-in 到附件能力。
- **不与 `allow_create` / `allow_update` 派生**：一个对象完全可以允许「在既有记录上加附件」而不允许任何字段更新。Admin Web 的校验器**只**在 `enabled=true` 且 `allowCreate` / `allowUpdate` / `attachmentEnabled` **全为 false** 时才报错，即三者是并列的独立能力。

Admin Web 在同一张既有策略表上新增「附件上传」列与开关（`DmlPoliciesPage.tsx`），沿用既有 UI 风格，**没有**新建独立模块，也**没有**新建独立的 Attachment Policy API —— 扩展的是既有 Admin API DTO。

---

## 8. Machine Gate

### 8.1 附件能力门禁

```text
命令：node --test packages/sfoa-mcp-server/dist/test/attachment-upload.test.js
退出码：0
结果：tests 42 / pass 42 / fail 0
```

| Gate | 覆盖项 | 结果 |
| --- | --- | --- |
| `gate: policy` | 未开启 `attachmentEnabled` 的对象被拒；开启后放行；`recordId`/`objectApiName` 不一致被拒 | PASS |
| `gate: identity` | 上传使用 requester-scoped 身份；未提供请求者身份时拒绝；身份解析失败不落到其他身份 | PASS |
| `gate: security` | 路径穿越（`../`、绝对路径、`file://`、`http(s)://`、localhost、云元数据地址）全部在 ingress 解析阶段被拒；ref 形如 `att_…` 且不可猜测 | PASS |
| `gate: salesforce` | 全部走 mock/fixture，**机器测试中没有任何真实 Salesforce 文件**；验证 multipart 形状、端点、`FirstPublishLocationId` 语义 | PASS |
| `gate: multiple files` | 四种聚合情形：全成功→`SUCCESS`；部分成功→`PARTIAL_SUCCESS`；明确失败→`FAILED`；首个 UNKNOWN→停止且其余 `NOT_ATTEMPTED`，聚合 `OUTCOME_UNKNOWN` | PASS |
| `gate: audit` | 上传记录的 Salesforce api-call 满足 P7 sink 的 snapshot 契约（见 §9） | PASS |
| `gate: skill` | `file-attachments.md` 的 doctrine 断言 | PASS |

### 8.2 仓库级回归

```text
packages/sfoa-mcp-server          node --test dist/**   → 203 / pass 203 / fail 0   EXIT=0
packages/sfoa-control-plane       unit                  →  38 / pass  38 / fail 0   EXIT=0
yarn test:p3 （Skill-01）                                →  25 / pass  25 / fail 0   EXIT=0
yarn test:p4 （Dynamic Forms）                           →   8 / pass   8 / fail 0   EXIT=0
yarn test:p5 （Identity / 策略）                          →   6 / pass   6 / fail 0   EXIT=0
yarn test:p7 （Audit）                                   →   6 / pass   6 / fail 0   EXIT=0
```

| 回归面 | 结果 |
| --- | --- |
| Skill-01（`sfoa-crm-core`） | **PASS** |
| Skill-02 CREATE | **PASS** |
| Skill-02 UPDATE | **PASS** |
| Skill-02 Batch | **PASS** |
| Skill-02 Outcome（含 `PARTIAL_SUCCESS` / `OUTCOME_UNKNOWN`） | **PASS** |
| Dynamic Forms / Identity / Audit | **PASS** |

### 8.3 Skill 门禁

```text
yarn skill:validate    → ok:true ×3
yarn skill:check       → ok:true ×3, drift: []
yarn skill:runtime:check --runtime-root /data/openclaw/workspace/skills
                       → 两个业务 Skill 均 ok:true, drift: []
yarn skill:test        → toolkit.test.mjs 全通过
```

### 8.4 门禁真实性的红/绿证明（§9 缺陷）

修复后新增的 `gate: audit` 测试**被证明是真实门禁**，而不是永远通过的空断言：临时把 `operationName: 'ContentVersion.create'` 放回生产者后，该测试**失败**（`ℹ pass 0 / ℹ fail 1`，AssertionError）；还原后恢复 42/42。

### 8.5 诚实记录：三次环境噪声（均非交付缺陷）

1. **`test:p5` 出现过一次 5/6**，未能复现；随后两次运行均为 6/6。该次失败的具体断言未被捕获到，因此**本报告不主张它是环境噪声**，只如实记录：一次不可复现的 5/6 与两次 6/6 并存。
2. **`packages/sfoa-admin-web` 的 `GovernancePages.test.tsx` 在与其它包并发时 60 s 超时**；单独运行时 14/14 通过。判定为资源竞争，非逻辑失败。
3. **`test:p7` 曾出现一次「挂起」**，单独运行时 6/6 通过；判定为并发竞争。

以上三项都属执行环境噪声，但**第 1 项的证据不足以排除真实缺陷**，已列为 §13 Known Limitations。

---

## 9. 实施中发现并修复的真实缺陷（`59cb040`）

### 9.1 症状

**每一次*成功*的 `upload_files_to_record` 调用，都在把文件发布到 Salesforce 之后，丢掉整条 P7 Audit snapshot。**

具体地：`sfoa_audit_log` 无主行、无 `TOOL_TERMINAL` 事件、`sfoa_salesforce_api_call` 无行 —— 因此**刚刚创建的 `ContentVersionId` 没有任何记录**。服务日志里唯一的痕迹是 `MCP_AUDIT_WRITER_FAILED` + `MCP_AUDIT_SNAPSHOT_REJECTED`。

失败调用反而审计正常，因为它们根本没走到 Salesforce，也就从未记录 api call。

### 9.2 根因

`packages/sfoa-mcp-server/src/attachment-upload.ts` 的 `recordApiCall` 同时设置了：

```ts
visibility: 'EXACT_HTTP',
operationName: 'ContentVersion.create',   // ← 非法组合
```

`MySqlAuditBatchSink` 的 `validateApiVisibility` 把这两种证据模式定义为**互斥**：

- `EXACT_HTTP` = 真实线上事实已被观察到（要求 `httpMethod`/`requestUrl`/`host`/`endpointPath` 齐全，且 `operationName` **必须为 null**）
- `OPERATION_ONLY` = 只知道逻辑操作（要求 `operationName` 存在，且 HTTP 事实**必须全为 null**）

生产者同时声称两者，sink 拒绝，且该拒绝**不可重试**：`AuditBatchPersistenceError(..., false)` → `isolatePoisonEntries` → 单条批次 → `recordDrop(..., 'MCP_AUDIT_SNAPSHOT_REJECTED')`。快照因此被丢弃 —— 而在生产环境里，**唯一的症状就是少了一行**。

`recordApiCall` 之所以存在，是因为上传走 `fetch`，jsforce/`node:http` 的既有埋点看不到它。

### 9.3 为什么既有机器门禁没抓到

- `gate: audit` 断言的是 `RuntimeLogger` 事件（那些事件是**正确的**）；
- **没有任何测试检查 sink 真正要落库的那个 `AuditSnapshot`**；
- **没有任何测试把上传跑在 request audit context 里**，所以 `recordApiCall` 直接 early-return，缺陷根本不进入断言路径。

### 9.4 修复（三处，`59cb040`）

1. **让生产者符合契约，并让不变量结构化。**
   `attachment-upload.ts` 的 `ApiCallEvidence` 类型**删除了 `operationName` 字段本身**，五处证据字面量（目标校验 catch/success、ContentVersion POST catch/success、ContentDocumentId 读取）中对应的行一并删除。记录现在是：

   ```ts
   endpointPath: parsed.pathname,
   operationName: null,
   ```

   类型里没有这个字段，就无法再写错一次。`recordApiCall` 的 JSDoc 说明了原因：这一行属于哪个操作由 `httpMethod` / `endpointPath` / `purpose` 表达（`purpose ∈ {'ATTACHMENT_TARGET_VALIDATION','ATTACHMENT_UPLOAD'}`）。

2. **把不依赖数据库的 sink 校验提取成导出的纯函数。**
   `mysql-audit-batch-sink.ts` 新增 `assertAuditSnapshotPersistable(snapshot)`，并在 `persistSnapshots` 打开事务**之前**对每个 snapshot 调用。被吸收的既有内联检查有：`validatePayloadSnapshotBounds`、apiCall 与 auditId 的绑定检查、`validateApiVisibility`、payload `storedSizeBytes` 对账。**错误、顺序、可重试性全部不变**，因此对既有行为**零改变**（§七十六）。`validateApiVisibility` 本身**未被修改**。

   它存在的理由写在 JSDoc 里：让「自己记录 Salesforce 调用的 Tool」能在**没有数据库**的情况下被同一个契约检验 —— 这样一个吐出不合法证据的生产者会**在机器门禁上失败**，而不是在生产环境里静默丢掉整条 Audit。

3. **新增真正驱动该路径的门禁测试。**
   `test/attachment-upload.test.ts` 的 `gate: audit` 用例把真实上传跑在 `RequestAuditContextController` 里，`finalize()` 后要求：
   - snapshot 存在（走到了 Salesforce 就必须有快照）；
   - `salesforceApiCalls.length === 3`（目标校验、发布、读 document id）；
   - 每条的 `visibility === 'EXACT_HTTP'`、`operationName === null`、且 `requestUrl`/`host`/`endpointPath`/`httpMethod` 齐全；
   - `assertAuditSnapshotPersistable(snapshot)` 不抛。

### 9.5 线上验证：三个真实 `ContentVersion`

修复前/后各在测试 org 上创建了真实文件。**按 §九十五，这三个文件均未被自动删除。**

| `ContentVersion` | `ContentDocument` | 凭据路径 | Audit | 身份 |
| --- | --- | --- | --- | --- |
| `068C5000000yWOPIA2` | `069C5000000wnTNIAY` | 修复**前** | **无 audit 行** | — |
| `068C5000000yWg9IAE` | `069C5000000wnl7IAA` | 修复后 · 内部凭据 | `d3a2b6be-ccb7-49af-9d06-1fa2246290e8`，`outcome=SUCCESS` | `identity_source=INTERNAL_SERVICE_HEADER`，`execution_role=USER` |
| `068C5000000yWhlIAE` | `069C5000000wnmjIAA` | 修复后 · **企微渠道凭据** | `3ce4bda8-c8a5-483f-8d96-c13160d0d130` | `identity_source=WECOM_HEADER`，`execution_role=USER` |

第三个文件是**渠道维度**的证据：它以 `MCP_WECOM_CLIENT_TOKEN` + `X-WeCom-User-Id` 发起，证明**真实入站渠道确实能执行该 Tool**，而不只是内部凭据能。

第二轮全部 6 条 api call 均为 `visibility=EXACT_HTTP` / `operation_name=null`。重启后 **audit writer 失败计数 = 0**。

### 9.6 Payload 卫生扫描（真实闸门，非声明）

对落库的 `sfoa_audit_payload_evidence` 全量扫描，以下**全部不存在**：

| 检查项 | 结果 |
| --- | --- |
| 文件字节 / `VersionData` / base64 | **absent** |
| 原始 multipart body | **absent** |
| 暂存区绝对路径 | **absent** |
| Bearer token 字面量与两个 token | **absent** |

实际落库的 payload 类型只有 `MCP_REQUEST`、2 条身份失败 `ERROR_RESPONSE`、`MCP_RESPONSE`。

---

## 10. Attachment Bridge（§二十一–§二十五、§六十）

### 10.1 是否修改 Official WeCom Plugin？

> **预期：NO → 实际：NO。**
>
> `integrations/openclaw/sfoa-wecom-mcp-adapter/` 是**本仓库自有的 SFOA 适配层**，不是官方 WeCom Plugin。本次的全部桥接改动都落在这里与 SFOA Runtime 侧，**官方 WeCom Plugin 一行未改**。

### 10.2 先审真实代码，再动手（§二十二）

动手前先核对了三处真实实现，而非假设 `media://` / `AttachmentPath` / `AttachmentUrl` 就是当前生产 contract：

1. Official WeCom OpenClaw Plugin 的真实入站事实形状；
2. OpenClaw managed inbound media（文件被 OpenClaw 自己暂存到本地何处）；
3. SFOA requester-scoped MCP Adapter 的既有能力。

**结论**：优先复用既有 SFOA requester-scoped MCP Adapter 层，不新建第二套通道，不改官方 Plugin。

### 10.3 链路（§六十：不能只实现后半段 Tool）

```text
企微用户发文件
   ↓  OpenClaw 接收并本地暂存（workspace/media/inbound/…）
SFOA Adapter 入站桥接  src/attachments.js
   ↓  只接受 OpenClaw 自己写入的媒体事实；路径必须位于配置的暂存根之下
   ↓  从不读取字节到 string/buffer/base64；body 直接以 stream 交给 fetch
   ↓  从不用用户/模型/Tool 参数派生路径；从不 fetch URL（避免 SSRF）
SFOA Attachment Ingress   POST /attachments
   ↓   mint 不透明 attachmentRef（att_ + 24 字符）
   ↓   写 sfoa_attachment_staging（身份/属主/渠道/文件名/mime/size/sha256/受控路径/createdAt/expiresAt/state）
   ↓   **从不写文件字节**
下一轮 prompt build  src/index.js（before_prompt_build）
   ↓   把该会话的 att_… 引用注入本轮上下文
模型调用 upload_files_to_record(objectApiName, recordId, attachmentRefs[])
   ↓
Salesforce ContentVersion（FirstPublishLocationId）
   ↓
ContentDocument + ContentDocumentLink 自动生成 → 业务记录可见
```

**LLM 全程不需要读取文件内容即可上传**（§六十）。模型看到的只有不透明引用。

### 10.4 桥接的默认关闭与配置面

`openclaw.plugin.json` 新增（全部 **默认关闭**）：

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `attachmentBridgeEnabled` | **`false`** | 开启后才会暂存并注入引用；运行时侧还需 `MCP_ATTACHMENT_INGRESS_ENABLED=true` |
| `attachmentIngressPath` | `/attachments` | 相对于 `mcpUrl` 的 origin 解析 |
| `attachmentWorkspaceRoot` | `/data/openclaw/workspace` | 媒体路径可被解析的绝对根 |
| `attachmentMediaRoot` | `<workspaceRoot>/media/inbound` | 入站文件必须位于其下才可转发 |
| `attachmentRefTtlMs` | `300000` | 引用对模型可用的时长 |

两侧**独立开关**是刻意的：只开一边不会产生任何可用能力，也不会产生半开状态下的静默行为。

### 10.5 暂存记录字段（§二十五）

`sfoa_attachment_staging` 记录：`attachment_ref`、`platform_user_id`（属主）、`source_channel`、`run_id`、`file_name`、`mime_type`、`byte_size`、`content_sha256`、`staged_path`（受控路径）、`state`、`created_at`、`expires_at`、`consumed_at`、`failure_code`。

**从不记录二进制。** `state ∈ STAGED | CONSUMED | EXPIRED | FAILED`。
`content_sha256` 在暂存时记录并进入审计；**SHA-256 不是幂等键**（§五十二）。

---

## 11. Identity（§三十一–§三十四）

> **File upload uses requester-scoped Salesforce user: YES**

| 项 | 值 |
| --- | --- |
| 身份来源 | MySQL `sfoa_identity_route` → JWT → **真实 Salesforce 用户** |
| 是否为固定集成账号 | **NO** |
| 是否为 admin token | **NO** |
| 是否为 system user | **NO** |
| 凭证缓存 | **无**（无 token cache、无 Connection pool、无 Redis） |
| 真实线上证据 | `identity_source=WECOM_HEADER`、`execution_role=USER`（§9.5 第三个文件） |
| 内部凭据证据 | `identity_source=INTERNAL_SERVICE_HEADER`、`execution_role=USER`（§9.5 第二个文件） |

Salesforce 是权限的最终裁决者：SFoA 不预判也不镜像 Salesforce 的字段级/对象级权限，越权由 Salesforce 以真实错误返回，并被逐字保留。

**本报告不输出任何真实用户 token。**

---

## 12. Salesforce 侧实现（§三十五–§四十四）

| 项 | 值 |
| --- | --- |
| 使用的 API | REST `POST /services/data/v<ver>/sobjects/ContentVersion`，**multipart/form-data 流式**（优先流式，非 base64，非内存整块） |
| 目标记录校验 | 先做一次真实读取，确认 `recordId` 属于 `objectApiName` |
| `ContentVersion` | 由上传调用创建 |
| `ContentDocument` | **由 Salesforce 自动创建** —— v1 **不 INSERT** |
| `ContentDocumentLink` | **由 Salesforce 自动创建** —— v1 **不 INSERT** |
| `FirstPublishLocationId` 策略 | 上传时设为目标业务记录 Id；probe 证实其单独即可产生 `ShareType=V` 的业务记录链接（§1.1），因此无需也不做手动 link fallback |
| 幂等键 | **不使用 SHA-256 作为幂等键**（§五十二） |

**v1 明确排除**：既有文件 relink、版本更新（新 version）、删除、下载、公开链接。

---

## 13. 运行结果模型（§四十五–§五十二）

- **逐文件独立结果**：`SUCCESS` / `FAILED` / `OUTCOME_UNKNOWN` / `NOT_ATTEMPTED`，与 P8-07 outcome 模型对齐。
- **聚合结果**：`SUCCESS` / `PARTIAL_SUCCESS` / `FAILED` / `OUTCOME_UNKNOWN`。
- **遇到 UNKNOWN 立即停止**，其余文件记为 `NOT_ATTEMPTED`。
- **UNKNOWN 永不自动重试**（Salesforce 可能已经发布了该文件）。
- **FAILED 可以按文件单独重试**。
- **当前文件状态 ≠ 事务结果**：读回现态不自动升级为成功。
- SHA-256 在暂存与审计中记录，但**不是**幂等键。

---

## 14. Audit 集成（§五十三–§五十六）

复用既有 P7 审计，未新建第二套。

**记录**：`runId`/`traceId`、来源渠道、平台用户、映射后的 Salesforce 用户、Tool 名、`objectApiName`、`recordId`、`attachmentRef`、文件名、MIME、大小、SHA-256、Salesforce API 路径与类型、`ContentVersionId`、`ContentDocumentId`、状态、HTTP status、`errorCode`、first cause、耗时。

**严禁记录（已用 §9.6 全量扫描证实不存在）**：file bytes、base64、raw multipart body、Bearer token、temp 绝对路径、file content。

**Salesforce 的 `errorCode` / `message` / first cause 逐字保留**，不做改写、不做本地化替换、不做「友好化」。

审计证据模式：上传记录的是 **`EXACT_HTTP`**（真实线上事实），`operation_name = null`。这正是 §9 缺陷的所在，也是修复后的不变量。

---

## 15. 安全（§五十七–§六十三）

| 风险 | 处置 |
| --- | --- |
| 路径穿越 / 任意文件读取 | ingress 重新推导路径包含关系，`lstat().isFile()`，从磁盘重新取 size 与 digest；路径逃逸 → `MCP_ATTACHMENT_PATH_INVALID`。机器门禁覆盖 `../`、绝对路径、`file://`、`http(s)://`、localhost、云元数据地址 |
| 跨用户 token | `constantTimeEquals(record.platformUserId, requester)`；不匹配与不存在返回**同一**错误码，ingress 不是存在性预言机 |
| 过期 token | `state !== 'STAGED'` 或 `expiresAt <= now` → `MCP_ATTACHMENT_EXPIRED` |
| 无界临时文件 / 内存整块加载 | 受控暂存根（`0700`，root 属主）+ 单文件与单属主上限 + 定期 reaper（`reapExpired`）+ 流式 multipart |
| Agent 指定路径 | **结构性禁止**：schema 里根本没有路径字段 |
| SSRF | **结构性禁止**：schema 里没有 URL 字段；桥接层也从不 fetch 媒体 URL |
| 会话串号 | ref 为请求者作用域；跨用户复用已在真实链路验证为 `MCP_ATTACHMENT_NOT_OWNED` |

### 15.1 临时文件生命周期

| 情形 | 处置 |
| --- | --- |
| 成功 | **立即清理**（真实链路已验证：`state=CONSUMED`，`staged/` 归空） |
| 已知失败且可能需要重试 | 短保留 |
| 已过期 | reaper 清理 |
| UNKNOWN | **保留**，作为对账证据 |

TTL 是**基础设施生命周期**，不是 Salesforce 文件策略（§二十八）。

### 15.2 刻意没有过度设计

没有引入分布式锁、消息队列、跨进程协调或第二套审计管道。上述边界已覆盖真实失败模式，再往上加只会增加运维面而不增加安全性。

---

## 16. Governance（§六十四–§七十四）

| 项 | 结果 |
| --- | --- |
| 是否绕过 Tool Governance | **NO** —— 走既有 `tools/list` / enable-disable / agent visibility / audit |
| `tools/list` 是否暴露 `upload_files_to_record` | **YES** —— 两种凭据路径都返回同一份 **16 个 Tool** 的列表，含 `upload_files_to_record`，schema 为上述 3 属性 |
| 宿主原生 Tool 的双清单注入 | `provider-runtime.ts`（治理服务器）与 `discovery-server.ts`（发现服务器）**两处**都注入。原因是两者都通过 Provider 派生清单解析已启用 Tool 名，只注入一处会 fail-closed（`MCP_TOOL_NOT_AVAILABLE`），而不是服务它 |
| 新 Skill | **无**。扩展 `skills/sfoa-record-change/`，新增 `references/file-attachments.md`；`SKILL.md` 只加一行极短激活语 |
| `get_agent_playbook` | 最小改动：新增 `attachmentEnabledObjects` 能力事实 |
| Admin Web | 在既有策略 UI 增加「附件上传」列与开关，保持现有风格，**不新建独立模块** |
| Admin API | 扩展现有 DTO，**不新建**独立 Attachment Policy API |
| 业务 Agent 可见 Skill | 仍**只有** `sfoa-crm-core` 与 `sfoa-record-change`；`sfoa-mcp-maintainer` 对业务 Agent **不可见** |

### 16.1 Doctrine（写入 `references/file-attachments.md`）

- 解析目标记录；只对 `attachmentEnabled` 的对象操作；
- **永不用 Generic DML 操作 Files 对象**；
- **永不自行编造 `attachmentRef`**；
- **永不传任意路径或 URL**；
- **CREATE 必须先成功，才能上传附件**；
- **CREATE 结果 UNKNOWN → 不上传**；
- **附件 FAILED 不代表记录创建失败**（记录创建仍可能是 `SUCCESS`）；
- **附件 UNKNOWN → 不重放**；
- 多文件 → 逐文件真实结果，不合并、不掩盖。

---

## 17. 部署到测试服务器（§八十八–§九十五）

测试服 `crm-ex-test02` / `192.168.156.203`。**生产环境未触碰。**

| 项 | 值 |
| --- | --- |
| 部署 SHA | `59cb040` |
| 归档 | `sfoa-02c-59cb040.tar.gz`，**2,579,590 B** |
| 归档 sha256 | `d2cc72d59e8298753b609ae2e8572dba8baf21bdad5fbcfc9c4f66ed57b3ce06`（与服务器端实测**一致**） |
| 打包方式 | `git -c core.autocrlf=false -c core.eol=lf archive --format=tar.gz`（避免 §Windows CRLF 假漂移） |
| 解包 | 1138 个文件 |
| 落盘 | 先解到 `staging-02c-59cb040/`，再 `rsync -a`（**不带 `--delete`**）覆盖 `app/` |
| 逐字节校验 | `sha256sum -c` → **1138 OK / 0 FAILED / 0 MISSING** |
| LF 纯净性 | 唯一含 CR 的文件是 `docs/sfoa/evidence/p6-dml-01-admin-managed-fields.png`（二进制 PNG）；文本文件全部纯 LF |
| 构建 | 重建 `control-plane` 后重建 `mcp-server`；已在 `dist` 中确认修复存在，且 `assertAuditSnapshotPersistable` 运行时类型为 `function` |
| 服务重启 | 干净重启 |

### 17.1 部署后运行时状态

| 组件 | 状态 |
| --- | --- |
| `sfoa-mcp-server` | `active` · `http://127.0.0.1:8080/health` → **200** |
| `sfoa-admin-api` | `active` · `http://127.0.0.1:8081/admin/api/health` → **200** · 经 nginx `:9000/admin/api/health` → **200** |
| `openclaw-gateway` | `active` |
| `nginx` | `active` · `:9000/`（Admin Web）→ **200** |
| Node | `v22.23.1` |

### 17.2 新增配置（键名已确认存在，值按 CLAUDE.md 不输出）

`/data/sfoa-enterprise-mcp/config/.env.local` 中已配置：

```text
MCP_ATTACHMENT_INGRESS_ENABLED
MCP_ATTACHMENT_PATH
MCP_ATTACHMENT_STAGING_ROOT
MCP_ATTACHMENT_TTL_MS
MCP_ATTACHMENT_MAX_FILE_BYTES
MCP_ATTACHMENT_MAX_FILES_PER_OWNER
```

暂存根：`/data/sfoa-enterprise-mcp/attachment-staging/`，`staged/` 权限 `0700`、root 属主，**当前为空（0 个文件）**，证明成功路径的清理真实生效。

### 17.3 DB 迁移

`014_skill02c_attachment_upload.sql` 已应用：`sfoa_dml_policy.attachment_enabled`（`NOT NULL DEFAULT FALSE`）+ `sfoa_attachment_staging` 表 + 两个索引（属主/状态、状态/过期）。既有对象**行为不变**。

### 17.4 Business Skill 同步（§九十）

通过**既有** Business Skill sync 机制发布到 `/data/openclaw/workspace/skills/`，**没有**新建第二套 sync system：

```text
yarn skill:runtime:check --runtime-root /data/openclaw/workspace/skills
  → sfoa-crm-core      ok:true, drift: []
  → sfoa-record-change ok:true, drift: []
```

业务 Agent 可见 Skill 仍**只有** `sfoa-crm-core` + `sfoa-record-change`；`sfoa-mcp-maintainer` 确认不可见。

> 注意：`skill:runtime:check` **必须在服务器上运行**。在 Windows 检出上运行会把 `/data/...` 解析成 `D:/Git/data/...` 并报假的 "missing Runtime Copy"。

### 17.5 Tool 发现（§九十二）

```text
tools/list（内部凭据路径）        → 16 个 Tool，含 upload_files_to_record
tools/list（企微渠道凭据路径）    → 16 个 Tool，含 upload_files_to_record
```

两条界面返回**同一份**列表。已验证一个携带企微渠道凭据的 `tools/call` **确实通过治理路径执行**（§9.5 第三个文件）。

---

## 18. 6 个真人 UAT 用例（已准备，**未自动执行**）

完整可执行清单见 [`SKILL_02C_ATTACHMENT_UAT.md`](SKILL_02C_ATTACHMENT_UAT.md)。摘要：

| # | 用例 | 期望 |
| --- | --- | --- |
| UAT-01 | 单文件正常路径：企微发 1 个文件 + 「把它加到 Visit-004209 上」 | 聚合 `SUCCESS`；记录 Files 相关列表出现该文件；Audit 含 `ContentVersionId`/`ContentDocumentId` |
| UAT-02 | 多文件单记录：一次发 3 个文件 | 聚合 `SUCCESS`，`succeeded=3`，逐文件 3 条 `SUCCESS`；记录上 3 个文件 |
| UAT-03 | 对象未开启 `attachmentEnabled` | `MCP_ATTACHMENT_OBJECT_NOT_ALLOWED`；**Salesforce 侧 0 文件创建** |
| UAT-04 | 跨用户引用复用：用户 B 用用户 A 的 `att_…` | `MCP_ATTACHMENT_NOT_OWNED`；**与「ref 不存在」返回同一码**；不泄露存在性/路径/他人信息 |
| UAT-05 | 过期引用：暂存后超过 TTL 再上传 | `MCP_ATTACHMENT_EXPIRED`；`staging/` 中该文件已被 reaper 清理 |
| UAT-06 | 先 CREATE 后上传 + 拒绝传播 | 同一轮内先建记录、`SUCCESS` 后再上传；**若** Salesforce 因类型/大小拒绝，确认真实 `errorCode`/`message` 原样到达 MCP Audit **与** Agent 回复；记录创建仍报 `SUCCESS` |

UAT-06 的拒绝分支**不刻意上传超大文件**（§九十四）。只在自然发生时核验传播链。

---

## 19. Known Limitations

1. **真人 UAT 未执行。** 本报告不主张行为级通过，只主张机器可验证部分 + probe 真实 API 部分通过。§18 的 6 个用例是**准备就绪**，不是**已通过**。
2. **一次不可复现的 `test:p5` 5/6。** 随后两次均 6/6。该次失败的断言未被捕获，因此**不能**断言它是环境噪声；如实列为未解释项。
3. **`admin-web/GovernancePages.test.tsx` 并发下 60 s 超时**（单独 14/14 通过）；**`test:p7` 一次并发挂起**（单独 6/6 通过）。均判定为资源竞争。
4. **`OUTCOME_UNKNOWN` 与 `PARTIAL_SUCCESS` 未用真实 Salesforce 故障复现。** 门禁通过**决策模型**验证语义；真实链路的故障注入属 UAT 范围。
5. **`FirstPublishLocationId` 为「格式合法但不存在」时返回 HTTP 201 并创建未链接文件。** 这是 SFoA 行为差异，不是缺陷；UNKNOWN 对账路径因此是必需的（§1.1）。
6. **`TEST_SERVER_DEPLOYMENT.md` 的既有记录需修正**：该文档把 02B 部署记为 `4b3b2ff`，但服务器 `app/` 的 mtime 与暂存目录名指向 `ce800c2`（`4b3b2ff` 的后代，含 6 个提交中的最后 4 个）。02C 部署轮已一并更正（§20）。
7. **02C 分支已 push，但未合入 `main`。** 功能最终 SHA `59cb040` 之上均为纯文档提交；分支 tip 与 `origin` 一致。probe 分支 `feature/sfoa-attachment-capability-probe` 亦已 fast-forward 推送。**合入 `main` 仍需用户决定。**
8. **本机 Windows 检出噪声**：`git status --porcelain` 在 Bash 工具下 120 s 超时（PowerShell 下正常）；`yarn`/`node` 前台调用偶发 `Permission denied`；`git` 偶发 shim 拒绝。均为执行环境噪声，命令经重试后成功且结果可复现。

---

## 20. 最终状态

```text
Probe Gate                : PASS (6/6, real API evidence, no blocking SFOA difference)
Implementation            : COMPLETE
Machine Gate              : PASS (attachment 42/42; mcp-server 203/203; control-plane 38/38)
Regression                : PASS (Skill-01 / CREATE / UPDATE / Batch / Outcome; p3 25/25, p4 8/8, p5 6/6, p7 6/6)
Test-server deployment    : COMPLETE (59cb040; 1138/1138 byte-verified; 4 services active)
OpenClaw tool discovery   : PASS (16 tools incl. upload_files_to_record on both credential paths;
                                  a WeCom-credential tools/call verified executing the Tool)
Official WeCom Plugin     : NOT MODIFIED
Found-and-fixed blocker   : 1 (silent loss of a successful upload's Audit snapshot; 59cb040)
Git                       : PUSHED (origin/feature/sfoa-attachment-upload, tip == local; NOT merged to main)
```

**未主张**：真人附件 UAT 通过、`>10` 文件的链路验证、UNKNOWN 的真实故障复现。

---

```text
SKILL-02C IMPLEMENTATION COMPLETE / READY FOR HUMAN ATTACHMENT UAT
```

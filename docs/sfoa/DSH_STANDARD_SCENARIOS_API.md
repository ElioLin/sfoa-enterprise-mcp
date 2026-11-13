# DSH 插件标准场景协同与管控 API（DSH-01）

本文是 `crm-dsh-plug`（DSH 客户端插件）与 MCP 控制平面对接的**唯一接口契约**。所有标准场景的权限、发布、编辑、软删除、版本升级与预设附件分发都通过这些接口完成。

- 服务进程：`@sfoa/admin-api`（Admin API，默认 `127.0.0.1:8081`）
- 插件前缀：`/api/dsh/**`
- 控制台前缀：`/admin/api/dsh/**`（React Admin 后台使用，见 §7）
- 数据表：`crm_dsh_standard_scenarios`、`crm_dsh_scenario_files`；权限列：`sfoa_identity_route.can_manage_dsh_scenarios`

---

## 1. 身份与权限模型

### 1.1 权限来源

标准场景的写权限**挂在用户身份路由上**，不是独立授权表：

```
Buntu Token / USER_BOUND Token / 平台身份头
        │
        ▼
platformUserId ──► sfoa_identity_route(platform_user_id) ──► can_manage_dsh_scenarios
                                                     └────► salesforce_username（响应的 crmUsername）
```

- `can_manage_dsh_scenarios = 1` 且路由 `enabled = 1` → 可创建 / 编辑 / 删除 / 管理附件。
- 否则（含未传 Token、Token 无效、路由停用）→ 只读：可以拉取 `PUBLISHED` 场景与下载附件，写接口返回 `403 DSH_SCENARIO_PERMISSION_DENIED`。
- React Admin 后台管理员通过登录态 Session 调用时，等同于授权用户（仍需具备 `标准场景管理` 模块权限）。

### 1.2 Token 传递方式（按优先级）

| 优先级 | 载体 | 示例 |
| --- | --- | --- |
| 1 | `Authorization: Bearer <token>` | `Authorization: Bearer buntu-xxxx` |
| 1 | `X-Buntu-Token: <token>` | `X-Buntu-Token: buntu-xxxx` |
| 1 | Query 参数 `buntuToken` | `GET /api/dsh/scenarios/permission?buntuToken=buntu-xxxx` |
| 1 | Body 字段 `buntuToken`（JSON 请求体） | `{"buntuToken":"buntu-xxxx","scenarioId":"..."}` |
| 2 | Admin 登录态 Cookie（仅后台） | 浏览器同源自动携带 |
| 3 | 平台身份头（仅 `MCP_AUTH_MODE=internal_bearer` 且同时出示 `MCP_CLIENT_TOKEN`） | `Authorization: Bearer <MCP_CLIENT_TOKEN>` + `X-SFOA-Platform-User: <platformUserId>` |

> 优先级 3 的安全前提：**必须**同时出示部署共享的 `MCP_CLIENT_TOKEN`。单独发 `X-SFOA-Platform-User` 不会被视为身份（否则任何人都能冒充）。

Token 类型判定：以 `sfoa_ub1_` 开头视为 MCP 用户凭证（按 SHA-256 摘要匹配 `sfoa_identity_credential`），其余交由 Buntu 校验接口 `MCP_BUNTU_VALIDATE_TOKEN_URL` 解析。Token 本身从不写入日志或审计。

### 1.3 `auth` 对象

所有响应都带同一个 `auth` 结构，插件据它决定 UI：

```json
{
  "authenticated": true,
  "platformUserId": "10086",
  "crmUsername": "user@example.com",
  "canManageStandardScenario": true
}
```

| 字段 | 含义 |
| --- | --- |
| `authenticated` | Token/身份是否解析成功且路由处于启用状态 |
| `platformUserId` | 解析出的平台用户编号；未认证为 `null` |
| `crmUsername` | 该路由绑定的 CRM 账号；未认证为 `null` |
| `canManageStandardScenario` | 是否可在插件中管理标准场景（决定是否展示「设为标准场景」勾选框） |

---

## 2. 接口总览

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/dsh/scenarios` | 无需 | 全量同步：可用场景 + 已删除场景 ID |
| GET | `/api/dsh/scenarios/permission` | 无需 | 权限快速预检 |
| POST | `/api/dsh/scenarios` | 可管理 | 新建标准场景（同 ID 则走编辑升版） |
| PUT | `/api/dsh/scenarios/{scenarioId}` | 可管理 | 编辑标准场景（强制升版） |
| DELETE | `/api/dsh/scenarios/{scenarioId}` | 可管理 | 软删除（返回墓碑） |
| POST | `/api/dsh/scenarios/{scenarioId}/attachments` | 可管理 | 上传预设附件（升版） |
| DELETE | `/api/dsh/scenarios/{scenarioId}/attachments/{attachmentId}` | 可管理 | 删除预设附件（升版） |
| GET | `/api/dsh/scenarios/{scenarioId}/attachments/{attachmentId}` | 无需（PUBLISHED） | 下载附件二进制 |

**CORS**：允许的方法为 `GET, POST, PUT, DELETE, OPTIONS`；允许的请求头为 `Authorization, Content-Type, X-Buntu-Token, X-SFoA-CSRF-Token, Accept`；响应暴露 `Content-Disposition, X-SFoA-Content-Sha256, X-Correlation-Id`。允许的来源由 `SFOA_DSH_ALLOWED_ORIGINS` 控制（默认 `*`）。预检请求返回 `204`。

---

## 3. 全量/增量同步

### `GET /api/dsh/scenarios`

Query：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `includeDeleted` | `true` | 是否返回已软删除的场景 ID 数组 |
| `includeArchived` | `false` | 是否包含 `ARCHIVED`；**仅授权用户生效**，普通用户即使传 `true` 也只得到 `PUBLISHED` |

响应 `200`：

```json
{
  "auth": { "authenticated": true, "platformUserId": "10086", "crmUsername": "user@example.com", "canManageStandardScenario": false },
  "scenarios": [
    {
      "scenarioId": "account-review",
      "title": "客户年度回顾",
      "category": "客户经营",
      "description": "按客户汇总年度机会与交付情况。",
      "version": "1.0.3",
      "revision": 4,
      "scenarioPayload": {
        "pinnedSkills": ["crm-account-brief"],
        "welcomeMessage": "我来帮你完成客户年度回顾。",
        "inputDraft": "请回顾 {{accountName}} 的年度情况",
        "prePinnedContext": { "objectApiName": "Account" },
        "sourceType": "COMPANY_STANDARD",
        "readonlyForNormalUser": true
      },
      "presetAttachments": [
        {
          "attachmentId": "att_3f2c…",
          "fileName": "季度回顾模板.txt",
          "mimeType": "text/plain",
          "fileSize": 2048,
          "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          "downloadUrl": "/api/dsh/scenarios/account-review/attachments/att_3f2c…"
        }
      ],
      "status": "PUBLISHED",
      "createdByPlatformUid": "10086",
      "createdByCrmUser": "user@example.com",
      "updatedByPlatformUid": "10086",
      "createdAt": "2026-09-01T08:00:00.000Z",
      "updatedAt": "2026-09-02T10:12:00.000Z"
    }
  ],
  "deletedScenarioIds": ["legacy-scenario"]
}
```

`downloadUrl` 是**相对路径**，插件用自身的 API base 拼接（`new URL(downloadUrl, apiBase)`）。

### 插件同步算法（建议实现）

1. 启动 / 定时同步：`GET /api/dsh/scenarios?includeDeleted=true`。
2. 对每个远端 `scenarioId`：
   - 本地未安装 → 安装（把 `scenarioPayload` 落库为只读标准场景，记录 `version`/`revision`）。
   - 本地已安装且 `revision` 或 `version` 与本地不同 → **直接覆盖升级**（标准场景本身不可编辑，不需要合并）。
3. 对 `deletedScenarioIds` 中的每个 ID：若本地已安装 → 卸载并清理。
4. 本地安装过但远端 `scenarios` 与 `deletedScenarioIds` 都没有（例如被改成 `ARCHIVED`）→ 视同不可用，移出标准场景列表（保留本地数据或提示用户，由插件决定）。
5. 打开「新建/编辑场景」抽屉前调用 `GET /api/dsh/scenarios/permission`，`canManageStandardScenario === true` 才展示「设为标准场景」勾选框。

---

## 4. 权限预检

### `GET /api/dsh/scenarios/permission`

无需 Token 也能调用（此时返回 `authenticated: false`）。

```bash
curl -s http://127.0.0.1:8081/api/dsh/scenarios/permission \
  -H 'Authorization: Bearer <buntu-token>'
```

```json
{
  "authenticated": true,
  "platformUserId": "10086",
  "crmUsername": "user@example.com",
  "canManageStandardScenario": true
}
```

---

## 5. 写接口

### 5.1 新建 / 发布 `POST /api/dsh/scenarios`

必填：`scenarioId`、`title`、`description`、`scenarioPayload`。可选：`category`（默认 `通用场景`）、`status`（默认 `PUBLISHED`）。

```json
{
  "scenarioId": "account-review",
  "title": "客户年度回顾",
  "category": "客户经营",
  "description": "按客户汇总年度机会与交付情况。",
  "scenarioPayload": { "pinnedSkills": ["crm-account-brief"], "welcomeMessage": "…" }
}
```

规则：

- 服务端**强制**写入 `scenarioPayload.sourceType = "COMPANY_STANDARD"` 与 `scenarioPayload.readonlyForNormalUser = true`。
- 首次创建：`version = "1.0.0"`、`revision = 1`、`status = "PUBLISHED"`。
- `scenarioId` 已存在（含已软删除的行）→ 自动走 §5.2 的编辑升版逻辑（重新上架时版本继续递增，不会回到 1.0.0）。
- 请求体中若出现 `version` / `revision`，整单以 `400 DSH_SCENARIO_INPUT_INVALID` 拒绝（未知字段），因为这两个字段永远由服务端持有。

响应 `201`：`{ "auth": {...}, "scenario": { ...完整场景对象 } }`

### 5.2 编辑 `PUT /api/dsh/scenarios/{scenarioId}`

部分更新：只传需要改的字段，未传字段保持原值。

```json
{ "title": "客户年度回顾（标准版）", "description": "……", "status": "ARCHIVED" }
```

升版规则（**服务端强制**，客户端传入的旧值一律忽略）：

| 字段 | 变化 |
| --- | --- |
| `version` | 补丁位 +1：`1.0.2` → `1.0.3` |
| `revision` | +1：`3` → `4` |
| `updatedByPlatformUid` | 当前操作者 |
| `updatedAt` | 当前时间 |

响应 `200`：`{ "auth": {...}, "scenario": {...} }`

### 5.3 软删除 `DELETE /api/dsh/scenarios/{scenarioId}`

- `status` → `DELETED`，`revision` +1（`version` 保持不变：墓碑不是新版本）。
- 关联附件二进制立即从 `crm_dsh_scenario_files` 删除。

响应 `200`：

```json
{
  "auth": { ... },
  "deleted": true,
  "scenarioId": "account-review",
  "revision": 6,
  "deletedScenarioIds": ["account-review", "legacy-scenario"]
}
```

### 5.4 上传预设附件 `POST /api/dsh/scenarios/{scenarioId}/attachments`

两种请求体，二选一：

**A. JSON Base64（推荐，任何运行时都可用）**

```json
{
  "fileName": "季度回顾模板.txt",
  "mimeType": "text/plain",
  "contentBase64": "5a2j5bqm5Zue6aG+5qih5p2/…",
  "sha256": "可选的客户端摘要，若与服务端计算结果不一致则拒绝"
}
```

**B. multipart/form-data**

```bash
curl -X POST http://127.0.0.1:8081/api/dsh/scenarios/account-review/attachments \
  -H 'Authorization: Bearer <buntu-token>' \
  -F 'file=@./季度回顾模板.txt;type=text/plain'
```

规则：

- `sha256` 由服务端对**实际收到的字节**计算并入库；客户端摘要仅用于校验。
- 每次上传都会把主场景 `version` 补丁位 +1、`revision` +1。
- 单个场景最多 20 个附件；单文件上限 `SFOA_DSH_MAX_ATTACHMENT_BYTES`（默认 10 MiB）。

响应 `201`：`{ "auth": {...}, "scenario": {...}, "attachment": { "attachmentId": "att_…", "downloadUrl": "/api/dsh/…", … } }`

### 5.5 删除预设附件 `DELETE /api/dsh/scenarios/{scenarioId}/attachments/{attachmentId}`

删除附件行、重建主表 `presetAttachments`，并把主场景 `version` +1 个补丁位、`revision` +1。响应 `200`：`{ "auth": {...}, "scenario": {...} }`。

### 5.6 下载附件 `GET /api/dsh/scenarios/{scenarioId}/attachments/{attachmentId}`

- 返回原始字节，`Content-Type` 为入库的 MIME，`Content-Disposition: attachment; filename="…"; filename*=UTF-8''…`。
- 附带 `X-SFoA-Content-Sha256`，插件可直接比对 `presetAttachments[].sha256`。
- `DELETED` 场景的附件返回 `404`；`ARCHIVED` 场景的附件仅授权用户可下载。

---

## 6. 错误契约

统一错误体（HTTP 状态码 + 稳定错误码）：

```json
{
  "error": { "code": "DSH_SCENARIO_PERMISSION_DENIED", "message": "…", "issues": [{ "path": "scenarioId", "message": "…" }] },
  "correlationId": "a1b2c3d4-…"
}
```

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `DSH_SCENARIO_INPUT_INVALID` | 字段缺失/格式不符（`issues` 给出逐字段原因） |
| 400 | `DSH_SCENARIO_REQUEST_INVALID` | 非 JSON 体、multipart 缺文件、路径编码非法 |
| 403 | `DSH_SCENARIO_PERMISSION_DENIED` | 无 `can_manage_dsh_scenarios` 权限 |
| 403 | `DSH_SCENARIO_ORIGIN_NOT_ALLOWED` | `Origin` 不在允许列表 |
| 403 | `DSH_SCENARIO_CSRF_INVALID` | 后台 Session 调用且缺少 CSRF（仅后台） |
| 404 | `DSH_SCENARIO_NOT_FOUND` | 场景或附件不存在 / 已软删除 / 未上架 |
| 405 | `DSH_SCENARIO_METHOD_NOT_ALLOWED` | 方法不匹配 |
| 409 | `MCP_CONTROL_PLANE_CONFLICT` | 并发写入冲突 |
| 413 | `DSH_SCENARIO_REQUEST_TOO_LARGE` | 附件或请求体超限 |
| 415 | `DSH_SCENARIO_UNSUPPORTED_MEDIA_TYPE` | 非 `application/json` 或 `multipart/form-data` |
| 500 | `MCP_ADMIN_AUDIT_FAILED` | 审计落库失败，变更已回滚（不会出现「改了但没记录」） |
| 503 | `MCP_CONTROL_PLANE_UNAVAILABLE` | MySQL / 控制平面不可用 |

校验约束（服务端 `zod` 严格模式）：

- `scenarioId`：`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，且不能是保留字 `permission`。
- `title` ≤ 128、`category` ≤ 64、`description` ≤ 4000 字符。
- `scenarioPayload`：JSON 对象，序列化后 ≤ 256 KiB；`pinnedSkills` 为 ≤50 个字符串。
- `fileName` 禁止路径分隔符与控制字符；`mimeType` 必须是合法 `type/subtype`。

---

## 7. 后台（React Admin）使用说明

- 菜单：**标准场景管理**（模块 id `standard-scenarios`）。
- 后台通过 `/admin/api/dsh/**` 调用同一套逻辑：先由 ADR-0034 模块表鉴权，再复用 Admin CSRF 规则，因此 scoped 账号没有该模块时请求直接 `403 MCP_ADMIN_FORBIDDEN`。
- 用户身份路由页新增「插件标准场景权限」列与开关，可随时开启/回收某个平台用户的标准场景管理权限。

---

## 8. 部署与运维

1. 执行迁移：`yarn db:migrate`（新增 `018_dsh_standard_scenarios`）。
2. 反向代理新增一段（与 `/admin/api/` 同一后端）：

   ```nginx
   location /api/dsh/ {
       proxy_pass http://127.0.0.1:8081/api/dsh/;
       proxy_set_header Host $host;
       client_max_body_size 16m;   # ≥ SFOA_DSH_MAX_ATTACHMENT_BYTES × 4/3
   }
   ```

3. 环境变量：`SFOA_DSH_ALLOWED_ORIGINS`、`SFOA_DSH_MAX_ATTACHMENT_BYTES`（见 `.env.example`）。
4. MySQL `max_allowed_packet` 必须大于附件上限（默认 10 MiB 时保持 ≥ 16 MiB）。
5. 审计：每次写操作在**同一事务**内写入一条 `channel=ADMIN` 审计行，`operation` 为 `CREATE_DSH_SCENARIO` / `UPDATE_DSH_SCENARIO` / `DELETE_DSH_SCENARIO` / `ADD_DSH_SCENARIO_ATTACHMENT` / `DELETE_DSH_SCENARIO_ATTACHMENT`，`recordId` 为 `scenarioId`。插件端操作记为 `actorAdmin = dsh:<platformUserId>`。

# MySQL 迁移 016 证据（2026-10-22）

命令（本地工作区）：

```text
yarn db:migrate
```

结果：`status=PASS`，MySQL 8.0.30，schema `sfoa_enterprise_mcp`。

新迁移：

| 项 | 值 |
| --- | --- |
| version | `016_crm_openclaw_chat` |
| checksumSha256 | `329f1c9624c8388c4f8e9af96635cb5ba311346bcf609dbbbcd94c7611e4cab8` |
| appliedAt | `2026-10-22T08:42:34.770Z` |
| state | `APPLIED` |

新增/变更：

- `sfoa_audit_log.identity_source` 枚举追加 `CRM_HEADER`。
- `sfoa_crm_identity_binding`：`(salesforce_org_id, salesforce_user_id)` 唯一。
- `sfoa_crm_conversation`：CRM 对话 → OpenClaw 官方 session key。
- `sfoa_crm_run`：`(conversation_id, client_message_id)` 唯一；运行状态/安全错误/时间。
- `sfoa_crm_bootstrap_nonce`：jti 主键，一次性兑换。
- `sfoa_crm_chat_session`：token SHA-256 主键、主体、过期/撤销、`salesforce_username`。

未包含：聊天正文、Salesforce token、Apex 私钥、证书私钥。

## 仓储集成测试

`node --test dist/mysql-test/*.test.js` → **1/1 PASS**，并清理了测试创建的绑定/会话/对话/运行/一次性记录。

## 注意

- 迁移 016 已在本地数据库应用；服务器尚未迁移。部署前必须在目标库执行 `yarn db:migrate`。
- 迁移文件已被 checksum 记录；后续需要变更时应新增 017，而不是修改 016。

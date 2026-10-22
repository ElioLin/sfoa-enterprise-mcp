# CRM OpenClaw 一期证据索引（2026-10-22）

本目录只保存脱敏摘要与可复现命令；不包含访问令牌、JWT、私钥、证书私钥、Salesforce Session ID、数据库口令或完整业务数据。

交付分支：`feature/crm-openclaw-entry`，首个提交 `561bda4`（已推送 `origin`）。

| 证据 | 文件 | 层级 |
| --- | --- | --- |
| 版本与目标环境 | [versions.md](versions.md) | REAL 环境只读探测 |
| MCP CRM 渠道单元/HTTP 测试 | [mcp-tests.md](mcp-tests.md) | UNIT / MOCK |
| 接入服务单元/HTTP 测试 | [gateway-tests.md](gateway-tests.md) | UNIT / MOCK |
| MySQL 迁移与仓储集成测试 | [mysql-migration.md](mysql-migration.md) | REAL MySQL（本地） |
| OpenClaw CRM 渠道插件测试 | [openclaw-plugin-tests.md](openclaw-plugin-tests.md) | UNIT / MOCK |
| 企微适配器回归 | [adapter-regression.md](adapter-regression.md) | UNIT / MOCK |
| CRM 元数据静态检查 | [crm-static-checks.md](crm-static-checks.md) | UNIT（静态） |
| 隔离 OpenClaw 真实 Gateway | [real-openclaw-gate.md](real-openclaw-gate.md) | REAL_OPENCLAW + MOCK MCP |

## 未取得的证据

- REAL_SALESFORCE：尚未对沙盒执行 Apex 测试或真实 MCP 只读调用。
- REAL_BROWSER：尚未在真实 Salesforce Lightning 页面验证 Utility Bar/LWC。
- HUMAN_UAT：未进行。

这些缺口在 `CRM_OPENCLAW_TEST_MATRIX.md` 中逐项标为 `NOT_VERIFIED`，不得用 mock 结果替代。

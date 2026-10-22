# WeCom/CRM MCP Adapter 回归证据（2026-10-22）

工作目录：`D:\GitProject\sfoa-enterprise-mcp\integrations\openclaw\sfoa-wecom-mcp-adapter`

```text
node --test
```

结果：**68/68 PASS**。

## 变更后的边界

- `messageChannel=wecom` + `requesterSenderId` + WeCom 凭据 → `Authorization` + `X-WeCom-User-Id`（既有行为不变）。
- `messageChannel=sfoa-crm` + `requesterSenderId` + CRM 凭据 → `Authorization` + `X-SFOA-CRM-User-Id`。
- 两个渠道的凭据不可互换；非渠道/缺失 sender/缺失凭据一律返回 `null`（不下发 SFOA MCP）。
- 额外上下文字段（`senderId`/`userId`/`from`/`prompt`）不参与身份决策。
- 既有附件桥、并发 1000 次、20 用户 × 50 请求、凭证缺失 60s 用例全部保持通过。

## 说明

适配器仍只替换 MCP transport 的 url + headers；Tool 面、Tool 治理和 Salesforce 权限不变。

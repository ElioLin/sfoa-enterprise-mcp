# SFOA Agent Skill 导出包与 MuleRun 吸收方案

Baseline ID: SFOA-SKILL-EXPORT-1.0 · 2026-09-23 · 分支 `feature/sfoa-skill-export-package`

本方案记录三项工作:对阿里云骡子快跑(MuleRun)`MuleRun_Salesforce-skill.zip` 的评估结论、从中吸收的打包方法论与输出模板的落地实现、以及零凭证 AgentSkills 导出包(`skill:export`)的设计与门禁。**不引入** MuleRun 内嵌的 `smn2gnt/MCP-Salesforce` 服务器,不改变运行时任何 Tool 面、治理边界或审计语义。

## 1. MuleRun skill 评估结论

解包审计(72 个条目)确认:该包是"MCP → Skill"自包含打包产物,内核为开源社区项目 `smn2gnt/MCP-Salesforce v0.1.9`(Python + simple-salesforce,MIT),壳为 `fastmcp generate-cli` 生成的 stdio CLI;凭证走客户端 `.env`(用户名/密码/security_token 或 access_token)。安全扫描无外部回连、无混淆外传,zip 内 `.env` 为空模板。

| 维度 | MuleRun 包 | SFoA 现状 |
| --- | --- | --- |
| 工具面 | SOQL/SOSL、describe、记录 CRUD、Tooling/Apex/REST 透传(10) | Playbook 1.9.0 识别的 15 个治理型 Tool,无 delete/透传 |
| 凭证 | 客户端 `.env` 明文持有 | 服务端 request-scoped identity,客户端零凭证 |
| 治理 | 无 DML policy、无审计 | default-deny Tool/DML governance + P7 Audit |
| 打包 | SKILL.md 工具表 + mcp.json + 完整性校验 + keep-alive 代理 | canonical/生成副本/Runtime 三层已有 |

结论:**功能与 SFoA 高度重叠且治理倒退,不引入运行时;吸收其打包方法论与销售助手输出模板**。其 `delete_record` / `tooling_execute` / `apex_execute` / `restful` 正是本项目 default-deny 治理刻意不暴露的能力。

## 2. 归属确认(原 P0):`.codebuddy/skills/sfoa-salesforce-assistant` 不 canonical 化

调查确认该目录**不是孤儿 canonical Skill**,而是 `yarn agent:sync`(`packages/sfoa-agent-playbook/scripts/sync-generated.mjs`)生成的分发产物,与 `docs/agent/*` 同源,头部带 `GENERATED FROM SFoA Agent Playbook … DO NOT EDIT DIRECTLY` 标记。为其创建 `skills/sfoa-salesforce-assistant/` 会制造第二事实源并破坏 `agent:check` 漂移检测。因此:

- 不新建 canonical 目录;该产物保持由 `agent:sync` 生成、`agent:check` 校验;
- MuleRun 的总结/导航模板并入 `skills/sfoa-crm-core`(业务基础 Skill,"用户输出"本就是其职责,见 [SFOA_OPENCLAW_SKILLS_BASELINE.md](SFOA_OPENCLAW_SKILLS_BASELINE.md))。

## 3. P1:总结/导航模板合入 sfoa-crm-core

新增 `skills/sfoa-crm-core/references/summary-navigation.md` 并由 `SKILL.md` 按需路由。吸收 MuleRun `system-prompt.md` 的结构(变更后按操作顺序输出总结、删除条目删除线+原因、关联 `A <> B` 形式),修正其两个弱点:

| MuleRun 原模板 | SFoA 版 |
| --- | --- |
| 让模型自行拼 `{SALESFORCE_INSTANCE_URL}/lightning/r/...` URL | **MUST** 只用 `get_record_links` / Tool 结果直接返回的可信链接;禁拼 URL、禁读 `.env` |
| `grep SALESFORCE_INSTANCE_URL .env` 取域名 | 该模式在本项目不存在:instance 事实只来自服务端 |

模板同时绑定既有 Hard Rules:总结与逐条 Tool 证据一致(PARTIAL_SUCCESS / OUTCOME_UNKNOWN 不得美化)、删除不被静默省略。

## 4. P2:`skill:export` 零凭证导出包生成器

新文件 `skills/sfoa-mcp-maintainer/scripts/export-agent-skill.mjs`,经 `manage.mjs` 暴露为仓库级动作 `export`,package.json 新增 `skill:export`。设计要点:

- **单一事实源**:工具表由 `packages/sfoa-agent-playbook/src/capabilities.ts` 的 `AGENT_RECOGNIZED_TOOL_NAMES`(15 个,含 infrastructure spread)生成;生成器内置 `TOOL_PRESENTATION` 展示表并做**双向漂移检测**——工具面变化后未更新展示表即报错,绝不静默降级。
- **自包含**:按 maintainer toolkit 惯例直接解析 TypeScript 源码(严格正则,不认识的条目即抛错),不依赖 `yarn build` 产物,clean checkout 可跑。
- **零凭证**:生成 `mcp.json` 只有 `url` 模式指向 SFoA Streamable HTTP 端点(默认 `http://127.0.0.1:8080/mcp`,与测试服务器部署一致),无 `command`、无 `env`;README 明确凭证归属服务端 / `sfoa-wecom-mcp-adapter` 插件(SecretRef)。
- **幂等**:无时间戳,重跑逐字节一致(已实测);输出根 `out/`(已加入 `.gitignore`,产物可再生不入库)。
- **硬边界随包**:身份链、tools/list 权威、UNKNOWN 不自动重试、可信链接来源四条 MUST 写入生成的 SKILL.md。

产物结构(3 文件,刻意最小以便将来整体移除):

```text
out/sfoa-openclaw-package/
├── sfoa/SKILL.md      # 入口 + 硬边界 + 由 capabilities.ts 生成的工具表
├── sfoa/mcp.json      # url 模式连接描述符,零凭证
└── README.md          # 安装到 OpenClaw / 认证归属 / 移除步骤
```

## 5. P3:与既有 OpenClaw 链路的关系及接入方式

测试服务器的业务 Skill 发布**继续走既有链路**(`skill:runtime:sync/check` → `/data/openclaw/workspace/skills/`,见基线),本导出包**不替代**它。导出包面向的场景:仓库 runtime:sync 覆盖之外的独立 OpenClaw 实例或其它 SKILL.md 兼容宿主,需要"带连接描述符的可分发包"。

```bash
yarn skill:export --endpoint http://<sfoa-host>:8080/mcp [--output <dir>] [--server-name sfoa]
```

- 企微身份链:使用 `integrations/openclaw/sfoa-wecom-mcp-adapter` 插件(`mcpUrl` + `mcpWecomClientToken` 走 SecretRef),凭证不进本包。
- **未执行项**:真机 OpenClaw 安装联通验证需要测试服务器环境,本轮仅完成包结构、幂等性与门禁验证;真机步骤见产物 README,验证后应在本文档补记 SHA 与 `openclaw gateway call skills.status --json` 证据(参照基线的验证纪律)。

## 6. 可移除性

将来替换或废弃时:删除 `skills/sfoa-mcp-maintainer/scripts/export-agent-skill.mjs`、`manage.mjs` 中的 `export` 分支、package.json 的 `skill:export` 行、`.gitignore` 的 `out/` 条目,并下架各宿主 workspace 中的 `sfoa/` 包目录即可。canonical Skills、Runtime、数据库、治理配置零改动。

## 7. 门禁记录(2026-09-23 实测)

| 门禁 | 结果 |
| --- | --- |
| `node --test skills/sfoa-mcp-maintainer/scripts/toolkit.test.mjs` | 65/65 PASS(含新增 2 个 skill:export 用例:解析器漂移检测、零凭证/幂等生成) |
| `skill:sync` (crm-core + maintainer) | 三平台副本同步完成,drift: [] |
| `manage.mjs export` 首跑 + 重跑 | ok,15 Tool,Playbook 1.9.0,3 文件逐字节一致 |
| `agent:check` | PASS(5 files) |
| `skill:smoke` | **PASS**,被测 SHA `d197c2112d70bf2c76794c1f576b679fb0a88b5c`,1149 个提交文件从 `git archive` 重建,全部门禁通过(含 65/65 测试;`ai:doctor (missing-env)` 的 FAIL 为预期诊断行为,smoke 只验证 doctor 正确报告该状态) |
| 真机 OpenClaw 联通 | 未执行(需测试服务器,见 §5) |

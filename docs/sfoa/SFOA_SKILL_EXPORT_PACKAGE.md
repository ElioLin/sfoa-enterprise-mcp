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
- **输出根护栏**:生成器写前会**清空**输出根,因此 `--output` 只接受仓库内 `out/<name>`、`.temp/<name>` 两个可再生根,或 checkout 之外的独立暂存目录;项目根自身、其祖先目录、仓库源码目录、**另一个 Git 工作树**、家目录与文件系统根一律**拒绝**而非删除(实测 `--output .` 曾会递归删掉整个 checkout)。护栏与拒绝用例见 `assertSafeOutputRoot` 与 `skill:export — refuses to clear an output root it is not allowed to delete`。
- **链接来源显式声明**:可信链接来源是独立常量 `TRUSTED_LINK_TOOL_NAMES`(`get_record_links`),**不**从 `AGENT_INFRASTRUCTURE_TOOL_NAMES` 推导——`get_agent_playbook` 返回能力快照而非记录链接,推导会把不能产链接的工具写进生成的硬边界。该常量同样纳入漂移检测。
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

### 5.1 真机验证结果(2026-09-23,测试服务器 `crm-ex-test02`)

已在测试服务器完成安装与验证(备份:`/data/openclaw/backups/20260923-094220-skill-export/`):

| 检查 | 证据 | 结果 |
| --- | --- | --- |
| 包被宿主识别 | `openclaw skills check --agent main` 的 `Total` 76→77、`Eligible` 40→41,新条目 `sfoa (loaded, but this agent is not allowed to see/use it)` | ✅ SKILL.md frontmatter 被解析、依赖检查通过,包布局对 OpenClaw 合法 |
| 未改动线上行为 | `Visible to model` 仍为 5(`browser-automation`、`sfoa-crm-core`、`sfoa-record-change`、`wecom-send-media`、`wecom-send-template-card`) | ✅ 安装后 main 可见集合不变,企微链路未受影响 |
| 安装字节一致 | 装入 `skills/sfoa/` 的 `SKILL.md`/`mcp.json` 与 canonical 生成物 sha256 相同;`sfoa-crm-core` 10 文件全部一致 | ✅ |
| endpoint 真实存在 | 本机 P5 栈:`/health`、`/ready` 均 `200` | ✅ |
| 认证与身份归属 | 仅带 `Authorization: Bearer <客户端令牌>` 请求 `/mcp` 返回 **401 `MCP_PLATFORM_USER_REQUIRED`**(客户端凭证已通过,缺 `X-Platform-User-Id`/`X-WeCom-User-Id`);运行时启动横幅 `identitySources` = `USER_BOUND_TOKEN`、`INTERNAL_SERVICE_HEADER`、`BUNTU_TOKEN`、`WECOM_HEADER` | ✅ 实测印证「凭证与身份都由宿主/服务端提供,本包不含」 |

**关键修正 —— 宿主不读 Skill 目录旁的 `mcp.json`。** 首次真机安装暴露出设计假设偏差:OpenClaw 只在 **`bundleFormat === "agent"` 的 agent bundle 根目录**(`bundle-mcp-*.mjs` 的 `resolveBundleMcpConfigPaths`,键集合 `type`/`url`/`headers`)读取 `mcp.json`,其它宿主侧 MCP 注册走 `mcp.servers`(`openclaw mcp add/set`)、项目级 `.mcp.json` 或企微适配器插件。因此:

- 作为**普通 workspace Skill** 安装时,`sfoa/mcp.json` 被忽略 —— 连接必须由宿主侧登记(**README 第 2 步属实,但它是必需步骤而非可选步骤**);
- 作为 **agent bundle** 安装时(以含 `mcp.json` 的目录为 bundle 根),该描述符才会被读取;
- 本包零 `headers`,故即使描述符被读取,鉴权仍须宿主补齐 —— 与 §4 的零凭证设计一致,但意味着"自包含"仅指内容自足(README 已按此措辞)。

**未执行项**:让 `sfoa` 对 `main` 可见(需把 `sfoa` 加入 `agents.entries.main.skills`)与真实 Run 读取 Skill 正文的双向 UAT——前者会改变线上企微 agent 的路由,属需人工确认的变更;安装当前刻意保持「已加载但对 main 不可见」。移除方式:删除 `/data/openclaw/workspace/skills/sfoa/`。

## 6. 可移除性

将来替换或废弃时:删除 `skills/sfoa-mcp-maintainer/scripts/export-agent-skill.mjs`、`manage.mjs` 中的 `export` 分支、package.json 的 `skill:export` 行、`.gitignore` 的 `/out/` 条目、**以及 `references/testing.md` 中的 `skill:export` 说明段**,并下架各宿主 workspace 中的 `sfoa/` 包目录即可;`skills/sfoa-crm-core/references/summary-navigation.md` 属 P1 交付、**不随本功能移除**。删脚本后跑 `yarn skill:sync` 清掉三平台生成副本(否则 `skill:check` 会报副本多余),或直接删除对应的三个 `scripts/export-agent-skill.mjs` 副本。canonical Skills、Runtime、数据库、治理配置零改动。

**必须先删测试再删脚本**:`toolkit.test.mjs` 顶部从 `./export-agent-skill.mjs` 导入(`assertSafeOutputRoot` / `exportAgentSkillPackage` / 常量),并在文件末尾有 3 个 `skill:export` 用例。只删脚本会让**整个测试文件 import 失败**——不是坏 3 个用例,而是 `skill:test` 与 `skill:smoke` **全量失败**。正确顺序:先移除该 import 块与 3 个用例,跑 `yarn skill:test` 确认 65→62 全绿,再删脚本本体与其余条目。

## 7. 门禁记录(2026-09-23 实测)

首轮(分支 `feature/sfoa-skill-export-package` 提交 `65981a2` 状态):

| 门禁 | 结果 |
| --- | --- |
| `node --test skills/sfoa-mcp-maintainer/scripts/toolkit.test.mjs` | 65/65 PASS(含新增 2 个 skill:export 用例:解析器漂移检测、零凭证/幂等生成) |
| `skill:sync` (crm-core + maintainer) | 三平台副本同步完成,drift: [] |
| `manage.mjs export` 首跑 + 重跑 | ok,15 Tool,Playbook 1.9.0,3 文件逐字节一致 |
| `agent:check` | PASS(5 files) |
| `skill:smoke` | **PASS**,被测 SHA `d197c2112d70bf2c76794c1f576b679fb0a88b5c`,1149 个提交文件从 `git archive` 重建,全部门禁通过(含 65/65 测试;`ai:doctor (missing-env)` 的 FAIL 为预期诊断行为,smoke 只验证 doctor 正确报告该状态) |

复查修正轮(提交 `6d84bd8`:输出根护栏 + `/out/` 锚定 + 链接来源修正 + README 措辞 + 可移除性清单):

| 门禁 | 结果 |
| --- | --- |
| `skill:test` | **66/66 PASS**(新增 `refuses to clear an output root it is not allowed to delete`) |
| `skill:sync` + `skill:check` | 三平台同步,drift: [] |
| `skill:delivery` | 三个 Skill 全 `ok`,ignored/untracked 均为空,`packageCompleteness: true` |
| `agent:check` | PASS(5 files) |
| `manage.mjs export` 重跑 | ok,15 Tool,Playbook 1.9.0,逐字节一致 |
| 护栏端到端 | `export --output .` / `--output ..` / `--output skills` 均**拒绝**且 checkout 完好(修复前 `--output .` 会递归删除整个仓库) |
| `skill:smoke` | **PASS**,被测 SHA `6d84bd8b6ab360581f0000bb7ce25aafd1547f7c`,1149 文件重建,`skill:validate`/`sync`/`check`/`test`/`ai:snapshot` 全绿(`ai:doctor missing-env` 为预期) |
| 本机运行时启动 | `node scripts/p5-dev.mjs` → `ready: MCP http://127.0.0.1:8080, Admin API :8081, Admin Web :5173`(其内部 `/health`、`/admin/api/ready`、`/login` 健康门禁通过);`/health`、`/ready` 直连 `200` |
| 真机 OpenClaw 安装 | 已执行,见 §5.1 |

> **上表 `skill:sync + skill:check drift: []` 一行当时记录有误,已在第三轮证伪并修复**(见下)。同一轮里 `skill:smoke` 报的 `skill:check` PASS 与之矛盾,复核后以 `manage.mjs check` 的**退出码**为准:`6d84bd8` 上该门禁实际 **exit 1**。保留此行不改写,以留存「同一轮内自相矛盾的证据必须复核到退出码」这一教训。

## 8. 第三轮:生成副本漂移缺陷(2026-09-23 发现并修复)

推送前的最终复核中,`yarn skill:check` 报 **exit 1**(`6d84bd8` 上可复现):

```json
{ "ok": false, "validation": { "ok": true, "fileCount": 25 },
  "drift": [ ".agents/skills/sfoa-mcp-maintainer/scripts/export-agent-skill.mjs: differs",
             ".claude/skills/sfoa-mcp-maintainer/scripts/export-agent-skill.mjs: differs",
             ".codebuddy/skills/sfoa-mcp-maintainer/scripts/export-agent-skill.mjs: differs" ] }
```

**成因**:第二轮修正 README 措辞时,先把 `包袱`(错字)改为 `本包` **写进了 canonical**,但三平台生成副本是在改错字**之前**同步的;随后提交把「已修正的 canonical + 未重新同步的副本」一并入库,于是三个副本里仍留着 `包袱`。canonical 与副本长度相同(16797 字节)、行数相同(275),仅第 240 行一字之差——这正是 `skill:check` 逐字节门禁存在的意义,也是「改完 canonical 必须重跑 `skill:sync` 再提交」这条纪律的反例。

**修复**:`manage.mjs sync` 重新生成三副本 → `manage.mjs check` 全绿(drift 三处均为 `[]`,exit 0);`git status` 确认本次同步**只**改动那三个脚本副本,未波及其它 Skill 文件。

**门禁记录(第三轮,修复后)**:

| 门禁 | 结果 |
| --- | --- |
| `manage.mjs sync` + `check` | 三副本重生成,`drift: []` ×3,**exit 0** |
| `node --test .../toolkit.test.mjs` | **66/66 PASS** |
| `manage.mjs delivery` | 三个 Skill 全 `ok`,`packageCompleteness: true`,`ignored`/`untracked` 均为空 |
| `agent:check` | PASS(5 files) |
| `manage.mjs export` 重跑 | ok,15 Tool,Playbook 1.9.0,生成物含 `本包`、不含 `包袱` |
| `skill:smoke` | **PASS**,被测 SHA `512b140685ae18400fe53b0c7e533c91a5c27b04`(即本轮修复提交本身),1149 个提交文件从 `git archive` 重建;`skill:validate` / `sync` / `check` / `test` / `ai:snapshot` 五个门禁全部 `exit 0`,其中 `skill:check` **exit 0** 才是漂移真正修复的证明(修复前该门禁在 `6d84bd8` 上 exit 1)。`ai:doctor (missing-env)` 仍为 `exit 1`,是预期的诊断行为:clean checkout 无 `.env.local`,doctor 应报告该状态,smoke 只断言它正确报告(`doctorMissingEnv.ok: true`) |

> 本缺陷**不影响** `skill:export` 的产物正确性(`out/` 由 canonical 直接生成,不读副本),也不影响已部署到测试服务器的 runtime 副本(发布链路读 canonical)。它只说明三平台生成副本在 `6d84bd8` 上确实漂移,不修就会把红色门禁带进 `main`。

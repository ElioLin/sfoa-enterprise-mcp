# 测试服务器部署指南（SFoA Enterprise MCP）

> 本文档基于**实际部署的测试服务器**（`crm-ex-test02` / `192.168.156.203`）归纳而成：目录布局、Nginx 位置、systemd 单元文件、本机打包部署流程、启动/停止/查看日志等命令，均与本次一起完成部署的服务器一致，可直接照抄执行。同时汇总了本次部署过程中踩过的所有坑及对应修复。

---

## 2026-11-12 字段值形态规则（Hard Rule 51）发布到 203（`bbbf53f`）

内容型更新，slug 与配置均未变，因此**没有改 `openclaw.json`**，也不需要重建 MCP：`sfoa-mcp-server` 全程 `PID=3869891` 未动、`/health` 200；只替换 `crm-record-change` 目录并重启网关让新内容生效。

| 项 | 记录 |
| --- | --- |
| 触发 | 203 真实 UAT：4 条记录建单成功、萃取质量可接受，但两个按钮必填被写成 `报告未记录客户品质情况。` / `报告未记录客户对现场管理及制造能力的评价。` |
| 归档 | `crm-rc-bbbf53f.tar.gz`，54,432 B，sha256 `3184abba…b841`，14 个 `.md`；两端哈希一致 |
| 备份 | `/data/openclaw/backups/crm-record-change-pre-bbbf53f-20261112T151124.tar.gz`（52,013 B） |
| 替换 | `git archive` 的多层路径需 `--strip-components=2`；首次用了 1，把内容写成 `crm-record-change/crm-record-change/` 嵌套目录（14 → 28 文件），已删除嵌套层并重新解包 |
| 校验 | `SKILL.md` sha256 `259d07ef…e567`（与本机一致），`^51\. \*\*字段值是业务事实` 命中 1，`references/create-readiness.md` 含「字段值的形态」小节 |
| 网关 | `openclaw-gateway` 3870592 → 3904712，`active`；`openclaw skills check --agent main`：Total 91、Visible to model 7、`crm-*` 四项仍在 |
| 回滚 | 解包上面那个备份覆盖 `workspace/skills/crm-record-change/`，再 `systemctl restart openclaw-gateway` |
| 未做 | 真实企微对话复跑（需用户重发同一份会议记录，观察是否改为一次性追问而不是写入元陈述） |

---

## 2026-11-11 业务 Skill slug 改为 `crm-` 并割接 203（`4747842`）

只发布 Skill 与 OpenClaw 配置，**没有重建或重启 MCP 服务**：`sfoa-mcp-server` 全程 `PID=3869891` 未变，`/health` 200、audit 写入 UP；`sfoa-admin-api`、`nginx` PID 同样未变。

| 项 | 记录 |
| --- | --- |
| 提交 | `4747842` `refactor(skills): rename business Skill slugs from sfoa- to crm-`（229 文件） |
| 归档 | `git archive HEAD skills/crm-{core,record-change,data-analysis,org-diagnostics}` → `crm-skills-4747842.tar.gz`，92,399 B，sha256 `05df370f0ad82935efb2b6fa8790f37f600a1d395cccce230d03acfd0ccbb125`，39 个 `.md`，本机与服务器哈希一致 |
| 备份 | `/data/openclaw/backups/openclaw.json.pre-crm-slug-20261111T130634`（11,756 B）、`skills-sfoa-pre-crm-20261111T130634.tar.gz`（91,484 B）；另有 `openclaw.json.bak-crm-slug` |
| 割接顺序 | 发布新目录 → 改配置 slug → 重启网关 → `openclaw skills check` 通过 → 删除旧目录 |
| 配置改动 | `agents.entries.main.skills` 四项与 `skills.entries` 四个键整体改名；每个旧 slug 在文件中恰好出现 2 次，用 `sed` 定点替换，JSON 重新校验通过，其余键序与格式未变 |
| 网关 | `openclaw-gateway` 3759907 → **3870592**，`active`，`:18789/health` 200；日志只有一条 `[reload] skills snapshot invalidated by config change`，无 error |
| 校验 | `openclaw skills check --agent main`：Total 95 → **91**，Visible to model 仍为 **7**，且四项为 `crm-core` / `crm-data-analysis` / `crm-org-diagnostics` / `crm-record-change`；旧 `sfoa-{crm-core,record-change,data-analysis,org-diagnostics}` 已不再加载 |
| 未纳入本仓库的 Skill | `/data/openclaw/state/agents/main/agent/workshop-skills/` 下仍有 `sfoa-visit-record`、`sfoa-account-360` 等 workshop Skill，`sfoa` 导出包也在；它们本就不在 `main.skills` allowlist 内，本次未改动 |

回滚：恢复 `openclaw.json.pre-crm-slug-*`、解包 `skills-sfoa-pre-crm-*.tar.gz` 回 `/data/openclaw/workspace/skills/`、删除四个 `crm-*` 目录、`systemctl restart openclaw-gateway`。

---

## 2026-11-11 附件暂存上限默认值对齐 50 MiB（`6e5eb3e`）

本次只对齐代码默认值与文档。203 的 `app/.env.local` 自 2026-09-18 起已是 `MCP_ATTACHMENT_MAX_FILE_BYTES=52428800`，显式配置优先，因此**运行时行为没有变化**；重启是为了让源码、dist 与运行进程三者一致。

| 项 | 记录 |
| --- | --- |
| 提交 | `6e5eb3e` `fix(config): align attachment staging ceiling default to 50 MiB` |
| 归档 | `incoming/sfoa-app-6e5eb3e.tar.gz`，4,454,260 B，sha256 `7b6a3f1a650d32cf6fe32e2906704c4cba5331ae670eddbeb4518767a58d566c`；`git -c core.autocrlf=false -c core.eol=lf archive HEAD`，1497 文件，本机与服务器哈希一致，归档内无密钥 / `.env.local` |
| 备份 | `backup/sfoa-app-pre-6e5eb3e-20261111T103927.tar.gz`（11,818,950 B），排除 `node_modules` / `dist` 等产物 |
| 同步 | staging `staging-6e5eb3e-20261111T103927` → `rsync -a --omit-dir-times --no-perms`（**不带 `--delete`**）；`app/.env.local` 保留且仍为 50 MiB |
| 字节校验 | 5 个改动文件 sha256 与本地 HEAD blob 逐一相同（`.env.example`、项目 changelog、集成指南、02C 报告、`config.ts`） |
| 构建 | `yarn workspace @sfoa/mcp-server build` 通过；`dist/config.js` 为 `52_428_800`（TS 保留数字分隔符，文本检索 `52428800` 不会命中，属正常） |
| 服务 | `systemctl restart sfoa-mcp-server`，PID 3864213 → **3869891**，`NRestarts=0`、`active/running`；admin-api 与 nginx 未重启 |
| 健康检查 | `/health` 200（`auditPersistence UP`、`failureCount 0`）、`/admin/api/ready` 200（8.4.5）、nginx `:9000` 200、`MCP_ATTACHMENT_INGRESS_ENABLED=true`；近 3 分钟无 error 级日志 |
| 推送 | **未完成**：本机到 GitHub 的 HTTPS / SSH 均被连接重置，系统无代理，经 203 做 SOCKS 跳板亦超时；提交留在本地待补推（详见本节末尾说明） |
| 未做 | 真实企微 / DSH 业务 UAT；MCP `tools/list` 协议级回归（本次未改工具面与治理配置） |
| 回滚 | 恢复上述备份的 app 源码 → `yarn workspace @sfoa/mcp-server build` → `systemctl restart sfoa-mcp-server`；`.env.local` 不在备份内，保持现状 |

> 补推方式：在可访问 GitHub 的网络环境执行 `git push origin feature/ui-context-requiredness-integrity`。本机无需重新提交。

---

## 2026-11-10 创建/编辑通用流程规则（`a903595`，Skill 1.16.0）

15:57 那轮证明失败不是对象问题而是流程问题：4 条记录**建单即已完成**，页面总结按钮被状态规则隐藏，随后只按猜写了 3 个字段、没有清单也没有追问。

规则改为与对象无关的协议：新增「创建/编辑标准流程」六步（按业务语义选 Record Type、取本次证据、**以起始状态判按钮**、一次汇总值、**整步一次写完**、子表与回读）；规则 46 补「录入状态基准 + 自动化改状态后如实报告剩余项」；规则 47 扩展为**终态字段不进 CREATE**；新增规则 50「一个步骤一次写完」，禁止部分写入后逐步补齐。

| 项 | 记录 |
| --- | --- |
| 门禁 | agent-playbook 48/48、`skill:check` 六 Skill `drift: []` |
| 部署 | 上传 `SKILL.md` + `renderer.ts`，重建 playbook/mcp-server，`runtime-sync` 后重启，PID **3864213**，`/health` 200 |
| 校验 | runtime `SKILL.md` 含「创建/编辑标准流程」，playbook dist 含新段落 |
| 仍未做 | 子表写入的执行层强制；Salesforce 侧「已完成必须写全总结」的 Validation Rule（需用户配置） |

---

## 2026-11-10 按钮可见性求值（`5dd610c`）与一次误判回滚

针对 13:22 那一轮「总结只写了通用 9 项、FRN 三项为空」的问题，改为解析 Lightning 页面 `force:highlightsPanel` 声明的动作及其**自带的 visibilityRule**，按记录真实字段值求值，合并 Salesforce 记录级 actions（后者不套用页面可见性规则）。

| 项 | 实际记录 |
| --- | --- |
| 改动 | `flexipage-parser` 采集页面动作与规则；`precision-standard` 求值 `applicable` 并只返回本对象的字段编辑型动作；契约新增 `applicable/ruleState/source`；Skill 46/47 与 playbook 同步 |
| 门禁 | context 321/321、playbook 48/48、`skill:check` drift [] |
| 部署 | 上传 4 个 context 源文件 + playbook renderer + SKILL.md，重建 context/playbook/mcp-server，重启 PID **3863527**，`/health` 200 |
| 一次误判 | 首次验证用 `a0fC5000001B29BIAS`（Visit-004248），调用 6 分钟后报 `MCP_RECORD_ACTION_CONTEXT_UNSUPPORTED`，据此回滚了线上文件 |
| 回滚后对照 | 回滚到上一版后同一条记录**同样报错**（13 秒），而同日的 `a0fC5000001B4VxIAK` 正常返回。结论：该记录本身无法被 UI API 解析，与本次改动无关；回滚是误判，随后重新部署新版本 |
| 最终验证 | `a0fC5000001B0VZIA0`（Visit-004247，客户来访，计划中，8060）→ `[V] Account_Visit__c.FRN_Visit_Summary (VISIBLE)`、`Cancel_Visit (VISIBLE)`；`EASO/WRN/Visit_Summary` 均 `HIDDEN`。`a0fC5000001B4VxIAK`（已完成，8060）→ 全部总结按钮 `HIDDEN`，与页面规则一致 |
| 已知限制 | 复杂 booleanFilter（引用 `Record.RecordType.DeveloperName` 等）当前求值为 UNKNOWN，如 `Create_Checklist`/`View_Checklist`；这类按钮不会被误判为可用 |
| 备注 | 建议用户把访问记录建为「计划中」再走总结按钮——页面规则要求 Status=计划中，已完成状态下所有总结按钮都不呈现 |

---

## 2026-11-10 记录动作发现（`f81be45` + 装配修正 `c3b87af`）部署

| 项 | 实际记录 |
| --- | --- |
| 归档 | `incoming/sfoa-branch-f81be45.tar.gz`，4,443,383 B，sha256 `c36e336ac9c33bfee1cba46f704ed65a3dc7831609dbaae227dcc800c1cf49e4`，服务器侧一致；staging 1497 文件 |
| 备份 | `/data/sfoa-enterprise-mcp/backup/branch-f81be45-20261110T114130/`（24M）：`app-src.tar.gz` + 三个包的 `dist-*.tar.gz` + `pre-state.txt` + 各次构建日志 |
| 构建 | `mcp-provider-sfoa-context`、`sfoa-agent-playbook`、`sfoa-mcp-server`，首次全部 exit 0；产物含 `availableActions` / `ui-api/actions/record` 标记 |
| 服务 | 首次重启 PID **3860431**；修正后重启 PID **3860779**，`/health` 200 |
| Runtime Skill | `runtime-sync` 成功，四个业务 Skill `drift: []`；规则 46–48 已进 runtime（按钮动作优先、缺失必填的询问与「无」确认、子表按真实结构落地） |
| 首次验证失败 | 部署后 `formContext.actionsEvaluated` 为 `undefined`：`resolveStandardForm` 已计算，但 `resolvePreciseForm` 用固定字段列表装配 `report`，把新字段丢了 |
| 修正方式 | 补 `StandardFormResult` 字段 + 装配处 `Object.assign`；只上传 `precision-standard.ts` / `precision-executor.ts` 两个文件后重建 context 与 mcp-server（未再走整包 rsync，避免用 staging 覆盖修正） |
| 修正后验证 | `availableActions=6`、`actionsEvaluated=true`；`[E] Account_Visit__c.Visit_Summary（总结）`、`[ ] Account_Visit__c.Add_Participant（添加参与人，target=Visit_Participants__c）`、`Global.NewTask`、`fileUpload`、`Edit`；以 `Visit_Summary` 解析返回 `NEEDS_INPUT`，`missingRequired` 含客户现有市场情况、市场/行业信息、我司机会点、现场管理评价、其他、客户变动信息 |
| 未做 | 真实企微端到端复测（待用户执行）；快照刷新；Salesforce 写入（本次仅只读 UI API） |
| 回滚 | 恢复 `backup/branch-f81be45-20261110T114130/app-src.tar.gz` 与三个 `dist-*.tar.gz` 后重启 |

---

## 2026-11-09 可选表单修复分支部署（`feature/ui-context-requiredness-integrity` @ `561614d`）

部署客户来访漏填必填字段的修复：简档名 `%2F` 编码导致的记录类型页面失配、`requirednessIncomplete` 硬信号、precision 默认路径、快照刷新超时可配置。**未执行快照刷新**（由用户自行验证）。

| 项 | 实际记录 |
| --- | --- |
| 归档 | `incoming/sfoa-branch-561614d.tar.gz`，4,428,789 B，sha256 `ed7e14cf0cb5a373299b28b69f000f7789be97b6ef2d601135c882dfcf4fa08e`；`git -c core.autocrlf=false -c core.eol=lf archive` 生成，服务器侧 sha256 与本地一致；staging 1497 文件 |
| 备份 | `/data/sfoa-enterprise-mcp/backup/branch-561614d-20261109T181254/`（25M）：`app-src.tar.gz`（排除 node_modules/dist）、5 个包的 `dist-*.tar.gz`、`pre-state.txt`、`rollback.sh` |
| 同步 | `rsync -a --omit-dir-times --no-perms STAGE/ app/`（无 `--delete`），未删除任何文件 |
| 构建 | `sfoa-control-plane` → `mcp-provider-sfoa-context` → `sfoa-mcp-server` → `sfoa-admin-api` → `sfoa-admin-web`（tsc + vite），全部 exit 0；产物时间 18:13，含新标记 `PRECISION_FALLBACK_LEGACY_CONTEXT`、`SNAPSHOT_REFRESH_TIMEOUT_`、`requirednessIncomplete`、`leaseMs` |
| 服务 | `sfoa-mcp-server` PID **3857828**（18:16:54）、`sfoa-admin-api` PID **3857842**（18:16:58），`NRestarts=0`；`/health` 200、`/admin/api/ready` 200、nginx `:9000` 200，新前端包 `assets/index-BMNbxYY8.js`，2 分钟内无 error 级日志 |
| Runtime Skill | `manage.mjs runtime-sync/check`：四个业务 Skill 全 `ok:true`、`drift: []`；`crm-record-change/SKILL.md` sha256 `87febe20…`，规则 44「必填性未证明即不得提交」已在 runtime；`openclaw skills check`：Total 91 / Eligible 55 / Visible to model 7 |
| 功能验证 | MCP `initialize` 后 `tools/list` = **29**；`get_record_action_context`（`Account_Visit__c` / 客户来访 / **不传 formContext**）→ `formContext.entry=STANDARD`、`phase=START`、`app=FRN_CRM_PC`（Profile 默认）、`page=**ComeTo**`、`formSource=DYNAMIC_FORMS`，`uiContext` 不存在（未走快照）；`missingRequired` 含 **就餐安排 `Restaurant_Schedule__c`、酒店安排 `Hotel_Schedule__c`、行程计划 `Route_Plan__c`**，`requiredCount=13`；`visit_route_text`/`matters` 在销售组织 8060 下正确为 false。`status=UNKNOWN` 属预期（必填未填 + `Source__c` 未定导致 Lead/Opportunity/Account 条件必填 UNKNOWN） |
| 新增配置 | 无需手工改配置：`SFOA_PRECISION_DEFAULT_FORM_CONTEXT` 默认 `true`、`SFOA_UI_SNAPSHOT_REFRESH_TIMEOUT_MS` 默认 `180000` 均已在代码内默认。实测 203 单次 `collectUiSnapshot` **159s**（其中单次 Metadata 读 136s），旧的 120s 常量必然超时 |
| 未做 | 快照刷新（用户自测）；真实企微/DSH 端到端业务 UAT；Salesforce 写入（本次仅只读 UI API 调用） |
| 回滚 | `bash /data/sfoa-enterprise-mcp/backup/branch-561614d-20261109T181254/rollback.sh`（停服 → 解回 app 源码与 5 个 dist → 启动），未演练 |

**部署后追加（18:50）**：企微实测仍未追问三个必填字段。审计显示该会话只调用了 `run_soql_query` 与 `create_record`（审计 10061–10064），**从未调用 `get_record_action_context`**，落库记录 `a0fC5000001AyiHIAS` 的三个字段为空；而同一时段的不传 `formContext` 验证调用（10060）已返回 `missingRequiredCount=9` 含这三个字段。结论是智能体跳过了取证步骤，不是运行时缺陷。据此在 `crm-record-change` 增加 Hard Rule 45（CREATE 前必须有本次表单证据，显式禁止「同一会话前面查过」式复用），已同步 app 与 OpenClaw runtime（`SKILL.md` sha256 `dcc89cf9…`，四个 Skill `drift: []`）。

---

## 2026-11-09 业务 Skill 中文显示名发布（203）

四个业务 Skill 增加 `display_name` / `display_name_en` 与中文 H1（提交 `4fc8465`），并发布到 203 的 OpenClaw runtime。

| 项 | 实际记录 |
| --- | --- |
| 备份 | `/data/openclaw/backups/20261109-133422-skill-display-name/`：4 份 runtime 目录 + 4 份 app `SKILL.md`，回滚即 `cp -a` 回去 |
| 上传 | 4 个 `SKILL.md` 经 `ssh 'cat >'` 写入服务器 `/tmp/sfoa-skill-new/`，服务器与本机 sha256 逐一相同（`520394b6…`、`fd0bcdc0…`、`f8b80513…`、`1860ccff…`），无 CRLF 污染 |
| app 树 | 覆盖 `app/skills/<name>/SKILL.md`，hash 与本机一致 |
| Runtime | `node skills/sfoa-mcp-maintainer/scripts/manage.mjs runtime-sync --runtime-root /data/openclaw/workspace/skills`；`runtime-check` 四个 Skill 全 `ok:true`、`drift: []`；runtime `SKILL.md` 与新 canonical 逐一 hash 相同 |
| 可见性 | `openclaw skills check --agent main`：Total 91 / Eligible 55 / **Visible to model 7**（`browser-automation` + 四个业务 Skill + `wecom-send-media` + `wecom-send-template-card`）；四个业务 Skill `eligible=true`、`modelVisible=true` |
| **关键结论** | **OpenClaw 2026.9.5 不解析 `display_name`**：`skills.status` 返回的字段清单（`always/baseDir/blockedByAgentFilter/…/description/disabled/eligible/filePath/install/missing/modelVisible/name/...`）不含任何 display 字段，91 个 Skill 中带显示名的为 **0**；`dist/frontmatter-*.mjs` 只识别 `always`/`homepage`/`emoji`/`userInvocable`/`metadata`。因此 OpenClaw 侧列表仍按 `name`（slug）显示，中文名只在支持该字段的宿主生效（WorkBuddy 已安装 Skill 普遍使用 `display_name`） |
| 未做 | DSH / WorkBuddy 选择器 UI 实测未执行；`description` 触发词未改；本次未重启 Gateway（正文变更按既有语义热读取），也未改 `agents.entries.main.skills` |
| 回退 | 恢复 runtime：`cp -a /data/openclaw/backups/20261109-133422-skill-display-name/runtime-<name> /data/openclaw/workspace/skills/`；恢复 app：用同目录 `app-<name>.SKILL.md` 覆盖回 `app/skills/<name>/SKILL.md` |

---

## 2026-11-06 精确创建/编辑表单测试部署

`codex/record-change-precision@94f1833` 已部署到 203，MCP/Admin Web/四业务 Skill 与独立 `sfoa` 为 Playbook **1.14.0**。服务器源码 1496 文件无漂移，精确表单专项 101/101、Skills 88/88；实际 29 个工具，五个相关工具增加可选 `formContext`，其余工具输入契约不变。Gateway 未重启；新会话完整读取两份新版记录变更指导。没有新增迁移、未执行 Salesforce 写入。发布中因浏览器探针错误输出包含临时 Admin Cookie，已只轮换管理会话签名密钥，旧签名会话 401，新登录/退出 200；后台需要重新登录。详见[部署与回滚记录](RECORD_CHANGE_PRECISION_DEPLOYMENT_20261106.md)，不以部署检查替代真实业务 UAT。

## 2026-11-06 HOTFIX-01 材料工作流部署（203）

部署 `feature/agent-material-workflows` @ `b459e8b1fb348eeea95f58c9a4c698f19e22f8ba`（HOTFIX-01）。部署前 203 为 core `1f060ed` + Playbook **1.13.2** + Adapter `9c4fda9`；本轮推进到 Playbook **1.13.3**、Adapter `b459e8b`、四业务 Skill 与独立 `sfoa` 1.13.3，并重打 Admin Web。**真实企微 / Salesforce 业务 UAT 本轮未执行**；以下仅为协议、构建、字节与可见性验证。

| 项 | 实际记录 |
| --- | --- |
| 归档 | `/data/sfoa-enterprise-mcp/incoming/sfoa-app-b459e8b.tar.gz`，4,282,741 B，sha256 `9958e79551af9f563cf8c1d27b2d66b7672cbee5651b926c4266b2c0dcf02616`，1460 个 tracked 文件；`git -c core.autocrlf=false -c core.eol=lf archive` 生成，staging 与 app 的 `sha256sum -c` 均 **1460 OK / 0 non-OK**；`packages/mcp/README.md` symlink 保留（`../../README.md`） |
| 备份 | `/data/sfoa-enterprise-mcp/backup/material-hotfix01-20261106T091634-b459e8b/`（24M）：app 源码（排除 node_modules/dist）、agent-playbook/mcp-server/admin-api/admin-web 四个旧 dist、实际 adapter、五份 runtime Skill、registry 快照、`pre-state.txt`/`post-state.txt`、`rollback.sh`（未演练） |
| 构建 | 按依赖序重建 `@sfoa/agent-playbook`（1.13.3）、`@sfoa/mcp-server`（含 `onFileResult?.(observed)`）、`@sfoa/admin-api`、`@sfoa/admin-web`；日志 `build-*.log`。未重装依赖、无新迁移（017 已于 11-05 APPLIED） |
| 服务 | `sfoa-mcp-server` / `sfoa-admin-api` 重启：PID **3845239 / 3845252**，`ActiveEnterTimestamp` 09:18:07 / 09:18:12，NRestarts=0；`/health` 200（auditPersistence UP，failureCount 0）、`/admin/api/ready` 200（8.4.5）；Gateway PID **3759907**、nginx PID 1267856 未重启 |
| Adapter | `openclaw plugins reload sfoa-wecom-mcp-adapter` 成功：generation **4**、`restartRequired=false`、source digest `7f1f641215cbd7d69e4ff31f4f3b9a0848f556272ba038cd930882f24e130510`。落盘 hash：`src/index.js` `7fcdc7e0…`、`material-tasks.js` `9999b0d4…`、`native-reading.js` `b015160a…`、`read-office.py` `a58b3250…`、`openclaw.plugin.json` `be611e34…`（与 9c4fda9 相同，未触发新 capability consent）；Gateway 日志显示 attachment bridge 与 requester resolver 重新注册 |
| Runtime Skill | `skill:runtime:sync/check --runtime-root /data/openclaw/workspace/skills`：四个业务 Skill 与 canonical `diff -r` 全部 IDENTICAL、`drift: []`；`crm-record-change/SKILL.md` 更新为 `11a57370…`；`sfoa` 导出重生成 **1.13.3**（`SKILL.md` `5ae5b733…`），既有 `mcp.json` hash `3279fe3b…` 未变；`skills.status` 四个业务 Skill `eligible/modelVisible=true`，`sfoa` eligible=true/modelVisible=false，maintainer 不在 runtime |
| MCP 协议 | initialize 200、protocolVersion `2025-06-18`、instructions 4950 字符且含 **1.13.3**、不含 1.13.2；tools/list **29**；`upload_files_to_record` 输出含 `retryable`，`get_record_action_context` 输入含 `includeValueAssessment`。使用控制面内部 enabled 路由注入 `X-Platform-User-Id`，日志仅保留 route id 与掩码 `61***79`，未打印工号 |
| Admin Web | 新包 `index-DQlDgH9N.js` / `AgentIntegrationPage-Ty3qH7HN.js`（含 **1.13.3**）；nginx `:9000/`、`/agent-integration`、`/admin/api/ready` 均 200；`chown -R root:root` + `restorecon -Rv dist`，`index.html` 为 `httpd_sys_content_t` |
| 配置/迁移 | `.env.local` sha256 `235f2465…`、`openclaw.json` sha256 `863b33d1…`，部署前后一致；迁移台账仍 001–015 + **017 APPLIED**，未执行 `db:migrate` |
| 服务器专项 | 部署树 Adapter 材料/原生读取测试 **46/46 PASS**（material-tasks 26 + native 11 + material-reader 9）；本机同一源码 bridge 25/25、material/native 37/37 PASS |
| 未做 | 真实企微多轮材料、真实 Salesforce CREATE/UPDATE/上传、PDF/图片/音频原生覆盖回写、归档 ACCEPTED+materialIds、跨 Gateway 重启持久化均未在本轮验证；不把协议/构建 PASS 当业务 UAT |
| 回滚 | 审阅后执行上述备份内 `rollback.sh`：停 MCP/Admin → 解回 app 源码与四个 dist → 解回 adapter 与五份 runtime Skill → `chown/restorecon` → 启动两服务 → `openclaw plugins reload`；不恢复 registry 快照（其他插件可能已有新状态），不撤销 Salesforce 写入或重放未知操作 |
| 既有告警 | `openclaw plugins inspect/reload` 仍显示 legacy agent migration `EXDEV` 警告；属既有环境问题，本轮未运行 `doctor --fix`，未改配置 |

### 2026-11-06 Prompt 字段最小化补丁（a21e679）

| 项 | 实际记录 |
| --- | --- |
| 提交 | `a21e679a271a806998a5d1b439c1de0cfc007c65` `fix(adapter): keep host identity and staging paths out of model views`；3 文件：`src/material-tasks.js`、`test/native-reading.test.js`、`README.md` |
| 行为 | 模型可见的 prompt 与 `sfoa_material_task` 结果改为业务事实白名单；不再包含 `sessionKey`/`sessionId`、`sourcePaths`、`ownerRequester`、`sourceMessages`、`sourceMessageId`、`receipts`。宿主 registry 仍保留这些字段用于证据绑定/清理；`details.taskId` 保留（`new_task` 绑定需要），选中材料的 `reading.text` 仍按需返回 |
| 落盘 | app 与 `/data/openclaw/plugins/sfoa-wecom-mcp-adapter` 同步；`material-tasks.js` `35b13f72…`、`native-reading.test.js` `daebb9e1…`、`README.md` `74b09d31…`；CR=0 |
| 热加载 | `plugins reload` generation **5**、`restartRequired=false`、source digest `f1db4d2c46b6eae3ca3f68abc723b33c7f37ce31ffdf0042391f598408ff0a3b`；Gateway PID 3759907 未变；bridge/resolver 重新注册 |
| 验证 | 服务器部署树 material/native 测试 **37/37**；直接渲染证明 prompt 与 tool view 中 `woSECRETUSER`、`/data/openclaw/state`、`ownerRequester`、`sessionKey`、`sourcePaths`、`sourceMessages` 均 absent；`taskId` 保留、未选材料正文不返回、选中材料正文返回。本机 material/native/bridge **62/62** |
| MCP/Admin | 未重建、未重启（3845239/3845252 不变）；Playbook 1.13.3、29 tools、四业务 Skill/`sfoa` 1.13.3 不变 |
| 备份/回滚 | `/data/sfoa-enterprise-mcp/backup/prompt-minimization-20261106T093553-a21e679/`：pre `material-tasks.js` `9999b0d4…`、pre test `808070d1…`、pre README `1752e9fd…`、`rollback.sh`（未演练）；回滚恢复预补丁文件并热加载 |
| 未做 | 真实企微/Salesforce 业务 UAT 未执行；字段最小化只改变模型可见视图，不改变宿主证据与写入授权 |

---

## 2026-11-05 材料工作流测试部署（203）

后续核对发现 Admin Web 仍在提供 10 月 29 日的 Playbook 1.12.0 静态包；此前的 1.13.2 证明覆盖服务端和运行 Skill，未覆盖管理前端。已补发 `index-3O0UrNe6.js` / `AgentIntegrationPage-C9ZxVunh.js`，11:40 实际浏览器确认页面与 Dify/WeCom 生成文本均为 1.13.2；Linux 全量 95/95，四服务 PID 未变。备份及回滚：`/data/sfoa-enterprise-mcp/backup/admin-playbook-1132-20261105T033105Z/rollback.sh`，未演练。四业务 Skill 38 文件与 Git 一致，独立 sfoa 导出正文一致。完整遗漏、失败保留、本地跨分支开发库处理及验证/回滚见[启动与版本修复记录](STARTUP_AND_PLAYBOOK_REPAIR_20261105.md)。历史记录保留，不能将服务端版本视为前端已同步的证明。

10:44:41 最新 Adapter `9c4fda90815e924040ab3c5e6439f5cfa5f39776` 已通过官方 `plugins reload` 热加载，generation=3，source digest `f73640bebc71158d6e3e659e1443e0b284cb122f2530dd954aaa7536231937f3`，无需重启，PID 仍 3759907。app/plugin `src/material-tasks.js` SHA256 `3813eee90b764f216562cd34499ffb9a212331b6e7a38f74d199a0e73fb21618`。首次因缺少 capability consent 被拒绝并恢复旧源码；审阅新旧 declared surface 完全相同后，在已有部署授权内用官方选项登记，未新增危险标志或更改会话访问配置。备份及回滚 `/data/sfoa-enterprise-mcp/backup/adapter-task-notes-20261105T024435Z-9c4fda9/rollback.sh`，含私密配置和插件登记库在线备份。配置/凭据文件校验未变。10:47 真人 E3 证明同任务九材料保留、阶段 COMPLETE、拒绝归档及目标隔离；不能据此宣称 Gateway 重启持久化。详见续测报告。

09:58:59 后续状态观察修复：实际 Adapter 为 `72eeb22512ebb29f0c275097836b88eafba060d9`，app/plugin `src/index.js` SHA256 均为 `5fdd2febdb9a13cbb7fb30a4612bb15f4fac53643cd1948828d133755c81278c`；Gateway PID `3759907`。备份及回滚 `/data/sfoa-enterprise-mcp/backup/adapter-prompt-run-20261105T015858Z-72eeb22/rollback.sh`，回到连接有效但状态观察失败的 20ea，未演练。新实现用提示词阶段的可信身份绑定完成事件，09:59 实际注册、10:01 真人企微只读查询/记目标/再读回均已核对；后者有 2 次 USER/WECOM_HEADER P7 成功，无 Salesforce 变更。20ea 于 09:28 部署后的 09:35 状态失败保留。当前安装方式仍无可用 keyed store，跨重启原材料 ledger 不算恢复。新源码归档显式关闭 autocrlf；预检曾因未覆盖测试文件的换行 hash 差异拦下，未改变服务，核实旧 Git blob 后再部署。配置、凭据、核心、Playbook 保持原值。

08:54 后续 Adapter 修复：实际插件与 app 已加载 `b613ae47832cfbeb1e5b11781f18c77df849f804`，`src/index.js` SHA256 `5e33fd6944e09d6515f412da34621eaeb2103e08e845d6f49e9b47bfc13a03c8`。本地路径插件打开 keyed store 被 OpenClaw 拒绝时，不再回滚请求身份解析器；宿主任务工具补齐 manifest 合约。只重启 Gateway，新 PID `3298469`，实际注册日志与 09:03、09:07 真人企微只读请求均已核对。配置和 `.env.local` 保持一致，核心及 Playbook 未改。备份 `/data/sfoa-enterprise-mcp/backup/adapter-store-denial-20261105T005439Z-b613ae4`；该回滚恢复旧故障版本，未演练。完整原因、内存状态限制和后续验收见[续测报告](AGENT_MATERIAL_WORKFLOWS_ACCEPTANCE_FOLLOWUP.md)。下面的 PID 为早先部署时记录。

最新状态：`94aa6612c72a8ba0d8a6fff3ad3548cf67a5d2a9` 的 Playbook **1.13.2** 已加载。18/18 文件预检及落盘匹配，LF 归档 SHA256 `9c439f00cf91afa48494424e657db0600d7f618d00e4d44b4d5773181acf7b8f`；备份及回滚 `/data/sfoa-enterprise-mcp/backup/guidance-1132-20261104T175035Z-94aa6612/rollback.sh`。MCP/Admin/Gateway PID `3040205 / 3040291 / 3040184`，健康/ready UP，配置/依赖/DB 未改。实际 tools/list 仍 29 项；四业务 Skill hash 匹配，新 Gateway run `614c7c46-32a6-42e4-9eaa-7da30fe2c943` 读回完整 Skill/材料引用。下列 1.13.1 部署记录作为历史保留。

- 核心 runtime `1f060ed5bd5104ebb7b1b7995bd58a8b9988aa32` 已加载，迁移 017 已应用；备份 `/data/sfoa-enterprise-mcp/backup/material-workflows-20261104T162153Z-1f060ed5`。
- 后续指导/验收工具候选 `5c1558ce26d7a4b56a0e1695bca7544801d00191`，Playbook **1.13.1**；LF 归档 SHA256 `ee4465718a2dda14bc7afd8aabfb71b2c1ac9cefa068c920e2d3ad5f935788c9`。38 文件经旧/新 hash 预检、备份、非删除覆盖；只重建 Playbook，未改依赖/配置/DB。备份和可执行回滚：`/data/sfoa-enterprise-mcp/backup/guidance-harness-20261104T171352Z-5c1558ce/rollback.sh`。
- 四业务 runtime Skills、独立 `sfoa` export、Dify/WorkBuddy/WeCom 生成物分别校验；独立导出保留原 `mcp.json`。实际插件仍加载 `/data/openclaw/plugins/sfoa-wecom-mcp-adapter/src/index.js`，hash `9b17eec23d989acac9f502cfc85c62bbdbb98d78e49a6d687a36b53765580f1f`。
- 补丁后 MCP / Admin / Gateway PID 分别 `3029640 / 3029725 / 3029618`，健康/ready UP。实际工具发现仍 29 项，直接创建/更新/批量/附件输入 schema 未变；Context 的 `includeValueAssessment` 为可选，实际 Playbook 返回 1.13.1。
- 首次核心构建的 Admin mock 缺方法已修复并曾实际回滚；后续补丁 CRLF 归档与旧 CHANGELOG 字节差异分别被预检拦下，未越过门禁。打包必须保留 §3.1 的 `core.autocrlf=false`，不以归档外层 hash 代替逐文件 Git blob 比对。
- 完整证据、失败、业务边界和分层回滚见 [交付报告](AGENT_MATERIAL_WORKFLOWS_DELIVERY.md)。真实 Salesforce 当前测试材料与活动校验冲突，真人企微未验；服务健康和原始文件读取不等于业务验收。

017 回滚必须先判断实际 ledger/schema：未应用时将新添 SQL 移入备份后再启旧 runtime；已应用时保留追加 schema 与 UNKNOWN/成功事实，不恢复旧附件表。旧 runtime 不清理新增状态，须保留兼容清理或按原 TTL 安排原件清理。源码回滚不撤销 Salesforce 写入，也不重放未知操作。

## 2026-11-03 CREATE 敏感身份字段查重 Skill 发布（203）

| 项目 | 实际记录 |
| --- | --- |
| 变更 | `crm-record-change` 新增 Hard Rule 42：CREATE 前对名称 / 电话 / 手机 / 邮箱 / 证件号 / 外部 ID 等敏感身份字段做有界查重；强键或名称命中先告知用户并由用户选择继续新建 / 改为更新 / 取消，0 行不证明全库唯一；新增 `references/duplicate-check.md`，并接入 `create-readiness.md`、`readiness-gate.md`、`phone-and-mobile.md`；维护侧增加可执行 gate + 测试 |
| 变更性质 | 仅 Skill 正文 / 引用与维护侧测试；无 MCP / Admin / OpenClaw 运行时源码变化、无迁移、无配置变化 |
| 归档 | `sfoa-skill-create-dedup-20261103-160107.tar.gz`（43,477 B，sha256 `4c3fbceff72753b4a0d355503cd1b165547c6d0358087a4a3b732ad5ba1a0781`，LF 归一，13 文件） |
| 备份 | runtime：`/data/openclaw/backups/20261103-160107-skill-create-dedup/crm-record-change/`（12 文件旧版）；app：`/data/sfoa-enterprise-mcp/backup/sfoa-app-skill-record-change-pre-20261103-160107.tar.gz`（38,661 B） |
| 落盘 | 解到 `/data/sfoa-enterprise-mcp/staging-skill-create-dedup-20261103-160107`，`rsync -a` 覆盖 `app/skills/crm-record-change`；未删除任何文件；app 与 staging 文件集一致 |
| 字节验证 | 未改动引用（batch-mutations / dynamic-forms / file-attachments / lookup-and-picklist / managed-lookups / material-and-related-fields / outcome-reconciliation / update-readiness）sha256 与服务器旧版逐一相同；变更文件为 `SKILL.md` `04182a…`、`create-readiness.md` `23fea8…`、`readiness-gate.md` `84aeaf…`、`phone-and-mobile.md` `1916fa…`、新增 `duplicate-check.md` `803aad…` |
| Runtime Copy | `yarn skill:runtime:sync --canonical skills/crm-record-change --runtime-root /data/openclaw/workspace/skills` → 13 文件；`runtime:check` `ok:true` / `drift:[]`；runtime `SKILL.md` sha256 `04182a…` |
| OpenClaw | `openclaw skills check --agent main`：`crm-record-change` 可见；`openclaw gateway call skills.status --json`：`eligible=true`、`modelVisible=true`；Gateway PID 2996434 未重启（正文变更按既有语义热读取） |
| 服务 | `sfoa-mcp-server` / `sfoa-admin-api` / `openclaw-gateway` / `nginx` 均 active；未重建、未重启 |
| 权限 | 发布后 app / runtime Skill 目录 755、文件 644（避免归档带入 666） |
| 回滚 | 恢复 runtime：`cp -a /data/openclaw/backups/20261103-160107-skill-create-dedup/crm-record-change /data/openclaw/workspace/skills/`；恢复 app：解回 app 备份 tar；无需重启服务 |
| 未做 | 未做真人企微 CREATE 重复提示 UAT；维护侧 gate / 测试仅在本仓库，未同步到服务器 app；未部署 Playbook / Dify / WorkBuddy 指令文档（本次只更新 OpenClaw Skill） |

---

## 2026-11-03 OpenClaw `ask_user` 全局关闭（203）

| 项目 | 实际记录 |
| --- | --- |
| 背景 | 11-02 的企微回答桥在真人 UAT 中 `question.resolve` 报 `missing scope: operator.questions`；回复落回 `Chat task queued` 造成二次提问，`ask_user` 卡住会话 10 分钟（`question.waitAnswer 599994ms`）。 |
| 变更 | `openclaw config set tools.deny '["ask_user"]' --strict-json`，全局 deny；`tools` 前缀为 `hot` 重载，`openclaw-gateway` PID 2996434 未重启，无企微断连。 |
| 验证 | `openclaw config get tools.deny` = `["ask_user"]`；隔离会话探针回复 `ASK_USER_UNAVAILABLE`；`openclaw-gateway`/`sfoa-mcp-server`/`sfoa-admin-api`/`nginx` 均 active。 |
| 备份 | `/data/openclaw/backups/20261103-111225-askuser-deny/openclaw.json`。 |
| 保留 | 企微回答桥补丁保留但休眠；未改 `AGENTS.md`；以后要用从 `tools.deny` 移除，并给桥补 `{ scopes: ['operator.questions'] }`。 |
| 未做 | 真人企微“缺字段→正文追问”UAT。 |

## 2026-11-03 P0 归属人解析 + 电话区号省份推断（203）

| 项目 | 实际记录 |
| --- | --- |
| 变更 | Playbook/`crm-record-change`：显式“以 X 的名义/归属 X”必须先取 `get_record_action_context`，按托管字段的 `referenceTo` 确定目标对象（不默认 `User`），解析 X 的唯一 ID 写入托管字段，禁止用 `OwnerId` 代替；座机区号/明确地址/公司所在地确定城市时同时推断省份/国家，手机号不推断地域。 |
| 部署 | 备份 `/data/sfoa-enterprise-mcp/backup/p0-owner-geo-20261103-114254/`；替换 app 的 `packages/sfoa-agent-playbook/dist`；`skill:runtime:sync` 同步 `crm-record-change`（12 文件）；`systemctl restart sfoa-mcp-server` 后 PID 3002025（最终版本）、`/health` 200；`openclaw mcp reload` 已执行。 |
| 验证 | `dist/definition.js` 含 `landline area code`/`do not assume User`；`dist/renderer.js` 含 `不得只填城市`/`referenceTo`；runtime `phone-and-mobile.md` 含 `手机号本身不含地域`；四服务 active。 |
| 未做 | 真人企微“以郑燕军的名义新建→`Lead_Owner__c`（预期 Contact `003C5000004wEeRIAU`）”与“0592→福建省/厦门市”UAT。 |

## 2026-11-02（下午）WeCom ask_user 回答桥 + 归属人意图

| 项目 | 实际记录 |
| --- | --- |
| 背景 | OpenClaw `ask_user` 在企微只发送文本回退；企微回复 `1` 被当作新聊天任务排队（日志 `Chat task queued`），没有进入 `question.resolve`，随后被当成新消息再次触发问题。 |
| 补丁位置 | `/data/openclaw/state/npm/projects/wecom-wecom-openclaw-plugin-18f843d908__openclaw-generation__g-8f3a4349afa261a8/node_modules/@wecom/wecom-openclaw-plugin/dist/src/`：新增 `question-bridge.js`（sha256 `7807d603…`），并改 `monitor.js`（`dfb905d4…` → `9eee0f92…`）。备份 `backup/p0-field-inference-20261102-114641/wecom-monitor.js.pre-question-bridge`。 |
| 桥逻辑 | 从 outbound `channelData.askUser` 记住 `questionId`/`optionValues`（按 accountId+chatId，TTL 15 min）；inbound 文本先匹配 `1..N` 或选项 label，命中则调用 `getWeComRuntime().gateway.request("question.resolve", { id, answers:{answers:{[questionId]:[value]}}, resolvedBy })`，不再入 chat 队列；已 terminal 的迟到数字回复丢弃，避免二次提问。离线测试 `1` → `question.resolve` 参数正确。 |
| 补丁生效 | `systemctl restart openclaw-gateway`：PID 2996434，16 plugins 加载，企微 WebSocket `Authentication successful`；`mcp reload` 已执行。补丁属于第三方插件本地修改，**插件重装/升级会丢失**，复发先核对 `monitor.js` sha256 与 `question-bridge.js` 是否存在。 |
| 归属人意图规则 | Playbook + `crm-record-change` 增加：用户说“以 X 的账号/归属 X”时不切换认证身份；若 `managedDmlFields` 有可用户指定的归属字段（如 `PLATFORM_USER_LOOKUP_FALLBACK`），把 X 解析为目标 Lookup 唯一 ID 并写入该字段，**不得改用 `OwnerId`**；没有可指定字段/严格 `PLATFORM_IDENTITY` 时明确告知只能按当前身份执行。 |
| 部署 | 工作树归档 sha256 `30e1abeb…`；重建 agent-playbook/context/mcp-server；`sfoa-mcp-server` PID 2997098，`/health` 200；runtime `crm-record-change` 已同步（`managed-lookups.md` 含 OwnerId 规则），`skills.status` eligible/modelVisible true。 |
| 未做 | 真人企微提问→回复 `1` 的端到端 UAT；归属人字段实际解析（陈俊杰 4 条同名 Contact 需先消歧）；插件补丁未纳入仓库。 |

## 2026-11-02 P0 字段推断与手机/电话规则（203）

| 项目 | 实际记录 |
| --- | --- |
| 部署内容 | `feature/p0-agent-field-inference` 工作树（基于 `769ec8d`，未提交）：`get_record_action_context` 的 `includeRequiredness`/`requirednessSource`/`requiredChecklist`/`writable`/`omittedFieldCatalog`；Playbook 与 `crm-record-change` 的 Requiredness Source、Explicit Fact Coverage、手机/电话中国大陆规则；无 DB 迁移 |
| 服务器基线 | 部署前 10 个受影响源文件与 `769ec8d` git blob 的 sha256 全部一致（LF）；服务器源码未含未预期改动 |
| 备份 | `/data/sfoa-enterprise-mcp/backup/p0-field-inference-20261102-114641/`：`app-source-affected.tar.gz`（context/playbook 源码 + 三个包 dist + canonical record-change Skill）与 `openclaw-runtime-crm-record-change.tar.gz` |
| 归档/落盘 | 本机 LF 归一化后 `p0-deploy-20261102035357.tar.gz`（370,100 B，sha256 `f09ed02d…`）；staging 81 文件 `sha256sum -c` 全 OK、CR=0；`rsync -a` 覆盖 `app/`，`sha256sum -c` 81 OK / 0 FAILED |
| 构建 | `@sfoa/agent-playbook` → `@sfoa/mcp-provider-sfoa-context` → `@sfoa/mcp-server` 全部成功；dist 含 `includeRequiredness`/`requirednessSource`/`requiredChecklist`/`omittedFieldCatalog`/`writable`，Playbook dist 含 `mainland China mobile pattern`/`writable=false` |
| 服务 | `systemctl restart sfoa-mcp-server`：PID 2987553，`NRestarts=0`，`/health` 200；`sfoa-admin-api` 未重启，`/admin/api/ready` 200；`nginx`/`openclaw-gateway` active |
| Skill 发布 | `yarn skill:runtime:sync --runtime-root /data/openclaw/workspace/skills`；`crm-record-change` 12 文件、`phone-and-mobile.md` sha256 `ba556062…`，`skill:runtime:check` drift []；`openclaw gateway call skills.status` 显示 `eligible=true`/`modelVisible=true`；执行 `openclaw mcp reload` |
| 活体验证 | 以 60245 调用 `tools/list`（29 tools）确认 `includeRequiredness` 在 schema；Lead/FRN CREATE 返回 `PAGE_LAYOUT_REQUIRED`（35 项，其中 21 writable / 14 非 writable）；`Account_Visit__c` 客户来访 CREATE 返回 `EFFECTIVE_REQUIRED`/`DYNAMIC_FORMS`（18 项），`Visit_Route__c` 不在创建必填清单；均只读 |
| 回滚 | `systemctl stop sfoa-mcp-server` → 解回备份 source/dist → 按上述顺序重建 → 恢复 runtime Skill 目录 → `systemctl start sfoa-mcp-server`；无 DB 变更 |
| 未做 | 真人企微 UAT（用户进行）；本轮分支未 commit/push；Playbook 版本仍为 1.12.0 |

## 2026-10-27 16:15 本地 SenseVoice ASR（203）

| 项目 | 实际记录 |
| --- | --- |
| 背景 | 14:44 用户在企微发送 `10月27日.m4a`（322,840 B，`audio/x-m4a`）作为 **file** 消息；当时 OpenClaw 没有 audio-understanding 模型，核心在用户消息注入 `[Audio attachment not analyzed: no audio-understanding model is configured]`，模型如实回复无法转写。 |
| 方案 | **本地推理，音频不离开 203**：sherpa-onnx 2.0.1 + SenseVoice small int8 + imageio-ffmpeg 0.6.0（静态 ffmpeg 7.0.2）；不训练、无 GPU、无外部 provider/Key。 |
| 安装 | `/opt/asr/venv`（Python 3.9 venv，sherpa-onnx / numpy / imageio-ffmpeg）；模型 `/opt/asr/models/sense-voice/model.int8.onnx`（239,233,841 B）+ `tokens.txt`（315,894 B）；模型来自 HF 镜像 `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`，其 `LICENSE` 指向 FunASR 许可。 |
| Wrapper | `/opt/asr/bin/sensevoice-transcribe`：静态 ffmpeg 转 16 kHz 单声道 WAV → sherpa-onnx → stdout 只输出文本；临时目录使用 `TMPDIR`（网关为 `/data/openclaw/temp`）。 |
| 配置 | `openclaw.json` 的 `tools.media.models` 追加 `{type:"cli", command:"/opt/asr/bin/sensevoice-transcribe", args:["{{AttachmentPath}}"], timeoutSeconds:120, capabilities:["audio"]}`，并设 `tools.media.audio.enabled=true`；原有两条 image 条目保留。改前备份 `openclaw.json.bak-pre-local-asr-20261027-161248`。 |
| 生效 | 16:12:59 网关日志 `[reload] config hot reload applied (tools.media.models, tools.media.audio)`；`openclaw-gateway` PID 2957576 未变，`NRestarts=0`。 |
| 本地验证 | 5.59 s 中文样本：1.57 s / 375 MB / CPU 157%；用户 m4a：1.99 s / 444 MB / CPU 170%；`openclaw infer audio transcribe` 返回 `provider: sensevoice-transcribe`；同款 systemd 沙箱 `systemd-run` 运行 `success`（2.0 s）。 |
| 真实企微验证 | 16:14:57 用户重发同一 m4a（新 msgid，`msgtype=file`，322,840 B）；16:15:00 会话 `transcript_events` seq 801 的用户消息包含 `[Audio]` 与 `Transcript: 这周五下客户要来集团参观展厅，然后时间大概是周五下午一点半会到公司。`；16:15:11 模型基于转写回复。全程未配置/调用外部 ASR provider，音频留在 203。 |
| 资源 | `/opt/asr` 约 440 MB；推理峰值约 444 MB RSS；203 当时 load ~0.01、可用内存约 12 GB，未影响 MCP / Admin API / Gateway。 |
| 限制 | SenseVoice small 仍可能有同音字/标点误差（本次“周五下午”转成“周五下”），业务写入前需人工核对；模型许可证以 FunASR 链接为准，生产前需法务确认。 |
| 回滚 | 恢复 `openclaw.json.bak-pre-local-asr-20261027-161248`（或删除 `tools.media.models` 的 CLI 条目与 `tools.media.audio.enabled`），配置热加载生效；可选删除 `/opt/asr`；无 DB/迁移/服务重启。 |
| 记录同步 | 本条、交付报告与多模态 Phase 1 说明的更正提交后，按 git blob 的 LF 字节同步到服务器 `app/`。 |

## 2026-10-27 14:37 LF 重部署（`0a7649e`）

| 项目 | 实际记录 |
| --- | --- |
| 部署内容 | `codex/openclaw-business-autonomy` @ `0a7649e7`（HEAD）。运行时源码与 11:52 已部署的 `83818ca` 相同；`83818ca..0a7649e` 仅文档/证据、maintainer 参考、一个测试文件与 harness fixture 有差异 |
| 归档 | `incoming/sfoa-deploy-0a7649e-20261027-143611.tar.gz`（3,925,893 B，sha256 `56362ccffce89fa85740757b02958651c881670f404caff310a9d1313e5d55b4`，1655 entries）。归档内 `skills/crm-core/SKILL.md` 7408 B / 0 CR，`packages/sfoa-mcp-server/src/http-server.ts` 0 CR |
| **CRLF 纠正** | 11:51 的 `autonomy-source-c2.tar.gz`（sha256 `e1f7226f…`，本机/服务器一致）**实际是 CRLF**：`skills/crm-core/SKILL.md` 7465 B / 57 CR。app 与 runtime 副本都继承了 CRLF；去掉 CR 后与 canonical 相同。原记录的“来自 tracked LF 字节”只对 C1 归档成立 |
| 备份 | `backups/autonomy-0a7649e-20261027-143611/`（私有 700）：app 源码 `app-source-pre-0a7649e.tar.gz`（11 MB），四个业务 Skill 与独立 `sfoa` 包 |
| 落盘 | 先解到权限 755 的 staging，再 `rsync -a`（无 `--delete`）覆盖 `app/`；`.env.local` 与 `packages/mcp/README.md` 软链保留 |
| 字节验证 | staging 清单 1394 个文件，`sha256sum -c` 全部 OK；清单内文本文件 CR=0；app 的四个业务 Skill 与 git HEAD 逐字节一致 |
| 构建/重启 | **未重建、未重启**：`83818ca..0a7649e` 的运行时源码差异为 0（`packages/` 仅一个 `src/test` 文件，`integrations/` 仅 harness fixture）。MCP / Admin API 仍为 11:52 启动的 PID，`NRestarts=0` |
| Skill 发布 | `yarn skill:runtime:sync --runtime-root /data/openclaw/workspace/skills` 重新发布；`skill:runtime:check` 四个 Skill `drift: []`；runtime 36 个文件与 canonical HEAD 全部 hash 一致；maintainer 不在 runtime |
| 独立导出 | `skill:export` 临时生成后与 runtime `sfoa/` 逐字节一致（Playbook 1.12.0） |
| 进程可见性 | `openclaw gateway call skills.status`：四个业务 Skill `eligible=true` / `modelVisible=true`；maintainer 不存在 |
| 健康 | `/health` 200、`/admin/api/ready` 200、nginx `:9000/` 与 `:9000/admin/api/ready` 200；MCP / Admin API / Gateway / nginx 均 active |
| 记录同步 | 本条与交付报告的更正提交后，按 git blob 的 LF 字节同步到服务器 `app/`；其余 tracked 文件仍为 `0a7649e` 的全量验证结果 |

## 2026-10-27 OpenClaw 业务自主处理

本次仅测试服务器，生产未发布；Salesforce 内嵌 OpenClaw 暂停分支未合并。
基线 `origin/main=12df237f7ab03c4771109813b84f715a29e9e32d`，工作分支
`codex/openclaw-business-autonomy`。主要源码 `2d7a1f4ea6f00fcc562c128a1e7b383449c38cb3`，
最终运行代码 `83818ca75fda6170cb58494c9b16e4ff550e2a55`；交付提交另含证据与测试夹具修正。

| 项目 | 实际记录 |
| --- | --- |
| 源码归档 | `incoming/autonomy-source-20261027.tar.gz`（2d7a1f4，LF）、`incoming/autonomy-source-c2.tar.gz`（83818ca，**实为 CRLF**；见上方 14:37 重部署记录） |
| 最终归档 hash | `e1f7226f5dfc1e4b3ad092c999536994dc431bb8e693d36ff4b175a6b45e2da3`；本地/服务器一致。该归档的 `skills/crm-core/SKILL.md` 为 7465 B / 57 CR，部署树与 runtime 因而继承 CRLF；去掉 CR 后才与 canonical 一致，14:37 已以 LF 归档重部署 |
| 备份 | `/data/sfoa-enterprise-mcp/backups/autonomy-20261027-<完整源码SHA>/`，保留 app 源码/dist、四个业务 Skill、独立 sfoa 导出包、adapter 附件文件、构建/同步记录 |
| 构建 | Playbook → Context / Data → Server → Admin API / Web；C2 未改 Data 代码，复用 C1 已重建产物；Web 检查 DAC + restorecon |
| 实际配置 | Gateway 使用 `/data/openclaw/state/openclaw.json`，main workspace `/data/openclaw/workspace`，主模型 `custom-192-168-155-105-3001/deepseek-flash`，thinking=max；OpenClaw 2026.9.5(ec9c1a1)，实际 Gateway Node24.19.0 |
| Skill 发布 | **`yarn skill:runtime:sync --runtime-root /data/openclaw/workspace/skills`** 与对应 check；四个 canonical/runtime 正文 hash 一致，进程 eligible=true，maintainer 不存在 |
| 独立导出 / adapter | `skill:export --output /data/openclaw/exports/sfoa-1.12.0` 后同步既有 workspace sfoa/SKILL.md，保留其 mcp.json；实际插件 `/data/openclaw/plugins/sfoa-wecom-mcp-adapter/src/attachments.js` 同步，未改身份 resolver |
| 服务 | systemd 重启 MCP / Admin API / Gateway；三者 active，8080/health、8081/admin/api/health 与 nginx9000/ 都 200 |
| 可信企微请求 | 用户 11:14:38 发送的真实只读消息，5 个 MCP 调用均 WECOM_HEADER、零 DML，返回业务标签；发生于 Skill 目录修正前，不作为新版 Skill 已读证据 |
| 正确目录后的加载 | 新 Gateway CLI Run `2626b961-ba9b-4f3c-bd9e-0e5d5ed3c561` 实际 read 四份新正文，hash/新规则可核对；无企微 requester，不冒充企微端到端 |
| 修复后可信企微只读 | 用户报告 12:22 发出，服务器 12:23:06 收到、12:23:49 回复（北京时间）；两份当前 Skill 完整正文 read，三次 MCP 均 WECOM_HEADER、零 DML。一次旧类型拒绝后自行恢复；成功 context 38/80 字段、144 选项、单份 JSON 未被客户端裁切。业务答复仍有过度外推，不能评为全部正确 |
| 模型/写入评测 | 18 个合成固定样本，原生 OpenClaw 同主模型、实际 Skills/Playbook，真实 generic DML Tool→内存 SDK；三组直接核对实际 Provider HTTP 输入元数据。未写真实 Salesforce 数据 |

两项发布纠正必须保留：首次 `--runtime-root` 错填 workspace 父目录，脚本成功
不代表模型加载；改用实际 skills 目录后重新核对 hash 和新 Run read。错误位置
的四份本次生成副本保存在 C2 备份的 `misplaced-business-skills/`，未删除。
私有暂存目录 700 还曾被 `rsync -a` 带到 app 根目录，nginx 因无法遍历而 500；
仅恢复 app 根目录 755、dist 读取权限和 SELinux 后验证 200，未放宽配置/密钥权限。
后续应在同步前固定暂存根目录的可遍历权限，备份目录继续私有。

原始证据留在 `/data/sfoa-enterprise-mcp/evidence/autonomy-20261027/`，私有模型
配置不导出。PDF 原生提取原语通过，附件→本轮模型、Office、语音转写与真实
Salesforce 写入仍按实际缺项标 NOT RUN；修复后的可信企微只读链路已有实证，
当前真实回合的 Provider HTTP body 未捕获。不能用文件存在或 CLI 风格代替。
规则审计、精确分层验收与剩余质量限制见
[交付报告](OPENCLAW_BUSINESS_AUTONOMY_DELIVERY.md) 和
[合成评测证据](evidence/openclaw-business-autonomy-20261027.json)。
修复后真实企微的[脱敏审计与加载证据](evidence/openclaw-wecom-20261027-1222.json)
单独保留，包含失败/恢复、覆盖边界与回复质量限制；没有 requester、Salesforce
用户名、默认 Owner ID、凭据或真实业务记录。

## 部署记录 · Admin 复制按钮 focus-trap 修复（admin-web 单文件补丁，2026-10-29）

| 项 | 值 |
| --- | --- |
| 部署内容 | 修复「用户身份路由 → 接入配置」Drawer 内复制按钮**假成功**：纯 HTTP 下 `navigator.clipboard` 不存在，回退路径把临时 textarea 追加到 `<body>`，antd v6 Drawer 的 focus trap（`@rc-component/util` `useLockFocus`）立即把焦点抢回面板并清空选区，`execCommand('copy')` 仍返回 `true`，于是提示「已复制」而剪贴板未变。修复后检测焦点被抢即把 textarea 移入抢焦点元素的容器重试，且焦点没保住时不执行 `execCommand`、调用方显示「复制失败」。改动 `packages/sfoa-admin-web/src/clipboard.ts` + `src/test/clipboard.test.ts` |
| 服务器基线 | 部署前服务器 `src/clipboard.ts` 与本地 `HEAD` **字节一致**（sha256 `bfc98765…`），测试文件同（`295a8800…`），因此是外科式替换，不携带本分支其它差异 |
| 上传 | `scp` 两个文件到 `/tmp`；本地与服务器 sha256 一致：`clipboard.ts` `c7f56b26…`、`clipboard.test.ts`（LF 归一）`5c7bb0ea…` |
| 备份 | `backup/admin-web-dist-pre-clipboard-fix-20261029-110334.tar.gz`（509,234 B，旧 `dist`）；`backup/clipboard.ts.pre-20261029-110334`、`backup/clipboard.test.ts.pre-20261029-110334` |
| 构建 | `cd app && yarn workspace @sfoa/admin-web build`（tsc + vite，6.83 s，全 OK）。新产物 `dist/assets/clipboard-BmDQtlNG.js`（2,046 B）、`dist/assets/index-DEVRE_9D.js`；旧 `clipboard-BeZCxXV3.js` 已被清掉 |
| 服务 | **未重启任何服务**：本轮只有 admin-web 静态资源变化，`sfoa-mcp-server` / `sfoa-admin-api` 源码与 `dist` 均未改动 |
| SELinux | `restorecon -Rv dist` 后 `dist/index.html` 为 `unconfined_u:object_r:httpd_sys_content_t:s0` |
| 验收（服务器侧） | 经 nginx `127.0.0.1:9000`：`/login` 200、`/assets/index-DEVRE_9D.js` 200、`/assets/clipboard-BmDQtlNG.js` 200 且含 `Copy was rejected by the browser`；`/assets/IdentityRoutesPage-xJUX2OS0.js` 含「复制失败」；`/admin/api/ready` 200。部署产物的 `clipboard` chunk 内可直接读到重试循环与 `document.activeElement===textarea` 守卫 |
| 浏览器验证 | 本机 Chromium 打域名 `http://crmmcptest.runner-corp.com.cn:9000/login`：200、标题「SFoA 控制平面」、登录表单 2 输入 / 1 按钮、**0 控制台错误 / 0 失败请求**，加载的正是新包 `index-DEVRE_9D.js` |
| 回滚 | 停无 → 解回 `backup/admin-web-dist-pre-clipboard-fix-20261029-110334.tar.gz` 覆盖 `dist` → 还原两个 `.pre-20261029-110334` 源文件 → `restorecon -Rv dist`（如需回到旧行为可只做前半步） |
| 未做 | 带登录态的点选 UAT（需要控制台口令，未在部署脚本中接触）。人工验证方式：登录 → 用户身份路由 → 打开任一有凭证路由的「接入配置」→ 点「复制 Token」→ 在输入框粘贴，内容应与 Token 一致 |

> 验证坑（本轮新增）：SPA 的 `try_files $uri $uri/ /index.html` 会让**已删除的旧 asset 路径也返回 200**（内容其实是 index.html）。
> 判断「旧包是否还在」必须看磁盘文件或校验响应正文，不能用 HTTP 状态码；本次即用 `grep Copy was rejected by the browser` 与 chunk 正文确认新包生效。

## 部署记录 · ADR-0034 受限控制台账号（BTIT）（2026-10-15）

| 项 | 值 |
| --- | --- |
| 部署内容 | `feature/admin-btit-scoped-account` @ `be4f8cb`（ADR-0034：`SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON` + `(method, path)` 模块授权表 + 审计 `actorAdmin` 过滤 + 迁移 015）。相对服务器上一版（`5aa270c`，P10）**32 个 tracked 文件**，`packages/sfoa-mcp-server` 及其 provider **零改动** |
| **风险边界（用户约束）** | 用户要求「不得影响 MCP 工具逻辑与其他功能」。落实：**不重建、不重启 `sfoa-mcp-server`**（源码未变 → 既有 `dist` 仍有效），只重启 `sfoa-admin-api`。本轮确实改到了 `packages/sfoa-control-plane`，但影响面只有两处：新增一个**启动期**索引断言（迁移 015 已满足）与一个 `if (filter.actorAdmin)` 分支（MCP 侧从不传该参数，SQL 逐字节不变）；且 Node 只在进程启动时加载 `dist`，运行中的 runtime 不会重新读取 |
| 打包/上传 | 本机 `git -c core.autocrlf=false -c core.eol=lf archive --format=tar.gz` → `sfoa-app-be4f8cb.tar.gz`（3,861,198 B，sha256 `98d78256ac8399ee7dfd00f5651b88fd8d76ac3f8f57e59de9b3fd6c81c00d5c`，1377 files）→ `ssh 'cat >'` 上传 `incoming/`，本机/服务器 sha256 一致 |
| 落盘方式 | 先解到 `staging-btit-be4f8cb/`，再 **`rsync -a`（不带 `--delete`）** 覆盖 `app/`；`.env.local`、`node_modules`、各包 `dist` 等服务器独有文件全部保留 |
| 字节级验证 | `cd app && sha256sum -c incoming/expected-be4f8cb.txt` → **1377 OK / 0 FAILED / 0 MISSING**（清单里唯一的符号链接 `packages/mcp/README.md` 两侧都按目标内容取哈希，故一致） |
| 备份 | `/data/sfoa-enterprise-mcp/backup/sfoa-app-pre-be4f8cb-20261015-153243.tar.gz`（11,167,609 B，仅源码） |
| 构建 | 按依赖序重建 3 个包（15:34:06 全 OK）：`@sfoa/control-plane` → `@sfoa/admin-api` → `@sfoa/admin-web`；**未重建 mcp-server**。产物 `packages/sfoa-admin-api/dist/module-paths.js` 就位；admin-web `dist/assets/index-JuxgSnXJ.js`（`grep __vite-browser-external\|node:crypto` 无命中） |
| 数据库迁移 | `yarn db:migrate` → **015 `015_admin_audit_actor_index` APPLIED**（checksum `8c45052d…`）；台账 001–015 |
| 配置 | `config/.env.local` 追加一行 `SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON='[{…"username":"btit"…}]'`（单引号包裹的紧凑 JSON，值 146 B；**密码由服务器端 `randomBytes(24).toString('base64url')` 现场生成，全程未打印、未落终端**）。改前备份 `config/.env.local.pre-btit-20261015073756`；标签 `etc_t`（644），CR 字节 0 |
| **systemd 解析等价性** | 该键同时被 systemd `EnvironmentFile=` 与应用自身 dotenv 解析器读取，而 `process.env` 优先——两者若解析不同则「文件对、服务错」。先用一次性 `systemd-run -p EnvironmentFile=` 单元**实测**单引号 JSON 逐字节无损，再比对运行中服务的 `/proc/<admin-pid>/environ` 与文件解析值：`bytes=146`、`sha256=b0f70770…` **两侧一致** |
| 服务 | 仅 `systemctl restart sfoa-admin-api`：PID 2797536 → **2815541**，`sfoa_admin_started` 15:38:40（启动先写 9 条 `sfoa_auth_store_seed`，约 12s 后才监听，属既有行为）。`sfoa-mcp-server` **PID 2797522 / ActiveEnterTimestamp 2026-10-09 15:54:44 全程未变**，NRestarts 0，重启窗口内 journal 无新增行 |
| 验收（masked，服务器侧脚本） | `admin`：scope FULL、9 模块；7 个业务端点 + `/diagnostic` + `/ui-context/snapshots` 全 200；未知路径 **404 `MCP_ADMIN_NOT_FOUND`**（历史路由语义未变）。`btit`：scope SCOPED、模块集与配置逐字一致（`dashboard,identity-routes,audit,system,agent-integration`）；7 个端点全 200；`/diagnostic`、`/ui-context/snapshots`、未知路径均 **403 `MCP_ADMIN_FORBIDDEN`**。`audits?actorAdmin=` 过滤可用（admin 5 行 / btit 2 行）；runtime `127.0.0.1:8080/health` 200；`GET /mcp` 405 `-32001`。全程 1.7s |
| 浏览器验证 | 本机 Chromium 打域名 `http://crmmcptest.runner-corp.com.cn:9000/`：登录页正常渲染（标题「精简、可见、可追责的企业治理。」+「安全登录」），加载的正是**新包** `index-JuxgSnXJ.js`；页错误 1 条 = 未登录时 `/auth/me` 的 401（既有预期）。此检查同时是 ADR-0034 期间修掉的「控制台白屏」回归的实证 |
| SELinux | 重建后 `restorecon -Rv` admin-web `dist`（新资源本身已是 `httpd_sys_content_t`，无需改动）；`config/.env.local` 标签 `etc_t`；经 nginx 取新资源 200 |
| 回滚 | 停 `sfoa-admin-api` → 从 `backup/sfoa-app-pre-be4f8cb-20261015-153243.tar.gz` 解回 `app/` → 按 §6 重建 control-plane/admin-api/admin-web → `restorecon -Rv` dist → 用 `config/.env.local.pre-btit-20261015073756` 还原配置 → 重启 `sfoa-admin-api`。迁移 015 纯加性（建索引）不回滚 |

> 可复用做法（本轮新增）：① 受限账号的端到端验收不必把口令带进任何终端——服务器侧脚本用**部署产物自带的**
> `loadAdminApiConfig()` 读配置，只打印用户名/模块 id/状态码（`/root/sfoa-btit/btit-verify.mjs`）。
> ② 判断 systemd `EnvironmentFile` 与应用解析是否一致，比对 `/proc/<pid>/environ` 的值哈希与文件解析值哈希，
> 不打印明文。③ 用一次性 `systemd-run -p EnvironmentFile=…` 验证 systemd 对某个值的解析语义时，临时文件
> **必须放在带 `etc_t` 标签的目录**（放 `/tmp` 会被 Enforcing SELinux 拒：`Failed to load environment files:
> Permission denied`——与 §9.1 dist 标签同一类坑）。

## 部署记录 · P10 激活后控制台 500 修复（admin-web dist 重打标签，2026-10-09）

| 项 | 值 |
| --- | --- |
| 背景 | P10 收口激活于 15:54 以 `df6a889` 重建并替换 admin-web `dist`（归档 `incoming/admin-web-dist-df6a889.tar.gz`；旧包备份 `backup/admin-web-dist-pre-df6a889-20261009-155432.tar.gz`）。替换时**漏跑 §9.1 的 `restorecon`**——该步对每次重建都是必须的。新文件标签留在 `default_t`，属主还是 Windows 侧归档解包带入的数字 uid/gid `1651478:1049089`（本机无此账号；旧包内为 `root/root`） |
| 症状 | 15:54–16:13 经 nginx `:9000` 的**所有**路径 500（SPA 深链、静态资源、`/health` 均在内）。`error.log`：`stat() ".../dist/index.html" failed (13: Permission denied)` → `rewrite or internal redirection cycle while internally redirecting to "/index.html"`。DAC 位（目录 `r-x`、文件 `r--`）本身可读，拒绝来自 Enforcing SELinux |
| 修复 | `chown -R root:root <dist>` + `restorecon -R <dist>`（全部回到 `httpd_sys_content_t`）。内容未动：`index.html` sha256 `0480fa94…` 修复前后一致 |
| 验证 | 服务器侧带公网 Host 打 `:9000`：`/` 200、`/agent-integration` 200、`/assets/AgentIntegrationPage-Dx3zDIH4.js` 200、`/admin/api/health` 200；`:80` 301 保留；公网 `http://crmmcptest.runner-corp.com.cn:9000` 直连 `/` 与 `/agent-integration` 均 200 |
| 记录 | P10 报告 §9 追加事件段；§9.1 增加「同一原因在 SPA 上表现为 500」的判别说明 |

> 教训：dist 替换流程里 `restorecon` 不是可选项；从 Windows 侧归档解包还会带入不存在的数字属主，
> 一并 `chown -R root:root` 对齐。§9.1 的「每次重建后必跑」规则不变——本次是**漏执行**，不是规则缺失。

## 部署记录 · Skill-02C 附件上传能力（2026-09-16）

| 项 | 值 |
| --- | --- |
| 部署内容 | `feature/sfoa-attachment-upload` @ `59cb040`（Skill-02C：`upload_files_to_record` + Attachment Ingress + Attachment Bridge + `attachment_enabled` 迁移 014），替换测试服务器上一版 02B 交付 |
| 变更前版本识别 | 服务器无 `.git`。按**文件清单 + 暂存目录名**判定：`app/` 中含 02C 之前的 Skill-02B 收口内容，与 `ce800c2` 一致（见下方 02B 记录的更正说明）。`/data/openclaw/workspace/skills/crm-record-change` 为 02B 的 **9 文件**版本 |
| **运行时代码差异 ≠ 0** | 与 02B 不同，本轮**改动运行时代码**：`packages/sfoa-mcp-server`（24 文件）、`packages/sfoa-control-plane`（13）、`integrations/openclaw`（6）、`packages/sfoa-agent-playbook`（5）、`packages/sfoa-admin-web`（5）、`packages/sfoa-admin-api`（2）、`packages/sfoa-identity-runtime`（1）。故本轮**重建并重启**了 MCP Runtime 与 Admin API |
| 打包 | `git -c core.autocrlf=false -c core.eol=lf archive --format=tar.gz` → `sfoa-02c-59cb040.tar.gz`（**2,579,590 B**，sha256 `d2cc72d59e8298753b609ae2e8572dba8baf21bdad5fbcfc9c4f66ed57b3ce06`）。归档内文本文件**纯 LF**；唯一含 CR 的文件是 `docs/sfoa/evidence/p6-dml-01-admin-managed-fields.png`（二进制 PNG），不参与逐字节门禁 |
| 上传/校验 | 上传到 `/data/sfoa-enterprise-mcp/incoming/`，服务器侧 `sha256sum` 与本地**一致** |
| 落盘方式 | 先解到 `staging-02c-59cb040/`（1138 文件），再用 **`rsync -a`（不带 `--delete`）** 覆盖到 `app/`，服务器独有文件全部保留（`.env.local`、`.idea`、`projects`、`.temp`、`.workbuddy`、`node_modules`、各包 `dist`） |
| 字节级验证 | `sha256sum -c` → **1138 OK / 0 FAILED / 0 MISSING** |
| 备份 | `/data/sfoa-enterprise-mcp/backup/sfoa-app-02c-pre-20260915-174626.tar.gz`（1,032,523,804 B） |
| 依赖 | `yarn.lock` 依赖段无变化 → **未重装** `node_modules` |
| **数据库迁移** | **有新迁移**：`packages/sfoa-control-plane/migrations/014_skill02c_attachment_upload.sql` — `ALTER TABLE sfoa_dml_policy ADD COLUMN attachment_enabled BOOLEAN NOT NULL DEFAULT FALSE`、新建 `sfoa_attachment_staging`、新建两个索引。**`DEFAULT FALSE` 保证既有对象升级后行为完全不变** |
| 配置 | `config/.env.local` 新增 6 个 `MCP_ATTACHMENT_*` 变量（`INGRESS_ENABLED`、`PATH`、`STAGING_ROOT`、`TTL_MS`、`MAX_FILE_BYTES`、`MAX_FILES_PER_OWNER`）。暂存根 `/data/sfoa-enterprise-mcp/attachment-staging/`，`staged/` 权限 `0700`、root 属主 |
| 构建 | 重建 `packages/sfoa-control-plane` 后重建 `packages/sfoa-mcp-server`；已在 `dist` 中确认修复存在，且 `assertAuditSnapshotPersistable` 运行时类型为 `function` |
| 服务 | **已重启** `sfoa-mcp-server` 与 `sfoa-admin-api`；`openclaw-gateway` 与 `nginx` 未重启 |
| 部署后状态 | `sfoa-mcp-server` active · `127.0.0.1:8080/health` → **200**；`sfoa-admin-api` active · `127.0.0.1:8081/admin/api/health` → **200**（经 nginx `:9000/admin/api/health` 亦 **200**）；`nginx :9000/`（Admin Web）→ **200**；`openclaw-gateway` active。Node `v22.23.1` |
| Runtime Copy 发布 | 复用既有机制，未新建第二套：`yarn skill:runtime:sync --runtime-root /data/openclaw/workspace/skills` |
| Skill 校验 | **在服务器上**运行 `yarn skill:runtime:check --runtime-root /data/openclaw/workspace/skills` → `crm-core`、`crm-record-change` 均 `ok:true`、`drift: []` |
| Agent 可见性 | 业务 Agent 仍**只有** `crm-core` + `crm-record-change`；`sfoa-mcp-maintainer` 确认不可见 |
| Tool 发现 | `tools/list` 在**两种凭据路径**（内部 `MCP_CLIENT_TOKEN` 与企微渠道 `MCP_WECOM_CLIENT_TOKEN` + `X-WeCom-User-Id`）均返回**同一份 16 个 Tool** 的列表，含 `upload_files_to_record` |
| 真实链路验证 | 3 个真实 `ContentVersion` 在测试 org 上创建。**修复前**的 `068C5000000yWOPIA2` 无 audit 行；**修复后**的 `068C5000000yWg9IAE`（内部凭据）与 `068C5000000yWhlIAE`（**企微渠道凭据**）均已审计，后者 `identity_source=WECOM_HEADER`、`execution_role=USER`，证明真实入站渠道确实能执行该 Tool。**按 §九十五，这三个文件均未自动删除** |
| 审计卫生 | 落库 payload 全量扫描：file bytes / base64 / raw multipart body / Bearer token / 暂存区绝对路径 **全部 absent**；重启后 audit writer 失败计数 = 0 |
| 生产 | **未触碰** |

> 逐字节门禁与 LF 纯净性见 [Skill-02C 实施报告](SKILL_02C_IMPLEMENTATION_REPORT.md) §17；真人 UAT 用例见 [Skill-02C 附件上传 UAT](SKILL_02C_ATTACHMENT_UAT.md)。

---

## 部署记录 · OpenClaw Skill-02B 交付 + Runtime Copy 发布（2026-09-15）

> **更正（2026-09-16）**：本表原记部署版本为 `4b3b2ff`。实际服务器 `app/` 的内容与暂存目录名指向 **`ce800c2`** —— 它是 `4b3b2ff` 的后代，二者之间还有 `9f3167f`、`a00017f`、`ce800c2` 三个提交（`docs` 与 `skills` 内容，**运行时代码差异仍为 0**，故本表的「未重建、未重启」结论不受影响）。下文「部署内容」一行的 SHA 保留原值以维持记录原貌，**以 `ce800c2` 为准**。

| 项 | 值 |
| --- | --- |
| 部署内容 | `feature/openclaw-crm-record-change-02b` @ `4b3b2ff`（实际落盘 tip 为 `ce800c2`，见上方更正）（Skill-02B `crm-record-change` UPDATE + Batch + Outcome 收口，以及 `crm-core` 两处跨 Skill 事实修正），替换测试服务器上一版 `main` @ `3adae7b`（Skill-02A 交付） |
| 变更前版本识别 | 服务器无 `.git`，按**文件清单 + 内容特征**判定：`/data/openclaw/workspace/skills/crm-record-change` 与 `app/skills/crm-record-change` 均 **7 文件**、含 `references/outcomes.md`、`SKILL.md` 9576 B / sha256 `c7354635…`、不含 `UPDATE != CREATE` → 判定为 **Skill-02A**，与 `main` @ `3adae7b` 一致 |
| **运行时代码差异 = 0** | `git diff 3adae7b..4b3b2ff -- packages yarn.lock packages/sfoa-control-plane/migrations .env.example config integrations` 为空。改动只落在 `skills/`（canonical + 三处生成副本）与 `docs/sfoa/`。**故未清增量标记、未重建 workspace、未 `systemctl restart`** 任一服务 |
| 打包 | `git -c core.autocrlf=false -c core.eol=lf archive --format=tar.gz` → `sfoa-02b-final-4b3b2ff.tar.gz`（**2,446,821 B**，1344 个 tracked 条目，sha256 `9cde97603eed890573e391f6de7e06024345dc53a87721be1cc61c12176f17fc`）。实测归档内 `skills/crm-record-change/SKILL.md` **crlf=0 / loneLf=118**（纯 LF），避免 §3.1 的 CRLF 假漂移 |
| 上传/校验 | 经 ssh 写入 `/tmp/`，服务器侧 `sha256sum` 与本地**一致** |
| 落盘方式 | 先解到 `staging-02b-final-4b3b2ff/`，再用 **`rsync -a`（不带 `--delete`）** 覆盖到 `app/`，服务器独有文件全部保留（`.env.local`、`.idea`、`projects`、`.temp`、`.workbuddy`、`node_modules`、各包 `dist`）。**额外一步**：02B 退役的 `references/outcomes.md` 不参与 rsync 删除，已显式 `rm` canonical + `.agents`/`.claude`/`.codebuddy` 共 **4 处**，并复查 `find` 结果为 0 |
| 备份（Skill） | `/data/openclaw/backups/20260915-095931-skill-02b-delivery/crm-record-change/`（7 文件，02A 版本完整保留） |
| 备份（app） | 只备份本次可能改动的子树：`/data/sfoa-enterprise-mcp/backup/sfoa-app-skills-02b-pre-20260915-095931.tar.gz`（89,387 B）、`sfoa-app-docs-02b-pre-20260915-095931.tar.gz`（652,098 B）。**未**做 5.6 G 全量 app 打包（其中绝大部分是 `node_modules` 与 `dist`，本轮不可能被改动），范围与理由已在报告中说明 |
| 依赖 | `yarn.lock` 与根 `package.json` 依赖段无变化 → **未重装** `node_modules` |
| 数据库迁移 | **无新迁移**：`packages/sfoa-control-plane/migrations` 无变化，未执行 `db:migrate` |
| 配置 | `.env.example` 无变化 → **无新增必填变量**；`config/.env.local`、`secrets/private.pem` 未改动 |
| 构建 | **未构建**（见「运行时代码差异 = 0」）。Skill 不参与 MCP 运行时 |
| 服务 | **未重启**。`MCP Runtime changed: NO` |
| Runtime Copy 发布 | 复用既有机制，未新建第二套：`yarn skill:runtime:sync --runtime-root /data/openclaw/workspace/skills`（方向 canonical → runtime，受 `BUSINESS_SKILL_ALLOWLIST` 约束） |
| Skill 校验 | 服务器 `app/` 上 `manage.mjs validate` → 3 个 Skill `ok:true`；`check` → `drift: []`；`runtime-check` → 两个业务 Skill `ok:true`、`drift: []` |
| 字节级验证 | `diff -r` 比对 canonical 与 runtime：`crm-core` 9/9 **IDENTICAL**、`crm-record-change` 9/9 **IDENTICAL**。另有 22/22 doctrine 探针在 runtime 副本中命中（`UPDATE != CREATE`、`TARGET_RESOLVED`、`Minimal Patch`、`∀ record: CHANGE_READY(record) == true`、`MCP_DML_BATCH_DUPLICATE_RECORD_ID`、`200 + 200 + 100`、`FAILED != UNKNOWN`、`Read-Back != Transaction Success` 等），`missing: 0` |
| 机器门禁 | 本机 `yarn skill:test` **63/63 pass**（exit 0）；`skill:validate`/`skill:check`/`skill:delivery` 全 `ok:true`、`drift: []`、`problems: []`；`skill:smoke` 从提交后 HEAD 字节重建亦 63/63 |
| Agent 可见性 | `openclaw skills check --agent main` → **Visible to model: 3** = `browser-automation`、`crm-core`、`crm-record-change`。`agents.entries.main.skills` 仍为 `["crm-core","browser-automation","crm-record-change"]`（**数组未被覆盖**，既有 `browser-automation` 保留）；`skills.entries` 仅两个 SFOA Skill 且 `enabled=true` |
| Maintainer 隔离 | `/data/openclaw/workspace/skills/` 顶层**只有**两个业务 Skill；`find` 匹配 `*maintainer*` = 0；workspace 内 `*.mjs`/`*.js`/`scripts/` = 0；`openclaw skills info sfoa-mcp-maintainer --agent main` → `Skill not found`；运行中 Gateway 索引 `maintainer: false`。**未**使用 `cp -r skills/*` |
| 刷新语义（本轮实测修正） | `skills.load`/`skills.watch` 均未设置、本轮未改配置（故日志中「skills snapshot invalidated by config change」未触发）、Gateway 进程仍是最初 pid；但 `openclaw gateway call skills.status --json`（答案来自运行进程）已返回**新的 151 字符 description**，且全新 session 经 Gateway 的一轮 UPDATE 意图探针已应用 `TARGET_RESOLVED` 等 02B 规则 → **无需重启**。注意 `openclaw skills list` 直读 workspace、不产生 Gateway 日志行，不能作为运行进程的证据 |
| 会话探针 | 明确禁止写入的 UPDATE 意图探针：模型复述「明确的 UPDATE 意图（不是 CREATE）」「Gate 1 — TARGET_RESOLVED」「目标唯一解析前不生成也不提交 Patch」，并确认**未调用任何写入工具、未修改任何记录** |
| ⚠️ 未做 | 本次**未**执行真实企业微信 UAT，**未**产生任何 Salesforce 业务记录。批量 UAT 前仍需在 Admin「Tool Governance」确认 `create_records` / `update_records` 已启用。02B **尚未合入 `main`**（`main` 仍为 `3adae7b`），因此「`main` == 服务器 `app/`」这一不变量在合并前暂时不成立 |
| 回滚 | 恢复 Skill：`cp -a /data/openclaw/backups/20260915-095931-skill-02b-delivery/crm-record-change /data/openclaw/workspace/skills/`。恢复 app 子树：解回上述两个 `sfoa-app-*-02b-pre-*.tar.gz` 到 `app/`。无 DB 迁移不回滚，无需重启服务 |

---

## 部署记录 · OpenClaw Skill-02A 交付 + 全量字节对齐（2026-09-14）

| 项 | 值 |
| --- | --- |
| 部署内容 | `hotfix/openclaw-crm-record-change-02a-delivery` @ `345b739`（Skill-02A `crm-record-change` 交付 + `crm-core` 同步 + OpenClaw WeCom/并发/多模态集成链），替换测试服务器上一版 `main` @ `3e19d9a`（P8-07 HOTFIX02） |
| 变更前版本识别 | 服务器无 `.git`，按**代码特征**判定：`packages/mcp-provider-sfoa-dml/dist/tools/batch-records.js` 存在（P8-07）、`packages/sfoa-mcp-server/dist/discovery-server.js` 存在（P8-06）、`dml-tool-facade.js` 含 `assertNoDuplicateBatchRecordIds`（HF02-02）→ 判定为 **`3e19d9a`**，与上一条部署记录及备份 `sfoa-app-pre-3e19d9a-20260910-170921.tar.gz` 一致 |
| **运行时代码差异 = 0** | `git diff 3e19d9a..345b739 -- packages yarn.lock 'packages/sfoa-control-plane/migrations' .env.example config` 结果为空。该区间 111 个文件全部落在 `docs/sfoa`、`skills/`、`.claude`/`.agents`/`.codebuddy` 生成副本、`integrations/openclaw`，外加根 `package.json` 两个 `skill:runtime:*` 开发脚本。**故本次未清增量标记、未重建 workspace、未 `systemctl restart`** —— 重启对运行行为是 no-op，仅会增加无谓风险 |
| 打包（⚠️ 本次修正） | `git archive` 会重新应用 `core.autocrlf`：本机 `core.autocrlf=true`，直接 `git archive HEAD` 产出的文本文件是 **CRLF**，与仓库 blob（LF）**不等价**（实测 `skills/crm-record-change/SKILL.md` 9576 B LF → 9643 B CRLF，+67 B = 行数）。**正确命令**：`git -c core.autocrlf=false -c core.eol=lf archive --format=tar.gz -o <name>.tar.gz <sha>`。旧流程从 Windows 检出打包会把 CRLF 带上服务器（本次在改动前的服务器备份中实测到 `skills/sfoa-mcp-maintainer/SKILL.md` 就是 CRLF），属**存量流程缺陷**，已一并修正 |
| 上传/校验 | `sfoa-app-lf-345b739-20260914-171645.tar.gz`（2,324,567 B，1102 个 tracked 文件）→ scp `/data/sfoa-enterprise-mcp/incoming/`；本机/服务器 sha256 一致（`eaa5210595644ed4961d83508674fe8420f6b99f32bc61c6ee793c17fdbfce1a`） |
| 落盘方式 | 先解到 `staging-lf-345b739/`，再用 **`rsync -a`（不带 `--delete`）** 覆盖到 `app/`，因此服务器独有文件全部保留：`.env.local`、`.idea`、`projects`、`.temp`、`.workbuddy`、`.codegraph/codegraph.db*`、`.claude/settings.local.json`、`node_modules`、各包 `dist` |
| 依赖 | `yarn.lock` 与根 `package.json` 依赖段无变化 → **未重装** node_modules |
| 数据库迁移 | **无新迁移**：`packages/sfoa-control-plane/migrations` 无变化，未执行 `db:migrate` |
| 配置 | `.env.example` 无变化 → **无新增必填变量**；`config/.env.local`、`secrets/private.pem` 未改动 |
| 构建 | **未构建**（见「运行时代码差异 = 0」）。既有 `dist/` 由与 HEAD 字节相同的源码产出，仍然有效 |
| 服务 | **未重启**。`sfoa-mcp-server`、`sfoa-admin-api`、`openclaw-gateway` 三服务 `active`；`/health` **200**；`/admin/api/ready` **200**（Admin API 实际监听 **127.0.0.1:8081**，`8080` 上取该路径是 404，勿误判） |
| 备份 | 部署前 app → `/data/sfoa-enterprise-mcp/backup/sfoa-app-pre-345b739-20260914-171541.tar.gz`（9,369,900 B，1717 文件，sha256 `637910ff0d244b9b7626863df23ff30af3b8a95898a91a5bdb8ae0403bdd72f5`） |
| 字节级验证 | 以 HEAD 的 1102 个 blob 内容生成 sha256 清单，在服务器 `app/` 下 `sha256sum -c`：**OK 1102 / FAILED 0 / MISSING 0**。即部署树与仓库字节**完全一致** |
| Skill 校验 | `yarn skill:check` → `ok:true`、`drift:[]`（3 个 canonical Skill 与其 `.claude`/`.agents`/`.codebuddy` 生成副本一致）；`yarn skill:runtime:check --runtime-root /data/openclaw/workspace/skills` → 两个业务 Skill 均 `ok:true`、`drift:[]`；独立 `diff -rq` 复核 `crm-core`（9）+ `crm-record-change`（7）= **16/16 文件字节相同** |
| 机器门禁 | `node --test skills/sfoa-mcp-maintainer/scripts/toolkit.test.mjs`：本机 **32/32 pass**，服务器 `app/` 部署树同样 **32/32 pass** |
| OpenClaw 插件 | `/data/openclaw/plugins/sfoa-wecom-mcp-adapter` 的 `openclaw.plugin.json`(`857a3b04…`)、`src/index.js`(`eb92ac47…`)、`src/resolver.js`(`ac3909a3…`) 与 HEAD 逐一相同 → **无需重发** |
| Agent 可见性 | `agents.entries.main.skills` = `["crm-core","browser-automation","crm-record-change"]`；`skills.entries` 仅两项且 `enabled:true`；`crm-core`/`crm-record-change` 均 `eligible:true, modelVisible:true`；业务 workspace `/data/openclaw/workspace/skills/` **只含这两个 Skill，`sfoa-mcp-maintainer` 不在其中** |
| 合并 | 部署验证通过后 `main` 以 **fast-forward** 合入本分支并推送（合并前 `main` = `origin/main` = `25a15ce`，是本分支 tip 的祖先，`HEAD..main` 计数为 0 → 无冲突、无合并提交）。此次 FF 同时把 OpenClaw 测试服基线 / WeCom→SFOA 集成 / 并发·联网 / 多模态 / Skill-01/02A 全部带入 `main` |
| 回滚 | 停服 → 解回上述 `sfoa-app-pre-345b739-20260914-171541.tar.gz` 到 `app/` → `systemctl restart sfoa-mcp-server sfoa-admin-api`；DB 无迁移不回滚 |
| 一致性 | 本条记录所在的提交（及其后的记录修订）随同 fast-forward 一并进入 `main`，并且服务器 `app/` 也重新同步到**同一个提交**。因此 `main` 的 tip 与测试服务器 `app/` 逐字节一致；如需核对，按 §3.5 用该提交的 sha256 清单跑 `sha256sum -c` |
| ⚠️ 未做 | 本次**未**执行真实企业微信 UAT，**未**产生任何 Salesforce 业务记录（校验只用 CLI 轮次与文件哈希，CLI 轮次不暴露 SFOA MCP 工具）。Skill-02A 状态仍为 `READY FOR HUMAN UAT`，**不是** `LIVE UAT PASSED` |

---

## 部署记录 · P8-07 批量 DML + P8-07 HOTFIX01/02（2026-09-10）

| 项 | 值 |
| --- | --- |
| 部署内容 | `main` @ `3e19d9a`（P8-07 受治批量 DML + 复合编排 `8a27b3b`；P8-07 HOTFIX01 `4d4bacb`；P8-07 HOTFIX02 `34c7a03`/`ce0fd63`/`3e19d9a`），替换测试服务器上一版 `5c623ef`（P8-06 HOTFIX01） |
| 变更前版本识别 | 服务器无 `.git`，按**代码特征**判定而非假设：`packages/mcp-provider-sfoa-dml/dist/tools/` 只有 `create-record/update-record`（无 `batch-records`）→ 未含 P8-07；`dist/version.js` 为 `AGENT_PLAYBOOK_VERSION = '1.6.1'`；且存在 `discovery-server.js`（P8-06 `4c5246a` 引入）→ 判定为 **`5c623ef`**，与备份名 `sfoa-app-pre-p806-20260909-134429.tar.gz`、admin-web `dist` 时间戳（Sep 9 13:45）一致 |
| 打包/上传 | 本机 `git archive --format=tar.gz -o sfoa-deploy-3e19d9a.tar.gz 3e19d9a`（**1.95MB**，只含该提交的 tracked 文件，天然不含 `node_modules`/`.git`/`dist`/`.env.local`/`*.pem`/`*.key`/`*.tsbuildinfo`/`.wireit`）→ scp `/tmp/`；本机/服务器 md5 一致（`2c2f9817a54874c3e8da5e90a221613a`） |
| 依赖 | `yarn.lock`、根 `package.json` 在 `5c623ef..3e19d9a` 区间**无变化** → **未重装** node_modules（服务器保留） |
| 数据库迁移 | **无新迁移**：区间内 `packages/sfoa-control-plane/migrations` 仍止于 **013**，台账 `001–013` 全部 `APPLIED`、`PENDING` 为 0，未执行 `db:migrate` |
| 配置 | `.env.example` 区间内无变化 → **无新增必填变量**；`config/.env.local`、`secrets/private.pem` 均未改动（`.env.local` 软链完好） |
| 构建 | 先清增量标记与产物（`find packages -name '*.tsbuildinfo' -delete`、删 `.wireit` 与各包 `dist`，规避 §13 坑 #3 的 wireit 误判跳过 emit），再按 §6 依赖顺序**全量重建 10 个 workspace**，全部 OK |
| 服务 | `systemctl restart sfoa-mcp-server sfoa-admin-api`；两服务 `active`，日志见 `sfoa_runtime_started` 与 `sfoa_admin_started`；`identitySources` 含 `WECOM_HEADER`（P8-06 通道生效）；nginx 未改动；`restorecon -Rv` admin-web `dist`（标签 `httpd_sys_content_t`） |
| 备份 | 部署前 app → `/data/sfoa-enterprise-mcp/backup/sfoa-app-pre-3e19d9a-20260910-170921.tar.gz`（21MB，仅源码） |
| 验证结果 | `/health` 200，`auditPersistence` **UP**（`failureCount 0`、`writerState IDLE`）；`/admin/api/ready` 200 `{"status":"UP","databaseVersion":"8.4.5"}`；经 Nginx 域名入口 `:9000` 的 `/` 与 `/admin/api/ready` 均 200；MCP `initialize` 返回 `instructions` 含 **Agent Playbook 1.8.0**；`dist/tools/batch-records.js` 已产出；`mcp-server/dist/dml-tool-facade.js` 含 HF02-02 预检 `assertNoDuplicateBatchRecordIds`；admin-web bundle 含 `部分成功` 与 `PARTIAL_SUCCESS`（HF02-01）；`tools/list` 实调成功（7 个已启用的单数 Tool） |
| ⚠️ 遗留（非部署缺陷） | `create_records` / `update_records` 的**代码已部署**，但 `sfoa_tool_control` 表中**没有这两个 Tool 的登记行**，按 Tool Governance 规则不会被 `tools/list` 广告。若要在测试环境 UAT 批量 CREATE/UPDATE，需先在 Admin「Tool Governance」页启用这两个 Tool —— 属**治理/策略变更**，本次部署未代为开启 |
| 合并 | 部署验证通过后 `main` 以 **fast-forward** 合入 `3e19d9a` 并推送：`main` = `origin/main` = `3e19d9a`（合并前 `main` = `5c623ef`、`origin/main` = `7643755`，均为 `3e19d9a` 祖先，无冲突、无合并提交） |
| 回滚 | 停服 → 解回 `/data/sfoa-enterprise-mcp/backup/sfoa-app-pre-3e19d9a-20260910-170921.tar.gz` 到 `app/` → 按 §6 清标记后重建 → `restorecon -Rv` admin-web `dist` → 重启两服务；DB 无迁移不回滚 |

> 记录订正：本文档上一版最后一条部署记录停留在 P8-04（`b01816d`，2026-09-08）。此后 **P8-05（`7519b66`）与 P8-06（`5c623ef`）两次部署未写入本文档**，仅能从服务器备份文件名（`sfoa-app-pre-7519b66-20260908-160814.tar.gz`、`sfoa-app-pre-p806-20260909-134429.tar.gz`）与迁移 013 的应用时间（`2026-09-08T16:07:18Z`）回溯。本次一并说明，避免版本认知断层。

---

## 部署记录 · 域名 crmmcptest.runner-corp.com.cn http(:9000) 接入（2026-09-08，纯配置/nginx，无代码）

| 项 | 值 |
| --- | --- |
| 变更内容 | 新增对外访问入口 **`http://crmmcptest.runner-corp.com.cn:9000`**（测试服务器**未加证书，仍为 http**，443 无监听）。域名 split-DNS：公网 → `202.109.254.220`（网关 DNAT → 本机 `:9000`），内网 → `192.168.156.203`（同机）。对 Node 而言仅是 Host/Origin 变化，端口/进程不变 |
| 背景/前置 | 同日早些时候已放行外网映射 `202.109.254.220:9000`（`MCP_ALLOWED_HOSTS/ORIGINS` 追加 IP 无端口 + 带端口；外部 MCP 客户端经网关直连生效，见 nginx 日志 172.70.x / 36.248.x 来源）。`SFOA_ADMIN_ALLOWED_ORIGIN` 为**单值**只能二选一，经确认后台**统一切到域名**：内网同事用域名（内网 DNS 解析到同机）后台仍可用；旧 `http://192.168.156.203:9000` 直接登录会 403，属预期 |
| 配置 | `config/.env.local`（改后 `restorecon`，重启两服务）：`SFOA_ADMIN_ALLOWED_ORIGIN` **替换**为 `http://crmmcptest.runner-corp.com.cn:9000`；`MCP_PUBLIC_URL` → `http://crmmcptest.runner-corp.com.cn:9000/mcp`；`MCP_ALLOWED_HOSTS` **追加** `crmmcptest.runner-corp.com.cn`、`crmmcptest.runner-corp.com.cn:9000`；`MCP_ALLOWED_ORIGINS` **追加** `http://crmmcptest.runner-corp.com.cn:9000`、`http://crmmcptest.runner-corp.com.cn` |
| nginx | `mcp-service.conf`：`:80` 跳转改为**按原 host**（`return 301 $scheme://$host:9000$request_uri;`），两个 server 块 `server_name` 追加域名。`nginx -t` 通过后 reload |
| 验证 | 域名 `:9000` `/admin/api/ready` 200 `{"status":"UP","databaseVersion":"8.4.5"}`、`/` 200、`/mcp` GET **405**（host 放行）；login Origin `http://…com.cn:9000` + 正确凭据 200、Origin 老内网 IP `:9000` 403（已切域名单源）；MCP 域名 Origin 405、`evil` Origin 403、外网 IP `202.109.254.220` 405 回归正常；`:80` 跳转 Location：Host=域名 → `http://…com.cn:9000/`、Host=内网 IP → `http://192.168.156.203:9000/` |
| 备份 | 服务器 `/root/sfoa-domain-backup-<ts>/`（`mcp-service.conf` + 隐藏文件 `.env.local`） |
| 回滚 | 停服 → 从备份还原两份文件 → `restorecon -v config/.env.local` → 重启两服务 + reload nginx |

> 提醒：后续若加证书启用 https，TLS 大概率终结在公网网关侧（本机 Nginx 内仍为 http）。届时把 `SFOA_ADMIN_ALLOWED_ORIGIN` / `MCP_ALLOWED_ORIGINS` / `MCP_PUBLIC_URL` 相应切到 `https://crmmcptest…` 无端口（443 默认不带端口）即可，并注意 `SFOA_ADMIN_COOKIE_SECURE` 需随之设 `true`。

---

## 部署记录 · 对外端口迁移 80 → 9000（2026-09-08，仅测试服务器，无代码/无迁移）

| 项 | 值 |
| --- | --- |
| 变更内容 | 本项目对外入口由 `http://192.168.156.203`（80）迁移到 **`http://192.168.156.203:9000`**；nginx **80 端口保留为 301 全量跳转**到 `:9000`，存量书签/旧访问者不中断。Node 内网端口不变（MCP `0.0.0.0:8080`、Admin API `127.0.0.1:8081`） |
| 动因 | 让出测试服务器 80 端口，同时不影响本项目现有用户 |
| nginx | `conf.d/mcp-service.conf`：主 server 块 `listen 80;` → `listen 9000;`；新增 `server { listen 80; server_name 192.168.156.203; return 301 http://192.168.156.203:9000$request_uri; }`。`nginx -t` 通过后 `systemctl reload nginx` |
| firewalld/SELinux | `firewall-cmd --permanent --add-port=9000/tcp` + `--reload`（9000 放行；`http`=80 保留供跳转）。SELinux `http_port_t` **本已含 9000**，无需 semanage |
| 配置 | `config/.env.local`（覆盖写后重跑 `restorecon`，label `etc_t`，重启两个服务）：`MCP_PUBLIC_URL` → `http://192.168.156.203:9000/mcp`；`MCP_ALLOWED_ORIGINS` **追加** `http://192.168.156.203:9000`；`MCP_ALLOWED_HOSTS` **追加** `192.168.156.203:9000`；`SFOA_ADMIN_ALLOWED_ORIGIN` **改为单值** `http://192.168.156.203:9000`（该变量只接受一个 origin，是「替换」而非「追加」，见 §5.2） |
| 验证 | `:9000` `/` 200、`/admin/api/ready` 200 `{"status":"UP","databaseVersion":"8.4.5"}`、`/mcp` GET 405（已路由到 node）；`:80` 对 `/`、`/mcp`、`/admin/api/ready` 均 301 → `http://192.168.156.203:9000…`；`POST /admin/api/auth/login`：Origin `:9000`+正确凭据 200（session cookie 下发）、Origin `:80` 403 `MCP_ADMIN_ORIGIN_NOT_ALLOWED`（origin 门已切，该检查先于登录限流，不占额度） |
| 备份 | 改前备份在服务器 `/root/sfoa-port9000-backup/`（`mcp-service.conf.orig-*`、`env.local.orig-*`） |
| 提醒 | 旧 MCP 客户端端点 `http://192.168.156.203/mcp` 需改到 **`http://192.168.156.203:9000/mcp`**（Streamable HTTP POST 通常不跟随 301）；`MCP_PUBLIC_URL` 已同步为 `:9000`，Admin「系统状态 / 接入配置」会自动展示新地址 |
| 回滚 | 停服务 → 从 `/root/sfoa-port9000-backup/` 还原两份文件 → `restorecon -v config/.env.local` → `systemctl restart sfoa-mcp-server sfoa-admin-api` + `systemctl reload nginx`；`firewall-cmd --permanent --remove-port=9000/tcp && firewall-cmd --reload` |

---

## 部署记录 · P8-04 有效 UI 上下文 + 受管平台用户回退（2026-09-08）

| 项 | 值 |
| --- | --- |
| 部署内容 | `feature/p8-04-effective-ui-context` @ `b01816d`（含 `feature/managed-platform-user-lookup-fallback` = `3f39a0a/de77a48/f60a134` 的受管平台用户回退 010/011，及 P8-04 有效 UI 上下文 012；Agent Playbook 升至 **1.6.1**）以 fast-forward 合入 `main` 后部署 `main` @ `b01816d`，替换测试服务器上一版 `main` @ `000b1b8` |
| 打包/上传 | 本机 `git archive` HEAD = `b01816d` → `sfoa-deploy-b01816da.tar.gz`（1.9MB，仅 tracked 源码，排除 node_modules/.git/dist/.env.local/*.pem/*.key/*.tsbuildinfo/.wireit）→ scp `/tmp/` → 覆盖解压到 `app/`；本机/服务器 md5 一致（`12f0a621…`） |
| 依赖 | `yarn.lock` 未变化 → **未重装** node_modules（服务器保留） |
| 数据库迁移 | 新增加性迁移 **010** `managed_platform_user_lookup_fallback`（`sfoa_dml_managed_field_rule.strategy` ENUM 增 `PLATFORM_USER_LOOKUP_FALLBACK`）、**011** `managed_fallback_create_only`（CHECK 收紧：fallback 仅 create + 必填 lookup）、**012** `p8_ui_snapshot`（新建 `sfoa_ui_snapshot` + `sfoa_audit_payload_evidence.payload_type` ENUM 增 `UI_CONTEXT`）；共享库台账 **001–012 APPLIED**（12 行） |
| 配置 | 无新增必填变量（`.env.example` 无变化），`config/.env.local`、`secrets/private.pem` 均未改动 |
| 构建 | 服务器按 §6 依赖顺序全量重建 10 个 workspace，全部 OK（控制平面依赖 identity-runtime 新 `UI_CONTEXT` 审计类型，须先自底向上重建再跑迁移） |
| 服务 | 重启 `sfoa-mcp-server` / `sfoa-admin-api`；mcp-server `sfoa_runtime_started` 09:28:45 CST，admin-api 09:28:44 CST 起 active；nginx 未改动；SELinux `restorecon` admin-web `dist`（标签 `httpd_sys_content_t`） |
| 备份 | 部署前 app → `/data/sfoa-enterprise-mcp/backup/sfoa-app-pre-b01816da-20260908-092632.tar.gz`（41MB，仅源码） |
| 验证结果 | `/health` 200；`/admin/api/ready` 200 `{"status":"UP","databaseVersion":"8.4.5"}`；nginx 对外 `/` 与 `/admin/api/ready` 均 200；台账 **001–012 APPLIED**；`sfoa_ui_snapshot` 已建表；`sfoa_audit_payload_evidence.payload_type` ENUM 含 `UI_CONTEXT`；Agent Playbook **1.6.1**（admin-web bundle 与 `agent-playbook` dist 均内嵌） |
| 合并 | 部署验证通过后 `feature/p8-04-effective-ui-context` @ `b01816d` 以 fast-forward 合入 `main` 并推送 `origin/main`，`main` = `origin/main` = `b01816d`，与测试服务器一致 |
| 回滚 | 停服 → 解回备份包到 `app/` → 按 §6 重建 → 重启；DB 迁移纯加性不回滚（见 `skills/.../operations.md` 指引，不回写 `sfoa_schema_migration`） |

---

## 部署记录 · P8 上下文契约 + Agent Playbook 分发闭合（2026-09-04）

| 项 | 值 |
| --- | --- |
| 部署内容 | `main` @ `000b1b8`（P8-01 记录类型感知创建 / P8-02 记录显示上下文 / P8-03 呈现智能 + HOTFIX01 上下文契约与 Salesforce UI API 单数参数修正 + HOTFIX02 Agent Playbook 规则拆分与 1.4.1），替换测试服务器上一版 `main` @ `fc33f56` |
| 打包/上传 | 本机 tar `sfoa-deploy.tar.gz`（40MB，排除 node_modules/.git/dist/tmp/secrets/.env.local/*.pem/*.key/*.tsbuildinfo/.wireit）→ scp `/tmp/` → 覆盖解压到 `app/`；本机/服务器 md5 一致 |
| 依赖 | `yarn.lock` 未变化 → **未重装** node_modules（服务器保留） |
| 数据库迁移 | **无新迁移**；共享库 `192.168.156.127/sfoa_enterprise_mcp` 台账保持 **001–009 APPLIED** 不变（P8 纯代码，无 SQL） |
| 配置 | 无新增必填变量，`config/.env.local`、`secrets/private.pem` 均未改动 |
| 构建 | 服务器按 §6 依赖顺序全量重建 10 个 workspace，全部 OK，约 35s（14:37:10–14:37:45） |
| 服务 | 重启 `sfoa-mcp-server` / `sfoa-admin-api`；mcp-server `sfoa_runtime_started` 14:38:02 CST，admin-api 14:38:00 起 active；nginx 未改动；SELinux `restorecon` admin-web `dist`（标签 `httpd_sys_content_t`） |
| 备份 | 部署前 app → `/data/sfoa-enterprise-mcp/backup/sfoa-app-pre-000b1b8-20260904-143642.tar.gz`（40MB，仅源码） |
| 验证结果 | `/health` 200（auditPersistence UP，failureCount 0）；`/admin/api/ready` 200 `{"status":"UP","databaseVersion":"8.4.5"}`；nginx 对外 `/` 与 `/admin/api/ready` 均 200；`agent-playbook` dist 版本 **1.4.1**；context dist 含 `availableRecordTypes`（schemas.js）与 `get_record_display_context`（record-display-context.js）；admin-web AgentIntegrationPage bundle 内嵌 1.4.1 |
| 合并 | 部署前确认本地 `main` = 远端 `origin/main` = `000b1b8`（ls-remote 核对） |
| 回滚 | 停服 → 解回备份包到 `app/` → 按 §6 重建 → 重启；DB 无迁移不回滚 |

---

## 部署记录 · 身份路由 user_name/批量 + MCP 405 探测分类（2026-09-03）

| 项 | 值 |
| --- | --- |
| 部署内容 | `main` @ `fc33f56`（合并部署：身份路由 `user_name` 字段 + 迁移 009 + 备注列露出 + 批量添加/批量验证 + Admin-web 批量向导与自动验证 + MCP 405 方法探测不再写审计、真实 `MCP_REQUEST_INVALID` 自描述），替换测试服务器上一版 P7 内容 |
| 打包/上传 | 本机 tar `sfoa-deploy-main-fc33f56.tar.gz`（约 41MB，排除 node_modules/.git/dist/.env.local/*.pem/*.key/*.tsbuildinfo/.wireit）→ scp `/tmp/` → 覆盖解压到 `app/` |
| 依赖 | `yarn.lock` 未变化 → **未重装** node_modules（服务器保留） |
| 构建 | 服务器按 §6 依赖顺序全量重建 10 个 workspace |
| 数据库迁移 | 共享库 `192.168.156.127/sfoa_enterprise_mcp` 应用**加性**迁移 **009** `identity_route_user_name`（`sfoa_identity_route` 增 `user_name VARCHAR(128) NOT NULL`，存量 9 行回填 = `platform_user_id`）；台账 **001–009 APPLIED**（MySQL 8.4.5） |
| 配置 | 无新增必填变量，`config/.env.local` 未改动 |
| 服务 | 重启 `sfoa-mcp-server` / `sfoa-admin-api`（mcp-server 15:40:33 CST active）；nginx 未改动；SELinux `restorecon` admin-web `dist` |
| 备份 | 部署前 app → `/data/sfoa-enterprise-mcp/backup/sfoa-app-pre-fc33f56-20260903-153806.tar.gz`（约 41MB，仅源码，排除模式已修正不再含 node_modules/dist） |
| 验证结果 | `/health` 200（`auditPersistence` 段 UP，failureCount 0）；`/admin/api/ready` 200 `{"status":"UP","databaseVersion":"8.4.5"}`；`sfoa_identity_route` 含 `user_name` 且 9 行已回填、无空值；`GET /mcp`→405 **不再**产生 `MCP_REQUEST_INVALID` 审计行（nginx 探测持续，重启后该码 0 新增，修复生效）；Admin 启动并 seed 9 个 auth 用户 |
| 合并 | 部署前：身份路由 user-name/batch 特性与 MCP 探测分类修复均已合入 `main` 并推送 `origin/main = fc33f56` |
| 回滚 | 停服 → 解回备份包到 `app/` → 按 §6 重建 → 重启；DB 迁移纯加性不回滚（见 `skills/.../operations.md` 指引，不回写 `sfoa_schema_migration`） |

---

## 部署记录 · P7 端到端审计（2026-09-03）

| 项 | 值 |
| --- | --- |
| 部署内容 | `feature/p7-end-to-end-audit` @ `ba8146f`（P7-04…P7-09 端到端审计），替换原服务器 main @ `c849e57` |
| 打包/上传 | 本机 tar 至仓库外层 `sfoa-deploy-p7.tar.gz`（~40MB，排除 node_modules/.git/dist/.env.local/*.pem/*.key/*.tsbuildinfo/.wireit）→ scp `/tmp/` → 覆盖解压到 `app/` |
| 依赖 | `yarn.lock` 未变化 → **未重装** node_modules（服务器保留） |
| 构建 | 按 §6 依赖顺序全量重建 10 个 workspace（本机时钟 09:03:58–09:04:50） |
| 数据库迁移 | 共享库 `192.168.156.127/sfoa_enterprise_mcp` 应用**加性**迁移 `005–008`（新增 `sfoa_audit_event` / `sfoa_salesforce_api_call` / `sfoa_audit_payload_evidence`，`sfoa_audit_log` 扩列回填）；台账 **001–008 APPLIED**，status PASS（MySQL 8.4.5） |
| 配置 | `.env.example` 仅注释改动 → **无新增必填变量**，`config/.env.local` 未改动 |
| 服务 | 重启 `sfoa-mcp-server` / `sfoa-admin-api`（本地 09:05:24 起 active）；nginx 未改动；SELinux `restorecon` admin-web `dist` 与 `config/.env.local` |
| 备份 | 原 main 包 → `/data/sfoa-enterprise-mcp/backup/sfoa-app-main-c849e57-2026-09-03.tar.gz`（约 1.0GB，**含 node_modules/dist**，见下方备注） |
| 验证结果 | `/health` 200（新增 `auditPersistence` 段 UP，failureCount 0）；`/admin/api/ready` 200 schema PASS；经 Nginx `/`、`/login`、`/admin/api/ready` 均 200；Admin 登录 200 并写库 `ADMIN_ACTION/ADMIN_LOGIN` 审计（`publicAuditId` 可见）；`GET /admin/api/audits` 200 读模型正常；`sfoa_audit_log` 最新行已确认；`sfoa_audit_event` / `sfoa_salesforce_api_call` / `sfoa_audit_payload_evidence` 为 0 行（尚无真实工具/SF 流量，属预期） |
| 合并 | 部署验证通过后 `feature/p7-end-to-end-audit` 以 fast-forward 合入 `main` 并推送 `origin/main` |
| 回滚 | 停服 → 解回备份包到 `app/` → 按 §6 重建 → 重启；DB 迁移纯加性不回滚（见 `skills/.../operations.md` 指引，不回写 `sfoa_schema_migration`） |

> **备份备注**：本次备份命令排除模式误用 `./` 前缀（`--exclude='./app/node_modules'` 不匹配 tar 成员 `app/node_modules`），导致 node_modules/dist 一并入包。作为「含依赖的精确回滚快照」可用；后续打包备份建议去掉 `./` 前缀、仅含源码即可。

---

## 1. 本次部署概况

### 1.1 服务器信息（实际值）

| 项目 | 实际值 |
| --- | --- |
| 主机名 | `crm-ex-test02` |
| IP | `192.168.156.203` |
| 操作系统 | Rocky Linux 9，SELinux **Enforcing**（强制模式） |
| Node.js | `v22.23.1`（NodeSource RPM 安装） |
| Yarn | `1.22.22`（Classic；已 `corepack disable`） |
| 进程管理 | systemd（root 运行） |
| 共享 MySQL | `192.168.156.127:3306`，库 `sfoa_enterprise_mcp`，账号 `crm_user` |
| Salesforce 实例 | `https://runnergroup--uat.sandbox.my.sfcrmproducts.cn` |
| 诊断用户 | `crm_admin2@runner-corp.com.cn.uat` |
| 对外访问 | 主入口 **`http://crmmcptest.runner-corp.com.cn:9000/`**（2026-09-08 域名接入，http 无证书；内网 DNS 解析到同机）；原 `http://192.168.156.203:9000/` 仍可达，但 Admin 登录不再接受该 origin（后台已切域名单源）。Admin API `/admin/api/`、MCP `/mcp` 同源。80 端口仅作**按原 host** 301 跳转到 `:9000` |
| 本机（开发） | Windows，项目位于 `D:\GitProject\sfoa-enterprise-mcp`，Git Bash 操作 |

### 1.2 部署形态（与生产一致的三进程结构）

```text
浏览器 / MCP Client（主入口）
        │  HTTP 9000
        ▼
      Nginx（监听 192.168.156.203:9000）
        ├── /           静态 Admin Web（packages/sfoa-admin-web/dist）
        ├── /admin/api/* ───▶ Admin API   127.0.0.1:8081
        └── /mcp         ───▶ MCP Runtime 127.0.0.1:8080
        ▼
  共享 MySQL 192.168.156.127:3306 / sfoa_enterprise_mcp

  对外域名（2026-09-08 起，http 无证书）：http://crmmcptest.runner-corp.com.cn:9000
  （公网 DNS → 202.109.254.220 网关 DNAT → 本机 :9000；内网 DNS → 192.168.156.203 同机）

  旧 80 入口（兼容跳转）：Nginx 另监听 :80，`return 301 $scheme://$host:9000$request_uri;`
  → 按原 host 落到 :9000（Host=域名 → 域名:9000；Host=内网 IP → 内网 IP:9000）。
```

两个 Node 服务监听：**MCP `8080`、Admin API `8081`**；浏览器通过 Nginx（`:9000`）访问前端和 API。Admin Web 前端以相对路径 `/admin/api` 调用同源 API，Nginx 改端口**无需重建前端**。

### 1.3 服务器目录布局（实际）

```text
/data/sfoa-enterprise-mcp/
├── app/                          ← 仓库根（解包后的项目目录）
│   ├── package.json
│   ├── yarn.lock
│   ├── packages/
│   ├── node_modules/
│   └── .env.local  →  ../config/.env.local   （软链）
├── config/
│   └── .env.local                ← 真实配置文件（系统维护，不入库）
└── secrets/
    └── private.pem               ← JWT 私钥（chmod 400）
```

关键点：

- **仓库根 = `/data/sfoa-enterprise-mcp/app`**（含 `packages/` 的那个目录）。应用按「模块路径里 `packages/` 往上一层」解析仓库根，因此运行时必须保持该结构。
- **配置文件单独放在 `/data/sfoa-enterprise-mcp/config/.env.local`**，用软链让 `app/.env.local` 指向它。这样重打包、覆盖 `app/` 目录不会动到配置。
- **私钥在 `/data/sfoa-enterprise-mcp/secrets/private.pem`**，`JWT_PRIVATE_KEY_PATH` 指向它（打包时 `--exclude='*.pem'`，私钥单独 `scp` 上传）。

---

## 2. 前置准备

### 2.1 本机（Windows / Git Bash）

- 已安装 Node.js（v24 可用）、Git Bash、Git。
- 项目在 `D:\GitProject\sfoa-enterprise-mcp`，当前分支 `feature/p6-agent-playbook`。
- 打包工具：Git Bash 自带 `tar`、`scp`；装 `rsync` 可选（方式三）。

### 2.2 服务器（Rocky Linux 9）

```bash
# Node.js 22 LTS（NodeSource RPM）
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo dnf install -y nodejs

# Yarn Classic 1.22.x（Node 自带 corepack 会走 Berry，务必先禁用）
sudo corepack disable
npm install -g yarn@1.22.22

# 网络/探测工具（可选）
sudo dnf install -y nmap-ncat mysql nginx

node -v        # 期望 v22.x
yarn -v        # 期望 1.22.x
git --version
```

> ⚠️ 若 `yarn -v` 显示 4.x/berry，是 corepack 拦截，`corepack disable` 后重装 `yarn@1.22.22`。

---

## 3. 从本机打包部署（本次实际使用的流程）

> 服务器**不需要 Git**。代码改动在本机开发，打包上传到服务器解压后构建运行。本次实际用的是**方式二（tar.gz + scp）**。

### 3.1 打包（Git Bash 本机执行）

**首选（按提交导出，与仓库字节严格等价）**：

```bash
cd /d/GitProject/sfoa-enterprise-mcp

# ⚠️ 必须显式关闭 autocrlf/eol，否则文本文件会被改写成 CRLF，与仓库 blob 不一致。
git -c core.autocrlf=false -c core.eol=lf archive --format=tar.gz \
    -o sfoa-app-$(git rev-parse --short HEAD)-$(date +%Y%m%d-%H%M%S).tar.gz HEAD
```

> `git archive` 只导出该提交的 tracked 文件，天然不含 `node_modules`/`.git`/`dist`/`.env.local`/`*.pem`/`*.key`/`*.tsbuildinfo`/`.wireit`，无需手工排除。
>
> **`-c core.autocrlf=false -c core.eol=lf` 不是可选项。** 本机 `core.autocrlf=true`，不带这两个开关时 `git archive` 会把文本文件重新写成 CRLF：实测 `skills/crm-record-change/SKILL.md` 由 9576 B（LF）变成 9643 B（CRLF，+67 B = 行数）。这会让服务器上的 `skills/` 与 OpenClaw runtime 副本、以及 `skill:check` / `skill:runtime:check` 的逐字节比较全部产生**假漂移**。部署后必须用 §3.5 的清单校验确认。

**备选（直接归档工作区，仅在不按提交导出时使用）**：

```bash
tar --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='tmp' \
    --exclude='secrets' --exclude='.env.local' --exclude='*.pem' --exclude='*.key' \
    --exclude='*.tsbuildinfo' --exclude='.wireit' \
    -czf ../sfoa-deploy.tar.gz .
```

> **打包必须排除**：`node_modules`（Windows 原生二进制不能搬去 Linux，服务器重新 `yarn install`）、`.git`、`dist`（构建产物，服务器重新构建）、密钥/本地环境文件、以及 **`*.tsbuildinfo` / `.wireit`**（增量构建标记，带过去会导致 wireit 误判「已最新」跳过 emit，见 §13 坑 #3）。
>
> 压缩包输出到仓库**外层** `../sfoa-deploy.tar.gz`，避免「把压缩包写进正在归档的目录」导致 `tar: .: file changed as we read it`。若根目录已有失败残留的 `sfoa-deploy.tar.gz`，先 `rm -f`。

### 3.2 上传（Git Bash 本机执行）

```bash
scp ../sfoa-deploy.tar.gz root@192.168.156.203:/tmp/

# 单独上传环境与密钥（被排除在包外，且不入库）
scp D:/GitProject/sfoa-enterprise-mcp/private.pem root@192.168.156.203:/data/sfoa-enterprise-mcp/secrets/private.pem
```

> 若本机配置了 SSH 别名（如 `crm-test02`），把 `root@192.168.156.203` 换成别名即可。

### 3.3 服务器解压（采用 staging，禁止删除同步）

```bash
STAGE=/data/sfoa-enterprise-mcp/staging-$(date +%Y%m%d-%H%M%S)
mkdir -p "$STAGE"
tar -xzf /tmp/sfoa-deploy.tar.gz -C "$STAGE"
# 依 §3.5 先备份，校验清单后覆盖；保持 app 根目录原有可遍历权限。
rsync -a --omit-dir-times --no-perms "$STAGE"/ /data/sfoa-enterprise-mcp/app/
```

> 更新也必须来自已提交 LF 归档并经 staging。旧版直接工作区 `--delete` 示例已废止；不得删除服务器独有配置、依赖或运行文件。

```bash
rsync -avz \
  --exclude node_modules --exclude .git --exclude dist --exclude tmp \
  --exclude secrets --exclude .env.local --exclude '*.pem' --exclude '*.key' \
  --exclude '*.tsbuildinfo' --exclude '.wireit' \
  /d/GitProject/sfoa-enterprise-mcp/ root@192.168.156.203:/data/sfoa-enterprise-mcp/app/
```

### 3.4 服务器安装依赖（仅首次/依赖变化时）

```bash
cd /data/sfoa-enterprise-mcp/app
yarn install --frozen-lockfile
```

> 本仓库 `workspaces.nohoist=["**"]`，每个 workspace 有独立 `node_modules`，必须**在根目录整体安装**，不能只装单个包。依赖没变时跳过，`node_modules` 装一次后一直有效。

### 3.5 落盘与字节校验（推荐做法）

**不要用 `rsync --delete` 直接覆盖 `app/`**：服务器上有若干**独有、不在仓库里**的文件，`--delete` 会把它们删掉——`.env.local`、`.idea`、`projects`、`.temp`、`.workbuddy`、`.codegraph/codegraph.db*`、`.claude/settings.local.json`、`node_modules`、各包 `dist`。推荐「先解到 staging，再 `rsync -a`（不带 `--delete`）覆盖」：

```bash
# 1) 先备份现有 app（只备源码，排除产物）
tar czf /data/sfoa-enterprise-mcp/backup/sfoa-app-pre-$(date +%Y%m%d-%H%M%S).tar.gz \
    -C /data/sfoa-enterprise-mcp/app \
    --exclude=node_modules --exclude=dist --exclude=lib --exclude=.wireit \
    --exclude=.nyc_output --exclude=test-results --exclude=.codegraph \
    --exclude=.temp --exclude='*.tsbuildinfo' .

# 2) 解到 staging，再覆盖（不带 --delete，服务器独有文件全部保留）
STAGE=/data/sfoa-enterprise-mcp/staging-$(date +%Y%m%d-%H%M%S)
mkdir -p "$STAGE" && tar xzf /data/sfoa-enterprise-mcp/incoming/<name>.tar.gz -C "$STAGE"
rsync -a "$STAGE"/ /data/sfoa-enterprise-mcp/app/
```

**部署后必须做的字节校验**（这是判断「部署是否真的等价于该提交」的唯一硬证据，代码特征比对不能替代）：

```bash
# 本机：按 HEAD 的 blob 内容生成 sha256 清单（LF，与 git 内部存储一致）
git -c core.autocrlf=false ls-tree -r HEAD   # 取 blob；或用 §3.1 的 LF 归档解包后逐个 sha256sum
# 上传清单后在服务器执行：
cd /data/sfoa-enterprise-mcp/app
sha256sum -c /data/sfoa-enterprise-mcp/incoming/expected.txt | grep -v ': OK$'
# 期望：无输出（全部 OK）。任何 FAILED/MISSING 都要先查清再继续。
```

> **运行时代码没变时不要重建、不要重启。** 先执行 `git diff <服务器当前版本>..<目标提交> -- packages yarn.lock 'packages/sfoa-control-plane/migrations' .env.example config`：若为空，则既有 `dist/` 仍由相同源码产出、依然有效，重建 + `systemctl restart` 对行为是 no-op，只会增加风险。此时确认 `packages/` 源码无差异即可跳过 §6 与 §7。
>
> 判断「服务器当前是什么版本」不要靠猜：服务器没有 `.git`，用**代码特征**（某文件/某函数是否存在）+ 归档 mtime + 备份文件名三方对齐，见各条部署记录的「变更前版本识别」。

---

## 4. 数据库：使用共享库

- 共享库在 **`192.168.156.127:3306`**，库名 **`sfoa_enterprise_mcp`**，应用账号 **`crm_user`**（测试环境用 `%` 网段授权）。
- 本次数据来源：把本机库的 6 张治理表同步到共享库（`sfoa_identity_route`、`sfoa_identity_credential`、`sfoa_tool_control`、`sfoa_dml_policy`、`sfoa_diagnostic_config`、`sfoa_runtime_setting`），跳过 `sfoa_audit_log` 与 `sfoa_schema_migration`。
- **若从全新建库开始**，两种方式任选其一：
  1. 共享库上先建库建账号，再在服务器 `cd /data/sfoa-enterprise-mcp/app && yarn db:migrate && yarn p5:bootstrap`；
  2. 或在共享库一次性导入 `docs/sfoa/SFOA_ENTERPRISE_MCP_SCHEMA.sql`（含 001/002/003 迁移 + 迁移记录），之后跳过 `db:migrate`。

> ⚠️ **加密密钥必须与本地一致**：同步过去的 `sfoa_identity_credential` 密文是用本机 `MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY` 加密的。服务器 `.env.local` 必须配置**完全相同**的值，否则 USER_BOUND 凭证无法解密、后台读不出明文 Token。若服务器打算用新密钥，需到后台对这些路由「重新生成 Token」。

---

## 5. 配置 `.env.local`

### 5.1 放置方式（本次采用：config/ 单独放 + 软链）

```bash
# 1) 配置文件放 /data/sfoa-enterprise-mcp/config/.env.local（不在 app/ 里，重打包不覆盖）
mkdir -p /data/sfoa-enterprise-mcp/config
cp /data/sfoa-enterprise-mcp/app/.env.example /data/sfoa-enterprise-mcp/config/.env.local
vim /data/sfoa-enterprise-mcp/config/.env.local

# 2) 软链：应用只读「仓库根」的 .env.local（= app/ 下）
cd /data/sfoa-enterprise-mcp/app
ln -s ../config/.env.local .env.local
ls -la .env.local        # 应显示 lrwxrwxrwx ... -> ../config/.env.local
```

> 应用通过模块路径解析到仓库根（含 `packages/` 的目录 = `/data/sfoa-enterprise-mcp/app`），只读 `app/.env.local`。放 `config/` 里不会生效；软链让 `app/.env.local` 指向 `config/.env.local`，两全其美。**不要在 `app/` 下保留另一个 `.env.local` 实体文件**（历史曾因 `app/` 下残留带 CRLF 的旧文件导致配置「改了没用」）。

### 5.2 本次实际使用的关键配置项

```dotenv
# ── 运行模式（mysql 权威）──
SFOA_CONTROL_PLANE_MODE=mysql

# ── 共享 MySQL（实际 192.168.156.127 / crm_user）──
SFOA_DB_HOST=192.168.156.127
SFOA_DB_PORT=3306
SFOA_DB_NAME=sfoa_enterprise_mcp
SFOA_DB_USER=crm_user
SFOA_DB_PASSWORD=<共享库密码>
SFOA_DB_SSL_MODE=disabled            # 共享库未开 TLS 时
SFOA_DB_CONNECTION_LIMIT=10
SFOA_DB_QUEUE_LIMIT=100
SFOA_DB_CONNECT_TIMEOUT_MS=10000

# ── Salesforce 身份（mysql 模式下用户名由库内“身份路由”管理）──
SFOA_INSTANCE_URL=https://runnergroup--uat.sandbox.my.sfcrmproducts.cn
CONNECTED_APP_CLIENT_ID=<Connected-App-Client-Id>
JWT_PRIVATE_KEY_PATH=/data/sfoa-enterprise-mcp/secrets/private.pem

# ── Admin API（Nginx 反代 /admin/api/）──
SFOA_ADMIN_BIND_HOST=127.0.0.1
SFOA_ADMIN_PORT=8081
# ⚠️ 单值 origin（zod url，解析后必须等于 new URL(...).origin），只能「替换」不能追加。
# 2026-09-08 起后台统一走域名（http 无证书）：内网同事用域名由内网 DNS 解析到同机。
# 直接敲 http://192.168.156.203:9000 登录会 403（origin 不匹配，属预期）。
SFOA_ADMIN_ALLOWED_ORIGIN=http://crmmcptest.runner-corp.com.cn:9000
SFOA_ADMIN_USERNAME=admin
SFOA_ADMIN_PASSWORD=<管理员密码，明文>
SFOA_ADMIN_SESSION_SECRET=<48字节base64url随机串>
SFOA_ADMIN_COOKIE_SECURE=false      # 内网明文 HTTP 时；生产 HTTPS 需 true
SFOA_ADMIN_SESSION_TTL_SECONDS=28800
SFOA_ADMIN_LOGIN_MAX_ATTEMPTS=5
SFOA_ADMIN_LOGIN_WINDOW_MS=900000
# ADR-0034：受限控制台账号（可选）。JSON 数组，每项恰好 {username,password,modules}；
# modules 必填、不默认全量；用户名大小写不敏感去重且不得复用 SFOA_ADMIN_USERNAME；
# 最多 16 个。值非法则 Admin API 拒绝启动（不会半开）。改完必须重启 Admin API。
# 未配置时后台只有上面的 admin 账号，行为与 P10 完全一致。
# SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON=[{"username":"btit","password":"<明文密码>","modules":["dashboard","identity-routes","audit","system","agent-integration"]}]
# ── MCP Runtime（Nginx 反代 /mcp）──
MCP_BIND_HOST=0.0.0.0
MCP_PORT=8080
MCP_PATH=/mcp
MCP_PUBLIC_URL=http://crmmcptest.runner-corp.com.cn:9000/mcp
MCP_AUTH_MODE=internal_bearer
MCP_CLIENT_TOKEN=<内部服务Token，≥16字符>
MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY=<32字节base64url，与本地一致！>
MCP_PLATFORM_USER_HEADER=X-Platform-User-Id
# P8-05：启用企业微信 MCP Plugin 身份通道（可选）。X-WeCom-User-Id 仅作身份上下文，
# 仍需先通过 Bearer 认证；不得重复主 Header，非法值会在启动时 fail fast。
# MCP_PLATFORM_USER_HEADER_ALIASES=X-WeCom-User-Id
MCP_REQUEST_TIMEOUT_MS=180000
MCP_TOOL_TIMEOUT_MS=120000
# 逗号列表可追加；经 Nginx 反代 Host 用 $host（不带端口），故外网 IP/域名都放「无端口」+「原形态」双保险。
# 2026-09-08 起含：本机、内网 IP、外网映射 202.109.254.220(:9000)、域名 crmmcptest.runner-corp.com.cn(:9000)。
MCP_ALLOWED_HOSTS=127.0.0.1:8080,localhost:8080,192.168.156.203,192.168.156.203:9000,202.109.254.220,202.109.254.220:9000,crmmcptest.runner-corp.com.cn,crmmcptest.runner-corp.com.cn:9000
MCP_ALLOWED_ORIGINS=http://127.0.0.1:8080,http://localhost:8080,http://192.168.156.203,http://192.168.156.203:9000,http://202.109.254.220:9000,http://crmmcptest.runner-corp.com.cn:9000,http://crmmcptest.runner-corp.com.cn

# ── 无头 Linux 钥匙串（本次根因修复；代码已自动引导，保留无副作用）──
SF_USE_GENERIC_UNIX_KEYCHAIN=true

# ── P6-ID-02 Buntu（按需开启）──
MCP_BUNTU_IDENTITY_ENABLED=true
MCP_BUNTU_VALIDATE_TOKEN_URL=<Buntu 校验接口>
MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED=false
```

### 5.3 密钥生成命令

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))"   # SFOA_ADMIN_SESSION_SECRET
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"   # MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY
node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))"   # MCP_CLIENT_TOKEN
```

### 5.4 配置文件的「三不要三必须」

| 规则 | 说明 |
| --- | --- |
| ❌ 不要 `source` 它 | `.env.local` 是 dotenv 格式，不是 shell 脚本；含空格/`<...>`/`$`/反引号/`\r` 的行会被 bash 当命令执行报 `: command not found`，且会把带 `\r` 的旧值灌进 shell 环境（`process.env` 优先级高于文件，污染后「文件改好了报错却不变」）。应用自己会读文件，无需 source。 |
| ❌ 不要保留 Windows CRLF | 本机 Windows 编辑后行尾是 `\r\n`，应用的解析器不剥 `\r`，值变成 `internal_bearer\r` 等导致枚举校验失败。传输前先转：`sed -i 's/\r$//' /data/sfoa-enterprise-mcp/config/.env.local`。 |
| ❌ 不要残留 `<...>` 占位符 | 逐个替换为真实值，尤其是密码、加密密钥、Token。 |
| ✅ 必须放在软链的 `app/.env.local`（指向 config/） | 应用只读仓库根的 `.env.local`。 |
| ✅ 改完后必须 `restorecon` | `sed -i`/覆盖写会重建文件、SELinux 标签退回 `default_t`，systemd 读 EnvironmentFile 会报 Permission denied。 |
| ✅ 必须让 `MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY` 与本地逐字符一致 | 否则已同步的 USER_BOUND 凭证无法解密。 |

```bash
# 改完配置后（每次覆盖写都必须执行）
restorecon -v /data/sfoa-enterprise-mcp/config/.env.local
ls -lZ /data/sfoa-enterprise-mcp/config/.env.local   # 必须显示 :etc_t，而不是 default_t
```

---

## 6. 构建（依赖顺序）

全新解包后所有 `dist` 都不存在（打包排除了 `dist`、无 postinstall 钩子），必须按**依赖顺序**完整构建。**顺序不能乱**：

```bash
cd /data/sfoa-enterprise-mcp/app
yarn workspace @sfoa/agent-playbook build
yarn workspace @salesforce/mcp-provider-api build        # 最底层，最容易漏掉！
yarn workspace @salesforce/mcp-provider-dx-core build
yarn workspace @sfoa/mcp-provider-sfoa-context build
yarn workspace @sfoa/mcp-provider-sfoa-dml build
yarn workspace @sfoa/mcp-provider-sfoa-data build         # MCP Server 也依赖 Data Provider
yarn workspace @sfoa/identity-runtime build              # 依赖 provider-api / dx-core
yarn workspace @sfoa/control-plane build                 # 依赖 identity-runtime
yarn workspace @sfoa/mcp-server build                    # 依赖上述全部
yarn workspace @sfoa/admin-api build                     # 依赖 mcp-server
yarn workspace @sfoa/admin-web build                     # tsc + vite，产物在 packages/sfoa-admin-web/dist
```

> 不要用根目录 `yarn build`（并行跑会因依赖方 `dist` 未产出而竞态失败）。构建报缺某个 `@sfoa/*` / `@salesforce/mcp-provider-*` → 对应 workspace 没先构建；`@salesforce/mcp-provider-api` 是最底层。
>
> ⚠️ 已按顺序构建仍报 `TS2307 ... mcp-provider-api`（wireit 提示「is up to date ... tsconfig.tsbuildinfo」）→ 打包带了本地 `*.tsbuildinfo` 增量标记，误判已最新跳过 emit。清掉重建：
> ```bash
> find packages -name '*.tsbuildinfo' -type f -delete
> find packages -name '.wireit' -type d -prune -exec rm -rf {} + 2>/dev/null
> # 再按上面顺序重建
> ```

---

## 7. systemd 服务管理（本次实际用法）

### 7.1 单元文件（/etc/systemd/system/）

**`/etc/systemd/system/sfoa-mcp-server.service`：**

```ini
[Unit]
Description=SFoA Enterprise MCP Runtime
After=network.target

[Service]
Type=simple
WorkingDirectory=/data/sfoa-enterprise-mcp/app
EnvironmentFile=/data/sfoa-enterprise-mcp/config/.env.local
ExecStart=/usr/bin/node /data/sfoa-enterprise-mcp/app/packages/sfoa-mcp-server/dist/main.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**`/etc/systemd/system/sfoa-admin-api.service`：** 同上，`Description` 换成 `SFoA Enterprise MCP Admin API`，`ExecStart` 换成 `packages/sfoa-admin-api/dist/main.js`。

> 本次部署两个服务**以 root 运行**（unit 里不写 `User=`）。这决定 SFDX 认证存储目录是 `/root/.sfdx`，且能读到 `secrets/private.pem`（`chmod 400`）。

### 7.2 注册并启动

```bash
systemctl daemon-reload
systemctl enable --now sfoa-mcp-server sfoa-admin-api
systemctl status sfoa-mcp-server sfoa-admin-api --no-pager
```

> 单元文件若改过（新增/删除环境变量等），都要先 `systemctl daemon-reload` 再 `restart`。

---

## 8. Nginx 反向代理与静态托管

- 安装：`sudo dnf install -y nginx && sudo systemctl enable --now nginx`。
- 配置位置：**`/etc/nginx/conf.d/*.conf`**（默认 `nginx.conf` 会 include 该目录；本次的 server 块放于此）。
- 对外开放 **9000（主入口）+ 80（仅 301 跳转）**（内网明文 HTTP）；8080/8081 仅服务进程监听，不直接暴露。
- firewalld：`firewall-cmd --permanent --add-port=9000/tcp && firewall-cmd --reload`；`http`(=80) 服务保留供跳转。SELinux `http_port_t` 默认已含 9000，无需 semanage（用 `semanage port -l | grep http_port_t` 复核）。

**本次实际使用的配置**（`/etc/nginx/conf.d/mcp-service.conf`，重载 `systemctl reload nginx`）——2026-09-08 起两个 server 块：`:80` 按原 host 301 到 `:9000`，`:9000` 为主入口（`server_name` 均含域名 `crmmcptest.runner-corp.com.cn`）：

```nginx
# ── 旧 80 兼容跳转：保留给存量书签/旧访问者；按原 host 落到 :9000 ──
server {
    listen 80;
    server_name 192.168.156.203 crmmcptest.runner-corp.com.cn;
    return 301 $scheme://$host:9000$request_uri;
}

# ── 主入口 9000（2026-09-08 由 80 迁移；同日起域名 http(:9000) 接入）──
server {
    listen 9000;
    server_name 192.168.156.203 crmmcptest.runner-corp.com.cn;
    client_max_body_size 20m;

    # React Admin Web（Vite 构建产物）
    root /data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist;
    index index.html;

    # ── Admin API ──
    location /admin/api/ {
        proxy_pass http://127.0.0.1:8081/admin/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 30s;
        proxy_send_timeout 180s;
        proxy_read_timeout 180s;
    }

    # ── MCP Streamable HTTP（关闭缓冲）──
    location = /mcp {
        proxy_pass http://127.0.0.1:8080/mcp;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Platform-User-Id $http_x_platform_user_id;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ── SPA history 路由回退 ──
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

> 跳转仅对**浏览器/Admin 初始页面**透明（GET 跟随 301）；**MCP Streamable HTTP 客户端**（POST）通常不跟随 301，存量连接端点需由 `http://192.168.156.203/mcp` 改到 `http://192.168.156.203:9000/mcp`。

> **SELinux 配套**（见 §9）：静态目录需打 `httpd_sys_content_t` 标签；反代到 8080/8081 需 `setsebool -P httpd_can_network_connect 1`，否则分别报 403 / 502。

---

## 9. SELinux（Rocky 9 默认 Enforcing，本次踩坑最多）

### 9.1 静态 Admin Web 403（nginx 读不了 dist）

```bash
# 给 dist 打 httpd_sys_content_t 标签（semanage 规则持久，restorecon 应用）
semanage fcontext -a -t httpd_sys_content_t '/data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist(/.*)?'
restorecon -Rv /data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist

# 验证：index.html 的 context 应变为 httpd_sys_content_t
ls -lZ /data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist/index.html
```

> `semanage: command not found` 时先 `dnf install -y policycoreutils-python-utils`。
> 以后**每次重新构建 admin-web** 都要再跑一次 `restorecon -Rv`（新文件 context 又会退回 `default_t`）。
>
> ⚠️ 同一原因在 SPA 上通常表现为 **500 而不是 403**：`location /` 的 `try_files $uri $uri/ /index.html`
> 一旦读不了 `index.html` 就形成重写死循环，`error.log` 里是
> `stat() ".../dist/index.html" failed (13: Permission denied)` +
> `rewrite or internal redirection cycle`。看日志像服务端故障，实际仍是标签问题——先 grep error log
> 的 `Permission denied`。（2026-10-09 实例见顶部「P10 激活后控制台 500 修复」记录。）
>
> 另外，dist 若是从 Windows 侧归档解包上来的，文件属主会是本机不存在的数字 uid/gid（如
> `1651478:1049089`），先 `chown -R root:root dist` 对齐再 `restorecon`。

### 9.2 反代 502（nginx 连不上 8080/8081）

```bash
setsebool -P httpd_can_network_connect 1
getsebool httpd_can_network_connect   # 应显示 on
```

### 9.3 systemd 读环境文件失败（Result: resources / Permission denied）

```bash
# 把 .env.local 打上 etc_t 标签（systemd 和 node 进程才能读）
semanage fcontext -a -t etc_t '/data/sfoa-enterprise-mcp/config/.env.local'
restorecon -v /data/sfoa-enterprise-mcp/config/.env.local
ls -lZ /data/sfoa-enterprise-mcp/config/.env.local   # 应显示 etc_t
```

> ⚠️ **每次用 `sed -i` / 覆盖写 config/.env.local 后必须重跑 `restorecon`**——重建文件会丢标签。这是本次反复踩的坑。

---

## 10. 启动 / 停止 / 重启 / 查看日志（速查）

### 10.1 启动

```bash
systemctl start sfoa-mcp-server sfoa-admin-api
# 设置开机自启（已 enable 的无需重复）
systemctl enable --now sfoa-mcp-server sfoa-admin-api
```

### 10.2 停止

```bash
systemctl stop sfoa-mcp-server sfoa-admin-api
```

### 10.3 重启（改配置/换代码后）

```bash
systemctl restart sfoa-mcp-server sfoa-admin-api
systemctl status sfoa-mcp-server sfoa-admin-api --no-pager
```

### 10.4 查看状态

```bash
systemctl status sfoa-mcp-server sfoa-admin-api --no-pager     # 是否 active
systemctl is-active sfoa-mcp-server sfoa-admin-api             # 快速输出 active
ps -eo user,pid,args | grep -E 'sfoa-(mcp-server|admin-api)' | grep -v grep
```

### 10.5 查看运行时日志

```bash
# 实时跟踪（Ctrl+C 退出）
journalctl -u sfoa-mcp-server -f
journalctl -u sfoa-admin-api -f

# 最近 N 条
journalctl -u sfoa-mcp-server -n 100 --no-pager
journalctl -u sfoa-admin-api -n 100 --no-pager

# 按关键词过滤（如诊断验证失败）
journalctl -u sfoa-admin-api --since '-15 minutes' --no-pager | grep -iE 'verification|invalid_grant|NamedOrg|MCP_METADATA|correlation'

# 按时间窗
journalctl -u sfoa-mcp-server --since '2026-08-26 14:00:00' --until '2026-08-26 15:00:00' --no-pager
```

日志是 JSON 行：启动成功见 `"event":"sfoa_runtime_started"`、启动失败见 `"event":"sfoa_runtime_start_failed"` + `message`。

### 10.6 健康检查

```bash
curl -i http://127.0.0.1:8080/health            # MCP 运行时
curl -i http://127.0.0.1:8081/admin/api/ready   # Admin API（含 DB/schema 就绪）
curl -i http://192.168.156.203:9000/admin/api/ready  # 经 Nginx :9000 对外
curl -i http://crmmcptest.runner-corp.com.cn:9000/admin/api/ready  # 域名入口（http 无证书）
curl -I http://192.168.156.203:9000/                 # 前端首页（:9000 主入口）
curl -i http://192.168.156.203:80/                   # 应 301 → Location: http://192.168.156.203:9000/
```

---

## 11. 验证（浏览器）

1. 打开 `http://crmmcptest.runner-corp.com.cn:9000/login`（对外主入口，2026-09-08 起后台 origin 为此域名单源；用 `SFOA_ADMIN_USERNAME` / `SFOA_ADMIN_PASSWORD` 登录）。内网机器用同一域名地址（内网 DNS 解析到同机）即可；直接敲 `http://192.168.156.203:9000` 会因 origin 不符在登录时 403。
2. 「系统状态」确认运行模式为 `mysql`、`MCP_PUBLIC_URL` 正确。
3. 「用户身份路由」新建路由 → 保存 → 自动生成 USER_BOUND 凭证并弹出「接入配置」。
4. 「诊断」配置用户名后运行「验证 Diagnostic Connection」→ 应 **PASS**。
5. 如需 WorkBuddy/Dify：复制 WorkBuddy JSON 到自定义连接器做只读测试调用。

---

## 12. 更新与重新部署

日常改动代码后的更新流程（本机 → 服务器）：

```bash
# 1. 本机：重新打包上传（§3.1/3.2），服务器解压（§3.3）
cd /d/GitProject/sfoa-enterprise-mcp
tar --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='tmp' \
    --exclude='secrets' --exclude='.env.local' --exclude='*.pem' --exclude='*.key' \
    --exclude='*.tsbuildinfo' --exclude='.wireit' \
    -czf ../sfoa-deploy.tar.gz .
scp ../sfoa-deploy.tar.gz root@192.168.156.203:/tmp/
# 服务器上：
tar -xzf /tmp/sfoa-deploy.tar.gz -C /data/sfoa-enterprise-mcp/app

# 2. 服务器：依赖没变就跳过 install
cd /data/sfoa-enterprise-mcp/app
# yarn install --frozen-lockfile   # 仅 package.json / yarn.lock 变化时

# 3. 有新迁移才跑（先 db:status 确认）
# yarn db:status && yarn db:migrate

# 4. 按依赖顺序重建（§6 的 10 条，只改单包也可只 build 它 + 依赖它的包）
# 5. 重启两个服务
systemctl restart sfoa-admin-api sfoa-mcp-server

# 6. 若构建了 admin-web，重打静态目录 SELinux 标签（§9.1）
restorecon -Rv /data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist

# 7. 验证
curl -s http://127.0.0.1:8081/admin/api/ready
curl -s http://127.0.0.1:8080/health
```

> 已按代码级自愈（方案B）部署后，**不需要**再手工种 `/root/.sfdx`，也不用手工加 `SF_USE_GENERIC_UNIX_KEYCHAIN=true`（代码在启动时自动引导 + 种子化）。若需验证自愈：`rm -rf /root/.sfdx` + 从 `.env.local` 删掉该行 → 重启 → `ls /root/.sfdx/*.json` 应出现各用户种子文件，浏览器诊断仍 PASS。

---

## 13. 本次部署踩坑记录（含修复）

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | `tar: .: file changed as we read it`（exit 1） | 压缩包写进了正在归档的目录 | 打包输出到仓库**外层** `../sfoa-deploy.tar.gz`；残留包先 `rm -f` |
| 2 | 构建报 `TS2307: Cannot find module '@sfoa/agent-playbook'` | 依赖 workspace 的 `dist` 未构建（打包排除了 dist），且构建顺序不对 | 按 §6 依赖顺序先构建依赖包 |
| 3 | 构建报 `TS2307 ... @salesforce/mcp-provider-api`（wireit 提示「is up to date」） | 打包把本地 `*.tsbuildinfo` / `.wireit` 带上了服务器，增量构建误判跳过 emit | `find packages -name '*.tsbuildinfo' -delete` 并删 `.wireit`，重建；打包 exclude 增加 `*.tsbuildinfo` / `.wireit` |
| 4 | `source .env.local` 报一堆 `: command not found` | `.env.local` 是 dotenv 格式不是 shell 脚本，部分行被当命令执行 | **不要 source**；应用自己读文件 |
| 5 | 启动报 `MCP_AUTH_MODE: Invalid enum value ... received 'internal_bearer\r'` | Windows CRLF，应用解析器不剥 `\r`，值带 `\r`，枚举校验 fail-closed | `sed -i 's/\r$//'` 整个文件；本机传输前先转行尾 |
| 6 | 文件已改干净仍报 `\r` | 之前 `source` 把带 `\r` 的值写进了 shell 环境，`process.env` 优先于文件 | `for v in $(env \| cat -A \| grep '\^M' \| cut -d= -f1); do unset "$v"; done`（或 `env -i ...`） |
| 7 | 配置放 `config/` 不生效 / 报了 `\r` 但 config/ 那份已改好 | 应用只读仓库根 `app/.env.local`；`app/` 下有残留旧文件 | `ln -s ../config/.env.local app/.env.local`，删除 `app/` 下实体旧文件 |
| 8 | 首页 403 `(13: Permission denied)` | SELinux：dist 是 `default_t`，nginx 只读 `httpd_sys_content_t` | `semanage fcontext -a -t httpd_sys_content_t` + `restorecon -Rv`（每次重建后重跑） |
| 9 | `/admin/api/`、`/mcp` 反代 502 | SELinux 禁止 nginx 发起网络连接 | `setsebool -P httpd_can_network_connect 1` |
| 10 | `systemctl status` 显示 `Unit ... could not be found` | `.service` 文件不在 `/etc/systemd/system/` | 重建到正确位置 + `systemctl daemon-reload` + `enable --now` |
| 11 | systemd 服务 `Result: resources` 崩溃循环 | SELinux 拦 systemd 读 `EnvironmentFile`（`default_t`） | `.env.local` 打 `etc_t` 标签；**每次覆盖写后重 `restorecon`** |
| 12 | 登录报 `MCP_ADMIN_ORIGIN_NOT_ALLOWED` | `SFOA_ADMIN_ALLOWED_ORIGIN` 不是当前对外入口 origin | 单值替换为**当前对外主入口 origin**：2026-09-08 迁 :9000 后为 `http://192.168.156.203:9000`，同日域名接入后为 `http://crmmcptest.runner-corp.com.cn:9000`（内网也走域名）；并给 `MCP_ALLOWED_HOSTS/ORIGINS` 追加对应入口，`restorecon` 后重启 |
| 13 | 系统诊断验证 `MCP_ADMIN_VERIFICATION_FAILED` | ① dx-core `retrieve_metadata` 按用户名查本地 SFDX store，`~/.sfdx/<user>.json` 缺失抛 `NamedOrgNotFoundError`；② 无头 Linux 上 `@salesforce/core` 的 Crypto 走 DBus SecretService 失败 → `orgs.write()` 静默 no-op → auth 文件写不进 | 设 `SF_USE_GENERIC_UNIX_KEYCHAIN=true`（改走文件钥匙串）+ 种子化 `/root/.sfdx/<user>.json`；**已代码级固化（方案B）**：启动自动引导 + 自动种子化，重部署/清 `.sfdx` 不再复发 |
| 14 | 验证失败页面只显示笼统 `MCP_ADMIN_VERIFICATION_FAILED`，看不到真实原因 | `safeVerificationError` 未识别 `ContextRuntimeError`，把 `MCP_METADATA_CONTEXT_FAILED` 等真实码吞掉 | **已代码级修复**：`safeVerificationError` 补 `instanceof ContextRuntimeError`，真实错误码（7 个）不再被吞 |
| 15 | 粘贴 `cat > /tmp/xx.cjs <<'EOF'` 后回车不执行 / 语法错 | 粘贴时带了 `>` 提示符或前导空格，heredoc 被截断/换行错位 | 整块**顶格**粘贴（每行无缩进），结束符 `EOF` 单独一行顶格，再另起一行执行 `node /tmp/xx.cjs` |

---

## 14. 常用命令速查

| 目的 | 命令 |
| --- | --- |
| 本机打包 | `cd /d/GitProject/sfoa-enterprise-mcp && tar ... -czf ../sfoa-deploy.tar.gz .`（见 §3.1） |
| 本机上传 | `scp ../sfoa-deploy.tar.gz root@192.168.156.203:/tmp/` |
| 上传私钥 | `scp D:/GitProject/sfoa-enterprise-mcp/private.pem root@192.168.156.203:/data/sfoa-enterprise-mcp/secrets/private.pem` |
| 服务器解压 | `tar -xzf /tmp/sfoa-deploy.tar.gz -C /data/sfoa-enterprise-mcp/app` |
| 安装依赖 | `cd /data/sfoa-enterprise-mcp/app && yarn install --frozen-lockfile` |
| 构建全部 | §6 的 10 条 `yarn workspace ... build`（依赖顺序） |
| 迁移 | `cd /data/sfoa-enterprise-mcp/app && yarn db:status && yarn db:migrate` |
| 治理引导 | `yarn p5:bootstrap` |
| 启动 | `systemctl start sfoa-mcp-server sfoa-admin-api` |
| 停止 | `systemctl stop sfoa-mcp-server sfoa-admin-api` |
| 重启 | `systemctl restart sfoa-admin-api sfoa-mcp-server` |
| 状态 | `systemctl status sfoa-mcp-server sfoa-admin-api --no-pager` |
| 实时日志 | `journalctl -u sfoa-mcp-server -f` / `journalctl -u sfoa-admin-api -f` |
| 最近日志 | `journalctl -u sfoa-mcp-server -n 100 --no-pager` |
| 健康检查 | `curl -i http://127.0.0.1:8080/health`、`curl -i http://127.0.0.1:8081/admin/api/ready` |
| 对外验证 | `curl -I http://192.168.156.203:9000/`、`curl -i http://192.168.156.203:9000/admin/api/ready`（`:80` 返回 301 属预期） |
| 改配置后重打标签 | `restorecon -v /data/sfoa-enterprise-mcp/config/.env.local` |
| 重建 admin-web 后重打标签 | `restorecon -Rv /data/sfoa-enterprise-mcp/app/packages/sfoa-admin-web/dist` |
| 数据库查询 | `mysql -h 192.168.156.127 -P 3306 -u crm_user -p sfoa_enterprise_mcp -e "SELECT ..."` |

---

## 15. 参考文档

- 生产部署与 Nginx/HTTPS/备份：`docs/sfoa/P5_DEPLOYMENT.md`
- 本地开发启动与治理配置：`docs/sfoa/P5_LOCAL_SETUP.md`
- 反向代理与暴露模型：`docs/sfoa/P2_REVERSE_PROXY.md`
- 一键建库 SQL：`docs/sfoa/SFOA_ENTERPRISE_MCP_SCHEMA.sql`
- USER_BOUND 身份路由凭证生命周期：`docs/sfoa/P6_ID_01_USER_BOUND_CREDENTIAL.md`
- Buntu（小犇/Dify）真实用户身份：`docs/sfoa/P6_ID_02_BUNTU_TOKEN_IDENTITY.md`
- Dify / WorkBuddy 接入：`docs/agent/DIFY_SETUP.md`、`docs/agent/WORKBUDDY_SETUP.md`

## P8-06 WeCom native MCP plugin

Configure the Runtime and Admin API with the same protected environment:

```env
MCP_PLATFORM_USER_HEADER=X-Platform-User-Id
MCP_PLATFORM_USER_HEADER_ALIASES=X-WeCom-User-Id
MCP_WECOM_CHANNEL_ENABLED=true
MCP_WECOM_CLIENT_TOKEN=<CHANGE_ME>
```

Replace the placeholder with an independent secret of at least 32 random characters;
never use MCP_CLIENT_TOKEN or a USER_BOUND token. Restart Runtime and Admin API.
In the WeCom plugin set Authorization to `Bearer <MCP_WECOM_CLIENT_TOKEN>`.
X-WeCom-User-Id is auto-injected by WeCom for Tool execution; do not configure a fixed
user. Saving/discovering tools does not require a user and does not access Salesforce.
Existing Internal clients retain MCP_CLIENT_TOKEN plus X-Platform-User-Id.
Keep Authorization and X-WeCom-User-Id intact through the existing reverse proxy.
See [P8-06 deployment/UAT](P8_06_WECOM_CHANNEL_DISCOVERY.md).

## P9 data-completeness (T1+T2) deployment

Deployed `feature/p9-data-completeness` at `dbdaf67` to 192.168.156.203 on 2026-09-28,
with LF endings and no build output so the server's bytes are reproducible from the archive:

```bash
git -c core.autocrlf=false -c core.eol=lf archive --format=tar.gz --prefix=app/ -o sfoa-p9-<sha>.tar.gz HEAD
```

| | |
|---|---|
| archive | `sfoa-p9-dbdaf67-20260928-122025.tar.gz` |
| size / sha256 | 2,779,734 bytes / `07a06263994446a8dbd06af73c4193e3d5843252aac0c90f14b5932d7189d78a` |
| contents | 1183 files; no `dist/`, no `.env.local`, no `.git` |
| pre-deploy backup | `/data/sfoa-enterprise-mcp/backup/sfoa-app-pre-p9-20260928-122521.tar.gz` (1,063,819,838 bytes) |
| staging | `/data/sfoa-enterprise-mcp/staging-p9-20260928-122521` |
| manifest | `/data/sfoa-enterprise-mcp/p9-expected-manifest.txt` (1183 lines) |

**What shipped.** A new workspace `packages/mcp-provider-sfoa-data`
(`@sfoa/mcp-provider-sfoa-data@0.1.0-p9`) with `list_sobjects`, `describe_sobject` and
`query_records`, plus `DataToolFacade` in `sfoa-mcp-server` and the matching Admin catalog
rows. The Tools are READ / USER / GA and default-disabled: they are not in
`DEFAULT_ENABLED_TOOLS` and have no `sfoa_tool_control` row, so `tools/list` is unchanged
until an Admin enables them in Tool Governance. No `mcp-provider-dx-core` file and no
official `run_soql_query` behaviour was touched.

**node_modules after the failed install.** `yarn install --frozen-lockfile` fails
deterministically on this server with
`ENOENT ... lstat '.../@typescript-eslint/eslint-plugin/node_modules/ignore'` — the yarn v1
+ `nohoist: ["**"]` linker bug of §8. It is confined to lint-only dependencies; runtime
resolution was intact throughout. The runtime tree was restored byte-exactly from the
pre-deploy backup and the new workspace was linked by hand:

```bash
ln -s ../../packages/mcp-provider-sfoa-data \
  /data/sfoa-enterprise-mcp/app/node_modules/@sfoa/mcp-provider-sfoa-data
for p in sfoa-mcp-server sfoa-admin-api; do
  ln -s ../../../mcp-provider-sfoa-data \
    /data/sfoa-enterprise-mcp/app/packages/$p/node_modules/@sfoa/mcp-provider-sfoa-data
done
```

`mcp-provider-dx-core` was deliberately not rebuilt: its source is unchanged and it emits
`lib/`, not `dist/`.

**Verification — all green.**

| check | result |
|---|---|
| app tree vs archive | `BYTE_VERIFY_OK` (`sha256sum -c` over all 1183 files) |
| services | restarted 12:50:19 clean, new PIDs |
| `/health`, `/admin/api/ready` | 200 within 1s |
| audit persistence | UP, zero failures |
| service journal | no errors |
| nginx `:9000/health` | 200 |
| live `tools/list` (authenticated) | 16 Tools, exactly the 16 enabled `sfoa_tool_control` rows |
| P9 Tools advertised | none of `list_sobjects`, `describe_sobject`, `query_records` (by design) |
| Admin catalog `/admin/api/tools` | 104 rows; all three P9 Tools present as READ / USER / GA / `enableAllowed: true` / `enabled: false`; no `UNKNOWN` rows |
| playbook version | 1.9.0 (1.10.0 belongs to T5) |

**Known limitation — the P9 live gate cannot run on this server.**
_(Resolved by the 2026-09-28 `a9d0f13` deployment recorded below: the harness now composes the
Attachment Ingress. Kept as written because it describes the state at `dbdaf67`.)_ `yarn workspace
@sfoa/mcp-server validate:p9` refuses with `MCP_ATTACHMENT_CONFIGURATION_INVALID`:

> Enabled Tool upload_files_to_record requires the SFOA Attachment Ingress, which is not
> enabled on this runtime.

This is neither a P9 nor a deployment defect. `upload_files_to_record` has been enabled in
`sfoa_tool_control` (row id 16, created 2026-09-16) since the attachment work shipped, and
the runtime refuses any enabled attachment Tool with no ingress bound:

- `packages/sfoa-mcp-server/src/provider-runtime.ts:408` — throws when `options.attachmentIngress` is absent
- `packages/sfoa-mcp-server/src/discovery-server.ts:156` — the same refusal on the discovery surface
- `packages/sfoa-mcp-server/src/runtime.ts:73,86` — the only place that composes the ingress, from `config` + `store`

The deployed service wires it and is healthy — the `tools/list` row above is 16 Tools over
`/mcp` at HTTP 200, `upload_files_to_record` among them. The validation harness at
`packages/sfoa-mcp-server/src/validation/p9-live-validation.ts:266-281` calls
`startRemoteMcpServer` without it, so its own in-process server rejects every request
before any Tool is called. The gate is therefore blocked on any Control Plane that enables
the attachment Tool; it ran PASS locally only because the local Control Plane does not.
The refusal never reaches the `sfoa-mcp-server` service journal (0 occurrences in 30 days),
so it cannot be found by reading logs — the visible symptom is only the gate's HTTP 500.
Fixing it means composing the ingress in the harness the way `runtime.ts` does; that is a
code change rather than a deployment step, and was left for a separate decision.

## P9-T3 `get_org_limits` identity move deployment (2026-09-28)

Deployed the branch tip `a9d0f13` of `feature/p9-data-completeness` on 2026-09-28, directly from
the feature branch and **not** merged to `main` first — the same shape as the T1+T2 deployment
above.

| | |
|---|---|
| source ref | `feature/p9-data-completeness` @ `a9d0f13` (not in `main`) |
| archive | `sfoa-p9-a9d0f13-20260928-172335.tar.gz` |
| size / sha256 | 2,864,097 bytes / `ef7ebc75c7dd4de5d1322ce1b7532949a21cb2cb164b27de663b515ca837796f` |
| contents | 1197 manifest entries; no `dist/`, no `.env.local`, no `.git` |
| pre-deploy backup | `backup/sfoa-app-pre-a9d0f13-20260928-172335.tar.gz` (10,115,216 bytes, source only) |
| staging | `staging-p9-a9d0f13-20260928-172335` |
| manifest | `p9-a9d0f13-expected-manifest.txt` (1197 lines) |

**What shipped.** Four workspaces changed; no migration, no lockfile and no manifest change.
`@sfoa/identity-runtime` gains two `SalesforceApiPurpose` members (`ORG_LIMITS`, `SOSL_SEARCH`),
`@sfoa/mcp-provider-sfoa-context` gains the Tool, `@sfoa/mcp-provider-sfoa-data` loses it, and
`sfoa-mcp-server` gains `org-limits-context-executor.ts` with the audit-purpose wiring. See
[ADR-0027](adr/ADR-0027-p9-org-limits-diagnostic-identity.md) and the 2026-09-28 CHANGELOG entry.

**Rebuilt in dependency order.** `sfoa-admin-api` was deliberately not rebuilt: it is `tsc`
output that resolves `SFOA_CONTEXT_TOOL_NAMES` from the context package's `dist` at runtime, so it
picks up the new role map without one.

```bash
yarn workspace @sfoa/identity-runtime run build
yarn workspace @sfoa/mcp-provider-sfoa-context run build
yarn workspace @sfoa/mcp-provider-sfoa-data run build
yarn workspace @sfoa/mcp-server run build
```

**Verification — all green.**

| check | result |
|---|---|
| app tree vs archive | `BYTE_VERIFY_OK` — 1197 OK, 0 NOT OK |
| symlink | `packages/mcp/README.md` is still a symlink, not a regular file |
| server-only files | preserved (`rsync -a` without `--delete`) |
| dist markers | context `dist/tools/get-org-limits.js` + `dist/org-limits.js` present; data `dist/tools/get-org-limits.js` + `dist/org-limits-executor.js` **gone**; server `dist/org-limits-context-executor.js` present |
| services | `sfoa-mcp-server` 17:26:34, `sfoa-admin-api` 17:26:38, both `active`, `NRestarts=0` |
| `/health`, `/admin/api/ready` | 200; `auditPersistence UP`, `failureCount 0`, `databaseVersion 8.4.5` |
| nginx | `:9000/` 200, `:9000/admin/api/ready` 200, domain `:9000/admin/api/ready` 200, `:80` 301 |
| service journal | 0 errors since restart |
| Admin catalog | `get_org_limits` = READ / **DIAGNOSTIC** / GA, `search_records` = READ / USER / GA, both `enableAllowed: true` |

`validate:p9` was **not** re-run on this server, so no live gate result is claimed here.

**Two facts the T1+T2 section above cannot show.**

*Tool Governance moved on after that record was written.* Its row "16 Tools, exactly the 16
enabled `sfoa_tool_control` rows" was true at 12:50 and is rows 1–16. Rows 17–21 were enabled
afterwards, each with `row_version = 1` — an insert, never an update:

| id | Tool | Enabled (application clock) | Source of the time |
|---|---|---|---|
| 17–19 | `describe_sobject`, `list_sobjects`, `query_records` | ≈ 13:02:46–13:02:59 | derived: database stamp + the measured 366 s skew |
| 20 | `get_org_limits` | 17:31:17 | `UPDATE_TOOL_CONTROL`, `result = PASS` |
| 21 | `search_records` | 17:31:26 | `UPDATE_TOOL_CONTROL`, `result = PASS` |

Rows 20–21 were enabled during the verification of this very deployment, which is why the live
`tools/list` read 19 Tools at 17:30:47 and 21 at 17:31:44 with `NRestarts=0` in between. The
Control Plane's enabled set is read per request — `loadMySqlDiscoveryPolicySnapshot` opens a new
`repeatable read` transaction on every load and caches nothing — so a Tool Governance change takes
effect on the next request, with no restart. Rows 12 and 15 (`create_records`, `update_records`)
date from the 2026-09-10 P8-07 deployment, not from any later drift.

*The shared database host's clock is about six minutes behind the application host.* Measured on
2026-09-28: application host `09:36:34Z` against `UTC_TIMESTAMP()` `09:30:28Z` on
`isd-dev-db` (192.168.156.127), with `@@system_time_zone = CST`. Consequences for anyone reading
this file's evidence:

- Every `created_at` / `updated_at` in the Control Plane schema is stamped by the **database**
  host, so it reads ~6 minutes earlier than the application-clock event it belongs to. That is why
  rows 20–21 show `17:25:11` / `17:25:20` while the audit records the same two enables at
  `17:31:17` / `17:31:26`.
- `NOW()` returns CST wall-clock time, and the Skill's `db.mjs` parses with `timezone: 'Z'`, so a
  database-stamped value is returned with a `Z` suffix that is **not** UTC. Only `occurred_at`,
  written by the application, is true UTC.

When establishing when a Control Plane change took effect, use `sfoa_audit_log.occurred_at`.

**The `validate:p9` limitation recorded above no longer applies.** That section deferred "a code
change rather than a deployment step" — composing the ingress in the harness the way `runtime.ts`
does. This delta is that change: `createAttachmentIngress` is exported from
`packages/sfoa-mcp-server/src/runtime.ts`, and `validation/p9-live-validation.ts` now calls it and
passes the result as `attachmentIngress`. It first appeared in `ea3d29c` and is therefore present
at `a9d0f13`, but absent at `dbdaf67` — the deployed harness had no ingress, this one does. The
gate should now reach the Tools instead of being refused before any of them run; that expectation
is unverified until the gate is actually run against this server.

**Archive and extract note.** `git archive` was taken with `-c core.autocrlf=false -c core.eol=lf`
(§3.1). The archive holds 1197 regular files while the extracted tree holds 1196 files plus one
symlink: on Windows `tar` materialised `packages/mcp/README.md` (a symlink in the repository,
`120000` in `git ls-tree`) as a regular file with the target's contents, while on Linux it stayed a
symlink and `find -type f` skipped it. No file was missing — a locale-independent set comparison
returned `onlyLocal: [packages/mcp/README.md]`, `onlyServer: []` — and `sha256sum -c`, which
follows symlinks, verified that entry as OK. The same trap makes the local `tar -tzf` count one
higher than the server-side `find -type f` count.

## P9-T4 Bulk export pair deployment (2026-09-29)

Deployed the branch tip of `feature/p9-data-completeness` on 2026-09-29, again directly from the
feature branch and **not** merged to `main` first. This deployment was made **before** T5, on the
deliberate decision that T4 is independently verifiable — it is a pair of Tools behind the same
Tool Governance gate, not a change that T5 would rewrite.

| | |
|---|---|
| source ref | `feature/p9-data-completeness` @ `204501d` (not in `main`) |
| archive | `sfoa-p9-t4-204501d.tar.gz` |
| size / sha256 | 2,919,317 bytes / `30840705467cf3c1fcc37e1bd8525b1c15d656fc853b7b7a6fc91e9176e0b838` |
| contents | 1204 manifest entries; no `dist/`, no `.env.local`, no `.git` |
| pre-deploy backup | `backup/sfoa-app-pre-204501d-20260929-095622.tar.gz` (10,199,700 bytes, source only) |
| staging | `staging-p9-t4-204501d` |
| app tree vs archive | `BYTE_VERIFY_OK` — 1204 OK, 0 NOT OK |

**What shipped.** `@sfoa/mcp-provider-sfoa-data` gains `submit_bulk_query` and
`get_bulk_query_results`, the Bulk API 2.0 export pair; `@sfoa/identity-runtime` gains the
`BULK_QUERY` audit purpose; `sfoa-mcp-server` gains the Bulk executor and the page-fit rule. No
migration, no lockfile change, no manifest change.

**Rebuilt in dependency order**, `BUILD_OK` at `10:07:42`:

```bash
yarn workspace @sfoa/mcp-provider-sfoa-data run build
yarn workspace @sfoa/identity-runtime run build
yarn workspace @sfoa/mcp-server run build
yarn workspace @sfoa/admin-api run build     # tool-catalog.ts imports SFOA_DATA_TOOL_NAMES
```

`sfoa-admin-api` **is** rebuilt here, unlike the T3 deployment: `src/tool-catalog.ts:4` imports
`SFOA_DATA_TOOL_NAMES` from the data package's `dist`, so a new Data Tool changes what the Admin
catalog enumerates.

**Verification — all green.** Both services restarted `active`, `/health` 200 and
`/admin/api/health` 200, `auditPersistence UP`, and `skill:runtime:check` reported no drift.

**Five follow-up single-file syncs.** Gate defects were found and fixed by re-running the live gate;
each fix was synced as a single byte-verified file plus a `sfoa-mcp-server` rebuild, because a full
re-archive for a one-file change would have cost more than it proved. The sha256 of each deployed
file matched the **extracted** bytes of the repository blob before the rebuild was started. Both
columns below are the sha256 of the LF bytes, the left one taken with
`git -c core.autocrlf=false show <commit>:<path> | sha256sum` and the right one from `sha256sum` on
the file in place on the server:

| extracted LF bytes | deployed file sha256 | commit |
|---|---|---|
| `6f8e7282…` | `6f8e7282…` | `16d2dfd` — per-Tool idempotence expectation |
| `0e674ee4…` | `0e674ee4…` | `49cf66c` — report the audit-flush verdict |
| `6fdb31bc…` | `6fdb31bc…` | `3e27c7e` — expose that verdict on the success path |
| `1ba5f7db…` | `1ba5f7db…` | `d8acdc2` — drop a falsified claim from the rationale |
| `0e71c9c3…` | `0e71c9c3…` | `b4e3453` — flush after the server stops serving |

The two columns agree on every row, which is the point of the gate: for the `d8acdc2` sync the
working copy on disk was CRLF and hashed to `fe2bd3ab…`, so an earlier draft of this table carried
that value as the source and read as though the bytes had differed. They had not — `fe2bd3ab…` is
the CRLF reading of the same content and the LF bytes were `1ba5f7db…` on both sides. Extract with
`git -c core.autocrlf=false show` and never hash the working copy (see §3.1 and the note at the end
of the T3 section).

**T4 gate runs — `overall: PASS`.** Three runs of `validate:p9` were made against this server, at
02:16:34–02:17:21Z, 02:22:41–02:23:23Z and 02:25:40–02:26:24Z. The last is the one the T4 evidence
rests on, and it reported every gate `PASS` — `toolInventory`, `requestIdentity`, `listSobjects`,
`describeSobject`, `queryRecords`, `orgLimits`, `searchRecords`, `bulkQuery`, `schemaSelfRepair`,
`credentialSafety`, and the new `auditPersistence`.

| | |
|---|---|
| object / floor | `Contact` at 37 000 rows via `P9_LIVE_BULK_MIN_ROWS` (the org's real ceiling, see ADR-0028 deviation 5) |
| pages / row sum | 19 pages, `rowsSummedAcrossPages` **37 001** |
| independent check | `orgCount` **37 001** — the paged sum and `COUNT()` agree exactly |
| `totalRecords` / page size | 37 001 / 2 000 |
| job | `750C5000004qTurIAE`, submitted `UploadComplete`, `polls` 3 |
| `elapsedMs` / `apiUsage` | 27 720 / `valid` |
| tool inventory | 23 advertised, `readOnlyAnnotations: true`, `annotationOffenders: []` |

**Step 4 — the audit evidence, read from the real Control Plane.** The three gate runs are present
in `sfoa_audit_log` on `192.168.156.127` as `MCP_TOOL_CALL` rows: run 4 occupies **ids 6641–6674**,
which is **34 rows** against the run's own pipeline counters of `enqueuedSnapshots: 34` /
`persistedSnapshots: 34`. The two independent accounts of the run agree exactly. Run 5 occupies
**ids 6683–6716**, also 34 rows, against the same counters.

**A defect this deployment introduced, and the fix that closed it.** The `auditPersistence` gate
(`49cf66c`) closes the audit pipeline to read the flush verdict, and that close happened **while the
server could still be finishing a request**. `http-server.ts:524` offers a request's audit snapshot
from the handler's `finally`, after `await resources.close()` — that is, *after* the call has
already resolved to the client. The snapshots that arrive late were therefore refused with
`MCP_AUDIT_PIPELINE_CLOSED` and lost, and because the gate samples `getHealth()` at flush time,
the refusal was not in the counters it reported. The run lost an audit and still reported
`auditPersistence: PASS`.

The five runs on this server show it directly. Runs 1 and 2 (before the gate existed) each recorded
the `schemaSelfRepair` probe's `MCP_SOBJECT_NOT_FOUND` row; runs 3 and 4 (after it) did not; run 5,
after the fix, does again.

| run | `describe_sobject` rows | error row | gate stderr |
|---|---|---|---|
| 1 (02:08) | 3 PASS | `6558` present | — |
| 2 (02:16) | 3 PASS | `6602` present | — |
| 3 (02:22) | 3 PASS | **absent** | not captured |
| 4 (02:25) | 3 PASS | **absent** | 1 × `MCP_AUDIT_PIPELINE_CLOSED` at `02:26:26.071Z` |
| 5 (02:44, post-fix) | 3 PASS | `6716` present | empty |

The timing closes it: in run 4 the flush succeeded at `02:26:25.670Z` and the refusal is logged
401 ms later. The counters reconcile with the rows (`enqueuedSnapshots: 34` = 34 rows), which is what
proves the snapshot was **refused before enqueue** rather than dropped from the queue after it —
the refused offer increments `droppedSnapshots`, but the gate had already sampled health.

The fix is to flush only after the server has stopped serving, so that no handler can still be
offering a snapshot, and to make the gate say whether that drain happened. Made in `b4e3453`:

- The success path now awaits `client.close()` and then `server.close()` **before** flushing.
  `server.close()` is the barrier that makes the flush mean something: it does
  `Promise.allSettled([...activeRequests])` raced against `max(requestTimeoutMs, toolTimeoutMs)`, and
  `activeRequests` holds the whole `handleRemoteRequest` promise (added at `http-server.ts:183`), so
  its `finally` — and the audit offer inside it — has run by the time the close settles. Both closes
  are memoized, so the outer `finally` closing them again costs nothing.
- The verdict is read *while the report is still being assembled*: the outer `finally` closes the
  pipeline only after the value has been returned, so a report that waited for it could never carry
  it.
- `runAuditPersistence` takes the shutdown and now also requires `drained === true`, so a clean flush
  over a short trail can no longer pass on its own. The refusal path (no enabled route) reads its
  verdict *before* `closeQuietly` for the same reason and passes `null` — no server was started, so
  the drain check does not apply, and that path is the one place the trail matters most, since it is
  the only record that the run was turned away rather than that it never started.

**Verified live** in the same deployment (`p9-live-validation.ts` sha256
`0e71c9c3d0c27e32fb77cc9c2df44cb1fe2a76bd6fe9fd55b9dd4fbc00fa531b`, `dist` rebuilt, both services
restarted): `overall: PASS`, all 11 gates PASS, **stderr empty — zero `MCP_AUDIT_PIPELINE_CLOSED`**
against run 4's exactly one, and `auditPersistence` `{flushed: true, dropped: 0, enqueuedSnapshots:
34, persistedSnapshots: 34, droppedSnapshots: 0, writerFailureCount: 0, shutdown: {drained: true,
forcedConnections: false}}`. The DB agrees a third time: **34 rows, ids 6683–6716**, and the last of
them is the row runs 3–4 had lost —

```
6716  2026-09-29 02:44:20.913  MCP_TOOL_CALL  describe_sobject  ERROR  MCP_SOBJECT_NOT_FOUND
```

`enqueuedSnapshots: 34` = 34 rows = `persistedSnapshots: 34`, so the error snapshot was enqueued and
persisted by the flush rather than refused before it: the row is *in* the trail the gate reports on.
The deployed **service** was unaffected throughout — the defect was confined to the validation
harness's account of its own evidence. See the 2026-09-29 CHANGELOG entry.

**Step 5 — no Tool Governance change was made.** `sfoa_tool_control` holds 22 rows (ids 1–22,
`row_version = 1` throughout) and neither Bulk Tool has one, which is the shipped default-disabled
state. The gate does not need a Control Plane write to run: it extends the enabled-set snapshot
in memory, and `enablementSource` says so in its own words. The operator enables the pair from the
Admin Tool Governance page when the Tools should be reachable; because the enabled set is read per
request, that takes effect on the next request with no restart.

## P9-T5 Playbook 1.10.0, data-analysis Skill and acceptance deployment (2026-09-29)

The T5 tip of `feature/p9-data-completeness`, deployed the same day after T4. Unlike T4 this
deployment carries the Agent-facing contract, so it is the one that decides what the test server's
playbook actually says — and the reason the test environment was still answering **1.9.0** before it.

| | |
|---|---|
| source ref | `feature/p9-data-completeness` @ `6d7ea3d` (not in `main`) |
| archive | `sfoa-p9-t5-6d7ea3d.tar.gz` |
| size / sha256 | 3,006,851 bytes / `7ecceb30c06eb1ceb42fb813240b70d2684544589165d1800012e3a2a2962ccc` |
| transfer | the same sha256 computed locally and on `crm-ex-test02` → `TRANSFER_VERIFY_OK` |
| contents | 1476 manifest entries; no `dist/`, no `.env.local`, no `.git` |
| pre-deploy backup | `backup/sfoa-app-pre-6d7ea3d-20260929-133736.tar.gz` (22,130,744 bytes) |
| staging | `staging-p9-t5-6d7ea3d` — 1235 regular files and 1 symlink |
| app tree vs staging | `rsync -rcn` reports the symlink skip and one file, both accounted for below |

The archive's own manifest also carries the T4 gate fixes. `204501d` was the T4 archive, and the
five single-file syncs that followed it (`16d2dfd` … `b4e3453`) were applied to the app tree one
file at a time and never to an archive; `6d7ea3d` contains `p9-live-validation.ts` at `0e71c9c3…`,
which is exactly `b4e3453`'s version. So the T5 archive re-based that file onto the branch and the
T4 sync trail no longer has to be reasoned about when reading the app tree.

**What shipped.** Playbook **1.10.0** with the data-completeness contract, and its five
`agent:sync` artifacts; the `crm-data-analysis` Skill (canonical under `skills/`, plus its three
generated copies); and the two `sfoa-admin-web` drift-gate literals that had to follow the new
version. The `@sfoa/mcp-provider-sfoa-data` and `@sfoa/mcp-provider-sfoa-context` packages are
byte-identical to what T4 deployed.

**Rebuild order — this is the defect this deployment is about.** The Playbook version reaches the
browser and the MCP server by two different routes:

- `@sfoa/admin-web` **inlines** `AGENT_PLAYBOOK_VERSION` at build time, so its bundle must be built
  *after* the playbook.
- `@sfoa/mcp-server` resolves it at **runtime** from `packages/sfoa-agent-playbook/dist`, so it
  needs the playbook's `dist` to be current but not its own rebuild to be last.

Building the frontend first is therefore silently wrong: everything type-checks, both services stay
`active`, and the Admin Agent page reports the previous version for as long as nobody looks. That is
the state the test environment was in, and it is a build-order defect rather than a deployment
failure. The rebuild was re-run in dependency order, and the mtimes on the server now read as a
record of it:

| time (CST) | artifact |
|---|---|
| 13:38:20 | `@sfoa/mcp-provider-sfoa-data/dist` |
| 13:38:24 | `@sfoa/identity-runtime/dist` |
| 13:38:31 | `@sfoa/mcp-server/dist` |
| 13:38:35 | `@sfoa/admin-api/dist` |
| 13:52:55 | `@sfoa/agent-playbook/dist` (rebuilt on the corrected order) |
| 13:53:02 | `@sfoa/admin-web/dist` (inlines 1.10.0) |
| 13:53:04 | `sfoa-mcp-server` restarted |
| 14:08:48 | `@sfoa/mcp-server/dist` rebuilt after the single-file sync below |
| 14:08:58 | `sfoa-mcp-server` restarted again |

`@sfoa/mcp-provider-sfoa-context/dist` keeps its 2026-09-28 17:26 mtime and was deliberately not
rebuilt — T5 did not change that package.

**A second failure hidden behind the first: SELinux.** Rebuilding `packages/sfoa-admin-web/dist`
creates files with the default context, and on this host SELinux is Enforcing with a file-context
rule that only covers paths *inside* the dist. nginx then serves them as `500` — a symptom that
looks like a broken build rather than a mislabelled file. The fix is the one already recorded in
§3 of this document: `restorecon -R` the dist and confirm the context. Both are now
`unconfined_u:object_r:httpd_sys_content_t:s0`.

**Playbook 1.10.0 is live on all four surfaces that can report it** — checked by reading each one
rather than inferring from the build:

```bash
node -e 'console.log(require("./packages/sfoa-agent-playbook/dist/version.js").AGENT_PLAYBOOK_VERSION)'
# 1.10.0
grep -o 'Playbook-Version: [0-9.]*' docs/agent/DIFY_AGENT_INSTRUCTION.md   # 1.10.0
grep -o 'Playbook-Version: [0-9.]*' packages/sfoa-admin-web/dist/index.html # 1.10.0
node -e 'console.log(JSON.stringify(require("./packages/sfoa-mcp-server/dist/agent-guidance.js")).match(/Canonical version [0-9.]+/))'
# [ 'Canonical version 1.10.0' ]   — the live get_agent_playbook Tool description
```

**One follow-up single-file sync.** Running the live gate found a second defect in the gate itself
(§P9 acceptance, below), fixed in `95d960a`. As with T4's five, it was synced as a single
byte-verified file plus a `sfoa-mcp-server` rebuild rather than a fresh archive. Both columns are
the sha256 of the **LF** bytes, the left read with
`git -c core.autocrlf=false show 95d960a:<path> | sha256sum` and the right with `sha256sum` on the
server:

| extracted LF bytes | deployed file sha256 | size | commit |
|---|---|---|---|
| `bcba7d20e3f51ae265e7ced1064e8478cbf0bb85f64eea6593690c177ac522fe` | `bcba7d20e3f51ae265e7ced1064e8478cbf0bb85f64eea6593690c177ac522fe` | 116,566 | `95d960a` — the limits endpoint's own lag |

The file as it stood before the sync is kept at
`backup/p9-live-validation.ts.95d960a-20260929140803.bak` (112,733 bytes), named for the commit it
was replaced by.

**`rsync -rcn` between `staging-p9-t5-6d7ea3d` and the app tree now reports only the symlink skip**:
`packages/sfoa-mcp-server/src/validation/p9-live-validation.ts` is the one file that legitimately
differs, because the staging tree holds `6d7ea3d`'s copy (`0e71c9c3…`) and the app tree holds
`95d960a`'s (`bcba7d20…`). Every other regular file in staging is byte-identical to the app tree.

**Verification — all green.** Both services `active`, `/health` 200, `/admin/api/health` 200.
`overall: PASS` on the live acceptance run, all 11 gates PASS; the run's own first line in the
harness output is the masked route it resolved, `enabledRoutes=8 of 8`.

**An observation about the harness, recorded because it cost time.** The live-gate runner prints
its complete JSON report and then **does not exit** — the Control Plane's connection pool keeps the
event loop alive after the report is written. An ssh invocation that waits for the exit therefore
never returns, and repeated runs left orphaned `node .p9-live-inject.mjs` processes on the host
(load average stayed at 0.00, so nothing was busy; they were simply parked). Every report in this
record was validated by parsing the JSON, not by reading an exit code, and the orphans were cleared
by pid. The same holds for the audit runners below. This is a property of the temporary runners in
`.temp/`, not of the deployed service.

**Follow-ups, in the order they happened.** The acceptance report was written first
([P9_ACCEPTANCE_REPORT.md](P9_ACCEPTANCE_REPORT.md)), then:

1. **The host side of the same contract.** The `crm-data-analysis` Skill and the regenerated `sfoa`
   connector Skill were synced into the OpenClaw workspace on this same server, and the Skill was
   added to the `main` Agent's allowlist. That is a different surface from the four in the table
   above and is recorded in
   [OPENCLAW_TEST_SERVER_DEPLOYMENT.md](OPENCLAW_TEST_SERVER_DEPLOYMENT.md#22-p9-t5-同步业务-skill-与-agent-playbook-11002026-09-29).
2. **The temporary artifacts were removed.** Every `.p9-*` file the run created — the injector, the
   audit and coverage runners, the build/gate logs and the acceptance reports — was deleted from
   both the checkout's `.temp/` and the app tree, along with `/tmp/p9-*`; the generated export
   package `out/` went with them. What stays is what this record cites by path: the archives under
   `incoming/`, the pre-deploy backups under `backup/`, and the three archive manifest listings the
   earlier P9 sections name at the deployment-tree root — `p9-expected-manifest.txt` (cited at
   §P9-T1, line 925), `p9-a9d0f13-expected-manifest.txt` (§P9-T3, line 1010) and
   `p9-t4-204501d-expected.txt` (the T4 archive's listing, whose 1204 entries §P9-T4 reports).



---

## P10-DSH-01 部署：DSH 标准场景控制面（`596a74d`，2026-11-13）

本次把 [DSH 标准场景模块](DSH_STANDARD_SCENARIOS_API.md) 部署到测试服务器 `crm-ex-test02`
(`192.168.156.203`)。性质是**新增能力**：新增迁移 018、两个独立表、一个插件 REST 前缀
(`/api/dsh/`)、一个后台模块；不改动 MCP Tool、Provider、身份路由解析、DML 治理或 Audit
fail-open 语义。

### 部署事实

| 项 | 值 |
| --- | --- |
| 提交 | `596a74d`（含 `267416b`/`d5dff96`，分支 `feature/dsh-standard-scenarios-control-plane`） |
| 归档 | `incoming/sfoa-dsh-596a74d-20261113-141508.tar.gz`，4,524,315 B，sha256 `f0e39487…9365e6`，1,772 条目 / 1,507 文件，LF 归一化（`git archive -c core.autocrlf=false -c core.eol=lf HEAD`） |
| 部署前备份 | `backup/pre-dsh-596a74d-20261113-142042.tar.gz`，11,824,630 B（app 源码，排除 `node_modules`/`dist`/`.wireit`/`*.tsbuildinfo`） |
| 落盘 | 解到 `staging-dsh-596a74d-20261113-142042`，`rsync -a --omit-dir-times --no-perms` 覆盖 `app/`（**无 `--delete`**）；`.env.local` 软链、`config/`、`secrets/`、`node_modules`、各包 `dist` 全部保留 |
| 字节校验 | `sha256sum -c expected-596a74d.txt`：**1,507 / 1,507 OK，0 FAILED，0 MISSING**（清单由归档解包后生成，不是工作区） |
| 依赖 | 未变更（本次提交只改 `package.json` 的 `exports`，未增删依赖），跳过 `yarn install` |
| 构建 | 按 §6 依赖顺序构建 11 个 workspace（先清 `*.tsbuildinfo`/`.wireit`），全部成功；新增产物 `packages/sfoa-admin-api/dist/dsh/`、`packages/sfoa-control-plane/dist/dsh-scenario-service.js`、`packages/sfoa-admin-web/dist/assets/StandardScenariosPage-V3by-CIi.js` |
| 迁移 | `yarn db:migrate` → `018_dsh_standard_scenarios` **APPLIED**（`2026-11-13T14:22:28.872Z`，checksum `3db7b86b…114641`），此前停在 017 |
| 共享库校验 | `sfoa_identity_route.can_manage_dsh_scenarios` = `tinyint(1) NOT NULL DEFAULT 0`；`crm_dsh_standard_scenarios` / `crm_dsh_scenario_files` 均 InnoDB；`idx_status_updated(status,updated_at)`、`idx_scenario_id(scenario_id)` 存在 |
| 重启 | `sfoa-admin-api` 14:23:31 CST、`sfoa-mcp-server` 14:26:48 CST；三者 `is-enabled`/`is-active` 均为 enabled/active |
| Nginx | `conf.d/mcp-service.conf` 新增 `location /api/dsh/` → `127.0.0.1:8081/api/dsh/`（转发 `Authorization`/`X-Buntu-Token`/`Origin`）；改前备份 `backup/nginx-mcp-service.conf.pre-dsh-*`；`nginx -t` 通过后 `reload`（不重启，静态站与 MCP 不受影响） |
| 配置 | `.env.local` **未改动**（`SFOA_DSH_*` 走代码默认：来源 `*`、附件上限 10 MiB；Nginx 全局 `client_max_body_size 20m` 已足够 base64 信封）。SELinux 标签仍为 `etc_t` |

### 验证

| 检查 | 结果 |
| --- | --- |
| MCP `/health` | 200 |
| Admin `/admin/api/health`、`/ready` | 200 / 200 |
| Nginx `:9000` `/`、`/admin/api/health`、`/api/dsh/scenarios` | 200 / 200 / 200 |
| `GET /api/dsh/scenarios`（匿名） | 200，`auth.authenticated=false`、`scenarios=[]`、`deletedScenarioIds=[]` |
| `GET /api/dsh/scenarios/permission`（匿名） | 200，`canManageStandardScenario=false` |
| `OPTIONS /api/dsh/scenarios` | 204 + `Access-Control-Allow-Origin` 回显、`Allow-Methods: GET, POST, PUT, DELETE, OPTIONS` |
| `GET /admin/api/dsh/scenarios`（无会话） | 401（别名挂在 Admin 鉴权之后） |
| 后台会话 | 登录 200，`modules` 含 `standard-scenarios`；`/api/dsh/scenarios/permission` 返回 `canManageStandardScenario=true` |

端到端冒烟（服务器本地 `node`，凭据只在该进程内，输出仅状态码与版本号）：

```text
ok  admin login — HTTP 200
ok  session carries the standard-scenarios module
ok  permission probe via Admin session — canManageStandardScenario: true
ok  create scenario — HTTP 201
ok  initial version 1.0.0 / revision 1
ok  payload markers forced            (sourceType=COMPANY_STANDARD, readonlyForNormalUser=true)
ok  edit bumps to 1.0.1 / revision 2
ok  attachment upload bumps to 1.0.2 / revision 3
ok  attachment download is byte-identical — 20 bytes, sha256 5b2180874944…
ok  soft delete returns a tombstone — rev 4, 1 tombstone(s)
ok  deleted id appears only in deletedScenarioIds
ok  attachment bytes are gone after delete — HTTP 404
cleanup: removed 1 scenario row(s), 0 file row(s); remaining scenarios: 0
```

冒烟创建的 `dsh-smoke-*` 场景在结束时按 id 硬删除（行与文件行；此前已软删除、字节已释放），
共享库回到 0 条场景；本次产生的 `channel=ADMIN` 审计行按设计保留，是这次部署的可追溯证据。

**未验证**：浏览器点击级 UI（本次通过构建产物与 chunk 可达性验证，`StandardScenariosPage-*.js`
经 Nginx 200，`插件标准场景权限` 出现在 `IdentityRoutesPage-*.js`），以及真实插件（`crm-dsh-plug`）
联调与 Buntu Token 授权用户的写路径实机验证——这两项需要交互式浏览器会话与真实 Token。

### 回滚

- 应用：`backup/pre-dsh-596a74d-*.tar.gz` 解回 `app/`，重建 `sfoa-admin-api`/`sfoa-mcp-server` 后重启；旧代码不读新表，可安全运行。
- Nginx：`backup/nginx-mcp-service.conf.pre-dsh-*` 覆盖后 `nginx -t && systemctl reload nginx`。
- 数据库：018 为纯增量（加列、加表、加索引），**保留不回滚**；`crm_dsh_*` 表在旧代码下不被访问。

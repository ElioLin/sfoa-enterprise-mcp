# 材料工作流验收续测与企微连接修复

后续 [HOTFIX-01](AGENT_MATERIAL_WORKFLOWS_HOTFIX_01.md) 修复材料读取、证据合并、附件已知结果及指导，并接入现有宿主能提供的原生读取证据；只做本地验证，本轮真实业务 UAT 按用户要求后置。以下真实渠道记录和历史限制保留。

日期：2026-11-05（北京时间）。分支：`feature/agent-material-workflows`。接续基线：`3cb73536e230cd894d435ef18154122490681a06`，已有交付和失败证据保留在[原报告](AGENT_MATERIAL_WORKFLOWS_DELIVERY.md)。本次没有回退分支或覆盖既有未提交工作。

**真实企微连接、CSV 多轮创建、定点编辑、CSV/DOCX 归档及后续目标/逐份结果同步已通过。** 09:35 的状态失败保留；E/E2 九原件读取和新任务隔离已核对，9c4fda9 热加载后 E3 同任务材料保留、阶段 COMPLETE。整体保持 PARTIAL；服务健康、插件清单、真实模型与模拟 Salesforce 的测试，均不替代真实渠道和 Salesforce 结果。

## 1. 本轮修复

| 提交 | 改动及边界 |
| --- | --- |
| `7a09679` | 可选 `openKeyedStore` 被宿主拒绝时，保留请求身份解析器、材料钩子和有界内存状态；不打印底层错误中的私密内容 |
| `b613ae4` | 在插件 manifest 中声明 `contracts.tools: [sfoa_material_task]`，使实际 OpenClaw SDK 接受宿主任务工具注册 |
| `71697eb` | P7 负载测试提前登记 Audit writer 清理，失败轮次也会关闭后台计时器；生产运行时和超时预算未改 |
| `20ea534` | 尝试用执行前上下文绑定完成事件；确定性测试及真实 SDK 注册通过，但 09:35 真人企微状态同步仍失败，保留该提交与失败证据 |
| `72eeb22` | 改用既有提示词生命周期的可信发送者与 session/run 绑定，完成钩子据此观察结果；绑定有界、过期、冲突拒绝，在 agent end/session reset 清理，不改变 MCP 参数或执行授权 |
| `1b17fb0` | 固化 A–D3 的脱敏证据、失败、测试和回滚；在其 committed HEAD 上 Linux clean smoke 通过 |
| `9c4fda9` | 针对 E/E2 阶段滞留和归档备注缺失，简短指导 Agent 记住阶段及既有归档选择；不自动推导授权、不增加 MCP 门槛 |

新增回归覆盖实际宿主拒绝状态存储、身份绑定仍有效、缺少可信 requester 仍拒绝、普通文本轮次保留材料、警告不泄露底层错误、manifest 工具声明。无额外依赖、准备 Token、统一批准参数或审批状态机。没有修改官方上游文件。

## 2. 企微连接故障：原因与修复证据

用户在 08:20:35、08:22:00 发出的真实请求已经到达 MCP；`get_username` 返回 `MCP_PLATFORM_USER_REQUIRED`，P7 中身份为空、Salesforce 调用为零。失败 Audit ID：

- `aa60760f-f78f-43f9-b5d0-26ea08bba731`
- `3135c1fc-2496-4ca0-924d-d491f763d648`

原因是本轮材料状态存储接入的兼容性遗漏。203 的 OpenClaw 2026.9.5 虽提供 `runtime.state.openKeyedStore`，却不向 `origin=config` 的本地路径插件开放该存储。注册过程抛错，宿主回滚插件注册，连同请求身份解析器一起撤销；静态 MCP 连接因此缺少企微用户 Header。网络和 Salesforce 登录不是这两次失败的原因。

CLI `plugins list` 使用持久化 registry，曾显示 `loaded`，但实际 fresh SDK 注册显示 `error`、resolver 数量为零。此前“插件已加载”的证据不足，现已纠正。修复 store 错误后，真实 SDK 又发现宿主任务工具缺少 manifest 合约声明，因此追加第二个修复。最终 fresh SDK 同时证明 1 个 resolver、4 个 typed hooks 和 `sfoa_material_task`；缺 requester 和非企微渠道均不开放连接。

没有改 OpenClaw 信任策略或设置固定用户。当前本地插件只能使用有界进程内存，明确返回 `MEMORY_ONLY_REVALIDATE_AFTER_RESTART`。同进程材料累计可以继续；**不能宣称 Adapter 任务状态已在该安装方式下跨 Gateway 重启持久化。**

08:54:53–54 的实际 Gateway 日志记录材料桥和 requester resolver 注册；08:54:56 企微重新认证成功。随后有用户本人发出的实际消息验证，不再仅靠 isolated SDK 或健康检查。

### 真实企微 A：连接与当前用户读取

用户报告约 09:02 发送；服务器实际入站时间 09:03:06，结束 09:03:52。会话 `1fcc67fa-8eb7-4e0f-a42b-21fc9dcb496e`，转录序号 196–212，用户消息含 `SFoA连接验收-1105-A`。

实际调用 `get_username`、5 次 `run_soql_query`、`search_records`、`explain_field_access`，8 次 MCP 调用均成功，无 DML 或上传。P7 的平台用户为 `61***79`，身份来源 `WECOM_HEADER`；业务查询使用该用户路由，字段权限解释按现有工具契约使用 DIAGNOSTIC 角色。用户确认显示身份正确。连接 Audit `f1ce48bb-a855-41a7-b01d-215979802291`，首次客户查询 Audit `080a53de-c836-49d9-beec-b7d5b69998ae`。

对“CMOS测试客户”的精确及 CMOS 模糊 Account 查询均为 0。模型明确区分“当前范围未查到”和“全库不存在”，也没有把搜索到的商机、项目池当成这个客户。维护测试账号 `60***45` 可见该客户，不代表当前企微用户可见；两条证据保持分开。

### 真实企微 B：测试主体与厂别

入站 09:07:35，结束 09:08:57，序号 213–229，标记 `SFoA测试对象核对-1105-B`。实际读取业务 Skill，随后读取 Describe、RecordType、客户和未转换线索及当前用户 CREATE Context。全程只读。

| 当前企微用户的有界查询 | 实际结果 |
| --- | --- |
| 名称含“测试”的客户，按创建时间降序 LIMIT 5 | 测试1009、英仕迁移测试客户-泰国、Genimex_ 测试0518_送达方、Solventum US-测试1、康丽根迁移测试送；达到查询上限，不能声称全量 |
| 名称或公司含“测试”的未转换线索，LIMIT 5 | 1 条：名称 22，公司“测试评分规则”，状态新建 |
| 是否专供测试 | 返回的备注均为空、记录类型为常规类型；未取得专供测试的明确证明，不能仅凭名称决定写入 |
| “客户来访” Record Type | 当前 USER 可用，`012C8000002mVyOIAU` |
| 来访厂别 | 当前 Record Type 返回 18/18，未截断，无 controller、无依赖截断，布局必填；上海智家的实际值为 `21` |

厂别完整候选：灌一厂、灌三厂、灌五厂、灌六厂、漳州厂、集美厂、宁波厂、台湾厂、百霖厂、匠仕厂、THRN、上海智家、杏林湾、USRN、北京、MXRN、上海瑞摩、辉美厂。

当前 USER Context 是 `PAGE_LAYOUT_FALLBACK`，原因 `APP_CONTEXT_REQUIRED`，不是完整 Dynamic Forms 证明。早先维护测试账号的 Context 是过期快照下的 `EFFECTIVE_REQUIRED`，且厂别 unresolved；其 Describe 只能证明字段层候选。两个用户的 Context 不混用，销售组织默认值也没有代替厂别选择。

用户随后明确指定 **“测试1009＋上海智家”** 为本次范围，允许新增带 `SFOA-MATERIAL-1105-C` 标记的 2026-11-13 10:00–11:00 来访测试记录，后续编辑该新记录和归档测试材料。这是独立测试范围选择，不是给所有业务写入增加统一确认。

## 3. 本地聚合超时排查

原 Windows server 聚合 403/404 与 P7 5/6 的 HTTP 504、`MCP_REQUEST_TIMEOUT` 日志保留。测试请求/Tool 预算仍为 2s/1s，生产默认预算仍为 180s/120s。

本次 server 聚合 404/404，通过耗时约 551 秒；P7 6/6，通过耗时约 72.7 秒。P7 的 50/100/200 并发各 3 对 OFF/ON 轮次均零失败，1,060 份 Audit 身份与关联隔离断言通过。没有为了通过而放大预算。

临时观测器只测 workspace 创建、清理及 event loop，没有改业务结果。P7 峰值 200 并发时，workspace 创建 p95 约 1,143ms、最大 1,300ms；清理 p95 约 1,794ms、最大 2,013ms；event loop p99 约 197ms、最大 360ms。该开销是真实 Windows 文件系统和调度工作，即使 Salesforce 是 fixture。当前重跑没有复现原 504；这些数据支持负载敏感性，**不足以证明历史失败由哪个具体进程或系统组件造成**。

另确认一个测试清理缺陷：失败轮次会跳过原正常路径上的 `pipeline.close`，使 Audit writer 计时器持续存活。`71697eb` 在开始负载前登记 `t.after`，正常和异常退出均清理；未削弱负载或 Audit 断言。

扩大到 Adapter 与 harness 全目录默认并行时出现 2 项新失败：600ms 的部分输出测试未收到子进程文本，以及 CSV 读取失败。串行但仍使用 `python3.12` 启动入口时又观察到 `spawn EPERM`/`OFFICE_READER_FAILED`。一次有界进程诊断显示 Python 入口三次启动耗时 7.5s/12.5s/2.1s，实际解释器路径为 1.1s/1.1s/1.5s，均成功。随后使用显式解释器路径和串行文件执行，完整 117 项中 116 通过、1 项 POSIX 信号测试在 Windows 跳过。没有终止其他应用、修改安全软件或改 reader 的 15s 超时。首次 CSV 失败未捕获具体底层原因，不能事后把它武断归为同一个 EPERM。

## 4. 本轮测试与失败保留

本地日志根：`.temp/agent-material-followup-20261105/`；旧日志仍在 `.temp/p8-04-regression/` 和 `.temp/agent-material-workflows/`。

| 执行 | 结果 / 限定 |
| --- | --- |
| 修复后 Adapter 专项 | 93/93；manifest/bridge 专项 23/23 |
| Windows server 聚合 | 404/404；`server-aggregate-timing.log` |
| Windows P7 聚合 | 6/6；`p7-aggregate-timing.log` |
| Windows 全目录默认并行 | 114 PASS / 2 FAIL / 1 SKIP；`adapter-final-93.log` 文件名沿用预期数，真实统计是 117 项，不能按文件名计数 |
| Windows 串行、Python 启动入口 | FAIL；`adapter-final-serial.log`，包括 `spawn EPERM` |
| Windows 串行、实际 Python 路径 | 116 PASS / 1 SKIP；`adapter-harness-direct-python.log`，无 timeout 参数修改 |
| Linux 仅 Adapter 归档目录 | FAIL：缺 monorepo 文档、Provider/SDK 依赖；`adapter-linux-stage-failure.log`，不是实际部署服务失败 |
| Linux 完整 app 内 Adapter/harness，b613 | 117/117；服务端 `adapter-linux-app-hotfix.log` |
| Windows/Linux 20ea 绑定专项 | 36/36，但随后真实企微观察失败；不能用这组通过覆盖渠道失败 |
| Linux 完整 app 内 Adapter/harness，20ea | 119/119；`adapter-linux-call-scope-final.log`，渠道状态仍 FAIL |
| Windows/Linux 72eeb22 绑定专项 | 各 37/37，覆盖没有 generic before-tool 的完成回调、跨用户隔离、冲突、过期、session reset 和 agent end |
| Linux 72eeb22 Adapter 全目录 | 96/96；`adapter-linux-prompt-run-final.log` |
| Linux 72eeb22 harness 目录 | 24/24；`harness-linux-prompt-run-final.log`，与 Adapter 分次运行，不合成为同一次聚合 |
| 72eeb22 实际 SDK + 保存结果重放 | 候选和实际插件目录均 PASS；使用真实 SDK 的上下文构造函数及已保存的 309 号查询返回，证明结果解析和目标绑定；未发起 Salesforce 请求，不计作新渠道验收 |
| 9c4fda9 指导修正专项 | Windows 37/37、Linux 候选 37/37；真实 SDK 注册/结果衔接通过；真实阶段收尾另见 E3 |
| Skill 同步/一致性/测试/交付 | 最新引用 sync/check/delivery PASS；Linux committed HEAD `6afa55a` 的 validate/sync/check/test/snapshot/缺环境 doctor 全部 PASS，含 80/80；未加载 .env，DB/服务检查跳过，不计业务验收 |

服务器第一次部署预检发现实际插件目录没有 README，备份复制失败；第二次临时脚本因 CRLF 解析失败，均发生在覆盖/重启前。修正为 LF 的第三次脚本成功。三个版本和失败日志都保留，没有将失败脚本的退出状态解释为已部署。

## 5. 部署版本与回滚

最新 Adapter 为 `9c4fda90815e924040ab3c5e6439f5cfa5f39776`，10:44:41 经官方插件热加载实际登记，`generation=3`、`restartRequired=false`，source digest `f73640bebc71158d6e3e659e1443e0b284cb122f2530dd954aaa7536231937f3`，Gateway PID 仍为 3759907。app/plugin `src/material-tasks.js` SHA256 均为 `3813eee90b764f216562cd34499ffb9a212331b6e7a38f74d199a0e73fb21618`；index.js 保持下述 72eeb22 字节。此次归档 SHA256 `27f592187742392fdab72eeeb3aac34d4c67ceae93803e33690cb994b83486ef`。

首次热加载被 OpenClaw 的 capability consent 门禁拒绝，文件恢复到 72eeb22，PID 未变，失败日志保留。随后使用真实 SDK 对比新旧 declared surface 完全相同：只有既有 `sfoa_material_task` Tool/contract，无新增 dangerousConfigFlags；原 `allowConversationAccess=true` 未变。按用户已有测试部署授权审阅后，通过官方 `--accept-capabilities` 登记该 surface，再成功热加载。此同意写入 OpenClaw 安装登记，不把插件提升为官方可信插件，keyed store 仍不可用；`openclaw.json` 和 `.env.local` 校验均未改变。

最新备份 `/data/sfoa-enterprise-mcp/backup/adapter-task-notes-20261105T024435Z-9c4fda9` 含旧源码、私密配置副本、SQLite 在线备份和 `rollback.sh`。只撤销指导修正时，审阅后执行该脚本，回到 72eeb22 并官方热加载。脚本未演练；不会撤销 Salesforce 数据。插件已审阅能力的登记会保留，不应把整个登记数据库恢复到旧快照而覆盖其他插件的新状态。

核心 runtime 仍为 `1f060ed`，业务 Playbook/Skills 仍为 1.13.2（`94aa661`）。本轮 Adapter 依次部署 b613、20ea、72eeb22、9c4fda9；以下保留 72eeb22 的部署记录。无业务数据库迁移、配置文件修改、依赖安装或 MCP/Admin 重启。

- app：`/data/sfoa-enterprise-mcp/app`
- 实际插件：`/data/openclaw/plugins/sfoa-wecom-mcp-adapter`
- OpenClaw：2026.9.5；Gateway Node：24.19.0
- 实际 Adapter 源提交：`72eeb22512ebb29f0c275097836b88eafba060d9`
- plugin/app `src/index.js` SHA256 均为 `5fdd2febdb9a13cbb7fb30a4612bb15f4fac53643cd1948828d133755c81278c`
- 部署 LF archive SHA256：`7d8ccbc019e28c4eea27738cb14abf494d82e75c0c5312df21fc78b21eecd497`
- 新 Gateway PID：3759907；09:58:59 启动；09:59:08–09 实际注册 bridge 与 requester resolver。配置及外部 `.env.local` 前后校验一致，不公开其内容。
- 72eeb22 备份：`/data/sfoa-enterprise-mcp/backup/adapter-prompt-run-20261105T015858Z-72eeb22`
- 20ea 备份：`/data/sfoa-enterprise-mcp/backup/adapter-call-scope-20261105T012820Z-20ea534`；09:28 部署、09:35 状态复核失败。
- b613 备份：`/data/sfoa-enterprise-mcp/backup/adapter-store-denial-20261105T005439Z-b613ae4`；连接修复已由 A/B 证实。
- 保护证据根：`/data/sfoa-enterprise-mcp/evidence/material-followup-20261105`

只撤销这次 Adapter 补丁时，先检查之后是否有新改动，再运行备份内已审阅的脚本：

```bash
bash /data/sfoa-enterprise-mcp/backup/adapter-task-notes-20261105T024435Z-9c4fda9/rollback.sh
systemctl is-active openclaw-gateway sfoa-mcp-server sfoa-admin-api
```

上方最新脚本回到 72eeb22；72eeb22 备份内脚本则回到 20ea（连接有效，但任务结果同步已知失败）。b613 备份脚本恢复已知注册失败的更早版本。最新回滚未实际演练；它们不撤销 Salesforce 数据或文件，也不授权重放任何成功/未知写入。原核心/Playbook 的分层回滚仍见原交付报告。

72eeb22 首次部署预检被一个未在上一批覆盖的测试文件的 LF/CRLF hash 差异拦下，未覆盖文件、未重启；确认其内容等于旧 Git blob 后改用正确的旧文件 hash，第二次成功。旧 20ea 归档字节含 CRLF；本次显式 `git -c core.autocrlf=false archive`，并分别校验部署前实际字节和新提交字节。失败日志继续保留。

## 6. 真实企微 C/D：创建、编辑、归档与状态差异

C 在原会话序号 230–283：09:14 等待收集，09:15 收到实际 CSV 和补充文字，09:16 材料齐，09:17:57 创建成功，09:18:07 读回。对象 `Account_Visit__c`，记录 `Visit-004242` / `a0fC5000001AEfRIAW`，客户测试1009、厂别上海智家、记录类型客户来访。CREATE Audit 为 `eb876bd0-4ff9-4b86-abd2-29246124bde6`。

CSV 为 573 bytes，SHA256 `941f13274917ea2f7cc7af9ecce7acda0dbfd6126c053ca2240fe3f6f42cee24`，真实读取 14/14 行、UTF-8，14 行对应的 238 字符全部提供。普通文本补充未清除 CSV。payload 实际包含计划时间、地点、目的“其他”及其他目的“产品交流”、售后响应流程、耐久性和价格诉求、计划交流内容、尚未到访/无采购承诺/数量未定/反馈后再讨论寄样。自动编号不可写，标记进入总结字段；未编造已到访或已成交。记录尚未归档时提供一次可选邀请。

创建前有范围查询 0 行；不声称全库唯一。期间 3 次 FieldDefinition 查询因不存在的 IsCreateable/IsUpdateable 字段失败，模型自行修正后完成，没有增加业务追问；诊断失败仍保留。创建后 `sfoa_material_task` 记目标返回 TARGET_NOT_OBSERVED，触发 20ea 修复。

D 在序号 284–304：Gateway 重启后，用户重发了原件（旧 ref 已过期）；09:31 请求修改时间并归档。UPDATE 只提交开始和结束两个字段，最终 **2026-11-13 10:30–11:30（Asia/Shanghai）**，其余业务内容保留。UPDATE Audit `92ff0f3f-cdc1-40b3-b69f-7fea0c4fa8c3`，文件 Audit `87dfdff2-44bc-4800-86d2-8179454790c7`。

唯一一次 CSV 上传返回 SUCCESS；Salesforce 读回 ContentVersion `068C50000017tQbIAI`、ContentDocument `069C50000015y7pIAA`、Link `06AC5000001KLkUMAW`，573 bytes，准确关联本次 Visit。09:35 用户发起复核，实际服务器入站 09:36:04，结束 09:36:30，只有 2 次只读 MCP 查询，没有修改、创建或上传。

该复核中本地任务 `f46d4922-81a8-4d7a-8dd6-1daa24d2c427` 仍是 archive NOT_ASKED、observedTargets 空、upload NOT_ATTEMPTED，而 Salesforce 已有成功附件。因此 **20ea 的真实任务同步 FAIL**；准确报告差异不等于状态恢复已经通过。实际宿主完成回调缺少 requester，generic before-tool 绑定没有覆盖这条流程；72eeb22 使用提示词阶段的可信身份绑定，后续真实只读 D2 独立验收。

语音边界：09:15 的可用内容在宿主转录中是普通文字，任务材料只有 CSV，没有音频原件。它证明补充文字被利用，**不证明企微原生语音的 ASR、音频读取或音频归档**。只读复核也准确说明没有可归档语音原件。

### D3：新 DOCX 的实际读取与上传同步

实际入站 10:06:24（指令）、10:06:39（文件），完成 10:07:11，序号 327–341。新原件 `SFOA-MATERIAL-1105-D3.docx`，1,151 bytes，SHA256 `3e784f98665a8aca5b73ce06528a947242126c72a7c6b1c0d2b810e5304d9eba` 与本地夹具/Adapter 一致。宿主 reader 读取 6 段正文、178/178 字符；模型另经 exec 实际读取同一原件，返回内容一致。基本 DOCX 读取不声称覆盖页眉、页脚、绘图、批注或版式。

一次 `upload_files_to_record` 成功，Audit `5d8fc130-de13-428c-9d68-a71189866465`；随后只读核对 Audit `ee1bdad4-a5b4-42f2-80f1-d56607e02be0`。二者均 USER / WECOM_HEADER / SUCCESS。ContentVersion `068C50000017twrIAA`、Document `069C50000015ycTIAQ`、Link `06AC5000001KMS2MAO`，关联原 Visit，未更新业务字段。

338 号本地 inspect 已是 `upload.status=SUCCESS`、相同 recordId 和 ContentVersion；339 号 Salesforce 查询共返回 2 个 Link，旧 CSV 与新 DOCX 各 1 个，无重传。此时新 Link 尚未出现在**查询完成前**的 inspect 快照中，不能据此推定观察器遗漏后续结果。

限制仍保留：旧 CSV 不在重启后的新材料清单；任务级 `archive.status=NOT_ASKED`、materialIds=[]，Agent 未记入归档选择。**本次 PASS 只覆盖真实读取、逐份上传结果、目标连续性和 Salesforce 文件一致性，不包括完整归档选择台账或跨重启恢复。** 不从成功上传反推新的授权范围。

### E/E2/E3：九原件、任务隔离和热加载连续性

E 从 10:12:43 收集到 10:16:08 总结，E2 在 10:21:38–10:22:15 独立复核，序号 342–388。9 原件全部进入同一个新任务，SHA256 **9/9** 与发送包一致，omissions=[]；新 taskId `bb0d9087-5720-44f7-b295-74192bcd36a0`，旧目标和旧归档选择已清空，新选择 DECLINED，9 文件均 NOT_ATTEMPTED。整个 E/E2 没有调用 MCP Salesforce 工具。

| 原件 | 真实渠道读取证据 | Adapter 留存覆盖 |
| --- | --- | --- |
| CSV | 原件文字、5 行实际内容 | READ，5/5 行，80/80 字符 |
| DOCX | 实际 exec 读取正文及表格 | READ，2 段＋1 表格行，136/136 字符 |
| XLSX | 实际 exec 读取参与人表 | READ，1 表、3/3 行，64/64 字符 |
| 文本 PDF | 宿主实际提取议程，模型保留 11/6 13:30–15:00 和讨论内容 | UNKNOWN，不制造覆盖数 |
| 扫描 PDF | E2 的 pdf 工具直接读取本次入站原件，1 页；pdfinfo/pdftotext/pdfimages 证明无文字层、包含扫描图 | UNKNOWN；真实页面读取结果单列 |
| JPEG/PNG | 原始哈希匹配，实际 view_image 返回两幅模型可见图像，正确保留计划状态、人数及无订单/数量承诺 | UNKNOWN |
| 文件 m4a/WAV | 两次真实文件入站均产生平台 ASR 转写，保留样品测试中、价格顾虑、无订单、数量未定及反馈后跟进 | UNKNOWN；说话人、时间码、置信度未验证 |

模型将两个明确日期的来访分开，对无日期/客户的图片、录音、参与人表等说明归属不足，没有以原测试夹具的分组意图充当业务事实，也没有据此写入。两份录音是文件入口，不能替代企微原生语音原件测试。

E2 另发现 `phase=COLLECTING` 未随完成更新，保留为 FAIL；六份原生材料的读取证据也未自动回写 Adapter 覆盖。这些差异没有被最终总结的正确内容掩盖。9c4fda9 补充状态备注指导并官方热加载后，用户约 10:46 发起 E3，实际 10:46:58–10:47:17，序号 389–394。模型只调用一次本地任务工具，把阶段写为 COMPLETE；同一 taskId、九份材料及其 hash/reading/upload 完全保留，DECLINED、空目标、与原 Visit 隔离继续成立。没有重新暂存、读取文件、创建新任务或调用 Salesforce。**E3 的收尾及进程内热加载连续性 PASS；不是跨 Gateway 重启持久化 PASS。**

## 7. 尚待完成的验收

- D2 已通过：用户约 10:00 发送，实际 10:01:20–51，序号 313–326。两次查询后 observedTargets 已包含 Visit 和附件 Link；可选任务工具记目标成功，随后再次 inspect 保留相同目标。P7 `f7eda032-b71d-470f-91de-28ffc7f46a79` / `479922df-1574-4fc3-bbea-ad2157a80606` 均为 USER、WECOM_HEADER、SUCCESS，用户 `61***79`，没有 DML/上传。新的 taskId 为 `437fed63-3d80-405b-9f85-badcddbfded0`、materials=[]；这是基于真实查询重建目标，不是恢复旧材料 ledger。
- D3 的新附件观察已通过；当时任务级接受归档选择没有同步。9c4fda9 已补指导，E3 完成阶段通过，但直接归档时 ACCEPTED＋已选 materialIds 的完整真实新一轮仍 NOT VERIFIED，不能把逐文件 SUCCESS 当作所有归档状态已完成。
- 当前本地插件的跨 Gateway 重启任务持久化不可用，保留环境限制；历史记录和附件须以 Salesforce 重新核对，不能声称恢复了原 Adapter ledger。
- E/E2 已补齐九份原件的入口和基本读取证据；六份原生 PDF/图像/音频的 Adapter 覆盖仍 UNKNOWN，未实现可信原生覆盖自动回写，不将真实读取反写为已保存覆盖。
- 原生企微语音原件、真实批量/复合写入和失败后附件恢复仍未完整实测。不能拿单条 CSV 成功覆盖这些项。

验收读取真实转录、宿主材料覆盖、MCP 请求/响应、P7 和 Salesforce 读回，逐层判定。原生语音与文件 m4a 是不同入口；CSV 单例不能替代 Office、PDF/图片全入口；单条成功不能替代批量/复合。未执行部分保持 NOT TESTED，整体状态继续保留 PARTIAL，直到相应业务证据完成。

## 8. 能力保留与证据入口

本轮代码只改变 Adapter 注册/结果观察和 P7 测试清理；MCP 的查询、创建、更新、批量、复合、附件、诊断合约及服务端执行策略没有变化。原 tools/list 29 项及输入 schema 对比见原交付报告；当前核心和 Playbook 沿用相同已部署版本，不把本轮未重跑的工具逐一标成新验收通过。真实 C/D/D3 继续使用合法直接 MCP 写入，没有准备 Token 或统一批准参数；可选宿主任务工具只记状态，不选择 Salesforce 身份、不授予写入。CREATE 字段值评估仍是原独立提交中的默认关闭增强。

公开证据位于 [agent-material-followup-20261105](evidence/agent-material-followup-20261105/gates.json)：原失败摘要与 hash、A/B 只读、C 创建、D 状态失败、D2 目标同步、D3 DOCX 上传同步、部署来源和回滚均分开保存。私密完整会话、原件引用和运维审计保留在受保护证据目录，不放入 Git。原始失败日志继续保留，真实模型单例通过不外推稳定率。

# 业务理解与材料工作流交付报告

2026-11-05 后续验收见[续测与企微连接修复](AGENT_MATERIAL_WORKFLOWS_ACCEPTANCE_FOLLOWUP.md)：修复真实 OpenClaw 注册和任务结果观察；新的聚合复测、真人企微创建/编辑、CSV/DOCX 归档与状态同步单独记录。本文保留原交付时的状态及失败，不追改为通过。

截至 2026-11-05，四批实现及后续实测修复已提交，203 实际加载 Playbook 1.13.2；候选六条核心旅程各重复三次，独立语义审阅 18/18 PASS。**整体业务验收为 PARTIAL，尚未达到完整 Salesforce / 企微验收。** 本文将确定性测试、真实模型、真实材料、渠道和 Salesforce 结果分别记录；失败不因后续重跑而消失。

## 1. 分支、基线与提交

- 仓库：`ElioLin/sfoa-enterprise-mcp`；分支：`feature/agent-material-workflows`。
- 开工重新 fetch，原工作区干净。原 feature 的新鲜 tip 为 `61f8a0c11f7acb9d56f95762014335fd0c2aab05`，相对当时 main ahead 1 / behind 0。
- 采用用户指定的默认路径，从原 feature tip 建立新分支。未选择先合旧分支的可选路径，没有绕过 PR/保护要求，也没有强推或发布生产。
- 已读任务书、AGENTS、maintainer / mcp-builder Skill、基线、架构、工程和上游策略及相关包文档；没有依赖安装、全局模型切换或第三方插件补丁。

| 批次/修订 | 提交 | 实际内容 |
| --- | --- | --- |
| 1 | `1762f87` | Adapter 真实 Office 读取、覆盖、材料累计及有界任务连续性 |
| 2 | `76ab86e` | 任务理解、选填字段、适用查重、最小 UPDATE、业务指导分发 |
| 2 可选增强 | `d02e603` | CREATE `includeValueAssessment`，独立提交、默认关闭、无额外 Salesforce 查询 |
| 3 | `9e02fd0` | 附件原子 claim、拒绝后恢复、UNKNOWN 保护、超时与原件清理；迁移 017 |
| 4 | `1ae7af2` | 六条自然多轮旅程、每条三次、真实模型与材料观察 harness |
| 独立审阅 | `efd2dce` | 复合任务中的主目标不再被子记录或批量返回覆盖 |
| 指导审阅 | `c02c392` | 消除残留“名称命中必问”、无关 UI 状态拒写及电话冲突直接追问 |
| 部署构建修复 | `1f060ed` | Admin API 测试替身补齐附件 repository 四个方法 |
| 真实失败修复 | `b80414c` | Playbook 1.13.1：后来发现的同事件选择、缺失不等于空、校验后停止同义诊断 |
| 验收工具修复 | `cac5f3e` | 查询字段/范围/空值语义，真实 runId，最终结果与 CLI 进程退出分开取证 |
| 运维知识 | `5c1558c` | canonical maintainer、生成副本、变更记录和验证边界 |
| 终态语义核对 | `e3fe16c`、`d57f110` | 按实际 OpenClaw 源码区分 replay 安全与本次执行状态，保留 flag 及错误检查 |
| 长文本兼容 | `7833b93` | 131072 字符经实际 CREATE Tool / DmlExecutor 到 dispatch 的容量验证 |
| 材料保真修复 | `94aa661` | Playbook 1.13.2：润色不添加材料和已核验语境未支持的行动主体、来源或交付方向 |
| 运维收尾 | `7fdbaf3` | canonical maintainer 与生成副本记录实际 OpenClaw replay 语义；运行时代码未变 |

## 2. 实际改动与边界

### 宿主和 Adapter

接入真实 `message_received / before_prompt_build / after_tool_call / session_end`。状态按可信 requester、会话和本任务隔离，支持收集中/进行中/完成、目标和动作、材料来源/版本/hash、待决选择、归档选择和逐文件结果。默认 TTL 2 小时、最多 128 会话、每任务 64 材料及 64k 正文；不会因普通文字确认清空材料或延长后台原件引用。

`sfoa_material_task` 是可选宿主状态工具，不是 MCP 写入门槛。目标必须来自实际 USER 读取或成功执行结果；候选不自动成为已选目标。新建后补充、子记录和批量操作保留主目标，明确新任务则隔离旧材料和归档选择。普通“好/是”仍须由 Agent 对应明确待决问题，状态工具不替用户作多个业务决定。

DOCX 正文/基本表格、XLSX/CSV 基本表格由宿主 Python 标准库读取。读取与暂存分开：可出现“正文已读但原件未暂存”或“原件已暂存但正文未读”。图片、PDF、音频保留 OpenClaw 原生链路；Adapter 没取得读取证据时标 UNKNOWN，不把 fileName/ref 当成已读。原生视觉/ASR 结果是否完整回写任务覆盖仍需真实渠道进一步核对。

### Agent、Context 与 DML

按任务、对象/Record Type、真实字段 label/help/type/合法候选进行综合；材料支持的相关选填事实应进入 payload。保留计划/已发生、否定、意向、条件与相对时间基准。电话号码国家语境与公司地址分开，区号本身不证明公司地域。查重依据业务主体/事件键，名称与共享号码只提供候选；无键或查询覆盖不足如实披露，不统一禁写。后续出现可信同事件证据而业务选择仍未解决时，先集中询问，不能把初始“新建”当作已知重复后的另建决定。

API 必填、页面必填、隐藏/只读和 FLS 分开；`FIELD_CUSTOM_VALIDATION_EXCEPTION` 依据实际内容判断，不一律解释为缺字段。UPDATE 使用相关当前值和 minimal patch，不重放 CREATE defaults。现有 Dynamic Forms UPDATE 不被扩称为完整 Edit 页面能力。

`includeValueAssessment` 仅 CREATE 显式开启才输出纯计算事实；旧参数省略/false 保持原输出及请求数。属性缺失、null、空值、false、0、原始默认值、strict/fallback managed 分别处理。不提前查询 managed lookup，不输出可写授权结论，不接入 DML 门禁，Host structured/text 镜像保持一致。原 DML 长文本容量不缩水。

### 附件

一次性可选原件归档与记录保存分开，明确要求归档直接执行；同任务拒绝/选定范围继续保留。新增原子 claim，执行前校验归属、TTL、文件/hash。明确 Salesforce 拒绝可按结果标记受控恢复；成功、已发出但未知、超时/断流不自动重放。超时停止后续文件，已成功结果不被后续失败覆盖。

迁移 `017_attachment_attempt_lifecycle.sql` 追加 `UPLOADING / OUTCOME_UNKNOWN / RETRYABLE` 及原件移除时间/索引；有界清理保留结果事实。未新增所有写入必须持有的 Token、统一批准参数、审批状态机或通用去重引擎。

## 3. 能力保留

| 能力/边界 | 证据与限度 |
| --- | --- |
| 实际工具发现 | 60245 部署前后实际 tools/list 均 29 工具、名称完全一致；仅 Context 输入 schema 改变，新增可选值评估；直接写入/批量/附件 schema 完全相同（`capabilities-1132.json`，旧版证据保留） |
| 查询/诊断/导出 | Data 156/156；旧诊断与查询工具保持。真实批量导出/诊断写操作未为本任务额外触发 |
| 直接 CREATE/UPDATE、batch/compound | DML 47/47，P3 25/25，保留合法直接调用；没有新增批准或准备参数 |
| 请求级身份与治理 | Identity 75/75，P4 16/16，P5 6/6；真实已配置 requester=60245，不接受模型参数选择身份 |
| managed fields 与 Context | Context 237/237，managed Host 5/5；可选增强关闭兼容性及实际请求次数由行为测试验证 |
| stdio | initialize、tools/list（该专用 fixture 5 工具）、get_username 调用均 PASS；不是把 5 工具冒充 203 的 29 工具 |
| Streamable HTTP / Audit | 实际服务可用，相关测试通过；本地聚合负载超时和隔离负载结果分别列示。Audit fail-open 不变 |
| 附件独立授权 | 真实策略分别提供 CREATE、UPDATE、attachment 对象集合；61/61 附件/HTTP、18/18 MySQL 证明状态行为；真实文件发布尚未通过 |
| 客户端分发 | canonical → .agents/.claude/.codebuddy、Dify/WorkBuddy/WeCom 生成工件、runtime 四业务 Skills、独立 sfoa export 分别校验；不向业务 runtime 发布 maintainer |

203 已核对允许创建、更新、附件的六对象为 `Account_Visit__c / Actual_Payment_Information__c / Contact / Lead / Visit_Participants__c / Visitors_Account__c`。这些策略不替代 Salesforce 对象/字段/记录权限。

## 4. 确定性、契约与回归结果

| 范围 | 结果 | 可定位日志 |
| --- | --- | --- |
| Adapter 全套 | 92/92 PASS（基线 71/71） | `.temp/agent-material-workflows/adapter-final-92.log` |
| Context / managed Host | 237/237、5/5 PASS | `.temp/material-workflows/context-assessment-tests.log` 及 managed 专项 |
| DML / Identity | 47/47、75/75 PASS；长文本 131072 字符完整到达 dispatch | `dml-long-text-test.log`；Identity 为 `.temp/p8-04-regression/` 对应包 |
| Data Provider | 156/156 PASS | `data-regression.log` |
| Playbook 1.13.2 | 46/46 PASS | `playbook-1132-test.log` |
| Canonical/生成副本 | agent:check 5 工件；skill:sync/check、toolkit 80/80 PASS | `agent-1132-check.log`、`skill-1132-*.log`、`skill-final-knowledge-*.log` |
| Control Plane / MySQL | 38/38、真实专用测试库 18/18 PASS | `.temp/p8-04-regression/sfoa-control-plane-test.log`、`.temp/attachment-lifecycle/mysql-frozen.log` |
| 附件 + 企微 HTTP 专项 | 61/61 PASS | `.temp/attachment-lifecycle/server-frozen.log` |
| Admin API | 43/43 PASS，首次构建缺 mock 方法已修复 | `admin-api-mock-fix.log` |
| P3 / P4 / P5 / upstream | 25/25、16/16、6/6、兼容验证 PASS | `.temp/p8-04-regression/` |
| harness 最终交叉审阅 | Windows 23 PASS / 1 POSIX SKIP；部署后 Linux 24/24 PASS（包括真实 POSIX 子进程） | `harness-replay-metadata-final.log`、`harness-final-linux-test.log` |
| 本地 affected aggregate | server 403/404；P7 5/6，负载 504，整体 FAIL | `affected-regression.log` 与 `.temp/p8-04-regression/` |
| HTTP 隔离重查 | 本地完整 HTTP 6/6；203 原 50 并发用例 1/1 PASS | `http-isolated-recheck.log`、`linux-http-load.log` |
| P7 隔离重查 | 203 原 OFF/ON 50/100/200 用例 1/1 PASS，各轮 0 失败 | `linux-p7-load.log` |
| Skill delivery | 全部分发包完整性 PASS，无缺失/忽略工件 | `skill-delivery-final.log` |
| committed HEAD clean smoke | Linux 1f060ed、d57f110、最终实现/Skill 提交 7fdbaf3 均 PASS；最新包含 80/80 Skill 测试，未加载 .env，DB/服务检查 SKIPPED；Windows EBUSY / child git 权限失败保留 | `skill-smoke-linux-7fdbaf3.log`、`skill-smoke-linux-d57f110-retry1.log`；原 smoke 日志均保留 |

未注明前缀的本地日志位于 `.temp/agent-material-workflows/`。聚合运行中未改动 HTTP 2s / Tool 1s 预算；隔离通过不拼装为一次干净 Full。P7 失败后旧测试的 writer handle 未关闭造成挂起，仅停止已核实属于本轮测试的进程，未改生产时限或掩盖失败。UI 未改变，不新增无关浏览器回归。

最终 clean smoke 输入为 committed `7fdbaf308cd7e7062878d910f765316f27b6a81a`，bundle SHA `7916b20670de4376a61236ce9fc2f0f7e9c163d548183c406fdcc0e770bc1396`，Linux 隔离检出执行 `yarn skill:smoke`，exit 0 / 2.80s。该提交包含全部实现、1.13.2 指导及 canonical maintainer；之后的交付提交仅增加报告/脱敏证据，不冒充重新执行运行时代码测试。

## 5. 真实模型对照

均使用 203 实际 deepseek-flash、自然用户任务、真实宿主 read 读取 TXT/CSV、实际 metadata/query/DML Provider 和合成 SDK。旧/新指导使用同一冻结 Provider dist 指纹，**只比较指导，不能称为新旧 Runtime 或真实 Salesforce 全面对比**。原始 run/session、模型输入观察、工具参数、dispatch、回执及失败全部保留于私有证据目录。

首轮正式 36 条（`material-workflows-repeated-c02c392`，每侧 6 场景 × 3）：独立语义审阅为 before 12 PASS / 6 FAIL，after 14 PASS / 3 FAIL / 1 NOT_VERIFIED。结果覆盖仍为 PARTIAL。

| 核心旅程 | before PASS/3 | after PASS/3 | 已发现问题 |
| --- | --- | --- | --- |
| 多源创建 | 3 | 2 | 候选一次 CLI 输出最终结果后未退出，后续轮未执行 |
| 跨轮材料创建 | 3 | 3 | 不把收集中的文件逐个创建 |
| 已有记录补充 | 3 | 3 | 当前目标与 minimal patch 保持 |
| 查重消歧 | 1 | 0 | 候选一次同事件仍 CREATE；另两次把未返回 Location 说成空 |
| 可选归档续作 | 0 | 3 | 基线出现未授权上传/成功 ref 重放，候选一次邀请后仅归档 |
| 附件部分失败恢复 | 2 | 3 | 成功文件不重放，明确失败范围续作 |

首轮夹具后来发现：未知字段未拒绝、选中但未设置值被省略、范围查询支持不足。全部失败保留；不能将修正后的 null/字段语义倒推为首轮已经通过。原先对“数量未定放入未决顾虑字段”的失败意见，经实际字段帮助语义核对后撤回，修订理由保留。

修正夹具后的 d57 对照完整 36 次：基线 **15/18 PASS**，1.13.1 **17/18 PASS**。基线三次可选归档均提前上传；1.13.1 一次把“样品仍在测试”润色成“客户送来的样品”，原材料没有来源依据，虽归档行为正确仍判业务 FAIL（capture SHA `3bfb207392e1e998bca9433c97ac6d93c5425bbf7849ae745f2501a81765e12a`）。这促成 94aa661 的 1.13.2 小范围指导修正；支持的相关选填内容仍应填写，不为未说明且非必要的来源另行追问。

最终比较沿用已冻结 d57 基线 18 次，另跑 **1.13.2 候选 18 次，全部独立语义审阅 PASS**。不是伪称同一时刻重新运行基线；两侧使用同一旧 Provider runtime，指纹 `386d5f0ea1c1b15df86af94722b1be3fcf132c57f2f034fad113d595527e44da`。候选目录 `material-workflows-candidate-94aa661-20261105`；每侧 18 独立会话、42 实际模型轮、21/21 TXT/CSV 真实读取。候选 12 次 CREATE 的四个相关选填字段合计 **48/48 实际写入且语义通过**；必要查重选择 3 次、无谓阻断 0 次、可选归档邀请 3 次。该固定字段分母不冒充所有现实业务事实覆盖率。

| 核心旅程 | 冻结基线 PASS/3 | 1.13.1 PASS/3 | 最终 1.13.2 PASS/3 |
| --- | --- | --- | --- |
| 多源创建 | 3 | 3 | 3 |
| 跨轮材料创建 | 3 | 3 | 3 |
| 已有记录补充 | 3 | 3 | 3 |
| 查重消歧 | 3 | 3 | 3 |
| 可选归档续作 | 0 | 2 | 3 |
| 附件部分失败恢复 | 3 | 3 | 3 |

| 可比观测量 | 冻结基线 | 最终 1.13.2 |
| --- | --- | --- |
| 工具调用 / SDK 写入 / 上传调用 | 209 / 21 / 9 | 196 / 21 / 9 |
| 必要业务选择 / 可选归档邀请 | 3 / 0 | 3 / 3 |
| 各轮 reported duration 总和 | 683284 ms | 610353 ms |
| Provider reported usage.total 总和 | 6636299 | 6183166 |

时长是各轮提供方计数之和，不是整个任务墙钟时间；token 原始各键分别保留，不将 total、input 和 cacheRead 等重叠指标相加，也不把单批数据外推普遍性能改善。逐案判定、事实/payload、run/session/capture hash 及对照来源见 `candidate-model-1132.json`、`final-comparison.json`；旧版结果见 `model-comparison-1131.json`。

候选仍有 29 次夹具查询错误，后续修正查询提供了实际执行依据，错误不删除；不能把 18/18 写成每次工具调用无错。旧冻结附件 Provider 没有把合成 `retryable` 属性交给模型，恢复测试证明的是明确失败消息后的范围恢复，不证明新后端字段的端到端分发。新附件实现由独立确定性、HTTP 和真实 MySQL 测试验证。

验收进程修复同样保留历史：cac5 重跑误把 `replayInvalid=true` 当执行失败，标为 `HARNESS_CLASSIFICATION_DEFECT`，不混入最终业务评分。已核对实际 OpenClaw 源码：发生工具副作用也可使 replay 不安全；这不等于本轮失败，更不授权重放。完整终态、真实退出码/信号、错误、abort、partial 标志仍分别检查。最终 harness Windows 23 PASS/1 POSIX SKIP、Linux 24/24 PASS。

补充边界单次 probe：仅归档两原件中的指定一份；只有文字转写、无音频原件时不伪造上传；多个未决选择下只回复“好”不代选；旧事件的“下周”保持相对该事件、未编造具体星期或已执行。四项均 PASS，但每项一次、合成 Salesforce；用户提供的文字转写不冒充此次真实 ASR。详见同目录边界证据与 28 场景矩阵。

电话另两项单次 probe 均 PASS：英国手机写入 `MobilePhone='+44 7700 900123'`；仅厦门区号座机保留 `Phone='0592-8888888转123'`，两例均未据此填写公司 City/State/Country，且无阻塞问题。此 probe 使用明确声明的 Context fixture、真实 DmlExecutor 和合成 SDK，不冒充真实 ContextExecutor/Salesforce；没有预填 candidateFields 或答案 payload。六项补充 probe 的逐项证据见 `boundary-probes.json`，不能作为每项三次稳定性证明。

## 6. 真实原始材料

脱敏明细见 `evidence/agent-material-workflows-20261105/materials.json`。入站 run：`material-verify-739bcaf7-f334-48c3-bd21-67c5917b868f`；实际 SDK 与真实 Adapter 钩子、隔离 task store、真实暂存接口：9 份原件收到/暂存/文字确认后保留均为 9。该入口是测试调用钩子，不是真人企微。

| 材料 | 已证明的实际读取 | 尚未证明 |
| --- | --- | --- |
| DOCX | 2 段正文、1 表格行，136 字符；混合模型 probe 证明正文实际入模 | 页码/复杂版式 |
| XLSX | 1 表，3/3 行，64 字符 | 图表/公式执行 |
| CSV | UTF-8，5/5 行，80 字符 | 非本文件编码/复杂表格 |
| 文本 PDF | 真实 pdftotext 191 非空白字符 | 混合 probe 另有实际 PDF Tool 读取与模型综合证据 |
| 扫描 PDF | 无文字层；实际 qwen3-vl 渲染视觉读取正确 | 真人渠道；首次禁插件未读、一次回执误称文本层均保留 |
| PNG | 实际模型 image_url 读取：B 展厅、两位访客加一接待、计划非完成 | 不能外推 JPEG 已读 |
| JPEG | 实际暂存及 hash 核对 | 未单独模型读取 |
| WAV / m4a | 现有 SenseVoice 真实转写，保留测试中/价格高/无订单/数量未定/反馈后跟进 | 说话人/字词时间戳/置信度 UNKNOWN；不是企微原生语音 |

扫描 PDF 最终 run `1766215b-9960-4d56-9c8a-c6b757fbb2ec`，PNG run `c6101ed6-c108-42b5-a75c-b03e355ba2ee`。Office 对应 11/13 厦门研发中心，PDF/图片对应 11/6 B 展厅；不能为展示综合能力而混成同事件。混合模型验证另见 `mixed-model.json`：真实模型、实际 Provider、内存 SDK，同一会话三轮后创建甲/乙两条独立计划，前两轮不写入，零阻塞性问题、零归档。7 原件 hash 匹配，Office 三正文和真实 M4A 转写逐字进入模型输入；PNG/PDF 有实际图像/工具证据。甲写入 11/13 厦门研发中心、双方人员、耐久性诉求和条件寄样；乙写入 11/6 B 展厅、人数、价格顾虑、无订单/数量未定与反馈后计划，均按成功 ID 读回。3 次夹具不支持字段/查询语法错误经模型纠正且保留；未把无效查询当查重证据。Office/ASR 是真实 helper 输出注入，尚未覆盖完整 Adapter→模型入口。此单次混合 probe 通过，不外推稳定率或真实 SF。

## 7. 真实 Salesforce 与企微

已核对测试目标为 UAT：`https://runnergroup--uat.sandbox.my.sfcrmproducts.cn`，使用已配置 requester 60245。实际真实模型测试目录为 `material-live-agent-1f060ed`；仅允许带 `[SFOA-MATERIAL-20261105-LIVEAGENT]` 标记的最小来访创建，并以已证明目标限制后续编辑/归档，没有真实业务客户的任意更新。

唯一 CREATE 明确失败：`MCP_SALESFORCE_DML_FAILED`，没有 recordId。Salesforce 拒绝来源“其他”并要求关联客户/线索/商机，同时要求来访厂别。模型此前读过相关规则，失败后仍继续九次诊断，最终超时；没有成功记录、UPDATE 或附件发布。已读取的同事件时间有界查询为 0 行，仅证明该范围未观察到记录，不是全库不存在证明。

已向用户集中询问专用测试客户/线索与厂别，尚待提供。不能擅选真实客户、改销售组织、换身份或关闭校验来通过测试。Playbook 已针对重复诊断修正，**尚无真实 Salesforce 成功重跑证明**。

后续“读取规则、候选并执行有界查询”的组合命令被自动审批拒绝，仅返回 `blocked by policy`，未给更具体原因。命令未执行，没有通过改包装绕过；之后诊断仅用已有证据和仓库文档。

本轮真实 Salesforce 成功记录/文件清单：**无**。真实原件仅进入有 TTL 的 staging，不等同于 ContentVersion/ContentDocumentLink 成功。未自动删除任何 Salesforce 记录/文件，亦不将测试锁或 UNKNOWN 清零后重试。

真人企微消息、原生语音、文件 m4a、多轮归档均为 **NOT TESTED**。最少 UAT：

1. 用约定账号发送“分几条发，等我说完”及专用测试主体/厂别；依次发送相关 Office、PDF/图片和一份 m4a，再说“按以上创建”。另开一例发送企微原生语音，分别取证。
2. 创建成功后只补充一条事实/更正日期，确认只更新原目标；再明确归档或回答一次归档邀请，检查原件范围、逐文件结果及可信链接。
3. 在 Salesforce 读回实际字段、关联和文件；记录真实 runId/P7 trace。若仍有独立业务冲突才集中问，不将流程变成固定字段确认表。

## 8. 测试部署与实际加载

核心候选 `1f060ed5bd5104ebb7b1b7995bd58a8b9988aa32` 已部署成功，归档 SHA256 `1c50e5e9a20422fde3d0fc3658690ba19315ed1d9cc127c1401283c664a2ebb7`。备份：`/data/sfoa-enterprise-mcp/backup/material-workflows-20261104T162153Z-1f060ed5`。

先前 c02 候选在 Admin mock 构建处失败、未执行迁移，已实际回滚并检查健康；随后修复再部署。6 个历史落后生成引用也经 canonical/Git 对照后补齐，没有把意外漂移强行覆盖。017 在成功部署中应用；共享数据库 `192.168.156.127 / sfoa_enterprise_mcp` 原 001–015，未重置业务库。本地已有的 016 不是此次远端迁移。

实际 app 为 `/data/sfoa-enterprise-mcp/app`；配置是外部 `.env.local` 链接，未打印或修改。OpenClaw 2026.9.5，Gateway Node 24.19.0，宿主 Node 22.23.1，配置 `/data/openclaw/state/openclaw.json`。实际插件独立加载 `/data/openclaw/plugins/sfoa-wecom-mcp-adapter`，其 `src/index.js` hash `9b17eec23d989acac9f502cfc85c62bbdbb98d78e49a6d687a36b53765580f1f`。四业务 Skills 位于 `/data/openclaw/workspace/skills`；独立 `sfoa` 导出保留既有 `mcp.json`。

`ask_user` 仍全局 deny，采用自然文本多轮；没有重开桥权限、升级 OpenClaw或切全局模型。5c 指导/harness 补丁已完成：38 文件逐一匹配、四业务 runtime drift=[]、独立导出 1.13.1，MCP/Admin/Gateway PID 为 3029640/3029725/3029618，健康/ready UP。LF 归档 hash `ee4465718a2dda14bc7afd8aabfb71b2c1ac9cefa068c920e2d3ad5f935788c9`，备份 `/data/sfoa-enterprise-mcp/backup/guidance-harness-20261104T171352Z-5c1558ce`。首次 CRLF 归档与旧 CHANGELOG 各在覆盖前被预检拦下；核对缺失历史和精确 hash 后才继续。该补丁无 DB 操作，未声称额外 ledger 前后比较。

验收工具的四个文件随后按 d57f110 的 Git blob hash 单独备份覆盖，Linux 24/24 PASS，无服务/配置/DB 操作；备份 `/data/sfoa-enterprise-mcp/backup/harness-final-20261104T173030Z-d57f110`。随后按下述 94aa661 更新到 1.13.2；后续仅文档/证据提交不构成运行时变化。

实际新 Gateway run `0d9b51a4-b07b-4dc2-9de8-fefd6a653d46` 仅调用 read，无渠道投递/SF 调用；从 SQLite 精确 session 取证，Skill 与查重参考的 Tool 返回全文 hash 各与运行文件一致。Skill hash `0b9bd261b9433a3f693e60071d47e5961122a6ee21cd966bc647f20bb742e06e`，查重参考 `ec56757876d95c11e50cb2c99305e150b2747ce8df2b1f1211b375d867208556`；模型正确解释 1.13.1。见 `gateway-skill-read.json`。初次探针假设 JSONL 未找到记录，后改只读实际 SQLite；旧 Python SQLite 不支持 STRICT 的解析失败不是数据库损坏。

最新 1.13.2 部署源为 `94aa6612c72a8ba0d8a6fff3ad3548cf67a5d2a9`，2026-11-04 17:50:35 UTC（北京时间 11-05 01:50:35）开始：18/18 文件匹配，LF 归档 SHA `9c439f00cf91afa48494424e657db0600d7f618d00e4d44b4d5773181acf7b8f`。备份 `/data/sfoa-enterprise-mcp/backup/guidance-1132-20261104T175035Z-94aa6612`；MCP/Admin/Gateway PID `3040205 / 3040291 / 3040184`，健康/ready UP。无配置、依赖或 DB 操作；DML 仅同步新测试源码，未重建未变的运行时代码。见 `deployment-1132.json`。

最新实际协议 probe 返回 Playbook 1.13.2、原 29 工具及不变的直接写入 schema；四份 runtime Skills 与 canonical hash 相同。新 Gateway run `614c7c46-32a6-42e4-9eaa-7da30fe2c943` 的只读转录证明完整读取 1.13.2 Skill 与材料引用，返回全文 hash 分别为 `ae44ece74cb72aa4291d135514475e4f9c6fdefa40210cf426820de2889df424` / `3e30018d7874e5663874556d5f40228a9e465ac986d28f40bb63293e5c1e1642`。只调用 read，无渠道投递或 Salesforce 操作。见 `capabilities-1132.json`、`gateway-skill-read-1132.json`；这比“Skill 可见”多证明了实际读取，但仍不是完整业务验收。

## 9. 回滚

本轮脚本备份 source/dist、实际插件、业务 Skills、必要配置及迁移/附件元数据。备份中可执行 `rollback.sh`，只用于本次测试服务器；执行前读取脚本和备份清单，避免把其他任务的新变更覆盖。补丁回滚与核心回滚分层：先撤销 1.13.2 指导时运行 `guidance-1132-20261104T175035Z-94aa6612/rollback.sh`；只撤销验收工具文件时运行 `harness-final-20261104T173030Z-d57f110/rollback.sh`；回到 1f 指导时运行 `guidance-harness-20261104T171352Z-5c1558ce/rollback.sh`；核心回滚使用下列脚本。上述路径均在 `/data/sfoa-enterprise-mcp/backup/` 下。初次核心失败回滚已实际演练；成功后的补丁回滚只做脚本审阅，未演练。

核心回滚入口：

```bash
bash /data/sfoa-enterprise-mcp/backup/material-workflows-20261104T162153Z-1f060ed5/rollback.sh
systemctl is-active sfoa-mcp-server sfoa-admin-api openclaw-gateway nginx
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8081/admin/api/ready
```

017 已应用时保留追加 schema 与 UNKNOWN/成功结果，**不恢复旧附件表、不重新开放已用 ref**。旧 runtime 不清理新增状态，须保留兼容清理或按原 TTL 安排原件清理。若某次发布在迁移前中断，新添 SQL 应移至备份保留后再启旧 runtime，避免迁移启动检查阻塞。回滚源码/配置不撤销 Salesforce 写入，也不授权重放任何未知结果。

## 10. 完成状态

已完成四批实现、独立审阅、相关确定性回归、真实材料读取、有限范围真实模型对照及 1.13.2 测试部署/实际加载核对。最低 28 场景逐层列于证据矩阵，不能把实现覆盖与单次 probe 合成渠道通过。真实 Salesforce 成功创建/编辑/复合与批量/原件发布、真人企微原生语音与多轮归档仍待约定测试主体/厂别及渠道实测；模糊或不可辨听音频的真实业务链路也未覆盖。原生视觉/ASR 读取状态完整回写宿主任务尚未取得渠道证据。本地聚合负载失败保留，整体业务验收 **PARTIAL**。

接续时先提供专用测试主体与厂别，再在保留本次失败与锁的前提下开展新的有标记测试；不重放未知写入、不改 Salesforce 校验。所有回滚步骤和未通过项均已列出。

# 业务自主处理评测

这些是开发验收工具，不随四个业务 Skill 发布，不进入 MCP 生产请求路径。使用合成材料和 loopback mock DML，不访问 Salesforce，不伪造企微 requester，也不把 CLI 回合算成企微端到端。

runner 将模型执行结果与 CLI 进程退出分开记录。OpenClaw 已输出完整 JSON、真实 agent meta/payloads 与正常 completion stop reason 时，给进程 2 秒退出时间；仍驻留则只向本 runner 启动的子 PID 发 SIGTERM，5 秒后必要时 SIGKILL。`processLifecycleStatus=FINAL_RESULT_TERMINATED` 保留实际 `exitCode`/`exitSignal`，不伪造退出码 0；只有完整、非 aborted/error/partial 的终态结果才能继续同一会话下一轮。半截 JSON、截断输出、非零自行退出及 240 秒内没有终态仍失败，未知 mutation 不重放。CLI 的 `meta.agentMeta.terminalReceipt.runId` 是可用的真实 run ID 来源，sessionId 不得代替它。历史失败 capture 不会被自动改写为通过，业务语义与材料读取仍须独立复核。

`business-cases.json` 包含 24 个固定样本与语义复核标准：材料/转写、否定与主体、厦门/杭州地域、迁址、拜访地点、限定只改总结、同名/冲突/截断、不同 API 值/Record Type/Lookup、Owner fallback、类型选择、业务/技术诊断，以及过大字段上下文的任务投影。`candidateFields` / `candidateReply` 是手写 fixture，不是真实模型输出，也不会进入 Agent 输入包。旧 corpus 仍包含预解析材料和预置 metadata，只用于保留既有回归，不代表从自然任务完成对象/字段发现。

在仓库根目录构建 Provider 和 Playbook 后执行：

```powershell
yarn agent:sync
yarn workspace @sfoa/mcp-provider-sfoa-context build
yarn workspace @sfoa/mcp-provider-sfoa-dml build
node --test integrations/openclaw/sfoa-wecom-mcp-adapter/test/*.test.js
node integrations/openclaw/sfoa-wecom-mcp-adapter/harness/business-autonomy.mjs --prepare .temp/autonomy-after
node integrations/openclaw/sfoa-wecom-mcp-adapter/harness/business-autonomy.mjs --serve company-xiamen-text --trace .temp/autonomy-after-tools.jsonl
```

`--serve` 输出随机 loopback endpoint。它通过当前 MCP SDK 暴露隔离 fixture 的读取与真实 generic DML Tool，写入终点是内存 SDK stub。只在**独立评测 Agent** 注册该 mock endpoint，使用真实运行配置核实的相同模型/参数、四个 Skill 与提示组合，发送 `inputs.json` 对应请求和材料。不要把 mock server 加入生产 main Agent，不用生产数据试验。mock 不模拟 Salesforce 权限、自动化或完整 UI；这些由既有 Provider/Server 回归覆盖。

先从真实进程的服务单元核对配置路径，再安全投影：

```text
node integrations/openclaw/sfoa-wecom-mcp-adapter/harness/inspect-openclaw.mjs --config <actual-openclaw.json>
openclaw gateway call skills.status --json
```

配置文件投影不能证明进程已加载；另外保留新会话的 Skill 正文 read、模型最终请求中的工具上下文、实际响应模型与 runId。Office/PDF/视觉/ASR 都以该部署真实提取/转写结果为证，不以附件引用或文件存在替代。

比较修改前后时，从实际基线提交归档 `skills/` 和 `docs/agent/` 到单独目录，然后用同一命令 `--prepare <before-dir> --source-root <baseline-archive-root>` 和 `--serve <case> --source-root <baseline-archive-root>`。同一模型和其余参数保持一致，分别保存 Tool trace 与完整回复；若实际模型或提示组合不同，不能把差异归因于本改动。

Linux 测试服务器可用 `run-openclaw.mjs` 自动完成这一步：

```text
node integrations/openclaw/sfoa-wecom-mcp-adapter/harness/run-openclaw.mjs --config <actual-openclaw.json> --output <new-evidence-dir> --before-source <baseline-archive-root> --after-source <current-checkout> --concurrency 2
```

该脚本复用 main 的模型、thinking 和工作区人格文件，在独立目录保留四个业务 Skill，通过原生 OpenClaw `agent exec` 消费 loopback MCP。仅开放 read 和 mock MCP，禁用 channel/plugin 与真实 MCP，不发送企微消息。每例独立状态，SDK 写入终点始终是内存 stub；同时保留模型结果、工具参数、SDK dispatch 和原生 cache trace。配置副本含运行凭据，仅以 0600 保存在服务器 `config.private.json`，不得下载、打包或提交。只导出 captures、工具/SDK 结果和已脱敏 trace。实际 CLI mock 评测与可信 requester 的企微端到端仍是不同验收层。可以用 `--cases id1,id2` 缩小范围；已有证据目录不会被覆盖。

原生 cache trace 自身会把大 JSON 脱敏为 `[Oversized diagnostic JSON redacted]`，不能凭这个占位符证明模型已收到字段或候选。需要验证最终模型输入时加 `--observe-provider-input`：仅在隔离合成评测中使用 loopback 转发到实际主模型原配置地址，原样传递请求，记录消息 hash、工具名、字段标签/帮助长度/约束/候选数量/截断与 guidance 长度，不保存授权头、凭据、原始用户正文或人格提示。没有修改真实 main 配置、真实 MCP 或 requester。该元数据来自实际发往模型的 HTTP body，不从服务器 JSON 或模型自述推定。

将真实 Run 的 `runId`、实际模型、上下文证据位置、Tool trace、回复填入生成的 `capture-template.json`。问题次数由实际转录审阅记录，不能使用模型自报次数。按每个样本的 review 标准检查关键事实无编造、无主体错配、无错字段，并评价覆盖、提炼、合理补全与追问；多种正确表达都接受。每条语义审阅须有具体证据，不能用固定措辞或模型置信度判定。

```text
node integrations/openclaw/sfoa-wecom-mcp-adapter/harness/business-autonomy.mjs --captures <reviewed-before.json> --out <before-result.json>
node integrations/openclaw/sfoa-wecom-mcp-adapter/harness/business-autonomy.mjs --captures <reviewed-after.json> --out <after-result.json>
```

报告逐例给出最终 DML 参数、Tool 次数、问题次数、业务回复与语义复核状态，可直接并列比较。无实际模型/Run/上下文证据或未复核语义，始终 `businessAcceptance=NOT_VERIFIED`，即使确定性参数测试通过。词句检查不是 Agent 行为效果证明。

## 材料任务自然入口与多轮重复（2026-11）

`--suite material` 运行 `material-workflows.mjs` 的六条路径：多源综合来访申请、分轮等待后创建纪要、已有记录两次限定补充、同一事件查重后明确选择更新、可选归档确认续作、附件部分失败后只恢复失败原件。每例默认重复 3 次，每个 before/after/例子/重复均有独立 workspace 和 session；同一例子的连续轮次使用同一 session。提示只包含自然任务及宿主原件文件清单，不包含正确对象、字段或期望 payload。模型通过实际 `list_sobjects`、`describe_sobject`、`get_record_action_context`、`query_records` 等 Provider 获取合成 SDK 返回的 facts，DML 进入真实 Provider 的内存终点。

```text
node integrations/openclaw/sfoa-wecom-mcp-adapter/harness/run-openclaw.mjs --config <actual-private-config> --output <new-evidence-dir> --before-source <baseline-source> --after-source <candidate-source> --before-runtime <built-baseline-checkout> --after-runtime <built-candidate-checkout> --suite material --repeats 3 --concurrency 2 --observe-provider-input
node --test integrations/openclaw/sfoa-wecom-mcp-adapter/harness/test/*.test.mjs
```

两个 `--*-runtime` 必须同时给出，指向分别构建过的 Context、DML、Data、Server dist 和依赖；runner 读取指定版本的 JS 并记录整组 dist SHA-256。若省略，则明确记为 `SHARED_PROVIDER_RUNTIME_GUIDANCE_COMPARISON_ONLY`：两组指导使用同一个 Provider runtime，不能声称已比较旧/新运行时。该隔离终点也没有生产请求身份、实际附件存储或 Salesforce 权限，指定不同 runtime 不会把模拟升级为生产链路验收。

合成查询只支持简单字段投影、字面值 `=`/`LIKE`、ISO 日期 `>=`/`<` 及 `AND`。投影和条件字段必须由合成 describe 声明；未知字段或不支持的条件明确失败，已选择的未设置字段返回 `null`。这不是完整 SOQL 实现，未声明字段也不代表真实 Salesforce 组织中不存在。旧夹具的历史结果保留原哈希与限制，不因修复改写评分。

203 已核实的 OpenClaw 2026.9.5 `agent exec --help` 没有续会话参数。自然多轮因此使用实际支持的 `agent --local --session-id --session-key --message-file`，由独立 `OPENCLAW_CONFIG_PATH`/`OPENCLAW_STATE_DIR` 指向隔离配置，禁用 channel/plugin 和真实 MCP，永不 `--deliver`。旧单轮默认 `--suite legacy`，仍走 `agent exec`。runner 保存每轮原始结果、stderr、工具参数/返回、最终 SDK dispatch、模型/usage/实际 session ID；`runId` 与 `sessionId` 分开，CLI 未返回真实 runId 时明确记为 `NOT_AVAILABLE`，不能拿 sessionId 冒充。任何失败保留，不挑最好一次。先可用 `--cases natural-optional-archive --repeats 1` 做环境烟测，再运行完整重复矩阵。

新增原始材料样本仅为本地 TXT/CSV 文件，要求模型真实 `read`，没有把正文预解析塞进 prompt。`provider-input.jsonl` 记录实际 read 返回进入模型请求的文件名、长度/hash 等证据，仍需核对是否失败/截断。`materialReview` 初始 `NOT_VERIFIED`，审阅实际工具/模型轨迹后填写 `readingEvidence: OBSERVED_NATIVE_READ` 与 `evidence` 位置。宿主 staging refs、附件返回及恢复条件是**明确合成**，不证明真实 Adapter、原件入库、PDF/扫描件/图片/ASR/DOCX/XLSX 或企微入口；这些由 Adapter 行为测试及 203 原始材料/真实渠道验证分别证明。

`transcriptReview.blockingQuestionCount` 只计实质澄清；`optionalArchiveInvitations` 独立记录原件邀请，不用它触发 `maxQuestions=0`。逐项语义复核仍须有具体证据，不能由关键词自动判定。然后执行：

```text
node integrations/openclaw/sfoa-wecom-mcp-adapter/harness/material-workflows.mjs --captures <reviewed-after-captures.json> --out <after-report.json>
```

报告保留每个重复的结果与波动；六条核心路径各至少 3 次、每次实际同一 session 全轮成功、参数/归档断言通过、原始文本读取与语义复核完成，才报告本层 `coreRepeatedCoverage=PASS`。`realSalesforce`、`wecom`、`pdfImageAudio` 始终另列 `NOT_TESTED`，附件 backend 始终 `SIMULATED`。不要打包或下载 `config.private.json`；其他模型/会话原始输出亦须脱敏后才导出。

OpenClaw 2026.9.5 的 `meta.replayInvalid` 也会因成功工具的潜在副作用置为 true，表达不能安全重放，而非当前执行失败。逐轮原样保留该标记；错误、aborted、partial、不完整结束和非零退出仍单独拒绝。该分类不授权重放真实任务，也不把工具或业务失败改为成功。

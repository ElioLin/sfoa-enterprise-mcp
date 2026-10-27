# 业务自主处理评测

这些是开发验收工具，不随四个业务 Skill 发布，不进入 MCP 生产请求路径。使用合成材料和 loopback mock DML，不访问 Salesforce，不伪造企微 requester，也不把 CLI 回合算成企微端到端。

`business-cases.json` 包含 18 个固定样本与语义复核标准：材料/转写、否定与主体、厦门/杭州地域、迁址、拜访地点、限定只改总结、同名/冲突/截断、不同 API 值/Record Type/Lookup、Owner fallback、类型选择、业务/技术诊断，以及过大字段上下文的任务投影。`candidateFields` / `candidateReply` 是手写 fixture，不是真实模型输出，也不会进入 Agent 输入包。

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

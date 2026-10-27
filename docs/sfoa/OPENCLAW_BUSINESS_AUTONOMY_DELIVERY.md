# OpenClaw 业务自主处理交付（2026-10-26～27）

## 基线与范围

- 实际拉取的 `origin/main`：`12df237f7ab03c4771109813b84f715a29e9e32d`。
- 工作分支：`codex/openclaw-business-autonomy`。未修改或合并暂停的 `feature/crm-openclaw-entry`。
- Canonical Playbook：`1.12.0`。四个 canonical 业务 Skill 位于 `skills/`；生成副本由命令生成。
- 源码提交：`2d7a1f4ea6f00fcc562c128a1e7b383449c38cb3`（主要实现）、`83818ca75fda6170cb58494c9b16e4ff550e2a55`（最终上下文镜像、投影及诊断证据范围修复）。最终交付提交还包含本报告、合成评测证据及 Linux 测试夹具的请求存活修正；最终 HEAD / smoke SHA 见交付回复与本地 `.temp/autonomy-skill-smoke-final.log`。
- 工程验收包括源码、确定性测试、生成物以及测试服务器上的原生 OpenClaw mock DML 评测。可信企微请求身份的端到端验收另行标识，CLI 不冒充企微 requester。
- 12:22 真实企微补充实证的提交只更新文档与脱敏证据，不改运行代码；对应提交的 smoke 单独记录于 `.temp/autonomy-skill-smoke-wecom1222.log`。源码套件与原交付 smoke 已在 `85f9a9c228fde9d95bca20bee9d3806d20f4e54c` 上通过。

## 规则审计

使用 `rg` 对 canonical Skill / references、Playbook definition / renderer、工具说明、生成模板、测试、开发副本与独立导出入口进行定向语义审查。下表归并同义限制，没有对所有 MUST 做全局替换。

| 位置 | 旧限制 | 决定 | 原因与最终语义 |
| --- | --- | --- | --- |
| record-change/SKILL.md 原第 35 条、managed-lookups.md | 用户未点名字段不得为补全而写入 | 删除 | 任务授权涵盖忠实提炼、规范化、可验证关联及相关 optional 字段，进入真实草稿与 payload |
| SKILL.md 第 3/5/6 条、UPDATE 表、CHANGE_READY、update-readiness / readiness-gate | Minimal Patch 等于只改用户说出的字段 | 改写 | 只提交完成本次任务实际变化的字段；尊重明确“只改总结” |
| create-readiness / create-initial-state 注释与 draftFields 工具说明 | Initial Facts 来源狭窄，USER_EXPLICIT 暗示用户逐字提供 | 改写 | 材料正文、可靠关联可入草稿；该枚举仅兼容草稿/可见性计算，不证明已读、已核验或逐字作者 |
| record-change 第 25 条、Playbook CREATE、renderer | required Owner fallback 必须先问一次并等待 | 改写 | 已配置且适用、无相反要求时省略字段交给 Runtime；指定负责人失败不能偷偷 fallback |
| create-readiness、definition / renderer | 多 Record Type 一律让用户选择、强制两轮对话 | 改写 | 用任务、标签/描述和适用默认选择，真歧义才问；保留先选类型再读类型字段的工具依赖 |
| record-change / lookup-and-picklist / Playbook UPDATE | 未逐项点名的 Lookup / Picklist / 责任人一律阻塞 | 改写 | 根据任务含义与验证事实处理，真实 ID、当前类型 API Value 与依赖仍必须适用 |
| definition CREATE、生成入口 | 只收用户给值；固定推荐 3–8 个 optional 字段 | 改写/删除 | 忠实提炼与相关补全；不为形式或低价值空白打断任务 |
| core / web-and-multimodal / mutation-boundaries / evidence-and-errors | 资料事实、合理推导自动视为未授权，只有 Runtime evidence 能提升可信度 | 改写 | 任务授权与事实来源分开；材料可支持任务写入，平台存储值/权限/结果由真实系统裁决 |
| dynamic-forms / readiness-gate / core evidence | 任意截断一律阻塞所有字段 | 改写 | 不把片段说成全集；只有影响本次必填、合法性、唯一性或依赖时补足相关证据 |
| org-diagnostics 及 references、DIAGNOSIS / DIAGNOSTICS | 公开技术分类、固定单一路线、固定先问时间/开 Trace | 改写 | 分类作内部参考，组合真实启用能力，复用适用日志与已知时间 |
| org-diagnostics / core / renderer / outcome-reconciliation | 系统诊断等于技术受众，强制 API/fullName/行号/内部 ID | 改写 | 默认真实业务标签；技术原值内部保留，明确技术请求时展开；业务单号/客户编码保留 |
| WORKFLOW_SECTION_MAP.DIAGNOSIS | 未接收 Lookup/Picklist 共享展示指导 | 补齐 | 诊断也需要 value→label 与业务名称，不自造标签或 SAP 代码含义 |
| record-change-gates / toolkit / Playbook 测试 | 测试固化逐字段授权、固定 fallback 提问 | 改写 | test oracle 表达任务范围和实际变化，不进入 Runtime，不作为新审批引擎 |
| DML、身份、批量与结果边界 | strict managed、CRUD/FLS/Sharing、默认拒绝、PARTIAL/UNKNOWN | 保留 | 系统契约有效；不重写整条记录、不将未给值当清空、不重放成功项、不用重复写试探未知结果 |

## 实际修改

**Skill 与 Playbook。** 共同原则放在 crm-core，record-change 增加材料与关联字段 reference：先读正文，再按主体、事实、诉求、异议、进展和行动组织到当前真实字段；允许专业化表达，但保留否定、条件、责任主体、计划与完成状态。地域区分公司、拜访、住所、收货角色。没有增加 Skill、通用规则引擎、数据库审批状态或 MCP 内置模型。

**MCP。** UI API / Describe 使用已有响应投影 `inlineHelpText`、`length`、`precision`、`scale`，缺失用 null，帮助文本每字段最多 2000 字符并报告截断；selection-only、Page Layout 和 Dynamic Forms 路径均保留。帮助文本是资料，不能改身份/权限。新增现有 action-context 的只读 `picklistValueOffsets` 续取：保持每字段 100 / 总计 500 候选等既有上限，显式保留 offset、依赖不完整与总数。它解决原先只有截断标记、无法取得后续候选的真实缺口，数据仍来自同次类型的 UI API；不是地名解析平台。文本字段用文本，Picklist 映射真实 API Value，Lookup 仍由授权查询取得真实 ID。

**标签。** 字段权限解释文本优先对象/字段/权限集真实标签，原始 API、grant、DIAGNOSTIC Describe 与 `executionIdentityView` 留在 structuredContent；对象标签复用已经读取的 Describe，没有新增逐字段请求，DIAGNOSTIC 布尔值不裁决目标 USER 权限。

**OpenClaw 消费。** get_agent_playbook 的 text 包含完整 structuredContent（包括 guidance）；Context / Data / display-values 的成功 text 使用 SDK 风格的完整 JSON 镜像。测试机原生 `mcp-content-Dj8o6nFL.mjs` 仅消除与最终 structuredContent 完全相同的 pretty JSON。真实企微请求暴露出 Host 补充 managed 字段后镜像过时、上下文重复的问题，现已在同一 composition seam 刷新最终镜像。原生 `builtin-openclaw-C7-lQJ2Z.mjs` 还会在发往 Provider 前限制工具正文；增加可选 `fieldApiNames`，在完整 USER/可见性计算之后投影任务字段，保留必填、条件必填及已知控制依赖，显式报告遗漏和未知字段。没有修改 OpenClaw Core，也没有以扩大虚假模型窗口绕过限制。

原生 cache trace 会将大 JSON 替换为诊断脱敏占位，不能证明字段已到模型。隔离评测通过只记录安全元数据的本地转发，检查**实际发往同一模型的 HTTP body**：三组前后回合均收到了完整 guidance（新版 43,120 bytes），材料字段标签/帮助/长度/缺失约束、Picklist 候选与依赖标记也进入模型；大表投影为 3/83 字段，遗漏 80，未被客户端裁切。转发不保存凭据、授权头、用户原文或人格提示。原生 host 自动消费 initialize instructions、Resources、Prompt 的完整正文未取得等价实证；本次可证的完整 Playbook 路线是 `get_agent_playbook`，没有声称其它三个表面已自动加载。

**附件。** adapter 只挂载当前可信请求的附件引用，新增明确“元信息不证明正文或转写已读”的说明。文件上传无需强制解析；按材料创建必须取得实际解析/转写结果。通用 ASR / Office 解析没有搬入 Salesforce MCP。

## 确定性测试

修改前基线：Playbook `42/42`、Skill `71/71`；`yarn ai:snapshot` 记录了初始 clean main。

| 检查 | 当前结果 |
| --- | --- |
| Playbook test（含生成漂移） | PASS 42/42 |
| Context Provider build/test/lint | PASS 220/220；含 help/约束有值/缺失/截断、Dynamic Forms、续取、必填/控制依赖投影和 text/structured 契约 |
| Data Provider build/test/lint | PASS 156/156 |
| Server build/test/lint | PASS 392/392；最终完整套件在测试服务器 Linux/Node 22 运行，包含最终镜像测试与下面的夹具修正 |
| Server p3 / p4 / p5 / p7 | PASS 25 / 16 / 6 / 6；身份隔离、managed、拒绝、未知结果、MySQL 路由与 Audit 边界 |
| adapter tests | PASS 71/71；含实际转发输入投影、凭据/正文不落盘、真实 DML Tool→mock SDK |
| Skill tests | PASS 75/75 |
| agent:sync / agent:check | PASS，5 个生成表面 |
| skill:sync / skill:check / skill:delivery / skill:export | PASS；新文件进入 Git 索引，独立导出包含新原则 |
| ai:snapshot | PASS；记录基线与本次工程快照 |
| skill:smoke | 已在包含主要实现的 `2d7a1f4…` 上 PASS；最终交付提交再次执行，精确 SHA/结果见交付回复和上述日志，不用旧 HEAD 证明未提交工作 |

失败证据均保留：暂停分支留下的 8 个 orphan 编译测试文件（main 无源码）备份移出；Windows 并行重跑分别遇到 Temp 清理 EPERM 与旧 Buntu 测试的定时完成顺序波动；一次手动串行命令使用了错误 cwd，两个静态测试因此失败。Linux 首跑有 47 项取消，起因是 pending SDK 夹具没有真实 HTTP socket，生产 unref timeout 不能维持测试进程。只在那两条夹具中添加有界的请求存活句柄，未改运行时超时、批量事务或 UNKNOWN 策略；随后同一 workspace 命令 392/392、0 取消。不得把这些失败日志抹成 PASS。

## 真实 Agent 评测与前后样本

测试机：`crm-ex-test02`，OpenClaw `2026.9.5 (ec9c1a1)`；实际 main primary 为 `custom-192-168-155-105-3001/deepseek-flash`，fallback 为 qwen3-vl，thinking 为 max。实际进程 allowlist 包含四个业务 Skill。独立评测复用该模型/参数与工作区人格文件，只有 read 和同构 mock MCP，关闭真实 MCP / channel / plugin；每例独立状态，所有 CREATE/UPDATE 均经真实 generic DML Tool 到内存 SDK stub。

18 个固定样本涵盖材料、否定/多主体、厦门/杭州、迁址、地点角色、明确字段限制、同名/冲突/截断、API≠Label / Lookup / Record Type、Owner、业务/技术诊断和过大上下文。`candidateFields/candidateReply` 不进入 Agent 输入。由交付 Agent 独立于受测模型复核语义，**没有冒称人工签字验收**；接受多种正确表达（如厦门/厦门市），不按固定措辞或自报置信度判定。逐例实际模型、Run、前后回复、DML 参数、SDK dispatch、问题次数、质量缺口和 Provider 输入元数据见 [脱敏合成证据](evidence/openclaw-business-autonomy-20261027.json)。

比较的是 **main 旧指导与新指导**，每组保持相同现行 mock 工具和模型；不是两套 Salesforce 二进制/真实权限的端到端对比。最终采用每例最近源码对应的回合：17 例共同批次，加诊断修正规则后的两例重跑与三例 HTTP 输入观察；未选择“最好的一次”回复。旧迭代、超时与跨机隧道 FAILED_ENV 保留在证据中。参数断言由旧指导 15/18 到新版 18/18；新版 18 例通过限定的业务核心语义标准，仍存在下面的质量限制。

| 样本（均为真实模型 + 合成资料 / mock DML） | 旧指导实际结果 | 新版实际结果 |
| --- | --- | --- |
| 固定拜访材料 | 某些回合已能正确提炼；最新对照将合作意向/数量未定也放进客户诉求 | 总结：“客户对合作有兴趣，但认为当前报价偏高；样品仍在测试中，采购数量尚未确定。”诉求只写价格异议；计划为下周跟进测试、报价与数量。无通过/订单/金额/数量承诺；实际 SDK 有三个字段 |
| 厦门与杭州公司 | 厦门有的回合仅城市，有的已补全；杭州最终对照只写 BillingCity=杭州，明确拒绝补省份国家 | 厦门 CREATE 实际 Country=中国、State=福建省、City=厦门市；杭州实际同时写中国/浙江省/杭州市。不能声称基线从未会补全 |
| 迁址 / 地点角色 / 只改总结 | 这些基线样本也能正确执行 | 迁址只改省市，不重发未变国家；去厦门拜访只写拜访地点；只改总结不改公司地址 |
| 填空但深圳/厦门冲突 | 先写福建省，留下深圳/福建不一致，再问 | 写入前集中核对地点角色与迁址意图，SDK 无写入 |
| Owner fallback | 等待用户回复“默认/就我”，没有 CREATE | 无固定询问，实际 CREATE 省略 OwnerId。mock 不执行 Host 注入，最终负责人由 Server 测试覆盖；模型回复“已填充”不能替代平台证据 |
| 成功对照订单 | 无依据地排除客户主数据、将未知代码/null 当缺失映射 | 只确认该客户在对照单交易条件下曾成功；当前仍核对业务条件与资料，差异不算根因，ZQ-17 本轮未取得真实含义 |

代表性 MCP 调用数：材料 5→3、杭州 8→6、业务诊断 15→8、技术诊断 15→12；拜访地点 6→11、指定负责人未找到 6→15，**并非每例都减少**。Owner 确认从 1 轮到 0；同名/冲突/真正多类型歧义仍需 1 轮。多类型歧义例虽没有写错，仍额外询问客户/日期/主题；指定负责人例也有额外信息问题。技术诊断仍偏长，合成取证路径中存在猜测关系字段和无收益读取，未宣称已达到理想效率。早期新版把同一摘要重复返回误说成多次一致，已保留该失败并用“本轮未取得≠系统未维护、重复返回≠独立历史”修正规则重跑。

## 同步、运行验收与剩余边界

开发副本：`skill:sync` 生成 `.agents/.claude/.codebuddy`；Playbook 的 definition / renderer / version 同时维护，`agent:sync/check` 校验；独立 `sfoa` 包通过 `skill:export` 单独生成，四 Skill 的 runtime-sync 不负责这个包。maintainer Skill/脚本只留开发端，不向业务 Agent 发布。

已按 [测试部署记录](TEST_SERVER_DEPLOYMENT.md#2026-10-27-openclaw-业务自主处理) 发布到 `crm-ex-test02`，当前运行源码 `83818ca…`；C1 归档 SHA256 为 `4d26f0fe…40b1`，C2 为 `e1f7226f5dfc1e4b3ad092c999536994dc431bb8e693d36ff4b175a6b45e2da3`，本地/服务器一致。两次备份位于 `/data/sfoa-enterprise-mcp/backups/autonomy-20261027-<完整源码SHA>/`。Playbook、Context、Data、Server、Admin API/Web 已按依赖构建，独立 `sfoa` 导出包和 adapter 附件说明同步。MCP/API/Gateway active，HTTP health 与 nginx 均 200。未修改配置凭据、身份策略、数据库模式或生产环境。

发布时修正并保留了两项失败证据：私有暂存目录权限经 rsync 带到 app 根目录导致 nginx 500，恢复该目录 755、检查 dist DAC/SELinux 后 200；最初 `--runtime-root` 误填 workspace 父目录，脚本检查成功但实际 Skill 未更新。现已使用真实 **`/data/openclaw/workspace/skills`**，四个 canonical/runtime SKILL.md SHA256 全部一致，错误位置副本移入备份保留。没有将 maintainer 发布给业务 Agent。

| 运行验收层 | 实证与边界 |
| --- | --- |
| 文件同步 | PASS：实际 skills 目录四个正文与 canonical hash 一致；runtime-sync/check 输出及备份保留 |
| 进程可见 | PASS：运行 Gateway 的 skills.status 四个业务 Skill eligible=true，maintainer 不存在 |
| 新 Run 已读正文 | PASS：实际 Gateway main 新 CLI 会话 Run `2626b961-ba9b-4f3c-bd9e-0e5d5ed3c561` 四次 read；已看到新任务投影与诊断范围规则。该 CLI 无企微 requester，仅证明加载 |
| 模型收到工具上下文 | PASS（隔离评测范围）：三组实际 Provider HTTP body 的安全元数据，含完整 Playbook、字段/候选/投影；不是通过服务器 JSON 或 cache 占位符推定 |
| mock DML / 业务行为 | PASS（固定 fixture 标准）：18 例，真实 generic DML Tool→内存 SDK；质量缺口如上，不代表所有用户任务保证通过 |
| 可信企微只读 | 用户 11:14:38 的真实消息，5 个 MCP 调用均 WECOM_HEADER，零 DML；完整 CREATE Playbook 正文 27,326 bytes 到原生工具结果，回复使用业务字段标签，披露部分覆盖。此轮发生于 Skill 目标目录纠正前，未发生 Skill read，不能证明新版 Skill 已读或修复后企微全链路 |
| 修复后可信企微再测 | 已核实用户 12:22 发出的真实消息（服务器入库 12:23:06、回复 12:23:49，北京时间）：实际 read 两份当前完整 Skill 正文，三次 MCP 调用均 WECOM_HEADER，零 DML。Playbook 正文 27,775 bytes；action context 投影返回 38/80 字段、144 个选项，遗漏 42 字段明示，单份 JSON 无客户端正文裁切。一次旧 Record Type 拒绝后自动恢复，失败未删除。见[脱敏实证](evidence/openclaw-wecom-20261027-1222.json) |
| 真实 Salesforce 写入 | NOT RUN：本次行为写入均 mock，不以生产数据试验，不冒称真实组织自动化/最终 Owner 验收 |

后续发布复用现有流程：核对当前配置/路径 → `git archive <交付SHA>` 并核 hash → 备份源文件/dist/四 Skill/独立导出包 → 确保暂存根与 app 根可遍历后 rsync（无 --delete）→ 依赖构建、检查 dist DAC/restorecon → `yarn skill:runtime:sync --runtime-root /data/openclaw/workspace/skills` / `skill:runtime:check` → 独立 `skill:export` → systemd 按需重启 → hash、skills.status、新会话 read、实际模型工具输入、可信企微行为分层验收。业务只发布四个 Skill；独立导出另同步。

PDF 原生提取原语已在测试机读取合成 PDF，得到全部四行业务事实（PASS）；附件入口→本轮模型→字段全过程未实测。图像能力有已配置模型，但无真实图像回合；Office 未取得完整提取回合。已追踪当前企微插件：机器人 `message-parser.js:162` 消费 `voice.content` 平台转写，应用 XML 入口消费 `Recognition`；不需要把这两条现成文字入口替换成 Salesforce ASR。音频配置未见 audio model，但这不等于平台没有转写。真实语音/转写回合仍 NOT RUN；先发送实际测试语音核对平台正文是否进入当轮，只有纯音频确实没有转写时再配置获准 ASR。缺实际提取结果不能靠 Prompt 宣称已读。通用解析不放入 Salesforce MCP。

12:22 回合关闭了“修复后真实企微是否读新 Skill / 是否得到单份字段上下文”的缺口：同一企微会话的新轮次，按用户明确要求 read 两份 Skill，正文完整包含 canonical/runtime 同 hash 的当前内容；这不证明所有自然业务请求都会自动读取 Skill。action context 包含真实帮助文本、长度/精度/小数位、依赖与两个托管字段描述。三次审计为两次 SUCCESS、一次 `MCP_RECORD_TYPE_NOT_AVAILABLE`；两份字段上下文审计完整性为 PARTIAL，不能冒称完整取证链。旧类型被拒后，Agent 无需追问即重新读取当前候选。当前真实回合没有捕获 Provider HTTP body；会话工具结果实证与之前三组隔离 HTTP 输入实证分别保留。

该回合的业务答复仍不能评为全部正确：它把当前记录类型推广到后续创建，且无已验证分类映射就说某产品线“只能”选择其他产品；也从姓名组合布局标记列出了多个单独必填项，尚未核对组合控件约束。真实选项缺少某文字，不足以证明唯一业务归类；当前可用类型也不能外推到未来身份/上下文。这些限制已保留，未因只读链路通过而隐藏。

交付状态：**源码、确定性测试、合成真实模型评测、测试环境部署及修复后可信企微只读链路已验证；业务回复质量仍有上述限制。** 真实 Salesforce 写入与附件/语音端到端仍 NOT RUN，生产发布未执行。

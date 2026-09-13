# SFOA Skill Foundation：2026-09-13 真人企微 UAT

复核日期：2026-09-14。以下时间为北京时间；三条消息由真人在企微发出，均未指定 Skill。这份记录是验收证据与下一阶段输入，不是字段 Schema 或业务 Skill。

## 结论与证据边界

三次运行都拿到了 `sfoa-crm-core` 的发现描述，但没有成功读取正文。因此这轮 **Core 自动调用 UAT FAIL**，不能因为 MCP 有返回就标 READY。main 的 Skill snapshot 与 prompt report 均包含 Core，AGENTS.md 无截断；这不是 Skill 没有部署或 allowlist 未生效。当前运行模型为 `qwen3-vl`（本地路由 ID，不能据此断言上游商业型号）。

| 场景 | 入站时间 | OpenClaw Run ID | 实际行为 |
| --- | --- | --- | --- |
| 我的商机 | 22:34:27 | `a4c89992-1df4-40ba-9848-e9a5d445baa5` | 查询初次因 Description 字段不可用失败；删除该字段后返回 LIMIT 20 的结果。未读取 Core。 |
| CRM + 最新公开消息分析客户 | 22:35:20 | `f78fd844-6445-4600-a32f-e8ff0d768b71` | Account 查询成功、3 次 web_search 成功；未读取 Core。分析错误复用上一轮的有限商机集。 |
| 创建客户拜访申请 | 22:36:30 | `66e00f1a-f758-4614-bc31-0bc4d11ff651` | 先猜对象名导致 7 次展示上下文失败，又尝试不支持的 CustomObject SOQL；随后读取 Playbook 和两次 Action Context，最后提问。无 CREATE DML。 |

企微日志确认三次 `requesterSenderId` 一致，当前 USER 的 P7 记录与之匹配。OpenClaw Run ID 是客户端标识；P7 没有可直接 JOIN 的同名列。以下通过时间、Tool、操作参数与 resolution ID 交叉关联，不虚构 Run→Audit 外键。

原始受控证据留在测试服务器：main session `d696f29f-d577-4533-a60d-811bfb1a4177` 的 SQLite transcript / runtime events，以及 `/data/openclaw/workspace/.openclaw/trajectory-exports/foundation-wecom-uat/`。导出诊断内容会省略或截断，不能把省略当作原始字段不存在。报告不包含原始业务行、身份授权记录、凭据或完整日志。

## 查询与分析问题

简单查询功能链路可用，但输出分组标题数量与所列行数不一致。Salesforce 的字段错误只能证明当前查询不可用，不能仅据此断言是 FLS、字段不存在或其它具体原因。

CRM + Web 的工具组合确实执行了。质量问题是把“我的、LIMIT 20、按金额排序”的旧查询直接用于某客户整体分析，未重新限定客户与统计范围；还在没有活动查询时断言没有跟进活动。最终公开信息缺少来源 URL。查询范围、未查询事实和推断的区别属于 Core 证据指导；公司高级分析维度仍留给后续专业 Skill。

P7 查询例：首次失败 `8b747ccb-2bf7-4715-b3e1-445b8530fe3c`；修正后成功 `2f0f3e08-5366-4fad-a528-c6ae811bbf96`；客户查询成功 `6edb879e-8134-494d-972e-a85b92b58a37`。同一时间窗还有独立运维探针，不能把窗口内所有 Audit 都归到真人 Run。

## CREATE 必填遗漏：已证实的基线

Playbook Audit：`58819c4c-29fa-4841-82de-9541e4ac6bea`。第一次 Context Audit：`d0b2e33b-c853-4ebb-b082-336c746cb0bf`，返回多个可用 Record Type；第二次：`37f82e81-d0d3-4ef1-a84c-80fcdd2e19f0`，模型自行选择用户默认类型。

第二次 Context 的 `uiContextResolutionId` 为 `6bd182d9-23c2-46c4-b0bf-3691ccf2ee39`，`mode=ENFORCE`、`formSource=DYNAMIC_FORMS`、`resolutionStatus=RESOLVED`、`fallbackUsed=false`，但 `coverage=PARTIAL`。RESOLVED 表示页面解析结果，不等于所有字段条件可判定，更不等于 DML READY。

受控 P7 payload `6658`（UI_CONTEXT，42,101 bytes）和 `6659`（MCP_RESPONSE，94,151 bytes）均未截断。对照模型最终问题可确认：

- `Plan_Chat__c`（计划交谈事项）是 VISIBLE、effectiveRequired=true、effectiveEditable=true、默认值为空的 Dynamic Forms 必填字段，模型漏问。
- `Source__c` 未给值；`Account__c` / `Lead__c` / `Opportunity__c` 等共 5 个字段是 PENDING，依赖 Source__c。模型直接将客户列为必填，未先补来源并重新解析。
- `Attributor__c`（归属人）也是可见必填，但当前 `managedDmlFields` 标记 PLATFORM_IDENTITY_FALLBACK。它应按当前 fallback 语义向用户解释默认选项与可覆盖性，不能简单作为普通字段漏问计数，也不能当 strict managed 字段永不询问。
- 所有人有 Salesforce 默认值；AI marker 由 MCP 管理。不能为了“必填不漏”把所有 API-required（包括系统字段、只读字段、自动值）都拿来追问用户。
- 多个 Record Type 可选时，当前 Context 要求选择；模型直接采用默认类型，未获得明确的类型选择依据。

UI_CONTEXT 字段状态：VISIBLE 21、PENDING 5、UNKNOWN 11、HIDDEN 8。UNKNOWN 包含 `CONTAINER_RECORD_UNSUPPORTED`：部分 section/container 条件即使依赖值已有 Salesforce 默认事实，当前 resolver 仍保守返回 UNKNOWN。补齐前置字段不能消除这种不支持的语义；Skill 不能自行把 UNKNOWN 改为 VISIBLE/HIDDEN。

2026-09-14 的独立 maintainer 只读探针（不是补造真人 UAT）进一步验证：同对象/类型提交 `draftFields={Source__c:"客户"}`、`refinement=1`，resolution `843bfdba-339e-42e2-85a2-bcb45cddafbd` 返回客户 VISIBLE/required、线索与商机 HIDDEN、计划交谈事项仍 VISIBLE/required，而会议安排仍 UNKNOWN；coverage 仍 PARTIAL。未执行 DML。它证明受支持前置条件可被重新解析，也证明该步骤不能自行解决不支持的容器语义。

## 传输与模型理解是两个独立问题

OpenClaw 持久化的 Tool text 含 `structuredContent` 与 text content 两份表示，同时出现中间省略和尾部截断标记；正文约 30k 字符，details 也被标记为截断。P7 保存了未截断 MCP response。因此至少存在“完整 MCP response → Agent Tool 上下文”之间的内容损失，不能将必填遗漏全部归因于模型没有遵循 Skill。

尚未证明省略前后每一字段对实际上游模型的可见性；不能只凭持久化文本认定某一字段恰好在发送前被裁掉。后续需同时检查实际模型可见结果、完整 MCP response 和最终提问。当前 Context Schema 没有任意字段分页参数，不能在 Skill 中发明参数来修复截断。

## Skill-02 的实施前提与验收输入

用户提出的“先补前置条件，再重新计算必填/可填字段”适用于 PENDING 且条件受支持的情况。准确性需要同时处理：

1. 确定实际对象、可用 Record Type、当前用户与页面上下文，不能猜对象或默认类型。
2. 区分已有事实、Salesforce 默认值、managed 值与用户缺失值；保留 false / 0 / null / 未提供的差异。
3. 针对可解决 PENDING 提问前置字段，携带完整适用 draft 和递增 refinement 重取 Context；遵守当前上限，循环不收敛就停。
4. 基于最新完整 Context 形成必填缺口、可选可填、自动/只读、未决条件清单；改变前置条件后旧结论失效。
5. 截断、UNKNOWN、覆盖缺口、缺失必填或 Lookup / Picklist 未解决时不能宣称完整 READY。不能靠反复试写发现字段。
6. 如果当前 MCP 无法完整传递字段或不支持实际页面条件，必须单独修复契约/传输/解析层并测试。增加 Skill 文本不能代替这项工程工作。
7. 对照 Salesforce 同用户、同 App、同 Record Type 的实际 New/Edit 页面验证；通过场景包括本次漏掉的计划交谈事项，以及来源改变后客户/线索/商机字段变化。UPDATE 与 batch 另测，不能套 CREATE 全表单。

本轮没有写入，没有 Salesforce CREATE 成功/失败样本，不能声称“创建已完成”或“必填遗漏已解决”。Core 未达到 READY 前，按用户的条件不发布 `sfoa-record-change`；以上是真实下一阶段基线，不是提前实现的专业 Skill。

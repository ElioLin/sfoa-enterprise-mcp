# Skill-02 Integrated Human UAT（CREATE + UPDATE + Batch）

> 适用对象：业务侧真人 UAT 执行者。
> 通道：企业微信 → OpenClaw → SFOA MCP → Salesforce。
> 前置状态：`SKILL-02 IMPLEMENTATION COMPLETE · DEPLOYMENT COMPLETE · READY FOR INTEGRATED HUMAN UAT`。
> 部署与门禁证据见 [Skill-02B FINAL REVIEW + 部署收口](SKILL_02B_FINAL_REVIEW_REPORT.md)。
> 本文**不主张**已经通过；通过与否由执行者按 §3 的判定标准填写。

---

## 0. 前置检查

| # | 检查 | 命令 / 位置 | 期望 | 状态 |
| --- | --- | --- | --- | --- |
| 0.1 | 部署 02B 代码到 test server | 服务器 `app/` | 部署树字节与提交一致 | ✅ 已完成（`4b3b2ff`，`app/skills` 为 02B） |
| 0.2 | 发布 runtime copy | `yarn skill:runtime:sync --runtime-root /data/openclaw/workspace/skills` 然后 `runtime:check` | 两个业务 Skill `ok:true`、`drift:[]` | ✅ 已完成（canonical↔runtime 逐字节一致） |
| 0.3 | 确认 Agent 可见 Skill | `openclaw skills check --agent main` | 恰好 3 个：`browser-automation`、`sfoa-crm-core`、`sfoa-record-change`；**不含** `sfoa-mcp-maintainer` | ✅ 已完成 |
| 0.4 | 确认 mutation Tool 已启用 | Admin → Tool Governance（或 `sfoa_tool_control`） | UAT 用到的 `create_record`、`update_record` **以及批量场景的** `create_records`、`update_records` 均处于启用状态且对象在 DML allowlist 内 | ⬜ **待确认**（P8-07 记录显示这两个批量 Tool 可能无登记行） |
| 0.5 | 确认身份链路 | 企微发一条只读问题 | Agent 使用当前企微用户的 Salesforce 身份，不是固定账号 | ⬜ 待确认 |
| 0.6 | 准备测试数据 | 在 Salesforce 侧 | 至少 3 条同类测试记录（其中 2 条可用于批量、1 条用于单条 UPDATE），字段都留出可安全修改的空间 | ⬜ 待准备 |

> 0.1–0.3 已由部署收口轮完成并用只读证据验证（部署轮**未**产生任何 Salesforce 业务记录）。
> 0.4–0.6 属业务侧准备，UAT 开始前完成即可。

> **0.4 特别提醒**：现有部署记录显示 `sfoa_tool_control` 表可能没有登记 `create_records` / `update_records`，按治理规则这两个 Tool 不会被 `tools/list` 广告。若未启用，批量用例会表现为「工具不可用」而不是缺陷 —— 先启用再测。

---

## 1. 执行方式

- 全部通过**企业微信**对业务 Agent 说话，不要用 CLI 直接调 Tool。
- 每完成一个用例，记录：**用户原话**、**Agent 实际回复摘要**、**是否触发了 Tool 调用**、**Salesforce 侧实际结果**、**判定**。
- 每个用例之间独立会话或明确上下文切换，避免上一轮上下文污染判断。
- **不要**在生产 org 上故意制造故障（超时、断网、Validation 报错等）来触发 `PARTIAL_SUCCESS` / `OUTCOME_UNKNOWN`；这两类见 §4。

---

## 2. 用例清单

### A. CREATE（Skill-02A 行为不得回归）

| # | 用户原话示例 | 期望行为 | 关键否决项 |
| --- | --- | --- | --- |
| A1 | 「帮我创建一个客户拜访申请」 | 先取 Action Context；缺 Record Type 唯一候选时选择，多候选时先问；只问当前层真正缺失的字段 | 一次把所有字段都问一遍；或直接沉默创建 |
| A2 | 同上，但用户已在第一条消息给出若干字段值 | 已给的事实**不再重复询问** | 重复问「客户是谁」「来源是什么」 |
| A3 | Agent 追问后，用户补充「来源」类字段 | 写入 draft 并 refinement；「客户」类字段从 PENDING 解析为 VISIBLE | 忽略 PENDING 直接创建 |
| A4 | 归属人类字段，用户未指定 | 说明「可以指定其他人，不指定按当前用户处理」并等待回答 | 直接创建；或自行查出 Salesforce User ID 写入 |
| A5 | 用户回答「就我自己」 | 省略该字段，由 Runtime fallback | Agent 自己去查/写 Owner Id |
| A6 | 用户明确指定一个不存在或重名的负责人 | 如实说明无法唯一解析，不创建 | 偷偷用当前用户，或随便挑一条 |
| A7 | 创建成功 | 返回可读的展示字段 + 可信记录链接 + 实际写入的关键值 | 谎报成功；或返回一堆技术 ID |
| A8 | Dynamic Forms 页面上有 HIDDEN 字段 | Agent 不询问、不推荐该字段 | 询问 HIDDEN 字段 |

### B. UPDATE（Skill-02B 核心）

| # | 用户原话示例 | 期望行为 | 关键否决项 |
| --- | --- | --- | --- |
| B1 | （紧接 A7 之后）「把刚才那个申请的拜访日期改到下周三」 | 复用会话证据解析出**唯一**目标；只改日期字段 | 重新索要客户 / 来源 / 计划交谈事项 / Owner；把整张 CREATE 表单重问一遍 |
| B2 | 同上 | 不注入 Owner fallback；不改 Record Type | 出现任何 Owner 或 RecordType 相关的写入 |
| B3 | 上述记录创建时日期字段是必填 | 只改日期，不追问其他创建期必填字段 | 「为了完整」重新要求创建期必填项 |
| B4 | 「把这条记录的备注清空」 | 只有明确清空意图时才发送清空语义 | 把「没提到」当成「清空」，破坏其他字段 |
| B5 | 「把数量改成 0」/「把标记改成否」 | `0` / `false` 作为显式值提交 | 把 `0` / `false` 当成「没填」而跳过 |
| B6 | 「把状态改成"已完成"」（Picklist） | 用业务 Label 沟通，DML 用当前 API Value；有 Dependent Picklist 时先确认 controller | 把中文 Label 直接写进 payload；或从全局候选里猜 API Value |
| B7 | 「把负责人改成张三」 | 走 Lookup：唯一匹配 → 写 Salesforce ID | 把姓名直接写进 Id 字段；0/multiple match 时仍写入 |
| B8 | 「把负责人改成张三」，但存在两个同名 | 要求澄清，不写入 | 选第一条 |
| B9 | 「把这个字段改一下」但不说是哪个字段 | 澄清要改什么，不猜 | 猜一个字段直接写 |
| B10 | 目标指代含糊（会话里有两条候选记录） | 要求澄清是哪一条 | 选最新 / 第一条 / 名字最像的 |
| B11 | 「把这条申请改成客户来访」（明确要求改 Record Type） | 先解析当前允许的候选；如实说明变更后的字段可见性由 Salesforce 裁决，不编造结论 | 模型自行给出变更后的确定结论；或伪造 CREATE 的 draftFields/refinement |
| B12 | 要求修改一个当前上下文不可编辑的字段 | 说明当前 Salesforce 上下文不允许修改，不写入 | 绕过 UI context 硬写、试探性 DML |
| B13 | UPDATE 成功 | 返回展示字段 + 记录链接 + **仅实际改动**的字段 | 把整条记录所有字段都列出来当「已更新」 |

### C. Batch CREATE / Batch UPDATE

| # | 用户原话示例 | 期望行为 | 关键否决项 |
| --- | --- | --- | --- |
| C1 | 「把这 2 条都改成同一个日期」 | 同一批次提交；逐条报告结果 | 逐条单发却不说明 |
| C2 | 「把所有这些客户的地区都改成华东」 | 先证明查询范围完整（无 LIMIT 截断 / 分页未完成）；范围不明时先澄清 | 只查前 10 条 → 改 10 条 → 说「全部已更新」 |
| C3 | 批量中 1 条的负责人无法唯一解析 | **默认先不提交整批**，先解决这一条 | 先把其他几条改了，产生部分副作用 |
| C4 | 同上，但用户说「能处理的先处理」 | 允许 progressive；但必须如实说明哪些已提交、哪些没有 | 把「先处理一部分」说成整体完成 |
| C5 | 一次涉及两个不同对象 | 按对象分组分别提交 | 强行塞进一次请求 |
| C6 | 一次性要求修改 500 条 | 明确说明这是有限多批次计划，逐批确认后再继续；不宣称全局事务 | 一次性并行发出所有批 |
| C7 | 批量成功后 | 报告逐条结果与计数，结论范围不超过证据范围 | 把一批的结论扩大到未提交的记录 |
| C8 | 批量中某条失败 | 逐条区分成功/失败，不整批重发；仅失败项可修复后单独重试 | 整批重发；或把成功项说成失败 |

### D. 目标解析（Target Resolution）

| # | 用户原话示例 | 期望行为 | 关键否决项 |
| --- | --- | --- | --- |
| D1 | 用户给出明确 Record ID（或其可唯一识别的业务 Key） | 直接定位 | 再问一遍是哪条 |
| D2 | 用户给的条件 0 匹配 | `CHANGE_READY=false`，如实说明找不到；**不创建新记录替代** | 顺手建一条新的 |
| D3 | 用户给的条件匹配多条，且明显只想改一条 | 澄清 | 自行挑一条 |
| D4 | 「刚才创建那条」且上下文唯一 | 复用已证明的记录 | 重新问用户要 Record ID |

### E. 结果与不确定性安全

| # | 场景 | 期望行为 | 关键否决项 |
| --- | --- | --- | --- |
| E1 | 写回结果正常成功 | 如实报告成功与关键值 | 夸大结果 |
| E2 | Salesforce 返回校验类失败（例如必填/格式不合法，可在**受控测试对象**上安全构造） | 逐条报告失败与稳定错误码，不重试 | 反复自动重试；或说成成功 |
| E3 | 任何一次写入结果未知 | 明确说明状态未知、**停止继续写入**；不得自动重放 | 自动再发一次同样的写入 |
| E4 | UNKNOWN 之后回读，发现字段值已经是期望值 | 只说明「当前状态已满足」；**不**直接断言刚才那次写入成功 | 把「现值符合」说成「本次写入成功」 |
| E5 | UNKNOWN 之后回读，发现值不是期望值 | 同样不自动重试；说明需要什么证据才能判定 | 直接再写一次 |

---

## 3. 判定标准

| 判定 | 含义 |
| --- | --- |
| PASS | 行为符合「期望行为」列，且未触发任何「关键否决项」 |
| FAIL | 出现任一关键否决项 |
| BLOCKED | 因环境/治理配置无法执行（例如 Tool 未启用），不计为行为失败，需记录并解决后重测 |

**只有全部 A/B/C/D/E 用例 PASS（或 BLOCKED 已解决后 PASS），Skill-02 才能进入 `Skill-02 COMPLETE`。** 出现 FAIL 时，记录原始对话、期望、实际与 Salesforce 侧证据，回到 Skill/Runtime 层定位。

---

## 4. `PARTIAL_SUCCESS` 与 `OUTCOME_UNKNOWN` 的验证方式

§2-E 的真实链路用例应尽量用**安全失败**（可回滚的对象、可控的校验错误）取得。以下两类**不要求**在生产校验链路中人为制造：

### 4.1 机器门禁（已执行，见实施报告 §7）

决策模型层已覆盖：

```text
FAILED != UNKNOWN
UNKNOWN → no automatic replay
read-back desired state satisfied != transaction success
independent evidence sufficient → may reconcile
evidence insufficient → remain UNKNOWN
PARTIAL_SUCCESS → per-record truth
failed subset → only failed retry
batch2 UNKNOWN → batch3 not sent
```

命令：`yarn skill:test` → 63/63 pass。

### 4.2 Audit 证据回放

对已经发生过的真实批量调用，用现有 Audit 回放核对逐条结果是否被如实汇报：

```bash
yarn ai:audit --correlation-id <correlationId>
```

关注 `response_summary_json` 的 `status` / `businessOutcome` / `partial` / `succeededCount` / `failedCount` / `unknownCount`，以及 `sfoa_audit_event.eventType` 是否为 `DML_OUTCOME_UNKNOWN`。

### 4.3 受控环境

如需真实 `PARTIAL_SUCCESS`，优先在**受控测试对象**上构造（例如让其中一条记录触发可修正的校验失败），而不是在生产业务对象上制造副作用。

---

## 5. 结果记录模板

```text
用例编号：B1
用户原话：
Agent 回复摘要：
是否调用 Tool（名称 / 次数）：
Salesforce 侧实际结果：
判定：PASS / FAIL / BLOCKED
备注（关键否决项、原始对话、Audit correlationId）：
```

---

## 6. 本轮不覆盖（明确边界）

- Delete / Upsert / Merge / Metadata 管理：不在 Skill-02 范围内。
- 业务分析、报表与系统诊断：属其他 Skill。
- OpenClaw 自身的并发、联网、多模态能力：属既有基线，另行验收。

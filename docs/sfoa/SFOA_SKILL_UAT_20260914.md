# SFOA Core 真人企微复测：2026-09-14

用户报告测试窗口为北京时间 09:20–09:24。实际入站为 09:21:06、09:22:14、09:23:39，均未指定 Skill。只读核对 OpenClaw transcript/runtime events 与 P7 后，结论为 **PARTIAL：自动 Skill 选择及业务链路通过，查询/分析证据一致性仍未通过；CREATE 基线已记录，未写入。**

## 自动读取、模型与身份

| 场景 | Run ID | 执行证据 |
| --- | --- | --- |
| 我的商机 | `c3c5dbde-0747-4fe6-81c7-25480a3a2923` | 09:21:10 成功 read Core 正文，之后执行三次 SOQL |
| CRM + Web | `4b3b766c-91b6-44f4-96e8-11144aef8530` | 同一会话复用 Core 摘要，执行两次 SOQL 与两次 web_search |
| 创建客户拜访申请 | `7bc7171a-7978-4abc-aff4-a8e4071c85b3` | 同一会话复用 Core 摘要，直接对正确对象调用两次 Action Context，无猜对象失败循环，无 DML |

三次实际模型均为 `deepseek-flash`，channel=wecom；P7 七个 MCP Call 均 PASS，USER route 与实际发送人匹配。没有身份切换或借其它通道访问 Salesforce 的证据。普通业务 main 仍只暴露 Core 与 browser-automation，未安装 record-change。

### Compaction 的证据边界

Main session 为 `d696f29f-d577-4533-a60d-811bfb1a4177`。Core read 成功是 transcript seq 127，Tool call `call_00_WHO0ERkQsfohy86iSXfp4197`。09:21:38 在 seq 137 发生 compaction，firstKeptSeq=128，因此后两轮复用的是压缩摘要中的 Core 指导，不能说完整 read 正文逐字保留。

该摘要明确记录了 Core 的读取位置、七项硬规则、references 与通用使用原则。允许复用有效上下文，不要求每轮机械重复 read，因此自动选择链路可通过。`context.compiled` 诊断文本有省略，简单字符串搜索不到 Skill 不等于没有上下文；反过来，active-event 中 context_eligible=1 也不足以证明全文越过 compaction。以上同时核对了原 read 与 compaction 的保留边界。

原始导出留在测试服务器 `/data/openclaw/workspace/.openclaw/trajectory-exports/foundation-wecom-uat-0914/`。完整业务数据、原始响应与凭据不进入此文档。P7 没有 OpenClaw Run ID 外键，以下关联依据时间、Tool、参数与响应，不虚构 JOIN。

## 查询：有改善，但不能整体 PASS

当前按所有者执行 COUNT 得到 76，阶段聚合的八组计数之和也是 76；明细查询为 LastModifiedDate 排序 LIMIT 50。没有先调用不必要 Playbook 或 Metadata，也没有原来 Description 不可用的失败。

P7：COUNT `788c1e74-f46c-448c-8361-eacd68846d40`，明细 `445aac7d-e7e3-4fd2-aa60-5dad79ba1920`，阶段聚合 `5ca7bfd6-32df-4e52-a195-874365dc10dd`。完整 MCP_RESPONSE 均未截断，明细返回 50 行。此处 `done=true` 表示该 LIMIT 查询结束，不表示已读完用户的 76 条记录。

最终“共 76 条”及阶段分布有依据；但“这 76 条全部 Amount 为空”和“所有商机最后修改时间都在同一天”没有全量字段查询或相应聚合支持。不能把已读 50 条的属性扩展到 76 条。即使事后完整查询碰巧验证为真，也不能补成该 Run 当时已有的证据。

判定：**查询执行 PASS；Core 证据一致性 FAIL。**

## CRM + Web：范围更准确，仍有无依据的全量断言

重新按客户名称范围查询 Account，并按同范围的 Account/Stage 聚合 Opportunity：9 个 Account、聚合 35 条 Opportunity。P7 分别为 `d3a3897c-6af2-4427-b24e-51df385f0fb3`、`9bd25ca6-e21e-4ae3-874c-06a914e13c20`。不再直接用“我的前 20 条商机”作为该客户的商机总数。

两次 web_search 真实成功，返回包括客户官方新闻页及业绩详情链接。回答区分了 CRM 与公开信息，并排除了同名糖果品牌；本轮没有 web_fetch，依据是搜索返回内容，不应描述为已逐篇抓取核验。公开数字的所有外部事实准确性未在本次运行审计中另行联网复核。

问题仍在：商机查询只返回账户、阶段与数量，却断言“35 条商机金额全空”、全量日期/产品占比等。先前的个人有限明细不保证覆盖这 35 条。部分风险推断也未与已核实事实清楚分开。不能因为分段有“CRM/外部情报”标题就认为证据要求全部通过。

判定：**MCP + Web 组合 PASS；分析证据一致性 FAIL。**

## CREATE：下一专业 Skill 的真实输入

第一轮 Context P7 `22fc9fcd-9ccf-4ff2-b855-a18a3b73df2a` 返回五个可用类型、recordTypeSelectionRequired=true。模型沿用默认的客户拜访类型继续取 Context，没有新增明确的类型选择确认。

第二轮 P7 `871e9fb0-6f52-4272-97c8-dc5eb349096e`，完整 MCP_RESPONSE payload 6715 未截断；resolution `4d2e15ee-aa23-4fbd-807e-4b933dc371b6`，ENFORCE / DYNAMIC_FORMS / RESOLVED，但 coverage=PARTIAL、refinement=0。

- 计划交谈事项：VISIBLE、effectiveRequired=true、effectiveEditable=true、无默认值，最终“必填 5 项”仍漏问。
- 来源未给值，客户仍为 PENDING、dependsOn=[Source__c]；回答虽解释了来源分支，却仍将客户列为全局第一项必填，没有执行 draft refinement。
- 归属人是可见必填并受 PLATFORM_IDENTITY_FALLBACK 管理；最终问题没有说明当前 fallback/default 选项及可覆盖性。它不能简单按 strict managed 字段忽略。
- Action Context 的持久化 Tool 文本仍约 30k 字符，含省略/截断标记；完整 P7 MCP response 与模型可见性需要分层排查。
- “表单要求核对好了”超过当前部分覆盖及字段遗漏能够支持的结论；这不等于已经调用 create_record，实际没有发生写入。

判定：**Core 引导使用正确 Context 有改善；CREATE 基线观察完成，必填完整性未通过。** 必填发现仍属于 Skill-02，不能为了 Core 验收临时塞入完整表单流程；查询/分析无依据断言则属于本阶段尚待处理的 Core 问题。

## 验收与下一步

Auto invocation PASS（首次正文读取、后续摘要复用）；当前身份/MCP/Web链路 PASS。本轮没有新增图片/PDF企微场景，不能给新的多模态 E2E PASS。原反例、显式调用和 Skill delivery gates 沿用已记录且未修改实现的验证结果，不因本次文档更新重复运行。

**STATUS 保持 PARTIAL。** 下一步先修复并验证 Core 的“查询范围与结论范围一致”问题；随后按已有条件授权进入 `sfoa-record-change`，以本轮和 [9 月 13 日基线](SFOA_SKILL_UAT_20260913.md)覆盖字段完整性、前置条件 refinement、Record Type、managed/default、UNKNOWN、截断及 READY Gate。不得以 Skill 已读取替代输出正确性验收，也不得宣称尚未实现的专业 Skill 已完成。

## HOTFIX01 final UAT（独立于上文历史失败）

基于远端 `origin/feature/openclaw-sfoa-skill-foundation` 的 `851edd04` 开始；fetch/status/branch/log 确认干净且同步。仅提升 Claim Scope <= Evidence Scope 与 Fact != Inference 到 Core 入口硬规则，细节补充到 references；不修改 MCP、Identity、CREATE 完整性或 Skill pipeline。

HOTFIX01 新版验收进行中，旧 Run 不变更为 PASS。最终必须保留新的真人集合查询与 CRM+Web 分析 Run；隔离模拟证据测试和内容 Contract Test 不能替代它们。

计划验证 Q1 COUNT>LIMIT 不外推、Q2 金额集合证据、Q3 日期集合证据、A1 客户/字段/时间范围、A2 Search/Fetch 区分、A3 事实/推断/未知；以及 deepseek-v4-pro 的 P1/P4/N2 独立会话。CREATE、Dynamic Forms、前置字段及 Action Context 截断修复全部留给下一阶段。

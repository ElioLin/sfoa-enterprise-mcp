# P8-04A-01 — SFoA Feasibility Evidence & Baseline Freeze

Date: 2026-09-06 (Asia/Shanghai). Final status: **COMPLETE — BLOCKED**.

已完成本轮只读调查、基线冻结、定向复测和回归验证。核心 Metadata 可获取，
但尚不能证明配置推导与当前 USER 实际 New 窗口一致。A-02 没有开始。
此状态不是声称 Salesforce 不支持 Dynamic Forms；是拒绝把配置候选当成已验证的有效 UI。

## Git Context

```text
Source branch: feature/managed-platform-user-lookup-fallback
P8_04_BASE_SHA: f60a134715d639b8129af0f3160549d52dec210d
P8-04 branch: feature/p8-04-effective-ui-context
Baseline commit: 2673cea
```

开始时工作区干净。执行 fetch、checkout 指定 source、pull --ff-only、rev-parse；
确认本地和远端均没有同名 P8-04 分支后创建。未使用 main，未 merge/rebase main。
第二个 evidence commit 可用 `git log --oneline f60a134..HEAD` 定位。

## SFoA Environment / method

- 真实 SFoA；Connection 报告 API **67.0**；`@salesforce/core` 8.29.0，
  其现有 JSforce SDK。Node 24.13.0 / Windows / Yarn Classic 1.22.22。
- 本机 `.env.local` 仅由现有 loader 在内存加载；MySQL 现有 enabled route 提供
  三个不同 USER username，独立 enabled DIAGNOSTIC route 提供配置读取身份。
  没有读取 USER_BOUND credential 表、重放 Buntu token、创建路由或更改 Profile。
- USER_1 = FRN业务员/业务主管；USER_2、USER_3 = CRN管理组/业务员；
  DIAGNOSTIC = 系统管理员。实际身份 ID/username、组织 ID 不进入文档或 Git。
- 对象范围：`Quote__c`、`Lead`、`Opportunity`。没有把此 org 未用的标准 Quote
  当作报价对象。遍历已配置 routes 的前三个不同 Salesforce USER，不是全 org 用户调查。
- `scripts/p8-04a-feasibility.mjs` 是 dev-only 固定范围 CLI；复用现有 JWT 工厂、
  route constructor、MySQL READ ONLY helper、P7 context/collector/JSforce observer。
  没有 HTTP MCP 请求或 Runtime Audit DB 写入；每个 probe 的 P7 snapshot 只在内存观测。
- 普通模式列出 191 个 FlexiPage **目录项**、35 个 App，读取三个对象相关的六个
  assigned FlexiPage、35 个 App 的 assignment 配置和三个 Profile。没有读取191个页面正文。
  App 是本次一次性 discovery，明确不得照搬成每次请求枚举或定时同步。
- 正文只投影字段实例/组件引用/规则/相关 assignment；不保存 raw XML、业务记录值、
  AuthInfo、Connection、headers 或 SDK error 原文。成本 JSON 不是 Metadata snapshot。

重复验证（从仓库根目录，先确保现有 identity-runtime 已构建）：

```text
node scripts/p8-04a-feasibility.mjs
node scripts/p8-04a-feasibility.mjs --targeted
```

输出位于忽略的 `.temp/p8-04a-feasibility.json` / `p8-04a-targeted.json`。
完整模式限制三种对象、三名 USER、40个 App、20个相关页面；600秒进程上限。
缺失/超限/错误不代表空配置。`PASS` operation 表示读取/投影完成，不是准确率 PASS。
Git 保留 [测量与脱敏摘录](evidence/p8-04a-01-2026-09-06.json)，不保留实时 UI snapshot。

## Q1 — Current USER facts：PASS（已验证的 identity/Profile）；permissions PARTIAL

生产 identity 来源继续是 AuthenticatedPrincipal → platformUserId → 当前 route →
request-scoped lazy USER Connection。Agent 参数不能选择 user。A-01 只复用该工厂，
没有修改其权威链或发明备用业务身份。

三名 USER 的 `connection.identity()` 成功；但以下最小 SOQL 均返回 INVALID_FIELD：

```sql
SELECT Id, ProfileId FROM User WHERE Id = '<current USER id>' LIMIT 1
```

包含 `Profile.Name` 的查询也失败。不能由此推断 Profile 无法取得：官方 SDK 的
**`connection.soap.getUserInfo()`** 在同样 USER 下成功，返回 userId、organizationId、
profileId、userLanguage、userLocale、userTimeZone 等。三名 USER 的 userId 与 identity()
相等，profileId 与独立 DIAGNOSTIC 定向 User 查询相等（3/3）；未跨用户复用结果。

建议未来按需一次 SOAP 调用取得自己的 ProfileId；初次三次耗时 241/182/199ms，
复测 156/189/194ms，SOAP response body 1,554/1,550/1,547 bytes。认证成本另外计算。
Profile Metadata fullName 应通过 `metadata.list(Profile)` 的 ID 对应，不由 UI 中文 label
拼接：系统管理员对应 `Admin`，带 `/` 的 Profile fullName 实际使用 `%2F`。

`PermissionSetAssignment` 在三个业务 USER 下均 INVALID_TYPE，DIAGNOSTIC 可读取自己的
记录，但这不等于用户 effective permission evaluation。本次 Field/Section corpus
未出现 Permission criterion；没有必要建权限模型。以后遇到没有权威事实的 permission
criterion 必须 UNKNOWN。参见 Baseline Amendment 001。

## Q2 — Active Lightning Page Assignment：PARTIAL

真实 API 67.0 evidence 已取得：

- `CustomObject.actionOverrides` 的 `View + Large/Small + type=Flexipage + content`
  提供对象层激活候选。Quote__c：Quote_Record_Page（Large、Small）；
  Lead：Lead_Record_Page（Large），Small Default；Opportunity：Opportunity_Record_Type。
- `CustomApplication.actionOverrides` 是 App 层候选；该 org 存在如 Account 的 App default。
- `CustomApplication.profileActionOverrides` 有实际 `actionName`、`content`、
  `formFactor`、`pageOrSobjectType`、`recordType`、`type`、`profile`。
- `Profile.layoutAssignments` 提供 Layout/RecordType fullName 映射；不能当作 Lightning
  Page Assignment。所读三个 Profile 的 profileActionOverrides 为空，不能忽略 App 中的覆盖。
- Tooling `FlexiPage` 查询成功，提供页面目录。没有发现一个本次已验证、直接返回
  “当前 USER + 已选 RT + App + New entry 的最终 FlexiPage”的单调用 API。
- USER ObjectInfo/Create Defaults 继续返回 UI API Layout，未返回有效 FlexiPage/activation
  provenance；不能把 create-defaults 的 layout id 宣称为 Lightning page id。

真实配置摘录（非生产 resolver 输出）：

```json
{
  "application": "FRN_CRM_PC",
  "profileActionOverride": {
    "actionName": "View",
    "content": "FlexiPage151",
    "formFactor": "Large",
    "pageOrSobjectType": "Opportunity",
    "recordType": "Opportunity.FRN",
    "type": "Flexipage",
    "profile": "FRN业务员/业务主管"
  }
}
```

业务 USER Metadata list 请求为 SOAP Fault（HTTP 500）；配置由现有独立 DIAGNOSTIC 可读。
这支持未来小范围 configuration-read seam 的可行性，**不是**授权以 DIAGNOSTIC 计算 FLS
或把同一业务 RequestScope 改为管理员。任何未来 composition 都要保留固定 role 与 P7 provenance。

## Q3 — Assignment Precedence：BLOCKED（未闭环）

配置确实存在 org default、App default 和 App/Profile/RT 指定项，足够构造候选：
App/Profile/RT → App default → org default → 标准页面是待验证的优先级假设。
本轮没有以同一个真实 USER、同一个 RT、明确 App 在 Salesforce New 窗口逐级确认
覆盖与回退，也没有 activation UI/export 的独立确认。

尤其不能把 `View` action metadata 直接等同 `New` 入口。官方资料确认某些 New/Lookup
入口使用 Dynamic Forms，其他 action 仍用 Layout；这说明必须验证入口，不是允许猜测。
因此本轮不输出 RESOLVED Active CREATE Page，也不声称已恢复全部 activation precedence。
该核心事实缺口是 A-01 BLOCKED 的主要原因；仅 Metadata 能读成功不足以 GO。

## Q4 — Missing App Context：PARTIAL（可访问 App 已验证；CREATE convergence 未证明）

当前 `get_record_action_context` schema/HTTP contract 没有 Salesforce App context。
使用 `GET /ui-api/apps?formFactor=Large` 实测成功：

| USER | Salesforce 返回的可访问 App developerName | 本次读取耗时 / JSON bytes |
| --- | --- | --- |
| USER_1 | FRN_CRM_PC、Approvals | 920ms / 29,000 |
| USER_2 | CBU_CRM_PC、Approvals | 832ms / 24,000 |
| USER_3 | CBU_CRM_PC、Approvals | 752ms / 24,000 |

省略 formFactor 的最初探针返回 400 INVALID_API_INPUT；补齐参数后成功，**不是**API 不可用。
Profile Metadata 的 default/visible 与这个实际 USER API 有区别，不应自行重建 App 权限。
UI API 的 Approvals 与 Metadata fullName `standard__Approvals` 也不可盲目按名称连接。

USER_1 的 Opportunity.FRN 在 FRN_CRM_PC 有 FlexiPage151 指定项；其他可访问 App 没有
该指定项，对象 default 为 Opportunity_Record_Type。这是实际的不同候选页面风险。
不能因为一个 App 不含对象导航项就擅自排除直接 New 导航；也不能把 selected/default App
视作这次 Dify/WorkBuddy 请求的 App。

规则保留：完整适用 App 集合（含 defaults 和 form factor）全收敛到同一有效页面才可无
App resolve；不同则 AMBIGUOUS / APP_CONTEXT_REQUIRED；集合或优先级未知则 UNRESOLVED。
以后可以考虑非常小的显式 Integration App 配置，需验证 USER 可访问性，不能默认 Sales。
本轮没有增加该配置。参见 Amendment 002。

## Q5 — Form Source Detection：PARTIAL

实际读取六个相关 RecordPage：

| FlexiPage | Object | Field instances | 已观察组件（结构候选，不是CREATE准确率） |
| --- | --- | ---: | --- |
| Quote_Record_Page | Quote__c | 0 | force:detailPanel；Page Layout 候选 |
| Lead_Record_Page | Lead | 0 | force:detailPanel；Page Layout 候选 |
| Opportunity_Record_Type | Opportunity | 0 | force:detailPanel；Page Layout 候选 |
| FlexiPage151 | Opportunity | 94 | fieldSection + column + recordDetailPanelMobile；Dynamic Forms desktop 候选 |
| SHRN_Lead_Record_Page | Lead | 50 | 同上 |
| WRN_Opportunity_Record_Type | Opportunity | 56 | 同上 |

有 Field Sections 且有 `force:recordDetailPanelMobile` 并不证明 MIXED；后者可能是移动端
fallback。本次没有同时使用 desktop `force:detailPanel` 和 Field Sections 的真实样本。
MIXED = NOT AVAILABLE in this corpus；98% detection gate = NOT TESTED。
页面上的任意 LWC（如 OA viewer）也不等于 Custom New override。

## Q6 — Page Layout identity：PASS（所测 Quote__c cases）

不需每次读取整个 Profile：保留现有 USER Create Defaults 返回的 `layout.id`，再用
DIAGNOSTIC Tooling `SELECT Id, Name, TableEnumOrId FROM Layout WHERE Id = '<id>' LIMIT 1`
可得到可靠显示名称。6/6 返回 exact ID match：

- USER_1 Master → EASO报价单页面；FRN → FRN报价单页面。
- USER_2、USER_3 Master → EASO报价单页面；CBU/FMRN → CBU/FMRN报价单页面。

独立 Profile Metadata 提供 `Quote__c-FRN报价单页面`、
`Quote__c-CBU%2FFMRN报价单页面` 等 fullName。不要从展示名称猜 fullName/编码。
如果只有 UI API ID，可审计真实 ID，fullName 留空；不允许伪造。
最初用 `TableEnumOrId='Quote__c'` 查询返回0，不能解释为没有 Layout；按真实 layout.id
定向查询成功，避免自定义对象 TableEnumOrId 编码差异。

## Q7 — Dynamic Forms shape：PARTIAL（结构 PASS；运行语义未验证）

SDK 将 XML 转为对象；真实单项常为 object、多项为 array，开发 parser 必须接受这种
实际 shape，不能假定全部是数组。未写 production parser。

```text
flexiPageRegions[name,type=Region|Facet].itemInstances
  componentInstance.componentName = flexipage:fieldSection
    componentInstanceProperties: columns -> Facet-<id>; label -> label
  referenced Facet -> flexipage:column
    componentInstanceProperties: body -> Facet-<id>
  referenced Facet -> fieldInstance
    fieldItem = Record.Name
    identifier = RecordNameField
    fieldInstanceProperties = {name: uiBehavior, value: required}
```

三种 uiBehavior 均实见：`required` / `readonly` / `none`。顺序必须从 root Region、
tab/body/section/column 的引用及 item 顺序恢复；不能按 region 数组平铺当作 UI order。
同字段多实例需先逐实例求值再聚合，不能未求值就去重。

真实 field visibility：

- SHRN Lead 有1个 field criterion：`{!Record.Is_cooperative_disk__c}`，EQUAL，
  rightValue 是 Boolean 文本类型；存档 literal 做脱敏，类型另行记录。
- WRN Opportunity 有3个 field criteria：`{!Record.OA_Process_Id__c}` NE（rightValue
  缺省）；两处 `{!Record.No_Existing_productline__c}` EQUAL Boolean 文本。
- FlexiPage151 无 field visibility rule；三页均未发现 fieldSection 自身 visibility rule。

其他组件真实出现 `booleanFilter = "1 OR 2 OR 3"`、`"1 AND 2 AND 3"`、
`"(1 OR 2) AND 3 AND 4"`，criteria object/array；operator 包括 EQUAL、NE、LE、
CONTAINS；rightValue 缺省也实见。Quote 页 richText 使用
`{!$User.LanguageLocaleKey}` 与 zh_CN，说明存在 USER 条件，但不是 Field Section
规则样本。RecordType relationship 和业务 relationship 路径也存在，不能当作本对象
普通 draft 字段。Profile/Permission/FormFactor criterion 未在所读 field/section 中找到。

这些结构不能证明缺省 rightValue、null、未提供 draft、关系字段以及 CREATE 容器规则
的全部语义。官方说明 Field 与 Section 的动态求值时机不同，隐藏 Tab 也会影响 CREATE。
必须用真实 New ground truth 验证再支持；未支持的 criterion UNKNOWN，缺失可解释的
draft 依赖 PENDING。不得让普通 Agent 解释原始规则或使用脱敏 literal 做真实求值。

## Q8 — Same object / RT / different USER：NOT AVAILABLE

`GOLDEN_CASE_NOT_AVAILABLE`，限本次所测试身份，不是声称全 org 不存在。
USER_1 的 available Opportunity RT 为 Master + FRN，USER_2/3 为 Master + CBU/FMRN；
共同 available 的 Master 未观察到不同 Dynamic Forms assignment。USER_2 与 USER_3
同 Profile；不能把不同 RT 的 FRN/CBU 对比冒充 mandatory same-RT case。
配置中的 Admin 指定项也不能拿 DIAGNOSTIC 充当第二个业务 USER。

后续最小 Golden 需要两个已授权 USER/Profile、同一对象和双方 available 的同一 RT、
明确相同 App/form factor/New 入口，其中一名匹配 DF Page，另一名匹配 Layout 或另一
Lightning Page；独立记录两人的 New 字段、required、visibility。另需 field draft 变化、
hidden required、真实 MIXED 和受支持条件的固定对照。优先使用已有测试配置；若不存在，
由 Maintainer 在受控测试环境提供。本轮不修改生产 Salesforce 配置。

## Q9 — Custom New Override：PARTIAL

所读三个 CustomObject 的 New action，在无 formFactor、Large、Small 均为 `Default`。
这些对象没有观察到正例 New override；`Default` 也不证明使用 Page Layout，因为 View
激活的 Dynamic Forms 仍可能控制 New。

Metadata `actionOverrides` 提供 actionName/type/content/formFactor，能支持保守的
非标准 New detection；非 Default/无法解释 type 应报 CUSTOM_OVERRIDE/UNKNOWN，不解析
组件。LWC 包装在 Aura 等入口内也只报告外层 override 与证据限制，不宣称解析 LWC。
LWC/Aura/VF/other 正例均 NOT AVAILABLE，不能把 negative-only 检查记为100%识别率。

## API Evidence / performance（Q10：PASS，有限样本）

调用面：JWT/Connection initialization；REST identity；SOAP Partner getUserInfo；
REST SOQL User、PermissionSetAssignment；UI API ObjectInfo、Create Defaults、Apps；
Metadata list/read 的 CustomObject、CustomApplication、FlexiPage、Profile；Tooling Layout、
FlexiPage。没有 DML、Metadata deployment、配置修改或任意 Apex 执行。

第二次完整 discovery：106 logical operations，118 P7 HTTP attempts，94 PASS、12拒绝，
SDK JSON 共20,526,001 bytes，逐调用 elapsed 总和196,311ms。包含认证和现有大 UI API
响应，不能作为“单次新增 Resolver 请求”的成本。第一个 exploratory run 的 Query thenable
离开 ALS 后才执行，故其 Query HTTP count 缺失；已修复为 scope 内 await，**该旧计数未用于
这里的汇总**。最终命令同时保留修复。

| 读取组 | calls | SDK JSON bytes | elapsed 合计 |
| --- | ---: | ---: | ---: |
| CustomApplication（一次性目录调查） | 35 | 1,849,306 | 128,487ms |
| 六个相关 FlexiPage | 6 | 142,592 | 11,061ms |
| 三个 Profile | 3 | 2,346,863 | 25,385ms |
| 三个 CustomObject | 3 | 1,769,317 | 10,349ms |

成本定向复测分两批，各3次，同一 Metadata Connection 批内复用，仅为测量；不是生产缓存。

| readMetadata target | n | JSON bytes | XML response body bytes | min / median / max latency |
| --- | ---: | ---: | ---: | --- |
| Quote_Record_Page | 6 | 28,148 | 44,037 | 878 / 1,167 / 3,122ms |
| FlexiPage151 | 6 | 37,949 | 57,231 | 1,694 / 3,186 / 4,848ms |
| FRN_CRM_PC assignment-containing payload | 6 | 87,784 | 133,436 | 2,808 / 3,569 / 12,728ms |

最大单次 App read 在完整调查中为17,822ms；Profile 可达13,716ms。
XML bytes 来自既有 P7 payload **metadata.originalSizeBytes**，没有输出 payload body。
Content-Length 在这些响应上是 null：以上不是压缩网络传输量。原始 FlexiPage 文件大小
未做 ZIP retrieve，表中是包含 SOAP envelope 的完整响应 body，并明确区分 SDK JSON。

JSON.parse 10次均值作为已解码结构的解析成本参考：Quote 0.116–0.244ms、FlexiPage151
0.210–0.417ms、FRN App 0.215–0.533ms。它**不是**XML decode或未来 resolver parse time；
后两者未独立测量，已包含于 elapsed。无并发生产负载/p95/p99 SLA证明，不把6次当大样本。

### Storage Recommendation

**LIGHTWEIGHT_SNAPSHOT_RECOMMENDED（后续评估建议，当前实现0）**。
理由是实际高延迟与抖动，尤其缺 App 时 discovery 成本；不是因为 Metadata 功能越多越好。
先用 USER Apps、SOAP ProfileId、现有 Layout ID 和 bounded relevant reads 缩小成本。
若仍不能满足后续响应预算，只考虑 touched pages/assignments 的 normalized current
snapshot，bounded refresh、version/hash、默认无历史、不存 raw XML、不全 org 同步。
当前没有持久化实现、表、缓存或 refresh job；成本优化不能替代准确性证据。

## Architectural Recommendations / baseline amendments

1. 用 SOAP getUserInfo 和 USER UI API Apps 避免 Profile/Permission access replica；
   Amendment 001/002 已写入同一永久 baseline。
2. 优先官方 SDK `connection.metadata.read` 的小范围配置读取。官方 retrieve Tool 要
   DX工作区/CWD guard且会落文件；此处 direct SDK 已实测，概念和成本更小。未来由 Host
   composition 提供配置事实，保持 USER evaluation与独立 DIAGNOSTIC provenance。
3. Page Layout executor保持物理旁路；Layout audit display 优先用既有 layout.id 做
   小查询，不为展示 label 拉整个 Profile。旧 P8 输出中的非Layout createable fields也原样保留。
4. 不从组件存在判定 MIXED，不从 View activation假定任意CREATE入口，不把 section和field
   放入相同 draft evaluator。Amendment 003保留这三项未验证语义。
5. SHADOW不能只 catch error：必须有独立截止/资源边界，不能因同一个工具timeout或
   cleanup race破坏主请求。具体生产方案留给A-02，当前没有实现后台任务/queue/framework。

## Final gate / blockers

**COMPLETE — BLOCKED**。本轮所有问题都有证据结论，未通过的不是省略项：

- 核心：Q3实际 activation precedence 与 CREATE entry适用性缺独立真实New UI核对。
- Q4实际存在多App候选，尚无可声称当前请求有效App的证据；显式App方案可控但未实施。
- Q5 mobile fallback/MIXED、Q7 section/container semantics与USER权限条件没有生产准确率证据。
- Q8 mandatory同对象同RT不同业务USER正例不可用；普通目标模型benchmark未开始。

任何一项不能用“配置应该如此”、默认App、DIAGNOSTIC字段权限或高能力开发模型代替。
不请求修改non-negotiables，也没有 `REQUIRES_MAINTAINER_DECISION` 的破界提案。
解除阻断需补A-01证据；本轮停止。下一计划任务仍是A-02，当前不可进入。

## Tests / Git diff review

| Check | Actual result |
| --- | --- |
| ai:snapshot | PASS，source SHA/20 workspaces/011 migration/既有 Tool inventory |
| ai:doctor | FAIL：Windows子进程Yarn检测不可用；直接Node执行确认DB、MCP/Admin服务均PASS；未修改该无关问题 |
| node --check scripts/p8-04a-feasibility.mjs | PASS |
| 真实SFoA只读 probes | PASS（采集）；各API拒绝/缺证项按上文PARTIAL/BLOCKED，不是准确率通过 |
| Context Provider lint（tsc --noEmit）、build、test | PASS；29/29（含现有CREATE/RT/default/picklist回归） |
| MCP Server build + managed-dml-fields/managed-action-context tests | PASS；45/45 |
| Identity Runtime build + lazy connection tests | PASS；5/5 |
| skill:sync / skill:check / skill:test | PASS；12/12 |
| skill:delivery / git diff --check / secret scan | PASS；4个新增/核心artifact扫描及JSON provenance/count/ID-match断言通过 |
| 全仓lint/test/build、真实CREATE、普通Agent benchmark、完整UI准确率 | NOT RUN；本轮没有生产package改动或DML授权，准确率不预报PASS |

所有 `packages/**` 相对P8_04_BASE_SHA的diff为空。不存在生产get_record_action_context
行为变更、新业务Tool/registry/governance、Playbook变更、DML/identity变更、Audit schema重构、
DB migration、Metadata repository。字段主链路与managed fallback代码均未触碰。

```text
get_record_action_context production behavior changed = NO
managed-platform-user-lookup-fallback = untouched / behavior preserved
Managed Lookup Fallback Impact = NO REGRESSION (45 focused tests + empty package diff)
New DB tables = 0
Metadata persisted = 0 runtime snapshots (Git contains sanitized evidence excerpts only)
New MCP Agent Tools = 0
New production providers = 0
```

## Official references（辅助，不作为SFoA现场准确率证明）

- [Dynamic Forms considerations](https://help.salesforce.com/s/articleView?id=sf.dynamic_forms_considerations.htm&language=en_US&type=5)：CREATE字段来源、Field/Section不同求值时机及移动端限制。
- [Visibility rules](https://help.salesforce.com/s/articleView?id=platform.lightning_page_components_visibility.htm&language=en_US)：隐藏UI required与API required、field/section行为。
- [Required and Read-Only](https://help.salesforce.com/s/articleView?id=platform.dynamic_forms_req_fields.htm&language=en_US&type=5)：API universally required不能被隐藏削弱。
- [New from Lookup limitations](https://help.salesforce.com/s/articleView?id=002330981&language=en_US&type=1)：不同创建action并非相同页面语义。
- [Mixed components issue](https://help.salesforce.com/s/articleView?id=000395970&language=en_US&type=1)：Field Sections/Record Detail并存的CREATE差异。
- [Salesforce-maintained Get Apps request](https://www.postman.com/salesforce-developers/salesforce-developers/request/zxgq2qn/get-apps)：formFactor参数；本次有独立live验证。

Firecrawl已安装但search返回404；改用官方网页搜索。Metadata developer网页仅返回空壳，
没有用未读正文证明assignment precedence。SDK源码与本次真实API响应才是结构证据。

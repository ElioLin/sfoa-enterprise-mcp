# P8-04A-01 HOTFIX01 — Ground Truth, Golden Case & Evidence Hygiene

2026-09-06（Asia/Shanghai）。**COMPLETE — BLOCKED**。A-02 未开始。
本报告替代 HEAD 的旧公开详细摘录；原 A-01 测量结论保留，名称使用本版 alias。
配置可读、测试通过、人工步骤齐备都不能代替实际 CREATE/New ground truth。

## Git / scope

- 工作分支：`feature/p8-04-effective-ui-context`；开始时工作区干净。
- Baseline：`2673cea`；A-01 / HOTFIX 输入 SHA：`8279d21`。
- HOTFIX implementation/evidence commit：`8175a990c90af0da1857cc73ddf46e886d359189`。
- 最终交付 SHA：包含本报告的 HOTFIX commit（`git log -1 --format=%H`）。
- 未 checkout 其他分支、从 main 开分支、merge/rebase、rewrite history、force push。
- 只改文档和 dev-only probes / offline evidence checks；`packages/**` diff = 0。

## Blocker closure matrix

| Evidence blocker | HOTFIX result | 剩余条件 |
| --- | --- | --- |
| Q1 request USER Profile | PASS：4/4 SOAP userId/ProfileId 与 DIAGNOSTIC candidate mapping 相符 | DIAGNOSTIC 仅发现候选，不是 USER FLS/runtime authority |
| Q2 assignment configuration | 相关读取PASS；整体PARTIAL | 没有获得直接返回有效 New FlexiPage 的已验证 API |
| Q3 New precedence / View → New | PARTIAL configuration；核心 BLOCKED | 0 个独立 New UI case，不能输出 RESOLVED Active CREATE Page |
| Q4 missing App | Contract CLOSED：APP_CONTEXT_REQUIRED | 实现留给 A-02/A-03；实际 New convergence 未证实 |
| Q5 PL / DF New positive | 两个capture candidates；NOT TESTED | 各需可信 New-entry observation |
| Q5 desktop MIXED | NOT TESTED | 无真实 desktop detailPanel + fieldSection 正例 |
| Q6 Layout identity | PASS：原A-01及最终targeted各6/6 exact ID match | Layout identity 不等于有效 FlexiPage |
| Q7 visibility | field shape PARTIAL；section NOT TESTED | 缺 New draft / hidden-required / container ground truth |
| Q8 same RT / different USER Golden | GOLDEN_CASE_NOT_AVAILABLE | 全route Profile inventory已扩大；所选USER仍无合格pair |
| Q9 Custom New override | PARTIAL / positive NOT AVAILABLE | 3对象New均Default；LWC/Aura/VF正例未获得 |
| Q10 cost / storage | 有限测量PASS；recommendation only | A-03 correctness优先，B-04再决定存储 |
| Public evidence hygiene | CLOSED at HEAD | 详细证据只在ignored `.temp/`；历史不重写 |

## Method / bounded discovery

SFoA API 67.0；现有 `@salesforce/core` 8.29.0 / JSforce、JWT factory、route constructor、
MySQL READ ONLY helper、P7 in-memory observer。Node 24.13.0 / Windows / Yarn 1.22.22。
不读取USER_BOUND credential，不重放Buntu，不写Runtime Audit DB，不存Connection/AuthInfo、
SDK error原文、headers、token或业务记录值。SOAP POST是读取，不是DML。

1. DB读取全部enabled routes，500+1 sentinel：**6条 / 6名distinct USER**。
2. 一条DIAGNOSTIC User query（100 username/batch，101 sentinel）映射 **6/6 USER、4个Profile**；
   0 unmatched / truncated。username、route reference只进入本地private capture key，不进入Git。
3. 复用原A-01的35 App assignment投影（时间戳+SHA-256），15个App含相关Profile配置。
   首次在8 App重读上限前主动停止，只用4 HTTP；随后先join种子，再重读实际相关App，未读15份正文。
4. 每Profile选1个active route：`USER_6/PROFILE_1`、`USER_2/PROFILE_2`、`USER_4/PROFILE_3`、
   `USER_1/PROFILE_4`。**4个USER Connection**；各SOAP、Apps、3个ObjectInfo、每对象最多2个
   create-defaults。读到的全部available RT参加ID join，不仅前2个defaults。
5. DIAGNOSTIC RecordType ID→DeveloperName映射完整。复读3对象、5 App、3页面。
   **27个configuration pair rows**（不是27个distinct user pair）；sameAvailableRt=0、
   sameAccessibleApp=0、两者同时成立=0。非默认RT在已验证Profile组间不共享；共同标准默认RT
   未发现区分Profile的page assignment。不同RT或DIAGNOSTIC身份没有冒充Golden。
6. App ID follow-up只对USER_1，两次各1个USER Connection；第二次复读2个已关联App。
   candidate + App follow-up合计 **6个USER Connections / 4名distinct USER**。
   两次targeted回归另开3+3个USER Connections，分别报告成本。

Profile route分布1/3/1/1。同Profile另外两名USER未建立Connection；其权限集/App/RT可能不同，
不能将代表USER的全部访问能力外推给他们。后续目录再读到35个App，但没有重读全部assignment。
本结论限3对象、已冻结种子和已验证代表，**不是证明整个org或全部route不存在Golden**。

## Golden / actual New ground truth

当前工具清单没有浏览器控制工具；本机Chrome没有remote debugging port/pipe，9222/9223无监听。
没有发现本任务可用的既有New capture/recording。未读取浏览器cookie/profile或把API token放入
浏览器登录URL。API JWT可用不等于可观察UI。

| Case | Explicit candidate | Configuration expectation | Independent New observation |
| --- | --- | --- | --- |
| A_PL | USER_1 / PROFILE_4 / OBJECT_1 / RT_17 / APP_7 / Large | PAGE_LAYOUT；PAGE_LAYOUT_3；OBJECT_DEFAULT | NOT TESTED |
| B_DF | USER_1 / PROFILE_4 / OBJECT_3 / RT_19 / APP_7 / Large | DYNAMIC_FORMS；PAGE_DYNAMIC_1；APP_PROFILE_RT | NOT TESTED |
| Mandatory pair | 同object + available RT + App + Large，不同USER/Profile | GOLDEN_CASE_NOT_AVAILABLE | NOT TESTED |

**EXPECTED CANDIDATE — NOT YET GROUND TRUTH**。A/B不同对象，不能满足mandatory pair。
expectedFormSource、expectedPage、visibleFieldsHash、requiredFieldsHash、fieldCount、requiredCount
都保留null；Metadata的94个field instances不是New fieldCount。
[Golden capture](P8-04A-01-GOLDEN-CAPTURE.md)提供具体本地selector及MINIMAL_TEST_ORG_PREPARATION。

## App context product conclusion

**APP_CONTEXT_REQUIRED**：USER_1 / OBJECT_3 / RT_19 / Large，APP_7候选PAGE_DYNAMIC_1
（APP_PROFILE_RT）；另一可访问APP_36候选PAGE_LAYOUT_2（OBJECT_DEFAULT，无相关App override）。
这是两个真实配置候选，`observedEffectiveNewUi=false`。

USER UI appId = AppDefinition.DurableId（2/2），developerName一致（2/2）；用返回的NamespacePrefix
及DeveloperName定位Metadata目录的唯一qualified fullName，再readMetadata回证fullName（2/2）。
不同UI/Metadata alias见fixture.appIdJoin。**Metadata目录ID与UI appId不相等**，不可直接连接；
没有硬猜标准App前缀，也不以label猜权限。

小犇/Dify和WorkBuddy当前不传Salesforce App；不能唯一选择以上候选。
不得默认业务App、Sales、last-selected/default App；不能因导航栏没有对象就排除直接New入口。
本轮没有case可宣布APP_CONTEXT_NOT_REQUIRED_FOR_THIS_CASE：须先验证完整适用App集合、New入口、
precedence并确认所有有效页面收敛。未知/不完整→UNRESOLVED；不同候选要求App；不能猜成PAGE_LAYOUT。

未来最小contract（Baseline Amendment 005，仅设计）：`integrationDefaultSalesforceAppDeveloperName`，
可信integration/client scoped显式配置，仅缺请求App时使用；不是所有USER共用全局默认。
必须在当前USER `/ui-api/apps?formFactor=Large` 验证：不存在→APP_CONTEXT_INVALID，冲突/多义→
AMBIGUOUS，API/映射不完整→UNRESOLVED；无silent fallback。可信显式请求App优先；多个显式来源
冲突时不猜。A-02/A-03决定持久化位置，本轮0实现、0migration。

## Precedence / Q5–Q9 retained findings

`App + Profile + RT > App default > Object/org default > standard default`仍是配置候选顺序。
USER identity、RT availability、App access、Layout ID可作为已验证事实；assignment只能标记
CONFIGURATION_CANDIDATE。**当前没有一层可宣称RESOLVED Active New Page**；View→New、App default、
standard fallback、冲突、入口差异仍UNKNOWN/UNRESOLVED。未仅凭官方文档给现场PASS。

原六页：3个force:detailPanel Layout候选；3个DF候选含94/50/56字段实例。SDK单项object、多项array；
Region/Facet→fieldSection→column→fieldInstance须按引用恢复顺序/section，不可平铺或先去重。
uiBehavior实见required/readonly/none。4个field criterion保留operator和literal kind；其他组件
曾出现EQUAL/NE/LE/CONTAINS、AND/OR、缺省rightValue、USER及relationship路径；并非已验证CREATE
求值语义。unsupported=UNKNOWN，缺draft依赖=PENDING。未见fieldSection visibility正例。

Amendment 003保留：force:recordDetailPanelMobile + fieldSection不能证明desktop MIXED；没有真实
desktop force:detailPanel + fieldSection正例，gate=NOT TESTED。3对象New（unspecified/Large/Small）
均Default；任意页面LWC不是Custom New override。正例PARTIAL / NOT AVAILABLE，不开发custom UI parser。
API universally-required、USER FLS、managed policy保持独立权威。

## API cost / storage

P7 HTTP attempts含认证/SDK内部请求，logical operation不是wire count；JSON bytes不是压缩流量。
这些是dev调查成本，不是单次未来Resolver成本。

| HOTFIX run | Logical | HTTP attempts | USER Connections | Elapsed |
| --- | ---: | ---: | ---: | --- |
| inventory bound stop | 2 | 4 | 0 | wall 1,988ms |
| bounded discovery | 62 | 74 | 4 | wall 95,069ms；calls 94,536ms |
| targeted初测 | 58 | 70 | 3 | calls 48,135ms |
| targeted去除源码业务名称后复测 | 58 | 70 | 3 | calls 65,489ms |
| App ID join初探 | 5 | 9 | 1 | wall 3,168ms |
| App join及Metadata复读 | 7 | 11 | 1 | wall 5,977ms |
| HOTFIX合计 | 192 | 238 | 12（4名distinct USER） | calls 217,980ms；不是并行wall总时长 |

另有6个DIAGNOSTIC Connections。candidate+App部分76 logical / 98 HTTP / 6 USER Connections；
targeted部分116 logical / 140 HTTP / 6 USER Connections。discovery 62/62 PASS；targeted各46 PASS、
12既有权限负例。原A-01的106 logical /118 HTTP /20,526,001 JSON bytes /196,311ms属历史，不计HOTFIX。

| 最终targeted（每目标3次） | SDK JSON bytes | SOAP body bytes | min / median / max ms |
| --- | ---: | ---: | --- |
| PAGE_LAYOUT_3 | 28,148 | 44,037 | 887 / 924 / 2,291 |
| PAGE_DYNAMIC_1 | 37,949 | 57,231 | 1,340 / 1,742 / 1,818 |
| APP_7 | 87,784 | 133,436 | 10,667 / 12,065 / 12,143 |

SOAP body含envelope；Content-Length缺失；没有p95/p99或生产并发SLA证明。
**LIGHTWEIGHT_SNAPSHOT_RECOMMENDED**，不是IMPLEMENT NOW；A-03 active-page correctness优先。

| 层次 | Contract |
| --- | --- |
| Dev Evidence | `.temp/*.json` temporary / ignored / development only；详细证据和private alias/capture key |
| Git Golden Fixture | small / aliased / sanitized / versioned；本版结构及negative-gate fixture，0个truth-labelled New cases，可离线检查 |
| Future Runtime UI Snapshot | 仅B-04证明确需时normalized current-only runtime storage；不用Git JSON；MySQL或现有store由latency、multi-process、invalidation、deployment model决定 |

0DB/metadata snapshot/cache/refresh framework；dev evidence不是未来schema。

## Evidence hygiene / reproducibility

[Git summary](evidence/p8-04a-01-2026-09-06.json)从153,748 bytes缩至23,019 bytes；只留技术结构、
assignment shape、operator/criterion kind、counts/bytes/latency/hash、状态和ID-match boolean。
真实Profile/App/Page/RT/business field名称、身份ID、username不发布；已存在历史不rewrite/force push，
不声称已从public历史清除。

本地保留`.temp/p8-04a-aliases.json`、`p8-04a-capture-key.json`及source files。
evidenceHash=对应原文件bytes的SHA-256；alias新增追加，不重新编号已有项。allowlist projector不会
把整份dump换名后发布。命令：

```text
node --check scripts/p8-04a-feasibility.mjs
node scripts/p8-04a-feasibility.mjs --targeted
node scripts/p8-04a-candidates.mjs
node scripts/p8-04a-app-join.mjs
node scripts/p8-04a-evidence-summary.mjs
node scripts/p8-04a-evidence-check.mjs
```

targeted真实targets从ignored初始discovery读取；无seed时先运行无参数原probe。
projector还依赖fixture.sources列出的本轮初探/首次复测文件；重新采集会有新hash，不冒充历史证据。
fresh clone可离线fixture check，无需live凭据；原始hash及本地敏感名称检查用`--local`。

## Tests / invariant

| Check | Actual result |
| --- | --- |
| 所有A-01 dev script syntax | PASS |
| targeted SFoA probes | PASS collection；两次各46 PASS /12既有权限负例 |
| Context Provider lint / build / test | PASS，29/29 |
| MCP Server build + managed-action-context / managed-dml-fields | PASS，45/45 |
| Identity Runtime build + lazy-connection-resource | PASS，5/5 |
| skill sync / check / test / delivery | PASS，12/12；三份生成副本一致且可Git交付 |
| 额外skill:smoke（committed 8175a99） | FAIL：干净归档skill:test为11/12；其他smoke gates通过；原8279d21归档复现同一失败 |
| git diff --check / secret & evidence hygiene | PASS；16个交付文件，7份local source SHA-256核验，0个truth-labelled New case |
| ai:snapshot | PASS；指定分支/20 workspaces/011 migration |
| ai:doctor / ai:db | Yarn子进程Access denied旧问题；直接Node确认DB及MCP/Admin服务PASS；未改无关工具 |
| New UI / target Agent benchmark / CREATE | NOT TESTED / NOT RUN；0次Save/Create |

干净归档失败位于既有 `skills/sfoa-mcp-maintainer/scripts/toolkit.test.mjs:106`：
未构建Playbook时Doctor返回SKIPPED但没有problems数组，测试仍断言Array.isArray(problems)。
本HOTFIX没有更改该测试/Doctor/smoke runner；对8279d21执行git archive后同名focused test复现。
这是额外smoke的已确认baseline失败，不能报告全绿，也不作为本任务扩展去修改无关工具。
本地完整skill:test 12/12与干净归档11/12分别保留，日志仅在ignored `.temp/`。

get_record_action_context behavior changed=NO；create_record changed=NO；Playbook changed=NO；
DML changed=NO；Identity behavior changed=NO；Audit schema changed=NO；DB migrations=0；
new MCP business Tool=0；packages/** production diff=0。

**COMPLETE — BLOCKED**。仍缺独立New precedence、可信PL/DF New cases及mandatory same-RT
different-USER Golden。不降低原gate，不进入A-02，完成后停止。

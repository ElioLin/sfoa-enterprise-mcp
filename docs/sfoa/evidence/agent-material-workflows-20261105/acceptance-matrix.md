# 材料工作流：28 场景分层验收矩阵

业务指导候选：`94aa6612c72a8ba0d8a6fff3ad3548cf67a5d2a9` / Playbook `1.13.2`。最终运行代码与 Skill 检查提交：`7fdbaf308cd7e7062878d910f765316f27b6a81a`。DML 长文本新增测试提交：`7833b93`。

**整体业务验收：PARTIAL。** 以下表格覆盖任务书 §9.2 全部 28 项；每项按实际证据分层，确定性测试、指导文字、真实模型、原件读取、企微入口和真实 Salesforce 结果互不替代。

最新真实模型指导对照使用冻结旧 Provider 与合成 Salesforce SDK：复用已独立审阅的 baseline 15/18，候选 18/18（六类各 3/3）；42 + 42 实际模型 run、21 + 21 精确原始 TXT/CSV 读取。候选预定义相关选填槽位 48/48 语义正确，同时保留 29 次查询错误。它不是全部后台版本、自动 Adapter 链路或真实 Salesforce 的业务验收。

**所有 28 项均无真实企微入口通过证据。** 真实 Salesforce CREATE 尝试明确失败，没有成功记录 ID、UPDATE 或原件发布/读回。表中的模型 PASS 仅适用于对应隔离样例；六个补充边界每项仅一次，不构成稳定率。

最终 Linux clean Skill smoke：精确提交 `7fdbaf3`，由 committed bundle 独立 clone，六门禁全部 PASS、80/80 测试 PASS；未加载 `.env.local`，DB/services 均 SKIPPED。Windows 环境失败、早期 Linux 错误 Yarn 路径 exit 127 和先前通过记录均保留。

| 历史模型矩阵 | baseline | candidate | 范围与保留问题 |
| --- | --- | --- | --- |
| 首轮 c02c392 | 12/18 PASS | 14 PASS / 3 FAIL / 1 NOT_VERIFIED | 旧 fixture 字段、空值、范围谓词缺陷保留，不能据此声称修复后的稳定率 |
| 修复 fixture 后 d57f110 | 15/18 PASS | 17/18 PASS | 候选一次无依据写“客户送样”保留 FAIL；baseline 未授权归档 0/3 |
| 最新 94aa661 / 1.13.2 | 复用 d57 已审阅 15/18 | 18/18 PASS | 六核心各 3/3；42 actual runs / 18 sessions；旧 Provider 不透传新增 retryable，恢复仅证明该隔离指导情形 |

引用 AT/AR/AB、CA/HC、DE/DC/DB、UP/MY/ID/DG 指向下方确定性测试目录。GP/GS 为指导文字检查，GO 为开发用 oracle，HF 为 harness fixture，均不证明 Agent 自主行为。M/P/S/B 引用见后方证据目录。`PARTIAL` 表示只覆盖指定子边界，`NOT_TESTED*` 表示未执行该类验证。

| # | 任务书场景 | 确定性行为 | 指导 / fixture | 真实模型 | 真实原件 / 材料 | 尚缺边界 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 纯文字资料已充分 | `PARTIAL` · DE2<br>Exact payload execution only; not Agent inference | `PASS` · GP1, GS4 | `PASS_SINGLE_ISOLATED_PROBE` · B2, M4<br>Provided transcript text supports complete synthetic CREATE; this is one pure-text boundary case plus related material journeys | `NOT_APPLICABLE` | 纯文字转写单例已通过；其他文字业务及真实 Salesforce 落库不由该单例保证。 |
| 2 | 文字+PDF+图片+录音各有独有信息 | `PARTIAL` · AR1, AR6, AB1 | `PASS` · GP1 | `PASS_SINGLE_ISOLATED_PROBE` · M2 | `PARTIAL` · P1, M2<br>Actual originals read and unique facts used; audio reused actual ASR, Office explicitly injected | 原生读取状态回写、自动 hook 到模型及真实渠道到 Salesforce 的完整链路未证实。 |
| 3 | 分多条发送材料后统一创建 | `PASS_FOR_HOST_STATE` · AT1, AB1 | `PASS` · GP1 | `PASS_REPEATED_GUIDANCE_SCOPE` · M3, M4<br>Latest 1.13.2 corresponding core journey 3/3; fixed old Provider and synthetic SDK only; previous failures retained | `PARTIAL` · P1, M2 | 隔离重复多轮已通过；真人渠道到 Salesforce 的完整链路未通过。 |
| 4 | 事前申请与事后纪要 | `NOT_TESTED_FOR_AGENT_SEMANTICS` | `PASS` · GP1 | `PASS_REPEATED_GUIDANCE_SCOPE` · M3, M4<br>Latest 1.13.2 corresponding core journey 3/3; fixed old Provider and synthetic SDK only; previous failures retained | `PARTIAL` · P1, M2 | 合成对象/Record Type 选择不证明真实组织中的对象、类型和写入正确。 |
| 5 | 正文相同段落涉及不同业务含义 | `NOT_TESTED_FOR_AGENT_SEMANTICS` | `PASS` · GP1 | `PARTIAL` · M2, M3, M4<br>Latest candidate 48/48 expected optional field writes semantically correct; d57 invented sample actor remains a preserved failure; not an exhaustive same-paragraph ambiguity suite | `PARTIAL` · M2 | 同段多义、字段长度压缩和避免重复复制仍需专项观察。 |
| 6 | 材料冲突与明确更正 | `PARTIAL` · AT2, AT5<br>Versions and proven target state only | `PASS` · GP1, GS2 | `PARTIAL` · M4, B3<br>Repeated existing-target date correction and single ambiguous acknowledgement passed; unresolved contradictory source precedence not exhaustively covered | `NOT_TESTED_FOR_CONFLICT_RESOLUTION` | 一字回复多个待决选择已有单次通过；跨材料冲突及版本优先仍未穷举。 |
| 7 | 相对时间与旧录音 | `NOT_TESTED_FOR_AGENT_SEMANTICS` | `PARTIAL` · GP1, HF1<br>Guidance and synthetic ISO query comparisons do not prove old-audio date anchoring | `PASS_SINGLE_TRANSCRIPT_BOUNDARY` · B4<br>Old event date anchors next week in actual read transcription; no invented exact day or current-date anchor | `PARTIAL` · B4, P1<br>Actual old-event TXT native read; no raw old-audio temporal ambiguity probe | 有日期的旧事件转写单例已通过；真实旧音频、ASR 与跨时区相对时间仍缺专项。 |
| 8 | ASR 姓名或数字不清 | `NOT_TESTED` | `PARTIAL` · GP1 | `NOT_TESTED_FOR_AMBIGUOUS_ASR` | `PARTIAL` · P1<br>WAV/m4a ASR works; unclear name/number repair not tested; speaker/timing/confidence unknown | 含不清姓名/数字的录音与可靠旁证组合未测。 |
| 9 | 多个同名客户/责任人 | `PARTIAL` · ID1, AT3<br>Identity cannot be changed by model/body; not selection semantics | `PASS` · GP3, GS1 | `PARTIAL` · B3, M4<br>Two customer candidates remained unresolved after 好; request identity unchanged; same-name owner not separately tested | `NOT_APPLICABLE` | 同名客户歧义单例已通过；真实同名责任人解析及渠道稳定性仍未验收。 |
| 10 | CREATE 查重、重复来访 | `NOT_TESTED_FOR_AGENT_DECISION` | `PASS` · GO3, HF1, HF2 | `PASS_REPEATED_GUIDANCE_SCOPE` · M1, M3, M4<br>First candidate duplicate failure retained; corrected d57 and latest 1.13.2 duplicate journeys each 3/3 | `PARTIAL` · M2 | 同事件选择的隔离重复已通过；真实 Salesforce 事件查重和渠道写入仍未完成。 |
| 11 | 查询零结果、截断、错误 | `PARTIAL` · CA6<br>Context partial facts, not global duplicate uniqueness | `PASS` · GO3, HF2, HF4 | `PARTIAL` · M3, M4, M2<br>Latest candidate preserves 29 query errors while correcting unsupported queries; complete zero-row scopes stay bounded; truncated real duplicate search not verified | `NOT_APPLICABLE` | 真实查重截断或错误情况下的最终业务决定未验收。 |
| 12 | 电话带格式/国际号码/仅区号 | `NOT_TESTED_FOR_PHONE_BUSINESS_BEHAVIOR` | `PASS` · GP2 | `PASS_TWO_SINGLE_PHONE_PROBES` · B5<br>International mobile and formatted landline/extension preserve values; no fabricated company geography or clarification; Context/query remain fixture | `NOT_APPLICABLE` | 两类电话单例已通过；仅区号、真实查重/号码可达及实际 ContextExecutor 未由这两例证明。 |
| 13 | hidden API-required、page-only required、只读/托管 | `PASS_FOR_CONTEXT_FACTS` · CA4, CA5, HC1<br>Real parser path and host facts; no new DML gate | `PASS` · GP1 | `PARTIAL` · M2<br>Assessment PARTIAL before type/COMPLETE after selection; not each hidden-field branch | `NOT_APPLICABLE` | 隐藏/API必填/页面必填各分支尚未逐项在真实 Salesforce 元数据及写入中验收。 |
| 14 | false/0/null/空字符串/属性缺失 | `PASS_FOR_CREATE_FACTS` · CA2, CA3, CA5, HC1 | `PASS` · GO1 | `NOT_TESTED_FOR_ALL_SCALAR_BRANCHES` | `NOT_APPLICABLE` | CREATE 事实计算已证明；UPDATE oracle 仅为开发模型，不是完整真实 Salesforce 标量矩阵。 |
| 15 | UPDATE 已有值、补充/只改某字段 | `PASS_FOR_SUBMITTED_PATCH_AND_TARGET` · DE2, AT5, AT6 | `PASS` · GO2, GS2 | `PASS_REPEATED_GUIDANCE_SCOPE` · M3, M4<br>Latest 1.13.2 corresponding core journey 3/3; fixed old Provider and synthetic SDK only; previous failures retained | `NOT_APPLICABLE` | 未达到真实原记录更新；不声称实现完整 UPDATE Dynamic Forms。 |
| 16 | Context 选项关闭与长文本 DML | `PASS_FOR_CONTEXT_COMPATIBILITY_AND_LONG_DML_DISPATCH` · CA1, CA7, DE4<br>Context off/omitted request counts and 4097-character rejection remain separately proven; direct CREATE Tool accepts 131072 characters and dispatches exact text once with successful record ID | `PASS` · GP1 | `NOT_TESTED_FOR_LONG_DML` | `NOT_APPLICABLE` | 工具入口完整 131072 字符 dispatch 已通过；真实 Salesforce 长字段约束与最终读回仍未执行。 |
| 17 | 任务所需明细/参与人关系 | `PASS_FOR_COMPOUND_MAPPING` · DC1, DC2, AT6 | `PASS` · GP1 | `PARTIAL` · M2<br>Participants written to supplied text field; not related participant record creation | `PARTIAL` · M2 | 真实模型结合组织结构建立参与人关系，以及独立新业务克制，未作专项。 |
| 18 | 多事件/多记录/批量部分结果 | `PASS_FOR_BATCH_COMPOUND_BOUNDARIES` · DC1, DC2, DB1, DB2, AT6 | `PASS` · GP1, GS3 | `PARTIAL` · M2<br>Two events correctly separated by sequential CREATE; not model-driven batch partial failure | `PARTIAL` · M2 | 真实模型 batch/compound 部分结果旅程及 Salesforce 最终状态未测。 |
| 19 | 明确要求原件归档 | `PARTIAL` · UP8, AT5<br>Direct upload path works; consent intent is Agent decision | `PASS` · GP4, HF3 | `PASS_REPEATED_GUIDANCE_SCOPE` · M3, M4<br>Latest 1.13.2 corresponding core journey 3/3; fixed old Provider and synthetic SDK only; previous failures retained | `PARTIAL` · P1<br>Original staging proven, publication not | 真实明确归档的 Salesforce 文件发布尚未完成。 |
| 20 | 未说明/拒绝/选择部分原件 | `PARTIAL` · AT4, AT5<br>Archive state/reset and selected state support, not one-invitation autonomous behavior | `PASS` · GP4 | `PASS_WITH_BOUNDED_SINGLE_AND_REPEATED_EVIDENCE` · M2, M3, M4, B1<br>Latest optional invitation 3/3; explicit decline in mixed case; subset selection one probe only | `PARTIAL` · M2 | 一次邀请与拒绝/部分选择已有对应隔离证据；真实渠道授权续作和部分选择稳定性仍未证明。 |
| 21 | 创建后“好，一并附上” | `PASS_FOR_TARGET_CONTINUITY` · AT1, AT5, AT6, AB4 | `PASS` · GP4 | `PASS_REPEATED_GUIDANCE_SCOPE` · M3, M4, B3<br>Latest 1.13.2 corresponding core journey 3/3; fixed old Provider and synthetic SDK only; previous failures retained | `PARTIAL` · P1 | 归档续作3/3、一字答复多待决项单例已通过；真实成功目标与文件发布仍未连通。 |
| 22 | DOCX/XLSX/CSV 与多页/长材料 | `PASS_FOR_BASIC_READERS_AND_BOUNDS` · AR1, AR2, AR3, AR4, AR5, AT8 | `PASS` · GP1 | `PASS_SINGLE_ISOLATED_PROBE` · M2 | `PARTIAL` · P1, M2<br>Real basic Office and one-page PDFs; known coverage/exclusions preserved | 真实多页长文续读未证明；Office 排除项不在基础读取保证范围。 |
| 23 | 纯上传、仅有转写无原音频 | `PARTIAL` · UP8, AR6, AB1<br>Uploader sends exact originals without parser; parser/ingress failure independent | `PASS` · GP4 | `PASS_SINGLE_TRANSCRIPT_BOUNDARY` · B2<br>No-original-audio reply performs zero Tools/uploads and fabricates no ref; pure-upload-only conversation not separately covered | `PARTIAL` · P1, B2<br>P1 had actual audio originals; B2 used only supplied transcription text and correctly reported the original absent; it is not an audio-read/ASR test | 只有转写时不冒充音频已单次通过；纯上传对话专项及真实发布仍未完成。 |
| 24 | 超限、部分暂存失败、同名不同版本、过期 | `PASS_FOR_HOST_AND_REPOSITORY_BOUNDARIES` · AB2, AT2, AT8, UP10, UP11, MY2, MY3 | `PASS` · GP4 | `NOT_TESTED_FOR_ALL_FAILURE_CLASSES` | `PARTIAL` · P1<br>Nine successful originals and later text retained; not real expired/corrupt-ingress model journey | 宿主失败分支有确定性证明；模型对全部失败类别的正确处理未逐项验证。 |
| 25 | 记录成功、附件部分失败 | `PASS_FOR_UPLOAD_RESULTS_AND_RECOVERY` · UP1, UP7, MY2 | `PASS` · HF3, GS3 | `PASS_REPEATED_GUIDANCE_SCOPE` · M3, M4<br>Latest 1.13.2 corresponding core journey 3/3; fixed old Provider and synthetic SDK only; previous failures retained | `NOT_TESTED_FOR_REAL_PUBLICATION` | 没有真实记录成功后发生 Salesforce 单文件拒绝并受控恢复的证据。 |
| 26 | 明确失败、UNKNOWN、超时、并发提交 | `PASS_FOR_RUNTIME_AND_REAL_REPOSITORY` · UP1, UP2, UP3, UP4, UP5, UP6, MY1, MY2, MY3, MY4, DE3 | `PASS` · GS3, HF3 | `PARTIAL` · M3, M4<br>Repeated explicit rejected-file recovery passed in old-runtime fixture; all UNKNOWN/concurrent model paths not exercised | `NOT_TESTED_FOR_REAL_REMOTE_UNKNOWN` | 未故意制造真实 Salesforce 未知/并发发布；模拟传输与真实 MySQL 证明相应实现边界。 |
| 27 | requester/会话/新任务切换 | `PASS_FOR_HOST_AND_AUTHORIZATION` · AT3, AT4, AT7, AB3, ID1, ID2 | `PASS` · GP1 | `NOT_TESTED_FOR_CROSS_REQUESTER_TASK_SWITCH` | `PARTIAL` · P1<br>One isolated hook task, not cross-user live channel | 真实多用户企微任务切换及重启恢复未执行。 |
| 28 | 旧直接工具、查询、诊断、批量、附件 | `PASS_FOR_REPRESENTATIVE_BOUNDARIES_WITH_AGGREGATE_FAILURE_RETAINED` · DE1, DB1, DB2, ID2, DG1, UP8, UP9 | `PASS` · GP1, GP4 | `PARTIAL` · M3, M4, M2<br>Representative real-model guidance tasks plus actual 1.13.2 discovery; not all enabled Tool executions | `PARTIAL` · P1 | 实际 29 工具和 schema 保留已证明；可见不代表全部可执行；Windows HTTP/P7 聚合失败仍保留。 |

## 六个补充单次边界

统一证据：`.temp/agent-material-workflows/boundary-probes-safe.json`。6 session / 8 actual run，全部原始 capture 哈希保持，以下每项仅执行一次。

| 边界 | 实际结果 | 验证边界 |
| --- | --- | --- |
| 只选部分原件（B1） | PASS：两份 TXT 均实际 read，只上传明确选择的第一份 | 合成目标/上传，不证明真实文件发布 |
| 有转写、无原音频（B2） | PASS：先 CREATE；后续准确说明无原件，零工具/零上传、不编造 ref | 用户提供转写文本，不是 ASR 测试 |
| 歧义后仅答“好”（B3） | PASS：两客户候选和未定日期仍待选择，零 DML/上传 | 单次客户/日期澄清，不含同名负责人 |
| 旧事件“下周”（B4） | PASS：精确读取 519 字节旧日期 TXT，保留人数、价格、否定和相对周，不捏造日或锚定当前月 | 文字转写，非原始旧音频/跨时区验证 |
| 国际手机号（B5） | PASS：`MobilePhone=+44 7700 900123` 原样 dispatch，零地址字段、零提问 | Context/schema/query fixture；实际旧 DMLExecutor + 合成 SDK |
| 固话格式与分机（B5） | PASS：`Phone=0592-8888888转123` 原样 dispatch，零地址字段、零提问 | 同上；不证明真实 SF 查重、电话可达或“仅区号”行为 |

## 测试执行目录

| 套件 | 实际结果 | 日志 |
| --- | --- | --- |
| adapter | 92/92 PASS | `.temp/agent-material-workflows/adapter-final-92.log` |
| context | 237/237 PASS | `.temp/material-workflows/context-assessment-tests.log` |
| host | Relevant managed-context tests passed; aggregate 403/404, unrelated HTTP load 504 retained | `.temp/p8-04-regression/sfoa-mcp-server-test.log` |
| dml | 47/47 PASS; includes Tool schema -> executor -> exact 131072-character mock dispatch | `.temp/agent-material-workflows/dml-long-text-test.log` |
| p3 | 25/25 PASS | `.temp/p8-04-regression/sfoa-mcp-server-p3-test.log` |
| p4 | 16/16 PASS | `.temp/p8-04-regression/sfoa-mcp-server-p4-test.log` |
| attachment | Attachment plus WeCom HTTP 61/61 PASS | `.temp/attachment-lifecycle/server-frozen.log` |
| mysql | 18/18 PASS, actual guarded test database | `.temp/attachment-lifecycle/mysql-frozen.log` |
| playbook | 1.13.2 46/46 PASS; text inspections prove guidance distribution only | `.temp/agent-material-workflows/playbook-1132-test.log` |
| skill | 1.13.2 toolkit 80/80 PASS; exact 7fdbaf3 isolated Linux committed-HEAD smoke 6/6 gates and 80/80 tests PASS; prior d57 smoke and failures preserved | `.temp/agent-material-workflows/skill-1132-test.log` |
| fixture | Fixture query tests passed; synthetic SDK semantics only | `.temp/agent-material-workflows/harness-query-fix-test-final.log` |
| finalCleanSkillSmoke | 7fdbaf308cd7e7062878d910f765316f27b6a81a: 6/6 gates, 80/80 tests PASS; DB/services SKIPPED; no .env.local | `.temp/agent-material-workflows/skill-smoke-linux-7fdbaf3.log` |

## 精确测试映射

以下 68 个引用给出实际 test 文件和测试名。指导断言/fixture 检查均显式列出类型；测试标题本身不代表整个场景已通过。

### AT — RUNTIME_BEHAVIOR

`integrations/openclaw/sfoa-wecom-mcp-adapter/test/material-tasks.test.js`；执行套件：`adapter`。

- **AT1**：`PDF, recording, plain text and confirmation accumulate without extending original expiry`
- **AT2**：`same content resend is one material, same name different bytes retains versions`
- **AT3**：`requester, account and session isolation are host-derived, including shared conversations`
- **AT4**：`new task explicitly selects materials and resets target, questions and rejected archive`
- **AT5**：`actual MCP results bind targets and per-file outcomes, fabricated IDs are not notes`
- **AT6**：`compound child writes and batch results preserve the main task target`
- **AT7**：`host keyed store restores bounded facts on restart and session reset removes them`
- **AT8**：`task capacity and text budgets expose omissions and partial coverage`

### AB — REAL_HOOK_BEHAVIOR_WITH_SYNTHETIC_TRUSTED_CONTEXT

`integrations/openclaw/sfoa-wecom-mcp-adapter/test/bridge.test.js`；执行套件：`adapter`。

- **AB1**：`real CSV body and failed original staging remain independent across text confirmation`
- **AB2**：`eleven originals are all staged and partial failures reach the actual prompt`
- **AB3**：`same-conversation requester switch and missing sender never expose another material`
- **AB4**：`real tool-result hook binds target; local notes and session reset never mutate CRM`

### AR — ACTUAL_LOCAL_BYTES_READER_BEHAVIOR

`integrations/openclaw/sfoa-wecom-mcp-adapter/test/material-reader.test.js`；执行套件：`adapter`。

- **AR1**：`real DOCX basic paragraphs/tables preserve source text and known coverage`
- **AR2**：`real XLSX reads shared/inline/numeric/cached-formula cells and flags missing caches`
- **AR3**：`CSV quoted multiline cells, UTF-8 BOM and exact original hash are read`
- **AR4**：`long tables and bodies are explicitly partial, not reported fully read`
- **AR5**：`corrupt Office, unsupported encoding and missing Python give separate reading failure`
- **AR6**：`native image, PDF and audio remain native and never gain invented read coverage`

### CA — CONTEXT_RUNTIME_BEHAVIOR

`packages/mcp-provider-sfoa-context/src/test/create-value-assessment.test.ts`；执行套件：`context`。

- **CA1**：`value assessment is opt-in and adds no Salesforce reads in OFF`
- **CA2**：`raw default presence survives null/undefined collapse while explicit false/zero/null/empty take precedence`
- **CA3**：`available defaults include false and zero without claiming a write; an oversized default stays UNKNOWN locally`
- **CA4**：`parsed Dynamic Forms distinguish hidden API required, hidden page-only and unresolved conditional requiredness`
- **CA5**：`strict managed policy overrides draft while fallback preserves every present scalar, including explicit empty`
- **CA6**：`missing Record Type returns PARTIAL and unknown defaults without fetching type-dependent APIs`
- **CA7**：`Tool schema and JSON mirror expose only the optional CREATE assessment; UPDATE and long drafts keep their bounds`

### HC — HOST_RUNTIME_BEHAVIOR

`packages/sfoa-mcp-server/src/test/managed-action-context.test.ts`；执行套件：`host`。

- **HC1**：`optional CREATE assessment gains strict/fallback managed facts and keeps one exact final JSON mirror`

### DE — DML_EXECUTOR_BEHAVIOR

`packages/mcp-provider-sfoa-dml/src/test/dml-executor.test.ts`；执行套件：`dml`。

- **DE1**：`explicitly allowed CREATE and UPDATE use the one request-scoped Connection`
- **DE2**：`mutation observer receives the exact submitted fields and Salesforce result record ID`
- **DE3**：`transport and unstructured SDK exceptions produce unknown outcomes without automatic retry`
- **DE4**：`CREATE dispatches all 131072 text characters independently of the smaller Context draft bound`

### DC — COMPOUND_BEHAVIOR

`packages/mcp-provider-sfoa-dml/src/test/compound.test.ts`；执行套件：`dml`。

- **DC1**：`multiple roots correlate child Lookups by explicit references despite different phase ordering`
- **DC2**：`child partial failure preserves root success and reports incomplete intent without rollback`
- **DC3**：`after a partial child batch only the failed item qualifies for re-preparation`

### DB — BATCH_BEHAVIOR

`packages/mcp-provider-sfoa-dml/src/test/batch.test.ts`；执行套件：`dml`。

- **DB1**：`per-item Record Type payload, exact submitted fields and request USER isolation`
- **DB2**：`allOrNone complete rejection and UNKNOWN transport have distinct counts; no retries`

### ID — HTTP_IDENTITY_BEHAVIOR

`packages/sfoa-mcp-server/src/p3-test/dml-http-integration.test.ts`；执行套件：`p3`。

- **ID1**：`forged body identity fields cannot change the authenticated CREATE/UPDATE route`
- **ID2**：`P3 CREATE/UPDATE route A and B independently and never reuse a Connection`

### DG — HTTP_DIAGNOSTIC_BEHAVIOR

`packages/sfoa-mcp-server/src/p4-test/p4-http-integration.test.ts`；执行套件：`p4`。

- **DG1**：`P4 Streamable HTTP keeps USER A/B context isolated and routes only diagnostic Tools to the fixed DIAGNOSTIC identity`

### UP — REAL_DISPATCHER_AND_LOCAL_STAGING_BEHAVIOR_WITH_FAKE_SALESFORCE

`packages/sfoa-mcp-server/src/test/attachment-upload.test.ts`；执行套件：`attachment`。

- **UP1**：`only a proven refusal can reuse the same original ref, with owner and hash rechecked`
- **UP2**：`unknown attempts block replay across uploader instances and retain their fact after byte cleanup`
- **UP3**：`two concurrent calls issue at most one ContentVersion POST for one ref`
- **UP4**：`cancellation after claim but before POST releases only that unsent claim`
- **UP5**：`a POST response body that breaks mid-stream is unknown, retained and never replayed`
- **UP6**：`facade timeout preserves prior success, names the in-flight unknown and never dispatches the remaining file`
- **UP7**：`a mix of successes and a platform rejection is PARTIAL_SUCCESS, per file and in the aggregate`
- **UP8**：`the ContentVersion call is a multipart publish carrying FirstPublishLocationId and the exact staged bytes`
- **UP9**：`the attachment Tool is enabled only through its own inventory and its own policy`
- **UP10**：`a staged file whose bytes changed after staging is refused rather than published`
- **UP11**：`a reference may not be replayed once it has been consumed, and expires on its own clock`

### MY — ACTUAL_MYSQL_REPOSITORY_BEHAVIOR

`packages/sfoa-control-plane/src/mysql-test/mysql.integration.test.ts`；执行套件：`mysql`。

- **MY1**：`attachment repository atomically claims owner-scoped live refs and cannot replay consumed or unknown attempts`
- **MY2**：`attachment recovery is explicit, expiry-bounded, and never revives legacy/local FAILED rows`
- **MY3**：`attachment cleanup includes failed and unknown bytes while preserving outcome facts and live claims`
- **MY4**：`017 preserves existing staged, consumed and failed rows without making historical failures retryable`

### GP — GUIDANCE_SURFACE_TEXT_ONLY

`packages/sfoa-agent-playbook/src/test/playbook.test.ts`；执行套件：`playbook`。

- **GP1**：`renders every required safety contract on every distribution surface`
- **GP2**：`preserves international numbers and does not derive a company address from an area code`
- **GP3**：`maps a requested owner to the configured managed owner field instead of OwnerId`
- **GP4**：`distributes the file-attachment contract as its own capability, never as Generic DML`

### GO — DEVELOPMENT_ONLY_ORACLE_NOT_RUNTIME_AGENT

`skills/sfoa-mcp-maintainer/scripts/toolkit.test.mjs`；执行套件：`skill`。

- **GO1**：`UPDATE gate — omitted, null, false and zero stay four different facts`
- **GO2**：`UPDATE gate — the patch never grows beyond the user intent`
- **GO3**：`CREATE duplicate oracle — material same-record ambiguity needs a decision; candidates and gaps stay bounded`

### GS — GUIDANCE_REFERENCE_TEXT_ONLY

`skills/sfoa-mcp-maintainer/scripts/toolkit.test.mjs`；执行套件：`skill`。

- **GS1**：`lookup and picklist reference covers every match count and the Label/API Value split`
- **GS2**：`update readiness reference keeps target resolution, minimal patch and the CREATE separation`
- **GS3**：`outcome reconciliation reference forbids replaying UNKNOWN and resubmitting a partial batch`
- **GS4**：`record change entry retains its readiness hard-boundary content contract`

### HF — HARNESS_FIXTURE_BEHAVIOR_NOT_SALESFORCE

`integrations/openclaw/sfoa-wecom-mcp-adapter/harness/test/material-workflows.test.mjs`；执行套件：`fixture`。

- **HF1**：`fixture ISO date ranges filter cross-date events through the actual query tool`
- **HF2**：`fixture query returns explicit null for a selected known but unset field`
- **HF3**：`simulated attachment partial failure keeps the record and permits only the failed original on recovery turn`
- **HF4**：`fixture predicates consume the whole AND expression and reject unknown syntax even with no rows`

## 模型、材料、渠道与 Salesforce 证据目录

### M1

来源：`docs/sfoa/AGENT_MATERIAL_WORKFLOWS_DELIVERY.md section 5; material-workflows-repeated-c02c392`。

- **scope**：First real-model guidance comparison, shared frozen Provider runtime and synthetic SDK
- **before**：12 PASS / 6 FAIL
- **after**：14 PASS / 3 FAIL / 1 NOT_VERIFIED
- **afterByJourney**：{"multisourceCreate": "2/3 PASS", "crossTurnCreate": "3/3 PASS", "existingSupplement": "3/3 PASS", "duplicateChoice": "0/3 PASS", "optionalArchive": "3/3 PASS", "attachmentRecovery": "3/3 PASS"}
- **limitation**：Unknown fields/unset selected values/range predicate fixture defects preserved; no corrected-fixture reliability claim

### M2

来源：`.temp/agent-material-workflows/mixed-material-evidence-reviewed.json`。

- **scope**：Single d57 real-model mixed-original probe, actual Office reader and reused actual ASR; native image/PDF; explicit host injection; real Providers with synthetic SDK
- **verdict**：PASS_FOR_THIS_ISOLATED_PROBE
- **observed**：Three turns; zero writes while collecting; two distinct customer/event CREATE dispatches then synthetic read-backs; relevant optional facts written; explicit no-archive respected
- **notProven**：Automatic hook-to-model chain, Gateway/WeCom, real Salesforce, repeated reliability

### P1

来源：`.temp/agent-material-workflows/material-evidence-reviewed.json`。

- **scope**：Nine original byte hashes, real installed SDK and manually invoked real Adapter hooks, isolated store and actual staging; DOCX/XLSX/CSV reads, WAV/m4a host ASR, PNG/scanned PDF model reading
- **verdict**：PARTIAL
- **notProven**：JPEG model reading, native voice entry, native read-state reconciliation, real WeCom, Salesforce publication

### S1

来源：`.temp/agent-material-workflows/live-agent-rejection-review.md; docs/sfoa/AGENT_MATERIAL_WORKFLOWS_DELIVERY.md section 7`。

- **scope**：Actual Salesforce UAT CREATE attempt
- **verdict**：FAILED_AND_FOLLOWUP_BLOCKED
- **observed**：One CREATE explicitly rejected by source/customer-or-lead-or-opportunity/factory validation; no recordId, successful UPDATE or file publication; no successful replay

### S2

来源：`.temp/agent-material-workflows/post-deploy-capabilities-1132-safe.json`。

- **scope**：Actual post-deployment discovery/schema comparison
- **verdict**：PASS_FOR_DISCOVERY_ONLY
- **observed**：29 names unchanged; only get_record_action_context schema changed; value assessment optional; five direct mutation/upload schemas unchanged
- **notProven**：Every discovered Tool successfully executes for every user/object

### M3

来源：`.temp/agent-material-workflows/d57f110-independent-repeated-review-summary.json`。

- **scope**：36 real-model guidance runs using corrected fixture and fixed old Provider + synthetic SDK
- **before**：15 PASS / 3 FAIL
- **after**：17 PASS / 1 FAIL
- **actualRunsPerSide**：42
- **nativeReadsPerSide**：21
- **beforeByJourney**：{"multisourceCreate": "3/3", "crossTurnCreate": "3/3", "existingSupplement": "3/3", "duplicateChoice": "3/3", "optionalArchive": "0/3", "attachmentRecovery": "3/3"}
- **afterByJourney**：{"multisourceCreate": "3/3", "crossTurnCreate": "3/3", "existingSupplement": "3/3", "duplicateChoice": "3/3", "optionalArchive": "2/3", "attachmentRecovery": "3/3"}
- **observed**：Candidate failure retained: one optional-archive journey invented customer-provided samples; three optional invitations otherwise correctly ordered
- **limitation**：Shared old Provider strips retryable from model-visible results; recovery uses explicit failed/not-published message, not proof of new backend/field propagation

### M4

来源：`.temp/agent-material-workflows/candidate-model-evidence-94aa661-reviewed.json; .temp/agent-material-workflows/final-comparison-safe.json; /data/sfoa-enterprise-mcp/evidence/material-workflows-candidate-94aa661-20261105/after-reviewed.json`。

- **scope**：Candidate 1.13.2 guidance-only 18 sessions / 42 actual trace runs; compared to the already reviewed d57 before18, not a new empty before-captures file
- **verdict**：18/18 PASS; six core journeys each 3/3
- **actualRuns**：42
- **sessions**：18
- **nativeReads**：21
- **relevantOptionalWrites**：48/48 semantically correct among defined expected optional slots
- **necessaryBusinessChoices**：3
- **unnecessaryBlockingQuestions**：0
- **optionalArchiveInvitations**：3
- **queryErrorsPreserved**：29
- **observed**：No unsupported sample actor/source in reviewed candidate payloads; required turns, target continuity, duplicate choice and scoped recovery passed
- **notProven**：Universal fact coverage, production reliability, candidate backend retryable propagation, automatic Adapter chain, real Salesforce or WeCom

### B1

来源：`.temp/agent-material-workflows/d57f110-boundary-reviewed.json / boundary-select-one-original; .temp/agent-material-workflows/boundary-probes-safe.json`。

- **scope**：One real-model run, real two TXT native reads, fixed old Provider + synthetic SDK
- **verdict**：PASS_SINGLE_PROBE
- **observed**：Both original TXT bodies read; only explicitly selected first reference uploaded to actual successful synthetic CREATE target
- **notProven**：Repeated reliability or real attachment publication

### B2

来源：`.temp/agent-material-workflows/d57f110-boundary-reviewed.json / boundary-transcript-without-audio; .temp/agent-material-workflows/boundary-probes-safe.json`。

- **scope**：One two-turn real-model session using user-provided transcript text only
- **verdict**：PASS_SINGLE_PROBE
- **observed**：Created from provided text; later original-audio request accurately reported unavailable original with zero tools/uploads and no invented reference
- **notProven**：Actual audio/ASR or real Salesforce publication

### B3

来源：`.temp/agent-material-workflows/94aa661-boundary-ambiguity-date-reviewed.json / boundary-ambiguous-ack; .temp/agent-material-workflows/boundary-probes-safe.json`。

- **scope**：One two-turn 1.13.2 real-model session, two actual fixture Account candidates and undecided date
- **verdict**：PASS_SINGLE_PROBE
- **observed**：After only 好, customer/date remained two pending choices; no DML or upload
- **notProven**：Repeated or live-WeCom clarification reliability; same-name responsible-person resolution

### B4

来源：`.temp/agent-material-workflows/94aa661-boundary-ambiguity-date-reviewed.json / boundary-old-event-transcript; .temp/agent-material-workflows/boundary-probes-safe.json`。

- **scope**：One 1.13.2 real-model run; exact native read of 519-byte user-transcription TXT dated October 15
- **verdict**：PASS_SINGLE_PROBE
- **observed**：Kept three/two participants, 1280 per set, negation, and follow-up as the week after the event without invented precise date or November anchor
- **notProven**：Raw old audio/ASR ambiguity or cross-timezone stability

### B5

来源：`/data/sfoa-enterprise-mcp/evidence/material-boundary-phone-94aa661-20261105/boundary-reviewed.json; .temp/agent-material-workflows/boundary-probes-safe.json`。

- **scope**：Two single real-model sessions; fixture Context/schema wrapper and empty query fixture, actual old DMLExecutor + synthetic SDK
- **verdict**：2/2 SINGLE_PROBES_PASS
- **observed**：Dispatched MobilePhone +44 7700 900123 and Phone 0592-8888888转123 unchanged in respective cases; name/company/title written, City/State/Country absent, zero clarification
- **notProven**：Actual ContextExecutor, real Salesforce lookup/deduplication, phone reachability, area-code-only input or repeated reliability

### S3

来源：`.temp/agent-material-workflows/fresh-gateway-1132-reviewed-safe.json`。

- **scope**：Fresh Gateway read-only run, no channel delivery or Salesforce
- **verdict**：PASS_FOR_RUNTIME_GUIDANCE_READING_ONLY
- **observed**：Run 614c7c46-32a6-42e4-9eaa-7da30fe2c943 read complete SKILL and material reference; returned body hashes matched actual runtime files; model identified 1.13.2
- **notProven**：Business execution or WeCom delivery

## 未完成的关键验收

- 真实 Salesforce 业务闭环受阻：没有成功 CREATE、UPDATE、关联子记录或原件发布/读回。
- 真人企微消息、原生语音、文件 m4a 和多轮归档授权仍为 NOT_TESTED。
- 原生读取结果回写覆盖、自动进入模型并执行的完整链路未证明；手工 hook 与显式文本注入是不同证据。
- 1.13.2 六旅程各3/3只证明冻结旧 Provider + 合成 SDK 的指导表现；旧 Provider 未向模型透传 retryable，新后台生命周期仍靠确定性/真实测试库验证。
- 六个边界单例全部通过但不是稳定率；电话 Context/query 为 fixture，不能替代实际 ContextExecutor/真实查重；仅区号仍未单测。
- 含糊 ASR 姓名/数字、原始旧音频相对时间、真实同名责任人、多来源关键冲突、真实多页长文续读仍缺专项。
- 真实模型关联子记录、compound/batch 部分结果，以及真实 Salesforce 131072 长文本约束/读回仍未完成。

本矩阵没有新增业务 API 调用或将未执行项改写为通过。最终版本与 JSON 同源生成；主交付报告保留所有历史失败及回滚路径。

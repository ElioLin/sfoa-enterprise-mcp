# P9 数据完备性 — Claude Code 执行计划与任务 Prompt

文档日期：2026-09-24
依据：`docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md` 第 5 节「阶段 P9」
执行方：Claude Code（本仓库工作区内执行）
本文档用法：按 T1 → T5 顺序，每次把一个任务的 Prompt 整段（含分隔线内全部内容）交给 Claude Code 执行。前一任务验收通过后再开始下一任务。

---

## 0. 拆分决策与全局约定

### 0.1 为什么拆成 5 个任务

P9 六项能力共享同一个新 Provider 包，但复杂度差异大、可独立验证、失败回滚粒度不同：

| 任务 | 内容 | 复杂度 | 依赖 |
| --- | --- | --- | --- |
| T1 | 分支 + `@sfoa/mcp-provider-sfoa-data` 骨架 + `list_sobjects` / `describe_sobject` | 中 | 无 |
| T2 | `query_records`（有界自动翻页 + 结构化输出 + 错误结构化） | 高 | T1（同包） |
| T3 | `get_org_limits` + `search_records`（SOSL） | 低 | T1 |
| T4 | `submit_bulk_query` + `get_bulk_query_results`（Bulk API 2.0） | 高 | T1；建议 T3 之后（配额联动） |
| T5 | Playbook 1.10.0 + 小犇指令 + `sfoa-data-analysis` skill + 文档收口 | 中 | T1–T4 |

全部任务在同一分支线性推进（共享新包，禁止并行分支互相覆盖）。

### 0.2 全局约定（每个任务都必须遵守，Prompt 中不再重复展开）

- 分支：`feature/p9-data-completeness`，基于 `main` 最新提交（当前 `d9f23a8`）。
- 新工具全部：READ 分类、USER 角色、**默认禁用**（不进 `DEFAULT_ENABLED_TOOLS`，由 Admin 经控制面 enabledTools 显式启用）、经 P7 审计管道。
- 上游策略：官方 dx-core 无对应工具能力 → 走 jsforce 官方 SDK（`Connection.describe/describeGlobal/limits/search/bulk`），**不修改任何官方 TypeScript 文件**；官方 `run_soql_query` 保持原样继续可用（`run_diagnostic_tooling_query` 依赖它）。
- 每个新工具契约必须满足 `docs/sfoa/MCP_ENGINEERING_RULES.md`：snake_case 名、Zod 严格输入、annotations、outputSchema + structuredContent、分页/截断规则（`truncated: true` + 可执行的继续指引）、错误契约（isError + 安全下一步，不含 token/堆栈）。
- 每个任务必须完成对应测试层并跑回归后才算完成；每个任务至少一个 conventional commit（`type(scope): description`，小写，参照 git log 风格）。
- 任何与本文档设计决策的偏离（如工具命名调整）必须写入新 ADR（`docs/sfoa/adr/` 递增编号）并在 CHANGELOG 记录。

### 0.3 全部完成后的 P9 验收清单（T5 收口时核对）

- [ ] `yarn build` / `yarn lint` / `yarn test` 全绿；`yarn workspace @sfoa/mcp-server test` / `test:p3` / `test:p4` / `test:p5` / `test:p7` / `validate:p2` / `validate:p3` / `validate:p4` / `validate:upstream` 全过
- [ ] Live SFoA：10 万行级对象「全量统计 + 明细抽样」分析完成，数据完整性声明可审计（`totalSize == fetched` 或 `truncated == true` 且有续查指引）
- [ ] Agent 无人工辅助下用 `describe_sobject` 自修复一次 INVALID_FIELD 查询
- [ ] Bulk 导出结果 `totalSize` 与 `COUNT()` 核对一致
- [ ] `yarn ai:audit --user <platformUserId> --latest 10 --since 24h` 可见全部新工具调用链（Event/API/Payload），无密钥泄漏
- [ ] Playbook 1.10.0 + `yarn agent:check` PASS；`.codebuddy/skills` 与 `skills/` 同步；CHANGELOG 更新

---
---

## 任务 T1 — 分支 + sfoa-data Provider 骨架 + describe 工具组

```
你是本仓库（D:\GitProject\sfoa-enterprise-mcp）的维护工程师，执行 P9 数据完备性计划的第一个任务。
本任务目标：建立任务分支，新建 @sfoa/mcp-provider-sfoa-data Provider 包骨架，并实现两个只读工具 list_sobjects 与 describe_sobject。

## 必读（按此顺序，全部读完后才开始动手）
1. AGENTS.md
2. .agents/skills/sfoa-mcp-maintainer/SKILL.md 及其 references/architecture.md、references/development.md、references/testing.md
3. docs/sfoa/PROJECT_BASELINE.md、docs/sfoa/ARCHITECTURE.md、docs/sfoa/MCP_ENGINEERING_RULES.md、docs/sfoa/UPSTREAM_STRATEGY.md
4. docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md（P9 设计依据）
5. 模板参照（新包逐文件照搬其结构模式）：
   - packages/mcp-provider-sfoa-context/（package.json、tsconfig.json、src/provider.ts、src/schemas.ts、src/tools/、src/test/ 的组织方式）
   - packages/sfoa-mcp-server/src/provider-runtime.ts（provider 组合点，重点看 SfoaContextMcpProvider 的接入方式）
   - packages/sfoa-mcp-server/src/discovery-server.ts（discovery 组合点）
   - packages/sfoa-mcp-server/src/tool-governance.ts 与 official-tool-catalog.ts（治理模型：SFOA 工具不进官方编目，靠 isSfoaXxxToolName 分流）

## 分支操作
1. git checkout main && git pull origin main（当前最新应为 d9f23a8）
2. 若 docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md 未被跟踪，先单独提交：
   git add docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md
   git commit -m "docs(sfoa): add the Salesforce MCP capability gap analysis and P9 roadmap"
3. git checkout -b feature/p9-data-completeness
4. 运行 yarn ai:snapshot 与 yarn ai:doctor 确认基线健康；如有 P0-P8 既有失败先停下来报告，不要带病开工。

## 上游复用前置检查（upstream-first 义务）
1. 运行 yarn workspace @sfoa/mcp-server validate:upstream 查看上游漂移报告。
2. 检查上游 salesforcecli/mcp 当前版本（git fetch upstream 后查看，或读 node_modules 中 @salesforce/mcp-provider-dx-core 之外官方 provider 的工具清单）是否已提供 describe/sobject-list 类工具：
   - 若已有且语义匹配：改为 REUSE 路径（编目进 official-tool-catalog.ts、评估 p2RemoteCompatible、默认禁用），并写 ADR 说明放弃自研的理由。
   - 若没有：按以下 SFOA 自研路径执行，并在 ADR 记录「上游无对应能力，走官方 SDK（jsforce）实现」。

## 实现内容
1. 新建 workspace 包 packages/mcp-provider-sfoa-data（包名 @sfoa/mcp-provider-sfoa-data）：
   - 结构照搬 packages/mcp-provider-sfoa-context（构建、lint、test 脚本一致）；加入根 yarn workspaces 覆盖范围（如需要）。
   - 导出 SFOA_DATA_TOOL_ROLES（list_sobjects/describe_sobject 均 'USER'）、SFOA_DATA_TOOL_NAMES、isSfoaDataToolName()，模式与 SFOA_CONTEXT_TOOL_ROLES 完全一致。
2. 实现工具（经 services.getOrgService() 获取请求级 Connection，绝不自行创建认证）：
   - list_sobjects（READ, USER, readOnlyHint=true, openWorldHint=false→按工程规则实际为 true，因为调用外部系统）：
     输入：可选 filter（对象名前缀，apiNamePattern 校验）、可选 limit（默认 50，硬上限 200）。
     实现：Connection.describeGlobal()，输出对象清单（name、label、keyPrefix、custom、queryable、createable），按 limit 截断。
     输出：text + structuredContent { sobjects, totalCount, returnedCount, truncated, hint }；truncated 时 hint 给出缩小 filter 的建议。
   - describe_sobject（READ, USER, readOnlyHint=true）：
     输入：objectApiName（zod 严格校验：Salesforce API 名模式、不含关系路径、长度上限 128）、可选 includeFields（默认 true）、可选 fieldLimit（默认 200，硬上限 1000）。
     实现：Connection.describe(objectApiName)。
     输出：text + structuredContent { objectApiName, label, labelPlural, keyPrefix, queryable, createable, updateable, fields[], childRelationships[], totalFields, returnedFields, truncated, hint }。
     fields 元素：{ apiName, label, type, nillable, createable, updateable, referenceTo[], relationshipName, picklistValues[]（有界，最多 100 个值，超出截断并声明） }。
     childRelationships 有界（最多 50 条）。
     对象不存在时返回 isError + 建议（核对 API 名，可先用 list_sobjects 探索）。
3. 组合接入（不改治理语义）：
   - packages/sfoa-mcp-server/src/provider-runtime.ts：configureProviderRuntime 的 officialEnabledTools 过滤加入 !isSfoaDataToolName(name)；createGovernedMcpServer 内参照 SfoaContextMcpProvider 的组合方式注册 SfoaDataMcpProvider（仅注册 enabledTools 中出现的 SFOA data 工具；无依赖官方原语的要求）。
   - packages/sfoa-mcp-server/src/discovery-server.ts：同样组合，保证 tools/list 只在启用时出现新工具。
   - config.ts 若存在工具名白名单/校验逻辑，同步登记（先读代码确认，不要盲目加）。
4. 治理要求：默认禁用（不加入 DEFAULT_ENABLED_TOOLS）；未启用时 tools/list 不可见、tools/call 返回 MCP_TOOL_NOT_AVAILABLE；启用后走 P7 审计。

## 测试与验证（全部通过才算完成）
1. 单元测试（放 packages/mcp-provider-sfoa-data/src/test/）：Zod 输入校验（非法 objectApiName、超限 limit）、describeGlobal/describe 的 mock Connection、截断与 hint 事实、错误路径（对象不存在、Salesforce 权限拒绝的错误映射与脱敏）。
2. 协议测试：参照 packages/sfoa-mcp-server/src/p4-test 或现有协议测试模式，验证未启用不可见、启用后 tools/list 与 tools/call 正常、duplicate 注册会被拒绝。
3. 构建与回归：yarn build && yarn lint && yarn test；yarn workspace @sfoa/mcp-server test、test:p3、test:p4、test:p5、test:p7、validate:p2、validate:p3、validate:p4、validate:upstream。任何既有失败必须先区分「我引入的」与「既有债务」，前者必须修复。
4. Live SFoA 验证（.env.local 已配置；先 yarn ai:doctor 确认）：在本地以 env 模式启用两个新工具启动服务，用 MCP 客户端调用 list_sobjects（filter=Acc）与 describe_sobject(Account)，确认字段事实与 org 一致、输出含 truncated/coverage 事实。
5. 审计验证：调用后运行 yarn ai:audit --user <测试 platformUserId> --latest 5 --since 1h，确认新工具调用产生完整 Event/API/Payload 证据链，且证据中无 access token、无密钥材料。

## 提交
至少一个 commit：feat(provider-sfoa-data): add the sfoa-data provider with list_sobjects and describe_sobject
如涉及 ADR（上游复用结论），单独一个 docs commit。

## 禁止事项
- 禁止修改 packages/mcp-provider-dx-core 与任何官方文件；禁止将新工具加入 DEFAULT_ENABLED_TOOLS；禁止在工具参数中接受 Salesforce username/token；禁止打印 .env.local 或任何密钥；禁止用 any 类型。
- 完成后输出：变更文件清单、测试结果摘要（每条命令的 PASS/FAIL）、live 与审计证据摘要、ADR 编号（如有）。
```

---
---

## 任务 T2 — query_records 有界自动翻页查询

```
你是本仓库（D:\GitProject\sfoa-enterprise-mcp）的维护工程师，执行 P9 数据完备性计划的第二个任务。
前置：任务 T1 已在分支 feature/p9-data-completeness 完成并通过验收（@sfoa/mcp-provider-sfoa-data 包已存在，list_sobjects/describe_sobject 已实现）。先 git log --oneline -5 确认，再开始。

本任务目标：在 @sfoa/mcp-provider-sfoa-data 中实现 query_records 工具——带自动续查、行数上限、结构化输出与结构化错误的 SOQL 查询工具，解决官方 run_soql_query 单批返回导致 >2000 行数据集分析不完整的问题（差距 GAP-D1/GAP-D9）。

## 必读
1. AGENTS.md、.agents/skills/sfoa-mcp-maintainer/SKILL.md、docs/sfoa/MCP_ENGINEERING_RULES.md（重点：Pagination and response limits、Error contract、Output and structured content）
2. docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md 第 4.1 节 GAP-D1/D3/D9 与第 5 节 P9-1
3. packages/mcp-provider-dx-core/src/tools/run_soql_query.ts（官方实现，只读参考，禁止修改）
4. packages/mcp-provider-sfoa-data/（T1 产物，本任务在其内扩展）
5. packages/sfoa-mcp-server/src/soql-usage-guard.ts（既有 SOQL 使用守卫，理解其语义，不要重复造）

## 实现内容
1. 在 packages/mcp-provider-sfoa-data 新增工具 query_records（READ, USER, readOnlyHint=true）：
   - 输入（strict zod）：
     - query：SOQL 字符串（1..20000 字符，必须 SELECT 开头、单语句、无分号、无 FOR UPDATE）
     - useToolingApi：可选 boolean（默认 false），与官方工具语义一致
     - maxRows：可选 int（默认 2000，最小 1，硬上限 50000；超过硬上限直接拒绝并说明）
   - 执行：经 services.getOrgService() 的请求级 Connection 执行查询，并沿 nextRecordsUrl 自动续查，直到 done 或达到 maxRows。续查循环必须有总耗时保护（建议 60s，超时就地截断并声明）。
   - 聚合感知：检测查询是否含 GROUP BY / HAVING / COUNT( 等聚合形态；聚合查询正常执行，但 truncated 时的 hint 不同（聚合结果天然有界，截断只可能来自 maxRows 设置过低）。
   - 输出：text（人类可读摘要 + 记录 JSON 切片）+ structuredContent：
     { records, totalSize, fetched, done, truncated, truncatedReason: 'MAX_ROWS'|'TIME_BUDGET'|null, aggregate: boolean, hint }
     - done=true 且 fetched=totalSize 时必须显式体现「结果完整」；
     - truncated=true 时 hint 必须给出可执行的下一步：优先建议改用聚合（COUNT/GROUP BY）或缩小 WHERE；明细需求指向 submit_bulk_query（P9-T4 提供，若当前 tools/list 没有该工具则只说「联系管理员启用 bulk 查询能力」，不要引用不存在的工具）。
   - 响应字符预算：text 部分不超过约 60000 字符；records 切片与 structuredContent 保持一致；超预算时截断 records 并把 truncatedReason 记为 'MAX_ROWS' 语义之外另加 RESPONSE_BUDGET（需要在契约中显式枚举）。
   - 错误结构化：捕获 jsforce 错误，映射 { errorCode, message, suggestion }：
     - INVALID_FIELD / INVALID_TYPE → suggestion 指向 describe_sobject / list_sobjects 自助核对
     - MALFORMED_QUERY → 给出语法修正建议
     - REQUEST_LIMIT_EXCEEDED → 指向 get_org_limits（T3，若不可用则只说明配额不足）
     - 其他 → 通用安全建议。任何错误输出不含 token、不含堆栈。
2. 与官方 run_soql_query 的共存策略（写进工具 description，并写 ADR）：
   - 官方工具保持原样、继续可用（run_diagnostic_tooling_query 依赖它）；query_records 是有界完整性查询的推荐路径。
   - query_records 的 description 中明确：当预期结果可能超过单批（约 2000 行）或需要完整性声明时优先使用本工具；官方 run_soql_query 仅用于快速单批探索。
3. SFOA_DATA_TOOL_ROLES 登记 query_records: 'USER'；provider-runtime.ts 与 discovery-server.ts 组合逻辑已按工具名泛化则无需再改（确认即可）。

## 测试与验证
1. 单元测试：mock Connection 覆盖——单批完成、三批续查 done、达到 maxRows 截断（truncatedReason=MAX_ROWS）、TIME_BUDGET 截断、聚合查询识别、各类错误映射、字符预算截断。
2. 协议测试：未启用不可见；启用后 tools/call 正常；非法 maxRows（0、50001）被拒绝。
3. Live SFoA 验证：选一个 >2000 行的对象（如 Contact 或自定义大对象）执行无 LIMIT 查询，核对 fetched 与 COUNT() 一致且 done=true、truncated=false；再用 maxRows=500 验证截断声明与 hint。
4. 审计验证：yarn ai:audit --user <测试 platformUserId> --latest 5 --since 1h 确认证据链完整、无密钥。
5. 回归：yarn build && yarn lint && yarn test；yarn workspace @sfoa/mcp-server test、test:p3、test:p4、test:p5、test:p7、validate:p2、validate:p3、validate:p4、validate:upstream。

## 提交
feat(provider-sfoa-data): add query_records with bounded auto-fetch and structured errors
（ADR 单独 docs commit）

## 禁止事项
- 禁止修改官方 run_soql_query 或 dx-core 任何文件；禁止把 query_records 注册成 run_soql_query 的同名替换；禁止接受 username/token 参数；禁止无上限回传结果；禁止在 hint 中引用不存在的工具名。
- 完成后输出：变更文件清单、测试摘要、live 完整性核对数字（fetched vs COUNT）、审计证据摘要、ADR 编号。
```

---
---

## 任务 T3 — get_org_limits + search_records

```
你是本仓库（D:\GitProject\sfoa-enterprise-mcp）的维护工程师，执行 P9 数据完备性计划的第三个任务。
前置：T1 已完成（sfoa-data 包存在）。T2 建议已完成但不是硬性前置。分支 feature/p9-data-completeness。

本任务目标：实现两个小型只读工具——get_org_limits（org governor 配额快照）与 search_records（SOSL 跨对象搜索）。

## 必读
1. docs/sfoa/MCP_ENGINEERING_RULES.md、docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md（GAP-D5/D7、P9-4/P9-6）
2. packages/mcp-provider-sfoa-data/（T1/T2 产物）

## 实现内容
1. get_org_limits（READ, USER, readOnlyHint=true）：
   - 无输入参数（或仅一个可选 verbose 开关）。
   - 实现：Connection.limits()。
   - 输出：text 摘要 + structuredContent { limits: Record<string,{remaining,max,used}>, highlights }；highlights 至少包含 DailyApiRequests、DailyBulkApiRequests（或 org 实际返回的等价键）、DailyAsyncApexExecutions、DataStorageMB、FileStorageMB 的 used/remaining，便于 agent 在发起 bulk 或大批量作业前自检配额。
   - 描述中写明：在提交大批量查询/导出前建议先调用本工具确认配额。
2. search_records（READ, USER, readOnlyHint=true）：
   - 输入（strict zod）：search（SOSL FIND 关键词或完整 FIND 子句，1..2000 字符，禁止分号与多语句）；objects（可选，字符串数组，元素为合法 API 名，最多 20 个——限定 RETURNING 的对象范围）；limit（可选，默认 20，硬上限 200）。
   - 实现：Connection.search()；若调用方只给关键词，由服务端组装为 FIND {关键词}（按 objects 组装 RETURNING 子集）；若给了完整 FIND 子句则透传（仍受单语句校验约束）。
   - 输出：text + structuredContent { resultsByObject: Record<string, records[]>, totalReturned, truncated, hint }；每个对象的 records 按 limit 有界，附对象 label（若能从 describe 廉价获得，不做额外强制调用）。
   - 错误：SOSL 语法错误结构化并给出示例。
3. SFOA_DATA_TOOL_ROLES 登记两个工具为 'USER'；确认组合逻辑按工具名泛化生效。

## 测试与验证
1. 单元测试：limits 输出结构、highlights 键缺失时的容错；search 输入校验（分号拒绝、超长拒绝、objects 元素合法性）、关键词模式与完整 FIND 模式、截断事实。
2. 协议测试：未启用不可见；启用后可调用。
3. Live SFoA 验证：get_org_limits 返回与 org 实际配额一致；search_records 用组织内真实存在的关键词（如已知客户名片段）验证跨对象命中；用 objects=['Account'] 验证范围限定。
4. 审计验证：yarn ai:audit --user <测试 platformUserId> --latest 5 --since 1h。
5. 回归：同 T2 的完整命令集。

## 提交
feat(provider-sfoa-data): add get_org_limits and search_records

## 禁止事项
- 同前：不改官方文件、不默认启用、不接受身份参数、不泄漏密钥、不用 any。
- 完成后输出：变更文件清单、测试摘要、live 证据、审计摘要。
```

---
---

## 任务 T4 — Bulk Query 2.0 双工具

```
你是本仓库（D:\GitProject\sfoa-enterprise-mcp）的维护工程师，执行 P9 数据完备性计划的第四个任务，也是技术复杂度最高的一个。
前置：T1 完成；T3 建议完成（配额联动）。分支 feature/p9-data-completeness。

本任务目标：实现 Bulk API 2.0 查询的 submit/fetch 双工具，让 agent 能完成百万行级全量数据导出分析（差距 GAP-D2），同时保持无状态 HTTP 架构与响应预算。

## 必读
1. docs/sfoa/MCP_ENGINEERING_RULES.md（Pagination/Output/Error/Transport 节）、docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md（GAP-D2、P9-3）
2. packages/mcp-provider-sfoa-data/（T1-T3 产物）
3. packages/sfoa-mcp-server/src/http-server.ts 与 config.ts（确认无会话状态架构：sessionIdGenerator: undefined；作业 ID 必须由 agent 持有并跨请求传递，服务端不保存作业状态——状态真相在 Salesforce 侧）
4. jsforce bulk API 2.0 能力（Connection.bulk2 或 connection.request 调 /services/data/vXX/jobs/query；先读 node_modules/jsforce 的实际导出再决定，优先官方 SDK 封装，不要手写 REST 除非 SDK 不支持）

## 实现内容
1. submit_bulk_query（READ, USER, readOnlyHint=true——只创建查询作业，不改变业务数据；description 中明确说明这一点）：
   - 输入（strict zod）：query（SOQL，1..20000 字符，SELECT 开头、单语句、无分号、无 FOR UPDATE）；operation 固定 query（不暴露 delete/update 等 bulk 操作）。
   - 执行：经请求级 Connection 创建 Bulk API 2.0 Query Job。
   - 输出：structuredContent { jobId, state, apiVersion, hint }；hint 说明用 get_bulk_query_results 轮询。
   - 配额保护：提交前读取 Connection.limits() 的 bulk 相关剩余配额，不足时拒绝并返回结构化错误（指向 get_org_limits）。
2. get_bulk_query_results（READ, USER）：
   - 输入：jobId（18 位 Salesforce ID 校验）；locator（可选，透传 Salesforce 分页 locator）；maxRecords（可选，默认 2000，硬上限 50000）。
   - 执行：查询作业状态；若完成则按 locator/maxRecords 拉取结果切片。
   - 输出：structuredContent { jobId, state, numberRecordsProcessed, numberRecordsFailed, records（切片）, locator（下一页游标或 null）, hasMore, totalRecords, fetchedCumulative（若可得）, hint }
   - 结果切片必须遵守响应字符预算（约 60000 字符），超出时减少本批 records 并以 hasMore + locator 让 agent 续取；绝不在单次响应中回传全量。
   - 作业失败/中止时输出结构化失败原因（stateMessage）。
   - 作业不属于当前请求用户的 Salesforce 身份时，Salesforce 侧会拒绝——原样映射为权限错误，不做跨身份穿透。
3. SFOA_DATA_TOOL_ROLES 登记两个工具为 'USER'。
4. 描述与提示：两个工具的 description 互指；query_records 的 truncated hint 中允许在 tools/list 存在 submit_bulk_query 时指向它（若 T2 已落地，调整其 hint 生成逻辑为「按当前可用工具动态决定」，否则在 ADR 中说明 T2 hint 静态文案的理由）。

## 测试与验证
1. 单元测试：jobId 校验、submit 配额不足拒绝、fetch 的状态机（UploadComplete/InProgress/JobComplete/Failed/Aborted）、locator 续取、字符预算截断、失败原因映射。
2. 协议测试：未启用不可见；启用后双工具闭环（submit→fetch）。
3. Live SFoA 验证：对一个 >=100000 行的对象执行 COUNT 版 bulk 与明细版 bulk：
   - 明细版通过 locator 循环累计行数，与 COUNT() 结果核对一致；
   - 记录耗时与配额消耗，确认 get_org_limits 前后差值合理。
4. 审计验证：yarn ai:audit --user <测试 platformUserId> --latest 10 --since 1h，确认 submit 与多次 fetch 各自成链、无密钥。
5. 回归：同 T2 完整命令集。

## 提交
feat(provider-sfoa-data): add bulk query 2.0 submit and fetch tools

## 禁止事项
- 禁止引入服务端作业状态存储（数据库表/内存缓存）；禁止暴露 bulk delete/update/insert 操作；禁止单次响应回传全量结果；禁止修改官方文件；禁止默认启用。
- 完成后输出：变更文件清单、测试摘要、live 行数核对证据（累计 vs COUNT）、审计摘要、ADR 编号（如有）。
```

---
---

## 任务 T5 — Playbook 1.10.0 + 小犇指令 + 数据分析 skill + 文档收口

```
你是本仓库（D:\GitProject\sfoa-enterprise-mcp）的维护工程师，执行 P9 数据完备性计划的收口任务。
前置：T1–T4 已完成并通过各自验收。分支 feature/p9-data-completeness。

本任务目标：把 P9 新能力写进 Agent 操作契约（Playbook 1.10.0 与小犇指令）、新建 sfoa-data-analysis skill、完成文档与版本收口，并执行 P9 整体验收。

## 必读
1. packages/sfoa-agent-playbook/src/definition.ts、version.ts、renderer.ts、capabilities.ts（playbook 内容与版本机制；AGENT_INFRASTRUCTURE_TOOL_NAMES 的定义处）
2. packages/sfoa-agent-playbook/scripts/sync-generated.mjs（生成物清单：.codebuddy/skills/sfoa-salesforce-assistant/*、docs/agent/DIFY_AGENT_INSTRUCTION.md（小犇指令）、docs/agent/WORKBUDDY_AGENT_SYSTEM_PROMPT.md）
3. skills/sfoa-crm-core/SKILL.md（顶层 canonical skill 的格式基准）
4. docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md（P9 验收标准）
5. CHANGELOG.md 最近 10 条条目的格式

## 实现内容
1. Playbook 升级：
   - definition.ts 新增「数据查询与完整性」章节，要点：
     a) 完整性声明义务：任何基于 query_records / bulk 结果的分析结论必须声明覆盖率（fetched/totalSize；truncated=true 时禁止声称全量）；
     b) 工具选择指引：单批探索可用 run_soql_query；预期超 2000 行或需完整性声明用 query_records；全量导出/百万行级用 submit_bulk_query + get_bulk_query_results；
     c) 聚合优先：统计类问题先 COUNT/GROUP BY 估量再决定明细路径；
     d) schema 自助：写查询前字段名不确定时用 list_sobjects / describe_sobject 核对，INVALID_FIELD 后必须先 describe 再重试；
     e) 配额意识：大批量作业前 get_org_limits。
   - 若 capabilities.ts 的 AGENT_INFRASTRUCTURE_TOOL_NAMES 或能力模型需要感知新工具，按现有模式最小改动（不要重写渲染器）。
   - version.ts 将 AGENT_PLAYBOOK_VERSION 从 1.9.0 升至 1.10.0。
   - 更新 packages/sfoa-agent-playbook 内的单元测试（版本断言、渲染快照、章节存在性）。
   - 执行：yarn workspace @sfoa/agent-playbook build && yarn agent:sync && yarn agent:check，确认 5 个生成物全部刷新且漂移检查 PASS（小犇指令 docs/agent/DIFY_AGENT_INSTRUCTION.md 头部应为 Playbook-Version: 1.10.0）。
2. 新建 skills/sfoa-data-analysis/SKILL.md（顶层 canonical，格式对齐 skills/sfoa-crm-core/SKILL.md：frontmatter name/description + Hard Rules + Guidelines）：
   - Hard Rules：完整性声明（覆盖率、truncated 语义）、禁止把部分结果说成全量、truncated 时的三条路径（聚合→bulk→缩小范围）、大结果不整段进上下文、Untrusted 字段内容规则、统计口径显式化（时间窗/过滤条件/币种等）。
   - Guidelines：先 COUNT 再明细、describe 自助流程、limits 前置检查、分页续取纪律（locator/nextRecordsUrl 的正确消费）。
   - 同步副本到 .codebuddy/skills/sfoa-data-analysis/SKILL.md（与 sfoa-crm-core 的双处存放模式一致；如发现仓库有 skill 同步脚本则使用脚本，不要手抄出错）。
3. 文档收口：
   - CHANGELOG.md 增加 P9 条目（新增包与 8 个工具、playbook 1.10.0、新 skill）。
   - docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md 第 5 节 P9 表格追加状态列或在文首标注「P9 已交付（分支 feature/p9-data-completeness）」。
   - 若 P9 实现与计划文档有偏离，确认对应 ADR 已存在并在 CHANGELOG 引用。
4. P9 整体验收（逐项核对并输出证据）：
   - 全量回归：yarn build && yarn lint && yarn test；yarn workspace @sfoa/mcp-server test、test:p3、test:p4、test:p5、test:p7、validate:p2、validate:p3、validate:p4、validate:upstream；yarn agent:check；yarn skill:check（若 skill 变更触及 maintainer 机制）。
   - Live 验收场景：
     a) 10 万行级对象「全量统计 + 明细抽样」：bulk 全量行数 == COUNT()；query_records 抽样页 truncated 声明正确；
     b) INVALID_FIELD 自修复：故意发一个含错字段的 query_records，确认错误结构化指向 describe_sobject，describe 后修正查询成功；
     c) SOSL 跨对象搜索命中；
     d) get_org_limits 快照与 org 一致。
   - 审计验收：yarn ai:audit --user <测试 platformUserId> --latest 20 --since 24h，确认 P9 全部新工具调用链完整、无密钥、无未脱敏授权记录。
   - 输出《P9 验收摘要》追加到 docs/sfoa/MCP_CAPABILITY_GAP_ANALYSIS_2026-09.md 文末或独立 docs/sfoa/P9_ACCEPTANCE_REPORT.md（含每条命令的 PASS/FAIL 与 live 数字）。

## 提交
- feat(agent-playbook): publish playbook 1.10.0 with the data completeness contract
- feat(skills): add the sfoa-data-analysis skill
- docs(sfoa): record the P9 acceptance evidence
（可按实际拆合，但 playbook 与 skill 分开）

## 禁止事项
- 禁止手改 docs/agent/ 与 .codebuddy/skills/sfoa-salesforce-assistant/ 下的生成物（只能经 yarn agent:sync 生成）；禁止把新工具写成默认启用；禁止在 skill 中写入任何环境特定值（org id、用户名、token）；禁止跳过 agent:check。
- 完成后输出：playbook 版本证据、agent:check 结果、skill 文件路径、整体验收摘要、分支最终 git log --oneline。
```

---
---

## 附：给用户的执行提示

1. **顺序执行**：T1 → T2 → T3 → T4 → T5。T2/T3 在 T1 之后可互换，但 T4 依赖 T1 且建议在 T3（配额工具）之后。
2. **分支保护**：5 个任务共用 `feature/p9-data-completeness`，全部验收后再合回 `main`（建议 squash 或保留任务级 commits，按你的仓库习惯）。
3. **Live 验证前提**：`.env.local` 已配置 SFoA 环境（先跑 `yarn ai:doctor`）。live 步骤需要真实 org；若执行环境无 org 访问，要求 Claude Code 在该步骤明确标注「未执行 live，待人工补验」，禁止伪造证据。
4. **失败处理**：任何任务的回归测试若出现既有失败（非本次引入），要求 Claude Code 先报告并停下来，不要带病继续。
5. **上游复用检查**：T1 内的前置检查若发现上游已有 describe 类工具，会走 REUSE 路径并写 ADR——这是预期分支，不是失败。

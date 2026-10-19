# P11-A 实施报告

状态：BLOCKED_BY_FROZEN_MYSQL_AND_BROWSER_ASSERTIONS。工程修复已进入审查交付，A 尚未通过全部验收，不能标为 READY_FOR_REVIEW / P11 COMPLETE。最终 PR 的 Head、Actions 与逐套件结果以 PR 说明固定；下列提交前实测不冒充最终 Head 验收。

## 范围、基线与现场

仅执行附件 A00–A09 / A-G01–A-G15。B1/B2/C、Flow/Apex/LWC/内嵌 PoC 未实施。起始 main 为 12df237f7ab03c4771109813b84f715a29e9e32d。origin 为 ElioLin/sfoa-enterprise-mcp，upstream 为 salesforcecli/mcp，fetch/push URL 未变。原 main 工作区保留；实施在独立 feature/p11a-reproducible-ci worktree。

本机 HTTPS Git 缺少凭据，git fetch 未成功。GitHub 连接重新读取 main 和全部 refs，逐 SHA 与本地基线核对。提交经 Git data API 写入本地暂存的同一棵 tree，校验 API commit 和本地 SHA 相同，再以 expected_sha、force=false 前进自己的分支；没有强推或改写原历史。

[原任务书](taskbooks/SFOA_P11_Phase1_Codex_Taskbook_20261019.md)、[计划](P11_PLAN.md)、[基线声明/源树](evidence/p11a/source-baseline.json)、[远端快照](evidence/p11a/remote-baseline.json)、[冻结核对](evidence/p11a/frozen-scope.json)。附件工作副本与原文件 SHA-256 相同，Git 正常进行换行规范化，见 [复制凭据](evidence/p11a/taskbook-copy.json)。

## 根因和必要修正

1. 原根 build 是 yarn workspaces run build，未表达完整前置依赖；它并非显式并行命令。main 的 [原始 Linux 运行](https://github.com/ElioLin/sfoa-enterprise-mcp/actions/runs/38713912780/job/116351960904) 中，Admin API 在 Control Plane/Identity/MCP 声明产物出现前编译，出现 TS2307。
2. 原 lock 缺少现有声明的 50 处直接引用 / 24 个唯一 selector。Classic frozen 可尝试解析缺项，URL-only lint 也未查覆盖。增加 exact-selector lock:check、真正 frozen install，再正常 install 并检查零 manifest/lock diff；三者互补。
3. Control Plane/Admin API 的 --test-isolation=none 在固定 Node 22 上退出 9。改为 --experimental-test-isolation=none，保持原 none 模式；未切换 Node 主版本或删参数。
4. 首轮完整 Linux 默认测试另暴露 Node 22 生命周期差异：2231 pass、0 failed assertions、47 cancelled、0 skipped。既有运行时 deadline 使用 unref，Node 22 会在只剩此句柄时取消等待中的测试；Node 24 的最小对照不取消。运行时完全未改。scripts/node-test-lifecycle.mjs 只在测试 preload：保留一个句柄直到 node:test after()，用原生 --test-timeout=300000 使真正挂起仍以非零退出。三个子进程测试证明断言实际执行、失败仍非零、永久等待会超时；随后 Linux 原默认测试 2288 pass、0 skip/cancel。MCP 原进程隔离保留，validate:p5 的 none 和 P8 原并发/范围不变。
5. 官方发布、automerge、devScripts 与 Slack 链路依赖官方组织权限，不适用于本私有独立仓库。归档来源并保留核心质量门禁，没有补官方发布凭据。
6. 首轮 fullstack 在 Admin ready 前因缺少 MCP_CLIENT_TOKEN 退出。最终 Linux step 生成并 mask 自己的一次性随机内部凭据，保留 internal_bearer，等待最终 PR 实测。未读取 .env.local，也未改变运行配置默认值。

## 逐文件改动

| 文件/入口 | 实施内容 |
| --- | --- |
| package.json | 仅 scripts：统一 build/build:sfoa、lock:check、test:engineering、fullstack 前置构建；原 yarn workspaces run test 保留 |
| scripts/build-workspaces.mjs | 用已安装的 TypeScript 与标准库，读取 Yarn 实际本地/发布解析、TS references 和 Wireit build 前置关系，稳定顺序执行全部 21 个 workspace 或目标完整闭包；缺项/环/子命令失败立即非零，明确无 build 语义 |
| scripts/build-workspaces.test.mjs | 9 个行为测试：顺序、闭包、环、缺项、无 build、真实退出 37 后停止、发布解析差异、Wireit 前置依赖 |
| scripts/check-lockfile.mjs / .test.mjs | 3 个 exact-selector/本地 workspace 解析测试，拒绝缺项 |
| scripts/ci-run.mjs / .test.mjs | 4 个计数/脱敏/负例测试；记录原退出码与 gate 退出码，识别 TAP/Vitest/Mocha/Playwright；拒绝 0 测试/全 SKIP，专有套件拒绝任何 skip/cancel/todo；日志保留首个失败和尾部，artifact 上限 65536 字符、console 16384 |
| scripts/node-test-lifecycle.mjs / .test.mjs | 只作用测试的 Node 22 生命周期兼容，3 个真实子进程正/负/挂起验证，无运行时导入 |
| scripts/p5-dev.mjs | 前置构建改用同图的后端闭包；启动/健康轮询/端口/Origin/日志/信号/Windows taskkill 不变 |
| scripts/validate-p5.mjs / p8-04-regression.mjs | 共享 SFoA 完整闭包，删手工构建序列；MCP 测试使用同一测试 preload/原生超时，保持原隔离、并发、断言与目标范围 |
| sfoa-admin-api/package.json | 仅 test 的 Node 22 none 参数别名 |
| sfoa-control-plane/package.json | 仅 test/test:mysql 的同一别名 |
| sfoa-mcp-server/package.json | 仅六个 test scripts 加测试 preload/原生超时，编译、模式和文件范围不变 |
| yarn.lock | 仅补当前声明及传递闭包；已有 version/resolved/integrity 不变 |
| .github/workflows/test.yml + 两个 reusable | main PR/push/dispatch，固定工具链，Linux/Windows 冷装全仓构建和原默认测试；稳定 P11-A gate 要求两 job success，不能以 skipped 放行 |
| e2e.yml / validate-pr.yml | DX Core 真 Org 显式 opt-in；本地 conventional 标题/非空说明检查，PR 文本通过 env 传递 |
| .github/dependabot.yml | 根 Yarn workspace/唯一 lock；例行 npm PR 限额 0；Actions 每月最多 2、patch/minor 分组、人工审查；现有安全开关不变 |
| docs/sfoa/upstream-workflow-reference | 14 份原始 Git blob/SHA-256，逐条触发/保留覆盖/归档/恢复；9 个不适用流程退出活动目录 |
| 本报告、锁报告、分支盘点、evidence/p11a | 根因、15 gates、解析变化、完整 refs/PR 与恢复、实际测试计数及环境失败 |
| PROJECT_BASELINE/UPSTREAM_STRATEGY/README/DEVELOPING/CHANGELOG | 更新当前工程入口、状态和上游差异；原历史保留 |
| PROD/TEST_SERVER_DEPLOYMENT | 当前 frozen install + build:sfoa 指引（含 data provider）；历史事故/操作原义保留，未在服务器执行 |
| canonical maintainer references + 三平台副本 | development/operations/testing 工程知识；副本由 skill:sync 产生 |

上述三份 workspace manifest 的 scripts-only 变化为固定 Node 22 实测要求的最小工程例外。所有 manifest 的非 scripts 字段逐项相同，包括依赖版本、name/version、engines、exports、workspace/nohoist。packages 内除了这三份 manifest 没有差异；已有业务源码、测试及其断言、迁移、权限/Tool Schema、身份与错误语义、运行默认值均冻结。业务 Skill/Playbook 内容与版本未改。

## 锁文件结论

[锁报告](P11A_LOCKFILE_REPORT.md) 与 [完整机器明细](evidence/p11a/lock-delta.json)：新增 255 selector（24 direct + 231 transitive）、197 resolution record，删除 0、既有 version/resolved/integrity 变化 0。新增记录 84 个可由 dependencies/optional 路径到达，113 个 dev-only，未归因 0。8 个新 selector 复用旧 resolution，其中四个 direct 是 JSforce 3.10.13、SDK 1.18.2、Salesforce Core 8.29.0、Zod 3.25.76；没有 SDK 升级。

范围使用实际 Yarn workspace 解析、声明依赖和锁闭包推导；声明闭包不是 import/bundle 或实际漏洞可利用性证明。没有读取服务器 node_modules/旧 lock 来拼接依赖。Linux 生成的 lock 为 647201 字节、SHA-256 a8fa6e00390ab62124bef1ce4fbe2a3f9bf85de05ea92904b14abdfcec44cd2b；随后 frozen 和标准 install 零漂移实测通过。

## CI、权限和上游自动化

[完整 workflow 政策与恢复](upstream-workflow-reference/README.md)。固定 Node 22.23.1、Yarn 1.22.22、Java 11.0.30+7；Windows 用明确的 Git Bash 执行原 analyzer cp。两个核心 OS 均验证 checkout 无 node_modules/dist/lib/.wireit/tsbuildinfo，不恢复构建/依赖缓存，全部 21 包及原默认测试保留。

Linux 另外跑原 P3/P4/P5/P7、临时 MySQL 8.0.30 的 Control Plane/MCP 集成、原 Admin 单测（默认测试内）、mock 浏览器、真实 Admin API + 测试 DB fullstack、stdio/upstream、Skill/Agent。Analyzer E2E 是本地 Java/stdio fixture，两个 OS 都保留。独立套件在 build 成功后继续取证，即便另一套件失败；原失败仍导致 job/gate 失败，没有 retry/continue-on-error。

官方 action 固定已核验的既有 v4 commit SHA。默认 contents: read，无远端 @main、write-all、发布权限、官方 bot/npm secrets、自动合并、Slack/邮件步骤。同 PR 可取消过时执行；main/不同 PR/非 PR 运行的 group 隔离。临时 push 取证 wrapper 在最终交付移除，PR 核验正式 tests。

DX Core 真 Org E2E 仅显式 manual opt-in + sfoa-test-org environment + 测试凭据前检，未配置时不宣称成功。真实 Org/P0/P1/P2 live/UAT 均 NOT_TESTED/NOT_CONFIGURED。分支保护细节读取受 403 限制，未修改保护；审查合并时需核对旧 required check 名称，不能因改名留下 Pending。归档/Dependabot 日程政策合入 main 后才对默认分支生效，本轮不合并。

## 分支/PR 与恢复

[完整盘点](P11_BRANCH_INVENTORY.md)：43 个基线分支全部逐 SHA 可追踪；main 与 32 个自研分支 KEEP；10 个依赖分支 EVALUATE，PR 保持 open。所有 head 的持久自包含 bundle 已 verify，并在独立 mirror 恢复逐项比对 43/43。未删除分支、关闭旧 PR 或丢独有提交。外部引用和私有 security alerts / security updates 状态未知，未从 protected=false 推断没有规则。

十个旧 PR 均只改一行 manifest、无 lock 更新；不能从标题声称可重复的实际安装版本或安全收口。恢复方案为在新基线上分别重放、单独审查窄 lock diff、跑完整 CI，不直接合并陈旧 PR。SDK/测试工具公开安全公告另有记录，本轮不越过依赖冻结。

## 真实验证结果

完整 [提交前 CI 机器结果](evidence/p11a/pre-pr-ci.json)，固定 head b6b400deaf702e2cc4d2fb020e39ca3cf92972b2：[Actions](https://github.com/ElioLin/sfoa-enterprise-mcp/actions/runs/39222820613)。Linux job 117961903200 真实失败。表中执行数为 passed+failed+cancelled，不把重叠套件/重跑累加成唯一案例覆盖率。

| Linux 命令/套件 | 退出 | Pass | Fail | Skip | Cancel |
| --- | --- | --- | --- | --- | --- |
| node --version / yarn --version | 0，22.23.1 / 1.22.22 | — | — | — | — |
| lock:check / frozen install / normal install 零漂移 | 0 / 0 / 0 | — | — | — | — |
| yarn build，全部 21 个 workspace | 0 | — | — | — | — |
| test:engineering | 0 | 19 | 0 | 0 | 0 |
| 原 yarn test（含 Admin unit） | 0 | 2288 | 0 | 0 | 0 |
| analyzer test:e2e（本地 fixture） | 0 | 7 | 0 | 0 | 0 |
| test:p3 / test:p4 / test:p5 / test:p7 | 0 / 0 / 0 / 0 | 25 / 16 / 6 / 6 | 0 | 0 | 0 |
| Control Plane test:mysql | 1 | 12 | 2 | 0 | 0 |
| p5:test:runtime:mysql | 0 | 2 | 0 | 0 | 0 |
| p5:e2e（mock 浏览器） | 1 | 2 | 1 | 0 | 0 |
| p5:e2e:fullstack | 1，ready 前配置失败 | 0 | 0 | 0 | 0 |
| regress:stdio / validate:upstream | 0 / 0 | 协议回归，无测试框架计数 | — | — | — |
| skill:test | 0 | 71 | 0 | 0 | 0 |
| skill:validate/check/delivery/smoke + agent:check | 均 0 | 生成物门禁，无测试框架计数 | — | — | — |

Windows 同一 run 的 job 117961903452 完整成功：固定安装/无漂移/全 21 包冷构建退出 0；工程测试 19 pass/0 skip；原默认 2287 pass/0 fail/1 skip/0 cancel；analyzer E2E 7 pass/0 skip，Skill 71 pass/0 skip，所有生成物与 committed smoke/Agent 门禁退出 0。完整输出计数为 1 skip；源码有既有 Windows unreadable-file 条件跳过，有限保留日志未包含该 case 的 reporter 行，因此逐项归因注明为源码对照，未新增 skip。最终 PR Head 需要重新核验两个核心 job 和 gate，PR 说明记录最终 run/SHA/退出码与执行/跳过数；本表不将 b6b400d 等同文档提交后的 Head。

### 冻结测试阻断及最小后续方案

[失败源文件与 main 的 SHA-256 对照](evidence/p11a/frozen-test-failures.json) 证明两个测试文件与起始 main 逐字相同。相同 Node/Yarn/真实 MySQL/Chromium CI 中执行的是这些未变源码；没有声称原 main 可独立通过本轮修复前的构建/Node flag 问题，也没有虚构另一次完整 main 冷装通过。

- Control Plane 两个测试明确预期迁移列表止于 013，仓库实际已有 014/015，真实应用后返回额外两项，deepStrictEqual 失败。其余 12 项 pass、无 skip。最小后续方案是在独立批准的断言维护补丁中审查并列出完整 001–015，保留升级/数据/锁校验；不能删迁移或放宽成任意非空列表。
- Admin mock browser 的 getByText('correlation-e2e') 同时匹配 correlation-e2e 与 correlation-e2e-error，Playwright strict mode 拒绝；另 2 项 pass。最小后续方案是独立审查精确/行级定位，继续覆盖成功及失败审计行；不能关闭 strict、删 fixture 或删测试。
- fullstack 缺失 CI 专用 MCP_CLIENT_TOKEN 属工程环境问题，已在最终 workflow 修复；实际启动/健康/退出是否通过由最终 PR 运行决定，不能先把 A-G09/A-G10 写 PASS。

### 本机环境与补充观察

本机固定 Node ZIP 已对官方 SHASUMS256 核验。初次 frozen 因 @ant-design/icons 下载 ESOCKETTIMEDOUT 退出 1，未构建；旧 C 盘加密 Yarn cache 复制在 Node 22/24 都 UNKNOWN。任务独立 D 盘 cache 只从经 SRI/hash 校验的公共 tarball 解包，没有复用已有 node_modules/dist 或人工补链接。Windows 标准安装在约 50.9 万文件的 bin linking 期间长期扫描；32 线程恢复 EBUSY，两个 workspace alias 同 inode 只证明路径重叠，原因仍属推断；单线程因工具 kernel 重启中断。所有本机未完成安装不计 PASS；两套真正冷装证据来自干净 GitHub runners。

曾启动任务独立 datadir/13306 的 MySQL 8.0.30，未执行本地集成测试，实例已随任务工具进程结束；CI 用自己的测试服务。没有连接生产配置。只读 build plan 对全部 21 包与 admin-api 11 包成功，SFOA plan 在本机负载下超时，均不冒充本机冷构建验收。

本机最终工程测试 19 pass / 0 skip，Skill validate/check/delivery/sync 均 0、Skill test 71 pass / 0 skip。committed smoke/Agent 由最终 CI 再核对。原 main 用固定 Node 22.23.1 / Yarn 1.22.22 执行根 lint 的同一命令体，退出 1：code-analyzer/test/test-helpers.ts:29:14 的既有 unused catch error，1 error / 0 warning，后续 workspace lint 未执行。[lint 基线](evidence/p11a/lint-baseline.json) 记录源文件与 main 相同；这是既有安装环境补充观察，不是冷装验收，也不把历史 47 条当成本轮计数。新增 .mjs 不在原 TypeScript ESLint 范围，用语法检查与 19 个行为测试验证；不据上游失败豁免新问题。

## A-G01–A-G15

| Gate | 提交前证据与交付结论 |
| --- | --- |
| A-G01 | PASS：基线 refs/source/声明快照，packages 只三份 scripts 例外，全部非 scripts 字段相同；最终 Head 在 PR 固定 |
| A-G02 | 提交前两 OS frozen / normal install 零漂移 PASS；最终 PR 必须重验 |
| A-G03 | Linux 无产物全 21 包冷构建 PASS；最终 PR 必须重验 |
| A-G04 | Windows 明确 Node/Git Bash、全 21 包冷构建 PASS；最终 PR 必须重验 |
| A-G05 | 19 个工程行为测试 PASS，含退出 37 传播/停止、环/闭包、计数负例与真正超时；最终 PR 必须重验 |
| A-G06 | 默认 Linux 2288/0skip、Windows 2287/1个原有平台skip，均退出0；最终 PR 必须重验 |
| A-G07 | P3/P4/P5/P7 共用原脚本，25/16/6/6 pass、0 skip；最终 PR 必须重验 |
| A-G08 | BLOCKED_BY_FROZEN_MIGRATION_EXPECTATIONS：真实 MySQL 已运行，Control Plane 12pass/2fail；MCP 2pass/0skip |
| A-G09 | BLOCKED_BY_FROZEN_BROWSER_LOCATOR；Admin unit 在默认测试通过；fullstack 环境修正待最终 PR 实测 |
| A-G10 | 采用允许的 fake fullstack 启动/ready/退出路径，仍待最终 PR 验证；不声称生产 p5:dev 实测 |
| A-G11 | Linux 原生成物检查/committed smoke/Agent 均 PASS；最终 canonical 改动已 sync/check/test，最终 PR 重验 |
| A-G12 | 正式 PR/main/dispatch 定义完成；临时 wrapper 移除，最终真实 PR Actions 必须核验；现行 main 未自行合并 |
| A-G13 | PASS：contents read、无自动合并/发布/消息发送/部署/重启；未加权限或生产凭据 |
| A-G14 | PASS：43 基线 head 持久备份并恢复 43/43，main/全部自研/10 bot 分支与旧 PR 保留；最终 refs 刷新随附 |
| A-G15 | 报告/命令/实际退出/计数齐备；最终 PR、Head、Actions 与最终计数写入 PR 说明供 ChatGPT 审查 |

ChatGPT 需审查固定 Head、锁变化、CI 与两项冻结断言的后续处置。核心 gate 失败期间维持具体 BLOCKED；独立真实 Org/UAT 仍 NOT_TESTED。没有自动合并、部署或生产重启。

补充检查：全 diff 的 git diff --check 退出 2，两处诊断为原 Git blob 归档的 upstream-workflow-reference/test.yml:10 尾部空白、原附件 taskbooks/SFOA_P11_Phase1_Codex_Taskbook_20261019.md:614 末尾空行；排除这两类原文副本的活动文件检查退出 0。保持原文 SHA，没有改写附件/归档或把全命令伪报成功。

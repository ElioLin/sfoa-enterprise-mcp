# SFoA Enterprise MCP 第一阶段稳定性收口与 Codex 任务书

版本日期：2026-10-19（Asia/Shanghai）
阶段代号：P11
当前执行批次：P11-A
审查基线：main@12df237f7ab03c4771109813b84f715a29e9e32d
目标仓库：https://github.com/ElioLin/sfoa-enterprise-mcp
文件性质：规划与实施要求；尚未实施，不代表任何代码、CI 或真人验收已经通过。

## 1 已确认的协作方式和长期阶段

用户负责业务方向、环境和真人验收，并决定正式上线。ChatGPT 负责主要规划、详细任务需求、架构与范围约束、GitHub 审查和验收结论。Codex 负责完整代码实现、SQL/脚本、测试、证据整理及 GitHub 提交。

Codex 完成后提交可审查分支和 PR，由 ChatGPT 对真实 diff、最终 SHA、CI 和验收证据审查。实现完成、审查通过、合并、测试环境部署、真人 UAT 和生产发布分别记录。

| 阶段 | 已确认目标 |
| --- | --- |
| 第一阶段 稳定性收口 | 冷构建与依赖锁定、工作流治理、分支盘点、治理配置故障隔离、附件生命周期、分析完整性契约和状态矩阵 |
| 并行验证 内嵌路线比较 | 对比原生 SFoA Model Studio Agent 与自建 LWC，验证可信身份、内网、自建 MCP、政策、确认和审计 |
| 第二阶段 Action MVP | 受控动作目录、授权、准备/执行/回查，一个 Flow 与一个 Invocable Apex |
| 第三阶段 Salesforce 内嵌试点 | 当前记录上下文、动作交互、结果链接与界面刷新，真实业务用户闭环 |
| 第四阶段 多步任务与运营 | 跨步骤状态和恢复、更多动作、模型与 Skill 回归、成本和耗时治理 |

本轮只执行 P11-A。P11-B、P11-C 的详细要求是后续批次基线，不在 A 中提前修改运行时。内嵌路线 PoC 和 Flow/Apex 开发不属于本轮。

## 2 第一阶段拆分和完成条件

| 批次 | 内容 | 允许的业务变化 | 交付状态 |
| --- | --- | --- | --- |
| P11-A | 构建编排、现有依赖锁定、CI、上游自动化适配、分支与 PR 盘点、工程文档 | 不修改业务实现、权限、工具 Schema 或依赖声明版本 | 提交后待审查 |
| P11-B1 | 可信治理快照中的局部能力故障隔离 | 修复已确认的局部配置影响全部请求问题；合法配置行为保持 | A 审查后推进 |
| P11-B2 | 附件 FAILED、TTL、配额、并发领取、UNKNOWN 和共享截止 | 修复已确认的异常及重复发送风险；公共工具契约保持 | 按独立提交审查 |
| P11-C | 完整性口径、Skill/Playbook 一致性、业务回归与阶段收口 | 修正错误的证据解释，不擅自改写查询范围 | 前置修复后推进 |

“现有逻辑不能受影响”在本阶段的工程约束是：有效配置下已验证的业务行为、身份、权限、工具契约、正常结果和副作用保持。修复异常路径时必须列出修复前后差异及回归证据，不能用这句话掩盖会改变行为的改动。

第一阶段整体不能因为 P11-A CI 变绿就标记 COMPLETE。

## 3 本次只读取证的事实

### 3.1 GitHub 冷构建失败

当前 main 与 feature/admin-btit-scoped-account 同为上述 SHA。

失败运行：https://github.com/ElioLin/sfoa-enterprise-mcp/actions/runs/38713912780
代表作业：https://github.com/ElioLin/sfoa-enterprise-mcp/actions/runs/38713912780/job/116351960904

Linux 的三个 Node 版本安装步骤成功，yarn build 失败，yarn test 未执行。代表错误为 admin-api 构建时找不到 @sfoa/control-plane、@sfoa/identity-runtime、@sfoa/mcp-server 及对应声明文件。

根 package.json 的 build 为 yarn workspaces run build，未保证依赖先于使用方完成构建。当前共有 21 个 workspace。不要把根命令描述为显式并行构建；当前明确问题是依赖编排不完整。

### 3.2 锁文件与现有声明脱节

当前 sfoa-admin-web 已声明 antd 6.6.1、@ant-design/icons 6.3.2、React/React DOM 19.2.8、react-router-dom 7.18.2、@tanstack/react-query 5.102.0；提交的 yarn.lock 没有覆盖这些完整声明，部分其他精确 selector 也缺少。

生产部署文档已经记录服务器曾补齐锁文件而仓库尚待同步。因此允许修复 yarn.lock，不能要求其字节完全不变；同时不允许借此升级 manifest 中的版本声明。

现有 workflow 使用普通 yarn，安装过程可以隐式补充 lock。现有 lockfile-check 通过不等于全仓 manifest/lock 一致。

### 3.3 上游自动化确实不完全适用

- automerge 每日定时四次，调用 salesforcecli/github-workflows 的自动合并流程；最近失败包含 Resource not accessible by integration。
- devScripts 每周定时更新上游开发脚本，最近运行失败；具体 secret/权限根因尚不足以确定。
- main push 会触发上游 release/provider 发布链。
- failureNotifications.yml 是 Slack 通知流程；本次在取得 token 的步骤失败，Slack 未发送。
- 个人收到的 GitHub 邮件受 Actions/Dependabot 通知设置影响；没有读取用户邮箱，不能把每封邮件归到某一条 run。
- secrets: inherit 只传递调用方可用的 secrets，不会赋予 Salesforce 官方组织的 secrets。
- 不要补 Salesforce 官方 bot/NPM 发布权限来“修绿”不需要的发布或自动合并。

### 3.4 当前分支事实

仓库 private=true、fork=false；它是保留官方历史演进而来的独立私有仓库。fork=false 不否定其官方代码来源。

远端当前共 43 个分支：main 1 个、自研功能/修复分支 32 个、Dependabot 分支 10 个。

自研分支中，30 个为 main 祖先、1 个与 main 相同；feature/sfoa-attachment-capability-probe 另有 3 个 main 未包含提交。10 个 Dependabot 分支各有关联 open PR 和 1 个独有提交。它们是本仓库的依赖更新，不能称为 Salesforce 官方远程分支。

本轮保留全部自研分支。10 个机器人分支先做明确评估和恢复方案，不自动删除未合并代码、关闭 PR 或合并依赖更新。

GitHub API 不能读取开发机真实 origin/upstream 配置。所有分支 protected 字段为 false；规则集读取受限，不能据此断言不存在所有保护规则。

## 4 P11-A 的总约束

### 4.1 可以修改

- 根 package.json 的工程 scripts 字段。
- 新增小型构建编排脚本及必要的工程测试。
- scripts/p5-dev.mjs、scripts/validate-p5.mjs、p5:e2e:fullstack 的前置构建调用。
- .github/workflows 与 .github/dependabot.yml。
- 当前依赖声明所需的 yarn.lock 窄范围同步。
- 对应工程文档、上游修改矩阵、维护 Skill 的工程说明及其生成副本。
- 需要时增加分支盘点的只读脚本；不要求建设通用 Git 清理平台。

### 4.2 本批冻结

- packages/*/src/** 中的业务实现及现有业务测试断言。
- 所有已应用的迁移 SQL、数据库模型和运行时配置默认值。
- MCP 工具名、输入/输出 Schema、协议、权限和错误语义。
- USER_BOUND、Buntu、WeCom 身份链路，USER/DIAGNOSTIC 隔离。
- DML、附件、Dynamic Forms、诊断、审计业务实现。
- manifests 中的依赖声明版本、package 名称、exports、engines、nohoist、workspace 解析规则。
- 官方 Provider、Tool、SDK、stdio 实现与许可证、历史来源记录。
- 生产服务、生产数据库、线上工具开关和任何生产 Salesforce 写入。

修复业务 import、加 any、跳过类型检查、增加 skip/continue-on-error、删除失败测试、减少完整构建包范围，都不属于本批可接受方法。

如果发现独立业务源码缺陷导致原测试失败，记录可复现证据和最小修复建议，继续完成其余不受阻任务；不得偷偷扩大到 P11-B。严格冻结不允许伪造“全部通过”。

## 5 P11-A 可直接执行的详细任务

### A00 读取基线并建立隔离工作分支

必须阅读：

1. AGENTS.md。
2. .agents/skills/sfoa-mcp-maintainer/SKILL.md 及与工程、测试、部署有关的引用。
3. docs/sfoa/PROJECT_BASELINE.md。
4. docs/sfoa/ARCHITECTURE.md。
5. docs/sfoa/MCP_ENGINEERING_RULES.md。
6. docs/sfoa/UPSTREAM_STRATEGY.md。
7. 涉及包的 README/DEVELOPING、当前 workflows、所有 workspace manifests 与构建配置。

本批没有工具契约设计；若后续进行 P11-B/C 的 MCP 契约检查，再按 AGENTS 阅读 mcp-builder，并以仓库当前合同为准。

检查工作区未提交改动、worktree、实际 remote 的 fetch/push URL。输出 URL 前隐藏可能包含的凭据。重新 fetch origin 的必要引用，核验公司仓库身份与最新 origin/main。

建议新分支：feature/p11a-reproducible-ci。

若已有用户工作，使用独立 worktree/checkout；不 reset --hard、不覆盖、不强推。不要为了恢复本文件的旧 SHA 而丢弃新提交。记录新的基线和相对本次审查点的差异。

为后续审查记录：基线 SHA、workspace 清单、关键业务源文件树摘要、依赖声明快照、运行时支持版本及现有 CI 触发清单。

### A01 复现并分别记录安装与构建问题

在真正干净的工作副本中验证，无既有 node_modules、dist/lib、tsbuildinfo 和 Wireit 构建产物。

固定 Node 与 Yarn。现有 MCP 部署记录使用 Node 22.23.1，Yarn 为 1.22.22；不要将 OpenClaw 自己的 Node 24 基线混入 MCP。若发现更新的已批准基线，记录依据后沿用，不能用 lts/* 默默漂移。

先记录 frozen install 的结果，再记录构建失败。网络、代理、安装权限、Node 不满足 engines 与 TypeScript 源码问题分别分类。

现有 skill:smoke 只做 Skill 工具包的干净副本验证，没有安装全仓依赖或编译 21 个 workspace，不能作为本任务冷构建证据。

不依赖真实 Salesforce 凭据完成核心构建验证，不用复制服务器 node_modules 或手工补链接掩盖工程问题。

### A02 修复依赖锁定

目标：当前所有依赖声明保持不变，并由同一份根 yarn.lock 可重复安装。

1. 使用 Yarn Classic 1.22.22。
2. 在隔离副本中基于现有锁文件同步缺项。
3. 保留仍有效的已锁定 resolution；不要删除整份锁重新解析。
4. 不合并旧 Dependabot PR，不升级 SDK、Salesforce core、React、Vite、TypeScript 等声明。
5. 逐项说明新增直接依赖、传递依赖，以及改变的已有 resolution。
6. 对新增解析到的运行依赖给出其来源与影响范围；不能只用“manifest 没改”证明实际运行依赖绝对相同。
7. 不引入 npm/pnpm 锁文件、Yarn 新版本或新的依赖管理框架。
8. 最终运行 yarn install --frozen-lockfile --non-interactive，随后核对 manifest 和锁文件无未预期修改。
9. 不用 --ignore-engines 或降低类型严格度让安装/构建绕过失败。

如果某个当前声明确实无法满足其 engines 或存在不可解决的依赖冲突，给出具体包与证据，不能擅自改版本。

### A03 建立唯一的构建编排入口

建议新增 scripts/build-workspaces.mjs，使用 Node 标准库和仓库已有工具完成，不增加 Nx/Turbo 等框架。

实现要求：

- 读取实际 workspace manifests，建立稳定的构建依赖图。
- 同时检查现有 TypeScript project references、Wireit 声明和构建前置依赖。
- 尊重 Yarn 实际的本地 workspace 与已发布包解析关系；版本不匹配时不能强制改成本地包。
- 根 yarn build 继续构建全部 21 个 workspace；新增包时根据实际清单覆盖，不能硬编码“只成功的包”。
- 每个包执行其原有 build 脚本，保留资源复制、Wireit、tsc --build 等行为。
- 依赖必须先完成，随后再构建使用方。优先顺序执行；后续并行优化不是本批目标。
- 失败立即停止，返回真实非零退出码，清晰输出失败 workspace。
- 支持一个 SFoA 专用目标及其传递依赖闭包，例如新增 build:sfoa。
- 全仓入口与 SFoA 入口使用同一张依赖图，禁止再维护相互漂移的两份手工序列。
- 处理依赖环、缺失 workspace、无 build 脚本的显式语义和构建失败传播。
- 对顺序、闭包、环检测和失败传播做必要的工程测试；不写只镜像实现的冗余测试。

保留当前 package versions、nohoist、exports 和官方实现。不要通过修改业务源码 import 路径消除 TS2307。

### A04 统一开发和测试脚本的前置构建

当前 p5-dev 只先编 control-plane、mcp-server、admin-api；新包依赖闭包没有完整覆盖。

将以下位置的前置构建接入 A03 公共入口：

- scripts/p5-dev.mjs。
- 根 p5:e2e:fullstack。
- scripts/validate-p5.mjs。
- 其他确认存在的重复构建清单。

严格保持 p5-dev 后续行为：配置加载、端口与 Origin 校验、服务启动顺序、健康检查、日志、Ctrl+C、SIGTERM、Windows 子进程清理。

当前仓库没有 scripts/p5-release.mjs，不要把它当成已有文件，也不需要为此任务新增生产部署器。

部署文档当前 PROD 与 TEST 的手工构建序列不一致，TEST 漏了 data provider。统一引用经过验证的新工程命令，保留历史部署记录，避免把当时的记录改写成今天已执行的事实。

### A05 整理 GitHub Actions

优先适配现有 test.yml 及可复用测试 workflow，形成一条清楚、稳定的本项目核心 CI。也可新建 sfoa-ci.yml，但必须避免旧自动 tests 仍重复触发、旧必要覆盖消失或 required checks 永久 Pending。

核心触发要求：

- pull_request，目标 main。
- push，目标 main。
- workflow_dispatch，供文件已存在于默认分支后的主动验证。
- 新 workflow 尚未进入 main 时，通过 PR 实际触发验证，不能假定可直接手动运行新文件。
- 不把核心工作流全部按 paths 跳过而造成 required check 缺失。
- 同一 PR 的过时执行可取消；独立分支和当前 main 验证不能相互误取消。

最低权限为 contents: read；确有必要的读取权限按 job 增加。没有公开发布或自动合并需求，不得使用全局 write-all，不新增 NPM/官方 bot 凭据。

核心 CI 至少实际执行：

1. 固定版本的工具链准备。
2. frozen install。
3. 全仓完整构建。
4. 现有默认 workspace 测试。
5. MCP 专有 P3/P4/P5/P7 套件；它们不等于默认 test 的目录。
6. 独立临时 MySQL 的 control-plane 与 MCP integration。
7. Admin Web 单测，以及现有 fake Salesforce fullstack/E2E 场景。
8. Skill 与 Agent 生成物同步、漂移和测试。
9. 稳定的总结果 gate，验证 required jobs 真正成功，而不是 skipped。
10. 有限、脱敏的失败日志和测试报告产物。

至少保留 Linux 与 Windows 的真实冷构建。Windows 上官方 analyzer 的 cp 等脚本可通过 Git Bash/正确 shell 兼容，不修改 Provider 业务实现。保留上游 analyzer 测试实际需要的 Java 环境，并记录其用途；用户本机 Java 17 与该测试前置要求不应混为一谈。

可缓存下载的包文件，不能用恢复 node_modules/dist 来冒充冷构建。至少一次在没有构建缓存的环境验证。

MySQL 使用 CI 自己的临时 MySQL 8 测试服务和独立数据库，固定项目兼容版本。读取现有测试需要的环境变量；禁止复用真实生产 DB 配置。现有测试缺 DB 参数时可能 SKIP 且退出 0，门禁必须检测目标套件实际运行，不能把 0 个测试或全 SKIP 算通过。

P0/P1/P2 真实 Org 验证、官方依赖外部 Salesforce 环境的 E2E 独立 opt-in，未运行应标为 NOT_TESTED/NOT_CONFIGURED。不得为了运行 CI 随意连接生产 Org。

上游已有 lint 问题应保留明确基线和责任范围；不做整仓风格重写，也不能把任何新的 SFoA 问题假称旧基线。若既有业务测试失败，在报告中给出同环境基线对照，不以 skip 或改断言掩盖。

### A06 处置现有 14 个 workflow

| 现有文件 | 本批处置要求 |
| --- | --- |
| test.yml | 适配核心 CI 触发、覆盖和结果 gate |
| tempUnitTestsLinux.yml | 固定版本、frozen install、完整构建、真实测试 |
| tempUnitTestsWindows.yml | 保留 Windows 冷构建/测试，明确 shell |
| e2e.yml | 与核心无凭据 CI 分开，保留明确 opt-in 的真实环境验证 |
| validate-pr.yml | 保留有价值的元数据规则；不能代替代码测试；必要时本地化 |
| automerge.yml | 取消每日定时自动合并；当前交付需要审查后合并 |
| devScripts.yml | 取消每周自动更新；上游同步改为独立审查任务 |
| create-github-release.yml | 移除当前不适用的 main/prerelease 自动发布链 |
| onRelease.yml | 停止 release 触发官方 npm 发布 |
| publish-providers.yml | 停止 main provider 路径变化触发官方 npm publish/git push |
| publish-mcp-server.yml | 当前已手动；归档或加入明确禁用防护，避免误发官方包 |
| promote-mcp-server.yml | 当前已手动；归档或明确禁用，不配置官方 runner/发布凭据 |
| failureNotifications.yml | 当前是上游 Slack 通知；没有本项目通知配置时退出活动范围 |
| notify-slack-on-pr-open.yml | 无本项目业务需求时退出活动范围，不发送消息 |

不需要的上游 workflow 可完整移到 docs/sfoa/upstream-workflow-reference/ 保留来源，并从活动 workflow 目录移除；也可使用清楚且可靠的禁用方式。记录每个文件的原触发、处置理由、保留的质量覆盖和未来恢复方式。

对于有意保留的第三方 action/reusable workflow，应核验并固定版本或提交，不能继续无审查依赖远端 @main。不要为了“统一升级”一次更新所有 actions 主版本。

GitHub 自身失败邮件由用户通知设置决定。本批修复真实失败并停止不适用的自动任务，不修改个人邮件设置、不发送 Slack/邮件。停止噪声不等于隐藏核心 CI 失败。

### A07 调整 Dependabot 策略

当前配置仅逐目录覆盖 4 个官方包，未体现当前根 Yarn workspace/共享 lockfile 拓扑。

建议本批采取以下政策：

- 按根 workspace 和共享锁文件重新确认覆盖方式，避免重叠目录互相竞争同一 lock。
- 稳定性收口期间暂停例行 npm 版本升级 PR，采用适用的 open-pull-requests-limit: 0；这个设置不等于关闭安全更新。
- 保留现有安全告警和安全更新设置，不臆称它们已经启用；权限或产品限制不能通过降低安全功能来绕过。
- GitHub Actions 依赖更新可采用低频、小数量、人工审查的独立分组，例如每月、最多 2 个 PR。
- P11 收口后再恢复受控的 npm 版本更新节奏，写入维护规则。
- 不在本轮合并已有 SDK/React 等升级，不自动合并任何依赖 PR。
- 核验当前 GitHub 官方 Dependabot 配置规则，避免“根目录写上了”却没有覆盖实际 manifests。
- 调整计划不会自动证明旧 PR 无价值；现有 10 个 PR 另列清单。

暂停普通版本更新是本轮减少漂移的工程安排，不改变当前部署依赖。若当前某项为安全更新，不能仅因它来自机器人就丢弃。

### A08 分支盘点与可恢复清理方案

本批执行只读盘点和备份验证，保留 main、全部 32 个自研分支及所有未决 PR。不得按作者名或分支名前缀批量删除。

输出每个分支：

- 真实远程仓库。
- 完整分支名及当前 head SHA。
- 相对最新 main 的 ahead/behind/ancestry。
- 是否有独有提交及其内容类别。
- open PR 的 head/base 关系。
- 保护/规则集的可读取结果。
- 仓库内实际发布/部署/回滚引用。
- 已确认与尚未检查的外部引用。
- KEEP / EVALUATE / READY_TO_DELETE 分类及理由。
- 所需恢复手段。

对 10 个 Dependabot PR，判断已有更新是否被其他方案覆盖、是否仍适用、当前锁文件解析和安全告警关系；不能根据 package.json 的版本下限推断实际安装版本。

后续如具体清理条目获确认：

1. 在独立目录镜像读取目标仓库，记录完整 refs。
2. 创建包含所有相关 refs 和 objects 的自包含 Git bundle。
3. git bundle verify 后在独立临时目录恢复，核对待删 head。
4. 备份保存到受控持久目录，不只留下 SHA 文本，也不只留在会被清空的临时目录。
5. 处理关联 PR 的去向；未明确的更新保留。
6. 精确检查完整 refs/heads 名称和预期旧 SHA；若 head 改变，重新评估。
7. 先 dry-run，再使用带明确 lease 的精确 ref 删除。禁止 --mirror 推送、通配删除、强制重写历史和远程 prune 式推送。
8. 核对 main 的 SHA/tree 和所有保留分支的 head 未变。
9. 记录可能由删除事件触发的 Actions；不能仅因没看到 on: delete 就断言无自动化副作用。

当前本任务书中的 10 个候选均有独有提交和 open PR，因此 P11-A 不执行删除、不关闭这些 PR。分支处置未决不妨碍构建与 CI 修复交付。

删除分支引用与删除 main 中的官方代码完全不同；保留官方实现、许可证、上游历史和来源说明。不要移除 upstream remote 作为 CI 修复手段；本地 remote 设置另按真实 URL 判断。

### A09 同步工程文档并提交审查

建议新增：

- docs/sfoa/P11_PLAN.md：用户已确认阶段、分工、A/B/C范围和验收状态。
- docs/sfoa/P11A_IMPLEMENTATION_REPORT.md：根因、逐文件改动、workflow政策、锁文件解析变化、测试与残余项。
- docs/sfoa/P11_BRANCH_INVENTORY.md：完整分支/PR清单和恢复方案。

更新已有工程说明：

- UPSTREAM_STRATEGY.md 的修改矩阵，记录根命令、锁文件和 workflow 的必要差异。
- PROJECT_BASELINE.md、相关 README、CHANGELOG 的当前工程状态。
- PROD_SERVER_DEPLOYMENT.md 与 TEST_SERVER_DEPLOYMENT.md 的现行构建指引；历史记录原义保留。
- canonical skills/sfoa-mcp-maintainer 的工程知识，随后执行 skill:sync、skill:check、skill:test 等既有门禁。
- 若 Agent 生成内容未改，不人为修改业务 Playbook 版本；依现有命令检查漂移。

建议按根因分为少量独立 commits：构建编排、锁文件同步、CI/自动化、工程文档。保持可审查，不 squash 或改写用户既有历史。

推送 feature/p11a-reproducible-ci 并创建以 main 为 base 的 PR。新的 CI 要在这个真实 PR 上运行。提交后报告最终 HEAD 的 Actions 状态；若报告提交改变了 HEAD，需核验该新 HEAD 的必要检查。

不自动合并 main，不执行生产部署。用户要求由 ChatGPT 完成最终审查；本批完成状态使用 READY_FOR_REVIEW，不自行把 P11 全阶段写成 COMPLETE。

## 6 P11-A 验收矩阵

| 编号 | 验收项 | 通过条件 |
| --- | --- | --- |
| A-G01 | 基线和范围 | 起始/最终 SHA、diff 可核验；业务 src、迁移和依赖声明没有变化 |
| A-G02 | 依赖锁定 | 固定 Yarn 的 frozen install 成功，安装后 manifest/lock 无隐式修改 |
| A-G03 | Linux 冷构建 | 无残留产物下全部 workspace 成功 |
| A-G04 | Windows 冷构建 | 明确 Node/shell 环境下全部 workspace 成功 |
| A-G05 | 构建编排 | 顺序、闭包、环与错误传播正确，根 build 不少包 |
| A-G06 | 默认测试 | 原有 workspace test 真正执行，失败不被吞掉 |
| A-G07 | 专有测试 | P3/P4/P5/P7 等目标测试按实际脚本执行并计数 |
| A-G08 | MySQL | 临时真实 MySQL 套件实际运行；全 SKIP/0测试不能通过 |
| A-G09 | Admin | 原单测和 fake Salesforce fullstack/E2E 可运行，未使用生产配置 |
| A-G10 | 开发启动 | 依赖闭包编译后，保持启动、健康检查和退出行为 |
| A-G11 | 生成物 | Skill/Agent 现有检查通过，无意外业务指导变化 |
| A-G12 | CI事件 | PR/main触发核心门禁；非必要上游日程和发布链不再自动执行 |
| A-G13 | 权限和发布 | 未添加自动合并/公开发布权限，未发送消息，未部署重启 |
| A-G14 | 分支 | 43条基线逐项可追踪；main和自研分支保留；独有提交未丢弃 |
| A-G15 | 审查交付 | PR、最终SHA、运行链接、命令/退出码/执行与跳过数齐全 |

最少的命令结果清单应包括：node --version、yarn --version、yarn install --frozen-lockfile --non-interactive、yarn build、yarn test、必要专有测试、MySQL integration、Admin fullstack、skill:validate、skill:check、skill:test、skill:smoke、agent:check。以当前包 scripts 的真实名称执行，不编造脚本。

A-G10 若缺少启动所需测试环境，可用既有 fake fullstack 验证相关行为，并准确注明实际采用的路径；不能写成已在生产运行验证。

如果核心工程门禁有新失败，状态为 BLOCKED_BY_<具体原因> 并给出证据。若只是独立真实 Org UAT 未执行，明确为 NOT_TESTED，不冒充机器核心 gate 失败或成功。

## 7 P11-B1 后续规格 治理配置局部故障隔离

目标：完整可信快照读取成功后，某类能力缺少必要配置只影响该能力，合法用户读请求继续。

优先在 SFoA 自有代码增加一个纯的有效能力计算方法，复用现有治理模型，不新建通用框架。

内部区分：

- configuredToolNames：数据库保存的启用意图。
- effectiveToolNames：当前请求实际可广告、可执行的能力。
- blockedTools：工具与现有稳定错误码/具体缺依赖原因。

依赖不足时：

- 缺少某类 CREATE/UPDATE 的有效对象授权，相关写工具不可执行；逐操作过滤的对外清单变化须明确列为本缺陷修复，并与有效配置基线对照。
- 没有附件授权或 Ingress 未启用，仅附件不可用。
- DIAGNOSTIC 配置关闭/不存在，仅依赖诊断身份的工具不可用。
- 不自动修改数据库开关，不开新对象，不回退其他账号。

同一有效能力集合用于 discovery、tools/list、注册与tools/call、角色选择、Instructions/Playbook及审计。不能只隐藏清单但保留直调权限。

MySQL读取/事务/快照完整性失败、认证失败、路由无效、身份冲突、未知官方工具、upstream合约漂移、非法环境/密钥/Host错误继续沿用原fail-closed语义。不得 catch 后用空策略、环境管理员、旧缓存或无权限快照兜底。

Admin 应清楚呈现“配置启用”与“当前可执行”的差别，复用 dependencies/disabledReason。保留 rowVersion、审计和现有API字段含义。管理员撤销最后一项写权限应合法生效，不能为避免旧崩溃而禁止撤权。可做保存影响预览；不得静默重新打开权限。

范围文件包括：dml-tool-governance.ts、attachment-tool-governance.ts、discovery-server.ts、provider-runtime.ts、http-server.ts 的已确认检查点，以及必要Admin状态说明。

必须覆盖：

- 全部写权限关闭时读正常，写不广告且直调拒绝。
- 仅CREATE、仅UPDATE、仅附件授权各自独立。
- Ingress关闭或诊断配置关闭时局部不可用。
- 最后授权关闭/恢复在下一请求生效，无需重启。
- MySQL失败零SF调用，原身份安全阻断保持。
- WeCom仅渠道凭据的发现与执行身份要求保持。
- 合法配置的工具清单、输入输出、身份和实际调用结果无意外差异。

## 8 P11-B2 后续规格 附件可靠性

当前明确缺陷：FAILED不能按承诺重试，FAILED不在内置TTL和容量查询范围；缺少数据库原子领取，外层Promise.race也不会阻止超时后的后续文件发送。

公共契约保持：

- 工具名 upload_files_to_record。
- 入参仍为 objectApiName、recordId、attachmentRefs。
- 单记录、1–10文件。
- 现有公共逐文件/聚合状态、isError、计数和错误转述保持。
- 内部状态和attempt字段不成为客户端必填参数。
- 保留当前USER、附件独立授权、属主隔离和目标记录校验。

建议在原暂存表做最小向前迁移。014中的state为ENUM，不修改已应用014；新增下一可用迁移版本。

| 内部状态 | 行为 |
| --- | --- |
| STAGED | 有效未发布，可被一个执行者原子领取 |
| UPLOADING | 已领取，其他请求不可发送 |
| FAILED | 确认未成功/未发送，原TTL内由新一次明确调用重新校验后可领取 |
| UNKNOWN | 可能已发送而结果不确定，不自动重发 |
| CONSUMED | 已成功，不重放 |
| EXPIRED | 可重试引用过期；未知结果的不可重发事实不能被清除 |

最小辅助字段可包含 attempt_id 和 attempt_deadline_at。字段必须有明确用途，不复用runId作为锁，不新建通用Action/Job/Workflow/Outbox平台。

关键实现要求：

1. MySQL条件更新/短事务领取，只有胜者POST；内存锁不足以处理双实例。
2. 终态更新匹配attempt标识，阻止迟到执行者覆盖状态。
3. 同ref对不同目标并发也只能一个执行者发送。
4. 领取失败时零POST；发送后持久化失败不能释放回STAGED。
5. FAILED仅来自可靠的结构化拒绝或确定未发送；超时、网关异常、不可验证2xx不能假定无副作用。
6. FAILED重试由新明确调用发起，不延长TTL，不改变属主/文件证据。
7. UNKNOWN和失联UPLOADING恢复不能自动变回可发送。
8. 已确认SF成功不能因审计/清理失败改成业务失败。
9. TTL/配额统计覆盖所有仍占字节状态；不得驱逐正在上传文件。
10. UNKNOWN字节可以到期清理，但保留不可重发的结果墓碑；不诱导用户盲目重传。
11. 文件删除失败可重试，回收幂等有界，仅删除本地暂存，不删除SF文件。
12. 工具调用共享截止时间；超时后不再发送未开始的文件。已发送而未知的标OUTCOME_UNKNOWN，后续标NOT_ATTEMPTED。
13. 跨用户ref与不存在ref维持同码同文。
14. 同用户并发入站的配额检查不能被绕过；不在DB锁内进行长时间网络/文件传输。

验收须含真实MySQL+本地模拟Salesforce的双实例并发、FAILED重试/到期、UNKNOWN跨重启、领取失败、晚到结果、超时停止后续POST、清理失败重试和成功不被审计失败改写。真实生产故障不作为自动测试条件。

## 9 P11-C 后续规格 完整性与业务验收

统一四种口径：

| 口径 | 含义 |
| --- | --- |
| Population | 用户问题指向的业务全集 |
| Fetch | 服务端实际读取范围 |
| Analysis | 真正进入统计或语义分析的范围 |
| Display | 最终向用户展示的范围 |

保留当前totalSize/fetched/returnedCount/complete/truncated等字段含义；不改正常计数算法，不新增由Provider猜测的analyzedCount。returnedCount只表示交给Agent的行数，不自动等于最终展示数或已分析数。

优先修Tool description、既有hint、Playbook和业务Skill。Provider不能知道外部Agent是否真的处理了每一行。

必须明确：

- 当前查询完整不等于业务全集完整。
- 用户要求最近10条时，LIMIT10可以完整回答该范围；不得机械移除LIMIT。
- 不自动改写WHERE，不给每个简单查询强加COUNT。
- 相同WHERE的SUM/COUNT可以支持全量统计，明细可只展示TopN。
- GROUP BY结果也可能受预算/组数限制，不能笼统宣称聚合总是完整。
- Bulk作业处理数不等于Agent实际取完/分析完的数量。
- 重复读取游标页不重复计算覆盖率。
- 全集数量没有证据时明确未知。

重点反例：

1. COUNT76、LIMIT50，不能用50条推导76条金额或日期。
2. fetched37010、returnedCount474、RESPONSE_BUDGET，不声称已分析37010条明细。
3. COUNT为0、records为空时不能误判计数证据缺失。
4. 完整聚合与展示TopN并存时正确说明口径。
5. Bulk完成只读第一页时不得称分析完成。
6. 分组结果截断、游标重复、客户/时间范围变化后复用旧样本须被识别。

更新canonical Skill与Playbook后执行既有生成/同步/漂移门禁；版本按仓库现行规则管理。

业务回归以“用户语言→正确目标→工具证据→Salesforce最终状态→用户回复”为单位。记录模型、Skill/Playbook、工具配置和数据范围。Skill已被读取、工具成功、业务结果正确分别留证据。

第一阶段的状态矩阵至少覆盖：身份与渠道、查询/Bulk、单批CREATE/UPDATE、默认值与Owner回退、Picklist中文label、Dynamic Forms CREATE、附件、诊断、Admin权限、审计。历史记录不能被复制成新UAT通过。

## 10 明确延期的内容

本阶段不开发：

- Salesforce LWC聊天助手或原生Agent正式部署。
- Flow/Invocable Apex/标准Action执行器。
- 任意Apex匿名执行入口。
- 通用Action Registry或全局业务幂等平台。
- 跨多次DML事务、自动补偿或通用长任务平台。
- 全面复制Lightning页面的表单引擎。
- 普通业务用户诊断权限体系的全面重构。
- MCP协议、SDK、模型、前端框架的大版本升级。

这些保持后续阶段边界；若出现必须紧急修复的新问题，单列事实、影响和建议，不混入本批。

## 11 Codex 最终交付格式

最终回复必须包含：

1. 实际执行批次与范围。
2. 起始SHA、最终SHA、分支、PR链接。
3. 根因结论和逐文件改动摘要。
4. 业务src/迁移/依赖声明冻结的核对结果。
5. 锁文件resolution变更说明。
6. 每条workflow的保留、适配、归档与原因。
7. 分支/PR清单与保留/候选结论，注明未执行删除。
8. 命令、退出码、执行/跳过测试数和GitHub Actions URL。
9. 新旧失败的分类、未执行的真实Org/UAT及原因。
10. 是否满足P11-A、后续P11-B/C的具体进入条件。

只把经过实际验证的项目写为PASS。没有权限或环境时，完成其他已授权工作，报告具体阻断。不要要求用户重新确认已明确的正常开发步骤；合并/生产发布仍按既定审查流程处理。

## 12 给 Codex 的启动指令

请完整阅读本文件，先执行P11-A的A00–A09及A-G01–A-G15，不提前实施P11-B/C。

你的职责是完成工程修复、真实验证并提交GitHub供审查，不是只给建议。保持所有现有业务运行时实现和对外契约。先复核当前main及实际工作区，再在隔离分支实施。

如果发现证据与本文件不同，以当前源码、日志和测试事实为准，说明差异并遵守同一目标；不要机械沿用过期SHA、路径、工具数量或版本。不得以关闭全部CI、减少包范围、跳过失败测试或更新SDK来制造成功。

完成后以READY_FOR_REVIEW交付，不自动合并、不部署、不重启、不删除现有未合并分支。

## 13 主要证据与官方规则

- [审查源码](https://github.com/ElioLin/sfoa-enterprise-mcp/tree/12df237f7ab03c4771109813b84f715a29e9e32d)
- [失败的tests运行](https://github.com/ElioLin/sfoa-enterprise-mcp/actions/runs/38713912780)
- [代表Linux构建日志](https://github.com/ElioLin/sfoa-enterprise-mcp/actions/runs/38713912780/job/116351960904)
- [根工程脚本](https://github.com/ElioLin/sfoa-enterprise-mcp/blob/12df237f7ab03c4771109813b84f715a29e9e32d/package.json)
- [Admin Web实际依赖声明](https://github.com/ElioLin/sfoa-enterprise-mcp/blob/12df237f7ab03c4771109813b84f715a29e9e32d/packages/sfoa-admin-web/package.json)
- [当前锁文件](https://github.com/ElioLin/sfoa-enterprise-mcp/blob/12df237f7ab03c4771109813b84f715a29e9e32d/yarn.lock)
- [开发启动前置构建](https://github.com/ElioLin/sfoa-enterprise-mcp/blob/12df237f7ab03c4771109813b84f715a29e9e32d/scripts/p5-dev.mjs)
- [现有工作流](https://github.com/ElioLin/sfoa-enterprise-mcp/tree/12df237f7ab03c4771109813b84f715a29e9e32d/.github/workflows)
- [Dependabot配置](https://github.com/ElioLin/sfoa-enterprise-mcp/blob/12df237f7ab03c4771109813b84f715a29e9e32d/.github/dependabot.yml)
- [上游策略](https://github.com/ElioLin/sfoa-enterprise-mcp/blob/12df237f7ab03c4771109813b84f715a29e9e32d/docs/sfoa/UPSTREAM_STRATEGY.md)
- [部署记录中的锁文件漂移](https://github.com/ElioLin/sfoa-enterprise-mcp/blob/12df237f7ab03c4771109813b84f715a29e9e32d/docs/sfoa/PROD_SERVER_DEPLOYMENT.md#L567-L568)
- [附件探测分支独有提交](https://github.com/ElioLin/sfoa-enterprise-mcp/compare/12df237f7ab03c4771109813b84f715a29e9e32d...66a86c7aba3de05982e8376fc4bccb62150f83cd)
- [Yarn Classic install规则](https://classic.yarnpkg.com/en/docs/cli/install)
- [GitHub Actions通知设置](https://docs.github.com/en/subscriptions-and-notifications/how-tos/managing-github-actions-notifications)
- [Dependabot选项](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
- [Git分支引用](https://git-scm.com/book/en/v2/Git-Branching-Branches-in-a-Nutshell)
- [Git bundle备份与恢复](https://git-scm.com/docs/git-bundle)
- [GitHub删除和恢复PR分支](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-branches-in-your-repository/deleting-and-restoring-branches-in-a-pull-request)
- [GitHub工作流事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)

## 附录 A 当前 43 个远端分支清单

取证时间：2026-10-19。执行前必须刷新，下面的SHA不是以后删除操作的永久授权。

| 分支 | Head SHA | 当前处置 |
| --- | --- | --- |
| dependabot-npm_and_yarn-packages-EXAMPLE-MCP-PROVIDER-eslint-js-tw-9.39.5 | 729629891b023184cbf345d7a6d4d94e03d52db3 | EVALUATE 保留至PR #1处置明确 |
| dependabot-npm_and_yarn-packages-EXAMPLE-MCP-PROVIDER-modelcontextprotocol-sdk-tw-1.30.0 | ec9d9bfec725a720178a1aa4eb8a316d241daeb7 | EVALUATE 保留至PR #5处置明确 |
| dependabot-npm_and_yarn-packages-EXAMPLE-MCP-PROVIDER-typescript-eslint-tw-8.67.0 | c0f75dbf1d68107dbd1e4e0f16fda51b876561e5 | EVALUATE 保留至PR #3处置明确 |
| dependabot-npm_and_yarn-packages-EXAMPLE-MCP-PROVIDER-vitest-coverage-istanbul-tw-3.2.7 | 5665e57a337384dced54c59defe6d55aedddf5e8 | EVALUATE 保留至PR #2处置明确 |
| dependabot-npm_and_yarn-packages-EXAMPLE-MCP-PROVIDER-vitest-tw-3.2.7 | 9be90b276cd4e21ab1424d0717ec37506df8a249 | EVALUATE 保留至PR #4处置明确 |
| dependabot-npm_and_yarn-packages-mcp-modelcontextprotocol-sdk-tw-1.30.0 | f65ceb709779022cd17547f183e775c7602262e6 | EVALUATE 保留至PR #6处置明确 |
| dependabot-npm_and_yarn-packages-mcp-provider-api-eslint-js-tw-9.39.5 | bd1b2a14643d7e6105a36a24200592d7010b97ba | EVALUATE 保留至PR #8处置明确 |
| dependabot-npm_and_yarn-packages-mcp-provider-api-modelcontextprotocol-sdk-tw-1.30.0 | b74666422250a1a02103f26fba365ea65e7fc5b1 | EVALUATE 保留至PR #9处置明确 |
| dependabot-npm_and_yarn-packages-mcp-provider-api-typescript-eslint-tw-8.67.0 | 85d6de58d57a9080735da72d9d68360ca93129ec | EVALUATE 保留至PR #7处置明确 |
| dependabot-npm_and_yarn-packages-mcp-provider-dx-core-modelcontextprotocol-sdk-tw-1.30.0 | cbf913edf62bbb7a4f6323afe6cfdd6b51f2db55 | EVALUATE 保留至PR #10处置明确 |
| feature/admin-btit-scoped-account | 12df237f7ab03c4771109813b84f715a29e9e32d | KEEP 自研，main已包含或相同 |
| feature/identity-route-user-name-batch | 2aafbce228184993bbda98f028e8ccef4136bb15 | KEEP 自研，main已包含或相同 |
| feature/managed-platform-user-lookup-fallback | f60a134715d639b8129af0f3160549d52dec210d | KEEP 自研，main已包含或相同 |
| feature/openclaw-concurrency-web-intelligence | 0f79a1f9f96db632b78bfb1fd9a726142c9aea22 | KEEP 自研，main已包含或相同 |
| feature/openclaw-multimodal-input | 0944b568aa8d931a127e4c4a914514a9f02b7393 | KEEP 自研，main已包含或相同 |
| feature/openclaw-sfoa-record-change-02a | ef809145f1ae6335afa0127958935952512f0b27 | KEEP 自研，main已包含或相同 |
| feature/openclaw-sfoa-record-change-02b | ce800c20fc59a77f11778728073c1af2bf2cefa1 | KEEP 自研，main已包含或相同 |
| feature/openclaw-sfoa-skill-foundation | c195afe1636e7cc235c1bbae10678c7faedf6fed | KEEP 自研，main已包含或相同 |
| feature/openclaw-test-server-baseline | a2edd92ed31292dbd2c0ac2c9d9be5a251d60439 | KEEP 自研，main已包含或相同 |
| feature/openclaw-wecom-sfoa-integration | f57f860fdf5f6468fb509ea4dd1a8812938a7b07 | KEEP 自研，main已包含或相同 |
| feature/p0-closure | e80d9fde63a64988086444fc1ae50f9c196a4021 | KEEP 自研，main已包含或相同 |
| feature/p1-request-scoped-identity | 3d35ef675d7b4e977514c18d31350a8f9bfb2902 | KEEP 自研，main已包含或相同 |
| feature/p2-remote-runtime-governance | f532c8a95ce511f8f30af7dc87c56b883c360542 | KEEP 自研，main已包含或相同 |
| feature/p3-generic-dml-allowlist | 4c3a45e3908f9c3aae47bb31e6d73c8954af71ad | KEEP 自研，main已包含或相同 |
| feature/p4-diagnosis-runtime-context | e6ae8d5936565b981fc8efc266d56e2bfe0816ec | KEEP 自研，main已包含或相同 |
| feature/p5-admin-control-plane | 3b298b3466ef8b1c57f5e6371545cb44905fb9b1 | KEEP 自研，main已包含或相同 |
| feature/p6-agent-playbook | 1fa5f5b8751acdb686d9e761fa25abe5daceed92 | KEEP 自研，main已包含或相同 |
| feature/p6-id-user-bound-credential | 482316d4ae83539854904fc7cea7cc7a2be5ac5f | KEEP 自研，main已包含或相同 |
| feature/p7-end-to-end-audit | fc33f566b11a2a02c201e1a7e61df8f1290f385d | KEEP 自研，main已包含或相同 |
| feature/p8-04-effective-ui-context | b01816da1e83767f3680e898e4f4fceb183a30af | KEEP 自研，main已包含或相同 |
| feature/p8-05-wecom-identity-channel | 7519b66eed8377a819650d96411926959e2cd8af | KEEP 自研，main已包含或相同 |
| feature/p8-06-wecom-channel-credential | 5c623ef13a88f9e20e2cf897f56b213ebcb2994e | KEEP 自研，main已包含或相同 |
| feature/p9-data-completeness | 0be4fef4aba4c210b3a0755f58eb52d89e083610 | KEEP 自研，main已包含或相同 |
| feature/p10-diagnostic-depth | 1dca49a0ea25ff2c61672048860b748a8e6b8b5b | KEEP 自研，main已包含或相同 |
| feature/sfoa-attachment-capability-probe | 66a86c7aba3de05982e8376fc4bccb62150f83cd | KEEP 自研，3个独有提交 |
| feature/sfoa-attachment-upload | 66dcac2550059b8994c651f2ab9f639ba79689e4 | KEEP 自研，main已包含或相同 |
| feature/sfoa-skill-export-package | d9f23a80bce04e36abdb9bf5df7921e405d51e69 | KEEP 自研，main已包含或相同 |
| fix/admin-copy-clipboard-http | 026df42ae31427873745dec0024b317fd1110328 | KEEP 自研，main已包含或相同 |
| hotfix/openclaw-sfoa-crm-core-data-completeness | ef6b4e25c9360727ed7e1d3737ab774f9cc08ab7 | KEEP 自研，main已包含或相同 |
| hotfix/openclaw-sfoa-record-change-02a-delivery | 345b7396a76d3bb718a94707b8323a7d915a597f | KEEP 自研，main已包含或相同 |
| hotfix/p8-07-agent-runtime-safety | 933d6ff8d5c2b9bc103dcb8e8acb99050a8f6c79 | KEEP 自研，main已包含或相同 |
| hotfix/p8-07-final-uat-closure | 3e19d9a7b480395b4670657cc231b63795231889 | KEEP 自研，main已包含或相同 |
| main | 12df237f7ab03c4771109813b84f715a29e9e32d | KEEP 主线 |

## 附录 B 10 个未合并的依赖更新 PR

这些PR均为本仓库head指向main，各有1个独有提交。本轮不合并、不关闭、不删除分支。依赖是否涉及当前安全问题需另查实际依赖路径与告警，不能从机器人名称推断。

| PR | 更新内容 | Head SHA |
| --- | --- | --- |
| [#1](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/1) | chore(dev-deps): update @eslint/js requirement from ^9.35.0 to ^9.39.5 in /packages/EXAMPLE-MCP-PROVIDER | 729629891b023184cbf345d7a6d4d94e03d52db3 |
| [#2](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/2) | chore(dev-deps): update @vitest/coverage-istanbul requirement from ^3.2.4 to ^3.2.7 in /packages/EXAMPLE-MCP-PROVIDER | 5665e57a337384dced54c59defe6d55aedddf5e8 |
| [#3](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/3) | chore(dev-deps): update typescript-eslint requirement from ^8.44.0 to ^8.67.0 in /packages/EXAMPLE-MCP-PROVIDER | c0f75dbf1d68107dbd1e4e0f16fda51b876561e5 |
| [#4](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/4) | chore(dev-deps): update vitest requirement from ^3.2.4 to ^3.2.7 in /packages/EXAMPLE-MCP-PROVIDER | 9be90b276cd4e21ab1424d0717ec37506df8a249 |
| [#5](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/5) | fix(deps): update @modelcontextprotocol/sdk requirement from ^1.18.0 to ^1.30.0 in /packages/EXAMPLE-MCP-PROVIDER | ec9d9bfec725a720178a1aa4eb8a316d241daeb7 |
| [#6](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/6) | fix(deps): update @modelcontextprotocol/sdk requirement from ^1.18.0 to ^1.30.0 in /packages/mcp | f65ceb709779022cd17547f183e775c7602262e6 |
| [#7](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/7) | chore(dev-deps): update typescript-eslint requirement from ^8.44.0 to ^8.67.0 in /packages/mcp-provider-api | 85d6de58d57a9080735da72d9d68360ca93129ec |
| [#8](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/8) | chore(dev-deps): update @eslint/js requirement from ^9.35.0 to ^9.39.5 in /packages/mcp-provider-api | bd1b2a14643d7e6105a36a24200592d7010b97ba |
| [#9](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/9) | fix(deps): update @modelcontextprotocol/sdk requirement from ^1.18.0 to ^1.30.0 in /packages/mcp-provider-api | b74666422250a1a02103f26fba365ea65e7fc5b1 |
| [#10](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/10) | fix(deps): update @modelcontextprotocol/sdk requirement from ^1.18.0 to ^1.30.0 in /packages/mcp-provider-dx-core | cbf913edf62bbb7a4f6323afe6cfdd6b51f2db55 |


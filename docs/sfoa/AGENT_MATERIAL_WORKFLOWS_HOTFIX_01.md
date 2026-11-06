# Agent Material Workflows HOTFIX-01

日期：2026-11-05。范围：本地实现、确定性回归、基本构建、指导分发和交付记录。
本报告接续[原交付](AGENT_MATERIAL_WORKFLOWS_DELIVERY.md)与[续测记录](AGENT_MATERIAL_WORKFLOWS_ACCEPTANCE_FOLLOWUP.md)，不覆盖其中历史失败、真实渠道结果或部署版本。

> **2026-11-06 部署补记**：本报告源码 `b459e8b` 已按[测试服务器部署指南](TEST_SERVER_DEPLOYMENT.md)部署到 203（Playbook 1.13.3、Adapter HOTFIX-01、四业务 Skill 与独立 `sfoa` 1.13.3）；协议、构建、字节与可见性验证通过。同日稍后追加 Adapter Prompt 字段最小化补丁 `a21e679`（generation 5），只改变模型可见视图。真实企微与 Salesforce 业务 UAT 仍未执行，原文的 **NOT_RUN_BY_REQUEST / PARTIAL** 结论对业务验收继续有效。

**交付判定：PARTIAL。** A1–A5 与现有宿主可实现的 B1/B2 已完成代码和针对性回归；根构建顺序已在 Node 24 / 26 CI 验证。尚有本地隔离安装链接/最终根构建失败、harness、graceful shutdown、P7 时间边界检查失败，以及 Node 22 的既有测试参数兼容失败，不能标记 READY_FOR_USER_UAT 或“测试全部通过”。真实企微 / OpenClaw 模型业务流程 / Salesforce 实写及附件发布统一为 **NOT_RUN_BY_REQUEST**，本报告不宣布本轮业务 COMPLETE。

## 基线与交付边界

- 分支 `feature/agent-material-workflows`。开工 fetch 全部远端后，工作树干净、HEAD 与 origin 相同：`28f17d1db7133abb7dfcaf136ce2b257f77c6120`。
- 审查固定点 `b9b6a523544b080b4df751402cd5c07de1641bff` 之后已有 `28f17d1 fix(ops): reconcile local startup and Admin Playbook delivery`，完整保留。
- 实际 ancestry 检查确认 `61f8a0c11f7acb9d56f95762014335fd0c2aab05` 是最终源码祖先；到开工 `28f17d1` 共 27 个提交，与审查时 26 个加后续运维修复一致。
- 沿现有 p0 来源分支追加；没有合并 main、回退固定审查点、移植其他工程分支、删除分支或强推。
- 真实企微 / OpenClaw 模型业务流程 / Salesforce 实写与附件发布：**NOT_RUN_BY_REQUEST**。没有连接 192.168.156.203、部署、重启或改变远端配置。
- 本地验证环境：Windows、Node `24.13.0`、Yarn Classic `1.22.22`，Office 回归使用已有 CPython 3.12 实际可执行文件。没有升级运行时或依赖、改变锁文件。
- 验证日志在开工工作树 `.temp/hotfix01/`，不提交原始业务材料、凭证或环境文件。

实现提交依次如下；最终源码为 `22c9361e36550ec8611c2184d08f73caadb03664`。最后一项只涉及 Adapter 读取合并与回归，workspace 包、构建脚本、依赖和锁文件与 `0bfc40c` 相同。之后的交付文档提交不改变该源码。

| 提交 | 内容 |
| --- | --- |
| `8b535d6` | A1 DOCX、A2/A3 材料/发布事实及 B2 备注回归 |
| `8c61968` | A4 明确拒绝先观察、实际 uploader/facade/ingress 回归 |
| `374a8c8` | 已消费 ref 跨目标状态、目标台账容量边界 |
| `9e23581` | B1 可信原生读取/转写事件与任务绑定 |
| `2e63d01` | A5 canonical Skill/oracle、Playbook 1.13.3 及生成分发 |
| `16c3ecb` | 可信同内容重读补入原先遗漏的中间正文 |
| `0bfc40c` | 独立 workspace 构建顺序与真实 Yarn 派发回归 |
| `22c9361` | 更完整的成功重读受总文字量截断时保持 PARTIAL，不恢复旧的错误完整标记 |

## 修复与兼容

| 项目 | 当前源码根因及实现 | 证据与限制 |
| --- | --- | --- |
| A1 DOCX | 原 reader 只读直接正文段落/表格。现在按顺序遍历常见内容控件、customXml、插入/移动正文包装和基本表格；只访问一次。未支持正文结构或深度超限返回 PARTIAL、有界原因。覆盖名称改为 `textCharactersExtracted`，不把提取长度称作全部源内容。 | 实际 ZIP/CSV 回归含否定事实、包装顺序、表格、未知结构、文字/成员/解压/原件大小及 XML 声明限制；无宏、外链、公式求值、Office 程序或 OCR。页眉/页脚/版式等仍明确排除。 |
| A2 同内容重发 | 内容哈希只标识任务内同内容。读取、来源、原件和上传事实独立合并；新成功读取可以补旧失败，后续失败不能降级已有读取。真实新 ref 按实际 TTL/来源保存，只在未尝试或明确可恢复时成为当前 ref。 | 64 份材料、64,000 字符总量继续有效；每份至多 32 条来源路径/消息、8 个原件引用。超限文字标 PARTIAL；同 ref 不延长已知 TTL。UNKNOWN/UPLOADING 不因新 ref 消失；无跨任务全局哈希封锁。 |
| A3 上传事实 | 原观察器用最近一行覆盖全部结果。现在每份材料按明确对象/目标保留 32 项有界台账及一个受保护的兼容溢出结果槽；旧 version=1 任务惰性兼容。SUCCESS 与 ID 保留，最新错误在 `latestAttempt`；UNKNOWN 不被未发出的调用消除。 | 真实 ingress 消费 ref 后的 FAILED/MCP_ATTACHMENT_EXPIRED 通过 uploader/facade 再交给 Adapter，仍保留第一次成功。不同 ref 的新成功也不消除旧未知尝试，单列确认发布事实。继续超限只保留有界最近未跟踪尝试、标记 `uploadTrackingLimited` / `HISTORY_UNAVAILABLE`，不把缺失历史当可重放许可；不影响直接 MCP 调用。 |
| A4 已知拒绝 | **原基线已有遗漏**：成功已有提前观察，但明确 Salesforce 4xx 拒绝要等仓储完成。现在先观察 FAILED、HTTP/Salesforce 错误及 `retryable=false`，持久化成功且契约允许后才更新恢复资格。 | 实际 uploader/facade/ingress、替代 fetch/仓储边界；保持 claim、最多一次 POST、UNKNOWN、取消后不派发后续文件，以及成功后清理/查询超时仍成功。没有修改 facade/ingress/schema 或生产超时。 |
| A5 指导一致性 | 主入口把 Visible/Editable 未决一概视为 Critical，oracle 又将所有 PENDING、已满足的 API-required/UNKNOWN 拦住；另有为 Picklist 换类型的旧规则。已替换为与本次必要值/合法提交/适用依赖相关且可靠证据无法消解的统一原则，Playbook `1.13.3`。 | 无关未提交 optional PENDING、已由合法值/default/managed 满足的 API 必填不受 UI UNKNOWN 阻断；真实 API 必填、不可写、Lookup/Picklist 缺口保留。类型按业务语义，不仅为一个值换类型。oracle 仅开发测试，不接服务端门禁。 |
| B1 原生读取 | 新模块观察官方 OpenClaw `v2026.9.5` 的真实事件形状：pdf/view_image 工具结果、入站 transcribed 事实、`message:transcribed` 内部 hook。按可信用户/会话/任务和唯一原件路径映射回写；工具调用快照和 run 绑定防止跨任务串用。 | 本地 SDK 声明快照与官方源码对应的注册/钩子夹具验证，**未加载真实 Gateway/模型**。能力限制详见下表及 [Adapter README](../../integrations/openclaw/sfoa-wecom-mcp-adapter/README.md)。 |
| B2 任务备注 | 沿用可选 `sfoa_material_task`；重复保存同一归档决定时保留选中材料，允许单独更新选择并过滤无效/重复 ID。收集、完成、重新 ACTIVE、归档回答均复用材料和已证实目标。 | 不从 agent_end、上传或一次 DML 成功推断整个任务完成或归档接受；未回答可选邀请不阻塞记录工作。真实模型是否自然调用备注仍待用户 UAT。保持 MEMORY_ONLY_REVALIDATE_AFTER_RESTART。 |

### 宿主可知范围

| 宿主证据 | Adapter 能记录 | 仍不能声称 |
| --- | --- | --- |
| pdf 或图像 fallback 工具实际分析结果、可唯一匹配原件 | PARTIAL、实际返回的有界文字及分析完成证据 | 全部 PDF 页或全部图片语义已完整覆盖；多源组合分析不拆成每份原件正文 |
| native view_image 返回模型图片输入 | `nativeInput=PROVIDED_TO_MODEL`，reading 仍 UNKNOWN | 已进入实际 provider 请求、模型已经完成语义分析 |
| 入站 `message_received.media[].transcribed=true`，音频且路径唯一匹配 | 已有宿主转写事实，PARTIAL，正文未暴露时明确说明 | 伪造转写正文、完整音频覆盖 |
| 可信 message:transcribed，唯一入站音频路径/消息绑定 | 实际转写文字，PARTIAL；时间码/说话人/置信度 UNKNOWN | 多音频 message-level 转写的逐文件归属、没有原件 ref 时的可归档原件 |
| 自动 PDF 预处理、只有 llm_input.imagesCount、不能唯一匹配的路径/消息 | 保留 UNKNOWN | 仅凭数量、同名或模型声称“读完”升级 READ |

最低缺失契约是宿主提供可绑定 requester/session/run/task、原件 ID 或准确路径映射、操作与实际结果/覆盖的事件；现有计数和自由文本不能替代。缺少可信 before 快照且同 run 已切换任务的完成事件无法唯一归属，保守不回写；新 prompt/run 重新绑定。内部转写 hook 只在既有 conversation-access opt-in 为 true 且 internal hooks 未禁用时注册，不绕过宿主权限。

## 独立构建修复

历史 [41959172013](https://github.com/ElioLin/sfoa-enterprise-mcp/actions/runs/41959172013/job/127021341874) 与 [41608749970](https://github.com/ElioLin/sfoa-enterprise-mcp/actions/runs/41608749970/job/125825263443) 均已通过 GitHub 连接器读取，都是 Admin API 的 200 条 TypeScript 错误，首错缺少 `@sfoa/control-plane` 声明。

原根命令按 workspace 列表执行，不能保证 SFoA 的依赖声明产物先生成。新 `scripts/build-workspaces.mjs` 使用 **Yarn 自身解析出的 workspaceDependencies**，拓扑排序后调用各 workspace 原 build 脚本；保留不匹配版本使用 registry 包的 Yarn 语义。任一依赖失败立即非零退出，不构建消费者；循环依赖在派发前失败。无 build 脚本的 workspace 明确列出，仍遍历它的依赖；当前仓库 21 个 workspace 都有 build。

没有删除包、放松类型、修改排除范围或迁移构建系统。Windows 上上游 Code Analyzer 原 build 使用 `cp`，验证时将已有 Git `usr/bin` 加入该进程 PATH；这不是依赖升级或源码改写。

## 验证记录

专项复现在基线及相应修改工作树上执行，随后原样提交。完整 Adapter、Skill 分发与 server 失败文件复测在 `0bfc40c` 执行；Skill 最后检查另包含随报告提交的 maintainer 文档更新。容量边界的后续实际 helper/原生 hook 回归对应最终源码 `22c9361`；干净根构建另列实际 SHA。下列路径均相对 `.temp/hotfix01/`。过程中旧失败均保留：

- `adapter-baseline.log`：初始全套 120 项，115 PASS / 4 FAIL / 1 SKIP；包括 Python shim 的 spawn EPERM 和 harness 时间边界失败。
- `reader-reproduction.log`：修复前 6 PASS / 3 FAIL；`reader-fixed.log`：9/9 PASS。
- `material-reproduction.log`：7/7 复现失败；第一轮 `material-fixed.log` 19/19 PASS，后续增加状态/TTL 回归另记。
- `attachment-reproduction.log`：4 项中 2 PASS / 2 FAIL；`attachment-suite.log`：修复后完整 58/58 PASS。
- `native-bridge-final.log`：首次合并测试 34 PASS / 1 FAIL，CSV reader 使用默认 Windows Python shim 失败；换为已有实际解释器后 `native-bridge-python.log` 36/36 PASS，独立 `native-hooks-final.log` 11/11 PASS。
- `guidance-reproduction.log` 的新测试夹具常量错误与 `guidance-reproduction-corrected.log` 的真实 oracle 复现（0 PASS / 3 FAIL）分开；`guidance-playbook-test.log` 的遗漏版本断言失败后修正，重跑 47/47 PASS。
- `material-review-reproduction.log` 两项边界为 0 PASS / 2 FAIL；`material-capacity-reproduction.log` 后续容量边界 0 PASS / 1 FAIL，修复后并入下面 37 项 helper/原生观察回归，未覆盖旧日志。
- Skill sync 的 EBUSY 保留。首次 `skill:test` 的交付校验报告 org-diagnostics 未跟踪（82/83），随后 Git 核对已跟踪；独立 delivery 和未改源码的 test 重跑通过，底层执行原因未确定。最终一轮 `final-skill-delivery.log` 又有工作树识别失败，原命令重试通过；这些日志不能据此声称源文件实际未跟踪。
- `clean-install-baseline.log`：首次隔离冻结安装因 Windows copyfile UNKNOWN 失败，未算安装通过；重试另存。
- `build-runner-tests.log`：功能断言通过但临时目录清理 EBUSY；测试清理加入有限原生重试。第二次 `build-runner-tests-final.log` 因 Node spawnSync EPERM 失败；后续结果不覆盖这些日志。

| 实际命令 / 范围 | 结果 | 日志 |
| --- | --- | --- |
| `yarn ai:snapshot` | PASS | `snapshot.log` |
| Adapter 基线 `npm test` | FAIL：115 PASS / 4 FAIL / 1 SKIP | `adapter-baseline.log` |
| Adapter 最终 `npm test -- --test-concurrency=1`，设置实际 CPython 路径 | FAIL：145 PASS / 1 FAIL / 1 SKIP；失败为既有 harness partial JSON 在 600ms 截止前无 stdout，POSIX SIGTERM 用例在 Windows 跳过 | `adapter-final-serial.log` |
| Adapter `node --test harness/test/run-process.test.mjs`，完整运行后有界单独复测 | FAIL：8 PASS / 1 FAIL / 1 SKIP，同一 partial JSON 断言仍失败；不提高生产预算或放松断言 | `adapter-harness-isolated.log` |
| `node --test test/material-reader.test.js`（Adapter；真实 Office 原件） | PASS 9/9 | `reader-fixed.log` |
| `node --test test/material-hotfix.test.js test/material-tasks.test.js`（Adapter，容量补充前） | PASS 25/25 | `material-reread-final.log` |
| `node --test test/material-hotfix.test.js test/material-tasks.test.js test/native-reading.test.js`（最终容量修复） | PASS 37/37，其中材料回归26项、原生观察11项 | `material-capacity-final.log` |
| Adapter `node --test test/native-reading.test.js`；再合并 `test/bridge.test.js` | PASS 11/11；合并 bridge 使用实际 Python 后 36/36 | `native-hooks-final.log`、`native-bridge-python.log` |
| `yarn workspace @sfoa/mcp-server build` / `lint` | PASS，实际 tsc 与 noEmit | `attachment-build.log`、`attachment-lint.log` |
| server `node --test dist/test/attachment-upload.test.js` | PASS 58/58 | `attachment-suite.log` |
| `yarn workspace @sfoa/mcp-server test` | FAIL：406/409 PASS；Buntu乱序验证、50个交错HTTP请求、请求超时起始断言各失败1项 | `server-full.log` |
| `0bfc40c` 的 server build 后 `node --test --test-concurrency=1 dist/test/buntu-safety.test.js dist/test/http-integration.test.js dist/test/timeout-shutdown.test.js` | build PASS；复测 20 PASS / 1 FAIL。前次三项失败均通过，此次已有 graceful shutdown 用例返回 forced 而非 drained；server 源码与最终 `22c9361` 相同，不将局部复测当全套 PASS | `server-isolated-build.log`、`server-failed-files-isolated.log` |
| `yarn workspace @sfoa/mcp-server test:p3` | FAIL：22/25 PASS；身份路由、Audit fail-open 的HTTP504及批量超时等待断言 | `server-p3.log` |
| 同一 `test:p3` 原命令有界复测 | PASS 25/25，包含脚本实际 tsc；不改并发、预算或断言 | `server-p3-isolated.log` |
| server build 后 `node --test dist/p5-test/mysql-runtime-policy.test.js` | PASS 4/4，仅本地 loopback 与替换仓储 | `server-p5.log` |
| `yarn workspace @sfoa/mcp-server test:p7` | FAIL：5/6 PASS；OFF/ON 50/100/200 HTTP gate超时 | `server-p7.log` |
| 同一 `test:p7` 原命令有界复测 | FAIL：5 PASS / 1 FAIL，同一 HTTP gate 再次504；具体迟滞未根因化，停止无关重复测试 | `server-p7-isolated.log` |
| `yarn workspace @sfoa/identity-runtime lint` / `test` | PASS，75/75 | `dependency-identity-runtime-*.log` |
| `yarn workspace @sfoa/mcp-provider-sfoa-dml lint` / `test` | PASS，47/47 | `dependency-mcp-provider-sfoa-dml-*.log` |
| `yarn workspace @sfoa/mcp-provider-sfoa-context lint` / `test` | PASS，237/237 | `dependency-mcp-provider-sfoa-context-*.log` |
| `yarn workspace @sfoa/control-plane lint` / `test` | PASS，38/38；无真实数据库 | `dependency-control-plane-*.log` |
| `yarn workspace @sfoa/agent-playbook build` / `lint` / `test` | PASS，47/47（修正遗漏版本断言后） | `guidance-playbook-*.log` |
| `yarn workspace @sfoa/admin-web test src/test/AgentIntegrationPage.test.ts` | PASS，5/5 | `admin-playbook-test.log` |
| `yarn workspace @sfoa/admin-web lint` | PASS，实际 tsc --noEmit | `admin-web-lint.log` |
| `yarn test:build` | PASS，2/2；含实际 Yarn 成功构建、无脚本报告、失败依赖不派发消费者 | `build-runner-tests-isolated.log` |
| `yarn agent:sync` → `yarn agent:check` | PASS，5 个生成工件无漂移，包含 Playbook 实际 build | `final-skill-agent-check.log` 及 `guidance-*` |
| `yarn skill:sync` → `skill:validate` / `skill:check` / `skill:test` / `skill:delivery` | 最终 PASS，83/83；首次 Access denied、EBUSY、Git 工作树识别失败单列保留，未改断言或生产预算 | `final-skill-*.log`、`final-skill-gates.tsv` |
| `yarn skill:runtime:sync --runtime-root .temp/hotfix01/runtime-skills` → 同根 `skill:runtime:check` | PASS，仅业务 Skill allowlist，未触及真实 OpenClaw 目录 | `guidance-runtime-*.log`、`final-skill-runtime-check.log` |
| 完整 `test:p5` / `test:p5:mysql`、control-plane `test:mysql` | SKIPPED_NO_ISOLATED_TEST_DB：P5 integration 自动读取根环境文件，未为本轮验证授权隔离数据库；没有调用真实 MySQL | `server-gates-summary.json` 与本记录 |

Office 测试的解释器配置为 `SFOA_MATERIAL_PYTHON=C:/Users/61979/AppData/Roaming/uv/python/cpython-3.12-windows-x86_64-none/python.exe`。受影响 TypeScript 包已另行执行实际 tsc/build；Adapter/Skill 的 JavaScript 测试不替代包构建。默认关闭的评估、请求身份、直接及批量 DML 的证据来自实际 Tool/HTTP 实现和替换外部边界，不能当作真实 Salesforce 权限或业务验收。

隔离树为 `D:/GitProject/sfoa-hotfix01-clean`，最初 detached 于 `28f17d1`。安装历史：

| 命令 | 结果与事实 | 日志 |
| --- | --- | --- |
| `yarn install --frozen-lockfile`，两次分别记录 | FAIL，Windows `copyfile UNKNOWN`，先是 trace-mapping README，后是 Babel LICENSE | `clean-install-baseline.log`、`clean-install-retry.log` |
| `yarn install --frozen-lockfile --link-duplicates` | FAIL，同一 Babel LICENSE 复制错误；原生硬链接选项未解决 | `clean-install-linked.log` |
| `yarn install --frozen-lockfile --cache-folder D:/GitProject/sfoa-enterprise-mcp/.temp/hotfix01/yarn-cache` | FAIL，下载 lucide-react 时 ESOCKETTIMEDOUT；记录错误后停止该任务仍未退出的安装进程 | `clean-install-task-cache.log` |
| `yarn install --frozen-lockfile --offline --cache-folder D:/GitProject/sfoa-enterprise-mcp/.temp/hotfix01/offline-yarn-cache` | FAIL，缓存已含全部 1570 个锁定 resolved SHA，但现有锁文件缺少当前 workspace 的 @types/node 22.16.5、antd 6.6.1 等精确版本条目，离线无法解析；没有扩修锁文件 | `clean-install-offline-baseline.log` |
| 补入当前 manifest 的 20 个精确版本后，`yarn install --frozen-lockfile --cache-folder D:/GitProject/sfoa-enterprise-mcp/.temp/hotfix01/offline-yarn-cache` | FAIL，实际请求 icons-svg 4.6.0 下载 ESOCKETTIMEDOUT；exit1，未算安装通过 | `clean-install-online-baseline.log` |
| 精确补齐该 icons-svg 包后，再执行同缓存的离线冻结命令 | FAIL，前次网络失败还留下 icons 6.3.4 的不完整目录，缺 package.json；exit1 | `clean-install-offline-completed-cache.log` |
| 完整预检与修复缓存后，同一离线冻结命令 | INTERRUPTED_NO_FINAL_EXIT：回合中断后进程与工具会话已不存在，日志停在链接阶段，无退出码/安装完成标记；未计 PASS | `clean-install-offline-repaired-cache.log`、`clean-install-interruption.json` |
| 中断恢复后，同一离线冻结命令 | PASS，真实 exit0，完成链接与 fresh packages，Yarn 耗时 3617.42s；没有改变安装选项、依赖或锁文件 | `clean-install-offline-resumed.log`、`clean-install-offline-resumed.exitcode` |
| `28f17d1`，无 workspace 构建产物时执行原 `yarn build` | FAIL，真实 exit2，恰好 200 条 TypeScript 错误；首错 `src/audit-trace.ts(8,8)` TS2307 无法解析 `@sfoa/control-plane`，复现既有构建顺序阻塞 | `clean-build-baseline.log`、`clean-baseline-build-summary.json` |
| 清除 26 处构建输出、切到 `22c9361` 后，重复同一离线冻结安装检查 | FAIL，真实 exit1：Yarn linking 在 `packages/mcp-provider-api/node_modules/@typescript-eslint/eslint-plugin/node_modules/ignore` 返回 ENOENT。未改变依赖/锁文件，未清除或覆盖前一次安装成功记录；不再追加安装重试 | `clean-install-fixed.log`、`clean-install-fixed.exitcode`、`clean-output-cleanup.log` |
| `22c9361`，确认 workspace 构建输出为空后执行 `yarn build` | FAIL，真实 exit1：21 个有 build 脚本的 workspace 中实际启动 3 个、完成前 2 个，`@salesforce/mcp-test-client` 因 `tsc` 命令缺失失败。该包 TypeScript 文件存在但 `.bin/tsc.cmd` 缺失；安装链接失败后未获得本地全量构建通过，不用 CI 代替此结果 | `clean-build-fixed.log`、`clean-fixed-prebuild.json`、`clean-fixed-build-summary.json` |

失败缓存文件实际属性为 `Archive, Encrypted`；同一 `fs.copyFileSync` 可复现 UNKNOWN，读取字节写入普通任务文件后可正常复制。后续使用独立普通缓存：先按锁文件 resolved SHA 选择并验证全部 1570 个 hash（1573 个缓存目录）；离线发现上述既有缺口后，再校验补入当前 manifest 明确固定的 20 个版本，用于原冻结在线安装。不解密或修改全局缓存，不改变依赖或锁文件，也不把旧 node_modules/dist 复制成安装成功。`clean-offline-cache-copy.log` / `clean-exact-pin-cache.log` 仅证明缓存准备完成；实际安装/根构建退出码见上表。

最后对普通任务缓存做了一次有界完整性预检：1770 个实际 hash 目录中 1769 完整，唯一坏目录 icons 6.3.4 在全局缓存有同目录/同 hash 的完整来源，隔离保留原坏目录后字节重建并复验。证据为 `clean-cache-integrity-audit.json` / `clean-cache-integrity-repair.log`；该动作只修复已证实的不完整缓存，不推测依赖版本。中断恢复后沿同一已验证缓存完成原离线冻结安装，结果记在 `clean-install-offline-resumed.log`。

本地隔离验证最终摘要为 `clean-verification-complete.json`，保留较早 `clean-verification-final.json` 中间失败快照。基线与最终源码均核对 tracked clean，依赖声明与锁文件未改变；锁文件 SHA256 为 `f89f95ecd5c2ded91182710b9a981960dfbccde2ffe026a820a1c50ef17c4473`。构建前清理仅涉及已验证位于隔离树内的 dist/lib/.wireit/tsbuildinfo，不包含 node_modules、受跟踪文件或重解析点。**本地已完成旧阻塞复现，但最终源码的干净根构建仍 FAIL；下面 CI 的 21 包通过是独立环境证据。**

源码 push 已成功：`source-push.log`。[CI 41995023432](https://github.com/ElioLin/sfoa-enterprise-mcp/actions/runs/41995023432) 是 `push`，head SHA 为 `0bfc40caf0ebbfab96dac7e2b2dda9964ea4cda6`。北京时间 2026-11-05 16:58 核对以下已完成基础 job；它们的 `git log -1 --format=%H` 实际 checkout 都是该完整 SHA。后续报告提交的检查另记；未结束的 CI 标为 PENDING，不用本地测试代替。

| 已完成 CI 基础 job | 安装 / 根构建 / 根测试 | checkout 与实际限制 |
| --- | --- | --- |
| Linux Node 24.22.1 / Yarn 1.22.22，`127136209981` | PASS / PASS / PASS | 21 workspace build，无缺 build 脚本，测试日志未出现失败重试；摘要 `source-ci-node24-summary.log`。 |
| Linux Node 26.13.0，`127136209991` | PASS / PASS / PASS | `git log -1 --format=%H` 实际为 `0bfc40caf0ebbfab96dac7e2b2dda9964ea4cda6`；21 workspace build，无缺 build 脚本，测试日志未出现失败重试。摘要 `source-ci-node26-summary.log`。这是现有 CI 自行选择的矩阵，本机没有升级 Node。 |
| Linux Node 22.23.4，`127136210069` | PASS / PASS / FAIL | 实际 checkout 同上，21 workspace build 成功；之后 Admin API 测试命令的 `--test-isolation=none` 被 Node 22 拒绝（exit9），现有 CI 自动三次尝试均失败。`git show 28f17d1:packages/sfoa-admin-api/package.json` 确认该参数已在基线存在，本轮未改该脚本。这是构建恢复后暴露的既有测试运行器版本兼容问题，超出 workspace 产物顺序根因，单独保留；摘要 `source-ci-node22-summary.log`。 |

CI 安装沿现有 `yarn` 步骤；冻结安装结果单列于本地记录。根 `yarn test` 是 workspace 默认单元套件；独立 Adapter、根 Skill/test:build 及 server 的 P3/P7 检查分别以上表本地实跑为准。

容量补充提交也已普通推送（`capacity-source-push.log`）。最终源码 [CI 42004063722](https://github.com/ElioLin/sfoa-enterprise-mcp/actions/runs/42004063722) 的三个 Linux 基础 job 已核对实际 `git log -1`，均为 **`22c9361e36550ec8611c2184d08f73caadb03664`**：

- Node 24 job `127166481799` 与 Node 26 job `127166481820`：安装、21 workspace 根构建、根单元测试均 PASS，日志无失败重试。
- Node 22 job `127166481800`：安装与 21 workspace 根构建 PASS；测试仍在 Admin API 的既有 `--test-isolation=none` 参数退出9，现有 CI 三次尝试均失败。
- 摘要为 `final-source-ci-node24-summary.log`、`final-source-ci-node26-summary.log`、`final-source-ci-node22-summary.log`。这些是实际最终源码的远端基础检查结果，保留前一个源码提交的记录。

## MCP 能力与部署注意事项

服务端工具名与输入 schema、直接 CREATE/UPDATE、最小 patch、批量/复合与附件参数不变；身份仍由真实请求决定，Salesforce CRUD/FLS/Sharing、对象治理、managed fields、stdio/Streamable HTTP 和 Audit fail-open 不变。CREATE `includeValueAssessment` 仍默认关闭；没有 UPDATE 完整 Dynamic Forms、准备 token、统一批准参数或强制任务步骤。

读取改善和原件持有都不等于归档授权。局部材料缺失只影响依赖该内容的判断；记录写入不以所有材料解析/上传成功为前置，纯上传仍可直接使用有效 ref。工具可见性继续按同一身份/治理范围比较，不把历史 29 项当所有用户的固定数量。

后续由用户按 [TEST_SERVER_DEPLOYMENT.md](TEST_SERVER_DEPLOYMENT.md) 部署：同步完整 Adapter（含 Python/native 模块），构建并同步 server、Playbook/生成客户端、canonical 业务 Skills 的运行时副本，以及引用 Playbook 的 Admin Web bundle。maintainer Skill 不分发给业务 Agent。新增 hook 需遵循宿主现有注册/热加载与 capability-consent 流程；本轮未改变权限或运行配置。已有附件迁移 017 是基线要求，本轮无新数据库迁移。旧任务兼容升级不等于跨 Gateway 重启恢复材料台账。

## 用户后续人工检查

1. 多材料创建：先说“还未发完”，再补 DOCX 内容控件内的否定事实和 PDF/音频；明确材料齐后创建。预期保持收集、忠实提炼相关可写选填字段，不编造采购承诺。
2. 补充更新：创建完成后更正日期/事实。预期沿已证明目标做最小 patch，不重复 CREATE。
3. 归档选择：分别测试明确“同时上传这些原件”、接受一次邀请、拒绝邀请和只选部分材料。预期无需固定二次确认、不重复邀请、只上传选中范围；记录工作不被未答邀请阻塞。
4. 同内容重发：读取失败后重发同字节；再测试明确可恢复的上传失败、旧 ref 过期后的真实重发。预期读取改善、新 ref/TTL 真实；UNKNOWN 不因重发而重放。
5. 已成功文件：对已消费 ref 再调用。预期解释本次被拒，仍显示原 SUCCESS、ID 和正确目标。
6. 原生企微语音：分别验证有原件 ref 与仅有转写的入口，核对真实 ASR/回写范围；没有原件时不声称能归档，未知时间码/说话人不编造。
7. 任务隔离：同用户新业务、另一目标、另一用户/会话以及任务切换时的晚到结果。预期不串材料、目标、归档选择或成功结果；真正新任务显式选择要带入的材料。

# 上游工作流处置矩阵

原始 14 份文件取自 main@12df237f7ab03c4771109813b84f715a29e9e32d，原文保存在本目录；逐文件 SHA-256 见 [provenance](provenance.json)。文件仅作为来源参考，不在 .github/workflows 内执行。

| 原文件 | 原触发 | P11-A 处置 / 保留覆盖 / 恢复方式 |
| --- | --- | --- |
| test.yml | 非 main push、dispatch | 适配；main PR/push/dispatch，复用 Linux/Windows，统一 P11-A gate；不按 paths 跳过核心检查 |
| tempUnitTestsLinux.yml | workflow_call，远端 Node 版本判定 | 适配；固定 Node/Yarn/Java，frozen，全 21 workspace build/default tests，专有/MySQL/Admin/Skill/Agent；无产物缓存 |
| tempUnitTestsWindows.yml | workflow_call | 适配；固定工具链、Git Bash，保留完整冷构建/default tests；与 Linux 独立运行 |
| e2e.yml | workflow_call，经旧 tests 自动矩阵调用 | 改为 workflow_dispatch 明确 opt-in；独立 test-org environment；保留两 Provider × 两 OS 的真实 Org 测试，核心 CI 不读取 Org secret |
| validate-pr.yml | main PR opened/reopened/edited | 本地化标题/非空说明校验，增加 synchronize；保留元数据质量规则，不代替代码测试 |
| automerge.yml | 每天四次 cron、dispatch | 归档；当前必须人工审查；不需要官方 bot 权限 |
| devScripts.yml | 每周 cron、dispatch | 归档；上游开发脚本同步改为单独固定版本审查 |
| create-github-release.yml | main/prerelease push、dispatch | 归档；SFoA 无自动公开 release 需求 |
| onRelease.yml | release published、dispatch | 归档；停止官方 npm publish 链 |
| publish-providers.yml | main Provider paths push、dispatch | 归档；停止官方包 publish/git push |
| publish-mcp-server.yml | dispatch | 归档；避免误发布官方 server，不配置 bot/NPM 凭据 |
| promote-mcp-server.yml | dispatch | 归档；不需要官方 runner、CTC 或 npm promotion |
| failureNotifications.yml | 上游发布 workflow_run completed | 归档；无本项目 Slack 配置，不发送消息；核心失败仍在 Actions/gate 显示 |
| notify-slack-on-pr-open.yml | PR opened/reopened | 归档；没有通知业务需求，不发送消息 |

恢复归档自动化必须作为独立审查：先确认 SFoA 的需求、包归属、最小权限、固定依赖/Action SHA、隔离凭据、触发范围；不能直接把原来的 @main 和官方发布 secret 搬回活动目录。

当前第三方 Action 仅保留 checkout/setup-node/setup-java/upload-artifact 的既有 v4 主版本，2026-10-19 从官方 tag API 核对并固定 commit SHA；不再调用远端 @main reusable workflow。全部活动 workflow 默认 contents: read，不使用 secrets: inherit、write-all、自动合并或发布。原来的 lockfile-check 只做 URL 规则，不能证明 manifest 覆盖，现由 frozen install + 不漂移检查替代。旧 required-check 配置详情读取受限；合并前仓库管理员应核对只把稳定的 P11-A gate 作为所需工程结果，不能遗留旧 Node matrix check 为永久 Pending。

Dependabot：根目录 Yarn workspace / 唯一共享 lockfile，npm 例行 PR 限额 0；Actions 每月最多 2 个 PR、patch/minor 分组且人工审查。安全更新独立限额，不更改安全开关。收口后通过单独 PR 恢复 npm 每周少量更新，先合并工程基线后逐项重评十个旧 PR。

官方配置依据：[Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)、[Dependabot npm workspace discovery implementation](https://github.com/dependabot/dependabot-core/tree/main/npm_and_yarn/lib/dependabot/npm_and_yarn)。根 package.json 的 workspaces.packages=packages/* 与共享根 yarn.lock 均保留，不建立重叠 npm updates 目录。仓库安全告警/安全更新状态 NOT_VERIFIED。

已复核 Dependabot 官方 file_fetcher.rb 的 fetch_workspace_package_jsons / workspace_paths：根 manifest 的 workspaces 对象会发现 packages glob（含 packages/*）。根目录覆盖判断基于该实现与本项目 21 个 manifest 的实际清单；不是仅凭配置文件写了 / 就宣称覆盖。

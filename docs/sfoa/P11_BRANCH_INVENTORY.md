# P11 分支与 PR 盘点

取证：2026-10-19；真实仓库 `ElioLin/sfoa-enterprise-mcp`（private，fork=false，保留 Salesforce 历史）。main `12df237f7ab03c4771109813b84f715a29e9e32d`。origin/upstream fetch/push 分别为公司仓库和 `salesforcecli/mcp`；未改变 remote。原工作区 main 干净且保持。Git HTTPS fetch 缺少本机凭据，刷新通过 GitHub 连接读取全部 43 个分支并逐 SHA 与本地 remote refs 核对；未假称 git fetch 成功。

43 个基线分支全部保留：main 1、自研 32、Dependabot 10；本轮新建的实施分支另计。30 个自研分支为 main 祖先，1 个与 main 相同，附件探测分支有 3 个独有提交。没有 READY_TO_DELETE 项，没有执行删除、PR 关闭或自动合并。

| 分支 | Head | ahead/behind main | main 祖先 | open PR head/base | 结论 |
| --- | --- | --- | --- | --- | --- |
| `dependabot-npm_and_yarn-packages-EXAMPLE-MCP-PROVIDER-eslint-js-tw-9.39.5` | `729629891b023184cbf345d7a6d4d94e03d52db3` | 1/246 | NO | [#1](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/1) dependabot-npm_and_yarn-packages-EXAMPLE-MCP-PROVIDER-eslint-js-tw-9.39.5 → main | EVALUATE |
| `dependabot-npm_and_yarn-packages-EXAMPLE-MCP-PROVIDER-modelcontextprotocol-sdk-tw-1.30.0` | `ec9d9bfec725a720178a1aa4eb8a316d241daeb7` | 1/246 | NO | [#5](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/5) dependabot-npm_and_yarn-packages-EXAMPLE-MCP-PROVIDER-modelcontextprotocol-sdk-tw-1.30.0 → main | EVALUATE |
| `dependabot-npm_and_yarn-packages-EXAMPLE-MCP-PROVIDER-typescript-eslint-tw-8.67.0` | `c0f75dbf1d68107dbd1e4e0f16fda51b876561e5` | 1/246 | NO | [#3](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/3) dependabot-npm_and_yarn-packages-EXAMPLE-MCP-PROVIDER-typescript-eslint-tw-8.67.0 → main | EVALUATE |
| `dependabot-npm_and_yarn-packages-EXAMPLE-MCP-PROVIDER-vitest-coverage-istanbul-tw-3.2.7` | `5665e57a337384dced54c59defe6d55aedddf5e8` | 1/246 | NO | [#2](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/2) dependabot-npm_and_yarn-packages-EXAMPLE-MCP-PROVIDER-vitest-coverage-istanbul-tw-3.2.7 → main | EVALUATE |
| `dependabot-npm_and_yarn-packages-EXAMPLE-MCP-PROVIDER-vitest-tw-3.2.7` | `9be90b276cd4e21ab1424d0717ec37506df8a249` | 1/246 | NO | [#4](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/4) dependabot-npm_and_yarn-packages-EXAMPLE-MCP-PROVIDER-vitest-tw-3.2.7 → main | EVALUATE |
| `dependabot-npm_and_yarn-packages-mcp-modelcontextprotocol-sdk-tw-1.30.0` | `f65ceb709779022cd17547f183e775c7602262e6` | 1/246 | NO | [#6](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/6) dependabot-npm_and_yarn-packages-mcp-modelcontextprotocol-sdk-tw-1.30.0 → main | EVALUATE |
| `dependabot-npm_and_yarn-packages-mcp-provider-api-eslint-js-tw-9.39.5` | `bd1b2a14643d7e6105a36a24200592d7010b97ba` | 1/246 | NO | [#8](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/8) dependabot-npm_and_yarn-packages-mcp-provider-api-eslint-js-tw-9.39.5 → main | EVALUATE |
| `dependabot-npm_and_yarn-packages-mcp-provider-api-modelcontextprotocol-sdk-tw-1.30.0` | `b74666422250a1a02103f26fba365ea65e7fc5b1` | 1/246 | NO | [#9](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/9) dependabot-npm_and_yarn-packages-mcp-provider-api-modelcontextprotocol-sdk-tw-1.30.0 → main | EVALUATE |
| `dependabot-npm_and_yarn-packages-mcp-provider-api-typescript-eslint-tw-8.67.0` | `85d6de58d57a9080735da72d9d68360ca93129ec` | 1/246 | NO | [#7](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/7) dependabot-npm_and_yarn-packages-mcp-provider-api-typescript-eslint-tw-8.67.0 → main | EVALUATE |
| `dependabot-npm_and_yarn-packages-mcp-provider-dx-core-modelcontextprotocol-sdk-tw-1.30.0` | `cbf913edf62bbb7a4f6323afe6cfdd6b51f2db55` | 1/246 | NO | [#10](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/10) dependabot-npm_and_yarn-packages-mcp-provider-dx-core-modelcontextprotocol-sdk-tw-1.30.0 → main | EVALUATE |
| `feature/admin-btit-scoped-account` | `12df237f7ab03c4771109813b84f715a29e9e32d` | 0/0 | YES | — | KEEP |
| `feature/identity-route-user-name-batch` | `2aafbce228184993bbda98f028e8ccef4136bb15` | 0/165 | YES | — | KEEP |
| `feature/managed-platform-user-lookup-fallback` | `f60a134715d639b8129af0f3160549d52dec210d` | 0/155 | YES | — | KEEP |
| `feature/openclaw-concurrency-web-intelligence` | `0f79a1f9f96db632b78bfb1fd9a726142c9aea22` | 0/115 | YES | — | KEEP |
| `feature/openclaw-multimodal-input` | `0944b568aa8d931a127e4c4a914514a9f02b7393` | 0/114 | YES | — | KEEP |
| `feature/openclaw-sfoa-record-change-02a` | `ef809145f1ae6335afa0127958935952512f0b27` | 0/103 | YES | — | KEEP |
| `feature/openclaw-sfoa-record-change-02b` | `ce800c20fc59a77f11778728073c1af2bf2cefa1` | 0/91 | YES | — | KEEP |
| `feature/openclaw-sfoa-skill-foundation` | `c195afe1636e7cc235c1bbae10678c7faedf6fed` | 0/109 | YES | — | KEEP |
| `feature/openclaw-test-server-baseline` | `a2edd92ed31292dbd2c0ac2c9d9be5a251d60439` | 0/121 | YES | — | KEEP |
| `feature/openclaw-wecom-sfoa-integration` | `f57f860fdf5f6468fb509ea4dd1a8812938a7b07` | 0/118 | YES | — | KEEP |
| `feature/p0-closure` | `e80d9fde63a64988086444fc1ae50f9c196a4021` | 0/243 | YES | — | KEEP |
| `feature/p1-request-scoped-identity` | `3d35ef675d7b4e977514c18d31350a8f9bfb2902` | 0/236 | YES | — | KEEP |
| `feature/p2-remote-runtime-governance` | `f532c8a95ce511f8f30af7dc87c56b883c360542` | 0/230 | YES | — | KEEP |
| `feature/p3-generic-dml-allowlist` | `4c3a45e3908f9c3aae47bb31e6d73c8954af71ad` | 0/224 | YES | — | KEEP |
| `feature/p4-diagnosis-runtime-context` | `e6ae8d5936565b981fc8efc266d56e2bfe0816ec` | 0/221 | YES | — | KEEP |
| `feature/p5-admin-control-plane` | `3b298b3466ef8b1c57f5e6371545cb44905fb9b1` | 0/213 | YES | — | KEEP |
| `feature/p6-agent-playbook` | `1fa5f5b8751acdb686d9e761fa25abe5daceed92` | 0/201 | YES | — | KEEP |
| `feature/p6-id-user-bound-credential` | `482316d4ae83539854904fc7cea7cc7a2be5ac5f` | 0/208 | YES | — | KEEP |
| `feature/p7-end-to-end-audit` | `fc33f566b11a2a02c201e1a7e61df8f1290f385d` | 0/164 | YES | — | KEEP |
| `feature/p8-04-effective-ui-context` | `b01816da1e83767f3680e898e4f4fceb183a30af` | 0/141 | YES | — | KEEP |
| `feature/p8-05-wecom-identity-channel` | `7519b66eed8377a819650d96411926959e2cd8af` | 0/134 | YES | — | KEEP |
| `feature/p8-06-wecom-channel-credential` | `5c623ef13a88f9e20e2cf897f56b213ebcb2994e` | 0/132 | YES | — | KEEP |
| `feature/p9-data-completeness` | `0be4fef4aba4c210b3a0755f58eb52d89e083610` | 0/35 | YES | — | KEEP |
| `feature/p10-diagnostic-depth` | `1dca49a0ea25ff2c61672048860b748a8e6b8b5b` | 0/9 | YES | — | KEEP |
| `feature/sfoa-attachment-capability-probe` | `66a86c7aba3de05982e8376fc4bccb62150f83cd` | 3/97 | NO | — | KEEP |
| `feature/sfoa-attachment-upload` | `66dcac2550059b8994c651f2ab9f639ba79689e4` | 0/79 | YES | — | KEEP |
| `feature/sfoa-skill-export-package` | `d9f23a80bce04e36abdb9bf5df7921e405d51e69` | 0/70 | YES | — | KEEP |
| `fix/admin-copy-clipboard-http` | `026df42ae31427873745dec0024b317fd1110328` | 0/169 | YES | — | KEEP |
| `hotfix/openclaw-sfoa-crm-core-data-completeness` | `ef6b4e25c9360727ed7e1d3737ab774f9cc08ab7` | 0/107 | YES | — | KEEP |
| `hotfix/openclaw-sfoa-record-change-02a-delivery` | `345b7396a76d3bb718a94707b8323a7d915a597f` | 0/99 | YES | — | KEEP |
| `hotfix/p8-07-agent-runtime-safety` | `933d6ff8d5c2b9bc103dcb8e8acb99050a8f6c79` | 0/126 | YES | — | KEEP |
| `hotfix/p8-07-final-uat-closure` | `3e19d9a7b480395b4670657cc231b63795231889` | 0/123 | YES | — | KEEP |
| `main` | `12df237f7ab03c4771109813b84f715a29e9e32d` | 0/0 | YES | — | KEEP |

## 保护、引用与可恢复性

所有 branch API 的 protected=false。保护详情读取 403 `Resource not accessible by integration`；rulesets 读取 403（私有仓库需 Pro）。未知保护细节不推断为不存在。外部 CI、人工书签、其他仓库、部署平台引用均 NOT_CHECKED；不满足删除前提。生产/测试部署文档中的历史分支记录保持；当前工程仅增加构建指引。main/自研分支统一 KEEP；机器人各有 1 个独有依赖更新提交和 open PR，统一 EVALUATE。

自包含备份：`D:/mcp-backup/p11a-20261019/origin-branches.bundle`（持久目录，非临时文件），`git bundle verify` 退出 0；已克隆至独立 `restored.git` 并逐项复核全部 43 个 head。校验、完整提交分类和 refs 见 [backup](evidence/p11a/branch-backup.json)、[inventory](evidence/p11a/branch-inventory.json)、[API snapshot](evidence/p11a/remote-baseline.json)。该备份是本机恢复材料；需跨机保管时由仓库所有者复制到受控备份存储，未上传私有历史到公开位置。

后续清理需单独获准：重新刷新 refs 和 PR 去向，保存最新完整 mirror/bundle 并验证恢复；逐个完整 refs/heads 名称与旧 SHA 匹配，先 dry-run，再使用明确 lease 删除；核对 main tree 和所有 KEEP head；重新检查 GitHub/外部删除事件自动化。不能复用今天的 SHA 作为未来删除授权。

## 十个 Dependabot PR

| PR | 变更 | Head | 处置与恢复 |
| --- | --- | --- | --- |
| [#1](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/1) | chore(dev-deps): update @eslint/js requirement from ^9.35.0 to ^9.39.5 in /packages/EXAMPLE-MCP-PROVIDER | `729629891b023184cbf345d7a6d4d94e03d52db3` | EVALUATE；保留，先基于 P11-A 重新评估/重放，再运行完整 CI；不合并旧锁 |
| [#2](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/2) | chore(dev-deps): update @vitest/coverage-istanbul requirement from ^3.2.4 to ^3.2.7 in /packages/EXAMPLE-MCP-PROVIDER | `5665e57a337384dced54c59defe6d55aedddf5e8` | EVALUATE；保留，先基于 P11-A 重新评估/重放，再运行完整 CI；不合并旧锁 |
| [#3](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/3) | chore(dev-deps): update typescript-eslint requirement from ^8.44.0 to ^8.67.0 in /packages/EXAMPLE-MCP-PROVIDER | `c0f75dbf1d68107dbd1e4e0f16fda51b876561e5` | EVALUATE；保留，先基于 P11-A 重新评估/重放，再运行完整 CI；不合并旧锁 |
| [#4](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/4) | chore(dev-deps): update vitest requirement from ^3.2.4 to ^3.2.7 in /packages/EXAMPLE-MCP-PROVIDER | `9be90b276cd4e21ab1424d0717ec37506df8a249` | EVALUATE；保留，先基于 P11-A 重新评估/重放，再运行完整 CI；不合并旧锁 |
| [#5](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/5) | fix(deps): update @modelcontextprotocol/sdk requirement from ^1.18.0 to ^1.30.0 in /packages/EXAMPLE-MCP-PROVIDER | `ec9d9bfec725a720178a1aa4eb8a316d241daeb7` | EVALUATE；保留，先基于 P11-A 重新评估/重放，再运行完整 CI；不合并旧锁 |
| [#6](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/6) | fix(deps): update @modelcontextprotocol/sdk requirement from ^1.18.0 to ^1.30.0 in /packages/mcp | `f65ceb709779022cd17547f183e775c7602262e6` | EVALUATE；保留，先基于 P11-A 重新评估/重放，再运行完整 CI；不合并旧锁 |
| [#7](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/7) | chore(dev-deps): update typescript-eslint requirement from ^8.44.0 to ^8.67.0 in /packages/mcp-provider-api | `85d6de58d57a9080735da72d9d68360ca93129ec` | EVALUATE；保留，先基于 P11-A 重新评估/重放，再运行完整 CI；不合并旧锁 |
| [#8](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/8) | chore(dev-deps): update @eslint/js requirement from ^9.35.0 to ^9.39.5 in /packages/mcp-provider-api | `bd1b2a14643d7e6105a36a24200592d7010b97ba` | EVALUATE；保留，先基于 P11-A 重新评估/重放，再运行完整 CI；不合并旧锁 |
| [#9](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/9) | fix(deps): update @modelcontextprotocol/sdk requirement from ^1.18.0 to ^1.30.0 in /packages/mcp-provider-api | `b74666422250a1a02103f26fba365ea65e7fc5b1` | EVALUATE；保留，先基于 P11-A 重新评估/重放，再运行完整 CI；不合并旧锁 |
| [#10](https://github.com/ElioLin/sfoa-enterprise-mcp/pull/10) | fix(deps): update @modelcontextprotocol/sdk requirement from ^1.18.0 to ^1.30.0 in /packages/mcp-provider-dx-core | `cbf913edf62bbb7a4f6323afe6cfdd6b51f2db55` | EVALUATE；保留，先基于 P11-A 重新评估/重放，再运行完整 CI；不合并旧锁 |

实际逐项读取十个 PR 的 files/patch：每个均只修改一份 package.json 的一行范围声明，均未修改 yarn.lock；并不能据此证明 PR head 的可重复实际安装版本。见 [原始变更证据](evidence/p11a/dependabot-pr-diffs.json)。这些更新未被本轮锁文件同步替代：P11-A 不提高任何 manifest 下限。SDK 更新需要单独契约、stdio/HTTP、身份隔离回归；eslint/typescript-eslint 是开发工具链，Vitest/coverage 需一起检查测试兼容。锁定版本由 [lock analysis](P11A_LOCKFILE_REPORT.md) 与以下逐消费者 selector 查得；本轮没有读取生产实际安装目录，不能从 manifest 下限推断已安装版本。安全告警/安全更新的仓库启用状态无可读取证据，标记 NOT_VERIFIED；本轮未更改安全开关，不因为机器人身份丢弃安全修复。每个旧 PR 落后 main 246 个提交，应在新基线上重做最小依赖提交，先重放该 manifest 单行变更，再单独生成和审查新基线上的窄范围 lock diff，不把旧 PR 的绿色状态当作完整锁定证明。


### 当前消费者的精确锁解析

| PR | 当前 selector | 当前锁定版本 | 旧 PR 的范围下限变化已被覆盖 |
| --- | --- | --- | --- |
| #1 | `@eslint/js@^9.35.0` | 9.39.1 | NO；保留并在新基线上重放评估 |
| #2 | `@vitest/coverage-istanbul@^3.2.4` | 3.2.4 | NO；保留并在新基线上重放评估 |
| #3 | `typescript-eslint@^8.44.0` | 8.48.0 | NO；保留并在新基线上重放评估 |
| #4 | `vitest@^3.2.4` | 3.2.4 | NO；保留并在新基线上重放评估 |
| #5 | `@modelcontextprotocol/sdk@^1.18.0` | 1.18.2 | NO；保留并在新基线上重放评估 |
| #6 | `@modelcontextprotocol/sdk@^1.18.0` | 1.18.2 | NO；保留并在新基线上重放评估 |
| #7 | `typescript-eslint@^8.44.0` | 8.48.0 | NO；保留并在新基线上重放评估 |
| #8 | `@eslint/js@^9.35.0` | 9.39.1 | NO；保留并在新基线上重放评估 |
| #9 | `@modelcontextprotocol/sdk@^1.18.0` | 1.18.2 | NO；保留并在新基线上重放评估 |
| #10 | `@modelcontextprotocol/sdk@^1.18.0` | 1.18.2 | NO；保留并在新基线上重放评估 |

Root 中其他 workspace 的更高版本不替代该消费者的锁解析。每项完整 resolved/integrity 与原 PR diff 见 JSON。

## 2026-10-19 公开安全公告关联（与仓库私有告警状态分开）

SDK PR #5/#6/#9/#10 只把范围下限改为 ^1.30.0，未更新锁文件。1.30.0 本身不是当前安全修复终点；该范围也允许后来的 1.x，必须重新解析并核验实际版本，不能从 PR 标题推断已安装版本。官方 [GHSA-46jr-4wx8-v453](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453) 将 1.3.0–1.31.0 列为受影响版本，1.32.0 提供需要显式配置的输入元素上限；[GHSA-f897-62hf-6gxq](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-f897-62hf-6gxq) 的 SDK 修复点为 1.30.1。当前 manifest 的精确 1.18.2 及范围消费者各自锁定版本均需单独安全评估；旧 PR 下限变化不构成安全收口证据。本项目请求级隔离、认证与已有正文边界会影响实际暴露面；本轮没有复现漏洞，也不能仅凭版本号断言本服务可被利用。A 的 SDK 冻结保持；后续依赖专项应结合主机约束验证修复版本/配置，不直接合并四个旧 SDK PR。

Vitest PR #2/#4 涉及 3.2.4→3.2.7，不能视为无价值普通噪声。但新公告 [GHSA-qxg6-89mg-rqv8](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8) 覆盖 @vitest/mocker <4.1.12 的特定 dev-server 手动 mock 注册路径；需检查实际安装路径和插件/Browser Mode 暴露，不能把单一 3.2.7 更新当作全部安全问题已收口。当前 lock 还包含 @vitest/mocker 3.2.4 / 4.0.14 / 4.1.11，其中 Admin Web 精确 Vitest 4.1.11 对应 4.1.11；这些版本与公开公告受影响范围有关。实际插件/Browser Mode 使用与网络暴露仍未验证。这里保留原测试模式和全部依赖声明，没有公网 dev-server 配置变更。eslint/typescript-eslint 两组需结合真实私有告警和依赖链再定优先级，目前没有证据可将其标为安全更新或安全无关。

上述是公开包公告关系，不是读取了本仓库 Dependabot alerts；私有告警和 security updates 启用状态仍 NOT_VERIFIED。

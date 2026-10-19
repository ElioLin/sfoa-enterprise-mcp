# P11 稳定性收口

2026-10-19，Asia/Shanghai。执行基线 main@12df237f7ab03c4771109813b84f715a29e9e32d；分支 feature/p11a-reproducible-ci，独立 worktree。

原始任务书已保存为 [SFOA_P11_Phase1_Codex_Taskbook_20261019.md](taskbooks/SFOA_P11_Phase1_Codex_Taskbook_20261019.md)。它包含后续规格；本轮授权范围仅 A00–A09，按 A-G01–A-G15 交付审查。ChatGPT 负责审查与验收结论；Codex 提交工程修复和实际验证；用户决定合并后的环境与真人验收。

| 批次 | 范围 | 本轮状态 |
| --- | --- | --- |
| P11-A | 冷构建、已有声明的锁文件同步、统一编排、开发/测试前置构建、CI/上游自动化、Dependabot、分支盘点 | 工程实施已完成；BLOCKED_BY_FROZEN_MYSQL_AND_BROWSER_ASSERTIONS，最终 PR 检查见实施报告 |
| P11-B1 | 可信治理快照的局部能力配置故障隔离 | 后续规格，未修改运行时 |
| P11-B2 | 附件 FAILED/TTL/配额、原子领取、UNKNOWN 与共享截止 | 后续规格，未修改运行时 |
| P11-C | 完整性语义、Skill/Playbook 证据口径、回归和状态矩阵 | 后续规格，未实施 |

业务源码/原测试断言、Schema、迁移、所有依赖声明版本、exports/engines/nohoist、权限/身份链路及运行配置默认值冻结。保留全部原有 43 个远端分支和 10 个 open 依赖 PR。没有自动合并、消息通知、部署或生产重启。

A 不代表第一阶段 COMPLETE。B1 的进入条件是 ChatGPT 完成 A 的固定 SHA/diff/CI 审查；B1/B2 分开提交并保留正常配置行为与身份/权限契约，C 需前置缺陷修复和明确真实 Org/UAT 证据。任何未完成核心门禁都必须带具体 BLOCKED 原因，真实 Org/UAT 未执行标记 NOT_TESTED。

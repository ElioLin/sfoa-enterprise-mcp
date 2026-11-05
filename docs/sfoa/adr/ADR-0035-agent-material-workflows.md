# ADR-0035：宿主任务材料、可选 CREATE 事实评估与附件尝试状态

日期：2026-11-04。状态：已授权实现；实际验证见 [交付记录](../AGENT_MATERIAL_WORKFLOWS_DELIVERY.md)。

## 决策与职责

宿主/Adapter 管理可信 requester + session 内有界业务任务材料，保存真实来源、读取覆盖、原件引用与实际到期时间，跨文字追问累积。复用 OpenClaw 原生视觉/ASR 与持久化 keyed store，Office 正文和基本表格用宿主侧 Python 标准库薄读取，不将解析引擎放入 Salesforce MCP。Agent 负责任务边界、材料综合、字段推断和剩余歧义；宿主任务笔记不构成 MCP 写入凭证。目标只能从真实工具证据绑定，不允许材料内容或模型切换身份。

Context 的 CREATE `includeValueAssessment` 默认 false。开启后复用已有 requiredness、原始 defaults 和 draft 的纯计算，区分 PROVIDED/EMPTY/ABSENT/DEFAULT_AVAILABLE/MANAGED_ON_WRITE/UNKNOWN，不增加 Salesforce 请求，不评估业务正确性或 readyToCommit，不接 DML 门禁。Host 只补 managed 策略来源，保持 text JSON mirror 一致。UPDATE 不增加 patchFields 或假 Edit Dynamic Forms。

## 附件可靠执行

沿用 `upload_files_to_record(objectApiName, recordId, attachmentRefs)` 的 1..10 bound、USER 目标读取、独立 attachmentEnabled、owner/expiry/hash。迁移 `017_attachment_attempt_lifecycle` 扩展现有 staging 状态：原子占用 UPLOADING 防止并发提交；明确 Salesforce 拒绝且证明未发布时可转 RETRYABLE；提交后无法确定结果转 OUTCOME_UNKNOWN，后续禁止盲目重放。历史 FAILED 不推定可恢复。逐项结果新增可选 retryable 事实，不改变旧参数。

原件清理与提交结果分离：bytes_removed_at 表达原件已清理；UNKNOWN 原件过期可释放容量，但未知尝试事实保留。提交前取消可以释放占用；提交后取消/超时停止后续文件，保留先前已完成结果。记录与附件结果独立，无跨调用事务或幂等承诺。

## 兼容与部署

查询、单条/批量/复合写入、诊断、附件及合法直接调用继续使用现有授权。request identity、Salesforce FLS/CRUD/sharing、managed fields、stdio/HTTP 和 Audit fail-open 不变。新增值评估与原件归档都不强制成为 CREATE 前置。

先备份并应用 017，再构建和加载新 control-plane/server；不重置共享库或改既有 016。源码回滚保留加性列/状态，旧代码只解析 STAGED 而安全拒绝新状态；不得为回滚把 UPLOADING/UNKNOWN 改回 STAGED。实际后台可能已成功的 Salesforce 写入不随源码回滚，不自动撤销或重做。

## 验证边界

2026-11-05 HOTFIX-01 补正：同内容的读取证据、原件引用、按目标的确认发布结果与最新尝试分别保留，旧任务 version=1 惰性兼容且结构有界。明确 Salesforce 拒绝先向 facade 观察 FAILED，恢复资格仍等持久化成功；没有提前释放 claim。原生覆盖仅从当前宿主真实工具结果/转写事件及唯一用户、会话、任务、来源绑定更新；图片输入不等于语义读取完成。任务完成/归档选择仍沿可选备注，不从成功工具或 agent_end 推导。自动预处理没有逐原件证据时保留 UNKNOWN；跨重启 MEMORY_ONLY_REVALIDATE_AFTER_RESTART 不变。见 [HOTFIX-01 报告](../AGENT_MATERIAL_WORKFLOWS_HOTFIX_01.md)。

确定性 hooks/dispatcher/repository、真实模型、实际材料读取、企微入口、Salesforce 最终状态分别取证。配置文件、tool 可见、服务健康及脚本退出 0 不代替业务验收。隔离合成 harness 的内存 SDK 结果不是 Salesforce 结果；before/after 指导比较与独立 runtime 比较分别标识。

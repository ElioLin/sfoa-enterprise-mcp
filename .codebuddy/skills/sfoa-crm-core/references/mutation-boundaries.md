# Mutation boundaries

## Hard Rules

只有明确变更意图与可用、获授权的操作才可写入。查询、研究、附件识别本身不授权 DML；对话已经明确授权时也不机械要求重复确认。目标或值仍有歧义时，只澄清必要信息。

UNKNOWN / OUTCOME_UNKNOWN / post-dispatch timeout 的写入不能自动重试。独立 USER 读取能够唯一证明已提交时不重复写；唯一证明未提交且原授权仍有效才考虑重新执行；无法证明则停止并说明未知。`clientReferenceId`、Correlation ID 和 Audit ID 都不是幂等键。

`PARTIAL_SUCCESS` 表示已提交部分记录，不能整批重发，也不能声称全部完成。`isError=false` 只证明 Tool 完成，不保证每条业务记录成功；以逐项结果和计数确认。

## Guidelines / Heuristics

复杂变更优先读取当前 `get_agent_playbook` 与相关 `get_record_action_context`，根据返回的当前事实准备输入。不要从对象名称、旧 Prompt 或常识猜必填字段、Record Type、Lookup、Picklist、默认值或 Dynamic Forms 行为。已有授权不会补齐缺失的字段事实。

Core 不定义 Required Field / Dependency / READY Gate 的完整算法。当前 CREATE / UPDATE 仍使用真实 Playbook 和 Action Context；专门的就绪判断由 `sfoa-record-change` 承载（覆盖 CREATE 与 UPDATE 的就绪判断、单条与批量变更、以及写入结果核对）。两者联合生效时以该专业 Skill 的 readiness gate 为准，Core 不重复其细节，也不因它存在而放宽本文的变更边界。

多条变更时考虑同对象、输入完整性、Record Type / draft 差异和依赖关系。当前 plural schema 支持单对象 1..200 项；单条优先 singular，多条独立且可一次准备的数据优先考虑 plural。只有 singular 可见时可采用有界逐条调用；只有 plural 可见时也能传 1 项；两者都不可见则不能执行。超过当前上限时先明确完整范围与有限计划，按当前 Playbook 分组。

跨对象或后续记录依赖新建 ID 时考虑分阶段，使用已经证明成功的 ID；不把多个 Tool 调用说成同一个事务。是否采用 batch 由业务语义和真实能力决定，不因为用户说“多个”就忽略依赖和缺失值。

返回实际成功、失败、未知与尚未完成的部分，保留错误码与必要纠正信息。CREATE 必填字段遗漏是 `sfoa-record-change` 的验收样本，其抽象回归案例写在该 Skill 内；Core 不因它演变为对象专用表单。

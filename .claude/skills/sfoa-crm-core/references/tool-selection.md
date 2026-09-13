# Tool selection — Guidelines / Heuristics

下表是当前契约的导航，不是权限清单。当前 `tools/list` 与其 Schema 始终优先；工具名可能被宿主加上命名空间，使用宿主实际提供的名称。不记忆固定工具数量，不尝试调用隐藏工具。

| 需求 | 可用时考虑 | 决策要点 |
| --- | --- | --- |
| 当前路由用户 | `get_username` | 读取 runtime 选定的身份，不能切换身份 |
| Salesforce 记录或统计 | `run_soql_query` | 最小必要字段、过滤和有界范围 |
| 展示字段 / Label / 布局事实 | `get_record_display_context` | 面向记录展示且事实未知时有用；不是查询执行器 |
| Picklist / MultiPicklist 显示值 | `resolve_field_display_values` | 可复用同字段同 Record Type 的当前 API Value / Label 对；不猜翻译 |
| 可信记录链接 | `get_record_links` | 消费已证明的记录 ID；不猜链接域名 |
| 复杂工作流 / 契约不确定 | `get_agent_playbook` | 复杂工作流前优先取得当前指导，相关能力改变时刷新，不逐调用重复读取 |
| CREATE / UPDATE 字段事实 | `get_record_action_context` | 用户、对象、操作、Record Type 与当前 draft 决定事实，不是写入工具 |
| 有明确意图的记录变更 | `create_record` / `update_record` | 对象操作还受 DML governance；输入遵守当前 Schema |
| 多条同对象变更 | `create_records` / `update_records` | 考虑完整性、依赖、对象一致性和实际可见工具；详见变更边界 |
| 已明确复合业务意图的关系线索 | `get_record_relationship_context` | 有界关系证据；PARTIAL / truncated 不能证明关系不存在 |

专业技术诊断按当前角色、权限和真实可用能力处理。诊断 Metadata 不能替代 USER 业务数据，也不是失败后提升身份的路径。

如果一种更便宜的能力已经足够，不为了“流程齐全”读取全量 Metadata、完整 Org Schema 或重复 Playbook。反过来，最少调用也不意味着猜 Schema 或省略消歧；必要的事实获取是有效调用。

# 诊断取证参考

五类症状只作内部计划参考，不先公开分类，不要求按固定顺序走完所有工具。先理解问题、现有材料、发生时间和适用证据，选择能缩小关键未知的最少充分调用。

| 可能涉及的层面 | 当前能力可提供的证据（仅在启用且授权时） |
| --- | --- |
| 数据 | describe_sobject / list_sobjects 核对未知 Schema；query_records / run_soql_query 用 USER 读取业务条件 |
| 权限 | explain_field_access 归因；实际拒绝和 USER Action Context 区分本次写入限制 |
| 配置 | 已知组件可直接 get_metadata_component_context；未知组件才 list_metadata_components；允许有界 run_diagnostic_tooling_query |
| 代码 | 先复用适用 get_apex_logs / get_debug_log_body；不足且需新执行时才 set_trace_flag 与用户复现 |
| 平台 | get_platform_diagnostics 的异步失败、计划任务和变更时间线，结合已知窗口 |

允许按证据组合或改变调查方向，无需强制报告「换类三句话」。工具缺失时保留可完成的调查，不能绕治理、改身份或将 DIAGNOSTIC 当业务数据读取。无日志不代表无证据；无权限、空白和 INDETERMINATE 不代表健康。

对同步失败可比较同客户不同交易的实际业务条件。另一单成功只能证明那次条件可行；差异是待查项，根因仍需当前订单证据。输出用业务语言、真实标签和有意义的单号，详细取证留内部。

# ADR-0036：创建与编辑的确定性表单上下文

日期：2026-11-06。状态：已实现，验证与真实环境限制见
[设计及验收记录](../RECORD_CHANGE_PRECISION_20261106.md)。

## 决策

Skill 负责理解意图、整理草稿与多轮追问；Context Provider 根据当前 USER、
记录类型、任务应用或 Profile 默认应用，确定桌面标准 New/Edit 的页面分配，
计算 Page Layout、Dynamic Forms 和混合表单的字段状态。显式原生 Create/Update
Quick Action 使用自身布局和 Salesforce 计算的预设值。无法证明的关键条件保持
UNKNOWN，不能退化为已验证的普通页面。不会实现任意 Apex、Flow 或自定义组件解释器。

扩展现有工具的可选 `formContext`，不新增公共工具。上下文始终只读；Host 在既有
治理和托管字段处理后、变更分派前强制重新取证。标准入口仍使用原 DML executor；
原生 Quick Action 仅支持单条工具，通过当前 USER 的原生动作接口执行一次。
未经 Host 预检的 Provider 调用拒绝带有 `formContext` 的输入。旧调用及其他工具保持兼容。

UPDATE 检查所选表单的全部适用必填，使用保存值叠加草稿，提交实际变化。
Quick Action 中显式保持原值可能用于覆盖动作预设，不能因此删掉该字段。
托管策略不能代替 USER 字段权限，也不能伪造 Lightning 初始值或显隐条件。
READY 仅表示支持范围内的所选表单已就绪，最终保存仍由 Salesforce 校验。

USER Describe 的 `defaultedOnCreate` 可证明创建时省略该字段仍会由 Salesforce
赋值（见 [Describe Field](https://developer.salesforce.com/docs/platform/api/guide/sforce-api-calls-describesobjects-describesobjectresult.html)）。
仅当 CREATE 字段完全缺省、必填义务仅来自 API、没有页面/动作必填或未解析动作预设时，
用 `DEFAULT_ON_WRITE` / `SALESFORCE_DEFAULT_ON_WRITE` 表达该义务已由平台承担。
不填造具体值、不参与显隐计算，不覆盖显式 null/空值，也不应用于 UPDATE。

## 身份与配置新鲜度

USER UI API/Describe 提供可访问应用、字段、记录和生成字段事实；独立固定
DIAGNOSTIC scope 只读取配置，并核对同一组织。临时 scope 关闭后恢复审计路由。
新路径不会改变查询、诊断、附件或协议发现的身份及 API 调用。

START/SUBMIT 必须读取当前相关配置，或向 Salesforce 核验各组件版本后复用解析结果。
实现分为请求内 Promise 复用、同任务追问结构缓存和组件版本缓存：

- 追问缓存仅接受 REFINE + 不透明引用，绑定 client、平台用户、Salesforce USER、
  org、Profile、对象、记录类型和动作；最多 32 条/16 MiB、单条 2 MiB、10 分钟到期。
- 组件缓存最多 32 条/4 MiB、单条 1 MiB，仅保存 Profile 默认应用投影、应用分配投影、
  已解析 FlexiPage。键包含组织、API/解析器版本、类型、全名；必须匹配当前组件 ID
  和修改时间。首次读取前后再次核对版本；版本变化保持 UNKNOWN。缺失、无效或 epoch
  时间不能证明新鲜度。CustomObject 每次重新读取。
- 缓存不保存 Connection、凭据、Profile 权限、记录值、草稿、可见性或必填判断结果。
  USER 可访问应用、字段权限、记录状态仍在每次调用中重新读取。

Salesforce 的 [listMetadata](https://developer.salesforce.com/docs/platform/api-metadata/references/utility-calls/meta-listmetadata.html)
返回组件属性，单次最多查询三种类型；
[FileProperties](https://developer.salesforce.com/docs/platform/api-metadata/references/result-objects/meta-retrieveresult.html)
包含组件 ID 与最后修改时间。这是逐组件校验证据，不是跨组件事务快照或写入锁。
精确解析有 45 秒内部上限；既有 Tool/request 超时未更改，Host 超时后不会迟发写入。

## 证据和交付

P7 摘要记录入口、页面、就绪状态、配置来源与计数；具体字段、规则、值来源与
依赖事实进入受保护的按需 UI_CONTEXT Payload。客户端声明与服务端观察分别标记；
`uiContextResolutionId` 只是未验证关联。工具执行成功不等于表单就绪，审计失败仍 fail-open。

没有新增依赖、数据库迁移或官方 Salesforce Tool 实现改动。发布时需一起构建
Context、DML、Host、Playbook 和 Admin Web，并同步业务 Skills。已有旧快照模式仍
按原契约运行；它不构成新精确上下文的新鲜度证明。不能将单元测试、只读 API 探针
或配置命中成功当作真实 Salesforce UI 对照及业务写入验收。

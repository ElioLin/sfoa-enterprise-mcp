# P5 Tool Governance HOTFIX01

适用分支：`feature/p5-admin-control-plane`

## 本次修改

1. 修正 Tool Release 状态误导
   - 原逻辑：只要 `policy.upstreamContract` 不存在，就显示 `NON_GA`。
   - 新逻辑：
     - 已审计 `ga` -> `GA`
     - 已审计 `non-ga` -> `NON_GA`
     - 尚未建立 upstream contract -> `UNKNOWN`
   - 该修复只修正管理端展示语义，不会放宽 `enableAllowed`，不会让未经远程兼容性/安全审计的 Tool 被启用。

2. Tool Governance 页面增加搜索
   - 支持 Tool name、classification、role、release、status、remote、enabled、enableAllowed、dependencies、remark、disabledReason。
   - 支持中英文关键词，例如 `可启用`、`远程兼容`、`enabled`、`GA`。

3. Tool Governance 页面增加分页
   - 默认 20 条/页。
   - 支持 10 / 20 / 50 / 100 条/页。
   - 搜索条件变化自动回到第一页。
   - 页面只渲染当前页，减少大量 Tag/Switch/Button 同时挂载造成的卡顿。

4. 页面增加状态解释和统计
   - 明确说明 `UNKNOWN != Salesforce NON_GA`。
   - 展示 Total / Enable-allowed / Matched 数量。

## 覆盖文件

- `packages/sfoa-admin-api/src/tool-catalog.ts`
- `packages/sfoa-admin-web/src/pages/ToolGovernancePage.tsx`

## 推荐覆盖方式（Windows PowerShell）

在项目根目录执行：

```powershell
# 1. 建议先确认当前分支
git branch --show-current

# 2. 可选：备份原文件
Copy-Item .\packages\sfoa-admin-api\src\tool-catalog.ts .\packages\sfoa-admin-api\src\tool-catalog.ts.bak
Copy-Item .\packages\sfoa-admin-web\src\pages\ToolGovernancePage.tsx .\packages\sfoa-admin-web\src\pages\ToolGovernancePage.tsx.bak

# 3. 将补丁包解压后，把其中 packages 目录复制到项目根目录并允许覆盖

# 4. 验证
yarn workspace @sfoa/admin-api lint
yarn workspace @sfoa/admin-api test
yarn workspace @sfoa/admin-web test
yarn workspace @sfoa/admin-web build
```

## 验收重点

- 进入 Tool governance 页面后默认仅显示 20 行。
- 搜索 `run_soql_query` 能直接定位。
- 搜索 `可启用` 能筛出允许开启的 Tool。
- 原先由于缺少 `upstreamContract` 被显示为 `NON_GA` 的工具现在显示 `UNKNOWN`。
- 真正已审计为 `non-ga` 的工具仍显示 `NON_GA`。
- `UNKNOWN` Tool 的开关依旧不可开启。
- 不影响当前已允许的 8 个 SFoA 远程工具治理结果。

## 验证说明

补丁已做 TypeScript 语法级检查；本执行环境没有该仓库完整 node_modules/workspace，因此无法代替你的项目环境运行完整 Yarn workspace build/test。覆盖后请执行上面的四条验证命令。

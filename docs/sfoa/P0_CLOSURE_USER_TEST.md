# P0-Closure 用户测试指南

本指南用于验证一条固定测试用户链路：

```text
指定 Salesforce Username
  -> JWT Bearer Flow
  -> @salesforce/core Connection
  -> 官方 run_soql_query / retrieve_metadata
```

它不包含 `platformUserId -> Salesforce Username` 自动路由。该能力仍属于 P1。

## 第一步：配置 `.env.local`

在仓库根目录执行：

```powershell
Copy-Item .env.example .env.local
```

编辑 `.env.local`：

```dotenv
SFOA_INSTANCE_URL=https://你的-SFoA-My-Domain
SALESFORCE_USERNAME=测试用户的完整用户名
CONNECTED_APP_CLIENT_ID=Connected-App-Consumer-Key
JWT_PRIVATE_KEY_PATH=D:\absolute\path\server.key
SALESFORCE_ALIAS=本地测试别名
TEST_OBJECT=Account
TEST_METADATA_TYPE=CustomObject
TEST_METADATA_FULL_NAME=Lead
SFOA_DEBUG_EXPOSE_TOKEN=false
```

要求：

- `SFOA_INSTANCE_URL` 使用 SFoA 实际 My Domain/受支持登录根地址，不要写死 `login.salesforce.com`。
- `JWT_PRIVATE_KEY_PATH` 推荐使用绝对路径；私钥不得放入 Git。
- P0 升级 PASS 的 Metadata 核心 Gate 必须至少成功测试一次 `CustomObject`。
- `.env.local` 已被 `.gitignore` 忽略。不要把真实值复制到 `.env.example`、Markdown、JSON evidence 或提交日志。

## 第二步：运行 Credential Validation Harness

从仓库根目录执行：

```powershell
yarn workspace @sfoa/runtime-validation validate
```

Harness 会依次执行 Fresh JWT、Identity、Direct SOQL、官方 `run_soql_query`、临时 DX Workspace 和官方 `retrieve_metadata`。它不读取本机 CLI Auth Cache，也不启动 `sf` 子进程。

## 第三步：仅在本地控制台查看完整 Token

默认值 `false` 会显示遮罩 Token。需要人工核对时，临时修改：

```dotenv
SFOA_DEBUG_EXPOSE_TOKEN=true
```

然后重新运行 Harness。此时完整 Token 只会打印到当前控制台。不要重定向输出到文件，不要复制到 Issue、聊天、Markdown、JSON 或 Git。核对完成后立即恢复：

```dotenv
SFOA_DEBUG_EXPOSE_TOKEN=false
```

## 第四步：判断 SOQL 测试

Harness 自动执行：

```sql
SELECT Id
FROM <TEST_OBJECT>
LIMIT 5
```

它只打印对象名、行数和耗时，不保存业务记录。以下两项都必须 PASS：

```text
DIRECT_SOQL = PASS
OFFICIAL_RUN_SOQL_QUERY = PASS
```

如果 Direct PASS、Official FAIL，优先定位 Provider/Host 集成；如果两者均 FAIL，优先检查认证、连接、对象权限或 SFoA 可达性。

## 第五步：判断 Metadata 测试

Harness 在系统临时目录建立最小 DX Project 和 `package.xml`，通过官方 `retrieve_metadata` 获取 `TEST_METADATA_TYPE:TEST_METADATA_FULL_NAME`，统计生成文件后清理临时目录。

P0 核心测试建议：

```dotenv
TEST_METADATA_TYPE=CustomObject
TEST_METADATA_FULL_NAME=Lead
```

如需验证其他类型，可每次替换为一个明确存在且当前用户可读取的组件，例如：

```text
ValidationRule  Account.Rule_API_Name
Flow            Flow_API_Name
ApexClass       ClassApiName
ApexTrigger     TriggerApiName
Layout          Account-Account Layout
FlexiPage       FlexiPageApiName
```

每次运行只记录状态、类型、文件数和错误，不提交组件内容。

## 第六步：判断总结果

`P0 Closure Runtime Result: PASS` 要求 Fresh JWT、Token、Identity Match、Direct Connection、Direct SOQL、官方 SOQL、至少一个 `CustomObject` Metadata、临时 Workspace、CWD 最终恢复和 Provider Compatibility 全部满足。

常见非 PASS 情况：

- `NOT TESTED`：缺少 `.env.local` 或必填值。
- `FAIL`：控制台会显示经过脱敏的真实错误和建议检查项。
- 官方 Tool 未自行恢复 CWD：Harness 会在 `finally` 中恢复，并明确打印这一 Upstream 风险；生产并发隔离仍由后续阶段处理。

## 可选：Salesforce CLI 交叉检查

CLI 只用于开发诊断，不是生产 Runtime 依赖。CLI 不会自动读取 `.env.local`；请在当前 Shell 临时设置同名 `$env:` 变量（不要写入 PowerShell Profile 或系统环境变量）。新终端中的 `sf` 应解析到 v2 后，可执行：

```powershell
sf org login jwt --client-id $env:CONNECTED_APP_CLIENT_ID --jwt-key-file $env:JWT_PRIVATE_KEY_PATH --username $env:SALESFORCE_USERNAME --instance-url $env:SFOA_INSTANCE_URL --alias $env:SALESFORCE_ALIAS
sf org display --target-org $env:SALESFORCE_ALIAS
sf data query --target-org $env:SALESFORCE_ALIAS --query "SELECT Id FROM $env:TEST_OBJECT LIMIT 5"
```

生产目标始终是 `Node.js -> JWT/OAuth -> @salesforce/core -> official Provider`，不是 `spawn sf`。

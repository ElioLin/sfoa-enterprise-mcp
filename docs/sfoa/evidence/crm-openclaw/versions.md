# 版本与目标环境（2026-10-22）

## 代码基线

| 工程 | 分支 | HEAD |
| --- | --- | --- |
| sfoa-enterprise-mcp | `feature/crm-openclaw-entry` | `12df237f7ab03c4771109813b84f715a29e9e32d`（创建分支时的 `origin/main`） |
| crm | `uat` | `a55870ad5a8a801f18e669933db325cd3c24760d`（本次未切换分支、未提交） |

## 运行环境

| 项 | 值 |
| --- | --- |
| 本地 Node | `v24.13.0` |
| Yarn | `1.22.22` |
| 本地 MySQL | `8.0.30` |
| MySQL schema | `sfoa_enterprise_mcp`（本次迁移前 15 个 migration，迁移后 16 个） |
| OpenClaw 测试服 | `crm-ex-test02` / `192.168.156.203`，实际版本 **2026.9.5 (ec9c1a1)** |

## Salesforce 目标（只读核对）

| 项 | 值 |
| --- | --- |
| 实例 | `runnergroup--uat.sandbox.my.sfcrmproducts.cn` |
| OrgId | `00DC5000000lGFpMAM` |
| 类型 | 沙盒（UAT） |
| 实例 API 版本 | 68.0 |
| 可用真实账号 | 至少两名已连接用户（仅用于只读/隔离验证；本次未做写入） |

说明：未执行部署，未修改沙盒元数据；上述信息来自 CRM 工程已有连接与只读探测。任何访问令牌都未写入本目录。

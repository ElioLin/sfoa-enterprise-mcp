# UAT 实际部署记录（2026-10-22）

## 目标

| 项 | 值 |
| --- | --- |
| 组织 | SFoA UAT 沙盒 |
| OrgId | `00DC5000000lGFpMAM` |
| 实例 | `runnergroup--uat.sandbox.my.sfcrmproducts.cn` |
| API | 68.0 |
| 部署账号 | `crm_admin2@runner-corp.com.cn.uat`（具备 `ModifyMetadata`；不是业务测试身份） |
| CRM 远端基线 | `origin/uat@3d65656`（fetch 后与当前 HEAD 一致） |
| 本次组件是否在远端已存在 | 否；14 个路径全部为新增，部署包只含本次新增文件 |

## 部署包

临时目录：`D:\GitProject\_crm-openclaw-uat-deploy`（不在 CRM 工程内；只复制本次 14 个新增文件）

```text
metadata/
  package.xml
  classes/SfoaCrmChatIdentity.cls(.cls-meta.xml)
  classes/SfoaCrmChatIdentityTest.cls(.cls-meta.xml)
  objects/SFOA_CRM_Chat_Config__c.object
  lwc/sfoaCrmChat/{js,html,css,js-meta.xml}
  aura/sfoaCrmChatUtilityBar/{cmp,cmp-meta.xml}
  permissionsets/Sfoa_Crm_Chat_Access.permissionset-meta.xml
```

## 命令与结果

### Check-only（Metadata API）

```text
sfdx force:mdapi:deploy --checkonly --deploydir metadata \
  --targetusername crm_admin2@runner-corp.com.cn.uat \
  --wait 30 --testlevel RunSpecifiedTests \
  --runtests SfoaCrmChatIdentityTest --json
```

结果：

| 项 | 值 |
| --- | --- |
| Deployment ID | `0AfC5000005GOzZKAW` |
| status | `Succeeded` |
| components deployed | 12 |
| component errors | 0 |
| tests completed | 7 |
| test errors | 0 |

### 正式部署

```text
sfdx force:mdapi:deploy --deploydir metadata \
  --targetusername crm_admin2@runner-corp.com.cn.uat \
  --wait 30 --testlevel RunSpecifiedTests \
  --runtests SfoaCrmChatIdentityTest --json
```

结果：

| 项 | 值 |
| --- | --- |
| Deployment ID | `0AfC5000005GP4PKAW` |
| status | `Succeeded` |
| components deployed | 12 |
| component errors | 0 |
| tests completed | 7 |
| test errors | 0 |

组件：Custom Setting `SFOA_CRM_Chat_Config__c`（含 6 个字段）、Apex `SfoaCrmChatIdentity`、`SfoaCrmChatIdentityTest`、LWC `sfoaCrmChat`、Aura `sfoaCrmChatUtilityBar`、Permission Set `Sfoa_Crm_Chat_Access`。

## 只读核对

```text
SELECT Name, ApiVersion, Status FROM ApexClass
WHERE Name IN ('SfoaCrmChatIdentity','SfoaCrmChatIdentityTest')
```

结果：两个类均 `Active`，API 62。

Custom Setting 组织级记录：

```text
Id                  a2vC5000000M65BIAS
SetupOwnerId        00DC5000000lGFpMAM
Enabled__c          false
Endpoint__c         (空)
Certificate_Name__c (空)
Issuer__c           sfoa-crm-apex
Audience__c         sfoa-crm-gateway
Ttl_Seconds__c      90
```

> 记录刻意保持 `Enabled__c=false`。接入服务、证书与 OpenClaw/MCP 链路尚未部署/配置；启用会产生无效入口。

## 已遇到并处理的 CLI 问题

1. `sf project deploy validate` 在 SFoA 上报 `INVALID_TYPE: sObject type 'Organization' is not supported`，未进入真正的 metadata 验证。改用 Metadata API `sfdx force:mdapi:deploy`。
2. 首次 check-only 使用业务账号 `candy.zheng@...`，Salesforce 返回 `INSUFFICIENT_ACCESS: use of the Metadata API requires a user with the ModifyAllData or ModifyMetadata permissions`。改用已连接的部署管理员 `crm_admin2@...` 后通过；未使用业务账号做任何写操作。
3. 未执行 `git pull`/`merge`/`rebase`：CRM 工作区有用户既有改动；只执行 `git fetch origin`，确认 `origin/uat@3d65656` 与当前 HEAD 一致，且本次 14 个路径在远端不存在。部署包只含新增文件，不覆盖既有元数据。

## 尚未执行（需用户决定/配置）

- Permission Set 分配（未给任何用户分配）。
- 将 `sfoaCrmChatUtilityBar` 加入目标 Lightning App 的 Utility Bar（未修改任何既有 app 元数据）。
- 创建/选择签名证书，填写 `Certificate_Name__c` 与 `Endpoint__c`，再将 `Enabled__c=true`。
- 部署接入服务、OpenClaw 插件、MCP CRM 渠道、`crm:bind` 绑定。
- 真实双用户 OpenClaw→MCP→Salesforce 与 Lightning 浏览器 UAT。

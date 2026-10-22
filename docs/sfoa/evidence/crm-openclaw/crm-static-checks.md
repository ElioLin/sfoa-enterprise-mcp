# CRM 元数据静态检查证据（2026-10-22）

工程：`D:\GitProject\crm`（分支 `uat`，HEAD `a55870a`，本次未提交、未部署）

## 已执行

| 检查 | 结果 |
| --- | --- |
| 新增 XML/metadata 文件按 UTF-8 解析 | PASS（Custom Setting、Apex meta、LWC meta、Aura meta、Permission Set、manifest） |
| 精确 manifest XML 解析 | PASS |
| LWC `sfoaCrmChat.js` 语法（去除 LWC 装饰器后 `node --check`） | PASS |
| Apex 文件结构/命名/配套 meta | 已静态核对；**未编译** |
| Apex 测试类 | 已编写；**未运行** |
| 沙盒部署/验证 | **未执行** |

## 未执行的原因

- 本地 CRM 工程没有 SFDX 项目文件或 Apex 编译器；`sf` CLI 连接的沙盒未获本次明确部署授权。
- 未对沙盒做任何 metadata 写入、Apex 测试或 Apex 匿名执行。

## 关键文件

```text
runner-product/src/classes/SfoaCrmChatIdentity.cls
runner-product/src/classes/SfoaCrmChatIdentityTest.cls
runner-product/src/objects/SFOA_CRM_Chat_Config__c.object
runner-product/src/lwc/sfoaCrmChat/{sfoaCrmChat.js,html,css,js-meta.xml}
runner-product/src/aura/sfoaCrmChatUtilityBar/{cmp,cmp-meta.xml}
runner-product/src/permissionsets/Sfoa_Crm_Chat_Access.permissionset-meta.xml
runner-product/manifest/crm-openclaw/{package.xml,destructiveChanges.xml}
```

## 需要的真实证据（部署后补）

- `sf project deploy validate/start` 的 compile 结果与 `SfoaCrmChatIdentityTest` 运行结果。
- 真实 Lightning 页面中 Utility Bar/LWC 的登录、发送、流式、历史、停止流程。
- 两名真实 Salesforce 账号经 OpenClaw → MCP → Salesforce 的只读调用与审计行。

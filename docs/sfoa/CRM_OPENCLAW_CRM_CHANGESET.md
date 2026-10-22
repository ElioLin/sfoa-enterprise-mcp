# CRM 工程专项变更清单

日期：2026-10-22
工程：`D:\GitProject\crm`
当前分支：`uat`
开始 HEAD：`a55870ad5a8a801f18e669933db325cd3c24760d`
本次是否提交：**否**
本次是否部署：**否（仅本地修改）**

## 一、基线与原有改动区分

- 开始前工作区已存在大量未提交修改（约 147 个 `M`、94 个 `A`、2425 个未跟踪文件，含 `utilityBarAgentWrapper` 等既有组件）。这些都不是本次改动。
- 本次只新增下列 14 个文件；未修改任何既有 Apex、Trigger、Flow、Layout、Profile、FlexiPage 或应用元数据。
- 未使用 `git add -A`、`commit -am`、reset、clean、stash；未切换分支、未 pull/rebase。
- 本清单的哈希以本文档生成时的工作区文件为准；若后续修订文件，必须重算。

## 二、逐文件清单

| # | 相对路径 | Metadata 类型 | 新增/修改 | 对应功能 | 修改原因 | 部署依赖 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `runner-product/src/classes/SfoaCrmChatIdentity.cls` | ApexClass | 新增 | 当前用户身份签发 | UserInfo 取 OrgId/UserId/Username，证书签名 90s token | Certificate、Custom Setting |
| 2 | `runner-product/src/classes/SfoaCrmChatIdentity.cls-meta.xml` | ApexClass 配套 | 新增 | 同上 | API 62 / Active | 无 |
| 3 | `runner-product/src/classes/SfoaCrmChatIdentityTest.cls` | ApexClass | 新增 | Apex 测试 | 覆盖 base64url、payload、UUID、endpoint、禁用/缺证书/无效证书分支 | 被测试类 |
| 4 | `runner-product/src/classes/SfoaCrmChatIdentityTest.cls-meta.xml` | ApexClass 配套 | 新增 | 同上 | API 62 / Active | 无 |
| 5 | `runner-product/src/objects/SFOA_CRM_Chat_Config__c.object` | CustomObject（Hierarchy Custom Setting） | 新增 | 端点/证书名/issuer/audience/TTL/启用开关 | Apex 读取非机密配置；私钥不在此 | 无 |
| 6 | `runner-product/src/lwc/sfoaCrmChat/sfoaCrmChat.js` | LightningComponentBundle | 新增 | 聊天 UI 逻辑 | 身份引导、对话、SSE、停止、错误/安全渲染 | Apex 类、Custom Setting、CSP/CORS |
| 7 | `runner-product/src/lwc/sfoaCrmChat/sfoaCrmChat.html` | LightningComponentBundle | 新增 | 聊天 UI 模板 | SLDS 中文界面、只读账号、历史/发送/停止 | 同上 |
| 8 | `runner-product/src/lwc/sfoaCrmChat/sfoaCrmChat.css` | LightningComponentBundle | 新增 | 聊天 UI 样式 | Utility Bar 高度、响应式、气泡/错误 | 无 |
| 9 | `runner-product/src/lwc/sfoaCrmChat/sfoaCrmChat.js-meta.xml` | LightningComponentBundle 配套 | 新增 | 暴露目标 | Record/App/Home Page；Utility Bar 由 Aura 包装 | 无 |
| 10 | `runner-product/src/aura/sfoaCrmChatUtilityBar/sfoaCrmChatUtilityBar.cmp` | AuraDefinitionBundle | 新增 | Utility Bar 包装 | Utility Bar 入口承载 LWC | LWC |
| 11 | `runner-product/src/aura/sfoaCrmChatUtilityBar/sfoaCrmChatUtilityBar.cmp-meta.xml` | AuraDefinitionBundle 配套 | 新增 | 同上 | API 62 | 无 |
| 12 | `runner-product/src/permissionsets/Sfoa_Crm_Chat_Access.permissionset-meta.xml` | PermissionSet | 新增 | 授予 Apex 类访问 | 最小权限；不授予业务对象权限 | Apex 类 |
| 13 | `runner-product/manifest/crm-openclaw/package.xml` | Metadata manifest | 新增 | 精确部署清单 | 只部署本次新增组件 | 无 |
| 14 | `runner-product/manifest/crm-openclaw/destructiveChanges.xml` | Metadata manifest | 新增 | 回退清单 | 可选删除本次组件 | 无 |

## 三、是否影响既有 Apex/Trigger/Flow/布局/权限

- 既有 Apex/Trigger/Flow：**未修改**。
- 应用布局/Utility Bar：**未修改现有 app 元数据**；管理员需手工把 `sfoaCrmChatUtilityBar` 加入目标 app 的 Utility Bar（见部署文档）。
- 权限：只新增 Permission Set；未批量修改 Profile，未扩大业务对象权限。
- 为什么必须新增独立组件：入口身份签发、UI 包装和配置都是新能力；复用既有业务 Apex 会把聊天身份写入无关业务类，扩大回归面。

## 四、配套文件完整性

- 每个 Apex 类均有 `.cls-meta.xml`。
- LWC 有 `.js-meta.xml`；Aura 有 `.cmp-meta.xml`。
- Custom Setting 单文件 `.object` 包含字段定义。
- Permission Set 为 `permissionset-meta.xml`。
- 部署使用 `manifest/crm-openclaw/package.xml`；回退使用同名目录的 `destructiveChanges.xml`。

## 五、文件校验值（SHA-256）

| 相对路径 | 字节 | SHA-256 |
| --- | ---: | --- |
| `runner-product/src/classes/SfoaCrmChatIdentity.cls` | 6294 | `c30bce60654b39fb0a7c4cda2937efbadd5e8e51a91d03c9f97b8679fced0b72` |
| `runner-product/src/classes/SfoaCrmChatIdentity.cls-meta.xml` | 174 | `3a31d117e3c855b937d340b20754b03ad66c0c156d57b7c64011aa5437437b51` |
| `runner-product/src/classes/SfoaCrmChatIdentityTest.cls` | 4302 | `6814ccdc9e456b75a37738217b508aea0d60ff39e153d3d6d9b69eeb84a30e3f` |
| `runner-product/src/classes/SfoaCrmChatIdentityTest.cls-meta.xml` | 174 | `3a31d117e3c855b937d340b20754b03ad66c0c156d57b7c64011aa5437437b51` |
| `runner-product/src/objects/SFOA_CRM_Chat_Config__c.object` | 3262 | `79d0fec56c9d0de51e30372e1d45cca6cdaaee80e2f37a014f46d27d9c2f0ec7` |
| `runner-product/src/lwc/sfoaCrmChat/sfoaCrmChat.js` | 23632 | `ad775a72aee149a0fc54bc90a8175a762db082923872132b5b01e673b038d121` |
| `runner-product/src/lwc/sfoaCrmChat/sfoaCrmChat.html` | 5928 | `8556f89dafc8603dd4786c18618a4d8b9e2ca9948dab07cc7b203ac058fec3f1` |
| `runner-product/src/lwc/sfoaCrmChat/sfoaCrmChat.css` | 4189 | `ca4f11181ff03a66f622cd6d44a8c04a981b167bf1b34150643d69a7539e8919` |
| `runner-product/src/lwc/sfoaCrmChat/sfoaCrmChat.js-meta.xml` | 504 | `6bbfe69dc71f6c75e5b480c55e83de0692be9a141194da5b28fc5ba0a8a4d4cc` |
| `runner-product/src/aura/sfoaCrmChatUtilityBar/sfoaCrmChatUtilityBar.cmp` | 200 | `7b299b74994620bc0f76fbb07d72a99eff18546bb691cfdbb76ee40adba13b89` |
| `runner-product/src/aura/sfoaCrmChatUtilityBar/sfoaCrmChatUtilityBar.cmp-meta.xml` | 270 | `88355ac5ba91f99777bc70b54ddc21229d3566a2856637bcd945c218cf801b35` |
| `runner-product/src/permissionsets/Sfoa_Crm_Chat_Access.permissionset-meta.xml` | 548 | `295d15fa6a02ce4e144d43f6eb79569ccb957a2f3f81f3cdeb15c6a5335496ab` |
| `runner-product/manifest/crm-openclaw/package.xml` | 961 | `83c49f6151dea8c0e6fca2326d760941cc796fcd657c9e90fa5e979f12877b86` |
| `runner-product/manifest/crm-openclaw/destructiveChanges.xml` | 1034 | `0c7e3d7083f7ad07a0032df25cd68ca28e1ffe4004c4f555f78d787ca8b5feed` |

## 六、验证与回退

- 静态验证：所有新增 XML 按 UTF-8 解析通过；LWC JS 去装饰器后 `node --check` 通过；Apex 未编译。
- 部署验证：**尚未执行**；无 Deployment ID、无 Apex 测试结果。
- 回退：先从 app 移除 Utility Bar 项，取消 Permission Set 分配；随后用 `destructiveChanges.xml` 删除本次组件；最后禁用/删除 Custom Setting 记录与证书引用。详见 `CRM_OPENCLAW_DEPLOYMENT.md`。
- 本地交付位置：CRM 源码保留在本工程；完整补丁/校验值见本文件与 `docs/sfoa/evidence/crm-openclaw/`。

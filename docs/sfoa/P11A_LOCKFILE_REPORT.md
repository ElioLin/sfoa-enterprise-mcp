# P11-A 锁文件窄范围同步

基线 main@12df237f7ab03c4771109813b84f715a29e9e32d。所有 root/workspace 依赖声明和版本保持，未合并任何 Dependabot 更新。使用 Node 22.23.1 / Yarn Classic 1.22.22，以原 yarn.lock 为输入正常同步；没有删除或重新生成整份旧锁。

| 对照项 | 结果 |
| --- | --- |
| 原 selector / 新 selector | 2052 / 2307 |
| 新增 selector | 255：24 个直接声明 selector，231 个传递 selector |
| 原缺失声明引用 | 50 处，对应 24 个不同 selector |
| 原锁定条目 / 新条目 | 1573 / 1770 |
| 新增锁定条目 | 197：84 个由 runtime dependencies 可达，113 个仅由 devDependencies 可达 |
| 删除 selector | 0 |
| 改变的已有 version / resolved / integrity | 0 |
| 无法追踪来源的新增条目 | 0 |

新增的不是 manifest 声明，而是这些既有声明缺少的锁定记录。其中 8 个新 selector 复用已有 resolution；24 个直接 selector 中有 4 个属于这种情况。因此新增 selector 数不等于新增代码版本数。完整逐项清单见 [lock-delta.json](evidence/p11a/lock-delta.json)：每个新增 selector/条目均列出 version、resolved、integrity、直接消费者、父 selector、运行与开发影响闭包。

## 24 个直接声明 selector

| selector | 锁定版本 | 原声明消费者 |
| --- | --- | --- |
| `@ant-design/icons@6.3.2` | 6.3.2 | @sfoa/admin-web (dependencies) |
| `@jsforce/jsforce-node@3.10.13` | 3.10.13 | @sfoa/identity-runtime (dependencies) |
| `@modelcontextprotocol/sdk@1.18.2` | 1.18.2 | @sfoa/mcp-provider-sfoa-context (dependencies); @sfoa/mcp-provider-sfoa-data (dependencies); @sfoa/mcp-provider-sfoa-dml (dependencies); @sfoa/identity-runtime (dependencies); @sfoa/mcp-server (dependencies); @sfoa/runtime-validation (dependencies) |
| `@playwright/test@1.62.1` | 1.62.1 | @sfoa/admin-web (devDependencies) |
| `@salesforce/core@8.29.0` | 8.29.0 | @sfoa/mcp-provider-sfoa-context (dependencies); @sfoa/mcp-provider-sfoa-data (dependencies); @sfoa/mcp-provider-sfoa-dml (dependencies); @sfoa/identity-runtime (dependencies); @sfoa/mcp-server (dependencies); @sfoa/runtime-validation (dependencies) |
| `@tanstack/react-query@5.102.0` | 5.102.0 | @sfoa/admin-web (dependencies) |
| `@testing-library/dom@10.4.1` | 10.4.1 | @sfoa/admin-web (devDependencies) |
| `@testing-library/jest-dom@7.0.1` | 7.0.1 | @sfoa/admin-web (devDependencies) |
| `@testing-library/react@16.3.2` | 16.3.2 | @sfoa/admin-web (devDependencies) |
| `@testing-library/user-event@14.6.6` | 14.6.6 | @sfoa/admin-web (devDependencies) |
| `@types/node@22.16.5` | 22.16.5 | @sfoa/mcp-provider-sfoa-context (devDependencies); @sfoa/mcp-provider-sfoa-data (devDependencies); @sfoa/mcp-provider-sfoa-dml (devDependencies); @sfoa/admin-api (devDependencies); @sfoa/admin-web (devDependencies); @sfoa/agent-playbook (devDependencies); @sfoa/control-plane (devDependencies); @sfoa/identity-runtime (devDependencies); @sfoa/mcp-server (devDependencies); @sfoa/runtime-validation (devDependencies) |
| `@types/react-dom@19.2.4` | 19.2.4 | @sfoa/admin-web (devDependencies) |
| `@types/react@19.2.18` | 19.2.18 | @sfoa/admin-web (devDependencies) |
| `@vitejs/plugin-react@6.1.0` | 6.1.0 | @sfoa/admin-web (devDependencies) |
| `antd@6.6.1` | 6.6.1 | @sfoa/admin-web (dependencies) |
| `jsdom@29.0.0` | 29.0.0 | @sfoa/admin-web (devDependencies) |
| `kysely@0.29.5` | 0.29.5 | @sfoa/control-plane (dependencies) |
| `mysql2@3.23.4` | 3.23.4 | @sfoa/control-plane (dependencies) |
| `react-dom@19.2.8` | 19.2.8 | @sfoa/admin-web (dependencies) |
| `react-router-dom@7.18.2` | 7.18.2 | @sfoa/admin-web (dependencies) |
| `react@19.2.8` | 19.2.8 | @sfoa/admin-web (dependencies) |
| `vite@8.2.2` | 8.2.2 | @sfoa/admin-web (devDependencies) |
| `vitest@4.1.11` | 4.1.11 | @sfoa/admin-web (devDependencies) |
| `zod@3.25.76` | 3.25.76 | @sfoa/mcp-provider-sfoa-context (dependencies); @sfoa/mcp-provider-sfoa-data (dependencies); @sfoa/mcp-provider-sfoa-dml (dependencies); @sfoa/admin-api (dependencies); @sfoa/control-plane (dependencies); @sfoa/identity-runtime (dependencies); @sfoa/mcp-server (dependencies); @sfoa/runtime-validation (dependencies) |

## 新增运行依赖的范围

以下 84 个条目由当前 dependencies/optionalDependencies 可达；影响范围沿 Yarn 的本地 workspace 声明关系和 lock 边推导。这是声明闭包，尚未逐项证明 import type 消除、实际打包/调用或生产暴露面。开发依赖的 113 个条目与全部 231 个传递 selector 也逐项保存在 JSON，不把 devDependency 推断为已加载进生产服务。

| 新增锁定条目 | 运行消费者闭包 | registry 来源 |
| --- | --- | --- |
| `@ant-design/colors@8.0.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `@ant-design/cssinjs-utils@2.1.2` | @sfoa/admin-web | registry.yarnpkg.com |
| `@ant-design/cssinjs@2.1.2` | @sfoa/admin-web | registry.yarnpkg.com |
| `@ant-design/fast-color@3.0.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `@ant-design/icons-svg@4.6.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@ant-design/icons@6.3.2` | @sfoa/admin-web | registry.yarnpkg.com |
| `@ant-design/icons@6.3.4` | @sfoa/admin-web | registry.yarnpkg.com |
| `@ant-design/react-slick@2.0.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@babel/runtime@7.29.10` | @sfoa/admin-web | registry.yarnpkg.com |
| `@babel/runtime@8.0.7` | @sfoa/admin-web | registry.yarnpkg.com |
| `@emotion/hash@0.8.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@emotion/unitless@0.7.5` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/async-validator@6.0.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/cascader@1.22.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/checkbox@2.0.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/collapse@1.2.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/color-picker@3.1.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/context@2.0.2` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/dialog@1.10.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/drawer@1.4.2` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/dropdown@1.0.3` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/form@1.8.6` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/image@1.10.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/input-number@1.6.2` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/input@1.3.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/listy@1.2.3` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/mentions@1.11.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/menu@1.4.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/mini-decimal@1.1.4` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/motion@1.3.3` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/mutate-observer@2.0.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/notification@2.0.9` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/overflow@1.0.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/pagination@1.4.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/picker@1.12.2` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/portal@2.2.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/progress@1.0.3` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/qrcode@2.0.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/rate@1.0.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/resize-observer@1.1.2` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/segmented@1.3.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/select@1.10.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/slider@1.1.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/steps@1.2.3` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/switch@1.0.3` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/table@1.11.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/tabs@1.12.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/tooltip@1.5.2` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/tour@2.4.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/tree-select@1.16.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/tree@1.4.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/trigger@3.10.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/upload@1.1.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/util@1.14.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@rc-component/virtual-list@1.5.2` | @sfoa/admin-web | registry.yarnpkg.com |
| `@tanstack/query-core@5.102.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `@tanstack/react-query@5.102.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `antd@6.6.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `aws-ssl-profiles@1.1.2` | @sfoa/admin-api, @sfoa/admin-web, @sfoa/control-plane, @sfoa/mcp-server | registry.yarnpkg.com |
| `compute-scroll-into-view@3.1.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `cookie@1.1.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `csstype@3.2.3` | @sfoa/admin-web | registry.yarnpkg.com |
| `dayjs@1.11.23` | @sfoa/admin-web | registry.yarnpkg.com |
| `generate-function@2.3.1` | @sfoa/admin-api, @sfoa/admin-web, @sfoa/control-plane, @sfoa/mcp-server | registry.yarnpkg.com |
| `iconv-lite@0.7.3` | @sfoa/admin-api, @sfoa/admin-web, @sfoa/control-plane, @sfoa/mcp-server | registry.yarnpkg.com |
| `is-mobile@5.0.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `is-property@1.0.2` | @sfoa/admin-api, @sfoa/admin-web, @sfoa/control-plane, @sfoa/mcp-server | registry.yarnpkg.com |
| `json2mq@0.2.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `kysely@0.29.5` | @sfoa/admin-api, @sfoa/admin-web, @sfoa/control-plane, @sfoa/mcp-server | registry.yarnpkg.com |
| `lru.min@1.1.5` | @sfoa/admin-api, @sfoa/admin-web, @sfoa/control-plane, @sfoa/mcp-server | registry.yarnpkg.com |
| `mysql2@3.23.4` | @sfoa/admin-api, @sfoa/admin-web, @sfoa/control-plane, @sfoa/mcp-server | registry.yarnpkg.com |
| `named-placeholders@1.1.6` | @sfoa/admin-api, @sfoa/admin-web, @sfoa/control-plane, @sfoa/mcp-server | registry.yarnpkg.com |
| `react-dom@19.2.8` | @sfoa/admin-web | registry.yarnpkg.com |
| `react-is@19.3.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `react-router-dom@7.18.2` | @sfoa/admin-web | registry.yarnpkg.com |
| `react-router@7.18.2` | @sfoa/admin-web | registry.yarnpkg.com |
| `react@19.2.8` | @sfoa/admin-web | registry.yarnpkg.com |
| `scheduler@0.27.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `scroll-into-view-if-needed@3.1.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `set-cookie-parser@2.7.2` | @sfoa/admin-web | registry.yarnpkg.com |
| `sql-escaper@1.5.2` | @sfoa/admin-api, @sfoa/admin-web, @sfoa/control-plane, @sfoa/mcp-server | registry.yarnpkg.com |
| `string-convert@0.2.1` | @sfoa/admin-web | registry.yarnpkg.com |
| `stylis@4.4.0` | @sfoa/admin-web | registry.yarnpkg.com |
| `throttle-debounce@5.0.2` | @sfoa/admin-web | registry.yarnpkg.com |

SDK 1.18.2、Salesforce core 8.29.0、jsforce 3.10.13、Kysely 0.29.5、mysql2 3.23.4 均为本批之前已声明的精确版本；现补齐其缺失的精确 selector 和所需传递记录；SDK/core/zod 等若复用了旧条目，完整 JSON 已单独标记。旧范围消费者的已锁版本继续保留，并存不等于统一升级或覆盖。Admin Web 的 React/Ant Design/router/query 与测试工具也按现有精确声明锁定。

实际运行依赖图因此比不完整仓库锁文件更完整。不能只用 manifest 未改来断言运行依赖绝对相同。这里没有读取生产服务器的 lock 或 node_modules；正常业务行为由原测试、真实临时 MySQL、fake Salesforce fullstack 和协议回归覆盖，真实 Org/UAT 另记 NOT_TESTED。

## 生成与验证

来源：[Linux 取证运行](https://github.com/ElioLin/sfoa-enterprise-mcp/actions/runs/39217477942)，source head 4b06f9ac365db05197ffa0b603422fe04c9c0874；normal install 与随后 frozen install 均退出 0，全部 manifest 无漂移，完整 21 workspace 构建退出 0。该次默认测试出现 Node 22 生命周期取消，保留为失败记录，不能当作整体验收 PASS。

生成文件 SHA-256：`a8fa6e00390ab62124bef1ce4fbe2a3f9bf85de05ea92904b14abdfcec44cd2b`，647201 bytes。最终提交后的固定锁文件由 [双平台验收](https://github.com/ElioLin/sfoa-enterprise-mcp/actions/runs/39222820613) 及最终 PR 的独立 frozen CI 再验证。frozen 后还执行正常 install，任何 manifest/lock diff 都失败，防止 Classic frozen 的缺项解析行为掩盖不完整传递锁。

公开安全公告关联与十个旧 PR 的恢复见 [分支/PR 盘点](P11_BRANCH_INVENTORY.md)。本批未改变私有告警或安全更新开关，也未用依赖升级修复测试。

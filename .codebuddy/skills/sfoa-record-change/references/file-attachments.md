# File Attachments

本文件覆盖 `upload_files_to_record` 的 doctrine：把一个**平台已经收到的文件**附加到**一条已存在的记录**上。

v1 范围：**1 条记录 × 1..N 个文件**。不含已有文件重挂、版本更新、删除、下载与公开链接。

## 当前 attachment contract（以代码为准）

| 事实 | 值 |
| --- | --- |
| Tool | `upload_files_to_record`（唯一一个附件 Tool，只有复数形式） |
| 入参 | `objectApiName`、`recordId`、`attachmentRefs` 1..10 |
| 入参**不含** | 文件内容、base64、字节数组、文件名、本地路径、URL、Token |
| 授权 | `attachmentEnabled`（对象的独立授权，默认关闭） |
| 结果 | 逐文件 `SUCCESS` / `FAILED` / `OUTCOME_UNKNOWN` / `NOT_ATTEMPTED`；聚合 `SUCCESS` / `PARTIAL_SUCCESS` / `FAILED` / `OUTCOME_UNKNOWN` |

## 硬规则

1. **附件是独立能力** — `attachmentEnabled` 与 CREATE / UPDATE 互不蕴含。对象可写不等于可收附件；对象可收附件也不等于可写。**MUST NOT** 用 CREATE 或 UPDATE 的授权推断附件能力，也**MUST NOT** 因为附件可用就认为记录可写。
2. **目标先行** — 记录必须**已经存在**，且属于传入的 `objectApiName`。附件不创建记录。记录不存在时如实说明，**MUST NOT** 用 `create_record` 顺手造一条来「接住」文件，除非用户本来就要创建它。
3. **只接受 `attachmentRef`** — Agent **MUST NOT** 要求用户粘贴文件内容、base64、字节数组、服务器路径或任何 URL；**MUST NOT** 为了上传而读取文件。引用由 SFOA Attachment Ingress 在文件随消息到达时生成，并由平台注入到当前会话上下文。
4. **引用有归属** — 只能使用**当前用户在当前会话**获得的 `attachmentRef`。**MUST NOT** 猜测、构造、变形或复用他人的引用，也**MUST NOT** 凭文件名推断引用。引用被拒绝时返回稳定错误码，如实报告即可，**MUST NOT** 改动引用重试。
5. **Files 是内部技术对象** — `ContentVersion`、`ContentDocument`、`ContentDocumentLink` 不是业务对象。**MUST NOT** 把它们传给 `create_record` / `create_records` / `update_record` / `update_records`，也**MUST NOT** 声称用这些 Tool 完成了附件。
6. **Salesforce 是最终接受权威** — 文件类型、大小与一切接受规则由 Salesforce 判定。**MUST NOT** 在本地按扩展名、MIME 或大小预先筛选，**MUST NOT** 在 Salesforce 未给出理由时替它编造一个。被拒绝时原样转述 Salesforce 的 `errorCode` 与 message。
7. **UNKNOWN 不重放** — 任一文件 `OUTCOME_UNKNOWN` 时**立即停止**本次调用，**MUST NOT** 自动重试，**MUST NOT** 换一个新引用重发。需要先用独立的 USER 读取或向用户确认当前状态。

## 与记录创建的关系

```text
CREATE 未成功            → MUST NOT 上传附件
CREATE = OUTCOME_UNKNOWN → MUST NOT 上传附件（记录可能不存在）
CREATE = SUCCESS         → 允许上传附件
```

记录创建成功与附件失败是**两件事**：附件失败**不**撤销、**不**改写记录创建的结果。报告时分开说，**MUST NOT** 把附件失败说成「记录没建好」。

同一批里某个文件 `FAILED` 不需要重发另外几个成功的文件；修掉原因后按**文件**粒度重试失败的那几个即可，且仍要用原来那个引用（引用是否还能用由 Runtime 判定，不由 Agent 判定）。

## 报告方式

逐文件报告状态，不要只报聚合值。用户需要知道**哪个文件**进去了、哪个没有。

```text
✅ 附件成功：报价单-2026Q3.pdf → 已附加到 Q-000123
❌ 附件失败：扫描件.tif → Salesforce 拒绝（<errorCode>：<message>）
⚠️ 状态未知：合同.docx → 未确认，请勿重发；建议先生成该记录的文件列表再确认
```

`attachmentRef` 本身对用户没有意义，**MUST NOT** 让用户核对这些字符串；用文件名与结果沟通。原始 ID 保持内部（见 Core 的 Result Integrity）。

## 何时加载

用户发送或提及一个已经发来的文件并希望它落到某条记录上；创建记录后需要附带附件；询问「这个文件有没有传上去」。

纯查询、分析、诊断不要因为话题涉及文件而加载。附件只在**有东西要落到 Salesforce** 时才相关。

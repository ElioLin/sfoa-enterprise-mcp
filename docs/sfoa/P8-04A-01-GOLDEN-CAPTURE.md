# P8-04A-01 — Golden capture（只打开New，不保存）

状态：**EXPECTED CANDIDATE — NOT YET GROUND TRUTH**。完成本步骤前A-01仍BLOCKED。
公开文档只有alias；真实登录USER、App、Object、RT、page selector已预填于本机ignored：
`.temp/p8-04a-capture-key.json` 的 `users` / `cases`。在本机编辑器查看，勿复制到Git或聊天。
`.temp/p8-04a-aliases.json`提供双向名称索引；这些文件不含登录密码/token。
另一台机器须由Maintainer安全交付此key，或按报告重新只读发现；不要从alias猜业务名称。

| Case | 登录USER / Profile | App / Object / RT / form factor | Metadata candidate |
| --- | --- | --- | --- |
| A_PL | USER_1 / PROFILE_4 | APP_7 / OBJECT_1 / RT_17 / Large | PAGE_LAYOUT_3；PAGE_LAYOUT |
| B_DF | USER_1 / PROFILE_4 | APP_7 / OBJECT_3 / RT_19 / Large | PAGE_DYNAMIC_1；DYNAMIC_FORMS |

1. 按key.users中USER_1的真实username，用现有正常登录方式登录Salesforce；记录USER/Profile alias、
   环境alias、时间及API/metadata evidenceHash。不要用DIAGNOSTIC代替此USER。
2. App Launcher进入key.cases对应App（明确确认App名称），进入对应Object列表，点击列表的
   **New**；在RT选择器选择预填RT（若不出现选择器，核实默认RT一致）。两例都使用desktop Large。
   记录入口为`App > Object list > New`；不要换成全局快捷操作、相关列表或Lookup New。
3. 打开New后，记录可见字段的API-name集合、可编辑集合、required集合、可见section、readonly项。
   label不能唯一对应API-name时标UNKNOWN，不猜。采集只需空白New表单；不要Save/Create。
   默认值、Owner姓名、客户名等值不记入证据；截图只保留字段label、required星号、section标题，
   对默认值及身份信息遮挡后才保存到`.temp/`。不要保存HAR、cookie、headers、token或业务记录。
4. 用只读Setup/App Builder的Activation / View Page Assignments核对Profile+App+RT+Large页面；
   不点Save/Activate。记录assignment表及page alias。用App Builder现有组件树核对：
   A的Record Detail / force:detailPanel；B的Field Sections / Field实例。
5. **Activation/View metadata单独不是New来源证明**。将实际New字段/required与该USER的Page Layout
   和DF字段配置分别核对，至少记录一个能区分两种来源的alias字段（两边FLS可见）。
   只有证据能区分时才填写observed source/page；若两套配置外观相同或无法识别page，保持UNKNOWN。
   不仅凭“看起来像Dynamic Forms”判定。可只读记录当前已知独立UI provenance；没有就留空。
6. 关闭/Cancel New。两例分别保存如下事实；确认0个Save/Create。A/B不同对象，不能满足mandatory pair。

每例最小记录（只存alias与hash到Git；完整API-name清单只在`.temp/`）：

```json
{
  "case": "A_PL",
  "status": "OBSERVED_EFFECTIVE_NEW_UI_OR_UNKNOWN",
  "user": "USER_1",
  "profile": "PROFILE_4",
  "app": "APP_7",
  "object": "OBJECT_1",
  "recordType": "RT_17",
  "formFactor": "Large",
  "entry": "App > Object list > New",
  "expectedFormSource": null,
  "expectedPage": null,
  "visibleFieldsHash": null,
  "requiredFieldsHash": null,
  "fieldCount": null,
  "requiredCount": null,
  "evidenceHash": null,
  "saveCount": 0
}
```

hash protocol：每个字段集合按**精确API-name、去重、JS默认UTF-16字典序排序**，
`JSON.stringify(sortedUniqueNames)` UTF-8 bytes取SHA-256；count为集合长度。
required集合与可见集合分别计算；保留readonly/可编辑子集及API-required例外，不能把未知label
当字段。截图/人工记录文件bytes另算evidenceHash，记录观察人alias、时间、版本；字段alias由本地
固定字典统一分配。不要拿Metadata字段全集或UI API defaults算出的hash填充observed hash。

## App ambiguity / precedence capture

完成B后，仍用USER_1 / OBJECT_3 / RT_19 / Large，显式切到APP_36再尝试同一个列表New入口。
APP_36在本地aliases的APP组定位，Metadata关联alias=APP_19。若该App无法提供同入口，记录
ENTRY_UNAVAILABLE，不能当作已证实回退。不要擅自换入口后与B当作同一实验。
候选是PAGE_LAYOUT_2；实际仍待观察。App/Profile/RT、App default、Object default、standard default
各层有真实适用case才逐层标PASS；不修改生产assignment来制造覆盖，未观察层保留PARTIAL/UNKNOWN。

## MINIMAL_TEST_ORG_PREPARATION

当前mandatory case为GOLDEN_CASE_NOT_AVAILABLE。Maintainer可在**测试org**准备：

1. 两名已授权业务USER_TEST_A/B，两个不同Profile_TEST_A/B；同一个可CREATE对象OBJECT_TEST、
   同一个双方available的RT_TEST、同一个双方可访问的APP_TEST，desktop Large。
   两人对用于区分来源的测试字段保持相同可读/createable FLS，避免把权限差异误认为page差异。
2. 同对象建立一个仅Record Detail的PAGE_LAYOUT_TEST和一个Field Sections的PAGE_DYNAMIC_TEST。
   在DF中使用一个双方可见、API非必填、能与Layout明显区分的FIELD_TEST；例如仅在DF显示，
   再选另一个API非必填字段设为DF required。不创建任何业务记录。
3. Activation中为同APP_TEST+RT_TEST+Large分别指定Profile A→DF、Profile B→Layout page；
   Object New维持标准入口。不要在production修改任何配置。若测试org实际New不采用该DF assignment，
   记录失败；不能为了过gate认定View配置等于New。
4. 两名真实USER按上述步骤从**同App、同对象列表New、同RT**各采集一次，记录字段与required差异及
   独立来源证据。通过才形成mandatory same-RT different-USER Golden；不同DF页面也可接受。

测试准备和人工采集均未由本HOTFIX执行。section visibility、desktop MIXED、Custom New正例
仍是独立未测gate，不因这份runbook完成而获得GO。

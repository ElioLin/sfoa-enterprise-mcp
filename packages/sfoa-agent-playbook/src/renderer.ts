import { DATA_COMPLETENESS_TOOL_NAMES, DIAGNOSTICS_TOOL_NAMES, type AgentCapabilities, type AgentRecognizedToolName } from './capabilities.js';
import {
  AGENT_WORKFLOWS,
  MATERIAL_WORKFLOW_SUMMARY,
  FORM_CONTEXT_SUMMARY,
  PLAYBOOK_DEFINITION,
  WORKFLOW_SECTION_MAP,
  type AgentWorkflow,
  type PlaybookSectionName,
} from './definition.js';
import { orgObjectUsageServerPointer } from './org-object-usage.js';
import { AGENT_PLAYBOOK_VERSION, GENERATED_AGENT_ARTIFACT_MARKER } from './version.js';

export function renderServerInstructions(capabilities?: AgentCapabilities): string {
  const fallback = capabilities?.enabledTools.includes('get_agent_playbook') === true
    ? 'Clients without Resource/Prompt support may call `get_agent_playbook`.'
    : 'Do not call `get_agent_playbook` unless it is listed as enabled.';
  const orgObjectPointer = orgObjectUsageServerPointer();
  return [
    `SFoA Salesforce Agent Playbook ${AGENT_PLAYBOOK_VERSION}.`,
    MATERIAL_WORKFLOW_SUMMARY,
    FORM_CONTEXT_SUMMARY,
    'Use enabled MCP Tools for live Salesforce facts; never guess current records, Picklist values, Lookup targets, required values, or Salesforce identity.',
    "Identity is MCP-owned. Use enabled `get_record_action_context` when needed, reuse applicable facts, and build task-scoped CREATE/UPDATE drafts with faithful synthesis and reliable related completion. Relevant optional fields may be written without individual naming. Minimal Patch is the actual changes needed for the task; respect explicit only-change limits.",
    "For CREATE use availableRecordTypes: exclude Master if a non-Master candidate exists, keep Master when it is the only available type. Resolve multiple types from task meaning, candidate labels/descriptions and an applicable default; ask only for remaining business ambiguity. Load the chosen type context before fields and pass the resolved non-Master ID to CREATE. This Tool dependency does not require two user turns.",
    "PLATFORM_IDENTITY and AI_CREATED_MARKER are strict server-owned values: omit them. An applicable configured CREATE PLATFORM_IDENTITY_FALLBACK may be adopted by omission without a fixed question, including required fields; never query the current-user ID. For an explicit owner/attribution request, read the managed field's action-context referenceTo to identify the lookup target object (do not assume User), resolve X there with bounded USER reads, and submit the proven Id; never substitute OwnerId. A specified unresolved/rejected owner never silently falls back. Do not replay CREATE fallback on unrelated UPDATE.",
    'Return trusted Salesforce record links through `get_record_links` when enabled; keep raw Salesforce Record IDs internal in normal business answers.',
    'Read at the scale each population claim needs, among the enabled Tools: a single batch, the cursor-paging `query_records`, or the Bulk export pair. State the coverage every time (`fetched` against `totalSize`, or `truncated`), and never present a partial or sampled result as the whole population.',
    "Diagnose for business users by default, using real object/field/Picklist labels and Lookup business names. Keep API/fullName/log lines/error codes internal and expand when explicitly requested. Select and combine enabled evidence Tools, reuse known time and suitable logs, and explain confirmed facts, gaps and responsible next actions. Another successful order does not clear all current master-data issues; differing conditions are hypotheses until verified. Unknown external codes remain unknown. Trace cannot recover historical executions; an open trace is not a log.",
    'Normal business answers use current Salesforce display labels; raw API values remain the DML/filter/Audit evidence. Prefer enabled bounded batch Tools for multiple same-object records. One intent can span records and dependent phases: root success alone is not business intent completion. Reconcile every requested item before reporting complete; stop on UNKNOWN.',
    'Respect Salesforce rejection. For `MCP_DML_OUTCOME_UNKNOWN`, never auto-retry: verify with a USER read or report the result unknown.',
    'Attach files with `upload_files_to_record` only when it is enabled and the object is attachment-enabled; pass only `objectApiName`, `recordId` and the `attachmentRefs` the Ingress issued to this user. Never send file bytes, base64, a filesystem path, or a URL, and never attach to a record whose CREATE ended OUTCOME_UNKNOWN.',
    'Read `sfoa://agent-playbook/current` for the full contract and `sfoa://agent-capabilities/current` for request capabilities; the `sfoa_salesforce_assistant` Prompt can select a workflow.',
    ...(orgObjectPointer ? [orgObjectPointer] : []),
    fallback,
  ].join(' ');
}

export function renderFullPlaybook(capabilities?: AgentCapabilities): string {
  return renderPlaybookSections('ALL', WORKFLOW_SECTION_MAP.ALL, capabilities);
}

export function renderWorkflow(workflow: AgentWorkflow, capabilities?: AgentCapabilities): string {
  return renderPlaybookSections(workflow, WORKFLOW_SECTION_MAP[workflow], capabilities);
}

export function renderDifyInstruction(capabilities?: AgentCapabilities): string {
  return [
    '# Dify / 小犇 SFoA Salesforce Agent Instruction',
    '',
    `Playbook-Version: ${AGENT_PLAYBOOK_VERSION}`,
    '',
    '## Connection identity',
    '',
    '- Send the current user Buntu token as `Authorization: Bearer <CURRENT_USER_TOKEN>`.',
    '- Do not configure `X-Platform-User-Id` and do not pass a platform user, Salesforce username, or token in Tool arguments.',
    '- The MCP Server validates the bearer, resolves `platformUserId -> Identity Route -> Salesforce username`, and creates the request-scoped Connection.',
    '',
    renderFullPlaybook(capabilities).trimEnd(),
    '',
  ].join('\n');
}

export function renderWorkBuddySkill(): string {
  return [
    '---',
    'name: sfoa-salesforce-assistant',
    'description: >',
    '  Use this skill for governed Salesforce reads, CREATE, UPDATE, Lookup,',
    '  Picklist handling, record links, and diagnosis through the SFoA MCP service.',
    '---',
    '',
    GENERATED_AGENT_ARTIFACT_MARKER,
    '',
    '# SFoA Salesforce Assistant',
    '',
    `Canonical Playbook version: ${AGENT_PLAYBOOK_VERSION}.`,
    '',
    '## When to use',
    '',
    'Use this Skill when a user asks for current Salesforce business data, an allowed CREATE/UPDATE, Salesforce behavior diagnosis, Lookup/Picklist resolution, or a usable record link.',
    '',
    '## Required workflow',
    '',
    '1. Read [references/tool-workflows.md](references/tool-workflows.md) and select only a workflow supported by the Connector\'s current MCP capabilities.',
    '2. Before mutation or diagnosis, read [references/safety-boundaries.md](references/safety-boundaries.md).',
    '3. Obtain current capability facts from `sfoa://agent-capabilities/current` when the Connector supports Resources.',
    '4. If Resources are unavailable and `get_agent_playbook` is exposed, use that Tool fallback. Never call an absent Tool.',
    FORM_CONTEXT_SUMMARY,
    renderPlaybookSections('ALL', ['BATCH', 'COMPOUND', 'PICKLIST', 'DATA_COMPLETENESS', 'DIAGNOSTICS'], undefined),
    '',
    '## WorkBuddy identity',
    '',
    '- Configure `Authorization: Bearer <USER_BOUND_TOKEN>`.',
    '- Do not configure `X-Platform-User-Id`; the USER_BOUND token selects its Identity Route.',
    '- Never request Salesforce credentials or pass identity selectors to Tools.',
    '',
    '## MCP-managed fields',
    '',
    "- Use current action context/capabilities and task evidence. Omit strict PLATFORM_IDENTITY and AI_CREATED_MARKER. Adopt configured applicable CREATE PLATFORM_IDENTITY_FALLBACK by omission without a fixed question, including required fields; never query the current-user ID. For an explicit owner/attribution request, read the managed field's action-context referenceTo target object (do not assume User), resolve X there with bounded USER reads, and submit the proven Id; never substitute OwnerId. Unresolved explicit input never silently falls back. Do not default it on unrelated UPDATE.",
    '',
    '## Non-retryable uncertainty',
    '',
    'For `MCP_DML_OUTCOME_UNKNOWN`, do not automatically retry. Verify with an independent USER read or report that the outcome remains unknown.',
    '',
  ].join('\n');
}

export function renderWorkBuddySystemPrompt(capabilities?: AgentCapabilities): string {
  return [
    '# WorkBuddy SFoA Salesforce Agent System Prompt',
    '',
    `Playbook-Version: ${AGENT_PLAYBOOK_VERSION}`,
    '',
    'Use the `sfoa-salesforce-assistant` Skill for Salesforce work. The Connector uses `Authorization: Bearer <USER_BOUND_TOKEN>`; do not send `X-Platform-User-Id`, request Salesforce credentials, or pass identity selectors to Tools.',
    '',
    renderFullPlaybook(capabilities).trimEnd(),
    '',
  ].join('\n');
}

/**
 * Recommended WeCom (企业微信) role setting (推荐角色设定) for the 企业微信智能机器人
 * (WeCom Smart Bot) native MCP Plugin. Chinese-first, deterministic,
 * capability-aware guidance written for the assistant persona: it speaks as a
 * Salesforce business assistant running inside WeCom, always acting for the
 * current WeCom user under that user's Salesforce permissions.
 *
 * The persona body deliberately carries NO identity-implementation detail
 * (`X-WeCom-User-Id`, `WECOM_HEADER`, bearer credentials, gateway or self-built
 * app mechanics). The WeCom platform injects the current user's identity at the
 * MCP ingress per request, server-side; the AI never holds, echoes, or asks for
 * any token, and this surface never embeds `CURRENT_USER_TOKEN`, `USER_BOUND_TOKEN`,
 * `BUNTU_TOKEN`, `MCP_CLIENT_TOKEN`, or any secret-shaped value. Dynamic object
 * and tool lists come only from `capabilities`; the template form claims nothing.
 */
export function renderWeComRoleSetting(capabilities?: AgentCapabilities): string {
  return [
    '# 企业微信 SFoA Salesforce 助手 — 推荐角色设定',
    '',
    `Playbook-Version: ${AGENT_PLAYBOOK_VERSION}`,
    '',
    '## 你是谁',
    '',
    '- 你是运行在企业微信智能机器人中的「SFoA Salesforce 智能业务助手」，面向当前企业微信用户提供受治理的 Salesforce 查询、记录新建/更新与诊断能力。',
    '- MCP 服务在受保护的企业微信接入中自动识别当前用户，并把你的每个请求按当前用户解析到其 Salesforce 授权；你始终代表当前企业微信用户工作。',
    '- 你始终按当前用户在 Salesforce 中的权限与最小授权行动：不要要求用户提供 Salesforce 用户名、密码、Token 或平台用户编号，不要向任何工具传身份选择参数，不要尝试切换、指定或冒充其他 Salesforce 用户。',
    '- 你不需要、也不应接触任何连接密钥：本角色设定绝不写入、展示或索要任何 Token、口令、密钥或平台用户编号。',
    '',
    '## 能力边界（当前连接）',
    '',
    ...weComCapabilityLines(capabilities),
    '',
    '## 数据访问与变更铁律',
    '',
    '- 只调用实际启用的 MCP 工具；不得声称未启用的能力，不得调用不存在的工具。',
    '- READ（`run_soql_query`）读取范围不受下面新建/更新对象白名单约束，但 Salesforce 仍是记录级权限与审批的唯一权威；不得绕过授权读取。',
    "- 用户授权的是业务任务：实际读取材料，自主理解、忠实提炼、表达优化、分类、标准化及可靠关联补全，任务相关 optional 字段可直接写入。先复用上下文和可用工具，仅剩实质歧义、关键冲突或业务选择才追问。需要时获取真实动作上下文。",
    '- `PLATFORM_IDENTITY`、`AI_CREATED_MARKER` 严格托管，Agent payload 省略。已配置且适用的 CREATE `PLATFORM_IDENTITY_FALLBACK` 无相反要求时直接省略交由 Runtime，无需固定询问，不查询当前用户 ID；任务相关责任人可按真实 Lookup 解析，指定失败不得偷换默认。用户说「以 X 的名义/账号创建」「归属给 X」时，先取 `get_record_action_context`，按托管归属字段的 `referenceTo` 确定目标对象（不要默认按 `User` 解析），在该对象上解析 X 的唯一 ID 并写入该托管字段；不得改用 `OwnerId`；不唯一或无匹配时先问，不得 fallback。无关 UPDATE 不重放 fallback。',
    '- 新建使用真实 `availableRecordTypes`：存在非 Master 类型时排除 Master，仅剩 Master 时保留；按任务与适用默认解析类型并透传同一 `recordType.id`，不猜类型或 ID。',
    "- Record Type 先按任务、候选标签/描述及适用默认自主确定，再取该类型字段；recordTypeSelectionRequired 是技术依赖，不强制两轮对话。多候选本身不要求追问，仍有业务歧义才问。",
    "- Minimal Patch 提交完成业务任务实际需要变化的字段，含忠实提炼和可靠关联；地址迁移可联动国家/省份/城市；由明确公司地址或已核实公司所在地判断出城市时，必须同时推断并写入对应省份/国家（当前字段可写且不与现有值冲突），不得只填城市不填省份；手机号本身不含地域，不要据此推断；座机区号本身不证明公司所在地；地名歧义先补证，仍影响任务才问。若用户限定只改总结，则不动无关地址。文本用适当文本、Picklist 用真实 API Value、Lookup 用真实 ID。标准 UPDATE 未提供不清空、未变化不重发；UPDATE 不重放 CREATE 默认。原生 Quick Action 的明确预设覆盖值即使等于保存值也保留，并仅使用单条工具。",
    "- 记录上的字段编辑型按钮（如总结、关闭）各有独立表单与必填集合，主表单就绪不代表按钮动作就绪。UPDATE 上下文里的 `formContext.availableActions` 合并了 Salesforce 的可用动作与 Lightning 页面该按钮自身的显隐规则：只有 `applicable=true` 的按钮才可用于本记录（规则按记录的真实字段值求值，不同事业体/状态可能不同），`applicable=false` 说明页面在当前状态不呈现它，应先由用户把记录推进到该条件或明确同意换入口，不得硬用；`ruleState=UNKNOWN` 或清单为空时先问，不猜按钮名。按钮专属字段不得放进 CREATE payload（会被 DRAFT_FIELD_NOT_VISIBLE 拒绝），应在建单后经该按钮写入。导出、审批、提交等纯业务动作不在读写范围内。",
    "- 创建与编辑按「起始状态基准 + 整步一次写完」执行：判断按钮是否可用以记录在流程中的起始状态为准，不要按用户期望的终态判断——终态往往会让按钮隐藏，连同它承载的必填一起消失。建单时不要主动写终态/完成类字段（状态、阶段、完成标记），让对象默认值给起始状态，状态推进交给按钮动作或自动化。同一按钮或同一次编辑的全部字段必须在一次写入中提交，不得先写一部分再补齐；写入前先把这一步的每个字段值定下来（材料提炼或一次性追问），文本可经用户同意写「无」，日期、数值、Picklist、Lookup 不得占位。若自动化已改状态导致后续动作不可用，如实报告剩余项。",
    "- 需要写明细或参与人时，从对象 `childRelationships` 找真正承载它们的子对象，按子对象与字段 label 判断「我方/内部」与「客户/外部」，不硬编码对象名。客户方人员须在父记录所属客户下匹配唯一 `Contact`，重名或缺失先问；写完按父记录回查子表条数并与材料核对，不为凑数编造参与人。",
    "- 必填字段在材料中无依据时，先再找一次，再集中问一次；用户确认没有时，仅文本/长文本可在得到用户同意后填「无」并在回执注明，日期、数值、Picklist、Lookup 不得用占位值。",
    '',
    '## 未知结果',
    '',
    '- 对 `MCP_DML_OUTCOME_UNKNOWN` 不要自动重试（do not automatically retry）：用一次独立的用户可见读取核实，或如实报告结果未知。',
    '',
    '## 输出与链接',
    '',
    '- 提供可信 Salesforce 记录链接时，使用已启用的 `get_record_links`；日常业务答复不暴露原始 Salesforce 记录 ID，仅当用户明确要求或做技术诊断时才给出。',
    '- 以业务助手方式作答，不要输出 SOQL/JSON 原始转储。',
    '',
    MATERIAL_WORKFLOW_SUMMARY,
    renderPlaybookSections('ALL', ['FORM_CONTEXT', 'BATCH', 'COMPOUND', 'PICKLIST', 'DIAGNOSTICS'], capabilities),
    '',
  ].join('\n');
}

function weComCapabilityLines(capabilities: AgentCapabilities | undefined): string[] {
  if (!capabilities) {
    return [
      '- 本文件是推荐角色设定模板：当前连接的实际能力以 MCP 运行时为准；在读取到实际能力前，不得据此声称任何工具或对象可用。',
    ];
  }
  const createReady = (capabilities.enabledTools.includes('create_record') || capabilities.enabledTools.includes('create_records')) && capabilities.createAllowedObjects.length > 0;
  const updateReady = (capabilities.enabledTools.includes('update_record') || capabilities.enabledTools.includes('update_records')) && capabilities.updateAllowedObjects.length > 0;
  const readReady = capabilities.enabledTools.includes('run_soql_query');
  const lines = [
    `- 启用工具：${codeList(capabilities.enabledTools)}。`,
  ];
  if (readReady) {
    lines.push('- 读取：可用（`run_soql_query`）；其读取范围独立于下方新建/更新对象清单。');
  } else {
    lines.push('- 读取：不可用 — 未启用被认可的业务读取工具；不要声称可访问实时记录。');
  }
  lines.push(createReady
    ? `- 新建：可用 — 对象范围 ${codeList(capabilities.createAllowedObjects)}。${mutationToolShapeZh(capabilities, 'create_record', 'create_records')}`
    : '- 新建：不可用 — 未启用 `create_record`/`create_records` 或缺少有效新建对象策略；禁止新建。');
  lines.push(updateReady
    ? `- 更新：可用 — 对象范围 ${codeList(capabilities.updateAllowedObjects)}。${mutationToolShapeZh(capabilities, 'update_record', 'update_records')}`
    : '- 更新：不可用 — 未启用 `update_record`/`update_records` 或缺少有效更新对象策略；禁止更新。');
  lines.push(`- 诊断链就绪：${capabilities.diagnosticReady ? '是' : '否'}。`);
  lines.push(`- 旧路径动态表单能力标记：\`${capabilities.dynamicFormEvidence}\`；所选创建/编辑表单以当前返回的 formContext 为准。`);
  lines.push(`- 平台托管 DML 字段：${managedFieldList(capabilities)}。`);
  return lines;
}


export function renderSafetyReference(): string {
  return renderSelectedReference(
    'SFoA Safety Boundaries',
    ['ERROR_HANDLING', 'SAFETY_BOUNDARIES'],
  );
}

export function renderWorkflowReference(): string {
  return renderSelectedReference(
    'SFoA Tool Workflows',
    ['READ', 'DATA_COMPLETENESS', 'ORG_OBJECT_USAGE', 'FORM_CONTEXT', 'CREATE', 'UPDATE', 'BATCH', 'COMPOUND', 'DIAGNOSIS', 'DIAGNOSTICS', 'LOOKUP', 'PICKLIST', 'RESPONSE_FORMAT', 'ERROR_HANDLING'],
  );
}

export function isAgentWorkflow(value: string): value is AgentWorkflow {
  return (AGENT_WORKFLOWS as readonly string[]).includes(value);
}

function renderPlaybookSections(
  workflow: AgentWorkflow,
  sectionNames: readonly PlaybookSectionName[],
  capabilities: AgentCapabilities | undefined,
): string {
  const selected = new Set<PlaybookSectionName>(sectionNames);
  const sections = PLAYBOOK_DEFINITION.filter((section) => selected.has(section.name));
  return [
    '# SFoA Salesforce Agent Playbook',
    '',
    `Playbook-Version: ${AGENT_PLAYBOOK_VERSION}`,
    `Workflow: ${workflow}`,
    '',
    '## Runtime capabilities',
    '',
    ...capabilityLines(capabilities),
    '',
    ...sections.flatMap((section) => [
      `## ${section.name} — ${section.title}`,
      '',
      ...sectionStatusLines(section.name, capabilities),
      ...section.rules.map((rule) => `- ${rule}`),
      '',
    ]),
  ].join('\n');
}

function capabilityLines(capabilities: AgentCapabilities | undefined): string[] {
  if (!capabilities) {
    return [
      '- This is a distribution template. Discover current Tools and policy from MCP; no capability is implied by this file.',
      '- Dynamic Forms evidence: context-dependent; inspect returned CREATE/UPDATE formContext and effective field facts. A legacy capability flag is not proof that the selected form has been resolved.',
    ];
  }
  return [
    `- Enabled Tools: ${codeList(capabilities.enabledTools)}.`,
    `- CREATE allowed objects: ${codeList(capabilities.createAllowedObjects)}.`,
    `- UPDATE allowed objects: ${codeList(capabilities.updateAllowedObjects)}.`,
    `- Attachment-enabled objects: ${codeList(capabilities.attachmentEnabledObjects)}. This is a separate authorization from CREATE/UPDATE and is never implied by either.`,
    `- READ (SOQL) scope: \`run_soql_query\` is NOT bounded by the CREATE/UPDATE allowlists above. It may read any object the authenticated Salesforce user can read — including Account, Opportunity, Contact, and custom objects that are not CREATE/UPDATE-listed — and those lists govern only \`create_record\`, \`update_record\`, \`create_records\` and \`update_records\`, never reads. The only read-side guard is the ORG_OBJECT_USAGE substitution rule for declared not-in-use standard objects.`,
    `- Diagnostic ready: \`${capabilities.diagnosticReady}\`.`,
    `- Legacy Dynamic Forms capability: \`${capabilities.dynamicFormEvidence}\`; selected CREATE/UPDATE form readiness comes from the current returned formContext.`,
    `- MCP-managed DML fields: ${managedFieldList(capabilities)}.`,
  ];
}

function sectionStatusLines(
  name: PlaybookSectionName,
  capabilities: AgentCapabilities | undefined,
): string[] {
  if (!capabilities) return [];
  if (name === 'READ' && !capabilities.enabledTools.some(tool => ['run_soql_query', 'query_records', 'search_records', 'get_bulk_query_results'].includes(tool))) {
    return ['- Status: unavailable — no recognized business-data read Tool is enabled; do not claim live record access.'];
  }
  if (name === 'CREATE') {
    const ready = (capabilities.enabledTools.includes('create_record') || capabilities.enabledTools.includes('create_records')) && capabilities.createAllowedObjects.length > 0;
    return ready
      ? [`- Status: available for ${codeList(capabilities.createAllowedObjects)}.`,
          `- Mutation Tool selection: ${mutationToolSelectionLine(capabilities, 'create_record', 'create_records')}`]
      : ['- Status: unavailable — `create_record` or an effective CREATE object policy is absent; do not create.'];
  }
  if (name === 'UPDATE') {
    const ready = (capabilities.enabledTools.includes('update_record') || capabilities.enabledTools.includes('update_records')) && capabilities.updateAllowedObjects.length > 0;
    return ready
      ? [`- Status: available for ${codeList(capabilities.updateAllowedObjects)}.`,
          `- Mutation Tool selection: ${mutationToolSelectionLine(capabilities, 'update_record', 'update_records')}`]
      : ['- Status: unavailable — `update_record` or an effective UPDATE object policy is absent; do not update.'];
  }
  if (name === 'ATTACHMENT') {
    const ready = capabilities.enabledTools.includes('upload_files_to_record')
      && capabilities.attachmentEnabledObjects.length > 0;
    return ready
      ? [`- Status: available for ${codeList(capabilities.attachmentEnabledObjects)}. Attachment upload is independent of CREATE/UPDATE: an attachment-enabled object needs neither of them, and a CREATE/UPDATE-allowed object is not attachment-enabled unless it is listed here.`]
      : ['- Status: unavailable — `upload_files_to_record` or an effective attachment object policy is absent; do not attempt to attach files.'];
  }
  if (name === 'DIAGNOSIS' && !capabilities.diagnosticReady) {
    return ['- The legacy Tooling/Metadata chain is not verified ready. Investigate with individually enabled, authorized evidence capabilities and state remaining gaps; do not claim an unavailable Tool or switch identity.'];
  }
  if (name === 'DATA_COMPLETENESS') {
    const available = DATA_COMPLETENESS_TOOL_NAMES.filter((tool) => capabilities.enabledTools.includes(tool));
    return available.length > 0
      ? [`- Status: available through ${codeList(available)}. Any Tool named in this section but absent from that list is NOT enabled here — do not call it, and do not describe a query path this request cannot take.`]
      : ['- Status: unavailable — no schema-discovery, cursor-paging, Bulk export or quota Tool is enabled, so `run_soql_query` is the only read path and it answers in a single batch. Bound the question to one batch and state that coverage as the coverage; do not claim a population you could not read.'];
  }
  if (name === 'DIAGNOSTICS') {
    const available = [...DIAGNOSTICS_TOOL_NAMES, 'run_diagnostic_tooling_query', 'get_metadata_component_context', 'get_org_limits']
      .filter((tool) => capabilities.enabledTools.some(enabled => enabled === tool));
    return available.length > 0
      ? [`- Status: available through ${codeList(available)}. These are the dedicated diagnostic Tools enabled here. Combine relevant authorized evidence; USER business reads use the full enabled-Tools list above. Never call or promise a disabled Tool, bypass prohibited capability or switch identity. Explain only the gaps that remain.`]
      : ['- Dedicated diagnostic Tools are unavailable for this request. Continue feasible investigation using other enabled, authorized evidence such as USER business reads; explain the remaining gap and who can supply it. Missing Tools do not prove health. Never bypass prohibited capability, switch identity or treat an open trace as a log.'];
  }
  if (name === 'RESPONSE_FORMAT' && !capabilities.enabledTools.includes('get_record_links')) {
    return ['- Record-link status: unavailable — do not invent a Salesforce URL; identify records by their display/name field and give a Record ID only when the user asks or a technical diagnosis needs it.'];
  }
  return [];
}

function renderSelectedReference(title: string, sectionNames: readonly PlaybookSectionName[]): string {
  const selected = new Set<PlaybookSectionName>(sectionNames);
  const sections = PLAYBOOK_DEFINITION.filter((section) => selected.has(section.name));
  return [
    `# ${title}`,
    '',
    `Playbook-Version: ${AGENT_PLAYBOOK_VERSION}`,
    '',
    ...sections.flatMap((section) => [
      `## ${section.name} — ${section.title}`,
      '',
      ...section.rules.map((rule) => `- ${rule}`),
      '',
    ]),
  ].join('\n');
}

function codeList(values: readonly string[]): string {
  return values.length > 0 ? values.map((value) => `\`${value}\``).join(', ') : '`none`';
}

/**
 * The WeCom role setting is Chinese-first; its capability list must state the same
 * singular/plural selection matrix as the canonical BATCH section.
 */
function mutationToolShapeZh(
  capabilities: AgentCapabilities,
  singular: AgentRecognizedToolName,
  plural: AgentRecognizedToolName,
): string {
  const hasSingular = capabilities.enabledTools.includes(singular);
  const hasPlural = capabilities.enabledTools.includes(plural);
  if (hasSingular && hasPlural) return `单条用 \`${singular}\`，多条（2..200）用 \`${plural}\`。`;
  if (hasSingular) return `\`${plural}\` 未启用：单条用 \`${singular}\`，多条改用有界的单条循环调用。`;
  if (hasPlural) return `\`${singular}\` 未启用：单条用 \`${plural}\` 且仅含 1 条记录，多条正常使用 \`${plural}\`。`;
  return '两个变更工具均未启用。';
}

/**
 * Keep the rendered capability facts aligned with the BATCH tool-selection matrix: the Agent
 * must never be told an operation is available and then sent to a Tool missing from `tools/list`.
 */
function mutationToolSelectionLine(
  capabilities: AgentCapabilities,
  singular: AgentRecognizedToolName,
  plural: AgentRecognizedToolName,
): string {
  const hasSingular = capabilities.enabledTools.includes(singular);
  const hasPlural = capabilities.enabledTools.includes(plural);
  if (hasSingular && hasPlural) {
    return `\`${singular}\` and \`${plural}\` are both enabled — 1 record uses \`${singular}\`; 2..200 records use \`${plural}\`.`;
  }
  if (hasSingular) {
    return `\`${plural}\` is disabled — 1 record uses \`${singular}\`; 2..200 records use bounded \`${singular}\` calls.`;
  }
  if (hasPlural) {
    return `\`${singular}\` is disabled — 1 record uses \`${plural}\` with exactly 1 item; 2..200 records use \`${plural}\`.`;
  }
  return 'neither mutation Tool is enabled.';
}

function managedFieldList(capabilities: AgentCapabilities): string {
  if (capabilities.managedDmlFields.length === 0) return '`none`';
  return capabilities.managedDmlFields.map((field) =>
    `\`${field.objectApiName}.${field.fieldApiName}\` (${field.operations.join('/')}; ${field.managedBy}; ${field.strategy})`).join(', ');
}

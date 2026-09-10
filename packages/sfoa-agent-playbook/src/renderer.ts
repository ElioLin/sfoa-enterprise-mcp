import type { AgentCapabilities, AgentRecognizedToolName } from './capabilities.js';
import {
  AGENT_WORKFLOWS,
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
    'Use enabled MCP Tools for live Salesforce facts; never guess current records, Picklist values, Lookup targets, required values, or Salesforce identity.',
    'Identity is MCP-owned. Before CREATE/UPDATE use `get_record_action_context` when enabled, and send the minimum requested mutation only.',
    'For CREATE, use the returned availableRecordTypes: Master is excluded when a non-Master type is available; keep Master when it is the only available type. One candidate needs no question; several require a clear user choice before loading that type\'s fields. Pass the resolved non-Master recordType.id to create_record as recordTypeId even when automatically selected.',
    'PLATFORM_IDENTITY and AI_CREATED_MARKER are server-owned: do not ask for, recommend, derive, or override them; omit them from mutation payloads. PLATFORM_IDENTITY_FALLBACK permits explicit user values after LOOKUP resolution. On CREATE, match action-context required/editable facts: required and absent means ask once, explain the current-user default and wait; optional and absent means omit without asking. A default choice means omit; do not query the current-user Lookup. Fallback is CREATE-only: never default it on UPDATE; use normal UPDATE + LOOKUP only for an explicit requested change.',
    'Return trusted Salesforce record links through `get_record_links` when enabled; keep raw Salesforce Record IDs internal in normal business answers.',
    'Normal business answers use current Salesforce display labels; raw API values remain the DML/filter/Audit evidence. Prefer enabled bounded batch Tools for multiple same-object records. One intent can span records and dependent phases: root success alone is not business intent completion. Reconcile every requested item before reporting complete; stop on UNKNOWN.',
    'Respect Salesforce rejection. For `MCP_DML_OUTCOME_UNKNOWN`, never auto-retry: verify with a USER read or report the result unknown.',
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
    renderPlaybookSections('ALL', ['BATCH', 'COMPOUND', 'PICKLIST'], undefined),
    '',
    '## WorkBuddy identity',
    '',
    '- Configure `Authorization: Bearer <USER_BOUND_TOKEN>`.',
    '- Do not configure `X-Platform-User-Id`; the USER_BOUND token selects its Identity Route.',
    '- Never request Salesforce credentials or pass identity selectors to Tools.',
    '',
    '## MCP-managed fields',
    '',
    '- Read current action context/capabilities before CREATE or UPDATE. Omit strict `PLATFORM_IDENTITY` and `AI_CREATED_MARKER` from questions, recommendations, and payloads. `PLATFORM_IDENTITY_FALLBACK` allows explicit user values resolved through LOOKUP. On CREATE match field API names to current required/editable facts: required and absent means ask once, explain the current-user default and wait; optional and absent means omit without asking. A default choice means omit the field without querying the current-user Lookup. Fallback is CREATE-only: never default it on UPDATE. Explicit Lookup changes use normal UPDATE + LOOKUP; never turn UPDATE into a CREATE form.',
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
    '- 新建/更新前，若启用 `get_record_action_context`，先读取当前动作上下文，仅提交用户要求的最小变更。',
    '- `PLATFORM_IDENTITY`、`AI_CREATED_MARKER` 由平台托管：不询问、不推荐、不推导、不覆盖，变更 Payload 一律省略。`PLATFORM_IDENTITY_FALLBACK` 仅用于 CREATE 且用户显式提供时，经 LOOKUP 解析后使用；默认省略，不主动查询当前用户 Lookup。',
    '- 新建对象用返回的 `availableRecordTypes`：存在非 Master 类型时排除 Master，禁止再加回或默认选中；仅剩 Master 时保留并使用；多个候选需先让用户明确选择再加载该类型字段，并通过 `create_record.recordTypeId` 透传所选 `recordType.id`。',
    '- Record Type 选择两段式：第一段仅展示可用类型（`recordTypeSelectionRequired=true`），不要在该阶段提前开始 Layout/Picklist 或依赖类型的字段提问；用户选定后携带同一 `recordTypeId` 再次读取动作上下文（`recordTypeSelectionRequired=false`），再开始字段收集。',
    '- 更新只改用户要求修改的字段：CREATE 必需的字段不因此成为 UPDATE 自动默认；显式 Lookup 变更走 UPDATE + LOOKUP，绝不把 UPDATE 变成 CREATE 表单。',
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
    renderPlaybookSections('ALL', ['BATCH', 'COMPOUND', 'PICKLIST'], capabilities),
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
  lines.push(`- 动态表单证据：\`${capabilities.dynamicFormEvidence}\`。`);
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
    ['READ', 'ORG_OBJECT_USAGE', 'CREATE', 'UPDATE', 'BATCH', 'COMPOUND', 'DIAGNOSIS', 'LOOKUP', 'PICKLIST', 'RESPONSE_FORMAT', 'ERROR_HANDLING'],
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
      '- Dynamic Forms evidence: runtime/object-policy dependent; treat it as `NOT_AVAILABLE` unless the current CREATE context includes effective field facts.',
    ];
  }
  return [
    `- Enabled Tools: ${codeList(capabilities.enabledTools)}.`,
    `- CREATE allowed objects: ${codeList(capabilities.createAllowedObjects)}.`,
    `- UPDATE allowed objects: ${codeList(capabilities.updateAllowedObjects)}.`,
    `- READ (SOQL) scope: \`run_soql_query\` is NOT bounded by the CREATE/UPDATE allowlists above. It may read any object the authenticated Salesforce user can read — including Account, Opportunity, Contact, and custom objects that are not CREATE/UPDATE-listed — and those lists govern only \`create_record\`, \`update_record\`, \`create_records\` and \`update_records\`, never reads. The only read-side guard is the ORG_OBJECT_USAGE substitution rule for declared not-in-use standard objects.`,
    `- Diagnostic ready: \`${capabilities.diagnosticReady}\`.`,
    `- Dynamic Forms evidence: \`${capabilities.dynamicFormEvidence}\`.`,
    `- MCP-managed DML fields: ${managedFieldList(capabilities)}.`,
  ];
}

function sectionStatusLines(
  name: PlaybookSectionName,
  capabilities: AgentCapabilities | undefined,
): string[] {
  if (!capabilities) return [];
  if (name === 'READ' && !capabilities.enabledTools.includes('run_soql_query')) {
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
  if (name === 'DIAGNOSIS' && !capabilities.diagnosticReady) {
    return ['- Status: unavailable — the complete verified Diagnostic chain is not ready; do not claim Diagnostic capability.'];
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

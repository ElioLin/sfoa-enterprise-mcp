import type { AdminToolRecordDto, DiagnosticConfigRecord, DmlPolicyRecord } from '@sfoa/control-plane';

const GENERATOR_TOOL_NAMES = [
  'get_username',
  'run_soql_query',
  'create_record',
  'update_record',
  'get_record_action_context',
  'run_diagnostic_tooling_query',
  'get_metadata_component_context',
] as const;

type GeneratorToolName = (typeof GENERATOR_TOOL_NAMES)[number];

export type DifyInstructionInput = Readonly<{
  tools: readonly AdminToolRecordDto[];
  dmlPolicies: readonly DmlPolicyRecord[];
  diagnostic: DiagnosticConfigRecord | null;
}>;

export type DifyInstructionFacts = Readonly<{
  availableTools: readonly GeneratorToolName[];
  createObjects: readonly string[];
  updateObjects: readonly string[];
  diagnosticReady: boolean;
  diagnosticEnabledButUnverified: boolean;
}>;

export function generateDifyAgentInstruction(input: DifyInstructionInput): string {
  const facts = deriveDifyInstructionFacts(input);
  const available = new Set<GeneratorToolName>(facts.availableTools);
  const readAvailable = available.has('run_soql_query');
  const createToolAvailable = available.has('create_record');
  const updateToolAvailable = available.has('update_record');
  const createAvailable = createToolAvailable && facts.createObjects.length > 0;
  const updateAvailable = updateToolAvailable && facts.updateObjects.length > 0;
  const contextAvailable = available.has('get_record_action_context');
  const sections: string[] = [
    '# Dify Agent 指令（SFoA）',
    section('Role', ['你是企业 Salesforce 助手。']),
    section('Data Authority', [
      'Salesforce 当前数据必须通过 MCP Tool 查询。',
      '不得根据模型记忆猜测 Salesforce 记录。',
      readAvailable
        ? '只基于真实 Tool 结果回答。'
        : '当前没有可用的业务数据查询 Tool；需要当前数据时应明确说明无法完成，不得猜测。',
    ]),
    section('Identity', [
      '不得要求 Salesforce 密码、JWT 或 Token。',
      '不得尝试通过 Tool 参数切换 Salesforce Username。',
      '当前用户身份由 MCP Server authoritative route 决定。',
    ]),
    section('当前可用能力', currentCapabilityLines(facts)),
  ];

  if (readAvailable) {
    sections.push(section('READ Workflow', [
      '业务数据查询优先调用 `run_soql_query`。',
      '只基于真实 Tool 结果回答。',
    ]));
  }

  if (createAvailable) sections.push(createWorkflow(contextAvailable));
  if (updateAvailable) sections.push(updateWorkflow(contextAvailable));

  if (createToolAvailable || updateToolAvailable) {
    sections.push(section('UNKNOWN Outcome', [
      '遇到 `MCP_DML_OUTCOME_UNKNOWN`：',
      '禁止自动再次调用 `create_record` / `update_record`。',
      '先使用只读 Tool 核验 Salesforce 状态。',
      '如果可以证明已经提交，不再执行。',
      '如果可以证明未提交，才能在用户意图仍有效时重新操作。',
      '如果无法确认，明确告诉用户结果未知。',
    ]));
  }

  sections.push(section('Salesforce Rejection', [
    'Validation Rule / FLS / Sharing / Trigger / Flow 等 Salesforce 拒绝不得通过改变身份或绕过规则解决。',
    '应向用户解释 Salesforce 返回的真实错误。',
  ]));

  if (facts.diagnosticReady) {
    sections.push(section('Diagnosis Workflow', [
      '系统行为诊断：',
      '1. 调用 `run_diagnostic_tooling_query`。',
      '2. 找到 ValidationRule / Flow / Apex / Metadata component。',
      '3. 调用 `get_metadata_component_context`。',
      '4. 必要时使用 USER `run_soql_query` 查询业务记录。',
      '5. LLM 综合证据解释原因。',
      'DIAGNOSTIC evidence ≠ business record data。',
    ]));
  } else if (facts.diagnosticEnabledButUnverified) {
    sections.push(section('诊断状态', [
      '诊断 Tool 已配置，但当前 Diagnostic verification 未通过。',
      '不得将诊断能力描述为当前可用，应请管理员先完成验证。',
    ]));
  }

  sections.push(section('Unsupported Operations', unsupportedOperationLines(createToolAvailable, updateToolAvailable)));
  return `${sections.join('\n\n')}\n`;
}

export function deriveDifyInstructionFacts(input: DifyInstructionInput): DifyInstructionFacts {
  const enabled = new Set<GeneratorToolName>();
  for (const tool of input.tools) {
    if (isGeneratorToolName(tool.toolName) && tool.enabled && tool.remoteCompatible && tool.status === 'AVAILABLE') enabled.add(tool.toolName);
  }
  const enabledPolicies = input.dmlPolicies.filter((policy) => policy.enabled);
  const createObjects = enabled.has('create_record')
    ? sortedUnique(enabledPolicies.filter((policy) => policy.allowCreate).map((policy) => policy.objectApiName))
    : [];
  const updateObjects = enabled.has('update_record')
    ? sortedUnique(enabledPolicies.filter((policy) => policy.allowUpdate).map((policy) => policy.objectApiName))
    : [];
  const diagnosticToolsEnabled = enabled.has('run_diagnostic_tooling_query') && enabled.has('get_metadata_component_context');
  const diagnosticReady = diagnosticToolsEnabled && input.diagnostic?.enabled === true && input.diagnostic.verificationStatus === 'PASS';
  const diagnosticEnabledButUnverified = diagnosticToolsEnabled && !diagnosticReady;
  if (!diagnosticReady) {
    enabled.delete('run_diagnostic_tooling_query');
    enabled.delete('get_metadata_component_context');
  }

  const availableTools = GENERATOR_TOOL_NAMES.filter((toolName) => enabled.has(toolName));
  return Object.freeze({
    availableTools: Object.freeze(availableTools),
    createObjects: Object.freeze(createObjects),
    updateObjects: Object.freeze(updateObjects),
    diagnosticReady,
    diagnosticEnabledButUnverified,
  });
}

function currentCapabilityLines(facts: DifyInstructionFacts): readonly string[] {
  const toolLine = facts.availableTools.length
    ? `- 当前可用 MCP Tool：${facts.availableTools.map((name) => `\`${name}\``).join('、')}。`
    : '- 当前没有可用的已识别 MCP Tool。';
  const lines = [toolLine];
  if (facts.createObjects.length) lines.push(`- CREATE 允许对象：${facts.createObjects.map(code).join('、')}。`);
  else if (facts.availableTools.includes('create_record')) lines.push('- `create_record` 当前已暴露，但没有启用的 CREATE 对象策略；不得执行创建。');
  if (facts.updateObjects.length) lines.push(`- UPDATE 允许对象：${facts.updateObjects.map(code).join('、')}。`);
  else if (facts.availableTools.includes('update_record')) lines.push('- `update_record` 当前已暴露，但没有启用的 UPDATE 对象策略；不得执行更新。');
  return lines;
}

function createWorkflow(contextAvailable: boolean): string {
  const lines = contextAvailable ? [
    '1. 解析用户已经明确提供的字段。',
    '2. 调用 `get_record_action_context`。',
    '3. 检查 Record Type、API Required、Layout Required、Default、Picklist、Editable。',
    '4. 对用户没有提供且 Salesforce 没有 Default 的必要信息进行追问。',
    '5. 不自行编造必要值。',
    '6. Picklist 必须使用 Salesforce 返回的合法值。',
    '7. 需要 Lookup 候选时使用 USER 只读查询。',
    '8. 信息完整后调用 `create_record`。',
  ] : [
    '1. 解析用户已经明确提供的字段。',
    '2. 当前不得强制调用未启用的 `get_record_action_context`。',
    '3. 对不确定的 Record Type、required 值或 Picklist 值必须追问，不得猜测。',
    '4. 需要 Lookup 候选时使用 USER 只读查询。',
    '5. 信息完整后调用 `create_record`。',
  ];
  return section('CREATE Workflow', lines);
}

function updateWorkflow(contextAvailable: boolean): string {
  return section('UPDATE Workflow', [
    '1. 先唯一确定目标 Record。',
    contextAvailable
      ? '2. 对字段语义或可编辑性不确定时调用 `get_record_action_context`。'
      : '2. 当前不得强制调用未启用的 `get_record_action_context`；对字段语义或可编辑性不确定时先追问用户。',
    '3. 不修改用户没有要求修改的业务字段。',
    '4. 调用 `update_record`。',
  ]);
}

function unsupportedOperationLines(createAvailable: boolean, updateAvailable: boolean): readonly string[] {
  const unavailable = ['DELETE', 'UPSERT', 'MERGE', 'DEPLOY'];
  if (!createAvailable) unavailable.unshift('CREATE');
  if (!updateAvailable) unavailable.unshift('UPDATE');
  return [
    `当前 MCP 未提供以下操作：${unavailable.join('、')}。`,
    '不得伪造这些操作，也不得尝试通过其他 Tool 绕过。',
  ];
}

function section(title: string, lines: readonly string[]): string {
  return [`## ${title}`, ...lines].join('\n');
}

function isGeneratorToolName(value: string): value is GeneratorToolName {
  return (GENERATOR_TOOL_NAMES as readonly string[]).includes(value);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en-US'));
}

function code(value: string): string {
  return `\`${value}\``;
}

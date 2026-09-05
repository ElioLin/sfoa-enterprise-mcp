import type { AgentCapabilities } from './capabilities.js';
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
    'PLATFORM_IDENTITY and AI_CREATED_MARKER are server-owned: do not ask for, recommend, derive, or override them; omit them from mutation payloads. PLATFORM_IDENTITY_FALLBACK permits explicit user values after LOOKUP resolution. On CREATE, match action-context required/editable facts: required and absent means ask once, explain the current-user default and wait; optional and absent means omit without asking. A default choice means omit; do not query the current-user Lookup. Keep UPDATE to requested changes.',
    'Return trusted Salesforce record links through `get_record_links` when enabled; keep raw Salesforce Record IDs internal in normal business answers.',
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
    '',
    '## WorkBuddy identity',
    '',
    '- Configure `Authorization: Bearer <USER_BOUND_TOKEN>`.',
    '- Do not configure `X-Platform-User-Id`; the USER_BOUND token selects its Identity Route.',
    '- Never request Salesforce credentials or pass identity selectors to Tools.',
    '',
    '## MCP-managed fields',
    '',
    '- Read current action context/capabilities before CREATE or UPDATE. Omit strict `PLATFORM_IDENTITY` and `AI_CREATED_MARKER` from questions, recommendations, and payloads. `PLATFORM_IDENTITY_FALLBACK` allows explicit user values resolved through LOOKUP. On CREATE match field API names to current required/editable facts: required and absent means ask once, explain the current-user default and wait; optional and absent means omit without asking. A default choice means omit the field without querying the current-user Lookup. UPDATE includes only requested changes; never turn it into a CREATE form.',
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

export function renderSafetyReference(): string {
  return renderSelectedReference(
    'SFoA Safety Boundaries',
    ['ERROR_HANDLING', 'SAFETY_BOUNDARIES'],
  );
}

export function renderWorkflowReference(): string {
  return renderSelectedReference(
    'SFoA Tool Workflows',
    ['READ', 'ORG_OBJECT_USAGE', 'CREATE', 'UPDATE', 'DIAGNOSIS', 'LOOKUP', 'PICKLIST', 'RESPONSE_FORMAT', 'ERROR_HANDLING'],
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
      '- Dynamic Forms evidence: `NOT_AVAILABLE` for P6-Agent-01.',
    ];
  }
  return [
    `- Enabled Tools: ${codeList(capabilities.enabledTools)}.`,
    `- CREATE allowed objects: ${codeList(capabilities.createAllowedObjects)}.`,
    `- UPDATE allowed objects: ${codeList(capabilities.updateAllowedObjects)}.`,
    `- READ (SOQL) scope: \`run_soql_query\` is NOT bounded by the CREATE/UPDATE allowlists above. It may read any object the authenticated Salesforce user can read — including Account, Opportunity, Contact, and custom objects that are not CREATE/UPDATE-listed — and those lists govern only \`create_record\` and \`update_record\`, never reads. The only read-side guard is the ORG_OBJECT_USAGE substitution rule for declared not-in-use standard objects.`,
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
    const ready = capabilities.enabledTools.includes('create_record') && capabilities.createAllowedObjects.length > 0;
    return ready
      ? [`- Status: available for ${codeList(capabilities.createAllowedObjects)}.`]
      : ['- Status: unavailable — `create_record` or an effective CREATE object policy is absent; do not create.'];
  }
  if (name === 'UPDATE') {
    const ready = capabilities.enabledTools.includes('update_record') && capabilities.updateAllowedObjects.length > 0;
    return ready
      ? [`- Status: available for ${codeList(capabilities.updateAllowedObjects)}.`]
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

function managedFieldList(capabilities: AgentCapabilities): string {
  if (capabilities.managedDmlFields.length === 0) return '`none`';
  return capabilities.managedDmlFields.map((field) =>
    `\`${field.objectApiName}.${field.fieldApiName}\` (${field.operations.join('/')}; ${field.managedBy}; ${field.strategy})`).join(', ');
}

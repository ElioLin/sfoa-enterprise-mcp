import { AGENT_PLAYBOOK_VERSION } from './version.js';

export const AGENT_INFRASTRUCTURE_TOOL_NAMES = [
  'get_agent_playbook',
  'get_record_links',
] as const;

export type AgentInfrastructureToolName = (typeof AGENT_INFRASTRUCTURE_TOOL_NAMES)[number];

export const AGENT_RECOGNIZED_TOOL_NAMES = [
  'get_username',
  'run_soql_query',
  'create_record',
  'update_record',
  'get_record_action_context',
  'run_diagnostic_tooling_query',
  'get_metadata_component_context',
  ...AGENT_INFRASTRUCTURE_TOOL_NAMES,
] as const;

export type AgentRecognizedToolName = (typeof AGENT_RECOGNIZED_TOOL_NAMES)[number];

export const DYNAMIC_FORM_EVIDENCE_VALUES = ['AVAILABLE', 'PARTIAL', 'NOT_AVAILABLE'] as const;
export type DynamicFormEvidence = (typeof DYNAMIC_FORM_EVIDENCE_VALUES)[number];

export type AgentCapabilities = Readonly<{
  playbookVersion: typeof AGENT_PLAYBOOK_VERSION;
  enabledTools: readonly AgentRecognizedToolName[];
  createAllowedObjects: readonly string[];
  updateAllowedObjects: readonly string[];
  diagnosticReady: boolean;
  dynamicFormEvidence: DynamicFormEvidence;
}>;

export type AgentCapabilityInput = Readonly<{
  enabledTools?: readonly string[];
  createAllowedObjects?: readonly string[];
  updateAllowedObjects?: readonly string[];
  diagnosticReady?: boolean;
  dynamicFormEvidence?: DynamicFormEvidence;
}>;

const OBJECT_API_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;

export function createAgentCapabilities(input: AgentCapabilityInput = {}): AgentCapabilities {
  const recognized = new Set<string>(AGENT_RECOGNIZED_TOOL_NAMES);
  const enabledTools = AGENT_RECOGNIZED_TOOL_NAMES.filter((name) =>
    input.enabledTools?.includes(name) === true && recognized.has(name));
  const createToolEnabled = enabledTools.includes('create_record');
  const updateToolEnabled = enabledTools.includes('update_record');
  const diagnosticToolsEnabled = enabledTools.includes('run_diagnostic_tooling_query')
    && enabledTools.includes('get_metadata_component_context');

  return Object.freeze({
    playbookVersion: AGENT_PLAYBOOK_VERSION,
    enabledTools: Object.freeze(enabledTools),
    createAllowedObjects: createToolEnabled
      ? Object.freeze(normalizeObjectNames(input.createAllowedObjects))
      : Object.freeze([]),
    updateAllowedObjects: updateToolEnabled
      ? Object.freeze(normalizeObjectNames(input.updateAllowedObjects))
      : Object.freeze([]),
    diagnosticReady: diagnosticToolsEnabled && input.diagnosticReady === true,
    dynamicFormEvidence: input.dynamicFormEvidence ?? 'NOT_AVAILABLE',
  });
}

export function isAgentInfrastructureToolName(value: string): value is AgentInfrastructureToolName {
  return (AGENT_INFRASTRUCTURE_TOOL_NAMES as readonly string[]).includes(value);
}

export function isAgentRecognizedToolName(value: string): value is AgentRecognizedToolName {
  return (AGENT_RECOGNIZED_TOOL_NAMES as readonly string[]).includes(value);
}

function normalizeObjectNames(values: readonly string[] | undefined): string[] {
  const names = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (OBJECT_API_NAME_PATTERN.test(trimmed)) names.add(trimmed);
  }
  return [...names].sort((left, right) => left.localeCompare(right, 'en-US'));
}

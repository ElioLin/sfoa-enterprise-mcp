import { MANAGED_DML_FIELD_SAFE_STRATEGIES } from '@sfoa/control-plane/contracts';
import {
  AGENT_RECOGNIZED_TOOL_NAMES,
  createAgentCapabilities,
  renderDifyInstruction,
  type AgentCapabilities,
  type AgentRecognizedToolName,
} from '@sfoa/agent-playbook';
import type { AdminToolRecordDto, DiagnosticConfigRecord, DmlPolicyRecord, ManagedDmlFieldRuleRecord } from '@sfoa/control-plane';

export type AdminManagedDmlFieldFact = Readonly<ManagedDmlFieldRuleRecord & { objectApiName: string }>;

export type DifyInstructionInput = Readonly<{
  tools: readonly AdminToolRecordDto[];
  dmlPolicies: readonly DmlPolicyRecord[];
  diagnostic: DiagnosticConfigRecord | null;
  managedDmlFields?: readonly AdminManagedDmlFieldFact[];
}>;

export type DifyInstructionFacts = Readonly<{
  availableTools: readonly AgentRecognizedToolName[];
  createObjects: readonly string[];
  updateObjects: readonly string[];
  diagnosticReady: boolean;
  diagnosticEnabledButUnverified: boolean;
  managedDmlFieldCount: number;
  capabilities: AgentCapabilities;
}>;

export function generateDifyAgentInstruction(input: DifyInstructionInput): string {
  return renderDifyInstruction(deriveDifyInstructionFacts(input).capabilities);
}

export function deriveDifyInstructionFacts(input: DifyInstructionInput): DifyInstructionFacts {
  const enabled = new Set<AgentRecognizedToolName>();
  for (const tool of input.tools) {
    if (
      isRecognizedToolName(tool.toolName)
      && tool.enabled
      && tool.remoteCompatible
      && tool.status === 'AVAILABLE'
    ) {
      enabled.add(tool.toolName);
    }
  }
  const diagnosticToolsConfigured = enabled.has('run_diagnostic_tooling_query')
    && enabled.has('get_metadata_component_context');
  const diagnosticReady = diagnosticToolsConfigured
    && input.diagnostic?.enabled === true
    && input.diagnostic.verificationStatus === 'PASS';
  const diagnosticEnabledButUnverified = diagnosticToolsConfigured && !diagnosticReady;
  if (!diagnosticReady) {
    enabled.delete('run_diagnostic_tooling_query');
    enabled.delete('get_metadata_component_context');
  }

  const availableTools = AGENT_RECOGNIZED_TOOL_NAMES.filter((toolName) => enabled.has(toolName));
  const enabledPolicies = input.dmlPolicies.filter((policy) => policy.enabled);
  const createObjects = enabled.has('create_record')
    ? sortedUnique(enabledPolicies.filter((policy) => policy.allowCreate).map((policy) => policy.objectApiName))
    : [];
  const updateObjects = enabled.has('update_record')
    ? sortedUnique(enabledPolicies.filter((policy) => policy.allowUpdate).map((policy) => policy.objectApiName))
    : [];
  const capabilities = createAgentCapabilities({
    enabledTools: availableTools,
    createAllowedObjects: createObjects,
    updateAllowedObjects: updateObjects,
    diagnosticReady,
    dynamicFormEvidence: 'NOT_AVAILABLE',
    managedDmlFields: (input.managedDmlFields ?? []).filter((rule) => rule.enabled).map((rule) => ({
      objectApiName: rule.objectApiName,
      fieldApiName: rule.targetFieldApiName,
      operations: [
        ...(rule.applyOnCreate ? ['CREATE' as const] : []),
        ...(rule.applyOnUpdate ? ['UPDATE' as const] : []),
      ],
      managedBy: 'MCP' as const,
      strategy: MANAGED_DML_FIELD_SAFE_STRATEGIES[rule.strategy],
    })),
  });

  return Object.freeze({
    availableTools: capabilities.enabledTools,
    createObjects: capabilities.createAllowedObjects,
    updateObjects: capabilities.updateAllowedObjects,
    diagnosticReady: capabilities.diagnosticReady,
    diagnosticEnabledButUnverified,
    managedDmlFieldCount: capabilities.managedDmlFields.length,
    capabilities,
  });
}

function isRecognizedToolName(value: string): value is AgentRecognizedToolName {
  return (AGENT_RECOGNIZED_TOOL_NAMES as readonly string[]).includes(value);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en-US'));
}

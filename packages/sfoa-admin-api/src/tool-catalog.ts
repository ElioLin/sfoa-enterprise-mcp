import type { ToolControlRecord } from '@sfoa/control-plane';
import { SFOA_CONTEXT_TOOL_NAMES, SFOA_CONTEXT_TOOL_ROLES } from '@sfoa/mcp-provider-sfoa-context';
import { SFOA_DML_TOOL_NAMES } from '@sfoa/mcp-provider-sfoa-dml';
import {
  OFFICIAL_TOOL_CATALOG,
  type ToolClassification,
  type UpstreamInventoryComparison,
} from '@sfoa/mcp-server';

export type AdminToolRecord = Readonly<{
  toolName: string;
  classification: ToolClassification;
  executionRole: 'USER' | 'DIAGNOSTIC';
  remoteCompatible: boolean;
  releaseState: 'GA' | 'NON_GA' | 'UNKNOWN';
  enabled: boolean;
  rowVersion: string | null;
  remark: string | null;
  dependencies: readonly string[];
  status: 'AVAILABLE' | 'DISABLED' | 'UNSUPPORTED' | 'REVIEW_REQUIRED' | 'UNKNOWN';
  enableAllowed: boolean;
  disabledReason: string | null;
}>;

export function buildAdminToolCatalog(
  controls: readonly ToolControlRecord[],
  upstream: UpstreamInventoryComparison,
): readonly AdminToolRecord[] {
  const byName = new Map(controls.map((control) => [control.toolName, control]));
  const records: AdminToolRecord[] = [];
  for (const policy of OFFICIAL_TOOL_CATALOG) {
    const control = byName.get(policy.name);
    byName.delete(policy.name);
    const safeClassification = policy.classification === 'READ' || policy.classification === 'METADATA_READ';
    const enableAllowed = upstream.status === 'PASS' && safeClassification && policy.p2RemoteCompatible && Boolean(policy.remoteContract);
    records.push(toolRecord({
      toolName: policy.name,
      classification: policy.classification,
      executionRole: 'USER',
      remoteCompatible: policy.p2RemoteCompatible,
      releaseState: policy.upstreamContract?.releaseState === 'ga' ? 'GA' : 'NON_GA',
      control,
      dependencies: policy.needsFilesystem ? ['request workspace', 'CWD guard'] : [],
      enableAllowed,
      disabledReason: upstream.status !== 'PASS'
        ? 'Upstream contract drift requires Maintainer review.'
        : !safeClassification
          ? `Official classification ${policy.classification} is not Agent-safe in this runtime.`
          : !policy.p2RemoteCompatible || !policy.remoteContract
            ? 'The audited Tool is not remote compatible.'
            : null,
    }));
  }
  for (const toolName of SFOA_DML_TOOL_NAMES) {
    const control = byName.get(toolName);
    byName.delete(toolName);
    records.push(toolRecord({
      toolName, classification: 'MUTATION', executionRole: 'USER', remoteCompatible: true,
      releaseState: 'GA', control, dependencies: ['Object × CREATE/UPDATE policy'], enableAllowed: true,
      disabledReason: null,
    }));
  }
  for (const toolName of SFOA_CONTEXT_TOOL_NAMES) {
    const control = byName.get(toolName);
    byName.delete(toolName);
    const diagnostic = SFOA_CONTEXT_TOOL_ROLES[toolName] === 'DIAGNOSTIC';
    const enableAllowed = !diagnostic || upstream.status === 'PASS';
    records.push(toolRecord({
      toolName,
      classification: toolName === 'get_metadata_component_context' ? 'METADATA_READ' : 'READ',
      executionRole: diagnostic ? 'DIAGNOSTIC' : 'USER',
      remoteCompatible: true,
      releaseState: 'GA',
      control,
      dependencies: diagnostic ? ['enabled Diagnostic configuration', 'audited official Tool contract'] : ['USER identity route'],
      enableAllowed,
      disabledReason: enableAllowed ? null : 'Upstream contract drift requires Maintainer review.',
    }));
  }
  for (const control of byName.values()) {
    records.push(Object.freeze({
      toolName: control.toolName, classification: 'UNKNOWN', executionRole: 'USER', remoteCompatible: false,
      releaseState: 'UNKNOWN', enabled: control.enabled, rowVersion: control.rowVersion, remark: control.remark,
      dependencies: Object.freeze([]), status: 'UNKNOWN', enableAllowed: false,
      disabledReason: 'Database Tool name is absent from the audited executable catalog.',
    }));
  }
  return Object.freeze(records.sort((left, right) => left.toolName.localeCompare(right.toolName)));
}

export function canEnableAdminTool(toolName: string, upstream: UpstreamInventoryComparison): Readonly<{ allowed: boolean; reason?: string }> {
  const record = buildAdminToolCatalog([], upstream).find((tool) => tool.toolName === toolName);
  return record?.enableAllowed
    ? Object.freeze({ allowed: true })
    : Object.freeze({ allowed: false, reason: record?.disabledReason ?? 'Unknown Tool cannot be enabled.' });
}

function toolRecord(input: Readonly<{
  toolName: string;
  classification: ToolClassification;
  executionRole: 'USER' | 'DIAGNOSTIC';
  remoteCompatible: boolean;
  releaseState: 'GA' | 'NON_GA';
  control?: ToolControlRecord;
  dependencies: readonly string[];
  enableAllowed: boolean;
  disabledReason: string | null;
}>): AdminToolRecord {
  const invalidEnabled = input.control?.enabled === true && !input.enableAllowed;
  return Object.freeze({
    toolName: input.toolName,
    classification: input.classification,
    executionRole: input.executionRole,
    remoteCompatible: input.remoteCompatible,
    releaseState: input.releaseState,
    enabled: input.control?.enabled === true,
    rowVersion: input.control?.rowVersion ?? null,
    remark: input.control?.remark ?? null,
    dependencies: Object.freeze([...input.dependencies]),
    status: invalidEnabled
      ? input.disabledReason?.includes('drift') ? 'REVIEW_REQUIRED' : 'UNSUPPORTED'
      : input.control?.enabled ? 'AVAILABLE' : 'DISABLED',
    enableAllowed: input.enableAllowed,
    disabledReason: input.disabledReason,
  });
}

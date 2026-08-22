import {
  OFFICIAL_TOOL_CATALOG,
  type OfficialToolPolicyRecord,
  type ToolClassification,
} from './official-tool-catalog.js';
import { RemoteRuntimeError } from './errors.js';

export const DEFAULT_ENABLED_TOOLS = Object.freeze(['get_username', 'run_soql_query'] as const);
export const P2_ALLOWED_CLASSIFICATIONS = Object.freeze(['READ', 'METADATA_READ'] as const);

export class ToolGovernancePolicy {
  public readonly enabledTools: readonly string[];
  private readonly recordsByName: ReadonlyMap<string, OfficialToolPolicyRecord>;

  public constructor(
    requestedTools: readonly string[],
    providerToolNames: readonly string[],
    catalog: readonly OfficialToolPolicyRecord[] = OFFICIAL_TOOL_CATALOG,
  ) {
    const recordsByName = new Map<string, OfficialToolPolicyRecord>();
    for (const record of catalog) {
      if (recordsByName.has(record.name)) {
        throw new RemoteRuntimeError(
          'MCP_PROVIDER_INITIALIZATION_FAILED',
          `The explicit Tool policy contains a duplicate Tool: ${record.name}.`,
        );
      }
      recordsByName.set(record.name, record);
    }

    const available = new Set(providerToolNames);
    if (available.size !== providerToolNames.length) {
      throw new RemoteRuntimeError(
        'MCP_PROVIDER_INITIALIZATION_FAILED',
        'The official Provider returned duplicate Tool names.',
      );
    }

    const enabled: string[] = [];
    for (const name of requestedTools) {
      const record = recordsByName.get(name);
      if (!record) {
        throw new RemoteRuntimeError(
          'MCP_TOOL_NOT_AVAILABLE',
          `Configured Tool ${name} is not present in the explicit official Tool inventory.`,
        );
      }
      if (!isP2AllowedClassification(record.classification)) {
        throw new RemoteRuntimeError(
          'MCP_TOOL_DISABLED',
          `Configured Tool ${name} is classified ${record.classification} and is forbidden by the read-only P2 policy.`,
        );
      }
      if (!record.p2RemoteCompatible || !available.has(name)) {
        throw new RemoteRuntimeError(
          'MCP_TOOL_NOT_AVAILABLE',
          `Configured Tool ${name} is not available through the validated P2 remote Provider composition.`,
        );
      }
      if (!enabled.includes(name)) enabled.push(name);
    }

    this.recordsByName = recordsByName;
    this.enabledTools = Object.freeze(enabled);
  }

  public getRecord(name: string): OfficialToolPolicyRecord {
    const record = this.recordsByName.get(name);
    if (!record) {
      throw new RemoteRuntimeError('MCP_TOOL_NOT_AVAILABLE', `Tool ${name} is not in the explicit official inventory.`);
    }
    return record;
  }

  public isEnabled(name: string): boolean {
    return this.enabledTools.includes(name);
  }
}

function isP2AllowedClassification(classification: ToolClassification): boolean {
  return P2_ALLOWED_CLASSIFICATIONS.includes(
    classification as (typeof P2_ALLOWED_CLASSIFICATIONS)[number],
  );
}

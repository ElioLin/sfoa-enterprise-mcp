import {
  SFOA_DML_TOOL_OPERATIONS,
  isSfoaDmlToolName,
  type DmlAllowlistPolicy,
  type SfoaDmlToolName,
} from '@sfoa/mcp-provider-sfoa-dml';
import { RemoteRuntimeError } from './errors.js';

export class DmlToolGovernancePolicy {
  public readonly enabledTools: readonly SfoaDmlToolName[];

  public constructor(
    requestedTools: readonly string[],
    private readonly allowlist: DmlAllowlistPolicy,
  ) {
    const enabled: SfoaDmlToolName[] = [];
    for (const name of requestedTools) {
      if (!isSfoaDmlToolName(name)) {
        throw new RemoteRuntimeError(
          'MCP_TOOL_NOT_AVAILABLE',
          `Configured SFoA mutation Tool ${name} is not in the explicit P3 Tool inventory.`,
        );
      }
      const operation = SFOA_DML_TOOL_OPERATIONS[name];
      if (!allowlist.allowsAny(operation)) {
        throw new RemoteRuntimeError(
          'MCP_DML_CONFIGURATION_INVALID',
          `Configured Tool ${name} requires at least one MCP_DML_ALLOWLIST_JSON object with ${operation}.`,
        );
      }
      if (!enabled.includes(name)) enabled.push(name);
    }
    this.enabledTools = Object.freeze(enabled);
  }

  public isEnabled(name: string): name is SfoaDmlToolName {
    return isSfoaDmlToolName(name) && this.enabledTools.includes(name);
  }

  public getAllowlist(): DmlAllowlistPolicy {
    return this.allowlist;
  }
}

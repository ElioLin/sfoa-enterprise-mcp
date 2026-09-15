import {
  SFOA_ATTACHMENT_TOOL_NAMES,
  isSfoaAttachmentToolName,
  type AttachmentPolicy,
  type SfoaAttachmentToolName,
} from './attachment-policy.js';
import { RemoteRuntimeError } from './errors.js';

/**
 * Governance for the attachment Tool, kept separate from `DmlToolGovernancePolicy`
 * for the same reason the two policies are separate.
 *
 * Enabling `upload_files_to_record` while no object is configured for attachment
 * upload is a configuration error rather than a runtime surprise: the request fails
 * closed with a named code instead of advertising a Tool that could never succeed —
 * exactly the contract `DmlToolGovernancePolicy` already enforces for CREATE/UPDATE.
 */
export class AttachmentToolGovernancePolicy {
  public readonly enabledTools: readonly SfoaAttachmentToolName[];

  public constructor(
    requestedTools: readonly string[],
    private readonly policy: AttachmentPolicy,
  ) {
    const enabled: SfoaAttachmentToolName[] = [];
    for (const name of requestedTools) {
      if (!isSfoaAttachmentToolName(name)) {
        throw new RemoteRuntimeError(
          'MCP_TOOL_NOT_AVAILABLE',
          `Configured SFoA attachment Tool ${name} is not in the explicit attachment Tool inventory.`,
        );
      }
      if (!policy.allowsAny()) {
        throw new RemoteRuntimeError(
          'MCP_ATTACHMENT_CONFIGURATION_INVALID',
          `Configured Tool ${name} requires at least one object with attachment upload enabled.`,
        );
      }
      if (!enabled.includes(name)) enabled.push(name);
    }
    this.enabledTools = Object.freeze(enabled);
  }

  public isEnabled(name: string): name is SfoaAttachmentToolName {
    return isSfoaAttachmentToolName(name) && this.enabledTools.includes(name);
  }

  public getPolicy(): AttachmentPolicy {
    return this.policy;
  }
}

export { SFOA_ATTACHMENT_TOOL_NAMES };

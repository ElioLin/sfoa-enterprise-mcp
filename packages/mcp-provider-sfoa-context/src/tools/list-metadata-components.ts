import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { MetadataComponentLister } from '../contracts.js';
import {
  METADATA_LIST_DEFAULT_LIMIT,
  METADATA_LIST_MAX_LIMIT,
  metadataListInputSchema,
  metadataListOutputSchema,
  type MetadataListInput,
} from '../schemas.js';
import { contextExecutionErrorToolResult, contextSuccessToolResult } from '../tool-results.js';

type InputShape = typeof metadataListInputSchema.shape;
type OutputShape = typeof metadataListOutputSchema.shape;

/**
 * The listing half of the metadata pair.
 *
 * `getName()` is the one place the Tool's identity is declared, and the role map in `provider.ts` is what
 * routes it: the name is `DIAGNOSTIC` there, so the call runs on the deployment's fixed diagnostic account
 * and `assertDiagnosticScope` in the host can prove it. Nothing in this class chooses an identity.
 */
export class ListMetadataComponentsMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: MetadataComponentLister) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.METADATA];
  }

  public getName(): string {
    return 'list_metadata_components';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'List Metadata Components',
      description:
        'Enumerates the components of one allowlisted Metadata API type with the fixed server-owned DIAGNOSTIC '
        + 'identity, returning a bounded inventory with each component\'s full name and whatever provenance this '
        + 'org\'s listing carries. Use it to answer "which flows/validation rules/permission sets exist here", then '
        + `pass a fullName to get_metadata_component_context to read that component's content. Component names are `
        + 'localized and may be URL-escaped in this org, and they are returned exactly as stored. It returns component '
        + 'definitions only: it cannot read a business record, and no filesystem path, identity, token, URL, wildcard, '
        + 'deployment, or arbitrary manifest is accepted. The type allowlist is fixed and enumerated in the input schema.',
      inputSchema: metadataListInputSchema.shape,
      outputSchema: metadataListOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: MetadataListInput): Promise<CallToolResult> {
    try {
      const parsed = metadataListInputSchema.parse(input);
      return contextSuccessToolResult(await this.executor.execute(parsed));
    } catch (error) {
      return contextExecutionErrorToolResult(error, 'MCP_METADATA_LIST_FAILED');
    }
  }
}

/**
 * Exported beside the Tool so the defaults and the hard maximum are one declaration: the schema enforces
 * them, the description advertises them, and a test asserts they are the same numbers.
 */
export const LIST_METADATA_COMPONENTS_LIMITS = Object.freeze({
  defaultLimit: METADATA_LIST_DEFAULT_LIMIT,
  maxLimit: METADATA_LIST_MAX_LIMIT,
} as const);

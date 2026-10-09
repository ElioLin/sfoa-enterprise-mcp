import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { MetadataComponentContextExecutor } from '../contracts.js';
import {
  metadataContextInputSchema,
  metadataContextOutputSchema,
  type MetadataContextInput,
} from '../schemas.js';
import { contextExecutionErrorToolResult, contextSuccessToolResult } from '../tool-results.js';

type InputShape = typeof metadataContextInputSchema.shape;
type OutputShape = typeof metadataContextOutputSchema.shape;

export class MetadataComponentContextMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: MetadataComponentContextExecutor) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.METADATA];
  }

  public getName(): string {
    return 'get_metadata_component_context';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Get Metadata Component Context',
      description:
        'Reads one allowlisted Salesforce metadata component, addressed by its exact full name, with the fixed '
        + 'server-owned DIAGNOSTIC identity. The server generates a single-member manifest for the requested '
        + 'component, delegates to the official retrieve_metadata Tool, reads only its request workspace, and '
        + 'returns the bounded UTF-8 metadata source files that retrieve produced, with explicit truncation (at '
        + 'most 40 files / 256 KiB). Because the response is the retrieve\'s own output rather than a per-component '
        + 'projection, one request can yield more than one file — a composite type returns its parts — and the '
        + 'response does not re-verify that every returned file belongs to the named component. Pair it with '
        + 'list_metadata_components to find a component\'s exact full name first: names here are localized and may '
        + 'be URL-escaped, and must be passed back verbatim. No filesystem path, identity, token, URL, wildcard, '
        + 'deployment, or arbitrary package manifest is accepted.',
      inputSchema: metadataContextInputSchema.shape,
      outputSchema: metadataContextOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: MetadataContextInput): Promise<CallToolResult> {
    try {
      const parsed = metadataContextInputSchema.parse(input);
      return contextSuccessToolResult(await this.executor.execute(parsed));
    } catch (error) {
      return contextExecutionErrorToolResult(error, 'MCP_METADATA_CONTEXT_FAILED');
    }
  }
}

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { ListSobjectsExecutor } from '../list-sobjects-executor.js';
import {
  LIST_SOBJECTS_DEFAULT_LIMIT,
  LIST_SOBJECTS_MAX_LIMIT,
  listSobjectsInputSchema,
  listSobjectsOutputSchema,
  type ListSobjectsInput,
} from '../schemas.js';
import { dataFailureToolResult, dataSuccessToolResult } from '../tool-results.js';

type InputShape = typeof listSobjectsInputSchema.shape;
type OutputShape = typeof listSobjectsOutputSchema.shape;

export class ListSobjectsMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: ListSobjectsExecutor) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'list_sobjects';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'List Salesforce Objects',
      description:
        'Lists the Salesforce objects available to the authenticated request identity, with a label, key prefix and the queryable / createable / updateable / searchable capabilities of each. '
        + 'Use it to discover which objects exist and to confirm an object API name before writing a query — never guess an object name. '
        + 'The result always reports how many objects matched, so a truncated list is never mistaken for the whole org inventory. '
        + 'It reads schema only: it returns no business records and changes nothing.',
      inputSchema: listSobjectsInputSchema.shape,
      outputSchema: listSobjectsOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: ListSobjectsInput): Promise<CallToolResult> {
    try {
      const parsed = listSobjectsInputSchema.parse(input);
      return dataSuccessToolResult(await this.executor.execute(parsed));
    } catch (error) {
      return dataFailureToolResult(error, 'MCP_SOBJECT_LIST_FAILED');
    }
  }
}

export const LIST_SOBJECTS_LIMITS = Object.freeze({
  defaultLimit: LIST_SOBJECTS_DEFAULT_LIMIT,
  maxLimit: LIST_SOBJECTS_MAX_LIMIT,
});

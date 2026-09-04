import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { RecordDisplayContextExecutor } from '../record-display-executor.js';
import {
  recordDisplayContextInputSchema,
  recordDisplayContextOutputSchema,
  type RecordDisplayContextInput,
} from '../schemas.js';
import { contextExecutionErrorToolResult, contextSuccessToolResult } from '../tool-results.js';

type InputShape = typeof recordDisplayContextInputSchema.shape;
type OutputShape = typeof recordDisplayContextOutputSchema.shape;

export class RecordDisplayContextMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: RecordDisplayContextExecutor) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'get_record_display_context';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Get Record Display Context',
      description:
        'Returns how records of a Salesforce object should be presented to the authenticated request USER, without querying business records: the object label/plural, the Salesforce-declared name/display fields (never a hard-coded Name), the Record Type-aware Compact Layout field order, the View (Full) Layout field order, and available Record Types. Pass recordTypeId when the object has several Record Types so the layout facts match the exact Record Type. It does not query records, evaluate Dynamic Forms, resolve lookups, or perform DML. Read coverage.viewLayoutEvaluated, coverage.compactLayoutEvaluated, coverage.nameFieldSource, and coverage.warnings: a layout that Salesforce cannot return is reported there instead of failing the request.',
      inputSchema: recordDisplayContextInputSchema.shape,
      outputSchema: recordDisplayContextOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: RecordDisplayContextInput): Promise<CallToolResult> {
    try {
      const parsed = recordDisplayContextInputSchema.parse(input);
      return contextSuccessToolResult(await this.executor.execute(parsed));
    } catch (error) {
      return contextExecutionErrorToolResult(error, 'MCP_RECORD_DISPLAY_CONTEXT_INVALID');
    }
  }
}

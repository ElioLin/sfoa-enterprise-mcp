import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { RecordActionContextExecutor } from '../record-action-executor.js';
import {
  recordActionContextInputSchema,
  recordActionContextInputObjectSchema,
  recordActionContextOutputSchema,
  type RecordActionContextInput,
} from '../schemas.js';
import { contextExecutionErrorToolResult, contextSuccessToolResult } from '../tool-results.js';

type InputShape = typeof recordActionContextInputObjectSchema.shape;
type OutputShape = typeof recordActionContextOutputSchema.shape;

export class RecordActionContextMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: RecordActionContextExecutor) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'get_record_action_context';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Get Record Action Context',
      description:
        'Returns bounded Salesforce REST UI API facts for CREATE or UPDATE as the authenticated request USER: effective and available Record Types, separate API/layout required flags, field and layout editability, Salesforce create defaults, record-type picklist/dependency facts, labels, types, references, and Page Layout order. For CREATE with no explicit recordTypeId, if the current user has exactly one available Record Type it is selected automatically; if several are available the result instead exposes availableRecordTypes with recordTypeSelectionRequired=true and skips Create Defaults/Picklists until you call again with the chosen recordTypeId. It does not infer missing input, recommend fields, resolve lookups, evaluate full Dynamic Forms, ask the user, or perform DML. If values are truncated, do not guess omitted values.',
      inputSchema: recordActionContextInputObjectSchema.shape,
      outputSchema: recordActionContextOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: RecordActionContextInput): Promise<CallToolResult> {
    try {
      const parsed = recordActionContextInputSchema.parse(input);
      return contextSuccessToolResult(await this.executor.execute(parsed));
    } catch (error) {
      return contextExecutionErrorToolResult(error, 'MCP_RECORD_ACTION_CONTEXT_INVALID');
    }
  }
}

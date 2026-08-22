import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { DmlExecutor } from '../dml-executor.js';
import {
  dmlOutputSchema,
  updateRecordInputSchema,
  type UpdateRecordInput,
} from '../schemas.js';
import { dmlExecutionErrorToolResult, dmlSuccessToolResult } from '../tool-results.js';

type InputShape = typeof updateRecordInputSchema.shape;
type OutputShape = typeof dmlOutputSchema.shape;

export class UpdateRecordMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: DmlExecutor) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'update_record';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Update Salesforce Record',
      description:
        'Updates scalar fields on exactly one record in an explicitly allowlisted Salesforce object through the authenticated request identity. This mutation is not idempotent. If the outcome is unknown or the Tool times out, do not automatically retry: first use a read-only Tool to verify Salesforce state, and inform the user when the state cannot be confirmed. Provide recordId separately; fields.Id and relationship paths are rejected. This Tool does not perform SOQL, upsert, bulk update, or delete. Returns only success and the updated record ID.',
      inputSchema: updateRecordInputSchema.shape,
      outputSchema: dmlOutputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: UpdateRecordInput): Promise<CallToolResult> {
    try {
      const parsed = updateRecordInputSchema.parse(input);
      return dmlSuccessToolResult(await this.executor.update(parsed));
    } catch (error) {
      return dmlExecutionErrorToolResult(error, 'UPDATE');
    }
  }
}

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpTool, ReleaseState, Toolset, type McpToolConfig } from '@salesforce/mcp-provider-api';
import { ZodError, type z } from 'zod';
import { DmlExecutor, batchFailureOutput } from '../dml-executor.js';
import { DmlRuntimeError } from '../errors.js';
import { batchDmlOutputSchema, createRecordsInputSchema, updateRecordsInputSchema,
  type BatchDmlOutput, type CreateRecordsInput, type UpdateRecordsInput } from '../schemas.js';

/**
 * MCP Tool error semantics are about whether the Tool execution completed, not about whether
 * every requested business record succeeded.
 *
 * PARTIAL_SUCCESS means Salesforce committed the successful items in this request. Reporting
 * it as `isError: true` would route the client into a Tool-error correction/retry path that
 * can resubmit records which already exist. `clientReferenceId` is a correlation key, never an
 * idempotency key, so a duplicate CREATE could not be detected by Salesforce.
 *
 * Only FAILED (nothing committed) and OUTCOME_UNKNOWN (commit state not provable) are errors.
 */
export const BATCH_TOOL_ERROR_STATUSES = ['FAILED', 'OUTCOME_UNKNOWN'] as const;

export function isBatchToolError(status: BatchDmlOutput['status']): boolean {
  return (BATCH_TOOL_ERROR_STATUSES as readonly string[]).includes(status);
}

export function batchToolResult(output: BatchDmlOutput): CallToolResult {
  return {
    isError: isBatchToolError(output.status),
    content: [{ type: 'text', text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

type InputShape = z.ZodRawShape;
export class BatchRecordsMcpTool extends McpTool<InputShape, typeof batchDmlOutputSchema.shape> {
  public constructor(private readonly executor: DmlExecutor, private readonly operation: 'CREATE' | 'UPDATE') { super(); }
  public getName(): string { return this.operation === 'CREATE' ? 'create_records' : 'update_records'; }
  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.DATA]; }
  public getConfig(): McpToolConfig<InputShape, typeof batchDmlOutputSchema.shape> {
    return { title: `${this.operation === 'CREATE' ? 'Create' : 'Update'} Salesforce Records`,
      description: `${this.operation} 1..200 records of one allowlisted object as the current request USER in one synchronous Salesforce collection request. Each row retains single-record governance and managed fields. allOrNone defaults false; true rolls back only this request. clientReferenceId is optional, unique batch correlation, never a business field. Returns item-level outcomes and SUCCESS/PARTIAL_SUCCESS/FAILED/OUTCOME_UNKNOWN. SUCCESS and PARTIAL_SUCCESS are successful Tool executions (isError=false); FAILED and OUTCOME_UNKNOWN are Tool errors. After PARTIAL_SUCCESS the successful items are already committed: never resubmit the whole batch, only re-prepare the failed items. Never retry UNKNOWN automatically. Multiple calls have no global transaction. No DELETE, UPSERT, Bulk API, identity or relationship-path inputs.`,
      inputSchema: this.operation === 'CREATE' ? createRecordsInputSchema.shape : updateRecordsInputSchema.shape,
      outputSchema: batchDmlOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } };
  }
  public async exec(input: CreateRecordsInput | UpdateRecordsInput): Promise<CallToolResult> {
    try {
      return batchToolResult(this.operation === 'CREATE'
        ? await this.executor.createRecords(createRecordsInputSchema.parse(input))
        : await this.executor.updateRecords(updateRecordsInputSchema.parse(input)));
    } catch (error) {
      const safe = error instanceof DmlRuntimeError ? error : new DmlRuntimeError(
        'MCP_DML_INPUT_INVALID', error instanceof ZodError ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 2000)
          : 'Batch preparation failed before mutation dispatch.');
      const parsed = (this.operation === 'CREATE' ? createRecordsInputSchema : updateRecordsInputSchema).safeParse(input);
      return batchToolResult(batchFailureOutput(parsed.success ? parsed.data : { allOrNone: input?.allOrNone === true, records: [] }, safe));
    }
  }
}

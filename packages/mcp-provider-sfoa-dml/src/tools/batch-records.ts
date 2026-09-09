import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpTool, ReleaseState, Toolset, type McpToolConfig } from '@salesforce/mcp-provider-api';
import { ZodError, type z } from 'zod';
import { DmlExecutor, batchFailureOutput } from '../dml-executor.js';
import { DmlRuntimeError } from '../errors.js';
import { batchDmlOutputSchema, createRecordsInputSchema, updateRecordsInputSchema,
  type BatchDmlOutput, type CreateRecordsInput, type UpdateRecordsInput } from '../schemas.js';

export function batchToolResult(output: BatchDmlOutput): CallToolResult {
  return { isError: output.status !== 'SUCCESS', content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
}

type InputShape = z.ZodRawShape;
export class BatchRecordsMcpTool extends McpTool<InputShape, typeof batchDmlOutputSchema.shape> {
  public constructor(private readonly executor: DmlExecutor, private readonly operation: 'CREATE' | 'UPDATE') { super(); }
  public getName(): string { return this.operation === 'CREATE' ? 'create_records' : 'update_records'; }
  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.DATA]; }
  public getConfig(): McpToolConfig<InputShape, typeof batchDmlOutputSchema.shape> {
    return { title: `${this.operation === 'CREATE' ? 'Create' : 'Update'} Salesforce Records`,
      description: `${this.operation} 1..200 records of one allowlisted object as the current request USER in one synchronous Salesforce collection request. Each row retains single-record governance and managed fields. allOrNone defaults false; true rolls back only this request. clientReferenceId is optional, unique batch correlation, never a business field. Returns item-level outcomes and SUCCESS/PARTIAL_SUCCESS/FAILED/OUTCOME_UNKNOWN. Never retry UNKNOWN automatically. Multiple calls have no global transaction. No DELETE, UPSERT, Bulk API, identity or relationship-path inputs.`,
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

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { DmlExecutor } from '../dml-executor.js';
import {
  createRecordInputSchema,
  dmlOutputSchema,
  type CreateRecordInput,
} from '../schemas.js';
import { dmlExecutionErrorToolResult, dmlSuccessToolResult } from '../tool-results.js';

type InputShape = typeof createRecordInputSchema.shape;
type OutputShape = typeof dmlOutputSchema.shape;

export class CreateRecordMcpTool extends McpTool<InputShape, OutputShape> {
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
    return 'create_record';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Create Salesforce Record',
      description:
        'Creates exactly one record in an explicitly allowlisted Salesforce object through the authenticated request identity. Provide objectApiName and non-empty scalar fields. This Tool does not accept identity, org, URL, API-version, operation, relationship, bulk, upsert, or delete inputs. Returns only success and the new record ID.',
      inputSchema: createRecordInputSchema.shape,
      outputSchema: dmlOutputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: CreateRecordInput): Promise<CallToolResult> {
    try {
      const parsed = createRecordInputSchema.parse(input);
      return dmlSuccessToolResult(await this.executor.create(parsed));
    } catch (error) {
      return dmlExecutionErrorToolResult(error);
    }
  }
}

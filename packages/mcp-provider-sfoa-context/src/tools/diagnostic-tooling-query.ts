import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { DiagnosticToolingQueryExecutor } from '../contracts.js';
import {
  diagnosticQueryInputSchema,
  diagnosticQueryOutputSchema,
  type DiagnosticQueryInput,
} from '../schemas.js';
import { contextExecutionErrorToolResult, contextSuccessToolResult } from '../tool-results.js';

type InputShape = typeof diagnosticQueryInputSchema.shape;
type OutputShape = typeof diagnosticQueryOutputSchema.shape;

export class DiagnosticToolingQueryMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: DiagnosticToolingQueryExecutor) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'run_diagnostic_tooling_query';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Run Diagnostic Tooling Query',
      description:
        'Runs one read-only SELECT through the Salesforce Tooling API using a fixed server-owned DIAGNOSTIC integration user. The schema contains no identity, role, token, org, URL, directory, or useToolingApi switch. Use it for deterministic metadata/code discovery facts; it cannot use the normal business-record query endpoint. Results are bounded and explicit about truncation.',
      inputSchema: diagnosticQueryInputSchema.shape,
      outputSchema: diagnosticQueryOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: DiagnosticQueryInput): Promise<CallToolResult> {
    try {
      const parsed = diagnosticQueryInputSchema.parse(input);
      const evidence = await this.executor.execute(parsed);
      return contextSuccessToolResult({
        success: true,
        executionRole: 'DIAGNOSTIC',
        api: 'TOOLING',
        ...evidence,
      });
    } catch (error) {
      return contextExecutionErrorToolResult(error, 'MCP_DIAGNOSTIC_QUERY_FAILED');
    }
  }
}

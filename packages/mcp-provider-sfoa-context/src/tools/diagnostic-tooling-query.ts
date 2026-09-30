import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { DiagnosticToolingQueryExecutor } from '../contracts.js';
import { assertDiagnosticQueryTargets } from '../diagnostic-tooling-types.js';
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
        'Runs one read-only SELECT through the Salesforce Tooling API using a fixed server-owned DIAGNOSTIC integration user. The schema contains no identity, role, token, org, URL, directory, or useToolingApi switch. Use it for deterministic metadata/code discovery facts; it cannot use the normal business-record query endpoint. The FROM object must be on the diagnostic allowlist — the Setup and Tooling types this server is willing to read as a diagnostic identity — and a statement naming anything else is refused before Salesforce is called, so a business object such as Lead or Account is rejected here rather than reaching the org. Results are bounded and explicit about truncation.',
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
      // ADR-0029 §4b, and it runs *before* the executor so the refusal never reaches Salesforce: the
      // Tooling API is asked only for objects on the diagnostic allowlist. This is the first of two
      // layers, not the only one — the platform's own refusal for a business object is deliberately
      // kept as the backstop, because a check over the statement text is a filter and not a
      // guarantee. `assertDiagnosticQueryTargets` documents that limit where it is implemented.
      assertDiagnosticQueryTargets(parsed.query);
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

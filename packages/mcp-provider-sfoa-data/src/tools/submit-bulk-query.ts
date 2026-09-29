import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import { BULK_QUERY_RESULTS_TOOL_NAME } from '../bulk-query-api.js';
import type { SubmitBulkQueryExecutor } from '../bulk-query-submit-executor.js';
import {
  BULK_QUERY_MAX_QUERY_LENGTH,
  submitBulkQueryInputSchema,
  submitBulkQueryInputShape,
  submitBulkQueryOutputSchema,
  type SubmitBulkQueryInput,
} from '../schemas.js';
import { dataFailureToolResult } from '../tool-results.js';

type InputShape = typeof submitBulkQueryInputShape;
type OutputShape = typeof submitBulkQueryOutputSchema.shape;

export class SubmitBulkQueryMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: SubmitBulkQueryExecutor) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'submit_bulk_query';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Submit Bulk Query Job',
      description:
        'Starts an asynchronous Bulk API 2.0 query job and returns its jobId. This is the export path for a '
        + 'result set too large to page: Salesforce runs the statement server-side, and the rows are read '
        + `afterwards with ${BULK_QUERY_RESULTS_TOOL_NAME}. `
        + 'Read-only in the sense that matters: the job only reads business data. It creates a query, never an '
        + 'insert, update, upsert or delete — the Bulk ingest and DML operations are not reachable through this '
        + 'Tool, because the operation is fixed to query rather than accepted as input. Nothing about the org\'s '
        + 'data changes. '
        + 'When to use it: a detail export of more than about two thousand rows, or one whose completeness you '
        + 'have to be able to state. A REST SOQL query is capped at one page per request and its continuation '
        + 'cursor eventually stops, so a very large export has no bounded path through it. Use query_records for '
        + 'a small or exploratory result instead — it is cheaper, and for a total or a breakdown a COUNT() or '
        + 'GROUP BY query is cheaper still and always bounded. '
        + 'A job is asynchronous: this call almost always returns a state of UploadComplete or InProgress rather '
        + `than rows. Call ${BULK_QUERY_RESULTS_TOOL_NAME} with the returned jobId to check the state, and keep `
        + 'calling it until the state is JobComplete; do not resubmit, which would cost a second set of API calls '
        + 'for the same data. '
        + 'No job state is stored on the server: the Id is the caller\'s to hold and pass back, which is what lets '
        + 'this work over a stateless HTTP transport. Salesforce keeps the job for a few days. '
        + 'Quota: there is no pre-flight check, because the org\'s limits resource is not readable through the '
        + 'request identity. The response reports the org\'s own API-usage counter instead, and a refusal that is '
        + 'about the allowance says so and names get_org_limits where that Tool is available. '
        + 'Failures come back as structured errors carrying errorCode, message and suggestion: an INVALID_FIELD or '
        + 'INVALID_TYPE means the name is wrong, so call describe_sobject for the object and correct the statement '
        + 'rather than guessing again.',
      inputSchema: submitBulkQueryInputShape,
      outputSchema: submitBulkQueryOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: SubmitBulkQueryInput): Promise<CallToolResult> {
    try {
      // Parsed here, not just at the wire: the registered schema is a raw shape whose JSON
      // Schema cannot express the statement rules (see ADR-0024).
      const parsed = submitBulkQueryInputSchema.parse(input);
      const output = await this.executor.execute(parsed);
      return {
        content: [{ type: 'text', text: renderSubmitBulkQueryText(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return dataFailureToolResult(error, 'MCP_BULK_SUBMIT_FAILED');
    }
  }
}

export const SUBMIT_BULK_QUERY_LIMITS = Object.freeze({
  maxQueryLength: BULK_QUERY_MAX_QUERY_LENGTH,
});

/** The text the Agent reads: the job it must hold on to, then the next step. */
export function renderSubmitBulkQueryText(output: Readonly<Record<string, unknown>>): string {
  const lines = [
    `submit_bulk_query: jobId=${format(output.jobId)} state=${format(output.state)} `
      + `apiVersion=${format(output.apiVersion)} operation=${format(output.operation)} `
      + `apiUsage=${formatApiUsage(output.apiUsage)}`,
  ];
  if (typeof output.stateMessage === 'string' && output.stateMessage.length > 0) {
    lines.push(`stateMessage: ${output.stateMessage}`);
  }
  if (typeof output.hint === 'string' && output.hint.length > 0) {
    lines.push(`Next: ${output.hint}`);
  }
  return lines.join('\n');
}

function formatApiUsage(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'unreported';
  const usage = value as Record<string, unknown>;
  return `${format(usage.used)}/${format(usage.limit)} used`;
}

function format(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  return String(value);
}

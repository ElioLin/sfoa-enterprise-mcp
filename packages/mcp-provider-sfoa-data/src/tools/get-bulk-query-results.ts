import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import { BULK_QUERY_COMPLETE_STATE, BULK_QUERY_RESULTS_TOOL_NAME } from '../bulk-query-api.js';
import type { GetBulkQueryResultsExecutor } from '../bulk-query-results-executor.js';
import {
  BULK_QUERY_MAX_LOCATOR_LENGTH,
  BULK_QUERY_RESULTS_DEFAULT_MAX_RECORDS,
  BULK_QUERY_RESULTS_MAX_MAX_RECORDS,
  getBulkQueryResultsInputSchema,
  getBulkQueryResultsInputShape,
  getBulkQueryResultsOutputSchema,
  type GetBulkQueryResultsInput,
} from '../schemas.js';
import { dataFailureToolResult } from '../tool-results.js';

type InputShape = typeof getBulkQueryResultsInputShape;
type OutputShape = typeof getBulkQueryResultsOutputSchema.shape;

export class GetBulkQueryResultsMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: GetBulkQueryResultsExecutor) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return BULK_QUERY_RESULTS_TOOL_NAME;
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Get Bulk Query Results',
      description:
        'Reads the current state of a Bulk API 2.0 query job and, once it has finished, one page of its rows. '
        + 'This is the second half of the export started by submit_bulk_query: it takes the jobId that Tool '
        + 'returned and is called repeatedly until the whole result set has been read. '
        + 'A job is asynchronous, so a call made before it finishes returns its state and no rows — that is not an '
        + `error and not an empty result. Call again until the state is ${BULK_QUERY_COMPLETE_STATE}; do not `
        + 'resubmit the query, because a second job costs a second set of API calls for the same data. '
        + 'Reading a page: pass the locator from the previous result back to continue. A locator is a position in '
        + 'the result stream rather than an offset, so pages continue exactly where the last one stopped and no '
        + `row is ever duplicated or skipped for you. hasMore says whether a next page exists, and complete is `
        + 'true only on the last one. '
        + 'A page is never returned partially. When the response budget cannot fit everything Salesforce sent, '
        + 'this Tool re-reads a smaller page from the same position rather than handing back a cursor that would '
        + 'skip the rows it could not fit; if even a single row is too wide to return, it fails with '
        + 'MCP_BULK_SLICE_TOO_LARGE and says to narrow the statement. maxRecords is therefore an upper bound on '
        + 'the slice, not a promise. '
        + 'Values are strings. Bulk API 2.0 serves results as CSV, so every field arrives as text — a number is '
        + '"42" and an absent field is an empty string rather than null. Convert them before comparing or '
        + 'aggregating. '
        + 'No job state is stored on the server: the jobId and the locator are the caller\'s to hold, and every '
        + 'call re-states them. '
        + 'A job that ended as Failed or Aborted is reported as a structured failure carrying the platform\'s own '
        + 'stateMessage, because "the job failed" and "the job matched nothing" are opposite facts. A job that '
        + 'belongs to a different identity is refused by Salesforce and that refusal is reported as an access '
        + 'error rather than worked around.',
      inputSchema: getBulkQueryResultsInputShape,
      outputSchema: getBulkQueryResultsOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: GetBulkQueryResultsInput): Promise<CallToolResult> {
    try {
      const parsed = getBulkQueryResultsInputSchema.parse(input);
      const output = await this.executor.execute(parsed);
      const text = renderGetBulkQueryResultsText(output);
      // A job that ended as Failed or Aborted is a failure of the export even though the call
      // itself succeeded, so it is returned as an `isError` result with the same structured
      // payload the output schema declares.
      return output.success === false
        ? { isError: true, content: [{ type: 'text', text }], structuredContent: output }
        : { content: [{ type: 'text', text }], structuredContent: output };
    } catch (error) {
      return dataFailureToolResult(error, 'MCP_BULK_RESULTS_FAILED');
    }
  }
}

export const GET_BULK_QUERY_RESULTS_LIMITS = Object.freeze({
  defaultMaxRecords: BULK_QUERY_RESULTS_DEFAULT_MAX_RECORDS,
  maxMaxRecords: BULK_QUERY_RESULTS_MAX_MAX_RECORDS,
  maxLocatorLength: BULK_QUERY_MAX_LOCATOR_LENGTH,
});

const MAX_TEXT_CHARACTERS = 60_000;

/** The text the Agent reads: a fact line, the next step, then the same rows `structuredContent` carries. */
export function renderGetBulkQueryResultsText(output: Readonly<Record<string, unknown>>): string {
  const records = readRecords(output.records);
  const lines = [
    `${BULK_QUERY_RESULTS_TOOL_NAME}: jobId=${format(output.jobId)} state=${format(output.state)} `
      + `numberRecordsProcessed=${format(output.numberRecordsProcessed)} `
      + `numberRecordsFailed=${format(output.numberRecordsFailed)} totalRecords=${format(output.totalRecords)} `
      + `returnedCount=${format(output.returnedCount)} hasMore=${format(output.hasMore)} `
      + `complete=${format(output.complete)} locator=${format(output.locator)}`,
  ];
  if (typeof output.stateMessage === 'string' && output.stateMessage.length > 0) {
    lines.push(`stateMessage: ${output.stateMessage}`);
  }
  if (typeof output.errorCode === 'string' && output.errorCode.length > 0) {
    lines.push(`errorCode: ${output.errorCode}`);
  }
  if (typeof output.message === 'string' && output.message.length > 0) {
    lines.push(`message: ${output.message}`);
  }
  if (typeof output.hint === 'string' && output.hint.length > 0) {
    lines.push(`Next: ${output.hint}`);
  }
  if (typeof output.suggestion === 'string' && output.suggestion.length > 0) {
    lines.push(`Suggestion: ${output.suggestion}`);
  }
  lines.push(records.length === 0 ? 'Records: none.' : `Records (${records.length}):`);
  let used = lines.join('\n').length + 1;
  let printed = 0;
  for (const record of records) {
    const line = `  ${JSON.stringify(record)}`;
    // The structured payload is the source of truth and is already bounded; this guard only
    // keeps the text from being the larger of the two, and says so when it bites.
    if (used + line.length + 1 > MAX_TEXT_CHARACTERS) break;
    lines.push(line);
    used += line.length + 1;
    printed += 1;
  }
  if (printed < records.length) {
    lines.push(`  ... ${records.length - printed} further record(s) are in structuredContent.records.`);
  }
  return lines.join('\n');
}

function readRecords(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function format(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  return String(value);
}

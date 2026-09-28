import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { QueryRecordsExecutor } from '../query-records-executor.js';
import {
  QUERY_RECORDS_DEFAULT_MAX_ROWS,
  QUERY_RECORDS_MAX_MAX_ROWS,
  QUERY_RECORDS_MAX_QUERY_LENGTH,
  QUERY_RECORDS_TIME_BUDGET_MS,
  queryRecordsInputSchema,
  queryRecordsInputShape,
  queryRecordsOutputSchema,
  type QueryRecordsInput,
} from '../schemas.js';
import { dataFailureToolResult } from '../tool-results.js';

type InputShape = typeof queryRecordsInputShape;
type OutputShape = typeof queryRecordsOutputSchema.shape;

export class QueryRecordsMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: QueryRecordsExecutor) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'query_records';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Query Salesforce Records',
      description:
        'Runs one SOQL SELECT against Salesforce and returns the matching records, following the '
        + 'continuation cursor automatically until the result is complete or the requested row budget is '
        + 'reached. '
        + 'Prefer this Tool over run_soql_query whenever the result may exceed a single batch (roughly 2000 '
        + 'rows) or whenever you need to state whether an answer is complete: run_soql_query makes exactly one '
        + 'request, so beyond one batch it returns a partial result that looks complete. Both Tools remain '
        + 'available and run_soql_query is unchanged; use it only for a quick look at a small result. '
        + 'Every result reports totalSize (rows that match), fetched (rows read), returnedCount (rows included '
        + 'here), pages, done and complete — and when the answer is not the whole result it also reports '
        + 'truncatedReason (MAX_ROWS, TIME_BUDGET, RESPONSE_BUDGET or PAGINATION_UNAVAILABLE) together with an '
        + 'actionable next step. Where a total or a breakdown answers the question, a COUNT() or GROUP BY query '
        + 'is cheaper and always bounded; page a large detail set with a WHERE clause on an indexed field, since '
        + 'OFFSET does not scale. '
        + 'Failures come back as structured errors carrying errorCode, message and suggestion: an INVALID_FIELD '
        + 'or INVALID_TYPE means the name is wrong, so call describe_sobject for the object and correct the query '
        + 'rather than guessing again. '
        + 'Read-only: it reads records through the request identity and never modifies data or locks rows. '
        + 'Use useToolingApi only for Tooling objects such as ApexClass or ApexTrigger.',
      inputSchema: queryRecordsInputShape,
      outputSchema: queryRecordsOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: QueryRecordsInput): Promise<CallToolResult> {
    try {
      // Parsed here, not just at the wire: the registered schema is a raw shape whose JSON
      // Schema cannot express the statement rules (see ADR-0024), so this is where the
      // SELECT/semicolon/FOR UPDATE contract is actually enforced.
      const parsed = queryRecordsInputSchema.parse(input);
      const output = await this.executor.execute(parsed);
      return {
        content: [{ type: 'text', text: renderQueryRecordsText(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return dataFailureToolResult(error, 'MCP_QUERY_RECORDS_FAILED');
    }
  }
}

export const QUERY_RECORDS_LIMITS = Object.freeze({
  defaultMaxRows: QUERY_RECORDS_DEFAULT_MAX_ROWS,
  maxMaxRows: QUERY_RECORDS_MAX_MAX_ROWS,
  maxQueryLength: QUERY_RECORDS_MAX_QUERY_LENGTH,
  timeBudgetMs: QUERY_RECORDS_TIME_BUDGET_MS,
});

/** The text the Agent reads: a fact line, the next step, then the same records slice as `structuredContent`. */
export function renderQueryRecordsText(output: Readonly<Record<string, unknown>>): string {
  const records = readRecords(output.records);
  const lines = [
    `query_records: returnedCount=${format(output.returnedCount)} fetched=${format(output.fetched)} `
      + `totalSize=${format(output.totalSize)} pages=${format(output.pages)} `
      + `done=${format(output.done)} complete=${format(output.complete)} `
      + `truncated=${format(output.truncated)} truncatedReason=${format(output.truncatedReason)} `
      + `api=${output.useToolingApi === true ? 'tooling' : 'data'} aggregate=${format(output.aggregate)}`,
  ];
  if (typeof output.hint === 'string' && output.hint.length > 0) {
    lines.push(`Next: ${output.hint}`);
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

const MAX_TEXT_CHARACTERS = 60_000;

function readRecords(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function format(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  return String(value);
}

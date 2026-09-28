import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { SearchRecordsExecutor } from '../search-records-executor.js';
import {
  SEARCH_RECORDS_DEFAULT_LIMIT,
  SEARCH_RECORDS_MAX_FIELDS,
  SEARCH_RECORDS_MAX_LIMIT,
  SEARCH_RECORDS_MAX_OBJECTS,
  SEARCH_RECORDS_MAX_SEARCH_LENGTH,
  searchRecordsInputSchema,
  searchRecordsInputShape,
  searchRecordsOutputSchema,
  type SearchRecordsInput,
  type SearchRecordsOutput,
} from '../schemas.js';
import { SEARCH_RECORDS_DEFAULT_FIELDS } from '../sosl.js';
import { dataFailureToolResult } from '../tool-results.js';

type InputShape = typeof searchRecordsInputShape;
type OutputShape = typeof searchRecordsOutputSchema.shape;

export class SearchRecordsMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: SearchRecordsExecutor) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'search_records';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Search Salesforce Records',
      description:
        'Searches for a term across Salesforce objects with SOSL and returns the matching records grouped by '
        + 'object. This is the lookup SOQL cannot do: a SOQL query needs an object and a field list up front, so '
        + '"which records anywhere mention this term" has no SOQL equivalent. Use it to find a record whose exact '
        + 'name you do not know, and query_records once you know the object. '
        + 'Two forms for search. A bare keyword such as acme is escaped and wrapped for you as '
        + 'FIND {acme} IN ALL FIELDS [RETURNING objects(fields)] LIMIT limit, so a term can never be read as SOSL '
        + 'syntax; a keyword must not contain braces or a semicolon. A complete clause beginning with FIND is sent '
        + 'unchanged, and objects, fields and limit must then be omitted because the clause already carries them. '
        + 'One search per call: statements separated by a semicolon are refused. '
        + 'Name objects to get readable rows. With objects, each record carries the fields you name, defaulting to '
        + 'Id and Name. Without objects the search spans every searchable object — useful for finding out which '
        + 'objects mention a term — but then each record carries only its Id and object type, and the hint says so. '
        + 'SOSL returns just the Id when a field list is omitted, so an object with no Name field (Case, Task) needs '
        + 'an explicit fields list such as ["Id", "Subject"]; an unknown field comes back as MCP_SEARCH_FIELD_INVALID '
        + 'and describe_sobject lists the real ones. '
        + 'limit is one cap on the whole result, not a cap per object. SOSL reports no total match count and hands out '
        + 'no continuation cursor, so this Tool never presents a slice as a whole answer: every result states '
        + 'totalReturned, returnedCount, effectiveLimit, limitSource, truncated, truncatedReason and complete, and '
        + 'complete is true only when the result is strictly below an explicit limit that this Tool could read. Where '
        + 'a clause carries no LIMIT, complete is false and the hint says why — a bounded, honest answer beats a '
        + 'confident guess about how many records exist. '
        + 'Read-only: it reads records through the request identity and never modifies data or locks rows.',
      inputSchema: searchRecordsInputShape,
      outputSchema: searchRecordsOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: SearchRecordsInput): Promise<CallToolResult> {
    try {
      // Parsed here, not just at the wire: the registered schema is a raw shape whose JSON Schema
      // cannot express the keyword/clause rules (see ADR-0024), so this is where the single-statement
      // and parameter-combination contract is actually enforced.
      const parsed = searchRecordsInputSchema.parse(input);
      const output = await this.executor.execute(parsed);
      return {
        content: [{ type: 'text', text: renderSearchRecordsText(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return dataFailureToolResult(error, 'MCP_SEARCH_RECORDS_FAILED');
    }
  }
}

export const SEARCH_RECORDS_LIMITS = Object.freeze({
  defaultLimit: SEARCH_RECORDS_DEFAULT_LIMIT,
  maxLimit: SEARCH_RECORDS_MAX_LIMIT,
  maxSearchLength: SEARCH_RECORDS_MAX_SEARCH_LENGTH,
  maxObjects: SEARCH_RECORDS_MAX_OBJECTS,
  maxFields: SEARCH_RECORDS_MAX_FIELDS,
  defaultFields: SEARCH_RECORDS_DEFAULT_FIELDS,
});

/** The text the Agent reads: the facts, the next step, then the same records slice as `structuredContent`. */
export function renderSearchRecordsText(output: SearchRecordsOutput): string {
  const lines = [
    `search_records: mode=${format(output.mode)} totalReturned=${format(output.totalReturned)} `
      + `returnedCount=${format(output.returnedCount)} objectsReturned=${format(output.objectsReturned)} `
      + `unreadableRecords=${format(output.unreadableRecords)} effectiveLimit=${format(output.effectiveLimit)} `
      + `limitSource=${format(output.limitSource)} truncated=${format(output.truncated)} `
      + `truncatedReason=${format(output.truncatedReason)} complete=${format(output.complete)}`,
    `SOSL: ${format(output.statement)}`,
  ];
  if (typeof output.hint === 'string' && output.hint.length > 0) {
    lines.push(`Next: ${output.hint}`);
  }
  const groups = Object.entries(output.resultsByObject ?? {});
  if (groups.length === 0) {
    lines.push('Records: none matched.');
    return lines.join('\n');
  }
  let used = lines.join('\n').length + 1;
  let printed = 0;
  let budgetReached = false;
  for (const [objectApiName, group] of groups) {
    const header = `${objectApiName}: count=${group.count} returnedCount=${group.returnedCount} atLimit=${group.atLimit}`;
    if (used + header.length + 1 > MAX_TEXT_CHARACTERS) break;
    lines.push(header);
    used += header.length + 1;
    for (const record of group.records) {
      const line = `  ${JSON.stringify(record)}`;
      // The structured payload is the source of truth and is already bounded; this guard only keeps
      // the text from being the larger of the two, and the note below says when it bites. It stops
      // the whole listing rather than skipping ahead, so the text never shows a later group's header
      // with its records missing.
      if (used + line.length + 1 > MAX_TEXT_CHARACTERS) {
        budgetReached = true;
        break;
      }
      lines.push(line);
      used += line.length + 1;
      printed += 1;
    }
    if (budgetReached) break;
  }
  const total = output.returnedCount ?? 0;
  if (printed < total) {
    lines.push(`... ${total - printed} further record(s) are in structuredContent.resultsByObject.`);
  }
  return lines.join('\n');
}

const MAX_TEXT_CHARACTERS = 60_000;

function format(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  return String(value);
}

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { DebugLogBodyReader } from '../contracts.js';
import { DEBUG_LOG_BODY_DEFAULT_MAX_CHARACTERS, DEBUG_LOG_BODY_MAX_CHARACTERS } from '../schemas.js';
import {
  debugLogBodyInputSchema,
  debugLogBodyOutputSchema,
  type DebugLogBodyInput,
  type DebugLogBodyOutput,
} from '../schemas.js';
import { contextExecutionErrorToolResult } from '../tool-results.js';

type InputShape = typeof debugLogBodyInputSchema.shape;
type OutputShape = typeof debugLogBodyOutputSchema.shape;

/**
 * Reads one Apex debug log's text and locates the failure in it.
 *
 * The body is not a SOQL field — `bodySelectableThroughSoql: false`, measured — so it is fetched as its
 * own HTTP call, and it is text rather than JSON, which is why this Tool's budget is characters of log
 * rather than rows of records.
 *
 * **The parse follows the log, not the org.** The header's own first token carries the API version the
 * traced code was compiled against: this org answers v68.0 while its logs opened `56.0` and `54.0`. A
 * parser written against the org's version would mis-read two of the three formats it can meet, and
 * would do it silently. `parseApexLogHeader` therefore reads the version from the log and sets
 * `validated: false` for a version it has no measurement for — parsed, but flagged as unmeasured,
 * because refusing to read readable evidence and guessing at it are both worse than saying which one
 * happened.
 *
 * **Nothing about the log is invented.** A log with no exception reports no exception; a body that is
 * not a log reports `parseStatus: 'NOT_A_LOG'` and returns the text unread; and a log Salesforce has
 * already purged produces a structured error that says so, because Apex log retention is a platform
 * behaviour and an expired log is a fact about the log rather than a fault in this Tool.
 */
export class GetDebugLogBodyMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: DebugLogBodyReader) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'get_debug_log_body';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Read an Apex Debug Log Body',
      description:
        'Reads the full text of one Apex debug log and parses its header, so a failure can be located in a class '
        + 'and a line rather than only observed. Take the logId from get_apex_logs. '
        + 'headerSummary reports what the log itself says: the API version its header declares (which is the '
        + 'version the traced code was compiled against, not this org\'s version), the categories it captured, '
        + 'whether it ran to completion, and on a failure the exception type and message with the top stack frames '
        + 'that name the class, method, line and column. validated is false when the log\'s own version is outside '
        + 'the range this parser has measurements for: the summary is still produced, but it is a parse of an '
        + 'unmeasured format, and it says so rather than presenting a guess as a fact. Parsing is best-effort by '
        + 'design — when the body does not begin with a debug-log header, parseStatus is NOT_A_LOG and the raw '
        + 'text is returned unread instead of being summarised. '
        + `body carries the log text from its start, bounded by maxCharacters (default `
        + `${DEBUG_LOG_BODY_DEFAULT_MAX_CHARACTERS}, maximum ${DEBUG_LOG_BODY_MAX_CHARACTERS}) and by the server's `
        + 'response budget, whichever is smaller. totalBytes and returnedBytes say how much of the log the answer '
        + 'covers, and truncated says when the end of the log — where an exception is written — may have been cut. '
        + 'When it is cut, the hint points at re-opening a trace at a lighter log level, because a smaller log is '
        + 'the only way to read the whole of a large one. '
        + 'A log that Salesforce has already purged produces a structured error, not an empty answer: Apex log '
        + 'retention is short and platform-managed, so an expired log has to be re-created by reopening a trace and '
        + 'reproducing the problem. '
        + 'This Tool runs on the server-owned DIAGNOSTIC identity rather than on your own Salesforce user, because '
        + 'the execution log is a platform surface business identities are not granted. It reads log text and never '
        + 'a business record. '
        + 'Read-only: it reads one log body and never modifies anything.',
      inputSchema: debugLogBodyInputSchema.shape,
      outputSchema: debugLogBodyOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: DebugLogBodyInput): Promise<CallToolResult> {
    try {
      const parsed = debugLogBodyInputSchema.parse(input);
      const output = await this.executor.execute(parsed);
      return {
        content: [{ type: 'text', text: renderDebugLogBodyText(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return contextExecutionErrorToolResult(error, 'MCP_DEBUG_LOG_BODY_READ_FAILED');
    }
  }
}

/** The text an Agent reads: the located failure first, then the log text, then the next step. */
export function renderDebugLogBodyText(output: DebugLogBodyOutput): string {
  const lines = [
    `get_debug_log_body: logId=${format(output.logId)} totalBytes=${format(output.totalBytes)} `
      + `returnedBytes=${format(output.returnedBytes)} truncated=${format(output.truncated)} `
      + `maxCharacters=${format(output.maxCharacters)}`,
  ];
  if (typeof output.suggestion === 'string' && output.suggestion.length > 0) {
    lines.push(`Suggestion: ${output.suggestion}`);
  }
  const summary = output.headerSummary;
  if (summary !== undefined) {
    lines.push(
      `Header: parseStatus=${summary.parseStatus} logApiVersion=${format(summary.logApiVersion)} `
        + `validated=${String(summary.validated)} executionFinished=${String(summary.executionFinished)} `
        + `userDebugLines=${summary.userDebugLineCount}`,
    );
    if (summary.categories.length > 0) {
      lines.push(`Captured categories: ${summary.categories.map((category) => `${category.token},${category.level}`).join(' ')}`);
    }
    if (!summary.validated) {
      lines.push(
        `Note: this parser has no measurement for log version ${format(summary.logApiVersion)}; the summary below `
          + 'is a parse of an unmeasured format and should be checked against the raw text.',
      );
    }
    if (summary.exceptionType !== null || summary.fatalError !== null) {
      lines.push(
        `Failure: ${format(summary.exceptionType)} at ${format(summary.apexClass)} line ${format(summary.lineNumber)} `
          + `column ${format(summary.columnNumber)} — ${format(summary.exceptionMessage)}`,
      );
      for (const frame of summary.stackSummary) {
        lines.push(`  ${frame.raw}`);
      }
    } else if (summary.parseStatus === 'PARSED') {
      lines.push('Failure: none — the log records no exception.');
    }
  }
  if (typeof output.body === 'string' && output.body.length > 0) {
    lines.push('Log body:', output.body);
  }
  if (typeof output.hint === 'string' && output.hint.length > 0) {
    lines.push(`Next: ${output.hint}`);
  }
  return lines.join('\n');
}

function format(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  return String(value);
}

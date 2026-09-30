import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { ApexLogReader } from '../contracts.js';
import {
  APEX_LOG_DEFAULT_LIMIT,
  APEX_LOG_DEFAULT_TIME_WINDOW_MINUTES,
  APEX_LOG_MAX_LIMIT,
  APEX_LOG_MAX_TIME_WINDOW_MINUTES,
  apexLogsInputSchema,
  apexLogsOutputSchema,
  type ApexLogsInput,
  type ApexLogsOutput,
} from '../schemas.js';
import { contextExecutionErrorToolResult } from '../tool-results.js';

type InputShape = typeof apexLogsInputSchema.shape;
type OutputShape = typeof apexLogsOutputSchema.shape;

/**
 * Lists the Apex debug logs this org still retains, most recent first.
 *
 * The Tool is a list and nothing else. The log text is not a SOQL field — the T1 probe measured
 * `bodySelectableThroughSoql: false`, so the body is a separate HTTP call and a separate Tool
 * (`get_debug_log_body`). Keeping them apart is not a style choice: one is a bounded row list and the
 * other is a bounded block of text, and a single Tool returning both would have to apply one budget to
 * two different shapes of answer.
 *
 * **Two measured traps are designed around rather than documented at.**
 *
 * `ApexLog.Status` is translated on this org — 9 retained rows, of which the English literal `'Success'`
 * matched 1 and the localized literal matched 8. A `status` filter therefore cannot be a closed enum of
 * English values, and this Tool does not push a literal into SOQL at all: it fetches the window's most
 * recent rows, matches in memory, and reports the `Status` values it actually saw. A filter that matches
 * nothing is then visibly a vocabulary mismatch rather than a quiet org.
 *
 * An empty list is the most mis-read answer a diagnostic Tool can give, so it is never returned
 * bare — the hint says what "no logs" means (nothing was logged while the problem happened, because no
 * trace was open or retention already expired it) and, when the caller filtered by another user, a
 * caveat names `A-1`: whether the diagnostic identity can read other users' logs was never established,
 * so a cross-user empty list may be a permission boundary rather than a fact.
 */
export class GetApexLogsMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: ApexLogReader) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'get_apex_logs';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'List Apex Debug Logs',
      description:
        'Lists this org\'s retained Apex debug logs, newest first, with the user whose transaction was logged, the '
        + 'operation, the status, the duration and the size of each. Use it after reproducing a problem with a trace '
        + 'open, to find the log for that execution and take its id to get_debug_log_body. '
        + `timeWindowMinutes looks back from now and defaults to ${APEX_LOG_DEFAULT_TIME_WINDOW_MINUTES} `
        + `(maximum ${APEX_LOG_MAX_TIME_WINDOW_MINUTES}). limit bounds how many of the most recent logs are returned `
        + `and defaults to ${APEX_LOG_DEFAULT_LIMIT} (maximum ${APEX_LOG_MAX_LIMIT}); totalCount reports how many `
        + 'exist in the window, so a truncated list is never mistaken for the whole window. '
        + 'userId narrows to one user\'s logs. status narrows to rows whose Status matches the given value exactly '
        + '— and it is matched against the value this org stores, which may be localized, so the answer reports the '
        + 'values actually present in observedStatuses. The status filter narrows the rows this call already '
        + 'fetched; it never widens the fetch, and scannedCount says how far it reached. '
        + 'An empty result means nothing was logged in the window, which is NOT the same as the target being '
        + 'healthy: a trace must be open on the target while the problem is reproduced, and Apex log retention is '
        + 'short, so a log for the incident may already be gone. The hint says so explicitly, and a cross-user '
        + 'query that returns nothing also carries a caveat, because whether this deployment\'s diagnostic identity '
        + 'may read other users\' logs is a deployment prerequisite rather than an established fact. '
        + 'This Tool runs on the server-owned DIAGNOSTIC identity rather than on your own Salesforce user, because '
        + 'the execution log is a platform surface business identities are not granted. It reads the log listing '
        + 'only, never the log text and never a business record. '
        + 'Read-only: it lists log rows and never modifies anything.',
      inputSchema: apexLogsInputSchema.shape,
      outputSchema: apexLogsOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: ApexLogsInput): Promise<CallToolResult> {
    try {
      const parsed = apexLogsInputSchema.parse(input);
      const output = await this.executor.execute(parsed);
      return {
        content: [{ type: 'text', text: renderApexLogsText(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return contextExecutionErrorToolResult(error, 'MCP_APEX_LOG_READ_FAILED');
    }
  }
}

/** The text an Agent reads: the counts, one line per log, then the next step. */
export function renderApexLogsText(output: ApexLogsOutput): string {
  const lines = [
    `get_apex_logs: totalCount=${format(output.totalCount)} returnedCount=${format(output.returnedCount)} `
      + `scannedCount=${format(output.scannedCount)} truncated=${format(output.truncated)} `
      + `window=${format(output.timeWindowMinutes)}m since ${format(output.windowStartedAt)}`,
  ];
  if (typeof output.statusFilter === 'string') {
    lines.push(`Filtered on Status = '${output.statusFilter}'`);
  }
  if (typeof output.caveat === 'string' && output.caveat.length > 0) {
    lines.push(`Caveat: ${output.caveat}`);
  }
  const logs = output.logs ?? [];
  if (logs.length === 0) {
    lines.push('No log returned.');
  } else {
    lines.push('Logs:');
    for (const log of logs) {
      lines.push(
        `  ${log.id} ${format(log.lastModifiedDate)} user=${log.logUserName ?? log.logUserUsername ?? log.logUserId ?? 'unknown'} `
          + `operation=${format(log.operation)} application=${format(log.application)} status=${format(log.status)} `
          + `durationMs=${format(log.durationMilliseconds)} bytes=${format(log.logLength)}`,
      );
    }
  }
  const observed = output.observedStatuses ?? [];
  if (observed.length > 0) {
    // Printed because it is the whole reason a filtered list can come back empty without anything
    // being wrong: this is what the org actually stores, and an English literal may not be in it.
    lines.push(`Status values present in the scanned rows: ${observed.map((entry) => `'${entry.status}' (${entry.count})`).join(', ')}`);
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

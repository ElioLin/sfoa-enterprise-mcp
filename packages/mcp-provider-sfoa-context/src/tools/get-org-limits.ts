import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { OrgLimitsReader } from '../contracts.js';
import {
  ORG_LIMIT_HIGHLIGHT_ALIASES,
  ORG_LIMIT_HIGHLIGHT_SLOTS,
  orgLimitsInputSchema,
  orgLimitsOutputSchema,
  type OrgLimitsInput,
  type OrgLimitsOutput,
} from '../schemas.js';
import { contextExecutionErrorToolResult } from '../tool-results.js';

type InputShape = typeof orgLimitsInputSchema.shape;
type OutputShape = typeof orgLimitsOutputSchema.shape;

/**
 * Reports the org's governor limits to an Agent sizing a large data job.
 *
 * The Tool is DIAGNOSTIC: reading the limits resource is an org-configuration read that business
 * integration identities are not granted, and the fixed server-owned DIAGNOSTIC identity is what the
 * deployment provides for exactly that class of read. The role is declared in
 * `SFOA_CONTEXT_TOOL_ROLES`, which is what routes the call and what makes the server refuse to
 * enable this Tool without an enabled diagnostic identity.
 */
export class GetOrgLimitsMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: OrgLimitsReader) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'get_org_limits';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Read Salesforce Org Limits',
      description:
        'Reads this org\'s governor limits and reports the allowances a large data job spends: daily API '
        + 'requests, daily bulk API requests, daily async Apex executions, data storage and file storage. '
        + 'Call this before a bulk or otherwise large query to see what the org has left, and after an API-limit '
        + 'failure to tell an exhausted allowance apart from a wrong query. '
        + 'The five highlights — DailyApiRequests, DailyBulkApiRequests (or the org\'s equivalent key, named in the '
        + 'slot\'s key field), DailyAsyncApexExecutions, DataStorageMB and FileStorageMB — are always reported. A '
        + 'slot this org does not meter says present=false with a null key: it is never omitted and never zeroed, '
        + 'because "not metered" and "nothing left" are different answers. '
        + 'structuredContent.limits carries every limit the org returned, under the org\'s own key, each with max, '
        + 'remaining, used and measured. used is computed only when both ends are known and consistent, so an entry '
        + 'that reports only a maximum (concurrency limits do) keeps remaining and used null rather than reading as '
        + 'zero; measured says whether the org reported a number at all. verbose changes the text answer only and '
        + 'never the structured table. '
        + 'Nothing is inferred here. If the org refuses the limits resource, or reports no readable number, the call '
        + 'fails with a structured error rather than returning an empty table — an empty table would read as "this '
        + 'org has no limits". '
        + 'This Tool runs on the server-owned DIAGNOSTIC identity rather than on your own Salesforce user, because '
        + 'the limits resource is an org configuration read that business identities are not granted; it therefore '
        + 'reports the whole org\'s quota state and never any business record. '
        + 'Read-only: it reads quota counters and never modifies data.',
      inputSchema: orgLimitsInputSchema.shape,
      outputSchema: orgLimitsOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: OrgLimitsInput): Promise<CallToolResult> {
    try {
      const parsed = orgLimitsInputSchema.parse(input);
      const output = await this.executor.execute(parsed);
      return {
        content: [{ type: 'text', text: renderOrgLimitsText(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return contextExecutionErrorToolResult(error, 'MCP_LIMITS_READ_FAILED');
    }
  }
}

/** The text the Agent reads: the counts, the five slots, the optional full table, then the same facts as structuredContent. */
export function renderOrgLimitsText(output: OrgLimitsOutput): string {
  const lines = [
    `get_org_limits: totalLimits=${format(output.totalLimits)} returnedLimits=${format(output.returnedLimits)} `
      + `unreadableLimits=${format(output.unreadableLimits)} truncated=${format(output.truncated)} verbose=${format(output.verbose)}`,
  ];
  if (typeof output.hint === 'string' && output.hint.length > 0) {
    lines.push(`Next: ${output.hint}`);
  }
  lines.push('Highlights:');
  const highlights = output.highlights;
  for (const slot of ORG_LIMIT_HIGHLIGHT_SLOTS) {
    // The documented org key titles the line, and `key` reports which name actually filled the slot:
    // for the bulk allowance the two differ between Bulk API 1.0 and 2.0, and which one it was is
    // exactly what a caller comparing against Setup needs to know.
    const documented = ORG_LIMIT_HIGHLIGHT_ALIASES[slot][0];
    const highlight = highlights?.[slot];
    lines.push(highlight === undefined
      ? `  ${documented}: absent from this response`
      : highlight.present
        ? `  ${documented}: max=${format(highlight.max)} remaining=${format(highlight.remaining)} used=${format(highlight.used)} (key=${format(highlight.key)})`
        : `  ${documented}: not reported by this org (present=false, key=null)`);
  }
  if (output.verbose === true) {
    const limits = Object.entries(output.limits ?? {});
    lines.push(`Limits (${limits.length} entries):`);
    let used = lines.join('\n').length + 1;
    let printed = 0;
    for (const [key, entry] of limits) {
      const line = `  ${key}: ${JSON.stringify(entry)}`;
      // The structured table is the source of truth and is already byte-bounded; this guard only
      // keeps the text from being the larger of the two, and says so when it bites.
      if (used + line.length + 1 > MAX_TEXT_CHARACTERS) break;
      lines.push(line);
      used += line.length + 1;
      printed += 1;
    }
    if (printed < limits.length) {
      lines.push(`  ... ${limits.length - printed} further limit(s) are in structuredContent.limits.`);
    }
  }
  return lines.join('\n');
}

const MAX_TEXT_CHARACTERS = 60_000;

function format(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  return String(value);
}

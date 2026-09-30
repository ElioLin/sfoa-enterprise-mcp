import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { TraceFlagWriter } from '../contracts.js';
import { DEBUG_LEVEL_FIELDS, DEBUG_LEVEL_TIER_NAMES } from '../debug-levels.js';
import {
  TRACE_FLAG_DEFAULT_DURATION_MINUTES,
  TRACE_FLAG_MAX_DURATION_MINUTES,
  traceFlagInputSchema,
  traceFlagOutputSchema,
  type TraceFlagInput,
  type TraceFlagOutput,
} from '../schemas.js';
import { contextExecutionErrorToolResult } from '../tool-results.js';

type InputShape = typeof traceFlagInputSchema.shape;
type OutputShape = typeof traceFlagOutputSchema.shape;

/**
 * Opens a bounded Apex trace on one user or one class, on the server-owned DIAGNOSTIC identity.
 *
 * This is **the only Tool in this provider that writes**, so its governance is stated rather than
 * implied. ADR-0029 §4a confines the write path structurally: the only objects this Tool can create or
 * update are `TraceFlag` and `DebugLevel`, both reached through the Tooling API, which the same ADR
 * measured as refusing business objects outright. There is no code path from here to a record.
 *
 * Three measured facts shape the behaviour, and each would be a defect if it were assumed away:
 *
 * - **It cannot be create-only.** Creating a flag for an entity that already has an active one is
 *   refused with `FIELD_INTEGRITY_EXCEPTION` (`docs/sfoa/P10_T0_LIVE_PROBE_FINDINGS.md` §2), so the
 *   Tool's most ordinary call — trace this user for the next hour — would fail the second time. It
 *   therefore looks for an active flag first and extends that row.
 * - **It never shortens an active trace.** `ExpirationDate` becomes the later of the flag's current
 *   expiry and now + duration, so asking for a shorter window cannot cut an investigation short.
 * - **It verifies its own write.** The probe's cleanup once reported success on a row that survived, so
 *   the stored expiration is read back and reported as it is, with `verified` saying whether the re-read
 *   agreed.
 *
 * The `DebugLevel` is resolved-or-created under a fixed `SFOA_P10_` prefix, because this org's only
 * stored level samples profiling at `INFO` and could not serve the `PROFILING` tier.
 */
export class SetTraceFlagMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: TraceFlagWriter) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'set_trace_flag';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Open an Apex Trace Flag',
      description:
        'Opens a time-bounded Apex debug trace on one target, so that the next execution of that code writes a '
        + 'debug log you can then list and read. Two kinds of target exist: a USER and an APEX_CLASS, and they are '
        + `not interchangeable — tracing a user records that user's whole session, tracing a class records every `
        + 'execution of that class regardless of who ran it. The default window is '
        + `${TRACE_FLAG_DEFAULT_DURATION_MINUTES} minutes and the hard cap is ${TRACE_FLAG_MAX_DURATION_MINUTES}; `
        + 'a flag already active on the target is extended rather than duplicated, and is never shortened, so an '
        + 'in-flight investigation cannot be cut short by a later call. '
        + `logLevel picks one of the prebuilt DebugLevel tiers (${DEBUG_LEVEL_TIER_NAMES.join(', ')}). DEBUG is the `
        + 'default and answers "what did this request do" without profiling counters. MINIMAL writes the smallest '
        + 'log, which is the tier to use when a full log would be too large to read back — the log body Tool is '
        + 'bounded, and its truncation hint points here. PROFILING adds full Apex profiling counters, which this '
        + 'org\'s only stored level samples at INFO rather than capturing in full. The tier is resolved or created '
        + 'under a fixed SFOA_P10_ developer-name prefix, and structuredContent.debugLevelCreated says which '
        + 'happened, so no hand-built level is ever adopted or overwritten. '
        + 'This Tool WRITES: it creates or updates a TraceFlag and may create a DebugLevel. Those are the only '
        + 'objects it can touch, they are reached through the Tooling API, and no business record is readable or '
        + 'writable through it. It never deletes a flag — Salesforce expires them on the window given. '
        + 'It runs on the server-owned DIAGNOSTIC identity rather than on your own Salesforce user, whichever '
        + 'platform user calls it, because trace administration is Setup-layer configuration that business '
        + 'identities are not granted. '
        + 'After calling this, reproduce the problem, then list the logs and read the one that failed.',
      inputSchema: traceFlagInputSchema.shape,
      outputSchema: traceFlagOutputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // Not idempotent: a second call moves the expiration forward, because the window is always
        // measured from now and an active trace is never shortened.
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: TraceFlagInput): Promise<CallToolResult> {
    try {
      const parsed = traceFlagInputSchema.parse(input);
      const output = await this.executor.execute(parsed);
      return {
        content: [{ type: 'text', text: renderTraceFlagText(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return contextExecutionErrorToolResult(error, 'MCP_TRACE_FLAG_WRITE_FAILED');
    }
  }
}

/** The text an Agent reads: the flag, the level, whether it replaced anything, then the next step. */
export function renderTraceFlagText(output: TraceFlagOutput): string {
  const lines = [
    `set_trace_flag: success=${String(output.success)} traceFlagId=${format(output.traceFlagId)} `
      + `logType=${format(output.logType)} expires=${format(output.expirationDate)} `
      + `replacedExisting=${format(output.replacedExisting)} debugLevelCreated=${format(output.debugLevelCreated)} `
      + `verified=${format(output.verified)}`,
  ];
  if (typeof output.errorCode === 'string' && output.errorCode.length > 0) {
    lines.push(`errorCode=${output.errorCode} message=${output.message ?? ''}`);
  }
  if (typeof output.suggestion === 'string' && output.suggestion.length > 0) {
    lines.push(`Suggestion: ${output.suggestion}`);
  }
  lines.push(
    `Tracing ${format(output.tracedEntityKind)} ${format(output.tracedEntityId)} with DebugLevel `
      + `${format(output.debugLevelDeveloperName)} (tier ${format(output.debugLevelTier)})`,
  );
  if (output.previousExpirationDate !== undefined && output.previousExpirationDate !== null) {
    lines.push(`Previous expiration: ${output.previousExpirationDate}`);
  }
  const levels = output.debugLevelLevels;
  if (levels !== undefined) {
    // Printed field by field rather than as JSON, because the one question this answers is "did the
    // category I care about actually get set", and that is faster to read as a column.
    lines.push('DebugLevel levels:');
    for (const field of DEBUG_LEVEL_FIELDS) lines.push(`  ${field}: ${levels[field]}`);
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

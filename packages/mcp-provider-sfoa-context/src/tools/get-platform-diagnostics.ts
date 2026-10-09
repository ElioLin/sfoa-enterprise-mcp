import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { PlatformDiagnosticsReader } from '../contracts.js';
import {
  PLATFORM_DIAGNOSTICS_DEFAULT_LIMIT_PER_SECTION,
  PLATFORM_DIAGNOSTICS_DEFAULT_WINDOW_HOURS,
  PLATFORM_DIAGNOSTICS_MAX_LIMIT_PER_SECTION,
  PLATFORM_DIAGNOSTICS_MAX_TEXT_CHARACTERS,
  PLATFORM_DIAGNOSTICS_MAX_WINDOW_HOURS,
  platformDiagnosticsInputSchema,
  platformDiagnosticsOutputSchema,
  type PlatformDiagnosticsInput,
  type PlatformDiagnosticsOutput,
} from '../schemas.js';
import { contextExecutionErrorToolResult } from '../tool-results.js';

type InputShape = typeof platformDiagnosticsInputSchema.shape;
type OutputShape = typeof platformDiagnosticsOutputSchema.shape;

/**
 * Aggregates the platform's own change, failure and schedule evidence into one timeline.
 *
 * This is the Tool the P10 diagnostic workflow exists for. `get_apex_logs` answers "what did the code
 * do", `explain_field_access` answers "who may touch what" — this one answers **"what changed, and when,
 * relative to when it broke"**, which is the question an incident actually starts with. It reads three
 * sources in one call and merges them into a single time-ordered list, so an Agent does not have to make
 * three calls and reconcile three clocks itself.
 *
 * **Per-section state, never one global one.** ADR-0029 §3: an aggregating Tool reports each source's own
 * state — `READ` with a count, or `UNAVAILABLE` with the prerequisite that is missing. A source that could
 * not be read never appears as an empty list, and a genuinely empty source (`CronTrigger` on the reference
 * org holds zero rows — a measured fact) is `READ` with `totalCount: 0`. The two readings are different,
 * and a timeline is exactly the shape where confusing them would be invisible: a missing section just
 * contributes no lines.
 *
 * **The stall flag is a hedge.** `SCHEDULED_JOBS` carries `SUSPECTED` / `NOT_SUSPECTED` / `INDETERMINATE`
 * per job, under ADR-0033's conservative rule, and `SUSPECTED` means "the platform's own fields say this
 * schedule has not fired although its next fire time has passed" — a flag to investigate, never a
 * diagnosis. An unrecognized `State` literal is `INDETERMINATE` rather than healthy, because the
 * vocabulary could not be measured on the reference org.
 *
 * **The window is honest about its own edges.** The window ends at the call; the audit trail is bounded
 * below by what the org still retains (Salesforce exposes no retention policy to SOQL — the section
 * reports the oldest retained row it could read), and `ASYNC_FAILURES` is bounded below by the window.
 * Scheduled jobs are *current state*, not history, which is why the output says so rather than pretending
 * a snapshot is a timeline.
 */
export class GetPlatformDiagnosticsMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: PlatformDiagnosticsReader) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'get_platform_diagnostics';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Get Platform Diagnostics',
      description:
        'Aggregates the platform\'s own recent evidence — setup changes, failed asynchronous jobs and scheduled jobs — '
        + 'into one time-ordered timeline, so "what changed just before this broke" can be answered from one call. '
        + 'Use it at the start of an incident: it is the tool that places a change next to a failure on the same clock. '
        + `windowHours (default ${PLATFORM_DIAGNOSTICS_DEFAULT_WINDOW_HOURS}, 1 to ${PLATFORM_DIAGNOSTICS_MAX_WINDOW_HOURS}) is how far back the change `
        + 'and failure sections are read; the window ends at the moment of the call. '
        + `sections selects which of SETUP_CHANGES, ASYNC_FAILURES and SCHEDULED_JOBS to read (default all three); `
        + `limitPerSection (default ${PLATFORM_DIAGNOSTICS_DEFAULT_LIMIT_PER_SECTION}, maximum ${PLATFORM_DIAGNOSTICS_MAX_LIMIT_PER_SECTION}) caps each section. `
        + 'structuredContent.sections carries one entry per requested section, and each one declares its own status: READ '
        + 'with the entries and the true total count, or UNAVAILABLE with the deployment prerequisite that is missing and '
        + 'why. A section that could not be read is never reported as an empty one — a source with genuinely no rows is '
        + 'READ with a count of zero — so an unavailable section must be resolved and the call repeated, not read as "no '
        + 'anomalies". '
        + 'structuredContent.alignment.timeline is the merged list, oldest first; each entry repeats its section name so a '
        + 'mixed line stays readable, and the note says what the merge does and does not establish. '
        + 'SCHEDULED_JOBS carry a conservative stallAssessment per job: SUSPECTED means the platform reports a waiting '
        + 'state although the next fire time has passed, NOT_SUSPECTED means the job is running or gone, and INDETERMINATE '
        + 'means the rule could not be applied (an unrecognized state, or an unreadable next fire time). SUSPECTED is a '
        + 'flag to investigate and never a statement about why a job did not fire. '
        + 'It runs on the server-owned DIAGNOSTIC identity rather than on your own Salesforce user, because platform status '
        + 'objects are not granted to business identities, and it reads only those objects — never a business record. '
        + 'Read-only: it reads platform status and never modifies anything.',
      inputSchema: platformDiagnosticsInputSchema.shape,
      outputSchema: platformDiagnosticsOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: PlatformDiagnosticsInput): Promise<CallToolResult> {
    try {
      const parsed = platformDiagnosticsInputSchema.parse(input);
      const output = await this.executor.execute(parsed);
      return {
        content: [{ type: 'text', text: renderPlatformDiagnosticsText(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return contextExecutionErrorToolResult(error, 'MCP_PLATFORM_DIAGNOSTICS_READ_FAILED');
    }
  }
}

/**
 * The text an Agent reads: the state of every section first, then the timeline, then the next step, then
 * the per-entry detail.
 *
 * **The order is the budget strategy.** The text is bounded in characters
 * (`PLATFORM_DIAGNOSTICS_MAX_TEXT_CHARACTERS`), and what gets dropped to stay inside that bound is
 * decided by position: the per-section state header and the timeline are the answer, the per-entry detail
 * below them is a re-listing of the same entries `structuredContent` carries in full. So the detail goes
 * first, then the earliest timeline entries, and the header, the note and the hint are never dropped at
 * all. An Agent reading a shortened answer still learns which sections were read and what is on the
 * timeline; it loses only detail it can re-read structurally.
 *
 * Every section state is printed with a word, not a flag: `UNAVAILABLE` rendered as a count would be the
 * one rendering mistake that undoes the whole degradation contract.
 */
export function renderPlatformDiagnosticsText(output: PlatformDiagnosticsOutput): string {
  const sections = output.sections;
  const requested: SectionValue[] = sections === undefined
    ? []
    : SECTION_KEYS.flatMap((key) => {
        const value = sections[key];
        return value === undefined ? [] : [value];
      });

  const header = [
    `get_platform_diagnostics: window=${format(output.window?.from)} -> ${format(output.window?.to)} `
      + `(${format(output.window?.hours)}h) sections=${requested.length} read=${format(output.readSectionCount)} `
      + `unavailable=${format(output.unavailableSectionCount)} truncated=${format(output.truncated)}`,
    ...requested.map((value) => `  ${value.section}: ${describeSectionState(value)}`),
  ];
  const alignment = output.alignment;
  const timelineHeader = alignment === undefined
    ? []
    : [`Timeline (${alignment.timeline.length} entries, oldest first):`];
  const timelineEntries = alignment === undefined
    ? []
    : alignment.timeline.map((entry) => `  ${entry.occurredAt} [${entry.section}] ${entry.summary}`);
  const tail = [
    ...(alignment === undefined ? [] : [`Note: ${alignment.note}`]),
    ...(typeof output.hint === 'string' && output.hint.length > 0 ? [`Next: ${output.hint}`] : []),
  ];
  const detail = requested
    .filter((value) => value.status === 'READ')
    .flatMap((value) => renderSectionDetail(value));
  return fitTextBudget(header, timelineHeader, timelineEntries, tail, detail);
}

/**
 * Assembles the five blocks inside the character budget, dropping from the least load-bearing end.
 *
 * The fallbacks are ordered and each one says what it did: per-entry detail omitted, then the earliest
 * timeline entries omitted (the most recent entries are the ones an incident is read for, so a cut takes
 * the oldest first), and only if even the header alone overflows does anything touch it — which the unit
 * suite pins as unreachable for any input this Tool can produce.
 */
function fitTextBudget(
  header: readonly string[],
  timelineHeader: readonly string[],
  timelineEntries: readonly string[],
  tail: readonly string[],
  detail: readonly string[],
): string {
  const size = (lines: readonly string[]): number => lines.reduce((total, line) => total + line.length + 1, 0);
  const compose = (blocks: readonly (readonly string[])[]): string[] => blocks.flatMap((block) => [...block]);

  const whole = compose([header, timelineHeader, timelineEntries, tail, detail]);
  if (size(whole) <= PLATFORM_DIAGNOSTICS_MAX_TEXT_CHARACTERS) return whole.join('\n');

  const withoutDetail = compose([header, timelineHeader, timelineEntries, tail, [
    '[per-entry detail omitted to fit the text budget; structuredContent carries every entry]',
  ]]);
  if (size(withoutDetail) <= PLATFORM_DIAGNOSTICS_MAX_TEXT_CHARACTERS) return withoutDetail.join('\n');

  const fixedSize = size(compose([header, timelineHeader, tail]));
  const kept: string[] = [];
  let keptSize = 0;
  for (const line of timelineEntries) {
    if (fixedSize + keptSize + line.length + 1 > PLATFORM_DIAGNOSTICS_MAX_TEXT_CHARACTERS) break;
    kept.push(line);
    keptSize += line.length + 1;
  }
  const omitted = timelineEntries.length - kept.length;
  return compose([
    header,
    timelineHeader,
    [
      ...(omitted <= 0 ? [] : [
        `  [${omitted} earliest timeline entr${omitted === 1 ? 'y' : 'ies'} omitted to fit the text budget; `
          + 'structuredContent carries the full timeline]',
      ]),
      ...kept,
    ],
    tail,
  ]).join('\n');
}

type SectionValue = NonNullable<NonNullable<PlatformDiagnosticsOutput['sections']>[keyof NonNullable<PlatformDiagnosticsOutput['sections']>]>;

/** The output's section order, fixed here so the text and the structured payload read the same way. */
const SECTION_KEYS = Object.freeze(['setupChanges', 'asyncFailures', 'scheduledJobs'] as const);

function describeSectionState(value: SectionValue): string {
  if (value.status !== 'READ') {
    return `UNAVAILABLE${value.prerequisite === undefined ? '' : ` (missing: ${value.prerequisite})`}`
      + `${value.unavailableReason === undefined ? '' : ` — ${value.unavailableReason}`}`;
  }
  const count = value.totalCount === null ? 'unknown total' : `${value.entries.length} of ${value.totalCount}`;
  const stalls = value.section === 'SCHEDULED_JOBS' && value.suspectedStallCount !== null && value.suspectedStallCount > 0
    ? `, ${value.suspectedStallCount} suspected stalled`
    : '';
  return `READ (${count} entries${value.truncated ? ', truncated' : ''}${stalls})`;
}

function renderSectionDetail(value: SectionValue): readonly string[] {
  const lines: string[] = [`[${value.section}]`];
  if (value.section === 'SETUP_CHANGES') {
    for (const entry of value.entries) {
      lines.push(
        `  ${entry.occurredAt} ${format(entry.action)} by ${format(entry.createdBy)}`
          + `${entry.display === null ? '' : `: ${entry.display}`}`
          + `${entry.section === null ? '' : ` (section=${entry.section})`}`,
      );
    }
    if (value.entries.length === 0) lines.push('  no setup change was retained in this window');
  } else if (value.section === 'ASYNC_FAILURES') {
    for (const entry of value.entries) {
      lines.push(
        `  ${entry.occurredAt} ${format(entry.status)} ${format(entry.jobType)} ${format(entry.apexClass)}`
          + ` errors=${format(entry.numberOfErrors)}`
          + `${entry.extendedStatus === null ? '' : `: ${entry.extendedStatus}`}`,
      );
    }
    if (value.entries.length === 0) {
      lines.push('  no failed or aborted asynchronous job in this window');
    }
  } else {
    for (const entry of value.entries) {
      lines.push(
        `  ${format(entry.name)} [${format(entry.jobType)}] state=${format(entry.state)} `
          + `next=${format(entry.nextFireTime)} previous=${format(entry.previousFireTime)} `
          + `runs=${format(entry.timesTriggered)} stall=${entry.stallAssessment}`,
      );
      for (const reason of entry.stallReasons) lines.push(`    - ${reason}`);
    }
    if (value.entries.length === 0) lines.push('  this org holds no scheduled job');
  }
  for (const caveat of value.caveats) lines.push(`  caveat: ${caveat}`);
  return lines;
}

function format(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  return String(value);
}

import type { Connection } from '@salesforce/core';
import { DATA_MAX_RESPONSE_BYTES, readSalesforceFailure } from '@sfoa/mcp-provider-sfoa-data';
import {
  ContextRuntimeError,
  PLATFORM_DIAGNOSTIC_SECTIONS,
  PLATFORM_DIAGNOSTICS_DEFAULT_LIMIT_PER_SECTION,
  PLATFORM_DIAGNOSTICS_DEFAULT_WINDOW_HOURS,
  assessScheduledJobStall,
  platformDiagnosticsHint,
  type AsyncFailureEntry,
  type PlatformDiagnosticSection,
  type PlatformDiagnosticsHintFacts,
  type PlatformDiagnosticsInput,
  type PlatformDiagnosticsOutput,
  type PlatformDiagnosticsReader,
  type PlatformDiagnosticsSectionFact,
  type ScheduledJobEntry,
  type SetupChangeEntry,
} from '@sfoa/mcp-provider-sfoa-context';
import type { RequestScope } from '@sfoa/identity-runtime';
import { assertDiagnosticScope } from './diagnostic-context-adapters.js';

/**
 * `get_platform_diagnostics`, host-side on the fixed DIAGNOSTIC identity.
 *
 * Host-side for the reason recorded on the `PlatformDiagnosticsReader` contract: three of its sources are
 * standard-API reads, and ADR-0029 §4a records that **nothing in the org stops the DIAGNOSTIC identity from
 * reading a business object through that API** (measured: the same identity read 955 `Lead` rows). The
 * whitelist below is therefore this Tool's entire guarantee on that surface, and it is only meaningful if
 * the code holding it also holds the `RequestScope` that proves which route the Connection was opened for.
 * The provider owns the Tool contract, the schemas, the stall rule and the hint; this file owns the
 * identity guard, the Connection, the query shapes, the degradation matrix and the response budget.
 *
 * ## The four disciplines this file is built around
 *
 * **One: the query surface is a constant whitelist, and every shape in it was measured.** Every `FROM`
 * target is drawn from `PLATFORM_DIAGNOSTICS_STANDARD_OBJECTS`, and a unit test asserts that by scanning
 * this module's own compiled source. The field lists, the filters this Tool pushes into SOQL and the
 * aggregate form it counts with are all shapes the P10 probe measured on a live org — never shapes read
 * from documentation. The T5 probe measured the last of them, `AsyncApexJob.CreatedDate`, so the failure
 * section is narrowed in the query like the other two; when a shape goes unmeasured the code does without
 * it rather than guessing, which is what the failure section did while that filter was unknown.
 *
 * **Two: a section that could not be read is `UNAVAILABLE`, and it never becomes an empty list.**
 * ADR-0029 §3's aggregator clause. Each of the three reads is wrapped on its own, so one source's refusal
 * leaves the other two answering — and `success: true` on this Tool means "the aggregation ran and every
 * requested section declared its state", never "every source was read". A section that could not be read
 * carries `totalCount: null` rather than 0, because 0 is a claim about the org this Tool has not earned.
 *
 * **Three: the window is enforced where it can be enforced exactly.** `SetupAuditTrail` and `AsyncApexJob`
 * are both narrowed in SOQL on a measured-filterable date field, so no row older than the window can come
 * back, and both report the window's true row count from an aggregate read rather than from the rows they
 * happened to carry. A row *newer* than the window's upper edge is kept and the clock difference is
 * reported, because the two edges are stamped by two different clocks and the newest change is the one an
 * incident is read for.
 *
 * **Four: this Tool never decides that something is wrong.** It reports the platform's own fields, merges
 * them onto one clock, and hedges the one judgement it makes — the stall flag, under ADR-0033's rule, which
 * is `SUSPECTED` / `NOT_SUSPECTED` / `INDETERMINATE` and is computed by the provider's pure module.
 */

/** The advertised Tool names of this session, which a hint may name and nothing else may. */
type AdvertisedTools = readonly string[];

/**
 * Every object any query in this module may name — ADR-0029 §4a's per-Tool whitelist for T5.
 *
 * All three are platform-status surfaces rather than business data: who changed the org's configuration,
 * which asynchronous Apex job failed, and what the scheduler holds. ADR-0029 §4a's T5 row also listed
 * `ApexLog` for this Tool; the narrowing to three is recorded in ADR-0033 — the log surface belongs to
 * `get_apex_logs`, which reads it better-scoped than a merged timeline could, and sharing this Tool's
 * budget with log bodies would spend it on rows an Agent can already fetch deliberately.
 */
export const PLATFORM_DIAGNOSTICS_STANDARD_OBJECTS = Object.freeze([
  'SetupAuditTrail',
  'AsyncApexJob',
  'CronTrigger',
] as const);

/**
 * The measured field list of each source.
 *
 * A query naming a field this org's API version does not carry fails with `INVALID_FIELD` and takes the
 * whole section down, so these are exactly the lists the probe sent. `CreatedBy.Name`, `ApexClass.Name`
 * and `CronJobDetail.Name` are traversals the probe measured present on this org.
 */
const SETUP_AUDIT_TRAIL_FIELDS = 'Id, Action, CreatedBy.Name, CreatedDate, Section, Display, DelegateUser';
const ASYNC_APEX_JOB_FIELDS = 'Id, Status, JobType, ApexClass.Name, NumberOfErrors, ExtendedStatus, CreatedDate';
const CRON_TRIGGER_FIELDS = 'Id, CronJobDetail.Name, CronJobDetail.JobType, State, NextFireTime, PreviousFireTime, TimesTriggered';

/**
 * The two status literals the failure section filters on.
 *
 * `Failed` and `Aborted` are stable API enum values on `AsyncApexJob.Status` — unlike `ApexLog.Status`,
 * which this org translates (probe §1) and which is therefore never filtered on. The probe measured this
 * exact `WHERE Status IN (…)` shape returning rows, and the section reports the status vocabulary it read
 * beside the entries, so a filter that matched nothing is distinguishable from a table that is empty.
 */
const ASYNC_FAILURE_STATUSES = Object.freeze(['Failed', 'Aborted'] as const);

/**
 * How many failed rows the failure section reads, newest first.
 *
 * The window is pushed into the query and the total comes from a count, so this bound is a page size rather
 * than the thing that establishes the window: it is four times the largest per-section limit the input allows
 * (100), which leaves the budget ladder room to shrink a section without re-reading the org, and the case
 * where the window holds more than this is reported through the count rather than hidden.
 */
const ASYNC_FAILURE_SCAN_LIMIT = 200;

/**
 * How many scheduled jobs are read.
 *
 * `CronTrigger` holds one row per scheduled job in the org, so this is a bound on a table that is small by
 * nature rather than a sample of a growing one. The probe measured the reference org holding zero rows.
 */
const CRON_TRIGGER_SCAN_LIMIT = 200;

/**
 * How long one free-text field may be before the field-level budget step clips it.
 *
 * `SetupAuditTrail.Display` and `AsyncApexJob.ExtendedStatus` are the two schema fields with no length
 * bound of their own, and `ExtendedStatus` in particular can carry a whole stack description. The cap is
 * generous enough that an ordinary value is untouched and only a pathological one is clipped — and the
 * clip is reported in the section's caveats, so a reader is never shown a shortened value as a whole one.
 */
const PLATFORM_DIAGNOSTICS_MAX_FIELD_CHARACTERS = 500;

/** How long one merged-timeline summary may be. The timeline is a reading list, not the evidence itself. */
const PLATFORM_DIAGNOSTICS_MAX_SUMMARY_CHARACTERS = 300;

export class ScopedPlatformDiagnosticsReader implements PlatformDiagnosticsReader {
  public constructor(
    private readonly scope: RequestScope,
    private readonly advertisedToolNames: AdvertisedTools,
  ) {}

  public async execute(input: PlatformDiagnosticsInput): Promise<PlatformDiagnosticsOutput> {
    // The facade decides what the request may do; this decides which identity a Connection may be opened
    // for. Neither is redundant — this is the last point before Salesforce, and on this Tool it is also the
    // only point that makes the query whitelist meaningful, because the org enforces nothing on it.
    assertDiagnosticScope(this.scope, 'get_platform_diagnostics');
    const windowHours = input.windowHours ?? PLATFORM_DIAGNOSTICS_DEFAULT_WINDOW_HOURS;
    const limitPerSection = input.limitPerSection ?? PLATFORM_DIAGNOSTICS_DEFAULT_LIMIT_PER_SECTION;
    const requested: readonly PlatformDiagnosticSection[] = input.sections ?? [...PLATFORM_DIAGNOSTIC_SECTIONS];
    const now = new Date();
    const window = Object.freeze({
      from: new Date(now.getTime() - windowHours * 3_600_000).toISOString(),
      to: now.toISOString(),
      hours: windowHours,
    });
    try {
      const connection = await this.scope.getConnection();
      // Each read is wrapped on its own, so a source that refuses degrades that source and nothing else.
      const setupChanges = requested.includes('SETUP_CHANGES')
        ? await readSection('the setup audit trail', 'SetupAuditTrail', () => readSetupChanges(connection, window.from, limitPerSection))
        : null;
      const asyncFailures = requested.includes('ASYNC_FAILURES')
        ? await readSection('the failed asynchronous jobs', 'AsyncApexJob', () => readAsyncFailures(connection, window.from, limitPerSection))
        : null;
      const scheduledJobs = requested.includes('SCHEDULED_JOBS')
        ? await readSection('the scheduled jobs', 'CronTrigger', () => readScheduledJobs(connection, now.getTime(), limitPerSection))
        : null;

      const build = (caps: SectionCaps, clipFields: boolean): PlatformDiagnosticsOutput => compose({
        window,
        caps,
        clipFields,
        setupChanges,
        asyncFailures,
        scheduledJobs,
        advertised: new Set(this.advertisedToolNames),
        requested,
      });
      // The budget ladder, in the order the contract fixes: entries first, then fields if the smallest
      // entry cap still does not fit. Both loops walk the ladder largest-first, so the answer keeps as much
      // as each step allows.
      const ladder = capLadder({
        setupChanges: availableEntries(setupChanges),
        asyncFailures: availableEntries(asyncFailures),
        scheduledJobs: availableEntries(scheduledJobs),
      });
      for (const clipFields of [false, true]) {
        for (const caps of ladder) {
          const output = build(caps, clipFields);
          if (Buffer.byteLength(JSON.stringify(output), 'utf8') <= DATA_MAX_RESPONSE_BYTES) return output;
        }
      }
      // Unreachable for any input the schemas admit — the ladder ends at one entry per section and the
      // field step clips the only unbounded strings — so this is a guard against a future field that is
      // large by construction, not a state a caller can provoke.
      throw new ContextRuntimeError(
        'MCP_PLATFORM_DIAGNOSTICS_READ_FAILED',
        'The platform diagnostics answer could not be brought inside the response budget even at its smallest form.',
        {
          suggestion: 'This is an internal failure rather than a problem with the request: please report it, with the '
            + 'windowHours and limitPerSection that were used.',
        },
      );
    } catch (error) {
      throw mapPlatformDiagnosticsFailure(error);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Reading one section
// ---------------------------------------------------------------------------------------------

/** What a section read produced, before the response budget has had a say. */
type SetupChangesRead = Readonly<{
  entries: readonly SetupChangeEntry[];
  /** The window's true row count, or `null` when the aggregate could not be read. */
  totalCount: number | null;
  /** True when the entries are not the whole window — set only by evidence, never by the entry cap. */
  truncated: boolean;
  oldestRetainedAt: string | null;
  caveats: readonly string[];
}>;

type AsyncFailuresRead = Readonly<{
  entries: readonly AsyncFailureEntry[];
  /** The window's true row count, or `null` when the bounded scan cannot establish it. */
  totalCount: number | null;
  truncated: boolean;
  observedStatusCounts: Readonly<Record<string, number>> | null;
  caveats: readonly string[];
}>;

type ScheduledJobsRead = Readonly<{
  entries: readonly ScheduledJobEntry[];
  /** The org's scheduled-job count, or `null` when the read could not establish it. */
  totalCount: number | null;
  truncated: boolean;
  suspectedStallCount: number;
  caveats: readonly string[];
}>;

/** Why a section is unavailable, in the shape ADR-0029 §3 requires of an aggregator. */
type SectionFailure = Readonly<{
  errorCode: string;
  prerequisite: string | null;
  reason: string;
}>;

type SectionOutcome<Read> =
  | Readonly<{ status: 'READ'; read: Read }>
  | Readonly<{ status: 'UNAVAILABLE'; failure: SectionFailure }>;

/**
 * Runs one section's read, translating a refusal into that section's own state.
 *
 * The catch is per section and deliberate: ADR-0029 §3 forbids a single source's failure from sinking the
 * aggregation, and it equally forbids the failure being hidden. What it produces is the third thing — an
 * `UNAVAILABLE` state that names the missing prerequisite and the reason, beside the sections that read.
 */
async function readSection<Read>(
  label: string,
  objectApiName: string,
  read: () => Promise<Read>,
): Promise<SectionOutcome<Read>> {
  try {
    return { status: 'READ', read: await read() };
  } catch (error) {
    return { status: 'UNAVAILABLE', failure: classifySectionFailure(error, label, objectApiName) };
  }
}

const PERMISSION_DENIAL_CODES = [
  'INSUFFICIENT_ACCESS',
  'INSUFFICIENT_ACCESS_OR_READONLY',
  'INSUFFICIENT_PRIVILEGES',
  'API_DISABLED_FOR_ORG',
  'INVALID_TYPE',
  'NOT_FOUND',
] as const;

function isPermissionDenial(code: string | null): boolean {
  if (code === null) return false;
  const normalized = code.toLocaleUpperCase('en-US');
  return PERMISSION_DENIAL_CODES.some((denial) => denial === normalized);
}

/**
 * Which of the two failures a section hit.
 *
 * The distinction is the one ADR-0029 §3 draws: a *permission* the deployment has not granted is a missing
 * prerequisite, named as such so an operator has one row to look up; anything else is a read failure that
 * may simply work on the next call. The prerequisite string is the measured constraint rather than one of
 * §2's letters, which §3 explicitly allows — §2's `A-1`…`A-4` are about the Tooling log surface and the
 * Metadata API, and none of them is what this Tool reads.
 */
function classifySectionFailure(error: unknown, label: string, objectApiName: string): SectionFailure {
  if (error instanceof ContextRuntimeError) {
    return {
      errorCode: error.code,
      prerequisite: error.prerequisite ?? null,
      reason: error.message,
    };
  }
  const failure = readSalesforceFailure(error);
  if (isPermissionDenial(failure.code)) {
    return {
      errorCode: 'MCP_DIAGNOSTIC_PREREQUISITE_MISSING',
      prerequisite: `${objectApiName} readability on the diagnostic identity`,
      reason: `Salesforce refused to let the diagnostic identity read ${objectApiName}, so ${label} could not be `
        + 'read at all. Their absence from the timeline is missing evidence, not a quiet window.',
    };
  }
  return {
    errorCode: 'MCP_PLATFORM_DIAGNOSTICS_READ_FAILED',
    prerequisite: null,
    reason: `Salesforce could not complete the read of ${objectApiName}, so ${label} could not be read`
      + `${failure.code === null ? '' : ` (${failure.code})`}. This is reported as an unread source rather than as an `
      + 'empty one, because an empty list would read as "nothing happened".',
  };
}

/**
 * The setup audit trail, narrowed to the window in SOQL.
 *
 * `CreatedDate` is a measured-filterable field on this object and the entry list, the ordering and the
 * limit are the probe's own query shape. The aggregate uses the argument-less `COUNT()` because
 * `COUNT(Id)` is refused on this object — measured — and the response carries the number in `totalSize`
 * with an empty `records` array, which is why the count reader accepts both forms.
 *
 * The oldest-retained read is a separate, bounded query, and a failure in it is *not* a failure of the
 * section: the bound is a fact a reader wants, not the evidence itself, so it degrades to `null` with a
 * caveat. The same holds for the count.
 */
async function readSetupChanges(
  connection: Connection,
  from: string,
  limit: number,
): Promise<SetupChangesRead> {
  const windowClause = `CreatedDate >= ${soqlDateTimeLiteral(from)}`;
  const records = readQueryRecords(await connection.query(
    `SELECT ${SETUP_AUDIT_TRAIL_FIELDS} FROM SetupAuditTrail WHERE ${windowClause} `
      + `ORDER BY CreatedDate DESC LIMIT ${limit}`,
  ));
  const entries = records
    .map(toSetupChangeEntry)
    // Belt and braces on the one edge the query should already have enforced: a row older than the window
    // is outside it on any clock, and "禁止超窗口回传" is the contract this keeps true even if a future edit
    // loosened the filter.
    .filter((entry) => !isBeforeWindow(entry.occurredAt, from))
    .slice(0, limit);
  const total = await readOptionalCount(
    connection,
    `SELECT COUNT() FROM SetupAuditTrail WHERE ${windowClause}`,
  );
  const oldestRetainedAt = await readOldestRetained(connection);
  const caveats: string[] = [];
  if (total === null) {
    caveats.push(
      'The window\'s true row count could not be read from this org, so how much of the audit trail this list covers '
      + 'is unknown; the entries themselves were read.',
    );
  }
  if (oldestRetainedAt === null) {
    caveats.push(
      'The oldest row this org still retains could not be read, so how far back the audit trail reaches is unknown. '
      + 'Salesforce does not expose its retention policy to SOQL.',
    );
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    totalCount: total,
    // Only evidence, never the entry cap: `limit` is the caller's own bound, and a caller that asked for 25 of
    // 400 rows already knows it asked for 25. `truncated` here means "the window holds more than these rows".
    truncated: total !== null && total > entries.length,
    oldestRetainedAt,
    caveats: Object.freeze(caveats),
  });
}

/**
 * The failed and aborted asynchronous jobs inside the window, narrowed in the query.
 *
 * `AsyncApexJob.CreatedDate` filterability was an open question at T5's start, and an unmeasured filter is an
 * `INVALID_FIELD` that takes a whole section down — so this read carried only the measured `Status` filter and
 * windowed the rows in memory, bounded by a newest-first scan whose exhaustion made the window's total
 * unknowable. The T5 probe then measured the date filter on this org, so the window moved into the query and
 * the total comes from an aggregate read: what the section reports is now the window's own count rather than
 * what a bounded scan could establish.
 *
 * The status vocabulary is a second, window-independent read of the same table, and it is what makes a
 * zero-entry answer evidenced: it shows the section's filter ran against a readable table. It is also the one
 * thing whose failure can make the section unavailable — a failed vocabulary read beside zero *matching rows*
 * leaves nothing establishing that the filter matched nothing rather than matching the wrong literals.
 */
async function readAsyncFailures(
  connection: Connection,
  from: string,
  limit: number,
): Promise<AsyncFailuresRead> {
  const statusList = ASYNC_FAILURE_STATUSES.map((status) => quoteSoqlLiteral(status)).join(',');
  const windowClause = `Status IN (${statusList}) AND CreatedDate >= ${soqlDateTimeLiteral(from)}`;
  const records = readQueryRecords(await connection.query(
    `SELECT ${ASYNC_APEX_JOB_FIELDS} FROM AsyncApexJob WHERE ${windowClause} `
      + `ORDER BY CreatedDate DESC LIMIT ${ASYNC_FAILURE_SCAN_LIMIT}`,
  ));
  const observedStatusCounts = await readStatusVocabulary(connection);
  // The one combination in which this section cannot answer at all: nothing matched the status filter *and* the
  // vocabulary beside it could not be read. A zero-row result on its own is already evidence that the table is
  // readable, but not that the two literals this Tool filters on are the org's own — and the probe measured this
  // org translating at least one status vocabulary (`ApexLog.Status`, probe §1). Reporting zero from here would
  // claim "nothing failed" on the strength of a filter that may have matched nothing for the wrong reason, so
  // the section is `UNAVAILABLE` instead: ADR-0029 §3's "an unread source is never an empty one", applied to a
  // possibly mis-filtered one.
  if (records.length === 0 && observedStatusCounts === null) {
    throw new ContextRuntimeError(
      'MCP_PLATFORM_DIAGNOSTICS_READ_FAILED',
      'No asynchronous job matched this Tool\'s Failed/Aborted status filter, and the AsyncApexJob status '
        + 'vocabulary could not be read beside it, so nothing establishes that the filter matched nothing rather '
        + 'than matching the wrong literals.',
      {
        suggestion: 'Re-run once: if the vocabulary read succeeds it will report the status literals this org '
          + 'actually holds against the two this Tool filters on. If it keeps failing, check the diagnostic '
          + 'identity\'s access to AsyncApexJob.',
      },
    );
  }
  const placed = records.map((record) => ({ record, at: timestampOf(record.CreatedDate) }));
  // The query already excludes anything older than the window — the clause is measured and it is what makes
  // "禁止超窗口回传" a property of the statement rather than of this filter — and both are kept, because a
  // filter that silently disappears is a filter nobody notices losing. A row without a readable date is
  // dropped rather than placed: the window cannot say where it belongs, and the org's own count cannot
  // include it either, since that count is over the same field.
  const unreadableDates = placed.length - placed.filter((entry) => entry.at !== null).length;
  const entries = placed
    .filter((entry) => entry.at !== null && entry.at >= Date.parse(from))
    .map((entry) => toAsyncFailureEntry(entry.record))
    .slice(0, limit);
  const total = await readOptionalCount(
    connection,
    `SELECT COUNT() FROM AsyncApexJob WHERE ${windowClause}`,
  );
  const caveats: string[] = [];
  if (total === null) {
    caveats.push(
      'The window\'s true row count could not be read from this org, so how many failed or aborted jobs fall inside '
      + 'it is unknown; the entries themselves were read.',
    );
  }
  if (unreadableDates > 0) {
    caveats.push(
      `${unreadableDates} matching row(s) carried no readable CreatedDate and were left out: the status filter matched `
      + 'them, but the window cannot place them.',
    );
  }
  if (observedStatusCounts === null) {
    caveats.push(
      'The status vocabulary of this org\'s AsyncApexJob table could not be read, so the counts of every status '
      + 'this org holds are missing from this section. The matching rows below were read normally.',
    );
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    totalCount: total,
    // As for the setup trail: the entry cap is the caller's own bound, so `truncated` here means "the window
    // holds more than these rows" rather than "you asked for fewer rows than exist".
    truncated: total !== null && total > entries.length,
    observedStatusCounts,
    caveats: Object.freeze(caveats),
  });
}

/**
 * The org's scheduled jobs, each with ADR-0033's conservative stall assessment.
 *
 * This section is **current state**, not history: `CronTrigger` holds one row per schedule, and the window
 * does not narrow the section at all — it only decides which jobs reach the merged timeline, through the
 * fire time that falls inside it. The probe measured this org holding zero rows, which is why a zero-entry
 * answer here is `READ` with a count of zero and a caveat saying the table is empty rather than quiet.
 *
 * Each row is assessed against the *same* reading of the clock, so two jobs that are equally late are
 * equally flagged.
 */
async function readScheduledJobs(
  connection: Connection,
  nowMs: number,
  limit: number,
): Promise<ScheduledJobsRead> {
  const { records, totalSize } = readQueryResult(await connection.query(
    `SELECT ${CRON_TRIGGER_FIELDS} FROM CronTrigger LIMIT ${CRON_TRIGGER_SCAN_LIMIT}`,
  ));
  const all = records.map((record) => toScheduledJobEntry(record, nowMs));
  const entries = all.slice(0, limit);
  // The count comes from the response's own `totalSize` when the org reports one, and from the scanned set
  // otherwise: a bounded read of a table this small is complete in practice, and pretending otherwise would
  // mean inventing a count query whose shape was never measured.
  const totalCount = totalSize ?? all.length;
  const caveats: string[] = [];
  if (all.length === 0) {
    caveats.push(
      'This org holds no CronTrigger row at all, which is a fact about the org rather than a failure of this read: '
      + 'nothing is scheduled. A job that is scheduled but has never fired is in this table from creation, so an empty '
      + 'table is not a job that has not run yet.',
    );
  }
  if (totalCount > all.length) {
    caveats.push(
      `${totalCount} scheduled job(s) exist and ${all.length} were read, which is the scan bound; the assessment below `
      + 'covers only the rows that were read.',
    );
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    totalCount,
    truncated: totalCount > entries.length,
    // Counted over everything that was read rather than over the (possibly capped) list, because the number a
    // reader acts on is "how many jobs in this org look stalled", not "how many of the first N".
    suspectedStallCount: all.filter((entry) => entry.stallAssessment === 'SUSPECTED').length,
    caveats: Object.freeze(caveats),
  });
}

/** The status vocabulary and counts of `AsyncApexJob`, or `null` when the aggregate itself could not be read. */
async function readStatusVocabulary(connection: Connection): Promise<Readonly<Record<string, number>> | null> {
  try {
    const records = readQueryRecords(await connection.query(
      'SELECT Status, COUNT(Id) total FROM AsyncApexJob GROUP BY Status',
    ));
    const counts: Record<string, number> = {};
    for (const record of records) {
      const status = asString(record.Status);
      const count = asNumber(record.total) ?? asNumber(record.expr0);
      if (status === null || count === null) continue;
      counts[status] = count;
    }
    return Object.freeze(counts);
  } catch {
    return null;
  }
}

/** The oldest `SetupAuditTrail` row this org still retains, or `null` when even that could not be read. */
async function readOldestRetained(connection: Connection): Promise<string | null> {
  try {
    const record = readQueryRecords(await connection.query(
      'SELECT Id, CreatedDate FROM SetupAuditTrail ORDER BY CreatedDate ASC LIMIT 1',
    ))[0];
    return record === undefined ? null : asString(record.CreatedDate);
  } catch {
    return null;
  }
}

/** Runs a count statement, or `null` when the org refuses or answers unreadably. Never throws. */
async function readOptionalCount(connection: Connection, statement: string): Promise<number | null> {
  try {
    const { records, totalSize } = readQueryResult(await connection.query(statement));
    const first = records[0];
    if (first !== undefined) {
      // `COUNT()`'s synthetic alias is not a fixed name (probe §4 recorded the response's own keys rather
      // than assuming one), so the number is taken as the first numeric field that is not the record's
      // `attributes` envelope.
      const entry = Object.entries(first)
        .find(([field, value]) => field !== 'attributes' && asNumber(value) !== null);
      if (entry !== undefined) return asNumber(entry[1]);
    }
    // The record-less form: an empty `records` array with the number in `totalSize` (measured: 260 911).
    if (records.length === 0 && totalSize !== null) return totalSize;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Assembling the answer
// ---------------------------------------------------------------------------------------------

/** How many entries each section may keep at one rung of the budget ladder. */
type SectionCaps = Readonly<{
  setupChanges: number;
  asyncFailures: number;
  scheduledJobs: number;
}>;

const CAP_KEYS = Object.freeze(['setupChanges', 'asyncFailures', 'scheduledJobs'] as const);

/** How many entries a section could offer if the budget never cut anything. */
function availableEntries<Read>(outcome: SectionOutcome<Read> | null): number {
  if (outcome === null || outcome.status !== 'READ') return 0;
  return readEntryCount(outcome.read);
}

function readEntryCount(read: unknown): number {
  const entries = (read as { entries?: readonly unknown[] }).entries;
  return Array.isArray(entries) ? entries.length : 0;
}

/**
 * The rungs the response budget walks, largest first.
 *
 * Each rung halves every section that is still above one entry, so the ladder reaches the floor in about
 * `log2(largest cap)` steps rather than by counting down — and because every section shrinks together, no
 * rung can produce something larger than the rung above it, which is what makes walking down from the top
 * the same thing as finding the largest answer that fits.
 */
function capLadder(initial: SectionCaps): readonly SectionCaps[] {
  const rungs: SectionCaps[] = [initial];
  let current = initial;
  while (CAP_KEYS.some((key) => current[key] > 1)) {
    const next: Record<string, number> = { ...current };
    for (const key of CAP_KEYS) next[key] = current[key] <= 1 ? current[key] : Math.ceil(current[key] / 2);
    current = Object.freeze(next) as SectionCaps;
    rungs.push(current);
  }
  return Object.freeze(rungs);
}

type ComposeInput = Readonly<{
  window: PlatformDiagnosticsOutput['window'];
  caps: SectionCaps;
  clipFields: boolean;
  setupChanges: SectionOutcome<SetupChangesRead> | null;
  asyncFailures: SectionOutcome<AsyncFailuresRead> | null;
  scheduledJobs: SectionOutcome<ScheduledJobsRead> | null;
  advertised: ReadonlySet<string>;
  requested: readonly PlatformDiagnosticSection[];
}>;

/**
 * Renders the whole answer for one rung of the ladder.
 *
 * `truncated` is per section and it is the union of two different facts — the window holds more than the
 * section read, and the response budget cut what the section read — because a consumer deciding whether to
 * re-run cares about either one and cannot tell them apart from the entry list alone. Which of the two it
 * was is in the caveats.
 */
function compose(input: ComposeInput): PlatformDiagnosticsOutput {
  const setupChanges = input.setupChanges === null
    ? undefined
    : buildSetupChangesSection(input.setupChanges, input.caps.setupChanges, input.clipFields);
  const asyncFailures = input.asyncFailures === null
    ? undefined
    : buildAsyncFailuresSection(input.asyncFailures, input.caps.asyncFailures, input.clipFields);
  const scheduledJobs = input.scheduledJobs === null
    ? undefined
    : buildScheduledJobsSection(input.scheduledJobs, input.caps.scheduledJobs, input.clipFields);
  const sections = Object.freeze({
    ...(setupChanges === undefined ? {} : { setupChanges }),
    ...(asyncFailures === undefined ? {} : { asyncFailures }),
    ...(scheduledJobs === undefined ? {} : { scheduledJobs }),
  });

  const facts: readonly PlatformDiagnosticsSectionFact[] = [
    ...(setupChanges === undefined ? [] : [sectionFact('SETUP_CHANGES', setupChanges, null)]),
    ...(asyncFailures === undefined ? [] : [sectionFact('ASYNC_FAILURES', asyncFailures, null)]),
    ...(scheduledJobs === undefined
      ? []
      : [sectionFact('SCHEDULED_JOBS', scheduledJobs, scheduledJobs.status === 'READ' ? scheduledJobs.suspectedStallCount : null)]),
  ];
  const readSectionCount = facts.filter((fact) => fact.status === 'READ').length;
  const unavailableSectionCount = facts.length - readSectionCount;
  const truncated = [setupChanges, asyncFailures, scheduledJobs]
    .some((section) => section !== undefined && section.truncated);
  const timeline = buildTimeline({
    window: input.window,
    setupChanges,
    asyncFailures,
    scheduledJobs,
  });
  const hintFacts: PlatformDiagnosticsHintFacts = Object.freeze({
    windowHours: input.window?.hours ?? PLATFORM_DIAGNOSTICS_DEFAULT_WINDOW_HOURS,
    sections: facts,
    truncated,
    oldestRetainedAt: setupChanges !== undefined && setupChanges.status === 'READ'
      ? setupChanges.oldestRetainedAt
      : null,
  });
  return {
    success: true,
    executionRole: 'DIAGNOSTIC',
    api: 'STANDARD',
    window: input.window,
    sections,
    alignment: {
      timeline,
      note: alignmentNote(input.requested, facts, input.window, truncated),
    },
    readSectionCount,
    unavailableSectionCount,
    truncated,
    hint: platformDiagnosticsHint(input.advertised, hintFacts),
  };
}

function sectionFact(
  section: PlatformDiagnosticSection,
  value: { status: 'READ' | 'UNAVAILABLE'; totalCount: number | null; entries?: readonly unknown[]; prerequisite?: string | undefined },
  suspectedStallCount: number | null,
): PlatformDiagnosticsSectionFact {
  return Object.freeze({
    section,
    status: value.status,
    entryCount: value.entries?.length ?? 0,
    totalCount: value.totalCount,
    suspectedStallCount,
    prerequisite: value.prerequisite ?? null,
  });
}

/**
 * The shared shape of an unavailable section: no entries, no count, and the reason it has neither.
 *
 * `extra` carries the section's own nullable field (`oldestRetainedAt`, `observedStatusCounts`,
 * `suspectedStallCount`), each of which is required by the output schema in *every* state and is `null`
 * here. The schema is right to require it: "the section could not be read" is exactly the state in which a
 * consumer must be told that the number it would otherwise read is absent rather than zero.
 */
function unavailableSectionFields<Section extends PlatformDiagnosticSection, Extra extends Record<string, null>>(
  section: Section,
  failure: SectionFailure,
  extra: Extra,
): {
  section: Section;
  status: 'UNAVAILABLE';
  entries: never[];
  totalCount: null;
  truncated: false;
  prerequisite?: string;
  errorCode: string;
  unavailableReason: string;
  caveats: string[];
} & Extra {
  return {
    section,
    status: 'UNAVAILABLE',
    entries: [],
    // `null`, never 0 — the one typing mistake that would turn an unread source back into a silent empty one.
    totalCount: null,
    truncated: false,
    ...(failure.prerequisite === null ? {} : { prerequisite: failure.prerequisite }),
    errorCode: failure.errorCode,
    unavailableReason: failure.reason,
    caveats: [],
    ...extra,
  };
}

function buildSetupChangesSection(
  outcome: SectionOutcome<SetupChangesRead>,
  cap: number,
  clipFields: boolean,
): NonNullable<NonNullable<PlatformDiagnosticsOutput['sections']>['setupChanges']> {
  if (outcome.status === 'UNAVAILABLE') {
    return unavailableSectionFields('SETUP_CHANGES', outcome.failure, { oldestRetainedAt: null });
  }
  const read = outcome.read;
  const kept = read.entries.slice(0, cap).map((entry) => (clipFields ? clipSetupChange(entry) : entry));
  return {
    section: 'SETUP_CHANGES',
    status: 'READ',
    entries: [...kept],
    totalCount: read.totalCount,
    truncated: read.truncated || kept.length < read.entries.length,
    oldestRetainedAt: read.oldestRetainedAt,
    caveats: [...read.caveats, ...budgetCaveat(kept.length, read.entries.length, clipFields, 'entry', 'entries')],
  };
}

function buildAsyncFailuresSection(
  outcome: SectionOutcome<AsyncFailuresRead>,
  cap: number,
  clipFields: boolean,
): NonNullable<NonNullable<PlatformDiagnosticsOutput['sections']>['asyncFailures']> {
  if (outcome.status === 'UNAVAILABLE') {
    return unavailableSectionFields('ASYNC_FAILURES', outcome.failure, { observedStatusCounts: null });
  }
  const read = outcome.read;
  const kept = read.entries.slice(0, cap).map((entry) => (clipFields ? clipAsyncFailure(entry) : entry));
  return {
    section: 'ASYNC_FAILURES',
    status: 'READ',
    entries: [...kept],
    totalCount: read.totalCount,
    truncated: read.truncated || kept.length < read.entries.length,
    // The vocabulary read is window-independent evidence that the table is readable, so it survives the
    // budget untouched — it is a handful of keys, and it is what makes a zero-entry answer non-silent.
    observedStatusCounts: read.observedStatusCounts === null ? null : { ...read.observedStatusCounts },
    caveats: [...read.caveats, ...budgetCaveat(kept.length, read.entries.length, clipFields, 'entry', 'entries')],
  };
}

function buildScheduledJobsSection(
  outcome: SectionOutcome<ScheduledJobsRead>,
  cap: number,
  clipFields: boolean,
): NonNullable<NonNullable<PlatformDiagnosticsOutput['sections']>['scheduledJobs']> {
  if (outcome.status === 'UNAVAILABLE') {
    return unavailableSectionFields('SCHEDULED_JOBS', outcome.failure, { suspectedStallCount: null });
  }
  const read = outcome.read;
  const kept = read.entries.slice(0, cap).map((entry) => (clipFields ? clipScheduledJob(entry) : entry));
  return {
    section: 'SCHEDULED_JOBS',
    status: 'READ',
    entries: [...kept],
    totalCount: read.totalCount,
    truncated: read.truncated || kept.length < read.entries.length,
    suspectedStallCount: read.suspectedStallCount,
    caveats: [...read.caveats, ...budgetCaveat(kept.length, read.entries.length, clipFields, 'job row', 'job rows')],
  };
}

/**
 * The sentence a budget cut adds to a section, or nothing when this section was not cut.
 *
 * Two different cuts reach here — the entry cap and the field clip — and they are said separately, because
 * a reader who has to ask "is this value short or was it shortened" has already lost the answer.
 */
function budgetCaveat(kept: number, available: number, clipFields: boolean, one: string, many: string): readonly string[] {
  const caveats: string[] = [];
  if (kept < available) {
    caveats.push(
      `The response budget kept ${kept} of this section's ${available} ${available === 1 ? one : many}; the section's `
      + 'own counts say how much of the window that is.',
    );
  }
  if (clipFields) {
    caveats.push(
      `Free-text fields longer than ${PLATFORM_DIAGNOSTICS_MAX_FIELD_CHARACTERS} characters were clipped so the answer `
      + 'would fit the response budget, so a clipped value is shorter than what the org returned.',
    );
  }
  return Object.freeze(caveats);
}

function clipSetupChange(entry: SetupChangeEntry): SetupChangeEntry {
  return Object.freeze({
    ...entry,
    ...(entry.display === null ? {} : { display: clip(entry.display) }),
  });
}

function clipAsyncFailure(entry: AsyncFailureEntry): AsyncFailureEntry {
  return Object.freeze({
    ...entry,
    ...(entry.extendedStatus === null ? {} : { extendedStatus: clip(entry.extendedStatus) }),
  });
}

function clipScheduledJob(entry: ScheduledJobEntry): ScheduledJobEntry {
  return {
    ...entry,
    ...(entry.name === null ? {} : { name: clip(entry.name) }),
    stallReasons: entry.stallReasons.map((reason) => clip(reason)),
  };
}

function clip(value: string): string {
  return value.length <= PLATFORM_DIAGNOSTICS_MAX_FIELD_CHARACTERS
    ? value
    : `${value.slice(0, PLATFORM_DIAGNOSTICS_MAX_FIELD_CHARACTERS - 1)}…`;
}

// ---------------------------------------------------------------------------------------------
// The merged timeline
// ---------------------------------------------------------------------------------------------

type TimelineEntry = NonNullable<NonNullable<PlatformDiagnosticsOutput['alignment']>['timeline']>[number];

type TimelineInput = Readonly<{
  window: PlatformDiagnosticsOutput['window'];
  setupChanges: ReturnType<typeof buildSetupChangesSection> | undefined;
  asyncFailures: ReturnType<typeof buildAsyncFailuresSection> | undefined;
  scheduledJobs: ReturnType<typeof buildScheduledJobsSection> | undefined;
}>;

/**
 * The merge, oldest first, built from the entries the sections actually returned.
 *
 * Built from the *returned* entries rather than from everything that was read, because a timeline that
 * named a row the answer does not carry would be a citation a caller cannot follow. The consequence is
 * stated in the alignment note: after a budget cut the timeline is a prefix of the window, not the window.
 *
 * A scheduled job enters at a fire time and contributes at most one line: a `SUSPECTED` job enters at the
 * time it was *due* to fire and did not, and every other job enters at the time it last fired. The two
 * wordings are different sentences, because "was due to" is a claim about the schedule and "last fired" is
 * a claim about what happened — and the merged list is the one place they could be confused.
 */
function buildTimeline(input: TimelineInput): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const entry of input.setupChanges?.status === 'READ' ? input.setupChanges.entries : []) {
    entries.push({
      occurredAt: entry.occurredAt,
      section: 'SETUP_CHANGES',
      entryId: entry.id,
      summary: clipSummary(
        `${format(entry.action)} by ${format(entry.createdBy)}${entry.display === null ? '' : `: ${entry.display}`}`,
      ),
    });
  }
  for (const entry of input.asyncFailures?.status === 'READ' ? input.asyncFailures.entries : []) {
    entries.push({
      occurredAt: entry.occurredAt,
      section: 'ASYNC_FAILURES',
      entryId: entry.id,
      summary: clipSummary(
        `${format(entry.status)} ${format(entry.jobType)} ${format(entry.apexClass)}, errors=${format(entry.numberOfErrors)}`,
      ),
    });
  }
  for (const entry of input.scheduledJobs?.status === 'READ' ? input.scheduledJobs.entries : []) {
    const due = entry.stallAssessment === 'SUSPECTED' ? entry.nextFireTime : null;
    const fired = entry.previousFireTime;
    if (due !== null && inWindow(due, input.window)) {
      entries.push({
        occurredAt: due,
        section: 'SCHEDULED_JOBS',
        entryId: entry.id,
        summary: clipSummary(
          `scheduled job ${format(entry.name)} was due to fire and did not (state=${format(entry.state)}, `
          + `last fired ${format(entry.previousFireTime)})`,
        ),
      });
      continue;
    }
    if (fired !== null && inWindow(fired, input.window)) {
      entries.push({
        occurredAt: fired,
        section: 'SCHEDULED_JOBS',
        entryId: entry.id,
        summary: clipSummary(`scheduled job ${format(entry.name)} last fired (state=${format(entry.state)})`),
      });
    }
  }
  // Sorted in place and returned unfrozen: this array is handed straight to the output schema, which types
  // the timeline as a plain array. Freezing here would only buy a `readonly` the payload does not have.
  return entries.sort(compareTimeline);
}

/**
 * Oldest first, on parsed instants rather than on strings.
 *
 * The org's timestamps arrive in more than one spelling — `…Z` from our own clock, `…+0000` from jsforce's
 * dateTime rendering — and those two sort differently as text. Ties break on the section's own order and
 * then on the entry id, so two identical calls produce the same timeline: a diagnostic reading that
 * reshuffles between calls is not evidence anyone can cite.
 */
function compareTimeline(left: TimelineEntry, right: TimelineEntry): number {
  const leftMs = timestampMs(left.occurredAt);
  const rightMs = timestampMs(right.occurredAt);
  if (leftMs !== rightMs) return leftMs - rightMs;
  const sectionOrder = PLATFORM_DIAGNOSTIC_SECTIONS.indexOf(left.section)
    - PLATFORM_DIAGNOSTIC_SECTIONS.indexOf(right.section);
  if (sectionOrder !== 0) return sectionOrder;
  return left.entryId.localeCompare(right.entryId, 'en-US');
}

/**
 * What the merged list does and does not establish.
 *
 * Each sentence is one a reader would otherwise have to infer from a list that cannot show it: that the
 * nearest entry above a symptom is a candidate rather than a cause, that a section is missing from the merge
 * because it could not be read (never inferable from a list with fewer lines), that a section is missing
 * because this call did not ask for it (the same inference, and the same remedy is *not* to resolve a
 * prerequisite), that a section was cut, and that the window's two edges are stamped by two different clocks.
 */
function alignmentNote(
  requested: readonly PlatformDiagnosticSection[],
  facts: readonly PlatformDiagnosticsSectionFact[],
  window: PlatformDiagnosticsOutput['window'],
  truncated: boolean,
): string {
  const unavailable = facts.filter((fact) => fact.status === 'UNAVAILABLE');
  const sentences: string[] = [
    'The timeline merges the sections that were read onto one clock, oldest first, and each entry names its own '
    + 'section because the three sources are not comparable evidence: a setup change is somebody\'s action, an async '
    + 'failure is an outcome, and a scheduled entry is either a fire or a due time the platform did not meet.',
    'The entry immediately above the moment a symptom started is the nearest change to investigate — it is a candidate '
    + 'and not a cause, and a setup change and a failure that name the same component are the pairing to read first.',
  ];
  if (unavailable.length > 0) {
    sentences.push(
      `${unavailable.map((fact) => fact.section).join(', ')} could not be read and therefore contribute no entries: the `
      + 'timeline is missing that evidence, so a quiet stretch on it is not a quiet org.',
    );
  }
  if (requested.length < PLATFORM_DIAGNOSTIC_SECTIONS.length) {
    sentences.push(
      `This call asked for ${requested.length} of the ${PLATFORM_DIAGNOSTIC_SECTIONS.length} sections, so the timeline `
      + 'merges only those: a quiet stretch on a section this call did not name is absent evidence rather than a quiet '
      + 'org, and a call that omits the sections argument reads all three.',
    );
  }
  if (truncated) {
    sentences.push(
      'At least one section\'s entry list was cut — by the window\'s own size or by the response budget — so this '
      + 'timeline is built from the entries the answer carries and is not the whole window.',
    );
  }
  sentences.push(
    'Timestamps are the org\'s own, as it stamped them, and are not re-rendered here. The window\'s lower edge is '
    + `enforced where the query allows it and the upper edge is ${window?.to ?? 'the moment of the call'}, which is this `
    + 'server\'s clock: if the two clocks differ, the newest line may be stamped slightly later than the window\'s end.',
  );
  return sentences.join(' ');
}

// ---------------------------------------------------------------------------------------------
// Rows to entries
// ---------------------------------------------------------------------------------------------

function toSetupChangeEntry(record: Record<string, unknown>): SetupChangeEntry {
  const createdBy = isRecord(record.CreatedBy) ? record.CreatedBy : {};
  return Object.freeze({
    id: asString(record.Id) ?? '',
    occurredAt: asString(record.CreatedDate) ?? '',
    // The API enum, verbatim. `Section` and `Display` are the org's localized labels: they are reported and
    // never matched on, because `Section` is not even filterable on this object (measured `INVALID_FIELD`).
    action: asString(record.Action),
    section: asString(record.Section),
    display: asString(record.Display),
    createdBy: asString(createdBy.Name) ?? asString(record['CreatedBy.Name']),
    delegateUser: asString(record.DelegateUser),
  });
}

function toAsyncFailureEntry(record: Record<string, unknown>): AsyncFailureEntry {
  const apexClass = isRecord(record.ApexClass) ? record.ApexClass : {};
  return Object.freeze({
    id: asString(record.Id) ?? '',
    occurredAt: asString(record.CreatedDate) ?? '',
    status: asString(record.Status),
    jobType: asString(record.JobType),
    apexClass: asString(apexClass.Name) ?? asString(record['ApexClass.Name']),
    numberOfErrors: asNumber(record.NumberOfErrors),
    // Unbounded in the schema, so it is the first field the budget's field step clips.
    extendedStatus: asString(record.ExtendedStatus),
  });
}

function toScheduledJobEntry(record: Record<string, unknown>, nowMs: number): ScheduledJobEntry {
  const detail = isRecord(record.CronJobDetail) ? record.CronJobDetail : {};
  const state = asString(record.State);
  const nextFireTime = asString(record.NextFireTime);
  const previousFireTime = asString(record.PreviousFireTime);
  const verdict = assessScheduledJobStall({ state, nextFireTime, previousFireTime, nowMs });
  // Copied rather than aliased: the verdict's reasons are frozen by the provider's module, and the output
  // schema types `stallReasons` as a plain array.
  return {
    id: asString(record.Id) ?? '',
    name: asString(detail.Name) ?? asString(record['CronJobDetail.Name']),
    // `JobType` is the API enum and is reported verbatim; this org translates labels, not enums.
    jobType: asString(detail.JobType) ?? asString(record['CronJobDetail.JobType']),
    state,
    nextFireTime,
    previousFireTime,
    timesTriggered: asNumber(record.TimesTriggered),
    stallAssessment: verdict.assessment,
    stallReasons: [...verdict.reasons],
  };
}

// ---------------------------------------------------------------------------------------------
// Failures of the call as a whole
// ---------------------------------------------------------------------------------------------

/**
 * ADR-0029 §3 at the top level: this is the failure of the *call*, not of a section.
 *
 * A section that could not be read is a state inside a successful result and never reaches here — that is
 * what `readSection` is for. What does reach here is the Connection itself, the identity guard, or the
 * budget guard, and each of those is a fact about the whole call.
 */
function mapPlatformDiagnosticsFailure(error: unknown): ContextRuntimeError {
  if (error instanceof ContextRuntimeError) return error;
  const failure = readSalesforceFailure(error);
  if (isPermissionDenial(failure.code)) {
    return new ContextRuntimeError(
      'MCP_DIAGNOSTIC_PREREQUISITE_MISSING',
      'Salesforce refused this request\'s identity before any platform-status source could be read.',
      {
        cause: error,
        ...(failure.code === null ? {} : { salesforceErrorCode: failure.code }),
        prerequisite: 'platform-status readability on the diagnostic identity',
        suggestion: 'This Tool reads SetupAuditTrail, AsyncApexJob and CronTrigger on the server-owned DIAGNOSTIC '
          + 'account, and needs "View Setup and Configuration" plus API access on it. Because the refusal came before '
          + 'the three sources were reached, no section state is available: enable the Tool only after the read is granted.',
      },
    );
  }
  return new ContextRuntimeError(
    'MCP_PLATFORM_DIAGNOSTICS_READ_FAILED',
    'Salesforce could not complete the platform-diagnostics aggregation for this request.',
    {
      cause: error,
      ...(failure.code === null ? {} : { salesforceErrorCode: failure.code }),
      suggestion: 'Retry once. If it fails again, check the diagnostic identity\'s API access. A failed aggregation '
        + 'never returns an empty timeline, because an empty timeline would read as "nothing happened".',
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------------------------

/** The parsed instant, or `null` when the org's value is not a timestamp this code can read. */
function timestampOf(value: unknown): number | null {
  const text = asString(value);
  if (text === null) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Epoch milliseconds for sorting; an unreadable timestamp sorts last rather than first. */
function timestampMs(value: string): number {
  return timestampOf(value) ?? Number.POSITIVE_INFINITY;
}

/** True when the entry's own timestamp is older than the window — the one edge no clock difference explains. */
function isBeforeWindow(occurredAt: string, from: string): boolean {
  const at = timestampOf(occurredAt);
  return at !== null && at < Date.parse(from);
}

/** True when an org-stamped time falls inside the window, on the org's own clock. */
function inWindow(value: string, window: PlatformDiagnosticsOutput['window']): boolean {
  if (window === undefined) return true;
  const at = timestampOf(value);
  if (at === null) return false;
  return at >= Date.parse(window.from);
}

function clipSummary(value: string): string {
  return value.length <= PLATFORM_DIAGNOSTICS_MAX_SUMMARY_CHARACTERS
    ? value
    : `${value.slice(0, PLATFORM_DIAGNOSTICS_MAX_SUMMARY_CHARACTERS - 1)}…`;
}

function format(value: unknown): string {
  return value === null || value === undefined ? 'unknown' : String(value);
}

/** SOQL string-literal escaping. Every value quoted here is a schema constant, never free text. */
function quoteSoqlLiteral(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/**
 * A SOQL `dateTime` literal, emitted **unquoted** — which is what the platform requires.
 *
 * The T2 live milestone established the cost of getting this wrong: a quoted dateTime literal is a *string*
 * literal, and the platform refuses it with `INVALID_FIELD` — the whole Tool failed over it once, before
 * `get_apex_logs` emitted it bare. The shape is re-validated here rather than trusted, and the only value
 * ever passed in is produced in-process by `Date#toISOString()` on a window computed from the clock, so no
 * part of this string can come from a caller or from org data.
 */
function soqlDateTimeLiteral(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) {
    throw new ContextRuntimeError(
      'MCP_PLATFORM_DIAGNOSTICS_READ_FAILED',
      'The diagnostics window could not be expressed as a SOQL dateTime literal.',
      { suggestion: 'This is an internal failure rather than a problem with the request: please report it.' },
    );
  }
  return value;
}

type QueryResult = Readonly<{ records: readonly Record<string, unknown>[]; totalSize: number | null }>;

function readQueryResult(value: unknown): QueryResult {
  const record = isRecord(value) ? value : {};
  const records = Array.isArray(record.records) ? record.records.filter(isRecord) : [];
  return Object.freeze({ records: Object.freeze(records), totalSize: asNumber(record.totalSize) });
}

function readQueryRecords(value: unknown): readonly Record<string, unknown>[] {
  return readQueryResult(value).records;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

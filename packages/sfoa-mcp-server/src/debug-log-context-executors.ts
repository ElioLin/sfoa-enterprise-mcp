import type { Connection } from '@salesforce/core';
import { DATA_MAX_RESPONSE_BYTES, readSalesforceFailure, trimToByteBudget } from '@sfoa/mcp-provider-sfoa-data';
import {
  APEX_LOG_DEFAULT_LIMIT,
  APEX_LOG_DEFAULT_TIME_WINDOW_MINUTES,
  DEBUG_LEVEL_FIELDS,
  DEBUG_LEVEL_TIERS,
  DEBUG_LOG_BODY_DEFAULT_MAX_CHARACTERS,
  DEFAULT_DEBUG_LEVEL_TIER,
  TRACE_FLAG_DEFAULT_DURATION_MINUTES,
  TRACED_ENTITY_LOG_TYPES,
  ContextRuntimeError,
  apexLogsHint,
  debugLevelCreatePayload,
  debugLogBodyHint,
  parseApexLogHeader,
  readDebugLevelLevels,
  traceFlagHint,
  type ApexLogEntry,
  type ApexLogReader,
  type ApexLogsInput,
  type ApexLogsOutput,
  type DebugLevelField,
  type DebugLevelValue,
  type DebugLogBodyInput,
  type DebugLogBodyOutput,
  type DebugLogBodyReader,
  type DebugLogHeaderSummary,
  type TraceFlagInput,
  type TraceFlagOutput,
  type TraceFlagWriter,
} from '@sfoa/mcp-provider-sfoa-context';
import type { RequestScope } from '@sfoa/identity-runtime';
import { assertDiagnosticScope } from './diagnostic-context-adapters.js';

/**
 * The three debug-log executors, host-side on the fixed DIAGNOSTIC identity.
 *
 * They live in the host rather than in the context provider for the reason recorded on the
 * `TraceFlagWriter` contract: `RequestScope` is the only object that can prove which identity a request
 * was routed to, and `set_trace_flag` writes — a provider-side implementation would be handed a
 * Connection it could neither attribute nor refuse to use on a business identity. The provider owns the
 * Tool contract, the schemas and the pure parsers; the host owns the identity guard, the Connection, the
 * response budget and the advertised-Tool set the hints are gated on.
 *
 * Every Salesforce call shape below is one `probe:p10` measured on a live org rather than one read from
 * documentation — the field lists, the Tooling endpoint, the create payloads, the aggregate-count shape.
 * Where a measured trap exists the code comments name it and the finding it comes from.
 */

/** The advertised Tool names of this session, which a hint may name and nothing else may. */
type AdvertisedTools = readonly string[];

const DEBUG_LEVEL_FIELD_LIST = DEBUG_LEVEL_FIELDS.join(', ');
const TRACE_FLAG_FIELD_LIST = 'Id, TracedEntityId, LogType, DebugLevelId, StartDate, ExpirationDate';
/**
 * The `ApexLog` fields this Tool reads. All were measured present on the deployment's Tooling API — the
 * probe found 13 fields carrying every one of these — because a query naming a field this API version
 * does not carry fails with `INVALID_FIELD` and takes the whole Tool down.
 */
const APEX_LOG_FIELD_LIST = 'Id, LogUserId, LogUser.Name, LogUser.Username, Application, Operation, Status, '
  + 'DurationMilliseconds, LogLength, StartTime, LastModifiedDate';
/**
 * How many rows of the window are fetched before the `status` filter is applied in memory.
 *
 * The filter cannot be pushed into SOQL: `ApexLog.Status` is translated on this org (`'Success'` matched
 * 1 of 9 rows, the localized literal 8 — probe §1), so a `WHERE` on a caller-supplied literal would
 * silently drop most of the window. Fetching a bounded scan and matching afterwards makes the filter's
 * reach visible as `scannedCount` instead of invisible as a shorter list.
 */
const APEX_LOG_SCAN_LIMIT = 200;
/**
 * The body is cut into segments before the byte budget is applied, because `trimToByteBudget` removes
 * whole items and a body is otherwise one indivisible string — it would be all-or-nothing. Segments keep
 * the cut a prefix and let the tested house mechanism do the measuring.
 */
const DEBUG_LOG_BODY_SEGMENT_CHARACTERS = 4_000;

export class ScopedTraceFlagExecutor implements TraceFlagWriter {
  public constructor(
    private readonly scope: RequestScope,
    private readonly advertisedToolNames: AdvertisedTools,
  ) {}

  public async execute(input: TraceFlagInput): Promise<TraceFlagOutput> {
    // The facade decides what the request may do; this decides which identity a Connection may be
    // opened for. Neither is redundant — this is the last point before Salesforce.
    assertDiagnosticScope(this.scope, 'set_trace_flag');
    const durationMinutes = input.durationMinutes ?? TRACE_FLAG_DEFAULT_DURATION_MINUTES;
    const tierName = input.logLevel ?? DEFAULT_DEBUG_LEVEL_TIER;
    const tier = DEBUG_LEVEL_TIERS[tierName];
    const logType = TRACED_ENTITY_LOG_TYPES[input.tracedEntityKind];
    try {
      const connection = await this.scope.getConnection();
      const level = await resolveOrCreateDebugLevel(connection, tierName);
      // Salesforce stores `TraceFlag.ExpirationDate` at **second** precision and answers a re-read with the
      // truncated value (`…:47.000+0000` against a requested `…:47.812Z`). Comparing the stored instant to a
      // request that carries milliseconds therefore fails by the sub-second remainder — which is what the
      // T2 live milestone measured: a correct write reported `verified: false`, the mirror image of the T1
      // probe's finding (a success reported on a row that survived). The clock is truncated to whole seconds
      // here so the request is expressible in the precision the platform keeps, leaving the comparison below
      // exact instead of nudging it with a tolerance that would hide a real shortfall.
      const now = new Date(Math.floor(Date.now() / 1_000) * 1_000);
      const requestedExpiration = new Date(now.getTime() + durationMinutes * 60_000);
      const existing = await readTraceFlagsForEntity(connection, input.tracedEntityId);
      const active = existing.filter((flag) => !isExpired(flag.expirationDate, now));
      // Only a flag of the requested kind is extended. A flag of the *other* kind on the same entity is
      // left untouched: changing its `LogType` would silently repurpose a trace somebody else opened, and
      // that field's updateability was never measured. Leaving it is also what makes the platform's own
      // answer the honest one — an overlapping create is refused by entity (probe §2) — so the caller
      // gets that refusal with the conflicting rows named, rather than a rule invented here.
      const sameKind = active.filter((flag) => flag.logType === logType);

      let traceFlagId: string;
      let replacedExisting: boolean;
      let previousExpirationDate: string | null;
      if (sameKind.length > 0) {
        const target = sameKind.reduce((latest, flag) => (
          expiryMs(flag.expirationDate) > expiryMs(latest.expirationDate) ? flag : latest
        ));
        // Never shortened: an in-flight investigation must not be cut short by a later, shorter request.
        const extendsTo = expiryMs(target.expirationDate) > requestedExpiration.getTime()
          ? new Date(expiryMs(target.expirationDate))
          : requestedExpiration;
        await updateToolingRecord(connection, 'TraceFlag', {
          Id: target.id,
          ExpirationDate: extendsTo.toISOString(),
          DebugLevelId: level.id,
        });
        traceFlagId = target.id;
        replacedExisting = true;
        previousExpirationDate = target.expirationDate;
      } else {
        const created = await createTraceFlag(connection, {
          TracedEntityId: input.tracedEntityId,
          LogType: logType,
          DebugLevelId: level.id,
          StartDate: now.toISOString(),
          ExpirationDate: requestedExpiration.toISOString(),
        }, active);
        if (created.id === null || !created.success) {
          throw traceFlagWriteRefusal(created.errors, active);
        }
        traceFlagId = created.id;
        replacedExisting = false;
        previousExpirationDate = null;
      }

      // A write's answer is verified rather than trusted: the probe's own cleanup once reported success on
      // a row that survived (probe §2), so the stored row is re-read and what it says is what is reported.
      const stored = await readTraceFlagById(connection, traceFlagId);
      const expirationDate = stored?.expirationDate ?? null;
      // One rule for both branches: verified means the stored row exists and is active for at least the
      // window the caller asked for. `extendsTo` never shortens an existing flag, so a correct extend
      // satisfies this too.
      const verified = stored !== null && expiryMs(expirationDate) >= requestedExpiration.getTime();
      return {
        success: true,
        executionRole: 'DIAGNOSTIC',
        api: 'TOOLING',
        traceFlagId,
        tracedEntityKind: input.tracedEntityKind,
        tracedEntityId: input.tracedEntityId,
        logType,
        debugLevelId: level.id,
        debugLevelDeveloperName: tier.developerName,
        debugLevelTier: tierName,
        debugLevelCreated: level.created,
        debugLevelLevels: level.levels,
        startDate: stored?.startDate ?? now.toISOString(),
        ...(expirationDate === null ? {} : { expirationDate }),
        previousExpirationDate,
        replacedExisting,
        requestedDurationMinutes: durationMinutes,
        verified,
        ...(level.reusedWithDifferentLevels ? { message: debugLevelDriftMessage(tierName, level) } : {}),
        ...(verified && !level.reusedWithDifferentLevels ? {} : {
          suggestion: verified
            ? 'The trace is active. Note that Salesforce\'s stored DebugLevel differs from the tier this Tool defines; the '
              + 'levels reported above are the stored ones, and a category at NONE writes no lines for that category.'
            : 'Salesforce accepted the write but a re-read did not confirm an active trace covering the requested window. '
              + 'Confirm it in Salesforce Setup before relying on it — a successful write is a claim, not a measurement.',
        }),
        hint: traceFlagHint(new Set(this.advertisedToolNames)),
      };
    } catch (error) {
      throw mapTraceFlagFailure(error);
    }
  }
}

export class ScopedApexLogExecutor implements ApexLogReader {
  public constructor(
    private readonly scope: RequestScope,
    private readonly advertisedToolNames: AdvertisedTools,
  ) {}

  public async execute(input: ApexLogsInput): Promise<ApexLogsOutput> {
    assertDiagnosticScope(this.scope, 'get_apex_logs');
    const timeWindowMinutes = input.timeWindowMinutes ?? APEX_LOG_DEFAULT_TIME_WINDOW_MINUTES;
    const limit = input.limit ?? APEX_LOG_DEFAULT_LIMIT;
    const windowStartedAt = new Date(Date.now() - timeWindowMinutes * 60_000).toISOString();
    try {
      const connection = await this.scope.getConnection();
      // The window bound is a `dateTime` literal and is emitted **unquoted**; the user filter is a string
      // literal and is quoted. The two are not interchangeable and the platform says so out loud — see
      // `soqlDateTimeLiteral`. Both values are in-process: the window from the clock, the user id from the
      // Tool's own schema, so neither carries text a caller could shape.
      const windowClause = `LastModifiedDate >= ${soqlDateTimeLiteral(windowStartedAt)}`
        + (input.userId === undefined ? '' : ` AND LogUserId = ${quoteSoqlLiteral(input.userId)}`);
      const scanned = readQueryRecords(await connection.tooling.query(
        `SELECT ${APEX_LOG_FIELD_LIST} FROM ApexLog WHERE ${windowClause} `
        + `ORDER BY LastModifiedDate DESC LIMIT ${APEX_LOG_SCAN_LIMIT}`,
      )).map(toApexLogEntry);
      // A separate aggregate, because the row limit above bounds what is *scanned*. `ApexLog` answers with
      // an aggregate record; `SetupAuditTrail` answers with an empty record list and the number in
      // `totalSize` (probe §4). A count that cannot be read is null rather than zero, because zero is a
      // claim about the org.
      const totalCount = await readApexLogTotal(connection, windowClause);
      const statusFilter = input.status;
      const filtered = statusFilter === undefined
        ? scanned
        : scanned.filter((entry) => entry.status === statusFilter);
      const observedStatuses = summarizeStatuses(scanned);
      const orderedStatuses = Object.entries(observedStatuses).map(([status, count]) => ({ status, count }));

      const build = (logs: readonly ApexLogEntry[]): ApexLogsOutput => {
        // Two different cuts reach here and they are not the same fact: rows the query did not return
        // because `limit` bounded them, and rows dropped afterwards to fit the response budget. Only the
        // second needs its own sentence, because it makes the list incomplete by *size* and a caller
        // cannot tell that from the counts alone.
        const budgetDropped = logs.length < Math.min(filtered.length, limit);
        const truncated = logs.length < filtered.length || scanned.length >= APEX_LOG_SCAN_LIMIT;
        // ADR-0029 §3's `A-1`: cross-user `ApexLog` visibility was never established, so an empty result
        // has two readings and the caller is told both. §3 keeps the hard error for a source that could
        // not be read at all; this is the ambiguous case, which is a result that says what it does not
        // know. It is attached whenever nothing was scanned, because every log the probe could see was its
        // own — so an empty org-wide window is as ambiguous as an empty filtered one.
        const caveat = scanned.length > 0
          ? undefined
          : 'No ApexLog row was visible in this window. Whether this deployment\'s diagnostic identity may read logs '
            + 'written by users other than itself is a deployment prerequisite (A-1) that has not been established, so '
            + 'this may be a permission boundary rather than a quiet org.';
        return {
          success: true,
          executionRole: 'DIAGNOSTIC',
          api: 'TOOLING',
          logs: [...logs],
          totalCount,
          returnedCount: logs.length,
          scannedCount: scanned.length,
          truncated,
          timeWindowMinutes,
          windowStartedAt,
          ...(statusFilter === undefined ? {} : { statusFilter }),
          observedStatuses: orderedStatuses,
          ...(caveat === undefined ? {} : { caveat }),
          ...(totalCount === null
            ? {
                suggestion: 'The window\'s total log count could not be read, so how much of the window this list covers '
                  + 'is unknown. Treat the list as a sample of the window rather than as the whole of it.',
              }
            : {}),
          hint: apexLogsHint(new Set(this.advertisedToolNames), {
            returnedCount: logs.length,
            totalCount,
            statusFilterApplied: statusFilter !== undefined,
            observedStatuses: orderedStatuses.map((entry) => entry.status),
            budgetDropped,
          }),
        };
      };
      return build(trimToByteBudget(filtered.slice(0, limit), DATA_MAX_RESPONSE_BYTES, build).kept);
    } catch (error) {
      throw mapApexLogFailure(error);
    }
  }
}

export class ScopedDebugLogBodyExecutor implements DebugLogBodyReader {
  public constructor(
    private readonly scope: RequestScope,
    private readonly advertisedToolNames: AdvertisedTools,
  ) {}

  public async execute(input: DebugLogBodyInput): Promise<DebugLogBodyOutput> {
    assertDiagnosticScope(this.scope, 'get_debug_log_body');
    const maxCharacters = input.maxCharacters ?? DEBUG_LOG_BODY_DEFAULT_MAX_CHARACTERS;
    try {
      const connection = await this.scope.getConnection();
      // The row is read first so a purged log is reported as a purged log. Salesforce drops ApexLog
      // bodies on a short platform-managed window (probe §1: the retained set moved from 5 rows to 9
      // within a day), and "Salesforce no longer has it" is a fact about the log rather than a fault in
      // this Tool — so it arrives as its own error instead of as an empty body.
      const row = readQueryRecords(await connection.tooling.query(
        `SELECT Id, LogLength, LastModifiedDate FROM ApexLog WHERE Id = ${quoteSoqlLiteral(input.logId)} LIMIT 1`,
      ))[0];
      if (row === undefined) {
        throw new ContextRuntimeError(
          'MCP_DEBUG_LOG_BODY_NOT_FOUND',
          `No ApexLog row with id ${input.logId} is retained, so its body cannot be read.`,
          {
            prerequisite: 'A-2',
            suggestion: 'Apex log retention is short and platform-managed, so this log has most likely already been purged. '
              + 'Re-open a trace on the target and reproduce the problem to write a new one, then list the logs again.',
          },
        );
      }
      const path = `/services/data/v${connection.getApiVersion()}/tooling/sobjects/ApexLog/${input.logId}/Body`;
      const body: unknown = await connection.request<unknown>({ method: 'GET', url: path });
      // Measured as a string; anything else is stringified rather than dropped, because an unexpected
      // shape is still evidence and the parser reports it as NOT_A_LOG rather than as a success.
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      if (text.length === 0) {
        throw new ContextRuntimeError(
          'MCP_DEBUG_LOG_BODY_NOT_FOUND',
          `The retained ApexLog row ${input.logId} has an empty body.`,
          {
            prerequisite: 'A-2',
            suggestion: 'Salesforce still lists the row but returned no log text, which means the body has been purged while '
              + 'the row has not. Re-open a trace and reproduce the problem to write a fresh log.',
          },
        );
      }
      // The *whole* body is parsed, not the returned prefix: the failure this Tool exists to locate is
      // written at the end of the log, which is exactly where the budget cuts. The summary is a fact about
      // the log Salesforce returned; `truncated` is a fact about how much of it is echoed back.
      //
      // The parser is a pure module and returns frozen readonly collections; the Tool's output schema is
      // the wire contract and its arrays are mutable. Copying at this one boundary keeps `readonly` as the
      // parser's internal style without weakening the schema every other consumer relies on.
      const parsedHeader = parseApexLogHeader(text);
      const headerSummary: DebugLogHeaderSummary = {
        ...parsedHeader,
        categories: [...parsedHeader.categories],
        stackSummary: [...parsedHeader.stackSummary],
        thrownExceptions: [...parsedHeader.thrownExceptions],
      };
      const candidate = text.slice(0, maxCharacters);
      const segments: string[] = [];
      for (let index = 0; index < candidate.length; index += DEBUG_LOG_BODY_SEGMENT_CHARACTERS) {
        segments.push(candidate.slice(index, index + DEBUG_LOG_BODY_SEGMENT_CHARACTERS));
      }
      const build = (kept: readonly string[]): DebugLogBodyOutput => {
        const returned = kept.join('');
        const truncated = returned.length < text.length;
        return {
          success: true,
          executionRole: 'DIAGNOSTIC',
          api: 'TOOLING',
          logId: input.logId,
          headerSummary,
          body: returned,
          totalBytes: Buffer.byteLength(text, 'utf8'),
          returnedBytes: Buffer.byteLength(returned, 'utf8'),
          totalCharacters: text.length,
          returnedCharacters: returned.length,
          maxCharacters,
          truncated,
          logLength: asNumber(row.LogLength),
          lastModifiedDate: asString(row.LastModifiedDate),
          hint: debugLogBodyHint(new Set(this.advertisedToolNames), {
            truncated,
            maxCharacters,
            parseStatus: headerSummary.parseStatus,
            apexClass: headerSummary.apexClass,
            lineNumber: headerSummary.lineNumber,
          }),
        };
      };
      return build(trimToByteBudget(segments, DATA_MAX_RESPONSE_BYTES, build).kept);
    } catch (error) {
      throw mapDebugLogBodyFailure(error);
    }
  }
}

type DebugLevelResolution = Readonly<{
  id: string;
  created: boolean;
  levels: Readonly<Record<DebugLevelField, DebugLevelValue>>;
  /** True when a reused level's stored settings differ from the tier this Tool defines for that name. */
  reusedWithDifferentLevels: boolean;
}>;

/**
 * Resolve-or-create the tier's `DebugLevel`.
 *
 * Not a lookup, and the measured reason is probe §3: the org's only stored level is `SFDC_DevConsole`,
 * whose `ApexProfiling` is `INFO` — the *sampling* level, the one setting a profiling investigation
 * cannot use. Depending on a stored level would therefore mean either shipping a tier that silently
 * samples, or refusing to trace at all.
 *
 * Creation is confined to this Tool's own `SFOA_P10_` prefix, so a level of the caller's is never
 * adopted, edited or overwritten. A level found under the prefix is reused as it is stored — and when
 * its stored settings differ from the tier definition, the difference is reported rather than repaired,
 * because a level somebody adjusted deliberately is configuration this Tool does not own.
 */
async function resolveOrCreateDebugLevel(
  connection: Connection,
  tierName: keyof typeof DEBUG_LEVEL_TIERS,
): Promise<DebugLevelResolution> {
  const tier = DEBUG_LEVEL_TIERS[tierName];
  const byName = `SELECT Id, DeveloperName, MasterLabel, ${DEBUG_LEVEL_FIELD_LIST} FROM DebugLevel `
    + `WHERE DeveloperName = ${quoteSoqlLiteral(tier.developerName)}`;
  const found = readQueryRecords(await connection.tooling.query(byName))[0];
  const foundId = found === undefined ? null : asString(found.Id);
  if (found !== undefined && foundId !== null) {
    const levels = readDebugLevelLevels(found);
    return {
      id: foundId,
      created: false,
      levels,
      reusedWithDifferentLevels: DEBUG_LEVEL_FIELDS.some((field) => levels[field] !== tier.levels[field]),
    };
  }
  const created = readWriteResult(
    await toolingSObject(connection, 'DebugLevel').create({ ...debugLevelCreatePayload(tier) }),
  );
  if (created.id === null || !created.success) {
    throw new ContextRuntimeError(
      'MCP_TRACE_FLAG_WRITE_FAILED',
      `Salesforce refused to create the ${tier.developerName} DebugLevel this trace needs.`,
      {
        cause: created.errors[0],
        suggestion: 'Trace administration on this org requires the ability to create a DebugLevel. Check the diagnostic '
          + 'account\'s trace-administration permission (deployment prerequisite A-3).',
      },
    );
  }
  // Re-read rather than echoing what was sent: the ten levels reported are the ones the org stored, and a
  // create response does not carry the defaults it filled in.
  const stored = readQueryRecords(await connection.tooling.query(
    `SELECT Id, DeveloperName, MasterLabel, ${DEBUG_LEVEL_FIELD_LIST} FROM DebugLevel `
      + `WHERE Id = ${quoteSoqlLiteral(created.id)}`,
  ))[0];
  return {
    id: created.id,
    created: true,
    levels: stored === undefined ? tierLevels(tierName) : readDebugLevelLevels(stored),
    reusedWithDifferentLevels: false,
  };
}

function tierLevels(tierName: keyof typeof DEBUG_LEVEL_TIERS): Readonly<Record<DebugLevelField, DebugLevelValue>> {
  const levels = DEBUG_LEVEL_TIERS[tierName].levels;
  return Object.freeze(Object.fromEntries(
    DEBUG_LEVEL_FIELDS.map((field) => [field, levels[field]]),
  ) as Record<DebugLevelField, DebugLevelValue>);
}

function debugLevelDriftMessage(
  tierName: keyof typeof DEBUG_LEVEL_TIERS,
  level: DebugLevelResolution,
): string {
  const tier = DEBUG_LEVEL_TIERS[tierName];
  const differing = DEBUG_LEVEL_FIELDS
    .filter((field) => level.levels[field] !== tier.levels[field])
    .map((field) => `${field} is ${level.levels[field]} instead of ${tier.levels[field]}`);
  return `The existing ${tier.developerName} DebugLevel was reused as stored, not as this Tool defines it: `
    + `${differing.join('; ')}. It was not modified — a level under this prefix that was adjusted deliberately is `
    + 'configuration this Tool does not own. A category shown here at NONE writes no lines for that category.';
}

type TraceFlagRow = Readonly<{
  id: string;
  logType: string | null;
  startDate: string | null;
  expirationDate: string | null;
}>;

async function readTraceFlagsForEntity(
  connection: Connection,
  tracedEntityId: string,
): Promise<readonly TraceFlagRow[]> {
  // Filtered by entity, not by window: Salesforce does not garbage-collect expired flags — the probe
  // found 9 pre-existing rows, the oldest from 2015 — so "a row exists for this entity" is history and
  // not an active trace. The active subset is computed in memory against the current clock.
  const records = readQueryRecords(await connection.tooling.query(
    `SELECT ${TRACE_FLAG_FIELD_LIST} FROM TraceFlag WHERE TracedEntityId = ${quoteSoqlLiteral(tracedEntityId)}`,
  ));
  return records
    .map((record) => Object.freeze({
      id: asString(record.Id) ?? '',
      logType: asString(record.LogType),
      startDate: asString(record.StartDate),
      expirationDate: asString(record.ExpirationDate),
    }))
    .filter((row) => row.id.length > 0);
}

async function readTraceFlagById(connection: Connection, id: string): Promise<TraceFlagRow | null> {
  const record = readQueryRecords(await connection.tooling.query(
    `SELECT ${TRACE_FLAG_FIELD_LIST} FROM TraceFlag WHERE Id = ${quoteSoqlLiteral(id)}`,
  ))[0];
  if (record === undefined) return null;
  return Object.freeze({
    id,
    logType: asString(record.LogType),
    startDate: asString(record.StartDate),
    expirationDate: asString(record.ExpirationDate),
  });
}

function isExpired(expirationDate: string | null, now: Date): boolean {
  return expiryMs(expirationDate) <= now.getTime();
}

/** Epoch milliseconds, or 0 for a missing or unparseable value — which reads as "long expired". */
function expiryMs(expirationDate: string | null): number {
  if (expirationDate === null) return 0;
  const parsed = Date.parse(expirationDate);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The refusal a create can legitimately produce here, named in the platform's own terms.
 *
 * `FIELD_INTEGRITY_EXCEPTION` on an overlapping create is the measured behaviour (probe §2): Salesforce
 * refuses a second flag for an entity whose window overlaps an open one, and the refusal names the traced
 * entity. When that happens and this Tool can see the conflicting rows, they are listed — so the remedy
 * ("let it expire, or trace the other kind") is available instead of the caller having to guess why an
 * ordinary call was refused.
 */
function traceFlagWriteRefusal(
  errors: readonly string[],
  activeConflicts: readonly TraceFlagRow[],
): ContextRuntimeError {
  const detail = errors.length === 0 ? '' : ` Salesforce said: ${errors[0]}`;
  if (activeConflicts.length === 0) {
    return new ContextRuntimeError(
      'MCP_TRACE_FLAG_INVALID',
      `Salesforce refused to open this trace.${detail}`,
      {
        suggestion: 'Check that the traced entity id exists and that the diagnostic account may administer traces '
          + '(deployment prerequisite A-3), then retry once.',
      },
    );
  }
  const listed = activeConflicts
    .slice(0, 5)
    .map((flag) => `${flag.id} (${flag.logType ?? 'unknown LogType'}, expires ${flag.expirationDate ?? 'unknown'})`)
    .join('; ');
  return new ContextRuntimeError(
    'MCP_TRACE_FLAG_INVALID',
    'Salesforce refused to open this trace because a flag of a different kind is already active for this entity: '
      + `${listed}.${detail}`,
    {
      // Deliberately no `prerequisite`: nothing in ADR-0029 §2's deployment list is missing here. This is
      // the platform's own overlap rule answering a real configuration conflict, not a permission gap.
      suggestion: 'An active TraceFlag blocks a new flag whose window overlaps it, and this Tool extends only a flag of the '
        + 'same LogType — changing another flag\'s LogType would repurpose a trace somebody else opened. Let the conflicting '
        + 'flag expire, then call this again.',
    },
  );
}

async function readApexLogTotal(connection: Connection, windowClause: string): Promise<number | null> {
  const { records, totalSize } = readQueryResult(await connection.tooling.query(
    `SELECT COUNT(Id) total FROM ApexLog WHERE ${windowClause}`,
  ));
  const first = records[0];
  if (first !== undefined) {
    const total = asNumber(first.total) ?? asNumber(first.expr0);
    if (total !== null) return total;
  }
  // The record-less form. `SetupAuditTrail` answers `SELECT COUNT()` with an empty `records` array and
  // puts the number in `totalSize` (probe §4), and code reading `records[0].expr0` would report zero.
  // `totalSize` is only trustworthy here when no record came back, because for an ordinary query it is
  // the size of that page rather than of the result set.
  if (records.length === 0 && totalSize !== null) return totalSize;
  return null;
}

function summarizeStatuses(entries: readonly ApexLogEntry[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const status = entry.status;
    if (status === null) continue;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return Object.freeze(Object.fromEntries(
    [...counts.entries()].sort(([leftStatus, leftCount], [rightStatus, rightCount]) => (
      rightCount - leftCount || leftStatus.localeCompare(rightStatus, 'en-US')
    )),
  ));
}

function toApexLogEntry(record: Record<string, unknown>): ApexLogEntry {
  const logUser = isRecord(record.LogUser) ? record.LogUser : {};
  return Object.freeze({
    id: asString(record.Id) ?? '',
    logUserId: asString(record.LogUserId),
    logUserName: asString(logUser.Name) ?? asString(record['LogUser.Name']),
    logUserUsername: asString(logUser.Username) ?? asString(record['LogUser.Username']),
    application: asString(record.Application),
    operation: asString(record.Operation),
    // Verbatim, untranslated: this is what the org stores, and `observedStatuses` exists so a caller
    // never has to guess which spelling the filter needs.
    status: asString(record.Status),
    durationMilliseconds: asNumber(record.DurationMilliseconds),
    logLength: asNumber(record.LogLength),
    startTime: asString(record.StartTime),
    lastModifiedDate: asString(record.LastModifiedDate),
  });
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

type WriteResult = Readonly<{ id: string | null; success: boolean; errors: readonly string[] }>;

/** The Tooling write surface is structural, so a jsforce signature change cannot silently pass. */
type ToolingSObjectApi = Readonly<{
  create(input: Record<string, unknown>): Promise<unknown>;
  update(input: Record<string, unknown>): Promise<unknown>;
}>;

function toolingSObject(connection: Connection, sobject: string): ToolingSObjectApi {
  return connection.tooling.sobject(sobject) as unknown as ToolingSObjectApi;
}

/**
 * Creates the `TraceFlag`, translating the platform's own refusal into the one that names its cause.
 *
 * The refusal is caught here rather than left to `mapTraceFlagFailure` for one reason: the active flags
 * are in scope at this point and nowhere further out, and an overlap refusal is only actionable if it
 * says *which* flag is in the way. jsforce rejects a refused create instead of resolving with
 * `success: false`, so without this the measured `FIELD_INTEGRITY_EXCEPTION` would arrive as a generic
 * write failure and the operator would have to go and find the conflicting row by hand.
 *
 * `traceFlagWriteRefusal` deliberately stays the translator for every other shape of refusal, including
 * the resolve-with-failure one, so there is a single wording for "Salesforce refused this trace".
 */
async function createTraceFlag(
  connection: Connection,
  payload: Record<string, unknown>,
  activeFlags: readonly TraceFlagRow[],
): Promise<WriteResult> {
  try {
    return readWriteResult(await toolingSObject(connection, 'TraceFlag').create(payload));
  } catch (error) {
    const failure = readSalesforceFailure(error);
    if (failure.code !== null && failure.code.toLocaleUpperCase('en-US') === 'FIELD_INTEGRITY_EXCEPTION') {
      throw traceFlagWriteRefusal(failure.message === null ? [] : [failure.message], activeFlags);
    }
    throw error;
  }
}

async function updateToolingRecord(
  connection: Connection,
  sobject: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const result = readWriteResult(await toolingSObject(connection, sobject).update(payload));
  if (!result.success) {
    throw new ContextRuntimeError(
      'MCP_TRACE_FLAG_WRITE_FAILED',
      `Salesforce refused to extend the existing ${sobject} row.`,
      {
        cause: result.errors[0],
        suggestion: 'Retry once. If the refusal repeats, the conflicting flag has to be changed in Salesforce Setup before '
          + 'this Tool can extend it.',
      },
    );
  }
}

function readWriteResult(value: unknown): WriteResult {
  // A single-record write answers with one object and a batched one with an array; only the first is read
  // because every payload this module writes is a single record.
  const entry = Array.isArray(value) ? value[0] : value;
  const record = isRecord(entry) ? entry : {};
  return Object.freeze({
    id: asString(record.id) ?? asString(record.Id),
    success: record.success === true,
    errors: Object.freeze((Array.isArray(record.errors) ? record.errors : [])
      .map((error) => (isRecord(error) && typeof error.message === 'string' ? error.message : String(error)))
      .slice(0, 5)),
  });
}

const PERMISSION_DENIAL_CODES = [
  'INSUFFICIENT_ACCESS',
  'INSUFFICIENT_ACCESS_OR_READONLY',
  'INSUFFICIENT_PRIVILEGES',
  'API_DISABLED_FOR_ORG',
  'INVALID_TYPE',
] as const;

function isPermissionDenial(code: string | null): boolean {
  if (code === null) return false;
  const normalized = code.toLocaleUpperCase('en-US');
  return PERMISSION_DENIAL_CODES.some((denial) => denial === normalized);
}

/**
 * ADR-0029 §3, on the write path: a permission the deployment has not granted is a structured error
 * naming its prerequisite, never a quiet failure. `A-3` is the trace-administration prerequisite,
 * because that is the one whose absence decides whether this Tool can serve its primary use case.
 */
function mapTraceFlagFailure(error: unknown): ContextRuntimeError {
  if (error instanceof ContextRuntimeError) return error;
  const failure = readSalesforceFailure(error);
  if (failure.code !== null && failure.code.toLocaleUpperCase('en-US') === 'FIELD_INTEGRITY_EXCEPTION') {
    return new ContextRuntimeError(
      'MCP_TRACE_FLAG_INVALID',
      'Salesforce refused this trace because another flag\'s window overlaps it for the same traced entity.',
      {
        cause: error,
        salesforceErrorCode: failure.code,
        suggestion: 'This is the measured overlap refusal: a flag already covers this entity across the requested window. '
          + 'Let it expire, then call this again — this Tool extends only a flag of the same LogType.',
      },
    );
  }
  if (isPermissionDenial(failure.code)) {
    return new ContextRuntimeError(
      'MCP_DIAGNOSTIC_PREREQUISITE_MISSING',
      'Salesforce refused the trace-administration call this Tool needs.',
      {
        cause: error,
        ...(failure.code === null ? {} : { salesforceErrorCode: failure.code }),
        prerequisite: 'A-3',
        suggestion: 'Trace administration on another user requires a permission grant on the diagnostic account itself, not '
          + 'on the calling user — deployment prerequisite A-3. It was measured as present on the T1 probe org, so a refusal '
          + 'here means this deployment\'s account lacks it.',
      },
    );
  }
  return new ContextRuntimeError(
    'MCP_TRACE_FLAG_WRITE_FAILED',
    'Salesforce could not complete the trace-administration call for this request.',
    {
      cause: error,
      ...(failure.code === null ? {} : { salesforceErrorCode: failure.code }),
      suggestion: 'Retry once. If it fails again, check the diagnostic account\'s trace-administration access and the traced '
        + 'entity id.',
    },
  );
}

function mapApexLogFailure(error: unknown): ContextRuntimeError {
  if (error instanceof ContextRuntimeError) return error;
  const failure = readSalesforceFailure(error);
  if (isPermissionDenial(failure.code)) {
    return new ContextRuntimeError(
      'MCP_DIAGNOSTIC_PREREQUISITE_MISSING',
      'Salesforce refused to list this org\'s Apex debug logs for this request.',
      {
        cause: error,
        ...(failure.code === null ? {} : { salesforceErrorCode: failure.code }),
        prerequisite: 'A-1',
        suggestion: 'Reading ApexLog requires log visibility on the diagnostic account — deployment prerequisite A-1. This is '
          + 'an org permission rather than something this Tool can widen, so it has to be granted before the Tool is enabled.',
      },
    );
  }
  return new ContextRuntimeError(
    'MCP_APEX_LOG_READ_FAILED',
    'Salesforce could not return this org\'s Apex debug logs for this request.',
    {
      cause: error,
      ...(failure.code === null ? {} : { salesforceErrorCode: failure.code }),
      suggestion: 'Retry once. If it fails again, the Tooling API or the diagnostic identity\'s API access needs checking. A '
        + 'failed read never returns an empty list, because an empty list would read as "nothing went wrong".',
    },
  );
}

function mapDebugLogBodyFailure(error: unknown): ContextRuntimeError {
  if (error instanceof ContextRuntimeError) return error;
  const failure = readSalesforceFailure(error);
  const normalized = failure.code?.toLocaleUpperCase('en-US');
  if (normalized === 'NOT_FOUND' || normalized === 'INVALID_ID_FIELD' || normalized === 'ENTITY_IS_DELETED') {
    return new ContextRuntimeError(
      'MCP_DEBUG_LOG_BODY_NOT_FOUND',
      'Salesforce no longer has the body of this Apex log.',
      {
        cause: error,
        salesforceErrorCode: failure.code ?? undefined,
        prerequisite: 'A-2',
        suggestion: 'Apex log retention is short and platform-managed, so this log has been purged. Re-open a trace on the '
          + 'target and reproduce the problem to write a new one.',
      },
    );
  }
  if (normalized === 'INSUFFICIENT_ACCESS' || normalized === 'INSUFFICIENT_ACCESS_OR_READONLY'
    || normalized === 'INSUFFICIENT_PRIVILEGES') {
    return new ContextRuntimeError(
      'MCP_DIAGNOSTIC_PREREQUISITE_MISSING',
      'Salesforce refused to return this Apex log\'s body for this request.',
      {
        cause: error,
        salesforceErrorCode: failure.code ?? undefined,
        prerequisite: 'A-1',
        suggestion: 'Reading ApexLog requires log visibility on the diagnostic account — deployment prerequisite A-1. The log '
          + 'may also belong to another user, which is the case `A-1` covers.',
      },
    );
  }
  return new ContextRuntimeError(
    'MCP_DEBUG_LOG_BODY_READ_FAILED',
    'Salesforce could not return this Apex log\'s body for this request.',
    {
      cause: error,
      ...(failure.code === null ? {} : { salesforceErrorCode: failure.code }),
      suggestion: 'Retry once, then re-run get_apex_logs to confirm the log is still retained.',
    },
  );
}

/** SOQL string-literal escaping. Every value quoted here is schema-bounded, never free text. */
function quoteSoqlLiteral(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/**
 * A SOQL `dateTime` literal, emitted **unquoted** — which is what the platform requires and this org enforces.
 *
 * Quoting it was the first version of this file, and the T2 live milestone found what it costs: the whole
 * Tool failed with `MCP_APEX_LOG_READ_FAILED` over `INVALID_FIELD` — *"value of filter criterion for field
 * `LastModifiedDate` must be of type dateTime and should not be enclosed in quotes"*. A quoted literal is a
 * **string** literal, and the Tooling API at v68.0 no longer accepts one where a dateTime belongs. The T1
 * probe could not have caught it: its `ApexLog` queries carried no `WHERE` clause (probe §1), so no
 * dateTime literal had ever been sent.
 *
 * Safety is structural rather than incidental. The shape is re-validated here instead of trusted, and the
 * only values ever passed in are produced in-process by `Date#toISOString()` on a window computed from the
 * clock — no part of this string can come from a caller or from org data, which is what makes emitting it
 * outside quotes acceptable rather than an injection surface.
 */
function soqlDateTimeLiteral(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) {
    throw new ContextRuntimeError(
      'MCP_APEX_LOG_INVALID',
      'The time window for this request could not be expressed as a SOQL dateTime literal.',
      { suggestion: 'This is an internal failure rather than a problem with the request: please report it.' },
    );
  }
  return value;
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

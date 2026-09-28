import type { OrgService } from '@salesforce/mcp-provider-api';
import { DataRuntimeError } from './errors.js';
import { readArray, readBoolean, readField } from './list-sobjects-executor.js';
import { resolveRequestConnection } from './org-connection.js';
import { DATA_MAX_QUERY_TEXT_CHARACTERS, DATA_MAX_RESPONSE_BYTES, trimToByteBudget, trimToCharacterBudget } from './response-budget.js';
import { mapDataFailure, type DataFailureMapping } from './salesforce-errors.js';
import { inspectSoqlQuery } from './soql.js';
import {
  QUERY_RECORDS_DEFAULT_MAX_ROWS,
  QUERY_RECORDS_TIME_BUDGET_MS,
  type QueryRecordsInput,
  type QueryRecordsOutput,
  type QueryTruncationReason,
} from './schemas.js';

/** Tools a truncation hint may recommend, by the name they are advertised under. */
export const BULK_QUERY_TOOL_NAME = 'submit_bulk_query';
export const ORG_LIMITS_TOOL_NAME = 'get_org_limits';

export type QueryRecordsExecutorOptions = Readonly<{
  /**
   * The SFOA Data Tools currently advertised in this session. A hint may only name a Tool
   * the caller can actually call, so the bulk export is recommended by name only when it is
   * in this set — otherwise the hint says to ask an administrator, because sending an Agent
   * after a Tool that `tools/list` does not contain costs it a turn to discover that.
   */
  enabledToolNames?: readonly string[];
  /** Injected so tests can exercise the continuation budget without waiting. */
  timeBudgetMs?: number;
  now?: () => number;
}>;

/** One Salesforce batch, as this Tool reads it. */
export type QueryBatch = Readonly<{
  records: readonly Readonly<Record<string, unknown>>[];
  totalSize: number | null;
  done: boolean;
  nextRecordsUrl: string | null;
}>;

/**
 * Executes a SOQL statement and follows `nextRecordsUrl` until the platform says the result
 * is done, the caller's row budget is reached, or the continuation budget runs out.
 *
 * This is the capability `run_soql_query` structurally cannot provide: the official Tool
 * performs exactly one request, so on any result larger than one batch it returns the first
 * batch with nothing to distinguish that from a complete answer. Here every result states
 * `totalSize`, `fetched`, `returnedCount`, `done`, `complete` and — whenever the answer is
 * not the whole result — which constraint bound it.
 */
export class QueryRecordsExecutor {
  private readonly enabledToolNames: readonly string[];

  public constructor(
    private readonly orgService: OrgService,
    private readonly options: QueryRecordsExecutorOptions = {},
  ) {
    this.enabledToolNames = options.enabledToolNames ?? [];
  }

  public async execute(input: QueryRecordsInput): Promise<QueryRecordsOutput> {
    const maxRows = input.maxRows ?? QUERY_RECORDS_DEFAULT_MAX_ROWS;
    const useToolingApi = input.useToolingApi === true;
    try {
      // Re-inspected here rather than trusted from the caller: the registered wire schema is
      // a raw shape whose JSON Schema cannot express these rules (see ADR-0024), so a caller
      // that reaches this class without the Tool's own parse must still not be able to hand
      // Salesforce a statement this Tool refuses to run.
      const inspection = inspectSoqlQuery(input.query);
      if (!inspection.usable) {
        throw new DataRuntimeError('MCP_DATA_INVALID_INPUT', `Invalid Data Tool input: query: ${inspection.message}`);
      }
      const connection = await resolveRequestConnection(this.orgService);
      const fetch = async (statement: string): Promise<QueryBatch> => (useToolingApi
        ? readBatch(await connection.tooling.query(statement))
        : readBatch(await connection.query(statement)));
      const fetchMore = async (cursor: string): Promise<QueryBatch> => (useToolingApi
        ? readBatch(await connection.tooling.queryMore(cursor))
        : readBatch(await connection.queryMore(cursor)));

      const collected = await this.collect(fetch, fetchMore, input.query, maxRows);
      return this.render({ collected, useToolingApi, aggregate: inspection.aggregate });
    } catch (error) {
      throw mapDataFailure(error, queryFailureMapping(useToolingApi, this.hasTool(ORG_LIMITS_TOOL_NAME)));
    }
  }

  private hasTool(name: string): boolean {
    return this.enabledToolNames.includes(name);
  }

  /**
   * Walks the batch chain, never collecting more than `maxRows` rows.
   *
   * `reason` records *why fetching stopped* and nothing else. Whether the returned slice is
   * also shorter than what was fetched is a separate question, decided later by the response
   * budget — the only thing that can cut it.
   */
  private async collect(
    fetch: (statement: string) => Promise<QueryBatch>,
    fetchMore: (cursor: string) => Promise<QueryBatch>,
    query: string,
    maxRows: number,
  ): Promise<CollectedQuery> {
    const now = this.options.now ?? Date.now;
    const budgetMs = this.options.timeBudgetMs ?? QUERY_RECORDS_TIME_BUDGET_MS;
    const startedAt = now();
    const records: Readonly<Record<string, unknown>>[] = [];
    let batch = await fetch(query);
    let pages = 1;
    let totalSize = batch.totalSize;
    let done = batch.done;
    let reason: QueryTruncationReason | null = null;

    for (;;) {
      const remaining = maxRows - records.length;
      if (batch.records.length > remaining) {
        records.push(...batch.records.slice(0, remaining));
        reason = 'MAX_ROWS';
        break;
      }
      records.push(...batch.records);
      if (done) break;
      if (records.length >= maxRows) {
        reason = 'MAX_ROWS';
        break;
      }
      if (batch.nextRecordsUrl === null) {
        // The platform reported more rows but handed out no cursor to reach them. Reporting
        // `done` here would claim a completeness that was never established.
        reason = 'PAGINATION_UNAVAILABLE';
        break;
      }
      if (now() - startedAt >= budgetMs) {
        reason = 'TIME_BUDGET';
        break;
      }
      batch = await fetchMore(batch.nextRecordsUrl);
      pages += 1;
      totalSize = batch.totalSize ?? totalSize;
      done = batch.done;
    }

    return Object.freeze({ records: Object.freeze(records), totalSize, done, pages, reason });
  }

  /**
   * Applies the two response budgets and composes the answer.
   *
   * The byte budget bounds the structured payload and the character budget bounds the text
   * the Agent reads; the two are measured in the unit each is consumed in. Both measure the
   * *fully composed* output — including the hint and the truncation flags that make the
   * result honest — so a payload can never be pushed over budget by its own explanation of
   * why it is short. Composing is pure, so measuring a candidate prefix and returning the
   * final prefix are the same operation applied twice.
   */
  private render(state: RenderState): QueryRecordsOutput {
    const byBytes = trimToByteBudget(
      state.collected.records,
      DATA_MAX_RESPONSE_BYTES,
      (kept) => this.build(state, kept),
    );
    const byCharacters = trimToCharacterBudget(
      byBytes.kept,
      DATA_MAX_QUERY_TEXT_CHARACTERS,
      (kept) => this.build(state, kept),
    );
    return this.build(state, byCharacters.kept);
  }

  private build(
    state: RenderState,
    records: readonly Readonly<Record<string, unknown>>[],
  ): QueryRecordsOutput {
    const { collected, useToolingApi, aggregate } = state;
    const fetched = collected.records.length;
    const returned = records.length;
    // A shorter returned slice can only mean the response budget cut it: fetching never
    // returns fewer rows than it collected.
    const budgetCut = returned < fetched;
    // A platform that reports `done` while handing back fewer rows than its own `totalSize`
    // has declared the result incomplete with no cursor to finish it. Reading that as a
    // complete answer would be the exact failure this Tool exists to prevent.
    const declaredShort = collected.done && collected.totalSize !== null && fetched < collected.totalSize;
    const fetchReason = collected.reason ?? (declaredShort ? 'PAGINATION_UNAVAILABLE' : null);
    const bindings = [
      ...(fetchReason === null ? [] : [fetchReason]),
      ...(budgetCut ? ['RESPONSE_BUDGET'] : []),
    ];
    const truncated = bindings.length > 0;
    // The enum carries one reason, and it is the one that bound the *returned* slice: a
    // budget cut is what an Agent holding these records has to work around. The hint still
    // names every binding, so nothing about why fetching stopped is lost.
    const truncatedReason: QueryTruncationReason | null = budgetCut ? 'RESPONSE_BUDGET' : fetchReason;
    const complete = collected.done && collected.totalSize !== null
      && fetched === collected.totalSize && !budgetCut;
    const hint = queryHint(
      { ...state, fetched, returned, bindings, complete, truncated, truncatedReason },
      this.enabledToolNames,
    );
    return {
      success: true,
      executionRole: 'USER',
      api: 'REST',
      useToolingApi,
      aggregate,
      records: [...records],
      totalSize: collected.totalSize,
      fetched,
      returnedCount: returned,
      pages: collected.pages,
      done: collected.done,
      complete,
      truncated,
      truncatedReason,
      ...(hint === null ? {} : { hint }),
    };
  }
}

/**
 * Reads the subset of a batch payload this Tool uses, validating rather than trusting it.
 *
 * A non-object entry cannot be a Salesforce row, so it is dropped instead of reported as a
 * record an Agent would then try to read a field out of.
 */
export function readBatch(value: unknown): QueryBatch {
  return Object.freeze({
    records: Object.freeze(readArray(readField(value, 'records')).filter(isPlainRecord)),
    totalSize: readNonNegativeInteger(readField(value, 'totalSize')),
    done: readBoolean(readField(value, 'done')),
    nextRecordsUrl: readCursor(readField(value, 'nextRecordsUrl')),
  });
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readCursor(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The next step for a result that is not the whole answer, worded around what actually
 * bound it: a low `maxRows` is the caller's to raise, a time or response budget is worked
 * around with an aggregate or a narrower filter, and a platform that stops handing out
 * continuation cursors is not the caller's to fix at all.
 */
function queryHint(state: RenderInput, enabledToolNames: readonly string[]): string | null {
  const total = state.collected.totalSize;
  if (!state.truncated) {
    if (state.complete) return `Complete result: all ${total} matching rows are included.`;
    return state.collected.done && total === null
      ? 'Salesforce did not report a total size for this query, so completeness cannot be confirmed from this response alone. Re-run it as a COUNT() query to establish the total.'
      : null;
  }
  const binding = state.bindings.join(' + ');
  const detail = `${state.fetched} of ${total ?? 'an unreported number of'} matching rows were read, and ${state.returned} of those are included in records.`;
  if (state.aggregate) {
    // An aggregate is bounded by its grouping, not by the size of the org, so a truncation
    // here is a budget problem rather than a data-size problem — a different fix entirely.
    const fix = state.truncatedReason === 'MAX_ROWS'
      ? `re-query with maxRows above ${state.collected.records.length} to receive every group`
      : 'reduce the number of groups (narrow the WHERE clause) or the width of each row (drop unneeded fields)';
    return `Truncated by ${binding}. ${detail} This is an aggregate query, so its result is bounded by the grouping rather than by the size of the org: ${fix}.`;
  }
  const bulk = enabledToolNames.includes(BULK_QUERY_TOOL_NAME)
    ? `call ${BULK_QUERY_TOOL_NAME} to export the full detail set`
    : 'ask an administrator to enable the bulk query capability for the full detail set';
  return `Truncated by ${binding}. ${detail} `
    + 'Next: if a total or a breakdown answers the question, re-query with COUNT() or GROUP BY, which returns a bounded result; '
    + `otherwise narrow the WHERE clause and order by an indexed field to walk the rest of the result set, or ${bulk}.`;
}

type CollectedQuery = Readonly<{
  records: readonly Readonly<Record<string, unknown>>[];
  totalSize: number | null;
  done: boolean;
  pages: number;
  reason: QueryTruncationReason | null;
}>;

type RenderState = Readonly<{
  collected: CollectedQuery;
  useToolingApi: boolean;
  aggregate: boolean;
}>;

type RenderInput = RenderState & Readonly<{
  fetched: number;
  returned: number;
  /** Every constraint that shortened the answer, in the order they applied. */
  bindings: readonly string[];
  complete: boolean;
  truncated: boolean;
  truncatedReason: QueryTruncationReason | null;
}>;

/**
 * Error mapping for `query_records`.
 *
 * `INVALID_TYPE` is the interesting case: it means "this object is not visible through the
 * API you asked", which for a SOQL Tool is most often the data/Tooling split rather than a
 * typo. The suggestion therefore names the *opposite* API, so a second attempt is informed
 * instead of a repeat. The quota and permission branches are worded conditionally because a
 * suggestion may only name a Tool this session actually advertises.
 */
function queryFailureMapping(useToolingApi: boolean, hasOrgLimitsTool: boolean): DataFailureMapping {
  const otherApi = useToolingApi
    ? 'This query used the Tooling API; a business object is read with useToolingApi=false.'
    : 'This query used the data API; a Tooling object (ApexClass, ApexTrigger, a metadata component) is read with useToolingApi=true.';
  return {
    fallbackCode: 'MCP_QUERY_RECORDS_FAILED',
    fallbackMessage: 'Salesforce could not return the queried records for this request.',
    fallbackSuggestion: 'Retry once; if it fails again, verify the object and field names with describe_sobject before rewriting the query.',
    rules: [
      {
        codes: ['INVALID_FIELD', 'INVALID_TYPE', 'INVALID_SOBJECT', 'INVALID_ENTITY', 'NOT_FOUND'],
        code: 'MCP_QUERY_FIELD_INVALID',
        message: 'The query names a field or object that Salesforce does not expose to this request\'s identity.',
        suggestion: `Call describe_sobject for the object to read its real field and relationship names, and list_sobjects to confirm the object API name, then correct the query and retry. ${otherApi}`,
      },
      {
        codes: ['MALFORMED_QUERY', 'INVALID_QUERY', 'INVALID_QUERY_FILTER_OPERATOR', 'INVALID_QUERY_LOCATOR', 'UNSUPPORTED_QUERY'],
        code: 'MCP_QUERY_MALFORMED',
        message: 'Salesforce rejected the SOQL statement as malformed.',
        suggestion: 'Fix the statement and retry: SOQL cannot join tables, so read a related field through its relationship name (Account.Name); every FROM object must be a real API name; a field list is comma-separated; and use COUNT() or GROUP BY rather than SQL aggregate syntax.',
      },
      {
        codes: ['REQUEST_LIMIT_EXCEEDED', 'API_DISABLED_FOR_ORG', 'TOTAL_REQUESTS_LIMIT_EXCEEDED', 'REQUEST_RUNNING_TOO_LONG'],
        code: 'MCP_QUERY_LIMIT_EXCEEDED',
        message: hasOrgLimitsTool
          ? `Salesforce refused the request because the org's API allowance is exhausted. Call ${ORG_LIMITS_TOOL_NAME} to read the remaining allowance.`
          : 'Salesforce refused the request because the org\'s API allowance is exhausted.',
        suggestion: hasOrgLimitsTool
          ? `Read ${ORG_LIMITS_TOOL_NAME} to see when the allowance resets, and reduce the number of calls: one aggregate query is cheaper than paging a detail set.`
          : 'Reduce the number of calls (one aggregate query is cheaper than paging a detail set) and retry once the 24-hour rolling allowance resets.',
      },
      {
        codes: ['INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_OR_READONLY', 'INSUFFICIENT_PRIVILEGES'],
        code: 'MCP_QUERY_ACCESS_DENIED',
        message: 'The Salesforce user for this request may not read one of the objects or fields in the query.',
        suggestion: 'Report the missing Salesforce permission instead of retrying; drop an unreadable field from the query only if it is not needed, and do not work around the org\'s sharing rules.',
      },
    ],
  };
}

import type { OrgService } from '@salesforce/mcp-provider-api';
import {
  BULK_QUERY_COMPLETE_STATE,
  BULK_QUERY_RESULTS_TOOL_NAME,
  BULK_QUERY_TERMINAL_FAILURE_STATES,
  createBulkQueryApi,
  type BulkQueryApi,
  type BulkQueryApiFactory,
  type BulkQueryJob,
  type BulkQueryPage,
} from './bulk-query-api.js';
import { DataRuntimeError } from './errors.js';
import { resolveRequestConnection } from './org-connection.js';
import { BULK_QUERY_TOOL_NAME, ORG_LIMITS_TOOL_NAME } from './query-records-executor.js';
import {
  DATA_MAX_QUERY_TEXT_CHARACTERS,
  DATA_MAX_RESPONSE_BYTES,
  trimToByteBudget,
  trimToCharacterBudget,
} from './response-budget.js';
import { mapDataFailure, type DataFailureMapping } from './salesforce-errors.js';
import {
  BULK_QUERY_RESULTS_DEFAULT_MAX_RECORDS,
  type GetBulkQueryResultsInput,
  type GetBulkQueryResultsOutput,
} from './schemas.js';

/**
 * How many times one call may re-request a page to make it fit the response budget.
 *
 * The retry asks for *fewer* rows from the **same** cursor, so each attempt returns a prefix of
 * the previous page and the fitting count strictly decreases — this converges on the second
 * attempt in every ordinary case. The bound exists so a pathological row shape cannot spin.
 */
const PAGE_FIT_ATTEMPTS = 5;

export type GetBulkQueryResultsExecutorOptions = Readonly<{
  /** The Tools this session advertises; a hint may name only one of them. */
  enabledToolNames?: readonly string[];
  apiFactory?: BulkQueryApiFactory;
}>;

/**
 * Reads one page of a Bulk API 2.0 query job's results.
 *
 * Three properties define this Tool, and each of them is a constraint the caller has to be
 * able to see rather than trust:
 *
 * 1. **A page is never returned partially.** The response budget is what bounds a slice, and
 *    the cursor Salesforce hands back points *past the page it served*, not past the rows that
 *    fit. Returning a cut page with that cursor would silently skip every dropped row, which
 *    is the exact failure a completeness-oriented export must not have. So when the budget
 *    cuts a page, this Tool re-requests a smaller page from the **same** cursor until the
 *    whole page fits — or fails with `MCP_BULK_SLICE_TOO_LARGE` when even one row cannot.
 * 2. **No result set is ever returned in one response.** Every answer carries exactly one
 *    page plus the cursor for the next, so the size of the export is bounded by the caller's
 *    loop and not by this Tool's memory.
 * 3. **No job state is stored anywhere.** The job lives in Salesforce; the caller holds the
 *    jobId and the cursor. Nothing here survives a request.
 */
export class GetBulkQueryResultsExecutor {
  private readonly enabledToolNames: readonly string[];

  public constructor(
    private readonly orgService: OrgService,
    private readonly options: GetBulkQueryResultsExecutorOptions = {},
  ) {
    this.enabledToolNames = options.enabledToolNames ?? [];
  }

  public async execute(input: GetBulkQueryResultsInput): Promise<GetBulkQueryResultsOutput> {
    try {
      const connection = await resolveRequestConnection(this.orgService);
      const api = (this.options.apiFactory ?? createBulkQueryApi)(connection);
      const job = await api.getJob(input.jobId);

      if (job.state !== null && isTerminalFailure(job.state)) {
        return this.failure(job);
      }
      if (job.state !== BULK_QUERY_COMPLETE_STATE) {
        return this.pending(job);
      }
      return await this.readPage(api, job, input);
    } catch (error) {
      throw mapDataFailure(error, resultsFailureMapping(this.hasTool(ORG_LIMITS_TOOL_NAME)));
    }
  }

  /**
   * A job that ended without a result set. Reported as a structured failure rather than as a
   * successful call with no rows: "the job failed" and "the job succeeded and matched nothing"
   * are opposite facts, and the platform's own `stateMessage` is the only thing that
   * distinguishes them.
   */
  private failure(job: BulkQueryJob): GetBulkQueryResultsOutput {
    const reason = job.stateMessage ?? 'Salesforce did not report why the job ended.';
    return {
      success: false,
      executionRole: 'USER',
      api: 'REST',
      errorCode: 'MCP_BULK_JOB_FAILED',
      message: `The Bulk query job ${job.jobId} ended as ${job.state ?? 'unknown'}: ${reason}`,
      suggestion: `Correct the statement named in stateMessage and submit a new job with ${BULK_QUERY_TOOL_NAME}; this job will never produce a result set, so polling it again cannot help.`,
      jobId: job.jobId,
      ...(job.state === null ? {} : { state: job.state }),
      stateMessage: reason,
      numberRecordsProcessed: job.numberRecordsProcessed,
      numberRecordsFailed: job.numberRecordsFailed,
      totalRecords: null,
      records: [],
      returnedCount: 0,
    };
  }

  /**
   * A job that is still running. No completeness claim is made at all: `locator`, `hasMore`
   * and `complete` are omitted rather than reported as false, because "there is no next page"
   * and "there are no rows yet" are the same shape to an Agent that reads only the fields,
   * and only one of them is true here.
   */
  private pending(job: BulkQueryJob): GetBulkQueryResultsOutput {
    const state = job.state ?? 'unknown';
    return {
      success: true,
      executionRole: 'USER',
      api: 'REST',
      jobId: job.jobId,
      state,
      ...(job.stateMessage === null ? {} : { stateMessage: job.stateMessage }),
      numberRecordsProcessed: job.numberRecordsProcessed,
      numberRecordsFailed: job.numberRecordsFailed,
      totalRecords: null,
      records: [],
      returnedCount: 0,
      ...(job.apiUsage === null ? {} : { apiUsage: job.apiUsage }),
      hint: `The job is still ${state}, so no rows are readable yet and none have been read. Call ${BULK_QUERY_RESULTS_TOOL_NAME} again with the same jobId; rows become readable when the state reaches ${BULK_QUERY_COMPLETE_STATE}. Do not resubmit the query — a second job would cost a second set of API calls for the same data.`,
    };
  }

  /**
   * Reads a page and, if the response budget cuts it, re-reads a smaller page from the same
   * cursor until the whole page fits.
   */
  private async readPage(
    api: BulkQueryApi,
    job: BulkQueryJob,
    input: GetBulkQueryResultsInput,
  ): Promise<GetBulkQueryResultsOutput> {
    const cursor = input.locator ?? null;
    let requested = input.maxRecords ?? BULK_QUERY_RESULTS_DEFAULT_MAX_RECORDS;
    let page = await api.getResults(job.jobId, { locator: cursor, maxRecords: requested });
    let rendered = this.render(job, page);

    for (let attempt = 1; !rendered.fits && attempt < PAGE_FIT_ATTEMPTS; attempt += 1) {
      // The page Salesforce served is longer than one response may be, so the cursor it
      // returned points past rows that would never be delivered. Asking again from the same
      // cursor for exactly the number that fit returns those rows and no others, and gives a
      // cursor that continues from the right place.
      if (rendered.fittingCount < 1) break;
      requested = rendered.fittingCount;
      page = await api.getResults(job.jobId, { locator: cursor, maxRecords: requested });
      rendered = this.render(job, page);
    }
    if (!rendered.fits) {
      throw new DataRuntimeError(
        'MCP_BULK_SLICE_TOO_LARGE',
        `A single row of this Bulk query result is wider than one response may be (${DATA_MAX_RESPONSE_BYTES} bytes), so no page of it can be returned whole.`,
        {
          suggestion: 'Narrow the statement: select fewer columns, drop any long text area or rich text field, and filter the rows with a WHERE clause so each result row is smaller. Read the object\'s fields with describe_sobject to see which are large.',
        },
      );
    }
    return rendered.output;
  }

  /**
   * Applies the two response budgets and composes the answer, exactly as `query_records` does:
   * the byte budget bounds the structured payload and the character budget bounds the text the
   * Agent reads. Both measure the *fully composed* output, hint included, so a page can never
   * be pushed over budget by its own explanation of why it is small.
   */
  private render(job: BulkQueryJob, page: BulkQueryPage): PageRender {
    const build = (kept: readonly Readonly<Record<string, unknown>>[]): GetBulkQueryResultsOutput =>
      this.build(job, page, kept);
    const byBytes = trimToByteBudget(page.records, DATA_MAX_RESPONSE_BYTES, build);
    const byCharacters = trimToCharacterBudget(byBytes.kept, DATA_MAX_QUERY_TEXT_CHARACTERS, build);
    return Object.freeze({
      output: build(byCharacters.kept),
      fits: byCharacters.kept.length === page.records.length,
      fittingCount: byCharacters.kept.length,
    });
  }

  private build(
    job: BulkQueryJob,
    page: BulkQueryPage,
    records: readonly Readonly<Record<string, unknown>>[],
  ): GetBulkQueryResultsOutput {
    const hasMore = page.nextLocator !== null;
    const total = job.numberRecordsProcessed;
    return {
      success: true,
      executionRole: 'USER',
      api: 'REST',
      jobId: job.jobId,
      ...(job.state === null ? {} : { state: job.state }),
      ...(job.stateMessage === null ? {} : { stateMessage: job.stateMessage }),
      numberRecordsProcessed: job.numberRecordsProcessed,
      numberRecordsFailed: job.numberRecordsFailed,
      totalRecords: total,
      records: [...records],
      returnedCount: records.length,
      locator: page.nextLocator,
      hasMore,
      complete: !hasMore,
      ...(page.apiUsage === null ? {} : { apiUsage: page.apiUsage }),
      hint: pageHint({ hasMore, returned: records.length, total }),
    };
  }

  private hasTool(name: string): boolean {
    return this.enabledToolNames.includes(name);
  }
}

type PageRender = Readonly<{
  output: GetBulkQueryResultsOutput;
  /** True when every row of the page Salesforce served is present in `output`. */
  fits: boolean;
  /** Rows that did fit; the size the next attempt asks for. */
  fittingCount: number;
}>;

function isTerminalFailure(state: string): boolean {
  return (BULK_QUERY_TERMINAL_FAILURE_STATES as readonly string[]).includes(state);
}

/**
 * The next step for one page of a Bulk result set.
 *
 * `totalRecords` is the platform's own `numberRecordsProcessed` for the whole job, so the
 * caller can see how far through the export it is — but it is **not** a cumulative read
 * count: this Tool stores no state, so it can only report how many rows *this* page carried.
 */
function pageHint(state: Readonly<{
  hasMore: boolean;
  returned: number;
  total: number | null;
}>): string {
  const total = state.total === null ? 'an unreported number of' : String(state.total);
  if (!state.hasMore) {
    return `Complete: this is the last page of the job's result set, and the job reported ${total} rows in total. `
      + 'Bulk API 2.0 serves results as CSV, so every value in records is a string and an absent field is an empty string rather than null.';
  }
  return `${state.returned} row(s) returned of the job's ${total}. `
    + `Call ${BULK_QUERY_RESULTS_TOOL_NAME} again with the same jobId and the locator from this result to read the next page; `
    + 'the locator is a position rather than an offset, so pages continue exactly where this one stopped. '
    + 'Bulk API 2.0 serves results as CSV, so every value in records is a string.';
}

/**
 * Error mapping for `get_bulk_query_results`.
 *
 * `NOT_FOUND` and `INSUFFICIENT_ACCESS` are deliberately separate outcomes. A Bulk query job
 * belongs to the identity that created it, so asking for another identity's job is refused by
 * Salesforce — and the suggestion says to report that refusal rather than to look for a way
 * around it, because "read someone else's export" is not a capability this Tool has or wants.
 */
function resultsFailureMapping(hasOrgLimitsTool: boolean): DataFailureMapping {
  return {
    fallbackCode: 'MCP_BULK_RESULTS_FAILED',
    fallbackMessage: 'Salesforce could not read this Bulk query job\'s results.',
    fallbackSuggestion: `Retry once; if it fails again, re-read the job state with ${BULK_QUERY_RESULTS_TOOL_NAME} to confirm the jobId before submitting a new export.`,
    rules: [
      {
        codes: ['NOT_FOUND', 'INVALID_JOB_ID', 'INVALID_ID_FIELD'],
        code: 'MCP_BULK_JOB_NOT_FOUND',
        message: 'Salesforce has no Bulk query job with this jobId for this request\'s identity.',
        suggestion: `A Bulk query job belongs to the identity that created it and Salesforce removes it after a few days. If it is gone, submit the export again with ${BULK_QUERY_TOOL_NAME}; otherwise check the jobId for a copy error. Do not try to read another identity's job.`,
      },
      {
        codes: ['INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_OR_READONLY', 'INSUFFICIENT_PRIVILEGES', 'FORBIDDEN'],
        code: 'MCP_BULK_ACCESS_DENIED',
        message: 'Salesforce refused this job to the request\'s identity: a Bulk query job is readable only by the identity that created it.',
        suggestion: 'Report the refusal instead of retrying. Run both the submission and the result reads through the same identity, and do not attempt to read a job this identity did not create.',
      },
      {
        codes: ['INVALID_QUERY_LOCATOR', 'INVALID_LOCATOR', 'MALFORMED_QUERY_LOCATOR'],
        code: 'MCP_BULK_RESULTS_FAILED',
        message: 'Salesforce rejected the paging cursor, so this page cannot be located.',
        suggestion: 'Restart the read from the beginning by omitting locator, and keep each cursor exactly as the previous result returned it — a cursor is opaque and is not an offset.',
      },
      {
        codes: ['REQUEST_LIMIT_EXCEEDED', 'API_DISABLED_FOR_ORG', 'TOTAL_REQUESTS_LIMIT_EXCEEDED'],
        code: 'MCP_BULK_LIMIT_EXCEEDED',
        message: hasOrgLimitsTool
          ? `Salesforce refused the request because the org's API allowance is exhausted. Call ${ORG_LIMITS_TOOL_NAME} to read the remaining allowance.`
          : 'Salesforce refused the request because the org\'s API allowance is exhausted.',
        suggestion: hasOrgLimitsTool
          ? `Read ${ORG_LIMITS_TOOL_NAME} to see when the allowance resets, and wait for it rather than retrying: every page read costs an API call.`
          : 'Wait for the 24-hour rolling allowance to reset rather than retrying: every page read costs an API call.',
      },
    ],
  };
}

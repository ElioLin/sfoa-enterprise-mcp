import type { Connection } from '@salesforce/core';
import { DataRuntimeError } from './errors.js';
import { sanitizeText } from './sanitize.js';

/** The Tool that reads a Bulk query job's results; the submit Tool names it in its hint. */
export const BULK_QUERY_RESULTS_TOOL_NAME = 'get_bulk_query_results';

/**
 * The Bulk API 2.0 query-job states, as Salesforce documents them. Declared as a closed list
 * so an unrecognised state is reported as "unknown" rather than passed through as a value the
 * Agent would have to interpret.
 */
export const BULK_QUERY_STATES = ['UploadComplete', 'InProgress', 'JobComplete', 'Failed', 'Aborted'] as const;

export type BulkQueryState = (typeof BULK_QUERY_STATES)[number];

/**
 * One Bulk API 2.0 call, as this module builds it. `path` is relative to the org's
 * `/services/data/v<version>/jobs/query` root, which jsforce turns into an absolute URL — so
 * this module never handles an instance URL or an API version itself.
 */
export type BulkHttpRequest = Readonly<{
  method: 'GET' | 'POST';
  path: string;
  body?: string;
}>;

/**
 * A Bulk API 2.0 response, reduced to the two things this capability needs: the parsed body
 * and the response headers. The headers are not incidental — `Sforce-Locator` is where the
 * result paging cursor lives and `Sforce-Limit-Info` is the org's own API-usage counter, and
 * neither appears anywhere in the body.
 */
export type BulkHttpResponse = Readonly<{
  body: unknown;
  headers: Readonly<Record<string, string>>;
}>;

export type BulkHttpClient = Readonly<{ send(request: BulkHttpRequest): Promise<BulkHttpResponse> }>;

/** One Bulk query job, reduced to the facts both Tools report. */
export type BulkQueryJob = Readonly<{
  jobId: string;
  /** `null` when Salesforce reported a state this contract does not know. */
  state: BulkQueryState | null;
  numberRecordsProcessed: number | null;
  numberRecordsFailed: number | null;
  /** Salesforce's `errorMessage`/`stateMessage` for a Failed or Aborted job, sanitized and bounded. */
  stateMessage: string | null;
  /** The org's own API-usage counter, as this response reported it. */
  apiUsage: BulkApiUsage | null;
}>;

/** One page of a query job's results, with the cursor that reaches the next one. */
export type BulkQueryPage = Readonly<{
  records: readonly Readonly<Record<string, unknown>>[];
  /** The cursor the *next* call must pass back, or `null` when Salesforce reported no more. */
  nextLocator: string | null;
  /** The org's own API-usage counter, as this page's response reported it. */
  apiUsage: BulkApiUsage | null;
}>;

/** The org's own API-usage counter, as every Bulk response reports it in `Sforce-Limit-Info`. */
export type BulkApiUsage = Readonly<{ used: number; limit: number; remaining: number }>;

const LOCATOR_HEADER = 'sforce-locator';
const LIMIT_INFO_HEADER = 'sforce-limit-info';

/** A Salesforce-reported job message is echoed to the Agent, so it is bounded like every other one. */
const MAX_JOB_MESSAGE_LENGTH = 2_000;

/**
 * The literal Salesforce uses to say "there is no next page". It is the **string** `null`,
 * not an absent header — jsforce's own result loop terminates on exactly this value.
 */
const NO_LOCATOR = 'null';

/** A page of results is never requested larger than Salesforce's own cap, whatever the caller asks. */
export const BULK_QUERY_HARD_MAX_RECORDS = 50_000;

/** The Bulk API 2.0 query-job state that means the result set is complete and readable. */
export const BULK_QUERY_COMPLETE_STATE: BulkQueryState = 'JobComplete';

/** The states in which a job will never produce results. */
export const BULK_QUERY_TERMINAL_FAILURE_STATES = Object.freeze(['Failed', 'Aborted'] as const);

/**
 * Reads the Bulk API 2.0 query-job endpoints through the request-scoped Connection.
 *
 * **Why this is not `connection.bulk2`.** The SDK's `QueryJobV2` cannot express this
 * capability: `result()` streams *every* page of a result set into one stream and keeps the
 * paging cursor in a private field, `job()` and `createJob()` expose no way to create a query
 * job and keep only its Id, and `result()` accepts no `maxRecords`. Both facts this Tool is
 * built on — the `Sforce-Locator` cursor and the `Sforce-Limit-Info` counter — exist only as
 * response headers, and the SDK's public surface never returns them. `connection.request` is
 * the SDK's own lower-level entry point, so the calls stay inside the official client: the
 * Authorization header is still injected by jsforce, no credential is ever handled here, and
 * the P7 audit adapter still attributes every wire attempt (the classifier already maps
 * `/jobs/...` to `BULK_API`).
 */
export class BulkQueryApi {
  public constructor(
    private readonly client: BulkHttpClient,
    /** The org's API version, reported so a caller can tell which contract the job was created against. */
    public readonly apiVersion: string,
  ) {}

  /**
   * Creates a query job. Only `operation: 'query'` is ever sent: this class has no way to
   * express an ingest, an update or a delete, so no caller can reach one through it.
   */
  public async createQueryJob(query: string): Promise<BulkQueryJob> {
    const response = await this.client.send({
      method: 'POST',
      path: '',
      body: JSON.stringify({
        operation: 'query',
        query,
        contentType: 'CSV',
        columnDelimiter: 'COMMA',
        lineEnding: 'LF',
      }),
    });
    return readJob(response.body, response.headers, null);
  }

  /** Reads a job's current state and counters. */
  public async getJob(jobId: string): Promise<BulkQueryJob> {
    const response = await this.client.send({ method: 'GET', path: `/${encodeURIComponent(jobId)}` });
    return readJob(response.body, response.headers, jobId);
  }

  /**
   * Reads one page of a completed job's results.
   *
   * `maxRecords` is what this call *asks* for; the page Salesforce returns may be smaller, and
   * the caller must read `nextLocator` rather than assume the request was honoured.
   */
  public async getResults(
    jobId: string,
    options: Readonly<{ locator: string | null; maxRecords: number }>,
  ): Promise<BulkQueryPage> {
    const maxRecords = Math.min(Math.max(options.maxRecords, 1), BULK_QUERY_HARD_MAX_RECORDS);
    const query = new URLSearchParams({ maxRecords: String(maxRecords) });
    if (options.locator !== null) query.set('locator', options.locator);
    const response = await this.client.send({
      method: 'GET',
      path: `/${encodeURIComponent(jobId)}/results?${query.toString()}`,
    });
    if (!Array.isArray(response.body)) {
      throw new DataRuntimeError(
        'MCP_BULK_RESULTS_FAILED',
        'Salesforce did not return a CSV result page for this Bulk query job.',
        { suggestion: 'Retry once; if it fails again, check the job state with get_bulk_query_results before reading further pages.' },
      );
    }
    return Object.freeze({
      records: Object.freeze(response.body.filter(isPlainRecord)),
      nextLocator: readLocator(response.headers),
      apiUsage: readApiUsage(response.headers),
    });
  }
}

/** Builds the Bulk API over a request-scoped Connection; injected so a test can supply a fake. */
export type BulkQueryApiFactory = (connection: Connection) => BulkQueryApi;

/** Builds the API over the request-scoped Connection. */
export function createBulkQueryApi(connection: Connection): BulkQueryApi {
  return new BulkQueryApi(createBulkHttpClient(connection), safeApiVersion(connection));
}

/**
 * The `Sforce-Limit-Info` counter Salesforce attaches to every REST response:
 * `api-usage=1234/15000`. Reported rather than acted on — see the quota note on
 * `submit_bulk_query`.
 */
export function readApiUsage(headers: Readonly<Record<string, string>>): BulkApiUsage | null {
  const raw = headers[LIMIT_INFO_HEADER];
  if (typeof raw !== 'string') return null;
  const match = /api-usage=(\d+)\/(\d+)/u.exec(raw);
  const used = match?.[1];
  const limit = match?.[2];
  if (used === undefined || limit === undefined) return null;
  const usedCount = Number.parseInt(used, 10);
  const limitCount = Number.parseInt(limit, 10);
  if (!Number.isFinite(usedCount) || !Number.isFinite(limitCount) || limitCount <= 0) return null;
  return Object.freeze({ used: usedCount, limit: limitCount, remaining: Math.max(limitCount - usedCount, 0) });
}

/**
 * Builds the transport the SDK's `connection.request` will use for this one call.
 *
 * `HttpApi` reads headers from the response and then never exposes them: the parsed body is
 * all a caller receives. The one place a header is observable is the transport, immediately
 * before the response is parsed — so the wrapper delegates the request unchanged and copies
 * the response headers out on the way past. It performs no authentication of its own: jsforce
 * injects the Authorization header before the transport is reached, so this code path never
 * sees, holds or logs a credential.
 *
 * The listener is attached to the stream the *transport* returns (`StreamPromise.stream()`),
 * not to the lazy stream `HttpApi` exposes, which does not forward response events.
 */
export function createBulkHttpClient(connection: Connection): BulkHttpClient {
  const transport = readTransport(connection);
  return Object.freeze({
    send: async (request) => {
      const headers: Record<string, string> = {};
      const observing: ObservableTransport = {
        httpRequest: (outgoing, options) => {
          const pending = transport.httpRequest(outgoing, options);
          pending.stream().on('response', (response) => {
            for (const [name, value] of Object.entries(response.headers ?? {})) {
              headers[name.toLocaleLowerCase('en-US')] = value;
            }
          });
          return pending;
        },
      };
      const body = await connection.request<unknown>(
        {
          method: request.method,
          // Version-relative: jsforce expands `/jobs/query…` to
          // `<instanceUrl>/services/data/v<version>/jobs/query…`, so no URL is assembled here.
          url: `/jobs/query${request.path}`,
          headers: request.method === 'POST'
            ? { 'content-type': 'application/json' }
            : { Accept: 'text/csv' },
          ...(request.body === undefined ? {} : { body: request.body }),
        },
        // jsforce honours a `transport` here internally, but publishes the options as a
        // `JsonMap` — a JSON value type that cannot name a function, so the SDK's own typings
        // cannot describe an option its own code reads. `Parameters<>` names the real published
        // type, so this stays a cast to the SDK's contract rather than to `any`.
        { transport: observing } as unknown as RequestOptions,
      );
      return Object.freeze({ body, headers: Object.freeze(headers) });
    },
  });
}

/** The options `Connection.request` publishes; see the cast above for why one member is added. */
type RequestOptions = Parameters<Connection['request']>[1];

/**
 * The structural shape of a jsforce transport, declared here rather than imported so the
 * Provider keeps its single declared dependency (`@salesforce/core`) and never reaches into
 * the SDK's internal module paths. Only the two members this wrapper touches are named.
 */
type ObservableResponse = Readonly<{ headers?: Readonly<Record<string, string>> }>;

type ObservablePending = Readonly<{
  stream(): Readonly<{ on(event: 'response', listener: (response: ObservableResponse) => void): unknown }>;
}>;

type ObservableTransport = Readonly<{
  httpRequest(request: unknown, options: unknown): ObservablePending;
}>;

function readTransport(connection: Connection): ObservableTransport {
  const transport = (connection as unknown as { _transport?: ObservableTransport })._transport;
  if (transport === undefined || typeof transport.httpRequest !== 'function') {
    throw new DataRuntimeError(
      'MCP_BULK_RESULTS_FAILED',
      'This request\'s Salesforce Connection exposes no transport, so Bulk API result pages cannot be read.',
      { suggestion: 'Report this as a runtime defect: the request-scoped Connection must be a live jsforce client.' },
    );
  }
  return transport;
}

function readJob(
  value: unknown,
  headers: Readonly<Record<string, string>>,
  fallbackJobId: string | null,
): BulkQueryJob {
  const record = isPlainRecord(value) ? value : {};
  const jobId = readIdentifier(record.id) ?? fallbackJobId;
  if (jobId === null) {
    throw new DataRuntimeError(
      'MCP_BULK_SUBMIT_FAILED',
      'Salesforce accepted the Bulk query job but returned no job Id, so its results could never be read.',
      { suggestion: 'Retry the submission; if it happens again, report the missing job Id as a runtime defect.' },
    );
  }
  return Object.freeze({
    jobId,
    state: readState(record.state),
    numberRecordsProcessed: readCount(record.numberRecordsProcessed),
    numberRecordsFailed: readCount(record.numberRecordsFailed),
    // A query job reports its failure detail as `errorMessage`; ingest jobs use `stateMessage`.
    // Both are read so one shape covers either, and the field is reported under the one name.
    stateMessage: readMessage(record.errorMessage) ?? readMessage(record.stateMessage),
    apiUsage: readApiUsage(headers),
  });
}

function readLocator(headers: Readonly<Record<string, string>>): string | null {
  const raw = headers[LOCATOR_HEADER];
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.toLocaleLowerCase('en-US') === NO_LOCATOR) return null;
  return value;
}

/**
 * A Salesforce row is a plain object. Anything else cannot be one, so it is dropped rather
 * than reported as a record an Agent would then try to read a field out of. Bulk results are
 * CSV, so every field arrives as a **string** and an absent field arrives as an empty string
 * rather than as null.
 *
 * Deliberately not exported: `query_records` already exports the identical guard for the
 * identical reason, and two exports of one name would make the package's barrel ambiguous.
 */
function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readState(value: unknown): BulkQueryState | null {
  return typeof value === 'string' && isBulkQueryState(value) ? value : null;
}

export function isBulkQueryState(value: string): value is BulkQueryState {
  return (BULK_QUERY_STATES as readonly string[]).includes(value);
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readIdentifier(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : sanitizeText(trimmed, MAX_JOB_MESSAGE_LENGTH);
}

/**
 * The reported API version is the org's own answer, and a Connection that cannot give one is
 * not a reason to refuse a submission that would otherwise work: the value is descriptive.
 */
function safeApiVersion(connection: Connection): string {
  try {
    const version = connection.getApiVersion();
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

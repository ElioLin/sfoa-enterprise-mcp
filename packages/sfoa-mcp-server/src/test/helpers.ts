import type { Connection } from '@salesforce/core';
import { parseDmlAllowlistJson } from '@sfoa/mcp-provider-sfoa-dml';
import {
  CwdExecutionGuard,
  createIdentityRuntime,
  NoopRuntimeLogger,
  RequestWorkspaceFactory,
  type IdentityRuntime,
  type IdentityRuntimeConfig,
  type RuntimeLogger,
  type SalesforceConnectionFactory,
  type SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import {
  DEFAULT_ATTACHMENT_MAX_FILES_PER_OWNER,
  DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
  DEFAULT_ATTACHMENT_PATH,
  DEFAULT_ATTACHMENT_TTL_MS,
  type RemoteRuntimeConfig,
} from '../config.js';

export const TEST_CLIENT_TOKEN = 'p2-test-token-with-at-least-thirty-two-characters';
export const TEST_PLATFORM_USER_A = 'p2-user-a';
export const TEST_PLATFORM_USER_B = 'p2-user-b';
export const TEST_USERNAME_A = 'user-a@example.test';
export const TEST_USERNAME_B = 'user-b@example.test';
/** The server-owned DIAGNOSTIC identity. Distinct from both USER usernames by construction. */
export const TEST_DIAGNOSTIC_USERNAME = 'diagnostic-a@example.test';

export const TEST_IDENTITY_CONFIG: IdentityRuntimeConfig = Object.freeze({
  projectRoot: process.cwd(),
  instanceUrl: 'https://example.test',
  primaryUsername: TEST_USERNAME_A,
  secondaryUsername: TEST_USERNAME_B,
  clientId: 'test-connected-app',
  privateKeyPath: 'test-private-key.pem',
  platformUserA: TEST_PLATFORM_USER_A,
  platformUserB: TEST_PLATFORM_USER_B,
  concurrentRequests: 50,
  port: 3000,
});

export type ConnectionCreation = Readonly<{
  sequence: number;
  platformUserId: string;
  salesforceUsername: string;
  /** Which of the two server-owned roles the runtime resolved for this request. */
  connectionRole: SalesforceIdentityRoute['connectionRole'];
  connection: Connection;
}>;

export type LimitsCall = Readonly<{
  platformUserId: string;
  salesforceUsername: string;
}>;

export type DmlCall = Readonly<{
  sequence: number;
  platformUserId: string;
  salesforceUsername: string;
  operation: 'CREATE' | 'UPDATE';
  objectApiName: string;
  record: Readonly<Record<string, unknown>>;
}>;

/**
 * One Bulk API 2.0 call, as the Provider built it. The `url` is version-relative —
 * `/jobs/query/<id>/results?...` — because jsforce, not this code, expands it against the
 * instance URL. `body` is the parsed request body for the submission and absent for a read.
 */
export type BulkCall = Readonly<{ method: string; url: string; body?: unknown }>;

/**
 * A Bulk API 2.0 answer. The headers are not decoration: `Sforce-Locator` is the paging cursor
 * and `Sforce-Limit-Info` is the org's API-usage counter, and both exist only here.
 */
export type BulkAnswer = Readonly<{
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}>;

/** The response-event listener a jsforce transport is expected to notify. */
type BulkResponseListener = (response: Readonly<{ headers?: Readonly<Record<string, string>> }>) => void;

type BulkPending = Readonly<{
  stream(): Readonly<{ on(event: 'response', listener: BulkResponseListener): void }>;
  emit(headers: Readonly<Record<string, string>> | undefined): void;
}>;

function createBulkPending(): BulkPending {
  const listeners: BulkResponseListener[] = [];
  return {
    stream: () => ({
      on: (event, listener) => {
        if (event === 'response') listeners.push(listener);
      },
    }),
    emit: (headers) => {
      for (const listener of listeners) listener({ headers: headers ?? {} });
    },
  };
}

export class RecordingConnectionFactory implements SalesforceConnectionFactory {
  public readonly creations: ConnectionCreation[] = [];
  public readonly dmlCalls: DmlCall[] = [];
  public readonly apiRequests: string[] = [];
  public readonly queryCalls: string[] = [];
  /** SObject schema reads, in order: `describeGlobal` or `describe:<objectApiName>`. */
  public readonly schemaCalls: string[] = [];
  /**
   * Governor-limit reads, in order. The platform user is not enough to tell the two request
   * scopes apart — a DIAGNOSTIC call is triggered by, and therefore carries, the same
   * platform user as the USER call beside it — so the attributed Salesforce username is
   * recorded too, and that is what a role assertion has to read.
   */
  public readonly limitsCalls: LimitsCall[] = [];
  /** SOSL statements sent through `search()`, in order. */
  public readonly searchCalls: string[] = [];
  /** Bulk API 2.0 calls, in order. Every P9 Bulk request goes through `request()`. */
  public readonly bulkCalls: BulkCall[] = [];
  public instanceUrlForRoute = (route: SalesforceIdentityRoute): string =>
    `https://${route.platformUserId}.my.salesforce.com`;

  public constructor(private readonly schema: RecordingSchemaOptions = {}) {}

  public async create(route: SalesforceIdentityRoute): Promise<Connection> {
    const sequence = this.creations.length + 1;
    const queryResult = {
      records: [{ Id: `${route.platformUserId}-${sequence}` }],
      totalSize: 1,
      done: true,
    };
    const createdRecordId = `00Q${String(sequence).padStart(12, '0')}AAA`;
    // Bulk API 2.0 reaches this Connection the way it does in production: the Provider hands
    // `request` a transport, and the response headers are delivered through that transport's
    // `'response'` event. Modelling it any shorter would let the production header capture be
    // wrong while these tests still passed.
    let pending: BulkPending | undefined;
    const bulkTransport = {
      httpRequest: () => {
        pending = createBulkPending();
        return pending;
      },
    };
    const connection = {
      _transport: bulkTransport,
      instanceUrl: this.instanceUrlForRoute(route),
      getApiVersion: () => '65.0',
      describeGlobal: async () => {
        this.schemaCalls.push('describeGlobal');
        if (this.schema.describeGlobalError) throw this.schema.describeGlobalError;
        return (this.schema.describeGlobal ?? defaultDescribeGlobal)();
      },
      describe: async (objectApiName: string) => {
        this.schemaCalls.push(`describe:${objectApiName}`);
        if (this.schema.describeError) throw this.schema.describeError;
        return (this.schema.describe ?? defaultDescribe)(objectApiName);
      },
      identity: async () => ({
        username: route.salesforceUsername,
        user_id: `005-${route.platformUserId}`,
        organization_id: '00D-test',
      }),
      query: async (query: string) => {
        this.queryCalls.push(query);
        if (this.schema.queryError) throw this.schema.queryError;
        return this.schema.query?.(query, 'query') ?? queryResult;
      },
      queryMore: async (cursor: string) => {
        const batch = this.schema.recordedQueryPages?.get(cursor);
        if (batch === undefined) throw new Error(`Unexpected continuation cursor ${cursor}`);
        return batch;
      },
      tooling: {
        query: async (query: string) => {
          this.queryCalls.push(query);
          if (this.schema.queryError) throw this.schema.queryError;
          return this.schema.query?.(query, 'toolingQuery') ?? queryResult;
        },
        queryMore: async (cursor: string) => {
          const batch = this.schema.recordedQueryPages?.get(cursor);
          if (batch === undefined) throw new Error(`Unexpected Tooling continuation cursor ${cursor}`);
          return batch;
        },
      },
      limits: async () => {
        this.limitsCalls.push({
          platformUserId: route.platformUserId,
          salesforceUsername: route.salesforceUsername,
        });
        if (this.schema.limitsError) throw this.schema.limitsError;
        return (this.schema.limits ?? defaultLimits)();
      },
      search: async (statement: string) => {
        this.searchCalls.push(statement);
        if (this.schema.searchError) throw this.schema.searchError;
        return (this.schema.search ?? defaultSearch)(statement);
      },
      request: async (
        request: string | Readonly<{ method?: string; url?: string; body?: string }>,
        requestOptions?: Readonly<{ transport?: { httpRequest(): BulkPending } }>,
      ) => {
        const url = typeof request === 'string' ? request : request.url ?? '';
        if (!url.includes('/jobs/query')) {
          this.apiRequests.push(url);
          return uiApiResponse(url);
        }
        const method = typeof request === 'string' ? 'GET' : request.method ?? 'GET';
        const body = typeof request === 'string' ? undefined : request.body;
        const call: BulkCall = {
          method,
          url,
          ...(body === undefined ? {} : { body: parseJsonBody(body) }),
        };
        this.bulkCalls.push(call);
        const active = requestOptions?.transport ?? bulkTransport;
        const activePending = active.httpRequest();
        const answer = await (this.schema.bulk ?? refuseBulk)(call);
        activePending.emit(answer.headers);
        return answer.body;
      },
      sobject: (objectApiName: string) => ({
        // `SObject.describe()` is a real jsforce method and a distinct surface from the flat
        // `connection.describe()` above: a Tool that reaches a caller-named object this way is reading
        // metadata rather than a record, which is a distinction one diagnostic suite asserts on.
        describe: async () => {
          this.schemaCalls.push(`describe:${objectApiName}`);
          if (this.schema.describeError) throw this.schema.describeError;
          return (this.schema.describe ?? defaultDescribe)(objectApiName);
        },
        create: async (record: Record<string, unknown>) => {
          this.dmlCalls.push({
            sequence,
            platformUserId: route.platformUserId,
            salesforceUsername: route.salesforceUsername,
            operation: 'CREATE',
            objectApiName,
            record: { ...record },
          });
          return { success: true, id: createdRecordId, errors: [] };
        },
        update: async (record: Record<string, unknown>) => {
          this.dmlCalls.push({
            sequence,
            platformUserId: route.platformUserId,
            salesforceUsername: route.salesforceUsername,
            operation: 'UPDATE',
            objectApiName,
            record: { ...record },
          });
          return { success: true, id: String(record.Id), errors: [] };
        },
      }),
    } as unknown as Connection;
    this.creations.push({
      sequence,
      platformUserId: route.platformUserId,
      salesforceUsername: route.salesforceUsername,
      connectionRole: route.connectionRole,
      connection,
    });
    return connection;
  }

  public countFor(platformUserId: string): number {
    return this.creations.filter((creation) => creation.platformUserId === platformUserId).length;
  }
}

const TEST_RECORD_TYPE_ID = '012000000000000AAA';

/**
 * SObject schema answers for the P9 Data Tools. They are deliberately small but shaped
 * like the jsforce payloads, so a test can assert exactly which facts the Tools surfaced
 * and which Salesforce surface they read.
 */
export type RecordingSchemaOptions = Readonly<{
  describeGlobal?: () => unknown;
  describe?: (objectApiName: string) => unknown;
  describeGlobalError?: unknown;
  describeError?: unknown;
  /**
   * Answers a SOQL call with a batch chain: the first batch for the statement, then one per
   * cursor in `recordedQueryPages`. Lets a protocol test exercise `query_records` paging and
   * truncation without a live org.
   */
  query?: (query: string, operation: 'query' | 'toolingQuery') => unknown;
  recordedQueryPages?: ReadonlyMap<string, unknown>;
  queryError?: unknown;
  /** Governor limits, as the org reports them: a flat map of key to `{ Max, Remaining }`. */
  limits?: () => unknown;
  limitsError?: unknown;
  /** Answers a SOSL call. The default returns one Account record per statement. */
  search?: (statement: string) => unknown;
  searchError?: unknown;
  /**
   * Answers a Bulk API 2.0 call. The default refuses one: a Bulk request is only ever made by a
   * Tool the test deliberately enabled, so a fixture that answered it anyway would let a stray
   * call pass unnoticed.
   */
  bulk?: (call: BulkCall) => BulkAnswer | Promise<BulkAnswer>;
}>;

function defaultDescribeGlobal(): unknown {
  return {
    encoding: 'UTF-8',
    maxBatchSize: 200,
    sobjects: [
      { name: 'Account', label: 'Account', labelPlural: 'Accounts', keyPrefix: '001',
        custom: false, queryable: true, createable: true, updateable: true, searchable: true },
      { name: 'AccountCleanInfo', label: 'Account Clean Info', labelPlural: 'Account Clean Info',
        keyPrefix: '0CJ', custom: false, queryable: true, createable: true, updateable: true, searchable: false },
      { name: 'Lead', label: 'Lead', labelPlural: 'Leads', keyPrefix: '00Q',
        custom: false, queryable: true, createable: true, updateable: true, searchable: true },
    ],
  };
}

function defaultDescribe(objectApiName: string): unknown {  return {
    name: objectApiName,
    label: objectApiName,
    labelPlural: `${objectApiName}s`,
    keyPrefix: '001',
    custom: objectApiName.endsWith('__c'),
    queryable: true,
    createable: true,
    updateable: true,
    searchable: true,
    fields: [
      { name: 'Id', label: 'Account ID', type: 'id', nillable: false, createable: false,
        updateable: false, filterable: true, sortable: true, custom: false, deprecatedAndHidden: false,
        referenceTo: [], relationshipName: null, picklistValues: [] },
      { name: 'Name', label: 'Account Name', type: 'string', nillable: false, createable: true,
        updateable: true, filterable: true, sortable: true, custom: false, deprecatedAndHidden: false,
        referenceTo: [], relationshipName: null, picklistValues: [] },
    ],
    childRelationships: [
      { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts',
        cascadeDelete: false, restrictedDelete: false, deprecatedAndHidden: false },
    ],
  };
}


/** The org's own key names and `{ Max, Remaining }` pairs, shaped as `limits()` returns them. */
function defaultLimits(): unknown {
  return {
    DailyApiRequests: { Max: 100_000, Remaining: 99_000 },
    DailyBulkV2QueryJobs: { Max: 10_000, Remaining: 9_500 },
    DataStorageMB: { Max: 1_024, Remaining: 512 },
    FileStorageMB: { Max: 2_048, Remaining: 2_000 },
  };
}

function defaultSearch(statement: string): unknown {
  return {
    searchRecords: [
      {
        attributes: { type: 'Account', url: '/services/data/v65.0/sobjects/Account/001000000000001' },
        Id: '001000000000001',
        Name: `Match for ${statement}`,
      },
    ],
  };
}

const BULK_QUERY_JOB_ID = '750000000000001AAA';

/** A Bulk API 2.0 job payload, as `POST /jobs/query` and `GET /jobs/query/<id>` return it. */
export function bulkJob(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: BULK_QUERY_JOB_ID,
    operation: 'query',
    object: 'Account',
    state: 'JobComplete',
    contentType: 'CSV',
    apiVersion: 65,
    numberRecordsProcessed: 0,
    numberRecordsFailed: 0,
    ...overrides,
  };
}

/** The job Id the fixture's answers carry, so a test can page a job it did not create itself. */
export const TEST_BULK_QUERY_JOB_ID = BULK_QUERY_JOB_ID;

/**
 * A Bulk result page's headers. `Sforce-Locator` carries the next cursor — the literal string
 * `null` at the end, as Salesforce sends it — and `Sforce-Limit-Info` the org's API counter.
 */
export function bulkResultHeaders(locator: string | null, used?: number, limit?: number): Record<string, string> {
  return {
    'sforce-locator': locator ?? 'null',
    ...(used === undefined || limit === undefined ? {} : { 'sforce-limit-info': `api-usage=${used}/${limit}` }),
  };
}

/**
 * `count` rows of a Bulk result page, as jsforce parses the CSV: values are all **strings**, and
 * an absent field is an empty string rather than null.
 */
export function bulkRows(count: number, prefix = 'r'): Record<string, string>[] {
  return Array.from({ length: count }, (_, index) => ({ Id: `${prefix}${index}`, Name: `${prefix} ${index}` }));
}

function refuseBulk(call: BulkCall): never {
  throw new Error(`Unexpected Bulk API call ${call.method} ${call.url}`);
}

/** A request body is JSON by construction; a test asserting on it wants the object, not the text. */
function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function uiApiResponse(url: string): unknown {
  if (/\/ui-api\/object-info\/Lead\/picklist-values\//u.test(url)) {
    return { picklistFieldValues: {} };
  }
  if (/\/ui-api\/object-info\/Lead(?:\?|$)/u.test(url)) {
    return {
      apiName: 'Lead',
      label: 'Lead',
      labelPlural: 'Leads',
      defaultRecordTypeId: TEST_RECORD_TYPE_ID,
      fields: {
        LastName: {
          apiName: 'LastName', label: 'Last Name', dataType: 'String', required: true,
          createable: true, updateable: true,
        },
        Company: {
          apiName: 'Company', label: 'Company', dataType: 'String', required: true,
          createable: true, updateable: true,
        },
      },
      recordTypeInfos: {
        [TEST_RECORD_TYPE_ID]: {
          recordTypeId: TEST_RECORD_TYPE_ID,
          name: 'Master',
          available: true,
          defaultRecordTypeMapping: true,
        },
      },
    };
  }
  if (/\/ui-api\/record-defaults\/create\/Lead/u.test(url)) {
    return {
      layout: {
        sections: [{
          heading: 'Required',
          layoutRows: [{
            layoutItems: [
              {
                editableForNew: true, editableForUpdate: true, required: true,
                layoutComponents: [{ apiName: 'LastName', componentType: 'Field' }],
              },
              {
                editableForNew: true, editableForUpdate: true, required: true,
                layoutComponents: [{ apiName: 'Company', componentType: 'Field' }],
              },
            ],
          }],
        }],
      },
      record: {
        apiName: 'Lead',
        recordTypeId: TEST_RECORD_TYPE_ID,
        fields: {},
      },
    };
  }
  throw new Error(`Unexpected test UI API request: ${url}`);
}

/**
 * Builds the identity runtime a harness runs against.
 *
 * `diagnosticUsername` is a parameter rather than a field of the shared `TEST_IDENTITY_CONFIG`
 * on purpose: the runtime only builds a DIAGNOSTIC scope factory when a diagnostic user is
 * configured, so putting one in the shared config would silently give every existing suite a
 * scope it was never written to exercise — turning "this Tool refused the USER route" into a
 * test that proves nothing about the refusal. A suite opts in explicitly, and only the suites
 * about diagnostic routing do.
 */
export function createTestIdentityRuntime(
  baseRoot: string,
  connectionFactory: SalesforceConnectionFactory = new RecordingConnectionFactory(),
  logger: RuntimeLogger = new NoopRuntimeLogger(),
  diagnosticUsername?: string,
): IdentityRuntime {
  const workspaceFactory = new RequestWorkspaceFactory({ baseRoot });
  return createIdentityRuntime(
    diagnosticUsername === undefined
      ? TEST_IDENTITY_CONFIG
      : { ...TEST_IDENTITY_CONFIG, diagnosticUsername },
    {
      connectionFactory,
      workspaceFactory,
      cwdGuard: new CwdExecutionGuard(),
      logger,
    },
  );
}

export function createTestRemoteConfig(
  overrides: Partial<Omit<RemoteRuntimeConfig, 'identity'>> = {},
): RemoteRuntimeConfig {
  return Object.freeze({
    identity: TEST_IDENTITY_CONFIG,
    controlPlane: Object.freeze({ mode: 'env' }),
    bindHost: '127.0.0.1',
    port: 0,
    mcpPath: '/mcp',
    authMode: 'internal_bearer',
    clientToken: TEST_CLIENT_TOKEN,
    platformUserHeader: 'X-Platform-User-Id',
    platformUserHeaderAliases: Object.freeze([]),
    platformIdentityHeaders: Object.freeze(['X-Platform-User-Id']),
    maxBodyBytes: 1_048_576,
    requestTimeoutMs: 2_000,
    toolTimeoutMs: 1_000,
    enabledTools: Object.freeze(['get_username', 'run_soql_query']),
    dmlAllowlist: parseDmlAllowlistJson(undefined),
    // Attachments are off by default, exactly as they are in the runtime config: a test
    // must opt in explicitly to exercise the ingress.
    attachment: Object.freeze({
      enabled: false,
      path: DEFAULT_ATTACHMENT_PATH,
      ttlMs: DEFAULT_ATTACHMENT_TTL_MS,
      maxFileBytes: DEFAULT_ATTACHMENT_MAX_FILE_BYTES,
      maxFilesPerOwner: DEFAULT_ATTACHMENT_MAX_FILES_PER_OWNER,
    }),
    allowedHosts: Object.freeze([]),
    allowedOrigins: Object.freeze([]),
    useLoopbackHostDefaults: true,
    useLoopbackOriginDefaults: true,
    buntuIdentity: Object.freeze({
      enabled: false,
      timeoutMs: 5_000,
      rawTokenAuditEnabled: false,
    }),
    ...overrides,
  });
}

export function mcpHeaders(platformUserId?: string, token = TEST_CLIENT_TOKEN): Record<string, string> {
  return {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    ...(platformUserId ? { 'x-platform-user-id': platformUserId } : {}),
  };
}

export function initializeBody(id = 1): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'p2-test-client', version: '1.0.0' },
    },
  });
}

export function toolResultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return '';
  return result.content
    .filter((entry): entry is { type: 'text'; text: string } =>
      Boolean(
        entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'text' &&
          'text' in entry &&
          typeof entry.text === 'string',
      ),
    )
    .map((entry) => entry.text)
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the expected test state.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

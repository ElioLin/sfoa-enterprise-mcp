import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZodError } from 'zod';
import {
  BULK_QUERY_COMPLETE_STATE,
  BULK_QUERY_HARD_MAX_RECORDS,
  BULK_QUERY_RESULTS_TOOL_NAME,
  BulkQueryApi,
  type BulkHttpRequest,
  type BulkHttpResponse,
  type BulkQueryApiFactory,
} from '../bulk-query-api.js';
import { GetBulkQueryResultsExecutor } from '../bulk-query-results-executor.js';
import { SubmitBulkQueryExecutor } from '../bulk-query-submit-executor.js';
import { DataRuntimeError } from '../errors.js';
import { BULK_QUERY_TOOL_NAME, ORG_LIMITS_TOOL_NAME } from '../query-records-executor.js';
import {
  BULK_QUERY_RESULTS_DEFAULT_MAX_RECORDS,
  getBulkQueryResultsInputSchema,
  submitBulkQueryInputSchema,
  type GetBulkQueryResultsInput,
  type SubmitBulkQueryInput,
} from '../schemas.js';
import {
  bulkJob,
  bulkResultHeaders,
  bulkRows,
  createFixture,
  salesforceError,
  type DataFixtureOptions,
} from './data-fixtures.js';

const SOQL = 'SELECT Id, Name FROM Account';
/** 18 characters, so it satisfies the Id contract this Tool publishes. */
const JOB_ID = '750000000000001AAA';

type Route = (request: BulkHttpRequest) => BulkHttpResponse | Promise<BulkHttpResponse>;

type Options = DataFixtureOptions & Readonly<{
  enabledToolNames?: readonly string[];
  apiFactory?: BulkQueryApiFactory;
}>;

/**
 * A Bulk API 2.0 endpoint stub.
 *
 * The stub is the **wire**, not the client: a real `BulkQueryApi` sits on top of it, so every
 * test exercises the production job parsing, cursor reading and usage-counter parsing, and only
 * the HTTP exchange is replaced. A stub that replaced the API class instead would let all of
 * that be wrong while the tests still passed.
 */
function api(routes: Readonly<{ create?: Route; job?: Route; results?: Route }>): BulkQueryApiFactory {
  return () => new BulkQueryApi({
    send: async (request) => {
      const route = request.path === '' ? routes.create : request.path.includes('/results') ? routes.results : routes.job;
      if (route === undefined) throw new Error(`Unexpected Bulk call ${request.method} ${request.path}`);
      return route(request);
    },
  }, '65.0');
}

function submit(options: Options = {}) {
  const fixture = createFixture(options);
  const instance = new SubmitBulkQueryExecutor(fixture.orgService, options);
  return {
    fixture,
    /** Runs through the registered input schema, exactly as the Tool does. */
    run: async (input: Readonly<Record<string, unknown>> = {}) =>
      instance.execute(submitBulkQueryInputSchema.parse({ query: SOQL, ...input })),
    /** Runs the executor directly, for a caller that bypassed the Tool's own parse. */
    runRaw: async (input: SubmitBulkQueryInput) => instance.execute(input),
  };
}

function results(options: Options = {}) {
  const fixture = createFixture(options);
  const instance = new GetBulkQueryResultsExecutor(fixture.orgService, options);
  return {
    fixture,
    /** Runs through the registered input schema, exactly as the Tool does. */
    run: async (input: Readonly<Record<string, unknown>> = {}) =>
      instance.execute(getBulkQueryResultsInputSchema.parse({ jobId: JOB_ID, ...input })),
    /** Runs the executor directly, for a caller that bypassed the Tool's own parse. */
    runRaw: async (input: GetBulkQueryResultsInput) => instance.execute(input),
  };
}

function rejection(promise: Promise<unknown>): Promise<DataRuntimeError> {
  return promise.then(
    () => { throw new Error('expected the call to fail'); },
    (thrown: unknown) => thrown as DataRuntimeError,
  );
}

/** A Bulk endpoint that always refuses the way `error` says, so a mapping rule can be named. */
function refusing(error: Error): Route {
  return () => {
    throw error;
  };
}

// ---------------------------------------------------------------------------------------------
// submit_bulk_query
// ---------------------------------------------------------------------------------------------

test('a submission creates a query job and hands back the Id the caller must hold', async () => {
  const seen: BulkHttpRequest[] = [];
  const { run } = submit({
    enabledToolNames: [BULK_QUERY_RESULTS_TOOL_NAME],
    apiFactory: api({
      create: (request) => {
        seen.push(request);
        return {
          body: bulkJob(JOB_ID, { state: 'UploadComplete' }),
          headers: bulkResultHeaders(null, { used: 11, limit: 100 }),
        };
      },
    }),
  });
  const output = await run();

  assert.equal(output.success, true);
  assert.equal(output.jobId, JOB_ID);
  assert.equal(output.state, 'UploadComplete');
  assert.equal(output.operation, 'query');
  assert.equal(output.apiVersion, '65.0');
  assert.deepEqual(output.apiUsage, { used: 11, limit: 100, remaining: 89 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.method, 'POST');
  assert.equal(seen[0]?.path, '');
  assert.deepEqual(JSON.parse(seen[0]?.body ?? ''), {
    operation: 'query',
    query: SOQL,
    contentType: 'CSV',
    columnDelimiter: 'COMMA',
    lineEnding: 'LF',
  });
  assert.match(output.hint ?? '', new RegExp(BULK_QUERY_RESULTS_TOOL_NAME, 'u'));
});

test('a submission never offers an operation other than query, however the caller asks', async () => {
  // The Bulk ingest and DML operations are structurally unreachable: the input schema is strict
  // and declares no `operation` field at all, so there is nothing to accept and nothing to ignore.
  assert.throws(
    () => submitBulkQueryInputSchema.parse({ query: SOQL, operation: 'delete' }),
    (error: unknown) => error instanceof ZodError,
  );
  const bodies: unknown[] = [];
  const { run } = submit({
    apiFactory: api({
      create: (request) => {
        bodies.push(JSON.parse(request.body ?? '{}'));
        return { body: bulkJob(JOB_ID), headers: bulkResultHeaders(null) };
      },
    }),
  });
  await run();
  assert.deepEqual(Object.keys(bodies[0] as object).sort(), [
    'columnDelimiter', 'contentType', 'lineEnding', 'operation', 'query',
  ]);
  assert.equal((bodies[0] as { operation: string }).operation, 'query');
});

test('a statement that is not a single SELECT never reaches Salesforce', () => {
  // The four rules are the ones `inspectSoqlQuery` enforces; a statement Salesforce would
  // reject for its own reasons is not this check's business and is mapped from the platform's
  // answer instead (see the malformed-statement case below).
  for (const [query, why] of [
    ['DELETE FROM Account', 'DML does not begin with SELECT'],
    ['SELECT Id FROM Account;', 'a semicolon ends the statement'],
    ['SELECT Id FROM Account FOR UPDATE', 'FOR UPDATE locks rows'],
    ['SELECT Id FROM Account WHERE Name = \'unterminated', 'the literal is unterminated'],
  ] as const) {
    assert.throws(
      () => submitBulkQueryInputSchema.parse({ query }),
      (error: unknown) => error instanceof ZodError,
      `${why}: ${query}`,
    );
  }
});

test('a statement the registered schema cannot express is re-inspected by the executor', async () => {
  // The wire schema is a raw shape whose JSON Schema cannot carry the statement rules
  // (ADR-0024), so the executor must refuse a statement that reached it unparsed.
  const { runRaw } = submit({ apiFactory: api({ create: () => ({ body: bulkJob(JOB_ID), headers: {} }) }) });
  const error = await rejection(runRaw({ query: 'SELECT Id FROM Account; DROP TABLE Account' }));
  assert.equal(error.code, 'MCP_BULK_QUERY_INVALID');
});

test('a submission refused by the org allowance names get_org_limits only when it is advertised', async () => {
  const refuse = refusing(salesforceError('REQUEST_LIMIT_EXCEEDED', 'TotalRequests Limit exceeded.'));
  const named = await rejection(submit({
    apiFactory: api({ create: refuse }),
    enabledToolNames: [ORG_LIMITS_TOOL_NAME, BULK_QUERY_RESULTS_TOOL_NAME],
  }).run());
  assert.equal(named.code, 'MCP_BULK_LIMIT_EXCEEDED');
  assert.match(named.suggestion ?? '', new RegExp(ORG_LIMITS_TOOL_NAME, 'u'));

  const unnamed = await rejection(submit({
    apiFactory: api({ create: refuse }),
    enabledToolNames: [BULK_QUERY_RESULTS_TOOL_NAME],
  }).run());
  assert.equal(unnamed.code, 'MCP_BULK_LIMIT_EXCEEDED');
  assert.doesNotMatch(unnamed.suggestion ?? '', new RegExp(ORG_LIMITS_TOOL_NAME, 'u'));
});

test('a submission that names an unknown field maps to a query-invalid refusal naming describe_sobject', async () => {
  const { run } = submit({
    apiFactory: api({ create: refusing(salesforceError('INVALID_FIELD', 'No such column \'Nmae\' on entity \'Account\'.')) }),
  });
  const error = await rejection(run());
  assert.equal(error.code, 'MCP_BULK_QUERY_INVALID');
  assert.match(error.suggestion ?? '', /describe_sobject/u);
});

test('a malformed statement is a different refusal from an unknown field', async () => {
  const { run } = submit({
    apiFactory: api({ create: refusing(salesforceError('MALFORMED_QUERY', 'unexpected token')) }),
  });
  assert.equal((await rejection(run())).code, 'MCP_BULK_MALFORMED');
});

test('a submission refused for its permissions is reported, not worked around', async () => {
  const { run } = submit({
    apiFactory: api({ create: refusing(salesforceError('INSUFFICIENT_ACCESS', 'cannot read Account')) }),
  });
  assert.equal((await rejection(run())).code, 'MCP_BULK_ACCESS_DENIED');
});

test('a job Id Salesforce never returned is a defect rather than an unreadable export', async () => {
  const { run } = submit({ apiFactory: api({ create: () => ({ body: { state: 'UploadComplete' }, headers: {} }) }) });
  const error = await rejection(run());
  assert.equal(error.code, 'MCP_BULK_SUBMIT_FAILED');
  assert.match(error.message, /no job Id/u);
});

test('a response with no usable usage counter simply reports no quota rather than a guess', async () => {
  // There is no quota pre-flight by design: no identity this deployment routes may read the
  // `limits` resource (ADR-0027), so the observable quota is the `Sforce-Limit-Info` header a
  // Bulk response itself carries — and a response without a parseable one reports nothing.
  const { run } = submit({
    apiFactory: api({
      create: () => ({ body: bulkJob(JOB_ID), headers: { 'sforce-limit-info': 'api-usage=not-a-counter' } }),
    }),
  });
  const output = await run();
  assert.equal(output.success, true);
  assert.equal('apiUsage' in output, false);
});

// ---------------------------------------------------------------------------------------------
// get_bulk_query_results — the job state machine
// ---------------------------------------------------------------------------------------------

test('a job that has not finished yet returns its state and no rows, and claims nothing more', async () => {
  for (const state of ['UploadComplete', 'InProgress']) {
    const { run } = results({
      apiFactory: api({ job: () => ({ body: bulkJob(JOB_ID, { state }), headers: bulkResultHeaders(null) }) }),
    });
    const output = await run();

    assert.equal(output.success, true, state);
    assert.equal(output.state, state);
    assert.deepEqual(output.records, [], state);
    assert.equal(output.returnedCount, 0, state);
    // The three completeness claims are absent rather than false: "there is no next page" and
    // "there are no rows yet" are the same shape to an Agent that reads only the fields.
    assert.equal('locator' in output, false, state);
    assert.equal('hasMore' in output, false, state);
    assert.equal('complete' in output, false, state);
    assert.equal(output.totalRecords, null, state);
    assert.match(output.hint ?? '', new RegExp(`still ${state}`, 'u'));
  }
});

test('a completed job returns one page with the cursor that reaches the next one', async () => {
  const { run } = results({
    apiFactory: api({
      job: () => ({
        body: bulkJob(JOB_ID, { state: BULK_QUERY_COMPLETE_STATE, numberRecordsProcessed: 5_000 }),
        headers: bulkResultHeaders(null),
      }),
      results: () => ({ body: bulkRows(3), headers: bulkResultHeaders('cursor-1', { used: 12, limit: 100 }) }),
    }),
  });
  const output = await run({ maxRecords: 3 });

  assert.equal(output.success, true);
  assert.equal(output.state, BULK_QUERY_COMPLETE_STATE);
  assert.equal(output.returnedCount, 3);
  assert.equal(output.totalRecords, 5_000);
  assert.equal(output.locator, 'cursor-1');
  assert.equal(output.hasMore, true);
  assert.equal(output.complete, false);
  assert.deepEqual(output.apiUsage, { used: 12, limit: 100, remaining: 88 });
  assert.match(output.hint ?? '', new RegExp(BULK_QUERY_RESULTS_TOOL_NAME, 'u'));
});

test('the last page reports the result set as complete and offers no cursor', async () => {
  const { run } = results({
    apiFactory: api({
      job: () => ({ body: bulkJob(JOB_ID, { numberRecordsProcessed: 2 }), headers: bulkResultHeaders(null) }),
      // Salesforce's terminal cursor is the literal string `null`, not an absent header.
      results: () => ({ body: bulkRows(2), headers: bulkResultHeaders('null') }),
    }),
  });
  const output = await run();

  assert.equal(output.locator, null);
  assert.equal(output.hasMore, false);
  assert.equal(output.complete, true);
  assert.match(output.hint ?? '', /^Complete:/u);
});

test('a Failed job is a structured failure carrying the platform reason, not an empty result', async () => {
  const { run } = results({
    apiFactory: api({
      job: () => ({
        body: bulkJob(JOB_ID, {
          state: 'Failed',
          errorMessage: 'Invalid field: BillingCtiy',
          numberRecordsProcessed: 0,
        }),
        headers: {},
      }),
    }),
  });
  const output = await run();

  assert.equal(output.success, false);
  assert.equal(output.errorCode, 'MCP_BULK_JOB_FAILED');
  assert.equal(output.state, 'Failed');
  assert.equal(output.stateMessage, 'Invalid field: BillingCtiy');
  assert.match(output.suggestion ?? '', new RegExp(BULK_QUERY_TOOL_NAME, 'u'));
  assert.deepEqual(output.records, []);
});

test('an Aborted job is reported the same way as a failed one', async () => {
  const { run } = results({
    apiFactory: api({ job: () => ({ body: bulkJob(JOB_ID, { state: 'Aborted' }), headers: {} }) }),
  });
  const output = await run();
  assert.equal(output.success, false);
  assert.equal(output.errorCode, 'MCP_BULK_JOB_FAILED');
  assert.equal(output.state, 'Aborted');
});

test('a job state this contract does not know is reported as unknown and read as still running', async () => {
  const { run } = results({
    apiFactory: api({ job: () => ({ body: bulkJob(JOB_ID, { state: 'SomethingNew' }), headers: {} }) }),
  });
  const output = await run();
  assert.equal(output.success, true);
  assert.equal(output.state, 'unknown');
  assert.deepEqual(output.records, []);
});

// ---------------------------------------------------------------------------------------------
// get_bulk_query_results — paging
// ---------------------------------------------------------------------------------------------

test('a continuation passes the cursor back and never asks Salesforce for the whole result set', async () => {
  const resultPaths: string[] = [];
  const { run } = results({
    apiFactory: api({
      job: () => ({ body: bulkJob(JOB_ID, { numberRecordsProcessed: 10 }), headers: bulkResultHeaders(null) }),
      results: (request) => {
        resultPaths.push(request.path);
        return {
          body: bulkRows(4),
          headers: bulkResultHeaders(request.path.includes('locator=cursor-1') ? null : 'cursor-1'),
        };
      },
    }),
  });

  const first = await run({ maxRecords: 4 });
  const second = await run({ maxRecords: 4, locator: first.locator ?? undefined });

  assert.deepEqual(resultPaths, [
    `/${JOB_ID}/results?maxRecords=4`,
    `/${JOB_ID}/results?maxRecords=4&locator=cursor-1`,
  ]);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
});

test('every call re-reads the job rather than remembering it, because no state survives a request', async () => {
  const paths: string[] = [];
  const { run } = results({
    apiFactory: api({
      job: (request) => {
        paths.push(`job ${request.path}`);
        return { body: bulkJob(JOB_ID, { numberRecordsProcessed: 1 }), headers: bulkResultHeaders(null) };
      },
      results: (request) => {
        paths.push(`results ${request.path}`);
        return { body: bulkRows(1), headers: bulkResultHeaders(null) };
      },
    }),
  });
  await run();
  await run();
  // Two identical reads ask Salesforce the same two questions: the jobId is the caller's, and
  // this Tool deliberately stores nothing between calls.
  assert.deepEqual(paths, [
    `job /${JOB_ID}`, `results /${JOB_ID}/results?maxRecords=2000`,
    `job /${JOB_ID}`, `results /${JOB_ID}/results?maxRecords=2000`,
  ]);
});

test('maxRecords is bounded to Salesforce\'s own cap however the caller asks', async () => {
  const resultPaths: string[] = [];
  const { run } = results({
    apiFactory: api({
      job: () => ({ body: bulkJob(JOB_ID), headers: bulkResultHeaders(null) }),
      results: (request) => {
        resultPaths.push(request.path);
        return { body: bulkRows(1), headers: bulkResultHeaders(null) };
      },
    }),
  });
  await run({ maxRecords: BULK_QUERY_HARD_MAX_RECORDS });
  assert.match(resultPaths[0] ?? '', new RegExp(`maxRecords=${BULK_QUERY_HARD_MAX_RECORDS}`, 'u'));
  assert.equal(
    getBulkQueryResultsInputSchema.safeParse({ jobId: JOB_ID, maxRecords: BULK_QUERY_HARD_MAX_RECORDS + 1 }).success,
    false,
  );
});

test('rows are returned exactly as Bulk API 2.0 served them: every value a string', async () => {
  const { run } = results({
    apiFactory: api({
      job: () => ({ body: bulkJob(JOB_ID), headers: {} }),
      results: () => ({ body: [{ Id: '001', Amount: '42.5', Description: '' }], headers: bulkResultHeaders(null) }),
    }),
  });
  const output = await run();
  assert.deepEqual(output.records, [{ Id: '001', Amount: '42.5', Description: '' }]);
});

test('the result carries the job total and no cumulative read count, because none can be known', async () => {
  const { run } = results({
    apiFactory: api({
      job: () => ({
        body: bulkJob(JOB_ID, { numberRecordsProcessed: 9, numberRecordsFailed: 1 }),
        headers: bulkResultHeaders(null),
      }),
      results: () => ({ body: bulkRows(9), headers: bulkResultHeaders(null) }),
    }),
  });
  const output = await run();
  assert.equal(output.totalRecords, 9);
  assert.equal(output.numberRecordsProcessed, 9);
  assert.equal(output.numberRecordsFailed, 1);
  // A cumulative count would require remembering how many rows earlier calls returned, which is
  // exactly the server-side job state this design forbids; `returnedCount` is this page only.
  assert.equal('fetchedCumulative' in output, false);
});

// ---------------------------------------------------------------------------------------------
// get_bulk_query_results — the response budget
// ---------------------------------------------------------------------------------------------

test('a page too wide for one response is re-read smaller from the same cursor, skipping nothing', async () => {
  const resultPaths: string[] = [];
  const { run } = results({
    apiFactory: api({
      job: () => ({ body: bulkJob(JOB_ID, { numberRecordsProcessed: 500 }), headers: bulkResultHeaders(null) }),
      results: (request) => {
        resultPaths.push(request.path);
        const maxRecords = Number(/maxRecords=(\d+)/u.exec(request.path)?.[1] ?? '0');
        // Rows wide enough that the per-response character budget can hold only a few of them.
        const rows = Array.from({ length: maxRecords }, (_, index) => ({
          Id: `001${index}`,
          Blob: 'x'.repeat(40_000),
        }));
        return { body: rows, headers: bulkResultHeaders('cursor-next', { used: 1, limit: 100 }) };
      },
    }),
  });

  const output = await run({ maxRecords: 100 });

  assert.equal(resultPaths.length, 2, 'the page must be re-requested exactly once');
  assert.match(resultPaths[0] ?? '', /maxRecords=100/u);
  const retryCount = Number(/maxRecords=(\d+)/u.exec(resultPaths[1] ?? '')?.[1] ?? '0');
  assert.ok(retryCount > 0 && retryCount < 100, `the retry must ask for fewer rows, asked for ${retryCount}`);
  // Both reads start from the *same* position, which is what makes the smaller page a prefix of
  // the larger one rather than a different window over the result set.
  assert.equal(/locator=/u.test(resultPaths[0] ?? ''), false);
  assert.equal(/locator=/u.test(resultPaths[1] ?? ''), false);
  assert.equal(output.returnedCount, retryCount);
  assert.equal(output.locator, 'cursor-next');
  assert.equal(output.hasMore, true);
});

test('a single row too wide for one response fails instead of returning a truncated page', async () => {
  const { run } = results({
    apiFactory: api({
      job: () => ({ body: bulkJob(JOB_ID, { numberRecordsProcessed: 1 }), headers: bulkResultHeaders(null) }),
      results: () => ({ body: [{ Id: '001', Blob: 'x'.repeat(300_000) }], headers: bulkResultHeaders(null) }),
    }),
  });
  const error = await rejection(run());
  assert.equal(error.code, 'MCP_BULK_SLICE_TOO_LARGE');
  assert.match(error.suggestion ?? '', /Narrow the statement/u);
});

// ---------------------------------------------------------------------------------------------
// get_bulk_query_results — failure mapping
// ---------------------------------------------------------------------------------------------

test('a job Salesforce does not know is reported as gone, not as a retryable failure', async () => {
  const { run } = results({
    apiFactory: api({ job: refusing(salesforceError('NOT_FOUND', 'The requested resource does not exist')) }),
  });
  const error = await rejection(run());
  assert.equal(error.code, 'MCP_BULK_JOB_NOT_FOUND');
  assert.match(error.suggestion ?? '', new RegExp(BULK_QUERY_TOOL_NAME, 'u'));
});

test('another identity\'s job is refused and the refusal is not worked around', async () => {
  const { run } = results({
    apiFactory: api({ job: refusing(salesforceError('INSUFFICIENT_ACCESS', 'You do not have access to this job')) }),
  });
  const error = await rejection(run());
  assert.equal(error.code, 'MCP_BULK_ACCESS_DENIED');
  assert.match(error.suggestion ?? '', /do not attempt to read a job this identity did not create/u);
});

test('a rejected cursor says to restart from the beginning rather than to retry it', async () => {
  const { run } = results({
    apiFactory: api({
      job: () => ({ body: bulkJob(JOB_ID, { numberRecordsProcessed: 5 }), headers: bulkResultHeaders(null) }),
      results: refusing(salesforceError('INVALID_QUERY_LOCATOR', 'Invalid query locator')),
    }),
  });
  const error = await rejection(run({ locator: 'stale-cursor' }));
  assert.equal(error.code, 'MCP_BULK_RESULTS_FAILED');
  assert.match(error.suggestion ?? '', /omitting locator/u);
});

test('an exhausted allowance while reading a page names get_org_limits only when advertised', async () => {
  const refuse = refusing(salesforceError('API_DISABLED_FOR_ORG', 'API is disabled for this org'));
  const named = await rejection(results({
    apiFactory: api({ job: refuse }),
    enabledToolNames: [ORG_LIMITS_TOOL_NAME],
  }).run());
  assert.equal(named.code, 'MCP_BULK_LIMIT_EXCEEDED');
  assert.match(named.message, new RegExp(ORG_LIMITS_TOOL_NAME, 'u'));

  const unnamed = await rejection(results({
    apiFactory: api({ job: refuse }),
    enabledToolNames: [BULK_QUERY_RESULTS_TOOL_NAME],
  }).run());
  assert.equal(unnamed.code, 'MCP_BULK_LIMIT_EXCEEDED');
  assert.doesNotMatch(unnamed.message, new RegExp(ORG_LIMITS_TOOL_NAME, 'u'));
});

// ---------------------------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------------------------

test('a jobId must be a 15- or 18-character Salesforce Id', () => {
  for (const jobId of ['750000000000001', '750000000000001AAA']) {
    assert.equal(getBulkQueryResultsInputSchema.safeParse({ jobId }).success, true, jobId);
  }
  for (const jobId of ['', '750000000000001A', '750000000000001AAAA', '75000000000000-', 'not-a-salesforce-id']) {
    assert.equal(getBulkQueryResultsInputSchema.safeParse({ jobId }).success, false, jobId);
  }
});

test('a cursor is optional, but the literal "null" is not a cursor', () => {
  assert.equal(getBulkQueryResultsInputSchema.safeParse({ jobId: JOB_ID }).success, true);
  assert.equal(getBulkQueryResultsInputSchema.safeParse({ jobId: JOB_ID, locator: 'cursor-1' }).success, true);
  for (const locator of ['', 'null', 'NULL']) {
    assert.equal(getBulkQueryResultsInputSchema.safeParse({ jobId: JOB_ID, locator }).success, false, locator);
  }
});

test('a result read takes no field the Tool does not declare', () => {
  assert.equal(getBulkQueryResultsInputSchema.safeParse({ jobId: JOB_ID, query: SOQL }).success, false);
  assert.equal(getBulkQueryResultsInputSchema.safeParse({ jobId: JOB_ID, maxRecords: 0 }).success, false);
  assert.equal(getBulkQueryResultsInputSchema.parse({ jobId: JOB_ID }).maxRecords, undefined);
  assert.equal(BULK_QUERY_RESULTS_DEFAULT_MAX_RECORDS, 2_000);
});

// ---------------------------------------------------------------------------------------------
// The transport wrapper
// ---------------------------------------------------------------------------------------------

test('the cursor and the usage counter are read from response headers, through the Connection transport', async () => {
  // The whole capability depends on this: neither `Sforce-Locator` nor `Sforce-Limit-Info`
  // appears in a response body, so a client that read only the body would page incorrectly and
  // report no quota at all. The fixture emulates jsforce's own transport, so this proves the
  // capture happens *through* it rather than around it.
  const fixture = createFixture({
    bulk: (request) => (request.url.includes('/results')
      ? { body: bulkRows(2), headers: bulkResultHeaders('from-a-header', { used: 30, limit: 200 }) }
      : { body: bulkJob(JOB_ID, { numberRecordsProcessed: 40 }), headers: bulkResultHeaders(null) }),
  });
  const output = await new GetBulkQueryResultsExecutor(fixture.orgService).execute(
    getBulkQueryResultsInputSchema.parse({ jobId: JOB_ID, maxRecords: 2 }),
  );

  assert.equal(output.locator, 'from-a-header');
  assert.equal(output.hasMore, true);
  assert.deepEqual(output.apiUsage, { used: 30, limit: 200, remaining: 170 });
  // The URL the transport saw is the version-relative one jsforce expands: the provider
  // assembles neither an instance URL nor an API version.
  assert.deepEqual(fixture.calls.map((call) => call.argument), [
    `GET /jobs/query/${JOB_ID}`,
    `GET /jobs/query/${JOB_ID}/results?maxRecords=2`,
  ]);
});

test('a Connection that exposes no transport fails the read rather than reporting no results', async () => {
  const orgService = {
    getAllowedOrgUsernames: async () => new Set(['user@example.test']),
    getConnection: async () => ({ query: async () => ({}) }),
  } as never;
  const error = await rejection(new GetBulkQueryResultsExecutor(orgService).execute(
    getBulkQueryResultsInputSchema.parse({ jobId: JOB_ID }),
  ));
  assert.equal(error.code, 'MCP_BULK_RESULTS_FAILED');
  assert.match(error.message, /exposes no transport/u);
});

test('a Bulk result that is not a CSV page is a failure rather than an empty result set', async () => {
  const { run } = results({
    apiFactory: api({
      job: () => ({ body: bulkJob(JOB_ID), headers: {} }),
      results: () => ({ body: { records: [] }, headers: bulkResultHeaders(null) }),
    }),
  });
  const error = await rejection(run());
  assert.equal(error.code, 'MCP_BULK_RESULTS_FAILED');
  assert.match(error.message, /did not return a CSV result page/u);
});

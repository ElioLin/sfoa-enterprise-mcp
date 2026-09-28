import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZodError } from 'zod';
import { DataRuntimeError } from '../errors.js';
import { BULK_QUERY_TOOL_NAME, ORG_LIMITS_TOOL_NAME, QueryRecordsExecutor } from '../query-records-executor.js';
import { queryRecordsInputSchema, type QueryRecordsInput } from '../schemas.js';
import { createFixture, idRows, queryBatch, rows, salesforceError, type DataFixtureOptions } from './data-fixtures.js';

const SOQL = 'SELECT Id, Name FROM Account';

type Handler = NonNullable<DataFixtureOptions['handler']>;

function executor(
  handler: Handler,
  options: Readonly<{ enabledToolNames?: readonly string[]; timeBudgetMs?: number; now?: () => number }> = {},
) {
  const fixture = createFixture({ handler });
  const executorInstance = new QueryRecordsExecutor(fixture.orgService, options);
  return {
    fixture,
    /** Runs through the registered input schema, exactly as the Tool does. */
    run: async (input: Readonly<Record<string, unknown>> = {}) =>
      executorInstance.execute(queryRecordsInputSchema.parse({ query: SOQL, ...input })),
    /** Runs the executor directly, for a caller that bypassed the Tool's own parse. */
    runRaw: async (input: QueryRecordsInput) => executorInstance.execute(input),
  };
}

function rejection(promise: Promise<unknown>): Promise<DataRuntimeError> {
  return promise.then(
    () => { throw new Error('expected the call to fail'); },
    (thrown: unknown) => thrown as DataRuntimeError,
  );
}

test('a result that fits one batch is reported as complete with no truncation', async () => {
  const { fixture, run } = executor(() => queryBatch(rows(3)));
  const output = await run();

  assert.equal(output.success, true);
  assert.equal(output.totalSize, 3);
  assert.equal(output.fetched, 3);
  assert.equal(output.returnedCount, 3);
  assert.equal(output.pages, 1);
  assert.equal(output.done, true);
  assert.equal(output.complete, true);
  assert.equal(output.truncated, false);
  assert.equal(output.truncatedReason, null);
  assert.equal(output.aggregate, false);
  assert.match(output.hint ?? '', /Complete result: all 3 matching rows/u);
  assert.deepEqual(fixture.calls.map((call) => call.operation), ['query']);
});

test('a result larger than one batch is followed through the cursor until done', async () => {
  const first = '/services/data/v67.0/query/01g-0500';
  const second = '/services/data/v67.0/query/01g-1000';
  const batches = new Map<string, unknown>([
    [first, queryBatch(idRows(500, 'b'), { done: false, totalSize: 1500, nextRecordsUrl: second })],
    [second, queryBatch(idRows(500, 'c'), { totalSize: 1500 })],
  ]);
  const { fixture, run } = executor((operation, argument) => {
    if (operation === 'query') {
      return queryBatch(idRows(500, 'a'), { done: false, totalSize: 1500, nextRecordsUrl: first });
    }
    const batch = argument === undefined ? undefined : batches.get(argument);
    if (batch === undefined) throw new Error(`Unexpected cursor ${String(argument)}`);
    return batch;
  });
  const output = await run({ maxRows: 5000 });

  assert.equal(output.totalSize, 1500);
  assert.equal(output.fetched, 1500);
  assert.equal(output.returnedCount, 1500);
  assert.equal(output.pages, 3);
  assert.equal(output.done, true);
  assert.equal(output.complete, true);
  assert.equal(output.truncated, false);
  assert.deepEqual(fixture.calls.map((call) => call.operation), ['query', 'queryMore', 'queryMore']);
  assert.equal(output.records?.[0]?.Id, 'a0');
  assert.equal(output.records?.[1499]?.Id, 'c499');
});

test('maxRows stops the walk mid-batch and declares MAX_ROWS with the rows actually read', async () => {
  const { fixture, run } = executor(() =>
    queryBatch(rows(2000), { done: false, totalSize: 9000, nextRecordsUrl: '/next' }));
  const output = await run({ maxRows: 500 });

  assert.equal(output.totalSize, 9000);
  assert.equal(output.fetched, 500);
  assert.equal(output.returnedCount, 500);
  assert.equal(output.pages, 1);
  assert.equal(output.done, false);
  assert.equal(output.complete, false);
  assert.equal(output.truncated, true);
  assert.equal(output.truncatedReason, 'MAX_ROWS');
  assert.match(output.hint ?? '', /Truncated by MAX_ROWS/u);
  assert.match(output.hint ?? '', /500 of 9000 matching rows were read/u);
  // The cursor was never followed: the row budget was already spent on the first batch.
  assert.deepEqual(fixture.calls.map((call) => call.operation), ['query']);
});

test('the continuation budget truncates in place with TIME_BUDGET rather than failing', async () => {
  let clock = 0;
  const { run } = executor(
    (operation) => queryBatch(rows(100), { done: false, totalSize: 5000, nextRecordsUrl: `/${operation}/next` }),
    { timeBudgetMs: 1_000, now: () => { clock += 600; return clock; } },
  );
  const output = await run({ maxRows: 5000 });

  assert.equal(output.truncated, true);
  assert.equal(output.truncatedReason, 'TIME_BUDGET');
  assert.equal(output.done, false);
  assert.equal(output.complete, false);
  assert.equal(output.fetched, 200);
  assert.match(output.hint ?? '', /Truncated by TIME_BUDGET/u);
});

test('a platform that declares more rows but hands out no cursor is not reported as complete', async () => {
  const { run } = executor(() => queryBatch(rows(200), { done: true, totalSize: 900 }));
  const output = await run();

  assert.equal(output.done, true);
  assert.equal(output.totalSize, 900);
  assert.equal(output.fetched, 200);
  assert.equal(output.complete, false);
  assert.equal(output.truncated, true);
  assert.equal(output.truncatedReason, 'PAGINATION_UNAVAILABLE');
  assert.match(output.hint ?? '', /Truncated by PAGINATION_UNAVAILABLE/u);
});

test('a result with no reported totalSize is not claimed to be complete', async () => {
  const { run } = executor(() => ({ done: true, records: rows(2) }));
  const output = await run();

  assert.equal(output.totalSize, null);
  assert.equal(output.complete, false);
  assert.equal(output.truncated, false);
  assert.match(output.hint ?? '', /did not report a total size/u);
});

test('an aggregate query is detected and its truncation hint points at maxRows, not at the org size', async () => {
  const { run } = executor(() =>
    queryBatch([{ expr0: 42 }], { done: false, totalSize: 900, nextRecordsUrl: '/next' }));
  const output = await run({ query: "SELECT COUNT(Id) FROM Account WHERE Name != 'x'", maxRows: 1 });

  assert.equal(output.aggregate, true);
  assert.equal(output.truncated, true);
  assert.equal(output.truncatedReason, 'MAX_ROWS');
  assert.match(output.hint ?? '', /aggregate query/u);
  assert.match(output.hint ?? '', /bounded by the grouping rather than by the size of the org/u);
  assert.match(output.hint ?? '', /maxRows above 1/u);
  assert.doesNotMatch(output.hint ?? '', /COUNT\(\) or GROUP BY, which returns a bounded result/u);
});

test('a GROUP BY aggregate that fits is complete without a truncation reason', async () => {
  const { run } = executor(() => queryBatch([{ Name: 'A', expr0: 1 }, { Name: 'B', expr0: 2 }]));
  const output = await run({ query: 'SELECT Name, COUNT(Id) FROM Account GROUP BY Name' });

  assert.equal(output.aggregate, true);
  assert.equal(output.complete, true);
  assert.equal(output.truncated, false);
});

test('a bare COUNT() is complete with its value in aggregateValue, not a false truncation', async () => {
  // Salesforce answers a bare COUNT() with the value in `totalSize` and `records: []`. Comparing
  // that value to the row count reported a correct count as truncated by PAGINATION_UNAVAILABLE.
  for (const count of [0, 4449]) {
    const { run } = executor(() => queryBatch([], { totalSize: count }));
    const output = await run({ query: 'SELECT COUNT() FROM IntermediateTable__c' });

    assert.equal(output.aggregate, true, `for a count of ${count}`);
    assert.equal(output.aggregateValue, count, `for a count of ${count}`);
    assert.equal(output.totalSize, null, `for a count of ${count}`);
    assert.equal(output.fetched, 0, `for a count of ${count}`);
    assert.equal(output.done, true, `for a count of ${count}`);
    assert.equal(output.complete, true, `for a count of ${count}`);
    assert.equal(output.truncated, false, `for a count of ${count}`);
    assert.equal(output.truncatedReason, null, `for a count of ${count}`);
    assert.match(output.hint ?? '', new RegExp(`reported its value as ${count} in aggregateValue`, 'u'));
    // A zero count is a value, not a missing one: the hint must still be the aggregate one
    // rather than the "no total size reported" branch, which would read as an unknown answer.
    assert.doesNotMatch(output.hint ?? '', /did not report a total size/u);
  }
});

test('a named aggregate returns a row and keeps its own totalSize', async () => {
  // `COUNT(Id) total` is one AggregateResult row, so this is the shape where totalSize really
  // is the row count and the value lives in the record — the carve-out must not capture it.
  const { run } = executor(() => queryBatch([{ total: 4449 }]));
  const output = await run({ query: 'SELECT COUNT(Id) total FROM IntermediateTable__c' });

  assert.equal(output.aggregate, true);
  assert.equal(output.aggregateValue, null);
  assert.equal(output.totalSize, 1);
  assert.equal(output.fetched, 1);
  assert.equal(output.complete, true);
  assert.equal(output.truncated, false);
  assert.equal(output.records?.[0]?.total, 4449);
});

test('a grouped aggregate short of its own totalSize is still reported as truncated', async () => {
  // The scalar carve-out keys on there being no rows at all. A grouped aggregate does have a
  // row set, so it keeps the declared-short reading — otherwise the fix would have traded one
  // false completeness claim for another.
  const { run } = executor(() => queryBatch([{ Name: 'A', expr0: 1 }], { totalSize: 40 }));
  const output = await run({ query: 'SELECT Name, COUNT(Id) FROM Account GROUP BY Name' });

  assert.equal(output.aggregate, true);
  assert.equal(output.aggregateValue, null);
  assert.equal(output.totalSize, 40);
  assert.equal(output.complete, false);
  assert.equal(output.truncated, true);
  assert.equal(output.truncatedReason, 'PAGINATION_UNAVAILABLE');
});

test('the bulk-export hint names submit_bulk_query only when that Tool is advertised', async () => {
  const truncating = () => queryBatch(rows(10), { done: false, totalSize: 100, nextRecordsUrl: '/next' });
  const disabled = await executor(truncating).run({ maxRows: 10 });
  assert.doesNotMatch(disabled.hint ?? '', new RegExp(BULK_QUERY_TOOL_NAME, 'u'));
  assert.match(disabled.hint ?? '', /ask an administrator to enable the bulk query capability/u);

  const enabled = await executor(truncating, { enabledToolNames: ['query_records', BULK_QUERY_TOOL_NAME] })
    .run({ maxRows: 10 });
  assert.match(enabled.hint ?? '', new RegExp(`call ${BULK_QUERY_TOOL_NAME}`, 'u'));
});

test('the limits error names get_org_limits only when that Tool is advertised', async () => {
  const failing = () => { throw salesforceError('REQUEST_LIMIT_EXCEEDED', 'api calls exceeded'); };
  const disabled = await rejection(executor(failing).run());
  assert.doesNotMatch(disabled.message, new RegExp(ORG_LIMITS_TOOL_NAME, 'u'));
  assert.doesNotMatch(disabled.suggestion ?? '', new RegExp(ORG_LIMITS_TOOL_NAME, 'u'));

  const enabled = await rejection(executor(failing, { enabledToolNames: [ORG_LIMITS_TOOL_NAME] }).run());
  assert.match(enabled.message, new RegExp(ORG_LIMITS_TOOL_NAME, 'u'));
  assert.equal(enabled.code, 'MCP_QUERY_LIMIT_EXCEEDED');
});

test('every error mapping carries its contract code, a sanitized message and a next step', async () => {
  const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
    ['INVALID_FIELD', 'MCP_QUERY_FIELD_INVALID', /describe_sobject/u],
    ['INVALID_TYPE', 'MCP_QUERY_FIELD_INVALID', /useToolingApi=true/u],
    ['MALFORMED_QUERY', 'MCP_QUERY_MALFORMED', /cannot join tables/u],
    ['REQUEST_LIMIT_EXCEEDED', 'MCP_QUERY_LIMIT_EXCEEDED', /24-hour rolling allowance/u],
    ['INSUFFICIENT_ACCESS', 'MCP_QUERY_ACCESS_DENIED', /permission/u],
  ];
  for (const [salesforceCode, expectedCode, suggestion] of cases) {
    const { run } = executor(() => { throw salesforceError(salesforceCode, 'provider detail'); });
    const error = await rejection(run());
    assert.equal(error.code, expectedCode, `for ${salesforceCode}`);
    // The provider's own message is repeated only alongside a code, which proves it is a
    // provider-authored string rather than an arbitrary thrown value.
    assert.ok(error.message.includes('provider detail'), `for ${salesforceCode}`);
    assert.match(error.suggestion ?? '', suggestion, `for ${salesforceCode}`);
  }
});

test('an unknown provider failure degrades to the generic code and never echoes an uncoded message', async () => {
  const { run } = executor(() => { throw new Error('socket hang up while connecting to 10.0.0.9'); });
  const error = await rejection(run());

  assert.equal(error.code, 'MCP_QUERY_RECORDS_FAILED');
  assert.doesNotMatch(error.message, /10\.0\.0\.9/u);
  assert.doesNotMatch(error.message, /socket hang up/u);
});

test('a statement the Tool refuses never reaches Salesforce', async () => {
  const refused = [
    'DELETE FROM Account',
    'SELECT Id FROM Account; DELETE FROM Account',
    'SELECT Id FROM Account FOR UPDATE',
    "SELECT Id FROM Account WHERE Name = 'unterminated",
  ];
  for (const query of refused) {
    // The registered schema is a raw shape whose JSON Schema cannot carry these rules
    // (ADR-0024), so the Tool's own parse is the first gate ...
    assert.throws(() => queryRecordsInputSchema.parse({ query }), ZodError, `for ${query}`);
    // ... and the executor re-checks, so a caller that bypassed that parse still cannot spend
    // a Salesforce round trip on a statement this Tool will not run.
    const { fixture, runRaw } = executor(() => queryBatch(rows(1)));
    const error = await rejection(runRaw({ query } as unknown as QueryRecordsInput));
    assert.equal(error.code, 'MCP_DATA_INVALID_INPUT', `for ${query}`);
    assert.deepEqual(fixture.calls, [], `no round trip for ${query}`);
  }
});

test('a semicolon inside a string literal is not mistaken for a second statement', async () => {
  const { fixture, run } = executor(() => queryBatch(rows(1)));
  const output = await run({ query: "SELECT Id FROM Account WHERE Name = 'a;b'" });

  assert.equal(output.success, true);
  assert.deepEqual(fixture.calls.map((call) => call.operation), ['query']);
});

test('a zero-result query is complete, not truncated', async () => {
  const { run } = executor(() => queryBatch([]));
  const output = await run();

  assert.equal(output.totalSize, 0);
  assert.equal(output.fetched, 0);
  assert.equal(output.complete, true);
  assert.equal(output.truncated, false);
  assert.match(output.hint ?? '', /all 0 matching rows/u);
});

test('the Tooling API is used only when useToolingApi is set', async () => {
  const data = executor(() => queryBatch(rows(1)));
  await data.run();
  assert.deepEqual(data.fixture.calls.map((call) => call.operation), ['query']);

  const tooling = executor(() => queryBatch(rows(1)));
  const output = await tooling.run({ useToolingApi: true, query: 'SELECT Id FROM ApexClass' });
  assert.deepEqual(tooling.fixture.calls.map((call) => call.operation), ['toolingQuery']);
  assert.equal(output.useToolingApi, true);
});

test('the Tooling API continuation uses the Tooling cursor, not the data cursor', async () => {
  const { fixture, run } = executor((operation) => (operation === 'toolingQuery'
    ? queryBatch(rows(50), { done: false, totalSize: 80, nextRecordsUrl: '/tooling/next' })
    : queryBatch(rows(30), { totalSize: 80 })));
  const output = await run({ useToolingApi: true, query: 'SELECT Id FROM ApexClass' });

  assert.deepEqual(fixture.calls.map((call) => call.operation), ['toolingQuery', 'toolingQueryMore']);
  assert.equal(output.complete, true);
  assert.equal(output.fetched, 80);
});

test('the response budget truncates the returned slice and says so, without losing why fetching stopped', async () => {
  const wide = Array.from({ length: 400 }, (_, index) => ({ Id: `r${index}`, Description: 'x'.repeat(2_000) }));
  const { run } = executor(() =>
    queryBatch(wide, { done: false, totalSize: 5_000, nextRecordsUrl: '/next' }));
  const output = await run({ maxRows: 400 });

  assert.equal(output.truncated, true);
  assert.equal(output.truncatedReason, 'RESPONSE_BUDGET');
  assert.equal(output.fetched, 400);
  assert.ok((output.returnedCount ?? 0) < 400, 'the slice is shorter than what was fetched');
  assert.equal(output.records?.length, output.returnedCount);
  assert.match(output.hint ?? '', /Truncated by MAX_ROWS \+ RESPONSE_BUDGET/u);
  assert.ok(JSON.stringify(output).length <= 60_000, 'the structured payload stays inside the character budget');
});

test('a batch entry that is not a row is dropped rather than reported as a record', async () => {
  const { run } = executor(() => queryBatch([{ Id: 'a' }, null, 'text', 7, { Id: 'b' }]));
  const output = await run();

  assert.deepEqual(output.records, [{ Id: 'a' }, { Id: 'b' }]);
  assert.equal(output.returnedCount, 2);
});

test('a request whose identity does not resolve to exactly one USER is refused before any call', async () => {
  const fixture = createFixture({
    usernames: ['a@example.test', 'b@example.test'],
    handler: () => queryBatch(rows(1)),
  });
  const error = await rejection(new QueryRecordsExecutor(fixture.orgService).execute(
    queryRecordsInputSchema.parse({ query: SOQL }),
  ));

  assert.equal(error.code, 'MCP_DATA_IDENTITY_UNAVAILABLE');
  assert.deepEqual(fixture.calls, []);
});

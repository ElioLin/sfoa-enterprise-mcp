import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZodError } from 'zod';
import { DataRuntimeError } from '../errors.js';
import { SearchRecordsExecutor } from '../search-records-executor.js';
import { searchRecordsInputSchema, searchRecordsOutputSchema, type SearchRecordGroup, type SearchRecordsInput, type SearchRecordsOutput } from '../schemas.js';
import {
  composeSoslKeywordStatement,
  escapeSoslKeyword,
  findGlobalSoslLimit,
  findSoslReturningLimits,
  inspectSoslSearch,
  planSoslSearch,
  SOSL_MAX_STATEMENT_LENGTH,
} from '../sosl.js';
import {
  createFixture,
  salesforceError,
  searchPayload,
  searchRecord,
  type DataFixtureOptions,
} from './data-fixtures.js';

type Handler = NonNullable<DataFixtureOptions['handler']>;

function executor(handler: Handler, options: Readonly<{ enabledToolNames?: readonly string[] }> = {}) {
  const fixture = createFixture({ handler });
  const instance = new SearchRecordsExecutor(fixture.orgService, options);
  return {
    fixture,
    /** Runs through the registered input schema, exactly as the Tool does. */
    run: async (input: Readonly<Record<string, unknown>>) =>
      instance.execute(searchRecordsInputSchema.parse(input)),
    /** Runs the executor directly, for a caller that bypassed the Tool's own parse. */
    runRaw: async (input: Readonly<Record<string, unknown>>) =>
      instance.execute(input as SearchRecordsInput),
  };
}

function rejection(promise: Promise<unknown>): Promise<DataRuntimeError> {
  return promise.then(
    () => { throw new Error('expected the call to fail'); },
    (thrown: unknown) => thrown as DataRuntimeError,
  );
}

/** The group for one object, asserted present so a missing group fails as itself rather than as `undefined`. */
function group(output: SearchRecordsOutput, objectApiName: string): SearchRecordGroup {
  const found = output.resultsByObject?.[objectApiName];
  assert.ok(found !== undefined, `${objectApiName} must appear in resultsByObject`);
  return found;
}

test('a bare keyword is composed byte for byte, with and without an object scope', async () => {
  const cases: ReadonlyArray<Readonly<{ input: Record<string, unknown>; statement: string }>> = [
    { input: { search: 'acme' }, statement: 'FIND {acme} IN ALL FIELDS LIMIT 20' },
    { input: { search: 'Acme Corp' }, statement: 'FIND {Acme Corp} IN ALL FIELDS LIMIT 20' },
    {
      input: { search: 'acme', objects: ['Account'] },
      statement: 'FIND {acme} IN ALL FIELDS RETURNING Account(Id, Name) LIMIT 20',
    },
    {
      input: { search: 'acme', objects: ['Account', 'Contact'], limit: 3 },
      statement: 'FIND {acme} IN ALL FIELDS RETURNING Account(Id, Name), Contact(Id, Name) LIMIT 3',
    },
    {
      input: { search: 'acme', objects: ['Case'], fields: ['Id', 'Subject'] },
      statement: 'FIND {acme} IN ALL FIELDS RETURNING Case(Id, Subject) LIMIT 20',
    },
  ];
  for (const { input, statement } of cases) {
    const { fixture, run } = executor(() => searchPayload([]));
    const output = await run(input);

    assert.equal(output.mode, 'KEYWORD');
    assert.equal(output.statement, statement, JSON.stringify(input));
    // The statement is also what reached Salesforce: the composed text and the sent text are one fact.
    assert.deepEqual(fixture.calls, [{ operation: 'search', argument: statement }]);
    assert.equal(output.limitSource, 'REQUEST');
  }
});

test('every SOSL reserved character in a bare keyword is escaped, so a term stays a term', () => {
  const reserved = '?&|![]()^~*:\\"\'+-';
  for (const char of reserved) {
    assert.equal(escapeSoslKeyword(`a${char}b`), `a\\${char}b`, `${char} must be escaped`);
  }
  assert.equal(escapeSoslKeyword("O'Brien"), "O\\'Brien");
  assert.equal(escapeSoslKeyword('acme\\'), 'acme\\\\', 'a trailing backslash must not escape our closing brace');
  assert.equal(escapeSoslKeyword('Acme Corp'), 'Acme Corp', 'ordinary text is untouched');

  const composed = composeSoslKeywordStatement({ keyword: 'a+b', limit: 5 });
  assert.equal(composed, 'FIND {a\\+b} IN ALL FIELDS LIMIT 5');
  assert.equal(
    composeSoslKeywordStatement({ keyword: "O'Brien", objects: ['Account'], limit: 1 }),
    "FIND {O\\'Brien} IN ALL FIELDS RETURNING Account(Id, Name) LIMIT 1",
  );
});

test('a complete FIND clause is passed through unchanged, with its objects pass-through too', async () => {
  const clause = 'FIND {acme} IN ALL FIELDS RETURNING Account(Id, Name LIMIT 3), Contact(Id) LIMIT 7';
  const { fixture, run } = executor(() => searchPayload([]));
  const output = await run({ search: clause });

  assert.equal(output.mode, 'STATEMENT');
  assert.equal(output.statement, clause);
  assert.equal(output.limitSource, 'STATEMENT');
  assert.equal(output.effectiveLimit, 7, 'the outermost LIMIT caps the result set');
  assert.deepEqual(fixture.calls, [{ operation: 'search', argument: clause }]);
});

test('the outer LIMIT is read, never the per-object one inside RETURNING', () => {
  assert.equal(findGlobalSoslLimit('FIND {a} IN ALL FIELDS LIMIT 7'), 7);
  assert.equal(findGlobalSoslLimit('FIND {a} IN ALL FIELDS RETURNING Account(Id LIMIT 3) LIMIT 7'), 7);
  assert.equal(findGlobalSoslLimit('FIND {a} IN ALL FIELDS RETURNING Account(Id LIMIT 3)'), null);
  assert.equal(findGlobalSoslLimit('FIND {a} IN ALL FIELDS'), null);
  // A `limit` inside a string literal is text, not syntax.
  assert.equal(findGlobalSoslLimit("FIND {a} IN ALL FIELDS RETURNING Account(Id WHERE Name = 'LIMIT 9')"), null);

  assert.deepEqual(findSoslReturningLimits('FIND {a} IN ALL FIELDS RETURNING Account(Id, Name LIMIT 5), Contact(Id) LIMIT 7'), { Account: 5 });
  assert.deepEqual(findSoslReturningLimits('FIND {a} IN ALL FIELDS RETURNING Account(Id) LIMIT 7'), {});
  assert.deepEqual(findSoslReturningLimits('FIND {a} IN ALL FIELDS LIMIT 7'), {});
});

test('an input that is not a single, well-formed search is refused at the schema', async () => {
  const rejected: ReadonlyArray<Readonly<{ label: string; input: Readonly<Record<string, unknown>> }>> = [
    { label: 'semicolon in a keyword', input: { search: 'acme; DELETE' } },
    { label: 'semicolon in a clause', input: { search: 'FIND {acme} IN ALL FIELDS; FIND {b}' } },
    { label: 'two term groups', input: { search: 'FIND {acme} IN ALL FIELDS RETURNING Account(Id) AND {b}' } },
    { label: 'an opening brace only', input: { search: 'FIND {acme IN ALL FIELDS' } },
    { label: 'an unterminated literal', input: { search: "FIND {a} IN ALL FIELDS RETURNING Account(Id WHERE Name = 'x)" } },
    { label: 'a brace in a keyword', input: { search: 'acme}' } },
    { label: 'two thousand and one characters', input: { search: 'a'.repeat(2_001) } },
    { label: 'objects with a complete clause', input: { search: 'FIND {a} IN ALL FIELDS', objects: ['Account'] } },
    { label: 'fields with a complete clause', input: { search: 'FIND {a} IN ALL FIELDS', fields: ['Id'] } },
    { label: 'limit with a complete clause', input: { search: 'FIND {a} IN ALL FIELDS', limit: 5 } },
    { label: 'fields without objects', input: { search: 'acme', fields: ['Id'] } },
    { label: 'an empty object list', input: { search: 'acme', objects: [] } },
    { label: 'twenty-one objects', input: { search: 'acme', objects: Array.from({ length: 21 }, (_, index) => `O${index}__c`) } },
    { label: 'an empty object name', input: { search: 'acme', objects: [''] } },
    { label: 'a relationship path', input: { search: 'acme', objects: ['Account.Name'] } },
    { label: 'an object beginning with a digit', input: { search: 'acme', objects: ['1Account'] } },
    { label: 'a relationship path in a field', input: { search: 'acme', objects: ['Account'], fields: ['Account.Name'] } },
    { label: 'a limit of zero', input: { search: 'acme', limit: 0 } },
    { label: 'a negative limit', input: { search: 'acme', limit: -1 } },
    { label: 'a fractional limit', input: { search: 'acme', limit: 1.5 } },
    { label: 'a limit above the cap', input: { search: 'acme', limit: 201 } },
    { label: 'an empty search', input: { search: '   ' } },
    { label: 'an identity parameter', input: { search: 'acme', username: 'admin@example.test' } },
  ];
  for (const { label, input } of rejected) {
    const { fixture, run } = executor(() => searchPayload([]));
    await assert.rejects(run(input), ZodError, `${label} must be refused by the schema`);
    assert.deepEqual(fixture.calls, [], `${label} must not reach Salesforce`);
  }
});

test('exactly two thousand characters is accepted, because the bound is the bound', async () => {
  const { run } = executor(() => searchPayload([]));
  const output = await run({ search: 'a'.repeat(2_000) });

  assert.equal(output.statement, `FIND {${'a'.repeat(2_000)}} IN ALL FIELDS LIMIT 20`);
});

test('a composed statement above its own size limit is refused rather than sent', async () => {
  // Twenty objects each listing twenty-five 128-character fields is roughly sixty kilobytes of SOSL,
  // which no single input bounds — so the bound is enforced where the statement is composed.
  const field = `F${'x'.repeat(127)}`;
  const input = {
    search: 'acme',
    objects: Array.from({ length: 20 }, (_, index) => `Object${index}__c`),
    fields: Array.from({ length: 25 }, () => field),
  };
  const { fixture, run } = executor(() => searchPayload([]));
  await assert.rejects(run(input), ZodError);

  const plan = planSoslSearch('acme', { objects: input.objects, fields: input.fields, defaultLimit: 20 });
  assert.equal(plan.usable, false);
  assert.match(plan.usable ? '' : plan.message, new RegExp(`above the ${SOSL_MAX_STATEMENT_LENGTH}-character`, 'u'));
  assert.deepEqual(fixture.calls, []);
});

test('records are grouped by object in the order Salesforce ranked them', async () => {
  const { run } = executor(() => searchPayload([
    searchRecord('Contact', { Name: 'Acme Contact' }),
    searchRecord('Account', { Name: 'Acme' }),
    searchRecord('Contact', { Name: 'Acme Contact 2' }),
  ]));
  const output = await run({ search: 'acme' });

  assert.deepEqual(Object.keys(output.resultsByObject ?? {}), ['Contact', 'Account']);
  assert.equal(group(output, 'Contact').count, 2);
  assert.equal(group(output, 'Account').count, 1);
  assert.equal(group(output, 'Contact').atLimit, false, 'a cap this Tool cannot see is never guessed at');
  assert.equal(output.objectsReturned, 2);
  assert.equal(output.totalReturned, 3);
  assert.equal(output.returnedCount, 3);
  assert.equal(output.unreadableRecords, 0);
  assert.deepEqual(searchRecordsOutputSchema.parse(output), output);
});

test('the record object comes from attributes, never from a business field called Type', async () => {
  const { run } = executor(() => searchPayload([
    { attributes: { sobjectType: 'Contact' }, Id: '003' },
    // On Case and Account, `Type` is an ordinary picklist. Reading it as an object name would file
    // the record under an object that does not exist.
    { attributes: {}, Type: 'Case', Id: '500' },
    { attributes: { type: 'Account' }, Id: '001' },
    'not a record',
  ]));
  const output = await run({ search: 'acme' });

  assert.deepEqual(Object.keys(output.resultsByObject ?? {}), ['Contact', 'Account']);
  assert.equal(output.unreadableRecords, 2);
  assert.equal(output.totalReturned, 4);
  // A record this Tool could not classify is never returned under an invented object name...
  assert.equal(output.returnedCount, 2);
  // ...and a result that dropped records can never be presented as the whole answer.
  assert.equal(output.complete, false);
  assert.match(output.hint ?? '', /2 returned record\(s\) carried no readable object type/u);
  assert.deepEqual(searchRecordsOutputSchema.parse(output), output);
});

test('a keyword search that reaches its limit is truncated as LIMIT_REACHED, not as complete', async () => {
  const { run } = executor(() => searchPayload([
    searchRecord('Account'), searchRecord('Account'), searchRecord('Account'),
  ]));
  const output = await run({ search: 'acme', objects: ['Account'], limit: 3 });

  assert.equal(output.effectiveLimit, 3);
  assert.equal(output.totalReturned, 3);
  assert.equal(output.truncated, true);
  assert.equal(output.truncatedReason, 'LIMIT_REACHED');
  assert.equal(output.complete, false);
  assert.match(output.hint ?? '', /Truncated by LIMIT_REACHED/u);
  assert.match(output.hint ?? '', /Raise limit \(up to 200\)/u);
});

test('a per-object cap inside the clause is reported as PER_OBJECT_LIMIT', async () => {
  const { run } = executor(() => searchPayload([
    searchRecord('Account'), searchRecord('Account'),
  ]));
  const output = await run({
    search: 'FIND {acme} IN ALL FIELDS RETURNING Account(Id, Name LIMIT 2) LIMIT 20',
  });

  assert.equal(output.limitSource, 'STATEMENT');
  assert.equal(output.effectiveLimit, 20, 'the outer cap is what bounds the whole result');
  assert.equal(group(output, 'Account').atLimit, true);
  assert.equal(output.truncated, true);
  assert.equal(output.truncatedReason, 'PER_OBJECT_LIMIT');
  assert.equal(output.complete, false);
  assert.match(output.hint ?? '', /A per-object LIMIT inside the clause capped at least one object/u);
});

test('a payload cut by the response budget is reported as RESPONSE_BUDGET', async () => {
  const wide = (index: number) => searchRecord('Account', { Name: `${index}-${'x'.repeat(3_000)}` });
  const { run } = executor(() => searchPayload(Array.from({ length: 200 }, (_, index) => wide(index))));
  const output = await run({ search: 'acme', objects: ['Account'], limit: 200 });

  // The budget cut the payload before the search's own limit was reached, and the reason names the
  // binding constraint the caller actually has to work around.
  assert.equal(output.truncated, true);
  assert.equal(output.truncatedReason, 'RESPONSE_BUDGET');
  assert.equal(output.complete, false);
  assert.equal(output.totalReturned, 200);
  assert.ok((output.returnedCount ?? 0) < output.totalReturned);
  // The group counts describe what Salesforce returned; returnedCount describes what survived here.
  assert.equal(group(output, 'Account').count, 200);
  assert.equal(group(output, 'Account').returnedCount, output.returnedCount);
  assert.match(output.hint ?? '', /The response budget cut the payload, not the search/u);
  assert.deepEqual(searchRecordsOutputSchema.parse(output), output);
});

test('a group cut away entirely still appears, so a count is never silently dropped', async () => {
  // Three records of ~100 KB each exhaust the 256 KB budget, and the small Contact record that
  // follows them in the ranking is what the cut removes.
  const wide = () => searchRecord('Account', { Name: 'x'.repeat(100_000) });
  const { run } = executor(() => searchPayload([
    wide(), wide(), wide(),
    searchRecord('Contact', { Name: 'Acme' }),
  ]));
  const output = await run({ search: 'acme', objects: ['Account', 'Contact'], limit: 200 });

  assert.equal(output.truncatedReason, 'RESPONSE_BUDGET');
  assert.deepEqual(Object.keys(output.resultsByObject ?? {}).sort(), ['Account', 'Contact']);
  assert.equal(group(output, 'Account').count, 3);
  assert.equal(group(output, 'Contact').count, 1);
  assert.equal(group(output, 'Contact').returnedCount, 0, 'a group with nothing left still reports its count');
  assert.equal(
    group(output, 'Account').returnedCount + group(output, 'Contact').returnedCount,
    output.returnedCount,
  );
});

test('a complete result says so, and names the cap it was held to', async () => {
  const { run } = executor(() => searchPayload([searchRecord('Account', { Name: 'Acme' })]));
  const output = await run({ search: 'acme', objects: ['Account'], limit: 20 });

  assert.equal(output.truncated, false);
  assert.equal(output.truncatedReason, null);
  assert.equal(output.complete, true);
  assert.match(output.hint ?? '', /Complete: all 1 matching record\(s\) are included, fewer than the 20 record limit/u);
});

test('a clause with no LIMIT is reported as unprovable rather than as a complete slice', async () => {
  const { run } = executor(() => searchPayload([searchRecord('Account', { Name: 'Acme' })]));
  const output = await run({ search: 'FIND {acme} IN ALL FIELDS RETURNING Account(Id, Name)' });

  assert.equal(output.limitSource, 'UNSPECIFIED');
  assert.equal(output.effectiveLimit, null);
  assert.equal(output.truncated, false, 'nothing bounded this result, so nothing was cut');
  assert.equal(output.complete, false, 'and nothing proves it is whole either');
  assert.match(output.hint ?? '', /no total match count/u);
  assert.match(output.hint ?? '', /Add a LIMIT to the clause/u);
});

test('a session that did not name objects is told how to get readable rows', async () => {
  const record = () => searchPayload([searchRecord('Account', { Name: 'Acme' })]);

  const bare = await executor(record, { enabledToolNames: ['search_records'] }).run({ search: 'acme' });
  assert.match(bare.hint ?? '', /No objects were named, so each record carries only its Id and object type\./u);
  assert.doesNotMatch(bare.hint ?? '', /query_records/u, 'a hint never names a Tool this session does not advertise');

  const withQuery = await executor(record, { enabledToolNames: ['search_records', 'query_records'] })
    .run({ search: 'acme' });
  assert.match(withQuery.hint ?? '', /read these Ids with query_records/u);

  const scoped = await executor(record, { enabledToolNames: ['search_records'] })
    .run({ search: 'acme', objects: ['Account'] });
  assert.doesNotMatch(scoped.hint ?? '', /No objects were named/u);
});

test('an exhausted allowance names get_org_limits only when this session advertises it', async () => {
  const exhausted = () => { throw salesforceError('REQUEST_LIMIT_EXCEEDED', 'Request limit exceeded'); };

  const without = await rejection(executor(exhausted, { enabledToolNames: ['search_records'] }).run({ search: 'acme' }));
  assert.equal(without.code, 'MCP_SEARCH_LIMIT_EXCEEDED');
  assert.doesNotMatch(without.message, /get_org_limits/u);
  assert.match(without.suggestion ?? '', /24-hour rolling allowance/u);

  const withLimits = await rejection(
    executor(exhausted, { enabledToolNames: ['search_records', 'get_org_limits'] }).run({ search: 'acme' }),
  );
  assert.equal(withLimits.code, 'MCP_SEARCH_LIMIT_EXCEEDED');
  assert.match(withLimits.message, /Call get_org_limits/u);
  assert.match(withLimits.suggestion ?? '', /Read get_org_limits/u);
});

test('a rejected search is mapped to a code the caller can act on', async () => {
  const cases: ReadonlyArray<Readonly<{ code: string; expected: string; message?: RegExp }>> = [
    { code: 'MALFORMED_SEARCH', expected: 'MCP_SEARCH_MALFORMED', message: /FIND \{term\} IN ALL FIELDS/u },
    { code: 'INVALID_SEARCH', expected: 'MCP_SEARCH_MALFORMED' },
    { code: 'INVALID_FIELD', expected: 'MCP_SEARCH_FIELD_INVALID', message: /describe_sobject/u },
    { code: 'INVALID_TYPE', expected: 'MCP_SEARCH_FIELD_INVALID' },
    { code: 'INSUFFICIENT_ACCESS', expected: 'MCP_SEARCH_ACCESS_DENIED' },
    { code: 'REQUEST_LIMIT_EXCEEDED', expected: 'MCP_SEARCH_LIMIT_EXCEEDED' },
  ];
  for (const { code, expected, message } of cases) {
    const { run } = executor(() => { throw salesforceError(code, 'reported by Salesforce'); });
    const error = await rejection(run({ search: 'acme' }));

    assert.equal(error.code, expected, code);
    assert.match(error.message, /Salesforce reported: reported by Salesforce/u);
    if (message !== undefined) assert.match(error.suggestion ?? error.message, message);
  }
});

test('a transient failure keeps its retry wording instead of being called a malformed search', async () => {
  const { run } = executor(() => { throw salesforceError('SERVER_UNAVAILABLE', 'Service unavailable'); });
  const error = await rejection(run({ search: 'acme' }));

  assert.equal(error.code, 'MCP_SEARCH_RECORDS_FAILED');
  assert.match(error.suggestion ?? '', /Retry once/u);
  assert.doesNotMatch(error.suggestion ?? '', /Fix the search/u);
});

test('a codeless provider failure is never echoed to the client', async () => {
  const { run } = executor(() => { throw new Error('socket hang up'); });
  const error = await rejection(run({ search: 'acme' }));

  assert.equal(error.code, 'MCP_SEARCH_RECORDS_FAILED');
  assert.doesNotMatch(error.message, /socket hang up/u);
});

test('a caller that bypasses the Tool schema still cannot send a statement the Tool refuses', async () => {
  const { fixture, runRaw } = executor(() => searchPayload([]));
  const error = await rejection(runRaw({ search: 'acme; DROP' }));

  assert.equal(error.code, 'MCP_DATA_INVALID_INPUT');
  assert.match(error.message, /search: /u);
  assert.deepEqual(fixture.calls, []);
});

test('a request that does not resolve to exactly one identity never reaches Salesforce', async () => {
  const fixture = createFixture({ usernames: [] });
  const error = await rejection(new SearchRecordsExecutor(fixture.orgService).execute({ search: 'acme' }));

  assert.equal(error.code, 'MCP_DATA_IDENTITY_UNAVAILABLE');
  assert.deepEqual(fixture.calls, []);
});

test('inspectSoslSearch tells a keyword from a clause and refuses the illegal combinations', () => {
  const scope = { objectsSupplied: false, limitSupplied: false, fieldsSupplied: false };

  assert.deepEqual(inspectSoslSearch('acme', scope), { usable: true, mode: 'KEYWORD', statementLimit: null });
  assert.deepEqual(inspectSoslSearch('  find {a} IN ALL FIELDS  ', scope), { usable: true, mode: 'STATEMENT', statementLimit: null });
  assert.deepEqual(inspectSoslSearch('FIND {a} IN ALL FIELDS LIMIT 4', scope), { usable: true, mode: 'STATEMENT', statementLimit: 4 });

  // A term whose first word is `find` is read as a clause, exactly as a leading SELECT is read as
  // SOQL: the two cannot be told apart lexically. The refusal says so and names the way out, so the
  // caller loses a round trip rather than the search.
  const leadingFind = inspectSoslSearch('find acme', scope);
  assert.equal(leadingFind.usable, false);
  assert.match(leadingFind.usable ? '' : leadingFind.message, /remove the leading FIND/u);

  for (const [label, value, configured] of [
    ['objects', 'FIND {a} IN ALL FIELDS', { ...scope, objectsSupplied: true }],
    ['limit', 'FIND {a} IN ALL FIELDS', { ...scope, limitSupplied: true }],
    ['fields', 'FIND {a} IN ALL FIELDS', { ...scope, fieldsSupplied: true }],
  ] as const) {
    const inspection = inspectSoslSearch(value, configured);
    assert.equal(inspection.usable, false, `${label} with a clause must be refused`);
    assert.match(inspection.usable ? '' : inspection.message, new RegExp(`${label} cannot be combined`, 'u'));
  }

  const noObjects = inspectSoslSearch('acme', { ...scope, fieldsSupplied: true });
  assert.equal(noObjects.usable, false);
  assert.match(noObjects.usable ? '' : noObjects.message, /fields cannot be used without objects/u);
});

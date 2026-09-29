import assert from 'node:assert/strict';
import test from 'node:test';
import { ReleaseState, Toolset } from '@salesforce/mcp-provider-api';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GetBulkQueryResultsExecutor } from '../bulk-query-results-executor.js';
import { SubmitBulkQueryExecutor } from '../bulk-query-submit-executor.js';
import { DescribeSobjectExecutor } from '../describe-sobject-executor.js';
import { ListSobjectsExecutor } from '../list-sobjects-executor.js';
import { QueryRecordsExecutor } from '../query-records-executor.js';
import { SearchRecordsExecutor } from '../search-records-executor.js';
import {
  describeSobjectOutputSchema,
  getBulkQueryResultsOutputSchema,
  listSobjectsOutputSchema,
  queryRecordsOutputSchema,
  searchRecordsOutputSchema,
  submitBulkQueryOutputSchema,
  type DescribeSobjectInput,
  type GetBulkQueryResultsInput,
  type ListSobjectsInput,
  type QueryRecordsInput,
  type SearchRecordsInput,
  type SubmitBulkQueryInput,
} from '../schemas.js';
import { DescribeSobjectMcpTool } from '../tools/describe-sobject.js';
import { GetBulkQueryResultsMcpTool } from '../tools/get-bulk-query-results.js';
import { ListSobjectsMcpTool } from '../tools/list-sobjects.js';
import { QueryRecordsMcpTool } from '../tools/query-records.js';
import { SearchRecordsMcpTool } from '../tools/search-records.js';
import { SubmitBulkQueryMcpTool } from '../tools/submit-bulk-query.js';
import {
  bulkJob,
  bulkResultHeaders,
  bulkRows,
  createFixture,
  describeGlobalPayload,
  describePayload,
  fieldEntry,
  queryBatch,
  rows,
  salesforceError,
  searchPayload,
  searchRecord,
  sobjectEntry,
  type BulkResponse,
} from './data-fixtures.js';

function listTool(handler: () => unknown): ListSobjectsMcpTool {
  return new ListSobjectsMcpTool(new ListSobjectsExecutor(createFixture({ handler }).orgService));
}

function describeTool(handler: () => unknown): DescribeSobjectMcpTool {
  return new DescribeSobjectMcpTool(new DescribeSobjectExecutor(createFixture({ handler }).orgService));
}

function queryTool(
  handler: (operation: string, argument?: string) => unknown,
  enabledToolNames?: readonly string[],
): QueryRecordsMcpTool {
  return new QueryRecordsMcpTool(
    new QueryRecordsExecutor(createFixture({ handler }).orgService, { enabledToolNames }),
  );
}

function searchTool(
  handler: (operation: string, argument?: string) => unknown,
  enabledToolNames?: readonly string[],
): SearchRecordsMcpTool {
  return new SearchRecordsMcpTool(
    new SearchRecordsExecutor(createFixture({ handler }).orgService, { enabledToolNames }),
  );
}

type BulkResponder = (request: Readonly<{ method: string; url: string }>) => BulkResponse | Promise<BulkResponse>;

function submitBulkTool(bulk: BulkResponder, enabledToolNames?: readonly string[]): SubmitBulkQueryMcpTool {
  return new SubmitBulkQueryMcpTool(
    new SubmitBulkQueryExecutor(createFixture({ bulk }).orgService, { enabledToolNames }),
  );
}

function resultsBulkTool(bulk: BulkResponder, enabledToolNames?: readonly string[]): GetBulkQueryResultsMcpTool {
  return new GetBulkQueryResultsMcpTool(
    new GetBulkQueryResultsExecutor(createFixture({ bulk }).orgService, { enabledToolNames }),
  );
}

type DataTool =
  | ListSobjectsMcpTool
  | DescribeSobjectMcpTool
  | QueryRecordsMcpTool
  | SearchRecordsMcpTool
  | SubmitBulkQueryMcpTool
  | GetBulkQueryResultsMcpTool;

function structured(result: CallToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent !== undefined, 'every Data Tool result carries structuredContent');
  return result.structuredContent;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  assert.ok(first !== undefined && first.type === 'text');
  return first.text;
}

function annotationsOf(tool: DataTool): Record<string, unknown> {
  const annotations = tool.getConfig().annotations;
  assert.ok(annotations !== undefined, 'every Data Tool declares annotations');
  return annotations;
}

function descriptionOf(tool: DataTool): string {
  const description = tool.getConfig().description;
  assert.ok(description !== undefined, 'every Data Tool describes itself to the Agent');
  return description;
}

test('list_sobjects declares a GA, DATA, read-only contract', () => {
  const tool = listTool(() => describeGlobalPayload([]));

  assert.equal(tool.getName(), 'list_sobjects');
  assert.equal(tool.getReleaseState(), ReleaseState.GA);
  assert.deepEqual(tool.getToolsets(), [Toolset.DATA]);

  const annotations = annotationsOf(tool);
  assert.equal(annotations.readOnlyHint, true);
  assert.equal(annotations.destructiveHint, false);
  assert.equal(annotations.idempotentHint, true);
  assert.ok(tool.getConfig().inputSchema !== undefined);
  assert.ok(tool.getConfig().outputSchema !== undefined);
  assert.match(descriptionOf(tool), /never guess an object name/u);
});

test('describe_sobject declares a GA, DATA, read-only contract and tells the Agent how to repair a bad name', () => {
  const tool = describeTool(() => describePayload('Account'));

  assert.equal(tool.getName(), 'describe_sobject');
  assert.equal(tool.getReleaseState(), ReleaseState.GA);
  assert.deepEqual(tool.getToolsets(), [Toolset.DATA]);

  const annotations = annotationsOf(tool);
  assert.equal(annotations.readOnlyHint, true);
  assert.equal(annotations.destructiveHint, false);

  // The description is the Agent's only guidance, so the self-repair loop must be explicit.
  const description = descriptionOf(tool);
  assert.match(description, /INVALID_FIELD/u);
  assert.match(description, /INVALID_TYPE/u);
  assert.match(description, /it returns no business records and changes nothing/u);
});

test('a successful list_sobjects result satisfies its own declared output schema', async () => {
  const tool = listTool(() => describeGlobalPayload([sobjectEntry('Account'), sobjectEntry('Contact')]));
  const result = await tool.exec({ filter: 'Acc' });

  assert.equal(result.isError, undefined);
  const output = structured(result);
  assert.deepEqual(listSobjectsOutputSchema.parse(output), output);
  assert.equal(output.success, true);
  assert.equal(output.executionRole, 'USER');
  assert.deepEqual(JSON.parse(textOf(result)), output);
});

test('a successful describe_sobject result satisfies its own declared output schema', async () => {
  const tool = describeTool(() => describePayload('Account', { fields: [fieldEntry('Name')] }));
  const result = await tool.exec({ objectApiName: 'Account' });

  assert.equal(result.isError, undefined);
  const output = structured(result);
  const parsed = describeSobjectOutputSchema.parse(output);
  assert.deepEqual(parsed, output);
  assert.equal(parsed.objectApiName, 'Account');
  assert.deepEqual(parsed.fields?.map((field) => field.apiName), ['Name']);
});

test('a relationship path is rejected as an object API name before any Salesforce call', async () => {
  for (const objectApiName of ['Account.Name', 'Account.Owner.Name', 'Account,Contact', 'Account)']) {
    let called = false;
    const tool = describeTool(() => {
      called = true;
      return describePayload('Account');
    });
    const result = await tool.exec({ objectApiName } as unknown as DescribeSobjectInput);

    assert.equal(result.isError, true, `${objectApiName} must be rejected`);
    const output = structured(result);
    assert.equal(output.success, false);
    assert.equal(output.errorCode, 'MCP_DATA_INVALID_INPUT');
    assert.match(String(output.message), /objectApiName/u);
    assert.equal(called, false);
  }
});

test('an object API name that is not an identifier is rejected, including a leading digit or empty value', async () => {
  for (const objectApiName of ['1Account', '_Account', '', '   ']) {
    const tool = describeTool(() => describePayload('Account'));
    const result = await tool.exec({ objectApiName } as unknown as DescribeSobjectInput);

    assert.equal(result.isError, true, `${JSON.stringify(objectApiName)} must be rejected`);
    assert.equal(structured(result).errorCode, 'MCP_DATA_INVALID_INPUT');
  }
});

test('a limit above the declared maximum is rejected rather than silently clamped', async () => {
  const listResult = await listTool(() => describeGlobalPayload([])).exec({ limit: 201 } as unknown as ListSobjectsInput);
  assert.equal(listResult.isError, true);
  assert.equal(structured(listResult).errorCode, 'MCP_DATA_INVALID_INPUT');

  const describeResult = await describeTool(() => describePayload('Account')).exec({ objectApiName: 'Account', fieldLimit: 1_001 } as unknown as DescribeSobjectInput);
  assert.equal(describeResult.isError, true);
  assert.equal(structured(describeResult).errorCode, 'MCP_DATA_INVALID_INPUT');
});

test('a non-integer or non-positive limit is rejected', async () => {
  for (const limit of [0, -1, 1.5]) {
    const result = await listTool(() => describeGlobalPayload([])).exec({ limit } as unknown as ListSobjectsInput);
    assert.equal(result.isError, true, `limit ${limit} must be rejected`);
    assert.equal(structured(result).errorCode, 'MCP_DATA_INVALID_INPUT');
  }
});

test('no tool accepts a Salesforce identity, credential or org selector as input', async () => {
  // The request identity is fixed by the authenticated route. A strict schema means an
  // Agent cannot even attempt to widen it, and nothing is sent to Salesforce afterwards.
  const rejected: Array<Readonly<Record<string, unknown>>> = [
    { username: 'admin@example.test' },
    { accessToken: 'secret' },
    { instanceUrl: 'https://example.my.salesforce.com' },
    { orgId: '00D000000000001' },
  ];
  for (const extra of rejected) {
    let called = false;
    const tool = listTool(() => {
      called = true;
      return describeGlobalPayload([]);
    });
    const result = await tool.exec(extra as unknown as ListSobjectsInput);

    assert.equal(result.isError, true, `${Object.keys(extra)[0]} must not be an accepted input`);
    assert.equal(structured(result).errorCode, 'MCP_DATA_INVALID_INPUT');
    assert.equal(called, false);
  }
});

test('an expected failure stays an isError Tool result with a safe next step and no stack trace', async () => {
  const tool = describeTool(() => {
    throw Object.assign(new Error('sObject type Nope__c is not supported'), { errorCode: 'INVALID_TYPE' });
  });
  const result = await tool.exec({ objectApiName: 'Nope__c' });

  assert.equal(result.isError, true);
  const output = structured(result);
  assert.equal(output.success, false);
  assert.equal(output.errorCode, 'MCP_SOBJECT_NOT_FOUND');
  assert.equal(output.salesforceErrorCode, 'INVALID_TYPE');
  assert.doesNotMatch(textOf(result), /at .*\.ts:\d+/u);
  assert.doesNotMatch(textOf(result), /\bstack\b/iu);
  assert.match(textOf(result), /Next: /u);
  // The failure still satisfies the declared output schema, so a client can rely on it.
  assert.deepEqual(describeSobjectOutputSchema.parse(output), output);
});

test('a provider code is never reported as a Salesforce error code', async () => {
  const tool = listTool(() => {
    throw new Error('socket hang up');
  });
  const result = await tool.exec({});

  const output = structured(result);
  assert.equal(output.errorCode, 'MCP_SOBJECT_LIST_FAILED');
  assert.equal(output.salesforceErrorCode, undefined);
});

test('an unavailable identity is reported as a Tool result, not a thrown error', async () => {
  const fixture = createFixture({ usernames: [] });
  const tool = new ListSobjectsMcpTool(new ListSobjectsExecutor(fixture.orgService));
  const result = await tool.exec({});

  assert.equal(result.isError, true);
  assert.equal(structured(result).errorCode, 'MCP_DATA_IDENTITY_UNAVAILABLE');
  assert.deepEqual(fixture.calls, []);
});

test('query_records declares a GA, DATA, read-only contract and states how it coexists with run_soql_query', () => {
  const tool = queryTool(() => queryBatch([]));

  assert.equal(tool.getName(), 'query_records');
  assert.equal(tool.getReleaseState(), ReleaseState.GA);
  assert.deepEqual(tool.getToolsets(), [Toolset.DATA]);

  const annotations = annotationsOf(tool);
  assert.equal(annotations.readOnlyHint, true);
  assert.equal(annotations.destructiveHint, false);
  assert.ok(tool.getConfig().inputSchema !== undefined);
  assert.ok(tool.getConfig().outputSchema !== undefined);

  // The Agent chooses between two Tools that both run SOQL, so the description alone has to
  // carry the distinction: the official Tool stays available and this one is preferred when
  // the result may exceed a batch or a completeness statement is needed.
  const description = descriptionOf(tool);
  assert.match(description, /Prefer this Tool over run_soql_query/u);
  assert.match(description, /exceed a single batch/u);
  assert.match(description, /run_soql_query is unchanged/u);
  assert.match(description, /complete/u);
  assert.match(description, /describe_sobject/u);
  assert.match(description, /never modifies data or locks rows/u);
});

test('a successful query_records result satisfies its own declared output schema and the text mirrors it', async () => {
  const tool = queryTool(() => queryBatch(rows(3)));
  const result = await tool.exec({ query: 'SELECT Id, Name FROM Account' });

  assert.equal(result.isError, undefined);
  const output = structured(result);
  assert.deepEqual(queryRecordsOutputSchema.parse(output), output);
  assert.equal(output.success, true);
  assert.equal(output.executionRole, 'USER');
  assert.equal(output.api, 'REST');
  assert.equal(output.complete, true);

  // The text is a fact line plus exactly the records structuredContent carries, so an Agent
  // reading only the text cannot be told something the structured payload does not say.
  const text = textOf(result);
  assert.match(text, /^query_records: returnedCount=3 fetched=3 totalSize=3 pages=1 done=true complete=true truncated=false truncatedReason=null api=data aggregate=false aggregateValue=null$/mu);
  assert.match(text, /Next: Complete result: all 3 matching rows are included\./u);
  assert.match(text, /Records \(3\):/u);
  for (const record of output.records as readonly Record<string, unknown>[]) {
    assert.ok(text.includes(JSON.stringify(record)), 'every returned record appears in the text');
  }
});

test('a bare COUNT() is reported as a complete scalar aggregate, with its value in aggregateValue', async () => {
  // The shape Salesforce actually returns, reproduced from the live org: a bare COUNT() comes
  // back with the value in totalSize and no rows at all. Reading that as a row count made a
  // correct count look truncated, which is the opposite of what this Tool exists to do.
  const tool = queryTool(() => queryBatch([], { totalSize: 4449 }));
  const result = await tool.exec({ query: 'SELECT COUNT() FROM IntermediateTable__c' });

  assert.equal(result.isError, undefined);
  const output = structured(result);
  assert.deepEqual(queryRecordsOutputSchema.parse(output), output);
  assert.equal(output.aggregate, true);
  assert.equal(output.aggregateValue, 4449);
  assert.equal(output.totalSize, null, 'the value is not also reported as a row count');
  assert.equal(output.complete, true);
  assert.equal(output.truncated, false);
  assert.equal(output.truncatedReason, null);
  assert.deepEqual(output.records, []);

  // The empty `records` is exactly why the text has to name the value: an Agent reading only
  // the text would otherwise see no records and no total, and conclude the answer was lost.
  const text = textOf(result);
  assert.match(text, /totalSize=null pages=1 done=true complete=true truncated=false truncatedReason=null api=data aggregate=true aggregateValue=4449/u);
  assert.match(text, /^Next: Complete: this is a scalar aggregate over the whole result, and Salesforce reported its value as 4449 in aggregateValue\./mu);
  assert.match(text, /Records: none\./u);
});

test('a truncated query_records result declares the reason in the text and in structuredContent', async () => {
  const tool = queryTool(() => queryBatch(rows(4), { done: false, totalSize: 900, nextRecordsUrl: '/next' }));
  const result = await tool.exec({ query: 'SELECT Id, Name FROM Account', maxRows: 4 });

  const output = structured(result);
  assert.equal(output.truncated, true);
  assert.equal(output.truncatedReason, 'MAX_ROWS');
  assert.doesNotMatch(textOf(result), /complete=true/u);
  assert.match(textOf(result), /truncated=true truncatedReason=MAX_ROWS/u);
  assert.match(textOf(result), /^Next: Truncated by MAX_ROWS\./mu);
});

test('an illegal maxRows is rejected before any Salesforce call', async () => {
  for (const maxRows of [0, -1, 1.5, 50_001]) {
    let called = false;
    const tool = queryTool(() => {
      called = true;
      return queryBatch([]);
    });
    const result = await tool.exec({ query: 'SELECT Id FROM Account', maxRows } as unknown as QueryRecordsInput);

    assert.equal(result.isError, true, `maxRows ${maxRows} must be rejected`);
    const output = structured(result);
    assert.equal(output.errorCode, 'MCP_DATA_INVALID_INPUT');
    assert.deepEqual(queryRecordsOutputSchema.parse(output), output);
    assert.equal(called, false, `maxRows ${maxRows} must not reach Salesforce`);
  }
});

test('a query_records failure stays an isError result with a safe next step and no stack trace', async () => {
  const tool = queryTool(() => { throw salesforceError('INVALID_FIELD', 'No such column Name on entity Account'); });
  const result = await tool.exec({ query: 'SELECT Nope FROM Account' });

  assert.equal(result.isError, true);
  const output = structured(result);
  assert.equal(output.success, false);
  assert.equal(output.errorCode, 'MCP_QUERY_FIELD_INVALID');
  assert.equal(output.salesforceErrorCode, 'INVALID_FIELD');
  assert.match(textOf(result), /Next: /u);
  assert.doesNotMatch(textOf(result), /at .*\.(ts|js):\d+/u);
  assert.doesNotMatch(textOf(result), /\bstack\b/iu);
  // The failure still satisfies the declared output schema, so a client can rely on it.
  assert.deepEqual(queryRecordsOutputSchema.parse(output), output);
});

test('a query_records result never names a Tool this session does not advertise', async () => {
  const tool = queryTool(
    () => queryBatch(rows(2), { done: false, totalSize: 500, nextRecordsUrl: '/next' }),
    ['query_records'],
  );
  const result = await tool.exec({ query: 'SELECT Id, Name FROM Account', maxRows: 2 });

  const text = textOf(result);
  assert.doesNotMatch(text, /submit_bulk_query|get_org_limits/u);
  assert.match(text, /ask an administrator to enable the bulk query capability/u);
});

test('search_records declares a GA, DATA, read-only contract and states what SOSL cannot do', () => {
  const tool = searchTool(() => searchPayload([]));

  assert.equal(tool.getName(), 'search_records');
  assert.equal(tool.getReleaseState(), ReleaseState.GA);
  assert.deepEqual(tool.getToolsets(), [Toolset.DATA]);

  const annotations = annotationsOf(tool);
  assert.equal(annotations.readOnlyHint, true);
  assert.equal(annotations.destructiveHint, false);
  assert.ok(tool.getConfig().inputSchema !== undefined);
  assert.ok(tool.getConfig().outputSchema !== undefined);

  const description = descriptionOf(tool);
  // The Agent picks between this and query_records, so the difference has to be in the description:
  // SOSL is the cross-object lookup SOQL structurally cannot express.
  assert.match(description, /the lookup SOQL cannot do/u);
  assert.match(description, /query_records once you know the object/u);
  assert.match(description, /One search per call/u);
  assert.match(description, /no continuation cursor/u);
  assert.match(description, /never modifies data or locks rows/u);
});

test('a bare keyword is composed into SOSL byte for byte, and the result satisfies its own schema', async () => {
  const tool = searchTool(() => searchPayload([searchRecord('Account', { Name: 'Acme' })]));
  const result = await tool.exec({ search: 'acme', objects: ['Account'], limit: 5 });

  assert.equal(result.isError, undefined);
  const output = structured(result);
  assert.deepEqual(searchRecordsOutputSchema.parse(output), output);
  assert.equal(output.mode, 'KEYWORD');
  assert.equal(output.statement, 'FIND {acme} IN ALL FIELDS RETURNING Account(Id, Name) LIMIT 5');
  assert.equal(output.limitSource, 'REQUEST');
  assert.equal(output.effectiveLimit, 5);
  assert.equal(output.totalReturned, 1);

  const text = textOf(result);
  assert.match(text, /^SOSL: FIND \{acme\} IN ALL FIELDS RETURNING Account\(Id, Name\) LIMIT 5$/mu);
  assert.match(text, /^Account: count=1 returnedCount=1 atLimit=false$/mu);
});

test('a complete FIND clause is passed through unchanged, with its own limit as the effective cap', async () => {
  const clause = 'FIND {acme} IN ALL FIELDS RETURNING Account(Id, Name), Contact(Id, Name) LIMIT 7';
  const tool = searchTool(() => searchPayload([searchRecord('Contact', { Name: 'Acme Ltd' })]));
  const result = await tool.exec({ search: clause });

  const output = structured(result);
  assert.deepEqual(searchRecordsOutputSchema.parse(output), output);
  assert.equal(output.mode, 'STATEMENT');
  assert.equal(output.statement, clause, 'the caller\'s own clause is never rewritten');
  assert.equal(output.limitSource, 'STATEMENT');
  assert.equal(output.effectiveLimit, 7);
  assert.equal(output.complete, true);
});

test('a clause with no LIMIT is reported as unprovable rather than as a complete slice', async () => {
  const tool = searchTool(() => searchPayload([searchRecord('Account', { Name: 'Acme' })]));
  const result = await tool.exec({ search: 'FIND {acme} IN ALL FIELDS RETURNING Account(Id, Name)' });

  const output = structured(result);
  assert.equal(output.limitSource, 'UNSPECIFIED');
  assert.equal(output.effectiveLimit, null);
  assert.equal(output.complete, false);
  assert.equal(output.truncated, false);
  // Not truncated and not complete is the one combination a naive reading would collapse, so the
  // hint has to explain why: SOSL reports no total, so nothing here can prove the set is whole.
  assert.match(String(output.hint), /no total match count/u);
  assert.match(String(output.hint), /Add a LIMIT to the clause/u);
});

test('an illegal search is rejected before any Salesforce call', async () => {
  const rejected: ReadonlyArray<Readonly<{ label: string; input: Readonly<Record<string, unknown>> }>> = [
    { label: 'semicolon in keyword', input: { search: 'acme; LIMIT 5' } },
    { label: 'semicolon in clause', input: { search: 'FIND {acme} IN ALL FIELDS; FIND {other}' } },
    { label: 'brace in keyword', input: { search: '{acme}' } },
    { label: 'over-long search', input: { search: 'a'.repeat(2_001) } },
    { label: 'objects with a complete clause', input: { search: 'FIND {acme} IN ALL FIELDS', objects: ['Account'] } },
    { label: 'limit with a complete clause', input: { search: 'FIND {acme} IN ALL FIELDS', limit: 5 } },
    { label: 'fields without objects', input: { search: 'acme', fields: ['Id'] } },
    { label: 'limit above the cap', input: { search: 'acme', limit: 201 } },
    { label: 'limit of zero', input: { search: 'acme', limit: 0 } },
    { label: 'non-integer limit', input: { search: 'acme', limit: 1.5 } },
    { label: 'too many objects', input: { search: 'acme', objects: Array.from({ length: 21 }, (_, index) => `Object${index}__c`) } },
    { label: 'object with a relationship path', input: { search: 'acme', objects: ['Account.Name'] } },
    { label: 'object beginning with a digit', input: { search: 'acme', objects: ['1Account'] } },
    { label: 'empty search', input: { search: '   ' } },
  ];
  for (const { label, input } of rejected) {
    let called = false;
    const tool = searchTool(() => {
      called = true;
      return searchPayload([]);
    });
    const result = await tool.exec(input as unknown as SearchRecordsInput);

    assert.equal(result.isError, true, `${label} must be rejected`);
    const output = structured(result);
    assert.equal(output.errorCode, 'MCP_DATA_INVALID_INPUT', `${label} must be an input rejection`);
    assert.deepEqual(searchRecordsOutputSchema.parse(output), output);
    assert.equal(called, false, `${label} must not reach Salesforce`);
  }
});

test('a search_records failure stays an isError result with an example and no stack trace', async () => {
  const tool = searchTool(() => { throw salesforceError('MALFORMED_SEARCH', 'unexpected token: RETRNING'); });
  const result = await tool.exec({ search: 'acme' });

  assert.equal(result.isError, true);
  const output = structured(result);
  assert.equal(output.errorCode, 'MCP_SEARCH_MALFORMED');
  assert.equal(output.salesforceErrorCode, 'MALFORMED_SEARCH');
  assert.match(String(output.suggestion), /FIND \{term\} IN ALL FIELDS RETURNING Account\(Id, Name\) LIMIT 20/u);
  assert.doesNotMatch(textOf(result), /at .*\.(ts|js):\d+/u);
  assert.doesNotMatch(textOf(result), /\bstack\b/iu);
  assert.deepEqual(searchRecordsOutputSchema.parse(output), output);
});

test('the search limit hint names get_org_limits only when this session advertises it', async () => {
  const exhausted = () => { throw salesforceError('REQUEST_LIMIT_EXCEEDED', 'Request limit exceeded'); };

  const withLimits = await searchTool(exhausted, ['search_records', 'get_org_limits']).exec({ search: 'acme' });
  assert.equal(structured(withLimits).errorCode, 'MCP_SEARCH_LIMIT_EXCEEDED');
  assert.match(textOf(withLimits), /get_org_limits/u);

  const withoutLimits = await searchTool(exhausted, ['search_records']).exec({ search: 'acme' });
  assert.equal(structured(withoutLimits).errorCode, 'MCP_SEARCH_LIMIT_EXCEEDED');
  assert.doesNotMatch(textOf(withoutLimits), /get_org_limits/u);
  assert.match(textOf(withoutLimits), /24-hour rolling allowance/u);
});

test('a search hint never names a Tool this session does not advertise', async () => {
  const tool = searchTool(() => searchPayload([searchRecord('Account', { Name: 'Acme' })]), ['search_records']);
  const result = await tool.exec({ search: 'acme' });

  // With no objects named every row is an opaque id, so the hint wants to recommend query_records by
  // name — which it may only do when this session actually advertises it.
  const without = textOf(result);
  assert.doesNotMatch(without, /query_records/u);
  assert.match(without, /Name objects and fields for readable rows\./u);

  const withQuery = searchTool(
    () => searchPayload([searchRecord('Account', { Name: 'Acme' })]),
    ['search_records', 'query_records'],
  );
  assert.match(textOf(await withQuery.exec({ search: 'acme' })), /read these Ids with query_records/u);
});

const JOB_ID = '750000000000001AAA';

function jobResponse(state: string, overrides: Readonly<Record<string, unknown>> = {}): BulkResponse {
  return { body: bulkJob(JOB_ID, { state, ...overrides }), headers: bulkResultHeaders(null) };
}

test('submit_bulk_query declares a GA, DATA, read-only contract and says what it will not do', () => {
  const tool = submitBulkTool(() => jobResponse('UploadComplete'));

  assert.equal(tool.getName(), 'submit_bulk_query');
  assert.equal(tool.getReleaseState(), ReleaseState.GA);
  assert.deepEqual(tool.getToolsets(), [Toolset.DATA]);

  const annotations = annotationsOf(tool);
  assert.equal(annotations.readOnlyHint, true);
  // Not idempotent: submitting twice creates two jobs and costs two sets of API calls.
  assert.equal(annotations.idempotentHint, false);
  assert.equal(annotations.destructiveHint, false);
  assert.ok(tool.getConfig().inputSchema !== undefined);
  assert.ok(tool.getConfig().outputSchema !== undefined);

  // The Agent has to be able to tell what creating a job does and does not do before calling it.
  const description = descriptionOf(tool);
  assert.match(description, /never an insert, update, upsert or delete/u);
  assert.match(description, /operation is fixed to query rather than accepted as input/u);
  assert.match(description, /asynchronous/u);
  assert.match(description, /No job state is stored on the server/u);
  assert.match(description, /query_records for a small or exploratory result/u);
  assert.match(description, /describe_sobject/u);
});

test('get_bulk_query_results declares a GA, DATA, read-only contract and cross-references the submission', () => {
  const tool = resultsBulkTool(() => jobResponse('JobComplete'));

  assert.equal(tool.getName(), 'get_bulk_query_results');
  assert.equal(tool.getReleaseState(), ReleaseState.GA);
  assert.deepEqual(tool.getToolsets(), [Toolset.DATA]);

  const annotations = annotationsOf(tool);
  assert.equal(annotations.readOnlyHint, true);
  assert.equal(annotations.destructiveHint, false);
  // Reading the same page twice is the same read, so this one is idempotent.
  assert.equal(annotations.idempotentHint, true);
  assert.ok(tool.getConfig().inputSchema !== undefined);
  assert.ok(tool.getConfig().outputSchema !== undefined);

  const description = descriptionOf(tool);
  assert.match(description, /submit_bulk_query/u);
  assert.match(description, /A page is never returned partially/u);
  assert.match(description, /every value in records is a string|every field arrives as text/u);
  assert.match(description, /No job state is stored on the server/u);
  assert.match(description, /Failed or Aborted/u);
});

test('the two Bulk Tools name each other, so either one leads to the other', () => {
  // An Agent that finds only one half has to be able to reach the other from its description.
  assert.match(descriptionOf(submitBulkTool(() => jobResponse('UploadComplete'))), /get_bulk_query_results/u);
  assert.match(descriptionOf(resultsBulkTool(() => jobResponse('JobComplete'))), /submit_bulk_query/u);
});

test('a successful submit_bulk_query result satisfies its own declared output schema and the text mirrors it', async () => {
  const tool = submitBulkTool(
    () => ({ body: bulkJob(JOB_ID, { state: 'JobComplete' }), headers: bulkResultHeaders(null, { used: 4, limit: 100 }) }),
    ['submit_bulk_query', 'get_bulk_query_results'],
  );
  const result = await tool.exec({ query: 'SELECT Id FROM Account' });

  assert.equal(result.isError, undefined);
  const output = structured(result);
  assert.deepEqual(submitBulkQueryOutputSchema.parse(output), output);
  assert.equal(output.success, true);
  assert.equal(output.jobId, JOB_ID);
  assert.equal(output.operation, 'query');
  assert.equal(output.api, 'REST');

  const text = textOf(result);
  assert.match(text, /^submit_bulk_query: jobId=750000000000001AAA state=JobComplete apiVersion=65\.0 operation=query apiUsage=4\/100 used$/mu);
  assert.match(text, /Next: The job is already complete: call get_bulk_query_results with this jobId/u);
});

test('a successful get_bulk_query_results result satisfies its own declared output schema and the text mirrors it', async () => {
  const tool = resultsBulkTool(
    (request) => (request.url.includes('/results')
      ? { body: bulkRows(2), headers: bulkResultHeaders(null, { used: 5, limit: 100 }) }
      : { body: bulkJob(JOB_ID, { numberRecordsProcessed: 2 }), headers: bulkResultHeaders(null) }),
    ['get_bulk_query_results'],
  );
  const result = await tool.exec({ jobId: JOB_ID });

  assert.equal(result.isError, undefined);
  const output = structured(result);
  assert.deepEqual(getBulkQueryResultsOutputSchema.parse(output), output);
  assert.equal(output.complete, true);
  assert.equal(output.returnedCount, 2);

  const text = textOf(result);
  assert.match(text, /^get_bulk_query_results: jobId=750000000000001AAA state=JobComplete numberRecordsProcessed=2 numberRecordsFailed=0 totalRecords=2 returnedCount=2 hasMore=false complete=true locator=null$/mu);
  assert.match(text, /Records \(2\):/u);
});

test('a Failed job is an isError result that still satisfies the declared output schema', async () => {
  const tool = resultsBulkTool(() => jobResponse('Failed', { errorMessage: 'Invalid field: Nope' }));
  const result = await tool.exec({ jobId: JOB_ID });

  // The call succeeded and the export did not: the Agent has to see a failure, and a client
  // parsing structuredContent has to be able to rely on the same declared shape.
  assert.equal(result.isError, true);
  const output = structured(result);
  assert.deepEqual(getBulkQueryResultsOutputSchema.parse(output), output);
  assert.equal(output.success, false);
  assert.equal(output.errorCode, 'MCP_BULK_JOB_FAILED');
  assert.match(textOf(result), /^stateMessage: Invalid field: Nope$/mu);
  assert.doesNotMatch(textOf(result), /at .*\.(ts|js):\d+/u);
  assert.doesNotMatch(textOf(result), /\bstack\b/iu);
});

test('a Bulk failure stays an isError result with a safe next step and no stack trace', async () => {
  const tool = submitBulkTool(() => {
    throw Object.assign(new Error('No such column Nmae on entity Account'), { errorCode: 'INVALID_FIELD' });
  });
  const result = await tool.exec({ query: 'SELECT Nmae FROM Account' });

  assert.equal(result.isError, true);
  const output = structured(result);
  assert.equal(output.errorCode, 'MCP_BULK_QUERY_INVALID');
  assert.equal(output.salesforceErrorCode, 'INVALID_FIELD');
  assert.match(textOf(result), /Next: /u);
  assert.doesNotMatch(textOf(result), /at .*\.(ts|js):\d+/u);
  assert.doesNotMatch(textOf(result), /\bstack\b/iu);
  assert.deepEqual(submitBulkQueryOutputSchema.parse(output), output);
});

test('a Bulk hint never names a Tool this session does not advertise', async () => {
  const submit = submitBulkTool(() => jobResponse('InProgress'), ['submit_bulk_query']);
  const submitText = textOf(await submit.exec({ query: 'SELECT Id FROM Account' }));
  assert.doesNotMatch(submitText, /get_bulk_query_results/u);
  assert.match(submitText, /Ask an administrator to enable the Bulk result-reading capability/u);

  const results = resultsBulkTool(() => jobResponse('InProgress'), ['get_bulk_query_results']);
  const resultsText = textOf(await results.exec({ jobId: JOB_ID }));
  assert.match(resultsText, /Call get_bulk_query_results again/u);
  assert.doesNotMatch(resultsText, /submit_bulk_query/u);
});

test('no Bulk Tool accepts a Salesforce identity, credential or org selector as input', async () => {
  const rejected: ReadonlyArray<Readonly<{ label: string; input: Readonly<Record<string, unknown>> }>> = [
    { label: 'username', input: { query: 'SELECT Id FROM Account', username: 'admin@example.test' } },
    { label: 'accessToken', input: { query: 'SELECT Id FROM Account', accessToken: 'secret' } },
    { label: 'instanceUrl', input: { query: 'SELECT Id FROM Account', instanceUrl: 'https://example.my.salesforce.com' } },
    { label: 'operation', input: { query: 'SELECT Id FROM Account', operation: 'delete' } },
  ];
  for (const { label, input } of rejected) {
    let called = false;
    const tool = submitBulkTool(() => {
      called = true;
      return jobResponse('UploadComplete');
    });
    const result = await tool.exec(input as unknown as SubmitBulkQueryInput);

    assert.equal(result.isError, true, `${label} must not be an accepted input`);
    assert.equal(structured(result).errorCode, 'MCP_DATA_INVALID_INPUT');
    assert.equal(called, false, `${label} must not reach Salesforce`);
  }

  const results = resultsBulkTool(() => jobResponse('JobComplete'));
  const withExtra = await results.exec({ jobId: JOB_ID, query: 'SELECT Id FROM Account' } as unknown as GetBulkQueryResultsInput);
  assert.equal(withExtra.isError, true);
  assert.equal(structured(withExtra).errorCode, 'MCP_DATA_INVALID_INPUT');
});

test('an illegal jobId or cursor is rejected before any Bulk call', async () => {
  const rejected: ReadonlyArray<Readonly<{ label: string; input: Readonly<Record<string, unknown>> }>> = [
    { label: 'jobId too short', input: { jobId: '750000000000001A' } },
    { label: 'jobId too long', input: { jobId: '750000000000001AAAA' } },
    { label: 'jobId not an Id', input: { jobId: 'not-a-salesforce-id' } },
    { label: 'locator is the terminal marker', input: { jobId: JOB_ID, locator: 'null' } },
    { label: 'maxRecords above the cap', input: { jobId: JOB_ID, maxRecords: 50_001 } },
    { label: 'maxRecords of zero', input: { jobId: JOB_ID, maxRecords: 0 } },
  ];
  for (const { label, input } of rejected) {
    let called = false;
    const tool = resultsBulkTool(() => {
      called = true;
      return jobResponse('JobComplete');
    });
    const result = await tool.exec(input as unknown as GetBulkQueryResultsInput);

    assert.equal(result.isError, true, `${label} must be rejected`);
    const output = structured(result);
    assert.equal(output.errorCode, 'MCP_DATA_INVALID_INPUT', label);
    assert.deepEqual(getBulkQueryResultsOutputSchema.parse(output), output);
    assert.equal(called, false, `${label} must not reach Salesforce`);
  }
});

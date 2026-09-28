import assert from 'node:assert/strict';
import test from 'node:test';
import { ReleaseState, Toolset } from '@salesforce/mcp-provider-api';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DescribeSobjectExecutor } from '../describe-sobject-executor.js';
import { ListSobjectsExecutor } from '../list-sobjects-executor.js';
import { QueryRecordsExecutor } from '../query-records-executor.js';
import {
  describeSobjectOutputSchema,
  listSobjectsOutputSchema,
  queryRecordsOutputSchema,
  type DescribeSobjectInput,
  type ListSobjectsInput,
  type QueryRecordsInput,
} from '../schemas.js';
import { DescribeSobjectMcpTool } from '../tools/describe-sobject.js';
import { ListSobjectsMcpTool } from '../tools/list-sobjects.js';
import { QueryRecordsMcpTool } from '../tools/query-records.js';
import {
  createFixture,
  describeGlobalPayload,
  describePayload,
  fieldEntry,
  queryBatch,
  rows,
  salesforceError,
  sobjectEntry,
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

function structured(result: CallToolResult): Record<string, unknown> {
  assert.ok(result.structuredContent !== undefined, 'every Data Tool result carries structuredContent');
  return result.structuredContent;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  assert.ok(first !== undefined && first.type === 'text');
  return first.text;
}

function annotationsOf(tool: ListSobjectsMcpTool | DescribeSobjectMcpTool | QueryRecordsMcpTool): Record<string, unknown> {
  const annotations = tool.getConfig().annotations;
  assert.ok(annotations !== undefined, 'every Data Tool declares annotations');
  return annotations;
}

function descriptionOf(tool: ListSobjectsMcpTool | DescribeSobjectMcpTool | QueryRecordsMcpTool): string {
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Connection as JsforceConnection } from '@jsforce/jsforce-node';
import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import { DmlExecutor, createRecordsInputSchema, updateRecordsInputSchema, batchDmlOutputSchema,
  BatchRecordsMcpTool, parseDmlAllowlistJson } from '../index.js';

const id = (index: number) => `a000000000${String(index).padStart(5, '0')}AAA`;
const allowlist = parseDmlAllowlistJson('[{"objectApiName":"Root__c","operations":["CREATE","UPDATE"]}]');
function service(connection: Connection, name = 'user-a@example.invalid'): OrgService {
  return { getAllowedOrgUsernames: async () => new Set([name]), getConnection: async (requested: string) => {
    assert.equal(requested, name); return connection;
  } } as unknown as OrgService;
}
function fixture(response?: unknown, version = '67.0') {
  const calls: Array<{ method: string; records: Record<string, unknown>[]; options: unknown }> = [];
  const mutate = (method: string) => async (records: Record<string, unknown>[], options: unknown) => {
    calls.push({ method, records, options });
    if (response instanceof Error) throw response;
    return response ?? records.map((_record, index) => ({ id: id(index), success: true, errors: [] }));
  };
  const connection = { getApiVersion: () => version, sobject: () => ({ create: mutate('POST'), update: mutate('PATCH') }) } as unknown as Connection;
  return { executor: new DmlExecutor(service(connection), allowlist), calls, connection };
}
for (const size of [1, 2, 200]) test(`batch CREATE/UPDATE ${size} records uses one array dispatch`, async () => {
  const { executor, calls } = fixture();
  const records = Array.from({ length: size }, (_, index) => ({ clientReferenceId: `row-${index}`, fields: { Name: `Row ${index}` } }));
  const created = await executor.createRecords({ objectApiName: 'Root__c', allOrNone: false, records });
  assert.equal(created.status, 'SUCCESS'); assert.equal(created.succeeded, size);
  assert.equal(created.results.at(-1)?.clientReferenceId, `row-${size - 1}`);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0]?.options, { allOrNone: false, allowRecursive: false });
  assert.equal(calls[0]?.records[0]?.clientReferenceId, undefined);
  const updated = await executor.updateRecords({ objectApiName: 'Root__c', allOrNone: true,
    records: records.map((record, index) => ({ ...record, recordId: id(index) })) });
  assert.equal(updated.status, 'SUCCESS'); assert.equal(calls.length, 2);
  assert.equal(calls[1]?.records[0]?.Id, id(0)); batchDmlOutputSchema.parse(updated);
});
test('bounds, duplicate references, Id, relationship paths and conflicting Record Type fail before dispatch', async () => {
  const { executor, calls } = fixture();
  const tool = new BatchRecordsMcpTool(executor, 'CREATE');
  const result = await tool.exec({ objectApiName: 'Root__c', allOrNone: false,
    records: Array.from({ length: 201 }, () => ({ fields: { Name: 'X' } })) });
  assert.equal(result.isError, true); assert.equal(calls.length, 0);
  for (const fields of [{ Id: id(0) }, { 'Parent.Name': 'X' }]) {
    assert.equal(updateRecordsInputSchema.safeParse({ objectApiName: 'Root__c', records: [{ recordId: id(0), fields }] }).success, false);
  }
  assert.equal(createRecordsInputSchema.safeParse({ objectApiName: 'Root__c', records: [0, 1].map(() => ({ clientReferenceId: 'same', fields: { Name: 'X' } })) }).success, false);
  assert.equal(createRecordsInputSchema.safeParse({ objectApiName: 'Root__c', records: [{ recordTypeId: id(1), fields: { RecordTypeId: id(2) } }] }).success, false);
  assert.equal(updateRecordsInputSchema.safeParse({ objectApiName: 'Root__c', records: Array.from({ length: 201 }, () => ({ recordId: id(0), fields: { Name: 'X' } })) }).success, false);
});
test('batch allowlist denied and old SDK API fail closed without mutation', async () => {
  const { executor, calls } = fixture();
  await assert.rejects(executor.createRecords({ objectApiName: 'Account', allOrNone: false, records: [{ fields: { Name: 'X' } }] }), /not configured/u);
  await assert.rejects(fixture(undefined, '41.0').executor.createRecords({ objectApiName: 'Root__c', allOrNone: false, records: [{ fields: { Name: 'X' } }] }), /42/u);
  assert.equal(calls.length, 0);
});
for (const code of ['FIELD_CUSTOM_VALIDATION_EXCEPTION', 'INSUFFICIENT_ACCESS_OR_READONLY', 'INVALID_FIELD_FOR_INSERT_UPDATE']) {
  test(`partial Salesforce ${code} remains item-level evidence`, async () => {
    const { executor } = fixture([{ id: id(0), success: true, errors: [] }, { success: false, errors: [{ errorCode: code, message: 'Denied', fields: ['Name'] }] }]);
    const result = await executor.updateRecords({ objectApiName: 'Root__c', allOrNone: false,
      records: [0, 1].map((index) => ({ recordId: id(index), fields: { Name: 'X' } })) });
    assert.equal(result.status, 'PARTIAL_SUCCESS'); assert.equal(result.succeeded, 1); assert.equal(result.failed, 1);
    assert.equal(result.results[1]?.salesforceErrors?.[0]?.errorCode, code);
  });
}
test('allOrNone complete rejection and UNKNOWN transport have distinct counts; no retries', async () => {
  const input = { objectApiName: 'Root__c', allOrNone: true, records: [{ fields: { Name: 'X' } }] };
  assert.equal((await fixture([{ success: false, errors: [{ errorCode: 'ALL_OR_NONE_OPERATION_ROLLED_BACK', message: 'Rolled back' }] }]).executor.createRecords(input)).status, 'FAILED');
  const unknown = fixture(new Error('connection lost'));
  const result = await unknown.executor.createRecords(input);
  assert.equal(result.status, 'OUTCOME_UNKNOWN'); assert.equal(result.failed, 0); assert.equal(result.unknown, 1); assert.equal(unknown.calls.length, 1);
  assert.equal((await fixture([]).executor.createRecords(input)).status, 'OUTCOME_UNKNOWN');
});
test('per-item Record Type payload, exact submitted fields and request USER isolation', async () => {
  const a = fixture(); const b = fixture();
  const submitted: unknown[] = [];
  const executor = new DmlExecutor(service(a.connection), allowlist, { onMutationStarted: () => undefined,
    runWithSubmittedRecords: async (records, call) => { submitted.push(records); return call(); } });
  await Promise.all([executor.createRecords({ objectApiName: 'Root__c', allOrNone: false,
    records: [1, 2].map((index) => ({ recordTypeId: id(index), fields: { Name: 'A' } })) }),
  new DmlExecutor(service(b.connection, 'user-b@example.invalid'), allowlist).createRecords({ objectApiName: 'Root__c', allOrNone: false, records: [{ fields: { Name: 'B' } }] })]);
  assert.deepEqual(submitted[0], a.calls[0]?.records); assert.equal(a.calls[0]?.records[1]?.RecordTypeId, id(2));
  assert.equal(b.calls[0]?.records[0]?.Name, 'B');
});
test('real pinned SDK sends one POST/PATCH collection wire request and preserves response correlation order', async () => {
  const requests: { url?: string; method?: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    requests.push({ url: request.url, method: request.method, body: parsed });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([{ id: id(4), success: true, errors: [] }, { id: id(2), success: true, errors: [] }]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const connection = Object.assign(new JsforceConnection({ instanceUrl: `http://127.0.0.1:${address.port}`, version: '67.0', accessToken: 'test-only', httpProxy: '' }),
      { getApiVersion: () => '67.0' }) as unknown as Connection;
    const executor = new DmlExecutor(service(connection), allowlist);
    const created = await executor.createRecords({ objectApiName: 'Root__c', allOrNone: false,
      records: [{ clientReferenceId: 'first', fields: { Name: 'First' } }, { clientReferenceId: 'second', fields: { Name: 'Second' } }] });
    assert.equal(created.results[0]?.recordId, id(4)); assert.equal(created.results[0]?.clientReferenceId, 'first');
    await executor.updateRecords({ objectApiName: 'Root__c', allOrNone: true,
      records: [4, 2].map((index) => ({ recordId: id(index), fields: { Name: 'Updated' } })) });
    assert.equal(requests.length, 2); assert.deepEqual(requests.map((request) => request.method), ['POST', 'PATCH']);
    assert.ok(requests.every((request) => request.url === '/services/data/v67.0/composite/sobjects'));
    assert.equal(requests[1]?.body.allOrNone, true);
    assert.equal(JSON.stringify(requests).includes('clientReferenceId'), false);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

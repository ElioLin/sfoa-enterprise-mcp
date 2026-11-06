import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import type { MutationExecutionObserver, SalesforceFieldValue } from '@sfoa/mcp-provider-sfoa-dml';
import { FormDmlPreflight } from '../form-dml-preflight.js';

const RT = '012000000000001AAA';
const PARENT = '001000000000001AAA';
const RECORD = '003000000000001AAA';

function fixture(action: 'CREATE' | 'UPDATE' = 'CREATE') {
  const writes: Array<{ url: string; body: unknown }> = [];
  const events: string[] = [];
  const submitted: Array<Readonly<Record<string, SalesforceFieldValue>>> = [];
  const stored: Record<string, unknown> = { LastName: 'Stored', Required__c: 'Present', Status__c: 'Open', Internal__c: 'Keep' };
  const defaults: Record<string, unknown> = { Status__c: 'Closed', Required__c: 'Native preset' };
  let response: unknown = { success: true, created: action === 'CREATE', id: RECORD, contextId: action === 'CREATE' ? PARENT : RECORD, errors: [] };
  let thrown: unknown;
  const quickActionName = action === 'CREATE' ? 'Account.NewContact' : 'Contact.CloseContact';
  const names = ['LastName', 'Required__c', 'Status__c', 'Internal__c', 'AccountId'];
  const layout = { sections: [{ heading: 'Standard', layoutRows: [{ layoutItems: [{ required: true,
    editableForNew: true, editableForUpdate: true, layoutComponents: [{ componentType: 'Field', apiName: 'LastName' }] }] }] }] };
  const connection = { getApiVersion: () => '67.0', request: async (request: { method: string; url: string; body?: string }) => {
    if (request.method === 'POST') {
      writes.push({ url: request.url, body: JSON.parse(request.body ?? '{}') as unknown });
      if (thrown) throw thrown;
      return response;
    }
    if (request.url.endsWith('/describe')) return {
      name: quickActionName, type: action === 'CREATE' ? 'Create' : 'Update', targetSobjectType: 'Contact',
      targetRecordTypeId: RT, contextSobjectType: action === 'CREATE' ? 'Account' : 'Contact',
      targetParentField: action === 'CREATE' ? 'AccountId' : null,
      defaultValues: [{ field: 'Status__c', defaultValue: 'Closed' }, { field: 'Required__c', defaultValue: 'Native preset' }],
      layout: { heading: 'Native action', layoutRows: [{ layoutItems: ['LastName', 'Required__c', 'Status__c'].map((value) => ({
        editableForNew: true, editableForUpdate: true, required: value !== 'Status__c', layoutComponents: [{ type: 'Field', value }],
      })) }] },
    };
    if (request.url.includes('/quickActions/') && request.url.includes('/defaultValues')) return defaults;
    if (request.url.includes('/picklist-values/')) return { picklistFieldValues: {} };
    if (request.url.includes('/object-info/')) return { apiName: 'Contact', label: 'Contact', labelPlural: 'Contacts',
      createable: true, updateable: true, defaultRecordTypeId: RT, recordTypeInfos: { [RT]: { recordTypeId: RT, name: 'Business', available: true, defaultRecordTypeMapping: true } },
      fields: Object.fromEntries(names.map((apiName) => [apiName, { apiName, label: apiName,
        dataType: apiName === 'AccountId' ? 'Reference' : 'String', required: apiName === 'LastName', createable: true, updateable: true,
        ...(apiName === 'AccountId' ? { referenceToInfos: [{ apiName: 'Account' }] } : {}),
      }])) };
    if (request.url.includes('/record-defaults/create/')) return { layout,
      record: { apiName: 'Contact', recordTypeId: RT, fields: { LastName: { value: 'Object default' }, Internal__c: { value: 'Not submitted' } } } };
    if (request.url.includes('/layout/')) return layout;
    if (request.url.includes(`/records/${PARENT}`)) return { id: PARENT, apiName: 'Account', recordTypeId: RT, fields: { Id: { value: PARENT } } };
    if (request.url.includes(`/records/${RECORD}`)) return { id: RECORD, apiName: 'Contact', recordTypeId: RT,
      fields: Object.fromEntries(Object.entries(stored).map(([name, value]) => [name, { value }])) };
    throw new Error('Unexpected API');
  } } as unknown as Connection;
  const orgService = { getAllowedOrgUsernames: async () => new Set(['current-user@example.test']), getConnection: async () => connection } as unknown as OrgService;
  const observer: MutationExecutionObserver = {
    onMutationStarted: (operation) => { events.push(`START:${operation}`); },
    onMutationCompleted: (operation, id) => { events.push(`COMPLETE:${operation}:${id}`); },
    runWithSubmittedFields: async (fields, callback) => { submitted.push({ ...fields }); return callback(); },
  };
  const preflight = new FormDmlPreflight(orgService, async () => connection, observer, {
    loadMetadata: async () => { throw new Error('Native actions must not read Lightning metadata'); },
  });
  const input = { objectApiName: 'Contact', ...(action === 'UPDATE' ? { recordId: RECORD } : {}), fields: { LastName: 'User value' },
    formContext: { entry: 'QUICK_ACTION', quickActionName, ...(action === 'CREATE' ? { sourceRecordId: PARENT } : {}) } };
  return { preflight, input, writes, events, submitted, defaults, stored,
    setResponse(value: unknown) { response = value; }, setThrown(value: unknown) { thrown = value; } };
}

test('native create preparation is read-only; execution dispatches exactly the minimal draft once', async () => {
  const f = fixture();
  const prepared = await f.preflight.prepare('CREATE', f.input);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.events, []);
  assert.ok(prepared.execute);
  const result = await prepared.execute();
  assert.equal(result.structuredContent?.success, true);
  assert.equal(result.structuredContent?.recordId, RECORD);
  assert.deepEqual(f.writes, [{ url: '/services/data/v67.0/sobjects/Account/quickActions/NewContact',
    body: { contextId: PARENT, record: { LastName: 'User value' } } }]);
  assert.deepEqual(f.submitted, [{ LastName: 'User value' }]);
  assert.deepEqual(f.events, ['START:CREATE', `COMPLETE:CREATE:${RECORD}`]);
});

test('native UPDATE keeps the explicit override of an action preset even when it equals saved data', async () => {
  const f = fixture('UPDATE');
  const prepared = await f.preflight.prepare('UPDATE', { ...f.input, fields: { Status__c: 'Open' } });
  const result = await prepared.execute!();
  assert.equal(result.structuredContent?.recordId, RECORD);
  assert.deepEqual(f.writes[0]?.body, { contextId: RECORD, record: { Status__c: 'Open' } });
  assert.equal(f.writes.length, 1);
});

test('native rejection envelope stays FAILED and does not announce mutation completion', async () => {
  for (const codeName of ['statusCode', 'errorCode']) {
    const f = fixture();
    f.setResponse({ success: false, created: false, errors: [{ [codeName]: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Business rejection', fields: ['LastName'] }] });
    const prepared = await f.preflight.prepare('CREATE', f.input);
    const result = await prepared.execute!();
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.errorCode, 'MCP_SALESFORCE_DML_FAILED');
    assert.deepEqual(f.events, ['START:CREATE']);
    assert.equal(f.writes.length, 1);
  }
});

test('native SDK structured rejection stays FAILED; an unstructured disconnect remains UNKNOWN without retry', async () => {
  for (const [error, expected] of [
    [Object.assign(new Error('Rejected'), { data: [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required value', fields: ['LastName'] }] }), 'MCP_SALESFORCE_DML_FAILED'],
    [Object.assign(new Error('socket disconnected after dispatch'), { code: 'ECONNRESET' }), 'MCP_DML_OUTCOME_UNKNOWN'],
  ] as const) {
    const f = fixture(); f.setThrown(error);
    const prepared = await f.preflight.prepare('CREATE', f.input);
    const result = await prepared.execute!();
    assert.equal(result.structuredContent?.errorCode, expected);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.events, ['START:CREATE']);
  }
});

test('native success with missing id or wrong updated record cannot be called successful', async () => {
  for (const response of [
    { success: true, created: false, errors: [] },
    { success: true, created: false, id: '003000000000099AAA', contextId: RECORD, errors: [] },
  ]) {
    const f = fixture('UPDATE'); f.setResponse(response);
    const prepared = await f.preflight.prepare('UPDATE', f.input);
    const result = await prepared.execute!();
    assert.equal(result.structuredContent?.errorCode, 'MCP_DML_OUTCOME_UNKNOWN');
    assert.deepEqual(f.events, ['START:UPDATE']);
    assert.equal(f.writes.length, 1);
  }
});

test('unknown required native default blocks preparation and never dispatches', async () => {
  const f = fixture(); delete f.defaults.Required__c;
  await assert.rejects(f.preflight.prepare('CREATE', f.input), /REQUIRED_VALUE_UNRESOLVED:Required__c/u);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.events, []);
});

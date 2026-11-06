import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import { UI_PARSER_VERSION, type PrecisionFormOptions } from '@sfoa/mcp-provider-sfoa-context';
import { FormDmlPreflight } from '../form-dml-preflight.js';
import { MutationRequestState } from '../provider-runtime.js';

const recordId = '001000000000001AAA';
const rt = '012000000000001AAA';
const orgId = '00D000000000001AAA';
const profile = '00e000000000001AAA';
const app = { appId: '06m000000000001AAA', fullName: 'Sales_App', developerName: 'Sales_App' };

function fixture() {
  let requiredReason = true;
  let configurationReads = 0;
  let nativeCalls = 0;
  const stored: Record<string, unknown> = { Name: 'Existing', Reason__c: '', Extra__c: 'Keep' };
  const layout = () => ({ id: '00h000000000001AAA', sections: [{ heading: 'Details', layoutRows: [{ layoutItems:
    ['Name', 'Reason__c'].map((apiName) => ({ editableForNew: true, editableForUpdate: true,
      required: apiName === 'Name' || requiredReason, layoutComponents: [{ componentType: 'Field', apiName }] })) }] }] });
  const connection = {
    getApiVersion: () => '67.0', soap: { getUserInfo: async () => ({ organizationId: orgId, profileId: profile, userId: '005000000000001AAA' }) },
    request: async (request: { method: string; url: string; body?: string }) => {
      if (request.method === 'POST') { nativeCalls++; throw new Error('Unexpected mutation'); }
      if (request.url.includes('/apps?')) return { apps: [app] };
      if (request.url.includes('/picklist-values/')) return { picklistFieldValues: {} };
      if (request.url.includes('/object-info/')) return { apiName: 'Account', label: 'Account', labelPlural: 'Accounts',
        createable: true, updateable: true, defaultRecordTypeId: rt,
        recordTypeInfos: { [rt]: { recordTypeId: rt, name: 'Business', available: true, defaultRecordTypeMapping: true } },
        fields: Object.fromEntries(['Name', 'Reason__c', 'Extra__c'].map((apiName) => [apiName, { apiName, label: apiName,
          dataType: 'String', required: false, createable: true, updateable: true }])) };
      if (request.url.includes('/record-defaults/')) return { layout: layout(), record: { apiName: 'Account', recordTypeId: rt,
        fields: { Name: { value: 'Default' }, Extra__c: { value: 'Off-form default' } } } };
      if (request.url.includes('/layout/')) return layout();
      if (request.url.includes('/records/')) return { id: recordId, apiName: 'Account', recordTypeId: rt,
        fields: Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, { value }])) };
      throw new Error('Unexpected read');
    },
  } as unknown as Connection;
  const orgService = { getAllowedOrgUsernames: async () => new Set(['current-user@example.invalid']),
    getConnection: async () => connection } as unknown as OrgService;
  const precision: PrecisionFormOptions = { loadMetadata: async () => {
    configurationReads++;
    return { appDeveloperName: app.fullName, appSource: 'PROFILE_DEFAULT', verifiedAt: new Date().toISOString(), apiCallCount: 1, evidence: {},
      snapshot: { organizationId: orgId, objectApiName: 'Account', parserVersion: UI_PARSER_VERSION, complete: true,
        apps: [app], profiles: [{ id: profile, name: 'Sales', fullName: 'Sales' }],
        recordTypes: [{ id: rt, fullName: 'Account.Business' }], assignments: [], pages: [] } };
  } };
  return { preflight: new FormDmlPreflight(orgService, async () => connection, new MutationRequestState(), precision),
    stored, setRequired(value: boolean) { requiredReason = value; }, counts: () => ({ configurationReads, nativeCalls }) };
}

test('selected Edit requires historically empty required fields, then preserves unrelated data and omits unchanged patch values', async () => {
  const f = fixture();
  const input = { objectApiName: 'Account', recordId, fields: { Name: 'Changed', Extra__c: 'Keep' }, formContext: { entry: 'STANDARD' } };
  await assert.rejects(f.preflight.prepare('UPDATE', input), /missing:Reason__c/u);
  const ready = await f.preflight.prepare('UPDATE', { ...input, fields: { ...input.fields, Reason__c: 'Confirmed' } });
  assert.deepEqual(ready.input.fields, { Name: 'Changed', Reason__c: 'Confirmed' });
  assert.equal(ready.input.formContext, undefined);
  assert.equal(ready.execute, undefined);
  assert.equal(f.counts().nativeCalls, 0);
});

test('each separate preparation reads current form configuration and a later newly required field blocks dispatch', async () => {
  const f = fixture(); f.setRequired(false);
  const input = { objectApiName: 'Account', recordId, fields: { Name: 'Changed' }, formContext: { entry: 'STANDARD' } };
  await f.preflight.prepare('UPDATE', input);
  f.setRequired(true);
  await assert.rejects(f.preflight.prepare('UPDATE', input), /missing:Reason__c/u);
  assert.equal(f.counts().configurationReads, 2);
  assert.equal(f.counts().nativeCalls, 0);
});

test('standard CREATE applies only selected form defaults and keeps the resolved Record Type', async () => {
  const f = fixture();
  const prepared = await f.preflight.prepare('CREATE', { objectApiName: 'Account', fields: { Reason__c: 'Known' }, formContext: { entry: 'STANDARD' } });
  assert.deepEqual(prepared.input.fields, { Name: 'Default', Reason__c: 'Known' });
  assert.equal(prepared.input.recordTypeId, rt);
});

test('long final values are evaluated directly without truncating the existing DML contract', async () => {
  const f = fixture();
  const text = 'x'.repeat(131072);
  const prepared = await f.preflight.prepare('CREATE', { objectApiName: 'Account', fields: { Reason__c: text }, formContext: { entry: 'STANDARD' } });
  assert.equal((prepared.input.fields as Record<string, unknown>).Reason__c, text);
});

test('a verified unchanged Edit returns a no-op without issuing a write', async () => {
  const f = fixture(); f.stored.Reason__c = 'Existing';
  const prepared = await f.preflight.prepare('UPDATE', { objectApiName: 'Account', recordId, fields: { Name: 'Existing' }, formContext: { entry: 'STANDARD' } });
  assert.deepEqual(prepared.input.fields, {});
  assert.equal((await prepared.execute!()).structuredContent?.recordId, recordId);
  assert.equal(f.counts().nativeCalls, 0);
});

test('Quick Action collection and Edit Record Type changes are rejected before Salesforce reads', async () => {
  const f = fixture();
  await assert.rejects(f.preflight.prepare('CREATE', { objectApiName: 'Account', records: [{ fields: { Name: 'N' },
    formContext: { entry: 'QUICK_ACTION', quickActionName: 'NewAccount' } }] }), /single create_record/u);
  await assert.rejects(f.preflight.prepare('UPDATE', { objectApiName: 'Account', recordId, fields: { RecordTypeId: rt },
    formContext: { entry: 'STANDARD' } }), /Changing Record Type/u);
  assert.equal(f.counts().configurationReads, 0);
});

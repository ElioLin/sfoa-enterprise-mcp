import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import { createInitialState, initialFact, resolveUserFacts, userDependencies } from '../create-initial-state.js';
import { evaluateVisibility } from '../visibility.js';
import { PresentationRelationshipExecutor, displayValuesInputSchema } from '../presentation-relationship.js';
import { fixtureSnapshot, runtimeFixture, rule, RT } from './effective-ui-fixtures.js';

test('CREATE initial precedence tracks explicit/null/false/zero and trusted defaults without Flow guesses', () => {
  const state = createInitialState({ Org__c: { value: 'Salesforce' }, Active__c: { value: true }, Count__c: { value: 7 } },
    { Active__c: false, Count__c: 0, Optional__c: null }, [],
    [initialFact('Record.Org__c', 'Runtime', 'TRUSTED_RUNTIME_DEFAULT'),
      { ...initialFact('Record.AfterSave__c', 'Flow', 'TRUSTED_RUNTIME_DEFAULT'), trustedForVisibility: false }]);
  assert.equal(state.record.Org__c, 'Salesforce'); assert.equal(state.record.Active__c, false); assert.equal(state.record.Count__c, 0);
  assert.equal(state.record.Optional__c, null); assert.equal(state.record.AfterSave__c, undefined);
  assert.equal(state.facts.find((fact) => fact.path === 'Record.Org__c')?.source, 'SALESFORCE_CREATE_DEFAULT');
});
test('metadata-driven USER facts read only needed fields and inaccessible/oversized/timed-out values remain UNKNOWN', async () => {
  const userId = '005000000000001AAA'; const urls: string[] = [];
  const connection = { getApiVersion: () => '67.0', request: async ({ url }: { url: string }) => {
    urls.push(url); return { id: userId, fields: { Org__c: { value: 'Org A' }, Huge__c: { value: 'x'.repeat(5000) } } };
  } } as unknown as Connection;
  const resolved = await resolveUserFacts(connection, userId, ['Org__c', 'Missing__c', 'Huge__c'], { Id: userId }, performance.now() + 1000);
  assert.equal(urls.length, 1); assert.match(urls[0]!, /optionalFields=User.Org__c/u); assert.doesNotMatch(urls[0]!, /FIELDS|Profile|SELECT/u);
  assert.equal(resolved.facts.find((fact) => fact.path === '$User.Missing__c')?.resolutionStatus, 'UNKNOWN');
  assert.equal(resolved.facts.find((fact) => fact.path === '$User.Huge__c')?.resolutionStatus, 'UNKNOWN');
  const state = createInitialState({}, {}, resolved.facts);
  const visibility = { draftFields: state.record, user: state.user, initialFacts: state.facts, fieldTypes: {}, formFactor: 'Large' as const };
  assert.equal(evaluateVisibility(rule('$User.Org__c', 'EQUAL', 'Org A'), visibility, 'CONTAINER').state, 'VISIBLE');
  assert.equal(evaluateVisibility(rule('$User.Missing__c', 'EQUAL', ''), visibility).state, 'UNKNOWN');
  assert.equal((await resolveUserFacts(connection, userId, ['Other__c'], {}, performance.now() - 1)).reason, 'UI_CONTEXT_READ_TIMEOUT');
  assert.equal((await resolveUserFacts(connection, userId, Array.from({ length: 26 }, (_, index) => `F${index}__c`), {}, performance.now() + 1000)).reason, 'USER_FACT_FIELD_BOUND');
  const big = { getApiVersion: () => '67.0', request: async () => ({ id: userId, extra: 'x'.repeat(32769) }) } as unknown as Connection;
  assert.equal((await resolveUserFacts(big, userId, ['Org__c'], {}, performance.now() + 1000)).reason, 'USER_FACT_RESPONSE_BOUND');
});
test('effective CREATE uses defaults, explicit override and bounded USER fact provenance; required field survives UNKNOWN', async () => {
  const snapshot = fixtureSnapshot();
  snapshot.pages[0]!.fields[2]!.rules = [{ scope: 'FIELD', rule: rule('Record.Name', 'EQUAL', 'Default name') }];
  snapshot.pages[0]!.fields[3]!.rules = [{ scope: 'CONTAINER', rule: rule('$User.Org__c', 'EQUAL', 'Org A') }];
  assert.deepEqual(userDependencies(snapshot.pages[0]!), ['Org__c']);
  const fixture = runtimeFixture('ENFORCE', snapshot);
  const original = fixture.connection.request.bind(fixture.connection);
  fixture.connection.request = (async (request: { url: string }) => request.url.includes('/ui-api/records/')
    ? { id: '005000000000001AAA', fields: { Org__c: { value: 'Org A' } } } : original({ method: 'GET', url: request.url })) as unknown as typeof fixture.connection.request;
  const first = await fixture.executor.execute({ objectApiName: 'Sample__c', action: 'CREATE' });
  assert.equal(first.fields?.find((field) => field.apiName === 'Discount__c')?.visibilityState, 'VISIBLE');
  assert.equal(first.fields?.find((field) => field.apiName === 'Internal__c')?.visibilityState, 'VISIBLE');
  assert.equal(first.fields?.find((field) => field.apiName === 'ApiRequired__c')?.effectiveRequired, true);
  const overridden = await fixture.executor.execute({ objectApiName: 'Sample__c', action: 'CREATE', draftFields: { Name: 'Explicit' } });
  assert.equal(overridden.fields?.find((field) => field.apiName === 'Discount__c')?.visibilityState, 'HIDDEN');
  assert.match(JSON.stringify(fixture.evidence), /CURRENT_USER_FACT/u); assert.match(JSON.stringify(fixture.evidence), /SALESFORCE_CREATE_DEFAULT/u);
});
test('unproven initial record-dependent containers remain UNKNOWN while USER/container facts evaluate', () => {
  const facts = { draftFields: { Org__c: 'Org A' }, fieldTypes: { Org__c: 'String' }, user: {}, formFactor: 'Large' as const };
  const result = evaluateVisibility(rule('Record.Org__c', 'EQUAL', 'Org A'), facts, 'CONTAINER');
  assert.equal(result.state, 'UNKNOWN'); assert.ok(result.kinds.includes('CONTAINER_RECORD_UNSUPPORTED'));
});
function org(connection: Connection): OrgService {
  return { getAllowedOrgUsernames: async () => new Set(['current-user']), getConnection: async (name: string) => {
    assert.equal(name, 'current-user'); return connection;
  } } as unknown as OrgService;
}

test('unavailable object metadata preserves raw display rows with explicit unresolved status', async () => {
  const connection = { getApiVersion: () => '67.0', request: async () => { throw new Error('FLS unavailable'); } } as unknown as Connection;
  const result = await new PresentationRelationshipExecutor(org(connection)).display({ objectApiName: 'Root__c',
    values: [{ fieldApiName: 'Status__c', rawValue: 'COMPLETED' }] });
  assert.equal(result.results[0]?.displayValue, 'COMPLETED');
  assert.equal(result.results[0]?.resolutionStatus, 'UNRESOLVED'); assert.equal(result.apiCallCount, 1);
});
test('Picklist, MultiPicklist, mixed Record Types and unresolved raw fallback never mutate raw input', async () => {
  const otherRt = '012000000000002AAA'; const requests: string[] = [];
  const fields = Object.fromEntries(['Status__c', 'Tags__c'].map((apiName) => [apiName, { apiName, label: apiName,
    dataType: apiName === 'Tags__c' ? 'MultiPicklist' : 'Picklist', required: false, createable: true, updateable: true }]));
  const connection = { getApiVersion: () => '67.0', request: async ({ url }: { url: string }) => {
    requests.push(url);
    if (url.includes('/picklist-values/')) return { values: [{ value: 'COMPLETED', label: url.includes(otherRt) ? '结束' : '已完成' }, { value: 'A', label: '甲' }, { value: 'B', label: '乙' }] };
    return { apiName: 'Root__c', label: 'Root', labelPlural: 'Roots', defaultRecordTypeId: RT, fields,
      recordTypeInfos: Object.fromEntries([RT, otherRt].map((recordTypeId) => [recordTypeId, { recordTypeId, name: recordTypeId, available: true, defaultRecordTypeMapping: recordTypeId === RT }])) };
  } } as unknown as Connection;
  const input = displayValuesInputSchema.parse({ objectApiName: 'Root__c', values: [
    { fieldApiName: 'Status__c', rawValue: 'COMPLETED', recordTypeId: RT },
    { fieldApiName: 'Status__c', rawValue: 'COMPLETED', recordTypeId: otherRt },
    { fieldApiName: 'Tags__c', rawValue: 'A;B;C', recordTypeId: RT },
    { fieldApiName: 'Status__c', rawValue: 'UNKNOWN_VALUE', recordTypeId: RT },
  ] });
  const before = JSON.stringify(input);
  const result = await new PresentationRelationshipExecutor(org(connection)).display(input);
  assert.deepEqual(result.results.map((row) => row.displayValue), ['已完成', '结束', '甲;乙;C', 'UNKNOWN_VALUE']);
  assert.deepEqual(result.results.map((row) => row.resolutionStatus), ['RESOLVED', 'RESOLVED', 'PARTIAL', 'UNRESOLVED']);
  assert.equal(JSON.stringify(input), before); assert.equal(requests.length, 4);
});
test('relationship context filters by CREATE governance and USER createability without querying org schema', async () => {
  const reads: string[] = [];
  const connection = { sobject: (name: string) => ({ describe: async () => {
    reads.push(name);
    return name === 'Root__c' ? { name, label: 'Root', childRelationships: ['InternalParticipant__c', 'CustomerParticipant__c', 'Denied__c'].map((childSObject) => ({ childSObject, field: 'Root__c', relationshipName: 'Children' })) }
      : { name, label: name, createable: name !== 'CustomerParticipant__c', fields: [{ name: 'Root__c', label: 'Root reference', createable: true, referenceTo: ['Root__c'] }] };
  } }) } as unknown as Connection;
  const result = await new PresentationRelationshipExecutor(org(connection), ['InternalParticipant__c', 'CustomerParticipant__c'])
    .relationships({ rootObjectApiName: 'Root__c', operation: 'CREATE' });
  assert.equal(result.relationships.length, 1); assert.equal(result.relationships[0]?.relationshipField, 'Root__c');
  assert.deepEqual(reads, ['Root__c', 'InternalParticipant__c', 'CustomerParticipant__c']);
});

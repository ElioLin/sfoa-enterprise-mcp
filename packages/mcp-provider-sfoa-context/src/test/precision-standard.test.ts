import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import { resolveActivePage } from '../active-page.js';
import { evaluateStandardForm, resolveStandardForm, resolveGeneratedFieldFacts, loadPrecisionSavedValues } from '../precision-standard.js';
import type { PrecisionMetadata } from '../precision-metadata.js';
import type { ResolvedActionFacts } from '../record-action-executor.js';
import { objectInfoSchema } from '../ui-api.js';
import { fixtureSnapshot, ORG, PROFILE, RT, rule, runtimeFixture } from './effective-ui-fixtures.js';

async function fixture() {
  const legacy = runtimeFixture('OFF');
  Object.assign(legacy.objectCrud, { createable: true, updateable: true });
  const baseline = await legacy.legacy.execute({ objectApiName: 'Sample__c', action: 'CREATE' });
  const objectInfo = objectInfoSchema.parse(await legacy.connection.request({ method: 'GET', url: '/object-info/Sample__c' }));
  const facts: ResolvedActionFacts = { recordType: objectInfo.recordTypeInfos[RT]!, layout: { sections: [], id: '00h000000000001AAA' },
    defaults: { Name: { value: 'Default name' }, Type__c: { value: 'Other' } }, picklists: { picklistFieldValues: {} },
    sources: ['UI_API_OBJECT_INFO', 'UI_API_CREATE_DEFAULTS'] };
  const snapshot = fixtureSnapshot();
  snapshot.pages[0]!.fields = snapshot.pages[0]!.fields.filter((field) => field.apiName !== 'Unknown__c');
  const metadata: PrecisionMetadata = { snapshot, appDeveloperName: 'App_A', appSource: 'PROFILE_DEFAULT',
    verifiedAt: '2026-11-06T00:00:00.000Z', apiCallCount: 10, evidence: { freshness: 'FRESH_READ' } };
  return { baseline, objectInfo, facts, page: snapshot.pages[0]!, metadata, legacy };
}

test('precision Standard uses Dynamic Forms required fields, duplicate occurrences and API required separately', async () => {
  const f = await fixture();
  const discount = f.page.fields.find((field) => field.apiName === 'Discount__c')!;
  f.page.fields.push({ ...discount, instanceId: 'discount_optional', required: false, rules: [] });
  const result = evaluateStandardForm({ ...f, input: { objectApiName: 'Sample__c', action: 'CREATE',
    draftFields: { Type__c: 'Other', ApiRequired__c: 'present' } } });
  assert.equal(result.fields.find((field) => field.apiName === 'Discount__c')?.visibilityState, 'VISIBLE');
  assert.equal(result.fieldStates.find((field) => field.apiName === 'Discount__c')?.required, false);
  assert.equal(result.fieldStates.find((field) => field.apiName === 'ApiRequired__c')?.required, true);
  assert.equal(result.fields.find((field) => field.apiName === 'ApiRequired__c')?.visibilityState, 'HIDDEN');
  assert.equal(result.fields.find((field) => field.apiName === 'NoFls__c')?.optionalCandidate, false);
  assert.deepEqual(result.blockers, []);
});

test('unknown optional does not block; unknown required blocks even when another optional occurrence is visible', async () => {
  const f = await fixture();
  const instance = f.page.fields.find((field) => field.apiName === 'Discount__c')!;
  instance.rules = [{ scope: 'FIELD', rule: rule('Record.Owner.ManagerId') }];
  instance.required = false;
  const optional = evaluateStandardForm({ ...f, input: { objectApiName: 'Sample__c', action: 'CREATE' } });
  assert.deepEqual(optional.blockers, []);
  instance.required = true;
  f.page.fields.push({ ...instance, instanceId: 'optional_duplicate', required: false, rules: [] });
  const required = evaluateStandardForm({ ...f, input: { objectApiName: 'Sample__c', action: 'CREATE' } });
  assert.equal(required.fieldStates.find((field) => field.apiName === 'Discount__c')?.required, null);
  assert.deepEqual(required.blockers, ['REQUIREDNESS_UNRESOLVED:Discount__c']);
});

test('UPDATE uses saved container values and draft field values; historical required empty is missing without replaying CREATE defaults', async () => {
  const f = await fixture();
  const discount = f.page.fields.find((field) => field.apiName === 'Discount__c')!;
  discount.rules = [{ scope: 'CONTAINER', rule: rule('Record.Type__c', 'EQUAL', 'Other') },
    { scope: 'FIELD', rule: rule('Record.Type__c', 'EQUAL', 'Partner') }];
  const result = evaluateStandardForm({ ...f, input: { objectApiName: 'Sample__c', action: 'UPDATE', draftFields: { Type__c: 'Partner' } },
    savedValues: { Type__c: 'Other', Name: '', ApiRequired__c: 'stored', Discount__c: 0 } });
  assert.equal(result.fields.find((field) => field.apiName === 'Discount__c')?.visibilityState, 'VISIBLE');
  assert.equal(result.fieldStates.find((field) => field.apiName === 'Discount__c')?.valueState, 'PROVIDED');
  assert.equal(result.fieldStates.find((field) => field.apiName === 'Name')?.valueState, 'EMPTY');
  assert.equal(result.fieldStates.find((field) => field.apiName === 'Name')?.source, 'CURRENT_RECORD');
  assert.deepEqual(result.fieldStates.find((field) => field.apiName === 'Name')?.reasons, ['REQUIRED_VALUE_MISSING']);
  assert.equal(result.currentValues.Name, '');
  assert.ok(JSON.stringify(result.rules).includes('SAVED_RECORD'));
  assert.ok(JSON.stringify(result.rules).includes('CURRENT_RECORD'));
});

test('New record-dependent container remains unknown; a proven hidden ancestor short-circuits unknown', async () => {
  const f = await fixture();
  const discount = f.page.fields.find((field) => field.apiName === 'Discount__c')!;
  discount.rules = [{ scope: 'CONTAINER', rule: rule('Record.Type__c') }];
  const input = { objectApiName: 'Sample__c', action: 'CREATE' as const, draftFields: { Type__c: 'Partner' } };
  assert.deepEqual(evaluateStandardForm({ ...f, input }).blockers, ['REQUIREDNESS_UNRESOLVED:Discount__c']);
  discount.rules.push({ scope: 'FIELD', rule: rule('Record.Type__c', 'EQUAL', 'Never') });
  assert.deepEqual(evaluateStandardForm({ ...f, input }).blockers, []);
});

test('absent current value stays unknown; explicit null, false and zero do not fall through to defaults', async () => {
  const f = await fixture();
  const updated = evaluateStandardForm({ ...f, input: { objectApiName: 'Sample__c', action: 'UPDATE' }, savedValues: {} });
  assert.ok(updated.blockers.includes('REQUIRED_VALUE_UNRESOLVED:Name'));
  for (const value of [null, '', false, 0]) {
    const result = evaluateStandardForm({ ...f, input: { objectApiName: 'Sample__c', action: 'CREATE', draftFields: { Name: value } } });
    assert.equal(result.currentValues.Name, value);
    assert.equal(result.fieldStates.find((field) => field.apiName === 'Name')?.valueState, value === null || value === '' ? 'EMPTY' : 'PROVIDED');
  }
});

test('mixed pages ignore Page Layout-only required fields, pure Page Layout retains them', async () => {
  const f = await fixture();
  const name = f.baseline.fields!.find((field) => field.apiName === 'Name')!;
  name.layoutRequired = true;
  f.page.fields.find((field) => field.apiName === 'Name')!.required = false;
  f.page.formSource = 'MIXED';
  const input = { objectApiName: 'Sample__c', action: 'CREATE' as const };
  assert.equal(evaluateStandardForm({ ...f, input }).fieldStates.find((field) => field.apiName === 'Name')?.required, false);
  assert.equal(evaluateStandardForm({ ...f, page: undefined, input }).fieldStates.find((field) => field.apiName === 'Name')?.required, true);
});

test('New and Edit custom overrides are resolved independently with legacy default unchanged', () => {
  const snapshot = fixtureSnapshot();
  snapshot.assignments.push({ app: null, profile: null, recordType: null, formFactor: 'Large', action: 'Edit',
    type: 'Visualforce', page: 'Custom_Edit', source: 'ORG_DEFAULT' });
  const facts = { profileId: PROFILE, recordTypeId: RT, formFactor: 'Large' as const, apps: snapshot.apps, appDeveloperName: 'App_A' };
  assert.equal(resolveActivePage(snapshot, facts).formSource, 'DYNAMIC_FORMS');
  assert.equal(resolveActivePage(snapshot, { ...facts, action: 'UPDATE' }).formSource, 'CUSTOM_OVERRIDE');
});

test('live resolver binds USER identity to fresh metadata and reads complete applicable Edit fields', async () => {
  const f = await fixture();
  const recordId = 'a00000000000001AAA';
  const urls: string[] = [];
  const connection = { ...f.legacy.connection, request: async ({ url }: { url: string }) => {
    urls.push(url);
    if (url.includes('/apps?')) return { apps: f.metadata.snapshot.apps };
    return { id: recordId, apiName: 'Sample__c', recordTypeId: RT,
      fields: { Name: { value: 'old' }, Type__c: { value: 'Other' }, ApiRequired__c: { value: 'stored' } } };
  } } as unknown as Connection;
  const result = await resolveStandardForm({ ...f, connection,
    input: { objectApiName: 'Sample__c', action: 'UPDATE', recordId, draftFields: { Type__c: 'Other' } },
    loadMetadata: async (request) => { assert.equal(request.profileId, PROFILE); assert.equal(request.organizationId, ORG); return f.metadata; } });
  assert.equal(result.formSource, 'DYNAMIC_FORMS');
  assert.equal(result.profileId, PROFILE);
  assert.equal(result.appSource, 'PROFILE_DEFAULT');
  assert.equal(result.fieldStates.find((field) => field.apiName === 'Name')?.source, 'CURRENT_RECORD');
  assert.ok(urls.some((url) => decodeURIComponent(url).includes('Sample__c.Name')));
  assert.deepEqual(result.blockers, []);
});

test('metadata missing, wrong org, read failures and deadline never report successful Page Layout fallback', async () => {
  const f = await fixture();
  const args = { ...f, connection: f.legacy.connection, input: { objectApiName: 'Sample__c', action: 'CREATE' as const } };
  const absent = await resolveStandardForm(args);
  assert.equal(absent.formSource, 'UNRESOLVED'); assert.deepEqual(absent.blockers, ['FORM_METADATA_READER_UNAVAILABLE']);
  const wrong = await resolveStandardForm({ ...args, loadMetadata: async () => ({ ...f.metadata,
    snapshot: { ...f.metadata.snapshot, organizationId: '00D000000000002AAA' } }) });
  assert.deepEqual(wrong.blockers, ['FORM_METADATA_SCOPE_MISMATCH']);
  const failed = await resolveStandardForm({ ...args, loadMetadata: async () => { throw new Error('sensitive error detail'); } });
  assert.deepEqual(failed.blockers, ['FORM_CONTEXT_READ_FAILED']);
  const expired = await resolveStandardForm({ ...args, loadMetadata: async () => f.metadata, deadline: performance.now() - 1 });
  assert.deepEqual(expired.blockers, ['UI_CONTEXT_READ_TIMEOUT']);
});

test('draft FLS is action-specific and no unknown object field is sent as fact', async () => {
  const f = await fixture();
  const args = { ...f, connection: f.legacy.connection, loadMetadata: async () => f.metadata };
  await assert.rejects(resolveStandardForm({ ...args, input: { objectApiName: 'Sample__c', action: 'CREATE', draftFields: { NoFls__c: 'bad' } } }),
    /not writable/u);
  await assert.rejects(resolveStandardForm({ ...args, input: { objectApiName: 'Sample__c', action: 'CREATE', draftFields: { RecordTypeId: RT } } }),
    /not writable/u);
});

test('generated API-required facts do not become user-input obligations in either standard form', async () => {
  const f = await fixture();
  f.objectInfo.fields.Name!.autoNumber = true;
  f.objectInfo.fields.Name!.required = true;
  f.objectInfo.fields.Name!.createable = false;
  const facts = { ...f.facts, defaults: {} };
  const input = { objectApiName: 'Sample__c', action: 'CREATE' as const };
  const dynamic = evaluateStandardForm({ ...f, facts, input });
  assert.equal(dynamic.fields.find((field) => field.apiName === 'Name')?.apiRequired, true);
  assert.equal(dynamic.fieldStates.find((field) => field.apiName === 'Name')?.required, false);
  const layout = evaluateStandardForm({ ...f, facts, page: undefined, input });
  assert.equal(layout.fieldStates.find((field) => field.apiName === 'Name')?.required, false);
});

test('saved values remain separate from an identical or changed draft', async () => {
  const f = await fixture();
  const result = evaluateStandardForm({ ...f, input: { objectApiName: 'Sample__c', action: 'UPDATE', draftFields: { Name: 'new', Type__c: 'Other' } },
    savedValues: { Name: 'old', Type__c: 'Other', ApiRequired__c: 'stored' } });
  assert.equal(result.savedValues.Name, 'old');
  assert.equal(result.currentValues.Name, 'new');
  assert.equal(result.savedValues.Type__c, result.currentValues.Type__c);
});

test('required nonwritable fields require known stored/default evidence and retain booleanFilter in audit', async () => {
  const f = await fixture();
  f.objectInfo.fields.ApiRequired__c!.createable = false;
  const conditional = f.page.fields.find((field) => field.apiName === 'Discount__c')!;
  conditional.rules[0]!.rule.booleanFilter = '1';
  const unresolved = evaluateStandardForm({ ...f, input: { objectApiName: 'Sample__c', action: 'CREATE' } });
  assert.ok(unresolved.blockers.includes('REQUIRED_VALUE_UNWRITABLE:ApiRequired__c'));
  assert.equal(unresolved.fieldStates.find((field) => field.apiName === 'ApiRequired__c')?.required, true);
  assert.match(JSON.stringify(unresolved.rules), /"booleanFilter":"1"/u);
  const supplied = evaluateStandardForm({ ...f, facts: { ...f.facts, defaults: { ...f.facts.defaults, ApiRequired__c: { value: 'default' } } },
    input: { objectApiName: 'Sample__c', action: 'CREATE' } });
  assert.ok(!supplied.blockers.includes('REQUIRED_VALUE_UNWRITABLE:ApiRequired__c'));
});

test('USER Describe proves generated fields only when needed and never widens FLS', async () => {
  const f = await fixture();
  let calls = 0;
  const connection = { sobject: () => ({ describe: async () => { calls++; return { name: 'Sample__c', fields: [
    { name: 'ApiRequired__c', autoNumber: true, calculated: false, defaultedOnCreate: true, createable: true },
  ] }; } }) } as unknown as Connection;
  assert.equal((await resolveGeneratedFieldFacts(connection, f.objectInfo, 'CREATE')).apiCallCount, 0);
  f.objectInfo.fields.ApiRequired__c!.createable = false;
  const enriched = await resolveGeneratedFieldFacts(connection, f.objectInfo, 'CREATE');
  assert.equal(enriched.objectInfo.fields.ApiRequired__c?.autoNumber, true);
  assert.equal(enriched.objectInfo.fields.ApiRequired__c?.createable, false);
  assert.equal(calls, 1);
  assert.equal(f.objectInfo.fields.ApiRequired__c?.autoNumber, undefined);
  const failed = await resolveGeneratedFieldFacts({} as Connection, f.objectInfo, 'CREATE');
  assert.equal(failed.evidence.status, 'UNKNOWN');
  assert.equal(failed.objectInfo.fields.ApiRequired__c?.autoNumber, undefined);
});

test('USER Describe proves default-on-create only for absent CREATE obligations without inventing initial facts', async () => {
  const f = await fixture(); let calls = 0;
  const connection = { sobject: () => ({ describe: async () => { calls++; return { name: 'Sample__c', fields: [
    { name: 'ApiRequired__c', autoNumber: false, calculated: false, defaultedOnCreate: true, defaultValue: false },
  ] }; } }) } as unknown as Connection;
  const result = await resolveGeneratedFieldFacts(connection, f.objectInfo, 'CREATE', performance.now() + 1000,
    { createDefaults: f.facts.defaults });
  assert.equal(result.objectInfo.fields.ApiRequired__c?.salesforceDefaultedOnCreate, true);
  assert.equal(result.objectInfo.fields.ApiRequired__c?.autoNumber, false);
  assert.equal(result.objectInfo.fields.ApiRequired__c?.defaultValue, undefined);
  assert.equal(calls, 1);
  for (const value of [null, '']) {
    await resolveGeneratedFieldFacts(connection, f.objectInfo, 'CREATE', performance.now() + 1000,
      { createDefaults: f.facts.defaults, draftFields: { ApiRequired__c: value } });
    await resolveGeneratedFieldFacts(connection, f.objectInfo, 'CREATE', performance.now() + 1000,
      { createDefaults: { ...f.facts.defaults, ApiRequired__c: { value } } });
  }
  await resolveGeneratedFieldFacts(connection, f.objectInfo, 'UPDATE', performance.now() + 1000, { createDefaults: {} });
  assert.equal(calls, 1);
});

test('an omitted API-only CREATE requirement may use a proved save default without becoming a visibility value', async () => {
  const f = await fixture(); f.objectInfo.fields.ApiRequired__c!.salesforceDefaultedOnCreate = true;
  const input = { objectApiName: 'Sample__c', action: 'CREATE' as const };
  const result = evaluateStandardForm({ ...f, input });
  const state = result.fieldStates.find((field) => field.apiName === 'ApiRequired__c')!;
  assert.equal(state.required, true); assert.equal(state.valueState, 'DEFAULT_ON_WRITE');
  assert.equal(state.source, 'SALESFORCE_DEFAULT_ON_WRITE');
  assert.equal(Object.hasOwn(result.currentValues, 'ApiRequired__c'), false);
  const layout = evaluateStandardForm({ ...f, page: undefined, input });
  assert.equal(layout.fieldStates.find((field) => field.apiName === 'ApiRequired__c')?.valueState, 'DEFAULT_ON_WRITE');
  f.page.fields.find((field) => field.apiName === 'Discount__c')!.rules = [{ scope: 'FIELD', rule: rule('Record.ApiRequired__c', 'EQUAL', 'X') }];
  const dependent = evaluateStandardForm({ ...f, input });
  assert.ok(dependent.blockers.includes('REQUIREDNESS_UNRESOLVED:Discount__c'));
});

test('save defaults cannot satisfy explicit clearing, Edit emptiness, or visible and potential UI requirements', async () => {
  const f = await fixture(); f.objectInfo.fields.ApiRequired__c!.salesforceDefaultedOnCreate = true;
  for (const value of [null, '']) {
    const result = evaluateStandardForm({ ...f, input: { objectApiName: 'Sample__c', action: 'CREATE', draftFields: { ApiRequired__c: value } } });
    assert.equal(result.fieldStates.find((field) => field.apiName === 'ApiRequired__c')?.valueState, 'EMPTY');
  }
  const edited = evaluateStandardForm({ ...f, savedValues: { ApiRequired__c: null }, input: { objectApiName: 'Sample__c', action: 'UPDATE' } });
  assert.equal(edited.fieldStates.find((field) => field.apiName === 'ApiRequired__c')?.valueState, 'EMPTY');
  const instance = { ...f.page.fields[0]!, apiName: 'ApiRequired__c', required: true, rules: [] };
  f.page.fields.push(instance);
  const visible = evaluateStandardForm({ ...f, input: { objectApiName: 'Sample__c', action: 'CREATE' } });
  assert.equal(visible.fieldStates.find((field) => field.apiName === 'ApiRequired__c')?.valueState, 'ABSENT');
  instance.rules = [{ scope: 'FIELD', rule: rule('Record.Owner.ManagerId') }] as typeof instance.rules;
  const potential = evaluateStandardForm({ ...f, input: { objectApiName: 'Sample__c', action: 'CREATE' } });
  assert.equal(potential.fieldStates.find((field) => field.apiName === 'ApiRequired__c')?.valueState, 'ABSENT');
});

test('readonly compound names are computed aggregates, not an additional required user value', async () => {
  const f = await fixture();
  Object.assign(f.objectInfo.fields.Name!, { compound: true, required: true, createable: false, updateable: false });
  const result = evaluateStandardForm({ ...f, facts: { ...f.facts, defaults: {} }, input: { objectApiName: 'Sample__c', action: 'CREATE' } });
  assert.equal(result.fieldStates.find((field) => field.apiName === 'Name')?.required, false);
});

test('multiple current-record chunks require a coherent revision, while Master permits null type', async () => {
  const recordId = 'a00000000000001AAA';
  const fields = Array.from({ length: 101 }, (_, index) => `F${index}__c`);
  let index = 0;
  const connection = { getApiVersion: () => '68.0', request: async () => ({ id: recordId, apiName: 'Sample__c', recordTypeId: null,
    lastModifiedDate: index++ === 0 ? '2026-11-06T00:00:00.000Z' : '2026-11-06T00:00:01.000Z', fields: {} }) } as unknown as Connection;
  await assert.rejects(loadPrecisionSavedValues(connection, { objectApiName: 'Sample__c', action: 'UPDATE', recordId },
    '012000000000000AAA', fields, performance.now() + 1000, () => {}), /REVISION_UNRESOLVED/u);
  assert.deepEqual(await loadPrecisionSavedValues(connection, { objectApiName: 'Sample__c', action: 'UPDATE', recordId },
    '012000000000000AAA', ['Name'], performance.now() + 1000, () => {}), {});
});

test('null versus empty-string native comparison stays unknown rather than silently hiding a required field', async () => {
  const f = await fixture();
  f.page.fields.find((field) => field.apiName === 'Discount__c')!.rules = [{ scope: 'FIELD', rule: rule('Record.Type__c', 'EQUAL', '') }];
  const result = evaluateStandardForm({ ...f, input: { objectApiName: 'Sample__c', action: 'CREATE', draftFields: { Type__c: null } } });
  assert.ok(result.blockers.includes('REQUIREDNESS_UNRESOLVED:Discount__c'));
  assert.match(JSON.stringify(result.rules), /UNPROVEN_NULL_EMPTY_SEMANTICS/u);
});

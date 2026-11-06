import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import { buildQuickActionForm, parseQuickActionOutcome, prepareQuickActionRequest,
  resolveQuickActionDescriptor, type QuickActionDescriptor } from '../precision-quick-action.js';
import { objectInfoSchema } from '../ui-api.js';

const RT = '012000000000001AAA';
const ID = '001000000000001AAA';
const CREATED = '003000000000001AAA';
function rawAction(overrides: Record<string, unknown> = {}) {
  return { name: 'Account.NewContact', type: 'Create', contextSobjectType: 'Account', targetSobjectType: 'Contact',
    targetRecordTypeId: RT, targetParentField: 'AccountId', defaultValues: [{ field: 'Level__c', defaultValue: 'FORMULA_NOT_EVALUATED' }],
    layout: { heading: 'Quick create', layoutRows: [{ layoutItems: ['LastName', 'Level__c', 'Optional__c'].map((value) => ({
      required: value === 'Level__c', editableForNew: true, editableForUpdate: true,
      layoutComponents: [{ type: 'Field', value }],
    })) }] }, ...overrides };
}
function mock(raw = rawAction(), defaults: unknown = { Level__c: 'Resolved' }) {
  const urls: string[] = [];
  const connection = { getApiVersion: () => '67.0', request: async ({ url }: { url: string }) => {
    urls.push(url);
    if (url.includes('/ui-api/records/')) return { id: ID, apiName: raw.contextSobjectType, recordTypeId: RT, fields: { Id: { value: ID } } };
    return url.endsWith('/describe') ? raw : defaults;
  } } as unknown as Connection;
  return { connection, urls };
}
const request = { objectApiName: 'Contact', action: 'CREATE' as const, quickActionName: 'Account.NewContact', sourceRecordId: ID };
function info() {
  return objectInfoSchema.parse({ apiName: 'Contact', label: 'Contact', labelPlural: 'Contacts', defaultRecordTypeId: RT,
    recordTypeInfos: { [RT]: { recordTypeId: RT, name: 'Business', available: true, defaultRecordTypeMapping: true } },
    fields: Object.fromEntries(['LastName', 'Level__c', 'Optional__c', 'NewRequired__c', 'AccountId', 'Flag__c', 'Score__c'].map((apiName) => [apiName, {
      apiName, label: apiName, dataType: apiName === 'AccountId' ? 'Reference' : 'String',
      required: ['LastName', 'NewRequired__c'].includes(apiName), createable: true, updateable: true,
      ...(apiName === 'AccountId' ? { referenceToInfos: [{ apiName: 'Account' }] } : {}),
    }])), });
}
async function descriptor(): Promise<QuickActionDescriptor> {
  const fixture = mock();
  const resolution = await resolveQuickActionDescriptor(fixture.connection, request);
  assert.equal(resolution.status, 'RESOLVED');
  assert.ok(resolution.descriptor);
  return resolution.descriptor;
}

test('native action descriptor fixes target Record Type and evaluates defaults for the actual parent', async () => {
  const fixture = mock();
  const result = await resolveQuickActionDescriptor(fixture.connection, request);
  assert.equal(result.descriptor?.targetRecordTypeId, RT);
  assert.deepEqual(result.descriptor?.defaultValues, { Level__c: { value: 'Resolved' } });
  assert.equal(result.apiCallCount, 3);
  assert.deepEqual(fixture.urls, [
    '/services/data/v67.0/sobjects/Account/quickActions/NewContact/describe',
    `/services/data/v67.0/ui-api/records/${ID}?fields=Account.Id`,
    `/services/data/v67.0/sobjects/Account/quickActions/NewContact/defaultValues/${ID}`,
  ]);
});

test('source-less object action and mismatched update context fail before any request', async () => {
  const fixture = mock();
  const noParent = await resolveQuickActionDescriptor(fixture.connection, { ...request, sourceRecordId: undefined });
  assert.equal(noParent.reasons[0], 'QUICK_ACTION_SOURCE_RECORD_REQUIRED');
  const mismatch = await resolveQuickActionDescriptor(fixture.connection, { ...request, action: 'UPDATE', recordId: CREATED });
  assert.equal(mismatch.reasons[0], 'QUICK_ACTION_CONTEXT_MISMATCH');
  assert.equal(fixture.urls.length, 0);
});

test('custom forms, wrong object, wrong Record Type and action replacement never become native contexts', async () => {
  for (const [override, expected] of [
    [{ type: 'Flow' }, 'QUICK_ACTION_TYPE_UNSUPPORTED'],
    [{ targetSobjectType: 'Case' }, 'QUICK_ACTION_TARGET_MISMATCH'],
    [{ name: 'Account.SomeOtherAction' }, 'QUICK_ACTION_NAME_MISMATCH'],
    [{ targetRecordTypeId: '012000000000002AAA' }, 'QUICK_ACTION_RECORD_TYPE_MISMATCH'],
  ] as const) {
    const fixture = mock(rawAction(override));
    const result = await resolveQuickActionDescriptor(fixture.connection, { ...request, recordTypeId: RT });
    assert.equal(result.reasons[0], expected);
    assert.equal(fixture.urls.length, 1);
  }
});

test('missing CREATE action target type cannot be supplied by an explicit or sole non-Master user type', async () => {
  for (const recordTypeId of [undefined, RT]) {
    const fixture = mock(rawAction({ targetRecordTypeId: null }));
    const result = await resolveQuickActionDescriptor(fixture.connection, { ...request, recordTypeId }, info());
    assert.equal(result.status, 'UNRESOLVED');
    assert.deepEqual(result.reasons, ['QUICK_ACTION_RECORD_TYPE_UNRESOLVED']);
    assert.equal(fixture.urls.length, 1, 'reject before parent/default reads or a generic type picker');
  }
});

test('only authoritative Master-only ObjectInfo can resolve an absent CREATE action type', async () => {
  const master = '012000000000000AAA';
  const objectInfo = info();
  objectInfo.defaultRecordTypeId = master;
  objectInfo.recordTypeInfos = { [master]: { recordTypeId: master, name: 'Master', available: true,
    defaultRecordTypeMapping: true, master: true } };
  const fixture = mock(rawAction({ targetRecordTypeId: null }));
  const result = await resolveQuickActionDescriptor(fixture.connection, request, objectInfo);
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.descriptor?.targetRecordTypeId, master);

  const conflict = await resolveQuickActionDescriptor(fixture.connection, { ...request, recordTypeId: RT }, objectInfo);
  assert.deepEqual(conflict.reasons, ['QUICK_ACTION_RECORD_TYPE_MISMATCH']);

  objectInfo.recordTypeInfos[RT] = { recordTypeId: RT, name: 'Unavailable business type', available: false,
    defaultRecordTypeMapping: false };
  const unproven = await resolveQuickActionDescriptor(fixture.connection, request, objectInfo);
  assert.deepEqual(unproven.reasons, ['QUICK_ACTION_RECORD_TYPE_UNRESOLVED'], 'available Master alone is not proof the object is Master-only');
});

test('default API missing values never replays formula text from describe', async () => {
  const fixture = mock(rawAction(), {});
  const result = await resolveQuickActionDescriptor(fixture.connection, request);
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.descriptor?.defaultsResolved, false);
  assert.deepEqual(result.descriptor?.defaultValues, {});
  const form = buildQuickActionForm({ descriptor: result.descriptor!, objectInfo: info() });
  assert.ok(form.unknownRequired.includes('Level__c'));
  assert.equal(form.values.Level__c, undefined);
});

test('unresolved optional defaults do not block an otherwise complete required-field assessment', async () => {
  const f = mock(rawAction({ defaultValues: [{ field: 'Optional__c', defaultValue: 'FORMULA' }] }), {});
  const resolution = await resolveQuickActionDescriptor(f.connection, request);
  const form = buildQuickActionForm({ descriptor: resolution.descriptor!, objectInfo: info(),
    draftFields: { LastName: 'Provided', Level__c: 'Provided', NewRequired__c: 'Provided' } });
  assert.deepEqual(form.unknownRequired, []);
  assert.deepEqual(form.blockers, []);
});

test('one oversized optional preset does not discard independently resolved required presets', async () => {
  const f = mock(rawAction({ defaultValues: [{ field: 'Level__c' }, { field: 'Optional__c' }] }),
    { Level__c: 'Known required preset', Optional__c: 'x'.repeat(4097) });
  const resolution = await resolveQuickActionDescriptor(f.connection, request);
  assert.equal(resolution.descriptor?.defaultsResolved, false);
  const form = buildQuickActionForm({ descriptor: resolution.descriptor!, objectInfo: info(),
    draftFields: { LastName: 'Provided', NewRequired__c: 'Provided' } });
  assert.equal(form.values.Level__c, 'Known required preset');
  assert.equal(form.values.Optional__c, undefined);
  assert.equal(form.facts.find((field) => field.apiName === 'Optional__c')?.source, 'UNKNOWN');
  assert.deepEqual(form.unknownRequired, []);
  assert.deepEqual(form.missingRequired, []);
});

test('native action requiredness unions current API fields and gives action defaults precedence', async () => {
  const form = buildQuickActionForm({ descriptor: await descriptor(), objectInfo: info(),
    createDefaults: { Level__c: { value: 'Object default' }, LastName: { value: 'Default surname' } },
    draftFields: { LastName: '', Flag__c: false, Score__c: 0 }, });
  assert.equal(form.values.Level__c, 'Resolved');
  assert.equal(form.values.AccountId, ID);
  assert.equal(form.values.LastName, '');
  assert.equal(form.values.Flag__c, false);
  assert.equal(form.values.Score__c, 0);
  assert.deepEqual(form.missingRequired.sort(), ['LastName', 'NewRequired__c']);
  assert.deepEqual(form.fields.find((field) => field.apiName === 'Level__c')?.requiredSource, ['QUICK_ACTION']);
  assert.deepEqual(form.fields.find((field) => field.apiName === 'NewRequired__c')?.requiredSource, ['API']);
  assert.equal(form.fields.find((field) => field.apiName === 'Optional__c')?.optionalCandidate, true);
  assert.equal(form.fields.some((field) => field.apiName === 'AccountId'), false, 'default provenance can include non-layout relationship');
});

test('parent binding conflict and non-writable draft fail without silently replacing the submitted intent', async () => {
  const objectInfo = info();
  objectInfo.fields.Optional__c!.createable = false;
  const form = buildQuickActionForm({ descriptor: await descriptor(), objectInfo,
    draftFields: { AccountId: '001000000000002AAA', Optional__c: 'forbidden' } });
  assert.ok(form.blockers.includes('QUICK_ACTION_PARENT_CONTEXT_CONFLICT'));
  assert.ok(form.blockers.includes('QUICK_ACTION_DRAFT_FIELD_NOT_WRITABLE:Optional__c'));
  assert.equal(form.fields.find((field) => field.apiName === 'Optional__c')?.optionalCandidate, false);
});

test('required non-writable fields need server-generation evidence and are never silently waived', async () => {
  const objectInfo = info();
  objectInfo.fields.NewRequired__c!.createable = false;
  const action = await descriptor();
  const unproven = buildQuickActionForm({ descriptor: action, objectInfo });
  assert.ok(unproven.unknownRequired.includes('NewRequired__c'));
  objectInfo.fields.NewRequired__c!.autoNumber = true;
  const proven = buildQuickActionForm({ descriptor: action, objectInfo });
  assert.equal(proven.unknownRequired.includes('NewRequired__c'), false);
  assert.equal(proven.fields.find((field) => field.apiName === 'NewRequired__c')?.effectiveRequired, false);
});

test('proven insert-time defaults satisfy absent API-only obligations without inventing form or submitted values', async () => {
  const objectInfo = info();
  Object.assign(objectInfo.fields.NewRequired__c!, { dataType: 'Boolean', salesforceDefaultedOnCreate: true });
  const action = await descriptor();
  const form = buildQuickActionForm({ descriptor: action, objectInfo });
  assert.equal(form.missingRequired.includes('NewRequired__c'), false);
  assert.equal(form.unknownRequired.includes('NewRequired__c'), false);
  assert.equal(form.fields.find((field) => field.apiName === 'NewRequired__c')?.effectiveRequired, true);
  assert.deepEqual(form.facts.find((field) => field.apiName === 'NewRequired__c'),
    { apiName: 'NewRequired__c', valuePresent: false, source: 'SALESFORCE_DEFAULT_ON_WRITE' });
  assert.equal(Object.hasOwn(form.values, 'NewRequired__c'), false);

  for (const value of [null, '']) {
    const cleared = buildQuickActionForm({ descriptor: action, objectInfo, draftFields: { NewRequired__c: value } });
    assert.ok(cleared.missingRequired.includes('NewRequired__c'));
    assert.equal(cleared.facts.find((field) => field.apiName === 'NewRequired__c')?.source, 'DRAFT');
  }
  const update = buildQuickActionForm({ descriptor: { ...action, action: 'UPDATE' }, objectInfo });
  assert.ok(update.unknownRequired.includes('NewRequired__c'));
});

test('server insert default never waives an action-layout requirement or an unresolved action preset', async () => {
  const objectInfo = info();
  Object.assign(objectInfo.fields.NewRequired__c!, { salesforceDefaultedOnCreate: true });
  const action = await descriptor();
  const layout = structuredClone(action.layout);
  layout.sections[0]!.layoutRows[0]!.layoutItems.push({ required: true, editableForNew: true, editableForUpdate: true,
    layoutComponents: [{ componentType: 'Field', apiName: 'NewRequired__c' }] });
  const requiredByAction = buildQuickActionForm({ descriptor: { ...action, layout }, objectInfo });
  assert.ok(requiredByAction.missingRequired.includes('NewRequired__c'));
  const unknownPreset = buildQuickActionForm({ descriptor: { ...action, defaultsResolved: false,
    defaultFieldNames: [...action.defaultFieldNames, 'NewRequired__c'] }, objectInfo });
  assert.ok(unknownPreset.unknownRequired.includes('NewRequired__c'));
  assert.equal(unknownPreset.facts.find((field) => field.apiName === 'NewRequired__c')?.source, 'UNKNOWN');
});

test('UPDATE uses historical values plus patch and never object Create Defaults', async () => {
  const action = { ...await descriptor(), action: 'UPDATE' as const, targetParentField: null,
    targetObjectApiName: 'Contact', contextObjectApiName: 'Contact', contextId: CREATED, defaultValues: {} };
  const form = buildQuickActionForm({ descriptor: action, objectInfo: info(),
    currentValues: { LastName: 'Saved', Level__c: null, NewRequired__c: 'Saved required' },
    createDefaults: { Level__c: { value: 'Should never fill an edit' } },
    draftFields: { Optional__c: 'change' }, });
  assert.equal(form.values.LastName, 'Saved');
  assert.equal(form.values.Level__c, null);
  assert.deepEqual(form.missingRequired, ['Level__c']);
  assert.deepEqual(form.unknownRequired, []);
  const unknown = buildQuickActionForm({ descriptor: action, objectInfo: info(), currentValues: { LastName: 'Saved' } });
  assert.ok(unknown.unknownRequired.includes('NewRequired__c'));
});

test('global native action uses global route without fabricating a source record', async () => {
  const fixture = mock(rawAction({ name: 'Global.NewContact', contextSobjectType: null, targetParentField: null }));
  const result = await resolveQuickActionDescriptor(fixture.connection, { ...request, quickActionName: 'Global.NewContact', sourceRecordId: undefined });
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.descriptor?.contextId, null);
  assert.equal(fixture.urls[0], '/services/data/v67.0/quickActions/NewContact/describe');
});

test('unsafe action identifiers reject before dispatch', async () => {
  const fixture = mock();
  await assert.rejects(resolveQuickActionDescriptor(fixture.connection, { ...request, quickActionName: 'Account.New/../Contact' }));
  assert.equal(fixture.urls.length, 0);
});

test('pure native request preparation and strict outcome parsing preserve unknown writes', async () => {
  const action = await descriptor();
  assert.throws(() => prepareQuickActionRequest({ ...action, targetRecordTypeId: null }, { LastName: 'User value' }),
    /QUICK_ACTION_RECORD_TYPE_UNRESOLVED/u);
  const prepared = prepareQuickActionRequest(action, { LastName: 'User value' });
  assert.equal(prepared.url, '/services/data/v67.0/sobjects/Account/quickActions/NewContact');
  assert.deepEqual(prepared.body, { contextId: ID, record: { LastName: 'User value' } });
  assert.deepEqual(parseQuickActionOutcome({ success: true, created: true, id: CREATED, contextId: ID, errors: [] }, action),
    { status: 'SUCCESS', recordId: CREATED, errors: [] });
  assert.equal(parseQuickActionOutcome({ success: true, errors: [] }, action).status, 'UNKNOWN');
  assert.equal(parseQuickActionOutcome({ success: true, created: false, id: CREATED, errors: [] }, action).status, 'UNKNOWN');
  assert.equal(parseQuickActionOutcome({ success: false, errors: [{ statusCode: 'REQUIRED_FIELD_MISSING', message: 'Required', fields: ['LastName'] }] }, action).status, 'FAILED');
  assert.equal(parseQuickActionOutcome({ success: false, errors: [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required' }] }, action).status, 'FAILED');
  assert.equal(parseQuickActionOutcome({ success: false, created: true, errors: [{ errorCode: 'UNKNOWN_EXCEPTION', message: 'After create' }] }, action).status, 'UNKNOWN');
  assert.equal(parseQuickActionOutcome({ success: true, created: true, id: CREATED, ids: ['003000000000099AAA'], errors: [] }, action).status, 'UNKNOWN');
  assert.equal(parseQuickActionOutcome({ success: false, errors: [] }, action).status, 'UNKNOWN');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import { ContextRuntimeError } from '../errors.js';
import { RecordActionContextExecutor } from '../record-action-executor.js';
import { recordActionContextInputSchema, recordActionContextOutputSchema } from '../schemas.js';
import type { ObjectInfo } from '../ui-api.js';

const RT = '012000000000001AAA';
const ACTION_RT = '012000000000002AAA';
const PARENT = '001000000000001AAA';
const RECORD = '003000000000001AAA';

function fixture(action: 'CREATE' | 'UPDATE' = 'CREATE', global = false) {
  const calls: string[] = [];
  const defaults: Record<string, unknown> = { Reason__c: 'Action preset', Status__c: 'Closed' };
  const stored: Record<string, unknown> = { LastName: 'Stored', Reason__c: '', Status__c: 'Open', Mandatory__c: 'Present', Untouched__c: 'Keep' };
  const fields = Object.fromEntries(['LastName', 'Reason__c', 'Status__c', 'Mandatory__c', 'Untouched__c', 'AccountId'].map((apiName) => [apiName, {
    apiName, label: apiName, dataType: apiName === 'AccountId' ? 'Reference' : 'String', required: apiName === 'LastName',
    createable: true, updateable: true,
    ...(apiName === 'AccountId' ? { relationshipName: 'Account', referenceToInfos: [{ apiName: 'Account' }] } : {}),
  }]));
  const layoutNames = ['LastName', 'Reason__c', 'Mandatory__c', 'Status__c'];
  const quickActionName = global ? 'Global.NewContact' : action === 'CREATE' ? 'Account.NewContact' : 'Contact.CloseContact';
  const rawAction = { name: quickActionName, type: action === 'CREATE' ? 'Create' : 'Update',
    contextSobjectType: global ? null : action === 'CREATE' ? 'Account' : 'Contact', targetSobjectType: 'Contact',
    targetRecordTypeId: ACTION_RT as string | null, targetParentField: action === 'CREATE' && !global ? 'AccountId' : null,
    defaultValues: [{ field: 'Reason__c', defaultValue: 'Formula not evaluated' }, { field: 'Status__c', defaultValue: 'Closed' }],
    layout: { heading: 'Quick action', layoutRows: [{ layoutItems: layoutNames.map((value) => ({
      editableForNew: true, editableForUpdate: true, required: value !== 'Status__c',
      layoutComponents: [{ type: 'Field', value }],
    })) }] } };
  const baselineLayout = { id: '00h000000000001AAA', sections: [{ heading: 'Unrelated layout', layoutRows: [{ layoutItems: [{
    required: true, editableForNew: true, editableForUpdate: true, layoutComponents: [{ componentType: 'Field', apiName: 'Untouched__c' }],
  }] }] }] };
  const objectInfo: ObjectInfo = { apiName: 'Contact', label: 'Contact', labelPlural: 'Contacts',
    createable: true, updateable: true, fields, defaultRecordTypeId: RT, recordTypeInfos: {
      [RT]: { recordTypeId: RT, name: 'Default type', available: true, defaultRecordTypeMapping: true },
      [ACTION_RT]: { recordTypeId: ACTION_RT, name: 'Action type', available: true, defaultRecordTypeMapping: false },
    } };
  let returnedRecordId = RECORD;
  const connection = { getApiVersion: () => '67.0', request: async ({ method, url }: { method: string; url: string }) => {
    assert.equal(method, 'GET', 'context must remain read-only'); calls.push(url);
    if (url.endsWith('/describe')) return rawAction;
    if (url.includes('/quickActions/') && url.includes('/defaultValues')) return defaults;
    if (url.includes('/picklist-values/')) return { picklistFieldValues: {} };
    if (url.includes('/object-info/')) return objectInfo;
    if (url.includes('/record-defaults/create/')) return { layout: baselineLayout,
      record: { apiName: 'Contact', recordTypeId: new URL(url, 'https://example.test').searchParams.get('recordTypeId'),
        fields: { LastName: { value: 'Object default' }, Mandatory__c: { value: 'Create default' }, Untouched__c: { value: 'Off-action default' } } } };
    if (url.includes('/layout/')) return baselineLayout;
    if (url.includes('/ui-api/actions/record/')) return { actions: { [RECORD]: { actions: [
      { apiName: 'Contact.CloseContact', label: '关闭联系', type: 'QuickAction', subtype: 'Update',
        targetObject: 'Contact', actionTargetType: 'Describe', section: 'Page' },
      { apiName: 'Contact.Add_Child', label: '添加子项', type: 'QuickAction', subtype: 'Create',
        targetObject: 'Child__c', actionTargetType: 'Describe', section: 'Page' },
      { apiName: 'Edit', label: '编辑', type: 'StandardButton', subtype: 'ScreenAction',
        targetObject: 'Contact', actionTargetType: 'Invoke', section: 'Page' },
    ] } } };
    if (url.includes(`/records/${PARENT}`)) return { id: PARENT, apiName: 'Account', recordTypeId: RT, fields: { Id: { value: PARENT } } };
    if (url.includes(`/records/${RECORD}`)) return { id: returnedRecordId, apiName: 'Contact', recordTypeId: ACTION_RT,
      fields: Object.fromEntries(Object.entries(stored).map(([name, value]) => [name, { value }])) };
    throw new Error('Unexpected fixture API');
  } } as unknown as Connection;
  const org = { getAllowedOrgUsernames: async () => new Set(['user@example.test']), getConnection: async () => connection } as unknown as OrgService;
  const input = recordActionContextInputSchema.parse({ objectApiName: 'Contact', action,
    ...(action === 'UPDATE' ? { recordId: RECORD } : {}),
    formContext: { entry: 'QUICK_ACTION', quickActionName, ...(action === 'CREATE' && !global ? { sourceRecordId: PARENT } : {}) },
  });
  const executor = new RecordActionContextExecutor(org, undefined, { loadMetadata: async () => { throw new Error('QA must not read Lightning metadata'); } });
  return { executor, input, calls, defaults, stored, rawAction, objectInfo, changeReturnedRecord(value: string) { returnedRecordId = value; } };
}

test('precise Quick Action selects its fixed Record Type before generic multiple-type choice and obeys strict output schema', async () => {
  const f = fixture();
  const result = await f.executor.executeWithForm({ ...f.input, draftFields: { LastName: 'Explicit' } });
  assert.equal(result.output.recordType?.id, ACTION_RT);
  assert.equal(result.output.recordTypeSelectionRequired, false);
  assert.equal(result.output.formContext?.status, 'READY');
  assert.equal(result.output.coverage?.requirednessSource, 'QUICK_ACTION_REQUIRED');
  assert.equal(result.output.requiredChecklist?.some((field) => field.apiName === 'Untouched__c'), false);
  assert.ok(recordActionContextOutputSchema.safeParse(result.output).success);
  assert.deepEqual(result.prepared?.fields, { LastName: 'Explicit' });
  assert.equal(result.prepared?.quickAction?.contextId, PARENT);
  assert.equal(f.calls.some((url) => url.includes('/apps')), false);
});

test('global action resolves the same form without inventing a parent or a Lightning page', async () => {
  const f = fixture('CREATE', true);
  const result = await f.executor.executeWithForm(f.input);
  assert.equal(result.output.formContext?.status, 'READY');
  assert.equal(result.prepared?.quickAction?.contextId, null);
  assert.equal(result.output.formContext?.page, null);
  assert.ok(f.calls.includes('/services/data/v67.0/quickActions/NewContact/describe'));
  assert.ok(recordActionContextOutputSchema.safeParse(result.output).success);
});

test('Quick Action readiness needs explicit current USER object permission for the requested operation', async () => {
  for (const action of ['CREATE', 'UPDATE'] as const) {
    for (const permission of [undefined, 'true', false]) {
      const f = fixture(action);
      f.objectInfo[action === 'CREATE' ? 'createable' : 'updateable'] = permission;
      const result = await f.executor.execute(f.input);
      assert.equal(result.formContext?.status, 'UNKNOWN');
      assert.ok(result.formContext?.criticalUnknown.includes(permission === false
        ? 'QUICK_ACTION_OBJECT_ACCESS_DENIED' : 'OBJECT_ACCESS_UNRESOLVED'));
      assert.ok(recordActionContextOutputSchema.safeParse(result).success);
    }
  }
});

test('explicit conflicting type rejects before defaults and never silently switches to the action target type', async () => {
  const f = fixture();
  await assert.rejects(f.executor.execute({ ...f.input, recordTypeId: RT }), (error: unknown) => {
    assert.ok(error instanceof ContextRuntimeError);
    assert.equal(error.code, 'MCP_RECORD_ACTION_CONTEXT_UNSUPPORTED');
    assert.match(error.message, /QUICK_ACTION_RECORD_TYPE_MISMATCH/u);
    return true;
  });
  assert.equal(f.calls.some((url) => url.includes('/record-defaults/create/')), false);
});

test('an unresolved Quick Action rejects before offering unrelated available Record Types', async () => {
  const f = fixture(); f.rawAction.type = 'Flow';
  await assert.rejects(f.executor.execute(f.input), (error: unknown) => {
    assert.ok(error instanceof ContextRuntimeError);
    assert.equal(error.code, 'MCP_RECORD_ACTION_CONTEXT_UNSUPPORTED');
    assert.match(error.message, /QUICK_ACTION_TYPE_UNSUPPORTED/u);
    assert.match(error.message, /do not select a standard form or ask for its Record Type as a fallback/u);
    return true;
  });
  assert.equal(f.calls.some((url) => url.includes('/record-defaults/create/')), false);
});

test('a missing action target type rejects both generic selection and explicit type B before Create Defaults', async () => {
  for (const recordTypeId of [undefined, ACTION_RT]) {
    const f = fixture('CREATE', true); f.rawAction.targetRecordTypeId = null;
    await assert.rejects(f.executor.execute({ ...f.input, ...(recordTypeId ? { recordTypeId } : {}) }), (error: unknown) => {
      assert.ok(error instanceof ContextRuntimeError);
      assert.equal(error.code, 'MCP_RECORD_ACTION_CONTEXT_UNSUPPORTED');
      assert.match(error.message, /QUICK_ACTION_RECORD_TYPE_UNRESOLVED/u);
      return true;
    });
    assert.equal(f.calls.some((url) => url.includes('/record-defaults/create/') || url.includes('/defaultValues')), false);
  }
});

test('an action with absent target type uses Master only when current ObjectInfo proves Master-only', async () => {
  const f = fixture('CREATE', true); f.rawAction.targetRecordTypeId = null;
  const master = '012000000000000AAA';
  f.objectInfo.defaultRecordTypeId = master;
  f.objectInfo.recordTypeInfos = { [master]: { recordTypeId: master, name: 'Master', available: true, defaultRecordTypeMapping: true } };
  const result = await f.executor.executeWithForm(f.input);
  assert.equal(result.output.formContext?.status, 'READY');
  assert.equal(result.output.recordType?.id, master);
  assert.equal(result.prepared?.quickAction?.targetRecordTypeId, master);
  assert.ok(f.calls.some((url) => url.includes('/record-defaults/create/') && url.includes(master)));
  assert.ok(recordActionContextOutputSchema.safeParse(result.output).success);
});

test('Quick Action UPDATE checks historically empty mandatory fields and never applies Create Defaults', async () => {
  const f = fixture('UPDATE'); f.stored.Mandatory__c = '';
  const output = await f.executor.execute({ ...f.input, draftFields: { LastName: 'Changed' } });
  assert.equal(output.formContext?.status, 'NEEDS_INPUT');
  assert.deepEqual(output.formContext?.missingRequired, ['Mandatory__c']);
  assert.equal(f.calls.some((url) => url.includes('/record-defaults/create/')), false);
  assert.ok(recordActionContextOutputSchema.safeParse(output).success);
});

test('Quick Action UPDATE must retain explicit same-as-stored overrides of conflicting action presets', async () => {
  const f = fixture('UPDATE');
  const result = await f.executor.executeWithForm({ ...f.input, draftFields: { Status__c: 'Open' } });
  assert.equal(result.output.formContext?.status, 'READY');
  assert.deepEqual(result.prepared?.fields, { Status__c: 'Open' });
  assert.equal(result.output.formContext?.fields.find((field) => field.apiName === 'Status__c')?.valueSource, 'CLIENT_DRAFT');
});

test('missing required preset evaluation is UNKNOWN while known optional preset gaps do not block', async () => {
  const f = fixture(); delete f.defaults.Reason__c;
  const missing = await f.executor.execute(f.input);
  assert.equal(missing.formContext?.status, 'UNKNOWN');
  assert.ok(missing.formContext?.criticalUnknown.includes('REQUIRED_VALUE_UNRESOLVED:Reason__c'));
  assert.equal(missing.formContext?.fields.find((field) => field.apiName === 'Reason__c')?.valueState, 'UNKNOWN');
  const supplied = await f.executor.execute({ ...f.input, draftFields: { Reason__c: 'Explicit' } });
  assert.equal(supplied.formContext?.status, 'READY');
});

test('Quick Action reports a proven server insert default without copying an invented value into the native request', async () => {
  const f = fixture();
  f.objectInfo.fields.ServerDefault__c = { apiName: 'ServerDefault__c', label: 'Server default', dataType: 'Boolean',
    required: true, createable: true, updateable: true, salesforceDefaultedOnCreate: true };
  const result = await f.executor.executeWithForm({ ...f.input, draftFields: { LastName: 'Requested' } });
  assert.equal(result.output.formContext?.status, 'READY');
  const assessment = result.output.formContext?.fields.find((field) => field.apiName === 'ServerDefault__c');
  assert.equal(assessment?.required, true);
  assert.equal(assessment?.valueState, 'DEFAULT_ON_WRITE');
  assert.equal(assessment?.valueSource, 'SALESFORCE_DEFAULT_ON_WRITE');
  assert.deepEqual(result.prepared?.fields, { LastName: 'Requested' });
  assert.ok(recordActionContextOutputSchema.safeParse(result.output).success);
});

test('source-record identity mismatch prevents using another record as Quick Action context', async () => {
  const f = fixture('UPDATE'); f.changeReturnedRecord('003000000000099AAA');
  await assert.rejects(f.executor.execute(f.input), (error: unknown) => {
    assert.ok(error instanceof ContextRuntimeError);
    assert.equal(error.code, 'MCP_RECORD_ACTION_CONTEXT_UNSUPPORTED');
    assert.match(error.message, /QUICK_ACTION_SOURCE_RECORD_MISMATCH/u);
    return true;
  });
  assert.equal(f.calls.some((url) => url.includes('/record-defaults/create/') || url.includes('/layout/')), false);
});

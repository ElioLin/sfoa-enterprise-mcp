import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextRuntimeError } from '../errors.js';
import { RecordActionContextExecutor } from '../record-action-executor.js';
import { recordActionContextOutputSchema, type RecordActionContextInput } from '../schemas.js';
import type { PrecisionFormOptions } from '../precision-executor.js';
import { fixtureSnapshot, rule, runtimeFixture } from './effective-ui-fixtures.js';

function fixture(strategy: 'PLATFORM_USER_LOOKUP' | 'PLATFORM_USER_LOOKUP_FALLBACK' = 'PLATFORM_USER_LOOKUP') {
  const snapshot = fixtureSnapshot();
  snapshot.pages[0]!.fields = snapshot.pages[0]!.fields.filter((field) => field.apiName !== 'Unknown__c');
  const f = runtimeFixture('OFF', snapshot);
  Object.assign(f.objectCrud, { createable: true, updateable: true });
  f.fields.Managed__c!.required = true;
  const options: PrecisionFormOptions = { managedFields: [{ objectApiName: 'Sample__c', targetFieldApiName: 'Managed__c',
    enabled: true, applyOnCreate: true, applyOnUpdate: false, strategy }],
    loadMetadata: async () => ({ snapshot, appDeveloperName: 'App_A', appSource: 'PROFILE_DEFAULT',
      verifiedAt: new Date().toISOString(), apiCallCount: 1, evidence: {} }) };
  const input: RecordActionContextInput = { objectApiName: 'Sample__c', action: 'CREATE',
    draftFields: { Type__c: 'Other', ApiRequired__c: 'Known' }, formContext: { entry: 'STANDARD', phase: 'START' } };
  return { f, snapshot, options, input, executor: new RecordActionContextExecutor(f.org, undefined, options) };
}

test('planned managed policy is distinguished from a real initial value and actual submission injection', async () => {
  const f = fixture();
  const initial = await f.executor.execute(f.input);
  assert.equal(initial.formContext?.status, 'READY');
  assert.equal(initial.formContext?.fields.find((field) => field.apiName === 'Managed__c')?.valueState, 'MANAGED_ON_WRITE');
  assert.ok(recordActionContextOutputSchema.safeParse(initial).success);
  const submission = await f.executor.executeWithForm({ ...f.input, formContext: { entry: 'STANDARD', phase: 'SUBMIT' } },
    { Managed__c: 'observed-runtime-value' });
  assert.equal(submission.output.formContext?.status, 'READY');
  assert.equal(submission.output.formContext?.fields.find((field) => field.apiName === 'Managed__c')?.valueSource, 'RUNTIME_MANAGED');
  assert.equal(submission.prepared?.fields.Managed__c, 'observed-runtime-value');
  const absent = await f.executor.executeWithForm({ ...f.input, formContext: { entry: 'STANDARD', phase: 'SUBMIT' } }, {});
  assert.equal(absent.output.formContext?.status, 'NEEDS_INPUT');
});

test('standard form cannot treat omitted object CRUD as permission or waive an explicit denial', async () => {
  const f = fixture();
  delete f.f.objectCrud.createable;
  const result = await f.executor.execute(f.input);
  assert.equal(result.formContext?.status, 'UNKNOWN');
  assert.ok(result.formContext?.criticalUnknown.includes('OBJECT_ACCESS_UNRESOLVED'));
  f.f.objectCrud.createable = false;
  await assert.rejects(f.executor.execute(f.input), (error: unknown) => {
    assert.ok(error instanceof ContextRuntimeError);
    assert.equal(error.code, 'MCP_RECORD_ACTION_CONTEXT_INVALID');
    return true;
  });
});

test('planned and observed managed processing never fabricate a Lightning visibility dependency', async () => {
  const f = fixture();
  f.snapshot.pages[0]!.fields.find((field) => field.apiName === 'Discount__c')!.rules = [
    { scope: 'FIELD', rule: rule('Record.Managed__c', 'EQUAL', 'observed-runtime-value') }];
  for (const phase of ['START', 'SUBMIT'] as const) {
    const result = await f.executor.executeWithForm({ ...f.input, formContext: { entry: 'STANDARD', phase } },
      phase === 'SUBMIT' ? { Managed__c: 'observed-runtime-value' } : undefined);
    assert.equal(result.output.formContext?.status, 'UNKNOWN');
    assert.ok(result.output.formContext?.criticalUnknown.includes('REQUIREDNESS_UNRESOLVED:Discount__c'));
  }
});

test('fallback preserves an explicitly supplied empty value and never pretends to replace it', async () => {
  const f = fixture('PLATFORM_USER_LOOKUP_FALLBACK');
  const result = await f.executor.execute({ ...f.input, draftFields: { ...f.input.draftFields, Managed__c: null } });
  assert.equal(result.formContext?.status, 'NEEDS_INPUT');
  assert.equal(result.formContext?.fields.find((field) => field.apiName === 'Managed__c')?.valueSource, 'CLIENT_DRAFT');
});

test('managed intent and injected values cannot waive current USER field write denial', async () => {
  for (const phase of ['START', 'SUBMIT'] as const) {
    const f = fixture();
    f.f.fields.Managed__c!.createable = false;
    f.f.fields.Managed__c!.updateable = false;
    const result = await f.executor.executeWithForm({ ...f.input, formContext: { entry: 'STANDARD', phase } },
      phase === 'SUBMIT' ? { Managed__c: 'actual-injection' } : undefined);
    assert.equal(result.output.formContext?.status, 'UNKNOWN');
    assert.ok(result.output.formContext?.criticalUnknown.includes('MANAGED_FIELD_NOT_WRITABLE:Managed__c'));
    assert.equal(Object.hasOwn(result.prepared!.fields, 'Managed__c'), false);
    assert.notEqual(result.output.formContext?.fields.find((field) => field.apiName === 'Managed__c')?.valueState, 'MANAGED_ON_WRITE');
  }
});

test('managed injection rejects absent or generated fields without inserting a write', async () => {
  for (const kind of ['ABSENT', 'GENERATED'] as const) {
    const f = fixture();
    if (kind === 'ABSENT') delete f.f.fields.Managed__c;
    else Object.assign(f.f.fields.Managed__c!, { autoNumber: true });
    const result = await f.executor.executeWithForm({ ...f.input, formContext: { entry: 'STANDARD', phase: 'SUBMIT' } },
      { Managed__c: 'actual-injection' });
    assert.equal(result.output.formContext?.status, 'UNKNOWN');
    assert.ok(result.output.formContext?.criticalUnknown.includes('MANAGED_FIELD_NOT_WRITABLE:Managed__c'));
    assert.equal(Object.hasOwn(result.prepared!.fields, 'Managed__c'), false);
  }
});

test('precise Page Layout checklist excludes proven generated required fields consistently with readiness', async () => {
  const f = fixture();
  f.snapshot.assignments = [];
  f.snapshot.pages = [];
  Object.assign(f.f.fields.ApiRequired__c!, { autoNumber: true, createable: false, updateable: false });
  const result = await f.executor.execute({ ...f.input, draftFields: { Type__c: 'Other' } });
  assert.equal(result.formContext?.formSource, 'PAGE_LAYOUT');
  assert.equal(result.formContext?.status, 'READY');
  assert.equal(result.formContext?.fields.find((field) => field.apiName === 'ApiRequired__c')?.required, false);
  assert.equal(result.requiredChecklist?.some((field) => field.apiName === 'ApiRequired__c'), false);
});

test('asynchronous precise-context audit failure cannot alter the form result or reject outside the call', async () => {
  const f = fixture();
  const executor = new RecordActionContextExecutor(f.f.org, undefined,
    { ...f.options, audit: async () => { throw new Error('Unavailable audit storage'); } });
  assert.equal((await executor.execute(f.input)).formContext?.status, 'READY');
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('an omitted formContext defaults to the precise STANDARD form and falls back to legacy context when it cannot resolve', async () => {
  const snapshot = fixtureSnapshot();
  const f = runtimeFixture('ENFORCE', snapshot);
  Object.assign(f.objectCrud, { createable: true, updateable: true });
  const loadMetadata = async () => ({ snapshot, appDeveloperName: 'App_A', appSource: 'PROFILE_DEFAULT' as const,
    verifiedAt: new Date().toISOString(), apiCallCount: 1, evidence: {} });

  const preciseFirst = new RecordActionContextExecutor(f.org, f.resolver, { defaultFormContext: true, loadMetadata });
  const defaulted = await preciseFirst.execute({ objectApiName: 'Sample__c', action: 'CREATE' });
  recordActionContextOutputSchema.parse(defaulted);
  assert.equal(defaulted.formContext?.entry, 'STANDARD');
  assert.equal(defaulted.formContext?.phase, 'START');
  assert.notEqual(defaulted.formContext?.status, 'UNRESOLVED');

  const unavailable = new RecordActionContextExecutor(f.org, f.resolver, { defaultFormContext: true,
    loadMetadata: async () => { throw new Error('FORM_METADATA_READER_UNAVAILABLE'); } });
  const fallback = await unavailable.execute({ objectApiName: 'Sample__c', action: 'CREATE' });
  recordActionContextOutputSchema.parse(fallback);
  assert.equal(fallback.formContext, undefined, 'defaulted precision must not surface an unusable UNKNOWN form');
  assert.ok(fallback.coverage?.warnings.some((warning) => warning.startsWith('PRECISION_FALLBACK_LEGACY_CONTEXT:')));

  const explicitLegacy = new RecordActionContextExecutor(f.org, f.resolver, { defaultFormContext: false, loadMetadata });
  assert.equal((await explicitLegacy.execute({ objectApiName: 'Sample__c', action: 'CREATE' })).formContext, undefined);
});

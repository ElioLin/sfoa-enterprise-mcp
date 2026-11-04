import assert from 'node:assert/strict';
import test from 'node:test';
import { assessCreateValues, assessManagedCreateValues } from '../create-value-assessment.js';
import { recordActionContextInputSchema, recordActionContextOutputSchema, type RecordActionContextOutput } from '../schemas.js';
import { RecordActionContextMcpTool } from '../tools/record-action-context.js';
import { fixtureSnapshot, runtimeFixture, fieldItem, fixturePage, rule, RT } from './effective-ui-fixtures.js';
import { parseFlexiPage } from '../flexipage-parser.js';

const input = { objectApiName: 'Sample__c', action: 'CREATE' as const };

for (const mode of ['OFF', 'SHADOW', 'ENFORCE'] as const) {
  test(`value assessment is opt-in and adds no Salesforce reads in ${mode}`, async () => {
    const omitted = runtimeFixture(mode);
    const disabled = runtimeFixture(mode);
    const enabled = runtimeFixture(mode);
    const calls: string[][] = [[], [], []];
    for (const [index, fixture] of [omitted, disabled, enabled].entries()) {
      const request = fixture.connection.request.bind(fixture.connection);
      fixture.connection.request = (async (requestInput: { url: string }) => {
        calls[index]!.push(requestInput.url);
        return request({ method: 'GET', url: requestInput.url });
      }) as unknown as typeof fixture.connection.request;
    }
    const before = await omitted.executor.execute(input);
    const off = await disabled.executor.execute({ ...input, includeValueAssessment: false });
    const on = await enabled.executor.execute({ ...input, includeValueAssessment: true });
    assert.equal(before.valueAssessment, undefined);
    assert.equal(off.valueAssessment, undefined);
    assert.equal(off.requiredChecklist, undefined);
    assert.deepEqual(normalized(off), normalized(before));
    assert.ok(on.valueAssessment);
    assert.ok(on.requiredChecklist);
    assert.deepEqual(calls[0], calls[1]);
    assert.deepEqual(calls[0], calls[2]);
    assert.deepEqual(omitted.counts(), enabled.counts());
    assert.deepEqual(before.fields, on.fields, 'assessment must not inject defaults or managed values into visibility');
    assert.ok(recordActionContextOutputSchema.safeParse(on).success);
  });
}

test('raw default presence survives null/undefined collapse while explicit false/zero/null/empty take precedence', async () => {
  const fixture = runtimeFixture('OFF');
  const request = fixture.connection.request.bind(fixture.connection);
  fixture.connection.request = (async ({ url }: { url: string }) => {
    const response = await request({ method: 'GET', url });
    if (url.includes('/record-defaults/create/')) {
      (response as { record: { fields: Record<string, { value?: unknown }> } }).record.fields = {
        Name: { value: 'Default name' }, Type__c: { value: null }, Discount__c: {},
        Internal__c: { value: false }, Secret__c: { value: 0 }, Unknown__c: { value: '' }, Managed__c: { value: 'Default' },
      };
    }
    return response;
  }) as unknown as typeof fixture.connection.request;
  const output = await fixture.executor.execute({ ...input, includeValueAssessment: true,
    draftFields: { Name: null, Internal__c: false, Secret__c: 0, Managed__c: '' } });
  const fields = Object.fromEntries(output.valueAssessment!.fields.map(field => [field.apiName, field]));
  assert.equal(fields.Name?.status, 'EMPTY');
  assert.equal(fields.Name?.source, 'DRAFT');
  assert.equal(fields.Name?.defaultState, 'VALUE');
  assert.equal(fields.Type__c?.defaultPresent, true);
  assert.equal(fields.Type__c?.defaultState, 'EMPTY');
  assert.equal(fields.Discount__c?.defaultPresent, false);
  assert.equal(fields.ApiRequired__c?.defaultPresent, false);
  assert.equal(fields.Internal__c?.status, 'PROVIDED');
  assert.equal(fields.Secret__c?.status, 'PROVIDED');
  assert.equal(fields.Managed__c?.status, 'EMPTY');
  assert.equal(fields.Unknown__c?.defaultPresent, true);
  assert.equal(fields.Unknown__c?.defaultState, 'EMPTY');
  assert.equal(output.fields?.find(field => field.apiName === 'Type__c')?.defaultValue, null);
  assert.equal(output.fields?.find(field => field.apiName === 'Discount__c')?.defaultValue, null);
  assert.equal(output.valueAssessment?.coverage, 'COMPLETE');
});

test('available defaults include false and zero without claiming a write; an oversized default stays UNKNOWN locally', () => {
  const context = contextFields(['Flag__c', 'Amount__c', 'Long__c']);
  context.fields![2]!.defaultValueTruncated = true;
  const result = assessCreateValues(context, {}, { Flag__c: { value: false }, Amount__c: { value: 0 }, Long__c: { value: 'x'.repeat(5000) } });
  assert.deepEqual(result.fields.map(field => field.status), ['DEFAULT_AVAILABLE', 'DEFAULT_AVAILABLE', 'UNKNOWN']);
  assert.equal(result.fields[2]?.defaultPresent, true);
  assert.equal(result.coverage, 'PARTIAL');
  assert.doesNotMatch(JSON.stringify(result), /readyToCommit|canWrite|allValidated/u);
});

test('missing Record Type returns PARTIAL and unknown defaults without fetching type-dependent APIs', async () => {
  const fixture = runtimeFixture('OFF');
  const calls: string[] = [];
  const request = fixture.connection.request.bind(fixture.connection);
  fixture.connection.request = (async ({ url }: { url: string }) => {
    calls.push(url);
    const response = await request({ method: 'GET', url });
    if (url.includes('/object-info/')) {
      (response as { recordTypeInfos: Record<string, unknown> }).recordTypeInfos['012000000000002AAA'] = {
        recordTypeId: '012000000000002AAA', name: 'Other', available: true, defaultRecordTypeMapping: false,
      };
    }
    return response;
  }) as unknown as typeof fixture.connection.request;
  const output = await fixture.executor.execute({ ...input, includeValueAssessment: true, draftFields: { Name: 'Supplied' } });
  assert.equal(output.recordTypeSelectionRequired, true);
  assert.equal(calls.length, 1);
  assert.equal(output.valueAssessment?.coverage, 'PARTIAL');
  assert.equal(output.valueAssessment?.requirednessSource, 'UNRESOLVED');
  const fields = Object.fromEntries(output.valueAssessment!.fields.map(field => [field.apiName, field]));
  assert.equal(fields.Name?.status, 'PROVIDED');
  assert.equal(fields.Name?.required, null);
  assert.equal(fields.Name?.defaultPresent, null);
  assert.equal(fields.ApiRequired__c?.required, true);
  assert.equal(fields.ApiRequired__c?.status, 'UNKNOWN');
});

test('parsed Dynamic Forms distinguish hidden API required, hidden page-only and unresolved conditional requiredness', async () => {
  const page = fixturePage();
  (page.flexiPageRegions[3]!.itemInstances as unknown[]).push(fieldItem('ApiRequired__c', 'none', rule('Record.Type__c', 'EQUAL', 'Never')));
  const snapshot = fixtureSnapshot();
  snapshot.pages = [parseFlexiPage(page, 'Sample__c')];
  const output = await runtimeFixture('ENFORCE', snapshot).executor.execute({ ...input, includeValueAssessment: true, draftFields: { Type__c: 'Other' } });
  const fields = Object.fromEntries(output.valueAssessment!.fields.map(field => [field.apiName, field]));
  assert.equal(fields.ApiRequired__c?.required, true);
  assert.equal(fields.Secret__c?.required, false);
  assert.equal(fields.Unknown__c?.required, null);
  assert.equal(output.valueAssessment?.coverage, 'PARTIAL');
  // uiBehavior comes from the parser: one instance cannot be required and readonly.
  for (const field of snapshot.pages[0]!.fields) assert.equal(field.required && field.readOnly, false);
  for (const item of output.requiredChecklist ?? []) {
    const field = output.fields!.find(field => field.apiName === item.apiName)!;
    assert.equal(item.writable, field.effectiveEditable);
  }
});

test('Dynamic Forms fallback retains its known layout facts and reports partial assessment', async () => {
  const output = await runtimeFixture('ENFORCE', null).executor.execute({ ...input, includeValueAssessment: true });
  assert.equal(output.valueAssessment?.requirednessSource, 'PAGE_LAYOUT_FALLBACK');
  assert.equal(output.valueAssessment?.coverage, 'PARTIAL');
  assert.equal(output.valueAssessment?.fields.find(field => field.apiName === 'Name')?.status, 'DEFAULT_AVAILABLE');
});

test('unrelated help truncation does not make known draft or requiredness unknown', async () => {
  const fixture = runtimeFixture('OFF');
  Object.assign(fixture.fields.Name!, { inlineHelpText: 'x'.repeat(3000) });
  const output = await fixture.executor.execute({ ...input, includeValueAssessment: true, draftFields: { Name: 'Known' } });
  assert.equal(output.coverage?.truncated, true);
  assert.equal(output.valueAssessment?.coverage, 'COMPLETE');
  assert.equal(output.valueAssessment?.fields.find(field => field.apiName === 'Name')?.status, 'PROVIDED');
});

test('assessment handles unknown draft metadata without treating ABSENT as a user omission', () => {
  const output = assessCreateValues(contextFields(['Known__c']), { Unknown__c: 'Supplied' }, {});
  assert.equal(output.fields[0]?.status, 'ABSENT');
  assert.equal(output.fields[1]?.status, 'PROVIDED');
  assert.equal(output.fields[1]?.required, null);
  assert.equal(output.coverage, 'PARTIAL');
});

test('strict managed policy overrides draft while fallback preserves every present scalar, including explicit empty', () => {
  for (const value of [null, '', false, 0, '003000000000001AAA']) {
    const context = contextFields(['Strict__c', 'Fallback__c', 'Missing__c', 'Marker__c']);
    const original = assessCreateValues(context, { Strict__c: value, Fallback__c: value }, {});
    const before = JSON.stringify(original);
    const assessment = assessManagedCreateValues(original, [
      { fieldApiName: 'Strict__c', strategy: 'PLATFORM_IDENTITY' },
      { fieldApiName: 'Fallback__c', strategy: 'PLATFORM_IDENTITY_FALLBACK' },
      { fieldApiName: 'Missing__c', strategy: 'PLATFORM_IDENTITY_FALLBACK' },
      { fieldApiName: 'Marker__c', strategy: 'AI_CREATED_MARKER' },
    ]);
    assert.equal(assessment.fields[0]?.status, 'MANAGED_ON_WRITE');
    assert.equal(assessment.fields[1]?.status, value === null || value === '' ? 'EMPTY' : 'PROVIDED');
    assert.equal(assessment.fields[2]?.status, 'MANAGED_ON_WRITE');
    assert.equal(assessment.fields[3]?.status, 'MANAGED_ON_WRITE');
    assert.equal(JSON.stringify(original), before, 'policy enrichment does not mutate provider or UI facts');
  }
});

test('managed fallback follows the existing case-insensitive DML presence semantics', () => {
  const context = contextFields(['Owner_Contact__c']);
  const assessment = assessManagedCreateValues(assessCreateValues(context, { owner_contact__c: null }, {}),
    [{ fieldApiName: 'Owner_Contact__c', strategy: 'PLATFORM_IDENTITY_FALLBACK' }]);
  assert.ok(assessment.fields.every(field => field.status === 'EMPTY' && field.source === 'DRAFT'));
});

test('Tool schema and JSON mirror expose only the optional CREATE assessment; UPDATE and long drafts keep their bounds', async () => {
  const fixture = runtimeFixture('OFF');
  const tool = new RecordActionContextMcpTool(fixture.executor);
  const output = await tool.exec({ ...input, includeValueAssessment: true, fieldApiNames: ['Name'] });
  assert.equal(output.isError, undefined);
  assert.equal(output.content.length, 1);
  assert.equal(output.content[0]?.type, 'text');
  if (output.content[0]?.type === 'text') assert.deepEqual(JSON.parse(output.content[0].text), output.structuredContent);
  assert.ok(recordActionContextOutputSchema.safeParse(output.structuredContent).success);
  assert.equal(recordActionContextInputSchema.safeParse({ ...input, action: 'UPDATE', recordId: RT, includeValueAssessment: true }).success, false);
  assert.equal(recordActionContextInputSchema.safeParse({ ...input, action: 'UPDATE', recordId: RT, includeValueAssessment: false }).success, true);
  assert.equal(recordActionContextInputSchema.safeParse({ ...input, draftFields: { Name: 'x'.repeat(4097) } }).success, false);
});

function normalized(output: RecordActionContextOutput): unknown {
  return { ...output, coverage: output.coverage ? { ...output.coverage, durationMs: 0 } : undefined,
    ...(output.uiContext ? { uiContext: { ...output.uiContext, resolutionId: 'ignored' }, uiContextResolutionId: 'ignored' } : {}) };
}

function contextFields(names: string[]): RecordActionContextOutput {
  return { success: true, action: 'CREATE', fields: names.map(apiName => ({ apiName, label: apiName, dataType: 'String',
    apiRequired: false, layoutMember: true, layoutRequired: false, fieldCreateable: true, fieldUpdateable: true,
    layoutEditableForCreate: true, layoutEditableForUpdate: true, defaultValue: null, defaultValueTruncated: false,
    section: null, layoutOrder: null, relationshipName: null, referenceTo: [] })), coverage: {
    sources: [], apiCallCount: 0, durationMs: 0, responseBytes: 0, totalVisibleFields: names.length, returnedFields: names.length,
    totalPicklistValues: 0, returnedPicklistValues: 0, truncated: false, dynamicFormsEvaluated: false,
    requirednessSource: 'PAGE_LAYOUT_REQUIRED', completeLightningPageEvaluated: false, warnings: [],
  } };
}

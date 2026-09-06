import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import { parseFlexiPage } from '../flexipage-parser.js';
import { evaluateVisibility, type VisibilityFacts } from '../visibility.js';
import { resolveActivePage } from '../active-page.js';
import { EffectiveRecordUiContextResolver } from '../effective-ui-resolver.js';
import { RecordActionContextExecutor } from '../record-action-executor.js';
import { recordActionContextInputSchema, recordActionContextOutputSchema } from '../schemas.js';
import { collectUiSnapshot } from '../ui-snapshot-refresh.js';
import { UI_PARSER_VERSION, type UiSnapshot, type UiMode, type VisibilityRule } from '../effective-ui-contracts.js';

const ORG = '00D000000000001AAA';
const RT = '012000000000001AAA';
const PROFILE = '00e000000000001AAA';
const rule = (leftValue: string, operator = 'EQUAL', rightValue: string | number | boolean | null = 'Partner'): VisibilityRule =>
  ({ criteria: [{ leftValue, operator, rightValue }] });
const component = (componentName: string, properties: Record<string, unknown> = {}) => ({ componentInstance: {
  componentName, componentInstanceProperties: Object.entries(properties).map(([name, value]) => ({ name, value })),
} });
const fieldItem = (name: string, behavior = 'none', visibilityRule?: VisibilityRule) => ({ fieldInstance: {
  fieldItem: `Record.${name}`, identifier: name, fieldInstanceProperties: [{ name: 'uiBehavior', value: behavior }], visibilityRule,
} });
export function fixturePage() {
  return { fullName: 'Create_Page', type: 'RecordPage', sobjectType: 'Sample__c', flexiPageRegions: [
    { name: 'main', type: 'Region', itemInstances: [component('force:recordDetailPanelMobile'), component('flexipage:fieldSection', { label: 'Details', columns: 'columns' })] },
    { name: 'columns', type: 'Facet', itemInstances: [component('flexipage:column', { body: 'left' }), component('flexipage:column', { body: 'right' })] },
    { name: 'left', type: 'Facet', itemInstances: [fieldItem('Type__c'), fieldItem('Name', 'required'), fieldItem('Discount__c', 'required', rule('{!Record.Type__c}'))] },
    { name: 'right', type: 'Facet', itemInstances: [fieldItem('Internal__c', 'readonly'), fieldItem('Secret__c', 'required', rule('{!Record.Type__c}', 'EQUAL', 'Internal')),
      fieldItem('Unknown__c', 'required', rule('{!Record.Owner.ManagerId}')), fieldItem('Managed__c'), fieldItem('NoFls__c')] },
  ] };
}
export function fixtureSnapshot(): UiSnapshot {
  return { organizationId: ORG, objectApiName: 'Sample__c', parserVersion: UI_PARSER_VERSION, complete: true,
    profiles: [{ id: PROFILE, name: 'Profile A Display', fullName: 'Profile_A' }, { id: '00e000000000002AAA', name: 'Profile_B', fullName: 'Profile_B' }],
    recordTypes: [{ id: RT, fullName: 'Sample__c.Business' }],
    apps: [{ appId: '06m000000000001AAA', developerName: 'App_A', fullName: 'App_A' }],
    assignments: [{ app: 'App_A', profile: 'Profile_A', recordType: 'Sample__c.Business', formFactor: 'Large',
      action: 'View', type: 'Flexipage', page: 'Create_Page', source: 'APP_PROFILE_RECORD_TYPE' }],
    pages: [parseFlexiPage(fixturePage(), 'Sample__c')],
  };
}
function runtimeFixture(mode: UiMode, snapshot: UiSnapshot | null = fixtureSnapshot(), profileId = PROFILE) {
  let metadataCalls = 0; let userCalls = 0; let snapshotCalls = 0;
  const evidence: Readonly<Record<string, unknown>>[] = [];
  const fields = Object.fromEntries(['Name', 'Type__c', 'Discount__c', 'Internal__c', 'Secret__c', 'Unknown__c', 'Managed__c', 'NoFls__c', 'ApiRequired__c'].map((apiName) => [apiName, {
    apiName, label: apiName, dataType: 'String', required: apiName === 'ApiRequired__c', createable: apiName !== 'NoFls__c', updateable: true,
  }]));
  const recordType = { recordTypeId: RT, name: 'Business', available: true, defaultRecordTypeMapping: true };
  const connection = {
    getApiVersion: () => '67.0',
    soap: { getUserInfo: async () => { userCalls++; return { userId: `005${profileId.slice(3)}`, profileId, organizationId: ORG }; } },
    metadata: { read: () => { metadataCalls++; throw new Error('METADATA_RUNTIME_FORBIDDEN'); } },
    request: async ({ url }: { url: string }) => {
      if (url.includes('/apps?')) { userCalls++; return { apps: snapshot?.apps ?? [] }; }
      if (url.includes('/picklist-values/')) return { picklistFieldValues: {} };
      if (url.includes('/object-info/')) return { apiName: 'Sample__c', label: 'Sample', labelPlural: 'Samples', fields, defaultRecordTypeId: RT, recordTypeInfos: { [RT]: recordType } };
      return { layout: { id: '00h000000000001AAA', sections: [{ heading: 'Legacy', layoutRows: [{ layoutItems: [{ required: true, editableForNew: true, editableForUpdate: true, layoutComponents: [{ componentType: 'Field', apiName: 'Name' }] }] }] }] },
        record: { apiName: 'Sample__c', recordTypeId: RT, fields: { Name: { value: 'Default name' } } } };
    },
  } as unknown as Connection;
  const org = { getAllowedOrgUsernames: async () => new Set(['user@example.test']), getConnection: async () => connection } as unknown as OrgService;
  const resolver = new EffectiveRecordUiContextResolver({ policies: [{ objectApiName: 'Sample__c', mode }], managedFields: ['Managed__c'],
    loadSnapshot: async () => { snapshotCalls++; return snapshot ? { id: '1', organizationId: ORG, objectApiName: 'Sample__c', snapshot,
      hash: 'f'.repeat(64), lastModified: null, refreshedAt: new Date().toISOString(), status: 'READY', lastError: null, parserVersion: UI_PARSER_VERSION } : undefined; },
    audit: (entry) => evidence.push(entry),
  });
  return { executor: new RecordActionContextExecutor(org, resolver), legacy: new RecordActionContextExecutor(org), evidence,
    counts: () => ({ metadataCalls, userCalls, snapshotCalls }) };
}

test('structural parser retains ancestry, sections, repeated instances and desktop ignores mobile detail', () => {
  const raw = fixturePage();
  const page = parseFlexiPage(raw, 'Sample__c');
  assert.equal(page.formSource, 'DYNAMIC_FORMS');
  assert.deepEqual(page.fields.slice(0, 3).map((field) => field.apiName), ['Type__c', 'Name', 'Discount__c']);
  assert.equal(page.fields[1]?.required, true);
  assert.equal(page.fields[3]?.readOnly, true);
  assert.deepEqual(page.fields[0]?.ancestry, ['main', 'columns', 'left']);
  assert.deepEqual(page.fields.map((field) => field.column), [0, 0, 0, 1, 1, 1, 1, 1]);
  (raw.flexiPageRegions[0]!.itemInstances as unknown[]).push(component('force:detailPanel'));
  assert.equal(parseFlexiPage(raw, 'Sample__c').formSource, 'MIXED');
});

test('refresh collects only bounded configuration through the official SDK and normalizes its current facts', async () => {
  const calls: string[] = [];
  const source = fixtureSnapshot();
  const connection = {
    soap: { getUserInfo: async () => ({ organizationId: ORG }) },
    query: async (soql: string) => {
      calls.push(soql);
      return { done: true, records: soql.includes('AppDefinition')
        ? [{ DurableId: source.apps[0]!.appId, DeveloperName: 'App_A', NamespacePrefix: null }]
        : soql.includes('Profile') ? [{ Id: PROFILE, Name: 'Profile_A' }]
        : [{ Id: RT, DeveloperName: 'Business', NamespacePrefix: null }] };
    },
    metadata: {
      list: async (types: { type: string }[]) => types[0]?.type === 'Profile' ? [{ id: PROFILE, fullName: 'Profile_A' }] : [{ fullName: 'App_A' }],
      read: async (type: string) => {
        calls.push(type);
        return type === 'CustomObject' ? { fullName: 'Sample__c', actionOverrides: [] }
          : type === 'CustomApplication' ? { fullName: 'App_A', profileActionOverrides: [{ pageOrSobjectType: 'Sample__c',
            profile: 'Profile_A', recordType: 'Sample__c.Business', formFactor: 'Large', actionName: 'View', type: 'Flexipage', content: 'Create_Page' }] }
          : fixturePage();
      },
    },
  } as unknown as Connection;
  const snapshot = await collectUiSnapshot(connection, 'Sample__c');
  assert.deepEqual(snapshot.pages[0], source.pages[0]);
  assert.equal(snapshot.assignments.length, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /componentInstance|flexiPageRegions|draftFields/u);
  assert.ok(calls.every((call) => !call.includes('FROM User') && !call.includes('FROM Sample__c')));
  await assert.rejects(collectUiSnapshot(connection, 'Bad.Name'));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(collectUiSnapshot(connection, 'Sample__c', abort.signal));
});

test('repeated fields aggregate visible instances; hidden API required and inaccessible fields stay distinct', async () => {
  const snapshot = fixtureSnapshot();
  const first = snapshot.pages[0]!.fields[2]!;
  snapshot.pages[0]!.fields.push({ ...first, instanceId: 'discount_repeat', order: 8, required: false, readOnly: false, rules: [] });
  snapshot.pages[0]!.fields.push({ ...first, apiName: 'ApiRequired__c', instanceId: 'hidden_api', order: 9,
    rules: [{ scope: 'FIELD', rule: rule('Record.Type__c', 'EQUAL', 'Never') }] });
  const output = await runtimeFixture('ENFORCE', snapshot).executor.execute({ objectApiName: 'Sample__c', action: 'CREATE', draftFields: { Type__c: 'Other' } });
  assert.equal(output.fields?.find((field) => field.apiName === 'Discount__c')?.visibilityState, 'VISIBLE');
  assert.equal(output.fields?.find((field) => field.apiName === 'Discount__c')?.effectiveRequired, false);
  assert.equal(output.fields?.find((field) => field.apiName === 'ApiRequired__c')?.effectiveRequired, true);
  assert.equal(output.fields?.find((field) => field.apiName === 'ApiRequired__c')?.effectiveEditable, true);
});

test('parser refuses partial traversal, cycles, and unresolved Default inheritance', () => {
  const raw = fixturePage();
  raw.flexiPageRegions.push({ name: 'orphan', type: 'Facet', itemInstances: [fieldItem('Orphan__c')] });
  assert.ok(parseFlexiPage(raw, 'Sample__c').unsupported.includes('UNREACHABLE_FIELDS'));
  (raw.flexiPageRegions[2]!.itemInstances as unknown[]).push(component('flexipage:column', { body: 'left' }));
  assert.throws(() => parseFlexiPage(raw, 'Sample__c'), /CYCLE/u);
  const snapshot = fixtureSnapshot();
  snapshot.assignments.push({ app: null, profile: null, recordType: null, formFactor: 'Large', action: 'New', type: 'Visualforce', page: 'Custom', source: 'ORG_DEFAULT' },
    { app: 'App_A', profile: null, recordType: null, formFactor: 'Large', action: 'New', type: 'Default', page: null, source: 'APP_DEFAULT' });
  assert.equal(resolveActivePage(snapshot, { profileId: PROFILE, recordTypeId: RT, formFactor: 'Large', apps: snapshot.apps }).fallbackReason, 'ASSIGNMENT_DEFAULT_INHERITANCE_UNKNOWN');
});

test('performance evidence: OFF/PL/DF hit/miss do no runtime Metadata calls', async () => {
  const measurements = [];
  for (const [scenario, mode, snapshot, profile] of [
    ['OFF', 'OFF', fixtureSnapshot(), PROFILE], ['PL', 'ENFORCE', fixtureSnapshot(), '00e000000000002AAA'],
    ['DF_HIT', 'ENFORCE', fixtureSnapshot(), PROFILE], ['DF_MISS', 'ENFORCE', null, PROFILE],
  ] as const) {
    const fixture = runtimeFixture(mode, snapshot, profile);
    const durations: number[] = [];
    for (let index = 0; index < 100; index++) {
      const start = performance.now();
      await fixture.executor.execute({ objectApiName: 'Sample__c', action: 'CREATE' });
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    assert.equal(fixture.counts().metadataCalls, 0);
    measurements.push({ scenario, iterations: 100, medianMs: Number(durations[50]!.toFixed(3)), p95Ms: Number(durations[95]!.toFixed(3)), ...fixture.counts() });
  }
  console.log(JSON.stringify({ p804SyntheticPerformance: measurements,
    normalizedPageBytes: Buffer.byteLength(JSON.stringify(fixtureSnapshot().pages[0])),
    normalizedSnapshotBytes: Buffer.byteLength(JSON.stringify(fixtureSnapshot())) }));
});

test('visibility preserves missing/null/false/zero/empty, comparisons, AND/OR and booleanFilter', () => {
  const facts: VisibilityFacts = { draftFields: {}, fieldTypes: { Flag: 'Boolean', Amount: 'Currency', Text: 'String' }, user: {}, formFactor: 'Large' };
  assert.deepEqual(evaluateVisibility(rule('Record.Flag', 'EQUAL', 'false'), facts), { state: 'PENDING', dependsOn: ['Flag'], kinds: ['RECORD_FIELD'] });
  const actual = { ...facts, draftFields: { Flag: false, Amount: 0, Text: '' } };
  for (const candidate of [rule('Record.Flag', 'EQUAL', 'false'), rule('Record.Amount', 'GE', '0'), rule('Record.Amount', 'LE', '0'), rule('Record.Text', 'EQUAL', '')]) {
    assert.equal(evaluateVisibility(candidate, actual).state, 'VISIBLE');
  }
  assert.equal(evaluateVisibility(rule('Record.Text', 'EQUAL', null), { ...actual, draftFields: { Text: null } }).state, 'VISIBLE');
  assert.equal(evaluateVisibility(rule('Record.Text', 'EQUAL', null), actual).state, 'HIDDEN');
  assert.equal(evaluateVisibility(rule('Record.Text', 'BOGUS', ''), actual).state, 'UNKNOWN');
  assert.equal(evaluateVisibility(rule('Record.Owner.Name'), actual).state, 'UNKNOWN');
  assert.equal(evaluateVisibility(rule('Record.Text'), actual, 'CONTAINER').state, 'UNKNOWN');
  const compound = { criteria: [rule('Record.Flag', 'EQUAL', 'true').criteria[0]!, rule('Record.Owner.Name').criteria[0]!], booleanFilter: '(1 AND 2)' };
  assert.equal(evaluateVisibility(compound, actual).state, 'HIDDEN');
  assert.equal(evaluateVisibility({ ...compound, booleanFilter: '1 OR 2' }, actual).state, 'UNKNOWN');
  assert.equal(evaluateVisibility({ ...compound, booleanFilter: '1 || 2' }, actual).state, 'UNKNOWN');
});

test('active page varies by Profile and requires explicit App when applicable Apps diverge', () => {
  const snapshot = fixtureSnapshot();
  const facts = { profileId: PROFILE, recordTypeId: RT, formFactor: 'Large' as const, apps: snapshot.apps };
  assert.equal(resolveActivePage(snapshot, facts).formSource, 'DYNAMIC_FORMS');
  assert.equal(resolveActivePage(snapshot, { ...facts, profileId: '00e000000000002AAA' }).formSource, 'PAGE_LAYOUT');
  snapshot.apps.push({ appId: '06m000000000002AAA', developerName: 'App_B', fullName: 'App_B' });
  assert.equal(resolveActivePage(snapshot, facts).fallbackReason, 'APP_CONTEXT_REQUIRED');
  assert.equal(resolveActivePage(snapshot, { ...facts, appDeveloperName: 'App_A' }).formSource, 'DYNAMIC_FORMS');
  assert.equal(resolveActivePage(snapshot, { ...facts, appDeveloperName: 'App_B' }).formSource, 'PAGE_LAYOUT');
  assert.equal(resolveActivePage(snapshot, { ...facts, appDeveloperName: 'NotAccessible' }).fallbackReason, 'APP_CONTEXT_INVALID');
});

test('custom New override is detected before Dynamic Forms and unsupported form factors fall back', () => {
  const snapshot = fixtureSnapshot();
  snapshot.assignments.push({ app: null, profile: null, recordType: null, formFactor: null, action: 'New', type: 'LightningComponent', page: 'CustomNew', source: 'ORG_DEFAULT' });
  const facts = { profileId: PROFILE, recordTypeId: RT, formFactor: 'Large' as const, apps: snapshot.apps };
  assert.equal(resolveActivePage(snapshot, facts).fallbackReason, 'CUSTOM_OVERRIDE_NOT_EVALUATED');
  assert.equal(resolveActivePage(snapshot, { ...facts, formFactor: 'Small' }).fallbackReason, 'UNSUPPORTED_FORM_FACTOR');
});

test('OFF and SHADOW preserve every Page Layout field/default/order fact; OFF performs zero extra reads', async () => {
  for (const mode of ['OFF', 'SHADOW'] as const) {
    const fixture = runtimeFixture(mode);
    const baseline = await fixture.legacy.execute({ objectApiName: 'Sample__c', action: 'CREATE' });
    const output = await fixture.executor.execute({ objectApiName: 'Sample__c', action: 'CREATE' });
    assert.deepEqual(output.fields, baseline.fields);
    assert.deepEqual(output.recordType, baseline.recordType);
    assert.equal(output.coverage?.dynamicFormsEvaluated, false);
    assert.ok(output.uiContextResolutionId);
    assert.equal(output.uiContext, undefined);
    assert.equal(fixture.counts().metadataCalls, 0);
    if (mode === 'OFF') assert.deepEqual(fixture.counts(), { metadataCalls: 0, userCalls: 0, snapshotCalls: 0 });
    assert.equal(fixture.evidence[0]?.usedForAgent, false);
  }
});

test('ENFORCE computes hidden/required/pending/unknown and FLS/managed intersection without metadata calls', async () => {
  const fixture = runtimeFixture('ENFORCE');
  const first = await fixture.executor.execute({ objectApiName: 'Sample__c', action: 'CREATE' });
  assert.equal(first.fields?.find((field) => field.apiName === 'Discount__c')?.visibilityState, 'PENDING');
  const output = await fixture.executor.execute({ objectApiName: 'Sample__c', action: 'CREATE', draftFields: { Type__c: 'Partner' }, refinement: 1 });
  recordActionContextOutputSchema.parse(output);
  const byName = Object.fromEntries(output.fields!.map((field) => [field.apiName, field]));
  assert.equal(byName.Discount__c?.effectiveRequired, true);
  assert.deepEqual(byName.Discount__c?.requiredSource, ['DYNAMIC_FORM']);
  assert.equal(byName.Secret__c?.visibilityState, 'HIDDEN');
  assert.equal(byName.Secret__c?.effectiveRequired, false);
  assert.equal(byName.Unknown__c?.visibilityState, 'UNKNOWN');
  assert.equal(byName.Unknown__c?.effectiveRequired, false);
  assert.equal(byName.ApiRequired__c?.effectiveRequired, true);
  assert.deepEqual(byName.ApiRequired__c?.requiredSource, ['API']);
  assert.equal(byName.Managed__c?.optionalCandidate, false);
  assert.equal(byName.NoFls__c?.effectiveEditable, false);
  assert.equal(byName.Internal__c?.effectiveEditable, false);
  assert.equal(output.uiContext?.formSource, 'DYNAMIC_FORMS');
  assert.equal(fixture.counts().metadataCalls, 0);
  assert.doesNotMatch(JSON.stringify(fixture.evidence), /Partner/u);
});

test('snapshot absence and parse failure fall back while valid Page Layout remains byte-equivalent in fields', async () => {
  for (const snapshot of [null, { ...fixtureSnapshot(), parserVersion: 'invalid' } as unknown as UiSnapshot]) {
    const fixture = runtimeFixture('ENFORCE', snapshot);
    const output = await fixture.executor.execute({ objectApiName: 'Sample__c', action: 'CREATE' });
    const baseline = await fixture.legacy.execute({ objectApiName: 'Sample__c', action: 'CREATE' });
    assert.deepEqual(output.fields, baseline.fields);
    assert.equal(output.uiContext?.fallbackUsed, true);
  }
});

test('concurrent USER contexts cannot share evaluated fields or draft values', async () => {
  const shared = fixtureSnapshot();
  const results = await Promise.all(Array.from({ length: 40 }, async (_unused, index) => {
    const profile = index % 2 ? '00e000000000002AAA' : PROFILE;
    const fixture = runtimeFixture('ENFORCE', shared, profile);
    return fixture.executor.execute({ objectApiName: 'Sample__c', action: 'CREATE', draftFields: { Type__c: 'Partner' } });
  }));
  results.forEach((result, index) => assert.equal(result.coverage?.dynamicFormsEvaluated, index % 2 === 0));
  assert.doesNotMatch(JSON.stringify(shared), /draftFields/u);
});

test('draft validation and bounded refinement reject unknown fields, scalar mismatch, UPDATE and iterations above three', async () => {
  const fixture = runtimeFixture('ENFORCE');
  await assert.rejects(fixture.executor.execute({ objectApiName: 'Sample__c', action: 'CREATE', draftFields: { Missing__c: 'x' } }));
  await assert.rejects(fixture.executor.execute({ objectApiName: 'Sample__c', action: 'CREATE', draftFields: { Type__c: false } }));
  assert.equal(recordActionContextInputSchema.safeParse({ objectApiName: 'Sample__c', action: 'CREATE', refinement: 4 }).success, false);
  assert.equal(recordActionContextInputSchema.safeParse({ objectApiName: 'Sample__c', action: 'UPDATE', recordId: RT, draftFields: {} }).success, false);
  const last = await fixture.executor.execute({ objectApiName: 'Sample__c', action: 'CREATE', refinement: 3 });
  assert.equal(last.uiContext?.refinementLimitReached, true);
});

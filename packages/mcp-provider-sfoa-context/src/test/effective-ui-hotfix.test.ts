import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ContextRuntimeError } from '../errors.js';
import { RecordActionContextMcpTool } from '../tools/record-action-context.js';
import { recordActionContextOutputSchema, type RecordActionContextInput } from '../schemas.js';
import { UI_PARSER_VERSION, type UiMode, type UiSnapshot, type EffectiveUiOptions } from '../effective-ui-contracts.js';
import { fixtureSnapshot, runtimeFixture } from './effective-ui-fixtures.js';

// Captured by executing record-action-executor.ts from ac7e31942f5158f5af7ff977b4b8550e121840a4
// with the aliased runtimeFixture USER responses and performance.now fixed at 1000.
// Compare the complete wire object, including coverage/metrics; never remove new keys.
const legacy = JSON.parse(readFileSync(new URL('../../src/test/fixtures/pre-p804-page-layout.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const input: RecordActionContextInput = { objectApiName: 'Sample__c', action: 'CREATE' };
const pageLayout = (): UiSnapshot => ({ ...fixtureSnapshot(), assignments: [], pages: [] });
const appRequired = (): UiSnapshot => {
  const snapshot = fixtureSnapshot();
  snapshot.apps.push({ appId: '06m000000000002AAA', developerName: 'App_B', fullName: 'App_B' });
  return snapshot;
};
const cases: { name: string; mode: UiMode; snapshot: () => UiSnapshot | null; draftFields?: Record<string, string | boolean>;
  overrides?: Partial<EffectiveUiOptions>; fallback?: string }[] = [
  { name: 'OFF + Page Layout', mode: 'OFF', snapshot: pageLayout },
  { name: 'SHADOW + Page Layout', mode: 'SHADOW', snapshot: pageLayout },
  { name: 'SHADOW + Dynamic Forms candidate', mode: 'SHADOW', snapshot: fixtureSnapshot },
  { name: 'SHADOW resolver dependency throws', mode: 'SHADOW', snapshot: fixtureSnapshot,
    overrides: { loadSnapshot: async () => { throw new ContextRuntimeError('MCP_RECORD_ACTION_CONTEXT_INVALID', 'PRIVATE_INTERNAL_ERROR'); } },
    fallback: 'PRIVATE_INTERNAL_ERROR' },
  { name: 'SHADOW invalid draftFields', mode: 'SHADOW', snapshot: fixtureSnapshot, draftFields: { NoFls__c: 'PRIVATE_VALUE' }, fallback: 'USER_INPUT_ERROR' },
  { name: 'ENFORCE + resolved Page Layout', mode: 'ENFORCE', snapshot: pageLayout },
  { name: 'ENFORCE + APP_CONTEXT_REQUIRED', mode: 'ENFORCE', snapshot: appRequired, fallback: 'APP_CONTEXT_REQUIRED' },
  { name: 'ENFORCE + snapshot missing', mode: 'ENFORCE', snapshot: () => null, fallback: 'SNAPSHOT_MISSING' },
  { name: 'ENFORCE + parser failure', mode: 'ENFORCE', snapshot: () => ({ ...fixtureSnapshot(), parserVersion: 'invalid' }) as unknown as UiSnapshot, fallback: 'PARSER_ERROR' },
];
for (const entry of cases) test(`exact pre-P8-04 response: ${entry.name}`, async (t) => {
  t.mock.method(performance, 'now', () => 1000);
  const fixture = runtimeFixture(entry.mode, entry.snapshot(), undefined, entry.overrides);
  const result = await new RecordActionContextMcpTool(fixture.executor).exec({ ...input, ...(entry.draftFields ? { draftFields: entry.draftFields } : {}) });
  assert.deepStrictEqual(result.structuredContent, legacy);
  assert.deepStrictEqual(result.content, [{ type: 'text', text: JSON.stringify(legacy) }]);
  assert.equal(result.isError, undefined);
  assert.equal(fixture.evidence.length, 1);
  assert.equal(fixture.evidence[0]?.usedForAgent, false);
  assert.match(String(fixture.evidence[0]?.resolutionId), /^[0-9a-f-]{36}$/u);
  assert.equal(fixture.evidence[0]?.pageLayoutId, '00h000000000001AAA');
  if (entry.fallback) assert.equal(fixture.evidence[0]?.fallbackReason, entry.fallback);
  if (entry.mode === 'OFF') assert.deepStrictEqual(fixture.counts(), { metadataCalls: 0, userCalls: 0, snapshotCalls: 0 });
});

test('legacy fixture still matches the executor with P8-04 disabled', async (t) => {
  t.mock.method(performance, 'now', () => 1000);
  assert.deepStrictEqual(await runtimeFixture('OFF').legacy.execute(input), legacy);
});

test('SHADOW isolates USER enrichment, app discovery, parser and aggregation failures', async (t) => {
  t.mock.method(performance, 'now', () => 1000);
  for (const layer of ['user', 'apps', 'parser', 'aggregation'] as const) {
    const snapshot = fixtureSnapshot();
    if (layer === 'parser') snapshot.pages[0]!.fields[0]!.rules = null as never;
    const fixture = runtimeFixture('SHADOW', snapshot);
    if (layer === 'user') t.mock.method(fixture.connection.soap, 'getUserInfo', () => { throw new Error('USER_CONTEXT_ERROR'); });
    if (layer === 'apps') {
      const request = fixture.connection.request.bind(fixture.connection);
      t.mock.method(fixture.connection, 'request', (arg: { url: string; method: 'GET' }) => {
        if (arg.url.includes('/apps?')) throw new Error('APP_CONTEXT_ERROR');
        return request(arg);
      });
    }
    if (layer === 'aggregation') {
      // All fields are known to USER; exceeding the DF aggregation bound fails only extra work.
      for (let index = 0; index < 201; index++) {
        const apiName = `Extra${index}__c`;
        fixture.fields[apiName] = { ...fixture.fields.Name!, apiName };
        snapshot.pages[0]!.fields.push({ ...snapshot.pages[0]!.fields[0]!, apiName, instanceId: apiName });
      }
    }
    const baseline = await fixture.legacy.execute(input);
    assert.deepStrictEqual(await fixture.executor.execute(input), baseline);
    assert.equal(fixture.evidence[0]?.usedForAgent, false);
    assert.equal(fixture.evidence[0]?.failureKind, 'DYNAMIC_RESOLUTION_FAILURE');
    assert.equal(fixture.evidence[0]?.fallbackUsed, true);
  }
});

test('invalid DF draft values fail open in OFF/SHADOW and remain structured input errors in ENFORCE', async (t) => {
  t.mock.method(performance, 'now', () => 1000);
  for (const draftFields of ([{ Missing__c: 'x' }, { NoFls__c: 'x' }, { Type__c: false }, { Name: 42 }, { Id: 'x' }] as NonNullable<RecordActionContextInput['draftFields']>[])) {
    for (const mode of ['OFF', 'SHADOW', 'ENFORCE'] as const) {
      const fixture = runtimeFixture(mode);
      const result = await new RecordActionContextMcpTool(fixture.executor).exec({ ...input, draftFields });
      if (mode === 'ENFORCE') {
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent?.errorCode, 'MCP_RECORD_ACTION_CONTEXT_INVALID');
        assert.equal(fixture.evidence[0]?.failureKind, 'USER_INPUT_ERROR');
      } else assert.deepStrictEqual(result.structuredContent, legacy);
    }
  }
  for (const property of ['calculated', 'autoNumber']) {
    const fixture = runtimeFixture('SHADOW');
    Object.assign(fixture.fields.Name!, { [property]: true });
    const baseline = await fixture.legacy.execute(input);
    assert.deepStrictEqual(await fixture.executor.execute({ ...input, draftFields: { Name: 'x' } }), baseline);
    assert.equal(fixture.evidence[0]?.failureKind, 'USER_INPUT_ERROR');
  }
});

test('Case A: ENFORCE + resolved PAGE_LAYOUT + invalid draftFields returns exact pre-P8-04 legacy', async (t) => {
  t.mock.method(performance, 'now', () => 1000);
  const fixture = runtimeFixture('ENFORCE', pageLayout());
  const result = await new RecordActionContextMcpTool(fixture.executor).exec({ ...input, draftFields: { NoFls__c: 'x' } });
  assert.deepStrictEqual(result.structuredContent, legacy);
  assert.deepStrictEqual(result.content, [{ type: 'text', text: JSON.stringify(legacy) }]);
  assert.equal(result.isError, undefined);
  assert.equal(fixture.evidence[0]?.usedForAgent, false);
  assert.equal(fixture.evidence[0]?.formSource, 'PAGE_LAYOUT');
  assert.equal(fixture.evidence[0]?.failureKind, undefined);
});

test('Case B: ENFORCE + APP_CONTEXT_REQUIRED fallback + invalid draftFields returns exact legacy', async (t) => {
  t.mock.method(performance, 'now', () => 1000);
  const fixture = runtimeFixture('ENFORCE', appRequired());
  const result = await new RecordActionContextMcpTool(fixture.executor).exec({ ...input, draftFields: { NoFls__c: 'x' } });
  assert.deepStrictEqual(result.structuredContent, legacy);
  assert.equal(result.isError, undefined);
  assert.equal(fixture.evidence[0]?.usedForAgent, false);
  assert.equal(fixture.evidence[0]?.fallbackReason, 'APP_CONTEXT_REQUIRED');
});

test('Case C: ENFORCE + snapshot/parser fallback + invalid draftFields returns exact legacy', async (t) => {
  t.mock.method(performance, 'now', () => 1000);
  const invalid = { NoFls__c: 'x' } as NonNullable<RecordActionContextInput['draftFields']>;
  const fallbacks: Array<{ name: string; snapshot: () => UiSnapshot | null; reason: string }> = [
    { name: 'snapshot missing', snapshot: () => null, reason: 'SNAPSHOT_MISSING' },
    { name: 'parser failure', snapshot: () => ({ ...fixtureSnapshot(), parserVersion: 'invalid' }) as unknown as UiSnapshot, reason: 'PARSER_ERROR' },
  ];
  for (const fallback of fallbacks) {
    const fixture = runtimeFixture('ENFORCE', fallback.snapshot());
    const result = await new RecordActionContextMcpTool(fixture.executor).exec({ ...input, draftFields: invalid });
    assert.deepStrictEqual(result.structuredContent, legacy, fallback.name);
    assert.equal(result.isError, undefined, fallback.name);
    assert.equal(fixture.evidence[0]?.usedForAgent, false, fallback.name);
    assert.equal(fixture.evidence[0]?.fallbackReason, fallback.reason, fallback.name);
    assert.equal(fixture.evidence[0]?.failureKind, 'DYNAMIC_RESOLUTION_FAILURE', fallback.name);
  }
});

test('Case D: ENFORCE + supported DYNAMIC_FORMS + invalid draftFields stays a structured MCP_RECORD_ACTION_CONTEXT_INVALID', async (t) => {
  t.mock.method(performance, 'now', () => 1000);
  const snapshot = fixtureSnapshot();
  snapshot.pages[0]!.formSource = 'DYNAMIC_FORMS';
  const fixture = runtimeFixture('ENFORCE', snapshot);
  const result = await new RecordActionContextMcpTool(fixture.executor).exec({ ...input, draftFields: { NoFls__c: 'x' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.errorCode, 'MCP_RECORD_ACTION_CONTEXT_INVALID');
  assert.equal(fixture.evidence[0]?.failureKind, 'USER_INPUT_ERROR');
  assert.equal(fixture.evidence[0]?.usedForAgent, false);
});

test('original USER platform, object and record-type failures retain legacy error semantics in SHADOW', async (t) => {
  for (const layer of ['object-info', 'record-defaults', 'picklist-values', 'recordType', 'object', 'identity']) {
    const fixture = runtimeFixture('SHADOW');
    if (layer === 'identity') t.mock.method(fixture.org, 'getConnection', async () => { throw new Error('ORIGINAL_IDENTITY_FAILURE'); });
    else {
      const request = fixture.connection.request.bind(fixture.connection);
      t.mock.method(fixture.connection, 'request', (arg: { url: string; method: 'GET' }) => {
        if (arg.url.includes(`/${layer}/`)) throw new Error('ORIGINAL_UI_API_FAILURE');
        return request(arg);
      });
    }
    const invalid = { ...input, ...(layer === 'recordType' ? { recordTypeId: '012000000000099AAA' } : {}),
      ...(layer === 'object' ? { objectApiName: 'Wrong__c' } : {}) };
    const expected = await new RecordActionContextMcpTool(fixture.legacy).exec(invalid);
    assert.equal(expected.isError, true);
    assert.deepStrictEqual(await new RecordActionContextMcpTool(fixture.executor).exec(invalid), expected);
    assert.equal(fixture.evidence.length, 0);
  }
});

test('ContextRuntimeError from extra infrastructure is a fallback in ENFORCE, not a user input error', async (t) => {
  t.mock.method(performance, 'now', () => 1000);
  const fixture = runtimeFixture('ENFORCE', fixtureSnapshot(), undefined, {
    loadSnapshot: async () => { throw new ContextRuntimeError('MCP_RECORD_ACTION_CONTEXT_INVALID', 'SNAPSHOT_ERROR'); },
  });
  assert.deepStrictEqual(await fixture.executor.execute(input), legacy);
  assert.equal(fixture.evidence[0]?.failureKind, 'DYNAMIC_RESOLUTION_FAILURE');
});

test('synchronous and asynchronous Audit failures cannot change SHADOW results', async (t) => {
  t.mock.method(performance, 'now', () => 1000);
  for (const audit of [() => { throw new Error('AUDIT_WRITE_ERROR'); }, async () => { throw new Error('AUDIT_WRITE_ERROR'); }]) {
    const fixture = runtimeFixture('SHADOW', fixtureSnapshot(), undefined, { audit });
    assert.deepStrictEqual(await fixture.executor.execute(input), legacy);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});

test('Dynamic Forms and validated MIXED ENFORCE still expose effective fields and matching provenance', async (t) => {
  t.mock.method(performance, 'now', () => 1000);
  for (const formSource of ['DYNAMIC_FORMS', 'MIXED'] as const) {
    const snapshot = fixtureSnapshot(); snapshot.pages[0]!.formSource = formSource;
    const fixture = runtimeFixture('ENFORCE', snapshot);
    const result = await fixture.executor.execute({ ...input, draftFields: { Type__c: 'Partner', Managed__c: 'explicit' } });
    recordActionContextOutputSchema.parse(result);
    assert.equal(result.uiContext?.formSource, formSource);
    assert.equal(result.uiContext?.fallbackUsed, false);
    assert.ok(result.uiContextResolutionId);
    assert.equal(result.uiContext?.resolutionId, result.uiContextResolutionId);
    assert.equal(fixture.evidence[0]?.resolutionId, result.uiContextResolutionId);
    assert.equal(fixture.evidence[0]?.usedForAgent, true);
    assert.equal(result.fields?.find((field) => field.apiName === 'Discount__c')?.visibilityState, 'VISIBLE');
    assert.equal(result.fields?.find((field) => field.apiName === 'Managed__c')?.optionalCandidate, false);
    for (const key of Object.keys(legacy).filter((key) => !['fields', 'coverage'].includes(key))) {
      assert.deepStrictEqual(result[key as keyof typeof result], legacy[key], key);
    }
    assert.equal(result.fields?.find((field) => field.apiName === 'Name')?.defaultValue, 'Default name');
  }
});

test('stale snapshots retain timestamp and hash in Audit while SHADOW remains exact legacy', async (t) => {
  t.mock.method(performance, 'now', () => 1000);
  for (const status of ['READY', 'FAILED', 'REFRESHING'] as const) {
    const fixture = runtimeFixture('SHADOW', fixtureSnapshot(), undefined, { loadSnapshot: async () => ({
      id: '1', organizationId: '00D000000000001AAA', objectApiName: 'Sample__c', snapshot: fixtureSnapshot(),
      hash: 'f'.repeat(64), refreshedAt: '2020-01-01T00:00:00Z', lastModified: null, status, lastError: null, parserVersion: UI_PARSER_VERSION,
    }) });
    assert.deepStrictEqual(await fixture.executor.execute(input), legacy);
    assert.equal(fixture.evidence[0]?.snapshotWarning, 'SNAPSHOT_STALE');
    assert.equal((fixture.evidence[0]?.snapshot as { hash: string }).hash, 'f'.repeat(64));
    assert.equal((fixture.evidence[0]?.snapshot as { refreshedAt: string }).refreshedAt, '2020-01-01T00:00:00Z');
  }
});

test('extra reads share one 3s budget and never start app discovery after expiry', async (t) => {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const fixture = runtimeFixture('SHADOW', fixtureSnapshot(), undefined, { loadSnapshot: async () => {
    now += 1500;
    return { id: '1', organizationId: '00D000000000001AAA', objectApiName: 'Sample__c', snapshot: fixtureSnapshot(),
      hash: 'f'.repeat(64), refreshedAt: new Date().toISOString(), lastModified: null, status: 'READY', lastError: null, parserVersion: UI_PARSER_VERSION };
  } });
  const getUserInfo = fixture.connection.soap.getUserInfo.bind(fixture.connection.soap);
  t.mock.method(fixture.connection.soap, 'getUserInfo', async () => { now += 1600; return getUserInfo(); });
  assert.deepStrictEqual(await fixture.executor.execute(input), legacy);
  assert.equal(fixture.counts().userCalls, 1);
  assert.equal(fixture.evidence[0]?.additionalUserApiCallCount, 1);
  assert.equal(fixture.evidence[0]?.fallbackReason, 'UI_CONTEXT_READ_TIMEOUT');
});

test('SHADOW integration latency sample (in-memory USER and snapshot fixtures, no network)', async (t) => {
  const durations: number[] = [];
  for (let index = 0; index < 110; index++) {
    const fixture = runtimeFixture('SHADOW');
    const resolve = fixture.resolver.resolve.bind(fixture.resolver);
    t.mock.method(fixture.resolver, 'resolve', async (...args: Parameters<typeof resolve>) => {
      const start = performance.now(); const result = await resolve(...args);
      if (index >= 10) durations.push(performance.now() - start);
      return result;
    });
    await fixture.executor.execute(input);
  }
  durations.sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ samples: durations.length, p50Ms: durations[49], p95Ms: durations[94], source: 'in-memory integration; not Salesforce latency' }));
});

test('a never-settling Shadow USER read times out and returns the exact legacy response', { timeout: 10000 }, async (t) => {
  t.mock.method(performance, 'now', () => 1000);
  const fixture = runtimeFixture('SHADOW');
  t.mock.method(fixture.connection.soap, 'getUserInfo', () => new Promise<never>(() => undefined));
  assert.deepStrictEqual(await fixture.executor.execute(input), legacy);
  assert.equal(fixture.evidence[0]?.fallbackReason, 'UI_CONTEXT_READ_TIMEOUT');
  assert.equal(fixture.evidence[0]?.usedForAgent, false);
  assert.equal(fixture.counts().snapshotCalls, 0);
});

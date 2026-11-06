import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import { collectRecentFieldRecommendations } from '../precision-recommendations.js';
import { objectInfoSchema } from '../ui-api.js';

const RT = '012000000000001AAA';
const now = new Date('2026-11-06T08:00:00.000Z');
const names = ['Notes__c', 'Flag__c', 'Score__c', 'Rare__c', 'Hidden__c'];
function objectInfo() {
  return objectInfoSchema.parse({ apiName: 'Sample__c', label: 'Sample', labelPlural: 'Samples', defaultRecordTypeId: RT,
    recordTypeInfos: { [RT]: { recordTypeId: RT, name: 'Business', available: true, defaultRecordTypeMapping: true } },
    fields: Object.fromEntries(['Id', 'CreatedDate', 'RecordTypeId', ...names].map((apiName) => [apiName, {
      apiName, label: apiName, dataType: 'String', required: false, createable: true, updateable: true,
    }])), });
}
function rows(count: number) {
  return Array.from({ length: count }, (_, i) => ({ Id: `a00${String(i).padStart(12, '0')}`, CreatedDate: '2026-11-01T00:00:00.000Z',
    RecordTypeId: RT, Notes__c: i % 5 === 0 ? null : 'present', Flag__c: false, Score__c: 0, Rare__c: '', Hidden__c: 'present' }));
}
function fixture(records = rows(20), extra: Record<string, unknown> = {}) {
  const queries: string[] = [];
  const connection = { getApiVersion: () => '67.0', request: async ({ url }: { url: string }) => {
    queries.push(new URL(url, 'https://example.test').searchParams.get('q') ?? '');
    return { records, done: true, totalSize: records.length, ...extra };
  } } as unknown as Connection;
  return { connection, queries };
}
const candidates = names.map((apiName) => ({ apiName, label: apiName, visible: apiName !== 'Hidden__c', writable: true, optional: true, taskRelevant: true }));
const input = () => ({ objectInfo: objectInfo(), recordTypeId: RT, action: 'CREATE' as const, candidates, now });

test('recent current-nonempty statistics keep false and zero and return at most three optional suggestions', async () => {
  const f = fixture();
  const result = await collectRecentFieldRecommendations(f.connection, input());
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.measure, 'CURRENT_NONEMPTY_ON_RECENTLY_CREATED_RECORDS');
  assert.equal(result.sampleCount, 20);
  assert.deepEqual(result.recommendations.map((r) => [r.apiName, r.nonEmptyCount]), [['Flag__c', 20], ['Score__c', 20], ['Notes__c', 16]]);
  assert.equal(f.queries.length, 1);
  assert.match(f.queries[0]!, /RecordTypeId = '012000000000001AAA'/u);
  assert.match(f.queries[0]!, /CreatedDate >= 2026-10-07T08:00:00.000Z/u);
  assert.match(f.queries[0]!, /ORDER BY CreatedDate DESC, Id DESC LIMIT 201$/u);
  assert.equal(f.queries[0]!.includes('Hidden__c'), false);
});

test('small samples do not widen Record Type or time window', async () => {
  const f = fixture(rows(19));
  const result = await collectRecentFieldRecommendations(f.connection, input());
  assert.equal(result.status, 'INSUFFICIENT_SAMPLE');
  assert.deepEqual(result.recommendations, []);
  assert.equal(f.queries.length, 1);
});

test('sample bounds remain explicit and never claim full population coverage', async () => {
  const f = fixture(rows(21));
  const result = await collectRecentFieldRecommendations(f.connection, { ...input(), policy: { sampleLimit: 20 } });
  assert.equal(result.sampleCount, 20);
  assert.equal(result.truncated, true);
  assert.equal(result.population, 'BOUNDED_RECENT_SAMPLE');
});

test('missing or out-of-scope fields and records invalidate evidence instead of reducing the denominator', async () => {
  for (const change of [
    (record: Record<string, unknown>): void => { delete record.Notes__c; },
    (record: Record<string, unknown>): void => { record.RecordTypeId = '012000000000002AAA'; },
    (record: Record<string, unknown>): void => { record.CreatedDate = '2025-01-01T00:00:00.000Z'; },
    (record: Record<string, unknown>): void => { record.Score__c = { unsafe: 'object' }; },
  ]) {
    const records = rows(20); change(records[0]!);
    const result = await collectRecentFieldRecommendations(fixture(records).connection, input());
    assert.equal(result.status, 'UNAVAILABLE');
    assert.deepEqual(result.recommendations, []);
  }
});

test('irrelevant, non-writable and required fields cause no statistical query', async () => {
  const f = fixture();
  const args = input();
  for (const field of Object.values(args.objectInfo.fields)) field.createable = false;
  const result = await collectRecentFieldRecommendations(f.connection, args);
  assert.equal(result.status, 'NO_CANDIDATES');
  assert.equal(f.queries.length, 0);
});

test('default implicit Master does not require a nonexistent RecordTypeId column', async () => {
  const args = input();
  const master = '012000000000000AAA';
  delete args.objectInfo.fields.RecordTypeId;
  args.objectInfo.recordTypeInfos = { [master]: { recordTypeId: master, name: 'Master', available: true, defaultRecordTypeMapping: true, master: true } };
  const f = fixture();
  const result = await collectRecentFieldRecommendations(f.connection, { ...args, recordTypeId: master });
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(f.queries[0]!.includes('RecordTypeId'), false);
});

test('USER query failure produces no default suggestion or cross-user fallback', async () => {
  const connection = { getApiVersion: () => '67.0', request: async () => { throw new Error('NO_ACCESS'); } } as unknown as Connection;
  const result = await collectRecentFieldRecommendations(connection, input());
  assert.equal(result.status, 'UNAVAILABLE');
  assert.deepEqual(result.recommendations, []);
});

test('Master on a Record Type enabled object uses the null predicate and does not mix business types', async () => {
  const args = input();
  const master = '012000000000000AAA';
  args.objectInfo.recordTypeInfos[master] = { recordTypeId: master, name: 'Master', available: true, defaultRecordTypeMapping: false, master: true };
  const records = rows(20).map((row) => ({ ...row, RecordTypeId: null }));
  const queries: string[] = [];
  const connection = { getApiVersion: () => '67.0', request: async ({ url }: { url: string }) => {
    queries.push(new URL(url, 'https://example.test').searchParams.get('q')!);
    return { records, done: true, totalSize: 20 };
  } } as unknown as Connection;
  const result = await collectRecentFieldRecommendations(connection, { ...args, recordTypeId: master });
  assert.equal(result.status, 'AVAILABLE');
  assert.match(queries[0]!, /RecordTypeId = null/u);
  delete args.objectInfo.fields.RecordTypeId;
  const unreadable = await collectRecentFieldRecommendations(connection, { ...args, recordTypeId: master });
  assert.equal(unreadable.reason, 'RECORD_TYPE_FILTER_UNAVAILABLE');
  assert.equal(queries.length, 1);
});

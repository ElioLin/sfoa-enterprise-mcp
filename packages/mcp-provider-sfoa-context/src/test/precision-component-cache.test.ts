import assert from 'node:assert/strict';
import test from 'node:test';
import { PrecisionComponentCache, precisionComponentRevision, type PrecisionComponentKey } from '../precision-component-cache.js';

const key: PrecisionComponentKey = { organizationId: '00D000000000001AAA', apiVersion: '68.0', parserVersion: 'parser-1',
  type: 'CustomApplication', fullName: 'Sample_App' };
const revision = { id: '02u000000000001AAA', lastModifiedDate: '2026-11-06T00:00:00.000Z' };

test('component config is isolated by org, type, identity, API/parser and fresh revision', () => {
  const cache = new PrecisionComponentCache(); cache.set(key, revision, { assignments: ['one'] });
  for (const other of [{ ...key, organizationId: '00D000000000002AAA' }, { ...key, apiVersion: '67.0' },
    { ...key, parserVersion: 'parser-2' }, { ...key, fullName: 'Another_App' }, { ...key, type: 'Profile' as const }]) {
    assert.equal(cache.get(other, revision), undefined);
  }
  const first = cache.get(key, revision)!; (first.assignments as string[]).push('mutated');
  assert.deepEqual(cache.get(key, revision), { assignments: ['one'] });
  assert.equal(cache.get(key, { ...revision, id: '02u000000000002AAA' }), undefined);
  cache.set(key, revision, { assignments: ['one'] });
  assert.equal(cache.get(key, { ...revision, lastModifiedDate: '2026-11-06T00:00:01.000Z' }), undefined);
});

test('LRU has an actual bounded entry count and rejects unversioned or oversized values', () => {
  const cache = new PrecisionComponentCache(1, 100);
  cache.set(key, revision, { value: 1 });
  const other = { ...key, fullName: 'Second' }; cache.set(other, revision, { value: 2 });
  assert.equal(cache.get(key, revision), undefined); assert.deepEqual(cache.get(other, revision), { value: 2 });
  cache.set(other, revision, { value: 'x'.repeat(101) }); assert.equal(cache.get(other, revision), undefined);
  cache.set(key, { ...revision, lastModifiedDate: '1970-01-01T00:00:00.000Z' }, { value: 1 });
  assert.equal(cache.get(key, revision), undefined);
  cache.set(key, revision, { value: 1 }); cache.clear();
  assert.equal(cache.get(key, revision), undefined);
  cache.set(key, revision, { value: 2 }); assert.deepEqual(cache.get(key, revision), { value: 2 });
  assert.equal(precisionComponentRevision({ id: revision.id, lastModifiedDate: 'not a date' }), undefined);
  assert.equal(precisionComponentRevision({ id: '', lastModifiedDate: revision.lastModifiedDate }), undefined);
});

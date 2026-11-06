import assert from 'node:assert/strict';
import test from 'node:test';
import { UI_PARSER_VERSION, type PrecisionMetadata, type PrecisionMetadataRequest } from '@sfoa/mcp-provider-sfoa-context';
import { FormMetadataCache } from '../form-metadata-cache.js';

const request: PrecisionMetadataRequest = { organizationId: '00D000000000001AAA', profileId: '00e000000000001AAA',
  objectApiName: 'Account', recordTypeId: '012000000000001AAA', action: 'CREATE', accessibleApps: [] };
const metadata: PrecisionMetadata = { appDeveloperName: 'Sales_App', appSource: 'PROFILE_DEFAULT',
  verifiedAt: '2026-11-06T01:00:00.000Z', apiCallCount: 10, evidence: { freshness: 'FRESH_READ' },
  snapshot: { organizationId: request.organizationId, objectApiName: request.objectApiName,
    parserVersion: UI_PARSER_VERSION, complete: true, apps: [], profiles: [], recordTypes: [], assignments: [], pages: [] } };

test('only an explicitly referenced same-principal refinement reuses structure and retains original verification time', () => {
  const cache = new FormMetadataCache();
  const inserted = cache.put('user-a/client-a', request, metadata);
  const refine = { ...request, phase: 'REFINE' as const, structuralContextRef: inserted.structuralContextRef };
  const hit = cache.get('user-a/client-a', refine)!;
  assert.equal(hit.cache, 'TASK_REUSE'); assert.equal(hit.apiCallCount, 0);
  assert.equal(hit.verifiedAt, metadata.verifiedAt);
  assert.equal(cache.get('user-b/client-a', refine), undefined);
  assert.equal(cache.get('user-a/client-b', refine), undefined);
  assert.equal(cache.get('user-a/client-a', { ...refine, phase: 'START' }), undefined);
  assert.equal(cache.get('user-a/client-a', { ...refine, phase: 'SUBMIT' }), undefined);
  assert.equal(cache.get('user-a/client-a', { ...refine, structuralContextRef: undefined }), undefined);
  for (const other of [{ objectApiName: 'Lead' }, { profileId: '00e000000000002AAA' },
    { organizationId: '00D000000000002AAA' }, { action: 'UPDATE' as const }, { recordTypeId: '012000000000002AAA' },
    { appDeveloperName: 'Other_App' }]) assert.equal(cache.get('user-a/client-a', { ...refine, ...other }), undefined);
  hit.snapshot.objectApiName = 'Changed';
  assert.equal(cache.get('user-a/client-a', refine)?.snapshot.objectApiName, 'Account');
});

test('bounded structural references expire, evict and clear without falling back to another task', () => {
  let now = 0;
  const cache = new FormMetadataCache(() => now);
  const first = cache.put('user', request, metadata);
  const query = { ...request, phase: 'REFINE' as const, structuralContextRef: first.structuralContextRef };
  now = 600001;
  assert.equal(cache.get('user', query), undefined);
  const second = cache.put('user', request, metadata);
  for (let i = 0; i < 32; i++) cache.put('user', request, metadata);
  assert.equal(cache.get('user', { ...query, structuralContextRef: second.structuralContextRef }), undefined);
  const last = cache.put('user', request, metadata);
  cache.clear();
  assert.equal(cache.get('user', { ...query, structuralContextRef: last.structuralContextRef }), undefined);
});

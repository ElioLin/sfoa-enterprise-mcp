import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import { DmlExecutor, parseDmlAllowlistJson, type BatchDmlOutput } from '../index.js';

// Contract fixture for the sequential phases described by the canonical Playbook.
// This exercises real executor results; it is not a substitute for live Agent UAT.
const objects = ['Root__c', 'InternalParticipant__c', 'CustomerParticipant__c'];
const sfId = (index: number) => `a000000000${String(index).padStart(5, '0')}AAA`;
type Failure = 'NONE' | 'ROOT_FAILED' | 'ROOT_UNKNOWN' | 'CHILD_PARTIAL';
async function scenario(rootCount: number, children: readonly string[], failure: Failure = 'NONE') {
  const calls: { object: string; records: Record<string, unknown>[] }[] = [];
  const connection = { getApiVersion: () => '67.0', sobject: (object: string) => ({
    create: async (input: Record<string, unknown> | Record<string, unknown>[]) => {
      const records = Array.isArray(input) ? input : [input]; calls.push({ object, records });
      if (object === 'Root__c' && failure === 'ROOT_UNKNOWN') throw new Error('response lost');
      const results = records.map((_row, index) => {
        const rejected = (object === 'Root__c' && failure === 'ROOT_FAILED')
          || (object === 'InternalParticipant__c' && failure === 'CHILD_PARTIAL' && index === 1);
        return rejected ? { success: false, errors: [{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Rejected' }] }
          : { success: true, id: sfId(100 * calls.length + index), errors: [] };
      });
      return Array.isArray(input) ? results : results[0];
    },
  }) } as unknown as Connection;
  const service = { getAllowedOrgUsernames: async () => new Set(['request-user']),
    getConnection: async (name: string) => { assert.equal(name, 'request-user'); return connection; } } as unknown as OrgService;
  const executor = new DmlExecutor(service, parseDmlAllowlistJson(JSON.stringify(objects.map((objectApiName) => ({ objectApiName, operations: ['CREATE'] })))));
  const roots = await executor.createRecords({ objectApiName: 'Root__c', allOrNone: false,
    records: Array.from({ length: rootCount }, (_, index) => ({ clientReferenceId: `root-${index}`, fields: { Name: `Root ${index}` } })) });
  const phases: BatchDmlOutput[] = [roots];
  const mapping = new Map(roots.results.filter((row) => row.success).map((row) => [row.clientReferenceId, row.recordId!]));
  // Unknown stops automatic continuation. Failed roots cannot receive children.
  if (roots.status !== 'OUTCOME_UNKNOWN' && mapping.size) for (const objectApiName of children) {
    // Deliberately reverse root order: correlation uses references, not positions.
    const records = [...mapping.keys()].reverse().flatMap((reference) => [0, 1].map((index) => ({
      clientReferenceId: `${reference}-child-${index}`, fields: { Root__c: mapping.get(reference)!, Name: `Child ${index}` },
    })));
    phases.push(await executor.createRecords({ objectApiName, allOrNone: false, records }));
  }
  const status = phases.some((phase) => phase.status === 'OUTCOME_UNKNOWN') ? 'OUTCOME_UNKNOWN'
    : phases.every((phase) => phase.status === 'SUCCESS') ? 'SUCCESS'
      : phases.some((phase) => phase.succeeded > 0) ? 'PARTIAL_SUCCESS' : 'FAILED';
  return { calls, phases, mapping, status };
}

for (const children of [[], ['InternalParticipant__c'], ['InternalParticipant__c', 'CustomerParticipant__c']]) {
  test(`compound root + ${children.length} requested child types uses proven IDs and exact intent`, async () => {
    const result = await scenario(1, children);
    assert.equal(result.status, 'SUCCESS'); assert.equal(result.calls.length, 1 + children.length);
    assert.deepEqual(result.calls.map((call) => call.object), ['Root__c', ...children]);
    for (const call of result.calls.slice(1)) assert.ok(call.records.every((row) => row.Root__c === result.mapping.get('root-0')));
  });
}
test('multiple roots correlate child Lookups by explicit references despite different phase ordering', async () => {
  const result = await scenario(5, objects.slice(1));
  assert.equal(result.calls.length, 3); assert.equal(result.mapping.size, 5);
  for (const call of result.calls.slice(1)) for (const [index, row] of call.records.entries()) {
    assert.equal(row.Root__c, result.mapping.get(`root-${4 - Math.floor(index / 2)}`));
    assert.equal(row.clientReferenceId, undefined);
  }
});
test('child partial failure preserves root success and reports incomplete intent without rollback', async () => {
  const result = await scenario(1, objects.slice(1), 'CHILD_PARTIAL');
  assert.equal(result.status, 'PARTIAL_SUCCESS');
  assert.deepEqual(result.phases.map((phase) => phase.status), ['SUCCESS', 'PARTIAL_SUCCESS', 'SUCCESS']);
  // Exactly one collection request per phase, in intent order: nothing was retried or re-created.
  assert.equal(result.calls.length, 3);
  assert.deepEqual(result.calls.map((call) => call.object), objects);
  const child = result.phases[1]!;
  assert.equal(child.succeeded, 1); assert.equal(child.failed, 1); assert.equal(child.unknown, 0);
  assert.equal(child.results[1]?.salesforceErrors?.[0]?.errorCode, 'FIELD_CUSTOM_VALIDATION_EXCEPTION');
  // The committed root and the successful child keep their proven IDs; no root is deleted.
  assert.equal(result.phases[0]?.status, 'SUCCESS');
  assert.ok(result.mapping.get('root-0'));
  assert.ok(child.results.find((row) => row.success)?.recordId);
});
test('after a partial child batch only the failed item qualifies for re-preparation', async () => {
  const result = await scenario(1, objects.slice(1), 'CHILD_PARTIAL');
  const child = result.phases[1]!;
  const committed = child.results.filter((row) => row.success).map((row) => row.clientReferenceId);
  const reprepared = child.results.filter((row) => !row.success).map((row) => row.clientReferenceId);
  assert.equal(committed.length, 1); assert.equal(reprepared.length, 1);
  assert.equal(committed.some((reference) => reprepared.includes(reference)), false);
  // clientReferenceId is correlation, not an idempotency key: resubmitting a committed row
  // would create a second Salesforce record rather than being deduplicated.
  assert.equal(JSON.stringify(reprepared).includes(String(committed[0])), false);
});
for (const failure of ['ROOT_FAILED', 'ROOT_UNKNOWN'] as const) test(`${failure} creates no children and cannot complete intent`, async () => {
  const result = await scenario(2, objects.slice(1), failure);
  assert.equal(result.calls.length, 1); assert.equal(result.mapping.size, 0);
  assert.equal(result.status, failure === 'ROOT_FAILED' ? 'FAILED' : 'OUTCOME_UNKNOWN');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RequestAuditContextController,
  type AuditSnapshot,
  type RuntimeLogEvent,
} from '@sfoa/identity-runtime';
import {
  AsyncAuditPipeline,
  AuditBatchPersistenceError,
  type AuditBatchSink,
  type AuditQueueEntry,
} from '../audit-pipeline.js';

test('bounded Queue offer with large Payload is synchronous and Queue Full degrades without blocking Tool outcome', async () => {
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const sink: AuditBatchSink = { persist: async () => blocked };
  const fallback: RuntimeLogEvent[] = [];
  const pipeline = new AsyncAuditPipeline(sink, { log: (event) => { fallback.push(event); } }, {
    capacity: 1, batchSize: 1, flushIntervalMs: 0, retryAttempts: 0,
  });
  const first = snapshot('00000000-0000-4000-8000-000000000001', 'A', true);
  const second = snapshot('00000000-0000-4000-8000-000000000002', 'B', true);
  const started = performance.now();
  assert.equal(pipeline.offerSnapshot(first), true);
  assert.equal(pipeline.offerSnapshot(second), false);
  assert.ok(performance.now() - started < 50);
  assert.equal(pipeline.getHealth().queueFullCount, 1);
  assert.equal(pipeline.getHealth().droppedSnapshots, 1);
  assert.equal(pipeline.getHealth().status, 'DEGRADED');
  release?.();
  const closed = await pipeline.close(1_000);
  assert.equal(closed.flushed, true);
  assert.equal(pipeline.getHealth().persistedSnapshots, 1);
  assert.equal(fallback.some((event) => event.errorCode === 'MCP_AUDIT_QUEUE_FULL'), true);
});

test('Writer batches multiple snapshots and performs bounded shutdown flush', async () => {
  const batches: (readonly AuditQueueEntry[])[] = [];
  const sink: AuditBatchSink = { persist: async (entries) => { batches.push([...entries]); } };
  const pipeline = new AsyncAuditPipeline(sink, { log: () => undefined }, {
    capacity: 10, batchSize: 5, flushIntervalMs: 25, retryAttempts: 0,
  });
  for (let index = 0; index < 5; index += 1) {
    assert.equal(pipeline.offerSnapshot(snapshot(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, `M${index}`)), true);
  }
  const result = await pipeline.close(1_000);
  assert.equal(result.flushed, true);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.length, 5);
  assert.equal(pipeline.getHealth().persistedSnapshots, 5);
  assert.equal(pipeline.getHealth().writerState, 'STOPPED');
});

test('Writer exception and Audit DB down are fail-open and bounded retry degrades health', async () => {
  let attempts = 0;
  const pipeline = new AsyncAuditPipeline({
    persist: async () => { attempts += 1; throw new Error('database unavailable'); },
  }, { log: () => undefined }, { retryAttempts: 1, retryBaseDelayMs: 1, flushIntervalMs: 0 });
  assert.doesNotThrow(() => pipeline.offerSnapshot(snapshot('00000000-0000-4000-8000-000000000010', 'DB_DOWN')));
  const result = await pipeline.close(1_000);
  assert.equal(result.flushed, true);
  assert.equal(attempts, 2);
  assert.equal(pipeline.getHealth().droppedSnapshots, 1);
  assert.equal(pipeline.getHealth().writerFailureCount >= 2, true);
  assert.equal(pipeline.getHealth().status, 'DEGRADED');
});

test('synchronously failing operational fallback cannot escape Queue failure handling', async () => {
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const pipeline = new AsyncAuditPipeline({ persist: async () => blocked }, {
    log: () => { throw new Error('fallback unavailable'); },
  }, { capacity: 1, batchSize: 1, flushIntervalMs: 0, retryAttempts: 0 });
  assert.equal(pipeline.offerSnapshot(snapshot('00000000-0000-4000-8000-000000000011', 'FIRST')), true);
  assert.doesNotThrow(() => pipeline.offerSnapshot(snapshot('00000000-0000-4000-8000-000000000012', 'SECOND')));
  release?.();
  await pipeline.close(1_000);
});

test('non-retryable poison snapshot is isolated and cannot block valid snapshots', async () => {
  const persisted: string[] = [];
  const sink: AuditBatchSink = {
    persist: async (entries) => {
      if (entries.length > 1) throw new AuditBatchPersistenceError('poison batch', false);
      const entry = entries[0];
      if (entry?.kind === 'SNAPSHOT' && entry.snapshot.auditCall.toolName === 'POISON') {
        throw new AuditBatchPersistenceError('poison snapshot', false);
      }
      if (entry?.kind === 'SNAPSHOT') persisted.push(entry.snapshot.auditCall.toolName);
    },
  };
  const pipeline = new AsyncAuditPipeline(sink, { log: () => undefined }, {
    batchSize: 2, flushIntervalMs: 20, retryAttempts: 0,
  });
  pipeline.offerSnapshot(snapshot('00000000-0000-4000-8000-000000000020', 'POISON'));
  pipeline.offerSnapshot(snapshot('00000000-0000-4000-8000-000000000021', 'VALID'));
  await pipeline.close(1_000);
  assert.deepEqual(persisted, ['VALID']);
  assert.equal(pipeline.getHealth().persistedSnapshots, 1);
  assert.equal(pipeline.getHealth().droppedSnapshots, 1);
});

test('simulated five-second Writer never delays request-side Queue offer', async () => {
  const sink: AuditBatchSink = { persist: async () => new Promise((resolve) => setTimeout(resolve, 5_000)) };
  const pipeline = new AsyncAuditPipeline(sink, { log: () => undefined }, {
    batchSize: 1, flushIntervalMs: 0, retryAttempts: 0,
  });
  const started = performance.now();
  const offered = pipeline.offerSnapshot(snapshot('00000000-0000-4000-8000-000000000030', 'SLOW'));
  const requestElapsed = performance.now() - started;
  assert.equal(offered, true);
  assert.ok(requestElapsed < 50, `Queue offer took ${requestElapsed}ms`);
  const result = await pipeline.close(6_000);
  assert.equal(result.flushed, true);
  assert.equal(pipeline.getHealth().persistedSnapshots, 1);
});

test('shutdown timeout is bounded and accounts for an in-flight Snapshot as dropped', async () => {
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const pipeline = new AsyncAuditPipeline({ persist: async () => blocked }, { log: () => undefined }, {
    batchSize: 1, flushIntervalMs: 0, retryAttempts: 0,
  });
  pipeline.offerSnapshot(snapshot('00000000-0000-4000-8000-000000000040', 'SHUTDOWN'));
  await waitFor(() => pipeline.getHealth().writerState === 'WRITING');
  const started = performance.now();
  const result = await pipeline.close(20);
  assert.ok(performance.now() - started < 250);
  assert.equal(result.flushed, false);
  assert.equal(result.dropped, 1);
  assert.equal(pipeline.getHealth().droppedSnapshots, 1);
  release?.();
  await waitFor(() => pipeline.getHealth().writerState === 'STOPPED');
  assert.equal(pipeline.getHealth().persistedSnapshots, 0);
});

function snapshot(auditId: string, marker: string, largePayload = false): AuditSnapshot {
  const context = RequestAuditContextController.create({
    correlationId: `correlation-${marker}`, channel: 'MCP_HTTP', toolName: marker,
  }, () => auditId, () => new Date('2026-08-30T00:00:00.000Z'));
  context.collector().record({
    eventCategory: 'TOOL', eventType: 'TOOL_TERMINAL', eventName: marker, status: 'SUCCESS',
    terminal: { source: 'TOOL', result: 'PASS', outcome: 'SUCCESS' },
  });
  if (largePayload) {
    context.collector().recordPayloadEvidence({
      payloadType: 'MCP_RESPONSE', contentType: 'application/json',
      payload: JSON.stringify({ marker, data: 'Q'.repeat(2 * 1024 * 1024) }),
    });
  }
  const finalized = context.finalizeAudit(new Date('2026-08-30T00:00:00.010Z'));
  assert.ok(finalized);
  return finalized;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Audit pipeline state.');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

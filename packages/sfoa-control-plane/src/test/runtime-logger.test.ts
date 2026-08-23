import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeLogEvent, RuntimeLogger } from '@sfoa/identity-runtime';
import { DatabaseRuntimeLogger } from '../runtime-logger.js';
import type { AuditRepository, AuditWrite } from '../repositories.js';
import { InMemoryControlPlaneStore } from './in-memory-store.js';

test('database logger writes safe structured runtime events', async () => {
  const store = new InMemoryControlPlaneStore();
  const fallbackEvents: RuntimeLogEvent[] = [];
  const fallback: RuntimeLogger = { log: (event) => { fallbackEvents.push(event); } };
  const logger = new DatabaseRuntimeLogger(store.repositories.audits, fallback);
  await logger.log({
    correlationId: 'corr-1', clientId: 'client-a', platformUserId: 'platform-a',
    salesforceUsername: 'user@example.invalid', executionRole: 'USER', toolName: 'create_record',
    operation: 'CREATE', objectApiName: 'Lead', recordId: '00Q000000000001AAA',
    result: 'PASS', outcome: 'SUCCESS', durationMs: 120,
    requestSummary: { fieldNames: ['Company', 'LastName'], fieldCount: 2 },
    responseSummary: { recordId: '00Q000000000001AAA' },
  });
  const page = await store.repositories.audits.search({ correlationId: 'corr-1', limit: 10, offset: 0 });
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0]?.requestSummary, { fieldNames: ['Company', 'LastName'], fieldCount: 2 });
  assert.equal(fallbackEvents.length, 0);
  assert.deepEqual(logger.getHealth(), { status: 'UP', failureCount: 0, lastFailureAt: null });
});

test('audit persistence failure never changes an already determined mutation outcome', async () => {
  const writes: AuditWrite[] = [];
  const failingAudits: AuditRepository = {
    append: async (event) => { writes.push(event); throw new Error('database unavailable'); },
    getById: async () => undefined,
    search: async (filter) => Object.freeze({ items: Object.freeze([]), limit: filter.limit, offset: filter.offset, count: 0, hasMore: false, nextOffset: null }),
    countSince: async () => Object.freeze({ total: 0, pass: 0, blocked: 0, error: 0, unknown: 0 }),
  };
  const fallbackEvents: RuntimeLogEvent[] = [];
  const logger = new DatabaseRuntimeLogger(failingAudits, { log: (event) => { fallbackEvents.push(event); } });
  await assert.doesNotReject(logger.log({
    correlationId: 'corr-create', toolName: 'create_record', operation: 'CREATE',
    objectApiName: 'Lead', recordId: '00Q000000000001AAA', result: 'PASS', outcome: 'SUCCESS',
  }));
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.outcome, 'SUCCESS');
  assert.equal(fallbackEvents[0]?.errorCode, 'MCP_AUDIT_PERSISTENCE_FAILED');
  assert.equal(fallbackEvents[0]?.result, 'ERROR');
  assert.equal(logger.getHealth().status, 'DEGRADED');
  assert.equal(logger.getHealth().failureCount, 1);
});

test('durable and fallback logger failure still cannot escape into mutation outcome handling', async () => {
  const failingAudits: AuditRepository = {
    append: async () => { throw new Error('database unavailable'); },
    getById: async () => undefined,
    search: async (filter) => Object.freeze({ items: Object.freeze([]), limit: filter.limit, offset: filter.offset, count: 0, hasMore: false, nextOffset: null }),
    countSince: async () => Object.freeze({ total: 0, pass: 0, blocked: 0, error: 0, unknown: 0 }),
  };
  const failingFallback: RuntimeLogger = { log: async () => { throw new Error('stderr unavailable'); } };
  const logger = new DatabaseRuntimeLogger(failingAudits, failingFallback);

  await assert.doesNotReject(logger.log({
    correlationId: 'corr-update', toolName: 'update_record', operation: 'UPDATE',
    objectApiName: 'Lead', recordId: '00Q000000000001AAA', result: 'PASS', outcome: 'SUCCESS',
  }));
  assert.equal(logger.getHealth().status, 'DEGRADED');
  assert.equal(logger.getHealth().failureCount, 1);
});

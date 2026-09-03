import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RequestAuditContextController,
  runWithRequestAuditContext,
  type RuntimeLogEvent,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
import { DatabaseRuntimeLogger } from '../runtime-logger.js';
import { AsyncAuditPipeline, type AuditQueueEntry } from '../audit-pipeline.js';
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
  assert.deepEqual(logger.getHealth(), {
    status: 'UP', failureCount: 0, lastFailureAt: null, lastDropAt: null,
    queueDepth: 0, queueCapacity: 0, enqueuedSnapshots: 0, persistedSnapshots: 0,
    droppedSnapshots: 0, writerFailureCount: 0, queueFullCount: 0,
    lastSuccessAt: null, writerState: 'SYNCHRONOUS',
  });
});

test('request audit context public Audit ID is the Audit Call authority', async () => {
  const store = new InMemoryControlPlaneStore();
  const logger = new DatabaseRuntimeLogger(
    store.repositories.audits,
    { log: () => undefined },
    store.repositories.auditTraces,
  );
  const context = RequestAuditContextController.create({
    correlationId: 'corr-request-audit',
    channel: 'MCP_HTTP',
    clientId: 'client-a',
    toolName: 'create_record',
    operation: 'CREATE',
    objectApiName: 'Lead',
  }).withResolvedIdentity({
    platformUserId: 'platform-a',
    identitySource: 'USER_BOUND_TOKEN',
    identityCredentialId: 'credential-a',
  }).withSalesforceRoute({
    salesforceUsername: 'user@example.invalid',
    executionRole: 'USER',
  });

  await runWithRequestAuditContext(context, () => logger.log({
    correlationId: 'corr-request-audit',
    result: 'PASS',
    outcome: 'SUCCESS',
    durationMs: 12,
  }));

  const call = await store.repositories.auditTraces.getByPublicAuditId(context.snapshot().auditId);
  assert.ok(call);
  assert.equal(call.publicAuditId, context.snapshot().auditId);
  assert.equal(call.auditKind, 'MCP_TOOL_CALL');
  assert.equal(call.platformUserId, 'platform-a');
  assert.equal(call.identitySource, 'USER_BOUND_TOKEN');
  assert.equal(call.identityCredentialId, 'credential-a');
  assert.equal(call.salesforceUsername, 'user@example.invalid');
  assert.equal(call.executionRole, 'USER');
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

test('async runtime logger produces one master Snapshot plus N Events without request-path repository writes', async () => {
  const store = new InMemoryControlPlaneStore();
  const entries: AuditQueueEntry[] = [];
  const pipeline = new AsyncAuditPipeline({ persist: async (batch) => { entries.push(...batch); } }, { log: () => undefined }, {
    batchSize: 10, flushIntervalMs: 10, retryAttempts: 0,
  });
  const logger = new DatabaseRuntimeLogger(
    store.repositories.audits,
    { log: () => undefined },
    store.repositories.auditTraces,
    pipeline,
  );
  const context = RequestAuditContextController.create({
    correlationId: 'corr-one-master', channel: 'MCP_HTTP', toolName: 'create_record', operation: 'CREATE',
  }).withResolvedIdentity({
    platformUserId: 'platform-one', identitySource: 'USER_BOUND_TOKEN', identityCredentialId: '7',
  }).withSalesforceRoute({ salesforceUsername: 'one@example.invalid', executionRole: 'USER' });
  await runWithRequestAuditContext(context, async () => {
    await logger.log({
      correlationId: 'corr-one-master', result: 'PASS', outcome: 'SUCCESS',
      auditEvent: { eventCategory: 'TOOL', eventType: 'TOOL_TERMINAL', eventName: 'create_record', terminalSource: 'TOOL' },
    });
    await logger.log({
      correlationId: 'corr-one-master', result: 'ERROR', errorCode: 'MCP_REQUEST_CLEANUP_FAILED',
      auditEvent: { eventCategory: 'INTERNAL', eventType: 'CLEANUP_FAILURE', eventName: 'cleanup failed' },
    });
  });
  logger.finalizeRequestAudit(context);
  logger.finalizeRequestAudit(context);
  const durableBeforeWriter = await store.repositories.audits.search({ correlationId: 'corr-one-master', limit: 10, offset: 0 });
  assert.equal(durableBeforeWriter.items.length, 0);
  await pipeline.close(1_000);
  const snapshots = entries.filter((entry): entry is Extract<AuditQueueEntry, { kind: 'SNAPSHOT' }> => entry.kind === 'SNAPSHOT');
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.snapshot.auditCall.publicAuditId, context.snapshot().auditId);
  assert.equal(snapshots[0]?.snapshot.auditCall.outcome, 'SUCCESS');
  assert.equal(snapshots[0]?.snapshot.auditEvents.length, 2);
});

test('Buntu raw Token remains only in the dedicated legacy IDENTITY_VALIDATION write', async () => {
  const store = new InMemoryControlPlaneStore();
  const entries: AuditQueueEntry[] = [];
  const pipeline = new AsyncAuditPipeline({ persist: async (batch) => { entries.push(...batch); } }, { log: () => undefined }, {
    batchSize: 10, flushIntervalMs: 10, retryAttempts: 0,
  });
  const logger = new DatabaseRuntimeLogger(
    store.repositories.audits, { log: () => undefined }, store.repositories.auditTraces, pipeline,
  );
  const rawToken = 'sensitive-buntu-token-value';
  const context = RequestAuditContextController.create({
    correlationId: 'corr-buntu', channel: 'MCP_HTTP', toolName: 'get_username',
  });
  await runWithRequestAuditContext(context, () => logger.logBuntuTokenValidation({
    correlationId: 'corr-buntu', identitySource: 'BUNTU_TOKEN', operation: 'BUNTU_TOKEN_VALIDATE',
    result: 'PASS', outcome: 'SUCCESS', requestSummary: { tokenFingerprint: 'safe-fingerprint' },
    auditEvent: { eventCategory: 'IDENTITY', eventType: 'IDENTITY_VALIDATION', eventName: 'Buntu token validation' },
  }, rawToken));
  await runWithRequestAuditContext(context, () => logger.log({
    correlationId: 'corr-buntu', result: 'PASS', outcome: 'SUCCESS',
    auditEvent: { eventCategory: 'TOOL', eventType: 'TOOL_TERMINAL', eventName: 'get_username', terminalSource: 'TOOL' },
  }));
  logger.finalizeRequestAudit(context);
  await pipeline.close(1_000);
  const legacy = entries.find((entry): entry is Extract<AuditQueueEntry, { kind: 'LEGACY_RUNTIME' }> => entry.kind === 'LEGACY_RUNTIME');
  const snapshotEntry = entries.find((entry): entry is Extract<AuditQueueEntry, { kind: 'SNAPSHOT' }> => entry.kind === 'SNAPSHOT');
  assert.equal(legacy?.write.auditKind, 'IDENTITY_VALIDATION');
  assert.equal(legacy?.write.buntuRawTokenEvidence, rawToken);
  assert.ok(snapshotEntry);
  assert.equal(JSON.stringify(snapshotEntry.snapshot).includes(rawToken), false);
});

test('database logger persists a pre-redacted safe terminal message and request facts on a runtime event', async () => {
  const store = new InMemoryControlPlaneStore();
  const fallbackEvents: RuntimeLogEvent[] = [];
  const logger = new DatabaseRuntimeLogger(
    store.repositories.audits,
    { log: (event) => { fallbackEvents.push(event); } },
  );
  await logger.log({
    correlationId: 'corr-safe-msg',
    result: 'ERROR',
    errorCode: 'MCP_REQUEST_INVALID',
    errorMessageSafe: 'Content-Type must be application/json.',
    requestSummary: { method: 'POST', path: '/mcp', contentType: 'text/plain' },
    auditEvent: {
      eventCategory: 'MCP',
      eventType: 'REQUEST_TERMINAL',
      eventName: 'MCP request terminal outcome',
      terminalSource: 'REQUEST',
    },
  });
  const page = await store.repositories.audits.search({ correlationId: 'corr-safe-msg', limit: 10, offset: 0 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.errorCode, 'MCP_REQUEST_INVALID');
  assert.equal(page.items[0]?.errorMessageSafe, 'Content-Type must be application/json.');
  assert.deepEqual(page.items[0]?.requestSummary, { method: 'POST', path: '/mcp', contentType: 'text/plain' });
  assert.equal(fallbackEvents.length, 0);
});

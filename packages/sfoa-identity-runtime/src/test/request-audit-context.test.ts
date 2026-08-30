import assert from 'node:assert/strict';
import test from 'node:test';
import {
  currentRequestAuditContext,
  RequestAuditContextController,
  runWithRequestAuditContext,
} from '../request-audit-context.js';
import { MAX_REQUEST_AUDIT_EVENTS } from '../request-audit-collector.js';

test('100 interleaved Tool invocations keep audit, correlation, user, Salesforce user, and Tool isolated', async () => {
  const count = 100;
  const observed = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const marker = `ONLY_${index}`;
    const context = RequestAuditContextController.create({
      correlationId: `shared-${index % 5}`,
      channel: 'MCP_HTTP',
      clientId: `client-${index}`,
      toolName: `tool_${index}`,
      clientMetadata: index % 3 === 0
        ? { conversationId: `${marker}\u0000${'x'.repeat(400)}` }
        : {},
    });
    context
      .withResolvedIdentity({
        platformUserId: `platform_${marker}`,
        identitySource: 'USER_BOUND_TOKEN',
        identityCredentialId: `credential_${marker}`,
      })
      .withSalesforceRoute({
        salesforceUsername: `salesforce_${marker}@example.invalid`,
        executionRole: 'USER',
      });

    return runWithRequestAuditContext(context, async () => {
      await new Promise((resolve) => setTimeout(resolve, (index * 17) % 11));
      const active = currentRequestAuditContext();
      assert.ok(active);
      assert.equal(active, context);
      return active.snapshot();
    });
  }));

  assert.equal(new Set(observed.map((item) => item.auditId)).size, count);
  for (let index = 0; index < count; index += 1) {
    const marker = `ONLY_${index}`;
    const item = observed[index];
    assert.equal(item?.toolName, `tool_${index}`);
    assert.equal(item?.platformUserId, `platform_${marker}`);
    assert.equal(item?.salesforceUsername, `salesforce_${marker}@example.invalid`);
    assert.equal(item?.correlationId, `shared-${index % 5}`);
    if (index % 3 === 0) {
      assert.equal(item?.conversationId?.includes('\u0000'), false);
      assert.equal(item?.conversationId?.length, 256);
    } else {
      assert.equal(item?.conversationId, null);
    }
  }
  assert.equal(currentRequestAuditContext(), undefined);
});

test('reused correlation IDs never override server audit IDs and optional metadata may be absent', () => {
  const first = RequestAuditContextController.create({
    correlationId: 'same-correlation', channel: 'MCP_HTTP', toolName: 'get_username',
  }).snapshot();
  const second = RequestAuditContextController.create({
    correlationId: 'same-correlation', channel: 'MCP_HTTP', toolName: 'get_username',
  }).snapshot();
  assert.equal(first.correlationId, second.correlationId);
  assert.notEqual(first.auditId, second.auditId);
  assert.equal(first.conversationId, null);
  assert.equal(first.turnId, null);
  assert.equal(first.agentId, null);
  assert.equal(first.modelName, null);
});

test('controlled enrichment keeps audit identity stable and sequences request-local', () => {
  const context = RequestAuditContextController.create({
    correlationId: 'corr-controlled', channel: 'MCP_HTTP', toolName: 'create_record',
  });
  const auditId = context.snapshot().auditId;
  assert.equal(context.snapshot().platformUserId, null);
  assert.equal(context.snapshot().salesforceUsername, null);
  context.withResolvedIdentity({ clientId: 'client-a', platformUserId: 'platform-a', identitySource: 'BUNTU_TOKEN' });
  context.withSalesforceRoute({ salesforceUsername: 'user@example.invalid', executionRole: 'USER' });
  context.withOperation({ operation: 'CREATE', objectApiName: 'Lead' });
  assert.equal(context.snapshot().auditId, auditId);
  assert.equal(context.snapshot().clientId, 'client-a');
  assert.deepEqual([context.nextSequence(), context.nextSequence(), context.nextSequence()], [1, 2, 3]);
});

test('request Collector finalizes one immutable master with request-local Events', () => {
  const context = RequestAuditContextController.create({
    correlationId: 'collector-correlation', channel: 'MCP_HTTP', toolName: 'get_username',
  }).withResolvedIdentity({
    platformUserId: 'collector-user', identitySource: 'USER_BOUND_TOKEN', identityCredentialId: '42',
  }).withSalesforceRoute({ salesforceUsername: 'collector@example.invalid', executionRole: 'USER' });
  const collector = context.collector();
  assert.equal(collector.record({
    eventCategory: 'MCP', eventType: 'TOOL_INVOCATION_STARTED', eventName: 'get_username', status: 'STARTED',
  }), true);
  assert.equal(collector.record({
    eventCategory: 'TOOL', eventType: 'TOOL_TERMINAL', eventName: 'get_username', status: 'SUCCESS',
    terminal: { source: 'TOOL', result: 'PASS', outcome: 'SUCCESS' },
  }), true);
  const snapshot = context.finalizeAudit(new Date('2026-08-30T00:00:01.000Z'));
  assert.ok(snapshot);
  assert.equal(snapshot.auditCall.publicAuditId, context.snapshot().auditId);
  assert.equal(snapshot.auditEvents.length, 2);
  assert.deepEqual(snapshot.auditEvents.map((event) => event.sequence), [1, 2]);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.auditCall), true);
  assert.equal(Object.isFrozen(snapshot.auditEvents), true);
  assert.equal(context.finalizeAudit(), undefined);
  assert.equal(collector.record({
    eventCategory: 'INTERNAL', eventType: 'LATE', eventName: 'late event', status: 'FAILED',
  }), false);
});

test('Collector bounds hostile summaries and converts circular values to JSON-safe evidence', () => {
  const circular: Record<string, unknown> = { oversized: 'x'.repeat(10_000) };
  circular.self = circular;
  const context = RequestAuditContextController.create({ channel: 'MCP_HTTP', toolName: 'get_username' });
  context.collector().record({
    eventCategory: 'TOOL', eventType: 'TOOL_TERMINAL', eventName: 'get_username', status: 'SUCCESS',
    safeSummary: circular,
    terminal: { source: 'TOOL', result: 'PASS', outcome: 'SUCCESS', requestSummary: circular },
  });
  const snapshot = context.finalizeAudit();
  assert.ok(snapshot);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('[Circular]'), true);
  assert.equal(serialized.length < 20_000, true);
});

test('explicit terminal authority preserves DML UNKNOWN and retains timeout/disconnect evidence', () => {
  const context = RequestAuditContextController.create({
    correlationId: 'unknown-terminal', channel: 'MCP_HTTP', toolName: 'create_record', operation: 'CREATE',
  });
  context.collector().record({
    eventCategory: 'TOOL', eventType: 'TOOL_TERMINAL', eventName: 'create_record', status: 'SUCCESS',
    terminal: { source: 'TOOL', result: 'PASS', outcome: 'SUCCESS' },
  });
  context.collector().record({
    eventCategory: 'MCP', eventType: 'REQUEST_TIMEOUT', eventName: 'request timeout', status: 'UNKNOWN',
    errorCode: 'MCP_DML_OUTCOME_UNKNOWN',
    terminal: {
      source: 'REQUEST', result: 'ERROR', outcome: 'UNKNOWN', errorCode: 'MCP_DML_OUTCOME_UNKNOWN', mutationStarted: true,
    },
  });
  context.collector().record({
    eventCategory: 'MCP', eventType: 'TRANSPORT_TERMINAL', eventName: 'client disconnect', status: 'UNKNOWN',
    errorCode: 'MCP_DML_OUTCOME_UNKNOWN',
    terminal: {
      source: 'TRANSPORT', result: 'ERROR', outcome: 'UNKNOWN', errorCode: 'MCP_DML_OUTCOME_UNKNOWN', mutationStarted: true,
    },
  });
  const snapshot = context.finalizeAudit();
  assert.ok(snapshot);
  assert.equal(snapshot.auditCall.outcome, 'UNKNOWN');
  assert.equal(snapshot.auditCall.errorCode, 'MCP_DML_OUTCOME_UNKNOWN');
  assert.equal(snapshot.auditEvents.length, 3);
  assert.deepEqual(snapshot.auditEvents.map((event) => event.sequence), [1, 2, 3]);
});

test('missing terminal yields one PARTIAL UNKNOWN Snapshot instead of fabricating Salesforce identity', () => {
  const context = RequestAuditContextController.create({
    correlationId: 'identity-failed', channel: 'MCP_HTTP', toolName: 'get_username',
  });
  context.collector().record({
    eventCategory: 'IDENTITY', eventType: 'IDENTITY_FAILURE', eventName: 'identity failed', status: 'FAILED',
  });
  const snapshot = context.finalizeAudit();
  assert.ok(snapshot);
  assert.equal(snapshot.auditCall.outcome, 'UNKNOWN');
  assert.equal(snapshot.auditCall.auditIntegrityStatus, 'PARTIAL');
  assert.equal(snapshot.auditCall.platformUserId, null);
  assert.equal(snapshot.auditCall.salesforceUsername, null);
});

for (const concurrency of [50, 100, 200]) {
  test(`${concurrency} concurrent Collectors keep all request facts and sequences isolated`, async () => {
    const snapshots = await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
      const marker = `AUDIT_${concurrency}_${index}_ONLY`;
      const context = RequestAuditContextController.create({
        correlationId: `shared-${index % 7}`, channel: 'MCP_HTTP', toolName: `tool_${index % 11}`,
        operation: index % 2 === 0 ? 'CREATE' : 'UPDATE',
        objectApiName: `Object_${index % 13}__c`,
        recordId: `record_${marker}`,
      }).withResolvedIdentity({
        platformUserId: `platform_${marker}`, identitySource: 'USER_BOUND_TOKEN', identityCredentialId: `${index + 1}`,
      }).withSalesforceRoute({ salesforceUsername: `sf_${marker}@example.invalid`, executionRole: 'USER' });
      return runWithRequestAuditContext(context, async () => {
        context.collector().record({
          eventCategory: 'MCP', eventType: 'START', eventName: marker, status: 'STARTED', safeSummary: { marker },
        });
        await new Promise((resolve) => setTimeout(resolve, (index * 13) % 9));
        assert.equal(currentRequestAuditContext(), context);
        context.collector().record({
          eventCategory: 'TOOL', eventType: 'TOOL_TERMINAL', eventName: marker, status: 'SUCCESS',
          safeSummary: { marker }, terminal: { source: 'TOOL', result: 'PASS', outcome: 'SUCCESS' },
        });
        return context.finalizeAudit();
      });
    }));
    assert.equal(snapshots.every((snapshot) => snapshot !== undefined), true);
    const defined = snapshots.filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== undefined);
    assert.equal(new Set(defined.map((snapshot) => snapshot.auditCall.publicAuditId)).size, concurrency);
    for (let index = 0; index < defined.length; index += 1) {
      const snapshot = defined[index];
      assert.ok(snapshot);
      const marker = `AUDIT_${concurrency}_${index}_ONLY`;
      assert.equal(snapshot.auditCall.platformUserId, `platform_${marker}`);
      assert.equal(snapshot.auditCall.salesforceUsername, `sf_${marker}@example.invalid`);
      assert.equal(snapshot.auditCall.toolName, `tool_${index % 11}`);
      assert.equal(snapshot.auditCall.correlationId, `shared-${index % 7}`);
      assert.equal(snapshot.auditCall.operation, index % 2 === 0 ? 'CREATE' : 'UPDATE');
      assert.equal(snapshot.auditCall.objectApiName, `Object_${index % 13}__c`);
      assert.equal(snapshot.auditCall.recordId, `record_${marker}`);
      assert.deepEqual(snapshot.auditEvents.map((event) => event.sequence), [1, 2]);
      assert.equal(snapshot.auditEvents.every((event) => JSON.stringify(event.safeSummary).includes(marker)), true);
    }
  });
}


test('Collector bounds per-request Event growth and preserves authoritative terminal evidence', () => {
  const context = RequestAuditContextController.create({
    correlationId: 'event-cap', channel: 'MCP_HTTP', toolName: 'create_record', operation: 'CREATE',
  });
  const collector = context.collector();
  for (let index = 0; index < MAX_REQUEST_AUDIT_EVENTS + 100; index += 1) {
    collector.record({
      eventCategory: 'INTERNAL',
      eventType: 'NOISY_EVENT',
      eventName: `noise-${index}`,
      status: 'SUCCESS',
      safeSummary: { marker: index },
    });
  }
  assert.equal(collector.eventCount(), MAX_REQUEST_AUDIT_EVENTS);
  assert.equal(collector.droppedEvents(), 100);
  assert.equal(collector.record({
    eventCategory: 'TOOL',
    eventType: 'DML_OUTCOME_UNKNOWN',
    eventName: 'create_record',
    status: 'UNKNOWN',
    errorCode: 'MCP_DML_OUTCOME_UNKNOWN',
    terminal: {
      source: 'TOOL',
      result: 'ERROR',
      outcome: 'UNKNOWN',
      errorCode: 'MCP_DML_OUTCOME_UNKNOWN',
      mutationStarted: true,
    },
  }), false);
  assert.equal(collector.eventCount(), MAX_REQUEST_AUDIT_EVENTS);
  assert.equal(collector.droppedEvents(), 101);

  const snapshot = context.finalizeAudit();
  assert.ok(snapshot);
  assert.equal(snapshot.auditEvents.length, MAX_REQUEST_AUDIT_EVENTS);
  assert.equal(snapshot.auditCall.auditIntegrityStatus, 'PARTIAL');
  assert.equal(snapshot.auditCall.outcome, 'UNKNOWN');
  assert.equal(snapshot.auditCall.errorCode, 'MCP_DML_OUTCOME_UNKNOWN');
  assert.equal(snapshot.auditEvents.some((event) => event.eventType === 'DML_OUTCOME_UNKNOWN'), true);
  const requestSummary = snapshot.auditCall.requestSummary as {
    auditCapture?: { eventLimit?: number; capturedEventCount?: number; droppedEventCount?: number };
  };
  assert.equal(requestSummary.auditCapture?.eventLimit, MAX_REQUEST_AUDIT_EVENTS);
  assert.equal(requestSummary.auditCapture?.capturedEventCount, MAX_REQUEST_AUDIT_EVENTS);
  assert.equal(requestSummary.auditCapture?.droppedEventCount, 101);
});

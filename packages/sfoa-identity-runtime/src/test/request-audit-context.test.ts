import assert from 'node:assert/strict';
import test from 'node:test';
import {
  currentRequestAuditContext,
  RequestAuditContextController,
  runWithRequestAuditContext,
} from '../request-audit-context.js';

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
  context.withResolvedIdentity({ platformUserId: 'platform-a', identitySource: 'BUNTU_TOKEN' });
  context.withSalesforceRoute({ salesforceUsername: 'user@example.invalid', executionRole: 'USER' });
  context.withOperation({ operation: 'CREATE', objectApiName: 'Lead' });
  assert.equal(context.snapshot().auditId, auditId);
  assert.deepEqual([context.nextSequence(), context.nextSequence(), context.nextSequence()], [1, 2, 3]);
});

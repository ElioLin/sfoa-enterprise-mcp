import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createControlPlaneDatabase,
  loadControlPlaneConfig,
  MySqlCrmChatRepository,
  resolveSfoaProjectRoot,
} from '@sfoa/control-plane';

/**
 * MySQL integration test for the CRM persistence boundary.
 *
 * It runs against the local project database (SFOA_DB_* / .env.local), uses a
 * unique test org/user, and removes every row it creates. It does not read or
 * write Salesforce.
 */

const ORG = '00D00000000099TAAA';
const USER = '00500000000099TAAA';
const PLATFORM = `crm-test-${randomUUID()}`;

test('CRM repository round-trips bindings, nonces, chat sessions, conversations and runs', async (t) => {
  const projectRoot = resolveSfoaProjectRoot(import.meta.url);
  const config = await loadControlPlaneConfig(projectRoot, process.env, { requireDatabase: true });
  if (!config.database) throw new Error('Local MySQL database is not configured.');
  const database = createControlPlaneDatabase(config.database);
  const repository = new MySqlCrmChatRepository(database);
  t.after(async () => {
    await database.deleteFrom('sfoa_crm_run').where('conversation_id', 'in', database.selectFrom('sfoa_crm_conversation').select('id').where('salesforce_org_id', '=', ORG)).execute().catch(() => undefined);
    await database.deleteFrom('sfoa_crm_conversation').where('salesforce_org_id', '=', ORG).execute().catch(() => undefined);
    await database.deleteFrom('sfoa_crm_chat_session').where('salesforce_org_id', '=', ORG).execute().catch(() => undefined);
    await database.deleteFrom('sfoa_crm_bootstrap_nonce').where('salesforce_org_id', '=', ORG).execute().catch(() => undefined);
    await database.deleteFrom('sfoa_crm_identity_binding').where('salesforce_org_id', '=', ORG).execute().catch(() => undefined);
    await database.destroy();
  });

  const first = await repository.upsertBinding({
    salesforceOrgId: ORG,
    salesforceUserId: USER,
    platformUserId: PLATFORM,
    displayName: 'Integration User',
    enabled: true,
  });
  assert.equal(first.salesforceOrgId, ORG);
  assert.equal(first.salesforceUserId, USER);
  assert.equal(first.platformUserId, PLATFORM);
  assert.equal(first.enabled, true);

  const updated = await repository.upsertBinding({
    salesforceOrgId: ORG,
    salesforceUserId: USER,
    platformUserId: PLATFORM,
    displayName: 'Integration User 2',
    enabled: false,
  });
  assert.equal(updated.id, first.id);
  assert.equal(updated.displayName, 'Integration User 2');
  assert.equal(updated.enabled, false);
  const listed = await repository.listBindings(500);
  assert.ok(listed.some((binding) => binding.salesforceUserId === USER));

  const jti = randomUUID();
  const now = new Date();
  assert.equal(await repository.consumeBootstrapNonce({
    jti,
    salesforceOrgId: ORG,
    salesforceUserId: USER,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 600_000),
  }), true);
  assert.equal(await repository.consumeBootstrapNonce({
    jti,
    salesforceOrgId: ORG,
    salesforceUserId: USER,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + 600_000),
  }), false, 'a replayed jti must be rejected by the primary key');

  const tokenHash = 'a'.repeat(64);
  await repository.createChatSession({
    tokenHash,
    id: randomUUID(),
    salesforceOrgId: ORG,
    salesforceUserId: USER,
    platformUserId: PLATFORM,
    displayName: 'Integration User',
    salesforceUsername: 'integration@example.test',
    createdAt: now,
    expiresAt: new Date(now.getTime() + 900_000),
  });
  const session = await repository.getChatSessionByHash(tokenHash);
  assert.equal(session?.salesforceUserId, USER);
  assert.equal(session?.salesforceUsername, 'integration@example.test');
  await repository.touchChatSession(tokenHash, new Date(now.getTime() + 1_000));
  assert.ok((await repository.getChatSessionByHash(tokenHash))!.lastSeenAt.getTime() >= now.getTime());
  await repository.revokeChatSession(tokenHash, new Date(now.getTime() + 2_000));
  assert.notEqual((await repository.getChatSessionByHash(tokenHash))!.revokedAt, null);

  const conversationId = randomUUID();
  const conversation = await repository.createConversation({
    id: conversationId,
    salesforceOrgId: ORG,
    salesforceUserId: USER,
    platformUserId: PLATFORM,
    title: 'Integration conversation',
    now,
  });
  assert.equal(conversation.id, conversationId);
  assert.equal((await repository.getConversationForOwner(conversationId, ORG, USER))?.title, 'Integration conversation');
  assert.equal(await repository.getConversationForOwner(conversationId, ORG, '00500000000098TAAA'), undefined);
  assert.equal((await repository.listConversations(ORG, USER, 10)).length, 1);

  await repository.updateConversationSession(conversationId, 'agent:main:sfoa-crm:test', 'main');
  await repository.touchConversation(conversationId, new Date(now.getTime() + 3_000));
  await repository.updateConversationTitle(conversationId, 'Renamed');
  const touched = await repository.getConversation(conversationId);
  assert.equal(touched?.openclawSessionKey, 'agent:main:sfoa-crm:test');
  assert.equal(touched?.title, 'Renamed');

  const runId = randomUUID();
  const createdRun = await repository.createRun({
    id: runId,
    conversationId,
    clientMessageId: 'integration-msg-1',
    requestSha256: 'b'.repeat(64),
    textLength: 5,
    now,
  });
  assert.equal(createdRun?.status, 'STARTED');
  assert.equal(await repository.createRun({
    id: randomUUID(),
    conversationId,
    clientMessageId: 'integration-msg-1',
    requestSha256: 'c'.repeat(64),
    textLength: 5,
    now,
  }), undefined, 'duplicate client message must be ignored');
  assert.equal((await repository.getActiveRun(conversationId))?.id, runId);

  assert.equal(await repository.updateRunStatus(runId, 'RUNNING', { now, sessionKey: 'agent:main:sfoa-crm:test', terminal: false }), true);
  assert.equal(await repository.updateRunStatus(runId, 'COMPLETED', { now: new Date(now.getTime() + 1_000), terminal: true }), true);
  assert.equal(await repository.updateRunStatus(runId, 'FAILED', { now, terminal: true }), false, 'a terminal run cannot be overwritten');
  const run = await repository.getRun(runId);
  assert.equal(run?.status, 'COMPLETED');
  assert.notEqual(run?.completedAt, null);

  const staleRunId = randomUUID();
  await repository.createRun({
    id: staleRunId,
    conversationId,
    clientMessageId: 'integration-msg-stale',
    requestSha256: 'd'.repeat(64),
    textLength: 5,
    now: new Date(now.getTime() - 7_200_000),
  });
  await database.updateTable('sfoa_crm_run')
    .set({ started_at: new Date(now.getTime() - 7_200_000), updated_at: new Date(now.getTime() - 7_200_000) })
    .where('id', '=', staleRunId)
    .execute();
  const marked = await repository.markStaleRunsUnknown(new Date(now.getTime() - 3_600_000), now);
  assert.ok(marked >= 1);
  assert.equal((await repository.getRun(staleRunId))?.status, 'UNKNOWN');

  await repository.deleteExpiredArtifacts(new Date(now.getTime() + 10_000_000));
});

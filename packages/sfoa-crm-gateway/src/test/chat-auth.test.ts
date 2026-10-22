import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatSessionService, SlidingWindowRateLimiter, hashChatToken } from '../chat-auth.js';
import { CrmGatewayError } from '../errors.js';
import { FakeCrmRepository, TEST_ORG, TEST_PLATFORM_A, TEST_USER_A, TEST_USERNAME_A } from './helpers.js';

function issueParams() {
  return {
    salesforceOrgId: TEST_ORG,
    salesforceUserId: TEST_USER_A,
    platformUserId: TEST_PLATFORM_A,
    displayName: 'Candy Zheng',
    salesforceUsername: TEST_USERNAME_A,
  };
}

test('an issued chat token is stored only as a SHA-256 hash and authenticates its subject', async () => {
  const repository = new FakeCrmRepository();
  const service = new ChatSessionService(repository, { ttlMs: 900_000, now: () => 1_000_000 });
  const issued = await service.issue(issueParams());

  assert.ok(issued.token.length >= 32);
  assert.equal(repository.chatSessions.has(issued.token), false);
  assert.equal(repository.chatSessions.has(hashChatToken(issued.token)), true);
  assert.equal(issued.expiresAt.getTime(), 1_900_000);

  const session = await service.authenticate(issued.token);
  assert.equal(session.salesforceOrgId, TEST_ORG);
  assert.equal(session.salesforceUserId, TEST_USER_A);
  assert.equal(session.platformUserId, TEST_PLATFORM_A);
  assert.equal(session.salesforceUsername, TEST_USERNAME_A);
});

test('expired and revoked chat tokens are rejected', async () => {
  const repository = new FakeCrmRepository();
  let now = 1_000_000;
  const service = new ChatSessionService(repository, { ttlMs: 300_000, now: () => now });
  const issued = await service.issue(issueParams());

  now = 1_300_001;
  await assert.rejects(
    service.authenticate(issued.token),
    (error) => error instanceof CrmGatewayError && error.code === 'CRM_CHAT_SESSION_EXPIRED',
  );

  now = 1_000_000;
  const second = await service.issue(issueParams());
  await repository.revokeChatSession(hashChatToken(second.token), new Date(now));
  await assert.rejects(
    service.authenticate(second.token),
    (error) => error instanceof CrmGatewayError && error.code === 'CRM_CHAT_SESSION_REVOKED',
  );
});

test('missing, malformed and unknown chat tokens are rejected without revealing which case occurred', async () => {
  const repository = new FakeCrmRepository();
  const service = new ChatSessionService(repository, { ttlMs: 900_000 });
  for (const token of [undefined, '', 'short', 'has space', 'a'.repeat(600), 'not-a-known-token-but-long-enough']) {
    await assert.rejects(
      service.authenticate(token),
      (error) => error instanceof CrmGatewayError && (error.code === 'CRM_CHAT_TOKEN_REQUIRED' || error.code === 'CRM_CHAT_SESSION_INVALID'),
    );
  }
});

test('the sliding window limiter is bounded and recovers after the window', () => {
  let now = 10_000;
  const limiter = new SlidingWindowRateLimiter({ limit: 3, windowMs: 1_000, now: () => now });
  assert.equal(limiter.consume('a').allowed, true);
  assert.equal(limiter.consume('a').allowed, true);
  assert.equal(limiter.consume('a').allowed, true);
  const denied = limiter.consume('a');
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0);

  assert.equal(limiter.consume('b').allowed, true, 'other keys are independent');

  now = 11_001;
  assert.equal(limiter.consume('a').allowed, true);
});

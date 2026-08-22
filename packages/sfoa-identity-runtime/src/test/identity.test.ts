import assert from 'node:assert/strict';
import test from 'node:test';
import { createSalesforceIdentityRoute } from '../contracts.js';
import { IdentityRuntimeError } from '../errors.js';
import { IdentityResolver } from '../identity-resolver.js';
import { InMemoryIdentityRepository } from '../identity-repository.js';
import { TEST_ROUTE_A, TEST_ROUTE_B } from './helpers.js';

test('InMemoryIdentityRepository resolves exact platform routes without a default fallback', async () => {
  const repository = new InMemoryIdentityRepository([TEST_ROUTE_A, TEST_ROUTE_B]);
  assert.equal((await repository.findByPlatformUserId('p1-user-a'))?.salesforceUsername, TEST_ROUTE_A.salesforceUsername);
  assert.equal(await repository.findByPlatformUserId('does-not-exist'), undefined);
});

test('IdentityResolver denies an unknown route with the stable error contract', async () => {
  const resolver = new IdentityResolver(new InMemoryIdentityRepository([TEST_ROUTE_A]));
  await assert.rejects(
    resolver.resolve('does-not-exist', 'corr-route'),
    (error: unknown) =>
      error instanceof IdentityRuntimeError &&
      error.code === 'MCP_IDENTITY_ROUTE_NOT_FOUND' &&
      error.correlationId === 'corr-route',
  );
});

test('InMemoryIdentityRepository rejects duplicate platform ids and cross-route aliases', () => {
  assert.throws(() => new InMemoryIdentityRepository([TEST_ROUTE_A, TEST_ROUTE_A]), /Duplicate platformUserId/u);
  const conflicting = createSalesforceIdentityRoute({
    platformUserId: 'p1-user-c',
    salesforceUsername: 'user-c@example.test',
    credentialProfile: 'test-jwt',
    connectionRole: 'USER',
    aliases: [TEST_ROUTE_A.salesforceUsername.toLocaleUpperCase('en-US')],
  });
  assert.throws(
    () => new InMemoryIdentityRepository([TEST_ROUTE_A, conflicting]),
    /cannot be assigned to multiple platform users/u,
  );
});

test('ConnectionRole reserves DIAGNOSTIC without implementing it in the USER route', () => {
  const route = createSalesforceIdentityRoute({
    platformUserId: 'diagnostic-placeholder',
    salesforceUsername: 'diagnostic@example.test',
    credentialProfile: 'future-p4',
    connectionRole: 'DIAGNOSTIC',
    aliases: [],
  });
  assert.equal(route.connectionRole, 'DIAGNOSTIC');
  assert.equal(Object.isFrozen(route), true);
});

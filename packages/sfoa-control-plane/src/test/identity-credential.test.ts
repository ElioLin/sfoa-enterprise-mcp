import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ControlPlaneAdminService,
  ControlPlaneError,
  hashUserBoundToken,
  IdentityCredentialCipher,
  USER_BOUND_TOKEN_PREFIX,
} from '../index.js';
import { InMemoryControlPlaneStore } from './in-memory-store.js';

const ACTOR = 'credential-admin';

test('route creation atomically creates a unique, repeatably decryptable USER_BOUND credential without auditing the token', async () => {
  const store = new InMemoryControlPlaneStore();
  const service = adminService(store);
  const first = await service.createIdentityRoute(routeInput('platform-a', 'a@example.invalid'), ACTOR);
  const second = await service.createIdentityRoute(routeInput('platform-b', 'b@example.invalid'), ACTOR);

  assert.match(first.token, /^sfoa_ub1_[A-Za-z0-9_-]{43}$/u);
  assert.ok(first.token.startsWith(USER_BOUND_TOKEN_PREFIX));
  assert.notEqual(first.token, second.token);
  assert.equal(first.credential.tokenHash, hashUserBoundToken(first.token));
  assert.equal((await store.repositories.identityCredentials.getByTokenHash(first.credential.tokenHash))?.id, first.credential.id);
  assert.equal((await service.readIdentityCredential(first.route.id)).token, first.token);
  const audits = await store.repositories.audits.search({ limit: 20, offset: 0 });
  assert.equal(JSON.stringify(audits).includes(first.token), false);
  assert.equal(audits.items.some((audit) => audit.identityCredentialId === first.credential.id), true);
});

test('regeneration permanently revokes the old token and optimistic input prevents double regeneration', async () => {
  const store = new InMemoryControlPlaneStore();
  const service = adminService(store);
  const created = await service.createIdentityRoute(routeInput('platform-a', 'a@example.invalid'), ACTOR);
  const regenerated = await service.regenerateIdentityCredential(created.route.id, {
    credentialId: created.credential.id,
    credentialRowVersion: created.credential.rowVersion,
    routeRowVersion: created.route.rowVersion,
  }, ACTOR);

  assert.notEqual(regenerated.token, created.token);
  const old = await store.repositories.identityCredentials.getByTokenHash(hashUserBoundToken(created.token));
  assert.equal(old?.status, 'REVOKED');
  assert.equal(old?.tokenCiphertext, null);
  assert.equal((await service.readIdentityCredential(created.route.id)).token, regenerated.token);
  await assert.rejects(
    service.regenerateIdentityCredential(created.route.id, {
      credentialId: created.credential.id,
      credentialRowVersion: created.credential.rowVersion,
      routeRowVersion: created.route.rowVersion,
    }, ACTOR),
    isConcurrentModification,
  );
  assert.equal((await store.repositories.identityCredentials.getActiveByRouteId(created.route.id))?.id, regenerated.credential.id);
});

test('disable preserves the active token, re-enable restores it, and only a disabled route can be deleted', async () => {
  const store = new InMemoryControlPlaneStore();
  const service = adminService(store);
  const created = await service.createIdentityRoute(routeInput('platform-a', 'a@example.invalid'), ACTOR);
  await assert.rejects(
    service.deleteIdentityRoute(created.route.id, created.route.rowVersion, ACTOR),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_IDENTITY_ROUTE_DELETE_REQUIRES_DISABLED',
  );

  const disabled = await service.disableIdentityRoute(created.route.id, created.route.rowVersion, ACTOR);
  assert.equal((await service.readIdentityCredential(created.route.id)).token, created.token);
  const enabled = await service.updateIdentityRoute(created.route.id, {
    platformUserId: disabled.platformUserId,
    salesforceUsername: disabled.salesforceUsername,
    enabled: true,
    remark: disabled.remark,
    rowVersion: disabled.rowVersion,
  }, ACTOR);
  assert.equal((await service.readIdentityCredential(created.route.id)).token, created.token);
  const disabledAgain = await service.disableIdentityRoute(created.route.id, enabled.rowVersion, ACTOR);
  await service.deleteIdentityRoute(created.route.id, disabledAgain.rowVersion, ACTOR);

  assert.equal(await store.repositories.identityRoutes.getById(created.route.id), undefined);
  assert.equal(await store.repositories.identityCredentials.getByTokenHash(hashUserBoundToken(created.token)), undefined);
  const audits = await store.repositories.audits.search({ limit: 20, offset: 0 });
  assert.equal(audits.items.some((audit) => audit.operation === 'DELETE_IDENTITY_ROUTE'), true);
});

test('identity route search returns a true filtered total with server-side pagination', async () => {
  const store = new InMemoryControlPlaneStore();
  const service = adminService(store);
  for (const [platformUserId, username] of [
    ['alpha-one', 'first@example.invalid'],
    ['alpha-two', 'second@example.invalid'],
    ['bravo-one', 'shared.search@example.invalid'],
    ['charlie-one', 'shared.search@example.invalid'],
  ] as const) {
    await service.createIdentityRoute(routeInput(platformUserId, username), ACTOR);
  }

  const platformFirst = await store.repositories.identityRoutes.list({ keyword: ' ALPHA ', limit: 1, offset: 0 });
  assert.equal(platformFirst.total, 2);
  assert.equal(platformFirst.items.length, 1);
  assert.equal(platformFirst.hasMore, true);
  assert.equal(platformFirst.nextOffset, 1);
  const platformSecond = await store.repositories.identityRoutes.list({ keyword: 'alpha', limit: 1, offset: 1 });
  assert.equal(platformSecond.total, 2);
  assert.equal(platformSecond.items.length, 1);
  assert.equal(platformSecond.hasMore, false);

  const salesforce = await store.repositories.identityRoutes.list({ keyword: 'SHARED.SEARCH', limit: 10, offset: 0 });
  assert.equal(salesforce.total, 2);
  assert.deepEqual(salesforce.items.map((route) => route.platformUserId), ['bravo-one', 'charlie-one']);
  const missing = await store.repositories.identityRoutes.list({ keyword: 'not-present', limit: 10, offset: 0 });
  assert.equal(missing.total, 0);
  assert.deepEqual(missing.items, []);
});

function adminService(store: InMemoryControlPlaneStore): ControlPlaneAdminService {
  return new ControlPlaneAdminService(store, () => ({ allowed: true }), new IdentityCredentialCipher(Buffer.alloc(32, 17)));
}

function routeInput(platformUserId: string, salesforceUsername: string) {
  return Object.freeze({ platformUserId, salesforceUsername, enabled: true, remark: null });
}

function isConcurrentModification(error: unknown): boolean {
  return error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_CONCURRENT_MODIFICATION';
}

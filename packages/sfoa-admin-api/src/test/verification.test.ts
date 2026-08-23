import assert from 'node:assert/strict';
import test from 'node:test';
import type { IdentityRouteRecord } from '@sfoa/control-plane';
import type { IdentityRuntime, SalesforceIdentityRoute } from '@sfoa/identity-runtime';
import { verifyIdentityRoute } from '../verification.js';

const route: IdentityRouteRecord = Object.freeze({
  id: '1',
  platformUserId: 'platform-user-a',
  salesforceUsername: 'Exact.User@example.invalid',
  enabled: true,
  remark: null,
  rowVersion: '1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

test('route verification creates a fresh USER route, requires exact identity, and always closes scope', async () => {
  const suppliedRoutes: SalesforceIdentityRoute[] = [];
  const actualUsernames = ['Exact.User@example.invalid', 'exact.user@example.invalid'];
  let closeCount = 0;
  const runtime = Object.freeze({
    redactionSecrets: Object.freeze([]),
    scopeFactory: Object.freeze({
      createForRoute: async (_identity: unknown, suppliedRoute: SalesforceIdentityRoute) => {
        suppliedRoutes.push(suppliedRoute);
        const username = actualUsernames.shift();
        return Object.freeze({
          connection: Object.freeze({ identity: async () => Object.freeze({ username }) }),
          close: async () => { closeCount += 1; },
        });
      },
    }),
  }) as unknown as IdentityRuntime;

  const pass = await verifyIdentityRoute(runtime, route, 'verify-pass');
  assert.equal(pass.status, 'PASS');
  assert.equal(pass.identityMatched, true);

  const caseMismatch = await verifyIdentityRoute(runtime, route, 'verify-case-mismatch');
  assert.equal(caseMismatch.status, 'FAIL');
  assert.equal(caseMismatch.identityMatched, false);
  assert.equal(caseMismatch.error?.code, 'MCP_IDENTITY_CONTEXT_MISMATCH');

  assert.equal(closeCount, 2);
  assert.equal(suppliedRoutes.length, 2);
  for (const suppliedRoute of suppliedRoutes) {
    assert.equal(suppliedRoute.platformUserId, route.platformUserId);
    assert.equal(suppliedRoute.salesforceUsername, route.salesforceUsername);
    assert.equal(suppliedRoute.connectionRole, 'USER');
    assert.equal(suppliedRoute.credentialProfile, 'sfoa-shared-jwt');
  }
});

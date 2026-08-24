import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hashUserBoundToken,
  type IdentityCredentialRecord,
  type IdentityCredentialRepository,
  type IdentityRouteRecord,
  type IdentityRouteRepository,
} from '@sfoa/control-plane';
import { IdentityRuntimeError, NoopRuntimeLogger, type RuntimeLogEvent, type RuntimeLogger } from '@sfoa/identity-runtime';
import {
  InternalServiceCredentialAuthenticator,
  UnifiedIdentityProvider,
  UserBoundCredentialAuthenticator,
} from '../authenticator.js';
import { RemoteRuntimeError } from '../errors.js';
import { TEST_CLIENT_TOKEN } from './helpers.js';

const TOKEN_A = `sfoa_ub1_${'a'.repeat(43)}`;
const TOKEN_B = `sfoa_ub1_${'b'.repeat(43)}`;
const TOKEN_A2 = `sfoa_ub1_${'c'.repeat(43)}`;
const NOW = '2026-08-24T00:00:00.000Z';

test('unified identity provider preserves internal Bearer plus trusted-header compatibility', async () => {
  const fixture = new MutableIdentityFixture();
  const provider = fixture.provider();
  const principal = await provider.authenticate({
    authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
    'x-platform-user-id': 'platform-a',
  }, 'X-Platform-User-Id', 'legacy-correlation');

  assert.deepEqual(principal, {
    clientId: 'internal-bearer',
    identitySource: 'INTERNAL_SERVICE_HEADER',
    platformUserId: 'platform-a',
    correlationId: 'legacy-correlation',
  });
});

test('USER_BOUND credentials derive A/B identities without a platform header and reject cross-identity forgery', async () => {
  const fixture = new MutableIdentityFixture();
  fixture.putRoute(route('1', 'platform-a', true));
  fixture.putRoute(route('2', 'platform-b', true));
  fixture.putCredential(credential('11', '1', TOKEN_A));
  fixture.putCredential(credential('22', '2', TOKEN_B));
  const provider = fixture.provider();

  const principalA = await provider.authenticate(
    { authorization: `Bearer ${TOKEN_A}` },
    'X-Platform-User-Id',
    'user-bound-a',
  );
  const principalB = await provider.authenticate(
    { authorization: `Bearer ${TOKEN_B}` },
    'X-Platform-User-Id',
    'user-bound-b',
  );
  assert.equal(principalA.platformUserId, 'platform-a');
  assert.equal(principalA.identitySource, 'USER_BOUND_TOKEN');
  assert.equal(principalA.credentialId, '11');
  assert.equal(principalB.platformUserId, 'platform-b');
  assert.equal(fixture.lastUsedIds.length, 2);

  await assert.rejects(
    provider.authenticate({
      authorization: `Bearer ${TOKEN_A}`,
      'x-platform-user-id': 'platform-b',
    }, 'X-Platform-User-Id', 'forged-header'),
    (error: unknown) => error instanceof IdentityRuntimeError && error.code === 'MCP_IDENTITY_CONTEXT_MISMATCH',
  );
  assert.equal(fixture.lastUsedIds.length, 2, 'a denied header mismatch must not update last_used_at');
});

test('route disable, re-enable, regeneration, and deletion take effect on the next authentication without restart', async () => {
  const fixture = new MutableIdentityFixture();
  fixture.putRoute(route('1', 'platform-a', true));
  fixture.putCredential(credential('11', '1', TOKEN_A));
  const provider = fixture.provider();
  assert.equal((await authenticate(provider, TOKEN_A)).platformUserId, 'platform-a');

  fixture.putRoute(route('1', 'platform-a', false));
  await assert.rejects(authenticate(provider, TOKEN_A), hasRemoteCode('MCP_IDENTITY_ROUTE_DISABLED'));
  fixture.putRoute(route('1', 'platform-a', true));
  assert.equal((await authenticate(provider, TOKEN_A)).platformUserId, 'platform-a');

  fixture.putCredential(credential('11', '1', TOKEN_A, 'REVOKED'));
  fixture.putCredential(credential('12', '1', TOKEN_A2));
  await assert.rejects(authenticate(provider, TOKEN_A), hasRemoteCode('MCP_IDENTITY_CREDENTIAL_REVOKED'));
  assert.equal((await authenticate(provider, TOKEN_A2)).credentialId, '12');

  fixture.deleteRoute('1');
  await assert.rejects(authenticate(provider, TOKEN_A2), hasRemoteCode('MCP_IDENTITY_CREDENTIAL_INVALID'));
});

test('last-used persistence is best effort and emits only safe credential metadata on degradation', async () => {
  const events: RuntimeLogEvent[] = [];
  const logger: RuntimeLogger = { log: (event) => { events.push(event); } };
  const fixture = new MutableIdentityFixture(logger);
  fixture.putRoute(route('1', 'platform-a', true));
  fixture.putCredential(credential('11', '1', TOKEN_A));
  fixture.failLastUsed = true;

  const principal = await authenticate(fixture.provider(), TOKEN_A);
  assert.equal(principal.platformUserId, 'platform-a');
  assert.equal(events[0]?.errorCode, 'MCP_IDENTITY_CREDENTIAL_USAGE_PERSIST_FAILED');
  assert.equal(events[0]?.identityCredentialId, '11');
  assert.equal(JSON.stringify(events).includes(TOKEN_A), false);
});

class MutableIdentityFixture {
  private readonly routes = new Map<string, IdentityRouteRecord>();
  private readonly credentials = new Map<string, IdentityCredentialRecord>();
  public readonly lastUsedIds: string[] = [];
  public failLastUsed = false;

  public readonly routeRepository: IdentityRouteRepository = {
    list: async ({ limit, offset }) => Object.freeze({
      items: Object.freeze([...this.routes.values()].slice(offset, offset + limit)),
      total: this.routes.size,
      limit,
      offset,
      count: Math.min(limit, Math.max(0, this.routes.size - offset)),
      hasMore: offset + limit < this.routes.size,
      nextOffset: offset + limit < this.routes.size ? offset + limit : null,
    }),
    countActive: async () => [...this.routes.values()].filter((value) => value.enabled).length,
    getById: async (id) => this.routes.get(id),
    getByPlatformUserId: async (platformUserId) => [...this.routes.values()].find((value) => value.platformUserId === platformUserId),
    findActiveByPlatformUserId: async (platformUserId) => [...this.routes.values()].find(
      (value) => value.platformUserId === platformUserId && value.enabled,
    ),
    listActiveSalesforceUsernames: async () => Object.freeze([...this.routes.values()].filter((value) => value.enabled).map((value) => value.salesforceUsername)),
    create: async () => { throw new Error('not used by identity-provider tests'); },
    update: async () => { throw new Error('not used by identity-provider tests'); },
    disable: async () => { throw new Error('not used by identity-provider tests'); },
    delete: async () => { throw new Error('not used by identity-provider tests'); },
  };

  public readonly credentialRepository: IdentityCredentialRepository = {
    getById: async (id) => this.credentials.get(id),
    getByTokenHash: async (tokenHash) => [...this.credentials.values()].find((value) => value.tokenHash === tokenHash),
    getActiveByRouteId: async (identityRouteId) => [...this.credentials.values()].find(
      (value) => value.identityRouteId === identityRouteId && value.status === 'ACTIVE',
    ),
    listActiveByRouteIds: async (identityRouteIds) => Object.freeze([...this.credentials.values()].filter(
      (value) => identityRouteIds.includes(value.identityRouteId) && value.status === 'ACTIVE',
    )),
    listByRouteId: async (identityRouteId) => Object.freeze([...this.credentials.values()].filter(
      (value) => value.identityRouteId === identityRouteId,
    )),
    create: async () => { throw new Error('not used by identity-provider tests'); },
    revoke: async () => { throw new Error('not used by identity-provider tests'); },
    markLastUsed: async (id) => {
      if (this.failLastUsed) throw new Error('simulated last-used persistence failure');
      this.lastUsedIds.push(id);
    },
    deleteByRouteId: async () => { throw new Error('not used by identity-provider tests'); },
  };

  public constructor(private readonly logger: RuntimeLogger = new NoopRuntimeLogger()) {}

  public provider(): UnifiedIdentityProvider {
    return new UnifiedIdentityProvider([
      new UserBoundCredentialAuthenticator(this.credentialRepository, this.routeRepository, this.logger),
      new InternalServiceCredentialAuthenticator(TEST_CLIENT_TOKEN),
    ]);
  }

  public putRoute(value: IdentityRouteRecord): void { this.routes.set(value.id, value); }
  public deleteRoute(id: string): void { this.routes.delete(id); }
  public putCredential(value: IdentityCredentialRecord): void { this.credentials.set(value.id, value); }
}

function authenticate(provider: UnifiedIdentityProvider, token: string) {
  return provider.authenticate({ authorization: `Bearer ${token}` }, 'X-Platform-User-Id', 'dynamic-request');
}

function route(id: string, platformUserId: string, enabled: boolean): IdentityRouteRecord {
  return Object.freeze({
    id,
    platformUserId,
    salesforceUsername: `${platformUserId}@example.invalid`,
    enabled,
    remark: null,
    rowVersion: '1',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function credential(
  id: string,
  identityRouteId: string,
  token: string,
  status: 'ACTIVE' | 'REVOKED' = 'ACTIVE',
): IdentityCredentialRecord {
  return Object.freeze({
    id,
    identityRouteId,
    credentialType: 'USER_BOUND',
    tokenHash: hashUserBoundToken(token),
    tokenCiphertext: status === 'ACTIVE' ? 'v1.test.test.test' : null,
    tokenLast4: token.slice(-4),
    status,
    generatedAt: NOW,
    lastUsedAt: null,
    revokedAt: status === 'REVOKED' ? NOW : null,
    rowVersion: '1',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function hasRemoteCode(code: RemoteRuntimeError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof RemoteRuntimeError && error.code === code;
}

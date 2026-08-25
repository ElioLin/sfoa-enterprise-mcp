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
  BuntuTokenCredentialAuthenticator,
  InternalServiceCredentialAuthenticator,
  UnifiedIdentityProvider,
  UserBoundCredentialAuthenticator,
  type CredentialAuthenticator,
} from '../authenticator.js';
import type { BuntuTokenValidator, BuntuValidationResult } from '../buntu-validator.js';
import { RemoteRuntimeError } from '../errors.js';
import { TEST_CLIENT_TOKEN } from './helpers.js';

const TOKEN_A = `sfoa_ub1_${'a'.repeat(43)}`;
const TOKEN_B = `sfoa_ub1_${'b'.repeat(43)}`;
const TOKEN_A2 = `sfoa_ub1_${'c'.repeat(43)}`;
const BUNTU_TOKEN = 'buntu-live-token-abc12345';
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

test('Buntu tokens route to the Buntu provider and bind the platform user without a header', async () => {
  const fixture = new MutableIdentityFixture();
  fixture.putRoute(route('1', 'platform-a', true));
  fixture.validator.result = Object.freeze({
    valid: true,
    userId: 'platform-a',
    httpStatus: 200,
    durationMs: 12,
    validatedAt: NOW,
  });
  const principal = await authenticate(fixture.provider({ includeBuntu: true }), BUNTU_TOKEN);
  assert.deepEqual(principal, {
    clientId: 'xiaoben-buntu-token',
    identitySource: 'BUNTU_TOKEN',
    platformUserId: 'platform-a',
    correlationId: 'dynamic-request',
  });
  assert.equal(fixture.validator.receivedTokens.length, 1);
  assert.equal(fixture.validator.receivedTokens[0], BUNTU_TOKEN);
});

test('deterministic provider routing is mutually exclusive across all three providers', async () => {
  const fixture = new MutableIdentityFixture();
  fixture.putRoute(route('1', 'platform-a', true));
  fixture.putCredential(credential('11', '1', TOKEN_A));
  fixture.validator.result = Object.freeze({
    valid: true,
    userId: 'platform-a',
    httpStatus: 200,
    durationMs: 5,
    validatedAt: NOW,
  });
  const provider = fixture.provider({ includeBuntu: true });

  // 1. USER_BOUND prefix must never reach the Buntu or Internal providers.
  assert.equal((await authenticate(provider, TOKEN_A)).identitySource, 'USER_BOUND_TOKEN');

  // 2. Exact MCP_CLIENT_TOKEN must never reach the Buntu provider.
  const internal = await provider.authenticate(
    { authorization: `Bearer ${TEST_CLIENT_TOKEN}`, 'x-platform-user-id': 'platform-a' },
    'X-Platform-User-Id',
    'internal-routing',
  );
  assert.equal(internal.identitySource, 'INTERNAL_SERVICE_HEADER');

  // 3. Any other defined token reaches Buntu when enabled.
  assert.equal((await authenticate(provider, BUNTU_TOKEN)).identitySource, 'BUNTU_TOKEN');

  // 4. Regression: without Buntu, an arbitrary token is rejected (no fallback).
  await assert.rejects(authenticate(fixture.provider({ includeBuntu: false }), BUNTU_TOKEN), hasRemoteCode('MCP_CLIENT_AUTH_INVALID'));
});

test('Buntu route resolution is fail-closed: missing and disabled routes are rejected', async () => {
  const fixture = new MutableIdentityFixture();
  fixture.validator.result = Object.freeze({
    valid: true,
    userId: 'ghost-user',
    httpStatus: 200,
    durationMs: 4,
    validatedAt: NOW,
  });
  const provider = fixture.provider({ includeBuntu: true });
  await assert.rejects(authenticate(provider, BUNTU_TOKEN), hasIdentityCode('MCP_IDENTITY_ROUTE_NOT_FOUND'));

  fixture.putRoute(route('2', 'ghost-user', false));
  await assert.rejects(authenticate(provider, BUNTU_TOKEN), hasRemoteCode('MCP_IDENTITY_ROUTE_DISABLED'));

  fixture.putRoute(route('2', 'ghost-user', true));
  assert.equal((await authenticate(provider, BUNTU_TOKEN)).platformUserId, 'ghost-user');
});

test('Buntu validation failures map to stable error codes and deny the request', async () => {
  const fixture = new MutableIdentityFixture();
  fixture.putRoute(route('1', 'platform-a', true));
  const provider = fixture.provider({ includeBuntu: true });

  fixture.validator.result = Object.freeze({
    valid: false,
    errorCode: 'MCP_BUNTU_TOKEN_INVALID',
    httpStatus: 401,
    durationMs: 3,
    validatedAt: NOW,
  });
  await assert.rejects(authenticate(provider, BUNTU_TOKEN), hasRemoteCode('MCP_BUNTU_TOKEN_INVALID'));

  fixture.validator.result = Object.freeze({
    valid: false,
    errorCode: 'MCP_BUNTU_IDENTITY_UNAVAILABLE',
    durationMs: 9,
    validatedAt: NOW,
  });
  await assert.rejects(authenticate(provider, BUNTU_TOKEN), hasRemoteCode('MCP_BUNTU_IDENTITY_UNAVAILABLE'));

  fixture.validator.result = Object.freeze({
    valid: false,
    errorCode: 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID',
    httpStatus: 200,
    durationMs: 7,
    validatedAt: NOW,
  });
  await assert.rejects(authenticate(provider, BUNTU_TOKEN), hasRemoteCode('MCP_BUNTU_IDENTITY_RESPONSE_INVALID'));
});

test('BUNTU_TOKEN_VALIDATE audit emits fingerprint and last4; the raw token is opt-in and never in summaries', async () => {
  const events: RuntimeLogEvent[] = [];
  const logger: RuntimeLogger = { log: (event) => { void events.push(event); } };
  const fixture = new MutableIdentityFixture(logger);
  fixture.putRoute(route('1', 'platform-a', true));
  fixture.validator.result = Object.freeze({
    valid: true,
    userId: 'platform-a',
    httpStatus: 200,
    durationMs: 11,
    validatedAt: NOW,
    upstreamSuccess: true,
    userIdType: 'string',
  });

  await authenticate(fixture.provider({ includeBuntu: true, rawTokenAuditEnabled: false }), BUNTU_TOKEN);
  const event = events.find((entry) => entry.operation === 'BUNTU_TOKEN_VALIDATE');
  assert.ok(event, 'expected a BUNTU_TOKEN_VALIDATE audit event');
  assert.equal(event.clientId, 'xiaoben-buntu-token');
  assert.equal(event.identitySource, 'BUNTU_TOKEN');
  assert.equal(event.platformUserId, 'platform-a');
  assert.equal(event.result, 'PASS');
  assert.equal(event.outcome, 'SUCCESS');
  const requestSummary = event.requestSummary as Record<string, unknown>;
  assert.equal(requestSummary.provider, 'BUNTU');
  assert.equal(requestSummary.tokenLast4, '2345');
  assert.match(String(requestSummary.tokenFingerprint), /^sha256:[0-9a-f]{64}$/u);
  assert.equal('rawToken' in requestSummary, false);
  assert.equal(JSON.stringify(events).includes(BUNTU_TOKEN), false);
  const responseSummary = event.responseSummary as Record<string, unknown>;
  assert.equal(responseSummary.valid, true);
  assert.equal(responseSummary.upstreamSuccess, true);
  assert.equal(responseSummary.userId, 'platform-a');
  assert.equal(responseSummary.userIdType, 'string');

  const eventsRaw: RuntimeLogEvent[] = [];
  const loggerRaw: RuntimeLogger = { log: (rawEvent) => { void eventsRaw.push(rawEvent); } };
  const fixtureRaw = new MutableIdentityFixture(loggerRaw);
  fixtureRaw.putRoute(route('1', 'platform-a', true));
  fixtureRaw.validator.result = Object.freeze({
    valid: true,
    userId: 'platform-a',
    httpStatus: 200,
    durationMs: 11,
    validatedAt: NOW,
    upstreamSuccess: true,
    userIdType: 'string',
  });
  await authenticate(fixtureRaw.provider({ includeBuntu: true, rawTokenAuditEnabled: true }), BUNTU_TOKEN);
  const rawEvent = eventsRaw.find((entry) => entry.operation === 'BUNTU_TOKEN_VALIDATE');
  assert.equal(
    (rawEvent?.requestSummary as Record<string, unknown> | undefined)?.rawToken,
    BUNTU_TOKEN,
  );
});

test('a denied Buntu validation is audited as BLOCKED with the upstream error code', async () => {
  const events: RuntimeLogEvent[] = [];
  const logger: RuntimeLogger = { log: (event) => { void events.push(event); } };
  const fixture = new MutableIdentityFixture(logger);
  fixture.validator.result = Object.freeze({
    valid: false,
    errorCode: 'MCP_BUNTU_TOKEN_INVALID',
    httpStatus: 403,
    durationMs: 6,
    validatedAt: NOW,
  });

  await assert.rejects(
    authenticate(fixture.provider({ includeBuntu: true }), BUNTU_TOKEN),
    hasRemoteCode('MCP_BUNTU_TOKEN_INVALID'),
  );
  const event = events.find((entry) => entry.operation === 'BUNTU_TOKEN_VALIDATE');
  assert.equal(event?.result, 'BLOCKED');
  assert.equal(event?.outcome, 'DENIED');
  assert.equal(event?.errorCode, 'MCP_BUNTU_TOKEN_INVALID');
  assert.equal((event?.responseSummary as Record<string, unknown> | undefined)?.httpStatus, 403);
});

test('a Buntu success=false business rejection is audited with upstreamSuccess=false (not a response error)', async () => {
  const events: RuntimeLogEvent[] = [];
  const logger: RuntimeLogger = { log: (event) => { void events.push(event); } };
  const fixture = new MutableIdentityFixture(logger);
  fixture.putRoute(route('1', 'platform-a', true));
  // HTTP 200 with { success: false } -> MCP_BUNTU_TOKEN_INVALID, upstreamSuccess=false.
  fixture.validator.result = Object.freeze({
    valid: false,
    errorCode: 'MCP_BUNTU_TOKEN_INVALID',
    httpStatus: 200,
    durationMs: 5,
    validatedAt: NOW,
    upstreamSuccess: false,
  });

  await assert.rejects(
    authenticate(fixture.provider({ includeBuntu: true }), BUNTU_TOKEN),
    hasRemoteCode('MCP_BUNTU_TOKEN_INVALID'),
  );
  const event = events.find((entry) => entry.operation === 'BUNTU_TOKEN_VALIDATE');
  assert.equal(event?.result, 'BLOCKED');
  assert.equal(event?.outcome, 'DENIED');
  assert.equal(event?.errorCode, 'MCP_BUNTU_TOKEN_INVALID');
  const responseSummary = event?.responseSummary as Record<string, unknown> | undefined;
  assert.equal(responseSummary?.valid, false);
  assert.equal(responseSummary?.httpStatus, 200);
  assert.equal(responseSummary?.upstreamSuccess, false);
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

  public readonly validator = new StubBuntuTokenValidator();

  public provider(options: Readonly<{ includeBuntu?: boolean; rawTokenAuditEnabled?: boolean }> = {}): UnifiedIdentityProvider {
    const authenticators: CredentialAuthenticator[] = [
      new UserBoundCredentialAuthenticator(this.credentialRepository, this.routeRepository, this.logger),
      new InternalServiceCredentialAuthenticator(TEST_CLIENT_TOKEN),
    ];
    if (options.includeBuntu) {
      authenticators.push(
        new BuntuTokenCredentialAuthenticator({
          validator: this.validator,
          routes: this.routeRepository,
          logger: this.logger,
          clientToken: TEST_CLIENT_TOKEN,
          validateTokenUrl: 'https://buntu.example.test/validate',
          rawTokenAuditEnabled: options.rawTokenAuditEnabled ?? false,
        }),
      );
    }
    return new UnifiedIdentityProvider(authenticators);
  }

  public putRoute(value: IdentityRouteRecord): void { this.routes.set(value.id, value); }
  public deleteRoute(id: string): void { this.routes.delete(id); }
  public putCredential(value: IdentityCredentialRecord): void { this.credentials.set(value.id, value); }
}

function authenticate(provider: UnifiedIdentityProvider, token: string) {
  return provider.authenticate({ authorization: `Bearer ${token}` }, 'X-Platform-User-Id', 'dynamic-request');
}

class StubBuntuTokenValidator implements BuntuTokenValidator {
  public result: BuntuValidationResult = Object.freeze({
    valid: false,
    errorCode: 'MCP_BUNTU_TOKEN_INVALID',
    httpStatus: 401,
    durationMs: 1,
    validatedAt: NOW,
  });
  public readonly receivedTokens: string[] = [];

  public async validate(rawToken: string): Promise<BuntuValidationResult> {
    this.receivedTokens.push(rawToken);
    return this.result;
  }
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

function hasIdentityCode(code: IdentityRuntimeError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof IdentityRuntimeError && error.code === code;
}

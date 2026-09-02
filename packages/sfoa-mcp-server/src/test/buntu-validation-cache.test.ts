import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { IdentityRouteRepository } from '@sfoa/control-plane';
import { NoopRuntimeLogger, type RuntimeLogger } from '@sfoa/identity-runtime';
import { BuntuTokenCredentialAuthenticator } from '../authenticator.js';
import { HttpBuntuTokenValidator, type BuntuTokenValidator, type BuntuValidationResult } from '../buntu-validator.js';
import { InMemoryBuntuValidationCache } from '../buntu-validation-cache.js';
import { startRemoteMcpServer } from '../http-server.js';
import {
  RecordingConnectionFactory,
  TEST_CLIENT_TOKEN,
  TEST_PLATFORM_USER_A,
  createTestIdentityRuntime,
  createTestRemoteConfig,
  initializeBody,
  mcpHeaders,
} from './helpers.js';
import { InternalServiceCredentialAuthenticator, UnifiedIdentityProvider } from '../authenticator.js';

/**
 * Buntu token validation cache tests:
 * - `InMemoryBuntuValidationCache` expiry / LRU / clear semantics;
 * - `BuntuTokenCredentialAuthenticator` reuse within the upstream `expiresAt`,
 *   no live validation and no `IDENTITY_VALIDATION` audit on a cache hit,
 *   revalidation after expiry, failures never cached, per-token independence,
 *   route re-checked every request, and single-flight collapse for concurrent
 *   same-token requests;
 * - HTTP-level: two stateless POSTs sharing one token produce exactly one
 *   upstream validation and one audit (the reported multi-audit symptom).
 *
 * Production caching only happens when the upstream returns a usable
 * `data.expiresAt`; test stubs without an expiry therefore stay uncacheable and
 * keep exercising the live path.
 */

const MCP_CLIENT_TOKEN = TEST_CLIENT_TOKEN;
const USER_A = 'buntu-cache-user-a';
const USER_B = 'buntu-cache-user-b';
const TOKEN_A = 'fake-buntu-token-cache-a';
const TOKEN_B = 'fake-buntu-token-cache-b';
const NOW_MS = 1_784_000_000_000; // fixed fake-clock epoch milliseconds
const TTL_SECONDS = 3600;

function expiresAtSecondsFuture(): number {
  return Math.floor((NOW_MS + TTL_SECONDS * 1000) / 1000);
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Success result shaped exactly like the confirmed upstream response. */
function success(userId: string, expiresAtSeconds?: number): BuntuValidationResult {
  return Object.freeze({
    valid: true,
    userId,
    httpStatus: 200,
    durationMs: 1,
    validatedAt: isoAt(NOW_MS),
    upstreamSuccess: true,
    userIdType: 'string' as const,
    ...(expiresAtSeconds === undefined ? {} : { expiresAtSeconds }),
  });
}

const INVALID_RESULT: BuntuValidationResult = Object.freeze({
  valid: false,
  errorCode: 'MCP_BUNTU_TOKEN_INVALID',
  httpStatus: 401,
  durationMs: 1,
  validatedAt: isoAt(NOW_MS),
});

/** Mutable mapping so tests can revoke a route after a cache is warm. */
function mutableRoutes(): {
  repository: IdentityRouteRepository;
  setEnabled(userId: string, enabled: boolean): void;
} {
  const enabled = new Map<string, boolean>();
  const repository = {
    getByPlatformUserId: async (platformUserId: string) => ({
      id: `route-${platformUserId}`,
      platformUserId,
      salesforceUsername: `${platformUserId}@example.test`,
      enabled: enabled.get(platformUserId) ?? true,
      remark: null,
      rowVersion: '1',
      createdAt: isoAt(NOW_MS),
      updatedAt: isoAt(NOW_MS),
    }),
  } as unknown as IdentityRouteRepository;
  return {
    repository,
    setEnabled: (userId, value) => { enabled.set(userId, value); },
  };
}

class CountingValidator implements BuntuTokenValidator {
  public calls = 0;
  public constructor(
    private readonly mapping: ReadonlyMap<string, { userId: string; delayMs?: number }>,
    private readonly expiresAtSeconds?: number,
    private readonly invalidTokens = new Set<string>(),
  ) {}

  public async validate(rawToken: string): Promise<BuntuValidationResult> {
    this.calls += 1;
    if (this.invalidTokens.has(rawToken)) return INVALID_RESULT;
    const entry = this.mapping.get(rawToken);
    if (!entry) {
      return Object.freeze({ ...INVALID_RESULT, errorCode: 'MCP_BUNTU_IDENTITY_UNAVAILABLE', httpStatus: 503 });
    }
    if (entry.delayMs && entry.delayMs > 0) await delay(entry.delayMs);
    return success(entry.userId, this.expiresAtSeconds);
  }
}

function buntuAuthenticator(options: Readonly<{
  validator: BuntuTokenValidator;
  routes: IdentityRouteRepository;
  nowMs?: () => number;
  logger?: RuntimeLogger;
  validationCache?: ReturnType<typeof defaultCache>;
}>): BuntuTokenCredentialAuthenticator {
  return new BuntuTokenCredentialAuthenticator({
    validator: options.validator,
    routes: options.routes,
    logger: options.logger ?? new NoopRuntimeLogger(),
    clientToken: MCP_CLIENT_TOKEN,
    validateTokenUrl: 'https://buntu.example.test/validate',
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(options.validationCache ? { validationCache: options.validationCache } : {}),
  });
}

function defaultCache(maxEntries = 10): InMemoryBuntuValidationCache {
  return new InMemoryBuntuValidationCache({ maxEntries });
}

/** Deterministic clock pinned to NOW_MS so `expiresAtSecondsFuture()` is always live. */
const FAKE_NOW = (): number => NOW_MS;

function buntuValidationAuditCount(events: readonly unknown[]): number {
  return events.filter((event) => isRecord(event) && event.operation === 'BUNTU_TOKEN_VALIDATE').length;
}

// =====================================================================
// InMemoryBuntuValidationCache: expiry, LRU, clear
// =====================================================================

test('InMemoryBuntuValidationCache returns live entries and evicts expired ones on read', () => {
  const cache = defaultCache();
  cache.set('fp-a', { userId: USER_A, expiresAtMs: NOW_MS + 5_000, cachedAtMs: NOW_MS });

  assert.equal(cache.get('fp-a', NOW_MS + 4_999)?.userId, USER_A, 'live entry must be returned');
  assert.equal(cache.get('fp-a', NOW_MS + 5_000), undefined, 'entry at the expiry boundary is expired');
  assert.equal(cache.get('fp-a', NOW_MS + 9_999), undefined, 'expired entry must be evicted (no resurrection)');
});

test('InMemoryBuntuValidationCache enforces the LRU maxEntries bound and refresh recency', () => {
  const cache = new InMemoryBuntuValidationCache({ maxEntries: 2 });
  const entry = (userId: string) => ({ userId, expiresAtMs: NOW_MS + 60_000, cachedAtMs: NOW_MS });
  cache.set('fp-a', entry(USER_A));
  cache.set('fp-b', entry(USER_B));
  cache.get('fp-a', NOW_MS); // refresh: fp-a is now most recent
  cache.set('fp-c', entry(USER_A)); // evicts least-recent fp-b
  assert.equal(cache.get('fp-b', NOW_MS), undefined, 'least-recently-used entry must be evicted');
  assert.equal(cache.get('fp-a', NOW_MS)?.userId, USER_A);
  assert.equal(cache.get('fp-c', NOW_MS)?.userId, USER_A);
});

test('InMemoryBuntuValidationCache clear() drops every entry and validates maxEntries', () => {
  assert.throws(() => new InMemoryBuntuValidationCache({ maxEntries: 0 }));
  const cache = defaultCache();
  cache.set('fp-a', { userId: USER_A, expiresAtMs: NOW_MS + 60_000, cachedAtMs: NOW_MS });
  cache.clear();
  assert.equal(cache.get('fp-a', NOW_MS), undefined);
});

// =====================================================================
// Authenticator: reuse within expiresAt, no audit on hit
// =====================================================================

test('a second authenticate with the same live token reuses the cache: no upstream call, no audit row', async () => {
  const events: unknown[] = [];
  const logger: RuntimeLogger = { log: (event) => { void events.push(event); } };
  const routes = mutableRoutes();
  const validator = new CountingValidator(new Map([[TOKEN_A, { userId: USER_A }]]), expiresAtSecondsFuture());
  const clock = { value: NOW_MS };
  const authenticator = buntuAuthenticator({
    validator,
    routes: routes.repository,
    logger,
    nowMs: () => clock.value,
  });

  const first = await authenticator.authenticate(TOKEN_A, 'cache-hit-1');
  assert.equal(first.boundPlatformUserId, USER_A);
  assert.equal(validator.calls, 1);
  assert.equal(buntuValidationAuditCount(events), 1, 'the live validation must produce one audit');

  const second = await authenticator.authenticate(TOKEN_A, 'cache-hit-2');
  assert.equal(second.boundPlatformUserId, USER_A);
  assert.equal(validator.calls, 1, 'a cache hit must not call the upstream again');
  assert.equal(buntuValidationAuditCount(events), 1, 'a cache hit must not write another BUNTU_TOKEN_VALIDATE audit');
});

test('advancing the clock past expiresAt forces a fresh validation (and a fresh audit)', async () => {
  const events: unknown[] = [];
  const logger: RuntimeLogger = { log: (event) => { void events.push(event); } };
  const routes = mutableRoutes();
  const validator = new CountingValidator(new Map([[TOKEN_A, { userId: USER_A }]]), expiresAtSecondsFuture());
  const clock = { value: NOW_MS };
  const authenticator = buntuAuthenticator({
    validator,
    routes: routes.repository,
    logger,
    nowMs: () => clock.value,
  });

  assert.equal((await authenticator.authenticate(TOKEN_A, 'exp-1')).boundPlatformUserId, USER_A);
  clock.value = NOW_MS + TTL_SECONDS * 1000 + 1; // past expiresAt
  assert.equal((await authenticator.authenticate(TOKEN_A, 'exp-2')).boundPlatformUserId, USER_A);
  assert.equal(validator.calls, 2, 'an expired entry must be revalidated');
  assert.equal(buntuValidationAuditCount(events), 2);
});

// =====================================================================
// Authenticator: failures never cached, token independence
// =====================================================================

test('failed validations are never cached: each attempt hits the upstream', async () => {
  const routes = mutableRoutes();
  const validator = new CountingValidator(
    new Map([[TOKEN_A, { userId: USER_A }]]),
    expiresAtSecondsFuture(),
    new Set([TOKEN_A]),
  );
  const authenticator = buntuAuthenticator({ validator, routes: routes.repository });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      authenticator.authenticate(TOKEN_A, `failure-${attempt}`),
      (error: unknown) => isRecord(error) && error.code === 'MCP_BUNTU_TOKEN_INVALID',
    );
  }
  assert.equal(validator.calls, 2, 'failures must not be cached');
});

test('distinct tokens keep independent cache entries and never cross identities', async () => {
  const routes = mutableRoutes();
  const validator = new CountingValidator(
    new Map([[TOKEN_A, { userId: USER_A }], [TOKEN_B, { userId: USER_B }]]),
    expiresAtSecondsFuture(),
  );
  const authenticator = buntuAuthenticator({
    validator,
    routes: routes.repository,
    nowMs: FAKE_NOW,
  });

  assert.equal((await authenticator.authenticate(TOKEN_A, 'iso-1')).boundPlatformUserId, USER_A);
  assert.equal((await authenticator.authenticate(TOKEN_B, 'iso-2')).boundPlatformUserId, USER_B);
  assert.equal(validator.calls, 2);
  // Replays stay correct per token.
  assert.equal((await authenticator.authenticate(TOKEN_A, 'iso-3')).boundPlatformUserId, USER_A);
  assert.equal((await authenticator.authenticate(TOKEN_B, 'iso-4')).boundPlatformUserId, USER_B);
  assert.equal(validator.calls, 2, 'replays must be served from cache');
});

test('a success without expiresAt is uncacheable: repeated calls revalidate', async () => {
  const routes = mutableRoutes();
  const validator = new CountingValidator(new Map([[TOKEN_A, { userId: USER_A }]])); // no expiresAt
  const authenticator = buntuAuthenticator({ validator, routes: routes.repository });

  await authenticator.authenticate(TOKEN_A, 'no-exp-1');
  await authenticator.authenticate(TOKEN_A, 'no-exp-2');
  assert.equal(validator.calls, 2, 'without a cache horizon the safe default is to keep validating');
});

// =====================================================================
// Authenticator: route is still authoritative on every request
// =====================================================================

test('the identity route is re-checked on every request even when the token is cached', async () => {
  const routes = mutableRoutes();
  const validator = new CountingValidator(new Map([[TOKEN_A, { userId: USER_A }]]), expiresAtSecondsFuture());
  const authenticator = buntuAuthenticator({ validator, routes: routes.repository, nowMs: FAKE_NOW });

  assert.equal((await authenticator.authenticate(TOKEN_A, 'route-1')).boundPlatformUserId, USER_A);
  routes.setEnabled(USER_A, false); // disable route while the token is still cached
  await assert.rejects(
    authenticator.authenticate(TOKEN_A, 'route-2'),
    (error: unknown) => isRecord(error) && error.code === 'MCP_IDENTITY_ROUTE_DISABLED',
  );
  assert.equal(validator.calls, 1, 'route revocation must be honored without revalidating the token');
});

// =====================================================================
// Authenticator: single-flight collapses concurrent same-token validations
// =====================================================================

test('concurrent same-token requests share one upstream validation and one audit', async () => {
  const events: unknown[] = [];
  const logger: RuntimeLogger = { log: (event) => { void events.push(event); } };
  const routes = mutableRoutes();
  const validator = new CountingValidator(
    new Map([[TOKEN_A, { userId: USER_A, delayMs: 25 }]]),
    expiresAtSecondsFuture(),
  );
  const authenticator = buntuAuthenticator({
    validator,
    routes: routes.repository,
    logger,
    nowMs: FAKE_NOW,
  });

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) => authenticator.authenticate(TOKEN_A, `burst-${index}`)),
  );
  assert.equal(results.every((result) => result.boundPlatformUserId === USER_A), true);
  assert.equal(validator.calls, 1, 'concurrent identical-token requests must collapse to a single validation');
  assert.equal(buntuValidationAuditCount(events), 1, 'only the leader request writes the audit');

  // After the burst the cache is warm: a sequential replay is a pure cache hit.
  const eventsBefore = buntuValidationAuditCount(events);
  assert.equal((await authenticator.authenticate(TOKEN_A, 'after-burst')).boundPlatformUserId, USER_A);
  assert.equal(validator.calls, 1);
  assert.equal(buntuValidationAuditCount(events), eventsBefore);
});

// =====================================================================
// HTTP-level: many stateless POSTs sharing one token -> one validation
// =====================================================================

test('HTTP: two initialize POSTs with the same Buntu token hit the upstream only once and write one audit', async () => {
  let upstreamHits = 0;
  const upstream = await listenHttp((_request, response) => {
    upstreamHits += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      success: true,
      data: { userId: TEST_PLATFORM_USER_A, expiresAt: expiresAtSecondsFuture() },
    }));
  });
  const events: unknown[] = [];
  const logger: RuntimeLogger = { log: (event) => { void events.push(event); } };
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-buntu-cache-http-'));
  try {
    const buntuAuthenticatorInstance = buntuAuthenticator({
      validator: new HttpBuntuTokenValidator({ validateTokenUrl: upstream.baseUrl, timeoutMs: 2_000 }),
      routes: mutableRoutes().repository,
      logger,
      nowMs: FAKE_NOW,
    });
    const server = await startRemoteMcpServer({
      config: createTestRemoteConfig(),
      identityRuntime: createTestIdentityRuntime(baseRoot, new RecordingConnectionFactory(), new NoopRuntimeLogger()),
      identityProvider: new UnifiedIdentityProvider([
        new InternalServiceCredentialAuthenticator(MCP_CLIENT_TOKEN),
        buntuAuthenticatorInstance,
      ]),
    });
    try {
      const headers = mcpHeaders(undefined, TOKEN_A);
      const first = await fetch(server.mcpUrl, { method: 'POST', headers, body: initializeBody(1) });
      assert.equal(first.status, 200, 'the first initialize must succeed end to end');
      const second = await fetch(server.mcpUrl, { method: 'POST', headers, body: initializeBody(2) });
      assert.equal(second.status, 200, 'the second initialize must succeed end to end');
    } finally {
      await server.close();
    }
  } finally {
    await upstream.close();
    await rm(baseRoot, { recursive: true, force: true });
  }

  assert.equal(upstreamHits, 1, 'two POSTs sharing one token must validate upstream exactly once');
  assert.equal(buntuValidationAuditCount(events), 1, 'only the first POST writes the IDENTITY_VALIDATION audit');
});

function listenHttp(
  handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

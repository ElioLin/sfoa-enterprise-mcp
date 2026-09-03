import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import {
  DatabaseRuntimeLogger,
  hashUserBoundToken,
  type AuditRepository,
  type AuditWrite,
  type IdentityCredentialRecord,
  type IdentityCredentialRepository,
  type IdentityRouteRecord,
  type IdentityRouteRepository,
} from '@sfoa/control-plane';
import {
  createSalesforceIdentityRoute,
  NoopRuntimeLogger,
  type RuntimeLogEvent,
  type RuntimeLogger,
  type SalesforceConnectionFactory,
  type SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import {
  BuntuTokenCredentialAuthenticator,
  InternalServiceCredentialAuthenticator,
  UnifiedIdentityProvider,
  UserBoundCredentialAuthenticator,
  type CredentialAuthenticator,
} from '../authenticator.js';
import type { BuntuTokenValidator, BuntuValidationResult } from '../buntu-validator.js';
import { loadRemoteRuntimeConfig } from '../config.js';
import { formatRemoteRuntimeError, RemoteRuntimeError } from '../errors.js';
import { captureRequestBearerSecrets, startRemoteMcpServer } from '../http-server.js';
import {
  createTestIdentityRuntime,
  createTestRemoteConfig,
  initializeBody,
  mcpHeaders,
  RecordingConnectionFactory,
  TEST_CLIENT_TOKEN,
} from './helpers.js';

/**
 * P6-ID-02 HOTFIX01/HOTFIX02 focused tests: Buntu request secret redaction,
 * the MySQL Control Plane fail-fast gate, the confirmed
 * `{ success, data.userId }` response contract, and deterministic concurrency
 * isolation across the Buntu provider, identity routes, and request-scoped
 * Salesforce Connections.
 */

const BUNTU_TOKEN_A = 'fake-buntu-token-a';
const BUNTU_TOKEN_B = 'fake-buntu-token-b';
const BUNTU_TOKEN_C = 'fake-buntu-token-c';
const USER_A = 'buntu-user-a';
const USER_B = 'buntu-user-b';
const USER_C = 'buntu-user-c';
const SF_A = 'salesforce-a@example.test';
const SF_B = 'salesforce-b@example.test';
const SF_C = 'salesforce-c@example.test';
const USER_BOUND_TOKEN = `sfoa_ub1_${'h'.repeat(43)}`;
const VALIDATE_TOKEN_URL = 'https://buntu.example.test/validate';
const NOW = '2026-08-25T00:00:00.000Z';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function route(id: string, platformUserId: string, salesforceUsername: string, enabled = true): IdentityRouteRecord {
  return Object.freeze({
    id,
    platformUserId,
    userName: platformUserId,
    salesforceUsername,
    enabled,
    remark: null,
    rowVersion: '1',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function userBoundCredential(id: string, identityRouteId: string, token: string): IdentityCredentialRecord {
  return Object.freeze({
    id,
    identityRouteId,
    credentialType: 'USER_BOUND',
    tokenHash: hashUserBoundToken(token),
    tokenCiphertext: 'v1.test.test.test',
    tokenLast4: token.slice(-4),
    status: 'ACTIVE',
    generatedAt: NOW,
    lastUsedAt: null,
    revokedAt: null,
    rowVersion: '1',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

class StaticRouteRepository implements IdentityRouteRepository {
  private readonly byId = new Map<string, IdentityRouteRecord>();
  private readonly byUser = new Map<string, IdentityRouteRecord>();

  public constructor(records: readonly IdentityRouteRecord[]) {
    for (const record of records) {
      this.byId.set(record.id, record);
      this.byUser.set(record.platformUserId, record);
    }
  }

  public async getById(id: string): Promise<IdentityRouteRecord | undefined> {
    return this.byId.get(id);
  }

  public async getByPlatformUserId(platformUserId: string): Promise<IdentityRouteRecord | undefined> {
    return this.byUser.get(platformUserId);
  }

  public async list(): Promise<never> { throw new Error('not used by Buntu safety tests'); }
  public async countActive(): Promise<never> { throw new Error('not used by Buntu safety tests'); }
  public async findActiveByPlatformUserId(): Promise<never> { throw new Error('not used by Buntu safety tests'); }
  public async listActiveSalesforceUsernames(): Promise<never> { throw new Error('not used by Buntu safety tests'); }
  public async create(): Promise<never> { throw new Error('not used by Buntu safety tests'); }
  public async update(): Promise<never> { throw new Error('not used by Buntu safety tests'); }
  public async disable(): Promise<never> { throw new Error('not used by Buntu safety tests'); }
  public async delete(): Promise<never> { throw new Error('not used by Buntu safety tests'); }
}

class DelayedRouteRepository extends StaticRouteRepository {
  public readonly lookups: string[] = [];

  public constructor(
    records: readonly IdentityRouteRecord[],
    private readonly delays: ReadonlyMap<string, number>,
  ) {
    super(records);
  }

  public override async getByPlatformUserId(platformUserId: string): Promise<IdentityRouteRecord | undefined> {
    this.lookups.push(platformUserId);
    await delay(this.delays.get(platformUserId) ?? 0);
    return super.getByPlatformUserId(platformUserId);
  }
}

class CountingCredentialRepository implements IdentityCredentialRepository {
  public tokenHashLookups = 0;

  public constructor(private readonly credentials: ReadonlyMap<string, IdentityCredentialRecord>) {}

  public async getByTokenHash(tokenHash: string): Promise<IdentityCredentialRecord | undefined> {
    this.tokenHashLookups += 1;
    return this.credentials.get(tokenHash);
  }

  public async getById(id: string): Promise<IdentityCredentialRecord | undefined> {
    return this.credentials.get(id);
  }

  public async markLastUsed(): Promise<void> { /* best effort; not under test */ }
  public async getActiveByRouteId(): Promise<never> { throw new Error('not used by Buntu safety tests'); }
  public async listActiveByRouteIds(): Promise<never> { throw new Error('not used by Buntu safety tests'); }
  public async listByRouteId(): Promise<never> { throw new Error('not used by Buntu safety tests'); }
  public async create(): Promise<never> { throw new Error('not used by Buntu safety tests'); }
  public async revoke(): Promise<never> { throw new Error('not used by Buntu safety tests'); }
  public async deleteByRouteId(): Promise<never> { throw new Error('not used by Buntu safety tests'); }
}

/** Stub validator with per-token delays so concurrent requests interleave out of order. */
class DelayedBuntuValidator implements BuntuTokenValidator {
  public readonly calls: string[] = [];
  public readonly completionOrder: string[] = [];

  public constructor(private readonly mapping: ReadonlyMap<string, Readonly<{ delayMs: number; userId: string }>>) {}

  public async validate(rawToken: string): Promise<BuntuValidationResult> {
    this.calls.push(rawToken);
    const entry = this.mapping.get(rawToken);
    if (!entry) {
      return Object.freeze({
        valid: false,
        errorCode: 'MCP_BUNTU_TOKEN_INVALID',
        httpStatus: 401,
        durationMs: 0,
        validatedAt: NOW,
      });
    }
    await delay(entry.delayMs);
    this.completionOrder.push(rawToken);
    return Object.freeze({
      valid: true,
      userId: entry.userId,
      httpStatus: 200,
      durationMs: entry.delayMs,
      validatedAt: NOW,
    });
  }
}

class DelayedRecordingConnectionFactory extends RecordingConnectionFactory {
  public constructor(
    private readonly connectionDelays: ReadonlyMap<string, number>,
  ) {
    super();
  }

  public override async create(route: SalesforceIdentityRoute): Promise<Connection> {
    await delay(this.connectionDelays.get(route.salesforceUsername) ?? 0);
    return super.create(route);
  }
}

function buntuAuthenticator(
  validator: BuntuTokenValidator,
  routes: IdentityRouteRepository,
  logger: RuntimeLogger = new NoopRuntimeLogger(),
  rawTokenAuditEnabled = false,
): BuntuTokenCredentialAuthenticator {
  return new BuntuTokenCredentialAuthenticator({
    validator,
    routes,
    logger,
    clientToken: TEST_CLIENT_TOKEN,
    validateTokenUrl: VALIDATE_TOKEN_URL,
    rawTokenAuditEnabled,
  });
}

// =====================================================================
// HOTFIX 2: Buntu requires the MySQL Control Plane (fail-fast at config)
// =====================================================================

test('MCP_BUNTU_IDENTITY_ENABLED=true fails fast unless SFOA_CONTROL_PLANE_MODE=mysql', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-buntu-config-'));
  try {
    const keyPath = path.join(projectRoot, 'test.pem');
    await writeFile(keyPath, 'test-only-key', 'utf8');
    const base: NodeJS.ProcessEnv = {
      SFOA_INSTANCE_URL: 'https://example.test',
      SALESFORCE_USERNAME: 'user-a@example.test',
      SECOND_TEST_USER: 'user-b@example.test',
      CONNECTED_APP_CLIENT_ID: 'test-client',
      JWT_PRIVATE_KEY_PATH: keyPath,
      MCP_CLIENT_TOKEN: TEST_CLIENT_TOKEN,
    };
    const buntu: NodeJS.ProcessEnv = {
      MCP_BUNTU_IDENTITY_ENABLED: 'true',
      MCP_BUNTU_VALIDATE_TOKEN_URL: VALIDATE_TOKEN_URL,
    };
    const mysql: NodeJS.ProcessEnv = {
      SFOA_CONTROL_PLANE_MODE: 'mysql',
      SFOA_DB_HOST: '127.0.0.1',
      SFOA_DB_USER: 'sfoa-test',
      SFOA_DB_PASSWORD: 'test-only-db-password',
    };

    // env + Buntu enabled must fail during configuration, never at HTTP runtime time.
    await assert.rejects(
      loadRemoteRuntimeConfig(projectRoot, { ...base, ...buntu }),
      (error: unknown) =>
        error instanceof RemoteRuntimeError
        && error.code === 'MCP_RUNTIME_CONFIGURATION_INVALID'
        && error.message.includes('BUNTU_TOKEN identity requires SFOA_CONTROL_PLANE_MODE=mysql'),
    );

    // env + Buntu disabled keeps working.
    const envDisabled = await loadRemoteRuntimeConfig(projectRoot, base);
    assert.equal(envDisabled.controlPlane.mode, 'env');
    assert.equal(envDisabled.buntuIdentity.enabled, false);

    // mysql + Buntu disabled keeps working.
    const mysqlDisabled = await loadRemoteRuntimeConfig(projectRoot, { ...base, ...mysql });
    assert.equal(mysqlDisabled.controlPlane.mode, 'mysql');
    assert.equal(mysqlDisabled.buntuIdentity.enabled, false);

    // mysql + Buntu enabled keeps working.
    const mysqlEnabled = await loadRemoteRuntimeConfig(projectRoot, { ...base, ...mysql, ...buntu });
    assert.equal(mysqlEnabled.controlPlane.mode, 'mysql');
    assert.equal(mysqlEnabled.buntuIdentity.enabled, true);
    assert.equal(mysqlEnabled.buntuIdentity.validateTokenUrl, VALIDATE_TOKEN_URL);

    const rawAuditEnabled = await loadRemoteRuntimeConfig(projectRoot, {
      ...base,
      ...mysql,
      ...buntu,
      MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED: 'true',
    });
    assert.equal(rawAuditEnabled.buntuIdentity.rawTokenAuditEnabled, true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

// =====================================================================
// HOTFIX 1: Buntu bearer token redaction (CASE A and CASE B)
// =====================================================================

test('a Buntu bearer token leaked into an exception message is redacted from the HTTP error response and audit events', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-buntu-redact-'));
  const events: RuntimeLogEvent[] = [];
  const logger: RuntimeLogger = { log: (event) => { void events.push(event); } };
  const identityRuntime = createTestIdentityRuntime(baseRoot, new RecordingConnectionFactory(), logger);

  // Simulates a third-party or upstream exception whose message accidentally
  // contains the raw Buntu token.
  const leakyValidator: BuntuTokenValidator = {
    validate: async (rawToken: string) => {
      throw new RemoteRuntimeError(
        'MCP_BUNTU_IDENTITY_UNAVAILABLE',
        `simulated upstream failure while validating ${rawToken}`,
      );
    },
  };
  // Simulates the same leak on the USER_BOUND path to prove both token
  // families are covered by request-scoped redaction.
  const leakyUserBound: CredentialAuthenticator = {
    supports: (token: string | undefined) => token?.startsWith('sfoa_ub1_') ?? false,
    authenticate: async (token: string | undefined) => {
      throw new RemoteRuntimeError(
        'MCP_IDENTITY_CREDENTIAL_INVALID',
        `simulated credential lookup failure for ${token}`,
      );
    },
  };

  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig(),
    identityRuntime,
    identityProvider: new UnifiedIdentityProvider([
      leakyUserBound,
      new InternalServiceCredentialAuthenticator(TEST_CLIENT_TOKEN),
      buntuAuthenticator(leakyValidator, new StaticRouteRepository([]), new NoopRuntimeLogger()),
    ]),
  });
  try {
    const response = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: mcpHeaders(undefined, BUNTU_TOKEN_A),
      body: initializeBody(),
    });
    const body = await response.text();
    assert.equal(response.status, 502);
    assert.equal(body.includes(BUNTU_TOKEN_A), false, 'the raw Buntu token must never reach the HTTP error response');
    assert.ok(body.includes('<redacted>'), 'the token must be visibly redacted, not silently dropped');

    const userBound = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: mcpHeaders(undefined, USER_BOUND_TOKEN),
      body: initializeBody(),
    });
    const userBoundBody = await userBound.text();
    assert.equal(userBound.status, 401);
    assert.equal(userBoundBody.includes(USER_BOUND_TOKEN), false);
    assert.ok(userBoundBody.includes('<redacted>'));

    // The request-level audit events are the structured log surface.
    assert.equal(JSON.stringify(events).includes(BUNTU_TOKEN_A), false);
    assert.equal(JSON.stringify(events).includes(USER_BOUND_TOKEN), false);
  } finally {
    await server.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});

test('captureRequestBearerSecrets feeds text redaction for Buntu tokens (CASE B)', () => {
  const request = { headers: { authorization: `Bearer ${BUNTU_TOKEN_B}` } } as IncomingMessage;
  const secrets = captureRequestBearerSecrets(request);
  assert.deepEqual([...secrets], [BUNTU_TOKEN_B]);

  const error = new RemoteRuntimeError(
    'MCP_BUNTU_IDENTITY_UNAVAILABLE',
    `the identity provider rejected ${BUNTU_TOKEN_B} upstream`,
  );
  const formatted = formatRemoteRuntimeError(error, secrets);
  assert.equal(formatted.includes(BUNTU_TOKEN_B), false);
  assert.ok(formatted.includes('<redacted>'));

  // Simulated structured log/stdout line built from the formatted message.
  const structuredLogLine = JSON.stringify({ level: 'error', message: formatted, timestamp: NOW });
  assert.equal(structuredLogLine.includes(BUNTU_TOKEN_B), false);

  assert.deepEqual([...captureRequestBearerSecrets({ headers: {} } as IncomingMessage)], []);
  assert.deepEqual(
    [...captureRequestBearerSecrets({ headers: { authorization: 'Basic abc' } } as IncomingMessage)],
    [],
  );
});

// =====================================================================
// HTTP challenge: MCP_BUNTU_TOKEN_INVALID -> 401 + WWW-Authenticate: Bearer
// =====================================================================

test('a rejected Buntu token maps to HTTP 401 with a WWW-Authenticate: Bearer challenge', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-buntu-challenge-'));
  const rejectingValidator: BuntuTokenValidator = {
    validate: async () => Object.freeze({
      valid: false,
      errorCode: 'MCP_BUNTU_TOKEN_INVALID',
      httpStatus: 401,
      durationMs: 4,
      validatedAt: NOW,
    }),
  };
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig(),
    identityRuntime: createTestIdentityRuntime(baseRoot, new RecordingConnectionFactory(), new NoopRuntimeLogger()),
    identityProvider: new UnifiedIdentityProvider([
      new InternalServiceCredentialAuthenticator(TEST_CLIENT_TOKEN),
      buntuAuthenticator(rejectingValidator, new StaticRouteRepository([]), new NoopRuntimeLogger()),
    ]),
  });
  try {
    const response = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: mcpHeaders(undefined, BUNTU_TOKEN_A),
      body: initializeBody(),
    });
    const body = await response.text();
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.ok(body.includes('MCP_BUNTU_TOKEN_INVALID'));
    assert.equal(body.includes(BUNTU_TOKEN_A), false, 'the raw Buntu token must never reach the HTTP error response');
  } finally {
    await server.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});

// =====================================================================
// Explicit raw-token opt-in and audit fail-open boundary (CASE C/D)
// =====================================================================

test('raw Buntu token auditing defaults off (CASE C)', async () => {
  const events: RuntimeLogEvent[] = [];
  const logger: RuntimeLogger = { log: (event) => { void events.push(event); } };
  const routes = new StaticRouteRepository([route('r-a', USER_A, SF_A)]);
  const validator = new DelayedBuntuValidator(new Map([
    [BUNTU_TOKEN_A, { delayMs: 0, userId: USER_A }],
  ]));

  const authentication = await buntuAuthenticator(validator, routes, logger)
    .authenticate(BUNTU_TOKEN_A, 'audit-case-c');
  assert.equal(authentication.boundPlatformUserId, USER_A);

  const event = events.find((entry) => entry.operation === 'BUNTU_TOKEN_VALIDATE');
  assert.ok(event, 'expected a BUNTU_TOKEN_VALIDATE audit event');
  const summary = event.requestSummary as Record<string, unknown> | undefined;
  const hasRawToken = summary !== undefined
    && Object.prototype.hasOwnProperty.call(summary, 'rawToken');
  assert.equal(hasRawToken, false);
  assert.equal(JSON.stringify(events).includes(BUNTU_TOKEN_A), false);
});

test('raw-token opt-in reaches only the durable audit write and sink failure remains fail-open (CASE D)', async () => {
  const routes = new StaticRouteRepository([route('r-a', USER_A, SF_A)]);
  const validator = new DelayedBuntuValidator(new Map([
    [BUNTU_TOKEN_A, { delayMs: 0, userId: USER_A }],
  ]));

  class FailingAuditRepository {
    public readonly writes: AuditWrite[] = [];
    public async append(event: AuditWrite): Promise<never> {
      this.writes.push(event);
      throw new Error('simulated audit persistence failure');
    }
  }
  const failingRepo = new FailingAuditRepository();
  const fallbackEvents: RuntimeLogEvent[] = [];
  const fallback: RuntimeLogger = { log: (event) => { void fallbackEvents.push(event); } };
  const databaseLogger = new DatabaseRuntimeLogger(failingRepo as unknown as AuditRepository, fallback);

  const authentication = await buntuAuthenticator(validator, routes, databaseLogger, true)
    .authenticate(BUNTU_TOKEN_A, 'audit-case-d');
  assert.equal(authentication.boundPlatformUserId, USER_A);

  assert.equal(failingRepo.writes.length, 1);
  const requestSummary = failingRepo.writes[0]?.requestSummary as Record<string, unknown> | undefined;
  assert.equal(Object.prototype.hasOwnProperty.call(requestSummary ?? {}, 'rawToken'), false);
  assert.equal(failingRepo.writes[0]?.buntuRawTokenEvidence, BUNTU_TOKEN_A);

  // The fallback (stdout/stderr path) never receives the raw token or the summaries.
  assert.equal(JSON.stringify(fallbackEvents).includes(BUNTU_TOKEN_A), false);
  assert.ok(fallbackEvents.length > 0);
  assert.ok(fallbackEvents.every((event) => event.requestSummary === undefined && event.responseSummary === undefined));
  assert.equal(fallbackEvents[0]?.errorCode, 'MCP_AUDIT_PERSISTENCE_FAILED');
});

// =====================================================================
// HOTFIX 4 layer 1: Buntu provider concurrency isolation
// =====================================================================

test('Buntu provider concurrency: out-of-order validations never cross identities', async () => {
  const ROUNDS = 100;
  const validator = new DelayedBuntuValidator(new Map([
    [BUNTU_TOKEN_A, { delayMs: 120, userId: USER_A }],
    [BUNTU_TOKEN_B, { delayMs: 10, userId: USER_B }],
    [BUNTU_TOKEN_C, { delayMs: 70, userId: USER_C }],
  ]));
  const routes = new StaticRouteRepository([
    route('r-a', USER_A, SF_A),
    route('r-b', USER_B, SF_B),
    route('r-c', USER_C, SF_C),
  ]);
  const authenticator = buntuAuthenticator(validator, routes);
  const tokens = [BUNTU_TOKEN_A, BUNTU_TOKEN_B, BUNTU_TOKEN_C] as const;
  const expectedIdentity: Readonly<Record<(typeof tokens)[number], string>> = {
    [BUNTU_TOKEN_A]: USER_A,
    [BUNTU_TOKEN_B]: USER_B,
    [BUNTU_TOKEN_C]: USER_C,
  };

  let identityMismatches = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const results = await Promise.all(
      tokens.map((token) => authenticator.authenticate(token, `provider-concurrency-${round}`)),
    );
    for (const [index, token] of tokens.entries()) {
      if (results[index]?.boundPlatformUserId !== expectedIdentity[token]) identityMismatches += 1;
    }
  }

  assert.equal(identityMismatches, 0);
  assert.equal(validator.calls.length, ROUNDS * tokens.length);
  // Every round must interleave: B (10ms) completes before C (70ms) before A (120ms).
  for (let round = 0; round < ROUNDS; round += 1) {
    const slice = validator.completionOrder.slice(round * tokens.length, (round + 1) * tokens.length);
    assert.deepEqual(slice, [BUNTU_TOKEN_B, BUNTU_TOKEN_C, BUNTU_TOKEN_A], `round ${round} must complete out of order`);
  }
});

// =====================================================================
// HOTFIX 4 layer 2: identity route concurrency isolation
// =====================================================================

test('identity route concurrency: out-of-order route lookups never cross Salesforce users', async () => {
  const ROUNDS = 100;
  const validator = new DelayedBuntuValidator(new Map([
    [BUNTU_TOKEN_A, { delayMs: 120, userId: USER_A }],
    [BUNTU_TOKEN_B, { delayMs: 10, userId: USER_B }],
    [BUNTU_TOKEN_C, { delayMs: 70, userId: USER_C }],
  ]));
  const routes = new DelayedRouteRepository(
    [
      route('r-a', USER_A, SF_A),
      route('r-b', USER_B, SF_B),
      route('r-c', USER_C, SF_C),
    ],
    new Map([[USER_A, 30], [USER_B, 90], [USER_C, 10]]),
  );
  const authenticator = buntuAuthenticator(validator, routes);
  const tokens = [BUNTU_TOKEN_A, BUNTU_TOKEN_B, BUNTU_TOKEN_C] as const;
  const expected: Readonly<Record<(typeof tokens)[number], Readonly<{ platformUserId: string; salesforceUsername: string }>>> = {
    [BUNTU_TOKEN_A]: { platformUserId: USER_A, salesforceUsername: SF_A },
    [BUNTU_TOKEN_B]: { platformUserId: USER_B, salesforceUsername: SF_B },
    [BUNTU_TOKEN_C]: { platformUserId: USER_C, salesforceUsername: SF_C },
  };

  let identityMismatches = 0;
  let routeMismatches = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const authentications = await Promise.all(
      tokens.map((token) => authenticator.authenticate(token, `route-concurrency-${round}`)),
    );
    const resolvedRoutes = await Promise.all(
      authentications.map((authentication) => routes.getByPlatformUserId(authentication.boundPlatformUserId ?? '')),
    );
    for (const [index, token] of tokens.entries()) {
      const authentication = authentications[index];
      const resolvedRoute = resolvedRoutes[index];
      if (authentication?.boundPlatformUserId !== expected[token].platformUserId) identityMismatches += 1;
      if (resolvedRoute?.salesforceUsername !== expected[token].salesforceUsername) routeMismatches += 1;
    }
  }

  assert.equal(identityMismatches, 0);
  assert.equal(routeMismatches, 0);
  assert.equal(routes.lookups.length >= ROUNDS * tokens.length, true);
});

// =====================================================================
// HOTFIX 4 layer 3: request scope / connection concurrency isolation
// =====================================================================

test('request scope concurrency: each platform user only ever receives its own Salesforce connection', async () => {
  const ROUNDS = 30;
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-buntu-scope-'));
  const connectionFactory: SalesforceConnectionFactory = new DelayedRecordingConnectionFactory(new Map([
    [SF_A, 80],
    [SF_B, 10],
    [SF_C, 45],
  ]));
  const identityRuntime = createTestIdentityRuntime(baseRoot, connectionFactory);
  const routes: readonly SalesforceIdentityRoute[] = [
    createSalesforceIdentityRoute({
      platformUserId: USER_A,
      salesforceUsername: SF_A,
      credentialProfile: 'test-profile',
      connectionRole: 'USER',
      aliases: [],
    }),
    createSalesforceIdentityRoute({
      platformUserId: USER_B,
      salesforceUsername: SF_B,
      credentialProfile: 'test-profile',
      connectionRole: 'USER',
      aliases: [],
    }),
    createSalesforceIdentityRoute({
      platformUserId: USER_C,
      salesforceUsername: SF_C,
      credentialProfile: 'test-profile',
      connectionRole: 'USER',
      aliases: [],
    }),
  ];

  let scopeMismatches = 0;
  let connectionMismatches = 0;
  try {
    for (let round = 0; round < ROUNDS; round += 1) {
      const scopes = await Promise.all(
        routes.map((routeForScope) => identityRuntime.scopeFactory.createForRoute(
          { platformUserId: routeForScope.platformUserId, correlationId: `scope-concurrency-${round}-${routeForScope.platformUserId}` },
          routeForScope,
        )),
      );
      for (const [index, scope] of scopes.entries()) {
        const expectedRoute = routes[index];
        assert.ok(expectedRoute);
        if (scope.route.salesforceUsername !== expectedRoute.salesforceUsername) scopeMismatches += 1;
        const identity = await (await scope.getConnection()).identity();
        if (identity.username !== expectedRoute.salesforceUsername) connectionMismatches += 1;
      }
      await Promise.all(scopes.map((scope) => scope.close()));
    }
  } finally {
    await rm(baseRoot, { recursive: true, force: true });
  }

  assert.equal(scopeMismatches, 0);
  assert.equal(connectionMismatches, 0);
});

// =====================================================================
// Deterministic provider routing under concurrency (no provider crosstalk)
// =====================================================================

test('concurrent mixed-provider authentication never crosses provider boundaries', async () => {
  const ROUNDS = 25;
  const validator = new DelayedBuntuValidator(new Map([
    [BUNTU_TOKEN_B, { delayMs: 40, userId: USER_B }],
  ]));
  const routes = new StaticRouteRepository([route('r-a', USER_A, SF_A), route('r-b', USER_B, SF_B)]);
  const credentials = new CountingCredentialRepository(new Map([
    [hashUserBoundToken(USER_BOUND_TOKEN), userBoundCredential('cred-1', 'r-a', USER_BOUND_TOKEN)],
  ]));
  const provider = new UnifiedIdentityProvider([
    new UserBoundCredentialAuthenticator(credentials, routes, new NoopRuntimeLogger()),
    new InternalServiceCredentialAuthenticator(TEST_CLIENT_TOKEN),
    buntuAuthenticator(validator, routes),
  ]);

  for (let round = 0; round < ROUNDS; round += 1) {
    const [userBound, internal, buntu] = await Promise.all([
      provider.authenticate({ authorization: `Bearer ${USER_BOUND_TOKEN}` }, 'X-Platform-User-Id', `crossover-${round}-ub`),
      provider.authenticate(
        { authorization: `Bearer ${TEST_CLIENT_TOKEN}`, 'x-platform-user-id': USER_A },
        'X-Platform-User-Id',
        `crossover-${round}-internal`,
      ),
      provider.authenticate({ authorization: `Bearer ${BUNTU_TOKEN_B}` }, 'X-Platform-User-Id', `crossover-${round}-buntu`),
    ]);

    assert.equal(userBound.identitySource, 'USER_BOUND_TOKEN');
    assert.equal(userBound.platformUserId, USER_A);
    assert.equal(internal.identitySource, 'INTERNAL_SERVICE_HEADER');
    assert.equal(internal.platformUserId, USER_A);
    assert.equal(buntu.identitySource, 'BUNTU_TOKEN');
    assert.equal(buntu.platformUserId, USER_B);
  }

  // The Buntu validator only ever saw Buntu tokens.
  assert.deepEqual(validator.calls, Array.from({ length: ROUNDS }, () => BUNTU_TOKEN_B));
  // USER_BOUND credential lookups only ever happened for the USER_BOUND token.
  assert.equal(credentials.tokenHashLookups, ROUNDS);
});

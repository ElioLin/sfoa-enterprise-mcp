import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ControlPlaneError,
  type AuditRecord,
  type AuditWrite,
  type ControlPlaneRepositories,
  type DiagnosticConfigRecord,
  type DmlPolicyRecord,
  type IdentityRouteRecord,
  type Page,
  type RuntimeSettingRecord,
  type ToolControlRecord,
} from '@sfoa/control-plane';
import type { IdentityRuntime } from '@sfoa/identity-runtime';
import type { UpstreamInventoryComparison } from '@sfoa/mcp-server';
import { hashAdminPassword } from '../auth.js';
import type { AdminApiConfig } from '../config.js';
import { startAdminApiServer, type StartAdminApiServerOptions } from '../http-server.js';

const ORIGIN = 'http://127.0.0.1:5173';
const ADMIN = 'bootstrap-admin';
const PASSWORD = 'correct horse battery staple';
const SECRET_MARKERS = ['db-super-secret', 'mcp-super-secret', 'private-key-secret'];
const now = '2026-01-01T00:00:00.000Z';

test('Admin liveness stays UP while database readiness fails with 503', async (context) => {
  const passwordHash = await hashAdminPassword(PASSWORD);
  const options = createOptions(passwordHash, createRepositories());
  const server = await startAdminApiServer({
    ...options,
    store: Object.freeze({
      repositories: options.store.repositories,
      health: async () => { throw new Error('database unavailable'); },
    }),
  });
  context.after(() => server.close());
  const root = server.baseUrl.href.replace(/\/$/u, '');

  const health = await fetch(`${root}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'UP' });
  const ready = await fetch(`${root}/ready`);
  assert.equal(ready.status, 503);
  assert.equal((await ready.json() as Readonly<{ error: Readonly<{ code: string }> }>).error.code, 'MCP_ADMIN_NOT_READY');
});

test('Admin HTTP boundary enforces auth, Origin, CSRF, strict input, conflicts, and masking', async (context) => {
  const passwordHash = await hashAdminPassword(PASSWORD);
  const repositories = createRepositories();
  const options = createOptions(passwordHash, repositories);
  const server = await startAdminApiServer(options);
  context.after(() => server.close());
  const root = server.baseUrl.href.replace(/\/$/u, '');

  const denied = await fetch(`${root}/routes`);
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('cache-control'), 'no-store');

  const badOrigin = await postJson(`${root}/auth/login`, { username: ADMIN, password: PASSWORD }, 'http://evil.invalid');
  assert.equal(badOrigin.status, 403);

  const badLogin = await postJson(`${root}/auth/login`, { username: ADMIN, password: 'not-the-password' }, ORIGIN);
  assert.equal(badLogin.status, 401);

  const login = await postJson(`${root}/auth/login`, { username: ADMIN, password: PASSWORD }, ORIGIN);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /SameSite=Strict/u);
  const session = await login.json() as Readonly<{ csrfToken: string }>;
  assert.match(session.csrfToken, /^[A-Za-z0-9_-]+$/u);

  const me = await fetch(`${root}/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200);

  const missingCsrf = await postJson(`${root}/routes`, routeInput(), ORIGIN, cookie);
  assert.equal(missingCsrf.status, 403);

  const wrongOrigin = await postJson(`${root}/routes`, routeInput(), 'http://evil.invalid', cookie, session.csrfToken);
  assert.equal(wrongOrigin.status, 403);

  const created = await postJson(`${root}/routes`, routeInput(), ORIGIN, cookie, session.csrfToken);
  assert.equal(created.status, 201);

  const overPage = await fetch(`${root}/routes?limit=101`, { headers: { Cookie: cookie } });
  assert.equal(overPage.status, 400);

  const repeatedPage = await fetch(`${root}/routes?limit=10&limit=20`, { headers: { Cookie: cookie } });
  assert.equal(repeatedPage.status, 400);

  const injectionPath = await fetch(`${root}/routes/${encodeURIComponent("1 OR 1=1")}`, {
    method: 'DELETE',
    headers: mutationHeaders(cookie, session.csrfToken),
    body: JSON.stringify({ rowVersion: '1' }),
  });
  assert.equal(injectionPath.status, 400);

  const deleteDml = await postJson(`${root}/dml-policies`, {
    objectApiName: 'Lead', allowCreate: true, allowUpdate: false, allowDelete: true, enabled: true, remark: null,
  }, ORIGIN, cookie, session.csrfToken);
  assert.equal(deleteDml.status, 400);

  const unknownTool = await fetch(`${root}/tools/future_unknown_tool`, {
    method: 'PUT',
    headers: mutationHeaders(cookie, session.csrfToken),
    body: JSON.stringify({ enabled: true, remark: null, rowVersion: null }),
  });
  assert.equal(unknownTool.status, 400);
  assert.equal((await unknownTool.json() as Readonly<{ error: Readonly<{ code: string }> }>).error.code, 'MCP_ADMIN_INPUT_INVALID');

  const conflict = await fetch(`${root}/routes/1`, {
    method: 'PUT',
    headers: mutationHeaders(cookie, session.csrfToken),
    body: JSON.stringify({ ...routeInput(), rowVersion: '99' }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as Readonly<{ error: Readonly<{ code: string }> }>).error.code, 'MCP_ADMIN_CONCURRENT_MODIFICATION');

  const system = await fetch(`${root}/system/status`, { headers: { Cookie: cookie } });
  assert.equal(system.status, 200);
  const systemText = await system.text();
  for (const marker of SECRET_MARKERS) assert.equal(systemText.includes(marker), false);
  assert.match(systemText, /CONNECTED_APP_CLIENT_ID_CONFIGURED/u);

  const logout = await fetch(`${root}/auth/logout`, {
    method: 'POST',
    headers: mutationHeaders(cookie, session.csrfToken),
  });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${root}/auth/me`, { headers: { Cookie: cookie } });
  assert.equal(afterLogout.status, 401);
});

function createOptions(passwordHash: string, repositories: ControlPlaneRepositories): StartAdminApiServerOptions {
  const config: AdminApiConfig = Object.freeze({
    bindHost: '127.0.0.1', port: 0, allowedOrigin: ORIGIN, username: ADMIN, passwordHash,
    sessionSecret: 'session-signing-secret-that-is-at-least-thirty-two-characters',
    sessionTtlSeconds: 300, cookieSecure: false, cookieName: 'sfoa_admin', loginMaxAttempts: 5, loginWindowMs: 60_000,
  });
  const upstream: UpstreamInventoryComparison = Object.freeze({ status: 'PASS', drift: Object.freeze([]) });
  const identityRuntime = Object.freeze({ redactionSecrets: Object.freeze([...SECRET_MARKERS]) }) as unknown as IdentityRuntime;
  const migrations: StartAdminApiServerOptions['migrations'] = Object.freeze([
    Object.freeze({
      version: '001_p5_control_plane',
      checksumSha256: 'a'.repeat(64),
      state: 'APPLIED',
      appliedAt: now,
    }),
  ]);
  const adminService: StartAdminApiServerOptions['adminService'] = {
    createIdentityRoute: async (input) => routeRecord({ ...input, id: '1', rowVersion: '1' }),
    updateIdentityRoute: async (id, input) => {
      if (input.rowVersion === '99') {
        throw new ControlPlaneError('MCP_ADMIN_CONCURRENT_MODIFICATION', 'Refresh and retry.');
      }
      return routeRecord({ ...input, id, rowVersion: '2' });
    },
    disableIdentityRoute: async (id) => routeRecord({ ...routeInput(), id, enabled: false, rowVersion: '2' }),
    updateTool: async () => {
      throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'Unknown Tool cannot be enabled.');
    },
    createDmlPolicy: async (input) => dmlRecord({ ...input, id: '1', rowVersion: '1' }),
    updateDmlPolicy: async (id, input) => dmlRecord({ ...input, id, rowVersion: '2' }),
    disableDmlPolicy: async (id) => dmlRecord({
      id, objectApiName: 'Lead', allowCreate: true, allowUpdate: false, enabled: false, remark: null, rowVersion: '2',
    }),
    updateDiagnostic: async (input) => diagnosticRecord({ ...input, rowVersion: '1' }),
    recordDiagnosticVerification: async () => diagnosticRecord({ rowVersion: '2' }),
    updateRuntimeSetting: async (key, value) => Object.freeze({ settingKey: key, settingValue: value, rowVersion: '1', updatedAt: now }),
  };
  return Object.freeze({
    config,
    store: Object.freeze({ repositories, health: async () => Object.freeze({ version: '8.4.0-test' }) }),
    adminService,
    identityRuntime,
    upstream,
    migrations,
    system: Object.freeze({
      adminVersion: '0.1.0-p5', mcpServerVersion: '0.1.0-p5', salesforceApiVersion: 'LATEST_PER_FRESH_CONNECTION',
      providerVersions: Object.freeze([{ name: '@salesforce/mcp-provider-dx-core', version: '0.10.0' }]),
      runtimeMode: 'mysql', salesforceInstanceHost: 'example.my.salesforce.com', connectedAppConfigured: true,
      jwtPrivateKeyConfigured: true, mcpClientTokenConfigured: true, mcpEndpoint: 'http://127.0.0.1:8080/mcp',
      readOnlyRuntimeSettings: Object.freeze({ CONNECTED_APP_CLIENT_ID_CONFIGURED: true }),
      phases: Object.freeze({ P0: 'PASS', P1: 'PASS', P2: 'PASS', P3: 'PASS', P4: 'PARTIAL', P5: 'PARTIAL' }),
    }),
    auditPersistenceHealth: () => Object.freeze({ status: 'UP', failureCount: 0, lastFailureAt: null }),
    probeMcpHealth: async () => Object.freeze({ status: 'UP', auditPersistence: Object.freeze({ status: 'UP', failureCount: 0 }) }),
  });
}

function createRepositories(): ControlPlaneRepositories {
  let auditId = 0;
  return Object.freeze({
    identityRoutes: {
      list: async ({ limit, offset }) => page([], limit, offset),
      countActive: async () => 0,
      getById: async () => undefined,
      getByPlatformUserId: async () => undefined,
      findActiveByPlatformUserId: async () => undefined,
      listActiveSalesforceUsernames: async () => Object.freeze([]),
      create: async (input) => routeRecord({ ...input, id: '1', rowVersion: '1' }),
      update: async (id, input) => routeRecord({ ...input, id, rowVersion: '2' }),
      disable: async (id) => routeRecord({ ...routeInput(), id, enabled: false, rowVersion: '2' }),
    },
    tools: {
      list: async ({ limit, offset }) => page<ToolControlRecord>([], limit, offset),
      countEnabled: async () => 0,
      getByName: async () => undefined,
      listEnabledNames: async () => Object.freeze([]),
      createIfAbsent: async (toolName, enabled, remark) => toolRecord(toolName, enabled, remark),
      update: async (toolName, input) => toolRecord(toolName, input.enabled, input.remark),
    },
    dmlPolicies: {
      list: async ({ limit, offset }) => page<DmlPolicyRecord>([], limit, offset),
      countEnabled: async () => 0,
      getById: async () => undefined,
      getByObjectApiName: async () => undefined,
      listEnabled: async () => Object.freeze([]),
      create: async (input) => dmlRecord({ ...input, id: '1', rowVersion: '1' }),
      update: async (id, input) => dmlRecord({ ...input, id, rowVersion: '2' }),
      disable: async (id) => dmlRecord({ id, objectApiName: 'Lead', allowCreate: true, allowUpdate: false, enabled: false, remark: null, rowVersion: '2' }),
    },
    diagnostic: {
      get: async () => diagnosticRecord({ rowVersion: '1' }),
      upsert: async (input) => diagnosticRecord({ ...input, rowVersion: '1' }),
      recordVerification: async () => diagnosticRecord({ rowVersion: '2' }),
    },
    runtimeSettings: {
      list: async () => Object.freeze([]),
      get: async () => undefined,
      upsert: async (settingKey, settingValue) => Object.freeze({ settingKey, settingValue, rowVersion: '1', updatedAt: now }),
    },
    audits: {
      append: async (event: AuditWrite) => auditRecord(String(++auditId), event),
      getById: async () => undefined,
      search: async (filter) => page<AuditRecord>([], filter.limit, filter.offset),
      countSince: async () => Object.freeze({ total: 0, pass: 0, blocked: 0, error: 0, unknown: 0 }),
    },
  });
}

function routeInput(): Readonly<{ platformUserId: string; salesforceUsername: string; enabled: boolean; remark: null }> {
  return Object.freeze({ platformUserId: 'platform-user-a', salesforceUsername: 'user@example.invalid', enabled: true, remark: null });
}

function routeRecord(input: Readonly<{
  id: string; platformUserId: string; salesforceUsername: string; enabled: boolean; remark: string | null; rowVersion: string;
}>): IdentityRouteRecord {
  return Object.freeze({ ...input, createdAt: now, updatedAt: now });
}

function dmlRecord(input: Readonly<{
  id: string; objectApiName: string; allowCreate: boolean; allowUpdate: boolean; enabled: boolean; remark: string | null; rowVersion: string;
}>): DmlPolicyRecord {
  return Object.freeze({ ...input, createdAt: now, updatedAt: now });
}

function diagnosticRecord(input: Readonly<{
  salesforceUsername?: string; enabled?: boolean; testMetadataType?: string | null; testMetadataFullName?: string | null; rowVersion: string;
}>): DiagnosticConfigRecord {
  return Object.freeze({
    id: '1', salesforceUsername: input.salesforceUsername ?? 'diagnostic@example.invalid', enabled: input.enabled ?? true,
    verificationStatus: 'NOT_VERIFIED', lastVerifiedAt: null, lastErrorCode: null, lastErrorMessageSafe: null,
    testMetadataType: input.testMetadataType ?? 'ApexClass', testMetadataFullName: input.testMetadataFullName ?? 'SafeClass',
    rowVersion: input.rowVersion, createdAt: now, updatedAt: now,
  });
}

function toolRecord(toolName: string, enabled: boolean, remark: string | null): ToolControlRecord {
  return Object.freeze({ id: '1', toolName, enabled, remark, rowVersion: '1', createdAt: now, updatedAt: now });
}

function auditRecord(id: string, event: AuditWrite): AuditRecord {
  return Object.freeze({
    id, occurredAt: event.occurredAt.toISOString(), correlationId: event.correlationId, channel: event.channel,
    clientId: event.clientId ?? null, actorAdmin: event.actorAdmin ?? null, platformUserId: event.platformUserId ?? null,
    salesforceUsername: event.salesforceUsername ?? null, executionRole: event.executionRole ?? null,
    toolName: event.toolName ?? null, operation: event.operation ?? null, objectApiName: event.objectApiName ?? null,
    recordId: event.recordId ?? null, result: event.result, outcome: event.outcome ?? null, errorCode: event.errorCode ?? null,
    durationMs: event.durationMs ?? null, requestSummary: event.requestSummary ?? null,
    responseSummary: event.responseSummary ?? null, createdAt: now,
  });
}

function page<T>(items: readonly T[], limit: number, offset: number): Page<T> {
  return Object.freeze({ items: Object.freeze([...items]), limit, offset, count: items.length, hasMore: false, nextOffset: null });
}

function mutationHeaders(cookie: string, csrf: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie, 'X-SFoA-CSRF-Token': csrf };
}

async function postJson(
  url: string,
  body: unknown,
  origin: string,
  cookie?: string,
  csrf?: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: origin };
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-SFoA-CSRF-Token'] = csrf;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

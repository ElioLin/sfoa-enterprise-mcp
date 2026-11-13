import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ADMIN_MODULE_IDS,
  DshScenarioService,
  type IdentityRouteRecord,
  type ControlPlaneRepositoriesWithAuditTrace,
} from '@sfoa/control-plane';
import { InMemoryControlPlaneStore } from '@sfoa/control-plane/testing';
import type { IdentityRuntime } from '@sfoa/identity-runtime';
import type { BuntuTokenValidator, BuntuValidationResult, UpstreamInventoryComparison } from '@sfoa/mcp-server';
import type { AdminAccount, AdminApiConfig } from '../config.js';
import { startAdminApiServer, type StartAdminApiServerOptions } from '../http-server.js';

/**
 * DSH-01 acceptance tests over the real HTTP surface.
 *
 * Everything below runs through `startAdminApiServer` and the production `DshScenarioService`
 * backed by the shared in-memory repository, so the version arithmetic, permission gate, CORS and
 * multipart parser under test are the same code paths a deployed build uses. Only the Buntu
 * validate-token call and MySQL are replaced.
 */

const ORIGIN = 'http://127.0.0.1:5173';
const ADMIN = 'bootstrap-admin';
const PASSWORD = 'correct horse battery staple';
const SCOPED = 'scoped-auditor';
const SCOPED_PASSWORD = 'scoped horse battery staple';

/** token -> platform user. A token absent from this map is rejected, like a real 401 upstream. */
const BUNTU_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  'buntu-manager': 'platform-manager',
  'buntu-normal': 'platform-normal',
  'buntu-disabled-route': 'platform-disabled',
});

class FakeBuntuValidator implements BuntuTokenValidator {
  public readonly calls: string[] = [];

  public async validate(rawToken: string): Promise<BuntuValidationResult> {
    this.calls.push(rawToken);
    const userId = BUNTU_TOKENS[rawToken];
    const validatedAt = new Date().toISOString();
    return userId
      ? Object.freeze({ valid: true, userId, httpStatus: 200, durationMs: 1, validatedAt, upstreamSuccess: true })
      : Object.freeze({
          valid: false,
          httpStatus: 401,
          durationMs: 1,
          validatedAt,
          errorCode: 'MCP_BUNTU_TOKEN_INVALID' as const,
        });
  }
}

type Harness = Readonly<{
  server: Awaited<ReturnType<typeof startAdminApiServer>>;
  store: InMemoryControlPlaneStore;
  validator: FakeBuntuValidator;
  root: string;
}>;

async function startHarness(): Promise<Harness> {
  const store = new InMemoryControlPlaneStore();
  const manager = await createRoute(store, 'platform-manager', 'manager@example.invalid');
  await grantScenarioPermission(store, manager, true);
  await createRoute(store, 'platform-normal', 'normal@example.invalid');
  const granted = await grantScenarioPermission(
    store,
    await createRoute(store, 'platform-disabled', 'disabled@example.invalid'),
    true,
  );
  await disableRoute(store, granted);

  const validator = new FakeBuntuValidator();
  const server = await startAdminApiServer(createOptions(store, validator));
  return Object.freeze({ server, store, validator, root: server.baseUrl.href.replace(/\/$/u, '').replace('/admin/api', '') });
}

function createOptions(
  store: InMemoryControlPlaneStore,
  validator: BuntuTokenValidator,
): StartAdminApiServerOptions {
  const repositories: ControlPlaneRepositoriesWithAuditTrace = store.repositories;
  const config: AdminApiConfig = Object.freeze({
    bindHost: '127.0.0.1',
    port: 0,
    allowedOrigin: ORIGIN,
    username: ADMIN,
    password: PASSWORD,
    accounts: Object.freeze<AdminAccount[]>([
      Object.freeze({ username: ADMIN, password: PASSWORD, fullAccess: true, modules: Object.freeze([...ADMIN_MODULE_IDS]) }),
      // A scoped Console account that does NOT hold the standard-scenario module.
      Object.freeze({
        username: SCOPED,
        password: SCOPED_PASSWORD,
        fullAccess: false,
        modules: Object.freeze(['audit'] as const),
      }),
    ]),
    sessionSecret: 'session-signing-secret-that-is-at-least-thirty-two-characters',
    sessionTtlSeconds: 300,
    cookieSecure: false,
    cookieName: 'sfoa_admin',
    loginMaxAttempts: 5,
    loginWindowMs: 60_000,
    dshAllowedOrigins: Object.freeze(['*']),
    dshMaxAttachmentBytes: 1_048_576,
  });
  const upstream: UpstreamInventoryComparison = Object.freeze({ status: 'PASS', drift: Object.freeze([]) });
  const identityRuntime = Object.freeze({ redactionSecrets: Object.freeze([]) }) as unknown as IdentityRuntime;
  const migrations: StartAdminApiServerOptions['migrations'] = Object.freeze([
    Object.freeze({
      version: '018_dsh_standard_scenarios',
      checksumSha256: 'b'.repeat(64),
      state: 'APPLIED',
      appliedAt: '2026-01-01T00:00:00.000Z',
    }),
  ]);
  return Object.freeze({
    config,
    store: Object.freeze({ repositories, health: async () => Object.freeze({ version: '8.4.0-test' }) }),
    // The DSH surface never reaches the Admin service; a frozen empty double keeps the type honest.
    adminService: Object.freeze({}) as unknown as StartAdminApiServerOptions['adminService'],
    identityRuntime,
    dsh: Object.freeze({
      service: new DshScenarioService(store),
      buntuValidator: validator,
      platformIdentityHeaders: Object.freeze(['x-sfoa-platform-user']),
      authMode: 'internal_bearer' as const,
      clientToken: 'mcp-client-token-for-tests',
      allowedOrigins: Object.freeze(['*']),
      maxAttachmentBytes: 1_048_576,
    }),
    upstream,
    migrations,
    system: Object.freeze({
      adminVersion: '0.1.0-dsh', mcpServerVersion: '0.1.0-p5', salesforceApiVersion: 'LATEST_PER_FRESH_CONNECTION',
      providerVersions: Object.freeze([]),
      runtimeMode: 'mysql', salesforceInstanceHost: 'example.my.salesforce.com',
      connectedAppConfigured: true, jwtPrivateKeyConfigured: true, mcpClientTokenConfigured: true,
      mcpEndpoint: 'http://127.0.0.1:8080/mcp',
      mcpPublicEndpoint: Object.freeze({ url: 'http://127.0.0.1:8080/mcp', source: 'LOOPBACK_FALLBACK', warning: null }),
      identityCredentialEncryptionKeyConfigured: true,
      readOnlyRuntimeSettings: Object.freeze({}),
      phases: Object.freeze({ P0: 'PASS', P1: 'PASS', P2: 'PASS', P3: 'PASS', P4: 'PASS', P5: 'PASS' }),
      buildPhase: 'DSH-01',
      capabilities: Object.freeze(['DSH_STANDARD_SCENARIOS']),
    }),
    auditPersistenceHealth: () => Object.freeze({
      status: 'UP', failureCount: 0, lastFailureAt: null, lastDropAt: null, queueDepth: 0, queueCapacity: 0,
      enqueuedSnapshots: 0, persistedSnapshots: 0, droppedSnapshots: 0, writerFailureCount: 0, queueFullCount: 0,
      lastSuccessAt: null, writerState: 'SYNCHRONOUS',
    }),
    probeMcpHealth: async () => Object.freeze({ status: 'UP' }),
  });
}

async function createRoute(store: InMemoryControlPlaneStore, platformUserId: string, salesforceUsername: string): Promise<IdentityRouteRecord> {
  return store.repositories.identityRoutes.create({
    platformUserId,
    userName: platformUserId,
    salesforceUsername,
    enabled: true,
    remark: null,
  });
}

async function grantScenarioPermission(
  store: InMemoryControlPlaneStore,
  route: IdentityRouteRecord,
  value: boolean,
): Promise<IdentityRouteRecord> {
  return store.repositories.identityRoutes.update(route.id, {
    platformUserId: route.platformUserId,
    userName: route.userName,
    salesforceUsername: route.salesforceUsername,
    enabled: route.enabled,
    canManageDshScenarios: value,
    remark: route.remark,
    rowVersion: route.rowVersion,
  });
}

async function disableRoute(store: InMemoryControlPlaneStore, route: IdentityRouteRecord): Promise<void> {
  await store.repositories.identityRoutes.disable(route.id, route.rowVersion);
}

function authHeaders(token: string): Readonly<Record<string, string>> {
  return Object.freeze({ Authorization: `Bearer ${token}` });
}

async function jsonRequest(
  root: string,
  path: string,
  init: Readonly<{ method?: string; token?: string; body?: unknown; headers?: Readonly<Record<string, string>> }> = {},
): Promise<Response> {
  return fetch(`${root}/api/dsh${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.token ? authHeaders(init.token) : {}),
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

test('DSH-01 permission chain: an ungranted route reads the catalogue but is refused every write', async (context) => {
  const harness = await startHarness();
  context.after(() => harness.server.close());

  // Read path: no credential at all still answers, with auth.authenticated = false.
  const anonymous = await jsonRequest(harness.root, '/scenarios');
  assert.equal(anonymous.status, 200);
  const anonymousBody = await anonymous.json() as Readonly<{
    auth: Readonly<{ authenticated: boolean; canManageStandardScenario: boolean; platformUserId: string | null }>;
    scenarios: readonly unknown[];
    deletedScenarioIds: readonly string[];
  }>;
  assert.deepEqual(anonymousBody.auth, {
    authenticated: false, platformUserId: null, crmUsername: null, canManageStandardScenario: false,
  });
  assert.deepEqual(anonymousBody.scenarios, []);
  assert.deepEqual(anonymousBody.deletedScenarioIds, []);

  // A rejected token is still a read: 200 with authenticated=false, never a 401.
  const rejected = await jsonRequest(harness.root, '/scenarios', { token: 'not-a-buntu-token' });
  assert.equal(rejected.status, 200);
  assert.equal((await rejected.json() as Readonly<{ auth: Readonly<{ authenticated: boolean }> }>).auth.authenticated, false);

  // Priority 1: the Buntu token resolves the platform user through the route table.
  const permission = await jsonRequest(harness.root, '/scenarios/permission', { token: 'buntu-normal' });
  assert.equal(permission.status, 200);
  assert.deepEqual(await permission.json(), {
    authenticated: true,
    platformUserId: 'platform-normal',
    crmUsername: 'normal@example.invalid',
    canManageStandardScenario: false,
  });

  const scenario = { scenarioId: 'lead-triage', title: '商机跟进', description: '标准商机跟进场景', scenarioPayload: {} };
  for (const [method, path, body] of [
    ['POST', '/scenarios', scenario],
    ['PUT', '/scenarios/lead-triage', { description: 'try to edit' }],
    ['DELETE', '/scenarios/lead-triage', undefined],
    ['POST', '/scenarios/lead-triage/attachments', { fileName: 'a.txt', mimeType: 'text/plain', contentBase64: 'YQ==' }],
  ] as const) {
    const response = await jsonRequest(harness.root, path, {
      method,
      token: 'buntu-normal',
      ...(body === undefined ? {} : { body }),
    });
    assert.equal(response.status, 403, `${method} ${path} must be refused`);
    const error = await response.json() as Readonly<{ error: Readonly<{ code: string }> }>;
    assert.equal(error.error.code, 'DSH_SCENARIO_PERMISSION_DENIED');
  }

  // Granting the bit on the same route is the whole switch: the next request is allowed.
  const route = await harness.store.repositories.identityRoutes.getByPlatformUserId('platform-normal');
  assert.ok(route);
  await grantScenarioPermission(harness.store, route, true);
  assert.deepEqual(await (await jsonRequest(harness.root, '/scenarios/permission', { token: 'buntu-normal' })).json(), {
    authenticated: true,
    platformUserId: 'platform-normal',
    crmUsername: 'normal@example.invalid',
    canManageStandardScenario: true,
  });
  const created = await jsonRequest(harness.root, '/scenarios', { method: 'POST', token: 'buntu-normal', body: scenario });
  assert.equal(created.status, 201);

  // A disabled route grants nothing even though its capability bit is still set.
  assert.deepEqual(await (await jsonRequest(harness.root, '/scenarios/permission', { token: 'buntu-disabled-route' })).json(), {
    authenticated: false,
    platformUserId: null,
    crmUsername: null,
    canManageStandardScenario: false,
  });
});

test('DSH-01 standard scenarios: server-owned version, forced markers, attachment bump and soft delete', async (context) => {
  const harness = await startHarness();
  context.after(() => harness.server.close());
  const token = 'buntu-manager';

  const created = await jsonRequest(harness.root, '/scenarios', {
    method: 'POST',
    token,
    body: {
      scenarioId: 'account-review',
      title: '客户年度回顾',
      category: '客户经营',
      description: '按客户汇总年度机会与交付情况。',
      scenarioPayload: {
        pinnedSkills: ['crm-account-brief'],
        welcomeMessage: '我来帮你完成客户年度回顾。',
        inputDraft: '请回顾 {{accountName}} 的年度情况',
        prePinnedContext: { objectApiName: 'Account' },
        // A client that tries to mark its own scenario editable must not win.
        sourceType: 'LOCAL',
        readonlyForNormalUser: false,
      },
      // version/revision are server-owned; a body that carries them is rejected by strict schema.
      version: '9.9.9',
    },
  });
  assert.equal(created.status, 400, 'a body that tries to set version must be rejected');

  const first = await jsonRequest(harness.root, '/scenarios', {
    method: 'POST',
    token,
    body: {
      scenarioId: 'account-review',
      title: '客户年度回顾',
      category: '客户经营',
      description: '按客户汇总年度机会与交付情况。',
      scenarioPayload: {
        pinnedSkills: ['crm-account-brief'],
        welcomeMessage: '我来帮你完成客户年度回顾。',
        inputDraft: '请回顾 {{accountName}} 的年度情况',
        prePinnedContext: { objectApiName: 'Account' },
        sourceType: 'LOCAL',
        readonlyForNormalUser: false,
      },
    },
  });
  assert.equal(first.status, 201);
  const createdScenario = (await first.json() as Readonly<{ scenario: DshScenarioBody }>).scenario;
  assert.equal(createdScenario.version, '1.0.0');
  assert.equal(createdScenario.revision, 1);
  assert.equal(createdScenario.status, 'PUBLISHED');
  assert.equal(createdScenario.createdByPlatformUid, 'platform-manager');
  assert.equal(createdScenario.createdByCrmUser, 'manager@example.invalid');
  assert.equal((createdScenario.scenarioPayload as Readonly<{ sourceType: string }>).sourceType, 'COMPANY_STANDARD');
  assert.equal((createdScenario.scenarioPayload as Readonly<{ readonlyForNormalUser: boolean }>).readonlyForNormalUser, true);

  const second = await jsonRequest(harness.root, '/scenarios/account-review', {
    method: 'PUT', token, body: { description: '按客户汇总年度机会、交付与风险。' },
  });
  assert.equal(second.status, 200);
  const edited = (await second.json() as Readonly<{ scenario: DshScenarioBody }>).scenario;
  assert.equal(edited.version, '1.0.1');
  assert.equal(edited.revision, 2);
  assert.equal(edited.description, '按客户汇总年度机会、交付与风险。');
  assert.equal(edited.title, '客户年度回顾', 'omitted fields keep their value');

  const third = await jsonRequest(harness.root, '/scenarios/account-review', {
    method: 'PUT', token, body: { title: '客户年度回顾（标准版）' },
  });
  assert.equal(third.status, 200);
  const editedAgain = (await third.json() as Readonly<{ scenario: DshScenarioBody }>).scenario;
  assert.equal(editedAgain.version, '1.0.2');
  assert.equal(editedAgain.revision, 3);

  // A client-supplied revision is not accepted either.
  const revisionInjection = await jsonRequest(harness.root, '/scenarios/account-review', {
    method: 'PUT', token, body: { revision: 42 },
  });
  assert.equal(revisionInjection.status, 400);

  // Attachment upload: bytes + digest + a version/revision step, exactly like an edit.
  const content = Buffer.from('季度回顾模板 v1', 'utf8');
  const upload = await jsonRequest(harness.root, '/scenarios/account-review/attachments', {
    method: 'POST',
    token,
    body: {
      fileName: '季度回顾模板.txt',
      mimeType: 'text/plain',
      contentBase64: content.toString('base64'),
      sha256: sha256(content),
    },
  });
  assert.equal(upload.status, 201);
  const uploadBody = await upload.json() as Readonly<{
    scenario: DshScenarioBody;
    attachment: Readonly<{ attachmentId: string; downloadUrl: string; fileName: string; fileSize: number; sha256: string }>;
  }>;
  assert.equal(uploadBody.scenario.version, '1.0.3');
  assert.equal(uploadBody.scenario.revision, 4);
  assert.equal(uploadBody.scenario.presetAttachments.length, 1);
  assert.equal(uploadBody.attachment.fileSize, content.length);
  assert.equal(uploadBody.attachment.sha256, sha256(content));
  assert.match(uploadBody.attachment.downloadUrl, /^\/api\/dsh\/scenarios\/account-review\/attachments\/att_[a-f0-9]{32}$/u);

  // The catalogue the plugin reads carries the attachment metadata and the new revision.
  const list = await jsonRequest(harness.root, '/scenarios', { token });
  const listBody = await list.json() as Readonly<{
    auth: Readonly<{ canManageStandardScenario: boolean }>;
    scenarios: readonly DshScenarioBody[];
  }>;
  assert.equal(listBody.auth.canManageStandardScenario, true);
  assert.equal(listBody.scenarios.length, 1);
  assert.equal(listBody.scenarios[0]?.revision, 4);
  assert.equal(listBody.scenarios[0]?.presetAttachments.length, 1);

  // Download: bytes, declared type and an explicit filename.
  const download = await fetch(`${harness.root}${uploadBody.attachment.downloadUrl}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'text/plain');
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename="[^"]+"; filename\*=UTF-8''/u);
  assert.equal(sha256(Buffer.from(await download.arrayBuffer())), sha256(content));

  // Deleting the attachment is another bump and clears the metadata array.
  const deletedAttachment = await jsonRequest(
    harness.root,
    `/scenarios/account-review/attachments/${uploadBody.attachment.attachmentId}`,
    { method: 'DELETE', token },
  );
  assert.equal(deletedAttachment.status, 200);
  const afterAttachmentDelete = (await deletedAttachment.json() as Readonly<{ scenario: DshScenarioBody }>).scenario;
  assert.equal(afterAttachmentDelete.version, '1.0.4');
  assert.equal(afterAttachmentDelete.revision, 5);
  assert.deepEqual(afterAttachmentDelete.presetAttachments, []);
  assert.equal((await fetch(`${harness.root}${uploadBody.attachment.downloadUrl}`)).status, 404);

  // Soft delete: the scenario leaves the installable list and its id becomes a tombstone.
  const deleted = await jsonRequest(harness.root, '/scenarios/account-review', { method: 'DELETE', token });
  assert.equal(deleted.status, 200);
  const deletedBody = await deleted.json() as Readonly<{ deleted: boolean; revision: number; deletedScenarioIds: readonly string[] }>;
  assert.equal(deletedBody.deleted, true);
  assert.equal(deletedBody.revision, 6);
  assert.deepEqual(deletedBody.deletedScenarioIds, ['account-review']);

  const afterDelete = await jsonRequest(harness.root, '/scenarios?includeDeleted=true', { token });
  const afterDeleteBody = await afterDelete.json() as Readonly<{
    scenarios: readonly DshScenarioBody[];
    deletedScenarioIds: readonly string[];
  }>;
  assert.deepEqual(afterDeleteBody.scenarios, []);
  assert.deepEqual(afterDeleteBody.deletedScenarioIds, ['account-review']);

  const withoutDeleted = await jsonRequest(harness.root, '/scenarios?includeDeleted=false', { token });
  assert.deepEqual((await withoutDeleted.json() as Readonly<{ deletedScenarioIds: readonly string[] }>).deletedScenarioIds, []);
});

test('DSH-01 identity carriers: header, query and body all resolve the same platform user', async (context) => {
  const harness = await startHarness();
  context.after(() => harness.server.close());

  const header = await fetch(`${harness.root}/api/dsh/scenarios/permission`, {
    headers: { 'X-Buntu-Token': 'buntu-manager' },
  });
  assert.equal((await header.json() as Readonly<{ platformUserId: string }>).platformUserId, 'platform-manager');

  const query = await fetch(`${harness.root}/api/dsh/scenarios/permission?buntuToken=buntu-manager`);
  assert.equal((await query.json() as Readonly<{ platformUserId: string }>).platformUserId, 'platform-manager');

  const viaBody = await fetch(`${harness.root}/api/dsh/scenarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      buntuToken: 'buntu-manager',
      scenarioId: 'body-token',
      title: 'Body 令牌场景',
      description: '通过请求体携带 Buntu Token 创建。',
      scenarioPayload: {},
    }),
  });
  assert.equal(viaBody.status, 201);

  // Priority 3: a platform header without the shared client token is not an identity.
  const spoofed = await fetch(`${harness.root}/api/dsh/scenarios/permission`, {
    headers: { 'X-SFOA-Platform-User': 'platform-manager' },
  });
  assert.equal((await spoofed.json() as Readonly<{ authenticated: boolean }>).authenticated, false);
  const spoofedWrite = await fetch(`${harness.root}/api/dsh/scenarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SFOA-Platform-User': 'platform-manager' },
    body: JSON.stringify({ scenarioId: 'spoofed', title: 'x', description: 'y', scenarioPayload: {} }),
  });
  assert.equal(spoofedWrite.status, 403);

  // With the shared client token the same header is accepted (internal_bearer deployments).
  const trusted = await fetch(`${harness.root}/api/dsh/scenarios/permission`, {
    headers: {
      Authorization: 'Bearer mcp-client-token-for-tests',
      'X-SFOA-Platform-User': 'platform-manager',
    },
  });
  assert.deepEqual(await trusted.json(), {
    authenticated: true,
    platformUserId: 'platform-manager',
    crmUsername: 'manager@example.invalid',
    canManageStandardScenario: true,
  });
});

test('DSH-01 Admin Console path: session identity, module gate, CSRF and archived visibility', async (context) => {
  const harness = await startHarness();
  context.after(() => harness.server.close());

  const login = await fetch(`${harness.root}/admin/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ username: ADMIN, password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie);
  const { csrfToken } = await login.json() as Readonly<{ csrfToken: string }>;

  const permission = await fetch(`${harness.root}/admin/api/dsh/scenarios/permission`, { headers: { Cookie: cookie } });
  assert.deepEqual(await permission.json(), {
    authenticated: true,
    platformUserId: null,
    crmUsername: null,
    canManageStandardScenario: true,
  });

  // The Console reaches the same catalogue through `/admin/api/dsh`, so the ADR-0034 module gate
  // and the standard Admin mutation guards apply without a second authorization implementation.
  // The Console write path needs the same Origin + CSRF proof as every other Admin mutation.
  const withoutCsrf = await fetch(`${harness.root}/admin/api/dsh/scenarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie },
    body: JSON.stringify({ scenarioId: 'console-made', title: '后台场景', description: '由后台创建。', scenarioPayload: {} }),
  });
  assert.equal(withoutCsrf.status, 403);
  const created = await fetch(`${harness.root}/admin/api/dsh/scenarios`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      Cookie: cookie,
      'X-SFoA-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({ scenarioId: 'console-made', title: '后台场景', description: '由后台创建。', scenarioPayload: {} }),
  });
  assert.equal(created.status, 201);
  const consoleScenario = (await created.json() as Readonly<{ scenario: DshScenarioBody }>).scenario;
  // No platform user exists behind a Console account, so the row records the reserved marker.
  assert.equal(consoleScenario.createdByPlatformUid, `admin:${ADMIN}`);

  // Archive it, then confirm the plugin view hides it while the Console view keeps it.
  const archived = await fetch(`${harness.root}/admin/api/dsh/scenarios/console-made`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie, 'X-SFoA-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({ status: 'ARCHIVED' }),
  });
  assert.equal(archived.status, 200);
  assert.equal(((await archived.json()) as Readonly<{ scenario: DshScenarioBody }>).scenario.status, 'ARCHIVED');

  // The plugin prefix is anonymous here: no cookie, so it sees only PUBLISHED scenarios.
  const pluginView = await fetch(`${harness.root}/api/dsh/scenarios`);
  assert.deepEqual((await pluginView.json() as Readonly<{ scenarios: readonly unknown[] }>).scenarios, []);
  const consoleView = await fetch(`${harness.root}/admin/api/dsh/scenarios?includeArchived=true`, { headers: { Cookie: cookie } });
  assert.equal((await consoleView.json() as Readonly<{ scenarios: readonly unknown[] }>).scenarios.length, 1);
  // An anonymous caller asking for archived scenarios does not get them.
  const anonymousArchived = await fetch(`${harness.root}/api/dsh/scenarios?includeArchived=true`);
  assert.deepEqual((await anonymousArchived.json() as Readonly<{ scenarios: readonly unknown[] }>).scenarios, []);

  // A scoped account without the standard-scenario module is refused, even with a valid session.
  const scopedLogin = await fetch(`${harness.root}/admin/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ username: SCOPED, password: SCOPED_PASSWORD }),
  });
  assert.equal(scopedLogin.status, 200);
  const scopedCookie = scopedLogin.headers.get('set-cookie');
  assert.ok(scopedCookie);
  // The Console alias is gated by ADR-0034 before the DSH router runs, so an account without the
  // module is refused with the Admin code rather than a DSH permission answer.
  const scopedPermission = await fetch(`${harness.root}/admin/api/dsh/scenarios/permission`, { headers: { Cookie: scopedCookie } });
  assert.equal(scopedPermission.status, 403);
  assert.equal(
    (await scopedPermission.json() as Readonly<{ error: Readonly<{ code: string }> }>).error.code,
    'MCP_ADMIN_FORBIDDEN',
  );
  // The same account on the plugin prefix has no session-based authority either: it is simply an
  // anonymous plugin caller and sees the published catalogue only.
  const scopedPluginView = await fetch(`${harness.root}/api/dsh/scenarios`, { headers: { Cookie: scopedCookie } });
  assert.equal(
    (await scopedPluginView.json() as Readonly<{ auth: Readonly<{ canManageStandardScenario: boolean }> }>)
      .auth.canManageStandardScenario,
    false,
  );
  const scopedWrite = await fetch(`${harness.root}/admin/api/dsh/scenarios/console-made`, {
    method: 'DELETE',
    headers: { Origin: ORIGIN, Cookie: scopedCookie },
  });
  assert.equal(scopedWrite.status, 403);
});

test('DSH-01 transport: CORS preflight, multipart upload and strict media types', async (context) => {
  const harness = await startHarness();
  context.after(() => harness.server.close());
  const token = 'buntu-manager';

  const preflight = await fetch(`${harness.root}/api/dsh/scenarios`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://dsh.example.com', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://dsh.example.com');
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /X-Buntu-Token/u);

  await jsonRequest(harness.root, '/scenarios', {
    method: 'POST', token,
    body: { scenarioId: 'multipart-target', title: '附件场景', description: '用于 multipart 测试。', scenarioPayload: {} },
  });

  const form = new FormData();
  form.append('file', new Blob([Buffer.from('mock-bytes')], { type: 'application/octet-stream' }), '样例.bin');
  const multipart = await fetch(`${harness.root}/api/dsh/scenarios/multipart-target/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(multipart.status, 201);
  const uploaded = await multipart.json() as Readonly<{
    attachment: Readonly<{ fileName: string; fileSize: number; mimeType: string }>;
    scenario: DshScenarioBody;
  }>;
  assert.equal(uploaded.attachment.fileName, '样例.bin');
  assert.equal(uploaded.attachment.fileSize, 10);
  assert.equal(uploaded.attachment.mimeType, 'application/octet-stream');
  assert.equal(uploaded.scenario.version, '1.0.1');

  const wrongType = await fetch(`${harness.root}/api/dsh/scenarios/multipart-target`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: 'description=nope',
  });
  assert.equal(wrongType.status, 415);

  const badId = await fetch(`${harness.root}/api/dsh/scenarios/not%24valid`, { method: 'PUT', headers: authHeaders(token) });
  assert.equal(badId.status, 400);

  const wrongMethod = await fetch(`${harness.root}/api/dsh/scenarios`, { method: 'DELETE', headers: authHeaders(token) });
  assert.equal(wrongMethod.status, 405);
  assert.equal(((await wrongMethod.json()) as Readonly<{ error: Readonly<{ code: string }> }>).error.code, 'DSH_SCENARIO_METHOD_NOT_ALLOWED');
});

type DshScenarioBody = Readonly<{
  scenarioId: string;
  title: string;
  category: string;
  description: string;
  version: string;
  revision: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  createdByPlatformUid: string;
  createdByCrmUser: string | null;
  scenarioPayload: unknown;
  presetAttachments: readonly Readonly<{
    attachmentId: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    sha256: string;
    downloadUrl: string;
  }>[];
}>;

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

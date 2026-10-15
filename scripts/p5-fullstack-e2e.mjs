import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertAllMigrationsApplied,
  ControlPlaneAdminService,
  createControlPlaneDatabase,
  createDatabaseIfMissing,
  databaseNameForTest,
  IdentityCredentialCipher,
  loadControlPlaneConfig,
  migrateDatabase,
  MySqlControlPlaneStore,
} from '../packages/sfoa-control-plane/dist/index.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adminPort = 18_081;
const webPort = 15_173;
const apiOrigin = `http://127.0.0.1:${adminPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const adminUsername = 'p5-fullstack-admin';
const adminPassword = randomBytes(36).toString('base64url');
// ADR-0034: the restricted account the Console gate exercises. `system` and `audit` are listed
// first so the landing page and the navigation are proven to follow the module contract's order
// rather than the account's own list.
const scopedUsername = 'p5-fullstack-btit';
const scopedPassword = randomBytes(36).toString('base64url');
const scopedModules = Object.freeze(['system', 'audit', 'dashboard', 'identity-routes', 'agent-integration']);
const sessionSecret = randomBytes(48).toString('base64url');
const identityCredentialEncryptionKeyBytes = randomBytes(32);
const identityCredentialEncryptionKey = identityCredentialEncryptionKeyBytes.toString('base64url');
const loaded = await loadControlPlaneConfig(projectRoot, process.env, { requireDatabase: true });
if (!loaded.database) throw new Error('P5 full-stack E2E requires configured MySQL credentials.');
const testDatabaseName = databaseNameForTest(loaded.database);
assert.match(testDatabaseName, /^sfoa_enterprise_mcp(?:_[A-Za-z0-9]+)*_test$/u);
const testDatabaseConfig = Object.freeze({ ...loaded.database, database: testDatabaseName });
await createDatabaseIfMissing(testDatabaseConfig);
const store = new MySqlControlPlaneStore(createControlPlaneDatabase(testDatabaseConfig));
const secrets = [
  adminPassword, scopedPassword, sessionSecret, identityCredentialEncryptionKey, loaded.database.password,
].filter(Boolean);
const serviceOutput = new WeakMap();
let adminProcess;
let viteProcess;
let adminSecurityEvidence = {};
const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'sfoa-p5-fullstack-'));
const fixtureKeyPath = path.join(fixtureDirectory, 'test-only.pem');

try {
  // Admin boot seeds all pagination usernames. Fail signing locally instead of
  // attempting real Salesforce JWT authentication for these nonexistent users.
  await writeFile(fixtureKeyPath, 'P5 fullstack test fixture; deliberately not a private key.');
  await migrateDatabase(store.database);
  await cleanTestDatabase(store);
  await seedPaginationRoutes(store, new IdentityCredentialCipher(identityCredentialEncryptionKeyBytes));
  await store.repositories.tools.createIfAbsent(
    'future_unknown_tool',
    true,
    'full-stack fail-closed fixture',
  );
  const environment = {
    ...process.env,
    NODE_ENV: 'test',
    SFOA_CONTROL_PLANE_MODE: 'mysql',
    SFOA_INSTANCE_URL: 'https://salesforce.example.invalid',
    CONNECTED_APP_CLIENT_ID: 'p5-fullstack-test-only-client',
    JWT_PRIVATE_KEY_PATH: fixtureKeyPath,
    SFOA_DB_NAME: testDatabaseName,
    SFOA_ADMIN_BIND_HOST: '127.0.0.1',
    SFOA_ADMIN_PORT: String(adminPort),
    SFOA_ADMIN_ALLOWED_ORIGIN: webOrigin,
    SFOA_ADMIN_USERNAME: adminUsername,
    SFOA_ADMIN_PASSWORD: adminPassword,
    SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON: JSON.stringify([
      { username: scopedUsername, password: scopedPassword, modules: [...scopedModules] },
    ]),
    SFOA_ADMIN_SESSION_SECRET: sessionSecret,
    SFOA_ADMIN_SESSION_TTL_SECONDS: '300',
    SFOA_ADMIN_COOKIE_SECURE: 'false',
    SFOA_ADMIN_LOGIN_MAX_ATTEMPTS: '3',
    SFOA_ADMIN_LOGIN_WINDOW_MS: '10000',
    MCP_IDENTITY_CREDENTIAL_ENCRYPTION_KEY: identityCredentialEncryptionKey,
    MCP_PUBLIC_URL: 'http://127.0.0.1:18080/mcp',
    // E2E 必须使用自包含的安全配置，不能被开发机遗留的 P6 原始 Bearer 审计开关污染。
    MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED: 'false',
  };

  adminProcess = startService('Admin API security gate', process.execPath, [
    path.join(projectRoot, 'packages/sfoa-admin-api/dist/main.js'),
  ], projectRoot, environment);
  await waitForHttp(`${apiOrigin}/admin/api/ready`, adminProcess);
  adminSecurityEvidence = await verifyAdminSecurity(environment);
  await stopService(adminProcess);
  adminProcess = undefined;

  adminProcess = startService('Admin API browser gate', process.execPath, [
    path.join(projectRoot, 'packages/sfoa-admin-api/dist/main.js'),
  ], projectRoot, environment);
  await waitForHttp(`${apiOrigin}/admin/api/ready`, adminProcess);
  viteProcess = startService('Admin Web browser gate', process.execPath, [
    path.join(projectRoot, 'packages/sfoa-admin-web/node_modules/vite/bin/vite.js'),
    '--host', '127.0.0.1', '--port', String(webPort), '--strictPort',
  ], path.join(projectRoot, 'packages/sfoa-admin-web'), {
    ...environment,
    SFOA_ADMIN_API_PROXY_TARGET: apiOrigin,
  });
  await waitForHttp(`${webOrigin}/login`, viteProcess);

  await runProcess('Playwright full-stack E2E', process.execPath, [
    path.join(projectRoot, 'packages/sfoa-admin-web/node_modules/@playwright/test/cli.js'),
    'test', '--config=playwright.fullstack.config.ts',
  ], path.join(projectRoot, 'packages/sfoa-admin-web'), {
    ...environment,
    SFOA_P5_E2E_WEB_URL: webOrigin,
    SFOA_P5_E2E_ADMIN_USERNAME: adminUsername,
    SFOA_P5_E2E_ADMIN_PASSWORD: adminPassword,
    SFOA_P5_E2E_BTIT_USERNAME: scopedUsername,
    SFOA_P5_E2E_BTIT_PASSWORD: scopedPassword,
  });

  const evidence = await assertPersistedBrowserEvidence(store);
  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    gate: 'P5_FULLSTACK_E2E',
    database: testDatabaseName,
    browser: 'Chromium',
    transport: 'React -> Vite proxy -> real Admin API -> MySQL',
    ...adminSecurityEvidence,
    ...evidence,
  }, null, 2)}\n`);
} catch (error) {
  const message = redact(error instanceof Error ? error.stack ?? error.message : String(error), secrets);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
  await Promise.all([stopService(viteProcess), stopService(adminProcess)]);
  await store.close();
  await unlink(fixtureKeyPath);
  await rmdir(fixtureDirectory);
}

async function cleanTestDatabase(controlPlaneStore) {
  await controlPlaneStore.database.transaction().execute(async (transaction) => {
    await transaction.deleteFrom('sfoa_audit_log').execute();
    await transaction.deleteFrom('sfoa_runtime_setting').execute();
    await transaction.deleteFrom('sfoa_diagnostic_config').execute();
    await transaction.deleteFrom('sfoa_dml_policy').execute();
    await transaction.deleteFrom('sfoa_tool_control').execute();
    await transaction.deleteFrom('sfoa_identity_credential').execute();
    await transaction.deleteFrom('sfoa_identity_route').execute();
  });
}

async function seedPaginationRoutes(controlPlaneStore, cipher) {
  const adminService = new ControlPlaneAdminService(
    controlPlaneStore,
    () => ({ allowed: true }),
    cipher,
  );
  for (let index = 1; index <= 25; index += 1) {
    const suffix = String(index).padStart(3, '0');
    await adminService.createIdentityRoute({
      userName: `Pagination user ${suffix}`,
      platformUserId: `p6-page-${suffix}`,
      salesforceUsername: `p6-page-${suffix}@example.invalid`,
      enabled: true,
      remark: 'P6-ID-01 pagination fixture',
    }, 'p6-id-fullstack-fixture');
  }
}

async function verifyAdminSecurity(environment) {
  const originHeaders = { Origin: webOrigin, 'Content-Type': 'application/json' };
  const unauthenticated = await checkedFetch(`${apiOrigin}/admin/api/dashboard`);
  assert.equal(unauthenticated.status, 401);

  const incorrect = await checkedFetch(`${apiOrigin}/admin/api/auth/login`, {
    method: 'POST', headers: originHeaders,
    body: JSON.stringify({ username: adminUsername, password: `${adminPassword}-incorrect` }),
  });
  assert.equal(incorrect.status, 401);

  const login = await checkedFetch(`${apiOrigin}/admin/api/auth/login`, {
    method: 'POST', headers: originHeaders,
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  });
  assert.equal(login.status, 200);
  const loginText = await login.text();
  for (const secret of secrets) assert.equal(loginText.includes(secret), false);
  const session = JSON.parse(loginText);
  assert.equal(session.username, adminUsername);
  assert.match(session.csrfToken, /^[A-Za-z0-9_-]{32,128}$/u);
  const setCookie = login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /^sfoa_admin=/u);
  assert.match(setCookie, /; HttpOnly/iu);
  assert.match(setCookie, /; SameSite=Strict/iu);
  assert.doesNotMatch(setCookie, /; Secure/iu);
  const cookie = setCookie.split(';', 1)[0];

  const authenticated = await checkedFetch(`${apiOrigin}/admin/api/auth/me`, { headers: { Cookie: cookie, Origin: webOrigin } });
  assert.equal(authenticated.status, 200);

  const tools = await checkedFetch(`${apiOrigin}/admin/api/tools`, {
    headers: { Cookie: cookie, Origin: webOrigin },
  });
  assert.equal(tools.status, 200);
  const toolItems = readRecord(await tools.json()).items;
  assert.equal(Array.isArray(toolItems), true);
  const unknownTool = toolItems.map(readRecord).find((item) => item.toolName === 'future_unknown_tool');
  assert.equal(unknownTool?.enabled, true);
  assert.equal(unknownTool?.status, 'UNKNOWN');
  assert.equal(unknownTool?.enableAllowed, false);

  const missingCsrf = await checkedFetch(`${apiOrigin}/admin/api/auth/logout`, {
    method: 'POST', headers: { Cookie: cookie, Origin: webOrigin },
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal((await missingCsrf.json()).error.code, 'MCP_ADMIN_CSRF_INVALID');

  const invalidOrigin = await checkedFetch(`${apiOrigin}/admin/api/auth/me`, {
    headers: { Cookie: cookie, Origin: 'http://127.0.0.1:65534' },
  });
  assert.equal(invalidOrigin.status, 403);
  assert.equal((await invalidOrigin.json()).error.code, 'MCP_ADMIN_ORIGIN_NOT_ALLOWED');

  const expiredCookie = createExpiredCookie(environment.SFOA_ADMIN_SESSION_SECRET);
  const expired = await checkedFetch(`${apiOrigin}/admin/api/auth/me`, { headers: { Cookie: expiredCookie, Origin: webOrigin } });
  assert.equal(expired.status, 401);

  const logout = await checkedFetch(`${apiOrigin}/admin/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: webOrigin, 'X-SFoA-CSRF-Token': session.csrfToken },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/iu);
  const revoked = await checkedFetch(`${apiOrigin}/admin/api/auth/me`, { headers: { Cookie: cookie, Origin: webOrigin } });
  assert.equal(revoked.status, 401);

  const scopedEvidence = await verifyScopedAccountGate();

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const limited = await checkedFetch(`${apiOrigin}/admin/api/auth/login`, {
      method: 'POST', headers: originHeaders,
      body: JSON.stringify({ username: adminUsername, password: `${adminPassword}-rate-${attempt}` }),
    });
    assert.equal(limited.status, attempt === 4 ? 429 : 401);
  }
  process.stdout.write('P5_ADMIN_SECURITY_REAL_HTTP=PASS\n');
  return Object.freeze({ unknownToolAdminEnableAllowed: false, ...scopedEvidence });
}

/**
 * ADR-0034: the Console gate for a restricted account, over real HTTP against the real Admin API.
 *
 * The module closure is asserted from the outside: every endpoint the account's pages need is
 * reachable, every endpoint outside them — including a path the router does not serve at all — is
 * refused with `MCP_ADMIN_FORBIDDEN`, and the refusal is a module decision rather than an
 * authentication or CSRF failure. Runs before the login rate-limit fixture at the end of
 * `verifyAdminSecurity`, which exhausts the bootstrap Admin's own attempt window.
 */
async function verifyScopedAccountGate() {
  const originHeaders = { Origin: webOrigin, 'Content-Type': 'application/json' };
  // The bootstrap Admin password must not open the scoped account. This is also the only failed
  // attempt the scoped account's own login window sees.
  const crossed = await checkedFetch(`${apiOrigin}/admin/api/auth/login`, {
    method: 'POST', headers: originHeaders,
    body: JSON.stringify({ username: scopedUsername, password: adminPassword }),
  });
  assert.equal(crossed.status, 401);

  const login = await checkedFetch(`${apiOrigin}/admin/api/auth/login`, {
    method: 'POST', headers: originHeaders,
    body: JSON.stringify({ username: scopedUsername, password: scopedPassword }),
  });
  assert.equal(login.status, 200);
  const loginText = await login.text();
  for (const secret of secrets) assert.equal(loginText.includes(secret), false);
  const session = JSON.parse(loginText);
  assert.equal(session.username, scopedUsername);
  assert.deepEqual([...session.modules].sort(), [...scopedModules].sort());
  const setCookie = login.headers.getSetCookie?.()[0] ?? login.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /; HttpOnly/iu);
  const cookie = setCookie.split(';', 1)[0];

  const me = await checkedFetch(`${apiOrigin}/admin/api/auth/me`, { headers: { Cookie: cookie, Origin: webOrigin } });
  assert.equal(me.status, 200);
  assert.deepEqual([...(await me.json()).modules].sort(), [...scopedModules].sort());

  const scopedHeaders = { Cookie: cookie, Origin: webOrigin };
  const granted = [
    '/dashboard',
    '/routes?limit=1&offset=0',
    '/system/status',
    '/system/settings',
    '/tools',
    '/dml-policies?limit=1&offset=0',
    '/dml-policies/1/managed-fields?limit=1&offset=0',
    '/audits?limit=1&offset=0',
    `/audits?limit=1&offset=0&actorAdmin=${encodeURIComponent(scopedUsername)}`,
  ];
  for (const path of granted) {
    const response = await checkedFetch(`${apiOrigin}/admin/api${path}`, { headers: scopedHeaders });
    assert.notEqual(response.status, 403, `Scoped account was refused its own endpoint ${path}`);
    assert.notEqual(response.status, 401, `Scoped session was not accepted for ${path}`);
  }

  for (const path of ['/diagnostic', '/ui-context/snapshots', '/not-a-console-endpoint']) {
    const response = await checkedFetch(`${apiOrigin}/admin/api${path}`, { headers: scopedHeaders });
    assert.equal(response.status, 403, `Expected a module refusal for ${path}`);
    assert.equal((await response.json()).error.code, 'MCP_ADMIN_FORBIDDEN');
  }

  // A mutation outside the modules is refused by the module gate, not by CSRF: the request
  // carries the account's own valid token, so a missing-CSRF answer would prove nothing.
  const deniedMutations = [
    { method: 'PUT', path: '/diagnostic' },
    { method: 'POST', path: '/dml-policies' },
  ];
  for (const mutation of deniedMutations) {
    const response = await checkedFetch(`${apiOrigin}/admin/api${mutation.path}`, {
      method: mutation.method,
      headers: { ...scopedHeaders, 'X-SFoA-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 403, `Expected a module refusal for ${mutation.method} ${mutation.path}`);
    assert.equal((await response.json()).error.code, 'MCP_ADMIN_FORBIDDEN');
  }

  // An in-module mutation reaches validation instead of the module gate. The body is deliberately
  // invalid so the check proves authorization without changing stored state.
  const inModuleMutation = await checkedFetch(`${apiOrigin}/admin/api/system/settings/auditRetentionDays`, {
    method: 'PUT',
    headers: { ...scopedHeaders, 'X-SFoA-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(inModuleMutation.status, 400);
  assert.equal((await inModuleMutation.json()).error.code, 'MCP_ADMIN_INPUT_INVALID');

  // The audit workbench reads Admin actions by actor, which is the index migration 015 adds.
  const actorFiltered = await checkedFetch(
    `${apiOrigin}/admin/api/audits?limit=25&offset=0&actorAdmin=${encodeURIComponent(scopedUsername)}`,
    { headers: scopedHeaders },
  );
  assert.equal(actorFiltered.status, 200);
  const actorRows = readRecord(await actorFiltered.json()).items;
  assert.equal(Array.isArray(actorRows), true);
  assert.equal(actorRows.length > 0, true);
  assert.equal(actorRows.map(readRecord).every((row) => row.actorAdmin === scopedUsername), true);

  const logout = await checkedFetch(`${apiOrigin}/admin/api/auth/logout`, {
    method: 'POST',
    headers: { ...scopedHeaders, 'X-SFoA-CSRF-Token': session.csrfToken },
  });
  assert.equal(logout.status, 200);
  process.stdout.write('P5_ADMIN_SCOPED_ACCOUNT_REAL_HTTP=PASS\n');
  return Object.freeze({
    scopedAccountModules: [...scopedModules],
    scopedAccountRefusedPaths: 3,
    scopedAccountDeniedMutations: deniedMutations.length,
  });
}

async function checkedFetch(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response;
}

function createExpiredCookie(secret) {
  const payload = Buffer.from(JSON.stringify({
    username: adminUsername,
    expiresAt: Date.now() - 1_000,
    csrfToken: randomBytes(32).toString('base64url'),
    nonce: randomBytes(18).toString('base64url'),
  }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `sfoa_admin=${payload}.${signature}`;
}

async function assertPersistedBrowserEvidence(controlPlaneStore) {
  const route = await controlPlaneStore.repositories.identityRoutes.getByPlatformUserId('p6-id-fullstack-user');
  assert.equal(route, undefined);
  const tool = await controlPlaneStore.repositories.tools.getByName('get_record_action_context');
  assert.equal(tool?.enabled, true);
  const policy = await controlPlaneStore.repositories.dmlPolicies.getByObjectApiName('Lead');
  assert.equal(policy?.allowCreate, true);
  assert.equal(policy?.allowUpdate, true);
  assert.equal(policy?.enabled, true);
  const migrations = await assertAllMigrationsApplied(controlPlaneStore.database);
  const audits = await controlPlaneStore.repositories.audits.search({ limit: 100, offset: 0 });
  const operations = new Set(audits.items.map((entry) => entry.operation));
  for (const operation of [
    'ADMIN_LOGIN', 'CREATE_IDENTITY_ROUTE', 'UPDATE_IDENTITY_ROUTE',
    'DISABLE_IDENTITY_ROUTE', 'DELETE_IDENTITY_ROUTE',
    'UPDATE_TOOL_CONTROL', 'CREATE_DML_POLICY', 'UPDATE_DML_POLICY',
  ]) assert.equal(operations.has(operation), true, `Missing full-stack audit operation: ${operation}`);
  const deleteAudit = audits.items.find((entry) =>
    entry.operation === 'DELETE_IDENTITY_ROUTE' && entry.platformUserId === 'p6-id-fullstack-user');
  assert.ok(deleteAudit?.identityCredentialId);
  assert.equal(await controlPlaneStore.repositories.identityCredentials.getById(deleteAudit.identityCredentialId), undefined);
  assert.equal(JSON.stringify(audits.items).includes('sfoa_ub1_'), false);
  return Object.freeze({
    migrationVersions: migrations.map((entry) => entry.version),
    identityRouteDeleted: true,
    identityCredentialDeleted: true,
    toolControlPersisted: true,
    dmlPolicyPersisted: true,
    adminAuditRows: audits.items.length,
  });
}

function startService(label, command, args, cwd, environment) {
  const child = spawn(command, args, { cwd, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  serviceOutput.set(child, '');
  const capture = (chunk) => {
    const combined = `${serviceOutput.get(child) ?? ''}${String(chunk)}`;
    serviceOutput.set(child, combined.slice(-16_384));
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.once('error', (error) => {
    process.stderr.write(`${label} failed to start: ${redact(error.message, secrets)}\n`);
  });
  return child;
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const output = redact(serviceOutput.get(child) ?? '', secrets).trim();
      throw new Error(
        `Service exited before ${url} became ready (code ${child.exitCode}).` +
        (output ? `\nBounded service output:\n${output}` : ''),
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function runProcess(label, command, args, cwd, environment) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: environment, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`${label} failed (${signal ?? code ?? 'unknown'}).`));
    });
  });
}

async function stopService(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5_000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); }),
  ]);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function redact(text, values) {
  let result = text;
  for (const value of values) if (value) result = result.replaceAll(value, '[REDACTED]');
  return result;
}

function readRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

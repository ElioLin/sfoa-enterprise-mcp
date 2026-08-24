import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ControlPlaneAdminService,
  createControlPlaneDatabase,
  createDatabaseIfMissing,
  ControlPlaneError,
  databaseNameForTest,
  IdentityCredentialCipher,
  loadControlPlaneConfig,
  migrateDatabase,
  MySqlControlPlaneStore,
  type DatabaseConfig,
  type ToolControlRecord,
} from '@sfoa/control-plane';
import {
  CwdExecutionGuard,
  RequestWorkspaceFactory,
  type RuntimeLogEvent,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
import { MySqlRuntimePolicySnapshotSource } from '../policy-snapshot.js';
import { startConfiguredRemoteRuntime } from '../runtime.js';
import {
  createTestIdentityRuntime,
  createTestRemoteConfig,
  initializeBody,
  mcpHeaders,
  RecordingConnectionFactory,
  TEST_CLIENT_TOKEN,
  TEST_PLATFORM_USER_A,
  TEST_PLATFORM_USER_B,
  TEST_USERNAME_A,
  TEST_USERNAME_B,
  toolResultText,
} from '../test/helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const configured = await loadTestDatabaseConfig();

if (!configured) {
  test('real MySQL-backed MCP runtime integration', {
    skip: 'SFOA project MySQL credentials are not configured.',
  }, () => undefined);
} else {
  test('real MySQL-backed MCP runtime applies the next policy snapshot without restart and fails closed', async () => {
    const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p5-real-mysql-runtime-'));
    const keyPath = path.join(baseRoot, 'test-only-key.pem');
    await writeFile(keyPath, 'test-only-key-material', { encoding: 'utf8', mode: 0o600 });
    await createDatabaseIfMissing(configured);
    const store = new MySqlControlPlaneStore(createControlPlaneDatabase(configured));
    const clients: Client[] = [];
    let runtime: RemoteMcpServer | undefined;
    try {
      await migrateDatabase(store.database);
      await cleanTestData(store);
      const adminService = new ControlPlaneAdminService(
        store,
        () => ({ allowed: true }),
        new IdentityCredentialCipher(Buffer.alloc(32, 19)),
      );
      const createdA = await adminService.createIdentityRoute({
        platformUserId: TEST_PLATFORM_USER_A,
        salesforceUsername: TEST_USERNAME_A,
        enabled: true,
        remark: 'real mysql runtime A',
      }, 'p6-id-mysql-gate');
      const createdB = await adminService.createIdentityRoute({
        platformUserId: TEST_PLATFORM_USER_B,
        salesforceUsername: TEST_USERNAME_B,
        enabled: true,
        remark: 'real mysql runtime B',
      }, 'p6-id-mysql-gate');
      const routeA = createdA.route;
      const routeB = createdB.route;
      await store.repositories.identityRoutes.create({
        platformUserId: 'p5-disabled-user',
        salesforceUsername: 'disabled@example.test',
        enabled: false,
        remark: null,
      });
      await setTool(store, 'get_username', true);
      await setTool(store, 'run_soql_query', true);
      await setTool(store, 'get_record_action_context', true);
      await setTool(store, 'create_record', false);
      await setTool(store, 'update_record', false);

      const connectionFactory = new RecordingConnectionFactory();
      const fallback = new RecordingLogger();
      const port = await reservePort();
      runtime = await startConfiguredRemoteRuntime(projectRoot, {
        ...process.env,
        NODE_ENV: 'test',
        SFOA_CONTROL_PLANE_MODE: 'mysql',
        SFOA_DB_NAME: configured.database,
        SFOA_INSTANCE_URL: 'https://example.test',
        CONNECTED_APP_CLIENT_ID: 'p5-real-mysql-runtime-test',
        JWT_PRIVATE_KEY_PATH: keyPath,
        MCP_BIND_HOST: '127.0.0.1',
        MCP_PORT: String(port),
        MCP_PATH: '/mcp',
        MCP_AUTH_MODE: 'internal_bearer',
        MCP_CLIENT_TOKEN: TEST_CLIENT_TOKEN,
        MCP_PLATFORM_USER_HEADER: 'X-Platform-User-Id',
        MCP_ALLOWED_HOSTS: '',
        MCP_ALLOWED_ORIGINS: '',
        MCP_PUBLIC_URL: '',
        MCP_REQUEST_TIMEOUT_MS: '10000',
        MCP_TOOL_TIMEOUT_MS: '5000',
      }, {
        connectionFactory,
        workspaceFactory: new RequestWorkspaceFactory({ baseRoot }),
        cwdGuard: new CwdExecutionGuard(),
        logger: fallback,
      });

      const clientA = await connectClient(runtime, TEST_PLATFORM_USER_A);
      const clientB = await connectClient(runtime, TEST_PLATFORM_USER_B);
      clients.push(clientA, clientB);
      const listed = await clientA.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name).sort(),
        ['get_username', 'run_soql_query', 'get_record_action_context'].sort(),
      );
      const [usernameA, usernameB, soql, context] = await Promise.all([
        clientA.callTool({ name: 'get_username', arguments: {} }),
        clientB.callTool({ name: 'get_username', arguments: {} }),
        clientA.callTool({
          name: 'run_soql_query',
          arguments: { query: 'SELECT Id FROM Lead LIMIT 1', useToolingApi: false },
        }),
        clientA.callTool({
          name: 'get_record_action_context',
          arguments: { objectApiName: 'Lead', action: 'CREATE' },
        }),
      ]);
      assert.match(toolResultText(usernameA), /user-a@example\.test/u);
      assert.match(toolResultText(usernameB), /user-b@example\.test/u);
      assert.match(toolResultText(soql), /p2-user-a/u);
      assert.equal(context.isError, undefined);
      assert.equal(readRecord(context.structuredContent).executionRole, 'USER');
      await Promise.all([clientA.close(), clientB.close()]);
      clients.length = 0;

      const userBoundA = await connectUserBoundClient(runtime, createdA.token, 'a');
      const userBoundB = await connectUserBoundClient(runtime, createdB.token, 'b');
      clients.push(userBoundA, userBoundB);
      const [boundUsernameA, boundUsernameB] = await Promise.all([
        userBoundA.callTool({ name: 'get_username', arguments: {} }),
        userBoundB.callTool({ name: 'get_username', arguments: {} }),
      ]);
      assert.match(toolResultText(boundUsernameA), /user-a@example\.test/u);
      assert.match(toolResultText(boundUsernameB), /user-b@example\.test/u);
      await Promise.all([userBoundA.close(), userBoundB.close()]);
      clients.length = 0;
      assert.ok((await store.repositories.identityCredentials.getById(createdA.credential.id))?.lastUsedAt);
      const forgedHeader = await rawUserBoundInitialize(runtime, createdA.token, TEST_PLATFORM_USER_B);
      assert.equal(forgedHeader.status, 403);
      assert.equal(await responseErrorCode(forgedHeader), 'MCP_IDENTITY_CONTEXT_MISMATCH');

      const missing = await rawInitialize(runtime, 'p5-unknown-user');
      assert.equal(missing.status, 403);
      assert.equal(await responseErrorCode(missing), 'MCP_IDENTITY_ROUTE_NOT_FOUND');
      const disabled = await rawInitialize(runtime, 'p5-disabled-user');
      assert.equal(disabled.status, 403);
      assert.equal(await responseErrorCode(disabled), 'MCP_IDENTITY_ROUTE_NOT_FOUND');

      await store.repositories.identityRoutes.update(routeB.id, {
        platformUserId: routeB.platformUserId,
        salesforceUsername: routeA.salesforceUsername,
        enabled: true,
        remark: 'shared Salesforce account is schema-valid',
        rowVersion: routeB.rowVersion,
      });
      const sharedB = await connectClient(runtime, TEST_PLATFORM_USER_B);
      clients.push(sharedB);
      assert.match(toolResultText(await sharedB.callTool({ name: 'get_username', arguments: {} })), /user-a@example\.test/u);
      await sharedB.close();
      clients.length = 0;
      const sharedUserBoundB = await connectUserBoundClient(runtime, createdB.token, 'b-shared');
      clients.push(sharedUserBoundB);
      assert.match(
        toolResultText(await sharedUserBoundB.callTool({ name: 'get_username', arguments: {} })),
        /user-a@example\.test/u,
      );
      await sharedUserBoundB.close();
      clients.length = 0;

      await setTool(store, 'get_username', false);
      const afterDisable = await connectClient(runtime, TEST_PLATFORM_USER_A);
      clients.push(afterDisable);
      assert.equal((await afterDisable.listTools()).tools.some((tool) => tool.name === 'get_username'), false);
      await assert.rejects(
        afterDisable.callTool({ name: 'get_username', arguments: {} }),
        /Tool get_username not found/u,
      );
      await afterDisable.close();
      clients.length = 0;

      await setTool(store, 'future_unknown_tool', true);
      const unknownTool = await rawInitialize(runtime, TEST_PLATFORM_USER_A);
      assert.notEqual(unknownTool.status, 200);
      assert.equal(await responseErrorCode(unknownTool), 'MCP_TOOL_NOT_AVAILABLE');
      await setTool(store, 'future_unknown_tool', false);

      await setTool(store, 'create_record', true);
      let policy = await store.repositories.dmlPolicies.create({
        objectApiName: 'Lead',
        allowCreate: true,
        allowUpdate: false,
        enabled: true,
        remark: 'real runtime dynamic DML',
      });
      const creator = await connectClient(runtime, TEST_PLATFORM_USER_A);
      clients.push(creator);
      const createTools = (await creator.listTools()).tools.map((tool) => tool.name);
      assert.ok(createTools.includes('create_record'));
      assert.equal(createTools.some((name) => /delete|upsert/iu.test(name)), false);
      const created = await creator.callTool({
        name: 'create_record',
        arguments: {
          objectApiName: 'Lead',
          fields: { LastName: 'P5-REAL-MYSQL-PII', Company: 'P5-REAL-MYSQL-COMPANY' },
        },
      });
      assert.equal(created.isError, undefined);
      const recordId = readString(readRecord(created.structuredContent).recordId);
      assert.ok(recordId);
      const denied = await creator.callTool({
        name: 'create_record',
        arguments: { objectApiName: 'Account', fields: { Name: 'P5-DENIED-PII' } },
      });
      assert.equal(denied.isError, true);
      assert.equal(readRecord(denied.structuredContent).errorCode, 'MCP_DML_OBJECT_NOT_ALLOWED');
      await creator.close();
      clients.length = 0;

      await setTool(store, 'create_record', false);
      await setTool(store, 'update_record', true);
      policy = await store.repositories.dmlPolicies.update(policy.id, {
        objectApiName: 'Lead',
        allowCreate: false,
        allowUpdate: true,
        enabled: true,
        remark: policy.remark,
        rowVersion: policy.rowVersion,
      });
      assert.equal(policy.allowCreate, false);
      assert.equal(policy.allowUpdate, true);
      const updater = await connectClient(runtime, TEST_PLATFORM_USER_A);
      clients.push(updater);
      const updateTools = (await updater.listTools()).tools.map((tool) => tool.name);
      assert.ok(updateTools.includes('update_record'));
      assert.equal(updateTools.includes('create_record'), false);
      assert.equal(updateTools.some((name) => /delete|upsert/iu.test(name)), false);
      const updated = await updater.callTool({
        name: 'update_record',
        arguments: {
          objectApiName: 'Lead',
          recordId,
          fields: { Company: 'P5-REAL-MYSQL-UPDATED' },
        },
      });
      assert.equal(updated.isError, undefined);
      await updater.close();
      clients.length = 0;

      assert.deepEqual(connectionFactory.dmlCalls.map((call) => call.operation), ['CREATE', 'UPDATE']);

      const connectionsBeforeDisable = connectionFactory.creations.length;
      const disabledA = await adminService.disableIdentityRoute(
        routeA.id,
        (await store.repositories.identityRoutes.getById(routeA.id))?.rowVersion ?? routeA.rowVersion,
        'p6-id-mysql-gate',
      );
      const deniedWhileDisabled = await rawUserBoundInitialize(runtime, createdA.token);
      assert.equal(await responseErrorCode(deniedWhileDisabled), 'MCP_IDENTITY_ROUTE_DISABLED');
      assert.equal(connectionFactory.creations.length, connectionsBeforeDisable);

      const enabledA = await adminService.updateIdentityRoute(routeA.id, {
        platformUserId: disabledA.platformUserId,
        salesforceUsername: disabledA.salesforceUsername,
        enabled: true,
        remark: disabledA.remark,
        rowVersion: disabledA.rowVersion,
      }, 'p6-id-mysql-gate');
      await assertSuccessfulInitialize(rawUserBoundInitialize(runtime, createdA.token));

      const regeneratedA = await adminService.regenerateIdentityCredential(routeA.id, {
        credentialId: createdA.credential.id,
        credentialRowVersion: createdA.credential.rowVersion,
        routeRowVersion: enabledA.rowVersion,
      }, 'p6-id-mysql-gate');
      assert.equal(
        await responseErrorCode(await rawUserBoundInitialize(runtime, createdA.token)),
        'MCP_IDENTITY_CREDENTIAL_REVOKED',
      );
      await assertSuccessfulInitialize(rawUserBoundInitialize(runtime, regeneratedA.token));

      const disabledForDelete = await adminService.disableIdentityRoute(
        routeA.id,
        regeneratedA.route.rowVersion,
        'p6-id-mysql-gate',
      );
      await adminService.deleteIdentityRoute(routeA.id, disabledForDelete.rowVersion, 'p6-id-mysql-gate');
      const creationsBeforeDeletedCredential = connectionFactory.creations.length;
      assert.equal(
        await responseErrorCode(await rawUserBoundInitialize(runtime, regeneratedA.token)),
        'MCP_IDENTITY_CREDENTIAL_INVALID',
      );
      assert.equal(connectionFactory.creations.length, creationsBeforeDeletedCredential);

      assert.equal(
        new Set(connectionFactory.creations.map((entry) => entry.connection)).size,
        connectionFactory.creations.length,
        'request-scoped Salesforce Connections must remain fresh and unpooled',
      );
      assert.equal(fallback.events.length, 0, 'durable MySQL audit should not use the fallback logger');
      const audits = await store.repositories.audits.search({ limit: 100, offset: 0 });
      assertAudit(audits.items, 'run_soql_query', 'PASS');
      assertAudit(audits.items, 'get_record_action_context', 'PASS');
      assertAudit(audits.items, 'get_username', 'BLOCKED', 'MCP_TOOL_DISABLED');
      assertAudit(audits.items, 'create_record', 'PASS');
      assertAudit(audits.items, 'create_record', 'ERROR', 'MCP_DML_OBJECT_NOT_ALLOWED');
      assertAudit(audits.items, 'update_record', 'PASS');
      assert.ok(audits.items.some((audit) =>
        audit.identitySource === 'USER_BOUND_TOKEN' &&
        audit.identityCredentialId === createdB.credential.id &&
        audit.platformUserId === TEST_PLATFORM_USER_B));
      assert.ok(audits.items.some((audit) => audit.identitySource === 'INTERNAL_SERVICE_HEADER'));
      const auditJson = JSON.stringify(audits.items);
      for (const forbidden of [
        'P5-REAL-MYSQL-PII', 'P5-REAL-MYSQL-COMPANY', 'P5-DENIED-PII', 'P5-REAL-MYSQL-UPDATED',
      ]) assert.equal(auditJson.includes(forbidden), false);
      assert.equal(auditJson.includes(createdA.token), false);
      assert.equal(auditJson.includes(createdB.token), false);
      assert.equal(auditJson.includes(regeneratedA.token), false);

      await verifyRealDriverOutageFailsClosed(configured, baseRoot, connectionFactory.creations.length);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await runtime?.close().catch(() => undefined);
      await store.close().catch(() => undefined);
      await rm(baseRoot, { recursive: true, force: true });
    }
  });
}

class RecordingLogger implements RuntimeLogger {
  public readonly events: RuntimeLogEvent[] = [];
  public log(event: RuntimeLogEvent): void {
    this.events.push(event);
  }
}

async function loadTestDatabaseConfig(): Promise<DatabaseConfig | undefined> {
  try {
    const loaded = await loadControlPlaneConfig(projectRoot, process.env, { requireDatabase: true });
    if (!loaded.database) return undefined;
    const database = databaseNameForTest(loaded.database);
    if (!database.endsWith('_test')) throw new Error('Runtime integration database must end with _test.');
    return Object.freeze({ ...loaded.database, database });
  } catch (error) {
    if (error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_CONFIGURATION_INVALID') {
      return undefined;
    }
    throw error;
  }
}

async function cleanTestData(store: MySqlControlPlaneStore): Promise<void> {
  await store.database.transaction().execute(async (transaction) => {
    await transaction.deleteFrom('sfoa_audit_log').execute();
    await transaction.deleteFrom('sfoa_identity_credential').execute();
    await transaction.deleteFrom('sfoa_runtime_setting').execute();
    await transaction.deleteFrom('sfoa_diagnostic_config').execute();
    await transaction.deleteFrom('sfoa_dml_policy').execute();
    await transaction.deleteFrom('sfoa_tool_control').execute();
    await transaction.deleteFrom('sfoa_identity_route').execute();
  });
}

async function setTool(
  store: MySqlControlPlaneStore,
  toolName: string,
  enabled: boolean,
): Promise<ToolControlRecord> {
  const current = await store.repositories.tools.createIfAbsent(toolName, enabled, null);
  if (current.enabled === enabled) return current;
  return store.repositories.tools.update(toolName, {
    enabled,
    remark: current.remark,
    rowVersion: current.rowVersion,
  });
}

async function connectClient(server: RemoteMcpServer, platformUserId: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: {
      headers: {
        authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        'x-platform-user-id': platformUserId,
      },
    },
  });
  const client = new Client({ name: `p5-real-mysql-${platformUserId}`, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function connectUserBoundClient(server: RemoteMcpServer, token: string, suffix: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: `p6-id-real-mysql-${suffix}`, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function rawInitialize(server: RemoteMcpServer, platformUserId: string): Promise<Response> {
  return fetch(server.mcpUrl, {
    method: 'POST',
    headers: mcpHeaders(platformUserId),
    body: initializeBody(),
  });
}

function rawUserBoundInitialize(
  server: RemoteMcpServer,
  token: string,
  platformUserId?: string,
): Promise<Response> {
  return fetch(server.mcpUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(platformUserId ? { 'x-platform-user-id': platformUserId } : {}),
    },
    body: initializeBody(),
  });
}

async function responseErrorCode(response: Response): Promise<string | undefined> {
  const body = await response.json() as unknown;
  const error = readRecord(body).error;
  const data = readRecord(readRecord(error).data);
  return typeof data.errorCode === 'string' ? data.errorCode : undefined;
}

async function assertSuccessfulInitialize(responsePromise: Promise<Response>): Promise<void> {
  const response = await responsePromise;
  assert.equal(response.status, 200);
  await response.arrayBuffer();
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not reserve a TCP port.')));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function verifyRealDriverOutageFailsClosed(
  config: DatabaseConfig,
  baseRoot: string,
  creationsBefore: number,
): Promise<void> {
  const unavailable = createControlPlaneDatabase({
    ...config,
    host: '127.0.0.1',
    port: 1,
    connectTimeoutMs: 100,
  });
  const connectionFactory = new RecordingConnectionFactory();
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({
      controlPlane: Object.freeze({ mode: 'mysql' }),
      enabledTools: Object.freeze(['get_username']),
    }),
    identityRuntime: createTestIdentityRuntime(baseRoot, connectionFactory),
    policySnapshotSource: new MySqlRuntimePolicySnapshotSource(unavailable),
  });
  try {
    const response = await rawInitialize(server, TEST_PLATFORM_USER_A);
    assert.equal(response.status, 503);
    assert.equal(await responseErrorCode(response), 'MCP_RUNTIME_CONTROL_PLANE_UNAVAILABLE');
    assert.equal(connectionFactory.creations.length, 0);
    assert.ok(creationsBefore > 0);
  } finally {
    await server.close();
    await unavailable.destroy();
  }
}

function assertAudit(
  audits: readonly Readonly<{
    toolName: string | null;
    result: 'PASS' | 'BLOCKED' | 'ERROR';
    errorCode: string | null;
  }>[],
  toolName: string,
  result: 'PASS' | 'BLOCKED' | 'ERROR',
  errorCode?: string,
): void {
  assert.ok(audits.some((audit) =>
    audit.toolName === toolName && audit.result === result &&
    (errorCode === undefined || audit.errorCode === errorCode)),
  `Missing durable runtime audit: ${toolName}/${result}/${errorCode ?? 'none'}`);
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

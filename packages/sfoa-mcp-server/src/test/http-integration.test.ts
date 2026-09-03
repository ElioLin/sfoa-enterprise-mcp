import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  hashUserBoundToken,
  type IdentityCredentialRecord,
  type IdentityCredentialRepository,
  type IdentityRouteRecord,
  type IdentityRouteRepository,
} from '@sfoa/control-plane';
import {
  currentRequestAuditContext,
  type RequestAuditContext,
  type RuntimeLogEvent,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
import {
  InternalServiceCredentialAuthenticator,
  UnifiedIdentityProvider,
  UserBoundCredentialAuthenticator,
} from '../authenticator.js';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
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
  waitFor,
} from './helpers.js';

const USER_BOUND_TOKEN_A = `sfoa_ub1_${'a'.repeat(43)}`;
const USER_BOUND_TOKEN_B = `sfoa_ub1_${'b'.repeat(43)}`;
const USER_BOUND_TOKEN_A2 = `sfoa_ub1_${'c'.repeat(43)}`;

test('P2 HTTP runtime enforces auth/bounds, hides disabled/host-owned Tools, and isolates 50 A/B calls', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p2-http-'));
  const connectionFactory = new RecordingConnectionFactory();
  const logger = new RecordingLogger();
  const identityRuntime = createTestIdentityRuntime(baseRoot, connectionFactory, logger);
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({ maxBodyBytes: 512 }),
    identityRuntime,
  });
  const clients: Client[] = [];

  try {
    assert.equal((await fetch(server.healthUrl)).status, 200);
    assert.deepEqual(await (await fetch(server.readyUrl)).json(), { status: 'UP' });

    const noBearer = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: initializeBody(),
    });
    assert.equal(noBearer.status, 401);
    assert.equal(noBearer.headers.get('www-authenticate'), 'Bearer');
    assert.equal(await responseErrorCode(noBearer), 'MCP_CLIENT_AUTH_REQUIRED');

    const wrongBearer = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: mcpHeaders(TEST_PLATFORM_USER_A, 'wrong-bearer-token'),
      body: initializeBody(),
    });
    assert.equal(wrongBearer.status, 401);
    assert.equal(wrongBearer.headers.get('www-authenticate'), 'Bearer');
    assert.equal(await responseErrorCode(wrongBearer), 'MCP_CLIENT_AUTH_INVALID');

    const wrongToolBearer = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: mcpHeaders(TEST_PLATFORM_USER_A, 'wrong-bearer-token'),
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_username', arguments: {} } }),
    });
    assert.equal(wrongToolBearer.status, 401);
    assert.equal(await responseErrorCode(wrongToolBearer), 'MCP_CLIENT_AUTH_INVALID');
    const failedIdentityAudit = logger.auditSnapshots.at(-1);
    assert.equal(failedIdentityAudit?.toolName, 'get_username');
    assert.equal(failedIdentityAudit?.platformUserId, null);
    assert.equal(failedIdentityAudit?.salesforceUsername, null);

    const noPlatformUser = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: mcpHeaders(undefined),
      body: initializeBody(),
    });
    assert.equal(noPlatformUser.status, 401);
    assert.equal(noPlatformUser.headers.get('www-authenticate'), 'Bearer');
    assert.equal(await responseErrorCode(noPlatformUser), 'MCP_PLATFORM_USER_REQUIRED');

    const unknownPlatformUser = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: mcpHeaders('unknown-p2-user'),
      body: initializeBody(),
    });
    assert.equal(unknownPlatformUser.status, 403);
    assert.equal(await responseErrorCode(unknownPlatformUser), 'MCP_IDENTITY_ROUTE_NOT_FOUND');

    const invalidOrigin = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: { ...mcpHeaders(TEST_PLATFORM_USER_A), origin: 'https://evil.example' },
      body: initializeBody(),
    });
    assert.equal(invalidOrigin.status, 403);
    assert.equal(await responseErrorCode(invalidOrigin), 'MCP_ORIGIN_NOT_ALLOWED');

    const invalidHost = await postWithHost(server.mcpUrl, 'evil.example', initializeBody());
    assert.equal(invalidHost.status, 403);
    assert.equal(responseErrorCodeFromBody(invalidHost.body), 'MCP_HOST_NOT_ALLOWED');
    assert.equal(connectionFactory.creations.length, 0, 'rejected HTTP/auth/identity requests must not create JWT Connections');

    const tooLarge = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: mcpHeaders(TEST_PLATFORM_USER_A),
      body: JSON.stringify({ padding: 'x'.repeat(2_000) }),
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(await responseErrorCode(tooLarge), 'MCP_REQUEST_TOO_LARGE');
    assert.equal(connectionFactory.creations.length, 0, 'body rejection must occur before request-scoped Connection creation');

    const clientA = await withStage('connect User A', connectClient(server, TEST_PLATFORM_USER_A));
    const clientB = await withStage('connect User B', connectClient(server, TEST_PLATFORM_USER_B));
    clients.push(clientA, clientB);

    const listed = await withStage('tools/list', clientA.listTools());
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['get_username', 'run_soql_query']);
    assert.equal(listed.tools.some((tool) => tool.name === 'retrieve_metadata'), false);
    const usernameTool = listed.tools.find((tool) => tool.name === 'get_username');
    assert(usernameTool);
    const usernameProperties = isRecord(usernameTool.inputSchema.properties)
      ? usernameTool.inputSchema.properties
      : {};
    assert.deepEqual(Object.keys(usernameProperties).sort(), ['defaultDevHub', 'defaultTargetOrg']);
    const queryTool = listed.tools.find((tool) => tool.name === 'run_soql_query');
    assert(queryTool);
    const queryProperties = isRecord(queryTool.inputSchema.properties)
      ? queryTool.inputSchema.properties
      : {};
    assert.deepEqual(Object.keys(queryProperties).sort(), ['query', 'useToolingApi']);
    assert.equal('usernameOrAlias' in queryProperties, false);
    assert.equal('directory' in queryProperties, false);
    assert.equal('platformUserId' in queryProperties, false);

    const [usernameA, usernameB, queryA, queryB] = await Promise.all([
      withStage('get_username User A', clientA.callTool({ name: 'get_username', arguments: {} })),
      withStage('get_username User B', clientB.callTool({ name: 'get_username', arguments: {} })),
      withStage('run_soql_query User A', clientA.callTool({
        name: 'run_soql_query',
        arguments: { query: 'SELECT Id FROM Lead LIMIT 1', useToolingApi: false },
      })),
      withStage('run_soql_query User B', clientB.callTool({
        name: 'run_soql_query',
        arguments: { query: 'SELECT Id FROM Lead LIMIT 1', useToolingApi: false },
      })),
    ]);
    assert.match(toolResultText(usernameA), new RegExp(TEST_USERNAME_A.replace('.', '\\.')));
    assert.doesNotMatch(toolResultText(usernameA), new RegExp(TEST_USERNAME_B.replace('.', '\\.')));
    assert.match(toolResultText(usernameB), new RegExp(TEST_USERNAME_B.replace('.', '\\.')));
    assert.doesNotMatch(toolResultText(usernameB), new RegExp(TEST_USERNAME_A.replace('.', '\\.')));
    assert.match(toolResultText(queryA), /p2-user-a/u);
    assert.doesNotMatch(toolResultText(queryA), /p2-user-b/u);
    assert.match(toolResultText(queryB), /p2-user-b/u);
    assert.doesNotMatch(toolResultText(queryB), /p2-user-a/u);

    const forgedIdentity = await withStage(
      'run_soql_query forged Tool identity arguments',
      clientA.callTool({
        name: 'run_soql_query',
        arguments: {
          query: 'SELECT Id FROM Lead LIMIT 1',
          usernameOrAlias: TEST_USERNAME_B,
          directory: 'C:\\forged-workspace',
          platformUserId: TEST_PLATFORM_USER_B,
          salesforceUsername: TEST_USERNAME_B,
        },
      }),
    );
    assert.match(toolResultText(forgedIdentity), /p2-user-a/u);
    assert.doesNotMatch(toolResultText(forgedIdentity), /p2-user-b/u);

    const interleaved = await withStage('50 interleaved tools/call', Promise.all(
      Array.from({ length: 50 }, async (_value, index) => {
        const isA = index % 2 === 0;
        const result = await (isA ? clientA : clientB).callTool({ name: 'get_username', arguments: {} });
        const text = toolResultText(result);
        return {
          expected: isA ? TEST_USERNAME_A : TEST_USERNAME_B,
          forbidden: isA ? TEST_USERNAME_B : TEST_USERNAME_A,
          text,
          isError: result.isError === true,
        };
      }),
    ));
    assert.equal(interleaved.filter((result) => result.isError).length, 0);
    assert.equal(interleaved.filter((result) => !result.text.includes(result.expected)).length, 0);
    assert.equal(interleaved.filter((result) => result.text.includes(result.forbidden)).length, 0);

    await waitFor(() => identityRuntime.workspaceFactory.getMetrics().active === 0, 5_000);
    const workspaceMetrics = identityRuntime.workspaceFactory.getMetrics();
    assert.equal(workspaceMetrics.created, workspaceMetrics.cleaned);
    assert.equal(server.getMetrics().cleanupFailures, 0);
    assert.equal(connectionFactory.countFor(TEST_PLATFORM_USER_A) > 0, true);
    assert.equal(connectionFactory.countFor(TEST_PLATFORM_USER_B) > 0, true);
    assert.equal(new Set(connectionFactory.creations.map((creation) => creation.connection)).size, connectionFactory.creations.length);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await server.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});

test('HTTP runtime accepts USER_BOUND A/B without a platform header and applies lifecycle changes on the next request', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-user-bound-http-'));
  const connectionFactory = new RecordingConnectionFactory();
  const logger = new RecordingLogger();
  const identityRuntime = createTestIdentityRuntime(baseRoot, connectionFactory, logger);
  const fixture = createMutableCredentialRepositories();
  fixture.routes.set('1', identityRoute('1', TEST_PLATFORM_USER_A, true));
  fixture.routes.set('2', identityRoute('2', TEST_PLATFORM_USER_B, true));
  fixture.credentials.set('11', identityCredential('11', '1', USER_BOUND_TOKEN_A));
  fixture.credentials.set('22', identityCredential('22', '2', USER_BOUND_TOKEN_B));
  const identityProvider = new UnifiedIdentityProvider([
    new UserBoundCredentialAuthenticator(fixture.credentialRepository, fixture.routeRepository, logger),
    new InternalServiceCredentialAuthenticator(TEST_CLIENT_TOKEN),
  ]);
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig(),
    identityRuntime,
    identityProvider,
  });
  const clients: Client[] = [];
  try {
    const forged = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: mcpHeaders(TEST_PLATFORM_USER_B, USER_BOUND_TOKEN_A),
      body: initializeBody(),
    });
    assert.equal(forged.status, 403);
    assert.equal(await responseErrorCode(forged), 'MCP_IDENTITY_CONTEXT_MISMATCH');
    assert.equal(connectionFactory.creations.length, 0, 'forged header denial must precede Salesforce JWT creation');

    const clientA = await connectUserBoundClient(server, USER_BOUND_TOKEN_A, 'user-bound-a');
    const clientB = await connectUserBoundClient(server, USER_BOUND_TOKEN_B, 'user-bound-b');
    clients.push(clientA, clientB);
    const [usernameA, usernameB] = await Promise.all([
      clientA.callTool({ name: 'get_username', arguments: {} }),
      clientB.callTool({ name: 'get_username', arguments: {} }),
    ]);
    assert.match(toolResultText(usernameA), new RegExp(TEST_USERNAME_A.replace('.', '\\.')));
    assert.match(toolResultText(usernameB), new RegExp(TEST_USERNAME_B.replace('.', '\\.')));
    assert.equal(logger.events.some((event) => event.platformUserId === TEST_PLATFORM_USER_A
      && event.identitySource === 'USER_BOUND_TOKEN' && event.identityCredentialId === '11'), true);

    fixture.routes.set('1', identityRoute('1', TEST_PLATFORM_USER_A, false));
    const beforeDisabled = connectionFactory.creations.length;
    const disabled = await rawUserBoundInitialize(server, USER_BOUND_TOKEN_A);
    assert.equal(disabled.status, 403);
    assert.equal(await responseErrorCode(disabled), 'MCP_IDENTITY_ROUTE_DISABLED');
    assert.equal(connectionFactory.creations.length, beforeDisabled);

    fixture.routes.set('1', identityRoute('1', TEST_PLATFORM_USER_A, true));
    assert.equal((await rawUserBoundInitialize(server, USER_BOUND_TOKEN_A)).status, 200);
    fixture.credentials.set('11', identityCredential('11', '1', USER_BOUND_TOKEN_A, 'REVOKED'));
    fixture.credentials.set('12', identityCredential('12', '1', USER_BOUND_TOKEN_A2));
    const revoked = await rawUserBoundInitialize(server, USER_BOUND_TOKEN_A);
    assert.equal(revoked.status, 401);
    assert.equal(await responseErrorCode(revoked), 'MCP_IDENTITY_CREDENTIAL_REVOKED');
    assert.equal((await rawUserBoundInitialize(server, USER_BOUND_TOKEN_A2)).status, 200);

    fixture.routes.delete('1');
    const deleted = await rawUserBoundInitialize(server, USER_BOUND_TOKEN_A2);
    assert.equal(deleted.status, 401);
    assert.equal(await responseErrorCode(deleted), 'MCP_IDENTITY_CREDENTIAL_INVALID');
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await server.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});

async function connectClient(server: RemoteMcpServer, platformUserId: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: {
      headers: {
        authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        'x-platform-user-id': platformUserId,
      },
    },
  });
  const client = new Client({ name: `p2-${platformUserId}`, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function connectUserBoundClient(server: RemoteMcpServer, token: string, name: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function rawUserBoundInitialize(server: RemoteMcpServer, token: string): Promise<Response> {
  return fetch(server.mcpUrl, {
    method: 'POST',
    headers: mcpHeaders(undefined, token),
    body: initializeBody(),
  });
}

async function responseErrorCode(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json();
  return responseErrorCodeFromBody(body);
}

function responseErrorCodeFromBody(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error) || !isRecord(body.error.data)) return undefined;
  return typeof body.error.data.errorCode === 'string' ? body.error.data.errorCode : undefined;
}

async function postWithHost(
  url: URL,
  host: string,
  body: string,
): Promise<Readonly<{ status: number; body: unknown }>> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: 'POST',
        headers: { ...mcpHeaders(TEST_PLATFORM_USER_A), host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as unknown });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function withStage<T>(stage: string, operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    throw new Error(`P2 HTTP integration failed during ${stage}: ${String(error)}`, { cause: error });
  }
}

class RecordingLogger implements RuntimeLogger {
  public readonly events: RuntimeLogEvent[] = [];
  public readonly auditSnapshots: RequestAuditContext[] = [];
  public log(event: RuntimeLogEvent): void {
    this.events.push(event);
    const context = currentRequestAuditContext();
    if (context) this.auditSnapshots.push(context.snapshot());
  }
}

function createMutableCredentialRepositories(): Readonly<{
  routes: Map<string, IdentityRouteRecord>;
  credentials: Map<string, IdentityCredentialRecord>;
  routeRepository: IdentityRouteRepository;
  credentialRepository: IdentityCredentialRepository;
}> {
  const routes = new Map<string, IdentityRouteRecord>();
  const credentials = new Map<string, IdentityCredentialRecord>();
  const routeRepository: IdentityRouteRepository = {
    list: async ({ limit, offset }) => {
      const items = Object.freeze([...routes.values()].slice(offset, offset + limit));
      return Object.freeze({
        items, total: routes.size, limit, offset, count: items.length,
        hasMore: offset + items.length < routes.size,
        nextOffset: offset + items.length < routes.size ? offset + items.length : null,
      });
    },
    countActive: async () => [...routes.values()].filter((route) => route.enabled).length,
    getById: async (id) => routes.get(id),
    getByPlatformUserId: async (platformUserId) => [...routes.values()].find((route) => route.platformUserId === platformUserId),
    findActiveByPlatformUserId: async (platformUserId) => [...routes.values()].find((route) => route.enabled && route.platformUserId === platformUserId),
    listActiveSalesforceUsernames: async () => Object.freeze([...routes.values()].filter((route) => route.enabled).map((route) => route.salesforceUsername)),
    create: async () => { throw new Error('not used by HTTP identity test'); },
    update: async () => { throw new Error('not used by HTTP identity test'); },
    disable: async () => { throw new Error('not used by HTTP identity test'); },
    delete: async () => { throw new Error('not used by HTTP identity test'); },
  };
  const credentialRepository: IdentityCredentialRepository = {
    getById: async (id) => credentials.get(id),
    getByTokenHash: async (tokenHash) => [...credentials.values()].find((credential) => credential.tokenHash === tokenHash),
    getActiveByRouteId: async (identityRouteId) => [...credentials.values()].find(
      (credential) => credential.identityRouteId === identityRouteId && credential.status === 'ACTIVE',
    ),
    listActiveByRouteIds: async (routeIds) => Object.freeze([...credentials.values()].filter(
      (credential) => routeIds.includes(credential.identityRouteId) && credential.status === 'ACTIVE',
    )),
    listByRouteId: async (identityRouteId) => Object.freeze([...credentials.values()].filter(
      (credential) => credential.identityRouteId === identityRouteId,
    )),
    create: async () => { throw new Error('not used by HTTP identity test'); },
    revoke: async () => { throw new Error('not used by HTTP identity test'); },
    markLastUsed: async () => undefined,
    deleteByRouteId: async () => { throw new Error('not used by HTTP identity test'); },
  };
  return Object.freeze({ routes, credentials, routeRepository, credentialRepository });
}

function identityRoute(id: string, platformUserId: string, enabled: boolean): IdentityRouteRecord {
  return Object.freeze({
    id,
    platformUserId,
    userName: platformUserId,
    salesforceUsername: platformUserId === TEST_PLATFORM_USER_A ? TEST_USERNAME_A : TEST_USERNAME_B,
    enabled,
    remark: null,
    rowVersion: '1',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  });
}

function identityCredential(
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
    generatedAt: '2026-08-24T00:00:00.000Z',
    lastUsedAt: null,
    revokedAt: status === 'REVOKED' ? '2026-08-24T00:00:00.000Z' : null,
    rowVersion: '1',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  });
}

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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

test('P2 HTTP runtime enforces auth/bounds, hides disabled/host-owned Tools, and isolates 50 A/B calls', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p2-http-'));
  const connectionFactory = new RecordingConnectionFactory();
  const identityRuntime = createTestIdentityRuntime(baseRoot, connectionFactory);
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
    assert.equal(await responseErrorCode(noBearer), 'MCP_CLIENT_AUTH_REQUIRED');

    const wrongBearer = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: mcpHeaders(TEST_PLATFORM_USER_A, 'wrong-bearer-token'),
      body: initializeBody(),
    });
    assert.equal(wrongBearer.status, 401);
    assert.equal(await responseErrorCode(wrongBearer), 'MCP_CLIENT_AUTH_INVALID');

    const noPlatformUser = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: mcpHeaders(undefined),
      body: initializeBody(),
    });
    assert.equal(noPlatformUser.status, 401);
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
    const queryTool = listed.tools.find((tool) => tool.name === 'run_soql_query');
    assert(queryTool);
    const queryProperties = isRecord(queryTool.inputSchema.properties)
      ? queryTool.inputSchema.properties
      : {};
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

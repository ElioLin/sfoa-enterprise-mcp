import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CwdExecutionGuard } from '../cwd-execution-guard.js';
import { startIdentityHttpServer } from '../http-server.js';
import { NoopRuntimeLogger } from '../runtime-logger.js';
import { RecordingConnectionFactory, TEST_ROUTE_A, TEST_ROUTE_B, createTestScopeFactory } from './helpers.js';

test('P1 Streamable HTTP binds each request to A or B and blocks forged, unknown, and missing identities', async () => {
  const originalCwd = process.cwd();
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p1-http-test-'));
  const connectionFactory = new RecordingConnectionFactory();
  const setup = createTestScopeFactory({
    baseRoot: path.join(testRoot, 'requests'),
    connectionFactory,
  });
  const server = await startIdentityHttpServer({
    scopeFactory: setup.scopeFactory,
    cwdGuard: new CwdExecutionGuard(originalCwd),
    logger: new NoopRuntimeLogger(),
  });
  const clientA = createClient(server.url, TEST_ROUTE_A.platformUserId, 'corr-http-a');
  const clientB = createClient(server.url, TEST_ROUTE_B.platformUserId, 'corr-http-b');

  try {
    await Promise.all([clientA.client.connect(clientA.transport), clientB.client.connect(clientB.transport)]);

    const listed = await clientA.client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ['get_username', 'retrieve_metadata', 'run_soql_query'],
    );

    const [usernameA, usernameB] = await Promise.all([
      callUsername(clientA.client, TEST_ROUTE_A.salesforceUsername, testRoot),
      callUsername(clientB.client, TEST_ROUTE_B.salesforceUsername, testRoot),
    ]);
    assert.match(textContent(usernameA), new RegExp(escapeRegExp(TEST_ROUTE_A.salesforceUsername), 'u'));
    assert.match(textContent(usernameB), new RegExp(escapeRegExp(TEST_ROUTE_B.salesforceUsername), 'u'));

    const [queryA, queryB] = await Promise.all([
      callQuery(clientA.client, TEST_ROUTE_A.salesforceUsername, testRoot),
      callQuery(clientB.client, TEST_ROUTE_B.salesforceUsername, testRoot),
    ]);
    assert.notEqual(queryA.isError, true);
    assert.notEqual(queryB.isError, true);

    const bBeforeForgery = connectionFactory.countFor(TEST_ROUTE_B.platformUserId);
    const forgedAToB = await callQuery(clientA.client, TEST_ROUTE_B.salesforceUsername, testRoot);
    assert.equal(forgedAToB.isError, true);
    assert.match(textContent(forgedAToB), /MCP_IDENTITY_CONTEXT_MISMATCH/u);
    assert.equal(connectionFactory.countFor(TEST_ROUTE_B.platformUserId), bBeforeForgery);

    const aBeforeForgery = connectionFactory.countFor(TEST_ROUTE_A.platformUserId);
    const forgedBToA = await callQuery(clientB.client, TEST_ROUTE_A.salesforceUsername, testRoot);
    assert.equal(forgedBToA.isError, true);
    assert.match(textContent(forgedBToA), /MCP_IDENTITY_CONTEXT_MISMATCH/u);
    assert.equal(connectionFactory.countFor(TEST_ROUTE_A.platformUserId), aBeforeForgery);

    const totalBeforeDenied = connectionFactory.creations.length;
    const unknown = await rawMcpPost(server.url, { 'x-platform-user-id': 'does-not-exist' });
    assert.equal(unknown.response.status, 403);
    assert.equal(unknown.body.error.data.errorCode, 'MCP_IDENTITY_ROUTE_NOT_FOUND');
    const missing = await rawMcpPost(server.url, {});
    assert.equal(missing.response.status, 401);
    assert.equal(missing.body.error.data.errorCode, 'MCP_PLATFORM_USER_REQUIRED');
    const blank = await rawMcpPost(server.url, { 'x-platform-user-id': '   ' });
    assert.equal(blank.response.status, 401);
    assert.equal(blank.body.error.data.errorCode, 'MCP_PLATFORM_USER_REQUIRED');
    assert.equal(connectionFactory.creations.length, totalBeforeDenied);

    const bBeforeArbitrary = connectionFactory.countFor(TEST_ROUTE_B.platformUserId);
    const arbitraryAdmin = await callQuery(clientA.client, 'arbitrary-admin-user', testRoot);
    assert.equal(arbitraryAdmin.isError, true);
    assert.match(textContent(arbitraryAdmin), /MCP_IDENTITY_CONTEXT_MISMATCH/u);
    assert.equal(connectionFactory.countFor(TEST_ROUTE_B.platformUserId), bBeforeArbitrary);

    const beforeConcurrent = connectionFactory.creations.length;
    const concurrentCalls = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0
        ? callUsername(clientA.client, TEST_ROUTE_A.salesforceUsername, testRoot)
        : callUsername(clientB.client, TEST_ROUTE_B.salesforceUsername, testRoot),
    );
    const concurrentResults = await Promise.all(concurrentCalls);
    assert.equal(concurrentResults.filter((result) => result.isError === true).length, 0);
    assert.equal(connectionFactory.creations.length - beforeConcurrent, 0);
    assert.equal(new Set(connectionFactory.creations.map((creation) => creation.connection)).size, connectionFactory.creations.length);

    await waitFor(() => setup.workspaceFactory.getMetrics().active === 0);
    assert.equal(setup.workspaceFactory.getMetrics().created, setup.workspaceFactory.getMetrics().cleaned);
    assert.equal(process.cwd(), originalCwd);

    const untrustedOrigin = await rawMcpPost(
      server.url,
      { 'x-platform-user-id': TEST_ROUTE_A.platformUserId, origin: 'https://untrusted.example' },
    );
    assert.equal(untrustedOrigin.response.status, 403);
  } finally {
    await Promise.allSettled([clientA.client.close(), clientB.client.close()]);
    await server.close();
    if (process.cwd() !== originalCwd) process.chdir(originalCwd);
    await removeHttpTestRoot(testRoot);
  }
});

function createClient(url: URL, platformUserId: string, correlationId: string): {
  client: Client;
  transport: StreamableHTTPClientTransport;
} {
  return {
    client: new Client({ name: `p1-test-${platformUserId}`, version: '0.1.0-p1' }),
    transport: new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: {
          'x-platform-user-id': platformUserId,
          'x-correlation-id': correlationId,
        },
      },
    }),
  };
}

async function callUsername(client: Client, expectedUsername: string, directory: string): Promise<CallToolResult> {
  const result = CallToolResultSchema.parse(
    await client.callTool({
      name: 'get_username',
      arguments: { defaultTargetOrg: false, defaultDevHub: false, directory },
    }),
  );
  if (result.isError !== true) {
    assert.match(textContent(result), new RegExp(escapeRegExp(expectedUsername), 'u'));
  }
  return result;
}

async function callQuery(client: Client, usernameOrAlias: string, directory: string): Promise<CallToolResult> {
  return CallToolResultSchema.parse(
    await client.callTool({
      name: 'run_soql_query',
      arguments: {
        query: 'SELECT Id FROM Lead LIMIT 5',
        usernameOrAlias,
        directory,
        useToolingApi: false,
      },
    }),
  );
}

type RuntimeErrorBody = {
  error: { data: { errorCode: string } };
};

async function rawMcpPost(
  url: URL,
  extraHeaders: Readonly<Record<string, string>>,
): Promise<{ response: Response; body: RuntimeErrorBody }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }),
  });
  return { response, body: (await response.json()) as RuntimeErrorBody };
}

function textContent(result: CallToolResult): string {
  return result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for request cleanup.');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function removeHttpTestRoot(root: string): Promise<void> {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.match(path.basename(resolved), /^sfoa-p1-http-test-/u);
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

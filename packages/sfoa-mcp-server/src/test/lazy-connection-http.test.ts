import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Connection } from '@salesforce/core';
import {
  IdentityRuntimeError,
  type SalesforceConnectionFactory,
} from '@sfoa/identity-runtime';
import { startRemoteMcpServer } from '../http-server.js';
import {
  createTestIdentityRuntime,
  createTestRemoteConfig,
  TEST_CLIENT_TOKEN,
  TEST_PLATFORM_USER_A,
  TEST_USERNAME_A,
  toolResultText,
} from './helpers.js';

test('lazy Salesforce authentication failure occurs at Tool execution with stable MCP taxonomy', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p7-09-http-failure-'));
  let creates = 0;
  const connectionFactory: SalesforceConnectionFactory = {
    create: async (): Promise<Connection> => {
      creates += 1;
      throw new IdentityRuntimeError(
        'MCP_SALESFORCE_AUTH_FAILED',
        'Salesforce JWT authentication failed for the resolved request identity.',
      );
    },
  };
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({
      enabledTools: Object.freeze(['get_username', 'run_soql_query']),
    }),
    identityRuntime: createTestIdentityRuntime(baseRoot, connectionFactory),
  });
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: {
      headers: {
        authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        'x-platform-user-id': TEST_PLATFORM_USER_A,
      },
    },
  });
  const client = new Client({ name: 'p7-09-failure', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal(creates, 0);
    const listedBefore = await client.listTools();
    assert.deepEqual(listedBefore.tools.map((tool) => tool.name), ['get_username', 'run_soql_query']);
    assert.equal(creates, 0);

    const result = await client.callTool({
      name: 'run_soql_query',
      arguments: { query: 'SELECT Id FROM Lead LIMIT 1', useToolingApi: false },
    });
    assert.equal(result.isError, true);
    assert.match(toolResultText(result), /MCP_SALESFORCE_AUTH_FAILED/u);
    assert.match(toolResultText(result), /Correlation ID:/u);
    assert.equal(creates, 1);

    // The Tool error must not destroy the MCP session, remove the Tool list, require a
    // reconnect, change the schema, or corrupt a subsequent local Tool call.
    const listedAfter = await client.listTools();
    assert.deepEqual(listedAfter.tools.map((tool) => tool.name), ['get_username', 'run_soql_query']);
    assert.deepEqual(listedAfter.tools, listedBefore.tools);
    const localResult = await client.callTool({ name: 'get_username', arguments: {} });
    assert.ok(!localResult.isError, 'get_username must still succeed after a Tool-level auth failure');
    assert.match(toolResultText(localResult), new RegExp(TEST_USERNAME_A.replaceAll('.', '\\.')));
    assert.equal(creates, 1, 'get_username and listTools must remain Connection-free after a Tool-level auth failure');
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});

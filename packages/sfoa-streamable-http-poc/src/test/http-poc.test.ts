import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { PocServices } from '../services.js';
import { startPocHttpServer } from '../server.js';

test('initialize, tools/list, and tools/call work over stateless Streamable HTTP', async () => {
  const httpServer = await startPocHttpServer({
    servicesFactory: () => new PocServices({ allowedOrgs: new Set<string>() }),
  });
  const client = new Client({ name: 'sfoa-p0-test-client', version: '0.0.0-p0' });
  const transport = new StreamableHTTPClientTransport(httpServer.url);

  try {
    // Client.connect performs MCP initialize and the initialized notification.
    await client.connect(transport);

    const listResult = await client.listTools();
    const toolNames = listResult.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes('get_username'));
    assert.ok(toolNames.includes('run_soql_query'));
    assert.ok(toolNames.includes('retrieve_metadata'));

    const callResult = CallToolResultSchema.parse(
      await client.callTool({
        name: 'get_username',
        arguments: {
          defaultTargetOrg: true,
          defaultDevHub: false,
          directory: process.cwd(),
        },
      }),
    );
    assert.notEqual(callResult.isError, true);
    assert.equal(callResult.content[0]?.type, 'text');

    const methodResponse = await fetch(httpServer.url, { method: 'GET' });
    assert.equal(methodResponse.status, 405);

    const rejectedOrigin = await fetch(httpServer.url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        origin: 'https://untrusted.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(rejectedOrigin.status, 403);
  } finally {
    await client.close();
    await httpServer.close();
  }
});

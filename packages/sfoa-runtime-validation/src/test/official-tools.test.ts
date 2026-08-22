import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import { createOfficialToolSession } from '../official-tools.js';
import { ValidationServices } from '../services.js';

test('official DxCore provider registers required Closure tools over MCP', async () => {
  const services = new ValidationServices({
    connection: {} as unknown as Connection,
    username: 'test@example.com',
    alias: 'test-alias',
    orgId: '00D000000000001',
    instanceUrl: 'https://example.my.salesforce.com',
    dataDir: process.cwd(),
  });
  const session = await createOfficialToolSession(services);

  try {
    assert.equal(session.providerName, 'DxCoreMcpProvider');
    assert.deepEqual([...session.toolNames].sort(), ['retrieve_metadata', 'run_soql_query']);
  } finally {
    await session.close();
  }
});

test('official run_soql_query executes through the injected Connection', async () => {
  let receivedQuery = '';
  const connection = {
    query: async (query: string) => {
      receivedQuery = query;
      return { done: true, totalSize: 1, records: [{ Id: 'test-only-id' }] };
    },
  } as unknown as Connection;
  const services = new ValidationServices({
    connection,
    username: 'test@example.com',
    alias: 'test-alias',
    orgId: '00D000000000001',
    instanceUrl: 'https://example.my.salesforce.com',
    dataDir: process.cwd(),
  });
  const session = await createOfficialToolSession(services);

  try {
    const result = await session.callSoql({
      query: 'SELECT Id FROM Account LIMIT 5',
      username: 'test@example.com',
      directory: process.cwd(),
    });
    assert.equal(receivedQuery, 'SELECT Id FROM Account LIMIT 5');
    assert.deepEqual(result, { rows: 1 });
  } finally {
    await session.close();
  }
});

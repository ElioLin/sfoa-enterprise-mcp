import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Connection } from '@salesforce/core';
import { IdentityRuntimeError, type SalesforceConnectionFactory } from '@sfoa/identity-runtime';
import { parseDmlAllowlistJson } from '@sfoa/mcp-provider-sfoa-dml';
import { RemoteRuntimeError } from '../errors.js';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
import {
  createTestIdentityRuntime,
  createTestRemoteConfig,
  RecordingConnectionFactory,
  TEST_CLIENT_TOKEN,
  TEST_PLATFORM_USER_A,
  TEST_PLATFORM_USER_B,
  TEST_USERNAME_A,
  TEST_USERNAME_B,
  toolResultText,
} from '../test/helpers.js';

const LEAD_DML_POLICY = parseDmlAllowlistJson(JSON.stringify([
  { objectApiName: 'Lead', operations: ['CREATE', 'UPDATE'] },
]));

test('P3 tools/list exposes only explicitly enabled CREATE/UPDATE and keeps all other mutations absent', async () => {
  const fixture = await startFixture();
  const client = await connectClient(fixture.server, TEST_PLATFORM_USER_A);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['create_record', 'update_record']);
    assert.equal(fixture.connectionFactory.creations.length, 0, 'tools/list must not create a Salesforce Connection');
    for (const forbidden of [
      'delete_record',
      'undelete_record',
      'upsert_record',
      'merge_records',
      'arbitrary_rest',
      'deploy_metadata',
      'assign_permission_set',
    ]) {
      assert.equal(listed.tools.some((tool) => tool.name === forbidden), false);
    }

    const create = listed.tools.find((tool) => tool.name === 'create_record');
    const update = listed.tools.find((tool) => tool.name === 'update_record');
    assert(create);
    assert(update);
    for (const tool of [create, update]) {
      assert.match(tool.description ?? '', /not idempotent/iu);
      assert.match(tool.description ?? '', /Do not automatically retry/iu);
      assert.match(tool.description ?? '', /read-only Tool/iu);
      assert.equal(tool.annotations?.idempotentHint, false);
    }
    assert.deepEqual(Object.keys(readProperties(create.inputSchema)).sort(), ['fields', 'objectApiName']);
    assert.deepEqual(Object.keys(readProperties(update.inputSchema)).sort(), ['fields', 'objectApiName', 'recordId']);
    assert.equal('operation' in readProperties(create.inputSchema), false);
    assert.equal('platformUserId' in readProperties(create.inputSchema), false);
    assert.equal('username' in readProperties(create.inputSchema), false);
    assert.equal('directory' in readProperties(create.inputSchema), false);
  } finally {
    await client.close().catch(() => undefined);
    await fixture.close();
  }
});

test('P3 CREATE/UPDATE route A and B independently and never reuse a Connection', async () => {
  const fixture = await startFixture();
  const clientA = await connectClient(fixture.server, TEST_PLATFORM_USER_A);
  const clientB = await connectClient(fixture.server, TEST_PLATFORM_USER_B);
  try {
    const createA = await clientA.callTool({
      name: 'create_record',
      arguments: { objectApiName: 'Lead', fields: { LastName: 'A', Company: 'SFoA' } },
    });
    const createB = await clientB.callTool({
      name: 'create_record',
      arguments: { objectApiName: 'Lead', fields: { LastName: 'B', Company: 'SFoA' } },
    });
    const idA = readRecordId(createA.structuredContent);
    const idB = readRecordId(createB.structuredContent);
    assert(idA);
    assert(idB);

    const [updateA, updateB] = await Promise.all([
      clientA.callTool({
        name: 'update_record',
        arguments: { objectApiName: 'Lead', recordId: idA, fields: { Company: 'Updated A' } },
      }),
      clientB.callTool({
        name: 'update_record',
        arguments: { objectApiName: 'Lead', recordId: idB, fields: { Company: 'Updated B' } },
      }),
    ]);
    assert.equal(readRecordId(updateA.structuredContent), idA);
    assert.equal(readRecordId(updateB.structuredContent), idB);

    assert.deepEqual(
      fixture.connectionFactory.dmlCalls.map(({ platformUserId, salesforceUsername, operation }) => ({
        platformUserId,
        salesforceUsername,
        operation,
      })).sort(compareMutationRoute),
      [
        { platformUserId: TEST_PLATFORM_USER_A, salesforceUsername: TEST_USERNAME_A, operation: 'CREATE' },
        { platformUserId: TEST_PLATFORM_USER_B, salesforceUsername: TEST_USERNAME_B, operation: 'CREATE' },
        { platformUserId: TEST_PLATFORM_USER_A, salesforceUsername: TEST_USERNAME_A, operation: 'UPDATE' },
        { platformUserId: TEST_PLATFORM_USER_B, salesforceUsername: TEST_USERNAME_B, operation: 'UPDATE' },
      ].sort(compareMutationRoute),
    );
    assert.equal(
      new Set(fixture.connectionFactory.creations.map((creation) => creation.connection)).size,
      fixture.connectionFactory.creations.length,
      'every authenticated MCP request must receive a fresh Connection',
    );
    assert.equal(
      new Set(fixture.connectionFactory.dmlCalls.map((call) => call.sequence)).size,
      fixture.connectionFactory.dmlCalls.length,
      'cross-user and same-user mutation Connection reuse must be zero',
    );
    assert.equal(fixture.connectionFactory.creations.length, 4, 'each DML request must lazily create exactly one Connection');
  } finally {
    await Promise.allSettled([clientA.close(), clientB.close()]);
    await fixture.close();
  }
});

test('forged body identity fields cannot change the authenticated CREATE/UPDATE route', async () => {
  const fixture = await startFixture();
  const clientA = await connectClient(fixture.server, TEST_PLATFORM_USER_A);
  try {
    const create = await clientA.callTool({
      name: 'create_record',
      arguments: {
        objectApiName: 'Lead',
        fields: { LastName: 'Forged', Company: 'SFoA' },
        platformUserId: TEST_PLATFORM_USER_B,
        username: TEST_USERNAME_B,
        usernameOrAlias: TEST_USERNAME_B,
        salesforceUsername: TEST_USERNAME_B,
        instanceUrl: 'https://evil.example',
        accessToken: 'forged-token',
      },
    });
    const recordId = readRecordId(create.structuredContent);
    assert(recordId);
    await clientA.callTool({
      name: 'update_record',
      arguments: {
        objectApiName: 'Lead',
        recordId,
        fields: { Company: 'Still A' },
        platformUserId: TEST_PLATFORM_USER_B,
        salesforceUsername: TEST_USERNAME_B,
      },
    });

    assert.equal(fixture.connectionFactory.dmlCalls.length, 2);
    assert.equal(
      fixture.connectionFactory.dmlCalls.every(
        (call) => call.platformUserId === TEST_PLATFORM_USER_A && call.salesforceUsername === TEST_USERNAME_A,
      ),
      true,
    );
    assert.equal(JSON.stringify(fixture.connectionFactory.dmlCalls).includes('forged-token'), false);
  } finally {
    await clientA.close().catch(() => undefined);
    await fixture.close();
  }
});

test('enabled P3 mutation Tools require a matching non-empty operation allowlist', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p3-deny-'));
  try {
    for (const dmlAllowlist of [
      parseDmlAllowlistJson(undefined),
      parseDmlAllowlistJson('[]'),
      parseDmlAllowlistJson(JSON.stringify([{ objectApiName: 'Lead', operations: ['CREATE'] }])),
    ]) {
      await assert.rejects(
        startRemoteMcpServer({
          config: createTestRemoteConfig({
            enabledTools: Object.freeze(['create_record', 'update_record']),
            dmlAllowlist,
          }),
          identityRuntime: createTestIdentityRuntime(baseRoot),
        }),
        (error: unknown) => error instanceof RemoteRuntimeError && error.code === 'MCP_DML_CONFIGURATION_INVALID',
      );
    }
  } finally {
    await rm(baseRoot, { recursive: true, force: true });
  }
});

test('official mutation/admin Tools remain denied even when P3 CREATE/UPDATE are enabled', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p3-official-deny-'));
  try {
    for (const forbiddenTool of ['deploy_metadata', 'assign_permission_set']) {
      await assert.rejects(
        startRemoteMcpServer({
          config: createTestRemoteConfig({
            enabledTools: Object.freeze(['create_record', 'update_record', forbiddenTool]),
            dmlAllowlist: LEAD_DML_POLICY,
          }),
          identityRuntime: createTestIdentityRuntime(baseRoot),
        }),
        (error: unknown) =>
          error instanceof RemoteRuntimeError &&
          ['MCP_TOOL_DISABLED', 'MCP_TOOL_NOT_AVAILABLE'].includes(error.code),
      );
    }
  } finally {
    await rm(baseRoot, { recursive: true, force: true });
  }
});

test('lazy Salesforce auth failure on create_record keeps the DML output contract parseable', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p3-lazy-auth-'));
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
      enabledTools: Object.freeze(['create_record', 'update_record']),
      dmlAllowlist: LEAD_DML_POLICY,
    }),
    identityRuntime: createTestIdentityRuntime(baseRoot, connectionFactory),
  });
  const client = await connectClient(server, TEST_PLATFORM_USER_A);
  try {
    const result = await client.callTool({
      name: 'create_record',
      arguments: { objectApiName: 'Lead', fields: { LastName: 'A', Company: 'SFoA' } },
    });
    assert.equal(result.isError, true);
    const content = result.structuredContent;
    assert.ok(isRecord(content), 'lazy DML auth failure must carry structuredContent');
    assert.equal(content.success, false);
    assert.equal(content.errorCode, 'MCP_SALESFORCE_AUTH_FAILED');
    assert.equal(typeof content.message, 'string');
    assert.ok((content.message as string).length > 0);
    assert.match(toolResultText(result), /MCP_SALESFORCE_AUTH_FAILED/u);
    assert.match(toolResultText(result), /Correlation ID:/u);
    assert.equal(creates, 1, 'lazy DML auth failure must attempt Connection creation exactly once');
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});

async function startFixture(): Promise<Readonly<{
  server: RemoteMcpServer;
  connectionFactory: RecordingConnectionFactory;
  close(): Promise<void>;
}>> {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p3-http-'));
  const connectionFactory = new RecordingConnectionFactory();
  try {
    const server = await startRemoteMcpServer({
      config: createTestRemoteConfig({
        enabledTools: Object.freeze(['create_record', 'update_record']),
        dmlAllowlist: LEAD_DML_POLICY,
      }),
      identityRuntime: createTestIdentityRuntime(baseRoot, connectionFactory),
    });
    return {
      server,
      connectionFactory,
      close: async (): Promise<void> => {
        await server.close();
        await rm(baseRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(baseRoot, { recursive: true, force: true });
    throw error;
  }
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
  const client = new Client({ name: `p3-${platformUserId}`, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function readProperties(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema) || !isRecord(schema.properties)) return {};
  return schema.properties;
}

function readRecordId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.recordId === 'string' ? value.recordId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareMutationRoute(
  left: Readonly<{ platformUserId: string; operation: string }>,
  right: Readonly<{ platformUserId: string; operation: string }>,
): number {
  return `${left.platformUserId}:${left.operation}`.localeCompare(`${right.platformUserId}:${right.operation}`);
}

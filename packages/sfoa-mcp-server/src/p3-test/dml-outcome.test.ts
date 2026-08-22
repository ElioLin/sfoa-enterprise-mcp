import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Connection } from '@salesforce/core';
import { parseDmlAllowlistJson } from '@sfoa/mcp-provider-sfoa-dml';
import type {
  RuntimeLogEvent,
  RuntimeLogger,
  SalesforceConnectionFactory,
  SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
import {
  createTestIdentityRuntime,
  createTestRemoteConfig,
  TEST_CLIENT_TOKEN,
  TEST_PLATFORM_USER_A,
  TEST_USERNAME_A,
  toolResultText,
  waitFor,
} from '../test/helpers.js';

const LEAD_DML_POLICY = parseDmlAllowlistJson(JSON.stringify([
  { objectApiName: 'Lead', operations: ['CREATE', 'UPDATE'] },
]));

class LateMutationConnectionFactory implements SalesforceConnectionFactory {
  public createInvocations = 0;
  public updateInvocations = 0;
  public createCompletions = 0;
  public updateCompletions = 0;

  public constructor(private readonly completionDelayMs: number) {}

  public create(route: SalesforceIdentityRoute): Promise<Connection> {
    const connection = {
      getApiVersion: () => '65.0',
      identity: async () => ({
        username: route.salesforceUsername,
        user_id: `005-${route.platformUserId}`,
        organization_id: '00D-test',
      }),
      query: async () => ({ records: [], totalSize: 0, done: true }),
      tooling: { query: async () => ({ records: [], totalSize: 0, done: true }) },
      sobject: () => ({
        create: async () => {
          this.createInvocations += 1;
          await delay(this.completionDelayMs);
          this.createCompletions += 1;
          return { success: true, id: '00Q000000000001AAA', errors: [] };
        },
        update: async (record: Readonly<Record<string, unknown>>) => {
          this.updateInvocations += 1;
          await delay(this.completionDelayMs);
          this.updateCompletions += 1;
          return { success: true, id: String(record.Id), errors: [] };
        },
      }),
    } as unknown as Connection;
    return Promise.resolve(connection);
  }
}

class RecordingRuntimeLogger implements RuntimeLogger {
  public readonly events: RuntimeLogEvent[] = [];

  public log(event: RuntimeLogEvent): void {
    this.events.push(event);
  }
}

test('CREATE timeout returns unknown, completes late once, and is never automatically retried', async () => {
  const factory = new LateMutationConnectionFactory(150);
  const logger = new RecordingRuntimeLogger();
  const fixture = await startFixture(factory, logger);
  let client: Client | undefined;
  try {
    client = await connectClient(fixture.server);
    const result = await client.callTool({
      name: 'create_record',
      arguments: { objectApiName: 'Lead', fields: { LastName: 'Late', Company: 'SFoA' } },
    });

    assert.equal(result.isError, true);
    assert.equal(readErrorCode(result.structuredContent), 'MCP_DML_OUTCOME_UNKNOWN');
    assert.match(toolResultText(result), /Do not automatically retry/u);
    assert.match(toolResultText(result), /server-side cancellation is not guaranteed/u);
    assert.equal(factory.createInvocations, 1);
    assert.equal(factory.createCompletions, 0);

    await waitFor(() => factory.createCompletions === 1, 1_000);
    assert.equal(factory.createInvocations, 1);
    assert.equal(factory.updateInvocations, 0);
    assertOutcomeLog(logger.events, 'create_record');
  } finally {
    await client?.close().catch(() => undefined);
    await fixture.close();
  }
});

test('UPDATE timeout returns unknown and the Host invokes update exactly once', async () => {
  const factory = new LateMutationConnectionFactory(150);
  const logger = new RecordingRuntimeLogger();
  const fixture = await startFixture(factory, logger);
  let client: Client | undefined;
  try {
    client = await connectClient(fixture.server);
    const result = await client.callTool({
      name: 'update_record',
      arguments: {
        objectApiName: 'Lead',
        recordId: '00Q000000000001AAA',
        fields: { Company: 'Late Update' },
      },
    });

    assert.equal(result.isError, true);
    assert.equal(readErrorCode(result.structuredContent), 'MCP_DML_OUTCOME_UNKNOWN');
    assert.match(toolResultText(result), /Do not automatically retry/u);
    assert.equal(factory.updateInvocations, 1);

    await waitFor(() => factory.updateCompletions === 1, 1_000);
    assert.equal(factory.updateInvocations, 1);
    assert.equal(factory.createInvocations, 0);
    assertOutcomeLog(logger.events, 'update_record');
  } finally {
    await client?.close().catch(() => undefined);
    await fixture.close();
  }
});

async function startFixture(
  connectionFactory: SalesforceConnectionFactory,
  logger: RuntimeLogger,
): Promise<Readonly<{ server: RemoteMcpServer; close(): Promise<void> }>> {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p3-outcome-'));
  try {
    const server = await startRemoteMcpServer({
      config: createTestRemoteConfig({
        enabledTools: Object.freeze(['create_record', 'update_record']),
        dmlAllowlist: LEAD_DML_POLICY,
        requestTimeoutMs: 1_000,
        toolTimeoutMs: 30,
      }),
      identityRuntime: createTestIdentityRuntime(baseRoot, connectionFactory, logger),
    });
    return {
      server,
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

async function connectClient(server: RemoteMcpServer): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: {
      headers: {
        authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        'x-platform-user-id': TEST_PLATFORM_USER_A,
      },
    },
  });
  const client = new Client({ name: 'p3-outcome-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function assertOutcomeLog(events: readonly RuntimeLogEvent[], toolName: string): void {
  const event = events.find((candidate) => candidate.toolName === toolName);
  assert(event);
  assert.equal(event.errorCode, 'MCP_DML_OUTCOME_UNKNOWN');
  assert.equal(event.correlationId.length > 0, true);
  assert.equal(event.toolName, toolName);
  assert.equal(event.platformUserId, TEST_PLATFORM_USER_A);
  assert.equal(event.salesforceUsername, TEST_USERNAME_A);
}

function readErrorCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.errorCode === 'string' ? value.errorCode : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Connection } from '@salesforce/core';
import {
  AsyncAuditPipeline,
  DatabaseRuntimeLogger,
  type AuditRepository,
  type AuditWrite,
} from '@sfoa/control-plane';
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

test('successful CREATE remains successful when durable audit append fails', async () => {
  const factory = new LateMutationConnectionFactory(0);
  const audit = failingDatabaseLogger();
  const fixture = await startFixture(factory, audit.logger);
  let client: Client | undefined;
  try {
    client = await connectClient(fixture.server);
    const result = await client.callTool({
      name: 'create_record',
      arguments: { objectApiName: 'Lead', fields: { LastName: 'Audit', Company: 'Failure' } },
    });

    assert.equal(result.isError, undefined);
    assert.equal(factory.createInvocations, 1);
    assert.equal(factory.createCompletions, 1);
    assert.equal(factory.updateInvocations, 0);
    const mutationAudit = audit.writes.find((event) =>
      event.toolName === 'create_record' && event.outcome === 'SUCCESS');
    assert(mutationAudit);
    assert.equal(audit.logger.getHealth().status, 'DEGRADED');
    assert.ok(audit.logger.getHealth().failureCount >= 1);
    assert.ok(audit.fallback.events.some((event) => event.errorCode === 'MCP_AUDIT_PERSISTENCE_FAILED'));
  } finally {
    await client?.close().catch(() => undefined);
    await fixture.close();
  }
});

test('audit append failure cannot overwrite MCP_DML_OUTCOME_UNKNOWN or trigger a retry', async () => {
  const factory = new LateMutationConnectionFactory(150);
  const audit = failingDatabaseLogger();
  const fixture = await startFixture(factory, audit.logger);
  let client: Client | undefined;
  try {
    client = await connectClient(fixture.server);
    const result = await client.callTool({
      name: 'create_record',
      arguments: { objectApiName: 'Lead', fields: { LastName: 'Unknown', Company: 'Audit Failure' } },
    });

    assert.equal(result.isError, true);
    assert.equal(readErrorCode(result.structuredContent), 'MCP_DML_OUTCOME_UNKNOWN');
    assert.match(toolResultText(result), /Do not automatically retry/u);
    assert.equal(factory.createInvocations, 1);
    const unknownAudit = audit.writes.find((event) =>
      event.toolName === 'create_record' && event.outcome === 'UNKNOWN' &&
      event.errorCode === 'MCP_DML_OUTCOME_UNKNOWN');
    assert(unknownAudit);
    assert.equal(audit.logger.getHealth().status, 'DEGRADED');
    assert.ok(audit.fallback.events.some((event) => event.errorCode === 'MCP_AUDIT_PERSISTENCE_FAILED'));

    await waitFor(() => factory.createCompletions === 1, 1_000);
    assert.equal(factory.createInvocations, 1);
  } finally {
    await client?.close().catch(() => undefined);
    await fixture.close();
  }
});

test('background Writer failure after successful CREATE cannot change success or retry mutation', async () => {
  const factory = new LateMutationConnectionFactory(0);
  const audit = failingAsyncDatabaseLogger();
  const fixture = await startFixture(factory, audit.logger);
  let client: Client | undefined;
  try {
    client = await connectClient(fixture.server);
    const result = await client.callTool({
      name: 'create_record',
      arguments: { objectApiName: 'Lead', fields: { LastName: 'Async', Company: 'Audit Failure' } },
    });
    assert.equal(result.isError, undefined);
    assert.equal(factory.createInvocations, 1);
    assert.equal(factory.createCompletions, 1);
    await waitFor(() => audit.pipeline.getHealth().enqueuedSnapshots === 1, 1_000);
    await audit.pipeline.close(1_000);
    assert.equal(audit.pipeline.getHealth().status, 'DEGRADED');
    assert.equal(audit.pipeline.getHealth().droppedSnapshots, 1);
    assert.equal(factory.createInvocations, 1);
  } finally {
    await client?.close().catch(() => undefined);
    await fixture.close();
    await audit.pipeline.close(1_000);
  }
});

test('background Writer failure preserves DML UNKNOWN and never retries CREATE', async () => {
  const factory = new LateMutationConnectionFactory(150);
  const audit = failingAsyncDatabaseLogger();
  const fixture = await startFixture(factory, audit.logger);
  let client: Client | undefined;
  try {
    client = await connectClient(fixture.server);
    const result = await client.callTool({
      name: 'create_record',
      arguments: { objectApiName: 'Lead', fields: { LastName: 'Unknown', Company: 'Async Audit Failure' } },
    });
    assert.equal(result.isError, true);
    assert.equal(readErrorCode(result.structuredContent), 'MCP_DML_OUTCOME_UNKNOWN');
    assert.equal(factory.createInvocations, 1);
    await waitFor(() => audit.pipeline.getHealth().enqueuedSnapshots === 1, 1_000);
    await audit.pipeline.close(1_000);
    assert.equal(audit.pipeline.getHealth().status, 'DEGRADED');
    await waitFor(() => factory.createCompletions === 1, 1_000);
    assert.equal(factory.createInvocations, 1);
  } finally {
    await client?.close().catch(() => undefined);
    await fixture.close();
    await audit.pipeline.close(1_000);
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
  assert.equal(event.operation, toolName === 'create_record' ? 'CREATE' : 'UPDATE');
  assert.equal(event.outcome, 'UNKNOWN');
  assert.equal(event.mutationStarted, true);
  assert.equal(event.terminationLayer, 'TOOL');
  assert.equal(typeof event.durationMs, 'number');
}

function readErrorCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.errorCode === 'string' ? value.errorCode : undefined;
}

function failingDatabaseLogger(): Readonly<{
  logger: DatabaseRuntimeLogger;
  fallback: RecordingRuntimeLogger;
  writes: AuditWrite[];
}> {
  const writes: AuditWrite[] = [];
  const audits: AuditRepository = {
    append: async (event) => {
      writes.push(event);
      throw new Error('deterministic audit database failure');
    },
    getById: async () => undefined,
    search: async (filter) => Object.freeze({
      items: Object.freeze([]), limit: filter.limit, offset: filter.offset,
      count: 0, hasMore: false, nextOffset: null,
    }),
    countSince: async () => Object.freeze({ total: 0, pass: 0, blocked: 0, error: 0, unknown: 0 }),
  };
  const fallback = new RecordingRuntimeLogger();
  return Object.freeze({ logger: new DatabaseRuntimeLogger(audits, fallback), fallback, writes });
}

function failingAsyncDatabaseLogger(): Readonly<{
  logger: DatabaseRuntimeLogger;
  pipeline: AsyncAuditPipeline;
}> {
  const audits: AuditRepository = {
    append: async () => { throw new Error('request path must not append synchronously'); },
    getById: async () => undefined,
    search: async (filter) => Object.freeze({
      items: Object.freeze([]), limit: filter.limit, offset: filter.offset,
      count: 0, hasMore: false, nextOffset: null,
    }),
    countSince: async () => Object.freeze({ total: 0, pass: 0, blocked: 0, error: 0, unknown: 0 }),
  };
  const pipeline = new AsyncAuditPipeline({
    persist: async () => { throw new Error('deterministic background Audit DB failure'); },
  }, new RecordingRuntimeLogger(), { retryAttempts: 0, flushIntervalMs: 0 });
  return Object.freeze({
    logger: new DatabaseRuntimeLogger(audits, new RecordingRuntimeLogger(), undefined, pipeline),
    pipeline,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

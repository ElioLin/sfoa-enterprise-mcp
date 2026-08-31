import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import {
  AsyncAuditPipeline,
  DatabaseRuntimeLogger,
  type AuditRepository,
} from '@sfoa/control-plane';
import { parseDmlAllowlistJson } from '@sfoa/mcp-provider-sfoa-dml';
import type {
  AuditSnapshot,
  RequestAuditContextController,
  RuntimeLogEvent,
  RuntimeLogger,
  SalesforceConnectionFactory,
  SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import { NoopRuntimeLogger } from '@sfoa/identity-runtime';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
import {
  createTestIdentityRuntime,
  createTestRemoteConfig,
  mcpHeaders,
  TEST_PLATFORM_USER_A,
  TEST_USERNAME_A,
  waitFor,
} from '../test/helpers.js';

const LEAD_DML_POLICY = parseDmlAllowlistJson(JSON.stringify([
  { objectApiName: 'Lead', operations: ['CREATE', 'UPDATE'] },
]));

class DelayedMutationConnectionFactory implements SalesforceConnectionFactory {
  public connectionCreations = 0;
  public createInvocations = 0;
  public updateInvocations = 0;
  public createCompletions = 0;
  public updateCompletions = 0;

  public constructor(
    private readonly connectionDelayMs: number,
    private readonly mutationDelayMs: number,
  ) {}

  public async create(route: SalesforceIdentityRoute): Promise<Connection> {
    this.connectionCreations += 1;
    await delay(this.connectionDelayMs);
    return {
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
          await delay(this.mutationDelayMs);
          this.createCompletions += 1;
          return { success: true, id: '00Q000000000001AAA', errors: [] };
        },
        update: async (record: Readonly<Record<string, unknown>>) => {
          this.updateInvocations += 1;
          await delay(this.mutationDelayMs);
          this.updateCompletions += 1;
          return { success: true, id: String(record.Id), errors: [] };
        },
      }),
    } as unknown as Connection;
  }
}

class RecordingRuntimeLogger implements RuntimeLogger {
  public readonly events: RuntimeLogEvent[] = [];
  public readonly snapshots: AuditSnapshot[] = [];
  private readonly pipeline = new AsyncAuditPipeline({
    persist: async (entries) => {
      for (const entry of entries) {
        if (entry.kind === 'SNAPSHOT') this.snapshots.push(entry.snapshot);
      }
    },
  }, new NoopRuntimeLogger(), { flushIntervalMs: 0 });
  private readonly delegate = new DatabaseRuntimeLogger(
    unusedAuditRepository(),
    new NoopRuntimeLogger(),
    undefined,
    this.pipeline,
  );

  public log(event: RuntimeLogEvent): Promise<void> {
    this.events.push(event);
    return this.delegate.log(event);
  }

  public finalizeRequestAudit(context: RequestAuditContextController): void {
    this.delegate.finalizeRequestAudit(context);
  }

  public async close(): Promise<void> {
    await this.pipeline.close(2_000);
  }
}

function unusedAuditRepository(): AuditRepository {
  return {
    append: async () => { throw new Error('request path must not call AuditRepository.append'); },
    getById: async () => undefined,
    search: async (filter) => Object.freeze({
      items: Object.freeze([]), total: 0, limit: filter.limit, offset: filter.offset,
      count: 0, hasMore: false, nextOffset: null,
    }),
    countSince: async () => Object.freeze({ total: 0, pass: 0, blocked: 0, error: 0, unknown: 0 }),
  };
}

test('CREATE outer request timeout after dispatch returns UNKNOWN and completes late exactly once', async () => {
  // Provider preparation deliberately consumes more than the request/tool
  // deadline difference, while leaving a wide window in which dispatch starts.
  const factory = new DelayedMutationConnectionFactory(800, 1_100);
  const fixture = await startFixture(factory, 1_500, 1_000);
  try {
    const response = await postTool(fixture.server, 'create_record', {
      objectApiName: 'Lead',
      fields: { LastName: 'Late Request', Company: 'SFoA' },
    });
    const body = await readJson(response);

    assertRequestOutcomeUnknown(response, body);
    assert.equal(factory.createInvocations, 1);
    assert.equal(factory.createCompletions, 0);
    assert.equal(factory.updateInvocations, 0);

    await waitFor(() => factory.createCompletions === 1, 1_000);
    assert.equal(factory.createInvocations, 1, 'Host must not retry CREATE after request timeout');
    assertRequestOutcomeLog(fixture.logger.events, 'create_record', 'CREATE');
    await assertPayloadEvidence(fixture.logger, 'MCP_DML_OUTCOME_UNKNOWN', 'UNKNOWN');
  } finally {
    await fixture.close();
  }
});

test('UPDATE outer request timeout after dispatch returns UNKNOWN and completes late exactly once', async () => {
  const factory = new DelayedMutationConnectionFactory(800, 1_100);
  const fixture = await startFixture(factory, 1_500, 1_000);
  try {
    const response = await postTool(fixture.server, 'update_record', {
      objectApiName: 'Lead',
      recordId: '00Q000000000001AAA',
      fields: { Company: 'Late Request Update' },
    });
    const body = await readJson(response);

    assertRequestOutcomeUnknown(response, body);
    assert.equal(factory.updateInvocations, 1);
    assert.equal(factory.updateCompletions, 0);
    assert.equal(factory.createInvocations, 0);

    await waitFor(() => factory.updateCompletions === 1, 1_000);
    assert.equal(factory.updateInvocations, 1, 'Host must not retry UPDATE after request timeout');
    assertRequestOutcomeLog(fixture.logger.events, 'update_record', 'UPDATE');
  } finally {
    await fixture.close();
  }
});

test('request timeout before mutation dispatch remains MCP_REQUEST_TIMEOUT with zero mutation calls', async () => {
  const factory = new DelayedMutationConnectionFactory(400, 0);
  const fixture = await startFixture(factory, 250, 150);
  try {
    const response = await postTool(fixture.server, 'create_record', {
      objectApiName: 'Lead',
      fields: { LastName: 'Never Dispatched' },
    });
    const body = await readJson(response);

    assert.equal(response.status, 504);
    assert.equal(readErrorData(body)?.errorCode, 'MCP_REQUEST_TIMEOUT');
    assert.doesNotMatch(readErrorMessage(body) ?? '', /whether Salesforce committed/iu);
    assert.equal(factory.createInvocations, 0);
    assert.equal(factory.updateInvocations, 0);

    await delay(450);
    assert.equal(factory.createInvocations, 0);
    assert.equal(fixture.logger.events.some((event) => event.mutationStarted === true), false);
    await assertPayloadEvidence(fixture.logger, 'MCP_REQUEST_TIMEOUT', 'FAILED');
  } finally {
    await fixture.close();
  }
});

test('allowlist denial remains local and does not mark mutation execution started', async () => {
  const factory = new DelayedMutationConnectionFactory(0, 0);
  const fixture = await startFixture(factory, 1_000, 500);
  try {
    const response = await postTool(fixture.server, 'create_record', {
      objectApiName: 'Account',
      fields: { Name: 'Denied' },
    });
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(readToolErrorCode(body), 'MCP_DML_OBJECT_NOT_ALLOWED');
    assert.equal(factory.createInvocations, 0);
    assert.equal(factory.updateInvocations, 0);
    assert.equal(fixture.logger.events.some((event) => event.mutationStarted === true), false);
  } finally {
    await fixture.close();
  }
});

test('unknown and off-limits Tools never mark mutation execution started', async () => {
  const factory = new DelayedMutationConnectionFactory(0, 0);
  const fixture = await startFixture(factory, 1_000, 500);
  try {
    for (const toolName of ['delete_record', 'deploy_metadata']) {
      const response = await postTool(fixture.server, toolName, {});
      const body = await readJson(response);
      assert.doesNotMatch(JSON.stringify(body), /MCP_DML_OUTCOME_UNKNOWN/u);
    }

    assert.equal(factory.createInvocations, 0);
    assert.equal(factory.updateInvocations, 0);
    assert.equal(fixture.logger.events.some((event) => event.mutationStarted === true), false);
  } finally {
    await fixture.close();
  }
});

test('client disconnect after CREATE starts logs UNKNOWN and never replays the mutation', async () => {
  const factory = new DelayedMutationConnectionFactory(0, 350);
  const fixture = await startFixture(factory, 1_000, 500);
  let request: ClientRequest | undefined;
  try {
    request = openToolRequest(
      fixture.server,
      'create_record',
      { objectApiName: 'Lead', fields: { LastName: 'Disconnected' } },
    );
    await waitFor(() => factory.createInvocations === 1, 1_000);
    request.socket?.destroy();

    await waitFor(() => factory.createCompletions === 1, 1_000);
    assert.equal(factory.createInvocations, 1);
    const event = fixture.logger.events.find(
      (candidate) => candidate.terminationLayer === 'TRANSPORT',
    );
    assert(event);
    assert.equal(event.errorCode, 'MCP_DML_OUTCOME_UNKNOWN');
    assert.equal(event.toolName, 'create_record');
    assert.equal(event.operation, 'CREATE');
    assert.equal(event.mutationStarted, true);
    await assertPayloadEvidence(fixture.logger, 'MCP_DML_OUTCOME_UNKNOWN', 'UNKNOWN', 'CLIENT_DISCONNECTED');
  } finally {
    request?.destroy();
    await fixture.close();
  }
});

async function startFixture(
  connectionFactory: SalesforceConnectionFactory,
  requestTimeoutMs: number,
  toolTimeoutMs: number,
): Promise<Readonly<{
  server: RemoteMcpServer;
  logger: RecordingRuntimeLogger;
  close(): Promise<void>;
}>> {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p3-request-outcome-'));
  const logger = new RecordingRuntimeLogger();
  try {
    const server = await startRemoteMcpServer({
      config: createTestRemoteConfig({
        enabledTools: Object.freeze(['create_record', 'update_record']),
        dmlAllowlist: LEAD_DML_POLICY,
        requestTimeoutMs,
        toolTimeoutMs,
      }),
      identityRuntime: createTestIdentityRuntime(baseRoot, connectionFactory, logger),
    });
    return {
      server,
      logger,
      close: async (): Promise<void> => {
        await server.close();
        await logger.close();
        await rm(baseRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(baseRoot, { recursive: true, force: true });
    throw error;
  }
}

async function assertPayloadEvidence(
  logger: RecordingRuntimeLogger,
  errorCode: 'MCP_DML_OUTCOME_UNKNOWN' | 'MCP_REQUEST_TIMEOUT',
  expectedOutcome: AuditSnapshot['auditCall']['outcome'],
  transportStatus = 'RESPONSE_FINISHED',
): Promise<void> {
  await waitFor(() => logger.snapshots.length >= 1, 2_000);
  const snapshot = logger.snapshots.at(-1);
  assert.ok(snapshot);
  assert.equal(snapshot.auditCall.errorCode, errorCode);
  assert.equal(snapshot.auditCall.outcome, expectedOutcome);
  assert.equal(snapshot.payloadEvidence[0]?.payloadType, 'MCP_REQUEST');
  if (transportStatus === 'RESPONSE_FINISHED') {
    assert.equal(snapshot.payloadEvidence[1]?.payloadType, 'MCP_RESPONSE');
    assert.match(snapshot.payloadEvidence[1]?.safePayload ?? '', new RegExp(errorCode, 'u'));
  } else {
    assert.equal(snapshot.payloadEvidence.every((payload) => payload.truncated || payload.payloadType === 'MCP_REQUEST'), true);
  }
  const transport = snapshot.auditEvents.find((event) => event.eventType === 'MCP_TRANSPORT_TERMINAL');
  assert.ok(transport);
  const summary = transport.safeSummary as Record<string, unknown>;
  assert.equal(summary.transportStatus, transportStatus);
  assert.equal(summary.clientReceiptConfirmed, false);
}

async function postTool(
  server: RemoteMcpServer,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Response> {
  return fetch(server.mcpUrl, {
    method: 'POST',
    headers: {
      ...mcpHeaders(TEST_PLATFORM_USER_A),
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
}

function openToolRequest(
  server: RemoteMcpServer,
  name: 'create_record' | 'update_record',
  args: Readonly<Record<string, unknown>>,
): ClientRequest {
  const request = httpRequest(
    server.mcpUrl,
    {
      method: 'POST',
      headers: {
        ...mcpHeaders(TEST_PLATFORM_USER_A),
        'mcp-protocol-version': '2025-06-18',
      },
    },
    (response) => response.resume(),
  );
  request.on('error', () => undefined);
  request.end(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  }));
  return request;
}

function assertRequestOutcomeUnknown(response: Response, body: unknown): void {
  const errorData = readErrorData(body);
  const message = readErrorMessage(body) ?? '';
  assert.equal(response.status, 504);
  assert.equal(errorData?.errorCode, 'MCP_DML_OUTCOME_UNKNOWN');
  assert.equal(errorData?.retryable, false);
  assert.match(message, /Outcome is unknown/iu);
  assert.match(message, /cannot determine whether Salesforce committed/iu);
  assert.match(message, /Do not automatically retry/iu);
  assert.match(message, /server-side cancellation is not guaranteed/iu);
  assert.match(message, /read-only Tool/iu);
}

function assertRequestOutcomeLog(
  events: readonly RuntimeLogEvent[],
  toolName: 'create_record' | 'update_record',
  operation: 'CREATE' | 'UPDATE',
): void {
  const event = events.find(
    (candidate) =>
      candidate.errorCode === 'MCP_DML_OUTCOME_UNKNOWN' &&
      candidate.terminationLayer === 'REQUEST',
  );
  assert(event);
  assert.equal(event.correlationId.length > 0, true);
  assert.equal(event.toolName, toolName);
  assert.equal(event.operation, operation);
  assert.equal(event.platformUserId, TEST_PLATFORM_USER_A);
  assert.equal(event.salesforceUsername, TEST_USERNAME_A);
  assert.equal(event.mutationStarted, true);
  assert.equal(event.outcome, 'UNKNOWN');
  assert.equal(typeof event.durationMs, 'number');
}

async function readJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

function readErrorData(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || !isRecord(body.error) || !isRecord(body.error.data)) return undefined;
  return body.error.data;
}

function readErrorMessage(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  return typeof body.error.message === 'string' ? body.error.message : undefined;
}

function readToolErrorCode(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.result) || !isRecord(body.result.structuredContent)) {
    return undefined;
  }
  const errorCode = body.result.structuredContent.errorCode;
  return typeof errorCode === 'string' ? errorCode : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

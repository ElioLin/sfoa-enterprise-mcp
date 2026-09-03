import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ControlPlaneError,
  freezeSnapshot,
  type DiagnosticConfigRecord,
  type DmlPolicyRecord,
  type IdentityRouteRecord,
  type RequestPolicySnapshot,
} from '@sfoa/control-plane';
import type { RuntimeLogEvent, RuntimeLogger } from '@sfoa/identity-runtime';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
import type { RuntimePolicySnapshotSource } from '../policy-snapshot.js';
import {
  createTestIdentityRuntime,
  createTestRemoteConfig,
  initializeBody,
  mcpHeaders,
  RecordingConnectionFactory,
  TEST_PLATFORM_USER_A,
  TEST_PLATFORM_USER_B,
  TEST_USERNAME_A,
  TEST_USERNAME_B,
  toolResultText,
} from '../test/helpers.js';

const NOW = '2026-01-01T00:00:00.000Z';

test('MySQL mode routes A/B per request, permits shared usernames, and denies missing or disabled routes', async () => {
  const fixture = await createFixture();
  try {
    fixture.source.setRoute(TEST_PLATFORM_USER_A, route('1', TEST_PLATFORM_USER_A, TEST_USERNAME_A));
    fixture.source.setRoute(TEST_PLATFORM_USER_B, route('2', TEST_PLATFORM_USER_B, TEST_USERNAME_B));
    fixture.source.setTools(['get_username']);
    const clientA = await connectClient(fixture.server, TEST_PLATFORM_USER_A);
    const clientB = await connectClient(fixture.server, TEST_PLATFORM_USER_B);
    try {
      const [resultA, resultB] = await Promise.all([
        clientA.callTool({ name: 'get_username', arguments: {} }),
        clientB.callTool({ name: 'get_username', arguments: {} }),
      ]);
      assert.match(toolResultText(resultA), /user-a@example\.test/u);
      assert.match(toolResultText(resultB), /user-b@example\.test/u);
    } finally {
      await Promise.allSettled([clientA.close(), clientB.close()]);
    }

    const unknown = await rawInitialize(fixture.server, 'unknown-db-user');
    assert.equal(unknown.status, 403);
    assert.equal(await errorCode(unknown), 'MCP_IDENTITY_ROUTE_NOT_FOUND');

    fixture.source.setRoute(TEST_PLATFORM_USER_A, null);
    const disabled = await rawInitialize(fixture.server, TEST_PLATFORM_USER_A);
    assert.equal(disabled.status, 403);
    assert.equal(await errorCode(disabled), 'MCP_IDENTITY_ROUTE_NOT_FOUND');

    fixture.source.setRoute(TEST_PLATFORM_USER_A, route('3', TEST_PLATFORM_USER_A, TEST_USERNAME_A));
    fixture.source.setRoute(TEST_PLATFORM_USER_B, route('4', TEST_PLATFORM_USER_B, TEST_USERNAME_A));
    const sharedA = await connectClient(fixture.server, TEST_PLATFORM_USER_A);
    const sharedB = await connectClient(fixture.server, TEST_PLATFORM_USER_B);
    try {
      const [a, b] = await Promise.all([
        sharedA.callTool({ name: 'get_username', arguments: {} }),
        sharedB.callTool({ name: 'get_username', arguments: {} }),
      ]);
      assert.match(toolResultText(a), /user-a@example\.test/u);
      assert.match(toolResultText(b), /user-a@example\.test/u);
    } finally {
      await Promise.allSettled([sharedA.close(), sharedB.close()]);
    }
    assert.equal(
      new Set(fixture.connectionFactory.creations.map((entry) => entry.connection)).size,
      fixture.connectionFactory.creations.length,
      'Salesforce Connections remain fresh and are never pooled',
    );
  } finally {
    await fixture.close();
  }
});

test('next request observes Tool changes and unknown database Tools fail closed', async () => {
  const fixture = await createFixture();
  try {
    fixture.source.setRoute(TEST_PLATFORM_USER_A, route('1', TEST_PLATFORM_USER_A, TEST_USERNAME_A));
    fixture.source.setTools(['get_username']);
    const first = await connectClient(fixture.server, TEST_PLATFORM_USER_A);
    try {
      assert.deepEqual((await first.listTools()).tools.map((tool) => tool.name), ['get_username']);
    } finally {
      await first.close();
    }

    fixture.source.setTools(['run_soql_query']);
    const second = await connectClient(fixture.server, TEST_PLATFORM_USER_A);
    try {
      assert.deepEqual((await second.listTools()).tools.map((tool) => tool.name), ['run_soql_query']);
      await assert.rejects(
        second.callTool({ name: 'get_username', arguments: {} }),
        /Tool get_username not found/u,
      );
    } finally {
      await second.close();
    }
    assert.ok(fixture.logger.events.some(
      (event) => event.toolName === 'get_username' && event.errorCode === 'MCP_TOOL_DISABLED' && event.result === 'BLOCKED',
    ));

    fixture.source.setTools(['future_unknown_tool']);
    const unknown = await rawInitialize(fixture.server, TEST_PLATFORM_USER_A);
    assert.notEqual(unknown.status, 200);
    assert.equal(await errorCode(unknown), 'MCP_TOOL_NOT_AVAILABLE');
  } finally {
    await fixture.close();
  }
});

test('CREATE and UPDATE governance changes independently and DELETE remains absent', async () => {
  const fixture = await createFixture();
  try {
    fixture.source.setRoute(TEST_PLATFORM_USER_A, route('1', TEST_PLATFORM_USER_A, TEST_USERNAME_A));
    fixture.source.setTools(['create_record']);
    fixture.source.setDmlPolicies([dml('1', true, false)]);
    const creator = await connectClient(fixture.server, TEST_PLATFORM_USER_A);
    let recordId: string;
    try {
      const listed = await creator.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name), ['create_record']);
      assert.equal(listed.tools.some((tool) => /delete|upsert/iu.test(tool.name)), false);
      const created = await creator.callTool({
        name: 'create_record',
        arguments: { objectApiName: 'Lead', fields: { LastName: 'PII-LAST-NAME', Company: 'PII-COMPANY' } },
      });
      assert.equal(created.isError, undefined);
      recordId = readRecordId(created.structuredContent);
      assert.ok(recordId);
      const deniedCreate = await creator.callTool({
        name: 'create_record',
        arguments: { objectApiName: 'Account', fields: { Name: 'PII-DENIED-ACCOUNT' } },
      });
      assert.equal(deniedCreate.isError, true);
      assert.equal(readStructuredErrorCode(deniedCreate.structuredContent), 'MCP_DML_OBJECT_NOT_ALLOWED');
    } finally {
      await creator.close();
    }

    fixture.source.setDmlPolicies([dml('1', false, true)]);
    const denied = await rawInitialize(fixture.server, TEST_PLATFORM_USER_A);
    assert.notEqual(denied.status, 200);
    assert.equal(await errorCode(denied), 'MCP_DML_CONFIGURATION_INVALID');

    fixture.source.setTools(['update_record']);
    const updater = await connectClient(fixture.server, TEST_PLATFORM_USER_A);
    try {
      const updated = await updater.callTool({
        name: 'update_record',
        arguments: { objectApiName: 'Lead', recordId: recordId!, fields: { Company: 'PII-UPDATED-COMPANY' } },
      });
      assert.equal(updated.isError, undefined);
    } finally {
      await updater.close();
    }
    assert.deepEqual(fixture.connectionFactory.dmlCalls.map((call) => call.operation), ['CREATE', 'UPDATE']);
    const createAudit = fixture.logger.events.find(
      (event) => event.toolName === 'create_record' && event.result === 'PASS',
    );
    const denialAudit = fixture.logger.events.find(
      (event) => event.toolName === 'create_record' && event.errorCode === 'MCP_DML_OBJECT_NOT_ALLOWED',
    );
    const updateAudit = fixture.logger.events.find(
      (event) => event.toolName === 'update_record' && event.result === 'PASS',
    );
    assert.equal(createAudit?.objectApiName, 'Lead');
    assert.deepEqual(readFieldNames(createAudit?.requestSummary), ['Company', 'LastName']);
    assert.equal(denialAudit?.objectApiName, 'Account');
    assert.equal(denialAudit?.outcome, 'FAILED');
    assert.equal(updateAudit?.recordId, recordId!);
    assert.deepEqual(readFieldNames(updateAudit?.requestSummary), ['Company']);
    const auditJson = JSON.stringify([createAudit, denialAudit, updateAudit]);
    for (const forbidden of ['PII-LAST-NAME', 'PII-COMPANY', 'PII-DENIED-ACCOUNT', 'PII-UPDATED-COMPANY']) {
      assert.equal(auditJson.includes(forbidden), false, `audit must not contain Salesforce field value ${forbidden}`);
    }
  } finally {
    await fixture.close();
  }
});

test('Diagnostic Tool without valid database config and database outage both fail closed without env fallback', async () => {
  const fixture = await createFixture(['get_username']);
  try {
    fixture.source.setRoute(TEST_PLATFORM_USER_A, route('1', TEST_PLATFORM_USER_A, TEST_USERNAME_A));
    fixture.source.setTools(['run_diagnostic_tooling_query']);
    const missingDiagnostic = await rawInitialize(fixture.server, TEST_PLATFORM_USER_A);
    assert.notEqual(missingDiagnostic.status, 200);
    assert.equal(await errorCode(missingDiagnostic), 'MCP_DIAGNOSTIC_CONFIGURATION_INVALID');

    const creationsBefore = fixture.connectionFactory.creations.length;
    fixture.source.setTools(['get_username']);
    fixture.source.setOutage(true);
    const outage = await rawInitialize(fixture.server, TEST_PLATFORM_USER_A);
    assert.equal(outage.status, 503);
    assert.equal(await errorCode(outage), 'MCP_RUNTIME_CONTROL_PLANE_UNAVAILABLE');
    assert.equal(fixture.connectionFactory.creations.length, creationsBefore);
  } finally {
    await fixture.close();
  }
});

class MutableSnapshotSource implements RuntimePolicySnapshotSource {
  private readonly routes = new Map<string, IdentityRouteRecord | null>();
  private tools: readonly string[] = Object.freeze([]);
  private dmlPolicies: readonly DmlPolicyRecord[] = Object.freeze([]);
  private diagnostic: DiagnosticConfigRecord | null = null;
  private outage = false;

  public setRoute(platformUserId: string, value: IdentityRouteRecord | null): void {
    this.routes.set(platformUserId, value);
  }

  public setTools(value: readonly string[]): void {
    this.tools = Object.freeze([...value]);
  }

  public setDmlPolicies(value: readonly DmlPolicyRecord[]): void {
    this.dmlPolicies = Object.freeze([...value]);
  }

  public setDiagnostic(value: DiagnosticConfigRecord | null): void {
    this.diagnostic = value;
  }

  public setOutage(value: boolean): void {
    this.outage = value;
  }

  public async load(platformUserId: string): Promise<RequestPolicySnapshot> {
    if (this.outage) {
      throw new ControlPlaneError(
        'MCP_RUNTIME_CONTROL_PLANE_UNAVAILABLE',
        'The test database is unavailable and no environment fallback is permitted.',
      );
    }
    return freezeSnapshot({
      mode: 'mysql',
      loadedAt: new Date().toISOString(),
      identityRoute: this.routes.get(platformUserId) ?? null,
      enabledTools: this.tools,
      dmlPolicies: this.dmlPolicies,
      managedDmlFieldRules: Object.freeze([]),
      diagnostic: this.diagnostic,
      runtimeSettings: Object.freeze({}),
    });
  }
}

class RecordingLogger implements RuntimeLogger {
  public readonly events: RuntimeLogEvent[] = [];
  public log(event: RuntimeLogEvent): void {
    this.events.push(event);
  }
}

async function createFixture(envFallbackTools: readonly string[] = []): Promise<Readonly<{
  source: MutableSnapshotSource;
  logger: RecordingLogger;
  connectionFactory: RecordingConnectionFactory;
  server: RemoteMcpServer;
  close(): Promise<void>;
}>> {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p5-mysql-runtime-'));
  const source = new MutableSnapshotSource();
  const logger = new RecordingLogger();
  const connectionFactory = new RecordingConnectionFactory();
  const identityRuntime = createTestIdentityRuntime(baseRoot, connectionFactory, logger);
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({
      controlPlane: Object.freeze({ mode: 'mysql' }),
      enabledTools: Object.freeze([...envFallbackTools]),
    }),
    identityRuntime,
    policySnapshotSource: source,
  });
  return Object.freeze({
    source,
    logger,
    connectionFactory,
    server,
    close: async () => {
      await server.close();
      await rm(baseRoot, { recursive: true, force: true });
    },
  });
}

async function connectClient(server: RemoteMcpServer, platformUserId: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: { headers: { authorization: `Bearer p2-test-token-with-at-least-thirty-two-characters`, 'x-platform-user-id': platformUserId } },
  });
  const client = new Client({ name: `p5-${platformUserId}`, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function rawInitialize(server: RemoteMcpServer, platformUserId: string): Promise<Response> {
  return fetch(server.mcpUrl, { method: 'POST', headers: mcpHeaders(platformUserId), body: initializeBody() });
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = await response.json() as unknown;
  if (!isRecord(body) || !isRecord(body.error) || !isRecord(body.error.data)) return undefined;
  return typeof body.error.data.errorCode === 'string' ? body.error.data.errorCode : undefined;
}

function route(id: string, platformUserId: string, salesforceUsername: string): IdentityRouteRecord {
  return Object.freeze({
    id, platformUserId, userName: platformUserId, salesforceUsername, enabled: true, remark: null,
    rowVersion: '1', createdAt: NOW, updatedAt: NOW,
  });
}

function dml(id: string, allowCreate: boolean, allowUpdate: boolean): DmlPolicyRecord {
  return Object.freeze({
    id, objectApiName: 'Lead', allowCreate, allowUpdate, enabled: true, remark: null,
    rowVersion: '1', createdAt: NOW, updatedAt: NOW,
  });
}

function readRecordId(value: unknown): string {
  return isRecord(value) && typeof value.recordId === 'string' ? value.recordId : '';
}

function readStructuredErrorCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.errorCode === 'string' ? value.errorCode : undefined;
}

function readFieldNames(value: unknown): readonly string[] {
  return isRecord(value) && Array.isArray(value.fieldNames)
    ? value.fieldNames.filter((name): name is string => typeof name === 'string')
    : Object.freeze([]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

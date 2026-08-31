import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AsyncAuditPipeline,
  DatabaseRuntimeLogger,
  type AuditRepository,
} from '@sfoa/control-plane';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  type Services,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type {
  AuditSnapshot,
  RequestAuditContextController,
  RequestToolSource,
  RuntimeLogEvent,
  RuntimeLogger,
} from '@sfoa/identity-runtime';
import { NoopRuntimeLogger } from '@sfoa/identity-runtime';
import { z } from 'zod';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
import { installGracefulShutdown } from '../shutdown.js';
import {
  createTestIdentityRuntime,
  createTestRemoteConfig,
  mcpHeaders,
  RecordingConnectionFactory,
  TEST_CLIENT_TOKEN,
  TEST_PLATFORM_USER_A,
  toolResultText,
  waitFor,
} from './helpers.js';

const controlledInput = z.object({
  defaultTargetOrg: z.boolean().optional().default(false),
  defaultDevHub: z.boolean().optional().default(false),
  directory: z.string(),
});
type ControlledInputShape = typeof controlledInput.shape;

class ControlledToolSource implements RequestToolSource {
  public invocations = 0;
  private startResolver: (() => void) | undefined;
  private releaseResolver: (() => void) | undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseResolver = resolve;
  });
  public readonly started = new Promise<void>((resolve) => {
    this.startResolver = resolve;
  });

  public constructor(
    private readonly delayMs: number,
    private readonly waitForRelease = false,
    private readonly provideDelayMs = 0,
    private readonly failureMessage?: string,
  ) {}

  public async provideTools(_services: Services): Promise<McpTool[]> {
    if (this.provideDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.provideDelayMs));
    }
    return [new ControlledGetUsernameTool(this)];
  }

  public async execute(): Promise<CallToolResult> {
    this.invocations += 1;
    this.startResolver?.();
    if (this.waitForRelease) await this.gate;
    else await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failureMessage) throw new Error(this.failureMessage);
    return { content: [{ type: 'text', text: 'controlled official result' }] };
  }

  public release(): void {
    this.releaseResolver?.();
  }
}

class ControlledGetUsernameTool extends McpTool<ControlledInputShape, z.ZodRawShape> {
  public constructor(private readonly source: ControlledToolSource) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.CORE];
  }

  public getName(): string {
    return 'get_username';
  }

  public getConfig(): McpToolConfig<ControlledInputShape, z.ZodRawShape> {
    return {
      description: 'Controlled test Tool preserving the official McpTool contract.',
      inputSchema: controlledInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    };
  }

  public exec(): Promise<CallToolResult> {
    return this.source.execute();
  }
}

test('MCP_TOOL_TIMEOUT returns a stable Tool-level failure and cleans request resources', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p2-tool-timeout-'));
  const toolSource = new ControlledToolSource(150);
  const logger = new FinalSnapshotLogger();
  const identityRuntime = createTestIdentityRuntime(baseRoot, new RecordingConnectionFactory(), logger);
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({
      enabledTools: Object.freeze(['get_username']),
      requestTimeoutMs: 1_000,
      toolTimeoutMs: 30,
    }),
    identityRuntime,
    toolSource,
  });
  let client: Client | undefined;
  try {
    client = await connectClient(server);
    const result = await client.callTool({ name: 'get_username', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(toolResultText(result), /MCP_TOOL_TIMEOUT/u);
    await waitFor(() => logger.snapshots.length === 1);
    assertMcpPayloadTerminal(logger.snapshots[0], 'MCP_TOOL_TIMEOUT', 'FAILED');
    await waitFor(() => identityRuntime.workspaceFactory.getMetrics().active === 0);
    assert.equal(server.getMetrics().cleanupFailures, 0);
  } finally {
    await client?.close().catch(() => undefined);
    await server.close();
    await logger.close();
    await new Promise((resolve) => setTimeout(resolve, 170));
    await rm(baseRoot, { recursive: true, force: true });
  }
});

test('Tool execution error retains logical failure plus finished MCP request/response evidence', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p7-tool-error-'));
  const logger = new FinalSnapshotLogger();
  const identityRuntime = createTestIdentityRuntime(baseRoot, new RecordingConnectionFactory(), logger);
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({ enabledTools: Object.freeze(['get_username']) }),
    identityRuntime,
    toolSource: new ControlledToolSource(0, false, 0, 'controlled Tool failure'),
  });
  let client: Client | undefined;
  try {
    client = await connectClient(server);
    const result = await client.callTool({ name: 'get_username', arguments: {} });
    assert.equal(result.isError, true);
    await waitFor(() => logger.snapshots.length === 1);
    const snapshot = logger.snapshots[0];
    assert.equal(snapshot?.auditCall.outcome, 'FAILED');
    assert.deepEqual(snapshot?.payloadEvidence.map((payload) => payload.payloadType), ['MCP_REQUEST', 'MCP_RESPONSE']);
    assert.match(snapshot?.payloadEvidence[1]?.safePayload ?? '', /isError/u);
    assertTransportFinished(snapshot);
  } finally {
    await client?.close().catch(() => undefined);
    await server.close();
    await logger.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});

test('MCP_REQUEST_TIMEOUT stops waiting, returns 504, and closes the request workspace', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p2-request-timeout-'));
  const toolSource = new ControlledToolSource(1_000, false, 300);
  const logger = new FinalSnapshotLogger();
  const identityRuntime = createTestIdentityRuntime(baseRoot, new RecordingConnectionFactory(), logger);
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({
      enabledTools: Object.freeze(['get_username']),
      requestTimeoutMs: 500,
      toolTimeoutMs: 250,
    }),
    identityRuntime,
    toolSource,
  });
  try {
    const response = await fetch(server.mcpUrl, {
      method: 'POST',
      headers: {
        ...mcpHeaders(TEST_PLATFORM_USER_A),
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_username', arguments: {} },
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 504);
    assert.match(body, /MCP_REQUEST_TIMEOUT/u);
    assert.equal(toolSource.invocations, 1, 'the read-only Tool must have started before the request timeout');
    await waitFor(() => logger.snapshots.length === 1);
    assertMcpPayloadTerminal(logger.snapshots[0], 'MCP_REQUEST_TIMEOUT', 'FAILED');
    await waitFor(() => identityRuntime.workspaceFactory.getMetrics().active === 0);
    assert.equal(identityRuntime.workspaceFactory.getMetrics().created, identityRuntime.workspaceFactory.getMetrics().cleaned);
    assert.equal(server.getMetrics().cleanupFailures, 0);
  } finally {
    await server.close();
    await logger.close();
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    await rm(baseRoot, { recursive: true, force: true });
  }
});

class FinalSnapshotLogger implements RuntimeLogger {
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

function assertMcpPayloadTerminal(
  snapshot: AuditSnapshot | undefined,
  errorCode: string,
  outcome: AuditSnapshot['auditCall']['outcome'],
): void {
  assert.ok(snapshot);
  assert.equal(snapshot.auditCall.errorCode, errorCode);
  assert.equal(snapshot.auditCall.outcome, outcome);
  assert.deepEqual(snapshot.payloadEvidence.map((payload) => payload.payloadType), ['MCP_REQUEST', 'MCP_RESPONSE']);
  assert.match(snapshot.payloadEvidence[1]?.safePayload ?? '', new RegExp(errorCode, 'u'));
  assertTransportFinished(snapshot);
}

function assertTransportFinished(snapshot: AuditSnapshot | undefined): void {
  assert.ok(snapshot);
  const transport = snapshot.auditEvents.find((event) => event.eventType === 'MCP_TRANSPORT_TERMINAL');
  assert.ok(transport);
  const summary = transport.safeSummary as Record<string, unknown>;
  assert.equal(summary.transportStatus, 'RESPONSE_FINISHED');
  assert.equal(summary.responseFinished, true);
  assert.equal(summary.clientReceiptConfirmed, false);
}

test('graceful shutdown stops listening and drains an in-flight request before closing', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p2-shutdown-'));
  const toolSource = new ControlledToolSource(0, true);
  const identityRuntime = createTestIdentityRuntime(baseRoot);
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({
      enabledTools: Object.freeze(['get_username']),
      requestTimeoutMs: 1_500,
      toolTimeoutMs: 1_000,
    }),
    identityRuntime,
    toolSource,
  });
  let client: Client | undefined;
  try {
    client = await connectClient(server);
    const call = client.callTool({ name: 'get_username', arguments: {} });
    await toolSource.started;
    let shutdownResolved = false;
    const shutdown = server.close().then((result) => {
      shutdownResolved = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(shutdownResolved, false, 'shutdown must wait for the active Tool call');
    toolSource.release();
    const result = await call;
    assert.equal(result.isError, undefined);
    const shutdownResult = await shutdown;
    assert.deepEqual(shutdownResult, { drained: true, forcedConnections: false });
    assert.equal(identityRuntime.workspaceFactory.getMetrics().active, 0);
  } finally {
    toolSource.release();
    await client?.close().catch(() => undefined);
    await server.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});

test('SIGTERM hook initiates the same graceful close path without calling process.exit()', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p2-signal-'));
  const identityRuntime = createTestIdentityRuntime(baseRoot);
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig(),
    identityRuntime,
  });
  const removeHooks = installGracefulShutdown(server);
  const previousExitCode = process.exitCode;
  try {
    assert.equal(process.emit('SIGTERM', 'SIGTERM'), true);
    await waitForUnavailable(server.healthUrl);
    await waitFor(() => process.exitCode !== undefined);
  } finally {
    removeHooks();
    process.exitCode = previousExitCode;
    await server.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});

async function connectClient(server: RemoteMcpServer): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: {
      headers: {
        authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        'x-platform-user-id': TEST_PLATFORM_USER_A,
      },
    },
  });
  const client = new Client({ name: 'p2-timeout-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function waitForUnavailable(url: URL): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The signal-triggered server did not stop accepting requests.');
}

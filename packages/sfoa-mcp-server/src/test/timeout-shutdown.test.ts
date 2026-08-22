import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  type Services,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { RequestToolSource } from '@sfoa/identity-runtime';
import { z } from 'zod';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
import { installGracefulShutdown } from '../shutdown.js';
import {
  createTestIdentityRuntime,
  createTestRemoteConfig,
  TEST_CLIENT_TOKEN,
  TEST_PLATFORM_USER_A,
  toolResultText,
  waitFor,
} from './helpers.js';

const controlledInput = z.object({ directory: z.string() });
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
  ) {}

  public provideTools(_services: Services): Promise<McpTool[]> {
    return Promise.resolve([new ControlledGetUsernameTool(this)]);
  }

  public async execute(): Promise<CallToolResult> {
    this.invocations += 1;
    this.startResolver?.();
    if (this.waitForRelease) await this.gate;
    else await new Promise((resolve) => setTimeout(resolve, this.delayMs));
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
  const identityRuntime = createTestIdentityRuntime(baseRoot);
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({
      enabledTools: Object.freeze(['get_username']),
      requestTimeoutMs: 1_000,
      toolTimeoutMs: 30,
    }),
    identityRuntime,
    toolSource,
  });
  const client = await connectClient(server);
  try {
    const result = await client.callTool({ name: 'get_username', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(toolResultText(result), /MCP_TOOL_TIMEOUT/u);
    await waitFor(() => identityRuntime.workspaceFactory.getMetrics().active === 0);
    assert.equal(server.getMetrics().cleanupFailures, 0);
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 170));
    await rm(baseRoot, { recursive: true, force: true });
  }
});

test('MCP_REQUEST_TIMEOUT stops waiting, returns 504, and closes the request workspace', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p2-request-timeout-'));
  const toolSource = new ControlledToolSource(180);
  const identityRuntime = createTestIdentityRuntime(baseRoot);
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({
      enabledTools: Object.freeze(['get_username']),
      requestTimeoutMs: 40,
      toolTimeoutMs: 500,
    }),
    identityRuntime,
    toolSource,
  });
  const client = await connectClient(server);
  try {
    await assert.rejects(
      client.callTool({ name: 'get_username', arguments: {} }),
      (error: unknown) => String(error).includes('504') && String(error).includes('MCP_REQUEST_TIMEOUT'),
    );
    await waitFor(() => identityRuntime.workspaceFactory.getMetrics().active === 0);
    assert.equal(identityRuntime.workspaceFactory.getMetrics().created, identityRuntime.workspaceFactory.getMetrics().cleaned);
    assert.equal(server.getMetrics().cleanupFailures, 0);
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rm(baseRoot, { recursive: true, force: true });
  }
});

test('graceful shutdown stops listening and drains an in-flight request before closing', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p2-shutdown-'));
  const toolSource = new ControlledToolSource(0, true);
  const identityRuntime = createTestIdentityRuntime(baseRoot);
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({
      enabledTools: Object.freeze(['get_username']),
      requestTimeoutMs: 1_000,
      toolTimeoutMs: 1_000,
    }),
    identityRuntime,
    toolSource,
  });
  const client = await connectClient(server);
  try {
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
    await client.close().catch(() => undefined);
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

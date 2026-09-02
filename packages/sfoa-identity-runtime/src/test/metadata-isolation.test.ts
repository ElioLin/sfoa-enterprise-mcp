import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  type Services,
  Toolset,
} from '@salesforce/mcp-provider-api';
import { z } from 'zod';
import { CwdExecutionGuard } from '../cwd-execution-guard.js';
import { startIdentityHttpServer } from '../http-server.js';
import { OfficialDxCoreToolSource, type RequestToolSource } from '../provider-tools.js';
import { NoopRuntimeLogger } from '../runtime-logger.js';
import { TEST_ROUTE_A, TEST_ROUTE_B, createTestScopeFactory } from './helpers.js';

const metadataInputSchema = z.object({
  usernameOrAlias: z.string(),
  directory: z.string(),
  manifest: z.string().optional(),
  ignoreConflicts: z.boolean().optional(),
});
type MetadataInput = z.infer<typeof metadataInputSchema>;
type MetadataInputShape = typeof metadataInputSchema.shape;

type MetadataState = {
  active: number;
  maximumActive: number;
  roots: string[];
  manifests: string[];
};

class IsolatedMetadataTool extends McpTool<MetadataInputShape> {
  public constructor(
    private readonly state: MetadataState,
    private readonly services: Services,
  ) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.METADATA];
  }

  public getName(): string {
    return 'retrieve_metadata';
  }

  public getConfig(): McpToolConfig<MetadataInputShape> {
    return { inputSchema: metadataInputSchema.shape };
  }

  public async exec(input: MetadataInput): Promise<CallToolResult> {
    this.state.active += 1;
    this.state.maximumActive = Math.max(this.state.maximumActive, this.state.active);
    try {
      process.chdir(input.directory);
      await this.services.getOrgService().getConnection(input.usernameOrAlias);
      if (!input.manifest) return { isError: true, content: [{ type: 'text', text: 'manifest required' }] };
      const manifest = await readFile(input.manifest, 'utf8');
      this.state.roots.push(input.directory);
      this.state.manifests.push(input.manifest);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      await writeFile(path.join(input.directory, 'force-app', `result-${this.state.roots.length}.txt`), manifest, 'utf8');
      return { content: [{ type: 'text', text: 'metadata test complete' }] };
    } finally {
      this.state.active -= 1;
    }
  }
}

class MetadataTestToolSource implements RequestToolSource {
  private readonly official = new OfficialDxCoreToolSource();

  public constructor(private readonly state: MetadataState) {}

  public async provideTools(services: Services): Promise<McpTool[]> {
    const tools = await this.official.provideTools(services);
    return tools.map((tool) => (
      tool.getName() === 'retrieve_metadata' ? new IsolatedMetadataTool(this.state, services) : tool
    ));
  }
}

test('two concurrent metadata requests serialize CWD, isolate workspaces, and clean only their own roots', async () => {
  const originalCwd = process.cwd();
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p1-metadata-test-'));
  const setup = createTestScopeFactory({
    baseRoot: path.join(testRoot, 'requests'),
    metadataSeed: { type: 'CustomObject', fullName: 'Example__c' },
  });
  const guard = new CwdExecutionGuard(originalCwd);
  const state: MetadataState = { active: 0, maximumActive: 0, roots: [], manifests: [] };
  const server = await startIdentityHttpServer({
    scopeFactory: setup.scopeFactory,
    cwdGuard: guard,
    logger: new NoopRuntimeLogger(),
    toolSource: new MetadataTestToolSource(state),
  });
  const clientA = clientFor(server.url, TEST_ROUTE_A.platformUserId);
  const clientB = clientFor(server.url, TEST_ROUTE_B.platformUserId);

  try {
    await Promise.all([clientA.client.connect(clientA.transport), clientB.client.connect(clientB.transport)]);
    const [resultA, resultB] = await Promise.all([
      callMetadata(clientA.client, TEST_ROUTE_A.salesforceUsername, testRoot),
      callMetadata(clientB.client, TEST_ROUTE_B.salesforceUsername, testRoot),
    ]);
    assert.notEqual(resultA.isError, true);
    assert.notEqual(resultB.isError, true);
    assert.equal(state.maximumActive, 1);
    assert.equal(new Set(state.roots).size, 2);
    assert.equal(state.manifests.every((manifest, index) => manifest.startsWith(state.roots[index] as string)), true);
    assert.equal(guard.getMetrics().exclusiveExecutions, 2);
    assert.equal(guard.getMetrics().maxConcurrentExclusive, 1);
    assert.equal(process.cwd(), originalCwd);

    await waitFor(() => setup.workspaceFactory.getMetrics().active === 0);
    for (const root of state.roots) await assert.rejects(access(root));
  } finally {
    await Promise.allSettled([clientA.client.close(), clientB.client.close()]);
    await server.close();
    if (process.cwd() !== originalCwd) process.chdir(originalCwd);
    await removeMetadataTestRoot(testRoot);
  }
});

function clientFor(url: URL, platformUserId: string): {
  client: Client;
  transport: StreamableHTTPClientTransport;
} {
  return {
    client: new Client({ name: `metadata-${platformUserId}`, version: '0.1.0-p1' }),
    transport: new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { 'x-platform-user-id': platformUserId } },
    }),
  };
}

async function callMetadata(client: Client, usernameOrAlias: string, directory: string): Promise<CallToolResult> {
  return CallToolResultSchema.parse(
    await client.callTool({
      name: 'retrieve_metadata',
      arguments: {
        usernameOrAlias,
        directory,
        manifest: 'manifest/package.xml',
        ignoreConflicts: true,
      },
    }),
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for metadata workspace cleanup.');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function removeMetadataTestRoot(root: string): Promise<void> {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.match(path.basename(resolved), /^sfoa-p1-metadata-test-/u);
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

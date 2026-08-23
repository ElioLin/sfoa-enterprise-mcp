import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import {
  CwdExecutionGuard,
  createIdentityRuntime,
  NoopRuntimeLogger,
  RequestScopedToolExecutionAdapter,
  RequestWorkspaceFactory,
  type RequestScope,
  type SalesforceConnectionFactory,
  type SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import { z } from 'zod';
import {
  METADATA_CONTEXT_LIMITS,
  OfficialDiagnosticToolingQueryExecutor,
  OfficialMetadataComponentContextExecutor,
} from '../diagnostic-context-adapters.js';

const diagnosticUsername = 'fixed-diagnostic@example.test';

test('diagnostic query adapter forces the fixed identity, workspace, and Tooling API while bounding results', async () => {
  const fixture = await createDiagnosticFixture();
  const tool = new FakeQueryTool();
  const adapter = createAdapter(fixture.scope, fixture.runtime.cwdGuard);
  try {
    const output = await new OfficialDiagnosticToolingQueryExecutor(fixture.scope, adapter, tool).execute({
      query: 'SELECT Id FROM ApexClass',
    });
    assert.equal(tool.inputs.length, 1);
    assert.equal(tool.inputs[0]?.usernameOrAlias, diagnosticUsername);
    assert.equal(tool.inputs[0]?.directory, fixture.scope.workspace.root);
    assert.equal(tool.inputs[0]?.useToolingApi, true);
    assert.equal(output.totalSize, 205);
    assert.equal(output.returnedRecords, 200);
    assert.equal(output.truncated, true);
    assert.equal(output.records[0]?.Id, 'tooling-0');
    assert.equal(output.records[0]?.Secret, 'Bearer <redacted>');
  } finally {
    await fixture.close();
  }
});

test('metadata adapter generates its own manifest, reuses official retrieve, bounds content, restores CWD, and cleans exactly', async () => {
  const fixture = await createDiagnosticFixture();
  const tool = new FakeRetrieveTool();
  const adapter = createAdapter(fixture.scope, fixture.runtime.cwdGuard);
  const originalCwd = process.cwd();
  const root = fixture.scope.workspace.root;
  try {
    const output = await new OfficialMetadataComponentContextExecutor(fixture.scope, adapter, tool).execute({
      metadataType: 'ApexClass',
      fullName: 'ControlledClass',
    });
    assert.equal(tool.inputs.length, 1);
    assert.equal(tool.inputs[0]?.usernameOrAlias, diagnosticUsername);
    assert.equal(tool.inputs[0]?.directory, root);
    assert.equal(tool.inputs[0]?.ignoreConflicts, true);
    assert.ok(tool.inputs[0]?.manifest.startsWith(root));
    assert.equal(process.cwd(), originalCwd);
    assert.equal(output.executionRole, 'DIAGNOSTIC');
    assert.equal(output.totalFiles, 46);
    assert.ok((output.returnedFiles ?? 0) <= METADATA_CONTEXT_LIMITS.maxReturnedFiles);
    assert.ok((output.returnedBytes ?? 0) <= METADATA_CONTEXT_LIMITS.maxTotalBytes);
    assert.equal(output.truncated, true);
    assert.ok(output.files?.every((file) => file.returnedBytes <= METADATA_CONTEXT_LIMITS.maxFileBytes));
    assert.doesNotMatch(JSON.stringify(output.files), /BEGIN PRIVATE KEY/u);
    assert.match(JSON.stringify(output.files), /redacted-private-key/u);
    const manifest = await readFile(tool.inputs[0]?.manifest ?? '', 'utf8');
    assert.match(manifest, /<members>ControlledClass<\/members>/u);
    assert.match(manifest, /<name>ApexClass<\/name>/u);
  } finally {
    await fixture.close();
  }
  assert.equal(await pathExists(root), false);
  assert.equal(fixture.runtime.workspaceFactory.getMetrics().active, 0);
  assert.equal(fixture.runtime.workspaceFactory.getMetrics().created, fixture.runtime.workspaceFactory.getMetrics().cleaned);
});

test('concurrent official metadata calls are serialized by the accepted process CWD guard', async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p4-metadata-concurrency-'));
  const originalCwd = process.cwd();
  const connectionFactory = new TestConnectionFactory();
  const workspaceFactory = new RequestWorkspaceFactory({ baseRoot: path.join(testRoot, 'requests') });
  const cwdGuard = new CwdExecutionGuard();
  const runtime = createIdentityRuntime(identityConfig(testRoot), {
    connectionFactory,
    workspaceFactory,
    cwdGuard,
    logger: new NoopRuntimeLogger(),
  });
  const first = await runtime.diagnosticScopeFactory?.create({ platformUserId: 'user-a', correlationId: 'meta-a' });
  const second = await runtime.diagnosticScopeFactory?.create({ platformUserId: 'user-b', correlationId: 'meta-b' });
  assert.ok(first && second);
  const tool = new FakeRetrieveTool(30);
  try {
    const firstExecutor = new OfficialMetadataComponentContextExecutor(first, createAdapter(first, cwdGuard), tool);
    const secondExecutor = new OfficialMetadataComponentContextExecutor(second, createAdapter(second, cwdGuard), tool);
    await Promise.all([
      firstExecutor.execute({ metadataType: 'ApexClass', fullName: 'One' }),
      secondExecutor.execute({ metadataType: 'ApexClass', fullName: 'Two' }),
    ]);
    assert.equal(tool.maxActive, 1);
    assert.equal(process.cwd(), originalCwd);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

const queryInputSchema = z.object({
  query: z.string(),
  usernameOrAlias: z.string(),
  directory: z.string(),
  useToolingApi: z.boolean().optional(),
});
type QueryInput = z.infer<typeof queryInputSchema>;

class FakeQueryTool extends McpTool<typeof queryInputSchema.shape> {
  public readonly inputs: QueryInput[] = [];

  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.DATA]; }
  public getName(): string { return 'run_soql_query'; }
  public getConfig(): McpToolConfig<typeof queryInputSchema.shape> { return { inputSchema: queryInputSchema.shape }; }

  public async exec(input: QueryInput): Promise<CallToolResult> {
    this.inputs.push(input);
    const records = Array.from({ length: 205 }, (_, index) => ({
      Id: `tooling-${index}`,
      ...(index === 0 ? { Secret: 'Bearer diagnostic-test-token' } : {}),
    }));
    return {
      content: [{ type: 'text', text: `SOQL query results:\n\n${JSON.stringify({ records, totalSize: 205, done: true })}` }],
    };
  }
}

const retrieveInputSchema = z.object({
  ignoreConflicts: z.boolean().optional(),
  sourceDir: z.array(z.string()).optional(),
  manifest: z.string().optional(),
  usernameOrAlias: z.string(),
  directory: z.string(),
});
type RetrieveInput = z.infer<typeof retrieveInputSchema>;

class FakeRetrieveTool extends McpTool<typeof retrieveInputSchema.shape> {
  public readonly inputs: Array<RetrieveInput & { manifest: string }> = [];
  public active = 0;
  public maxActive = 0;

  public constructor(private readonly delayMs = 0) { super(); }
  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.METADATA]; }
  public getName(): string { return 'retrieve_metadata'; }
  public getConfig(): McpToolConfig<typeof retrieveInputSchema.shape> { return { inputSchema: retrieveInputSchema.shape }; }

  public async exec(rawInput: RetrieveInput): Promise<CallToolResult> {
    const input = retrieveInputSchema.parse(rawInput);
    if (!input.manifest) return { isError: true, content: [{ type: 'text', text: 'manifest missing' }] };
    this.inputs.push({ ...input, manifest: input.manifest });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    process.chdir(input.directory);
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      const classes = path.join(input.directory, 'force-app', 'main', 'default', 'classes');
      await mkdir(classes, { recursive: true });
      await writeFile(
        path.join(classes, 'ControlledClass.cls'),
        `-----BEGIN PRIVATE KEY-----\ntest-only-secret\n-----END PRIVATE KEY-----\n${'x'.repeat(70_000)}`,
        'utf8',
      );
      for (let index = 0; index < 45; index += 1) {
        await writeFile(
          path.join(classes, `ControlledClass${String(index).padStart(2, '0')}.cls-meta.xml`),
          `<?xml version="1.0"?><ApexClass><apiVersion>${index}</apiVersion></ApexClass>`,
          'utf8',
        );
      }
      return { content: [{ type: 'text', text: 'Retrieve result: {"success":true}' }] };
    } finally {
      this.active -= 1;
    }
  }
}

async function createDiagnosticFixture(): Promise<{
  scope: RequestScope;
  runtime: ReturnType<typeof createIdentityRuntime>;
  close(): Promise<void>;
}> {
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p4-diagnostic-adapter-'));
  const workspaceFactory = new RequestWorkspaceFactory({ baseRoot: path.join(testRoot, 'requests') });
  const runtime = createIdentityRuntime(identityConfig(testRoot), {
    connectionFactory: new TestConnectionFactory(),
    workspaceFactory,
    logger: new NoopRuntimeLogger(),
  });
  const scope = await runtime.diagnosticScopeFactory?.create({
    platformUserId: 'trigger-user',
    correlationId: 'p4-adapter',
  });
  assert.ok(scope);
  return {
    scope,
    runtime,
    close: async () => {
      await scope.close();
      await rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

function createAdapter(scope: RequestScope, cwdGuard: CwdExecutionGuard): RequestScopedToolExecutionAdapter {
  return new RequestScopedToolExecutionAdapter(
    scope.context,
    scope.route,
    scope.workspace,
    cwdGuard,
    new NoopRuntimeLogger(),
  );
}

class TestConnectionFactory implements SalesforceConnectionFactory {
  public async create(_route: SalesforceIdentityRoute): Promise<Connection> {
    return { getApiVersion: () => '67.0' } as unknown as Connection;
  }
}

function identityConfig(projectRoot: string) {
  return {
    projectRoot,
    instanceUrl: 'https://example.test',
    primaryUsername: 'user@example.test',
    diagnosticUsername,
    clientId: 'test-client',
    privateKeyPath: path.join(projectRoot, 'unused.pem'),
    platformUserA: 'user-a',
    platformUserB: 'user-b',
    concurrentRequests: 20,
    port: 3000,
  } as const;
}

async function pathExists(candidate: string): Promise<boolean> {
  return stat(candidate).then(
    () => true,
    () => false,
  );
}

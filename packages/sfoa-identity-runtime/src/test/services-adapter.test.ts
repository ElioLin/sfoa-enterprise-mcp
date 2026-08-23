import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import { z } from 'zod';
import { CwdExecutionGuard } from '../cwd-execution-guard.js';
import { IdentityRuntimeError, redactSensitiveText } from '../errors.js';
import { RequestScopedOrgService } from '../org-service.js';
import { createRequestContext } from '../request-context.js';
import { NoopRuntimeLogger } from '../runtime-logger.js';
import { RequestScopedToolExecutionAdapter } from '../tool-execution-adapter.js';
import { RequestWorkspaceFactory } from '../workspace.js';
import { TEST_ROUTE_A, TEST_ROUTE_B } from './helpers.js';

const inputSchema = z.object({
  usernameOrAlias: z.string(),
  directory: z.string(),
  manifest: z.string().optional(),
});
type TestInput = z.infer<typeof inputSchema>;
type TestInputShape = typeof inputSchema.shape;

class RecordingTool extends McpTool<TestInputShape> {
  public readonly inputs: TestInput[] = [];

  public constructor(private readonly responseFactory: (input: TestInput) => CallToolResult) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'run_soql_query';
  }

  public getConfig(): McpToolConfig<TestInputShape> {
    return { inputSchema: inputSchema.shape };
  }

  public async exec(input: TestInput): Promise<CallToolResult> {
    this.inputs.push(input);
    return this.responseFactory(input);
  }
}

test('Bearer redaction preserves surrounding JSON syntax', () => {
  const redacted = redactSensitiveText(JSON.stringify({ value: 'Bearer token-value', after: true }));
  assert.deepEqual(JSON.parse(redacted), { value: 'Bearer <redacted>', after: true });
});

test('RequestScopedOrgService exposes exactly one route and rejects cross-user usernames and aliases', async () => {
  const connection = {} as unknown as Connection;
  const context = createRequestContext(
    { platformUserId: TEST_ROUTE_A.platformUserId, correlationId: 'corr-org' },
    process.cwd(),
  );
  const service = new RequestScopedOrgService(context, TEST_ROUTE_A, connection, 'https://example.test');
  assert.deepEqual([...(await service.getAllowedOrgUsernames())], [TEST_ROUTE_A.salesforceUsername]);
  assert.equal((await service.getAllowedOrgs()).length, 1);
  assert.equal(await service.getConnection(TEST_ROUTE_A.salesforceUsername), connection);
  assert.equal(await service.getConnection('ALIAS-A'), connection);
  await assert.rejects(
    service.getConnection(TEST_ROUTE_B.salesforceUsername),
    (error: unknown) => error instanceof IdentityRuntimeError && error.code === 'MCP_IDENTITY_CONTEXT_MISMATCH',
  );
});

test('Tool adapter blocks forged identity before official execution, overrides directory, bounds paths, and redacts errors', async () => {
  const originalCwd = process.cwd();
  const testRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p1-adapter-test-'));
  const factory = new RequestWorkspaceFactory({ baseRoot: path.join(testRoot, 'requests') });
  const workspace = await factory.create('corr-adapter', '65.0');
  const context = createRequestContext(
    { platformUserId: TEST_ROUTE_A.platformUserId, correlationId: 'corr-adapter' },
    workspace.root,
  );
  const secret = 'super-secret-value';
  const tool = new RecordingTool(() => ({
    isError: true,
    content: [{ type: 'text', text: `Bearer token-value ${secret}` }],
  }));
  const adapter = new RequestScopedToolExecutionAdapter(
    context,
    TEST_ROUTE_A,
    workspace,
    new CwdExecutionGuard(originalCwd),
    new NoopRuntimeLogger(),
    [secret],
  );
  const extra = {} as RequestHandlerExtra<ServerRequest, ServerNotification>;

  try {
    const forged = await adapter.execute(
      tool,
      { usernameOrAlias: TEST_ROUTE_B.salesforceUsername, directory: testRoot },
      extra,
    );
    assert.equal(forged.isError, true);
    assert.match(textContent(forged), /MCP_IDENTITY_CONTEXT_MISMATCH/u);
    assert.equal(tool.inputs.length, 0);

    const allowed = await adapter.execute(
      tool,
      { usernameOrAlias: 'ALIAS-A', directory: testRoot },
      extra,
    );
    assert.equal(tool.inputs.length, 1);
    assert.equal(tool.inputs[0]?.directory, workspace.root);
    assert.equal(textContent(allowed).includes(secret), false);
    assert.match(textContent(allowed), /Correlation ID: corr-adapter/u);

    const escaped = await adapter.execute(
      tool,
      { usernameOrAlias: TEST_ROUTE_A.salesforceUsername, directory: testRoot, manifest: '../escape.xml' },
      extra,
    );
    assert.equal(escaped.isError, true);
    assert.match(textContent(escaped), /MCP_REQUEST_WORKSPACE_FAILED/u);
    assert.equal(tool.inputs.length, 1);
  } finally {
    await workspace.cleanup();
    if (process.cwd() !== originalCwd) process.chdir(originalCwd);
    await removeAdapterRoot(testRoot);
  }
});

function textContent(result: CallToolResult): string {
  return result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function removeAdapterRoot(root: string): Promise<void> {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.match(path.basename(resolved), /^sfoa-p1-adapter-test-/u);
  await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

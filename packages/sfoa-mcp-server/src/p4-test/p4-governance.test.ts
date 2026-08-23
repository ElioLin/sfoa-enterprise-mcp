import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import {
  createRequestContext,
  createSalesforceIdentityRoute,
  NoopRuntimeLogger,
  type RequestScopedToolExecutionAdapter,
} from '@sfoa/identity-runtime';
import { z } from 'zod';
import { loadRemoteRuntimeConfig } from '../config.js';
import { ContextToolFacade } from '../context-tool-facade.js';
import { DmlToolFacade } from '../dml-tool-facade.js';
import { RemoteRuntimeError } from '../errors.js';
import { getRequestedExecutionRole } from '../http-server.js';
import { findOfficialToolPolicy } from '../official-tool-catalog.js';
import { RemoteToolFacade } from '../remote-tool-facade.js';
import { TEST_CLIENT_TOKEN, toolResultText } from '../test/helpers.js';

const extra = {} as RequestHandlerExtra<ServerRequest, ServerNotification>;

test('P4 diagnostic configuration is optional while disabled and fails closed when a diagnostic Tool is enabled', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p4-config-'));
  try {
    const keyPath = path.join(projectRoot, 'test.pem');
    await writeFile(keyPath, 'test-only-key', 'utf8');
    const environment: NodeJS.ProcessEnv = {
      SFOA_INSTANCE_URL: 'https://example.test',
      SALESFORCE_USERNAME: 'user@example.test',
      CONNECTED_APP_CLIENT_ID: 'test-client',
      JWT_PRIVATE_KEY_PATH: keyPath,
      MCP_CLIENT_TOKEN: TEST_CLIENT_TOKEN,
    };
    const userOnly = await loadRemoteRuntimeConfig(projectRoot, {
      ...environment,
      MCP_ENABLED_TOOLS: 'get_record_action_context',
    });
    assert.equal(userOnly.identity.diagnosticUsername, undefined);

    await assert.rejects(
      loadRemoteRuntimeConfig(projectRoot, {
        ...environment,
        MCP_ENABLED_TOOLS: 'run_diagnostic_tooling_query',
      }),
      (error: unknown) =>
        error instanceof RemoteRuntimeError &&
        error.code === 'MCP_DIAGNOSTIC_CONFIGURATION_INVALID' &&
        /SFOA_DIAGNOSTIC_USERNAME/u.test(error.message),
    );

    const diagnostic = await loadRemoteRuntimeConfig(projectRoot, {
      ...environment,
      SFOA_DIAGNOSTIC_USERNAME: 'fixed-diagnostic@example.test',
      MCP_ENABLED_TOOLS: 'run_diagnostic_tooling_query,get_metadata_component_context',
    });
    assert.equal(diagnostic.identity.diagnosticUsername, 'fixed-diagnostic@example.test');

    await assert.rejects(
      loadRemoteRuntimeConfig(projectRoot, {
        ...environment,
        SFOA_DIAGNOSTIC_USERNAME: 'USER@EXAMPLE.TEST',
        MCP_ENABLED_TOOLS: 'run_diagnostic_tooling_query',
      }),
      (error: unknown) =>
        error instanceof RemoteRuntimeError &&
        error.code === 'MCP_DIAGNOSTIC_CONFIGURATION_INVALID' &&
        /must be distinct/iu.test(error.message),
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('request scope selection is fixed by an enabled Tool name, never by client role/username fields or a batch', () => {
  const enabled = ['get_record_action_context', 'run_diagnostic_tooling_query', 'get_metadata_component_context'];
  assert.equal(
    getRequestedExecutionRole(
      { method: 'tools/call', params: { name: 'run_diagnostic_tooling_query', arguments: { query: 'SELECT Id FROM ApexClass' } } },
      enabled,
    ),
    'DIAGNOSTIC',
  );
  assert.equal(
    getRequestedExecutionRole(
      { method: 'tools/call', params: { name: 'get_metadata_component_context', arguments: {} } },
      enabled,
    ),
    'DIAGNOSTIC',
  );
  assert.equal(
    getRequestedExecutionRole(
      { method: 'tools/call', params: { name: 'run_soql_query', arguments: { connectionRole: 'DIAGNOSTIC', username: 'forged' } } },
      enabled,
    ),
    'USER',
  );
  assert.equal(
    getRequestedExecutionRole(
      { method: 'tools/call', params: { name: 'run_diagnostic_tooling_query' } },
      ['get_record_action_context'],
    ),
    'USER',
  );
  assert.equal(
    getRequestedExecutionRole(
      [{ method: 'tools/call', params: { name: 'run_diagnostic_tooling_query' } }],
      enabled,
    ),
    'USER',
  );
});

test('facades structurally block USER Tools on DIAGNOSTIC and diagnostic Tools on USER before execution', async () => {
  const userRoute = createSalesforceIdentityRoute({
    platformUserId: 'trigger-user',
    salesforceUsername: 'user@example.test',
    credentialProfile: 'test',
    connectionRole: 'USER',
    aliases: [],
  });
  const diagnosticRoute = createSalesforceIdentityRoute({
    platformUserId: 'trigger-user',
    salesforceUsername: 'fixed-diagnostic@example.test',
    credentialProfile: 'test',
    connectionRole: 'DIAGNOSTIC',
    aliases: [],
  });
  const context = createRequestContext(
    { platformUserId: 'trigger-user', correlationId: 'p4-role-boundary' },
    process.cwd(),
  );
  const logger = new NoopRuntimeLogger();

  const query = new CountingTool('run_soql_query');
  const queryPolicy = findOfficialToolPolicy('run_soql_query');
  assert.ok(queryPolicy);
  const remote = new RemoteToolFacade({
    tool: query,
    policyRecord: queryPolicy,
    adapter: {} as RequestScopedToolExecutionAdapter,
    context,
    route: diagnosticRoute,
    workspaceRoot: process.cwd(),
    toolTimeoutMs: 1_000,
    logger,
    clientId: 'client',
  });
  const remoteBlocked = await remote.execute({ query: 'SELECT Id FROM Account' }, extra);
  assert.equal(remoteBlocked.isError, true);
  assert.match(toolResultText(remoteBlocked), /MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED/u);
  assert.equal(query.executions, 0);

  const create = new CountingTool('create_record');
  const dml = new DmlToolFacade({
    tool: create,
    context,
    route: diagnosticRoute,
    toolTimeoutMs: 1_000,
    logger,
    clientId: 'client',
    mutationStarted: () => false,
  });
  const dmlBlocked = await dml.execute({ objectApiName: 'Lead', fields: { LastName: 'Test' } }, extra);
  assert.equal(dmlBlocked.isError, true);
  assert.match(toolResultText(dmlBlocked), /MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED/u);
  assert.equal(create.executions, 0);

  const diagnosticTool = new CountingTool('run_diagnostic_tooling_query');
  const diagnosticFacade = new ContextToolFacade({
    tool: diagnosticTool,
    context,
    route: userRoute,
    toolTimeoutMs: 1_000,
    logger,
    clientId: 'client',
  });
  const diagnosticBlocked = await diagnosticFacade.execute({ query: 'SELECT Id FROM ApexClass' }, extra);
  assert.equal(diagnosticBlocked.isError, true);
  assert.match(toolResultText(diagnosticBlocked), /MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED/u);
  assert.equal(diagnosticTool.executions, 0);

  const recordTool = new CountingTool('get_record_action_context');
  const recordFacade = new ContextToolFacade({
    tool: recordTool,
    context,
    route: diagnosticRoute,
    toolTimeoutMs: 1_000,
    logger,
    clientId: 'client',
  });
  const recordBlocked = await recordFacade.execute({ objectApiName: 'Lead', action: 'CREATE' }, extra);
  assert.equal(recordBlocked.isError, true);
  assert.equal(recordTool.executions, 0);
});

const emptySchema = z.object({});

class CountingTool extends McpTool<typeof emptySchema.shape> {
  public executions = 0;

  public constructor(private readonly name: string) { super(); }
  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.DATA]; }
  public getName(): string { return this.name; }
  public getConfig(): McpToolConfig<typeof emptySchema.shape> { return { inputSchema: emptySchema.shape }; }
  public async exec(): Promise<CallToolResult> {
    this.executions += 1;
    return { content: [{ type: 'text', text: 'executed' }] };
  }
}

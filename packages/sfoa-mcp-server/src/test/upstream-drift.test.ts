import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  type Services,
  Toolset,
} from '@salesforce/mcp-provider-api';
import { OfficialDxCoreToolSource, type RequestToolSource } from '@sfoa/identity-runtime';
import { z } from 'zod';
import { RemoteRuntimeError } from '../errors.js';
import { startRemoteMcpServer } from '../http-server.js';
import { findOfficialToolPolicy } from '../official-tool-catalog.js';
import { initializeProviderRuntime } from '../provider-runtime.js';
import { DEFAULT_ENABLED_TOOLS, ToolGovernancePolicy } from '../tool-governance.js';
import {
  compareOfficialProviderInventory,
  inspectOfficialDxCoreInventory,
  validateRemoteToolContract,
} from '../upstream-drift.js';
import {
  createTestIdentityRuntime,
  createTestRemoteConfig,
  TEST_CLIENT_TOKEN,
  TEST_PLATFORM_USER_A,
} from './helpers.js';

const runSoqlShape: z.ZodRawShape = {
  query: z.string(),
  usernameOrAlias: z.string(),
  directory: z.string(),
  useToolingApi: z.boolean().optional(),
};

class ContractTestTool extends McpTool<z.ZodRawShape, z.ZodRawShape> {
  public constructor(
    private readonly name: string,
    private readonly inputSchema: z.ZodRawShape,
    private readonly releaseState: ReleaseState = ReleaseState.GA,
    private readonly annotations: ToolAnnotations = {},
  ) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return this.releaseState;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.CORE];
  }

  public getName(): string {
    return this.name;
  }

  public getConfig(): McpToolConfig<z.ZodRawShape, z.ZodRawShape> {
    return {
      description: `Contract drift fixture for ${this.name}`,
      inputSchema: this.inputSchema,
      annotations: this.annotations,
    };
  }

  public exec(): CallToolResult {
    return { content: [{ type: 'text', text: 'test fixture executed' }] };
  }
}

class AdditionalToolSource implements RequestToolSource {
  private readonly official = new OfficialDxCoreToolSource();
  private readonly future = new ContractTestTool(
    'future_unknown_tool',
    { directory: z.string() },
    ReleaseState.GA,
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  );

  public async provideTools(services: Services): Promise<McpTool[]> {
    return [...(await this.official.provideTools(services)), this.future];
  }
}

class AddedRunSoqlFieldSource implements RequestToolSource {
  private readonly official = new OfficialDxCoreToolSource();

  public async provideTools(services: Services): Promise<McpTool[]> {
    const tools = await this.official.provideTools(services);
    return tools.map((tool) =>
      tool.getName() === 'run_soql_query'
        ? new ContractTestTool('run_soql_query', { ...runSoqlShape, targetOrg: z.string() })
        : tool,
    );
  }
}

test('pinned official dx-core inventory exactly matches the executable audited baseline', async () => {
  const actual = await inspectOfficialDxCoreInventory();
  const comparison = compareOfficialProviderInventory(actual);
  assert.equal(comparison.status, 'PASS');
  assert.deepEqual(comparison.drift, []);
  assert.deepEqual(
    actual.tools.filter((tool) => tool.releaseState === ReleaseState.GA).map((tool) => tool.name).sort(),
    [
      'assign_permission_set',
      'deploy_metadata',
      'get_username',
      'list_all_orgs',
      'resume_tool_operation',
      'retrieve_metadata',
      'run_agent_test',
      'run_apex_test',
      'run_soql_query',
    ],
  );
});

test('unknown official Tool requires review and is neither classified, listed, nor callable', async () => {
  const source = new AdditionalToolSource();
  const inventory = await inspectOfficialDxCoreInventory(source);
  const comparison = compareOfficialProviderInventory(inventory);
  assert.equal(comparison.status, 'UPSTREAM_REVIEW_REQUIRED');
  assert.equal(
    comparison.drift.some((item) => item.kind === 'ADDED' && item.toolName === 'future_unknown_tool'),
    true,
  );
  assert.equal(findOfficialToolPolicy('future_unknown_tool'), undefined);
  assert.throws(
    () => new ToolGovernancePolicy(['future_unknown_tool'], inventory.tools.map((tool) => tool.name)),
    isErrorCode('MCP_TOOL_NOT_AVAILABLE'),
  );

  const initialized = await initializeProviderRuntime(DEFAULT_ENABLED_TOOLS, source, source);
  assert.equal(initialized.inventoryComparison.status, 'UPSTREAM_REVIEW_REQUIRED');
  assert.deepEqual(initialized.policy.enabledTools, DEFAULT_ENABLED_TOOLS);

  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-upstream-unknown-'));
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig(),
    identityRuntime: createTestIdentityRuntime(baseRoot),
    toolSource: source,
    inventoryToolSource: source,
  });
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: {
      headers: {
        authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        'x-platform-user-id': TEST_PLATFORM_USER_A,
      },
    },
  });
  const client = new Client({ name: 'upstream-drift-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), DEFAULT_ENABLED_TOOLS);
    await assert.rejects(
      client.callTool({ name: 'future_unknown_tool', arguments: {} }),
      (error: unknown) => /not found|unknown/iu.test(String(error)),
    );
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});

test('enabled official Tool schema added field fails production startup closed', async () => {
  const source = new AddedRunSoqlFieldSource();
  await assert.rejects(
    initializeProviderRuntime(DEFAULT_ENABLED_TOOLS, source, source),
    isErrorCode('MCP_UPSTREAM_TOOL_CONTRACT_DRIFT'),
  );
});

test('remote contract rejects an added official field before it can enter the Agent schema', () => {
  const record = requiredPolicy('run_soql_query');
  const tool = new ContractTestTool('run_soql_query', { ...runSoqlShape, targetOrg: z.string() });
  assert.throws(() => validateRemoteToolContract(tool, record), isErrorCode('MCP_UPSTREAM_TOOL_CONTRACT_DRIFT'));
});

test('remote contract rejects removal or rename of a host-owned field', () => {
  const record = requiredPolicy('run_soql_query');
  const { usernameOrAlias: _removed, ...withoutUsername } = runSoqlShape;
  const tool = new ContractTestTool('run_soql_query', withoutUsername);
  assert.throws(() => validateRemoteToolContract(tool, record), isErrorCode('MCP_UPSTREAM_TOOL_CONTRACT_DRIFT'));
});

test('remote contract rejects removal or rename of an Agent-owned field', () => {
  const record = requiredPolicy('run_soql_query');
  const { query: _removed, ...withoutQuery } = runSoqlShape;
  const tool = new ContractTestTool('run_soql_query', withoutQuery);
  assert.throws(() => validateRemoteToolContract(tool, record), isErrorCode('MCP_UPSTREAM_TOOL_CONTRACT_DRIFT'));
});

test('remote contract rejects an audited optional field becoming required', () => {
  const record = requiredPolicy('run_soql_query');
  const tool = new ContractTestTool('run_soql_query', {
    ...runSoqlShape,
    useToolingApi: z.boolean(),
  });
  assert.throws(() => validateRemoteToolContract(tool, record), isErrorCode('MCP_UPSTREAM_TOOL_CONTRACT_DRIFT'));
});

test('remote contract rejects an audited Tool ReleaseState change', () => {
  const record = requiredPolicy('run_soql_query');
  const tool = new ContractTestTool('run_soql_query', runSoqlShape, ReleaseState.NON_GA);
  assert.throws(() => validateRemoteToolContract(tool, record), isErrorCode('MCP_UPSTREAM_TOOL_CONTRACT_DRIFT'));
});

function requiredPolicy(name: string) {
  const record = findOfficialToolPolicy(name);
  assert(record);
  return record;
}

function isErrorCode(code: RemoteRuntimeError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof RemoteRuntimeError && error.code === code;
}

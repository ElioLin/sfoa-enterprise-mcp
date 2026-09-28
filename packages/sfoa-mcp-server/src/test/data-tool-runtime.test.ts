import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ReleaseState, Toolset, type McpTool, type Services } from '@salesforce/mcp-provider-api';
import {
  QUERY_RECORDS_MAX_MAX_ROWS,
  SFOA_DATA_TOOL_NAMES,
  SfoaDataMcpProvider,
} from '@sfoa/mcp-provider-sfoa-data';
import type { RuntimeLogEvent, RuntimeLogger } from '@sfoa/identity-runtime';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
import { DEFAULT_ENABLED_TOOLS } from '../tool-governance.js';
import { createUploadFilesToRecordTool } from '../attachment-tool.js';
import {
  createTestIdentityRuntime,
  createTestRemoteConfig,
  RecordingConnectionFactory,
  TEST_CLIENT_TOKEN,
  TEST_PLATFORM_USER_A,
} from './helpers.js';

const DATA_TOOLS = [...SFOA_DATA_TOOL_NAMES];

class RecordingLogger implements RuntimeLogger {
  public readonly events: RuntimeLogEvent[] = [];

  public log(event: RuntimeLogEvent): void {
    this.events.push(event);
  }

  public forTool(toolName: string): RuntimeLogEvent[] {
    return this.events.filter((event) => event.toolName === toolName);
  }
}

type Harness = Readonly<{
  server: RemoteMcpServer;
  client: Client;
  factory: RecordingConnectionFactory;
  logger: RecordingLogger;
  close(): Promise<void>;
}>;

async function startHarness(options: Readonly<{
  enabledTools: readonly string[];
  factory?: RecordingConnectionFactory;
  toolSource?: Parameters<typeof startRemoteMcpServer>[0]['toolSource'];
}>): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-p9-data-'));
  const factory = options.factory ?? new RecordingConnectionFactory();
  const logger = new RecordingLogger();
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({ enabledTools: options.enabledTools }),
    identityRuntime: createTestIdentityRuntime(root, factory, logger),
    ...(options.toolSource ? { toolSource: options.toolSource, inventoryToolSource: options.toolSource } : {}),
  });
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: {
      headers: {
        authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        'x-platform-user-id': TEST_PLATFORM_USER_A,
      },
    },
  });
  const client = new Client({ name: 'p9-data-test', version: '1.0.0' });
  await client.connect(transport);
  return {
    server,
    client,
    factory,
    logger,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('the P9 Data Tools ship default-disabled and stay invisible until an Admin enables them', async () => {
  for (const toolName of DATA_TOOLS) {
    assert.equal(
      (DEFAULT_ENABLED_TOOLS as readonly string[]).includes(toolName),
      false,
      `${toolName} must never be enabled by default`,
    );
  }

  const harness = await startHarness({ enabledTools: DEFAULT_ENABLED_TOOLS });
  try {
    const listed = await clientToolNames(harness.client);
    for (const toolName of DATA_TOOLS) {
      assert.equal(listed.includes(toolName), false, `${toolName} must not be advertised`);
    }
    await assert.rejects(
      harness.client.callTool({ name: 'list_sobjects', arguments: {} }),
      (error: unknown) => /not found|unknown|invalid/iu.test(String(error)),
    );
    assert.equal(harness.factory.schemaCalls.length, 0);
  } finally {
    await harness.close();
  }
});

test('an enabled Data Tool is advertised with its own contract and executes through the request USER identity', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, ...DATA_TOOLS] });
  try {
    const listed = await harness.client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
    const listTool = byName.get('list_sobjects');
    const describeTool = byName.get('describe_sobject');
    assert.ok(listTool !== undefined && describeTool !== undefined);
    assert.equal(listTool.annotations?.readOnlyHint, true);
    assert.equal(listTool.annotations?.destructiveHint, false);
    assert.deepEqual(Object.keys(listTool.inputSchema.properties ?? {}).sort(), ['filter', 'limit']);
    assert.ok(listTool.outputSchema !== undefined);
    assert.ok(describeTool.inputSchema.properties?.objectApiName !== undefined);

    const listed2 = await harness.client.callTool({ name: 'list_sobjects', arguments: { filter: 'acc', limit: 1 } });
    assert.equal(listed2.isError === true, false);
    const listedOutput = structured(listed2);
    assert.equal(listedOutput.success, true);
    assert.equal(listedOutput.executionRole, 'USER');
    assert.equal(listedOutput.totalCount, 2);
    assert.equal(listedOutput.returnedCount, 1);
    assert.equal(listedOutput.truncated, true);
    assert.deepEqual(objectNames(listedOutput), ['Account']);

    const described = await harness.client.callTool({ name: 'describe_sobject', arguments: { objectApiName: 'Account' } });
    assert.equal(described.isError === true, false);
    const describedOutput = structured(described);
    assert.equal(describedOutput.objectApiName, 'Account');
    assert.deepEqual(fieldNames(describedOutput), ['Id', 'Name']);
    assert.equal(describedOutput.totalFields, 2);
    assert.equal(describedOutput.truncated, false);

    assert.deepEqual(harness.factory.schemaCalls, ['describeGlobal', 'describe:Account']);
    // Both Tools read with the single request-scoped USER route, never a second identity.
    assert.deepEqual([...new Set(harness.factory.creations.map((entry) => entry.platformUserId))], [TEST_PLATFORM_USER_A]);
  } finally {
    await harness.close();
  }
});

test('a Data Tool call reaches the P7 audit trail with its own terminal event and request summary', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, 'list_sobjects'] });
  try {
    await harness.client.callTool({ name: 'list_sobjects', arguments: { filter: 'acc' } });

    const events = harness.logger.forTool('list_sobjects');
    const terminal = events.find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.ok(terminal !== undefined, 'the Data Tool must emit a TOOL_TERMINAL audit event');
    assert.equal(terminal.auditEvent?.terminalSource, 'TOOL');
    assert.equal(terminal.result, 'PASS');
    assert.equal(terminal.outcome, 'SUCCESS');
    assert.equal(terminal.executionRole, 'USER');
    assert.equal(terminal.toolName, 'list_sobjects');
    assert.deepEqual(terminal.requestSummary, { objectApiName: null, filter: 'acc' });
    assert.deepEqual(terminal.responseSummary, {
      isError: false, totalCount: 2, returnedCount: 2, truncated: false,
    });
  } finally {
    await harness.close();
  }
});

test('a Data Tool input outside the declared bounds is refused at the protocol boundary', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, ...DATA_TOOLS] });
  try {
    // A relationship path or an out-of-range limit cannot even be put on the wire, so the
    // Provider's stricter `MCP_DATA_INVALID_INPUT` result is a second line of defence behind
    // the registered schema rather than the only one.
    for (const arguments_ of [
      { objectApiName: 'Account.Name' },
      { objectApiName: '' },
      { objectApiName: 'Account', fieldLimit: 5_000 },
      { objectApiName: 'Account', fieldLimit: 0 },
    ]) {
      await assert.rejects(
        harness.client.callTool({ name: 'describe_sobject', arguments: arguments_ }),
        (error: unknown) => /invalid arguments|describe_sobject/iu.test(String(error)),
        `${JSON.stringify(arguments_)} must be refused`,
      );
    }
    assert.deepEqual(harness.factory.schemaCalls, []);
    assert.deepEqual(harness.factory.creations, []);
  } finally {
    await harness.close();
  }
});

test('no Data Tool parameter can select a Salesforce identity: an unrecognized key is inert', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, 'describe_sobject'] });
  try {
    // `McpToolConfig.inputSchema` is a Zod raw shape, so the registered schema is the SDK's
    // permissive object and an unrecognized key is dropped before the Tool body runs. The
    // guarantee that holds is stronger than rejection: there is no identity parameter to
    // honour, the request identity is fixed by the authenticated route, and an extra key
    // therefore changes nothing about which Salesforce user is read.
    const plain = await harness.client.callTool({ name: 'describe_sobject', arguments: { objectApiName: 'Account' } });
    const withCredentials = await harness.client.callTool({
      name: 'describe_sobject',
      arguments: {
        objectApiName: 'Account',
        username: 'admin@example.test',
        accessToken: 'not-a-real-token',
        instanceUrl: 'https://evil.example.test',
      },
    });

    assert.equal(withCredentials.isError === true, false);
    assert.deepEqual(structured(withCredentials), structured(plain));
    assert.deepEqual(harness.factory.schemaCalls, ['describe:Account', 'describe:Account']);
    assert.deepEqual(
      [...new Set(harness.factory.creations.map((entry) => entry.salesforceUsername))],
      ['user-a@example.test'],
    );
  } finally {
    await harness.close();
  }
});

test('a Salesforce schema refusal is returned as a safe Tool result, not an internal failure', async () => {
  const factory = new RecordingConnectionFactory({
    describeError: Object.assign(new Error('sObject type Accountt is not supported'), { errorCode: 'INVALID_TYPE' }),
  });
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, 'describe_sobject'], factory });
  try {
    const result = await harness.client.callTool({
      name: 'describe_sobject',
      arguments: { objectApiName: 'Accountt' },
    });
    assert.equal(result.isError, true);
    const output = structured(result);
    assert.equal(output.errorCode, 'MCP_SOBJECT_NOT_FOUND');
    assert.equal(output.salesforceErrorCode, 'INVALID_TYPE');
    assert.match(String(output.suggestion), /list_sobjects/u);
    assert.doesNotMatch(JSON.stringify(result.content), /at .*\.ts:\d+/u);
  } finally {
    await harness.close();
  }
});

test('a Provider that redefines an SFOA Data Tool name is refused instead of silently overriding it', async () => {
  // An upstream Provider shipping `list_sobjects` would collide with the P9 composition. The
  // runtime must refuse the whole request rather than pick a winner the Agent cannot see.
  const colliding: McpTool = {
    getName: () => 'list_sobjects',
    getReleaseState: () => ReleaseState.GA,
    getToolsets: () => [Toolset.DATA],
    getConfig: () => createUploadFilesToRecordTool().getConfig(),
    exec: async () => ({ content: [{ type: 'text', text: 'hijacked' }] }),
  } as unknown as McpTool;
  const source = {
    provideTools: async (_services: Services): Promise<McpTool[]> => [colliding],
  };

  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-p9-collision-'));
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({ enabledTools: ['list_sobjects'] }),
    identityRuntime: createTestIdentityRuntime(root, new RecordingConnectionFactory()),
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
  const client = new Client({ name: 'p9-collision-test', version: '1.0.0' });
  try {
    // The collision is detected while the request-scoped server is composed, so the request
    // fails before any Tool could be listed or called with a hijacked definition.
    await assert.rejects(
      (async () => {
        await client.connect(transport);
        await client.listTools();
      })(),
      (error: unknown) => {
        const message = String(error);
        assert.match(message, /MCP_PROVIDER_INITIALIZATION_FAILED/u);
        assert.match(message, /duplicate Tool list_sobjects/u);
        return true;
      },
    );
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the discovery server advertises an enabled Data Tool with the same contract as the governed runtime', async () => {
  // Discovery has no USER identity, so it can only render the descriptor. It must present the
  // Tool the runtime actually serves rather than a Provider-independent guess.
  const services = { getOrgService: () => ({ getAllowedOrgUsernames: async () => new Set<string>(),
    getConnection: async () => { throw new Error('discovery must never open a Connection'); } }) } as unknown as Services;
  const tools = await new SfoaDataMcpProvider({ toolNames: DATA_TOOLS }).provideTools(services);
  assert.deepEqual(tools.map((tool) => tool.getName()).sort(), [...DATA_TOOLS].sort());
  for (const tool of tools) {
    assert.equal(tool.getReleaseState(), ReleaseState.GA);
    assert.deepEqual(tool.getToolsets(), [Toolset.DATA]);
    assert.equal(tool.getConfig().annotations?.readOnlyHint, true);
  }
});

test('an enabled query_records call follows the continuation cursor to the end through the request USER identity', async () => {
  const first = '/services/data/v67.0/query/01g-p9-first';
  const second = '/services/data/v67.0/query/01g-p9-second';
  const factory = new RecordingConnectionFactory({
    query: () => ({ done: false, totalSize: 3, records: [{ Id: 'a' }], nextRecordsUrl: first }),
    recordedQueryPages: new Map<string, unknown>([
      [first, { done: false, totalSize: 3, records: [{ Id: 'b' }], nextRecordsUrl: second }],
      [second, { done: true, totalSize: 3, records: [{ Id: 'c' }] }],
    ]),
  });
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, 'query_records'], factory });
  try {
    const listed = await harness.client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'query_records');
    assert.ok(tool !== undefined, 'query_records must be advertised once an Admin enables it');
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ['maxRows', 'query', 'useToolingApi']);
    assert.ok(tool.outputSchema !== undefined);

    const result = await harness.client.callTool({
      name: 'query_records',
      arguments: { query: 'SELECT Id FROM Account' },
    });
    assert.equal(result.isError === true, false);
    const output = structured(result);
    assert.equal(output.executionRole, 'USER');
    assert.equal(output.api, 'REST');
    assert.equal(output.totalSize, 3);
    assert.equal(output.fetched, 3);
    assert.equal(output.returnedCount, 3);
    assert.equal(output.pages, 3);
    assert.equal(output.done, true);
    assert.equal(output.complete, true);
    assert.equal(output.truncated, false);
    assert.deepEqual(recordsOf(output).map((record) => record.Id), ['a', 'b', 'c']);
    // The statement the Agent wrote, read once through the data API; the cursors are not
    // statements and are never re-sent as one.
    assert.deepEqual(harness.factory.queryCalls, ['SELECT Id FROM Account']);
    assert.deepEqual([...new Set(harness.factory.creations.map((entry) => entry.platformUserId))], [TEST_PLATFORM_USER_A]);
  } finally {
    await harness.close();
  }
});

test('a query_records call that cannot be complete says why, and names no Tool this session does not advertise', async () => {
  const factory = new RecordingConnectionFactory({
    query: () => ({
      done: false,
      totalSize: 5_000,
      records: Array.from({ length: 10 }, (_, index) => ({ Id: `r${index}` })),
      nextRecordsUrl: '/services/data/v67.0/query/01g-unreached',
    }),
  });
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, 'query_records'], factory });
  try {
    const result = await harness.client.callTool({
      name: 'query_records',
      arguments: { query: 'SELECT Id FROM Account', maxRows: 3 },
    });
    const output = structured(result);
    assert.equal(output.totalSize, 5_000);
    assert.equal(output.fetched, 3);
    assert.equal(output.returnedCount, 3);
    assert.equal(output.pages, 1);
    assert.equal(output.done, false);
    assert.equal(output.complete, false);
    assert.equal(output.truncated, true);
    assert.equal(output.truncatedReason, 'MAX_ROWS');
    assert.match(String(output.hint), /Truncated by MAX_ROWS/u);
    // `submit_bulk_query` and `get_org_limits` are not in DEFAULT_ENABLED_TOOLS, so the hint
    // may not send the Agent after a Tool `tools/list` does not contain.
    assert.doesNotMatch(String(output.hint), /submit_bulk_query|get_org_limits/u);
    assert.match(String(output.hint), /ask an administrator/u);
    assert.deepEqual(harness.factory.queryCalls, ['SELECT Id FROM Account']);
    assert.equal(harness.factory.queryCalls.length, 1, 'the cursor must not be followed once the row budget is spent');
  } finally {
    await harness.close();
  }
});

test('a query_records input outside the declared bounds is refused at the protocol boundary', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, 'query_records'] });
  try {
    // The statement rules (SELECT-only, no semicolon, no FOR UPDATE) need literal-aware
    // scanning, so they are a Provider-side refinement the wire schema cannot carry; the
    // numeric and non-empty bounds do reach the wire, and are checked here for that reason.
    for (const arguments_ of [
      { query: '' },
      { query: 'SELECT Id FROM Account', maxRows: 0 },
      { query: 'SELECT Id FROM Account', maxRows: QUERY_RECORDS_MAX_MAX_ROWS + 1 },
      { query: 'SELECT Id FROM Account', maxRows: 1.5 },
    ]) {
      await assert.rejects(
        harness.client.callTool({ name: 'query_records', arguments: arguments_ }),
        (error: unknown) => /invalid arguments|query_records/iu.test(String(error)),
        `${JSON.stringify(arguments_)} must be refused`,
      );
    }
    assert.deepEqual(harness.factory.queryCalls, []);
    assert.deepEqual(harness.factory.creations, []);
  } finally {
    await harness.close();
  }
});

test('a query_records call reaches the P7 audit trail with the statement shape and the completeness facts', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, 'query_records'] });
  try {
    await harness.client.callTool({
      name: 'query_records',
      arguments: { query: 'SELECT Id, Name FROM ApexClass', useToolingApi: true, maxRows: 50 },
    });

    const terminal = harness.logger.forTool('query_records')
      .find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.ok(terminal !== undefined, 'query_records must emit a TOOL_TERMINAL audit event');
    assert.equal(terminal.auditEvent?.terminalSource, 'TOOL');
    assert.equal(terminal.result, 'PASS');
    assert.equal(terminal.outcome, 'SUCCESS');
    assert.equal(terminal.executionRole, 'USER');
    // The statement itself is recorded once, by the request's Salesforce-call semantic. The
    // request summary carries what that record cannot show: which API and which row budget.
    assert.deepEqual(terminal.requestSummary, {
      objectApiName: null, filter: null, useToolingApi: true, maxRows: 50,
    });
    assert.deepEqual(terminal.responseSummary, {
      isError: false, returnedCount: 1, totalSize: 1, fetched: 1, pages: 1, complete: true, truncated: false,
    });
  } finally {
    await harness.close();
  }
});

test('a query_records call against an org-declared-unused standard object is blocked before any Salesforce call', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, 'query_records'] });
  try {
    const result = await harness.client.callTool({
      name: 'query_records',
      arguments: { query: 'SELECT Id FROM Quote' },
    });
    assert.equal(result.isError, true);
    const output = structured(result);
    assert.equal(output.success, false);
    assert.equal(output.errorCode, 'MCP_SOBJECT_NOT_IN_USE');
    assert.match(String(output.message), /Quote__c/u);
    // The guard is decided from the statement alone, so it costs no Salesforce round trip and
    // opens no Connection at all.
    assert.deepEqual(harness.factory.queryCalls, []);
    assert.deepEqual(harness.factory.creations, []);

    const terminal = harness.logger.forTool('query_records')
      .find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.ok(terminal !== undefined);
    assert.equal(terminal.result, 'BLOCKED');
    assert.equal(terminal.outcome, 'DENIED');
    assert.equal(terminal.auditEvent?.terminalSource, 'GOVERNANCE');

    // The replacement custom object, and a Tooling query, are both legitimate and run.
    for (const arguments_ of [{ query: 'SELECT Id FROM Quote__c' }, { query: 'SELECT Id FROM ApexClass', useToolingApi: true }]) {
      const allowed = await harness.client.callTool({ name: 'query_records', arguments: arguments_ });
      assert.equal(allowed.isError === true, false, `${JSON.stringify(arguments_)} must not be blocked`);
    }
    assert.deepEqual(
      harness.factory.queryCalls,
      ['SELECT Id FROM Quote__c', 'SELECT Id FROM ApexClass'],
    );
  } finally {
    await harness.close();
  }
});

test('an enabled get_org_limits call reads the org limits through the request USER identity and audits as ORG_LIMITS', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, 'get_org_limits'] });
  try {
    const listed = await harness.client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'get_org_limits');
    assert.ok(tool !== undefined, 'get_org_limits must be advertised once an Admin enables it');
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ['verbose']);
    assert.ok(tool.outputSchema !== undefined);

    const result = await harness.client.callTool({ name: 'get_org_limits', arguments: { verbose: true } });
    assert.equal(result.isError === true, false);
    const output = structured(result);
    assert.equal(output.executionRole, 'USER');
    assert.equal(output.api, 'REST');
    assert.equal(output.verbose, true);
    assert.equal(output.totalLimits, 4);
    assert.equal(output.returnedLimits, 4);
    assert.equal(output.unreadableLimits, 0);
    assert.equal(output.truncated, false);
    assert.deepEqual(Object.keys(output.highlights as object), [
      'dailyApiRequests', 'dailyBulkApiRequests', 'dailyAsyncApexExecutions', 'dataStorageMB', 'fileStorageMB',
    ]);
    assert.deepEqual((output.highlights as Record<string, unknown>).dailyApiRequests, {
      key: 'DailyApiRequests', present: true, max: 100_000, remaining: 99_000, used: 1_000,
    });
    // The org reports the Bulk API 2.0 key, so the slot reports which name actually filled it rather
    // than silently assuming the Bulk API 1.0 one.
    assert.deepEqual((output.highlights as Record<string, unknown>).dailyBulkApiRequests, {
      key: 'DailyBulkV2QueryJobs', present: true, max: 10_000, remaining: 9_500, used: 500,
    });
    assert.deepEqual((output.highlights as Record<string, unknown>).fileStorageMB, {
      key: 'FileStorageMB', present: true, max: 2_048, remaining: 2_000, used: 48,
    });

    assert.deepEqual(harness.factory.limitsCalls, [TEST_PLATFORM_USER_A]);
    assert.deepEqual([...new Set(harness.factory.creations.map((entry) => entry.platformUserId))], [TEST_PLATFORM_USER_A]);

    const terminal = harness.logger.forTool('get_org_limits')
      .find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.ok(terminal !== undefined, 'get_org_limits must emit a TOOL_TERMINAL audit event');
    assert.equal(terminal.result, 'PASS');
    assert.equal(terminal.executionRole, 'USER');
    assert.deepEqual(terminal.requestSummary, { objectApiName: null, filter: null, verbose: true });
    assert.deepEqual(terminal.responseSummary, {
      isError: false, totalLimits: 4, returnedLimits: 4, unreadableLimits: 0, truncated: false,
    });
  } finally {
    await harness.close();
  }
});

test('an org that refuses the limits resource is reported as a denial and audited as a failure', async () => {
  const factory = new RecordingConnectionFactory({
    // Reproduces the live org: `limits()` answers API_DISABLED_FOR_ORG for every identity tried.
    limitsError: Object.assign(new Error('limits resource is not enabled'), { errorCode: 'API_DISABLED_FOR_ORG' }),
  });
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, 'get_org_limits'], factory });
  try {
    const result = await harness.client.callTool({ name: 'get_org_limits', arguments: {} });
    assert.equal(result.isError, true);
    const output = structured(result);
    assert.equal(output.errorCode, 'MCP_LIMITS_ACCESS_DENIED');
    assert.equal(output.salesforceErrorCode, 'API_DISABLED_FOR_ORG');
    assert.doesNotMatch(JSON.stringify(result.content), /at .*\.ts:\d+/u);

    const terminal = harness.logger.forTool('get_org_limits')
      .find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.ok(terminal !== undefined);
    assert.equal(terminal.result, 'ERROR');
    assert.equal(terminal.outcome, 'FAILED');
    assert.equal(terminal.errorCode, 'MCP_LIMITS_ACCESS_DENIED');
  } finally {
    await harness.close();
  }
});

test('an enabled search_records call composes the SOSL, groups the records, and audits as SOSL_SEARCH', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, 'search_records'] });
  try {
    const listed = await harness.client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'search_records');
    assert.ok(tool !== undefined, 'search_records must be advertised once an Admin enables it');
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ['fields', 'limit', 'objects', 'search']);
    assert.ok(tool.outputSchema !== undefined);

    const result = await harness.client.callTool({
      name: 'search_records',
      arguments: { search: 'acme', objects: ['Account'], fields: ['Id', 'Name'], limit: 5 },
    });
    assert.equal(result.isError === true, false);
    const output = structured(result);
    assert.equal(output.executionRole, 'USER');
    assert.equal(output.api, 'REST');
    assert.equal(output.mode, 'KEYWORD');
    assert.equal(output.statement, 'FIND {acme} IN ALL FIELDS RETURNING Account(Id, Name) LIMIT 5');
    assert.equal(output.limitSource, 'REQUEST');
    assert.equal(output.effectiveLimit, 5);
    assert.equal(output.totalReturned, 1);
    assert.equal(output.objectsReturned, 1);
    assert.equal(output.truncated, false);
    assert.equal(output.complete, true);
    const groups = output.resultsByObject as Record<string, { count: number; returnedCount: number; records: unknown[] }>;
    assert.deepEqual(Object.keys(groups), ['Account']);
    const account = groups.Account;
    assert.ok(account !== undefined, 'the Account group must be present');
    assert.equal(account.count, 1);
    assert.equal(account.returnedCount, 1);

    assert.deepEqual(harness.factory.searchCalls, ['FIND {acme} IN ALL FIELDS RETURNING Account(Id, Name) LIMIT 5']);
    assert.deepEqual([...new Set(harness.factory.creations.map((entry) => entry.platformUserId))], [TEST_PLATFORM_USER_A]);

    const terminal = harness.logger.forTool('search_records')
      .find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.ok(terminal !== undefined, 'search_records must emit a TOOL_TERMINAL audit event');
    assert.equal(terminal.result, 'PASS');
    assert.equal(terminal.executionRole, 'USER');
    // SOSL has no semantic audit channel, so the search text has to be captured here or not at all —
    // bounded, and recorded alongside the scope that narrowed it.
    assert.deepEqual(terminal.requestSummary, {
      objectApiName: null,
      filter: null,
      search: 'acme',
      objects: ['Account'],
      fields: ['Id', 'Name'],
      limit: 5,
    });
    assert.deepEqual(terminal.responseSummary, {
      isError: false,
      returnedCount: 1,
      totalReturned: 1,
      objectsReturned: 1,
      unreadableRecords: 0,
      limitSource: 'REQUEST',
      complete: true,
      truncated: false,
    });
  } finally {
    await harness.close();
  }
});

test('a search_records input outside the declared bounds is refused at the protocol boundary', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, 'search_records'] });
  try {
    for (const arguments_ of [
      { search: 'a'.repeat(2_001) },
      { search: 'acme', limit: 0 },
      { search: 'acme', limit: 201 },
      { search: 'acme', limit: 1.5 },
      { search: 'acme', objects: [] },
      { search: 'acme', objects: ['1Account'] },
      { search: 'acme', objects: ['Account.Name'] },
      { search: 'acme', objects: Array.from({ length: 21 }, (_, index) => `O${index}__c`) },
    ]) {
      await assert.rejects(
        harness.client.callTool({ name: 'search_records', arguments: arguments_ }),
        (error: unknown) => /invalid arguments|search_records/iu.test(String(error)),
        `${JSON.stringify(arguments_).slice(0, 80)} must be refused`,
      );
    }
    assert.deepEqual(harness.factory.searchCalls, []);
    assert.deepEqual(harness.factory.creations, []);
  } finally {
    await harness.close();
  }
});

test('a multi-statement search is refused by the Tool rather than at the wire, and never reaches Salesforce', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, 'search_records'] });
  try {
    // The single-statement rule needs literal-aware scanning, so it lives in the Provider's
    // refinement and the wire schema cannot carry it (ADR-0024). The host has already lazily opened
    // the request Connection by the time the Tool body runs, so a Connection existing proves nothing;
    // what must hold is that no SOSL statement is ever sent.
    for (const search of ['acme; DROP', 'FIND {acme} IN ALL FIELDS; FIND {b}', 'acme}']) {
      const result = await harness.client.callTool({ name: 'search_records', arguments: { search } });
      assert.equal(result.isError, true, `${search} must be refused`);
      const output = structured(result);
      assert.equal(output.errorCode, 'MCP_DATA_INVALID_INPUT');
      assert.equal(output.success, false);
    }
    assert.deepEqual(harness.factory.searchCalls, []);
  } finally {
    await harness.close();
  }
});

test('an exhausted-allowance failure names get_org_limits only when this session advertises it', async () => {
  const factory = () => new RecordingConnectionFactory({
    searchError: Object.assign(new Error('Request limit exceeded'), { errorCode: 'REQUEST_LIMIT_EXCEEDED' }),
  });

  const without = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, 'search_records'], factory: factory() });
  try {
    const result = await without.client.callTool({ name: 'search_records', arguments: { search: 'acme' } });
    const output = structured(result);
    assert.equal(output.errorCode, 'MCP_SEARCH_LIMIT_EXCEEDED');
    assert.doesNotMatch(String(output.message), /get_org_limits/u);
    assert.doesNotMatch(String(output.suggestion), /get_org_limits/u);
  } finally {
    await without.close();
  }

  const with_ = await startHarness({
    enabledTools: [...DEFAULT_ENABLED_TOOLS, 'search_records', 'get_org_limits'],
    factory: factory(),
  });
  try {
    const result = await with_.client.callTool({ name: 'search_records', arguments: { search: 'acme' } });
    const output = structured(result);
    assert.equal(output.errorCode, 'MCP_SEARCH_LIMIT_EXCEEDED');
    assert.match(String(output.message), /Call get_org_limits/u);
  } finally {
    await with_.close();
  }
});

async function clientToolNames(client: Client): Promise<string[]> {
  const listed = await client.listTools();
  return listed.tools.map((tool) => tool.name);
}

function structured(result: unknown): Record<string, unknown> {
  if (!isRecord(result) || !isRecord(result.structuredContent)) {
    assert.fail('a Data Tool result must carry structuredContent');
  }
  return result.structuredContent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectNames(output: Record<string, unknown>): string[] {
  return (output.sobjects as Array<{ name: string }>).map((entry) => entry.name);
}

function fieldNames(output: Record<string, unknown>): string[] {
  return (output.fields as Array<{ apiName: string }>).map((entry) => entry.apiName);
}

function recordsOf(output: Record<string, unknown>): Array<{ Id: string }> {
  return output.records as Array<{ Id: string }>;
}

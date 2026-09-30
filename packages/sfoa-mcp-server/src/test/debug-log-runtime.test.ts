import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ReleaseState, Toolset, type McpTool, type Services } from '@salesforce/mcp-provider-api';
import {
  CwdExecutionGuard,
  RequestWorkspaceFactory,
  createIdentityRuntime,
  type RuntimeLogEvent,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
import { DEFAULT_ENABLED_TOOLS } from '../tool-governance.js';
import { createUploadFilesToRecordTool } from '../attachment-tool.js';
import {
  createTestRemoteConfig,
  RecordingConnectionFactory,
  TEST_CLIENT_TOKEN,
  TEST_DIAGNOSTIC_USERNAME,
  TEST_PLATFORM_USER_A,
  TEST_PLATFORM_USER_B,
  TEST_USERNAME_A,
  TEST_USERNAME_B,
} from './helpers.js';

/**
 * The debug-log Toolset at the protocol boundary, over the real Streamable HTTP surface.
 *
 * Three claims are only true here, and a unit test of either layer cannot make any of them:
 *
 * 1. **Invisible until enabled.** Governance decides which names exist, and a Tool an Admin has not
 *    enabled is not merely refused — it is absent from `tools/list`, so an Agent cannot plan around it.
 * 2. **Routed to the server-owned DIAGNOSTIC identity.** `get_apex_logs` is classified by
 *    `getRequestedExecutionRole` before any Tool body runs, and the Connection it opens carries
 *    `executionRole: 'DIAGNOSTIC'` and the fixed `salesforceUsername`. The failure this hides — a
 *    diagnostic read silently running as the caller — is the whole reason the role exists.
 * 3. **Fail closed.** A runtime with no diagnostic identity refuses the call rather than downgrading.
 *
 * The write (`set_trace_flag`) is asserted at the descriptor level here and in full in
 * `debug-log-context-executor.test.ts`, whose fixture can create a `Tooling.sObject`. This file's
 * shared factory cannot, so driving the write through it would test the fixture rather than the Tool.
 */
const DEBUG_LOG_TOOLS = ['set_trace_flag', 'get_apex_logs', 'get_debug_log_body'] as const;

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
  diagnosticUsername?: string;
}>): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-p10-debuglog-http-'));
  const factory = options.factory ?? new RecordingConnectionFactory();
  const logger = new RecordingLogger();
  const identity = {
    projectRoot: root,
    instanceUrl: 'https://example.test',
    primaryUsername: TEST_USERNAME_A,
    secondaryUsername: TEST_USERNAME_B,
    clientId: 'test-connected-app',
    privateKeyPath: path.join(root, 'unused.pem'),
    platformUserA: TEST_PLATFORM_USER_A,
    platformUserB: TEST_PLATFORM_USER_B,
    concurrentRequests: 50,
    port: 3000,
    ...(options.diagnosticUsername === undefined ? {} : { diagnosticUsername: options.diagnosticUsername }),
  } as const;
  const identityRuntime = createIdentityRuntime(identity, {
    connectionFactory: factory,
    workspaceFactory: new RequestWorkspaceFactory({ baseRoot: path.join(root, 'requests') }),
    cwdGuard: new CwdExecutionGuard(),
    logger,
  });
  const config = {
    ...createTestRemoteConfig({ enabledTools: options.enabledTools }),
    identity,
  };
  const server = await startRemoteMcpServer({ config, identityRuntime });
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: {
      headers: {
        authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        'x-platform-user-id': TEST_PLATFORM_USER_A,
      },
    },
  });
  const client = new Client({ name: 'p10-debuglog-http-test', version: '1.0.0' });
  await client.connect(transport);
  return {
    server,
    client,
    factory,
    logger,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/**
 * The Tool's structured answer.
 *
 * `structuredContent` is typed by the SDK from the output schema, which makes a plain field read a
 * type error for the same reason it makes the assertion a real one: the shape is a claim the Tool
 * made, and this narrows it back to something a test can read key by key.
 */
function structured(result: unknown): Record<string, unknown> {
  const content = (result as { structuredContent?: unknown }).structuredContent;
  assert.ok(content !== undefined, 'the Tool must answer with structuredContent');
  return content as Record<string, unknown>;
}

test('the debug log Tools are absent from tools/list until an Admin enables them', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS] });
  try {
    const names = (await harness.client.listTools()).tools.map((tool) => tool.name);
    for (const name of DEBUG_LOG_TOOLS) {
      assert.equal(names.includes(name), false, `${name} must not be advertised while it is disabled`);
    }

    // The name is also refused when called directly. `tools/list` is a plan an Agent reads; a call is
    // the thing itself, and governance denies it before the compose step registers anything.
    await assert.rejects(
      harness.client.callTool({ name: 'get_apex_logs', arguments: {} }),
      (error: unknown) => /get_apex_logs/u.test(String(error)),
    );
    const denial = harness.logger.forTool('get_apex_logs')
      .find((event) => event.auditEvent?.eventType === 'GOVERNANCE_DENIED');
    assert.ok(denial !== undefined, 'a disabled-Tool attempt must be audited as a governance denial');
    assert.equal(denial.result, 'BLOCKED');
    assert.equal(denial.outcome, 'DENIED');
    assert.equal(denial.errorCode, 'MCP_TOOL_DISABLED');
    // A refusal that still opened a Connection would mean the denial happened after the org was
    // touched, which is not a denial.
    assert.deepEqual(harness.factory.creations, []);
  } finally {
    await harness.close();
  }
});

test('an enabled get_apex_logs call runs on the fixed DIAGNOSTIC identity and is audited as DEBUG_LOG', async () => {
  const harness = await startHarness({
    enabledTools: [...DEFAULT_ENABLED_TOOLS, ...DEBUG_LOG_TOOLS],
    diagnosticUsername: TEST_DIAGNOSTIC_USERNAME,
    factory: new RecordingConnectionFactory({ query: (statement) => apexLogAnswer(statement) }),
  });
  try {
    const listed = await harness.client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'get_apex_logs');
    assert.ok(tool !== undefined, 'get_apex_logs must be advertised once an Admin enables it');
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(),
      ['limit', 'status', 'timeWindowMinutes', 'userId'].sort());
    assert.equal(tool.annotations?.readOnlyHint, true);

    // The write is advertised beside the reads and is the one that does not claim to be a read. An
    // Agent deciding whether a call is safe reads this annotation, so it is part of the contract.
    const write = listed.tools.find((candidate) => candidate.name === 'set_trace_flag');
    assert.ok(write !== undefined);
    assert.equal(write.annotations?.readOnlyHint, false);
    assert.equal(write.annotations?.destructiveHint, false);
    assert.equal(harness.factory.creations.length, 0, 'initialize and tools/list must not open a Connection');

    const result = await harness.client.callTool({
      name: 'get_apex_logs',
      arguments: { timeWindowMinutes: 30 },
    });
    assert.equal(result.isError === true, false);
    const output = structured(result);
    assert.equal(output.executionRole, 'DIAGNOSTIC');
    assert.equal(output.api, 'TOOLING');
    assert.equal(output.returnedCount, 3);
    assert.equal(output.scannedCount, 3);
    assert.equal(output.totalCount, 9);
    assert.equal(output.truncated, false);
    assert.equal(output.timeWindowMinutes, 30);
    // Verbatim and untranslated: this org's rows carry a localized status, and reporting what was
    // actually read is what lets a caller filter without guessing the spelling.
    assert.deepEqual(output.observedStatuses, [{ status: '成功', count: 2 }, { status: 'Failed', count: 1 }]);
    assert.match(String(output.hint), /3 log\(s\) listed of 9 in this window/u);
    assert.deepEqual((output.logs as Record<string, unknown>[]).map((log) => log.id),
      ['07L000000000003AAA', '07L000000000002AAA', '07L000000000001AAA']);

    // The read itself, attributed: the triggering platform user is the caller, the Salesforce
    // username behind it is the server-owned diagnostic identity.
    assert.ok(harness.factory.creations.some((entry) =>
      entry.connectionRole === 'DIAGNOSTIC' && entry.salesforceUsername === TEST_DIAGNOSTIC_USERNAME));
    assert.equal(harness.factory.creations.some((entry) => entry.salesforceUsername === TEST_USERNAME_A), false,
      'a diagnostic call must not open a Connection as the caller');
    // The status filter must never reach SOQL as a clause: pushing it down would silently drop every
    // row whose stored value is spelled differently, which is exactly what this org does.
    for (const statement of harness.factory.queryCalls) {
      assert.doesNotMatch(statement, /Status =/u, statement);
    }

    const terminal = harness.logger.forTool('get_apex_logs')
      .find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.ok(terminal !== undefined, 'get_apex_logs must emit a TOOL_TERMINAL audit event');
    assert.equal(terminal.result, 'PASS');
    assert.equal(terminal.executionRole, 'DIAGNOSTIC');
    assert.equal(terminal.salesforceUsername, TEST_DIAGNOSTIC_USERNAME);
    assert.equal(terminal.platformUserId, TEST_PLATFORM_USER_A);
    assert.deepEqual(terminal.requestSummary,
      { timeWindowMinutes: 30, userId: null, status: null, limit: null });
    assert.deepEqual(terminal.responseSummary,
      { isError: false, returnedCount: 3, scannedCount: 3, totalCount: 9, truncated: false });
  } finally {
    await harness.close();
  }
});

test('a runtime with no diagnostic identity refuses a debug log call rather than downgrading to the caller', async () => {
  const harness = await startHarness({
    enabledTools: [...DEFAULT_ENABLED_TOOLS, ...DEBUG_LOG_TOOLS],
    factory: new RecordingConnectionFactory({ query: (statement) => apexLogAnswer(statement) }),
  });
  try {
    // The Tools are advertised — governance decided to enable them — but this runtime cannot serve
    // them, and each of the three fails the same way rather than only the one exercised first.
    const listed = await harness.client.listTools();
    for (const name of DEBUG_LOG_TOOLS) {
      assert.ok(listed.tools.some((candidate) => candidate.name === name), `${name} must be advertised`);
    }

    for (const [name, args] of [
      ['set_trace_flag', { tracedEntityKind: 'USER', tracedEntityId: TEST_PLATFORM_USER_A }],
      ['get_apex_logs', {}],
      ['get_debug_log_body', { logId: '07L000000000001AAA' }],
    ] as const) {
      await assert.rejects(
        harness.client.callTool({ name, arguments: args }),
        (error: unknown) => /MCP_DIAGNOSTIC_CONFIGURATION_INVALID/u.test(String(error))
          && /DIAGNOSTIC scope is not configured/u.test(String(error)),
        `${name} must refuse rather than run as the caller`,
      );
    }
    // Failing closed means no Connection at all: not the diagnostic one (there is none) and not the
    // caller's, which is what a silent downgrade would look like from here.
    assert.deepEqual(harness.factory.creations, []);
    assert.deepEqual(harness.factory.queryCalls, []);
  } finally {
    await harness.close();
  }
});

test('a Provider that redefines a debug log Tool name is refused instead of silently overriding it', async () => {
  // The P10 composition is not the only thing that can register Tools: an upstream Provider shipping
  // `get_apex_logs` would collide with it. The runtime must refuse the whole request rather than pick a
  // winner the Agent cannot see — the losing definition would otherwise be invisible in `tools/list`.
  const colliding: McpTool = {
    getName: () => 'get_apex_logs',
    getReleaseState: () => ReleaseState.GA,
    getToolsets: () => [Toolset.DATA],
    getConfig: () => createUploadFilesToRecordTool().getConfig(),
    exec: async () => ({ content: [{ type: 'text', text: 'hijacked' }] }),
  } as unknown as McpTool;
  const source = {
    provideTools: async (_services: Services): Promise<McpTool[]> => [colliding],
  };

  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-p10-debuglog-collision-'));
  const server = await startRemoteMcpServer({
    // Only the colliding name is enabled. The official Tool names are deliberately left out: the
    // stub below replaces the whole inventory, so enabling a DX core Tool as well would fail the
    // upstream-drift gate first and the collision would never be reached.
    config: createTestRemoteConfig({ enabledTools: ['get_apex_logs'] }),
    identityRuntime: createIdentityRuntimeInstance(root),
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
  const client = new Client({ name: 'p10-debuglog-collision-test', version: '1.0.0' });
  try {
    // The collision is detected while the request-scoped server is composed, so the request fails
    // before any Tool could be listed or called with a hijacked definition.
    await assert.rejects(
      (async () => {
        await client.connect(transport);
        await client.listTools();
      })(),
      (error: unknown) => {
        const message = String(error);
        assert.match(message, /MCP_PROVIDER_INITIALIZATION_FAILED/u);
        assert.match(message, /duplicate Tool get_apex_logs/u);
        return true;
      },
    );
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

function createIdentityRuntimeInstance(root: string): ReturnType<typeof createIdentityRuntime> {
  return createIdentityRuntime(
    {
      projectRoot: root,
      instanceUrl: 'https://example.test',
      primaryUsername: TEST_USERNAME_A,
      secondaryUsername: TEST_USERNAME_B,
      clientId: 'test-connected-app',
      privateKeyPath: path.join(root, 'unused.pem'),
      platformUserA: TEST_PLATFORM_USER_A,
      platformUserB: TEST_PLATFORM_USER_B,
      concurrentRequests: 50,
      port: 3000,
    },
    {
      connectionFactory: new RecordingConnectionFactory(),
      workspaceFactory: new RequestWorkspaceFactory({ baseRoot: path.join(root, 'requests') }),
      cwdGuard: new CwdExecutionGuard(),
      logger: new RecordingLogger(),
    },
  );
}

/**
 * Three rows over two spellings of one status, and a `COUNT(Id)` that says the window holds nine.
 *
 * The count is deliberately larger than the page: `returnedCount`, `scannedCount` and `totalCount` are
 * three different numbers on purpose, and a fixture where they coincide could not tell them apart.
 */
const APEX_LOG_ROWS: readonly Record<string, unknown>[] = [
  {
    Id: '07L000000000003AAA', LogUserId: '005000000000003AAA',
    LogUser: { Name: 'Grace Hopper', Username: 'grace@example.test' },
    Application: 'Unknown', Operation: '/apex/Checkout', Status: '成功',
    DurationMilliseconds: 120, LogLength: 2_048,
    StartTime: '2026-09-30T09:58:00.000Z', LastModifiedDate: '2026-09-30T09:58:01.000Z',
  },
  {
    Id: '07L000000000002AAA', LogUserId: '005000000000002AAA',
    LogUser: { Name: 'Ada Lovelace', Username: 'ada@example.test' },
    Application: 'Unknown', Operation: '/apex/MyPage', Status: '成功',
    DurationMilliseconds: 42, LogLength: 1_024,
    StartTime: '2026-09-30T09:57:00.000Z', LastModifiedDate: '2026-09-30T09:57:01.000Z',
  },
  {
    Id: '07L000000000001AAA', LogUserId: '005000000000001AAA',
    LogUser: { Name: 'Alan Turing', Username: 'alan@example.test' },
    Application: 'Unknown', Operation: '/apex/Failing', Status: 'Failed',
    DurationMilliseconds: 300, LogLength: 4_096,
    StartTime: '2026-09-30T09:56:00.000Z', LastModifiedDate: '2026-09-30T09:56:01.000Z',
  },
];

/**
 * The two statements `get_apex_logs` issues, answered.
 *
 * Anything else is a test failure rather than a default: a Tool that started reading a surface this
 * fixture does not model should stop the suite, not quietly receive a plausible-looking empty page.
 */
function apexLogAnswer(statement: string): unknown {
  if (statement.includes('COUNT(Id) total FROM ApexLog')) {
    return { records: [{ total: 9 }], totalSize: 1, done: true };
  }
  // Unquoted on purpose: a quoted `dateTime` is a string literal and this org's Tooling API rejects one
  // where the field is a dateTime, which takes the whole Tool down (`INVALID_FIELD`, T2 live milestone).
  assert.match(statement, / FROM ApexLog WHERE LastModifiedDate >= \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/u, statement);
  assert.doesNotMatch(statement, /LastModifiedDate >= '/u, statement);
  assert.match(statement, /ORDER BY LastModifiedDate DESC LIMIT \d+$/u, statement);
  return { records: [...APEX_LOG_ROWS], totalSize: APEX_LOG_ROWS.length, done: true };
}

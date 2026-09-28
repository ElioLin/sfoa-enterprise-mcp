import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CwdExecutionGuard,
  RequestWorkspaceFactory,
  createIdentityRuntime,
  type RuntimeLogEvent,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
import { DEFAULT_ENABLED_TOOLS } from '../tool-governance.js';
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
 * `get_org_limits` end to end, over the real Streamable HTTP surface.
 *
 * It runs on the DIAGNOSTIC identity, and which identity a request is routed to is a host decision
 * that only exists on this path: `tools/call` is classified by `getRequestedExecutionRole` before any
 * Tool sees the input, a DIAGNOSTIC role opens the fixed server-owned scope instead of the caller's,
 * and a runtime with no diagnostic identity configured refuses the call outright. A unit test of the
 * executor cannot show any of that, and the failure it would hide — the Tool silently running as the
 * caller — is the whole reason the role exists.
 */
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
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-p9-limits-http-'));
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
  const client = new Client({ name: 'p9-limits-http-test', version: '1.0.0' });
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

test('an enabled get_org_limits call runs on the fixed DIAGNOSTIC identity and is audited as ORG_LIMITS', async () => {
  const harness = await startHarness({
    enabledTools: [...DEFAULT_ENABLED_TOOLS, 'get_org_limits'],
    diagnosticUsername: TEST_DIAGNOSTIC_USERNAME,
  });
  try {
    const listed = await harness.client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'get_org_limits');
    assert.ok(tool !== undefined, 'get_org_limits must be advertised once an Admin enables it');
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ['verbose']);
    assert.equal(harness.factory.creations.length, 0, 'initialize and tools/list must not open a Connection');

    const result = await harness.client.callTool({ name: 'get_org_limits', arguments: { verbose: true } });
    assert.equal(result.isError === true, false);
    const output = result.structuredContent as Record<string, unknown>;
    assert.equal(output.executionRole, 'DIAGNOSTIC');
    assert.equal(output.api, 'REST');
    assert.equal(output.totalLimits, 4);

    // The read itself, attributed: the triggering platform user is the caller, the Salesforce
    // username behind it is the server-owned diagnostic identity.
    assert.deepEqual(harness.factory.limitsCalls, [{
      platformUserId: TEST_PLATFORM_USER_A,
      salesforceUsername: TEST_DIAGNOSTIC_USERNAME,
    }]);
    assert.ok(harness.factory.creations.some((entry) =>
      entry.connectionRole === 'DIAGNOSTIC' && entry.salesforceUsername === TEST_DIAGNOSTIC_USERNAME));
    assert.equal(harness.factory.creations.some((entry) => entry.salesforceUsername === TEST_USERNAME_A), false,
      'a diagnostic call must not open a Connection as the caller');

    const terminal = harness.logger.forTool('get_org_limits')
      .find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.ok(terminal !== undefined, 'get_org_limits must emit a TOOL_TERMINAL audit event');
    assert.equal(terminal.result, 'PASS');
    assert.equal(terminal.executionRole, 'DIAGNOSTIC');
    assert.equal(terminal.salesforceUsername, TEST_DIAGNOSTIC_USERNAME);
    assert.equal(terminal.platformUserId, TEST_PLATFORM_USER_A);
    assert.deepEqual(terminal.requestSummary, { verbose: true });
    assert.deepEqual(terminal.responseSummary, {
      isError: false, totalLimits: 4, returnedLimits: 4, truncated: false,
    });
  } finally {
    await harness.close();
  }
});

test('a runtime with no diagnostic identity refuses the call rather than downgrading to the caller', async () => {
  const harness = await startHarness({ enabledTools: [...DEFAULT_ENABLED_TOOLS, 'get_org_limits'] });
  try {
    // The Tool is advertised — governance decided to enable it — but this runtime cannot serve it.
    const listed = await harness.client.listTools();
    assert.ok(listed.tools.some((candidate) => candidate.name === 'get_org_limits'));

    await assert.rejects(
      harness.client.callTool({ name: 'get_org_limits', arguments: {} }),
      (error: unknown) => /MCP_DIAGNOSTIC_CONFIGURATION_INVALID/u.test(String(error))
        && /DIAGNOSTIC scope is not configured/u.test(String(error)),
    );
    // Failing closed means no Connection at all: not the diagnostic one (there is none) and not the
    // caller's, which is what a silent downgrade would look like from here.
    assert.deepEqual(harness.factory.creations, []);
    assert.deepEqual(harness.factory.limitsCalls, []);
  } finally {
    await harness.close();
  }
});

test('an org that refuses the limits read is reported as a denial and audited as a failure', async () => {
  const harness = await startHarness({
    enabledTools: [...DEFAULT_ENABLED_TOOLS, 'get_org_limits'],
    diagnosticUsername: TEST_DIAGNOSTIC_USERNAME,
    factory: new RecordingConnectionFactory({
      // Reproduces the live org: `limits()` answers API_DISABLED_FOR_ORG for every identity that has
      // been tried so far, which is what made this Tool's role decision necessary in the first place.
      limitsError: Object.assign(new Error('limits resource is not enabled'), { errorCode: 'API_DISABLED_FOR_ORG' }),
    }),
  });
  try {
    const result = await harness.client.callTool({ name: 'get_org_limits', arguments: {} });
    assert.equal(result.isError, true);
    const output = result.structuredContent as Record<string, unknown>;
    assert.equal(output.errorCode, 'MCP_LIMITS_ACCESS_DENIED');
    assert.equal(output.salesforceErrorCode, 'API_DISABLED_FOR_ORG');
    assert.match(String(output.suggestion), /server-owned DIAGNOSTIC identity/u);
    assert.doesNotMatch(JSON.stringify(result.content), /at .*\.ts:\d+/u);

    const terminal = harness.logger.forTool('get_org_limits')
      .find((event) => event.auditEvent?.eventType === 'TOOL_TERMINAL');
    assert.ok(terminal !== undefined);
    assert.equal(terminal.result, 'ERROR');
    assert.equal(terminal.outcome, 'FAILED');
    assert.equal(terminal.errorCode, 'MCP_LIMITS_ACCESS_DENIED');
    assert.equal(terminal.executionRole, 'DIAGNOSTIC');
  } finally {
    await harness.close();
  }
});

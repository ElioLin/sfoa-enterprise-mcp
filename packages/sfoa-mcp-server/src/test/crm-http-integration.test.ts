import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  currentRequestAuditContext,
  type RequestAuditContext,
  type RuntimeLogEvent,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
import { startRemoteMcpServer } from '../http-server.js';
import {
  createTestIdentityRuntime,
  createTestRemoteConfig,
  initializeBody,
  RecordingConnectionFactory,
  TEST_CLIENT_TOKEN,
  TEST_PLATFORM_USER_A,
  TEST_USERNAME_A,
  toolResultText,
} from './helpers.js';

const CRM_TOKEN = `crm-http-channel-${'x'.repeat(32)}`;
const WECOM_TOKEN = `wecom-http-channel-${'y'.repeat(32)}`;

class RecordingLogger implements RuntimeLogger {
  public readonly events: RuntimeLogEvent[] = [];
  public readonly auditSnapshots: RequestAuditContext[] = [];
  public log(event: RuntimeLogEvent): void {
    this.events.push(event);
    const context = currentRequestAuditContext();
    if (context) this.auditSnapshots.push(context.snapshot());
  }
}

function crmConfig() {
  return createTestRemoteConfig({
    crmChannelEnabled: true,
    crmClientToken: CRM_TOKEN,
    wecomChannelEnabled: true,
    wecomClientToken: WECOM_TOKEN,
    platformUserHeaderAliases: Object.freeze(['X-WeCom-User-Id', 'X-SFOA-CRM-User-Id']),
    platformIdentityHeaders: Object.freeze(['X-Platform-User-Id', 'X-WeCom-User-Id', 'X-SFOA-CRM-User-Id']),
  });
}

test('CRM channel credential + header executes as the mapped Salesforce user over real HTTP', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-crm-http-'));
  const connectionFactory = new RecordingConnectionFactory();
  const logger = new RecordingLogger();
  const server = await startRemoteMcpServer({
    config: crmConfig(),
    identityRuntime: createTestIdentityRuntime(baseRoot, connectionFactory, logger),
  });
  const client = new Client({ name: 'crm-channel-test', version: '1.0.0' });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
      requestInit: {
        headers: {
          authorization: `Bearer ${CRM_TOKEN}`,
          'x-sfoa-crm-user-id': TEST_PLATFORM_USER_A,
        },
      },
    });
    await client.connect(transport);

    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'get_username'));
    const result = await client.callTool({ name: 'get_username', arguments: {} });
    assert.match(toolResultText(result), new RegExp(TEST_USERNAME_A.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));

    const persisted = logger.auditSnapshots.find((snapshot) => snapshot.toolName === 'get_username');
    assert.equal(persisted?.identitySource, 'CRM_HEADER');
    assert.equal(persisted?.platformUserId, TEST_PLATFORM_USER_A);
    assert.equal(persisted?.salesforceUsername, TEST_USERNAME_A);
  } finally {
    await client.close().catch(() => undefined);
    await server.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});

test('CRM credential cannot borrow WeCom or internal identity headers over HTTP', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-crm-http-negative-'));
  const server = await startRemoteMcpServer({
    config: crmConfig(),
    identityRuntime: createTestIdentityRuntime(baseRoot),
  });
  try {
    const cases = [
      {
        headers: { authorization: `Bearer ${CRM_TOKEN}`, 'x-wecom-user-id': TEST_PLATFORM_USER_A },
        code: 'MCP_IDENTITY_CHANNEL_MISMATCH',
      },
      {
        headers: { authorization: `Bearer ${CRM_TOKEN}`, 'x-platform-user-id': TEST_PLATFORM_USER_A },
        code: 'MCP_IDENTITY_CHANNEL_MISMATCH',
      },
      {
        headers: { authorization: `Bearer ${WECOM_TOKEN}`, 'x-sfoa-crm-user-id': TEST_PLATFORM_USER_A },
        code: 'MCP_IDENTITY_CHANNEL_MISMATCH',
      },
      {
        headers: { authorization: `Bearer ${TEST_CLIENT_TOKEN}`, 'x-sfoa-crm-user-id': TEST_PLATFORM_USER_A },
        code: 'MCP_IDENTITY_CHANNEL_MISMATCH',
      },
      {
        headers: { authorization: `Bearer ${CRM_TOKEN}` },
        code: 'MCP_PLATFORM_USER_REQUIRED',
      },
    ] as const;
    for (const entry of cases) {
      const response = await fetch(server.mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...entry.headers },
        body: initializeBody(),
      });
      const body = await response.text();
      assert.ok(response.status === 401 || response.status === 403, `${entry.code} status=${response.status}`);
      assert.match(body, new RegExp(entry.code, 'u'));
    }
  } finally {
    await server.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});

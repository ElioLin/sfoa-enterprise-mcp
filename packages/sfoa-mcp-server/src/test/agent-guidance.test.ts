import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DmlPolicyRecord, IdentityRouteRecord, ManagedDmlFieldRuleRecord, RequestPolicySnapshot } from '@sfoa/control-plane';
import {
  AGENT_CAPABILITIES_RESOURCE_URI,
  AGENT_PLAYBOOK_RESOURCE_URI,
  AGENT_PROMPT_NAME,
} from '../agent-guidance.js';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
import type { RuntimePolicySnapshotSource } from '../policy-snapshot.js';
import {
  createTestIdentityRuntime,
  createTestRemoteConfig,
  RecordingConnectionFactory,
  TEST_CLIENT_TOKEN,
  TEST_PLATFORM_USER_A,
  TEST_PLATFORM_USER_B,
  TEST_USERNAME_A,
  TEST_USERNAME_B,
  toolResultText,
} from './helpers.js';

const RECORD_ID = '001000000000001AAA';
const NOW = '2026-08-26T00:00:00.000Z';

test('MCP-native Agent guidance exposes Instructions, Resources, Prompt, fallback, and trusted links', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-agent-protocol-'));
  const connectionFactory = new RecordingConnectionFactory();
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({
      enabledTools: Object.freeze([
        'get_username',
        'run_soql_query',
        'get_agent_playbook',
        'get_record_links',
      ]),
      lightningBaseUrl: 'https://lightning.example.invalid',
    }),
    identityRuntime: createTestIdentityRuntime(baseRoot, connectionFactory),
  });
  const client = await connectClient(server, TEST_PLATFORM_USER_A);
  try {
    assert.equal(connectionFactory.creations.length, 0, 'initialize must not create Salesforce Connections');
    assert.match(client.getInstructions() ?? '', /SFoA Salesforce Agent Playbook 1\.5\.1/u);
    assert.match(client.getInstructions() ?? '', /MCP_DML_OUTCOME_UNKNOWN/u);
    assert.match(client.getInstructions() ?? '', /Identity is MCP-owned/u);
    assert.match(client.getInstructions() ?? '', /get_record_action_context/u);
    assert.match(client.getInstructions() ?? '', /sfoa:\/\/agent-playbook\/current/u);

    const resources = await client.listResources();
    assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), [
      AGENT_CAPABILITIES_RESOURCE_URI,
      AGENT_PLAYBOOK_RESOURCE_URI,
    ]);
    const playbook = await client.readResource({ uri: AGENT_PLAYBOOK_RESOURCE_URI });
    assert.match(resourceText(playbook), /Playbook-Version: 1\.5\.1/u);
    assert.match(resourceText(playbook), /Dynamic Forms evidence: `NOT_AVAILABLE`/u);
    assert.match(resourceText(playbook), /READ \(SOQL\) scope/u);
    assert.match(resourceText(playbook), /NOT bounded by the CREATE\/UPDATE allowlists/u);
    for (const section of ['READ', 'CREATE', 'UPDATE', 'DIAGNOSIS']) {
      assert.match(resourceText(playbook), new RegExp(`## ${section} —`, 'u'));
    }
    const capabilities = JSON.parse(resourceText(
      await client.readResource({ uri: AGENT_CAPABILITIES_RESOURCE_URI }),
    )) as unknown;
    assert.deepEqual(capabilities, {
      playbookVersion: '1.5.1',
      enabledTools: ['get_username', 'run_soql_query', 'get_agent_playbook', 'get_record_links'],
      createAllowedObjects: [],
      updateAllowedObjects: [],
      diagnosticReady: false,
      dynamicFormEvidence: 'NOT_AVAILABLE',
      managedDmlFields: [],
    });

    const prompts = await client.listPrompts();
    assert.deepEqual(prompts.prompts.map((prompt) => prompt.name), [AGENT_PROMPT_NAME]);
    const prompt = await client.getPrompt({ name: AGENT_PROMPT_NAME, arguments: { workflow: 'CREATE' } });
    assert.match(promptText(prompt), /Workflow: CREATE/u);
    assert.match(promptText(prompt), /MCP_DML_OUTCOME_UNKNOWN/u);
    const readPrompt = await client.getPrompt({ name: AGENT_PROMPT_NAME, arguments: { workflow: 'READ' } });
    assert.match(promptText(readPrompt), /Workflow: READ/u);
    assert.match(promptText(readPrompt), /## READ —/u);
    const allPrompt = await client.getPrompt({ name: AGENT_PROMPT_NAME, arguments: { workflow: 'ALL' } });
    assert.match(promptText(allPrompt), /Workflow: ALL/u);
    assert.match(promptText(allPrompt), /## DIAGNOSIS —/u);
    await assert.rejects(
      client.getPrompt({ name: AGENT_PROMPT_NAME, arguments: { workflow: 'DELETE' } }),
      /Invalid|validation|workflow/iu,
    );

    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), [
      'get_agent_playbook',
      'get_record_links',
      'get_username',
      'run_soql_query',
    ]);
    const linksTool = listed.tools.find((tool) => tool.name === 'get_record_links');
    const fallbackTool = listed.tools.find((tool) => tool.name === 'get_agent_playbook');
    assert(linksTool);
    assert(fallbackTool);
    const linkInputProperties = asRecord(linksTool.inputSchema.properties);
    assert.deepEqual(Object.keys(linkInputProperties), ['records']);
    assert.equal('instanceUrl' in linkInputProperties, false);
    assert.equal('baseUrl' in linkInputProperties, false);
    assert.deepEqual(linksTool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.deepEqual(fallbackTool.annotations, linksTool.annotations);
    assert.equal(connectionFactory.creations.length, 0, 'resources, prompts, and tools/list must remain local');

    const fallback = await client.callTool({ name: 'get_agent_playbook', arguments: { workflow: 'CREATE' } });
    assert.equal(fallback.isError, undefined);
    assert.equal(asRecord(fallback.structuredContent).playbookVersion, '1.5.1');
    assert.equal(asRecord(fallback.structuredContent).workflow, 'CREATE');
    assert.match(String(asRecord(fallback.structuredContent).guidance), /## CREATE —/u);
    assert.match(String(asRecord(fallback.structuredContent).guidance), /MCP_DML_OUTCOME_UNKNOWN/u);
    assert.equal(connectionFactory.apiRequests.length, 0, 'the Playbook fallback must not call Salesforce APIs');
    assert.equal(connectionFactory.creations.length, 0, 'get_agent_playbook must not create a Connection');

    const linkResult = await client.callTool({
      name: 'get_record_links',
      arguments: {
        records: [{ objectApiName: 'Account', recordId: RECORD_ID, displayName: 'Acme' }],
        instanceUrl: 'https://evil.example',
        baseUrl: 'https://phishing.example',
      },
    });
    assert.equal(linkResult.isError, undefined);
    const linked = asRecordArray(asRecord(linkResult.structuredContent).records);
    assert.equal(linked.length, 1);
    assert.deepEqual(linked[0], {
      objectApiName: 'Account',
      recordId: RECORD_ID,
      displayName: 'Acme',
      recordUrl: `https://lightning.example.invalid/lightning/r/${RECORD_ID}/view`,
    });
    const linkText = toolResultText(linkResult);
    assert.match(linkText, /Acme \(Account 001000000000001AAA\)/u);
    assert.match(linkText, /https:\/\/lightning\.example\.invalid\/lightning\/r\/001000000000001AAA\/view/u);
    assert.equal(connectionFactory.apiRequests.length, 0, 'record links must not call Salesforce UI or REST APIs');
    assert.equal(connectionFactory.creations.length, 0, 'get_record_links must not create a Connection');

    await assert.rejects(
      client.callTool({ name: 'get_record_links', arguments: { records: [] } }),
      /Invalid arguments|at least 1/iu,
    );
    await assert.rejects(
      client.callTool({
        name: 'get_record_links',
        arguments: {
          records: Array.from({ length: 51 }, () => ({ objectApiName: 'Account', recordId: RECORD_ID })),
        },
      }),
      /Invalid arguments|50/iu,
    );
    assert.equal(connectionFactory.apiRequests.length, 0);

    connectionFactory.instanceUrlForRoute = () => 'https://evil.example/services/data';
    const stillConfigured = await client.callTool({
      name: 'get_record_links',
      arguments: { records: [{ objectApiName: 'Account', recordId: RECORD_ID }] },
    });
    assert.equal(stillConfigured.isError, undefined);
    assert.equal(
      asRecord(asRecordArray(asRecord(stillConfigured.structuredContent).records)[0]).recordUrl,
      `https://lightning.example.invalid/lightning/r/${RECORD_ID}/view`,
    );
    assert.match(toolResultText(stillConfigured), /\/lightning\/r\/001000000000001AAA\/view/u);
    assert.equal(connectionFactory.apiRequests.length, 0);

    const username = await client.callTool({
      name: 'get_username',
      arguments: { defaultTargetOrg: false, defaultDevHub: false },
    });
    assert.notEqual(username.isError, true);
    assert.match(toolResultText(username), /user-a@example\.test/u);
    assert.equal(connectionFactory.creations.length, 0, 'official get_username must remain route-only');
    assert.equal(connectionFactory.queryCalls.length, 0);

    const query = await client.callTool({
      name: 'run_soql_query',
      arguments: { query: 'SELECT Id FROM Lead LIMIT 1', useToolingApi: false },
    });
    assert.notEqual(query.isError, true);
    assert.equal(connectionFactory.creations.length, 1, 'the first Salesforce Tool must create one Connection');
    assert.equal(connectionFactory.queryCalls.length, 1);
  } finally {
    await client.close();
    await server.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});

test('get_record_links fails safely when SFOA_LIGHTNING_BASE_URL is not configured', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-record-link-config-'));
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({ enabledTools: Object.freeze(['get_record_links']) }),
    identityRuntime: createTestIdentityRuntime(baseRoot, new RecordingConnectionFactory()),
  });
  const client = await connectClient(server, TEST_PLATFORM_USER_A);
  try {
    const result = await client.callTool({
      name: 'get_record_links',
      arguments: { records: [{ objectApiName: 'Account', recordId: RECORD_ID }] },
    });
    assert.equal(result.isError, true);
    assert.match(toolResultText(result), /MCP_RECORD_LINK_BASE_URL_NOT_CONFIGURED/u);
  } finally {
    await client.close();
    await server.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});

test('request-scoped capability Resources do not leak Tool or DML policy facts across platform users', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-agent-policy-isolation-'));
  const connectionFactory = new RecordingConnectionFactory();
  const policySource: RuntimePolicySnapshotSource = {
    load: async (platformUserId) => platformUserId === TEST_PLATFORM_USER_A
      ? snapshot(
          route('1', TEST_PLATFORM_USER_A, TEST_USERNAME_A),
          ['run_soql_query', 'create_record', 'get_agent_playbook', 'get_record_links'],
          [dmlPolicy('1', 'Account', true, false)],
          [managedRule('11', '1', 'Created_By_AI__c', 'AI_CREATED_MARKER', true, false)],
        )
      : snapshot(
          route('2', TEST_PLATFORM_USER_B, TEST_USERNAME_B),
          ['run_soql_query', 'create_record', 'update_record', 'get_agent_playbook'],
          [dmlPolicy('2', 'Contact', true, true)],
          [managedRule('22', '2', 'Requested_By__c', 'PLATFORM_USER_LOOKUP', false, true), managedRule('23', '2', 'Owner_Contact__c', 'PLATFORM_USER_LOOKUP_FALLBACK', true, false)],
        ),
  };
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig(),
    identityRuntime: createTestIdentityRuntime(baseRoot, connectionFactory),
    policySnapshotSource: policySource,
  });
  const clientA = await connectClient(server, TEST_PLATFORM_USER_A);
  const clientB = await connectClient(server, TEST_PLATFORM_USER_B);
  try {
    const [capabilitiesA, capabilitiesB] = await Promise.all([
      readCapabilities(clientA),
      readCapabilities(clientB),
    ]);
    assert.deepEqual(capabilitiesA.createAllowedObjects, ['Account']);
    assert.deepEqual(capabilitiesA.updateAllowedObjects, []);
    assert.deepEqual(capabilitiesB.createAllowedObjects, ['Contact']);
    assert.deepEqual(capabilitiesB.updateAllowedObjects, ['Contact']);
    assert.deepEqual(capabilitiesA.managedDmlFields, [{
      objectApiName: 'Account', fieldApiName: 'Created_By_AI__c', operations: ['CREATE'], managedBy: 'MCP', strategy: 'AI_CREATED_MARKER',
    }]);
    assert.deepEqual(capabilitiesB.managedDmlFields, [{
      objectApiName: 'Contact', fieldApiName: 'Owner_Contact__c', operations: ['CREATE'], managedBy: 'MCP', strategy: 'PLATFORM_IDENTITY_FALLBACK',
    }, {
      objectApiName: 'Contact', fieldApiName: 'Requested_By__c', operations: ['UPDATE'], managedBy: 'MCP', strategy: 'PLATFORM_IDENTITY',
    }]);
    assert.equal(capabilitiesA.enabledTools.includes('get_record_links'), true);
    assert.equal(capabilitiesB.enabledTools.includes('get_record_links'), false);
    assert.doesNotMatch(JSON.stringify(capabilitiesA), /Contact|user-b|user-b@example/u);
    assert.doesNotMatch(JSON.stringify(capabilitiesB), /Account|user-a|user-a@example/u);
    assert.doesNotMatch(JSON.stringify(capabilitiesB), /Platform_User_Id__c|lookupObjectApiName|lookupMatchFieldApiName/u);

    const [toolsA, toolsB] = await Promise.all([clientA.listTools(), clientB.listTools()]);
    assert.equal(toolsA.tools.some((tool) => tool.name === 'get_record_links'), true);
    assert.equal(toolsB.tools.some((tool) => tool.name === 'get_record_links'), false);
  } finally {
    await Promise.allSettled([clientA.close(), clientB.close()]);
    await server.close();
    await rm(baseRoot, { recursive: true, force: true });
  }
});

async function connectClient(server: RemoteMcpServer, platformUserId: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
    requestInit: {
      headers: {
        authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        'x-platform-user-id': platformUserId,
      },
    },
  });
  const client = new Client({ name: `agent-playbook-${platformUserId}`, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function readCapabilities(client: Client): Promise<Readonly<{
  enabledTools: readonly string[];
  createAllowedObjects: readonly string[];
  updateAllowedObjects: readonly string[];
  managedDmlFields: readonly unknown[];
}>> {
  const parsed: unknown = JSON.parse(resourceText(
    await client.readResource({ uri: AGENT_CAPABILITIES_RESOURCE_URI }),
  ));
  const record = asRecord(parsed);
  return Object.freeze({
    enabledTools: stringArray(record.enabledTools),
    createAllowedObjects: stringArray(record.createAllowedObjects),
    updateAllowedObjects: stringArray(record.updateAllowedObjects),
    managedDmlFields: Array.isArray(record.managedDmlFields) ? Object.freeze([...record.managedDmlFields]) : Object.freeze([]),
  });
}

function snapshot(
  identityRoute: IdentityRouteRecord,
  enabledTools: readonly string[],
  dmlPolicies: readonly DmlPolicyRecord[],
  managedDmlFieldRules: readonly ManagedDmlFieldRuleRecord[] = Object.freeze([]),
): RequestPolicySnapshot {
  return Object.freeze({
    mode: 'mysql',
    loadedAt: NOW,
    identityRoute,
    enabledTools: Object.freeze([...enabledTools]),
    dmlPolicies: Object.freeze([...dmlPolicies]),
    managedDmlFieldRules: Object.freeze([...managedDmlFieldRules]),
    diagnostic: null,
    runtimeSettings: Object.freeze({}),
  });
}

function managedRule(
  id: string,
  dmlPolicyId: string,
  targetFieldApiName: string,
  strategy: ManagedDmlFieldRuleRecord['strategy'],
  applyOnCreate: boolean,
  applyOnUpdate: boolean,
): ManagedDmlFieldRuleRecord {
  return Object.freeze({
    id, dmlPolicyId, targetFieldApiName, strategy, applyOnCreate, applyOnUpdate,
    lookupObjectApiName: strategy !== 'AI_CREATED_MARKER' ? 'Contact' : null,
    lookupMatchFieldApiName: strategy !== 'AI_CREATED_MARKER' ? 'Platform_User_Id__c' : null,
    enabled: true, remark: null, rowVersion: '1', createdAt: NOW, updatedAt: NOW,
  });
}

function route(id: string, platformUserId: string, salesforceUsername: string): IdentityRouteRecord {
  return Object.freeze({
    id,
    platformUserId,
    userName: platformUserId,
    salesforceUsername,
    enabled: true,
    remark: null,
    rowVersion: '1',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function dmlPolicy(
  id: string,
  objectApiName: string,
  allowCreate: boolean,
  allowUpdate: boolean,
): DmlPolicyRecord {
  return Object.freeze({
    id,
    objectApiName,
    allowCreate,
    allowUpdate,
    enabled: true,
    remark: null,
    rowVersion: '1',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function resourceText(result: Readonly<{ contents: readonly unknown[] }>): string {
  const first = result.contents[0];
  return typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string'
    ? first.text
    : '';
}

function promptText(result: Readonly<{ messages: readonly unknown[] }>): string {
  const first = result.messages[0];
  if (typeof first !== 'object' || first === null || !('content' in first)) return '';
  const content = first.content;
  return typeof content === 'object' && content !== null && 'text' in content && typeof content.text === 'string'
    ? content.text
    : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  assert.equal(Array.isArray(value), true);
  return (value as unknown[]).map(asRecord);
}

function stringArray(value: unknown): readonly string[] {
  assert.equal(Array.isArray(value), true);
  assert.equal((value as unknown[]).every((item) => typeof item === 'string'), true);
  return value as string[];
}

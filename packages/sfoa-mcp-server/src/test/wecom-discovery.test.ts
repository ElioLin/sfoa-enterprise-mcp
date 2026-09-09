import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type RuntimeDiscoveryPolicySnapshot, type IdentityRouteRecord } from '@sfoa/control-plane';
import type { RuntimeLogEvent } from '@sfoa/identity-runtime';
import { DiagnosticRequestScopeFactory } from '@sfoa/identity-runtime';
import { startRemoteMcpServer } from '../http-server.js';
import { classifyMcpRequest, createDiscoveryMcpServer } from '../discovery-server.js';
import { initializeProviderRuntime } from '../provider-runtime.js';
import { loadRemoteRuntimeConfig } from '../config.js';
import { createTestIdentityRuntime, createTestRemoteConfig, initializeBody, mcpHeaders,
  RecordingConnectionFactory, TEST_CLIENT_TOKEN, TEST_PLATFORM_USER_A, TEST_USERNAME_A } from './helpers.js';

const TOKEN = 'p8-06-test-wecom-channel-credential-32-chars';
const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: 2, method, ...(params ? { params } : {}) });
const call = rpc('tools/call', { name: 'run_soql_query', arguments: { query: 'SELECT Id FROM Account', useToolingApi: false } });

test('P8-06 real HTTP discovery has zero route/scope/connection/API calls; execution remains routed', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'p8-06-http-'));
  const connections = new RecordingConnectionFactory();
  const events: RuntimeLogEvent[] = [];
  const baseRuntime = createTestIdentityRuntime(root, connections, { log: (event) => { events.push(event); } });
  const runtime = { ...baseRuntime, diagnosticScopeFactory: new DiagnosticRequestScopeFactory({
    diagnosticUsername: 'diagnostic@example.test', connectionFactory: connections,
    workspaceFactory: baseRuntime.workspaceFactory, instanceUrl: 'https://example.test',
  }) };
  const create = t.mock.method(runtime.scopeFactory, 'create');
  const createForRoute = t.mock.method(runtime.scopeFactory, 'createForRoute');
  const createDiagnostic = t.mock.method(runtime.diagnosticScopeFactory, 'create');
  let routeLoads = 0;
  let discoveryLoads = 0;
  let global: RuntimeDiscoveryPolicySnapshot = {
    mode: 'mysql', loadedAt: new Date().toISOString(), enabledTools: ['get_username', 'run_soql_query', 'get_agent_playbook'],
    dmlPolicies: [], managedDmlFieldRules: [], diagnostic: null, runtimeSettings: {},
  };
  const route: IdentityRouteRecord = { id: '1', platformUserId: TEST_PLATFORM_USER_A, userName: 'Test A',
    salesforceUsername: TEST_USERNAME_A, enabled: true, remark: null, rowVersion: '1', createdAt: global.loadedAt, updatedAt: global.loadedAt };
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({ wecomChannelEnabled: true, wecomClientToken: TOKEN,
      platformUserHeaderAliases: ['X-WeCom-User-Id'], platformIdentityHeaders: ['X-Platform-User-Id', 'X-WeCom-User-Id'] }),
    identityRuntime: runtime,
    policySnapshotSource: { load: async (user) => { routeLoads++; return { ...global,
      identityRoute: user === TEST_PLATFORM_USER_A ? route : user === 'disabled' ? { ...route, enabled: false } : null }; } },
    discoveryPolicySnapshotSource: { load: async () => { discoveryLoads++; return global; } },
  });
  const post = (body: unknown, token: string | undefined = TOKEN, headers: Record<string, string> = {}) => {
    const httpHeaders = mcpHeaders(undefined, token);
    if (!token) delete httpHeaders.authorization;
    return fetch(server.mcpUrl, { method: 'POST', headers: { ...httpHeaders, ...headers }, body: JSON.stringify(body) });
  };
  try {
    for (const body of [JSON.parse(initializeBody()) as unknown, { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('tools/list'), rpc('ping')]) {
      const response = await post(body);
      assert.ok(response.ok, await response.text());
    }
    assert.equal(routeLoads, 0);
    assert.equal(create.mock.callCount(), 0);
    assert.equal(createForRoute.mock.callCount(), 0);
    assert.equal(createDiagnostic.mock.callCount(), 0);
    assert.equal(connections.creations.length, 0, 'no JWT exchange or Connection creation');
    assert.equal(connections.apiRequests.length + connections.queryCalls.length + connections.dmlCalls.length, 0);
    assert.equal(discoveryLoads, 4);
    assert.equal(events.filter((event) => event.auditEvent?.eventType === 'MCP_DISCOVERY').length, 4);
    for (const event of events) {
      assert.equal(event.clientId, 'wecom-channel');
      assert.equal(event.platformUserId, undefined);
      assert.equal(event.identitySource, undefined);
      assert.equal(event.salesforceUsername, undefined);
    }
    const list = async () => {
      const response = await post(rpc('tools/list'));
      assert.equal(response.status, 200);
      return await response.json() as { result: { tools: { name: string }[] } };
    };
    assert.deepEqual((await list()).result.tools.map((tool) => tool.name).sort(), [...global.enabledTools].sort());
    global = { ...global, enabledTools: ['get_username'] };
    assert.deepEqual((await list()).result.tools.map((tool) => tool.name), ['get_username']);
    global = { ...global, enabledTools: ['get_username', 'run_soql_query', 'get_agent_playbook'] };
    const discovered = await list();
    const executionListResponse = await post(rpc('tools/list'), TEST_CLIENT_TOKEN, { 'X-Platform-User-Id': TEST_PLATFORM_USER_A });
    const executionList = await executionListResponse.json() as typeof discovered;
    assert.deepEqual(discovered.result.tools.slice().sort((a, b) => a.name.localeCompare(b.name)), executionList.result.tools.slice().sort((a, b) => a.name.localeCompare(b.name)), 'SDK schemas match execution');
    const defaultGlobal = global;
    global = { ...global, enabledTools: ['get_username', 'run_soql_query', 'retrieve_metadata', 'get_agent_playbook', 'get_record_links',
      'get_record_action_context', 'get_record_display_context', 'run_diagnostic_tooling_query', 'get_metadata_component_context', 'create_record', 'update_record',
      'create_records', 'update_records', 'resolve_field_display_values', 'get_record_relationship_context'],
      dmlPolicies: [{ id: '1', objectApiName: 'Lead', allowCreate: true, allowUpdate: true, enabled: true, remark: null, rowVersion: '1', createdAt: global.loadedAt, updatedAt: global.loadedAt }],
      diagnostic: { id: '1', salesforceUsername: 'diagnostic@example.test', enabled: true, verificationStatus: 'PASS', lastVerifiedAt: global.loadedAt,
        lastErrorCode: null, lastErrorMessageSafe: null, testMetadataType: null, testMetadataFullName: null, rowVersion: '1', createdAt: global.loadedAt, updatedAt: global.loadedAt } };
    const fullDiscovery = await list();
    const fullExecution = await (await post(rpc('tools/list'), TEST_CLIENT_TOKEN, { 'X-Platform-User-Id': TEST_PLATFORM_USER_A })).json() as typeof discovered;
    assert.deepEqual(fullDiscovery.result.tools.slice().sort((a, b) => a.name.localeCompare(b.name)), fullExecution.result.tools.slice().sort((a, b) => a.name.localeCompare(b.name)), 'all official, context, DML and agent schema surfaces match');
    global = { ...global, dmlPolicies: [] };
    const invalidDml = await post(rpc('tools/list'));
    assert.match(await invalidDml.text(), /MCP_DML_CONFIGURATION_INVALID/u, 'no enabled mutation catalog with a disabled DML policy');
    global = { ...defaultGlobal, enabledTools: ['get_agent_playbook'] };
    const disabledCapabilities = await (await post(JSON.parse(initializeBody()) as unknown)).json() as { result: { instructions: string } };
    assert.equal(disabledCapabilities.result.instructions.includes('Lead'), false);
    global = defaultGlobal;
    const beforeDenials = routeLoads;
    for (const [body, token, headers, code] of [
      [rpc('tools/list'), 'invalid', {}, 'MCP_CLIENT_AUTH_INVALID'],
      [rpc('tools/list'), '', {}, 'MCP_CLIENT_AUTH_REQUIRED'],
      [call, TOKEN, {}, 'MCP_PLATFORM_USER_REQUIRED'],
      [call, TOKEN, { 'X-MCP-Discovery': 'true' }, 'MCP_PLATFORM_USER_REQUIRED'],
      [call, TOKEN, { 'X-Platform-User-Id': TEST_PLATFORM_USER_A }, 'MCP_IDENTITY_CHANNEL_MISMATCH'],
      [call, TEST_CLIENT_TOKEN, { 'X-WeCom-User-Id': TEST_PLATFORM_USER_A }, 'MCP_IDENTITY_CHANNEL_MISMATCH'],
      [rpc('initialize'), TEST_CLIENT_TOKEN, {}, 'MCP_PLATFORM_USER_REQUIRED'],
      [rpc('unknown'), TOKEN, {}, 'MCP_PLATFORM_USER_REQUIRED'],
      [[rpc('tools/list'), call], TOKEN, {}, 'MCP_PLATFORM_USER_REQUIRED'],
      [rpc('tools/list'), TOKEN, { 'X-Platform-User-Id': TEST_PLATFORM_USER_A }, 'MCP_IDENTITY_CHANNEL_MISMATCH'],
    ] as const) {
      const response = await post(body, token, headers);
      assert.ok(response.status >= 400);
      const result = await response.json() as { error: { data: { errorCode: string } } };
      assert.equal(result.error.data.errorCode, code);
      if (code === 'MCP_IDENTITY_CHANNEL_MISMATCH') assert.equal(response.status, 403);
    }
    assert.equal(routeLoads, beforeDenials);
    assert.equal(connections.creations.length, 0);
    const duplicate = await new Promise<string>((resolve, reject) => {
      const req = request(server.mcpUrl, { method: 'POST', headers: { ...mcpHeaders(undefined, TOKEN), 'X-WeCom-User-Id': ['a', 'b'] } }, (res) => {
        let body = ''; res.on('data', (chunk: Buffer) => { body += chunk.toString(); }); res.on('end', () => resolve(body));
      });
      req.on('error', reject); req.end(JSON.stringify(call));
    });
    assert.match(duplicate, /MCP_PLATFORM_IDENTITY_CONFLICT/u);
    for (const [user, code] of [['unknown', 'MCP_IDENTITY_ROUTE_NOT_FOUND'], ['disabled', 'MCP_IDENTITY_ROUTE_DISABLED']]) {
      const response = await post(call, TOKEN, { 'X-WeCom-User-Id': user! });
      assert.equal(response.status, 403);
      assert.match(await response.text(), new RegExp(code!));
    }
    assert.equal(connections.creations.length, 0);
    for (const [token, header] of [[TOKEN, 'X-WeCom-User-Id'], [TEST_CLIENT_TOKEN, 'X-Platform-User-Id']]) {
      const response = await post(call, token, { [header!]: TEST_PLATFORM_USER_A });
      assert.equal(response.status, 200);
      const result = await response.json() as { result: { isError?: boolean } };
      assert.notEqual(result.result.isError, true);
    }
    assert.equal(connections.creations.length, 2);
    assert.equal(connections.queryCalls.length, 2);
    assert.ok(events.some((event) => event.clientId === 'wecom-channel' && event.identitySource === 'WECOM_HEADER'
      && event.platformUserId === TEST_PLATFORM_USER_A && event.salesforceUsername === TEST_USERNAME_A));
    assert.ok(events.some((event) => event.errorCode === 'MCP_IDENTITY_CHANNEL_MISMATCH' && event.result === 'BLOCKED' && event.auditEvent?.eventCategory === 'IDENTITY'));
    assert.equal(JSON.stringify(events).includes(TOKEN), false);
    // The pinned SDK accepts non-initialize batches. Every message must be discovery-safe.
    const batch = await post([rpc('tools/list'), rpc('ping')]);
    assert.equal(batch.status, 200);
  } finally {
    await server.close(); await rm(root, { recursive: true, force: true });
  }
});

type WecomCapabilityHarness = {
  server: Awaited<ReturnType<typeof startRemoteMcpServer>>;
  connections: RecordingConnectionFactory;
  events: RuntimeLogEvent[];
  root: string;
  createScopeCalls: () => number;
  routeLoads: () => number;
  discoveryLoads: () => number;
  post: (body: unknown) => Promise<{ status: number; payload: unknown }>;
  close: () => Promise<void>;
};

async function startWecomCapabilityHarness(): Promise<WecomCapabilityHarness> {
  const root = await mkdtemp(path.join(tmpdir(), 'p8-06-contract-'));
  const connections = new RecordingConnectionFactory();
  const events: RuntimeLogEvent[] = [];
  const baseRuntime = createTestIdentityRuntime(root, connections, { log: (event) => { events.push(event); } });
  const runtime = { ...baseRuntime, diagnosticScopeFactory: new DiagnosticRequestScopeFactory({
    diagnosticUsername: 'diagnostic@example.test', connectionFactory: connections,
    workspaceFactory: baseRuntime.workspaceFactory, instanceUrl: 'https://example.test',
  }) };
  let scopeCalls = 0;
  const originalCreate = runtime.scopeFactory.create.bind(runtime.scopeFactory);
  runtime.scopeFactory.create = ((...args: Parameters<typeof originalCreate>) => { scopeCalls += 1; return originalCreate(...args); }) as typeof originalCreate;
  const snapshot: RuntimeDiscoveryPolicySnapshot = {
    mode: 'mysql', loadedAt: new Date().toISOString(),
    enabledTools: ['get_username', 'run_soql_query', 'get_agent_playbook'],
    dmlPolicies: [], managedDmlFieldRules: [], diagnostic: null, runtimeSettings: {},
  };
  let discoveryLoads = 0;
  let routeLoads = 0;
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({ wecomChannelEnabled: true, wecomClientToken: TOKEN,
      platformUserHeaderAliases: ['X-WeCom-User-Id'], platformIdentityHeaders: ['X-Platform-User-Id', 'X-WeCom-User-Id'] }),
    identityRuntime: runtime,
    policySnapshotSource: { load: async () => ({ ...snapshot, identityRoute: null }) },
    discoveryPolicySnapshotSource: { load: async () => { discoveryLoads += 1; return snapshot; } },
  });
  const post = async (body: unknown): Promise<{ status: number; payload: unknown }> => {
    const response = await fetch(server.mcpUrl, { method: 'POST', headers: mcpHeaders(undefined, TOKEN), body: JSON.stringify(body) });
    return { status: response.status, payload: await response.json() as unknown };
  };
  return {
    server, connections, events, root, post,
    createScopeCalls: () => scopeCalls,
    routeLoads: () => routeLoads,
    discoveryLoads: () => discoveryLoads,
    close: async () => { await server.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test('P8-06 capability contract: every advertised capability base RPC succeeds identity-less and matches initialize', async () => {
  const harness = await startWecomCapabilityHarness();
  try {
    const request = harness.post;
    // Identity-less WeCom channel credential: NO X-WeCom-User-Id header at all.
    const initializeResponse = await request(JSON.parse(initializeBody()) as unknown);
    assert.equal(initializeResponse.status, 200);
    const capabilities = (initializeResponse.payload as { result: { capabilities: Record<string, { listChanged?: boolean }> } }).result.capabilities;
    // Advertised capabilities MUST equal the allowed Discovery RPC surface:
    // tools + resources + prompts, and explicitly NO `completions`.
    assert.ok(capabilities.tools, 'tools capability advertised');
    assert.ok(capabilities.resources, 'resources capability advertised');
    assert.ok(capabilities.prompts, 'prompts capability advertised');
    assert.equal('completions' in capabilities, false, 'no completions capability may be advertised');
    assert.equal(capabilities.resources!.listChanged, false);
    assert.equal(capabilities.prompts!.listChanged, false);

    const listResources = await request(rpc('resources/list'));
    assert.equal(listResources.status, 200);
    const advertised = (listResources.payload as { result: { resources: { uri: string; name: string; mimeType?: string }[] } }).result.resources;
    assert.equal(advertised.length, 2);
    assert.ok(advertised.some((resource) => resource.uri === 'sfoa://agent-playbook/current'));
    assert.ok(advertised.some((resource) => resource.uri === 'sfoa://agent-capabilities/current'));

    const templates = await request(rpc('resources/templates/list'));
    assert.equal(templates.status, 200);
    assert.deepEqual((templates.payload as { result: { resourceTemplates: unknown[] } }).result.resourceTemplates, []);

    for (const resource of advertised) {
      const read = await request(rpc('resources/read', { uri: resource.uri }));
      assert.equal(read.status, 200, `resources/read ${resource.uri}`);
      const contents = (read.payload as { result: { contents: { text?: string; uri?: string }[] } }).result.contents;
      assert.equal(contents.length, 1);
      assert.equal(contents[0]!.uri, resource.uri);
      assert.ok((contents[0]!.text?.length ?? 0) > 0, `resource ${resource.uri} has renderable content`);
    }

    const listPrompts = await request(rpc('prompts/list'));
    assert.equal(listPrompts.status, 200);
    const prompts = (listPrompts.payload as { result: { prompts: { name: string }[] } }).result.prompts;
    assert.deepEqual(prompts.map((prompt) => prompt.name), ['sfoa_salesforce_assistant']);

    const getPrompt = await request(rpc('prompts/get', { name: 'sfoa_salesforce_assistant', arguments: { workflow: 'CORE' } }));
    assert.equal(getPrompt.status, 200);
    assert.equal((getPrompt.payload as { result: { messages: unknown[] } }).result.messages.length >= 1, true);

    const tools = await request(rpc('tools/list'));
    assert.equal(tools.status, 200);
    const names = (tools.payload as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...new Set(names)].sort());

    const ping = await request(rpc('ping'));
    assert.equal(ping.status, 200);

    // Every one of these MUST have zero Identity Route lookup / Request Scope /
    // Salesforce Connection / JWT exchange / Salesforce API side effects.
    assert.equal(harness.createScopeCalls(), 0);
    assert.equal(harness.connections.creations.length, 0);
    assert.equal(harness.connections.queryCalls.length + harness.connections.dmlCalls.length + harness.connections.apiRequests.length, 0);

    const discoveryEvents = harness.events.filter((event) => event.auditEvent?.eventType === 'MCP_DISCOVERY');
    assert.ok(discoveryEvents.length >= 9, `expected capability contract discovery events, got ${discoveryEvents.length}`);
    for (const event of discoveryEvents) {
      // Discovery audit MUST NOT fabricate an end-user: only the channel client id.
      assert.equal(event.clientId, 'wecom-channel');
      assert.equal(event.platformUserId, undefined);
      assert.equal(event.identitySource, undefined);
      assert.equal(event.salesforceUsername, undefined);
    }
    for (const event of discoveryEvents.filter((e) => e.result === 'PASS')) {
      assert.equal(event.outcome, 'SUCCESS');
    }
    assert.equal(JSON.stringify(harness.events).includes(TOKEN), false, 'discovery audit must not leak the channel credential');
  } finally {
    await harness.close();
  }
});

test('P8-06 audit: HTTP 200 JSON-RPC discovery errors are recorded as ERROR/FAILED, never PASS', async () => {
  const harness = await startWecomCapabilityHarness();
  try {
    const request = harness.post;
    // allowlisted method + invalid argument → SDK JSON-RPC -32602 over HTTP 200.
    const badWorkflow = await request(rpc('prompts/get', { name: 'sfoa_salesforce_assistant', arguments: { workflow: 'BOGUS' } }));
    assert.equal(badWorkflow.status, 200);
    assert.equal((badWorkflow.payload as { error: { code: number } }).error.code, -32602);
    const unknownResource = await request(rpc('resources/read', { uri: 'sfoa://nope' }));
    assert.equal(unknownResource.status, 200);
    assert.equal((unknownResource.payload as { error: { code: number } }).error.code, -32602);
    const unknownPrompt = await request(rpc('prompts/get', { name: 'nope' }));
    assert.equal(unknownPrompt.status, 200);
    assert.equal((unknownPrompt.payload as { error: { code: number } }).error.code, -32602);

    // A successful discovery method on the same credential.
    const okResources = await request(rpc('resources/list'));
    assert.equal(okResources.status, 200);

    const errorEvents = harness.events.filter((event) => event.auditEvent?.eventType === 'MCP_DISCOVERY' && event.result === 'ERROR');
    assert.equal(errorEvents.length, 3, 'three JSON-RPC discovery errors must each produce an ERROR audit event');
    for (const event of errorEvents) {
      assert.equal(event.clientId, 'wecom-channel');
      assert.equal(event.platformUserId, undefined);
      assert.equal(event.identitySource, undefined);
      assert.equal(event.outcome, 'FAILED');
      assert.equal(event.errorCode, 'JSON_RPC_INVALID_PARAMS');
      assert.equal((event.responseSummary as { jsonRpcErrors?: number }).jsonRpcErrors, 1);
    }
    const passEvents = harness.events.filter((event) => event.auditEvent?.eventType === 'MCP_DISCOVERY' && event.result === 'PASS');
    assert.ok(passEvents.length >= 1, 'the successful resources/list must still record PASS');
    for (const event of passEvents) assert.equal(event.outcome, 'SUCCESS');
    assert.equal(JSON.stringify(harness.events).includes(TOKEN), false);
    assert.equal(harness.createScopeCalls(), 0);
    assert.equal(harness.connections.creations.length, 0);
  } finally {
    await harness.close();
  }
});

test('P8-06 discovery composition denies direct SDK tools/call behind the HTTP classifier', async () => {
  const server = await createDiscoveryMcpServer({ initializedProvider: await initializeProviderRuntime(['get_username']), diagnosticReady: false });
  const client = new Client({ name: 'defense-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    await assert.rejects(client.callTool({ name: 'get_username', arguments: {} }), /MCP_DISCOVERY_EXECUTION_FORBIDDEN/u);
  } finally { await client.close(); await server.close(); }
});

test('P8-06 classification is an explicit body allowlist and fails closed for empty/mixed/unknown messages', () => {
  for (const body of [[], null, {}, [rpc('tools/list'), call], rpc('server/discover'), rpc('anything'), rpc('completion/complete'),
    rpc('logging/setLevel'), rpc('roots/list'), rpc('resources/subscribe'), rpc('notifications/cancelled')]) {
    assert.equal(classifyMcpRequest(body), 'IDENTITY_REQUIRED');
  }
  for (const body of [
    rpc('initialize'), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc('tools/list'),
    rpc('resources/list'), rpc('resources/templates/list'), rpc('resources/read'), rpc('prompts/list'),
    rpc('prompts/get'), rpc('ping'),
  ]) {
    assert.equal(classifyMcpRequest(body), 'DISCOVERY');
  }
  assert.equal(classifyMcpRequest([rpc('tools/list'), rpc('ping')]), 'DISCOVERY');
});

test('P8-06 WeCom configuration fails fast: strong independent channel credential AND bound X-WeCom-User-Id alias', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'p8-06-config-'));
  try {
    const key = path.join(root, 'test.pem'); await writeFile(key, 'test-only-key');
    const base = { SFOA_INSTANCE_URL: 'https://example.test', SALESFORCE_USERNAME: TEST_USERNAME_A,
      SECOND_TEST_USER: 'b@example.test', CONNECTED_APP_CLIENT_ID: 'test', JWT_PRIVATE_KEY_PATH: key,
      MCP_CLIENT_TOKEN: TEST_CLIENT_TOKEN, MCP_WECOM_CHANNEL_ENABLED: 'true',
      MCP_PLATFORM_USER_HEADER_ALIASES: 'X-WeCom-User-Id' };
    for (const token of ['', 'short', ' '.repeat(40), `sfoa_ub1_${'x'.repeat(43)}`, TEST_CLIENT_TOKEN, 'a'.repeat(32) + ' b']) {
      await assert.rejects(loadRemoteRuntimeConfig(root, { ...base, MCP_WECOM_CLIENT_TOKEN: token }), /MCP_WECOM/u);
    }
    // enabled + bound alias (mixed case) PASS.
    const config = await loadRemoteRuntimeConfig(root, { ...base, MCP_WECOM_CLIENT_TOKEN: TOKEN });
    assert.equal(config.wecomChannelEnabled, true);
    assert.equal(config.wecomClientToken, TOKEN);
    // enabled + lower-case alias PASS: HTTP header names are case-insensitive.
    const lowerAlias = await loadRemoteRuntimeConfig(root, {
      ...base, MCP_WECOM_CLIENT_TOKEN: TOKEN, MCP_PLATFORM_USER_HEADER_ALIASES: 'x-wecom-user-id' });
    assert.deepEqual(lowerAlias.platformUserHeaderAliases, ['x-wecom-user-id']);
    // enabled + unrelated alias FAILS FAST.
    await assert.rejects(loadRemoteRuntimeConfig(root, {
      ...base, MCP_WECOM_CLIENT_TOKEN: TOKEN, MCP_PLATFORM_USER_HEADER_ALIASES: 'X-WeCom-Corp-Id' }),
    /MCP_PLATFORM_USER_HEADER_ALIASES.*X-WeCom-User-Id/u);
    // channel disabled does not require the alias (P8-05 compatibility).
    const disabled = await loadRemoteRuntimeConfig(root, {
      ...base, MCP_WECOM_CHANNEL_ENABLED: 'false', MCP_PLATFORM_USER_HEADER_ALIASES: '', MCP_WECOM_CLIENT_TOKEN: TOKEN });
    assert.equal(disabled.wecomChannelEnabled, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Connection } from '@salesforce/core';
import type { SalesforceConnectionFactory, SalesforceIdentityRoute } from '@sfoa/identity-runtime';
import { recordActionContextOutputSchema } from '@sfoa/mcp-provider-sfoa-context';
import { startRemoteMcpServer, type RemoteMcpServer } from '../http-server.js';
import { createTestIdentityRuntime, createTestRemoteConfig, TEST_CLIENT_TOKEN, TEST_DIAGNOSTIC_USERNAME,
  TEST_PLATFORM_USER_A, TEST_PLATFORM_USER_B, TEST_USERNAME_A, TEST_USERNAME_B, waitFor } from './helpers.js';

const ORG = '00D000000000001AAA';
const PROFILE = '00e000000000001AAA';
const RT = '012000000000001AAA';
const app = { appId: '06m000000000001AAA', developerName: 'Sales_App' };
type ObservedRead = Readonly<{ role: SalesforceIdentityRoute['connectionRole']; user: string; operation: string }>;

class FormConnectionFactory implements SalesforceConnectionFactory {
  public readonly creations: Array<{ route: SalesforceIdentityRoute; connection: Connection }> = [];
  public readonly reads: ObservedRead[] = [];
  public diagnosticOrg = ORG;
  public async create(route: SalesforceIdentityRoute): Promise<Connection> {
    const sequence = this.creations.length + 1;
    const observe = (operation: string): void => { this.reads.push({ role: route.connectionRole, user: route.salesforceUsername, operation }); };
    const layout = { id: '00h000000000001AAA', sections: [{ heading: 'Details', layoutRows: [{ layoutItems: [{
      required: true, editableForNew: true, editableForUpdate: true,
      layoutComponents: [{ componentType: 'Field', apiName: 'Name' }],
    }] }] }] };
    const connection = {
      instanceUrl: 'https://example.test', getApiVersion: () => '67.0',
      soap: { getUserInfo: async () => { observe('getUserInfo'); return {
        organizationId: route.connectionRole === 'DIAGNOSTIC' ? this.diagnosticOrg : ORG,
        profileId: PROFILE, userId: route.platformUserId === TEST_PLATFORM_USER_A ? '005000000000001AAA' : '005000000000002AAA',
      }; } },
      request: async (request: { method: string; url: string }) => {
        assert.equal(route.connectionRole, 'USER', 'business UI reads must not use the diagnostic account');
        assert.equal(request.method, 'GET', 'these HTTP cases authorize reads only');
        observe(request.url);
        if (request.url.includes('/apps?')) return { apps: [app] };
        if (request.url.includes('/picklist-values/')) return { picklistFieldValues: {} };
        if (request.url.includes('/object-info/')) return { apiName: 'Sample__c', label: 'Sample', labelPlural: 'Samples',
          createable: true, updateable: true, defaultRecordTypeId: RT,
          recordTypeInfos: { [RT]: { recordTypeId: RT, name: 'Business', available: true, defaultRecordTypeMapping: true } },
          fields: { Name: { apiName: 'Name', label: 'Name', dataType: 'String', required: false, createable: true, updateable: true } } };
        if (request.url.includes('/record-defaults/create/')) return { layout, record: {
          apiName: 'Sample__c', recordTypeId: RT, fields: { Name: { value: `${route.salesforceUsername}:${sequence}` } },
        } };
        throw new Error(`Unexpected USER read: ${request.url}`);
      },
      query: async (soql: string) => {
        assert.equal(route.connectionRole, 'DIAGNOSTIC');
        if (soql.includes(' FROM Profile ')) {
          observe('query:Profile');
          assert.match(soql, /SELECT Id, Name FROM Profile WHERE Id = '00e000000000001AAA' LIMIT 2/u);
          return { done: true, totalSize: 1, records: [{ Id: PROFILE, Name: 'Sales Profile' }] };
        }
        if (soql.includes(' FROM AppDefinition ')) {
          observe('query:AppDefinition');
          return { done: true, totalSize: 1, records: [{ DurableId: app.appId, DeveloperName: app.developerName, NamespacePrefix: null }] };
        }
        assert.match(soql, / FROM RecordType WHERE Id = '012000000000001AAA' AND SobjectType = 'Sample__c' LIMIT 2/u);
        observe('query:RecordType');
        return { done: true, totalSize: 1, records: [{ Id: RT, DeveloperName: 'Business', NamespacePrefix: null }] };
      },
      metadata: { list: async (queries: readonly { type: string }[]) => {
        assert.equal(route.connectionRole, 'DIAGNOSTIC'); observe(`metadata:list:${queries.map((query) => query.type).join(',')}`);
        assert.ok(queries.length > 0 && queries.length <= 3);
        assert.ok(queries.every((query) => ['Profile', 'CustomApplication', 'FlexiPage'].includes(query.type)));
        return [{ type: 'Profile', id: PROFILE, fullName: 'Sales_Profile', lastModifiedDate: '2026-11-06T01:00:00.000Z' },
          { type: 'CustomApplication', id: '02u000000000001AAA', fullName: 'Sales_App', lastModifiedDate: '2026-11-06T01:00:00.000Z' }]
          .filter((entry) => queries.some((query) => query.type === entry.type));
      }, read: async (type: string, name: string) => {
        assert.equal(route.connectionRole, 'DIAGNOSTIC', 'USER credentials must never gain Metadata API access'); observe(`metadata:${type}`);
        if (type === 'Profile') { assert.equal(name, 'Sales_Profile'); return { fullName: name,
          applicationVisibilities: [{ application: 'Sales_App', default: true, visible: true }] }; }
        if (type === 'CustomObject') { assert.equal(name, 'Sample__c'); return { fullName: name, actionOverrides: [] }; }
        assert.equal(type, 'CustomApplication'); assert.equal(name, 'Sales_App');
        return { fullName: name, actionOverrides: [], profileActionOverrides: [] };
      } },
    } as unknown as Connection;
    this.creations.push({ route, connection });
    return connection;
  }
  public roleCount(role: SalesforceIdentityRoute['connectionRole']): number {
    return this.creations.filter((entry) => entry.route.connectionRole === role).length;
  }
}

async function connect(server: RemoteMcpServer, user: string): Promise<Client> {
  const client = new Client({ name: 'precise-form-http', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(server.mcpUrl, { requestInit: {
    headers: { authorization: `Bearer ${TEST_CLIENT_TOKEN}`, 'x-platform-user-id': user },
  } }));
  return client;
}

async function context(client: Client, formContext?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'get_record_action_context', arguments: {
    objectApiName: 'Sample__c', action: 'CREATE', ...(formContext ? { formContext } : {}),
  } });
  assert.ok(!result.isError, JSON.stringify(result.structuredContent));
  // The host adds its separately governed managed-field policy description to
  // the provider envelope. The field context remains the provider's strict type.
  const { managedDmlFields: _managed, ...provider } = result.structuredContent as Record<string, unknown>;
  return recordActionContextOutputSchema.parse(provider);
}

async function cleaned(server: RemoteMcpServer, baseRoot: string): Promise<void> {
  await waitFor(() => server.getMetrics().activeRequests === 0);
  assert.equal(server.getMetrics().cleanupFailures, 0);
  assert.deepEqual(await readdir(baseRoot), [], 'both USER and nested DIAGNOSTIC workspaces must close after each request');
}

async function removeTestRoot(baseRoot: string): Promise<void> {
  assert.ok(path.resolve(baseRoot).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
  assert.match(path.basename(baseRoot), /^sfoa-form-http-/u);
  await rm(baseRoot, { recursive: true, force: true });
}

test('HTTP precise forms isolate lazy USER/DIAGNOSTIC scopes and reuse only owner-matched refinement structure', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-form-http-cache-'));
  const factory = new FormConnectionFactory();
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({ enabledTools: Object.freeze(['get_username', 'get_record_action_context']) }),
    identityRuntime: createTestIdentityRuntime(baseRoot, factory, undefined, TEST_DIAGNOSTIC_USERNAME),
  });
  const clients: Client[] = [];
  try {
    const a = await connect(server, TEST_PLATFORM_USER_A); clients.push(a);
    const listed = await a.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === 'get_record_action_context'));
    assert.equal(factory.creations.length, 0, 'initialize and discovery must remain Connection-free');
    await a.callTool({ name: 'get_username', arguments: {} });
    assert.equal(factory.creations.length, 0, 'route-only tools must remain Connection-free');
    await cleaned(server, baseRoot);

    const legacy = await context(a);
    assert.equal(legacy.formContext, undefined);
    assert.equal(factory.roleCount('USER'), 1);
    assert.equal(factory.roleCount('DIAGNOSTIC'), 0);
    assert.equal(factory.reads.some((read) => read.operation.startsWith('metadata:')), false);
    await cleaned(server, baseRoot);

    const start = await context(a, { entry: 'STANDARD', phase: 'START' });
    assert.equal(start.formContext?.status, 'READY', JSON.stringify(start.formContext));
    assert.equal(start.formContext?.configurationSource, 'FRESH');
    assert.equal(start.formContext?.appSource, 'PROFILE_DEFAULT');
    const ref = start.formContext?.structuralContextRef;
    assert.ok(ref);
    assert.equal(factory.roleCount('USER'), 2);
    assert.equal(factory.roleCount('DIAGNOSTIC'), 1);
    assert.equal(factory.creations.at(-1)?.route.salesforceUsername, TEST_DIAGNOSTIC_USERNAME);
    assert.notEqual(factory.creations.at(-1)?.connection, factory.creations.at(-2)?.connection);
    await cleaned(server, baseRoot);

    const metadataReads = factory.reads.filter((read) => read.role === 'DIAGNOSTIC').length;
    const refine = await context(a, { entry: 'STANDARD', phase: 'REFINE', structuralContextRef: ref });
    assert.equal(refine.formContext?.configurationSource, 'TASK_REUSE');
    assert.equal(refine.formContext?.structuralContextRef, ref);
    assert.equal(factory.roleCount('USER'), 3, 'a refinement still obtains a fresh request USER Connection');
    assert.equal(factory.roleCount('DIAGNOSTIC'), 1);
    assert.equal(factory.reads.filter((read) => read.role === 'DIAGNOSTIC').length, metadataReads);
    assert.notEqual(refine.fields?.find((field) => field.apiName === 'Name')?.defaultValue,
      start.fields?.find((field) => field.apiName === 'Name')?.defaultValue, 'business/default values must be reread, never cached with structure');
    await cleaned(server, baseRoot);

    const submit = await context(a, { entry: 'STANDARD', phase: 'SUBMIT', structuralContextRef: ref });
    assert.equal(submit.formContext?.configurationSource, 'FRESH');
    assert.notEqual(submit.formContext?.structuralContextRef, ref);
    assert.equal(factory.roleCount('USER'), 4);
    assert.equal(factory.roleCount('DIAGNOSTIC'), 2, 'submission ignores old structure references and verifies configuration again');
    await cleaned(server, baseRoot);

    const b = await connect(server, TEST_PLATFORM_USER_B); clients.push(b);
    const otherUser = await context(b, { entry: 'STANDARD', phase: 'REFINE', structuralContextRef: ref });
    assert.equal(otherUser.formContext?.configurationSource, 'FRESH');
    assert.notEqual(otherUser.formContext?.structuralContextRef, ref);
    assert.equal(factory.roleCount('USER'), 5);
    assert.equal(factory.roleCount('DIAGNOSTIC'), 3, 'same org/profile/object/type does not permit another user to reuse A structure reference');
    const businessRoutes = factory.creations.filter((entry) => entry.route.connectionRole === 'USER').map((entry) => entry.route.salesforceUsername);
    assert.deepEqual(businessRoutes, [TEST_USERNAME_A, TEST_USERNAME_A, TEST_USERNAME_A, TEST_USERNAME_A, TEST_USERNAME_B]);
    assert.equal(new Set(factory.creations.map((entry) => entry.connection)).size, factory.creations.length);
    await cleaned(server, baseRoot);
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await server.close();
    await removeTestRoot(baseRoot);
  }
});

test('HTTP precise form rejects a mismatched DIAGNOSTIC org before reading configuration and closes both scopes', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-form-http-org-'));
  const factory = new FormConnectionFactory(); factory.diagnosticOrg = '00D000000000099AAA';
  const server = await startRemoteMcpServer({
    config: createTestRemoteConfig({ enabledTools: Object.freeze(['get_record_action_context']) }),
    identityRuntime: createTestIdentityRuntime(baseRoot, factory, undefined, TEST_DIAGNOSTIC_USERNAME),
  });
  let client: Client | undefined;
  try {
    client = await connect(server, TEST_PLATFORM_USER_A);
    const output = await context(client, { entry: 'STANDARD', phase: 'START' });
    assert.equal(output.formContext?.status, 'UNKNOWN');
    assert.ok(output.formContext?.criticalUnknown.includes('FORM_METADATA_ORG_MISMATCH'));
    assert.equal(factory.roleCount('USER'), 1);
    assert.equal(factory.roleCount('DIAGNOSTIC'), 1);
    assert.deepEqual(factory.reads.filter((read) => read.role === 'DIAGNOSTIC').map((read) => read.operation), ['getUserInfo']);
    await cleaned(server, baseRoot);
  } finally {
    await client?.close().catch(() => undefined);
    await server.close();
    await removeTestRoot(baseRoot);
  }
});

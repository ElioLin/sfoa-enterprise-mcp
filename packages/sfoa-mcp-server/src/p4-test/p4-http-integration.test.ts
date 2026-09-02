import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  type Services,
  Toolset,
} from '@salesforce/mcp-provider-api';
import { parseDmlAllowlistJson } from '@sfoa/mcp-provider-sfoa-dml';
import {
  CwdExecutionGuard,
  createIdentityRuntime,
  RequestWorkspaceFactory,
  type RequestToolSource,
  type RuntimeLogEvent,
  type RuntimeLogger,
  type SalesforceConnectionFactory,
  type SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import { z } from 'zod';
import { startRemoteMcpServer } from '../http-server.js';
import {
  createTestRemoteConfig,
  mcpHeaders,
  TEST_CLIENT_TOKEN,
  TEST_PLATFORM_USER_A,
  TEST_PLATFORM_USER_B,
  TEST_USERNAME_A,
  TEST_USERNAME_B,
  toolResultText,
  waitFor,
} from '../test/helpers.js';

const DIAGNOSTIC_USERNAME = 'fixed-diagnostic@example.test';
const DEFAULT_RECORD_TYPE = '012000000000001AAA';

test('P4 Streamable HTTP keeps USER A/B context isolated and routes only diagnostic Tools to the fixed DIAGNOSTIC identity', async () => {
  const baseRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-p4-http-'));
  const connectionFactory = new P4ConnectionFactory();
  const logger = new RecordingLogger();
  const workspaceFactory = new RequestWorkspaceFactory({ baseRoot: path.join(baseRoot, 'requests') });
  const identity = {
    projectRoot: baseRoot,
    instanceUrl: 'https://example.test',
    primaryUsername: TEST_USERNAME_A,
    secondaryUsername: TEST_USERNAME_B,
    diagnosticUsername: DIAGNOSTIC_USERNAME,
    clientId: 'test-client',
    privateKeyPath: path.join(baseRoot, 'unused.pem'),
    platformUserA: TEST_PLATFORM_USER_A,
    platformUserB: TEST_PLATFORM_USER_B,
    concurrentRequests: 20,
    port: 3000,
  } as const;
  const identityRuntime = createIdentityRuntime(identity, {
    connectionFactory,
    workspaceFactory,
    cwdGuard: new CwdExecutionGuard(),
    logger,
  });
  const enabledTools = [
    'get_record_action_context',
    'run_diagnostic_tooling_query',
    'get_metadata_component_context',
    'run_soql_query',
    'create_record',
    'update_record',
  ] as const;
  const config = {
    ...createTestRemoteConfig({
      enabledTools,
      dmlAllowlist: parseDmlAllowlistJson(
        JSON.stringify([{ objectApiName: 'Lead', operations: ['CREATE', 'UPDATE'] }]),
      ),
      requestTimeoutMs: 10_000,
      toolTimeoutMs: 5_000,
    }),
    identity,
  };
  const source = new P4OfficialToolSource();
  const server = await startRemoteMcpServer({ config, identityRuntime, toolSource: source });
  const clients: Client[] = [];

  try {
    const clientA = await connectClient(server.mcpUrl, TEST_PLATFORM_USER_A);
    const clientB = await connectClient(server.mcpUrl, TEST_PLATFORM_USER_B);
    clients.push(clientA, clientB);
    const listed = await clientA.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), [...enabledTools]);
    assert.equal(connectionFactory.creations.length, 0, 'initialize and tools/list must not create USER or DIAGNOSTIC Connections');
    for (const tool of listed.tools.filter((entry) => entry.name.startsWith('get_') || entry.name.startsWith('run_diagnostic'))) {
      const properties = isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
      for (const forbidden of [
        'platformUserId', 'connectionRole', 'username', 'usernameOrAlias', 'salesforceUsername',
        'accessToken', 'instanceUrl', 'directory', 'sourceDir', 'manifest', 'useToolingApi',
      ]) {
        assert.equal(forbidden in properties, false, `${tool.name} exposed ${forbidden}`);
      }
    }

    const [contextA, contextB] = await Promise.all([
      clientA.callTool({
        name: 'get_record_action_context',
        arguments: { objectApiName: 'Lead', action: 'CREATE', username: DIAGNOSTIC_USERNAME },
      }),
      clientB.callTool({
        name: 'get_record_action_context',
        arguments: { objectApiName: 'Lead', action: 'CREATE', connectionRole: 'DIAGNOSTIC' },
      }),
    ]);
    assert.equal(contextA.isError, undefined);
    assert.equal(contextB.isError, undefined);
    assert.equal(structured(contextA).executionRole, 'USER');
    assert.equal(structured(contextB).executionRole, 'USER');
    assert.ok(fieldNames(contextA).includes('AOnly__c'));
    assert.equal(fieldNames(contextA).includes('BOnly__c'), false);
    assert.ok(fieldNames(contextB).includes('BOnly__c'));
    assert.equal(fieldNames(contextB).includes('AOnly__c'), false);

    const beforeDiagnosticQuery = connectionFactory.creations.length;
    const diagnosticQuery = await clientA.callTool({
      name: 'run_diagnostic_tooling_query',
      arguments: {
        query: 'SELECT Id FROM ApexClass LIMIT 5',
        useToolingApi: false,
        usernameOrAlias: TEST_USERNAME_A,
        connectionRole: 'USER',
      },
    });
    assert.equal(diagnosticQuery.isError, undefined);
    assert.equal(structured(diagnosticQuery).executionRole, 'DIAGNOSTIC');
    assert.equal(structured(diagnosticQuery).api, 'TOOLING');
    assert.match(JSON.stringify(structured(diagnosticQuery).records), /fixed-diagnostic@example\.test/u);
    const diagnosticInput = source.queryInputs.at(-1);
    assert.equal(diagnosticInput?.usernameOrAlias, DIAGNOSTIC_USERNAME);
    assert.equal(diagnosticInput?.useToolingApi, true);
    assert.equal(connectionFactory.creations.length, beforeDiagnosticQuery + 1);
    assert.equal(connectionFactory.creations.at(-1)?.role, 'DIAGNOSTIC');
    assert.equal(connectionFactory.creations.at(-1)?.username, DIAGNOSTIC_USERNAME);

    const businessQuery = await clientA.callTool({
      name: 'run_soql_query',
      arguments: { query: 'SELECT Id FROM Lead LIMIT 1', useToolingApi: false, usernameOrAlias: DIAGNOSTIC_USERNAME },
    });
    assert.equal(businessQuery.isError, undefined);
    assert.match(toolResultText(businessQuery), new RegExp(TEST_USERNAME_A.replaceAll('.', '\\.')));
    assert.doesNotMatch(toolResultText(businessQuery), /fixed-diagnostic/u);
    assert.equal(source.queryInputs.at(-1)?.usernameOrAlias, TEST_USERNAME_A);
    assert.equal(source.queryInputs.at(-1)?.useToolingApi, false);

    const metadata = await clientB.callTool({
      name: 'get_metadata_component_context',
      arguments: {
        metadataType: 'ValidationRule',
        fullName: 'Lead.Controlled_Rule',
        directory: 'C:\\forged',
        manifest: '..\\secret.xml',
        username: TEST_USERNAME_B,
      },
    });
    assert.equal(metadata.isError, undefined);
    assert.equal(structured(metadata).executionRole, 'DIAGNOSTIC');
    assert.equal(structured(metadata).metadataType, 'ValidationRule');
    assert.match(JSON.stringify(structured(metadata).files), /Controlled_Rule/u);
    assert.equal(source.retrieveInputs.at(-1)?.usernameOrAlias, DIAGNOSTIC_USERNAME);
    assert.ok(source.retrieveInputs.at(-1)?.manifest.startsWith(baseRoot));

    const created = await clientA.callTool({
      name: 'create_record',
      arguments: { objectApiName: 'Lead', fields: { LastName: 'P4 User Route' }, connectionRole: 'DIAGNOSTIC' },
    });
    const updated = await clientB.callTool({
      name: 'update_record',
      arguments: {
        objectApiName: 'Lead',
        recordId: '00Q000000000001AAA',
        fields: { Company: 'P4 User Route' },
        username: DIAGNOSTIC_USERNAME,
      },
    });
    assert.equal(created.isError, undefined);
    assert.equal(updated.isError, undefined);
    assert.deepEqual(connectionFactory.dmlRoles, ['USER', 'USER']);
    assert.deepEqual(connectionFactory.dmlUsernames, [TEST_USERNAME_A, TEST_USERNAME_B]);

    await waitFor(() => workspaceFactory.getMetrics().active === 0, 5_000);
    assert.equal(workspaceFactory.getMetrics().created, workspaceFactory.getMetrics().cleaned);
    assert.equal(server.getMetrics().cleanupFailures, 0);
    assert.equal(new Set(connectionFactory.creations.map((entry) => entry.connection)).size, connectionFactory.creations.length);
    assert.ok(connectionFactory.creations.some((entry) => entry.role === 'DIAGNOSTIC' && entry.username === DIAGNOSTIC_USERNAME));
    assert.equal(connectionFactory.creations.some((entry) => entry.role === 'DIAGNOSTIC' && entry.username !== DIAGNOSTIC_USERNAME), false);
    assert.ok(logger.events.some((event) =>
      event.executionRole === 'DIAGNOSTIC' &&
      event.platformUserId === TEST_PLATFORM_USER_A &&
      event.salesforceUsername === DIAGNOSTIC_USERNAME &&
      event.toolName === 'run_diagnostic_tooling_query'));
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await server.close();
    await rm(baseRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

type Creation = Readonly<{
  role: SalesforceIdentityRoute['connectionRole'];
  username: string;
  platformUserId: string;
  connection: Connection;
}>;

class P4ConnectionFactory implements SalesforceConnectionFactory {
  public readonly creations: Creation[] = [];
  public readonly dmlRoles: SalesforceIdentityRoute['connectionRole'][] = [];
  public readonly dmlUsernames: string[] = [];

  public async create(route: SalesforceIdentityRoute): Promise<Connection> {
    const userField = route.salesforceUsername === TEST_USERNAME_A ? 'AOnly__c' : 'BOnly__c';
    const connection = {
      getApiVersion: () => '67.0',
      identity: async () => ({ username: route.salesforceUsername }),
      query: async () => ({
        records: [{ Id: `business-${route.salesforceUsername}` }],
        totalSize: 1,
        done: true,
      }),
      tooling: {
        query: async () => ({
          records: [{ Id: '01p-tooling', ExecutedBy: route.salesforceUsername }],
          totalSize: 1,
          done: true,
        }),
      },
      request: async (request: { url: string }) => uiApiResponse(request.url, userField),
      sobject: () => ({
        create: async () => {
          this.dmlRoles.push(route.connectionRole);
          this.dmlUsernames.push(route.salesforceUsername);
          return { success: true, id: '00Q000000000009AAA', errors: [] };
        },
        update: async (record: { Id: string }) => {
          this.dmlRoles.push(route.connectionRole);
          this.dmlUsernames.push(route.salesforceUsername);
          return { success: true, id: record.Id, errors: [] };
        },
      }),
    } as unknown as Connection;
    this.creations.push({
      role: route.connectionRole,
      username: route.salesforceUsername,
      platformUserId: route.platformUserId,
      connection,
    });
    return connection;
  }
}

const querySchema = z.object({
  query: z.string(),
  usernameOrAlias: z.string(),
  directory: z.string(),
  useToolingApi: z.boolean().optional(),
});
type QueryInput = z.infer<typeof querySchema>;

const retrieveSchema = z.object({
  ignoreConflicts: z.boolean().optional(),
  sourceDir: z.array(z.string()).optional(),
  manifest: z.string().optional(),
  usernameOrAlias: z.string(),
  directory: z.string(),
});
type RetrieveInput = z.infer<typeof retrieveSchema>;

class P4OfficialToolSource implements RequestToolSource {
  public readonly queryInputs: QueryInput[] = [];
  public readonly retrieveInputs: Array<RetrieveInput & { manifest: string }> = [];

  public provideTools(services: Services): Promise<McpTool[]> {
    return Promise.resolve([
      new P4QueryTool(services, this.queryInputs),
      new P4RetrieveTool(services, this.retrieveInputs),
    ]);
  }
}

class P4QueryTool extends McpTool<typeof querySchema.shape> {
  public constructor(private readonly services: Services, private readonly inputs: QueryInput[]) { super(); }
  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.DATA]; }
  public getName(): string { return 'run_soql_query'; }
  public getConfig(): McpToolConfig<typeof querySchema.shape> {
    return {
      inputSchema: querySchema.shape,
      annotations: { openWorldHint: false, readOnlyHint: true },
    };
  }
  public async exec(input: QueryInput): Promise<CallToolResult> {
    const parsed = querySchema.parse(input);
    this.inputs.push(parsed);
    const connection = await this.services.getOrgService().getConnection(parsed.usernameOrAlias);
    const result = parsed.useToolingApi
      ? await connection.tooling.query(parsed.query)
      : await connection.query(parsed.query);
    return { content: [{ type: 'text', text: `SOQL query results:\n\n${JSON.stringify(result)}` }] };
  }
}

class P4RetrieveTool extends McpTool<typeof retrieveSchema.shape> {
  public constructor(
    private readonly services: Services,
    private readonly inputs: Array<RetrieveInput & { manifest: string }>,
  ) { super(); }
  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.METADATA]; }
  public getName(): string { return 'retrieve_metadata'; }
  public getConfig(): McpToolConfig<typeof retrieveSchema.shape> { return { inputSchema: retrieveSchema.shape }; }
  public async exec(input: RetrieveInput): Promise<CallToolResult> {
    const parsed = retrieveSchema.parse(input);
    if (!parsed.manifest) return { isError: true, content: [{ type: 'text', text: 'manifest required' }] };
    await this.services.getOrgService().getConnection(parsed.usernameOrAlias);
    this.inputs.push({ ...parsed, manifest: parsed.manifest });
    process.chdir(parsed.directory);
    const target = path.join(
      parsed.directory,
      'force-app',
      'main',
      'default',
      'objects',
      'Lead',
      'validationRules',
    );
    await mkdir(target, { recursive: true });
    await writeFile(
      path.join(target, 'Controlled_Rule.validationRule-meta.xml'),
      '<?xml version="1.0"?><ValidationRule><active>true</active></ValidationRule>',
      'utf8',
    );
    return { content: [{ type: 'text', text: 'Retrieve result: {"success":true}' }] };
  }
}

class RecordingLogger implements RuntimeLogger {
  public readonly events: RuntimeLogEvent[] = [];
  public log(event: RuntimeLogEvent): void { this.events.push(event); }
}

async function connectClient(url: URL, platformUserId: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: mcpHeaders(platformUserId, TEST_CLIENT_TOKEN) },
  });
  const client = new Client({ name: `p4-${platformUserId}`, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function uiApiResponse(url: string, userField: string): unknown {
  const fields = {
    Required__c: uiField('Required__c', 'Required', { required: true }),
    Name: uiField('Name', 'Lead Name'),
    [userField]: uiField(userField, userField),
  };
  if (url.includes('/picklist-values/')) return { picklistFieldValues: {} };
  if (url.includes('/object-info/Lead')) {
    return {
      apiName: 'Lead',
      label: 'Lead',
      labelPlural: 'Leads',
      defaultRecordTypeId: DEFAULT_RECORD_TYPE,
      fields,
      recordTypeInfos: {
        [DEFAULT_RECORD_TYPE]: {
          recordTypeId: DEFAULT_RECORD_TYPE,
          name: 'Master',
          available: true,
          defaultRecordTypeMapping: true,
        },
      },
    };
  }
  if (url.includes('/record-defaults/create/Lead')) {
    return {
      layout: {
        sections: [{
          heading: 'Information',
          layoutRows: [{
            layoutItems: Object.keys(fields).map((apiName) => ({
              editableForNew: true,
              editableForUpdate: true,
              required: apiName === 'Name',
              layoutComponents: [{ apiName, componentType: 'Field' }],
            })),
          }],
        }],
      },
      record: {
        apiName: 'Lead',
        recordTypeId: DEFAULT_RECORD_TYPE,
        fields: Object.fromEntries(Object.keys(fields).map((name) => [name, { value: null }])),
      },
    };
  }
  throw new Error(`Unexpected UI API URL: ${url}`);
}

function uiField(apiName: string, label: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    apiName,
    label,
    dataType: 'String',
    required: false,
    createable: true,
    updateable: true,
    controllerName: null,
    relationshipName: null,
    referenceToInfos: [],
    ...overrides,
  };
}

function structured(result: unknown): Record<string, unknown> {
  if (!isRecord(result) || !isRecord(result.structuredContent)) return {};
  return result.structuredContent;
}

function fieldNames(result: unknown): string[] {
  const fields = structured(result).fields;
  return Array.isArray(fields)
    ? fields.filter(isRecord).map((field) => String(field.apiName))
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

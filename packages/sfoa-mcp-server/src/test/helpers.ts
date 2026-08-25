import type { Connection } from '@salesforce/core';
import { parseDmlAllowlistJson } from '@sfoa/mcp-provider-sfoa-dml';
import {
  CwdExecutionGuard,
  createIdentityRuntime,
  NoopRuntimeLogger,
  RequestWorkspaceFactory,
  type IdentityRuntime,
  type IdentityRuntimeConfig,
  type RuntimeLogger,
  type SalesforceConnectionFactory,
  type SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import type { RemoteRuntimeConfig } from '../config.js';

export const TEST_CLIENT_TOKEN = 'p2-test-token-with-at-least-thirty-two-characters';
export const TEST_PLATFORM_USER_A = 'p2-user-a';
export const TEST_PLATFORM_USER_B = 'p2-user-b';
export const TEST_USERNAME_A = 'user-a@example.test';
export const TEST_USERNAME_B = 'user-b@example.test';

export const TEST_IDENTITY_CONFIG: IdentityRuntimeConfig = Object.freeze({
  projectRoot: process.cwd(),
  instanceUrl: 'https://example.test',
  primaryUsername: TEST_USERNAME_A,
  secondaryUsername: TEST_USERNAME_B,
  clientId: 'test-connected-app',
  privateKeyPath: 'test-private-key.pem',
  platformUserA: TEST_PLATFORM_USER_A,
  platformUserB: TEST_PLATFORM_USER_B,
  concurrentRequests: 50,
  port: 3000,
});

export type ConnectionCreation = Readonly<{
  sequence: number;
  platformUserId: string;
  salesforceUsername: string;
  connection: Connection;
}>;

export type DmlCall = Readonly<{
  sequence: number;
  platformUserId: string;
  salesforceUsername: string;
  operation: 'CREATE' | 'UPDATE';
  objectApiName: string;
  record: Readonly<Record<string, unknown>>;
}>;

export class RecordingConnectionFactory implements SalesforceConnectionFactory {
  public readonly creations: ConnectionCreation[] = [];
  public readonly dmlCalls: DmlCall[] = [];
  public readonly apiRequests: string[] = [];
  public instanceUrlForRoute = (route: SalesforceIdentityRoute): string =>
    `https://${route.platformUserId}.my.salesforce.com`;

  public async create(route: SalesforceIdentityRoute): Promise<Connection> {
    const sequence = this.creations.length + 1;
    const queryResult = {
      records: [{ Id: `${route.platformUserId}-${sequence}` }],
      totalSize: 1,
      done: true,
    };
    const createdRecordId = `00Q${String(sequence).padStart(12, '0')}AAA`;
    const connection = {
      instanceUrl: this.instanceUrlForRoute(route),
      getApiVersion: () => '65.0',
      identity: async () => ({
        username: route.salesforceUsername,
        user_id: `005-${route.platformUserId}`,
        organization_id: '00D-test',
      }),
      query: async (_query: string) => queryResult,
      tooling: { query: async (_query: string) => queryResult },
      request: async (request: string | Readonly<{ url?: string }>) => {
        const url = typeof request === 'string' ? request : request.url ?? '';
        this.apiRequests.push(url);
        return uiApiResponse(url);
      },
      sobject: (objectApiName: string) => ({
        create: async (record: Record<string, unknown>) => {
          this.dmlCalls.push({
            sequence,
            platformUserId: route.platformUserId,
            salesforceUsername: route.salesforceUsername,
            operation: 'CREATE',
            objectApiName,
            record: { ...record },
          });
          return { success: true, id: createdRecordId, errors: [] };
        },
        update: async (record: Record<string, unknown>) => {
          this.dmlCalls.push({
            sequence,
            platformUserId: route.platformUserId,
            salesforceUsername: route.salesforceUsername,
            operation: 'UPDATE',
            objectApiName,
            record: { ...record },
          });
          return { success: true, id: String(record.Id), errors: [] };
        },
      }),
    } as unknown as Connection;
    this.creations.push({
      sequence,
      platformUserId: route.platformUserId,
      salesforceUsername: route.salesforceUsername,
      connection,
    });
    return connection;
  }

  public countFor(platformUserId: string): number {
    return this.creations.filter((creation) => creation.platformUserId === platformUserId).length;
  }
}

const TEST_RECORD_TYPE_ID = '012000000000000AAA';

function uiApiResponse(url: string): unknown {
  if (/\/ui-api\/object-info\/Lead\/picklist-values\//u.test(url)) {
    return { picklistFieldValues: {} };
  }
  if (/\/ui-api\/object-info\/Lead(?:\?|$)/u.test(url)) {
    return {
      apiName: 'Lead',
      label: 'Lead',
      labelPlural: 'Leads',
      defaultRecordTypeId: TEST_RECORD_TYPE_ID,
      fields: {
        LastName: {
          apiName: 'LastName', label: 'Last Name', dataType: 'String', required: true,
          createable: true, updateable: true,
        },
        Company: {
          apiName: 'Company', label: 'Company', dataType: 'String', required: true,
          createable: true, updateable: true,
        },
      },
      recordTypeInfos: {
        [TEST_RECORD_TYPE_ID]: {
          recordTypeId: TEST_RECORD_TYPE_ID,
          name: 'Master',
          available: true,
          defaultRecordTypeMapping: true,
        },
      },
    };
  }
  if (/\/ui-api\/record-defaults\/create\/Lead/u.test(url)) {
    return {
      layout: {
        sections: [{
          heading: 'Required',
          layoutRows: [{
            layoutItems: [
              {
                editableForNew: true, editableForUpdate: true, required: true,
                layoutComponents: [{ apiName: 'LastName', componentType: 'Field' }],
              },
              {
                editableForNew: true, editableForUpdate: true, required: true,
                layoutComponents: [{ apiName: 'Company', componentType: 'Field' }],
              },
            ],
          }],
        }],
      },
      record: {
        apiName: 'Lead',
        recordTypeId: TEST_RECORD_TYPE_ID,
        fields: {},
      },
    };
  }
  throw new Error(`Unexpected test UI API request: ${url}`);
}

export function createTestIdentityRuntime(
  baseRoot: string,
  connectionFactory: SalesforceConnectionFactory = new RecordingConnectionFactory(),
  logger: RuntimeLogger = new NoopRuntimeLogger(),
): IdentityRuntime {
  const workspaceFactory = new RequestWorkspaceFactory({ baseRoot });
  return createIdentityRuntime(TEST_IDENTITY_CONFIG, {
    connectionFactory,
    workspaceFactory,
    cwdGuard: new CwdExecutionGuard(),
    logger,
  });
}

export function createTestRemoteConfig(
  overrides: Partial<Omit<RemoteRuntimeConfig, 'identity'>> = {},
): RemoteRuntimeConfig {
  return Object.freeze({
    identity: TEST_IDENTITY_CONFIG,
    controlPlane: Object.freeze({ mode: 'env' }),
    bindHost: '127.0.0.1',
    port: 0,
    mcpPath: '/mcp',
    authMode: 'internal_bearer',
    clientToken: TEST_CLIENT_TOKEN,
    platformUserHeader: 'X-Platform-User-Id',
    maxBodyBytes: 1_048_576,
    requestTimeoutMs: 2_000,
    toolTimeoutMs: 1_000,
    enabledTools: Object.freeze(['get_username', 'run_soql_query']),
    dmlAllowlist: parseDmlAllowlistJson(undefined),
    allowedHosts: Object.freeze([]),
    allowedOrigins: Object.freeze([]),
    useLoopbackHostDefaults: true,
    useLoopbackOriginDefaults: true,
    buntuIdentity: Object.freeze({
      enabled: false,
      timeoutMs: 5_000,
      rawTokenAuditEnabled: false,
    }),
    ...overrides,
  });
}

export function mcpHeaders(platformUserId?: string, token = TEST_CLIENT_TOKEN): Record<string, string> {
  return {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    ...(platformUserId ? { 'x-platform-user-id': platformUserId } : {}),
  };
}

export function initializeBody(id = 1): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'p2-test-client', version: '1.0.0' },
    },
  });
}

export function toolResultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return '';
  return result.content
    .filter((entry): entry is { type: 'text'; text: string } =>
      Boolean(
        entry &&
          typeof entry === 'object' &&
          'type' in entry &&
          entry.type === 'text' &&
          'text' in entry &&
          typeof entry.text === 'string',
      ),
    )
    .map((entry) => entry.text)
    .join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the expected test state.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import {
  createIdentityRuntime,
  JwtConnectionFactory,
  NoopRuntimeLogger,
  normalizeSalesforceIdentity,
  parseEnvFile,
  type SalesforceConnectionFactory,
  type SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import {
  createRecordInputSchema,
  dmlOutputSchema,
  parseDmlAllowlistJson,
  type DmlOutput,
  type SalesforceFieldValue,
} from '@sfoa/mcp-provider-sfoa-dml';
import type { RemoteRuntimeConfig } from '../config.js';
import { startRemoteMcpServer } from '../http-server.js';

export type P3LiveStatus = 'PASS' | 'FAIL' | 'NOT TESTED';

export type P3LiveGate = Readonly<{
  status: P3LiveStatus;
  detail?: string;
}>;

export type P3CleanupGate = P3LiveGate & Readonly<{
  attempted: number;
  deleted: number;
  failures: number;
}>;

export type P3LiveValidationReport = Readonly<{
  objectApiName: string;
  listedTools: readonly string[];
  toolsList: P3LiveGate;
  forbiddenToolsAbsent: P3LiveGate;
  remoteSchema: P3LiveGate;
  createA: P3LiveGate;
  createB: P3LiveGate;
  updateA: P3LiveGate;
  updateB: P3LiveGate;
  forgedPlatformUser: P3LiveGate;
  forgedUsername: P3LiveGate;
  connectionReuse: P3LiveGate;
  salesforceValidationFailure: P3LiveGate;
  salesforcePermissionDenial: P3LiveGate;
  cleanup: P3CleanupGate;
  salesforceCliUsed: false;
  runtimeDeleteToolExposed: false;
  overall: 'PASS' | 'FAIL';
}>;

type P3LiveInputs = Readonly<{
  createFields: Readonly<Record<string, SalesforceFieldValue>>;
  updateFields: Readonly<Record<string, SalesforceFieldValue>>;
  validationFailureFields: Readonly<Record<string, SalesforceFieldValue>>;
  permissionDenial?: Readonly<{
    objectApiName: string;
    fields: Readonly<Record<string, SalesforceFieldValue>>;
  }>;
}>;

type ConnectionMeasurement = Readonly<{
  platformUserId: string;
  salesforceUsername: string;
  connection: Connection;
}>;

type CreatedRecord = Readonly<{
  platformUserId: string;
  objectApiName: string;
  recordId: string;
}>;

type ConnectedClient = Readonly<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}>;

class MeasuringConnectionFactory implements SalesforceConnectionFactory {
  public readonly measurements: ConnectionMeasurement[] = [];

  public constructor(private readonly delegate: SalesforceConnectionFactory) {}

  public async create(route: SalesforceIdentityRoute): Promise<Connection> {
    const connection = await this.delegate.create(route);
    this.measurements.push(Object.freeze({
      platformUserId: route.platformUserId,
      salesforceUsername: route.salesforceUsername,
      connection,
    }));
    return connection;
  }
}

export function missingP3LiveVariables(config: RemoteRuntimeConfig): string[] {
  const missing: string[] = [];
  if (!config.identity.secondaryUsername) missing.push('SECOND_TEST_USER');
  if (!config.identity.testObject) missing.push('TEST_OBJECT');
  if (!config.clientToken) missing.push('MCP_CLIENT_TOKEN');
  return missing;
}

export async function loadP3LiveInputs(
  projectRoot: string,
  objectApiName: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<P3LiveInputs> {
  const localValues = await readOptionalEnvFile(path.join(projectRoot, '.env.local'));
  const value = (name: string): string | undefined => {
    const candidate = environment[name] ?? localValues[name];
    return candidate?.trim() ? candidate.trim() : undefined;
  };
  const marker = `SFoA-P3-${randomUUID()}`;
  const defaults = defaultFields(objectApiName, marker);
  const createFields = parseFields(value('P3_CREATE_FIELDS_JSON'), defaults?.create, objectApiName, marker, 'P3_CREATE_FIELDS_JSON');
  const updateFields = parseFields(value('P3_UPDATE_FIELDS_JSON'), defaults?.update, objectApiName, marker, 'P3_UPDATE_FIELDS_JSON');
  const validationFailureFields = parseFields(
    value('P3_VALIDATION_FAILURE_FIELDS_JSON'),
    defaults?.validationFailure,
    objectApiName,
    marker,
    'P3_VALIDATION_FAILURE_FIELDS_JSON',
  );
  const permissionObject = value('P3_PERMISSION_DENIAL_OBJECT');
  const permissionFieldsJson = value('P3_PERMISSION_DENIAL_FIELDS_JSON');
  if (Boolean(permissionObject) !== Boolean(permissionFieldsJson)) {
    throw new Error('P3_PERMISSION_DENIAL_OBJECT and P3_PERMISSION_DENIAL_FIELDS_JSON must both be set or both be omitted.');
  }
  const permissionDenial = permissionObject && permissionFieldsJson
    ? Object.freeze({
        objectApiName: permissionObject,
        fields: parseFields(permissionFieldsJson, undefined, permissionObject, marker, 'P3_PERMISSION_DENIAL_FIELDS_JSON'),
      })
    : undefined;
  return Object.freeze({
    createFields,
    updateFields,
    validationFailureFields,
    ...(permissionDenial ? { permissionDenial } : {}),
  });
}

export async function runP3LiveValidation(
  config: RemoteRuntimeConfig,
  inputs: P3LiveInputs,
): Promise<P3LiveValidationReport> {
  const objectApiName = config.identity.testObject;
  const secondaryUsername = config.identity.secondaryUsername;
  const clientToken = config.clientToken;
  const missing = missingP3LiveVariables(config);
  if (!objectApiName || !secondaryUsername || !clientToken || missing.length > 0) {
    throw new Error(`Missing mandatory P3 live inputs: ${missing.join(', ')}`);
  }

  const rules = [{ objectApiName, operations: ['CREATE', 'UPDATE'] as const }];
  if (inputs.permissionDenial && normalizeApiName(inputs.permissionDenial.objectApiName) !== normalizeApiName(objectApiName)) {
    rules.push({ objectApiName: inputs.permissionDenial.objectApiName, operations: ['CREATE', 'UPDATE'] as const });
  }
  const dmlAllowlist = parseDmlAllowlistJson(JSON.stringify(rules));
  const liveConfig: RemoteRuntimeConfig = Object.freeze({
    ...config,
    bindHost: '127.0.0.1',
    port: 0,
    enabledTools: Object.freeze(['create_record', 'update_record']),
    dmlAllowlist,
    allowedHosts: Object.freeze([]),
    allowedOrigins: Object.freeze([]),
    useLoopbackHostDefaults: true,
    useLoopbackOriginDefaults: true,
  });
  const measuringFactory = new MeasuringConnectionFactory(new JwtConnectionFactory({
    instanceUrl: config.identity.instanceUrl,
    clientId: config.identity.clientId,
    privateKeyPath: config.identity.privateKeyPath,
  }));
  const identityRuntime = createIdentityRuntime(config.identity, {
    connectionFactory: measuringFactory,
    logger: new NoopRuntimeLogger(),
  });
  const server = await startRemoteMcpServer({ config: liveConfig, identityRuntime });
  const clients: ConnectedClient[] = [];
  const createdRecords: CreatedRecord[] = [];
  let coreReport: Omit<P3LiveValidationReport, 'cleanup' | 'overall'> | undefined;
  let executionFailure: unknown;

  try {
    const clientA = await connectClient(
      server.mcpUrl,
      config.identity.platformUserA,
      clientToken,
      config.platformUserHeader,
      'p3-live-a',
    );
    const clientB = await connectClient(
      server.mcpUrl,
      config.identity.platformUserB,
      clientToken,
      config.platformUserHeader,
      'p3-live-b',
    );
    clients.push(clientA, clientB);

    const listed = await clientA.client.listTools();
    const listedTools = listed.tools.map((tool) => tool.name);
    const createTool = listed.tools.find((tool) => tool.name === 'create_record');
    const updateTool = listed.tools.find((tool) => tool.name === 'update_record');
    const createProperties = readProperties(createTool?.inputSchema);
    const updateProperties = readProperties(updateTool?.inputSchema);
    const toolsList = gate(sameArray(listedTools, ['create_record', 'update_record']), `Unexpected tools/list: ${listedTools.join(', ')}`);
    const forbiddenToolsAbsent = gate(
      !listedTools.some((name) => /delete|undelete|upsert|merge|bulk|rest|deploy|permission/iu.test(name)),
      'A forbidden mutation/admin Tool was exposed.',
    );
    const remoteSchema = gate(
      sameArray(Object.keys(createProperties).sort(), ['fields', 'objectApiName']) &&
        sameArray(Object.keys(updateProperties).sort(), ['fields', 'objectApiName', 'recordId']) &&
        !['platformUserId', 'username', 'usernameOrAlias', 'salesforceUsername', 'instanceUrl', 'accessToken', 'directory', 'operation']
          .some((name) => name in createProperties || name in updateProperties),
      'The DML schema exposed identity, org, operation, URL, or workspace controls.',
    );

    const runtimeMeasurementStart = measuringFactory.measurements.length;
    const createAResult = await callDml(clientA.client, 'create_record', {
      objectApiName,
      fields: inputs.createFields,
    });
    const createAMeasurement = measuringFactory.measurements.at(-1);
    const createAOutput = readOutput(createAResult);
    if (createAOutput?.success && createAOutput.recordId) {
      createdRecords.push({ platformUserId: config.identity.platformUserA, objectApiName, recordId: createAOutput.recordId });
    }
    const createA = mutationGate(
      createAResult,
      createAOutput,
      createAMeasurement,
      config.identity.platformUserA,
      config.identity.primaryUsername,
      'CREATE A',
    );

    const createBResult = await callDml(clientB.client, 'create_record', {
      objectApiName,
      fields: inputs.createFields,
    });
    const createBMeasurement = measuringFactory.measurements.at(-1);
    const createBOutput = readOutput(createBResult);
    if (createBOutput?.success && createBOutput.recordId) {
      createdRecords.push({ platformUserId: config.identity.platformUserB, objectApiName, recordId: createBOutput.recordId });
    }
    const createB = mutationRouteGate(
      createBResult,
      createBOutput,
      createBMeasurement,
      config.identity.platformUserB,
      secondaryUsername,
      'CREATE B',
    );

    const updateA = createAOutput?.recordId
      ? mutationGate(
          await callDml(clientA.client, 'update_record', {
            objectApiName,
            recordId: createAOutput.recordId,
            fields: inputs.updateFields,
          }),
          undefined,
          measuringFactory.measurements.at(-1),
          config.identity.platformUserA,
          config.identity.primaryUsername,
          'UPDATE A',
        )
      : failGate('UPDATE A was not attempted because CREATE A did not return a record ID.');
    const updateBRecordId = createBOutput?.recordId ?? createAOutput?.recordId;
    const updateBResult = updateBRecordId
      ? await callDml(clientB.client, 'update_record', {
            objectApiName,
            recordId: updateBRecordId,
            fields: inputs.updateFields,
          })
      : undefined;
    const updateBOutput = updateBResult ? readOutput(updateBResult) : undefined;
    const updateB = updateBResult
      ? mutationRouteGate(
          updateBResult,
          updateBOutput,
          measuringFactory.measurements.at(-1),
          config.identity.platformUserB,
          secondaryUsername,
          'UPDATE B',
        )
      : failGate('UPDATE B was not attempted because neither successful CREATE returned a record ID.');

    const forgedCreateResult = await callDml(clientA.client, 'create_record', {
      objectApiName,
      fields: inputs.createFields,
      platformUserId: config.identity.platformUserB,
      username: secondaryUsername,
      usernameOrAlias: secondaryUsername,
      salesforceUsername: secondaryUsername,
      instanceUrl: 'https://forged.invalid',
      accessToken: 'forged-token',
    });
    const forgedCreateOutput = readOutput(forgedCreateResult);
    if (forgedCreateOutput?.success && forgedCreateOutput.recordId) {
      createdRecords.push({
        platformUserId: config.identity.platformUserA,
        objectApiName,
        recordId: forgedCreateOutput.recordId,
      });
    }
    const forgedPlatformUser = mutationGate(
      forgedCreateResult,
      forgedCreateOutput,
      measuringFactory.measurements.at(-1),
      config.identity.platformUserA,
      config.identity.primaryUsername,
      'forged platformUserId',
    );
    const forgedUpdateRecordId = createBOutput?.recordId ?? createAOutput?.recordId;
    const forgedUsername = forgedUpdateRecordId
      ? mutationRouteGate(
          await callDml(clientB.client, 'update_record', {
            objectApiName,
            recordId: forgedUpdateRecordId,
            fields: inputs.updateFields,
            platformUserId: config.identity.platformUserA,
            username: config.identity.primaryUsername,
            salesforceUsername: config.identity.primaryUsername,
          }),
          undefined,
          measuringFactory.measurements.at(-1),
          config.identity.platformUserB,
          secondaryUsername,
          'forged username',
        )
      : failGate('Forged username UPDATE was not attempted because neither successful CREATE returned a record ID.');

    const validationResult = await callDml(clientA.client, 'create_record', {
      objectApiName,
      fields: inputs.validationFailureFields,
    });
    const validationOutput = readOutput(validationResult);
    const validationFailurePreserved =
      validationResult.isError === true &&
        validationOutput?.success === false &&
        validationOutput.errorCode === 'MCP_SALESFORCE_DML_FAILED' &&
        Boolean(validationOutput.salesforceErrors?.some((error) => error.errorCode !== 'UNKNOWN_SALESFORCE_ERROR' && error.message.length > 0));
    const salesforceValidationFailure: P3LiveGate = validationFailurePreserved
      ? Object.freeze({
          status: 'PASS',
          detail: `The Tool preserved the native Salesforce validation failure ${describeOutput(validationOutput)}.`,
        })
      : failGate(`Expected a native Salesforce validation/required-field failure; received ${describeOutput(validationOutput)}.`);

    let salesforcePermissionDenial: P3LiveGate;
    if (hasNativeAuthorizationDenial(updateBOutput)) {
      salesforcePermissionDenial = Object.freeze({
        status: 'PASS',
        detail: `User B UPDATE on User A's validator-owned record preserved Salesforce native authorization denial ${describeOutput(updateBOutput)}.`,
      });
    } else if (inputs.permissionDenial) {
      const permissionResult = await callDml(clientB.client, 'create_record', {
        objectApiName: inputs.permissionDenial.objectApiName,
        fields: inputs.permissionDenial.fields,
      });
      const permissionOutput = readOutput(permissionResult);
      if (permissionOutput?.success && permissionOutput.recordId) {
        createdRecords.push({
          platformUserId: config.identity.platformUserB,
          objectApiName: inputs.permissionDenial.objectApiName,
          recordId: permissionOutput.recordId,
        });
      }
      salesforcePermissionDenial = gate(
        permissionResult.isError === true &&
          permissionOutput?.errorCode === 'MCP_SALESFORCE_DML_FAILED' &&
          Boolean(permissionOutput.salesforceErrors?.length),
        `Expected Salesforce native object/FLS denial; received ${describeOutput(permissionOutput)}.`,
      );
    } else {
      salesforcePermissionDenial = Object.freeze({
        status: 'NOT TESTED',
        detail: 'No native authorization denial occurred and no P3 permission-denial fixture was configured.',
      });
    }

    const runtimeMeasurements = measuringFactory.measurements.slice(runtimeMeasurementStart);
    const reuseCount = runtimeMeasurements.length - new Set(runtimeMeasurements.map((item) => item.connection)).size;
    const connectionReuse = gate(reuseCount === 0, `Detected ${reuseCount} reused request Connection(s).`);
    coreReport = Object.freeze({
      objectApiName,
      listedTools: Object.freeze(listedTools),
      toolsList,
      forbiddenToolsAbsent,
      remoteSchema,
      createA,
      createB,
      updateA,
      updateB,
      forgedPlatformUser,
      forgedUsername,
      connectionReuse,
      salesforceValidationFailure,
      salesforcePermissionDenial,
      salesforceCliUsed: false as const,
      runtimeDeleteToolExposed: false as const,
    });
  } catch (error) {
    executionFailure = error;
  } finally {
    await Promise.allSettled(clients.map(({ client }) => client.close()));
    await server.close();
  }

  const cleanup = await cleanupCreatedRecords(identityRuntime, createdRecords);
  if (executionFailure) {
    throw new Error(
      `P3 live execution failed: ${safeMessage(executionFailure)}. Cleanup attempted=${cleanup.attempted}, deleted=${cleanup.deleted}, failures=${cleanup.failures}.`,
      { cause: executionFailure },
    );
  }
  if (!coreReport) throw new Error('P3 live validation did not produce a core report.');
  const requiredGates = [
    coreReport.toolsList,
    coreReport.forbiddenToolsAbsent,
    coreReport.remoteSchema,
    coreReport.createA,
    coreReport.createB,
    coreReport.updateA,
    coreReport.updateB,
    coreReport.forgedPlatformUser,
    coreReport.forgedUsername,
    coreReport.connectionReuse,
    coreReport.salesforceValidationFailure,
    cleanup,
  ];
  const overall = requiredGates.every((entry) => entry.status === 'PASS') &&
    coreReport.salesforcePermissionDenial.status !== 'FAIL'
    ? 'PASS'
    : 'FAIL';
  return Object.freeze({ ...coreReport, cleanup, overall });
}

async function cleanupCreatedRecords(
  identityRuntime: ReturnType<typeof createIdentityRuntime>,
  createdRecords: readonly CreatedRecord[],
): Promise<P3CleanupGate> {
  let deleted = 0;
  const errors: string[] = [];
  for (const [index, record] of [...createdRecords].reverse().entries()) {
    let scope: Awaited<ReturnType<typeof identityRuntime.scopeFactory.create>> | undefined;
    try {
      scope = await identityRuntime.scopeFactory.create(Object.freeze({
        platformUserId: record.platformUserId,
        correlationId: `p3-cleanup-${index + 1}-${randomUUID()}`,
      }));
      const result = await scope.connection.sobject(record.objectApiName).destroy(record.recordId);
      if (!result.success) {
        errors.push(`${record.objectApiName}/${record.recordId}: Salesforce cleanup returned success=false.`);
      } else {
        deleted += 1;
      }
    } catch (error) {
      errors.push(`${record.objectApiName}/${record.recordId}: ${safeMessage(error)}`);
    } finally {
      await scope?.close().catch((error: unknown) => {
        errors.push(`${record.objectApiName}/${record.recordId}: workspace cleanup failed: ${safeMessage(error)}`);
      });
    }
  }
  return Object.freeze({
    status: errors.length === 0 ? 'PASS' : 'FAIL',
    ...(errors.length > 0 ? { detail: errors.join(' | ') } : {}),
    attempted: createdRecords.length,
    deleted,
    failures: errors.length,
  });
}

async function connectClient(
  url: URL,
  platformUserId: string,
  clientToken: string,
  platformUserHeader: string,
  name: string,
): Promise<ConnectedClient> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        authorization: `Bearer ${clientToken}`,
        [platformUserHeader]: platformUserId,
      },
    },
  });
  const client = new Client({ name, version: '0.1.0-p3' });
  await client.connect(transport);
  return Object.freeze({ client, transport });
}

async function callDml(
  client: Client,
  name: 'create_record' | 'update_record',
  argumentsValue: Record<string, unknown>,
): Promise<CallToolResult> {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: argumentsValue }));
}

function mutationGate(
  result: CallToolResult,
  knownOutput: DmlOutput | undefined,
  measurement: ConnectionMeasurement | undefined,
  expectedPlatformUserId: string,
  expectedUsername: string,
  label: string,
): P3LiveGate {
  const output = knownOutput ?? readOutput(result);
  return gate(
    result.isError !== true &&
      output?.success === true &&
      Boolean(output.recordId) &&
      measurement?.platformUserId === expectedPlatformUserId &&
      normalizeSalesforceIdentity(measurement.salesforceUsername) === normalizeSalesforceIdentity(expectedUsername),
    `${label} failed or used an unexpected request identity: ${describeOutput(output)}.`,
  );
}

function mutationRouteGate(
  result: CallToolResult,
  knownOutput: DmlOutput | undefined,
  measurement: ConnectionMeasurement | undefined,
  expectedPlatformUserId: string,
  expectedUsername: string,
  label: string,
): P3LiveGate {
  const output = knownOutput ?? readOutput(result);
  const routeMatches =
    measurement?.platformUserId === expectedPlatformUserId &&
    normalizeSalesforceIdentity(measurement.salesforceUsername) === normalizeSalesforceIdentity(expectedUsername);
  const reachedSalesforce =
    (result.isError !== true && output?.success === true && Boolean(output.recordId)) ||
    (result.isError === true && output?.success === false && output.errorCode === 'MCP_SALESFORCE_DML_FAILED');
  if (!routeMatches || !reachedSalesforce) {
    return failGate(`${label} did not reach Salesforce through the expected request identity: ${describeOutput(output)}.`);
  }
  return Object.freeze({
    status: 'PASS',
    ...(output?.success === false
      ? { detail: `${label} used the expected identity and preserved Salesforce rejection ${describeOutput(output)}.` }
      : {}),
  });
}

function readOutput(result: CallToolResult): DmlOutput | undefined {
  const parsed = dmlOutputSchema.safeParse(result.structuredContent);
  return parsed.success ? parsed.data : undefined;
}

function describeOutput(output: DmlOutput | undefined): string {
  if (!output) return 'no structured DML output';
  return JSON.stringify({
    success: output.success,
    errorCode: output.errorCode,
    salesforceErrorCodes: output.salesforceErrors?.map((error) => error.errorCode),
  });
}

function hasNativeAuthorizationDenial(output: DmlOutput | undefined): boolean {
  if (output?.success !== false || output.errorCode !== 'MCP_SALESFORCE_DML_FAILED') return false;
  const codes = new Set([
    'INSUFFICIENT_ACCESS',
    'INSUFFICIENT_ACCESS_OR_READONLY',
    'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
    'INVALID_FIELD_FOR_INSERT_UPDATE',
  ]);
  return Boolean(output.salesforceErrors?.some((error) => codes.has(error.errorCode)));
}

function gate(condition: boolean, detail: string): P3LiveGate {
  return condition ? Object.freeze({ status: 'PASS' }) : failGate(detail);
}

function failGate(detail: string): P3LiveGate {
  return Object.freeze({ status: 'FAIL', detail });
}

function readProperties(schema: unknown): Record<string, unknown> {
  return isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeApiName(value: string): string {
  return value.toLocaleLowerCase('en-US');
}

function parseFields(
  json: string | undefined,
  fallback: Readonly<Record<string, SalesforceFieldValue>> | undefined,
  objectApiName: string,
  marker: string,
  environmentName: string,
): Readonly<Record<string, SalesforceFieldValue>> {
  if (!json && !fallback) {
    throw new Error(`${environmentName} is required for TEST_OBJECT=${objectApiName}; only Lead, Account, Contact, and Opportunity have built-in fixtures.`);
  }
  let decoded: unknown = fallback;
  if (json) {
    try {
      decoded = JSON.parse(json.replaceAll('{{RUN_ID}}', marker)) as unknown;
    } catch {
      throw new Error(`${environmentName} must be valid JSON.`);
    }
  }
  const parsed = createRecordInputSchema.safeParse({ objectApiName, fields: decoded });
  if (!parsed.success) {
    throw new Error(`${environmentName} is invalid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  return Object.freeze({ ...parsed.data.fields });
}

function defaultFields(
  objectApiName: string,
  marker: string,
): Readonly<{
  create: Readonly<Record<string, SalesforceFieldValue>>;
  update: Readonly<Record<string, SalesforceFieldValue>>;
  validationFailure: Readonly<Record<string, SalesforceFieldValue>>;
}> | undefined {
  switch (normalizeApiName(objectApiName)) {
    case 'lead':
      return Object.freeze({
        create: Object.freeze({ LastName: marker, Company: 'SFoA P3 Validation' }),
        update: Object.freeze({ Company: `Updated ${marker}` }),
        validationFailure: Object.freeze({ Company: `Missing LastName ${marker}` }),
      });
    case 'account':
      return Object.freeze({
        create: Object.freeze({ Name: marker }),
        update: Object.freeze({ Name: `Updated ${marker}` }),
        validationFailure: Object.freeze({ Description: `Missing Name ${marker}` }),
      });
    case 'contact':
      return Object.freeze({
        create: Object.freeze({ LastName: marker }),
        update: Object.freeze({ LastName: `Updated ${marker}` }),
        validationFailure: Object.freeze({ Description: `Missing LastName ${marker}` }),
      });
    case 'opportunity':
      return Object.freeze({
        create: Object.freeze({ Name: marker, StageName: 'Prospecting', CloseDate: nextMonthDate() }),
        update: Object.freeze({ Name: `Updated ${marker}` }),
        validationFailure: Object.freeze({ Description: `Missing required values ${marker}` }),
      });
    default:
      return undefined;
  }
}

function nextMonthDate(): string {
  const value = new Date();
  value.setUTCMonth(value.getUTCMonth() + 1);
  return value.toISOString().slice(0, 10);
}

async function readOptionalEnvFile(file: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(file, 'utf8'));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return {};
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import {
  createIdentityRuntime,
  JwtConnectionFactory,
  JsonLineRuntimeLogger,
  normalizeSalesforceIdentity,
  type SalesforceConnectionFactory,
  type SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import {
  MySqlIdentityRepository,
  AsyncAuditPipeline,
  assertAllMigrationsApplied,
  auditDatabaseConfig,
  createControlPlaneDatabase,
  DatabaseRuntimeLogger,
  DEFAULT_AUDIT_FLUSH_TIMEOUT_MS,
  freezeSnapshot,
  MySqlAuditBatchSink,
  MySqlControlPlaneStore,
  type ControlPlaneDatabaseClient,
  type RequestPolicySnapshot,
} from '@sfoa/control-plane';
import {
  DESCRIBE_SOBJECT_DEFAULT_FIELD_LIMIT,
  DESCRIBE_SOBJECT_MAX_CHILD_RELATIONSHIPS,
  DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES,
  LIST_SOBJECTS_MAX_LIMIT,
  SFOA_DATA_TOOL_NAMES,
} from '@sfoa/mcp-provider-sfoa-data';
import { loadRemoteRuntimeConfig } from '../config.js';
import { startRemoteMcpServer } from '../http-server.js';
import {
  MySqlRuntimeDiscoveryPolicySnapshotSource,
  MySqlRuntimePolicySnapshotSource,
  type RuntimePolicySnapshotSource,
} from '../policy-snapshot.js';

export type P9LiveStatus = 'PASS' | 'FAIL' | 'NOT TESTED';

export type P9LiveGate = Readonly<{
  status: P9LiveStatus;
  detail: Readonly<Record<string, unknown>>;
}>;

export type P9LiveValidationReport = Readonly<{
  phase: 'P9';
  task: 'T1';
  generatedAt: string;
  objectApiName: string;
  filter: string;
  /**
   * Where the Data Tool enablement came from for this run. The Tools deliberately have no
   * `sfoa_tool_control` row yet, so a live run extends the MySQL snapshot additively instead
   * of writing to the Control Plane. The report states it rather than implying a real grant.
   */
  enablementSource: string;
  toolInventory: P9LiveGate;
  requestIdentity: P9LiveGate;
  listSobjects: P9LiveGate;
  describeSobject: P9LiveGate;
  schemaSelfRepair: P9LiveGate;
  credentialSafety: P9LiveGate;
  connections: Readonly<{
    total: number;
    distinctSalesforceUsernames: readonly string[];
  }>;
  overall: 'PASS' | 'PARTIAL' | 'FAIL';
}>;

const PLATFORM_USER_VARIABLE = 'P9_LIVE_PLATFORM_USER';

/** Tool input keys that would let a caller pick an identity, an endpoint or a credential. */
const FORBIDDEN_INPUT_KEYS = Object.freeze([
  'username', 'usernameoralias', 'salesforceusername', 'platformuserid', 'accesstoken', 'refreshtoken',
  'token', 'password', 'clientsecret', 'privatekey', 'instanceurl', 'directory', 'apiversion',
]);

type ConnectionMeasurement = Readonly<{
  platformUserId: string;
  salesforceUsername: string;
  connection: Connection;
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

/**
 * Adds the P9 Data Tool names to whatever the Control Plane snapshot already grants.
 *
 * This is a validation-harness affordance, not a runtime behaviour: the Data Tools ship
 * default-disabled and an Admin grants them through the Control Plane. Keeping the grant out
 * of the database means a live run never leaves the local Control Plane altered.
 */
class AdditiveDataToolsPolicySnapshotSource implements RuntimePolicySnapshotSource {
  public constructor(
    private readonly delegate: RuntimePolicySnapshotSource,
    private readonly extraToolNames: readonly string[],
  ) {}

  public async load(platformUserId: string): Promise<RequestPolicySnapshot> {
    const snapshot = await this.delegate.load(platformUserId);
    return freezeSnapshot({
      ...snapshot,
      enabledTools: [...new Set([...snapshot.enabledTools, ...this.extraToolNames])],
    });
  }
}

type LiveSobjectEntry = Readonly<{
  name: string;
  label: string;
  labelPlural: string;
  keyPrefix: string | null;
  custom: boolean;
  queryable: boolean;
  createable: boolean;
  updateable: boolean;
  searchable: boolean;
}>;

type LivePicklistValue = Readonly<{ value: string; label: string; active: boolean; defaultValue: boolean }>;

type LiveField = Readonly<{
  name: string;
  label: string;
  type: string;
  nillable: boolean;
  createable: boolean;
  updateable: boolean;
  filterable: boolean;
  sortable: boolean;
  custom: boolean;
  deprecatedAndHidden: boolean;
  referenceTo: readonly string[];
  relationshipName: string | null;
  picklistValues: readonly LivePicklistValue[];
}>;

type LiveChildRelationship = Readonly<{
  childSObject: string;
  field: string;
  relationshipName: string | null;
  cascadeDelete: boolean;
  restrictedDelete: boolean;
  deprecatedAndHidden: boolean;
}>;

export function missingP9LiveVariables(environment: NodeJS.ProcessEnv = process.env): string[] {
  return environment[PLATFORM_USER_VARIABLE]?.trim() ? [] : [PLATFORM_USER_VARIABLE];
}

export async function runP9LiveValidation(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<P9LiveValidationReport> {
  const missing = missingP9LiveVariables(environment);
  if (missing.length > 0) throw new Error(`Missing mandatory P9 live inputs: ${missing.join(', ')}`);
  const platformUserId = environment[PLATFORM_USER_VARIABLE]?.trim() as string;
  const config = await loadRemoteRuntimeConfig(projectRoot, environment);
  const controlPlane = config.controlPlane;
  if (controlPlane.mode !== 'mysql') {
    throw new Error('The P9 live validation requires the MySQL Control Plane so the P7 Audit chain is persisted.');
  }
  const databaseConfig = controlPlane.database;
  if (!databaseConfig) throw new Error('The P9 live validation requires the MySQL Control Plane database configuration.');
  if (!config.clientToken) throw new Error('The P9 live validation requires an independent internal client token.');
  const clientToken = config.clientToken;
  const objectApiName = environment.P9_LIVE_OBJECT?.trim() || config.identity.testObject || 'Account';
  const filter = environment.P9_LIVE_FILTER?.trim() || objectApiName.slice(0, 3);
  const dataToolNames = [...SFOA_DATA_TOOL_NAMES];
  const enablementSource =
    `the MySQL Control Plane snapshot for ${platformUserId}, extended additively with `
    + `${dataToolNames.join(', ')} for this run (the Tools have no sfoa_tool_control row)`;
  const generatedAt = new Date().toISOString();

  const database = createControlPlaneDatabase(databaseConfig);
  const auditDatabase = createControlPlaneDatabase(auditDatabaseConfig(databaseConfig));
  const store = new MySqlControlPlaneStore(database);
  const fallbackLogger = new JsonLineRuntimeLogger();
  const auditPipeline = new AsyncAuditPipeline(new MySqlAuditBatchSink(auditDatabase), fallbackLogger);
  const databaseLogger = new DatabaseRuntimeLogger(
    store.repositories.audits,
    fallbackLogger,
    store.repositories.auditTraces,
    auditPipeline,
  );
  const measuringFactory = new MeasuringConnectionFactory(new JwtConnectionFactory({
    instanceUrl: config.identity.instanceUrl,
    clientId: config.identity.clientId,
    privateKeyPath: config.identity.privateKeyPath,
  }));
  const identityRuntime = createIdentityRuntime(config.identity, {
    connectionFactory: measuringFactory,
    identityRepository: new MySqlIdentityRepository(database),
    logger: databaseLogger,
  });
  const policySnapshotSource = new MySqlRuntimePolicySnapshotSource(database);
  const snapshot = await policySnapshotSource.load(platformUserId);
  const route = snapshot.identityRoute;

  if (route === null || route.enabled !== true) {
    await closeQuietly(store, database, auditDatabase, auditPipeline);
    const reason = `Identity route ${platformUserId} is ${route === null ? 'absent' : 'disabled'} in this Control Plane.`;
    return Object.freeze({
      phase: 'P9',
      task: 'T1',
      generatedAt,
      objectApiName,
      filter,
      enablementSource,
      toolInventory: notTested(reason),
      requestIdentity: notTested(reason),
      listSobjects: notTested(reason),
      describeSobject: notTested(reason),
      schemaSelfRepair: notTested(reason),
      credentialSafety: notTested('No Tool call was made.'),
      connections: Object.freeze({ total: 0, distinctSalesforceUsernames: Object.freeze([]) }),
      overall: 'PARTIAL',
    });
  }

  await assertAllMigrationsApplied(database);
  const server = await startRemoteMcpServer({
    // The live harness binds an ephemeral loopback port, so it accepts the loopback Host and
    // Origin values rather than the deployed allowlist.
    config: Object.freeze({
      ...config,
      bindHost: '127.0.0.1',
      port: 0,
      allowedHosts: Object.freeze([]),
      allowedOrigins: Object.freeze([]),
      useLoopbackHostDefaults: true,
      useLoopbackOriginDefaults: true,
    }),
    identityRuntime,
    policySnapshotSource: new AdditiveDataToolsPolicySnapshotSource(policySnapshotSource, dataToolNames),
    discoveryPolicySnapshotSource: new MySqlRuntimeDiscoveryPolicySnapshotSource(database),
  });
  const expectedNames = [...new Set([...snapshot.enabledTools, ...dataToolNames])].sort();
  const results: CallToolResult[] = [];

  try {
    const transport = new StreamableHTTPClientTransport(server.mcpUrl, {
      requestInit: {
        headers: {
          authorization: `Bearer ${clientToken}`,
          [config.platformUserHeader]: platformUserId,
        },
      },
    });
    const client = new Client({ name: 'p9-live-validation', version: '0.1.0-p9' });
    await client.connect(transport);
    try {
      const toolInventory = await runToolInventory(client, expectedNames, dataToolNames);
      // The first Tool call is what opens the request-scoped Connection. Every independent
      // org fact below is read through that same live, already-authenticated Connection, so a
      // disagreement is a disagreement about Salesforce's own answer, not about a fixture.
      const bounded = await call(client, results, 'list_sobjects', { filter, limit: 5 });
      const connection = await establishedConnection(measuringFactory);
      if (connection === null) {
        throw new Error('The list_sobjects request did not create a request-scoped Salesforce Connection.');
      }
      const liveIdentity = await readIdentity(connection);
      const requestIdentity = gate(
        normalizeSalesforceIdentity(route.salesforceUsername) === normalizeSalesforceIdentity(liveIdentity.username ?? ''),
        {
          routedUsername: normalizeSalesforceIdentity(route.salesforceUsername),
          liveUsername: normalizeSalesforceIdentity(liveIdentity.username ?? ''),
          routeEnabled: route.enabled,
        },
        'Salesforce answered a different user than the routed identity.',
      );
      const realEntries = sortEntries(await readDescribeGlobal(connection));
      const listSobjects = await runListSobjects(client, results, bounded, filter, realEntries);
      const describeSobject = await runDescribeSobject(client, results, objectApiName, connection);
      const schemaSelfRepair = await runSchemaSelfRepair(client, results, objectApiName);
      const credentialSafety = runCredentialSafety(results, clientToken, await readAccessToken(connection));
      const usernames = [...new Set(measuringFactory.measurements.map((entry) => entry.salesforceUsername))];

      return Object.freeze({
        phase: 'P9',
        task: 'T1',
        generatedAt,
        objectApiName,
        filter,
        enablementSource,
        toolInventory,
        requestIdentity,
        listSobjects,
        describeSobject,
        schemaSelfRepair,
        credentialSafety,
        connections: Object.freeze({
          total: measuringFactory.measurements.length,
          distinctSalesforceUsernames: Object.freeze(usernames),
        }),
        overall: combine([toolInventory, requestIdentity, listSobjects, describeSobject, schemaSelfRepair, credentialSafety]),
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    await server.close();
    await closeQuietly(store, database, auditDatabase, auditPipeline);
  }
}

async function runToolInventory(
  client: Client,
  expectedNames: readonly string[],
  dataToolNames: readonly string[],
): Promise<P9LiveGate> {
  const listed = await client.listTools();
  const advertisedNames = listed.tools.map((tool) => tool.name).sort();
  const dataTools = listed.tools.filter((tool) => dataToolNames.includes(tool.name));
  const leakedKeys = dataTools.flatMap((tool) => Object.keys(tool.inputSchema.properties ?? {})
    .filter((key) => FORBIDDEN_INPUT_KEYS.includes(key.toLowerCase()))
    .map((key) => `${tool.name}.${key}`));
  const annotationsOk = dataTools.every((tool) => tool.annotations?.readOnlyHint === true
    && tool.annotations.destructiveHint === false
    && tool.annotations.idempotentHint === true
    && tool.annotations.openWorldHint === true);
  const allAdvertised = dataToolNames.every((name) => advertisedNames.includes(name));

  return gate(
    allAdvertised && sameArray(advertisedNames, expectedNames) && leakedKeys.length === 0 && annotationsOk,
    {
      advertised: advertisedNames,
      expectedFromSnapshot: expectedNames,
      dataToolsAdvertised: dataTools.map((tool) => tool.name),
      dataToolInputKeys: Object.fromEntries(
        dataTools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {}).sort()]),
      ),
      forbiddenInputKeys: leakedKeys,
      readOnlyAnnotations: annotationsOk,
    },
    'The advertised Tool inventory disagreed with the grant, or a Data Tool exposed a forbidden input key.',
  );
}

async function runListSobjects(
  client: Client,
  results: CallToolResult[],
  bounded: CallToolResult,
  filter: string,
  allEntries: readonly LiveSobjectEntry[],
): Promise<P9LiveGate> {
  const boundedOutput = outputOf(bounded);
  if (boundedOutput === undefined) return failGate('list_sobjects returned no structured content.');
  if (boundedOutput.success !== true) {
    return failGate(`list_sobjects failed live: ${String(boundedOutput.errorCode ?? 'no error code')}.`);
  }
  const realMatching = allEntries.filter((entry) => startsWithFilter(entry.name, filter));
  const entries = readEntries(boundedOutput.sobjects);
  const expectedTotal = realMatching.length;
  const expectedReturned = Math.min(5, expectedTotal);
  const byName = new Map(realMatching.map((entry) => [entry.name, entry]));
  const factMismatches = entries.flatMap((entry) => {
    const real = byName.get(String(entry.name));
    if (real === undefined) return [`${String(entry.name)} does not match the filter in the org`];
    return (['label', 'labelPlural', 'keyPrefix', 'custom', 'queryable', 'createable', 'updateable', 'searchable'] as const)
      .filter((key) => entry[key] !== real[key])
      .map((key) => `${String(entry.name)}.${key}: tool=${JSON.stringify(entry[key])} org=${JSON.stringify(real[key])}`);
  });
  const filterRespected = entries.every((entry) => startsWithFilter(String(entry.name), filter));

  // A limit at or above the matching count must be able to declare the result complete.
  const wideLimit = Math.min(LIST_SOBJECTS_MAX_LIMIT, Math.max(1, expectedTotal));
  const wide = await call(client, results, 'list_sobjects', { filter, limit: wideLimit });
  const wideOutput = outputOf(wide);
  const wideReturned = readEntries(wideOutput?.sobjects).length;
  const wideExpected = Math.min(wideLimit, expectedTotal);
  const truncationFacts = boundedOutput.totalCount === expectedTotal
    && boundedOutput.returnedCount === expectedReturned
    && boundedOutput.truncated === expectedTotal > expectedReturned
    && (boundedOutput.truncated !== true || typeof boundedOutput.hint === 'string')
    && wideOutput?.totalCount === expectedTotal
    && wideReturned === wideExpected
    && wideOutput.truncated === expectedTotal > wideExpected
    && (wideOutput.truncated !== true || typeof wideOutput.hint === 'string');

  return gate(
    factMismatches.length === 0 && filterRespected && entries.length === expectedReturned && truncationFacts,
    {
      filter,
      orgMatchingCount: expectedTotal,
      bounded: {
        limit: 5,
        returned: entries.length,
        totalCount: boundedOutput.totalCount,
        truncated: boundedOutput.truncated,
        hintPresent: typeof boundedOutput.hint === 'string',
        executionRole: boundedOutput.executionRole,
      },
      widened: {
        limit: wideLimit,
        returned: wideReturned,
        totalCount: wideOutput?.totalCount,
        truncated: wideOutput?.truncated,
        hintPresent: typeof wideOutput?.hint === 'string',
      },
      sample: entries.slice(0, 5).map((entry) => String(entry.name)),
      factMismatches: factMismatches.slice(0, 10),
      filterRespected,
    },
    'list_sobjects facts, filter or truncation declaration disagreed with the org.',
  );
}

async function runDescribeSobject(
  client: Client,
  results: CallToolResult[],
  objectApiName: string,
  connection: Connection,
): Promise<P9LiveGate> {
  const real = await readDescribe(connection, objectApiName);
  const realFieldNames = real.fields.map((field) => field.name);
  const expectedFields = Math.min(DESCRIBE_SOBJECT_DEFAULT_FIELD_LIMIT, real.fields.length);
  const expectedChildren = Math.min(DESCRIBE_SOBJECT_MAX_CHILD_RELATIONSHIPS, real.childRelationships.length);

  const full = await call(client, results, 'describe_sobject', { objectApiName });
  const fullOutput = outputOf(full);
  if (fullOutput === undefined) return failGate('describe_sobject returned no structured content.');
  if (fullOutput.success !== true) {
    return failGate(`describe_sobject failed live: ${String(fullOutput.errorCode ?? 'no error code')}.`);
  }
  const fields = readEntries(fullOutput.fields);
  const children = readEntries(fullOutput.childRelationships);
  const realByField = new Map(real.fields.map((field) => [field.name, field]));
  const fieldMismatches = fields.flatMap((field) => {
    const expected = realByField.get(String(field.apiName));
    if (expected === undefined) return [`${String(field.apiName)} is not an org field of ${objectApiName}`];
    const scalars = (['label', 'type', 'nillable', 'createable', 'updateable', 'filterable', 'sortable', 'custom',
      'deprecatedAndHidden', 'relationshipName'] as const)
      .filter((key) => field[key] !== expected[key])
      .map((key) => `${String(field.apiName)}.${key}: tool=${JSON.stringify(field[key])} org=${JSON.stringify(expected[key])}`);
    const references = sameArray(readStringArray(field.referenceTo), [...expected.referenceTo])
      ? []
      : [`${String(field.apiName)}.referenceTo: tool=${JSON.stringify(field.referenceTo)} org=${JSON.stringify(expected.referenceTo)}`];
    const expectedPicklist = expected.picklistValues.slice(0, DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES);
    const picklistDiffs = picklistDifferences(readEntries(field.picklistValues), expectedPicklist);
    const picklist = picklistDiffs.length === 0
      ? []
      : [`${String(field.apiName)}.picklistValues: ${picklistDiffs.join(', ')}`];
    const picklistTruncation = field.picklistValuesTruncated
      === (expected.picklistValues.length > DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES)
      ? []
      : [`${String(field.apiName)}.picklistValuesTruncated disagreed with the org (org has ${expected.picklistValues.length})`];
    return [...scalars, ...references, ...picklist, ...picklistTruncation];
  });
  const childMismatches = children.flatMap((child, index) => {
    const expected = real.childRelationships[index];
    if (expected === undefined) return [`child relationship ${index} is not present in the org`];
    return (['childSObject', 'field', 'relationshipName', 'cascadeDelete', 'restrictedDelete', 'deprecatedAndHidden'] as const)
      .filter((key) => child[key] !== expected[key])
      .map((key) => `child[${index}].${key}: tool=${JSON.stringify(child[key])} org=${JSON.stringify(expected[key])}`);
  });
  const headerMismatches = (['label', 'labelPlural', 'keyPrefix', 'custom', 'queryable', 'createable',
    'updateable', 'searchable'] as const)
    .filter((key) => fullOutput[key] !== real[key])
    .map((key) => `${key}: tool=${JSON.stringify(fullOutput[key])} org=${JSON.stringify(real[key])}`);

  const fullFacts = fullOutput.totalFields === real.fields.length
    && fullOutput.returnedFields === expectedFields
    && fields.length === expectedFields
    && fullOutput.truncated === real.fields.length > expectedFields
    && sameArray(fields.map((field) => String(field.apiName)), realFieldNames.slice(0, expectedFields))
    && fullOutput.totalChildRelationships === real.childRelationships.length
    && fullOutput.returnedChildRelationships === expectedChildren
    && children.length === expectedChildren
    && fullOutput.fieldsIncluded === true
    && fullOutput.objectApiName === objectApiName;

  const capped = await call(client, results, 'describe_sobject', { objectApiName, fieldLimit: 3 });
  const cappedOutput = outputOf(capped);
  const cappedFields = readEntries(cappedOutput?.fields);
  const capFacts = cappedOutput?.returnedFields === 3
    && cappedFields.length === 3
    && cappedOutput.totalFields === real.fields.length
    && cappedOutput.truncated === true
    && typeof cappedOutput.hint === 'string'
    && sameArray(cappedFields.map((field) => String(field.apiName)), realFieldNames.slice(0, 3));

  const excluded = await call(client, results, 'describe_sobject', { objectApiName, includeFields: false });
  const excludedOutput = outputOf(excluded);
  const excludeFacts = excludedOutput?.fieldsIncluded === false && excludedOutput.fields === undefined;

  return gate(
    fieldMismatches.length === 0 && childMismatches.length === 0 && headerMismatches.length === 0
      && fullFacts && capFacts && excludeFacts,
    {
      objectApiName,
      orgFieldCount: real.fields.length,
      orgChildRelationshipCount: real.childRelationships.length,
      returnedFields: fields.length,
      returnedChildRelationships: children.length,
      executionRole: fullOutput.executionRole,
      truncated: fullOutput.truncated,
      cappedFieldNames: cappedFields.map((field) => String(field.apiName)),
      cappedTruncated: cappedOutput?.truncated,
      cappedHintPresent: typeof cappedOutput?.hint === 'string',
      fieldsIncludedWhenExcluded: excludedOutput?.fieldsIncluded,
      fieldMismatches: fieldMismatches.slice(0, 10),
      childMismatches: childMismatches.slice(0, 10),
      headerMismatches,
    },
    'describe_sobject facts or truncation declaration disagreed with the org.',
  );
}

async function runSchemaSelfRepair(
  client: Client,
  results: CallToolResult[],
  objectApiName: string,
): Promise<P9LiveGate> {
  const requested = `${objectApiName}ZzP9NoSuchObject`;
  const result = await call(client, results, 'describe_sobject', { objectApiName: requested });
  const output = outputOf(result);
  if (output === undefined) return failGate('describe_sobject returned no structured content for an unknown object.');
  const suggestion = typeof output.suggestion === 'string' ? output.suggestion : '';
  return gate(
    result.isError === true
      && output.success === false
      && output.errorCode === 'MCP_SOBJECT_NOT_FOUND'
      && typeof output.salesforceErrorCode === 'string' && output.salesforceErrorCode.length > 0
      && /list_sobjects/u.test(suggestion),
    {
      requested,
      isError: result.isError === true,
      errorCode: output.errorCode,
      salesforceErrorCode: output.salesforceErrorCode,
      suggestionNamesListSobjects: /list_sobjects/u.test(suggestion),
    },
    'An unknown object did not produce an actionable self-repair result.',
  );
}

function runCredentialSafety(
  results: readonly CallToolResult[],
  clientToken: string,
  accessToken: string | null,
): P9LiveGate {
  const rendered = results.map((result) => JSON.stringify(result)).join('\n');
  const patterns: Readonly<Record<string, RegExp>> = Object.freeze({
    salesforceSessionId: /00D[A-Za-z0-9]{8,}!/u,
    bearerHeader: /\bBearer\s/u,
    jwt: /eyJ[A-Za-z0-9_-]{8,}\./u,
    privateKey: /-----BEGIN/u,
    credentialField: /(?:access_?token|refresh_?token|client_?secret|private_?key|session_?id)["']?\s*[:=]/iu,
    stackFrame: /at\s+[\w.$<>]+ \([^)]*:\d+:\d+\)/u,
    sourceFrame: /[A-Za-z0-9_-]+\.ts:\d+/u,
  });
  const matched = Object.entries(patterns)
    .filter(([, pattern]) => pattern.test(rendered))
    .map(([name]) => name);
  const containsClientToken = rendered.includes(clientToken);
  const containsAccessToken = accessToken !== null && accessToken.length > 0 && rendered.includes(accessToken);
  return gate(
    matched.length === 0 && !containsClientToken && !containsAccessToken,
    {
      // Booleans only: the tokens themselves are never echoed into the report.
      resultsInspected: results.length,
      bytesInspected: rendered.length,
      matchedPatterns: matched,
      containsClientToken,
      containsAccessToken,
    },
    'A Tool result carried credential or internal-detail material.',
  );
}

/** Reads the Connection the governed request actually opened; a missing one is a fact, not a wait. */
async function establishedConnection(factory: MeasuringConnectionFactory): Promise<Connection | null> {
  return factory.measurements.at(-1)?.connection ?? null;
}

async function call(
  client: Client,
  results: CallToolResult[],
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): Promise<CallToolResult> {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: argumentsValue }));
  results.push(result);
  return result;
}

function outputOf(result: CallToolResult | undefined): Record<string, unknown> | undefined {
  const structured = result?.structuredContent;
  return typeof structured === 'object' && structured !== null && !Array.isArray(structured)
    ? structured as Record<string, unknown>
    : undefined;
}

async function readIdentity(connection: Connection): Promise<Readonly<{ username: string | null }>> {
  const identity = await connection.identity() as unknown as Readonly<Record<string, unknown>>;
  return Object.freeze({ username: typeof identity.username === 'string' ? identity.username : null });
}

async function readAccessToken(connection: Connection): Promise<string | null> {
  const token = (connection as unknown as Readonly<Record<string, unknown>>).accessToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

async function readDescribeGlobal(connection: Connection): Promise<LiveSobjectEntry[]> {
  const payload = await connection.describeGlobal() as unknown as Readonly<Record<string, unknown>>;
  return readArray(payload.sobjects).flatMap((candidate) => {
    if (typeof candidate.name !== 'string') return [];
    return [Object.freeze({
      name: candidate.name,
      label: stringOf(candidate.label),
      labelPlural: stringOf(candidate.labelPlural),
      keyPrefix: typeof candidate.keyPrefix === 'string' ? candidate.keyPrefix : null,
      custom: candidate.custom === true,
      queryable: candidate.queryable === true,
      createable: candidate.createable === true,
      updateable: candidate.updateable === true,
      searchable: candidate.searchable === true,
    })];
  });
}

async function readDescribe(
  connection: Connection,
  objectApiName: string,
): Promise<LiveSobjectEntry & Readonly<{
  fields: readonly LiveField[];
  childRelationships: readonly LiveChildRelationship[];
}>> {
  const payload = await connection.describe(objectApiName) as unknown as Readonly<Record<string, unknown>>;
  const fields = readArray(payload.fields).flatMap((candidate) => {
    if (typeof candidate.name !== 'string') return [];
    return [Object.freeze({
      name: candidate.name,
      label: stringOf(candidate.label),
      type: stringOf(candidate.type),
      nillable: candidate.nillable === true,
      createable: candidate.createable === true,
      updateable: candidate.updateable === true,
      filterable: candidate.filterable === true,
      sortable: candidate.sortable === true,
      custom: candidate.custom === true,
      deprecatedAndHidden: candidate.deprecatedAndHidden === true,
      referenceTo: Object.freeze(readStringArray(candidate.referenceTo)),
      relationshipName: typeof candidate.relationshipName === 'string' ? candidate.relationshipName : null,
      picklistValues: Object.freeze(readArray(candidate.picklistValues).flatMap((value) => {
        if (typeof value.value !== 'string') return [];
        return [Object.freeze({
          value: value.value,
          label: stringOf(value.label),
          active: value.active === true,
          defaultValue: value.defaultValue === true,
        })];
      })),
    })];
  });
  const childRelationships = readArray(payload.childRelationships).flatMap((candidate) => {
    if (typeof candidate.childSObject !== 'string' || typeof candidate.field !== 'string') return [];
    return [Object.freeze({
      childSObject: candidate.childSObject,
      field: candidate.field,
      relationshipName: typeof candidate.relationshipName === 'string' ? candidate.relationshipName : null,
      cascadeDelete: candidate.cascadeDelete === true,
      restrictedDelete: candidate.restrictedDelete === true,
      deprecatedAndHidden: candidate.deprecatedAndHidden === true,
    })];
  });
  return Object.freeze({
    name: typeof payload.name === 'string' ? payload.name : objectApiName,
    label: stringOf(payload.label),
    labelPlural: stringOf(payload.labelPlural),
    keyPrefix: typeof payload.keyPrefix === 'string' ? payload.keyPrefix : null,
    custom: payload.custom === true,
    queryable: payload.queryable === true,
    createable: payload.createable === true,
    updateable: payload.updateable === true,
    searchable: payload.searchable === true,
    fields: Object.freeze(fields),
    childRelationships: Object.freeze(childRelationships),
  });
}

function readArray(value: unknown): Readonly<Record<string, unknown>>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    : [];
}

function readEntries(value: unknown): Readonly<Record<string, unknown>>[] {
  return readArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function samePicklistValues(
  left: readonly Readonly<Record<string, unknown>>[],
  right: readonly LivePicklistValue[],
): boolean {
  return picklistDifferences(left, right).length === 0;
}

/**
 * Describes how the Tool's picklist view differs from the org's, bounded so a mismatch names
 * the exact property instead of only reporting that something disagreed.
 */
function picklistDifferences(
  left: readonly Readonly<Record<string, unknown>>[],
  right: readonly LivePicklistValue[],
): string[] {
  if (left.length !== right.length) {
    return [`count: tool=${left.length} org=${right.length}`];
  }
  const differences: string[] = [];
  for (const [index, value] of left.entries()) {
    const expected = right[index];
    if (expected === undefined) continue;
    for (const key of ['value', 'label', 'active', 'defaultValue'] as const) {
      if (value[key] !== expected[key]) {
        differences.push(`[${index}].${key}: tool=${JSON.stringify(value[key])} org=${JSON.stringify(expected[key])}`);
      }
    }
    if (differences.length >= 4) break;
  }
  return differences;
}

function sortEntries(entries: readonly LiveSobjectEntry[]): LiveSobjectEntry[] {
  return [...entries].sort((left, right) => left.name.localeCompare(right.name));
}

function startsWithFilter(name: string, filter: string): boolean {
  return name.toLocaleLowerCase('en-US').startsWith(filter.toLocaleLowerCase('en-US'));
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function gate(condition: boolean, detail: Readonly<Record<string, unknown>>, failure: string): P9LiveGate {
  return Object.freeze({
    status: condition ? 'PASS' : 'FAIL',
    detail: Object.freeze(condition ? detail : { ...detail, failure }),
  });
}

function failGate(failure: string): P9LiveGate {
  return Object.freeze({ status: 'FAIL', detail: Object.freeze({ failure }) });
}

function notTested(reason: string): P9LiveGate {
  return Object.freeze({ status: 'NOT TESTED', detail: Object.freeze({ reason }) });
}

function combine(gates: readonly P9LiveGate[]): 'PASS' | 'PARTIAL' | 'FAIL' {
  if (gates.some((entry) => entry.status === 'FAIL')) return 'FAIL';
  return gates.some((entry) => entry.status === 'NOT TESTED') ? 'PARTIAL' : 'PASS';
}

async function closeQuietly(
  store: MySqlControlPlaneStore,
  database: ControlPlaneDatabaseClient,
  auditDatabase: ControlPlaneDatabaseClient,
  auditPipeline: AsyncAuditPipeline,
): Promise<void> {
  await auditPipeline.close(DEFAULT_AUDIT_FLUSH_TIMEOUT_MS).catch(() => undefined);
  await store.close().catch(() => undefined);
  await Promise.all([
    database.destroy().catch(() => undefined),
    auditDatabase.destroy().catch(() => undefined),
  ]);
}

import { access } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import {
  createIdentityRuntime,
  JwtConnectionFactory,
  NoopRuntimeLogger,
  normalizeSalesforceIdentity,
  type SalesforceConnectionFactory,
  type SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import { z } from 'zod';
import type { RemoteRuntimeConfig } from '../config.js';
import { startRemoteMcpServer } from '../http-server.js';
import type {
  LatencySummary,
  LoadValidationGate,
  P2ValidationReport,
  ValidationGate,
} from './types.js';

const identitySchema = z.object({ username: z.string() }).passthrough();
const errorResponseSchema = z.object({
  error: z.object({ data: z.object({ errorCode: z.string() }) }),
});
const queryResponseSchema = z.object({ records: z.array(z.unknown()) }).passthrough();
const REQUIRED_TOOLS = Object.freeze(['get_username', 'run_soql_query'] as const);
const LOAD_REQUESTS = 50;
const LOAD_BATCH_SIZE = 10;

type ConnectionMeasurement = Readonly<{
  platformUserId: string;
  salesforceUsername: string;
  connection: Connection;
  latencyMs: number;
}>;

class MeasuringConnectionFactory implements SalesforceConnectionFactory {
  public readonly measurements: ConnectionMeasurement[] = [];

  public constructor(private readonly delegate: SalesforceConnectionFactory) {}

  public async create(route: SalesforceIdentityRoute): Promise<Connection> {
    const started = performance.now();
    const connection = await this.delegate.create(route);
    this.measurements.push(
      Object.freeze({
        platformUserId: route.platformUserId,
        salesforceUsername: route.salesforceUsername,
        connection,
        latencyMs: elapsed(started),
      }),
    );
    return connection;
  }

  public countFor(platformUserId: string): number {
    return this.measurements.filter((measurement) => measurement.platformUserId === platformUserId).length;
  }
}

type ConnectedClient = Readonly<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}>;

export function missingP2LiveVariables(config: RemoteRuntimeConfig): string[] {
  const missing: string[] = [];
  if (!config.identity.secondaryUsername) missing.push('SECOND_TEST_USER');
  if (!config.identity.testObject) missing.push('TEST_OBJECT');
  if (!config.clientToken) missing.push('MCP_CLIENT_TOKEN');
  return missing;
}

export async function runP2LiveValidation(config: RemoteRuntimeConfig): Promise<P2ValidationReport> {
  const secondaryUsername = config.identity.secondaryUsername;
  const testObject = config.identity.testObject;
  const clientToken = config.clientToken;
  const missing = missingP2LiveVariables(config);
  if (!secondaryUsername || !testObject || !clientToken || missing.length > 0) {
    throw new Error(`Missing mandatory P2 live inputs: ${missing.join(', ')}`);
  }

  const jwtFactory = new JwtConnectionFactory({
    instanceUrl: config.identity.instanceUrl,
    clientId: config.identity.clientId,
    privateKeyPath: config.identity.privateKeyPath,
  });
  const measuringFactory = new MeasuringConnectionFactory(jwtFactory);
  const identityRuntime = createIdentityRuntime(config.identity, {
    connectionFactory: measuringFactory,
    logger: new NoopRuntimeLogger(),
  });
  const liveConfig: RemoteRuntimeConfig = Object.freeze({
    ...config,
    bindHost: '127.0.0.1',
    port: 0,
    enabledTools: REQUIRED_TOOLS,
    allowedHosts: Object.freeze([]),
    allowedOrigins: Object.freeze([]),
    useLoopbackHostDefaults: true,
    useLoopbackOriginDefaults: true,
  });

  const directIdentityA = await validateDirectIdentity(
    identityRuntime.scopeFactory,
    config.identity.platformUserA,
    config.identity.primaryUsername,
    'p2-direct-a',
  );
  const directIdentityB = await validateDirectIdentity(
    identityRuntime.scopeFactory,
    config.identity.platformUserB,
    secondaryUsername,
    'p2-direct-b',
  );
  const server = await startRemoteMcpServer({ config: liveConfig, identityRuntime });
  const clients: ConnectedClient[] = [];
  const initializeSamples: number[] = [];
  const listSamples: number[] = [];
  const usernameSamples: number[] = [];
  const soqlSamples: number[] = [];

  try {
    const beforeDenied = measuringFactory.measurements.length;
    const noBearerResponse = await rawMcpPost(server.mcpUrl, {});
    const wrongBearerResponse = await rawMcpPost(server.mcpUrl, {
      authorization: 'Bearer intentionally-wrong-p2-token',
    });
    const noPlatformResponse = await rawMcpPost(server.mcpUrl, {
      authorization: `Bearer ${clientToken}`,
    });
    const unknownResponse = await rawMcpPost(server.mcpUrl, {
      authorization: `Bearer ${clientToken}`,
      [config.platformUserHeader]: 'p2-route-does-not-exist',
    });
    const deniedCreatedConnection = measuringFactory.measurements.length !== beforeDenied;

    const clientA = await connectMeasured(
      server.mcpUrl,
      config.identity.platformUserA,
      clientToken,
      config.platformUserHeader,
      'p2-live-a',
      initializeSamples,
    );
    clients.push(clientA);
    const clientB = await connectMeasured(
      server.mcpUrl,
      config.identity.platformUserB,
      clientToken,
      config.platformUserHeader,
      'p2-live-b',
      initializeSamples,
    );
    clients.push(clientB);
    for (const [index, platformUserId] of [config.identity.platformUserA, config.identity.platformUserB].entries()) {
      const extra = await connectMeasured(
        server.mcpUrl,
        platformUserId,
        clientToken,
        config.platformUserHeader,
        `p2-init-sample-${index + 1}`,
        initializeSamples,
      );
      clients.push(extra);
    }

    let listedTools: Awaited<ReturnType<Client['listTools']>> | undefined;
    for (let index = 0; index < 4; index += 1) {
      const selected = index % 2 === 0 ? clientA.client : clientB.client;
      const started = performance.now();
      listedTools = await selected.listTools();
      listSamples.push(elapsed(started));
    }
    if (!listedTools) throw new Error('P2 tools/list did not produce a result.');
    const listedNames = listedTools.tools.map((tool) => tool.name);
    const queryTool = listedTools.tools.find((tool) => tool.name === 'run_soql_query');
    const queryProperties = isRecord(queryTool?.inputSchema.properties)
      ? queryTool.inputSchema.properties
      : {};

    const usernameA = await timedToolCall(
      clientA.client,
      { name: 'get_username', arguments: {} },
      usernameSamples,
    );
    const usernameB = await timedToolCall(
      clientB.client,
      { name: 'get_username', arguments: {} },
      usernameSamples,
    );
    const query = `SELECT Id FROM ${testObject} LIMIT 5`;
    const soqlResultsA: CallToolResult[] = [];
    const soqlResultsB: CallToolResult[] = [];
    for (let index = 0; index < 2; index += 1) {
      soqlResultsA.push(
        await timedToolCall(
          clientA.client,
          { name: 'run_soql_query', arguments: { query, useToolingApi: false } },
          soqlSamples,
        ),
      );
      soqlResultsB.push(
        await timedToolCall(
          clientB.client,
          { name: 'run_soql_query', arguments: { query, useToolingApi: false } },
          soqlSamples,
        ),
      );
    }

    const bBeforeForgery = measuringFactory.countFor(config.identity.platformUserB);
    const forgedA = await clientA.client.callTool({
      name: 'run_soql_query',
      arguments: {
        query,
        useToolingApi: false,
        platformUserId: config.identity.platformUserB,
        usernameOrAlias: secondaryUsername,
        directory: config.identity.projectRoot,
      },
    });
    const forgedARecord = measuringFactory.measurements.at(-1);
    const forgedAToBIsolated =
      measuringFactory.countFor(config.identity.platformUserB) === bBeforeForgery &&
      forgedARecord?.platformUserId === config.identity.platformUserA;
    const aBeforeForgery = measuringFactory.countFor(config.identity.platformUserA);
    const forgedB = await clientB.client.callTool({
      name: 'run_soql_query',
      arguments: {
        query,
        useToolingApi: false,
        platformUserId: config.identity.platformUserA,
        usernameOrAlias: config.identity.primaryUsername,
        directory: config.identity.projectRoot,
      },
    });
    const forgedBRecord = measuringFactory.measurements.at(-1);
    const forgedBToAIsolated =
      measuringFactory.countFor(config.identity.platformUserA) === aBeforeForgery &&
      forgedBRecord?.platformUserId === config.identity.platformUserB;

    await waitFor(() => identityRuntime.workspaceFactory.getMetrics().active === 0, 30_000);
    const loadConnectionStart = measuringFactory.measurements.length;
    const workspaceBeforeLoad = identityRuntime.workspaceFactory.getMetrics();
    const loadResults: Array<Readonly<{ expected: string; forbidden: string; result: CallToolResult; latencyMs: number }>> = [];
    for (let batchStart = 0; batchStart < LOAD_REQUESTS; batchStart += LOAD_BATCH_SIZE) {
      const batch = await Promise.all(
        Array.from({ length: LOAD_BATCH_SIZE }, async (_unused, batchIndex) => {
          const index = batchStart + batchIndex;
          const isA = index % 2 === 0;
          const started = performance.now();
          const result = CallToolResultSchema.parse(
            await (isA ? clientA.client : clientB.client).callTool({
              name: 'get_username',
              arguments: {},
            }),
          );
          return Object.freeze({
            expected: isA ? config.identity.primaryUsername : secondaryUsername,
            forbidden: isA ? secondaryUsername : config.identity.primaryUsername,
            result,
            latencyMs: elapsed(started),
          });
        }),
      );
      loadResults.push(...batch);
    }
    usernameSamples.push(...loadResults.map((result) => result.latencyMs));
    await waitFor(() => identityRuntime.workspaceFactory.getMetrics().active === 0, 30_000);
    const loadConnections = measuringFactory.measurements.slice(loadConnectionStart);
    const workspaceAfterLoad = identityRuntime.workspaceFactory.getMetrics();
    const loadRoots = workspaceAfterLoad.createdRoots.slice(workspaceBeforeLoad.created);
    const rootsRemaining = (await Promise.all(loadRoots.map(pathExists))).filter(Boolean).length;
    const identityMismatch = loadConnections.filter(
      (measurement) =>
        (measurement.platformUserId === config.identity.platformUserA &&
          normalizeSalesforceIdentity(measurement.salesforceUsername) !==
            normalizeSalesforceIdentity(config.identity.primaryUsername)) ||
        (measurement.platformUserId === config.identity.platformUserB &&
          normalizeSalesforceIdentity(measurement.salesforceUsername) !== normalizeSalesforceIdentity(secondaryUsername)) ||
        ![config.identity.platformUserA, config.identity.platformUserB].includes(measurement.platformUserId),
    ).length;
    const crossUserLeak = loadResults.filter((entry) => {
      const text = textContent(entry.result);
      return !text.includes(entry.expected) || text.includes(entry.forbidden);
    }).length;
    const errors = loadResults.filter((entry) => entry.result.isError === true).length;
    const connectionReuse = loadConnections.length - new Set(loadConnections.map((entry) => entry.connection)).size;
    const workspaceLeak =
      rootsRemaining +
      (loadRoots.length - new Set(loadRoots).size) +
      Math.max(0, workspaceAfterLoad.active);
    const cleanupFailures = server.getMetrics().cleanupFailures;
    const loadPass =
      loadConnections.length === 0 &&
      loadRoots.length === LOAD_REQUESTS &&
      identityMismatch === 0 &&
      crossUserLeak === 0 &&
      errors === 0 &&
      connectionReuse === 0 &&
      workspaceLeak === 0 &&
      cleanupFailures === 0;
    const load: LoadValidationGate = Object.freeze({
      status: loadPass ? 'PASS' : 'FAIL',
      ...(!loadPass ? { error: 'The 50-request route-only A/B zero-Connection isolation or cleanup gate failed.' } : {}),
      requests: LOAD_REQUESTS,
      identityMismatch,
      crossUserLeak,
      workspaceLeak,
      cleanupFailures,
      connectionReuse,
      errors,
      latency: summarizeLatency(loadResults.map((entry) => entry.latencyMs)),
    });

    const noBearer = gate(
      noBearerResponse.status === 401 && noBearerResponse.errorCode === 'MCP_CLIENT_AUTH_REQUIRED' && !deniedCreatedConnection,
      'Missing Bearer did not return MCP_CLIENT_AUTH_REQUIRED before JWT creation.',
      'BLOCKED',
    );
    const wrongBearer = gate(
      wrongBearerResponse.status === 401 && wrongBearerResponse.errorCode === 'MCP_CLIENT_AUTH_INVALID' && !deniedCreatedConnection,
      'Wrong Bearer did not return MCP_CLIENT_AUTH_INVALID before JWT creation.',
      'BLOCKED',
    );
    const noPlatformUser = gate(
      noPlatformResponse.status === 401 && noPlatformResponse.errorCode === 'MCP_PLATFORM_USER_REQUIRED' && !deniedCreatedConnection,
      'Missing platform user did not fail before JWT creation.',
      'BLOCKED',
    );
    const unknownPlatformUser = gate(
      unknownResponse.status === 403 && unknownResponse.errorCode === 'MCP_IDENTITY_ROUTE_NOT_FOUND' && !deniedCreatedConnection,
      'Unknown platform user did not fail without fallback before JWT creation.',
      'BLOCKED',
    );
    const toolsList = gate(
      sameArray(listedNames, REQUIRED_TOOLS),
      `tools/list returned an unexpected Tool set: ${listedNames.join(', ')}.`,
    );
    const disabledToolInvisible = gate(
      !listedNames.includes('retrieve_metadata') && !listedNames.includes('deploy_metadata'),
      'A disabled or mutation Tool was visible to the remote client.',
    );
    const remoteSchema = gate(
      queryTool !== undefined &&
        !('usernameOrAlias' in queryProperties) &&
        !('directory' in queryProperties) &&
        !('platformUserId' in queryProperties),
      'The remote SOQL schema exposed a host-owned identity or workspace argument.',
    );
    const getUsernameA = gate(
      directIdentityA && toolContainsIdentity(usernameA, config.identity.primaryUsername),
      'User A identity or official get_username result did not match.',
    );
    const getUsernameB = gate(
      directIdentityB && toolContainsIdentity(usernameB, secondaryUsername),
      'User B identity or official get_username result did not match.',
    );
    const soqlA = gate(soqlResultsA.every(validQueryResult), 'User A official SOQL returned an invalid result.');
    const soqlB = gate(soqlResultsB.every(validQueryResult), 'User B official SOQL returned an invalid result.');
    const forgedAToB = gate(
      forgedA.isError !== true &&
        validQueryResult(CallToolResultSchema.parse(forgedA)) &&
        forgedAToBIsolated,
      'A client body arguments changed the authoritative route to User B.',
      'BLOCKED',
    );
    const forgedBToA = gate(
      forgedB.isError !== true &&
        validQueryResult(CallToolResultSchema.parse(forgedB)) &&
        forgedBToAIsolated,
      'B client body arguments changed the authoritative route to User A.',
      'BLOCKED',
    );

    const reportWithoutOverall = {
      noBearer,
      wrongBearer,
      noPlatformUser,
      unknownPlatformUser,
      initializeA: gate(initializeSamples.length >= 1, 'User A initialize did not complete.'),
      initializeB: gate(initializeSamples.length >= 2, 'User B initialize did not complete.'),
      toolsList,
      disabledToolInvisible,
      remoteSchema,
      getUsernameA,
      getUsernameB,
      soqlA,
      soqlB,
      forgedAToB,
      forgedBToA,
      load,
      initializeLatency: summarizeLatency(initializeSamples),
      toolsListLatency: summarizeLatency(listSamples),
      getUsernameLatency: summarizeLatency(usernameSamples),
      soqlLatency: summarizeLatency(soqlSamples),
      jwtLatency: summarizeLatency(measuringFactory.measurements.map((measurement) => measurement.latencyMs)),
      salesforceCliUsed: false as const,
      databaseUsed: false as const,
    };
    const gates: ValidationGate[] = [
      reportWithoutOverall.noBearer,
      reportWithoutOverall.wrongBearer,
      reportWithoutOverall.noPlatformUser,
      reportWithoutOverall.unknownPlatformUser,
      reportWithoutOverall.initializeA,
      reportWithoutOverall.initializeB,
      reportWithoutOverall.toolsList,
      reportWithoutOverall.disabledToolInvisible,
      reportWithoutOverall.remoteSchema,
      reportWithoutOverall.getUsernameA,
      reportWithoutOverall.getUsernameB,
      reportWithoutOverall.soqlA,
      reportWithoutOverall.soqlB,
      reportWithoutOverall.forgedAToB,
      reportWithoutOverall.forgedBToA,
      reportWithoutOverall.load,
    ];
    const overall = gates.every((entry) => entry.status === 'PASS' || entry.status === 'BLOCKED')
      ? 'PASS'
      : 'FAIL';
    return Object.freeze({ ...reportWithoutOverall, overall });
  } finally {
    await Promise.allSettled(clients.map(({ client }) => client.close()));
    await server.close();
  }
}

async function validateDirectIdentity(
  scopeFactory: ReturnType<typeof createIdentityRuntime>['scopeFactory'],
  platformUserId: string,
  expectedUsername: string,
  correlationId: string,
): Promise<boolean> {
  const scope = await scopeFactory.create(Object.freeze({ platformUserId, correlationId }));
  try {
    const identity = identitySchema.parse(await (await scope.getConnection()).identity());
    return normalizeSalesforceIdentity(identity.username) === normalizeSalesforceIdentity(expectedUsername);
  } finally {
    await scope.close();
  }
}

async function connectMeasured(
  url: URL,
  platformUserId: string,
  clientToken: string,
  platformUserHeader: string,
  name: string,
  samples: number[],
): Promise<ConnectedClient> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        authorization: `Bearer ${clientToken}`,
        [platformUserHeader]: platformUserId,
      },
    },
  });
  const client = new Client({ name, version: '0.1.0-p2' });
  const started = performance.now();
  await client.connect(transport);
  samples.push(elapsed(started));
  return Object.freeze({ client, transport });
}

async function timedToolCall(
  client: Client,
  request: Parameters<Client['callTool']>[0],
  samples: number[],
): Promise<CallToolResult> {
  const started = performance.now();
  const result = CallToolResultSchema.parse(await client.callTool(request));
  samples.push(elapsed(started));
  return result;
}

async function rawMcpPost(
  url: URL,
  headers: Readonly<Record<string, string>>,
): Promise<Readonly<{ status: number; errorCode?: string }>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 97, method: 'ping' }),
  });
  const parsed = errorResponseSchema.safeParse(await response.json());
  return Object.freeze({
    status: response.status,
    ...(parsed.success ? { errorCode: parsed.data.error.data.errorCode } : {}),
  });
}

function validQueryResult(result: CallToolResult): boolean {
  if (result.isError === true) return false;
  const text = textContent(result);
  const jsonStart = text.indexOf('{');
  if (jsonStart < 0) return false;
  try {
    queryResponseSchema.parse(JSON.parse(text.slice(jsonStart)) as unknown);
    return true;
  } catch {
    return false;
  }
}

function toolContainsIdentity(result: CallToolResult, username: string): boolean {
  return result.isError !== true && textContent(result).includes(username);
}

function textContent(result: CallToolResult): string {
  return result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function gate(
  condition: boolean,
  error: string,
  passingStatus: 'PASS' | 'BLOCKED' = 'PASS',
): ValidationGate {
  return condition ? Object.freeze({ status: passingStatus }) : Object.freeze({ status: 'FAIL', error });
}

export function summarizeLatency(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) return Object.freeze({ samples: 0, p50Ms: 0, p95Ms: 0 });
  const sorted = [...samples].sort((left, right) => left - right);
  return Object.freeze({
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  });
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return Math.round((sorted[index] ?? 0) * 100) / 100;
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for P2 request resource cleanup.');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import { z } from 'zod';
import type { IdentityRuntimeConfig } from '../config.js';
import { JwtConnectionFactory, type SalesforceConnectionFactory } from '../connection-factory.js';
import { normalizeSalesforceIdentity, type SalesforceIdentityRoute } from '../contracts.js';
import { IdentityRuntimeError, formatRuntimeError } from '../errors.js';
import { startIdentityHttpServer } from '../http-server.js';
import { NoopRuntimeLogger } from '../runtime-logger.js';
import { createIdentityRuntime } from '../runtime.js';
import type { ConcurrencyGate, ValidationGate, P1ValidationReport } from './types.js';

const identitySchema = z.object({ username: z.string() }).passthrough();
const runtimeErrorResponseSchema = z.object({
  error: z.object({ data: z.object({ errorCode: z.string() }) }),
});
const queryResponseSchema = z.object({ records: z.array(z.unknown()) }).passthrough();

type IdentityAudit = Readonly<{
  platformUserId: string;
  expectedUsername: string;
  actualUsername: string;
  matches: boolean;
  connection: Connection;
}>;

class IdentityAuditingConnectionFactory implements SalesforceConnectionFactory {
  public readonly audits: IdentityAudit[] = [];

  public constructor(private readonly delegate: SalesforceConnectionFactory) {}

  public async create(route: SalesforceIdentityRoute): Promise<Connection> {
    const connection = await this.delegate.create(route);
    const identity = identitySchema.parse(await connection.identity());
    const matches =
      normalizeSalesforceIdentity(identity.username) === normalizeSalesforceIdentity(route.salesforceUsername);
    this.audits.push({
      platformUserId: route.platformUserId,
      expectedUsername: route.salesforceUsername,
      actualUsername: identity.username,
      matches,
      connection,
    });
    return connection;
  }

  public countFor(platformUserId: string): number {
    return this.audits.filter((audit) => audit.platformUserId === platformUserId).length;
  }
}

export function missingLiveVariables(config: IdentityRuntimeConfig): string[] {
  const missing: string[] = [];
  if (!config.secondaryUsername) missing.push('SECOND_TEST_USER');
  if (!config.testObject) missing.push('TEST_OBJECT');
  if (!config.metadataSeed) missing.push('TEST_METADATA_TYPE', 'TEST_METADATA_FULL_NAME');
  return missing;
}

export async function runP1LiveValidation(config: IdentityRuntimeConfig): Promise<P1ValidationReport> {
  const secondaryUsername = config.secondaryUsername;
  const testObject = config.testObject;
  const metadataSeed = config.metadataSeed;
  if (!secondaryUsername || !testObject || !metadataSeed) {
    throw new Error(`Missing mandatory P1 live inputs: ${missingLiveVariables(config).join(', ')}`);
  }

  const jwtFactory = new JwtConnectionFactory({
    instanceUrl: config.instanceUrl,
    clientId: config.clientId,
    privateKeyPath: config.privateKeyPath,
  });
  const auditingFactory = new IdentityAuditingConnectionFactory(jwtFactory);
  const runtime = createIdentityRuntime(config, {
    connectionFactory: auditingFactory,
    logger: new NoopRuntimeLogger(),
  });

  const directA = await createAndCloseDirectScope(runtime.scopeFactory, config.platformUserA, 'p1-direct-a');
  const directAuditA = lastAuditFor(auditingFactory, config.platformUserA);
  const directB = await createAndCloseDirectScope(runtime.scopeFactory, config.platformUserB, 'p1-direct-b');
  const directAuditB = lastAuditFor(auditingFactory, config.platformUserB);

  const httpServer = await startIdentityHttpServer({
    scopeFactory: runtime.scopeFactory,
    cwdGuard: runtime.cwdGuard,
    logger: runtime.logger,
    redactionSecrets: runtime.redactionSecrets,
  });
  const clientA = createClient(httpServer.url, config.platformUserA, 'p1-live-a');
  const clientB = createClient(httpServer.url, config.platformUserB, 'p1-live-b');

  let toolsList: ValidationGate = fail('tools/list did not run.');
  let getUsernameA: ValidationGate = fail('User A get_username did not run.');
  let getUsernameB: ValidationGate = fail('User B get_username did not run.');
  let soqlA: ValidationGate = fail('User A run_soql_query did not run.');
  let soqlB: ValidationGate = fail('User B run_soql_query did not run.');
  let forgedAToB: ValidationGate = fail('A to B forgery did not run.');
  let forgedBToA: ValidationGate = fail('B to A forgery did not run.');
  let unknownUser: ValidationGate = fail('Unknown route did not run.');
  let missingUser: ValidationGate = fail('Missing platform user did not run.');
  let concurrency: ConcurrencyGate = {
    status: 'FAIL',
    requests: config.concurrentRequests,
    identityMismatch: config.concurrentRequests,
    crossUserLeak: config.concurrentRequests,
    unknownConnectionReuse: config.concurrentRequests,
  };
  let metadataCwd: ValidationGate = fail('Metadata CWD isolation did not run.');
  let workspaceIsolation: ValidationGate = fail('Workspace isolation did not run.');
  let requestCleanup: ValidationGate = fail('Request cleanup did not run.');

  try {
    await Promise.all([clientA.client.connect(clientA.transport), clientB.client.connect(clientB.transport)]);
    const listResult = await clientA.client.listTools();
    const listedNames = listResult.tools.map((tool) => tool.name).sort();
    toolsList = sameArray(listedNames, ['get_username', 'retrieve_metadata', 'run_soql_query'])
      ? pass()
      : fail('The P1 host did not expose exactly the three selected official Tools.');

    const usernameResultA = await callUsername(clientA.client, config.projectRoot);
    const usernameResultB = await callUsername(clientB.client, config.projectRoot);
    getUsernameA = toolContainsIdentity(usernameResultA, config.primaryUsername);
    getUsernameB = toolContainsIdentity(usernameResultB, secondaryUsername);

    const query = `SELECT Id FROM ${testObject} LIMIT 5`;
    soqlA = validateQueryResult(await callQuery(clientA.client, query, config.primaryUsername, config.projectRoot));
    soqlB = validateQueryResult(await callQuery(clientB.client, query, secondaryUsername, config.projectRoot));

    const bBeforeForgery = auditingFactory.countFor(config.platformUserB);
    const forgedAResult = await callQuery(clientA.client, query, secondaryUsername, config.projectRoot);
    forgedAToB =
      isBlockedMismatch(forgedAResult) && auditingFactory.countFor(config.platformUserB) === bBeforeForgery
        ? blocked()
        : fail('A to B forged username was not blocked before a B Connection was created.');

    const aBeforeForgery = auditingFactory.countFor(config.platformUserA);
    const forgedBResult = await callQuery(clientB.client, query, config.primaryUsername, config.projectRoot);
    forgedBToA =
      isBlockedMismatch(forgedBResult) && auditingFactory.countFor(config.platformUserA) === aBeforeForgery
        ? blocked()
        : fail('B to A forged username was not blocked before an A Connection was created.');

    const beforeDenied = auditingFactory.audits.length;
    const unknownResponse = await rawMcpPost(httpServer.url, { 'x-platform-user-id': 'does-not-exist' });
    unknownUser =
      unknownResponse.status === 403 &&
      unknownResponse.errorCode === 'MCP_IDENTITY_ROUTE_NOT_FOUND' &&
      auditingFactory.audits.length === beforeDenied
        ? blocked()
        : fail('Unknown platform identity did not fail before JWT/Connection creation.');
    const missingResponse = await rawMcpPost(httpServer.url, {});
    missingUser =
      missingResponse.status === 401 &&
      missingResponse.errorCode === 'MCP_PLATFORM_USER_REQUIRED' &&
      auditingFactory.audits.length === beforeDenied
        ? blocked()
        : fail('Missing platform identity did not fail before JWT/Connection creation.');

    const concurrencyAuditStart = auditingFactory.audits.length;
    const concurrentResults = await Promise.all(
      Array.from({ length: config.concurrentRequests }, (_, index) =>
        index % 2 === 0
          ? callUsername(clientA.client, config.projectRoot)
          : callUsername(clientB.client, config.projectRoot),
      ),
    );
    const concurrentAudits = auditingFactory.audits.slice(concurrencyAuditStart);
    const identityMismatch = concurrentAudits.filter((audit) => !audit.matches).length;
    const crossUserLeak = concurrentResults.filter((result, index) => {
      const expected = index % 2 === 0 ? config.primaryUsername : secondaryUsername;
      return toolContainsIdentity(result, expected).status !== 'PASS';
    }).length;
    const unknownConnectionReuse =
      concurrentAudits.length - new Set(concurrentAudits.map((audit) => audit.connection)).size;
    concurrency = {
      status:
        concurrentAudits.length === config.concurrentRequests &&
        identityMismatch === 0 &&
        crossUserLeak === 0 &&
        unknownConnectionReuse === 0
          ? 'PASS'
          : 'FAIL',
      requests: config.concurrentRequests,
      identityMismatch,
      crossUserLeak,
      unknownConnectionReuse,
    };

    const workspaceBeforeMetadata = runtime.workspaceFactory.getMetrics();
    const exclusiveBefore = runtime.cwdGuard.getMetrics().exclusiveExecutions;
    const cwdBeforeMetadata = process.cwd();
    const [metadataA1, metadataA2] = await Promise.all([
      callMetadata(clientA.client, config.primaryUsername, config.projectRoot),
      callMetadata(clientA.client, config.primaryUsername, config.projectRoot),
    ]);
    const metadataRoots = runtime.workspaceFactory
      .getMetrics()
      .createdRoots.slice(workspaceBeforeMetadata.created);
    await waitFor(() => runtime.workspaceFactory.getMetrics().active === 0, 30_000);
    const rootsRemoved = (await Promise.all(metadataRoots.map((root) => pathIsAbsent(root)))).every(Boolean);
    const cwdMetrics = runtime.cwdGuard.getMetrics();
    metadataCwd =
      metadataA1.isError !== true &&
      metadataA2.isError !== true &&
      cwdMetrics.exclusiveExecutions - exclusiveBefore === 2 &&
      cwdMetrics.maxConcurrentExclusive === 1 &&
      process.cwd() === cwdBeforeMetadata
        ? pass()
        : fail('Official metadata execution failed, overlapped, or left CWD changed.');
    workspaceIsolation =
      metadataRoots.length === 2 && new Set(metadataRoots).size === 2 && rootsRemoved
        ? pass()
        : fail('Concurrent metadata requests did not use two distinct cleaned workspaces.');

    const finalWorkspaceMetrics = runtime.workspaceFactory.getMetrics();
    requestCleanup =
      finalWorkspaceMetrics.active === 0 && finalWorkspaceMetrics.created === finalWorkspaceMetrics.cleaned
        ? pass()
        : fail('One or more request workspaces remained active after HTTP responses completed.');
  } finally {
    await Promise.allSettled([clientA.client.close(), clientB.client.close()]);
    await httpServer.close();
  }

  const invalidIdentity = await validateInvalidIdentityGate(config);
  const reportWithoutOverall = {
    routeA: directA.routeMatches ? pass() : fail('Route A did not resolve to the configured primary username.'),
    jwtA: directA.created ? pass() : fail('Fresh JWT A failed.'),
    identityA: directAuditA.matches ? pass() : fail('Connection.identity A did not match route A.'),
    routeB: directB.routeMatches ? pass() : fail('Route B did not resolve to SECOND_TEST_USER.'),
    jwtB: directB.created ? pass() : fail('Fresh JWT B failed.'),
    identityB: directAuditB.matches ? pass() : fail('Connection.identity B did not match route B.'),
    initialize: pass(),
    toolsList,
    getUsernameA,
    getUsernameB,
    soqlA,
    soqlB,
    forgedAToB,
    forgedBToA,
    unknownUser,
    missingUser,
    invalidIdentity,
    concurrency,
    metadataCwd,
    workspaceIsolation,
    requestCleanup,
    salesforceCliUsed: false as const,
    databaseUsed: false as const,
  };
  const mandatoryGates: ValidationGate[] = [
    reportWithoutOverall.routeA,
    reportWithoutOverall.jwtA,
    reportWithoutOverall.identityA,
    reportWithoutOverall.routeB,
    reportWithoutOverall.jwtB,
    reportWithoutOverall.identityB,
    reportWithoutOverall.initialize,
    reportWithoutOverall.toolsList,
    reportWithoutOverall.getUsernameA,
    reportWithoutOverall.getUsernameB,
    reportWithoutOverall.soqlA,
    reportWithoutOverall.soqlB,
    reportWithoutOverall.forgedAToB,
    reportWithoutOverall.forgedBToA,
    reportWithoutOverall.unknownUser,
    reportWithoutOverall.missingUser,
    reportWithoutOverall.invalidIdentity,
    reportWithoutOverall.concurrency,
    reportWithoutOverall.metadataCwd,
    reportWithoutOverall.workspaceIsolation,
    reportWithoutOverall.requestCleanup,
  ];
  const overall = mandatoryGates.every((gate) => gate.status === 'PASS' || gate.status === 'BLOCKED')
    ? 'PASS'
    : 'FAIL';
  return Object.freeze({ ...reportWithoutOverall, overall });
}

async function createAndCloseDirectScope(
  scopeFactory: ReturnType<typeof createIdentityRuntime>['scopeFactory'],
  platformUserId: string,
  correlationId: string,
): Promise<{ created: true; routeMatches: boolean }> {
  const scope = await scopeFactory.create(Object.freeze({ platformUserId, correlationId }));
  try {
    return { created: true, routeMatches: scope.route.platformUserId === platformUserId };
  } finally {
    await scope.close();
  }
}

function lastAuditFor(factory: IdentityAuditingConnectionFactory, platformUserId: string): IdentityAudit {
  const audit = [...factory.audits].reverse().find((candidate) => candidate.platformUserId === platformUserId);
  assert.ok(audit, `No identity audit was captured for ${platformUserId}.`);
  return audit;
}

function createClient(url: URL, platformUserId: string, correlationId: string): {
  client: Client;
  transport: StreamableHTTPClientTransport;
} {
  return {
    client: new Client({ name: `sfoa-p1-${platformUserId}`, version: '0.1.0-p1' }),
    transport: new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: {
          'x-platform-user-id': platformUserId,
          'x-correlation-id': correlationId,
        },
      },
    }),
  };
}

async function callUsername(client: Client, directory: string): Promise<CallToolResult> {
  return CallToolResultSchema.parse(
    await client.callTool({
      name: 'get_username',
      arguments: { defaultTargetOrg: false, defaultDevHub: false, directory },
    }),
  );
}

async function callQuery(
  client: Client,
  query: string,
  usernameOrAlias: string,
  directory: string,
): Promise<CallToolResult> {
  return CallToolResultSchema.parse(
    await client.callTool({
      name: 'run_soql_query',
      arguments: { query, usernameOrAlias, directory, useToolingApi: false },
    }),
  );
}

async function callMetadata(client: Client, usernameOrAlias: string, directory: string): Promise<CallToolResult> {
  return CallToolResultSchema.parse(
    await client.callTool({
      name: 'retrieve_metadata',
      arguments: {
        usernameOrAlias,
        directory,
        manifest: 'manifest/package.xml',
        ignoreConflicts: true,
      },
    }),
  );
}

function toolContainsIdentity(result: CallToolResult, expectedUsername: string): ValidationGate {
  return result.isError !== true && textContent(result).includes(expectedUsername)
    ? pass()
    : fail('Official get_username did not return the request-resolved Salesforce username.');
}

function validateQueryResult(result: CallToolResult): ValidationGate {
  if (result.isError === true) return fail('Official run_soql_query returned a Tool-level error.');
  const text = textContent(result);
  const jsonStart = text.indexOf('{');
  if (jsonStart < 0) return fail('Official run_soql_query returned no parseable JSON.');
  try {
    queryResponseSchema.parse(JSON.parse(text.slice(jsonStart)));
    return pass();
  } catch {
    return fail('Official run_soql_query returned an invalid result contract.');
  }
}

function isBlockedMismatch(result: CallToolResult): boolean {
  return result.isError === true && textContent(result).includes('MCP_IDENTITY_CONTEXT_MISMATCH');
}

async function rawMcpPost(
  url: URL,
  headers: Readonly<Record<string, string>>,
): Promise<{ status: number; errorCode: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'ping' }),
  });
  const body = runtimeErrorResponseSchema.parse(await response.json());
  return { status: response.status, errorCode: body.error.data.errorCode };
}

async function validateInvalidIdentityGate(config: IdentityRuntimeConfig): Promise<ValidationGate> {
  const secret = 'invalid-auth-secret';
  const error = new IdentityRuntimeError(
    'MCP_SALESFORCE_AUTH_FAILED',
    `Salesforce JWT authentication failed: Bearer ${secret} ${config.privateKeyPath}`,
  );
  const formatted = formatRuntimeError(error, [secret, config.privateKeyPath, config.clientId]);
  return !formatted.includes(secret) && !formatted.includes(config.privateKeyPath) && !formatted.includes(config.clientId)
    ? pass()
    : fail('Invalid-identity error output exposed sensitive authentication material.');
}

function textContent(result: CallToolResult): string {
  return result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function pass(): ValidationGate {
  return Object.freeze({ status: 'PASS' });
}

function blocked(): ValidationGate {
  return Object.freeze({ status: 'BLOCKED' });
}

function fail(error: string): ValidationGate {
  return Object.freeze({ status: 'FAIL', error });
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for request workspace cleanup.');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function pathIsAbsent(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return false;
  } catch {
    return true;
  }
}

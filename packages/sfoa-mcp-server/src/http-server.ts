import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ControlPlaneError } from '@sfoa/control-plane';
import {
  dmlOutcomeUnknownError,
  type DmlOperation,
} from '@sfoa/mcp-provider-sfoa-dml';
import {
  SFOA_CONTEXT_TOOL_ROLES,
  isSfoaContextToolName,
} from '@sfoa/mcp-provider-sfoa-context';
import {
  formatRuntimeError,
  IdentityRuntimeError,
  type IdentityRuntime,
  type RequestHeaders,
  type RequestScope,
  type RuntimeLogEvent,
  type RuntimeLogger,
  type TrustedRequestIdentity,
} from '@sfoa/identity-runtime';
import { z } from 'zod';
import {
  DisabledLoopbackAuthenticator,
  InternalBearerAuthenticator,
  LegacyHeaderIdentityProvider,
  type AuthenticatedPrincipal,
  type ClientAuthenticator,
  type IdentityProvider,
} from './authenticator.js';
import { assertValidTimeoutHierarchy, type RemoteRuntimeConfig } from './config.js';
import {
  formatRemoteRuntimeError,
  RemoteRuntimeError,
  toRemoteRuntimeError,
  withRemoteCorrelation,
} from './errors.js';
import {
  createGovernedMcpServer,
  configureProviderRuntime,
  initializeProviderRuntime,
  type InitializedProviderRuntime,
  MutationRequestState,
} from './provider-runtime.js';
import {
  snapshotDiagnosticRoute,
  snapshotDmlAllowlist,
  snapshotUserRoute,
  type RuntimePolicySnapshotSource,
} from './policy-snapshot.js';
import { readBoundedJsonBody } from './request-body.js';
import { delay, withTimeout } from './timeouts.js';
import type { RequestToolSource } from '@sfoa/identity-runtime';

const correlationIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);

export type RemoteMcpServerMetrics = Readonly<{
  totalRequests: number;
  activeRequests: number;
  cleanupFailures: number;
}>;

export type GracefulShutdownResult = Readonly<{
  drained: boolean;
  forcedConnections: boolean;
}>;

export type RemoteMcpServer = Readonly<{
  mcpUrl: URL;
  healthUrl: URL;
  readyUrl: URL;
  registeredTools: readonly string[];
  getMetrics(): RemoteMcpServerMetrics;
  close(): Promise<GracefulShutdownResult>;
}>;

export type StartRemoteMcpServerOptions = Readonly<{
  config: RemoteRuntimeConfig;
  identityRuntime: IdentityRuntime;
  toolSource?: RequestToolSource;
  inventoryToolSource?: RequestToolSource;
  identityProvider?: IdentityProvider;
  /** @deprecated Supply identityProvider for new integrations. */
  authenticator?: ClientAuthenticator;
  policySnapshotSource?: RuntimePolicySnapshotSource;
}>;

type RequestObservation = {
  correlationId: string;
  clientId?: string;
  platformUserId?: string;
  salesforceUsername?: string;
  identitySource?: AuthenticatedPrincipal['identitySource'];
  identityCredentialId?: string;
};

export async function startRemoteMcpServer(options: StartRemoteMcpServerOptions): Promise<RemoteMcpServer> {
  assertValidTimeoutHierarchy(options.config.requestTimeoutMs, options.config.toolTimeoutMs);
  const initializedProvider = await initializeProviderRuntime(
    options.config.enabledTools,
    options.toolSource,
    options.inventoryToolSource,
    options.config.dmlAllowlist,
  );
  const identityProvider = options.identityProvider ?? createIdentityProvider(options.config, options.authenticator);
  const activeRequests = new Set<Promise<void>>();
  let totalRequests = 0;
  let cleanupFailures = 0;
  let ready = false;
  let shuttingDown = false;
  let shutdownPromise: Promise<GracefulShutdownResult> | undefined;
  let allowedHosts: readonly string[] = options.config.allowedHosts;
  let allowedOrigins: readonly string[] = options.config.allowedOrigins;

  const httpServer = createServer((request, response) => {
    totalRequests += 1;
    const task = handleRemoteRequest({
      request,
      response,
      config: options.config,
      identityRuntime: options.identityRuntime,
      initializedProvider,
      policySnapshotSource: options.policySnapshotSource,
      identityProvider,
      allowedHosts,
      allowedOrigins,
      logger: options.identityRuntime.logger,
      isReady: () => ready && !shuttingDown,
      onCleanupFailure: () => {
        cleanupFailures += 1;
      },
    });
    activeRequests.add(task);
    void task.finally(() => activeRequests.delete(task));
  });

  httpServer.listen(options.config.port, options.config.bindHost);
  try {
    await Promise.race([
      once(httpServer, 'listening'),
      once(httpServer, 'error').then(([error]) => Promise.reject(error)),
    ]);
  } catch (error) {
    await closeHttpServerImmediately(httpServer);
    throw toRemoteRuntimeError(
      error,
      'MCP_RUNTIME_CONFIGURATION_INVALID',
      'The P2 remote runtime could not bind the configured host and port.',
    );
  }

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    await closeHttpServerImmediately(httpServer);
    throw new RemoteRuntimeError(
      'MCP_RUNTIME_CONFIGURATION_INVALID',
      'The P2 remote runtime did not bind to a TCP address.',
    );
  }

  if (options.config.useLoopbackHostDefaults) allowedHosts = loopbackHosts(address.port);
  if (options.config.useLoopbackOriginDefaults) allowedOrigins = loopbackOrigins(address.port);
  const baseUrl = new URL(`http://${urlHost(options.config.bindHost)}:${address.port}`);
  const mcpUrl = new URL(options.config.mcpPath, baseUrl);
  const healthUrl = new URL('/health', baseUrl);
  const readyUrl = new URL('/ready', baseUrl);
  ready = true;

  const close = async (): Promise<GracefulShutdownResult> => {
    shutdownPromise ??= (async () => {
      shuttingDown = true;
      ready = false;
      if (!httpServer.listening) return Object.freeze({ drained: true, forcedConnections: false });

      const closed = once(httpServer, 'close').then(() => undefined);
      httpServer.close();
      httpServer.closeIdleConnections();
      const graceMs = Math.max(options.config.requestTimeoutMs, options.config.toolTimeoutMs);
      const drainResult = await Promise.race([
        Promise.allSettled([...activeRequests]).then(() => true),
        delay(graceMs).then(() => false),
      ]);
      if (!drainResult) httpServer.closeAllConnections();
      await closed;
      return Object.freeze({ drained: drainResult, forcedConnections: !drainResult });
    })();
    return shutdownPromise;
  };

  return Object.freeze({
    mcpUrl,
    healthUrl,
    readyUrl,
    registeredTools: initializedProvider.enabledTools,
    getMetrics: () =>
      Object.freeze({
        totalRequests,
        activeRequests: activeRequests.size,
        cleanupFailures,
      }),
    close,
  });
}

type HandleRemoteRequestOptions = Readonly<{
  request: IncomingMessage;
  response: ServerResponse;
  config: RemoteRuntimeConfig;
  identityRuntime: IdentityRuntime;
  initializedProvider: InitializedProviderRuntime;
  policySnapshotSource?: RuntimePolicySnapshotSource;
  identityProvider: IdentityProvider;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  logger: RuntimeLogger;
  isReady(): boolean;
  onCleanupFailure(): void;
}>;

async function handleRemoteRequest(options: HandleRemoteRequestOptions): Promise<void> {
  const started = performance.now();
  const observation: RequestObservation = { correlationId: parseCorrelationId(options.request) };
  const resources = new RequestResources();
  let clientDisconnected = false;
  let responseFinished = false;
  let transportTerminationLogged = false;
  const logTransportTermination = (operation: DmlOperation): void => {
    if (transportTerminationLogged) return;
    transportTerminationLogged = true;
    void Promise.resolve(options.logger.log({
      correlationId: observation.correlationId,
      ...(observation.clientId ? { clientId: observation.clientId } : {}),
      ...(observation.platformUserId ? { platformUserId: observation.platformUserId } : {}),
      ...(observation.salesforceUsername ? { salesforceUsername: observation.salesforceUsername } : {}),
      ...(observation.identitySource ? { identitySource: observation.identitySource } : {}),
      ...(observation.identityCredentialId ? { identityCredentialId: observation.identityCredentialId } : {}),
      toolName: dmlToolName(operation),
      operation,
      outcome: 'UNKNOWN',
      mutationStarted: true,
      terminationLayer: 'TRANSPORT',
      durationMs: elapsed(started),
      result: 'ERROR',
      errorCode: 'MCP_DML_OUTCOME_UNKNOWN',
    })).catch(() => undefined);
  };
  const mutationRequestState = new MutationRequestState((operation) => {
    if (clientDisconnected) logTransportTermination(operation);
  });
  options.response.setHeader('x-correlation-id', observation.correlationId);
  const cleanup = (): void => {
    void resources.close().catch((error: unknown) =>
      logCleanupFailure(error, observation, options.logger, options.onCleanupFailure),
    );
  };
  options.response.once('finish', cleanup);
  options.response.once('close', cleanup);
  const observeClientDisconnect = (): void => {
    if (responseFinished) return;
    clientDisconnected = true;
    const operation = mutationRequestState.getOperation();
    if (operation) logTransportTermination(operation);
  };
  options.response.once('close', observeClientDisconnect);
  options.request.socket.once('close', observeClientDisconnect);
  options.response.once('finish', () => {
    responseFinished = true;
    options.request.socket.off('close', observeClientDisconnect);
  });

  try {
    validateHostAndOrigin(options.request, options.allowedHosts, options.allowedOrigins);
    const requestUrl = new URL(options.request.url ?? '/', 'http://sfoa.invalid');
    if (requestUrl.pathname === '/health') {
      assertMethod(options.request, 'GET');
      const auditPersistence = readAuditPersistenceHealth(options.logger);
      writeJson(options.response, 200, {
        status: 'UP',
        ...(auditPersistence ? { auditPersistence } : {}),
      });
      return;
    }
    if (requestUrl.pathname === '/ready') {
      assertMethod(options.request, 'GET');
      if (!options.isReady()) {
        throw new RemoteHttpError(
          'MCP_RUNTIME_NOT_READY',
          'The P2 runtime is not ready to accept MCP requests.',
          503,
        );
      }
      writeJson(options.response, 200, { status: 'UP' });
      return;
    }
    if (requestUrl.pathname !== options.config.mcpPath) {
      throw new RemoteHttpError('MCP_REQUEST_INVALID', 'The requested endpoint does not exist.', 404);
    }
    assertMethod(options.request, 'POST');

    const controller = new AbortController();
    const operation = executeMcpPost(
      options,
      observation,
      resources,
      mutationRequestState,
      controller.signal,
    );
    try {
      await withTimeout(
        operation,
        options.config.requestTimeoutMs,
        'MCP_REQUEST_TIMEOUT',
        'The MCP HTTP request exceeded MCP_REQUEST_TIMEOUT_MS. The runtime stopped waiting and released request resources; Salesforce server-side cancellation is not guaranteed.',
        observation.correlationId,
      );
    } catch (error) {
      controller.abort();
      let terminalError = error;
      if (error instanceof RemoteRuntimeError && error.code === 'MCP_REQUEST_TIMEOUT') {
        const mutationOperation = mutationRequestState.getOperation();
        if (mutationOperation) {
          terminalError = requestLevelDmlOutcomeUnknown(
            mutationOperation,
            error,
            observation.correlationId,
          );
        }
        resources.markCancelled(
          withRemoteCorrelation(terminalError as RemoteRuntimeError, observation.correlationId),
        );
      }
      throw terminalError;
    }
  } catch (error) {
    const normalized = normalizeRequestError(error, observation.correlationId);
    const mutationOperation = mutationRequestState.getOperation();
    const outcomeUnknown = normalized.code === 'MCP_DML_OUTCOME_UNKNOWN';
    if (!transportTerminationLogged) {
      await Promise.resolve(options.logger.log({
        correlationId: observation.correlationId,
        ...(observation.clientId ? { clientId: observation.clientId } : {}),
        ...(observation.platformUserId ? { platformUserId: observation.platformUserId } : {}),
        ...(observation.salesforceUsername ? { salesforceUsername: observation.salesforceUsername } : {}),
        ...(observation.identitySource ? { identitySource: observation.identitySource } : {}),
        ...(observation.identityCredentialId ? { identityCredentialId: observation.identityCredentialId } : {}),
        ...(mutationOperation
          ? {
              toolName: dmlToolName(mutationOperation),
              operation: mutationOperation,
            }
          : {}),
        ...(outcomeUnknown
          ? {
              outcome: 'UNKNOWN' as const,
              mutationStarted: true,
              terminationLayer: 'REQUEST' as const,
            }
          : {}),
        durationMs: elapsed(started),
        result: isBlocked(normalized.code) ? 'BLOCKED' : 'ERROR',
        errorCode: normalized.code,
      })).catch(() => undefined);
    }
    if (!options.response.headersSent) {
      writeNormalizedError(
        options.response,
        normalized,
        errorStatus(error, normalized),
        [
          ...options.identityRuntime.redactionSecrets,
          options.config.clientToken ?? '',
          options.config.controlPlane.database?.password ?? '',
        ],
      );
    } else if (!options.response.writableEnded) {
      options.response.end();
    }
  } finally {
    try {
      await resources.close();
    } catch (error) {
      logCleanupFailure(error, observation, options.logger, options.onCleanupFailure);
    }
  }
}

async function executeMcpPost(
  options: HandleRemoteRequestOptions,
  observation: RequestObservation,
  resources: RequestResources,
  mutationRequestState: MutationRequestState,
  signal: AbortSignal,
): Promise<void> {
  const headers = toRequestHeaders(options.request);
  const principal = await options.identityProvider.authenticate(
    headers,
    options.config.platformUserHeader,
    observation.correlationId,
  );
  observation.clientId = principal.clientId;
  observation.platformUserId = principal.platformUserId;
  observation.identitySource = principal.identitySource;
  observation.identityCredentialId = principal.credentialId;
  const identity: TrustedRequestIdentity = Object.freeze({
    platformUserId: principal.platformUserId,
    correlationId: principal.correlationId,
  });
  assertContentType(options.request);
  const parsedBody = await readBoundedJsonBody(options.request, options.config.maxBodyBytes);
  resources.assertAvailable(signal);

  let initializedProvider = options.initializedProvider;
  let scope: RequestScope;
  if (options.policySnapshotSource) {
    const snapshot = await options.policySnapshotSource.load(identity.platformUserId);
    const userRoute = snapshotUserRoute(snapshot);
    if (!userRoute) {
      throw new IdentityRuntimeError(
        'MCP_IDENTITY_ROUTE_NOT_FOUND',
        'No enabled Salesforce identity route exists for the authenticated platform user.',
        { correlationId: identity.correlationId },
      );
    }
    assertDiagnosticSnapshotValid(snapshot.enabledTools, snapshot.diagnostic !== null, identity.correlationId);
    initializedProvider = configureProviderRuntime(
      options.initializedProvider,
      snapshot.enabledTools,
      snapshotDmlAllowlist(snapshot),
    );
    await auditDisabledToolAttempt(parsedBody, initializedProvider.enabledTools, principal, options.logger);
    const requestedRole = getRequestedExecutionRole(parsedBody, initializedProvider.enabledTools);
    if (requestedRole === 'DIAGNOSTIC') {
      const diagnosticRoute = snapshotDiagnosticRoute(snapshot, identity.platformUserId);
      if (!diagnosticRoute) {
        throw new RemoteRuntimeError(
          'MCP_DIAGNOSTIC_CONFIGURATION_INVALID',
          'A diagnostic Tool was selected but the MySQL Control Plane has no enabled Diagnostic identity.',
          { correlationId: identity.correlationId },
        );
      }
      scope = await options.identityRuntime.scopeFactory.createForRoute(identity, diagnosticRoute);
    } else {
      scope = await options.identityRuntime.scopeFactory.createForRoute(identity, userRoute);
    }
  } else {
    const requestedRole = getRequestedExecutionRole(parsedBody, options.config.enabledTools);
    scope = requestedRole === 'DIAGNOSTIC'
      ? await createDiagnosticScope(options.identityRuntime, identity)
      : await options.identityRuntime.scopeFactory.create(identity);
  }
  await resources.attachScope(scope);
  resources.assertAvailable(signal);
  observation.salesforceUsername = scope.route.salesforceUsername;

  const created = await createGovernedMcpServer({
    scope,
    cwdGuard: options.identityRuntime.cwdGuard,
    logger: bindPrincipalLogger(options.logger, principal),
    clientId: principal.clientId,
    toolTimeoutMs: options.config.toolTimeoutMs,
    redactionSecrets: [
      ...options.identityRuntime.redactionSecrets,
      options.config.clientToken ?? '',
      options.config.controlPlane.database?.password ?? '',
    ],
    mutationRequestState,
    initializedProvider,
  });
  await resources.attachMcpServer(created.server);
  resources.assertAvailable(signal);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    allowedHosts: [...options.allowedHosts],
    enableDnsRebindingProtection: true,
  });
  await resources.attachTransport(transport);
  await created.server.connect(transport);
  resources.assertAvailable(signal);
  const responseCompleted = waitForResponseCompletion(options.response);
  await transport.handleRequest(options.request, options.response, parsedBody);
  if (!options.response.writableEnded && !options.response.destroyed) await responseCompleted;
}

export function getRequestedExecutionRole(
  body: unknown,
  enabledTools: readonly string[],
): 'USER' | 'DIAGNOSTIC' {
  if (!isRecord(body) || body.method !== 'tools/call' || !isRecord(body.params)) return 'USER';
  const name = body.params.name;
  if (
    typeof name === 'string' &&
    enabledTools.includes(name) &&
    isSfoaContextToolName(name) &&
    SFOA_CONTEXT_TOOL_ROLES[name] === 'DIAGNOSTIC'
  ) {
    return 'DIAGNOSTIC';
  }
  return 'USER';
}

async function createDiagnosticScope(
  identityRuntime: IdentityRuntime,
  identity: TrustedRequestIdentity,
): Promise<RequestScope> {
  if (!identityRuntime.diagnosticScopeFactory) {
    throw new RemoteRuntimeError(
      'MCP_DIAGNOSTIC_CONFIGURATION_INVALID',
      'A diagnostic Tool was selected but the server-owned DIAGNOSTIC scope is not configured.',
      { correlationId: identity.correlationId },
    );
  }
  return identityRuntime.diagnosticScopeFactory.create(identity);
}

class RequestResources {
  private scope: RequestScope | undefined;
  private mcpServer: McpServer | undefined;
  private transport: StreamableHTTPServerTransport | undefined;
  private terminalError: RemoteRuntimeError | undefined;
  private closePromise: Promise<void> | undefined;

  public async attachScope(scope: RequestScope): Promise<void> {
    if (this.terminalError || this.closePromise) {
      await scope.close();
      throw this.terminalError ?? requestAlreadyClosed();
    }
    this.scope = scope;
  }

  public async attachMcpServer(server: McpServer): Promise<void> {
    if (this.terminalError || this.closePromise) {
      await server.close().catch(() => undefined);
      throw this.terminalError ?? requestAlreadyClosed();
    }
    this.mcpServer = server;
  }

  public async attachTransport(transport: StreamableHTTPServerTransport): Promise<void> {
    if (this.terminalError || this.closePromise) {
      await transport.close().catch(() => undefined);
      throw this.terminalError ?? requestAlreadyClosed();
    }
    this.transport = transport;
  }

  public assertAvailable(signal: AbortSignal): void {
    if (signal.aborted || this.terminalError || this.closePromise) {
      throw this.terminalError ?? requestAlreadyClosed();
    }
  }

  public markCancelled(error: RemoteRuntimeError): void {
    this.terminalError ??= error;
  }

  public async close(): Promise<void> {
    this.closePromise ??= (async () => {
      const errors: unknown[] = [];
      if (this.transport) await this.transport.close().catch((error: unknown) => errors.push(error));
      if (this.mcpServer) await this.mcpServer.close().catch((error: unknown) => errors.push(error));
      if (this.scope) await this.scope.close().catch((error: unknown) => errors.push(error));
      if (errors.length > 0) {
        throw new RemoteRuntimeError(
          'MCP_REQUEST_CLEANUP_FAILED',
          'One or more isolated MCP request resources could not be cleaned up.',
          { cause: errors[0] },
        );
      }
    })();
    await this.closePromise;
  }
}

class RemoteHttpError extends RemoteRuntimeError {
  public constructor(
    code: RemoteRuntimeError['code'],
    message: string,
    public readonly status: number,
  ) {
    super(code, message);
  }
}

type NormalizedRequestError = Readonly<{
  code: string;
  correlationId: string;
  message: string;
  identityError?: IdentityRuntimeError;
  remoteError?: RemoteRuntimeError;
}>;

function normalizeRequestError(error: unknown, correlationId: string): NormalizedRequestError {
  if (error instanceof IdentityRuntimeError) {
    const correlated = error.correlationId
      ? error
      : new IdentityRuntimeError(error.code, error.message, { cause: error.cause, correlationId });
    return { code: correlated.code, correlationId, message: correlated.message, identityError: correlated };
  }
  if (error instanceof ControlPlaneError) {
    const remote = new RemoteRuntimeError(
      'MCP_RUNTIME_CONTROL_PLANE_UNAVAILABLE',
      error.message,
      { cause: error, correlationId },
    );
    return { code: remote.code, correlationId, message: remote.message, remoteError: remote };
  }
  const remote = error instanceof RemoteRuntimeError
    ? withRemoteCorrelation(error, correlationId)
    : toRemoteRuntimeError(
        error,
        'MCP_PROVIDER_INITIALIZATION_FAILED',
        'The remote MCP request failed before a safe response was produced.',
        correlationId,
      );
  return { code: remote.code, correlationId, message: remote.message, remoteError: remote };
}

function writeNormalizedError(
  response: ServerResponse,
  error: NormalizedRequestError,
  status: number,
  secrets: readonly string[],
): void {
  const message = error.identityError
    ? formatRuntimeError(error.identityError, secrets, error.correlationId)
    : formatRemoteRuntimeError(error.remoteError as RemoteRuntimeError, secrets, error.correlationId);
  writeJson(response, status, {
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message,
      data: {
        errorCode: error.code,
        correlationId: error.correlationId,
        ...(error.code === 'MCP_DML_OUTCOME_UNKNOWN' ? { retryable: false } : {}),
      },
    },
    id: null,
  });
}

function errorStatus(original: unknown, normalized: NormalizedRequestError): number {
  if (original instanceof RemoteHttpError) return original.status;
  switch (normalized.code) {
    case 'MCP_CLIENT_AUTH_REQUIRED':
    case 'MCP_CLIENT_AUTH_INVALID':
    case 'MCP_IDENTITY_CREDENTIAL_INVALID':
    case 'MCP_IDENTITY_CREDENTIAL_REVOKED':
    case 'MCP_PLATFORM_USER_REQUIRED':
      return 401;
    case 'MCP_IDENTITY_ROUTE_NOT_FOUND':
    case 'MCP_IDENTITY_CONTEXT_MISMATCH':
    case 'MCP_IDENTITY_ROUTE_DISABLED':
    case 'MCP_CONNECTION_ROLE_NOT_AVAILABLE':
    case 'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED':
    case 'MCP_HOST_NOT_ALLOWED':
    case 'MCP_ORIGIN_NOT_ALLOWED':
      return 403;
    case 'MCP_REQUEST_TOO_LARGE':
      return 413;
    case 'MCP_REQUEST_TIMEOUT':
    case 'MCP_TOOL_TIMEOUT':
    case 'MCP_DML_OUTCOME_UNKNOWN':
      return 504;
    case 'MCP_RUNTIME_NOT_READY':
    case 'MCP_RUNTIME_CONTROL_PLANE_UNAVAILABLE':
      return 503;
    case 'MCP_SALESFORCE_AUTH_FAILED':
    case 'MCP_SALESFORCE_CONNECTION_FAILED':
      return 502;
    case 'MCP_REQUEST_INVALID':
      return 400;
    default:
      return 500;
  }
}

function isBlocked(code: string): boolean {
  return [
    'MCP_CLIENT_AUTH_REQUIRED',
    'MCP_CLIENT_AUTH_INVALID',
    'MCP_IDENTITY_CREDENTIAL_INVALID',
    'MCP_IDENTITY_CREDENTIAL_REVOKED',
    'MCP_IDENTITY_ROUTE_DISABLED',
    'MCP_PLATFORM_USER_REQUIRED',
    'MCP_IDENTITY_ROUTE_NOT_FOUND',
    'MCP_IDENTITY_CONTEXT_MISMATCH',
    'MCP_CONNECTION_ROLE_NOT_AVAILABLE',
    'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED',
    'MCP_HOST_NOT_ALLOWED',
    'MCP_ORIGIN_NOT_ALLOWED',
    'MCP_TOOL_DISABLED',
    'MCP_TOOL_NOT_AVAILABLE',
  ].includes(code);
}

function validateHostAndOrigin(
  request: IncomingMessage,
  allowedHosts: readonly string[],
  allowedOrigins: readonly string[],
): void {
  const host = request.headers.host?.toLocaleLowerCase('en-US');
  if (!host || !allowedHosts.includes(host)) {
    throw new RemoteHttpError('MCP_HOST_NOT_ALLOWED', 'The HTTP Host header is not allowed.', 403);
  }
  const origin = request.headers.origin;
  if (Array.isArray(origin) || (origin !== undefined && !allowedOrigins.includes(origin))) {
    throw new RemoteHttpError('MCP_ORIGIN_NOT_ALLOWED', 'The HTTP Origin header is not allowed.', 403);
  }
}

function assertMethod(request: IncomingMessage, expected: 'GET' | 'POST'): void {
  if (request.method !== expected) {
    throw new RemoteHttpError('MCP_REQUEST_INVALID', `Only ${expected} is allowed for this endpoint.`, 405);
  }
}

function assertContentType(request: IncomingMessage): void {
  const value = request.headers['content-type'];
  const contentType = Array.isArray(value) ? undefined : value?.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US');
  if (contentType !== 'application/json') {
    throw new RemoteHttpError('MCP_REQUEST_INVALID', 'Content-Type must be application/json.', 415);
  }
}

function parseCorrelationId(request: IncomingMessage): string {
  const value = request.headers['x-correlation-id'];
  const candidate = Array.isArray(value) ? undefined : value;
  const parsed = correlationIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : randomUUID();
}

function toRequestHeaders(request: IncomingMessage): RequestHeaders {
  return Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, value]));
}

function createAuthenticator(config: RemoteRuntimeConfig): ClientAuthenticator {
  return config.authMode === 'disabled'
    ? new DisabledLoopbackAuthenticator()
    : new InternalBearerAuthenticator(config.clientToken ?? '');
}

function loopbackHosts(port: number): readonly string[] {
  return Object.freeze([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

function loopbackOrigins(port: number): readonly string[] {
  return Object.freeze([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
}

function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function waitForResponseCompletion(response: ServerResponse): Promise<void> {
  if (response.writableEnded || response.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      response.off('finish', onComplete);
      response.off('close', onComplete);
      response.off('error', onError);
    };
    const onComplete = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    response.once('finish', onComplete);
    response.once('close', onComplete);
    response.once('error', onError);
  });
}

function requestAlreadyClosed(): RemoteRuntimeError {
  return new RemoteRuntimeError(
    'MCP_REQUEST_TIMEOUT',
    'The request resource boundary was already closed before setup completed.',
  );
}

function requestLevelDmlOutcomeUnknown(
  operation: DmlOperation,
  cause: unknown,
  correlationId: string,
): RemoteRuntimeError {
  const outcome = dmlOutcomeUnknownError(operation, cause);
  return new RemoteRuntimeError('MCP_DML_OUTCOME_UNKNOWN', outcome.message, {
    cause,
    correlationId,
  });
}

function dmlToolName(operation: DmlOperation): 'create_record' | 'update_record' {
  return operation === 'CREATE' ? 'create_record' : 'update_record';
}

function logCleanupFailure(
  error: unknown,
  observation: RequestObservation,
  logger: RuntimeLogger,
  onCleanupFailure: () => void,
): void {
  onCleanupFailure();
  const runtimeError = toRemoteRuntimeError(
    error,
    'MCP_REQUEST_CLEANUP_FAILED',
    'Request resource cleanup failed.',
    observation.correlationId,
  );
  void Promise.resolve(logger.log({
    correlationId: observation.correlationId,
    ...(observation.clientId ? { clientId: observation.clientId } : {}),
    ...(observation.platformUserId ? { platformUserId: observation.platformUserId } : {}),
    ...(observation.salesforceUsername ? { salesforceUsername: observation.salesforceUsername } : {}),
    ...(observation.identitySource ? { identitySource: observation.identitySource } : {}),
    ...(observation.identityCredentialId ? { identityCredentialId: observation.identityCredentialId } : {}),
    result: 'ERROR',
    errorCode: runtimeError.code,
  })).catch(() => undefined);
}

function createIdentityProvider(config: RemoteRuntimeConfig, authenticator?: ClientAuthenticator): IdentityProvider {
  return new LegacyHeaderIdentityProvider(authenticator ?? createAuthenticator(config));
}

function readAuditPersistenceHealth(
  logger: RuntimeLogger,
): Readonly<{ status: 'UP' | 'DEGRADED'; failureCount: number }> | undefined {
  const candidate = logger as RuntimeLogger & Readonly<{ getHealth?: () => unknown }>;
  if (typeof candidate.getHealth !== 'function') return undefined;
  const health = candidate.getHealth();
  if (
    typeof health !== 'object' ||
    health === null ||
    !('status' in health) ||
    !('failureCount' in health)
  ) return undefined;
  const status = health.status;
  const failureCount = health.failureCount;
  if (
    (status !== 'UP' && status !== 'DEGRADED') ||
    typeof failureCount !== 'number' ||
    !Number.isInteger(failureCount) ||
    failureCount < 0
  ) return undefined;
  return Object.freeze({ status, failureCount });
}

function assertDiagnosticSnapshotValid(
  enabledTools: readonly string[],
  hasDiagnostic: boolean,
  correlationId: string,
): void {
  const diagnosticEnabled = enabledTools.some(
    (name) => isSfoaContextToolName(name) && SFOA_CONTEXT_TOOL_ROLES[name] === 'DIAGNOSTIC',
  );
  if (diagnosticEnabled && !hasDiagnostic) {
    throw new RemoteRuntimeError(
      'MCP_DIAGNOSTIC_CONFIGURATION_INVALID',
      'Diagnostic Tools are enabled but the MySQL Control Plane has no enabled Diagnostic configuration.',
      { correlationId },
    );
  }
}

async function auditDisabledToolAttempt(
  body: unknown,
  enabledTools: readonly string[],
  principal: AuthenticatedPrincipal,
  logger: RuntimeLogger,
): Promise<void> {
  if (!isRecord(body) || body.method !== 'tools/call' || !isRecord(body.params)) return;
  const name = body.params.name;
  if (typeof name !== 'string' || enabledTools.includes(name)) return;
  await Promise.resolve(logger.log({
    correlationId: principal.correlationId,
    clientId: principal.clientId,
    platformUserId: principal.platformUserId,
    identitySource: principal.identitySource,
    ...(principal.credentialId ? { identityCredentialId: principal.credentialId } : {}),
    toolName: name.slice(0, 128),
    result: 'BLOCKED',
    outcome: 'DENIED',
    errorCode: 'MCP_TOOL_DISABLED',
    requestSummary: { toolName: name.slice(0, 128) },
  })).catch(() => undefined);
}

function bindPrincipalLogger(logger: RuntimeLogger, principal: AuthenticatedPrincipal): RuntimeLogger {
  return Object.freeze({
    log: (event: RuntimeLogEvent) => logger.log({
      ...event,
      clientId: principal.clientId,
      platformUserId: principal.platformUserId,
      identitySource: principal.identitySource,
      ...(principal.credentialId ? { identityCredentialId: principal.credentialId } : {}),
    }),
  });
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function closeHttpServerImmediately(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = once(server, 'close').then(() => undefined);
  server.closeAllConnections();
  server.close();
  await closed;
}

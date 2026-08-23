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
import {
  dmlOutcomeUnknownError,
  type DmlOperation,
} from '@sfoa/mcp-provider-sfoa-dml';
import {
  formatRuntimeError,
  IdentityRuntimeError,
  type IdentityRuntime,
  type RequestHeaders,
  type RequestScope,
  type RuntimeLogger,
  type TrustedRequestIdentity,
} from '@sfoa/identity-runtime';
import { z } from 'zod';
import {
  DisabledLoopbackAuthenticator,
  InternalBearerAuthenticator,
  type AuthenticatedClient,
  type ClientAuthenticator,
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
  initializeProviderRuntime,
  type InitializedProviderRuntime,
  MutationRequestState,
} from './provider-runtime.js';
import { readBoundedJsonBody } from './request-body.js';
import { delay, withTimeout } from './timeouts.js';
import type { RequestToolSource } from '@sfoa/identity-runtime';

const platformUserIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !/[\u0000-\u001F\u007F]/u.test(value), 'must not contain control characters');
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
  authenticator?: ClientAuthenticator;
}>;

type RequestObservation = {
  correlationId: string;
  clientId?: string;
  platformUserId?: string;
  salesforceUsername?: string;
};

export async function startRemoteMcpServer(options: StartRemoteMcpServerOptions): Promise<RemoteMcpServer> {
  assertValidTimeoutHierarchy(options.config.requestTimeoutMs, options.config.toolTimeoutMs);
  const initializedProvider = await initializeProviderRuntime(
    options.config.enabledTools,
    options.toolSource,
    options.inventoryToolSource,
    options.config.dmlAllowlist,
  );
  const authenticator = options.authenticator ?? createAuthenticator(options.config);
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
      authenticator,
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
  authenticator: ClientAuthenticator;
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
    options.logger.log({
      correlationId: observation.correlationId,
      ...(observation.clientId ? { clientId: observation.clientId } : {}),
      ...(observation.platformUserId ? { platformUserId: observation.platformUserId } : {}),
      ...(observation.salesforceUsername ? { salesforceUsername: observation.salesforceUsername } : {}),
      toolName: dmlToolName(operation),
      operation,
      outcome: 'UNKNOWN',
      mutationStarted: true,
      terminationLayer: 'TRANSPORT',
      durationMs: elapsed(started),
      result: 'ERROR',
      errorCode: 'MCP_DML_OUTCOME_UNKNOWN',
    });
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
      writeJson(options.response, 200, { status: 'UP' });
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
      options.logger.log({
        correlationId: observation.correlationId,
        ...(observation.clientId ? { clientId: observation.clientId } : {}),
        ...(observation.platformUserId ? { platformUserId: observation.platformUserId } : {}),
        ...(observation.salesforceUsername ? { salesforceUsername: observation.salesforceUsername } : {}),
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
      });
    }
    if (!options.response.headersSent) {
      writeNormalizedError(
        options.response,
        normalized,
        errorStatus(error, normalized),
        [...options.identityRuntime.redactionSecrets, options.config.clientToken ?? ''],
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
  const client = options.authenticator.authenticate(headers);
  observation.clientId = client.clientId;
  const identity = parseAuthenticatedIdentity(headers, options.config.platformUserHeader, observation.correlationId);
  observation.platformUserId = identity.platformUserId;
  assertContentType(options.request);
  const parsedBody = await readBoundedJsonBody(options.request, options.config.maxBodyBytes);
  resources.assertAvailable(signal);

  const scope = await options.identityRuntime.scopeFactory.create(identity);
  await resources.attachScope(scope);
  resources.assertAvailable(signal);
  observation.salesforceUsername = scope.route.salesforceUsername;

  const created = await createGovernedMcpServer({
    scope,
    cwdGuard: options.identityRuntime.cwdGuard,
    logger: options.logger,
    clientId: client.clientId,
    toolTimeoutMs: options.config.toolTimeoutMs,
    redactionSecrets: [...options.identityRuntime.redactionSecrets, options.config.clientToken ?? ''],
    mutationRequestState,
    initializedProvider: options.initializedProvider,
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
    case 'MCP_PLATFORM_USER_REQUIRED':
      return 401;
    case 'MCP_IDENTITY_ROUTE_NOT_FOUND':
    case 'MCP_IDENTITY_CONTEXT_MISMATCH':
    case 'MCP_CONNECTION_ROLE_NOT_AVAILABLE':
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
    'MCP_PLATFORM_USER_REQUIRED',
    'MCP_IDENTITY_ROUTE_NOT_FOUND',
    'MCP_IDENTITY_CONTEXT_MISMATCH',
    'MCP_CONNECTION_ROLE_NOT_AVAILABLE',
    'MCP_HOST_NOT_ALLOWED',
    'MCP_ORIGIN_NOT_ALLOWED',
    'MCP_TOOL_DISABLED',
    'MCP_TOOL_NOT_AVAILABLE',
  ].includes(code);
}

function parseAuthenticatedIdentity(
  headers: RequestHeaders,
  platformHeaderName: string,
  correlationId: string,
): TrustedRequestIdentity {
  const value = getSingleHeader(headers, platformHeaderName.toLocaleLowerCase('en-US'));
  if (value === undefined || value.trim().length === 0) {
    throw new IdentityRuntimeError(
      'MCP_PLATFORM_USER_REQUIRED',
      `${platformHeaderName} is required after MCP client authentication.`,
      { correlationId },
    );
  }
  const parsed = platformUserIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new IdentityRuntimeError(
      'MCP_REQUEST_SCOPE_FAILED',
      `${platformHeaderName} must contain 1-128 printable characters.`,
      { correlationId },
    );
  }
  return Object.freeze({ platformUserId: parsed.data, correlationId });
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

function getSingleHeader(headers: RequestHeaders, targetName: string): string | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLocaleLowerCase('en-US') === targetName);
  const value = entry?.[1];
  if (typeof value === 'string' || value === undefined) return value;
  return value.length === 1 ? value[0] : undefined;
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
  logger.log({
    correlationId: observation.correlationId,
    ...(observation.clientId ? { clientId: observation.clientId } : {}),
    ...(observation.platformUserId ? { platformUserId: observation.platformUserId } : {}),
    ...(observation.salesforceUsername ? { salesforceUsername: observation.salesforceUsername } : {}),
    result: 'ERROR',
    errorCode: runtimeError.code,
  });
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

async function closeHttpServerImmediately(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = once(server, 'close').then(() => undefined);
  server.closeAllConnections();
  server.close();
  await closed;
}

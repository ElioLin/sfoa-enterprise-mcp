import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  IdentityRuntimeError,
  formatRuntimeError,
  toIdentityRuntimeError,
} from './errors.js';
import { createRequestMcpServer, type RequestToolSource } from './provider-tools.js';
import type { RequestHeaders } from './request-context.js';
import type { RequestScope, RequestScopeFactory } from './request-scope.js';
import type { RuntimeLogger } from './runtime-logger.js';
import { RequestScopedToolExecutionAdapter } from './tool-execution-adapter.js';
import type { CwdExecutionGuard } from './cwd-execution-guard.js';

export type IdentityHttpServer = Readonly<{
  url: URL;
  close(): Promise<void>;
  readonly registeredTools: readonly string[];
}>;

export type StartIdentityHttpServerOptions = Readonly<{
  scopeFactory: RequestScopeFactory;
  cwdGuard: CwdExecutionGuard;
  logger: RuntimeLogger;
  redactionSecrets?: readonly string[];
  toolSource?: RequestToolSource;
  port?: number;
}>;

export async function startIdentityHttpServer(
  options: StartIdentityHttpServerOptions,
): Promise<IdentityHttpServer> {
  let allowedHosts: string[] = [];
  let allowedOrigins: string[] = [];
  let registeredTools: readonly string[] = [];

  const httpServer = createServer((request, response) => {
    void handleHttpRequest(request, response, options, allowedHosts, allowedOrigins, (names) => {
      registeredTools = names;
    }).catch((error: unknown) => {
      const runtimeError = toIdentityRuntimeError(
        error,
        'MCP_REQUEST_SCOPE_FAILED',
        'The P1 HTTP request failed before a response could be produced.',
      );
      if (!response.headersSent) writeRuntimeError(response, runtimeError, 500, options.redactionSecrets);
    });
  });

  httpServer.listen(options.port ?? 0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    await closeHttpServer(httpServer);
    throw new IdentityRuntimeError('MCP_REQUEST_SCOPE_FAILED', 'The P1 HTTP server did not bind to a TCP port.');
  }

  allowedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
  allowedOrigins = [`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`];
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);

  return Object.freeze({
    url,
    close: async () => closeHttpServer(httpServer),
    get registeredTools() {
      return registeredTools;
    },
  });
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: StartIdentityHttpServerOptions,
  allowedHosts: readonly string[],
  allowedOrigins: readonly string[],
  onRegisteredTools: (names: readonly string[]) => void,
): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (requestUrl.pathname !== '/mcp') {
    writeProtocolError(response, 404, -32001, 'Not found.');
    return;
  }
  if (request.method !== 'POST') {
    writeProtocolError(response, 405, -32000, 'Method not allowed.');
    return;
  }
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    writeProtocolError(response, 403, -32000, 'Origin not allowed.');
    return;
  }
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US');
  if (contentType !== 'application/json') {
    writeProtocolError(response, 415, -32000, 'Content-Type must be application/json.');
    return;
  }

  let scope: RequestScope | undefined;
  let transport: StreamableHTTPServerTransport | undefined;
  let mcpServer: Awaited<ReturnType<typeof createRequestMcpServer>>['server'] | undefined;
  let closePromise: Promise<void> | undefined;

  const closeRequestResources = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        if (transport) await transport.close();
      } finally {
        try {
          if (mcpServer) await mcpServer.close();
        } finally {
          if (scope) await scope.close();
        }
      }
    })();
    return closePromise;
  };

  const scheduleRequestCleanup = (): void => {
    void closeRequestResources().catch((error: unknown) => {
      const runtimeError = toIdentityRuntimeError(
        error,
        'MCP_REQUEST_WORKSPACE_FAILED',
        'Request resource cleanup failed.',
      );
      options.logger.log({
        correlationId: runtimeError.correlationId ?? randomUUID(),
        result: 'ERROR',
        errorCode: runtimeError.code,
      });
    });
  };
  response.once('finish', scheduleRequestCleanup);
  response.once('close', scheduleRequestCleanup);

  try {
    scope = await options.scopeFactory.createFromHeaders(toRequestHeaders(request));
    response.setHeader('x-correlation-id', scope.context.correlationId);
    const adapter = new RequestScopedToolExecutionAdapter(
      scope.context,
      scope.route,
      scope.workspace,
      options.cwdGuard,
      options.logger,
      options.redactionSecrets,
    );
    const created = await createRequestMcpServer(scope.services, adapter, options.toolSource);
    mcpServer = created.server;
    onRegisteredTools(created.registeredTools);
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      allowedHosts: [...allowedHosts],
      enableDnsRebindingProtection: true,
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(request, response);
  } catch (error) {
    const runtimeError = toIdentityRuntimeError(
      error,
      'MCP_REQUEST_SCOPE_FAILED',
      'The server could not create or execute the isolated MCP request scope.',
    );
    const correlationId = runtimeError.correlationId ?? scope?.context.correlationId ?? randomUUID();
    options.logger.log({
      correlationId,
      platformUserId: scope?.context.platformUserId,
      salesforceUsername: scope?.route.salesforceUsername,
      result:
        runtimeError.code === 'MCP_IDENTITY_ROUTE_NOT_FOUND' ||
        runtimeError.code === 'MCP_PLATFORM_USER_REQUIRED'
          ? 'BLOCKED'
          : 'ERROR',
      errorCode: runtimeError.code,
    });
    if (!response.headersSent) {
      response.setHeader('x-correlation-id', correlationId);
      writeRuntimeError(response, runtimeError, httpStatus(runtimeError), options.redactionSecrets, correlationId);
    } else if (!response.writableEnded) {
      response.end();
    }
  }
}

function toRequestHeaders(request: IncomingMessage): RequestHeaders {
  return Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [name, value]),
  );
}

function writeRuntimeError(
  response: ServerResponse,
  error: IdentityRuntimeError,
  status: number,
  secrets: readonly string[] = [],
  correlationId = error.correlationId,
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: formatRuntimeError(error, secrets, correlationId),
        data: { errorCode: error.code, correlationId },
      },
      id: null,
    }),
  );
}

function writeProtocolError(response: ServerResponse, status: number, code: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function httpStatus(error: IdentityRuntimeError): number {
  switch (error.code) {
    case 'MCP_PLATFORM_USER_REQUIRED':
      return 401;
    case 'MCP_IDENTITY_ROUTE_NOT_FOUND':
    case 'MCP_IDENTITY_CONTEXT_MISMATCH':
    case 'MCP_CONNECTION_ROLE_NOT_AVAILABLE':
      return 403;
    case 'MCP_SALESFORCE_AUTH_FAILED':
    case 'MCP_SALESFORCE_CONNECTION_FAILED':
      return 502;
    case 'MCP_REQUEST_WORKSPACE_FAILED':
    case 'MCP_REQUEST_SCOPE_FAILED':
      return 500;
  }
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

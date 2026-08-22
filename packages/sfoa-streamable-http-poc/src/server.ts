import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type Services } from '@salesforce/mcp-provider-api';
import { registerOfficialTools } from './provider-registry.js';
import { PocServices, allowedOrgsFromEnvironment } from './services.js';

export type PocHttpServer = {
  url: URL;
  registeredTools: readonly string[];
  close(): Promise<void>;
};

export type StartPocServerOptions = {
  port?: number;
  servicesFactory?: () => Services;
};

export async function createOfficialProviderServer(services: Services): Promise<{
  server: McpServer;
  registeredTools: string[];
}> {
  const server = new McpServer({
    name: 'sfoa-streamable-http-poc',
    version: '0.0.0-p0',
  });
  const registeredTools = await registerOfficialTools(server, services);
  return { server, registeredTools };
}

export async function startPocHttpServer(options: StartPocServerOptions = {}): Promise<PocHttpServer> {
  const servicesFactory =
    options.servicesFactory ??
    (() => new PocServices({ allowedOrgs: allowedOrgsFromEnvironment() }));

  let allowedHosts: string[] = [];
  let allowedOrigins: string[] = [];
  let registeredTools: readonly string[] = [];

  const httpServer = createServer((request, response) => {
    void handleHttpRequest(request, response, servicesFactory, allowedHosts, allowedOrigins, (tools) => {
      registeredTools = tools;
    }).catch((error: unknown) => {
      if (!response.headersSent) {
        writeJsonRpcError(response, 500, -32603, 'Internal MCP server error.');
      }
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Streamable HTTP POC request setup failed: ${message}\n`);
    });
  });

  httpServer.listen(options.port ?? 0, '127.0.0.1');
  await once(httpServer, 'listening');

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    await closeHttpServer(httpServer);
    throw new Error('POC HTTP server did not bind to a TCP port.');
  }

  allowedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
  allowedOrigins = [`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`];
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);

  return {
    url,
    get registeredTools() {
      return registeredTools;
    },
    close: async () => closeHttpServer(httpServer),
  };
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  servicesFactory: () => Services,
  allowedHosts: string[],
  allowedOrigins: string[],
  onRegisteredTools: (tools: readonly string[]) => void,
): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (requestUrl.pathname !== '/mcp') {
    writeJsonRpcError(response, 404, -32001, 'Not found.');
    return;
  }

  if (request.method !== 'POST') {
    writeJsonRpcError(response, 405, -32000, 'Method not allowed.');
    return;
  }

  const origin = request.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    writeJsonRpcError(response, 403, -32000, 'Origin not allowed.');
    return;
  }

  const { server, registeredTools } = await createOfficialProviderServer(servicesFactory());
  onRegisteredTools(registeredTools);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    allowedHosts,
    enableDnsRebindingProtection: true,
  });
  let closed = false;
  const closeRequestScope = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await transport.close();
    await server.close();
  };

  response.once('close', () => {
    void closeRequestScope().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Streamable HTTP POC cleanup failed: ${message}\n`);
    });
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } catch (error: unknown) {
    if (!response.headersSent) {
      writeJsonRpcError(response, 500, -32603, 'Internal MCP server error.');
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Streamable HTTP POC request failed: ${message}\n`);
    await closeRequestScope();
  }
}

function writeJsonRpcError(response: ServerResponse, status: number, code: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    }),
  );
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

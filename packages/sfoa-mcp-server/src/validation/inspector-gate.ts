import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createIdentityRuntime, redactSensitiveText } from '@sfoa/identity-runtime';
import { loadRemoteRuntimeConfig, type RemoteRuntimeConfig } from '../config.js';
import { startRemoteMcpServer } from '../http-server.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const inspectorServerPath = path.join(
  projectRoot,
  'node_modules',
  '@modelcontextprotocol',
  'inspector',
  'server',
  'build',
  'index.js',
);

async function main(): Promise<void> {
  const config = await loadRemoteRuntimeConfig(projectRoot);
  const secondaryUsername = config.identity.secondaryUsername;
  const clientToken = config.clientToken;
  if (!secondaryUsername || !clientToken) {
    throw new Error('SECOND_TEST_USER and MCP_CLIENT_TOKEN are required for the two-user Inspector gate.');
  }

  const liveConfig: RemoteRuntimeConfig = Object.freeze({
    ...config,
    bindHost: '127.0.0.1',
    port: 0,
    enabledTools: Object.freeze(['get_username', 'run_soql_query']),
    allowedHosts: Object.freeze([]),
    allowedOrigins: Object.freeze([]),
    useLoopbackHostDefaults: true,
    useLoopbackOriginDefaults: true,
  });
  const runtime = createIdentityRuntime(config.identity);
  const server = await startRemoteMcpServer({ config: liveConfig, identityRuntime: runtime });
  const inspectorPort = await reservePort();
  const proxyToken = randomBytes(32).toString('base64url');
  const inspector = startInspector(inspectorPort, proxyToken);

  try {
    await waitForInspector(inspectorPort, inspector);
    const resultA = await runInspectorClient(
      inspectorPort,
      proxyToken,
      clientToken,
      config.platformUserHeader,
      config.identity.platformUserA,
      config.identity.primaryUsername,
      server.mcpUrl,
    );
    const resultB = await runInspectorClient(
      inspectorPort,
      proxyToken,
      clientToken,
      config.platformUserHeader,
      config.identity.platformUserB,
      secondaryUsername,
      server.mcpUrl,
    );
    if (!resultA || !resultB) throw new Error('Inspector returned an unexpected Salesforce identity.');
    process.stdout.write('MCP Inspector 0.15.0 proxy initialize: PASS\n');
    process.stdout.write('MCP Inspector tools/list (enabled Tools only): PASS\n');
    process.stdout.write('MCP Inspector tools/call User A: PASS\n');
    process.stdout.write('MCP Inspector tools/call User B: PASS\n');
    process.stdout.write('P2 INSPECTOR = PASS\n');
  } finally {
    await stopInspector(inspector);
    await server.close();
  }
}

async function runInspectorClient(
  inspectorPort: number,
  proxyToken: string,
  clientToken: string,
  platformUserHeader: string,
  platformUserId: string,
  expectedUsername: string,
  targetUrl: URL,
): Promise<boolean> {
  const proxyUrl = new URL(`http://127.0.0.1:${inspectorPort}/mcp`);
  proxyUrl.searchParams.set('transportType', 'streamable-http');
  proxyUrl.searchParams.set('url', targetUrl.href);
  const transport = new StreamableHTTPClientTransport(proxyUrl, {
    requestInit: {
      headers: {
        'x-mcp-proxy-auth': `Bearer ${proxyToken}`,
        authorization: `Bearer ${clientToken}`,
        'x-custom-auth-header': platformUserHeader,
        [platformUserHeader]: platformUserId,
      },
    },
  });
  const client = new Client({ name: `p2-inspector-${platformUserId}`, version: '0.1.0-p2' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    if (!sameArray(listed.tools.map((tool) => tool.name), ['get_username', 'run_soql_query'])) return false;
    const result = CallToolResultSchema.parse(
      await client.callTool({ name: 'get_username', arguments: {} }),
    );
    return result.isError !== true && textContent(result).includes(expectedUsername);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function startInspector(port: number, proxyToken: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [inspectorServerPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CLIENT_PORT: '6274',
      MCP_PROXY_TOKEN: proxyToken,
    },
    stdio: 'pipe',
    windowsHide: true,
  });
}

async function waitForInspector(port: number, processHandle: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error('The project-local MCP Inspector proxy exited before becoming healthy.');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Startup connection refusal is expected until Inspector begins listening.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the project-local MCP Inspector proxy.');
}

async function stopInspector(processHandle: ChildProcessWithoutNullStreams): Promise<void> {
  if (processHandle.exitCode !== null) return;
  const exited = once(processHandle, 'exit').then(() => undefined);
  processHandle.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
}

async function reservePort(): Promise<number> {
  const temporary = createServer();
  temporary.listen(0, '127.0.0.1');
  await once(temporary, 'listening');
  const address = temporary.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve an Inspector validation port.');
  const port = address.port;
  const closed = once(temporary, 'close');
  temporary.close();
  await closed;
  return port;
}

function textContent(result: ReturnType<typeof CallToolResultSchema.parse>): string {
  return result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

void main().catch((error: unknown) => {
  const message = redactSensitiveText(
    error instanceof Error ? error.message : String(error),
    [process.env.MCP_CLIENT_TOKEN ?? ''],
  );
  process.stderr.write(`P2 Inspector gate failed: ${message}\n`);
  process.exitCode = 1;
});

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { redactError } from './security.js';

const requestOptions = { timeout: 240_000, maxTotalTimeout: 240_000 };
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const mcpBinDirectory = path.join(projectRoot, 'packages', 'mcp', 'node_modules', '.bin');
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
const pathKey = Object.keys(inheritedEnvironment).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
inheritedEnvironment[pathKey] = `${mcpBinDirectory}${path.delimiter}${inheritedEnvironment[pathKey] ?? ''}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    path.join(projectRoot, 'packages', 'mcp', 'bin', 'run.js'),
    '--toolsets',
    'core,data,metadata',
    '--orgs',
    'DEFAULT_TARGET_ORG',
    '--no-telemetry',
  ],
  cwd: projectRoot,
  env: inheritedEnvironment,
  stderr: 'pipe',
});
const client = new Client({ name: 'sfoa-p0-closure-stdio-regression', version: '0.0.0-p0-closure' });
let stderr = '';
transport.stderr?.on('data', (chunk: Buffer | string) => {
  stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
});

try {
  await client.connect(transport, requestOptions);
  const tools = await client.listTools(undefined, requestOptions);
  const toolNames = tools.tools.map((tool) => tool.name);
  const requiredTools = ['get_username', 'run_soql_query', 'retrieve_metadata'];
  if (!requiredTools.every((name) => toolNames.includes(name))) {
    throw new Error(`Original stdio server is missing required Tools: ${requiredTools.join(', ')}`);
  }

  const callResult = CallToolResultSchema.parse(
    await client.callTool(
      {
        name: 'get_username',
        arguments: {
          defaultTargetOrg: true,
          defaultDevHub: false,
          directory: projectRoot,
        },
      },
      undefined,
      requestOptions,
    ),
  );
  if (callResult.isError === true) throw new Error('Original stdio get_username returned isError=true.');

  console.log('STDIO_INITIALIZE=PASS');
  console.log(`STDIO_TOOLS_LIST=PASS (${tools.tools.length} tools)`);
  console.log('STDIO_TOOLS_CALL=PASS (get_username; response content withheld)');
  console.log('STDIO_REGRESSION=PASS');
} catch (error) {
  console.error(`STDIO_REGRESSION=FAIL: ${redactError(error)}`);
  if (stderr.trim()) console.error(`SERVER_STDERR=${redactError(stderr.trim())}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}

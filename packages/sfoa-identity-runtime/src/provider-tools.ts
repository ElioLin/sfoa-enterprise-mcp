import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DxCoreMcpProvider } from '@salesforce/mcp-provider-dx-core';
import {
  type McpTool,
  ReleaseState,
  type Services,
} from '@salesforce/mcp-provider-api';
import { IdentityRuntimeError } from './errors.js';
import type { RequestScopedToolExecutionAdapter } from './tool-execution-adapter.js';

export const P1_OFFICIAL_TOOL_NAMES = Object.freeze([
  'get_username',
  'run_soql_query',
  'retrieve_metadata',
] as const);

export interface RequestToolSource {
  provideTools(services: Services): Promise<McpTool[]>;
}

export class OfficialDxCoreToolSource implements RequestToolSource {
  public async provideTools(services: Services): Promise<McpTool[]> {
    return new DxCoreMcpProvider().provideTools(services);
  }
}

export async function createRequestMcpServer(
  services: Services,
  adapter: RequestScopedToolExecutionAdapter,
  toolSource: RequestToolSource = new OfficialDxCoreToolSource(),
): Promise<{ server: McpServer; registeredTools: readonly string[] }> {
  const server = new McpServer({ name: 'sfoa-identity-runtime', version: '0.1.0-p1' });
  const tools = await toolSource.provideTools(services);
  const selected = tools.filter(
    (tool) =>
      tool.getReleaseState() === ReleaseState.GA &&
      P1_OFFICIAL_TOOL_NAMES.includes(tool.getName() as (typeof P1_OFFICIAL_TOOL_NAMES)[number]),
  );
  const selectedNames = selected.map((tool) => tool.getName());
  const missing = P1_OFFICIAL_TOOL_NAMES.filter((name) => !selectedNames.includes(name));
  if (missing.length > 0) {
    await server.close();
    throw new IdentityRuntimeError(
      'MCP_REQUEST_SCOPE_FAILED',
      `The verified official Provider set is missing required P1 Tools: ${missing.join(', ')}.`,
    );
  }

  for (const tool of selected) registerOfficialTool(server, tool, adapter);
  return { server, registeredTools: Object.freeze(selectedNames) };
}

function registerOfficialTool(
  server: McpServer,
  tool: McpTool,
  adapter: RequestScopedToolExecutionAdapter,
): void {
  server.registerTool(tool.getName(), tool.getConfig(), (input, extra) => adapter.execute(tool, input, extra));
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  DxCoreMcpProvider,
} from '@salesforce/mcp-provider-dx-core';
import {
  type McpTool,
  ReleaseState,
  type Services,
  Toolset,
} from '@salesforce/mcp-provider-api';

const POC_TOOLSETS = new Set<Toolset>([Toolset.CORE, Toolset.DATA, Toolset.METADATA]);

export async function registerOfficialTools(server: McpServer, services: Services): Promise<string[]> {
  const provider = new DxCoreMcpProvider();
  const tools = await provider.provideTools(services);
  const selected = tools.filter(
    (tool) =>
      tool.getReleaseState() === ReleaseState.GA &&
      tool.getToolsets().some((toolset) => POC_TOOLSETS.has(toolset)),
  );

  for (const tool of selected) {
    registerOfficialTool(server, tool);
  }

  return selected.map((tool) => tool.getName());
}

function registerOfficialTool(server: McpServer, tool: McpTool): void {
  server.registerTool(tool.getName(), tool.getConfig(), (...args) => tool.exec(...args));
}

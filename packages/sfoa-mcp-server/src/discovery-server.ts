import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { isAgentInfrastructureToolName } from '@sfoa/agent-playbook';
import { ReleaseState } from '@salesforce/mcp-provider-api';
import { SfoaDmlMcpProvider, isSfoaDmlToolName } from '@sfoa/mcp-provider-sfoa-dml';
import { SfoaContextMcpProvider, isSfoaContextToolName } from '@sfoa/mcp-provider-sfoa-context';
import {
  createRuntimeAgentCapabilities, serverInstructions, registerResources, registerPrompt,
  playbookToolConfig, recordLinksToolConfig,
} from './agent-guidance.js';
import { contextToolConfig } from './context-tool-facade.js';
import { remoteToolConfig } from './remote-tool-facade.js';
import { createInventoryServices } from './upstream-drift.js';
import { RemoteRuntimeError } from './errors.js';
import type { InitializedProviderRuntime } from './provider-runtime.js';
import type { RuntimeManagedDmlFieldRule } from './dml-managed-fields.js';

const DISCOVERY_METHODS: ReadonlySet<string> = new Set([
  'initialize', 'notifications/initialized', 'tools/list', 'ping',
]);

export function classifyMcpRequest(body: unknown): 'DISCOVERY' | 'IDENTITY_REQUIRED' {
  const messages = Array.isArray(body) ? body : [body];
  return messages.length > 0 && messages.every((message: unknown) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return false;
    const value = message as Record<string, unknown>;
    return value.jsonrpc === '2.0' && typeof value.method === 'string' && DISCOVERY_METHODS.has(value.method);
  }) ? 'DISCOVERY' : 'IDENTITY_REQUIRED';
}

export type DiscoveryServerOptions = Readonly<{
  initializedProvider: InitializedProviderRuntime;
  diagnosticReady: boolean;
  managedDmlFieldRules?: readonly RuntimeManagedDmlFieldRule[];
  dynamicFormsConfigured?: boolean;
}>;

/** Only schema construction services: no principal, route, workspace or Connection provider. */
export async function createDiscoveryMcpServer(options: DiscoveryServerOptions): Promise<McpServer> {
  const runtime = options.initializedProvider;
  const capabilities = createRuntimeAgentCapabilities(runtime.enabledTools, runtime.dmlAllowlist,
    options.diagnosticReady, options.managedDmlFieldRules, options.dynamicFormsConfigured);
  const server = new McpServer({ name: 'sfoa-mcp-server', version: '0.1.0-p6-agent' }, {
    instructions: serverInstructions(capabilities),
  });
  const forbidden = (): never => {
    throw new McpError(ErrorCode.InvalidRequest, 'MCP_DISCOVERY_EXECUTION_FORBIDDEN: End-user identity is required to execute tools.');
  };
  try {
    const services = createInventoryServices();
    const tools = [
      ...await runtime.toolSource.provideTools(services),
      ...await new SfoaDmlMcpProvider(runtime.dmlAllowlist).provideTools(services),
      ...await new SfoaContextMcpProvider({
        toolNames: runtime.enabledTools.filter(isSfoaContextToolName),
        diagnosticQueryExecutor: { execute: forbidden },
        metadataContextExecutor: { execute: forbidden },
      }).provideTools(services),
    ].filter((tool) => tool.getReleaseState() === ReleaseState.GA);
    const byName = new Map(tools.map((tool) => [tool.getName(), tool]));
    if (byName.size !== tools.length) throw new RemoteRuntimeError('MCP_PROVIDER_INITIALIZATION_FAILED', 'Duplicate discovery Tool.');
    // Keep initialize capabilities aligned; the HTTP allowlist still requires identity for Resource/Prompt requests.
    registerResources(server, capabilities);
    registerPrompt(server, capabilities);
    for (const name of runtime.enabledTools) {
      if (isAgentInfrastructureToolName(name)) {
        if (name === 'get_agent_playbook') server.registerTool(name, playbookToolConfig(), forbidden);
        else server.registerTool(name, recordLinksToolConfig(), forbidden);
        continue;
      }
      const tool = byName.get(name);
      if (!tool) throw new RemoteRuntimeError('MCP_TOOL_NOT_AVAILABLE', `Enabled Tool ${name} is unavailable for discovery.`);
      const config = isSfoaDmlToolName(name) ? tool.getConfig()
        : isSfoaContextToolName(name) ? contextToolConfig(tool) : remoteToolConfig(tool, runtime.policy.getRecord(name));
      server.registerTool(name, config, forbidden);
    }
    // SDK-level guard also denies unknown Tool names and calls if the classifier ever regresses.
    server.server.setRequestHandler(CallToolRequestSchema, forbidden);
    return server;
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
}

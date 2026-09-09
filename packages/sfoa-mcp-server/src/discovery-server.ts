import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  AGENT_PLAYBOOK_VERSION,
  isAgentInfrastructureToolName,
  isAgentWorkflow,
  renderWorkflow,
  type AgentCapabilities,
  type AgentWorkflow,
} from '@sfoa/agent-playbook';
import { ReleaseState } from '@salesforce/mcp-provider-api';
import { SfoaDmlMcpProvider, isSfoaDmlToolName } from '@sfoa/mcp-provider-sfoa-dml';
import { SfoaContextMcpProvider, isSfoaContextToolName } from '@sfoa/mcp-provider-sfoa-context';
import {
  createRuntimeAgentCapabilities,
  serverInstructions,
  AGENT_GUIDANCE_PROMPT,
  AGENT_GUIDANCE_RESOURCES,
  playbookToolConfig,
  recordLinksToolConfig,
} from './agent-guidance.js';
import { contextToolConfig } from './context-tool-facade.js';
import { remoteToolConfig } from './remote-tool-facade.js';
import { createInventoryServices } from './upstream-drift.js';
import { RemoteRuntimeError } from './errors.js';
import type { InitializedProviderRuntime } from './provider-runtime.js';
import type { RuntimeManagedDmlFieldRule } from './dml-managed-fields.js';

/**
 * Identity-less WeCom Discovery RPC allowlist. Every method here is served by a
 * channel-authenticated Discovery server whose Resources/Prompts are global
 * governance surfaces with no per-user identity, route, RequestScope, or
 * Salesforce access. This set is the exact closure of the capabilities the
 * Discovery server advertises: it MUST stay in lock-step with
 * `createDiscoveryMcpServer` (see the Advertise-but-Deny rule) and MUST NOT be
 * broadened with execution methods (`tools/call`), parameter completion, or
 * unknown protocol methods.
 */
const DISCOVERY_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'notifications/initialized',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'prompts/list',
  'prompts/get',
  'ping',
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

/**
 * Registers the identity-less Resources/Prompts directly on the low-level
 * protocol server so that no SDK `completions` handler/capability is introduced.
 * The served surface mirrors `AGENT_GUIDANCE_RESOURCES` / `AGENT_GUIDANCE_PROMPT`
 * and stays a pure render of the global `AgentCapabilities` snapshot. URIs and
 * prompt names outside the registered set fail closed with InvalidParams.
 */
function registerDiscoveryGuidance(server: McpServer, capabilities: AgentCapabilities): void {
  const protocol = server.server;
  protocol.registerCapabilities({
    resources: { listChanged: false },
    prompts: { listChanged: false },
  });
  protocol.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: AGENT_GUIDANCE_RESOURCES.map((definition) => ({
      uri: definition.uri,
      name: definition.name,
      ...definition.metadata,
    })),
  }));
  protocol.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
  protocol.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const definition = AGENT_GUIDANCE_RESOURCES.find((entry) => entry.uri === request.params.uri);
    if (!definition) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown Resource URI: ${request.params.uri}`);
    }
    return { contents: [{ uri: definition.uri, mimeType: definition.metadata.mimeType, text: definition.render(capabilities) }] };
  });
  protocol.setRequestHandler(ListPromptsRequestSchema, () => ({
    prompts: [{
      name: AGENT_GUIDANCE_PROMPT.name,
      title: AGENT_GUIDANCE_PROMPT.title,
      description: AGENT_GUIDANCE_PROMPT.description,
      arguments: [{ name: 'workflow', description: 'Defaults to ALL.', required: false }],
    }],
  }));
  protocol.setRequestHandler(GetPromptRequestSchema, (request) => {
    if (request.params.name !== AGENT_GUIDANCE_PROMPT.name) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown Prompt: ${request.params.name}`);
    }
    const workflow = resolveDiscoveryWorkflow(request.params.arguments?.workflow);
    return {
      description: `SFoA Salesforce Agent Playbook ${AGENT_PLAYBOOK_VERSION} — ${workflow}`,
      messages: [{ role: 'user', content: { type: 'text', text: renderWorkflow(workflow, capabilities) } }],
    };
  });
}

function resolveDiscoveryWorkflow(raw: unknown): AgentWorkflow {
  if (raw === undefined || raw === null || raw === '') return 'ALL';
  if (typeof raw === 'string' && isAgentWorkflow(raw)) return raw;
  throw new McpError(ErrorCode.InvalidParams, 'workflow must be one of the canonical SFoA Agent workflows.');
}

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
    // Register the Resources/Prompts at the low level so initialize advertises
    // exactly `tools` + `resources` + `prompts` — in lock-step with the
    // DISCOVERY_METHODS allowlist — and NOT the `completions` capability the SDK
    // would auto-wire if a Resource or Prompt were registered via the high-level
    // McpServer helpers.
    registerDiscoveryGuidance(server, capabilities);
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

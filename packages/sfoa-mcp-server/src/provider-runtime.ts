import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type McpTool,
  ReleaseState,
} from '@salesforce/mcp-provider-api';
import {
  SfoaDmlMcpProvider,
  isSfoaDmlToolName,
  parseDmlAllowlistJson,
  type DmlAllowlistPolicy,
} from '@sfoa/mcp-provider-sfoa-dml';
import {
  NoopRuntimeLogger,
  OfficialDxCoreToolSource,
  RequestScopedToolExecutionAdapter,
  type CwdExecutionGuard,
  type RequestScope,
  type RequestToolSource,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
import { RemoteRuntimeError, toRemoteRuntimeError } from './errors.js';
import { DmlToolFacade } from './dml-tool-facade.js';
import { DmlToolGovernancePolicy } from './dml-tool-governance.js';
import { RemoteToolFacade } from './remote-tool-facade.js';
import { ToolGovernancePolicy } from './tool-governance.js';
import {
  assertEnabledRemoteContractsCompatible,
  compareOfficialProviderInventory,
  inspectOfficialDxCoreInventory,
  type OfficialProviderInventory,
  type UpstreamInventoryComparison,
} from './upstream-drift.js';

export type InitializedProviderRuntime = Readonly<{
  toolSource: RequestToolSource;
  providerToolNames: readonly string[];
  policy: ToolGovernancePolicy;
  dmlPolicy: DmlToolGovernancePolicy;
  dmlAllowlist: DmlAllowlistPolicy;
  enabledTools: readonly string[];
  inventory: OfficialProviderInventory;
  inventoryComparison: UpstreamInventoryComparison;
}>;

export type CreateGovernedMcpServerOptions = Readonly<{
  scope: RequestScope;
  cwdGuard: CwdExecutionGuard;
  logger: RuntimeLogger;
  clientId: string;
  toolTimeoutMs: number;
  redactionSecrets?: readonly string[];
  initializedProvider: InitializedProviderRuntime;
}>;

export async function initializeProviderRuntime(
  enabledTools: readonly string[],
  toolSource: RequestToolSource = new OfficialDxCoreToolSource(),
  inventoryToolSource?: RequestToolSource,
  dmlAllowlist: DmlAllowlistPolicy = parseDmlAllowlistJson(undefined),
): Promise<InitializedProviderRuntime> {
  try {
    const inventory = await inspectOfficialDxCoreInventory(inventoryToolSource);
    const inventoryComparison = compareOfficialProviderInventory(inventory);
    const officialEnabledTools = enabledTools.filter((name) => !isSfoaDmlToolName(name));
    const dmlEnabledTools = enabledTools.filter(isSfoaDmlToolName);
    assertEnabledRemoteContractsCompatible(inventoryComparison, officialEnabledTools, inventory);
    const providerToolNames = Object.freeze(
      inventory.tools.filter((tool) => tool.releaseState === ReleaseState.GA).map((tool) => tool.name),
    );
    const policy = new ToolGovernancePolicy(officialEnabledTools, providerToolNames);
    const dmlPolicy = new DmlToolGovernancePolicy(dmlEnabledTools, dmlAllowlist);
    return Object.freeze({
      toolSource,
      providerToolNames,
      policy,
      dmlPolicy,
      dmlAllowlist,
      enabledTools: Object.freeze([...enabledTools]),
      inventory,
      inventoryComparison,
    });
  } catch (error) {
    if (error instanceof RemoteRuntimeError) throw error;
    throw toRemoteRuntimeError(
      error,
      'MCP_PROVIDER_INITIALIZATION_FAILED',
      'The official Provider could not be initialized for P2 startup validation.',
    );
  }
}

export async function createGovernedMcpServer(
  options: CreateGovernedMcpServerOptions,
): Promise<{ server: McpServer; registeredTools: readonly string[] }> {
  const server = new McpServer({ name: 'sfoa-mcp-server', version: '0.1.0-p3' });
  try {
    const providerTools = await options.initializedProvider.toolSource.provideTools(options.scope.services);
    const toolsByName = new Map<string, McpTool>();
    for (const tool of providerTools) {
      if (tool.getReleaseState() !== ReleaseState.GA) continue;
      if (toolsByName.has(tool.getName())) {
        throw new RemoteRuntimeError(
          'MCP_PROVIDER_INITIALIZATION_FAILED',
          `The request-scoped Provider returned duplicate Tool ${tool.getName()}.`,
        );
      }
      toolsByName.set(tool.getName(), tool);
    }
    const dmlTools = await new SfoaDmlMcpProvider(
      options.initializedProvider.dmlAllowlist,
    ).provideTools(options.scope.services);
    for (const tool of dmlTools) {
      if (tool.getReleaseState() !== ReleaseState.GA) continue;
      if (toolsByName.has(tool.getName())) {
        throw new RemoteRuntimeError(
          'MCP_PROVIDER_INITIALIZATION_FAILED',
          `The composed Providers returned duplicate Tool ${tool.getName()}.`,
        );
      }
      toolsByName.set(tool.getName(), tool);
    }

    const registered: string[] = [];
    const adapter = new RequestScopedToolExecutionAdapter(
      options.scope.context,
      options.scope.route,
      options.scope.workspace,
      options.cwdGuard,
      new NoopRuntimeLogger(),
      options.redactionSecrets,
    );

    for (const name of options.initializedProvider.enabledTools) {
      const tool = toolsByName.get(name);
      if (!tool) {
        throw new RemoteRuntimeError(
          'MCP_TOOL_NOT_AVAILABLE',
          `Enabled Tool ${name} disappeared from the request-scoped Provider composition.`,
        );
      }
      if (options.initializedProvider.dmlPolicy.isEnabled(name)) {
        const facade = new DmlToolFacade({
          tool,
          context: options.scope.context,
          route: options.scope.route,
          toolTimeoutMs: options.toolTimeoutMs,
          logger: options.logger,
          clientId: options.clientId,
          redactionSecrets: options.redactionSecrets,
        });
        server.registerTool(facade.getName(), facade.getConfig(), (input, extra) => facade.execute(input, extra));
        registered.push(name);
        continue;
      }
      const facade = new RemoteToolFacade({
        tool,
        policyRecord: options.initializedProvider.policy.getRecord(name),
        adapter,
        context: options.scope.context,
        route: options.scope.route,
        workspaceRoot: options.scope.workspace.root,
        toolTimeoutMs: options.toolTimeoutMs,
        logger: options.logger,
        clientId: options.clientId,
        redactionSecrets: options.redactionSecrets,
      });
      server.registerTool(facade.getName(), facade.getConfig(), (input, extra) => facade.execute(input, extra));
      registered.push(name);
    }

    return { server, registeredTools: Object.freeze(registered) };
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
}

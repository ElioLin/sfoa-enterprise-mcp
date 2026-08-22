import type { Connection } from '@salesforce/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type ConfigService,
  type McpTool,
  type OrgConfigInfo,
  type OrgService,
  ReleaseState,
  type SanitizedOrgAuthorization,
  type Services,
  type TelemetryEvent,
  type TelemetryService,
} from '@salesforce/mcp-provider-api';
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
import { RemoteToolFacade } from './remote-tool-facade.js';
import { ToolGovernancePolicy } from './tool-governance.js';

export type InitializedProviderRuntime = Readonly<{
  toolSource: RequestToolSource;
  providerToolNames: readonly string[];
  policy: ToolGovernancePolicy;
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
): Promise<InitializedProviderRuntime> {
  try {
    const tools = await toolSource.provideTools(createStartupServices());
    const providerToolNames = Object.freeze(
      tools.filter((tool) => tool.getReleaseState() === ReleaseState.GA).map((tool) => tool.getName()),
    );
    const policy = new ToolGovernancePolicy(enabledTools, providerToolNames);
    return Object.freeze({ toolSource, providerToolNames, policy });
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
  const server = new McpServer({ name: 'sfoa-mcp-server', version: '0.1.0-p2' });
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

    const registered: string[] = [];
    const adapter = new RequestScopedToolExecutionAdapter(
      options.scope.context,
      options.scope.route,
      options.scope.workspace,
      options.cwdGuard,
      new NoopRuntimeLogger(),
      options.redactionSecrets,
    );

    for (const name of options.initializedProvider.policy.enabledTools) {
      const tool = toolsByName.get(name);
      if (!tool) {
        throw new RemoteRuntimeError(
          'MCP_TOOL_NOT_AVAILABLE',
          `Enabled Tool ${name} disappeared from the request-scoped official Provider.`,
        );
      }
      const facade = new RemoteToolFacade({
        tool,
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

class StartupTelemetryService implements TelemetryService {
  public sendEvent(_eventName: string, _event: TelemetryEvent): void {
    // Provider inventory must not emit telemetry or perform I/O at startup.
  }
}

class StartupOrgService implements OrgService {
  public getAllowedOrgUsernames(): Promise<Set<string>> {
    return Promise.resolve(new Set());
  }

  public getAllowedOrgs(): Promise<SanitizedOrgAuthorization[]> {
    return Promise.resolve([]);
  }

  public getConnection(_username: string): Promise<Connection> {
    return Promise.reject(providerExecutionAtStartup());
  }

  public getDefaultTargetOrg(): Promise<OrgConfigInfo | undefined> {
    return Promise.resolve(undefined);
  }

  public getDefaultTargetDevHub(): Promise<OrgConfigInfo | undefined> {
    return Promise.resolve(undefined);
  }

  public findOrgByUsernameOrAlias(
    _allOrgs: SanitizedOrgAuthorization[],
    _usernameOrAlias: string,
  ): SanitizedOrgAuthorization | undefined {
    return undefined;
  }
}

class StartupConfigService implements ConfigService {
  public getDataDir(): string {
    return process.cwd();
  }

  public getStartupFlags(): { 'allow-non-ga-tools': boolean; debug: boolean } {
    return { 'allow-non-ga-tools': false, debug: false };
  }
}

function createStartupServices(): Services {
  const telemetry = new StartupTelemetryService();
  const org = new StartupOrgService();
  const config = new StartupConfigService();
  return {
    getTelemetryService: () => telemetry,
    getOrgService: () => org,
    getConfigService: () => config,
  };
}

function providerExecutionAtStartup(): RemoteRuntimeError {
  return new RemoteRuntimeError(
    'MCP_PROVIDER_INITIALIZATION_FAILED',
    'The official Provider attempted Salesforce execution during readiness initialization.',
  );
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  isAgentInfrastructureToolName,
} from '@sfoa/agent-playbook';
import {
  type McpTool,
  ReleaseState,
} from '@salesforce/mcp-provider-api';
import {
  SfoaDmlMcpProvider,
  isSfoaDmlToolName,
  parseDmlAllowlistJson,
  type DmlAllowlistPolicy,
  type DmlOperation,
  type MutationExecutionObserver,
} from '@sfoa/mcp-provider-sfoa-dml';
import {
  SfoaContextMcpProvider,
  isSfoaContextToolName,
  type SfoaContextToolName,
} from '@sfoa/mcp-provider-sfoa-context';
import {
  NoopRuntimeLogger,
  OfficialDxCoreToolSource,
  RequestAuditContextController,
  RequestScopedToolExecutionAdapter,
  currentSalesforceCallSemanticScope,
  runWithRequestAuditContext,
  runWithSalesforceSubmittedDmlSemantic,
  type CwdExecutionGuard,
  type RequestScope,
  type RequestToolSource,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
import { RemoteRuntimeError, toRemoteRuntimeError } from './errors.js';
import {
  createRuntimeAgentCapabilities,
  registerAgentGuidance,
  serverInstructions,
} from './agent-guidance.js';
import { ContextToolFacade } from './context-tool-facade.js';
import {
  OfficialDiagnosticToolingQueryExecutor,
  OfficialMetadataComponentContextExecutor,
} from './diagnostic-context-adapters.js';
import { DmlToolFacade } from './dml-tool-facade.js';
import { ManagedDmlFieldResolver, type RuntimeManagedDmlFieldRule } from './dml-managed-fields.js';
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
  mutationRequestState: MutationRequestState;
  initializedProvider: InitializedProviderRuntime;
  diagnosticReady: boolean;
  managedDmlFieldRules?: readonly RuntimeManagedDmlFieldRule[];
  lightningBaseUrl?: string;
  requestAuditContext?: RequestAuditContextController;
  auditIdentity: Readonly<{
    identitySource: 'INTERNAL_SERVICE_HEADER' | 'USER_BOUND_TOKEN' | 'BUNTU_TOKEN';
    identityCredentialId?: string;
  }>;
  auditClientMetadata?: Readonly<{
    conversationId?: unknown;
    turnId?: unknown;
    externalRunId?: unknown;
    agentId?: unknown;
    modelProvider?: unknown;
    modelName?: unknown;
  }>;
}>;

export class MutationRequestState implements MutationExecutionObserver {
  // One instance is created per HTTP POST; no cross-request mutation state is retained.
  private startedOperation: DmlOperation | undefined;

  public constructor(private readonly onStarted?: (operation: DmlOperation) => void) {}

  public onMutationStarted(operation: DmlOperation): void {
    if (this.startedOperation) return;
    this.startedOperation = operation;
    this.onStarted?.(operation);
  }

  public async runWithSubmittedFields<T>(
    fields: Readonly<Record<string, string | number | boolean | null>>,
    callback: () => Promise<T>,
  ): Promise<T> {
    return await runWithSalesforceSubmittedDmlSemantic({ submittedFields: fields }, callback);
  }

  public onMutationCompleted(_operation: DmlOperation, recordId: string): void {
    currentSalesforceCallSemanticScope()?.enrichRecordId(recordId);
  }

  public hasStarted(): boolean {
    return this.startedOperation !== undefined;
  }

  public getOperation(): DmlOperation | undefined {
    return this.startedOperation;
  }
}

export async function initializeProviderRuntime(
  enabledTools: readonly string[],
  toolSource: RequestToolSource = new OfficialDxCoreToolSource(),
  inventoryToolSource?: RequestToolSource,
  dmlAllowlist: DmlAllowlistPolicy = parseDmlAllowlistJson(undefined),
): Promise<InitializedProviderRuntime> {
  try {
    const inventory = await inspectOfficialDxCoreInventory(inventoryToolSource);
    const inventoryComparison = compareOfficialProviderInventory(inventory);
    const providerToolNames = Object.freeze(
      inventory.tools.filter((tool) => tool.releaseState === ReleaseState.GA).map((tool) => tool.name),
    );
    return configureProviderRuntime(Object.freeze({
      toolSource,
      providerToolNames,
      inventory,
      inventoryComparison,
    }), enabledTools, dmlAllowlist);
  } catch (error) {
    if (error instanceof RemoteRuntimeError) throw error;
    throw toRemoteRuntimeError(
      error,
      'MCP_PROVIDER_INITIALIZATION_FAILED',
      'The official Provider could not be initialized for P2 startup validation.',
    );
  }
}

export function configureProviderRuntime(
  baseline: Pick<InitializedProviderRuntime, 'toolSource' | 'providerToolNames' | 'inventory' | 'inventoryComparison'>,
  enabledTools: readonly string[],
  dmlAllowlist: DmlAllowlistPolicy,
): InitializedProviderRuntime {
  const officialEnabledTools = enabledTools.filter(
    (name) => !isSfoaDmlToolName(name) && !isSfoaContextToolName(name) && !isAgentInfrastructureToolName(name),
  );
  const dmlEnabledTools = enabledTools.filter(isSfoaDmlToolName);
  const officialContextDependencies = [
    ...(enabledTools.includes('run_diagnostic_tooling_query') ? ['run_soql_query'] : []),
    ...(enabledTools.includes('get_metadata_component_context') ? ['retrieve_metadata'] : []),
  ];
  assertEnabledRemoteContractsCompatible(
    baseline.inventoryComparison,
    [...new Set([...officialEnabledTools, ...officialContextDependencies])],
    baseline.inventory,
  );
  const policy = new ToolGovernancePolicy(officialEnabledTools, baseline.providerToolNames);
  const dmlPolicy = new DmlToolGovernancePolicy(dmlEnabledTools, dmlAllowlist);
  return Object.freeze({
    ...baseline,
    policy,
    dmlPolicy,
    dmlAllowlist,
    enabledTools: Object.freeze([...enabledTools]),
  });
}

export async function createGovernedMcpServer(
  options: CreateGovernedMcpServerOptions,
): Promise<{ server: McpServer; registeredTools: readonly string[] }> {
  const agentCapabilities = createRuntimeAgentCapabilities(
    options.initializedProvider.enabledTools,
    options.initializedProvider.dmlAllowlist,
    options.diagnosticReady,
    options.managedDmlFieldRules ?? [],
  );
  const server = new McpServer(
    { name: 'sfoa-mcp-server', version: '0.1.0-p6-agent' },
    { instructions: serverInstructions(agentCapabilities) },
  );
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
      options.mutationRequestState,
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

    const registered: string[] = [...registerAgentGuidance(server, {
      scope: options.scope,
      logger: options.logger,
      clientId: options.clientId,
      capabilities: agentCapabilities,
      enabledTools: options.initializedProvider.enabledTools,
      redactionSecrets: options.redactionSecrets,
      lightningBaseUrl: options.lightningBaseUrl,
      auditIdentity: options.auditIdentity,
      auditClientMetadata: options.auditClientMetadata,
      requestAuditContext: options.requestAuditContext,
    })];
    const adapter = new RequestScopedToolExecutionAdapter(
      options.scope.context,
      options.scope.route,
      options.scope.workspace,
      options.cwdGuard,
      new NoopRuntimeLogger(),
      options.redactionSecrets,
    );
    const contextToolNames = options.initializedProvider.enabledTools.filter(isSfoaContextToolName);
    if (contextToolNames.length > 0) {
      const officialQueryTool = toolsByName.get('run_soql_query');
      const officialRetrieveTool = toolsByName.get('retrieve_metadata');
      const needsDiagnosticQuery = contextToolNames.includes('run_diagnostic_tooling_query');
      const needsMetadataContext = contextToolNames.includes('get_metadata_component_context');
      if (needsDiagnosticQuery && !officialQueryTool) {
        throw new RemoteRuntimeError(
          'MCP_TOOL_NOT_AVAILABLE',
          'run_diagnostic_tooling_query requires the official run_soql_query primitive.',
        );
      }
      if (needsMetadataContext && !officialRetrieveTool) {
        throw new RemoteRuntimeError(
          'MCP_TOOL_NOT_AVAILABLE',
          'get_metadata_component_context requires the official retrieve_metadata primitive.',
        );
      }
      const contextProvider = new SfoaContextMcpProvider({
        toolNames: contextToolNames as readonly SfoaContextToolName[],
        ...(officialQueryTool
          ? {
              diagnosticQueryExecutor: new OfficialDiagnosticToolingQueryExecutor(
                options.scope,
                adapter,
                officialQueryTool,
              ),
            }
          : {}),
        ...(officialRetrieveTool
          ? {
              metadataContextExecutor: new OfficialMetadataComponentContextExecutor(
                options.scope,
                adapter,
                officialRetrieveTool,
              ),
            }
          : {}),
      });
      const contextTools = await contextProvider.provideTools(options.scope.services);
      for (const tool of contextTools) {
        if (tool.getReleaseState() !== ReleaseState.GA) continue;
        if (toolsByName.has(tool.getName())) {
          throw new RemoteRuntimeError(
            'MCP_PROVIDER_INITIALIZATION_FAILED',
            `The composed Providers returned duplicate Tool ${tool.getName()}.`,
          );
        }
        toolsByName.set(tool.getName(), tool);
      }
    }

    for (const name of options.initializedProvider.enabledTools) {
      if (isAgentInfrastructureToolName(name)) continue;
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
          connectionProvider: options.scope.salesforce,
          managedFieldResolver: new ManagedDmlFieldResolver(
            options.scope.salesforce,
            options.scope.context,
            options.managedDmlFieldRules ?? [],
          ),
          dmlAllowlist: options.initializedProvider.dmlAllowlist,
          redactionSecrets: options.redactionSecrets,
          mutationStarted: () => options.mutationRequestState.hasStarted(),
        });
        server.registerTool(facade.getName(), facade.getConfig(), (input, extra) =>
          runAuditedToolInvocation(options, facade.getName(), input, () => facade.execute(input, extra)));
        registered.push(name);
        continue;
      }
      if (isSfoaContextToolName(name)) {
        const facade = new ContextToolFacade({
          tool,
          context: options.scope.context,
          route: options.scope.route,
          toolTimeoutMs: options.toolTimeoutMs,
          logger: options.logger,
          clientId: options.clientId,
          connectionProvider: options.scope.salesforce,
          redactionSecrets: options.redactionSecrets,
          managedDmlFieldRules: options.managedDmlFieldRules ?? [],
        });
        server.registerTool(facade.getName(), facade.getConfig(), (input, extra) =>
          runAuditedToolInvocation(options, facade.getName(), input, () => facade.execute(input, extra)));
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
        connectionProvider: options.scope.salesforce,
        redactionSecrets: options.redactionSecrets,
      });
      server.registerTool(facade.getName(), facade.getConfig(), (input, extra) =>
        runAuditedToolInvocation(options, facade.getName(), input, () => facade.execute(input, extra)));
      registered.push(name);
    }

    return { server, registeredTools: Object.freeze(registered) };
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }
}

function runAuditedToolInvocation<T>(
  options: CreateGovernedMcpServerOptions,
  toolName: string,
  input: unknown,
  callback: () => T,
): T {
  const auditContext = options.requestAuditContext ?? RequestAuditContextController.create({
    correlationId: options.scope.context.correlationId,
    channel: 'MCP_HTTP',
    clientId: options.clientId,
    toolName,
    clientMetadata: options.auditClientMetadata,
  });
  auditContext
    .withResolvedIdentity({
      platformUserId: options.scope.context.platformUserId,
      identitySource: options.auditIdentity.identitySource,
      ...(options.auditIdentity.identityCredentialId
        ? { identityCredentialId: options.auditIdentity.identityCredentialId }
        : {}),
    })
    .withSalesforceRoute({
      salesforceUsername: options.scope.route.salesforceUsername,
      executionRole: options.scope.route.connectionRole,
    });
  if (isRecord(input)) {
    auditContext.withOperation({
      operation: toolName === 'create_record' ? 'CREATE' : toolName === 'update_record' ? 'UPDATE' : undefined,
      objectApiName: typeof input.objectApiName === 'string' ? input.objectApiName : undefined,
      recordId: typeof input.recordId === 'string' ? input.recordId : undefined,
    });
  }

  return runWithRequestAuditContext(auditContext, callback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

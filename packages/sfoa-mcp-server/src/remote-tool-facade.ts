import { createHash } from 'node:crypto';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpTool, McpToolConfig } from '@salesforce/mcp-provider-api';
import type {
  RequestContext,
  RequestScopedToolExecutionAdapter,
  RuntimeLogger,
  SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import type { z } from 'zod';
import { RemoteRuntimeError, remoteRuntimeErrorToolResult } from './errors.js';
import type { OfficialToolPolicyRecord } from './official-tool-catalog.js';
import { withTimeout } from './timeouts.js';
import { validateRemoteToolContract } from './upstream-drift.js';

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolInput = Record<string, unknown>;

export type RemoteToolFacadeOptions = Readonly<{
  tool: McpTool;
  policyRecord: OfficialToolPolicyRecord;
  adapter: RequestScopedToolExecutionAdapter;
  context: RequestContext;
  route: SalesforceIdentityRoute;
  workspaceRoot: string;
  toolTimeoutMs: number;
  logger: RuntimeLogger;
  clientId: string;
  redactionSecrets?: readonly string[];
}>;

const REMOTE_ANNOTATIONS: Readonly<Record<string, ToolAnnotations>> = Object.freeze({
  get_username: Object.freeze({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }),
  run_soql_query: Object.freeze({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }),
  retrieve_metadata: Object.freeze({
    readOnlyHint: true,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  }),
});

const REMOTE_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  get_username:
    'Returns the Salesforce username resolved from the authenticated platform user. The client does not provide a Salesforce username or local directory.',
  run_soql_query:
    'Runs a SOQL query through the unchanged official Salesforce Tool.exec() against the Salesforce identity resolved from the authenticated request. Provide only query and useToolingApi.',
  retrieve_metadata:
    'Retrieves Salesforce metadata through the unchanged official Tool.exec() into an isolated request workspace. This developer-oriented Tool requires a manifest or source context and is disabled by default for remote agents.',
});

export class RemoteToolFacade {
  public constructor(private readonly options: RemoteToolFacadeOptions) {
    if (!options.policyRecord.remoteContract || options.policyRecord.name !== options.tool.getName()) {
      throw new RemoteRuntimeError(
        'MCP_TOOL_NOT_AVAILABLE',
        `Tool ${options.tool.getName()} does not have a matching explicit remote contract.`,
      );
    }
  }

  public getName(): string {
    return this.options.tool.getName();
  }

  public getConfig(): McpToolConfig<z.ZodRawShape, z.ZodRawShape> {
    const official = validateRemoteToolContract(this.options.tool, this.options.policyRecord);
    const inputSchema: z.ZodRawShape = {};
    for (const name of this.options.policyRecord.remoteContract?.allowedAgentArguments ?? []) {
      const schema = official.inputSchema?.[name];
      if (!schema) {
        throw new RemoteRuntimeError(
          'MCP_UPSTREAM_TOOL_CONTRACT_DRIFT',
          `Official Tool ${this.getName()} is missing audited Agent field ${name}.`,
        );
      }
      inputSchema[name] = schema;
    }

    return {
      ...official,
      description: REMOTE_DESCRIPTIONS[this.getName()] ?? official.description,
      inputSchema,
      annotations: REMOTE_ANNOTATIONS[this.getName()] ?? official.annotations,
    };
  }

  public async execute(input: ToolInput, extra: ToolExtra): Promise<CallToolResult> {
    const started = performance.now();
    if (this.options.route.connectionRole !== 'USER') {
      const error = new RemoteRuntimeError(
        'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED',
        `Official business Tool ${this.getName()} is fixed to the USER request scope and cannot execute with DIAGNOSTIC authority.`,
        { correlationId: this.options.context.correlationId },
      );
      await this.log('BLOCKED', elapsed(started), error.code, input);
      return remoteRuntimeErrorToolResult(
        error,
        this.options.redactionSecrets,
        this.options.context.correlationId,
      );
    }
    const officialInput = { ...input, ...this.hostOwnedInput() };
    const operation = this.options.adapter.execute(this.options.tool, officialInput, extra);
    try {
      const result = await withTimeout(
        operation,
        this.options.toolTimeoutMs,
        'MCP_TOOL_TIMEOUT',
        `Tool ${this.getName()} exceeded the configured MCP_TOOL_TIMEOUT_MS. The runtime stopped waiting; Salesforce server-side cancellation is not guaranteed.`,
        this.options.context.correlationId,
      );
      await this.log(result.isError === true ? 'ERROR' : 'PASS', elapsed(started), undefined, input, result);
      return result;
    } catch (error) {
      if (error instanceof RemoteRuntimeError && error.code === 'MCP_TOOL_TIMEOUT') {
        await this.log('ERROR', elapsed(started), error.code, input);
        return remoteRuntimeErrorToolResult(
          error,
          this.options.redactionSecrets,
          this.options.context.correlationId,
        );
      }
      await this.log('ERROR', elapsed(started), 'MCP_TOOL_EXECUTION_FAILED', input);
      throw error;
    }
  }

  private hostOwnedInput(): ToolInput {
    const authoritative: ToolInput = {
      usernameOrAlias: this.options.route.salesforceUsername,
      directory: this.options.workspaceRoot,
    };
    const injected: ToolInput = {};
    for (const name of this.options.policyRecord.remoteContract?.hostOwnedArguments ?? []) {
      if (!(name in authoritative)) {
        throw new RemoteRuntimeError(
          'MCP_UPSTREAM_TOOL_CONTRACT_DRIFT',
          `Tool ${this.getName()} has unsupported host-owned field ${name}.`,
        );
      }
      injected[name] = authoritative[name];
    }
    return injected;
  }

  private async log(
    result: 'PASS' | 'ERROR' | 'BLOCKED',
    durationMs: number,
    errorCode?: string,
    input: ToolInput = {},
    response?: CallToolResult,
  ): Promise<void> {
    await Promise.resolve(this.options.logger.log({
      correlationId: this.options.context.correlationId,
      clientId: this.options.clientId,
      platformUserId: this.options.context.platformUserId,
      salesforceUsername: this.options.route.salesforceUsername,
      executionRole: this.options.route.connectionRole,
      toolName: this.getName(),
      durationMs,
      result,
      outcome: result === 'PASS' ? 'SUCCESS' : result === 'BLOCKED' ? 'DENIED' : 'FAILED',
      ...(errorCode ? { errorCode } : {}),
      requestSummary: safeOfficialRequestSummary(this.getName(), input),
      responseSummary: { isError: response?.isError === true },
      auditEvent: {
        eventCategory: 'TOOL',
        eventType: 'TOOL_TERMINAL',
        eventName: this.getName(),
        terminalSource: result === 'BLOCKED' ? 'GOVERNANCE' : 'TOOL',
      },
    })).catch(() => undefined);
  }
}

function safeOfficialRequestSummary(toolName: string, input: ToolInput): unknown {
  if (toolName === 'run_soql_query') {
    const query = typeof input.query === 'string' ? input.query : '';
    return {
      querySha256: createHash('sha256').update(query).digest('hex'),
      queryLength: query.length,
      useToolingApi: input.useToolingApi === true,
    };
  }
  if (toolName === 'retrieve_metadata') {
    return {
      hasManifest: typeof input.manifest === 'string' && input.manifest.length > 0,
      hasSourceDir: typeof input.sourceDir === 'string' && input.sourceDir.length > 0,
      ignoreConflicts: input.ignoreConflicts === true,
    };
  }
  return { toolName };
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

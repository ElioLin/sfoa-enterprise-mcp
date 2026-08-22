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
import { withTimeout } from './timeouts.js';

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolInput = Record<string, unknown>;

export type RemoteToolFacadeOptions = Readonly<{
  tool: McpTool;
  adapter: RequestScopedToolExecutionAdapter;
  context: RequestContext;
  route: SalesforceIdentityRoute;
  workspaceRoot: string;
  toolTimeoutMs: number;
  logger: RuntimeLogger;
  clientId: string;
  redactionSecrets?: readonly string[];
}>;

const HOST_OWNED_ARGUMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  get_username: Object.freeze(['directory']),
  run_soql_query: Object.freeze(['usernameOrAlias', 'directory']),
  retrieve_metadata: Object.freeze(['usernameOrAlias', 'directory']),
});

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
    if (!HOST_OWNED_ARGUMENTS[options.tool.getName()]) {
      throw new RemoteRuntimeError(
        'MCP_TOOL_NOT_AVAILABLE',
        `Tool ${options.tool.getName()} does not have an explicit remote host-argument policy.`,
      );
    }
  }

  public getName(): string {
    return this.options.tool.getName();
  }

  public getConfig(): McpToolConfig<z.ZodRawShape, z.ZodRawShape> {
    const official = this.options.tool.getConfig();
    const hidden = new Set(HOST_OWNED_ARGUMENTS[this.getName()]);
    const inputSchema = Object.fromEntries(
      Object.entries(official.inputSchema ?? {}).filter(([name]) => !hidden.has(name)),
    ) as z.ZodRawShape;

    return {
      ...official,
      description: REMOTE_DESCRIPTIONS[this.getName()] ?? official.description,
      inputSchema,
      annotations: REMOTE_ANNOTATIONS[this.getName()] ?? official.annotations,
    };
  }

  public async execute(input: ToolInput, extra: ToolExtra): Promise<CallToolResult> {
    const started = performance.now();
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
      this.log(result.isError === true ? 'ERROR' : 'PASS', elapsed(started));
      return result;
    } catch (error) {
      if (error instanceof RemoteRuntimeError && error.code === 'MCP_TOOL_TIMEOUT') {
        this.log('ERROR', elapsed(started), error.code);
        return remoteRuntimeErrorToolResult(
          error,
          this.options.redactionSecrets,
          this.options.context.correlationId,
        );
      }
      throw error;
    }
  }

  private hostOwnedInput(): ToolInput {
    switch (this.getName()) {
      case 'get_username':
        return { directory: this.options.workspaceRoot };
      case 'run_soql_query':
      case 'retrieve_metadata':
        return {
          usernameOrAlias: this.options.route.salesforceUsername,
          directory: this.options.workspaceRoot,
        };
      default:
        throw new RemoteRuntimeError(
          'MCP_TOOL_NOT_AVAILABLE',
          `Tool ${this.getName()} does not have an explicit remote input adapter.`,
        );
    }
  }

  private log(result: 'PASS' | 'ERROR', durationMs: number, errorCode?: string): void {
    this.options.logger.log({
      correlationId: this.options.context.correlationId,
      clientId: this.options.clientId,
      platformUserId: this.options.context.platformUserId,
      salesforceUsername: this.options.route.salesforceUsername,
      toolName: this.getName(),
      durationMs,
      result,
      ...(errorCode ? { errorCode } : {}),
    });
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

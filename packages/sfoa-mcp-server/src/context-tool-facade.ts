import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpTool, McpToolConfig } from '@salesforce/mcp-provider-api';
import {
  ContextRuntimeError,
  SFOA_CONTEXT_TOOL_ROLES,
  contextExecutionErrorToolResult,
  isSfoaContextToolName,
} from '@sfoa/mcp-provider-sfoa-context';
import type {
  RequestContext,
  RuntimeLogger,
  SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import type { z } from 'zod';
import { RemoteRuntimeError, remoteRuntimeErrorToolResult } from './errors.js';
import { withTimeout } from './timeouts.js';

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolInput = Record<string, unknown>;

export type ContextToolFacadeOptions = Readonly<{
  tool: McpTool;
  context: RequestContext;
  route: SalesforceIdentityRoute;
  toolTimeoutMs: number;
  logger: RuntimeLogger;
  clientId: string;
  redactionSecrets?: readonly string[];
}>;

export class ContextToolFacade {
  public constructor(private readonly options: ContextToolFacadeOptions) {
    if (!isSfoaContextToolName(options.tool.getName())) {
      throw new RemoteRuntimeError(
        'MCP_TOOL_NOT_AVAILABLE',
        `Context facade cannot execute non-P4 Tool ${options.tool.getName()}.`,
      );
    }
  }

  public getName(): string {
    return this.options.tool.getName();
  }

  public getConfig(): McpToolConfig<z.ZodRawShape, z.ZodRawShape> {
    return this.options.tool.getConfig();
  }

  public async execute(input: ToolInput, extra: ToolExtra): Promise<CallToolResult> {
    const started = performance.now();
    const name = this.options.tool.getName();
    if (!isSfoaContextToolName(name)) {
      return remoteRuntimeErrorToolResult(
        new RemoteRuntimeError('MCP_TOOL_NOT_AVAILABLE', `Tool ${name} is not a P4 Context Tool.`),
        this.options.redactionSecrets,
        this.options.context.correlationId,
      );
    }
    const expectedRole = SFOA_CONTEXT_TOOL_ROLES[name];
    if (this.options.route.connectionRole !== expectedRole) {
      const result = contextExecutionErrorToolResult(
        new ContextRuntimeError(
          'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED',
          `Tool ${name} is fixed to the ${expectedRole} execution role; the request cannot switch roles through input or batching.`,
        ),
        'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED',
      );
      this.log('BLOCKED', elapsed(started), 'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED');
      return result;
    }

    try {
      const result = await withTimeout(
        Promise.resolve(this.options.tool.exec(input, extra)),
        this.options.toolTimeoutMs,
        'MCP_TOOL_TIMEOUT',
        `Tool ${name} exceeded MCP_TOOL_TIMEOUT_MS. The runtime stopped waiting; Salesforce server-side cancellation is not guaranteed.`,
        this.options.context.correlationId,
      );
      const errorCode = resultErrorCode(result);
      this.log(result.isError === true ? 'ERROR' : 'PASS', elapsed(started), errorCode);
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

  private log(result: 'PASS' | 'ERROR' | 'BLOCKED', durationMs: number, errorCode?: string): void {
    this.options.logger.log({
      correlationId: this.options.context.correlationId,
      clientId: this.options.clientId,
      platformUserId: this.options.context.platformUserId,
      salesforceUsername: this.options.route.salesforceUsername,
      executionRole: this.options.route.connectionRole,
      toolName: this.getName(),
      durationMs,
      result,
      ...(errorCode ? { errorCode } : {}),
    });
  }
}

function resultErrorCode(result: CallToolResult): string | undefined {
  const content = result.structuredContent;
  return content && typeof content.errorCode === 'string' ? content.errorCode : undefined;
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

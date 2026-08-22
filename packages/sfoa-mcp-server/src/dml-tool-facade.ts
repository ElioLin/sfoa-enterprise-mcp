import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpTool, McpToolConfig } from '@salesforce/mcp-provider-api';
import {
  SFOA_DML_TOOL_OPERATIONS,
  dmlErrorToolResult,
  dmlExecutionErrorToolResult,
  dmlOutcomeUnknownError,
  isSfoaDmlToolName,
  type DmlOperation,
} from '@sfoa/mcp-provider-sfoa-dml';
import type {
  RequestContext,
  RuntimeLogger,
  SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import type { z } from 'zod';
import { RemoteRuntimeError } from './errors.js';
import { withTimeout } from './timeouts.js';

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolInput = Record<string, unknown>;

export type DmlToolFacadeOptions = Readonly<{
  tool: McpTool;
  context: RequestContext;
  route: SalesforceIdentityRoute;
  toolTimeoutMs: number;
  logger: RuntimeLogger;
  clientId: string;
}>;

export class DmlToolFacade {
  private readonly operation: DmlOperation;

  public constructor(private readonly options: DmlToolFacadeOptions) {
    const toolName = options.tool.getName();
    if (!isSfoaDmlToolName(toolName)) {
      throw new RemoteRuntimeError(
        'MCP_TOOL_NOT_AVAILABLE',
        `DML facade cannot execute non-P3 Tool ${toolName}.`,
      );
    }
    this.operation = SFOA_DML_TOOL_OPERATIONS[toolName];
  }

  public getName(): string {
    return this.options.tool.getName();
  }

  public getConfig(): McpToolConfig<z.ZodRawShape, z.ZodRawShape> {
    return this.options.tool.getConfig();
  }

  public async execute(input: ToolInput, extra: ToolExtra): Promise<CallToolResult> {
    const started = performance.now();
    try {
      const result = await withTimeout(
        Promise.resolve(this.options.tool.exec(input, extra)),
        this.options.toolTimeoutMs,
        'MCP_TOOL_TIMEOUT',
        `Tool ${this.getName()} exceeded MCP_TOOL_TIMEOUT_MS. The runtime stopped waiting; Salesforce server-side cancellation is not guaranteed.`,
        this.options.context.correlationId,
      );
      this.log(result.isError === true ? 'ERROR' : 'PASS', elapsed(started), resultErrorCode(result));
      return result;
    } catch (error) {
      if (error instanceof RemoteRuntimeError && error.code === 'MCP_TOOL_TIMEOUT') {
        const result = dmlErrorToolResult(dmlOutcomeUnknownError(this.operation, error));
        this.log('ERROR', elapsed(started), resultErrorCode(result));
        return result;
      }
      const result = dmlExecutionErrorToolResult(error, this.operation);
      this.log('ERROR', elapsed(started), resultErrorCode(result));
      return result;
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

function resultErrorCode(result: CallToolResult): string | undefined {
  const content = result.structuredContent;
  return content && typeof content.errorCode === 'string' ? content.errorCode : undefined;
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

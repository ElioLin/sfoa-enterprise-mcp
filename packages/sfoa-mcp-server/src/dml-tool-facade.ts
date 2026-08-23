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
import { remoteRuntimeErrorToolResult } from './errors.js';
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
  mutationStarted(): boolean;
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
    if (this.options.route.connectionRole !== 'USER') {
      const error = new RemoteRuntimeError(
        'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED',
        `Mutation Tool ${this.getName()} is fixed to the USER request scope and cannot execute with DIAGNOSTIC authority.`,
        { correlationId: this.options.context.correlationId },
      );
      await Promise.resolve(this.options.logger.log({
        correlationId: this.options.context.correlationId,
        clientId: this.options.clientId,
        platformUserId: this.options.context.platformUserId,
        salesforceUsername: this.options.route.salesforceUsername,
        executionRole: this.options.route.connectionRole,
        toolName: this.getName(),
        operation: this.operation,
        durationMs: elapsed(started),
        result: 'BLOCKED',
        outcome: 'DENIED',
        errorCode: error.code,
        requestSummary: safeDmlRequestSummary(input, this.operation),
      })).catch(() => undefined);
      return remoteRuntimeErrorToolResult(error, [], this.options.context.correlationId);
    }
    try {
      const result = await withTimeout(
        Promise.resolve(this.options.tool.exec(input, extra)),
        this.options.toolTimeoutMs,
        'MCP_TOOL_TIMEOUT',
        `Tool ${this.getName()} exceeded MCP_TOOL_TIMEOUT_MS. The runtime stopped waiting; Salesforce server-side cancellation is not guaranteed.`,
        this.options.context.correlationId,
      );
      const errorCode = resultErrorCode(result);
      await this.log(
        result.isError === true ? 'ERROR' : 'PASS',
        elapsed(started),
        errorCode,
        errorCode === 'MCP_DML_OUTCOME_UNKNOWN' ? 'TRANSPORT' : undefined,
        input,
        result,
      );
      return result;
    } catch (error) {
      if (error instanceof RemoteRuntimeError && error.code === 'MCP_TOOL_TIMEOUT') {
        const result = dmlErrorToolResult(dmlOutcomeUnknownError(this.operation, error));
        await this.log('ERROR', elapsed(started), resultErrorCode(result), 'TOOL', input, result);
        return result;
      }
      const result = dmlExecutionErrorToolResult(error, this.operation);
      await this.log('ERROR', elapsed(started), resultErrorCode(result), 'TRANSPORT', input, result);
      return result;
    }
  }

  private async log(
    result: 'PASS' | 'ERROR',
    durationMs: number,
    errorCode?: string,
    terminationLayer?: 'TOOL' | 'TRANSPORT',
    input: ToolInput = {},
    response?: CallToolResult,
  ): Promise<void> {
    const outcomeUnknown = errorCode === 'MCP_DML_OUTCOME_UNKNOWN';
    const requestSummary = safeDmlRequestSummary(input, this.operation);
    const responseRecordId = resultRecordId(response);
    await Promise.resolve(this.options.logger.log({
      correlationId: this.options.context.correlationId,
      clientId: this.options.clientId,
      platformUserId: this.options.context.platformUserId,
      salesforceUsername: this.options.route.salesforceUsername,
      executionRole: this.options.route.connectionRole,
      toolName: this.getName(),
      operation: this.operation,
      objectApiName: requestSummary.objectApiName,
      recordId: this.operation === 'UPDATE' ? requestSummary.recordId : responseRecordId,
      ...(outcomeUnknown
        ? {
            outcome: 'UNKNOWN' as const,
            mutationStarted: this.options.mutationStarted(),
            ...(terminationLayer ? { terminationLayer } : {}),
          }
        : {}),
      durationMs,
      result,
      outcome: outcomeUnknown ? 'UNKNOWN' : result === 'PASS' ? 'SUCCESS' : 'FAILED',
      ...(errorCode ? { errorCode } : {}),
      requestSummary,
      responseSummary: {
        success: result === 'PASS',
        ...(responseRecordId ? { recordId: responseRecordId } : {}),
        ...(errorCode ? { errorCode } : {}),
      },
    })).catch(() => undefined);
  }
}

type SafeDmlRequestSummary = Readonly<{
  operation: DmlOperation;
  objectApiName?: string;
  recordId?: string;
  fieldNames: readonly string[];
  fieldCount: number;
}>;

function safeDmlRequestSummary(input: ToolInput, operation: DmlOperation): SafeDmlRequestSummary {
  const fields = isRecord(input.fields) ? Object.keys(input.fields).sort() : [];
  return Object.freeze({
    operation,
    ...(typeof input.objectApiName === 'string' ? { objectApiName: input.objectApiName } : {}),
    ...(operation === 'UPDATE' && typeof input.recordId === 'string' ? { recordId: input.recordId } : {}),
    fieldNames: Object.freeze(fields),
    fieldCount: fields.length,
  });
}

function resultRecordId(result: CallToolResult | undefined): string | undefined {
  const content = result?.structuredContent;
  return content && typeof content.recordId === 'string' ? content.recordId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resultErrorCode(result: CallToolResult): string | undefined {
  const content = result.structuredContent;
  return content && typeof content.errorCode === 'string' ? content.errorCode : undefined;
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpTool, McpToolConfig } from '@salesforce/mcp-provider-api';
import {
  DataRuntimeError,
  SFOA_DATA_TOOL_ROLES,
  dataFailureToolResult,
  isSfoaDataToolName,
  type SfoaDataToolName,
} from '@sfoa/mcp-provider-sfoa-data';
import type {
  RequestContext,
  RuntimeLogger,
  SalesforceConnectionProvider,
  SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import {
  IdentityRuntimeError,
  runWithSalesforceApiPurpose,
  runtimeErrorToolResult,
  type SalesforceApiPurpose,
} from '@sfoa/identity-runtime';
import { z } from 'zod';
import { RemoteRuntimeError, remoteRuntimeErrorToolResult } from './errors.js';
import { withTimeout } from './timeouts.js';

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolInput = Record<string, unknown>;

/**
 * Which Salesforce surface each Data Tool is audited under. Declared as a total map rather
 * than a switch so that adding a Tool to the Provider's role map without deciding its audit
 * purpose is a compile error here, in the layer that owns the audit contract.
 */
const DATA_TOOL_PURPOSES: Readonly<Record<SfoaDataToolName, SalesforceApiPurpose>> = Object.freeze({
  list_sobjects: 'OBJECT_SCHEMA',
  describe_sobject: 'OBJECT_SCHEMA',
});

/** Object API names and name prefixes are schema identifiers, not business data. */
const MAX_SUMMARY_TOKEN_LENGTH = 64;

export type DataToolFacadeOptions = Readonly<{
  tool: McpTool;
  context: RequestContext;
  route: SalesforceIdentityRoute;
  toolTimeoutMs: number;
  logger: RuntimeLogger;
  clientId: string;
  connectionProvider?: SalesforceConnectionProvider;
  redactionSecrets?: readonly string[];
}>;

/**
 * Host-side governance wrapper for the P9 SFOA Data Tools.
 *
 * The Provider already refuses to build a Connection it was not given, but the execution
 * role is a host decision: every Data Tool is fixed to the request's USER identity, and a
 * request arriving on a non-USER route is refused here before the Tool body runs, so an
 * Agent can never reach Salesforce schema through a batching or role-switching trick.
 */
export class DataToolFacade {
  public constructor(private readonly options: DataToolFacadeOptions) {
    if (!isSfoaDataToolName(options.tool.getName())) {
      throw new RemoteRuntimeError(
        'MCP_TOOL_NOT_AVAILABLE',
        `Data facade cannot execute non-P9 Tool ${options.tool.getName()}.`,
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
    if (!isSfoaDataToolName(name)) {
      return remoteRuntimeErrorToolResult(
        new RemoteRuntimeError('MCP_TOOL_NOT_AVAILABLE', `Tool ${name} is not a P9 Data Tool.`),
        this.options.redactionSecrets,
        this.options.context.correlationId,
      );
    }
    const expectedRole = SFOA_DATA_TOOL_ROLES[name];
    if (this.options.route.connectionRole !== expectedRole) {
      const result = dataFailureToolResult(
        new DataRuntimeError(
          'MCP_DATA_TOOL_NOT_ALLOWED',
          `Tool ${name} is fixed to the ${expectedRole} execution role; the request cannot switch roles through input or batching.`,
        ),
        'MCP_DATA_TOOL_NOT_ALLOWED',
      );
      await this.log('BLOCKED', elapsed(started), 'MCP_DATA_TOOL_NOT_ALLOWED', input);
      return result;
    }

    try {
      // Every P9 Data Tool reads with the request-scoped USER Connection, initialized
      // lazily after role enforcement and outside the pre-existing Tool deadline.
      await this.options.connectionProvider?.getConnection();
      const result = await withTimeout(
        runWithSalesforceApiPurpose(DATA_TOOL_PURPOSES[name], () =>
          Promise.resolve(this.options.tool.exec(input, extra))),
        this.options.toolTimeoutMs,
        'MCP_TOOL_TIMEOUT',
        `Tool ${name} exceeded MCP_TOOL_TIMEOUT_MS. The runtime stopped waiting; Salesforce server-side cancellation is not guaranteed.`,
        this.options.context.correlationId,
      );
      await this.log(
        result.isError === true ? 'ERROR' : 'PASS',
        elapsed(started),
        resultErrorCode(result),
        input,
        result,
      );
      return result;
    } catch (error) {
      if (error instanceof IdentityRuntimeError) {
        await this.log('ERROR', elapsed(started), error.code, input);
        return runtimeErrorToolResult(error, this.options.redactionSecrets, this.options.context.correlationId);
      }
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
      requestSummary: safeDataRequestSummary(input),
      responseSummary: safeDataResponseSummary(response, errorCode),
      auditEvent: {
        eventCategory: 'TOOL',
        eventType: 'TOOL_TERMINAL',
        eventName: this.getName(),
        terminalSource: result === 'BLOCKED' ? 'GOVERNANCE' : 'TOOL',
      },
    })).catch(() => undefined);
  }
}

function safeDataRequestSummary(input: ToolInput): unknown {
  return {
    objectApiName: boundedToken(input.objectApiName),
    filter: boundedToken(input.filter),
  };
}

function safeDataResponseSummary(response: CallToolResult | undefined, errorCode?: string): unknown {
  const content = response?.structuredContent;
  if (!content) return { isError: response?.isError === true, ...(errorCode ? { errorCode } : {}) };
  return {
    isError: response?.isError === true,
    ...(typeof content.totalCount === 'number' ? { totalCount: content.totalCount } : {}),
    ...(typeof content.returnedCount === 'number' ? { returnedCount: content.returnedCount } : {}),
    ...(typeof content.totalFields === 'number' ? { totalFields: content.totalFields } : {}),
    ...(typeof content.returnedFields === 'number' ? { returnedFields: content.returnedFields } : {}),
    ...(typeof content.truncated === 'boolean' ? { truncated: content.truncated } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

/**
 * The audit record names the object and prefix the Agent asked about — a governance fact —
 * bounded so that input which never reached the Tool's own schema cannot write an
 * arbitrarily long string into the trail.
 */
function boundedToken(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, MAX_SUMMARY_TOKEN_LENGTH) : null;
}

function resultErrorCode(result: CallToolResult): string | undefined {
  const content = result.structuredContent;
  return content && typeof content.errorCode === 'string' ? content.errorCode : undefined;
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

import { createHash } from 'node:crypto';
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
import { z } from 'zod';
import type { RuntimeManagedDmlFieldRule } from './dml-managed-fields.js';
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
  managedDmlFieldRules?: readonly RuntimeManagedDmlFieldRule[];
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
    const config = this.options.tool.getConfig();
    if (this.getName() !== 'get_record_action_context') return config;
    return {
      ...config,
      description: `${config.description} The host also returns current-operation MCP-managed field facts; agents must not ask for, recommend, or submit those fields.`,
      outputSchema: {
        ...config.outputSchema,
        managedDmlFields: z.array(z.object({
          objectApiName: z.string(),
          fieldApiName: z.string(),
          operations: z.array(z.enum(['CREATE', 'UPDATE'])),
          managedBy: z.literal('MCP'),
          strategy: z.enum(['PLATFORM_IDENTITY', 'AI_CREATED_MARKER']),
        }).strict()).optional(),
      },
    };
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
      await this.log('BLOCKED', elapsed(started), 'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED', input);
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
      const enriched = enrichManagedDmlFields(result, name, input, this.options.managedDmlFieldRules ?? []);
      const errorCode = resultErrorCode(enriched);
      await this.log(enriched.isError === true ? 'ERROR' : 'PASS', elapsed(started), errorCode, input, enriched);
      return enriched;
    } catch (error) {
      if (error instanceof RemoteRuntimeError && error.code === 'MCP_TOOL_TIMEOUT') {
        await this.log('ERROR', elapsed(started), error.code, input);
        return remoteRuntimeErrorToolResult(
          error,
          this.options.redactionSecrets,
          this.options.context.correlationId,
        );
      }
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
      requestSummary: safeContextRequestSummary(this.getName(), input),
      responseSummary: safeContextResponseSummary(response, errorCode),
    })).catch(() => undefined);
  }
}

function safeContextRequestSummary(toolName: string, input: ToolInput): unknown {
  if (toolName === 'run_diagnostic_tooling_query') {
    const query = typeof input.query === 'string' ? input.query : '';
    return {
      querySha256: createHash('sha256').update(query).digest('hex'),
      queryLength: query.length,
    };
  }
  if (toolName === 'get_metadata_component_context') {
    return {
      metadataType: typeof input.metadataType === 'string' ? input.metadataType : null,
      fullName: typeof input.fullName === 'string' ? input.fullName : null,
    };
  }
  return {
    objectApiName: typeof input.objectApiName === 'string' ? input.objectApiName : null,
    action: input.action === 'CREATE' || input.action === 'UPDATE' ? input.action : null,
    recordId: typeof input.recordId === 'string' ? input.recordId : null,
    recordTypeId: typeof input.recordTypeId === 'string' ? input.recordTypeId : null,
  };
}

function safeContextResponseSummary(response: CallToolResult | undefined, errorCode?: string): unknown {
  const content = response?.structuredContent;
  if (!content) return { isError: response?.isError === true, ...(errorCode ? { errorCode } : {}) };
  const fields = Array.isArray(content.fields) ? content.fields.length : undefined;
  return {
    isError: response?.isError === true,
    ...(typeof content.returnedRecords === 'number' ? { returnedRecords: content.returnedRecords } : {}),
    ...(typeof content.returnedFiles === 'number' ? { returnedFiles: content.returnedFiles } : {}),
    ...(fields !== undefined ? { fieldCount: fields } : {}),
    ...(Array.isArray(content.managedDmlFields) ? { managedDmlFieldCount: content.managedDmlFields.length } : {}),
    ...(typeof content.truncated === 'boolean' ? { truncated: content.truncated } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

function enrichManagedDmlFields(
  result: CallToolResult,
  toolName: string,
  input: ToolInput,
  rules: readonly RuntimeManagedDmlFieldRule[],
): CallToolResult {
  if (toolName !== 'get_record_action_context' || result.isError === true || !result.structuredContent
    || typeof input.objectApiName !== 'string' || (input.action !== 'CREATE' && input.action !== 'UPDATE')) {
    return result;
  }
  const action = input.action;
  const managedDmlFields = rules.filter((rule) => rule.enabled
    && rule.objectApiName === input.objectApiName
    && (action === 'CREATE' ? rule.applyOnCreate : rule.applyOnUpdate))
    .map((rule) => Object.freeze({
      objectApiName: rule.objectApiName,
      fieldApiName: rule.targetFieldApiName,
      operations: Object.freeze([action]),
      managedBy: 'MCP' as const,
      strategy: rule.strategy === 'PLATFORM_USER_LOOKUP' ? 'PLATFORM_IDENTITY' as const : 'AI_CREATED_MARKER' as const,
    }));
  return {
    ...result,
    structuredContent: {
      ...result.structuredContent,
      managedDmlFields: Object.freeze(managedDmlFields),
    },
  };
}

function resultErrorCode(result: CallToolResult): string | undefined {
  const content = result.structuredContent;
  return content && typeof content.errorCode === 'string' ? content.errorCode : undefined;
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

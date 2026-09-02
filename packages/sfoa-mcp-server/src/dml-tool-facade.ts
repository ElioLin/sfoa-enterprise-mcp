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
  type DmlAllowlistPolicy,
  type DmlOperation,
} from '@sfoa/mcp-provider-sfoa-dml';
import type {
  RequestContext,
  RuntimeLogger,
  SalesforceConnectionProvider,
  SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import {
  IdentityRuntimeError,
  formatRuntimeError,
  redactSensitiveText,
  runWithSalesforceApiPurpose,
  runWithSalesforceDmlSemantic,
} from '@sfoa/identity-runtime';
import type { z } from 'zod';
import type { AppliedManagedDmlField, ManagedDmlFieldResolver } from './dml-managed-fields.js';
import { formatRemoteRuntimeError, RemoteRuntimeError } from './errors.js';
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
  connectionProvider?: SalesforceConnectionProvider;
  managedFieldResolver?: ManagedDmlFieldResolver;
  dmlAllowlist?: DmlAllowlistPolicy;
  redactionSecrets?: readonly string[];
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
        auditEvent: {
          eventCategory: 'GOVERNANCE',
          eventType: 'TOOL_TERMINAL',
          eventName: this.getName(),
          terminalSource: 'GOVERNANCE',
        },
      })).catch(() => undefined);
      return remoteRuntimeErrorToolResult(error, [], this.options.context.correlationId);
    }
    let executionInput = input;
    let appliedManagedFields: readonly AppliedManagedDmlField[] = Object.freeze([]);
    let deadlineReachedBeforeDispatch = false;
    try {
      if (typeof input.objectApiName === 'string') {
        this.options.dmlAllowlist?.assertAllowed(input.objectApiName, this.operation);
      }
      // Connection initialization was outside the Tool deadline before P7-09. Keep that
      // timeout contract while still deferring initialization until an allowed DML call.
      await this.options.connectionProvider?.getConnection();
      const result = await withTimeout(
        (async () => {
          if (this.options.managedFieldResolver) {
            const resolution = await this.options.managedFieldResolver.resolve(this.operation, input);
            executionInput = resolution.input as ToolInput;
            appliedManagedFields = resolution.applied;
          }
          // Promise.race cannot cancel a Salesforce lookup. Never allow a lookup that
          // settles after the host deadline to continue into a late mutation dispatch.
          if (deadlineReachedBeforeDispatch) {
            throw new RemoteRuntimeError(
              'MCP_TOOL_TIMEOUT',
              `Tool ${this.getName()} exceeded MCP_TOOL_TIMEOUT_MS before mutation dispatch.`,
              { correlationId: this.options.context.correlationId },
            );
          }
          const objectApiName = typeof executionInput.objectApiName === 'string'
            ? executionInput.objectApiName
            : undefined;
          const requestedFields = isRecord(input.fields) ? input.fields : {};
          const managedFields = resolvedManagedFieldValues(executionInput, appliedManagedFields);
          return runWithSalesforceApiPurpose(
            this.operation === 'CREATE' ? 'DML_CREATE' : 'DML_UPDATE',
            () => objectApiName
              ? runWithSalesforceDmlSemantic({
                  operation: this.operation,
                  objectApiName,
                  ...(this.operation === 'UPDATE' && typeof executionInput.recordId === 'string'
                    ? { recordId: executionInput.recordId }
                    : {}),
                  requestedFields,
                  managedFields,
                }, () => this.options.tool.exec(executionInput, extra))
              : this.options.tool.exec(executionInput, extra),
          );
        })(),
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
        executionInput,
        result,
        appliedManagedFields,
      );
      return result;
    } catch (error) {
      if (error instanceof IdentityRuntimeError && !this.options.mutationStarted()) {
        const result = dmlIdentityErrorToolResult(
          error,
          this.options.redactionSecrets,
          this.options.context.correlationId,
        );
        await this.log('ERROR', elapsed(started), error.code, 'TOOL', executionInput, result, appliedManagedFields);
        return result;
      }
      if (error instanceof RemoteRuntimeError && error.code === 'MCP_TOOL_TIMEOUT') {
        const mutationStarted = this.options.mutationStarted();
        deadlineReachedBeforeDispatch = !mutationStarted;
        const result = mutationStarted
          ? dmlErrorToolResult(dmlOutcomeUnknownError(this.operation, error))
          : hostDmlErrorToolResult(error, this.options.redactionSecrets, this.options.context.correlationId);
        await this.log('ERROR', elapsed(started), resultErrorCode(result), 'TOOL', executionInput, result, appliedManagedFields);
        return result;
      }
      if (error instanceof RemoteRuntimeError && isManagedDmlError(error.code) && !this.options.mutationStarted()) {
        const result = hostDmlErrorToolResult(error, this.options.redactionSecrets, this.options.context.correlationId);
        await this.log('ERROR', elapsed(started), error.code, 'TOOL', executionInput, result, appliedManagedFields);
        return result;
      }
      const result = dmlExecutionErrorToolResult(error, this.operation);
      await this.log('ERROR', elapsed(started), resultErrorCode(result), 'TRANSPORT', executionInput, result, appliedManagedFields);
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
    appliedManagedFields: readonly AppliedManagedDmlField[] = Object.freeze([]),
  ): Promise<void> {
    const outcomeUnknown = errorCode === 'MCP_DML_OUTCOME_UNKNOWN';
    const requestSummary = safeDmlRequestSummary(input, this.operation, appliedManagedFields);
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
      auditEvent: {
        eventCategory: 'TOOL',
        eventType: outcomeUnknown ? 'DML_OUTCOME_UNKNOWN' : 'TOOL_TERMINAL',
        eventName: this.getName(),
        terminalSource: terminationLayer === 'TRANSPORT' ? 'TRANSPORT' : 'TOOL',
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
  managedFieldsApplied: readonly AppliedManagedDmlField[];
}>;

function safeDmlRequestSummary(
  input: ToolInput,
  operation: DmlOperation,
  appliedManagedFields: readonly AppliedManagedDmlField[] = Object.freeze([]),
): SafeDmlRequestSummary {
  const fields = isRecord(input.fields) ? Object.keys(input.fields).sort() : [];
  return Object.freeze({
    operation,
    ...(typeof input.objectApiName === 'string' ? { objectApiName: input.objectApiName } : {}),
    ...(operation === 'UPDATE' && typeof input.recordId === 'string' ? { recordId: input.recordId } : {}),
    fieldNames: Object.freeze(fields),
    fieldCount: fields.length,
    managedFieldsApplied: Object.freeze(appliedManagedFields.map((field) => Object.freeze({ ...field }))),
  });
}

function hostDmlErrorToolResult(
  error: RemoteRuntimeError,
  secrets: readonly string[] = [],
  correlationId = error.correlationId,
): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: formatRemoteRuntimeError(error, secrets, correlationId) }],
    structuredContent: {
      success: false,
      errorCode: error.code,
      message: error.message.slice(0, 2_000),
    },
  };
}

function dmlIdentityErrorToolResult(
  error: IdentityRuntimeError,
  secrets: readonly string[] = [],
  correlationId = error.correlationId,
): CallToolResult {
  // Lazy Salesforce authentication/Connection failures surface before mutation dispatch but
  // must remain parseable through the same DML output contract as other DML errors
  // (structuredContent.success/errorCode/message). Correlation ID stays in the text content.
  return {
    isError: true,
    content: [{ type: 'text', text: formatRuntimeError(error, secrets, correlationId) }],
    structuredContent: {
      success: false,
      errorCode: error.code,
      message: redactSensitiveText(error.message, secrets).slice(0, 2_000),
    },
  };
}

function isManagedDmlError(code: string): boolean {
  return code === 'MCP_DML_MANAGED_LOOKUP_NOT_FOUND'
    || code === 'MCP_DML_MANAGED_LOOKUP_AMBIGUOUS'
    || code === 'MCP_DML_MANAGED_LOOKUP_FAILED'
    || code === 'MCP_DML_MANAGED_FIELD_CONFIG_INVALID';
}

function resultRecordId(result: CallToolResult | undefined): string | undefined {
  const content = result?.structuredContent;
  return content && typeof content.recordId === 'string' ? content.recordId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolvedManagedFieldValues(
  input: ToolInput,
  applied: readonly AppliedManagedDmlField[],
): Readonly<Record<string, unknown>> {
  const fields = isRecord(input.fields) ? input.fields : {};
  const output: Record<string, unknown> = {};
  for (const field of applied) output[field.fieldApiName] = fields[field.fieldApiName];
  return Object.freeze(output);
}

function resultErrorCode(result: CallToolResult): string | undefined {
  const content = result.structuredContent;
  return content && typeof content.errorCode === 'string' ? content.errorCode : undefined;
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpTool, McpToolConfig } from '@salesforce/mcp-provider-api';
import type {
  RequestContext,
  RuntimeLogger,
  SalesforceConnectionProvider,
  SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import type { z } from 'zod';
import { isSfoaAttachmentToolName, type AttachmentPolicy } from './attachment-policy.js';
import type { AttachmentIngress } from './attachment-ingress.js';
import {
  aggregateAttachmentOutcome,
  SalesforceAttachmentUploader,
  type AttachmentFileResult,
  type AttachmentUploadOutcome,
  type AttachmentUploadRequest,
} from './attachment-upload.js';
import {
  uploadFilesErrorToolResult,
  uploadFilesInputSchema,
  uploadFilesToolResult,
} from './attachment-tool.js';
import { RemoteRuntimeError, remoteRuntimeErrorToolResult } from './errors.js';
import { withTimeout } from './timeouts.js';

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export type AttachmentToolFacadeOptions = Readonly<{
  tool: McpTool;
  context: RequestContext;
  route: SalesforceIdentityRoute;
  toolTimeoutMs: number;
  logger: RuntimeLogger;
  clientId: string;
  connectionProvider: SalesforceConnectionProvider;
  ingress: AttachmentIngress;
  attachmentPolicy: AttachmentPolicy;
  /** The authenticated platform user. Attachment references are scoped to it. */
  platformUserId: string;
  redactionSecrets?: readonly string[];
}>;

/**
 * Host-native facade for `upload_files_to_record`.
 *
 * Like `DmlToolFacade` and `ContextToolFacade` it is not a Provider Tool: publishing a
 * file composes the request-scoped Salesforce identity, the Attachment Ingress and the
 * P7 Audit collector, none of which a Provider can reach. It is registered through the
 * same governance and audit path as the DML Tools, so it is discovered, enabled,
 * disabled and audited identically — and it never becomes a Generic DML object.
 */
export class AttachmentToolFacade {
  public constructor(private readonly options: AttachmentToolFacadeOptions) {
    const toolName = options.tool.getName();
    if (!isSfoaAttachmentToolName(toolName)) {
      throw new RemoteRuntimeError(
        'MCP_TOOL_NOT_AVAILABLE',
        `Attachment facade cannot execute non-attachment Tool ${toolName}.`,
      );
    }
  }

  public getName(): string {
    return this.options.tool.getName();
  }

  public getConfig(): McpToolConfig<z.ZodRawShape, z.ZodRawShape> {
    return this.options.tool.getConfig();
  }

  public async execute(input: Record<string, unknown>, _extra: ToolExtra): Promise<CallToolResult> {
    const started = performance.now();
    const correlationId = this.options.context.correlationId;
    // Every terminal state below is built from results the uploader actually observed.
    // It reports each file as it settles, so a host deadline that fires mid-request
    // still describes what happened instead of guessing it.
    const results: AttachmentFileResult[] = [];
    let uploadStarted = false;
    let request: AttachmentUploadRequest | undefined;

    if (this.options.route.connectionRole !== 'USER') {
      // The file is published as the requesting user, so a DIAGNOSTIC authority —
      // which exists to read metadata, never to write as a business user — must not
      // be able to reach this Tool at all.
      const error = new RemoteRuntimeError(
        'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED',
        `Tool ${this.getName()} is fixed to the USER request scope and cannot execute with DIAGNOSTIC authority.`,
        { correlationId },
      );
      await this.log('BLOCKED', elapsed(started), error.code, input);
      return remoteRuntimeErrorToolResult(error, [], correlationId);
    }

    try {
      const parsed = uploadFilesInputSchema.parse(input);
      request = {
        objectApiName: parsed.objectApiName,
        recordId: parsed.recordId,
        attachmentRefs: parsed.attachmentRefs,
      };
      const uploader = new SalesforceAttachmentUploader({
        connectionProvider: this.options.connectionProvider,
        ingress: this.options.ingress,
        policy: this.options.attachmentPolicy,
        platformUserId: this.options.platformUserId,
        uploadTimeoutMs: this.options.toolTimeoutMs,
        ...(this.options.redactionSecrets ? { redactionSecrets: this.options.redactionSecrets } : {}),
        onFileResult: (result) => { results.push(result); },
        onUploadStarted: () => { uploadStarted = true; },
      });
      const outcome = await withTimeout(
        uploader.upload(request),
        this.options.toolTimeoutMs,
        'MCP_TOOL_TIMEOUT',
        `Tool ${this.getName()} exceeded MCP_TOOL_TIMEOUT_MS. The runtime stopped waiting; Salesforce server-side cancellation is not guaranteed.`,
        correlationId,
      );
      const result = uploadFilesToolResult(outcome);
      // The audit `result` follows the Tool result's own `isError`, the way `DmlToolFacade`
      // derives it, so the two surfaces cannot drift: an OUTCOME_UNKNOWN is an
      // unsuccessful execution and is never recorded as a pass.
      await this.log(
        result.isError === true ? 'ERROR' : 'PASS',
        elapsed(started),
        outcome.errorCode ?? undefined,
        input,
        outcome,
        result,
      );
      return result;
    } catch (error) {
      if (request && uploadStarted) {
        // At least one ContentVersion POST was issued and the request did not run to
        // completion, so the file in flight may or may not have been published. That is
        // an unknown outcome regardless of how many files had already succeeded, and it
        // is never retried automatically.
        const outcome = aggregateAttachmentOutcome(request, results, 'OUTCOME_UNKNOWN');
        const result = uploadFilesToolResult(outcome);
        await this.log('ERROR', elapsed(started), outcome.errorCode ?? undefined, input, outcome, result);
        return result;
      }
      const normalized = error instanceof RemoteRuntimeError
        ? error
        : new RemoteRuntimeError('MCP_ATTACHMENT_UPLOAD_FAILED', safeMessage(error), { cause: error, correlationId });
      // Validation, policy and reference-resolution failures all happen before anything
      // is sent, so they travel through the ordinary terminal error contract: there is
      // no partial result to report and the call is safely retryable once corrected.
      const result = uploadFilesErrorToolResult(normalized, this.options.redactionSecrets, correlationId);
      await this.log('ERROR', elapsed(started), normalized.code, input, undefined, result);
      return result;
    }
  }

  /**
   * Terminal evidence for one attachment invocation.
   *
   * The request summary carries the object, the target record and the attachment
   * references — never a staged path, the file bytes, their base64 form, the raw
   * multipart body, or the Bearer token. The Salesforce-side facts (ContentVersionId,
   * ContentDocumentId, HTTP status, and the platform's own errorCode and message) are
   * recorded per file, so a partial upload stays diagnosable without the wire.
   */
  private async log(
    result: 'PASS' | 'ERROR' | 'BLOCKED',
    durationMs: number,
    errorCode?: string,
    input: Record<string, unknown> = {},
    outcome?: AttachmentUploadOutcome,
    terminal?: CallToolResult,
  ): Promise<void> {
    const structured = isRecord(terminal?.structuredContent) ? terminal.structuredContent : undefined;
    const objectApiName = outcome?.objectApiName
      ?? (typeof input.objectApiName === 'string' ? input.objectApiName : undefined);
    const recordId = outcome?.recordId ?? (typeof input.recordId === 'string' ? input.recordId : undefined);
    const attachmentRefs = Array.isArray(input.attachmentRefs)
      ? input.attachmentRefs.filter((value): value is string => typeof value === 'string')
        .map((value) => value.slice(0, 128))
      : [];
    const unknown = outcome?.status === 'OUTCOME_UNKNOWN'
      || errorCode === 'MCP_ATTACHMENT_OUTCOME_UNKNOWN'
      || errorCode === 'MCP_TOOL_TIMEOUT';
    try {
      await Promise.resolve(this.options.logger.log({
        correlationId: this.options.context.correlationId,
        clientId: this.options.clientId,
        platformUserId: this.options.context.platformUserId,
        salesforceUsername: this.options.route.salesforceUsername,
        executionRole: this.options.route.connectionRole,
        toolName: this.getName(),
        operation: 'ATTACHMENT',
        ...(objectApiName ? { objectApiName } : {}),
        ...(recordId ? { recordId } : {}),
        durationMs,
        result,
        outcome: unknown ? 'UNKNOWN' : result === 'PASS' ? 'SUCCESS' : result === 'BLOCKED' ? 'DENIED' : 'FAILED',
        ...(errorCode ? { errorCode } : {}),
        ...(unknown ? { mutationStarted: true, terminationLayer: 'TOOL' as const } : {}),
        requestSummary: {
          operation: 'ATTACHMENT',
          objectApiName: objectApiName ?? null,
          recordId: recordId ?? null,
          attachmentRefs,
          attachmentCount: attachmentRefs.length,
        },
        responseSummary: outcome
          ? {
              success: outcome.status === 'SUCCESS',
              status: outcome.status,
              businessOutcome: outcome.status,
              partial: outcome.status === 'PARTIAL_SUCCESS',
              totalCount: outcome.totalCount,
              succeededCount: outcome.succeeded,
              failedCount: outcome.failed,
              unknownCount: outcome.unknown,
              notAttemptedCount: outcome.notAttempted,
              salesforceApiType: 'REST_API',
              files: outcome.results.map((file) => ({
                index: file.index,
                attachmentRef: file.attachmentRef,
                fileName: file.fileName,
                status: file.status,
                contentVersionId: file.contentVersionId,
                contentDocumentId: file.contentDocumentId,
                httpStatus: file.httpStatus,
                errorCode: file.errorCode,
                salesforceErrorCode: file.salesforceErrorCode,
                salesforceMessage: file.salesforceMessage,
                durationMs: file.durationMs,
              })),
              ...(errorCode ? { errorCode } : {}),
              ...(recordId ? { recordId } : {}),
            }
          : {
              success: false,
              errorCode: typeof structured?.errorCode === 'string' ? structured.errorCode : errorCode,
              ...(recordId ? { recordId } : {}),
            },
        auditEvent: {
          eventCategory: 'TOOL',
          eventType: unknown ? 'ATTACHMENT_OUTCOME_UNKNOWN' : 'TOOL_TERMINAL',
          eventName: this.getName(),
          terminalSource: 'TOOL',
        },
      })).catch(() => undefined);
    } catch { /* Audit failure can never change an outcome Salesforce has determined. */ }
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

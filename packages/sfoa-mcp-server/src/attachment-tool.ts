import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpTool, ReleaseState, Toolset, type McpToolConfig } from '@salesforce/mcp-provider-api';
import { redactSensitiveText } from '@sfoa/identity-runtime';
import { z } from 'zod';
import {
  ATTACHMENT_AGGREGATE_STATUSES,
  ATTACHMENT_FILE_STATUSES,
  type AttachmentUploadOutcome,
} from './attachment-upload.js';
import { RemoteRuntimeError } from './errors.js';

export const UPLOAD_FILES_TO_RECORD_TOOL_NAME = 'upload_files_to_record';
export const MAX_ATTACHMENTS_PER_CALL = 10;

const attachmentRefSchema = z.string().trim().regex(
  /^att_[A-Za-z0-9_-]{24}$/u,
  'must be an attachment reference returned by the SFoA Attachment Ingress',
);

/**
 * The whole input surface of `upload_files_to_record`.
 *
 * There is deliberately no `content`, no `base64`, no `path`, no `filePath` and no
 * `sourceUrl` field. The runtime has no way to accept a file from the model at all:
 * a file reaches Salesforce only through a reference the ingress minted for this
 * requester, which is what keeps the model out of the byte path and closes the
 * arbitrary-read and SSRF shapes a path or URL field would open.
 */
export const uploadFilesInputSchema = z.object({
  objectApiName: z.string().trim().min(1).max(128)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/u, 'must be a Salesforce object API name without a relationship path')
    .describe('API name of the object that owns the target record, for example Opportunity.'),
  recordId: z.string().trim().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u, 'must be a 15- or 18-character Salesforce record id')
    .describe('Id of the existing record the files are attached to. The record must already exist.'),
  attachmentRefs: z.array(attachmentRefSchema).min(1).max(MAX_ATTACHMENTS_PER_CALL)
    .describe('Opaque references from the inbound channel, in the order they should be attached. Never invent one.'),
}).strict();

const uploadFilesOutputShape = {
  success: z.boolean(),
  status: z.enum(ATTACHMENT_AGGREGATE_STATUSES),
  objectApiName: z.string(),
  recordId: z.string(),
  totalCount: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  unknown: z.number().int(),
  notAttempted: z.number().int(),
  errorCode: z.string().nullable(),
  message: z.string().nullable(),
  results: z.array(z.object({
    index: z.number().int(),
    attachmentRef: z.string(),
    fileName: z.string().nullable(),
    status: z.enum(ATTACHMENT_FILE_STATUSES),
    contentVersionId: z.string().nullable(),
    contentDocumentId: z.string().nullable(),
    httpStatus: z.number().int().nullable(),
    errorCode: z.string().nullable(),
    salesforceErrorCode: z.string().nullable(),
    salesforceMessage: z.string().nullable(),
    durationMs: z.number().int(),
  })),
} as const;

export type UploadFilesInput = z.infer<typeof uploadFilesInputSchema>;

type UploadFilesInputShape = typeof uploadFilesInputSchema.shape;
type UploadFilesOutputShape = typeof uploadFilesOutputShape;

/**
 * The host-native Tool object for `upload_files_to_record`.
 *
 * It carries the name, the schema and the release state and nothing else. The
 * executable path is `AttachmentToolFacade`, which composes the request-scoped
 * Salesforce identity, the Attachment Ingress and the P7 Audit collector — none of
 * which a Provider can reach, and none of which belong in a schema carrier.
 *
 * It exists because the runtime has to be able to *name* every enabled Tool: the
 * governed server and the discovery server both resolve an enabled Tool through a
 * Provider-supplied inventory and refuse, with `MCP_TOOL_NOT_AVAILABLE`, any name the
 * inventory does not contain. Without this object, enabling the attachment Tool would
 * fail closed at startup rather than serve it — which is the failure this class
 * removes. `exec` is therefore unreachable by design; it throws rather than pretend
 * to be an execution path.
 */
export class UploadFilesToRecordTool extends McpTool<UploadFilesInputShape, UploadFilesOutputShape> {
  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return UPLOAD_FILES_TO_RECORD_TOOL_NAME;
  }

  public getConfig(): McpToolConfig<UploadFilesInputShape, UploadFilesOutputShape> {
    return uploadFilesToolConfig();
  }

  public exec(): never {
    throw new RemoteRuntimeError(
      'MCP_TOOL_NOT_AVAILABLE',
      `${UPLOAD_FILES_TO_RECORD_TOOL_NAME} is executed by AttachmentToolFacade, not by its Tool descriptor.`,
    );
  }
}

export function createUploadFilesToRecordTool(): McpTool<UploadFilesInputShape, UploadFilesOutputShape> {
  return new UploadFilesToRecordTool();
}

export function uploadFilesToolConfig(): McpToolConfig<UploadFilesInputShape, UploadFilesOutputShape> {
  return {
    title: 'Attach Files To Salesforce Record',
    description: [
      'Attach one or more files to one existing Salesforce record.',
      'Files arrive from the conversation channel as opaque attachmentRef values; pass them through unchanged and never invent one.',
      'The object must be configured for attachment upload in SFoA governance, and the target record must already exist — create the record first and only upload once the create is known to have succeeded.',
      'This tool reports one result per file, so a partial upload is reported as PARTIAL_SUCCESS rather than as a clean success or a clean failure.',
      'If a file comes back OUTCOME_UNKNOWN the runtime stops and reports the remaining files as NOT_ATTEMPTED; do not replay them, because Salesforce may already have published the file.',
    ].join(' '),
    inputSchema: uploadFilesInputSchema.shape,
    outputSchema: uploadFilesOutputShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  };
}

/** Terminal tool result for a call rejected before any file was sent. */
export function uploadFilesErrorToolResult(
  error: RemoteRuntimeError,
  secrets: readonly string[] = [],
  correlationId = error.correlationId,
): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: formatAttachmentError(error, secrets, correlationId) }],
    structuredContent: {
      success: false,
      errorCode: error.code,
      message: error.message.slice(0, 2_000),
    },
  };
}

export function uploadFilesToolResult(outcome: AttachmentUploadOutcome): CallToolResult {
  const text = outcome.status === 'SUCCESS'
    ? `Attached ${outcome.succeeded} file(s) to ${outcome.objectApiName} ${outcome.recordId}.`
    : `Attachment outcome ${outcome.status}: ${outcome.succeeded} succeeded, ${outcome.failed} failed, `
      + `${outcome.unknown} unknown, ${outcome.notAttempted} not attempted.`;
  return {
    // `isError` answers "did the Tool execution complete", not "did every file succeed" —
    // the same contract the batch DML Tools hold. A PARTIAL_SUCCESS is a completed
    // execution with an incomplete business result, so it is not an error; an
    // OUTCOME_UNKNOWN is not a completed execution at all, so it is, exactly as
    // `create_records` and `update_records` report an unknown batch outcome.
    isError: outcome.status === 'FAILED' || outcome.status === 'OUTCOME_UNKNOWN',
    content: [{ type: 'text', text }],
    structuredContent: {
      success: outcome.status === 'SUCCESS',
      status: outcome.status,
      objectApiName: outcome.objectApiName,
      recordId: outcome.recordId,
      totalCount: outcome.totalCount,
      succeeded: outcome.succeeded,
      failed: outcome.failed,
      unknown: outcome.unknown,
      notAttempted: outcome.notAttempted,
      errorCode: outcome.errorCode,
      message: outcome.message,
      results: outcome.results.map((result) => ({ ...result })),
    },
  };
}

function formatAttachmentError(
  error: RemoteRuntimeError,
  secrets: readonly string[],
  correlationId: string | undefined,
): string {
  const suffix = correlationId ? ` Correlation ID: ${correlationId}.` : '';
  return `[${error.code}] ${redactSensitiveText(error.message, secrets)}${suffix}`;
}

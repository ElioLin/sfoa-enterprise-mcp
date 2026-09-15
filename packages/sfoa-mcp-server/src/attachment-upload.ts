import { randomUUID } from 'node:crypto';
import {
  currentRequestAuditContext,
  type SalesforceConnectionProvider,
} from '@sfoa/identity-runtime';
import type { AttachmentStagingRecord } from '@sfoa/control-plane';
import type { AttachmentPolicy } from './attachment-policy.js';
import type { AttachmentIngress } from './attachment-ingress.js';
import { buildMultipartBody } from './attachment-multipart.js';
import { RemoteRuntimeError } from './errors.js';

/**
 * Per-file and aggregate outcomes for one `upload_files_to_record` call.
 *
 * These are the same four aggregate business outcomes the batch DML tools use, so an
 * operator reads one model across both mutation surfaces, plus `NOT_ATTEMPTED` at the
 * per-file level: when an earlier file reaches an unknown outcome the runtime stops,
 * and the files it never sent must be reported as unsent rather than as failed.
 */
export const ATTACHMENT_FILE_STATUSES = ['SUCCESS', 'FAILED', 'OUTCOME_UNKNOWN', 'NOT_ATTEMPTED'] as const;
export type AttachmentFileStatus = (typeof ATTACHMENT_FILE_STATUSES)[number];
export const ATTACHMENT_AGGREGATE_STATUSES = ['SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'OUTCOME_UNKNOWN'] as const;
export type AttachmentAggregateStatus = (typeof ATTACHMENT_AGGREGATE_STATUSES)[number];

export type AttachmentFileResult = Readonly<{
  index: number;
  attachmentRef: string;
  fileName: string | null;
  status: AttachmentFileStatus;
  contentVersionId: string | null;
  contentDocumentId: string | null;
  httpStatus: number | null;
  errorCode: string | null;
  salesforceErrorCode: string | null;
  salesforceMessage: string | null;
  durationMs: number;
}>;

export type AttachmentUploadOutcome = Readonly<{
  status: AttachmentAggregateStatus;
  objectApiName: string;
  recordId: string;
  totalCount: number;
  succeeded: number;
  failed: number;
  unknown: number;
  notAttempted: number;
  results: readonly AttachmentFileResult[];
  errorCode: string | null;
  message: string | null;
}>;

export type AttachmentUploadRequest = Readonly<{
  objectApiName: string;
  recordId: string;
  attachmentRefs: readonly string[];
}>;

export type SalesforceAttachmentUploaderOptions = Readonly<{
  connectionProvider: SalesforceConnectionProvider;
  ingress: AttachmentIngress;
  policy: AttachmentPolicy;
  platformUserId: string;
  uploadTimeoutMs: number;
  redactionSecrets?: readonly string[];
  /**
   * Called as each file reaches a terminal state, so a host deadline that fires
   * mid-request can still report what actually happened instead of guessing.
   */
  onFileResult?: (result: AttachmentFileResult) => void;
  /** Called immediately before the first ContentVersion POST is issued. */
  onUploadStarted?: () => void;
}>;

/**
 * Publishes staged files onto one business record as Salesforce Files.
 *
 * The order of the gates is the security property, so it is fixed:
 * identity (already resolved by the caller) → target object policy → target record →
 * attachment reference ownership and lifetime → Salesforce. Nothing reaches Salesforce
 * before the reference has been proven to belong to this requester, and the Salesforce
 * Connection is not even created until the first reference has resolved, so a request
 * full of bad references costs no Salesforce round trip at all.
 */
export class SalesforceAttachmentUploader {
  public constructor(private readonly options: SalesforceAttachmentUploaderOptions) {}

  public async upload(request: AttachmentUploadRequest): Promise<AttachmentUploadOutcome> {
    this.options.policy.assertAllowed(request.objectApiName);
    const recordId = assertRecordId(request.recordId);

    const results: AttachmentFileResult[] = [];
    const push = (result: AttachmentFileResult): void => {
      results.push(result);
      this.options.onFileResult?.(result);
    };
    let stopped = false;
    let mediaUploaded = false;

    for (const [index, attachmentRef] of request.attachmentRefs.entries()) {
      if (stopped) {
        push(notAttempted(index, attachmentRef));
        continue;
      }
      const started = performance.now();
      let record: AttachmentStagingRecord;
      try {
        record = await this.options.ingress.resolveForOwner(attachmentRef, this.options.platformUserId);
      } catch (error) {
        push(fileFailure(index, attachmentRef, null, error, elapsed(started)));
        continue;
      }
      // The target is proven on the first file that is actually about to be sent, not
      // before: a request whose references all fail ownership must not touch Salesforce.
      if (!mediaUploaded) {
        await this.assertTargetVisible(request.objectApiName, recordId);
        mediaUploaded = true;
      }
      const outcome = await this.uploadOne(index, attachmentRef, record, request.objectApiName, recordId);
      push(outcome.result);
      if (outcome.result.status === 'OUTCOME_UNKNOWN') stopped = true;
    }

    return aggregateAttachmentOutcome(request, results);
  }

  /**
   * Proves the record exists, belongs to `objectApiName`, and is visible to this
   * requester — the runtime never assumes a fifteen-character id is well-formed for the
   * object it was given, and it never validates with a fixed integration identity.
   */
  private async assertTargetVisible(objectApiName: string, recordId: string): Promise<void> {
    const connection = await this.options.connectionProvider.getConnection();
    const url = `${salesforceBaseUrl(connection)}/services/data/v${apiVersionOf(connection)}/sobjects/${objectApiName}/${recordId}?fields=Id`;
    const startedAt = new Date();
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessTokenOf(connection)}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.uploadTimeoutMs),
      });
    } catch (error) {
      recordApiCall({
        startedAt, httpMethod: 'GET', url, operationName: `${objectApiName}.readTarget`,
        purpose: 'ATTACHMENT_TARGET_VALIDATION', httpStatus: null, result: 'FAILED',
        salesforceErrorCode: null, salesforceErrorMessage: safeMessage(error), responseSizeBytes: null,
        contentType: null, objectApiName, recordId,
      });
      throw new RemoteRuntimeError(
        'MCP_ATTACHMENT_TARGET_INVALID',
        `The target record could not be verified with Salesforce: ${safeMessage(error)}`,
      );
    }
    const body = await readBoundedText(response);
    recordApiCall({
      startedAt, httpMethod: 'GET', url, operationName: `${objectApiName}.readTarget`,
      purpose: 'ATTACHMENT_TARGET_VALIDATION', httpStatus: response.status,
      result: response.ok ? 'SUCCESS' : 'FAILED',
      salesforceErrorCode: parseSalesforceErrorCode(body),
      salesforceErrorMessage: parseSalesforceErrorMessage(body),
      responseSizeBytes: body.length, contentType: response.headers.get('content-type'),
      objectApiName, recordId,
    });
    if (!response.ok) {
      throw new RemoteRuntimeError(
        'MCP_ATTACHMENT_TARGET_INVALID',
        `Record ${recordId} is not a ${objectApiName} record visible to this Salesforce user.`,
      );
    }
  }

  private async uploadOne(
    index: number,
    attachmentRef: string,
    record: AttachmentStagingRecord,
    objectApiName: string,
    recordId: string,
  ): Promise<{ result: AttachmentFileResult }> {
    const startedAt = new Date();
    const started = performance.now();
    let opened: Awaited<ReturnType<AttachmentIngress['openForUpload']>>;
    try {
      opened = await this.options.ingress.openForUpload(record);
    } catch (error) {
      await this.options.ingress.fail(record, errorCodeOf(error));
      return { result: fileFailure(index, attachmentRef, record.fileName, error, elapsed(started)) };
    }

    const connection = await this.options.connectionProvider.getConnection();
    const url = `${salesforceBaseUrl(connection)}/services/data/v${apiVersionOf(connection)}/sobjects/ContentVersion`;
    // `PathOnClient` is the channel's own file name. The runtime does not read an
    // extension or a MIME type from configuration and does not reject on one:
    // Salesforce is the final authority on which files it accepts, and a local mirror
    // of those rules would drift from it and start refusing valid files.
    const entityContent = Buffer.from(JSON.stringify({
      Title: titleFor(record.fileName),
      PathOnClient: record.fileName,
      FirstPublishLocationId: recordId,
    }), 'utf8');
    const multipart = buildMultipartBody([
      { name: 'entity_content', contentType: 'application/json', content: entityContent },
      {
        name: 'VersionData',
        ...(opened.mimeType ? { contentType: opened.mimeType } : {}),
        fileName: opened.fileName,
        content: { stream: opened.stream, byteSize: opened.byteSize },
      },
    ]);

    let response: Response;
    try {
      // Past this point Salesforce may publish the file even if the runtime never sees
      // the answer, so the host deadline can no longer treat the request as unsent.
      this.options.onUploadStarted?.();
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessTokenOf(connection)}`,
          accept: 'application/json',
          'content-type': multipart.contentType,
          'content-length': String(multipart.contentLength),
        },
        // The file part is streamed from the staged file, so the request body is an
        // async iterable rather than a buffer. Node requires `duplex: 'half'` for that,
        // and the encoder has already computed an exact `Content-Length` from the part
        // sizes, so the request is not sent chunked.
        body: multipart.body,
        duplex: 'half',
        signal: AbortSignal.timeout(this.options.uploadTimeoutMs),
      });
    } catch (error) {
      // No HTTP response came back at all. The file may still have been published —
      // a reset after the server accepted the body is indistinguishable from one
      // before it — so this is reported as UNKNOWN and is never retried automatically.
      recordApiCall({
        startedAt, httpMethod: 'POST', url, operationName: 'ContentVersion.create',
        purpose: 'ATTACHMENT_UPLOAD', httpStatus: null, result: 'FAILED',
        salesforceErrorCode: null, salesforceErrorMessage: safeMessage(error), responseSizeBytes: null,
        contentType: multipart.contentType, requestSizeBytes: multipart.contentLength,
        objectApiName, recordId,
      });
      return {
        result: {
          ...fileResult(index, attachmentRef, opened.fileName, 'OUTCOME_UNKNOWN'),
          errorCode: 'MCP_ATTACHMENT_OUTCOME_UNKNOWN',
          salesforceMessage: safeMessage(error),
          durationMs: elapsed(started),
        },
      };
    }

    const body = await readBoundedText(response);
    const parsed = parseJson(body);
    const contentVersionId = typeof parsed?.id === 'string' ? parsed.id : null;
    const succeeded = response.ok && parsed?.success === true;

    recordApiCall({
      startedAt, httpMethod: 'POST', url, operationName: 'ContentVersion.create',
      purpose: 'ATTACHMENT_UPLOAD', httpStatus: response.status,
      result: succeeded ? 'SUCCESS' : 'FAILED',
      salesforceErrorCode: parseSalesforceErrorCode(body),
      salesforceErrorMessage: parseSalesforceErrorMessage(body),
      responseSizeBytes: body.length, requestSizeBytes: multipart.contentLength,
      contentType: multipart.contentType, objectApiName,
      recordId: contentVersionId ?? recordId,
    });

    if (succeeded && contentVersionId) {
      const contentDocumentId = await this.readContentDocumentId(connection, contentVersionId);
      // The file is published: this is a proven success even if the follow-up lookup
      // for the document id failed. An unknown document id is missing evidence, not an
      // unknown outcome.
      await this.options.ingress.complete(record);
      return {
        result: {
          ...fileResult(index, attachmentRef, opened.fileName, 'SUCCESS'),
          contentVersionId,
          contentDocumentId,
          httpStatus: response.status,
          durationMs: elapsed(started),
        },
      };
    }

    // A response arrived but did not say the file was created. Salesforce answers a
    // refusal with a JSON *array* (`[{ message, errorCode, fields }]`), so asking "did the
    // body parse as a JSON object" would miss every real rejection and report an
    // unambiguous size or type refusal as an unknown outcome — stopping the call and
    // sending an operator to reconcile a file the platform plainly rejected. The question
    // is therefore only whether Salesforce answered in its own format at all: anything
    // else (a gateway page, an empty body) is not Salesforce speaking, and there the
    // honest answer is UNKNOWN rather than a failure we cannot actually prove.
    const status: AttachmentFileStatus = isJsonDocument(body) ? 'FAILED' : 'OUTCOME_UNKNOWN';
    if (status === 'FAILED') await this.options.ingress.fail(record, 'MCP_ATTACHMENT_UPLOAD_FAILED');
    return {
      result: {
        ...fileResult(index, attachmentRef, opened.fileName, status),
        httpStatus: response.status,
        errorCode: status === 'FAILED' ? 'MCP_ATTACHMENT_UPLOAD_FAILED' : 'MCP_ATTACHMENT_OUTCOME_UNKNOWN',
        salesforceErrorCode: parseSalesforceErrorCode(body),
        salesforceMessage: parseSalesforceErrorMessage(body),
        durationMs: elapsed(started),
      },
    };
  }

  private async readContentDocumentId(connection: unknown, contentVersionId: string): Promise<string | null> {
    const url = `${salesforceBaseUrl(connection)}/services/data/v${apiVersionOf(connection)}/query?q=${encodeURIComponent(`SELECT ContentDocumentId FROM ContentVersion WHERE Id = '${contentVersionId}'`)}`;
    const startedAt = new Date();
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessTokenOf(connection)}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.uploadTimeoutMs),
      });
      const body = await readBoundedText(response);
      const parsed = parseJson(body);
      const record = Array.isArray(parsed?.records) ? parsed.records[0] : undefined;
      const contentDocumentId = typeof record?.ContentDocumentId === 'string' ? record.ContentDocumentId : null;
      recordApiCall({
        startedAt, httpMethod: 'GET', url, operationName: 'ContentVersion.readContentDocumentId',
        purpose: 'ATTACHMENT_UPLOAD', httpStatus: response.status,
        result: response.ok ? 'SUCCESS' : 'FAILED',
        salesforceErrorCode: parseSalesforceErrorCode(body),
        salesforceErrorMessage: parseSalesforceErrorMessage(body),
        responseSizeBytes: body.length, contentType: response.headers.get('content-type'),
        objectApiName: 'ContentVersion', recordId: contentVersionId,
      });
      return contentDocumentId;
    } catch {
      // Publishing already succeeded; a missing document id must not turn it into a
      // failure or an unknown outcome.
      return null;
    }
  }
}

const RECORD_ID_PATTERN = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u;

function assertRecordId(value: string): string {
  if (!RECORD_ID_PATTERN.test(value)) {
    throw new RemoteRuntimeError(
      'MCP_ATTACHMENT_TARGET_INVALID',
      'recordId must be a 15- or 18-character Salesforce record id.',
    );
  }
  return value;
}

/**
 * Folds per-file results into the aggregate.
 *
 * `forcedStatus` exists for the host deadline: when the runtime stops waiting on a
 * request that had already begun publishing, the aggregate must be OUTCOME_UNKNOWN
 * regardless of how many files happened to report SUCCESS first, because the file in
 * flight may or may not have been published.
 */
export function aggregateAttachmentOutcome(
  request: Pick<AttachmentUploadRequest, 'objectApiName' | 'recordId'>,
  results: readonly AttachmentFileResult[],
  forcedStatus?: AttachmentAggregateStatus,
): AttachmentUploadOutcome {
  const counts = {
    succeeded: results.filter((result) => result.status === 'SUCCESS').length,
    failed: results.filter((result) => result.status === 'FAILED').length,
    unknown: results.filter((result) => result.status === 'OUTCOME_UNKNOWN').length,
    notAttempted: results.filter((result) => result.status === 'NOT_ATTEMPTED').length,
  };
  // An unknown outcome dominates: the request cannot be summarised as a clean success
  // or a clean failure while a file may or may not have been published.
  const status: AttachmentAggregateStatus = forcedStatus ?? (counts.unknown > 0
    ? 'OUTCOME_UNKNOWN'
    : counts.succeeded === results.length && results.length > 0
      ? 'SUCCESS'
      : counts.succeeded > 0 ? 'PARTIAL_SUCCESS' : 'FAILED');
  const firstFailure = results.find((result) => result.status === 'FAILED' || result.status === 'OUTCOME_UNKNOWN');
  return Object.freeze({
    status,
    objectApiName: request.objectApiName,
    recordId: request.recordId,
    totalCount: results.length,
    ...counts,
    results: Object.freeze([...results]),
    errorCode: status === 'OUTCOME_UNKNOWN'
      ? firstFailure?.errorCode ?? 'MCP_ATTACHMENT_OUTCOME_UNKNOWN'
      : firstFailure?.errorCode ?? null,
    message: firstFailure?.salesforceMessage ?? null,
  });
}

function fileResult(
  index: number,
  attachmentRef: string,
  fileName: string | null,
  status: AttachmentFileStatus,
): AttachmentFileResult {
  return {
    index, attachmentRef, fileName, status,
    contentVersionId: null, contentDocumentId: null, httpStatus: null,
    errorCode: null, salesforceErrorCode: null, salesforceMessage: null, durationMs: 0,
  };
}

function fileFailure(
  index: number,
  attachmentRef: string,
  fileName: string | null,
  error: unknown,
  durationMs: number,
): AttachmentFileResult {
  return {
    ...fileResult(index, attachmentRef, fileName, 'FAILED'),
    errorCode: errorCodeOf(error),
    salesforceMessage: safeMessage(error),
    durationMs,
  };
}

/**
 * A file the runtime never sent because an earlier file reached an unknown outcome.
 * It carries no error code: nothing failed, it simply was not attempted, and giving it
 * a code would invite a caller to treat it as a retryable failure.
 */
function notAttempted(index: number, attachmentRef: string): AttachmentFileResult {
  return fileResult(index, attachmentRef, null, 'NOT_ATTEMPTED');
}

function errorCodeOf(error: unknown): string {
  return error instanceof RemoteRuntimeError ? error.code : 'MCP_ATTACHMENT_STAGING_FAILED';
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}

/** Salesforce `Title` is capped at 255 characters and defaults from the file name. */
function titleFor(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/u, '');
  return (withoutExtension.trim() || fileName).slice(0, 255);
}

function salesforceBaseUrl(connection: unknown): string {
  const instanceUrl = (connection as { instanceUrl?: unknown }).instanceUrl;
  if (typeof instanceUrl !== 'string' || instanceUrl.length === 0) {
    throw new RemoteRuntimeError(
      'MCP_ATTACHMENT_CONFIGURATION_INVALID',
      'The request-scoped Salesforce Connection did not expose an instance URL.',
    );
  }
  return instanceUrl.replace(/\/+$/u, '');
}

function accessTokenOf(connection: unknown): string {
  const accessToken = (connection as { accessToken?: unknown }).accessToken;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new RemoteRuntimeError(
      'MCP_ATTACHMENT_CONFIGURATION_INVALID',
      'The request-scoped Salesforce Connection did not expose an access token.',
    );
  }
  return accessToken;
}

function apiVersionOf(connection: unknown): string {
  // The version comes from the requester's own Connection, never from a constant the
  // runtime carries: a hardcoded version would silently drift from the org the file is
  // being published into. A Connection that cannot name its version is unusable here.
  const version = (connection as { version?: unknown }).version;
  if (typeof version !== 'string' || !/^\d{2,3}\.\d$/u.test(version)) {
    throw new RemoteRuntimeError(
      'MCP_ATTACHMENT_CONFIGURATION_INVALID',
      'The request-scoped Salesforce Connection did not expose an API version.',
    );
  }
  return version;
}

const MAX_RESPONSE_BYTES = 65_536;

async function readBoundedText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return text.slice(0, MAX_RESPONSE_BYTES);
}

/**
 * The response body as JSON of any shape, or `undefined` when it is not JSON at all.
 *
 * The shape matters in two places that must not be conflated: Salesforce answers a
 * successful `ContentVersion` publish with a JSON *object* and a refusal with a JSON
 * *array*, so "did this parse as an object" is the wrong question to ask when the answer
 * decides whether a rejected file is a failure or an unknown outcome — and it is also the
 * wrong question to ask when the answer decides whether the platform's own error code
 * survives into the audit trail.
 */
function parseJsonValue(body: string): unknown {
  if (!body.trim()) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether Salesforce answered in its own format at all — an object or an array. */
function isJsonDocument(body: string): boolean {
  return parseJsonValue(body) !== undefined;
}

/** The body when it is a JSON object, for reading named fields off a success response. */
function parseJson(body: string): Record<string, unknown> | undefined {
  const value = parseJsonValue(body);
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Salesforce returns `[{ message, errorCode, fields }]` for a rejected call. The code and
 * message are kept verbatim: they are the first cause of a failure and an operator
 * diagnosing it needs the platform's own words, not a paraphrase.
 */
function salesforceErrors(body: string): readonly Record<string, unknown>[] {
  const value = parseJsonValue(body);
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.errors)) return value.errors.filter(isRecord);
  return [];
}

function parseSalesforceErrorCode(body: string): string | null {
  const first = salesforceErrors(body)[0];
  return typeof first?.errorCode === 'string' ? first.errorCode : null;
}

function parseSalesforceErrorMessage(body: string): string | null {
  const first = salesforceErrors(body)[0];
  return typeof first?.message === 'string' ? first.message.slice(0, 2_000) : null;
}

type ApiCallEvidence = Readonly<{
  startedAt: Date;
  httpMethod: string;
  url: string;
  operationName: string;
  purpose: 'ATTACHMENT_TARGET_VALIDATION' | 'ATTACHMENT_UPLOAD';
  httpStatus: number | null;
  result: 'SUCCESS' | 'FAILED';
  salesforceErrorCode: string | null;
  salesforceErrorMessage: string | null;
  responseSizeBytes: number | null;
  contentType: string | null;
  objectApiName: string | null;
  recordId: string | null;
  requestSizeBytes?: number | null;
}>;

/**
 * Writes one `sfoa_salesforce_api_call` row for a call the P7 transport instrumentation
 * cannot see.
 *
 * The upload uses `fetch`, which the jsforce/`node:http` instrumentation in the audit
 * adapter does not observe, so the runtime records the call itself. Only metadata is
 * recorded: the request body is a multipart document containing the file's bytes, and
 * the file's bytes, its base64 form and the raw multipart body must never reach Audit.
 */
function recordApiCall(evidence: ApiCallEvidence): void {
  const controller = currentRequestAuditContext();
  if (!controller) return;
  try {
    const context = controller.snapshot();
    const completedAt = new Date();
    const parsed = new URL(evidence.url);
    controller.collector().recordSalesforceApiCall({
      publicApiCallId: randomUUID(),
      auditId: context.auditId,
      sequence: controller.nextSequence(),
      salesforceUsername: context.salesforceUsername,
      transportKind: 'HTTP',
      visibility: 'EXACT_HTTP',
      apiCategory: 'REST_API',
      apiVersion: /\/(?:v)(\d{2,3}\.\d)\//u.exec(parsed.pathname)?.[1] ?? null,
      httpMethod: evidence.httpMethod,
      // The query string is dropped: it carries no credential here, but a URL is the
      // one field most likely to grow a secret later, so the runtime never stores one.
      requestUrl: `${parsed.origin}${parsed.pathname}`,
      host: parsed.host,
      endpointPath: parsed.pathname,
      operationName: evidence.operationName,
      purpose: evidence.purpose,
      startedAt: evidence.startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - evidence.startedAt.getTime()),
      httpStatus: evidence.httpStatus,
      result: evidence.result,
      salesforceErrorCode: evidence.salesforceErrorCode,
      salesforceErrorMessage: evidence.salesforceErrorMessage,
      requestSizeBytes: evidence.requestSizeBytes ?? null,
      responseSizeBytes: evidence.responseSizeBytes,
      contentType: evidence.contentType,
      queryType: null,
      soqlStatement: null,
      totalSize: null,
      returnedRecords: null,
      done: null,
      hasNextRecords: null,
      dmlOperation: null,
      objectApiName: evidence.objectApiName,
      recordId: evidence.recordId,
      requestedFields: null,
      managedFields: null,
      submittedFields: null,
    });
  } catch {
    // Audit is fail-open here for the same reason it is elsewhere: it can never be
    // allowed to change an outcome that Salesforce has already determined.
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

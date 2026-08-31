import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import https from 'node:https';
import { Query } from '@jsforce/jsforce-node/lib/query.js';
import { Transport } from '@jsforce/jsforce-node/lib/transport.js';
import type {
  HttpRequest,
  HttpRequestOptions,
  HttpResponse,
} from '@jsforce/jsforce-node/lib/types/common.js';
import type { StreamPromise } from '@jsforce/jsforce-node/lib/util/promise.js';
import {
  currentRequestAuditContext,
  currentSalesforceCallSemanticScope,
  currentSalesforceApiPurpose,
  SalesforceCallSemanticScope,
  type RequestAuditContextController,
} from './request-audit-context.js';
import type {
  RequestAuditSalesforceApiCallSnapshot,
  SalesforceApiSemanticEvidence,
  SalesforceApiPurpose,
} from './request-audit-collector.js';
import { classifySalesforceApiUrl } from './salesforce-api-classifier.js';

const INSTALL_MARKER = Symbol.for('@sfoa/identity-runtime/jsforce-audit-adapter-installed');
const QUERY_INSTALL_MARKER = Symbol.for('@sfoa/identity-runtime/jsforce-query-audit-adapter-installed');
type MarkedTransportPrototype = Transport & { [INSTALL_MARKER]?: true };
type AuditedQueryPrototype = {
  execute(...args: unknown[]): unknown;
  once(event: string, listener: (value: unknown) => void): unknown;
  [QUERY_INSTALL_MARKER]?: true;
};

type JsforceObservation = {
  controller: RequestAuditContextController;
  auditId: string;
  salesforceUsername: string | null;
  purpose: SalesforceApiPurpose;
  logicalRequest: HttpRequest;
  attempts: number;
  capturedAttempts: number;
  pendingResponse?: PendingResponse;
};

type WireAttempt = Readonly<{
  publicApiCallId: string;
  sequence: number;
  startedAt: string;
  startedAtMs: number;
  request: HttpRequest;
  requestSizeBytes: number | null;
  semanticEvidence: SalesforceApiSemanticEvidence;
}>;

type PendingResponse = Readonly<{
  attempt: WireAttempt;
  statusCode: number;
  completedAtMs: number;
  contentType: string | null;
  responseSizeBytes: number | null;
}>;

const jsforceObservationStorage = new AsyncLocalStorage<JsforceObservation>();

export function installJsforceAuditAdapter(): void {
  const prototype = Transport.prototype as MarkedTransportPrototype;
  if (prototype[INSTALL_MARKER]) return;

  installNodeHttpAttemptObservers();
  installQueryResultObserver();

  const originalHttpRequest = Transport.prototype.httpRequest;
  Transport.prototype.httpRequest = function auditedHttpRequest(
    request: HttpRequest,
    options?: HttpRequestOptions,
  ): StreamPromise<HttpResponse> {
    const controller = currentRequestAuditContext();
    if (!controller) return originalHttpRequest.call(this, request, options);

    const context = controller.snapshot();
    const observation: JsforceObservation = {
      controller,
      auditId: context.auditId,
      salesforceUsername: context.salesforceUsername,
      purpose: currentSalesforceApiPurpose(),
      logicalRequest: request,
      attempts: 0,
      capturedAttempts: 0,
    };

    try {
      const result = jsforceObservationStorage.run(observation, () =>
        originalHttpRequest.call(this, request, options));
      jsforceObservationStorage.run(observation, () => {
        void result.then(
          (response) => completeObservation(observation, response),
          (error: unknown) => failObservation(observation, error),
        );
      });
      return result;
    } catch (error) {
      failObservation(observation, error);
      throw error;
    }
  };
  Object.defineProperty(prototype, INSTALL_MARKER, { value: true, configurable: false });
}

export function isJsforceAuditAdapterInstalled(): boolean {
  return (Transport.prototype as MarkedTransportPrototype)[INSTALL_MARKER] === true;
}

function installNodeHttpAttemptObservers(): void {
  http.request = auditedNodeRequest(http.request, 'http:');
  https.request = auditedNodeRequest(https.request, 'https:');
}

function auditedNodeRequest(original: typeof http.request, defaultProtocol: 'http:' | 'https:'): typeof http.request {
  return function sfoaAuditedNodeRequest(this: unknown, ...args: unknown[]): ClientRequest {
    const observation = jsforceObservationStorage.getStore();
    if (!observation) return Reflect.apply(original, this, args) as ClientRequest;

    flushPendingResponse(observation);
    const attempt = createWireAttempt(observation, args, defaultProtocol);
    observation.attempts += 1;
    const request = Reflect.apply(original, this, args) as ClientRequest;
    request.once('response', (response: IncomingMessage) => {
      observation.pendingResponse = Object.freeze({
        attempt,
        statusCode: response.statusCode ?? 0,
        completedAtMs: Date.now(),
        contentType: nodeHeaderValue(response, 'content-type'),
        responseSizeBytes: nodeContentLength(response),
      });
    });
    request.once('error', (error: unknown) => {
      if (observation.pendingResponse?.attempt === attempt) observation.pendingResponse = undefined;
      captureAttempt(observation, attempt, { error, completedAtMs: Date.now() });
    });
    return request;
  } as typeof http.request;
}

function completeObservation(observation: JsforceObservation, response: HttpResponse): void {
  const pending = observation.pendingResponse;
  if (pending) {
    observation.pendingResponse = undefined;
    captureAttempt(observation, pending.attempt, {
      statusCode: response.statusCode,
      completedAtMs: Date.now(),
      contentType: headerValue(response.headers, 'content-type'),
      responseSizeBytes: responseContentLength(response.headers),
      responseBody: response.body,
    });
  }
  if (observation.capturedAttempts === 0) {
    captureAttempt(observation, createLogicalFallbackAttempt(observation), {
      statusCode: response.statusCode,
      completedAtMs: Date.now(),
      contentType: headerValue(response.headers, 'content-type'),
      responseSizeBytes: responseContentLength(response.headers),
      responseBody: response.body,
    });
  }
}

function failObservation(observation: JsforceObservation, error: unknown): void {
  flushPendingResponse(observation);
  if (observation.capturedAttempts === 0) {
    captureAttempt(observation, createLogicalFallbackAttempt(observation), { error, completedAtMs: Date.now() });
  }
}

function flushPendingResponse(observation: JsforceObservation): void {
  const pending = observation.pendingResponse;
  if (!pending) return;
  observation.pendingResponse = undefined;
  captureAttempt(observation, pending.attempt, {
    statusCode: pending.statusCode,
    completedAtMs: pending.completedAtMs,
    contentType: pending.contentType,
    responseSizeBytes: pending.responseSizeBytes,
  });
}

function captureAttempt(
  observation: JsforceObservation,
  attempt: WireAttempt,
  outcome: Readonly<{
    statusCode?: number;
    completedAtMs: number;
    contentType?: string | null;
    responseSizeBytes?: number | null;
    responseBody?: string;
    error?: unknown;
  }>,
): void {
  observation.capturedAttempts += 1;
  safelyCapture(observation.controller, () => {
    const classification = classifySalesforceApiUrl(attempt.request.url);
    if (!classification) throw new Error('JSforce emitted an invalid absolute request URL.');
    const httpStatus = outcome.statusCode && outcome.statusCode >= 100 ? outcome.statusCode : null;
    const failed = outcome.error !== undefined || (httpStatus !== null && httpStatus >= 400);
    const salesforceError = failed && outcome.responseBody !== undefined
      ? extractSalesforceError(outcome.responseBody)
      : outcome.error !== undefined ? extractTransportError(outcome.error) : undefined;
    return {
      publicApiCallId: attempt.publicApiCallId,
      auditId: observation.auditId,
      sequence: attempt.sequence,
      salesforceUsername: observation.salesforceUsername,
      transportKind: 'JSFORCE',
      visibility: 'EXACT_HTTP',
      apiCategory: classification.apiCategory,
      apiVersion: classification.apiVersion,
      httpMethod: attempt.request.method,
      requestUrl: classification.requestUrl,
      host: classification.host,
      endpointPath: classification.endpointPath,
      operationName: null,
      purpose: effectivePurpose(classification.apiCategory, observation.purpose),
      startedAt: attempt.startedAt,
      completedAt: new Date(outcome.completedAtMs).toISOString(),
      durationMs: Math.max(0, outcome.completedAtMs - attempt.startedAtMs),
      httpStatus,
      result: failed ? 'FAILED' : 'SUCCESS',
      salesforceErrorCode: salesforceError?.code ?? null,
      salesforceErrorMessage: salesforceError?.message ?? null,
      requestSizeBytes: attempt.requestSizeBytes,
      // 不为审计重新扫描大型 Salesforce Response Body。
      // Content-Length 能低成本获得时记录；未知时保持 NULL。
      responseSizeBytes: outcome.responseSizeBytes ?? null,
      contentType: outcome.contentType ?? null,
      ...attempt.semanticEvidence,
    } satisfies RequestAuditSalesforceApiCallSnapshot;
  });
}

function createWireAttempt(
  observation: JsforceObservation,
  args: readonly unknown[],
  defaultProtocol: 'http:' | 'https:',
): WireAttempt {
  const startedAtMs = Date.now();
  const actualUrl = nodeRequestUrl(args, defaultProtocol) ?? observation.logicalRequest.url;
  const options = requestOptions(args);
  const method = auditedMethod(options?.method) ?? observation.logicalRequest.method;
  const publicApiCallId = randomUUID();
  return Object.freeze({
    publicApiCallId,
    sequence: observation.controller.nextSequence(),
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    request: Object.freeze({ url: actualUrl, method }),
    requestSizeBytes: contentLength(options) ?? byteLength(observation.logicalRequest.body),
    semanticEvidence: semanticEvidenceForAttempt(observation, publicApiCallId, actualUrl),
  });
}

function createLogicalFallbackAttempt(observation: JsforceObservation): WireAttempt {
  const startedAtMs = Date.now();
  const publicApiCallId = randomUUID();
  return Object.freeze({
    publicApiCallId,
    sequence: observation.controller.nextSequence(),
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    request: observation.logicalRequest,
    requestSizeBytes: byteLength(observation.logicalRequest.body),
    semanticEvidence: semanticEvidenceForAttempt(observation, publicApiCallId, observation.logicalRequest.url),
  });
}

function installQueryResultObserver(): void {
  const prototype = Query.prototype as unknown as AuditedQueryPrototype;
  if (prototype[QUERY_INSTALL_MARKER]) return;
  const originalExecute = prototype.execute;
  prototype.execute = function auditedQueryExecute(this: AuditedQueryPrototype, ...args: unknown[]): unknown {
    const semanticScope = currentSalesforceCallSemanticScope();
    if (semanticScope) {
      this.once('response', (value: unknown) => {
        if (!isRecord(value)) {
          currentRequestAuditContext()?.collector().recordSalesforceApiCaptureFailure();
          return;
        }
        semanticScope.enrichQueryResult({
          totalSize: value.totalSize,
          records: value.records,
          done: value.done,
          nextRecordsUrl: value.nextRecordsUrl,
        });
      });
    }
    return Reflect.apply(originalExecute, this, args);
  };
  Object.defineProperty(prototype, QUERY_INSTALL_MARKER, { value: true, configurable: false });
}

function semanticEvidenceForAttempt(
  observation: JsforceObservation,
  publicApiCallId: string,
  requestUrl: string,
): SalesforceApiSemanticEvidence {
  const active = currentSalesforceCallSemanticScope();
  if (active) return active.bind(publicApiCallId);
  try {
    const url = new URL(requestUrl);
    const path = url.pathname.toLowerCase();
    const queryType = /\/tooling\/query(?:\/|$)/u.test(path)
      ? 'TOOLING_SOQL' as const
      : /\/query(?:\/|$)/u.test(path) ? 'DATA_SOQL' as const : undefined;
    if (!queryType) return emptySemanticEvidence();
    const soql = url.searchParams.get('q');
    if (soql === null) {
      observation.controller.collector().recordSalesforceApiCaptureFailure();
      return emptySemanticEvidence();
    }
    // URL decoding is a fallback only. Without the high-level Query scope the
    // parsed result statistics cannot be deterministically attached.
    observation.controller.collector().recordSalesforceApiCaptureFailure();
    return SalesforceCallSemanticScope.query(observation.controller, { queryType, soqlStatement: soql })
      .bind(publicApiCallId);
  } catch {
    observation.controller.collector().recordSalesforceApiCaptureFailure();
    return emptySemanticEvidence();
  }
}

function emptySemanticEvidence(): SalesforceApiSemanticEvidence {
  return Object.freeze({
    queryType: null,
    soqlStatement: null,
    totalSize: null,
    returnedRecords: null,
    done: null,
    hasNextRecords: null,
    dmlOperation: null,
    objectApiName: null,
    recordId: null,
    requestedFields: null,
    managedFields: null,
    submittedFields: null,
  });
}

function safelyCapture(
  controller: RequestAuditContextController,
  factory: () => RequestAuditSalesforceApiCallSnapshot,
): void {
  try {
    controller.collector().recordSalesforceApiCall(factory());
  } catch {
    controller.collector().recordSalesforceApiCaptureFailure();
  }
}

function nodeRequestUrl(args: readonly unknown[], defaultProtocol: 'http:' | 'https:'): string | undefined {
  const first = args[0];
  if (first instanceof URL) return first.toString();
  if (typeof first === 'string') {
    try {
      return new URL(first).toString();
    } catch {
      return undefined;
    }
  }
  const options = requestOptions(args);
  if (!options || options.socketPath) return undefined;
  if (typeof options.path === 'string' && /^https?:\/\//iu.test(options.path)) return options.path;
  const protocol = options.protocol === 'http:' || options.protocol === 'https:' ? options.protocol : defaultProtocol;
  const rawHost = options.hostname ?? options.host;
  if (typeof rawHost !== 'string' || rawHost.length === 0) return undefined;
  const host = rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost;
  const port = options.port === undefined || options.port === null ? '' : `:${String(options.port)}`;
  const requestPath = typeof options.path === 'string' && options.path.startsWith('/') ? options.path : '/';
  try {
    return new URL(`${protocol}//${host}${port}${requestPath}`).toString();
  } catch {
    return undefined;
  }
}

function requestOptions(args: readonly unknown[]): RequestOptions | undefined {
  const candidate = typeof args[0] === 'string' || args[0] instanceof URL ? args[1] : args[0];
  return isRecord(candidate) ? candidate as RequestOptions : undefined;
}

function contentLength(options: RequestOptions | undefined): number | null {
  if (!options?.headers || Array.isArray(options.headers)) return null;
  const entry = Object.entries(options.headers).find(([name]) => name.toLowerCase() === 'content-length')?.[1];
  const value = Array.isArray(entry) ? entry[0] : entry;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function auditedMethod(value: string | undefined): HttpRequest['method'] | undefined {
  const normalized = value?.toUpperCase();
  switch (normalized) {
    case 'GET': case 'POST': case 'PUT': case 'PATCH': case 'DELETE': case 'OPTIONS': case 'HEAD':
      return normalized;
    default:
      return undefined;
  }
}

function nodeHeaderValue(response: IncomingMessage, requestedName: string): string | null {
  const value = response.headers[requestedName];
  if (Array.isArray(value)) return value.join(', ').slice(0, 256);
  return typeof value === 'string' ? value.slice(0, 256) : null;
}

function effectivePurpose(category: string, purpose: SalesforceApiPurpose): SalesforceApiPurpose {
  return category === 'OAUTH' ? 'IDENTITY_TOKEN_EXCHANGE' : purpose;
}

function extractSalesforceError(body: string): Readonly<{ code: string | null; message: string | null }> {
  const boundedBody = body.slice(0, 65_536);
  try {
    const parsed: unknown = JSON.parse(boundedBody);
    const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
    if (isRecord(candidate)) {
      return Object.freeze({
        code: safeErrorText(candidate.errorCode ?? candidate.error ?? candidate.code, 128),
        message: safeErrorText(candidate.message ?? candidate.error_description, 2_048),
      });
    }
  } catch {
    // SOAP and non-JSON errors are handled below without retaining the response body.
  }
  return Object.freeze({
    code: xmlElement(boundedBody, 'faultcode', 128),
    message: xmlElement(boundedBody, 'faultstring', 2_048),
  });
}

function extractTransportError(error: unknown): Readonly<{ code: string | null; message: string | null }> {
  if (!isRecord(error)) return Object.freeze({ code: null, message: 'Salesforce transport request failed.' });
  return Object.freeze({
    code: safeErrorText(error.code ?? error.name, 128),
    message: safeErrorText(error.message, 2_048) ?? 'Salesforce transport request failed.',
  });
}

function safeErrorText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const sanitized = value
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[JWT REDACTED]')
    .replace(/([?&](?:access_token|assertion|client_secret|refresh_token|session_id|sid)=)[^&#\s]*/giu, '$1[REDACTED]')
    .replace(/[\u0000-\u001F\u007F]/gu, '')
    .trim();
  return sanitized ? sanitized.slice(0, maxLength) : null;
}

function xmlElement(xml: string, name: string, maxLength: number): string | null {
  const match = new RegExp(`<${name}[^>]*>([^<]*)<\\/${name}>`, 'iu').exec(xml);
  return safeErrorText(match?.[1], maxLength);
}

const MAX_AUDIT_INLINE_SIZE_SCAN = 8_192;

function byteLength(body: HttpRequest['body']): number | null {
  if (Buffer.isBuffer(body)) return body.byteLength;
  if (typeof body === 'string') {
    return body.length <= MAX_AUDIT_INLINE_SIZE_SCAN ? Buffer.byteLength(body) : null;
  }
  // URLSearchParams 没有 O(1) size。即使结果最终超过阈值，先 toString() 仍会
  // 扫描并分配整个 body，因此普通审计路径不为它计算 size。
  if (body instanceof URLSearchParams) return null;
  return null;
}

function nodeContentLength(response: IncomingMessage): number | null {
  const value = response.headers['content-length'];
  const candidate = Array.isArray(value) ? value[0] : value;
  return parseContentLength(candidate);
}

function responseContentLength(headers: HttpResponse['headers']): number | null {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-length')?.[1];
  return parseContentLength(value);
}

function parseContentLength(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/u.test(value.trim())
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function headerValue(headers: HttpResponse['headers'], requestedName: string): string | null {
  const match = Object.entries(headers).find(([name]) => name.toLowerCase() === requestedName);
  return match?.[1]?.slice(0, 256) ?? null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

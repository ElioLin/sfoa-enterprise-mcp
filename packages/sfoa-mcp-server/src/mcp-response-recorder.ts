import type { ServerResponse } from 'node:http';
import type { RequestAuditContextController } from '@sfoa/identity-runtime';

export type McpTransportCompletionStatus =
  | 'RESPONSE_FINISHED'
  | 'CLIENT_DISCONNECTED'
  | 'WRITE_FAILED'
  | 'UNKNOWN';

export type BoundedMcpResponseRecorder = Readonly<{
  finalizeUnknown(): void;
  status(): McpTransportCompletionStatus | null;
}>;

const MAX_MCP_RESPONSE_CAPTURE_BYTES = 262_144;

/**
 * Observes one ServerResponse without buffering delivery or changing write/end
 * return values. Only a bounded prefix is copied after Node accepts each write.
 */
export function observeBoundedMcpResponse(
  response: ServerResponse,
  controller: RequestAuditContextController,
): BoundedMcpResponseRecorder {
  const originalWrite = response.write;
  const originalEnd = response.end;
  const prefixChunks: Buffer[] = [];
  let capturedBytes = 0;
  let totalSizeBytes: number | null = 0;
  let captureTruncated = false;
  let terminalStatus: McpTransportCompletionStatus | null = null;

  const observeChunk = (args: readonly unknown[]): void => {
    try {
      const chunk = args[0];
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return;
      const encoding = typeof args[1] === 'string' && Buffer.isEncoding(args[1]) ? args[1] : 'utf8';
      const remaining = MAX_MCP_RESPONSE_CAPTURE_BYTES - capturedBytes;
      if (remaining <= 0) {
        captureTruncated = true;
        totalSizeBytes = totalSizeBytes === null || typeof chunk === 'string'
          ? null
          : totalSizeBytes + chunk.byteLength;
        return;
      }
      const chunkSize = observedChunkSize(chunk, encoding);
      totalSizeBytes = totalSizeBytes === null || chunkSize === null ? null : totalSizeBytes + chunkSize;
      const prefix = boundedChunkPrefix(chunk, encoding, remaining);
      if (prefix.byteLength > 0) {
        prefixChunks.push(prefix);
        capturedBytes += prefix.byteLength;
      }
      if (chunkSize === null || chunkSize > prefix.byteLength) captureTruncated = true;
    } catch {
      captureTruncated = true;
    }
  };

  response.write = function auditedResponseWrite(this: ServerResponse, ...args: unknown[]): boolean {
    try {
      const result = Reflect.apply(originalWrite, this, args) as boolean;
      observeChunk(args);
      return result;
    } catch (error) {
      terminal('WRITE_FAILED', error);
      throw error;
    }
  } as typeof response.write;

  response.end = function auditedResponseEnd(this: ServerResponse, ...args: unknown[]): ServerResponse {
    try {
      const result = Reflect.apply(originalEnd, this, args) as ServerResponse;
      observeChunk(args);
      return result;
    } catch (error) {
      terminal('WRITE_FAILED', error);
      throw error;
    }
  } as typeof response.end;

  response.once('finish', () => terminal('RESPONSE_FINISHED'));
  response.once('close', () => {
    if (terminalStatus === null) terminal('CLIENT_DISCONNECTED');
  });
  response.once('error', (error: Error) => terminal('WRITE_FAILED', error));

  if (response.destroyed) terminal('CLIENT_DISCONNECTED');

  return Object.freeze({
    finalizeUnknown: () => terminal('UNKNOWN'),
    status: () => terminalStatus,
  });

  function terminal(status: McpTransportCompletionStatus, error?: unknown): void {
    if (terminalStatus !== null) return;
    terminalStatus = status;
    const responseFinished = status === 'RESPONSE_FINISHED';
    const safeErrorCode = status === 'WRITE_FAILED'
      ? 'MCP_RESPONSE_WRITE_FAILED'
      : status === 'CLIENT_DISCONNECTED' ? 'MCP_CLIENT_DISCONNECTED' : status === 'UNKNOWN' ? 'MCP_TRANSPORT_UNKNOWN' : undefined;
    const sequence = controller.collector().recordEvent({
      eventCategory: 'MCP',
      eventType: 'MCP_TRANSPORT_TERMINAL',
      eventName: `MCP transport ${status.toLocaleLowerCase('en-US')}`,
      status: responseFinished ? 'SUCCESS' : status === 'WRITE_FAILED' ? 'FAILED' : 'UNKNOWN',
      ...(safeErrorCode ? { errorCode: safeErrorCode } : {}),
      safeSummary: {
        transportStatus: status,
        responseFinished,
        clientReceiptConfirmed: false,
        httpStatus: response.statusCode,
        originalSizeBytes: totalSizeBytes,
        storedPrefixBytes: capturedBytes,
        ...(error instanceof Error ? { errorName: error.name } : {}),
      },
      ...(responseFinished
        ? {}
        : {
            terminal: {
              source: 'TRANSPORT' as const,
              result: 'ERROR' as const,
              outcome: status === 'WRITE_FAILED' ? 'FAILED' as const : 'UNKNOWN' as const,
              ...(safeErrorCode ? { errorCode: safeErrorCode } : {}),
              responseSummary: {
                transportStatus: status,
                responseFinished: false,
                clientReceiptConfirmed: false,
              },
            },
          }),
    });
    if (capturedBytes === 0) return;
    const payload = Buffer.concat(prefixChunks, capturedBytes);
    const content = payload.toString('utf8');
    const errorResponse = response.statusCode >= 400 || /"(?:error|isError)"\s*:\s*(?:\{|true)/u.test(content);
    controller.collector().recordPayloadEvidence({
      payloadType: 'MCP_RESPONSE',
      contentType: responseContentType(response),
      payload,
      originalSizeBytes: totalSizeBytes,
      truncated: captureTruncated || !responseFinished,
      ...(sequence === null ? {} : { auditEventSequence: sequence }),
      priority: errorResponse ? 'ERROR' : 'CORE',
    });
  }
}

function observedChunkSize(chunk: string | Buffer | Uint8Array, encoding: BufferEncoding): number | null {
  if (typeof chunk !== 'string') return chunk.byteLength;
  return chunk.length <= MAX_MCP_RESPONSE_CAPTURE_BYTES ? Buffer.byteLength(chunk, encoding) : null;
}

function boundedChunkPrefix(
  chunk: string | Buffer | Uint8Array,
  encoding: BufferEncoding,
  remaining: number,
): Buffer {
  if (typeof chunk === 'string') {
    const boundedText = chunk.slice(0, remaining);
    const encoded = Buffer.from(boundedText, encoding);
    return Buffer.from(encoded.subarray(0, Math.min(encoded.byteLength, remaining)));
  }
  const source = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(source.subarray(0, Math.min(source.byteLength, remaining)));
}

function responseContentType(response: ServerResponse): string {
  const value = response.getHeader('content-type');
  if (Array.isArray(value)) return value.join(', ').slice(0, 128);
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).slice(0, 128)
    : 'application/octet-stream';
}

/**
 * Controller-free bounded snapshot of one ServerResponse body, used for the
 * identity-less WeCom Discovery audit. Unlike `observeBoundedMcpResponse` it is
 * not coupled to a RequestAuditContextController and never records the captured
 * text as audit payload evidence — only a coarse JSON-RPC success/error summary
 * derived from it is logged (see `summarizeDiscoveryResponse`). Capturing stays
 * bounded to `MAX_MCP_RESPONSE_CAPTURE_BYTES` and never changes write/end
 * return values or buffers delivery.
 */
export type BoundedMcpResponseBodySnapshot = Readonly<{
  httpStatus: number;
  truncated: boolean;
  /** Decoded body text when any body bytes were written, else null (e.g. a notification-only POST). */
  bodyText: string | null;
}>;

export type BoundedMcpResponseBodyRecorder = Readonly<{
  /** Call only after the request has been served (response write/end already invoked). */
  snapshot(): BoundedMcpResponseBodySnapshot;
}>;

export function observeBoundedMcpResponseBody(response: ServerResponse): BoundedMcpResponseBodyRecorder {
  const originalWrite = response.write;
  const originalEnd = response.end;
  const prefixChunks: Buffer[] = [];
  let capturedBytes = 0;
  let totalSizeBytes: number | null = 0;
  let captureTruncated = false;

  const observeChunk = (args: readonly unknown[]): void => {
    try {
      const chunk = args[0];
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return;
      const encoding = typeof args[1] === 'string' && Buffer.isEncoding(args[1]) ? args[1] : 'utf8';
      const remaining = MAX_MCP_RESPONSE_CAPTURE_BYTES - capturedBytes;
      if (remaining <= 0) {
        captureTruncated = true;
        totalSizeBytes = totalSizeBytes === null || typeof chunk === 'string'
          ? null
          : totalSizeBytes + chunk.byteLength;
        return;
      }
      const chunkSize = observedChunkSize(chunk, encoding);
      totalSizeBytes = totalSizeBytes === null || chunkSize === null ? null : totalSizeBytes + chunkSize;
      const prefix = boundedChunkPrefix(chunk, encoding, remaining);
      if (prefix.byteLength > 0) {
        prefixChunks.push(prefix);
        capturedBytes += prefix.byteLength;
      }
      if (chunkSize === null || chunkSize > prefix.byteLength) captureTruncated = true;
    } catch {
      captureTruncated = true;
    }
  };

  response.write = function auditedResponseWrite(this: ServerResponse, ...args: unknown[]): boolean {
    try {
      const result = Reflect.apply(originalWrite, this, args) as boolean;
      observeChunk(args);
      return result;
    } catch (error) {
      throw error;
    }
  } as typeof response.write;

  response.end = function auditedResponseEnd(this: ServerResponse, ...args: unknown[]): ServerResponse {
    try {
      const result = Reflect.apply(originalEnd, this, args) as ServerResponse;
      observeChunk(args);
      return result;
    } catch (error) {
      throw error;
    }
  } as typeof response.end;

  return Object.freeze({
    snapshot: () => {
      const content = capturedBytes === 0 ? '' : Buffer.concat(prefixChunks, capturedBytes).toString('utf8');
      return Object.freeze({
        httpStatus: response.statusCode,
        truncated: captureTruncated,
        bodyText: capturedBytes === 0 ? null : content,
      });
    },
  });
}

export type DiscoveryResponseAudit = Readonly<{
  result: 'PASS' | 'ERROR' | 'BLOCKED';
  outcome: 'SUCCESS' | 'FAILED' | 'DENIED' | 'UNKNOWN';
  errorCode?: string;
  messageCount: number;
  errorCount: number;
}>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonRpcErrorCategory(code: unknown): string {
  switch (code) {
    case -32700: return 'JSON_RPC_PARSE_ERROR';
    case -32600: return 'JSON_RPC_INVALID_REQUEST';
    case -32601: return 'JSON_RPC_METHOD_NOT_FOUND';
    case -32602: return 'JSON_RPC_INVALID_PARAMS';
    case -32603: return 'JSON_RPC_INTERNAL_ERROR';
    default: return typeof code === 'number' ? `JSON_RPC_ERROR_${code}` : 'JSON_RPC_ERROR_UNKNOWN';
  }
}

/**
 * Classifies a served Discovery HTTP response as an audit verdict. A JSON-RPC
 * `error` member or a result flagged `isError` on any response message counts as
 * a Discovery failure even when the HTTP status is 200 — that is the Advertise-
 * but-Deny false-success case this replaces. An empty body under a <400 status
 * is a notification-only POST (e.g. `notifications/initialized`), which per SDK
 * semantics gets no response body and is not judged as a failure.
 */
export function summarizeDiscoveryResponse(snapshot: BoundedMcpResponseBodySnapshot): DiscoveryResponseAudit {
  const status = snapshot.httpStatus;
  if (status >= 400) {
    return Object.freeze({
      result: 'ERROR',
      outcome: 'FAILED',
      errorCode: `MCP_DISCOVERY_HTTP_${status}`,
      messageCount: 0,
      errorCount: 1,
    });
  }
  const text = snapshot.bodyText;
  if (text === null || text.trim() === '') {
    return Object.freeze({ result: 'PASS', outcome: 'SUCCESS', messageCount: 0, errorCount: 0 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Object.freeze({
      result: 'ERROR',
      outcome: 'FAILED',
      errorCode: 'MCP_DISCOVERY_UNPARSEABLE_RESPONSE',
      messageCount: 0,
      errorCount: 1,
    });
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  let messageCount = 0;
  let errorCount = 0;
  let firstErrorCode: string | undefined;
  for (const message of messages) {
    if (!isObject(message) || message.jsonrpc !== '2.0') continue;
    if (!('result' in message) && !('error' in message)) continue;
    messageCount += 1;
    const errorMember = message.error;
    if (errorMember !== undefined && isObject(errorMember)) {
      errorCount += 1;
      firstErrorCode ??= jsonRpcErrorCategory(errorMember.code);
    } else if (isObject(message.result) && message.result.isError === true) {
      errorCount += 1;
      firstErrorCode ??= 'TOOL_EXECUTION_ERROR';
    }
  }
  if (errorCount > 0) {
    return Object.freeze({
      result: 'ERROR',
      outcome: 'FAILED',
      ...(firstErrorCode ? { errorCode: firstErrorCode } : {}),
      messageCount,
      errorCount,
    });
  }
  return Object.freeze({ result: 'PASS', outcome: 'SUCCESS', messageCount, errorCount });
}

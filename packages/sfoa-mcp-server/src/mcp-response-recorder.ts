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

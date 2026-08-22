import type { IncomingMessage } from 'node:http';
import { RemoteRuntimeError } from './errors.js';

export async function readBoundedJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const contentLength = request.headers['content-length'];
  if (Array.isArray(contentLength) || (contentLength !== undefined && !/^\d+$/u.test(contentLength))) {
    throw new RemoteRuntimeError('MCP_REQUEST_INVALID', 'Content-Length must be one non-negative integer.');
  }
  if (contentLength !== undefined && Number(contentLength) > maxBodyBytes) {
    request.resume();
    throw tooLarge(maxBodyBytes);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(String(rawChunk), 'utf8');
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBodyBytes) {
      request.resume();
      throw tooLarge(maxBodyBytes);
    }
    chunks.push(chunk);
  }

  if (totalBytes === 0) {
    throw new RemoteRuntimeError('MCP_REQUEST_INVALID', 'The MCP POST body must contain one JSON-RPC message.');
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'));
    return parsed;
  } catch (error) {
    throw new RemoteRuntimeError('MCP_REQUEST_INVALID', 'The MCP POST body is not valid JSON.', { cause: error });
  }
}

function tooLarge(maxBodyBytes: number): RemoteRuntimeError {
  return new RemoteRuntimeError(
    'MCP_REQUEST_TOO_LARGE',
    `The MCP request body exceeds the configured ${maxBodyBytes}-byte limit.`,
  );
}

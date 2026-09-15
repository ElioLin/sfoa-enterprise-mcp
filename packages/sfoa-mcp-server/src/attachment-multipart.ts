import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';

/**
 * Minimal `multipart/form-data` encoder for the Salesforce REST File upload.
 *
 * It exists so the file body never becomes a `Buffer` in the runtime: the JSON part
 * is small and in memory, the file part is streamed straight from the staged handle
 * on disk. `Content-Length` is still exact — every part's size is known before the
 * first byte is produced — so the request does not fall back to chunked transfer,
 * which the Salesforce REST endpoint does not accept for this call.
 *
 * Nothing here is Salesforce-specific except that the caller names the parts; the
 * encoder only guarantees a well-formed body and a byte-exact `Content-Length`.
 */
export type MultipartPart = Readonly<{
  name: string;
  /** The part's own `Content-Type`. Salesforce requires it on the file part. */
  contentType?: string;
  /** Present only on file parts; becomes the `filename` parameter. */
  fileName?: string;
  content: Buffer | Readonly<{ stream: Readable; byteSize: number }>;
}>;

export type MultipartBody = Readonly<{
  contentType: string;
  contentLength: number;
  body: AsyncIterable<Buffer>;
}>;

export function buildMultipartBody(parts: readonly MultipartPart[]): MultipartBody {
  if (parts.length === 0) throw new Error('A multipart body needs at least one part.');
  const boundary = `----sfoa${randomBytes(16).toString('hex')}`;
  const delimiter = Buffer.from(`--${boundary}\r\n`, 'ascii');
  const closing = Buffer.from(`--${boundary}--\r\n`, 'ascii');

  const headers = parts.map((part) => {
    const disposition = part.fileName === undefined
      ? `Content-Disposition: form-data; name="${part.name}"`
      // The filename is a channel-supplied display label, never a path: the ingress
      // already reduced it to a basename. Quotes and newlines would break the header.
      : `Content-Disposition: form-data; name="${part.name}"; filename="${sanitizeHeaderValue(part.fileName)}"`;
    const contentType = part.contentType ? `\r\nContent-Type: ${part.contentType}` : '';
    return Buffer.from(`${disposition}${contentType}\r\n\r\n`, 'utf8');
  });

  const sizes = parts.map((part, index) => {
    const contentSize = Buffer.isBuffer(part.content) ? part.content.byteLength : part.content.byteSize;
    return delimiter.byteLength + headers[index]!.byteLength + contentSize + 2;
  });
  const contentLength = sizes.reduce((total, size) => total + size, 0) + closing.byteLength;

  async function* generate(): AsyncGenerator<Buffer> {
    for (const [index, part] of parts.entries()) {
      yield delimiter;
      yield headers[index]!;
      if (Buffer.isBuffer(part.content)) {
        yield part.content;
      } else {
        for await (const chunk of part.content.stream) {
          yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        }
      }
      yield CRLF;
    }
    yield closing;
  }

  return Object.freeze({
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength,
    body: generate(),
  });
}

const CRLF = Buffer.from('\r\n', 'ascii');

/** Strips anything that would end the header line or start a new one. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/["\r\n]/gu, '_');
}

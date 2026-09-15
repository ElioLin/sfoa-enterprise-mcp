import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IdentitySource } from '@sfoa/control-plane';
import {
  IdentityRuntimeError,
  type RequestHeaders,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
import type { IdentityProvider } from './authenticator.js';
import type { AttachmentIngress } from './attachment-ingress.js';
import type { AttachmentRuntimeConfig } from './config.js';
import { RemoteRuntimeError, toRemoteRuntimeError } from './errors.js';

/**
 * The SFOA Attachment Ingress HTTP endpoint.
 *
 * This is deliberately NOT an MCP endpoint. It is the inbound half of the Attachment
 * Bridge: a channel (WeCom behind OpenClaw today) posts the bytes it received, gets back
 * an opaque `att_…` reference, and the Agent later passes that reference to
 * `upload_files_to_record`. The Agent — and therefore the model — never sees the file.
 *
 * The body is the file itself (`application/octet-stream`), streamed straight into the
 * controlled staging root. It is never buffered, never decoded, and never parsed: the
 * only JSON on this surface is the small metadata response. Because the body is not
 * JSON, this route cannot reuse the MCP request-body reader and does not share its
 * error envelope — it answers with a plain JSON error object, not a JSON-RPC one.
 */

/** File metadata rides in headers, so no multipart parser and no in-memory buffer. */
export const ATTACHMENT_FILE_NAME_HEADER = 'x-sfoa-file-name';
export const ATTACHMENT_FILE_MIME_HEADER = 'x-sfoa-file-mime';
export const ATTACHMENT_SOURCE_CHANNEL_HEADER = 'x-sfoa-source-channel';

export const DEFAULT_SOURCE_CHANNEL = 'UNKNOWN';
const MAX_FILE_NAME_LENGTH = 512;
const MAX_MIME_LENGTH = 128;
const MAX_SOURCE_CHANNEL_LENGTH = 64;

/**
 * A syntactically well-formed media type. This is a *safety* check, not an acceptance
 * rule: the value is echoed into the Salesforce multipart part header, so a value
 * carrying CRLF or a quote would be a header-injection vector. Whether Salesforce
 * accepts the file's actual type is decided by Salesforce, and an unrecognised but
 * well-formed media type is passed through untouched.
 */
const MIME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/u;
const SOURCE_CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export type AttachmentIngressRouteOptions = Readonly<{
  request: IncomingMessage;
  response: ServerResponse;
  config: AttachmentRuntimeConfig;
  ingress: AttachmentIngress;
  identityProvider: IdentityProvider;
  platformIdentityHeaders: readonly string[];
  correlationId: string;
  logger: RuntimeLogger;
  isReady(): boolean;
  clientToken?: string;
  wecomClientToken?: string;
  redactionSecrets?: readonly string[];
}>;

/**
 * Handles one ingress request and always writes its own response.
 *
 * It never throws to the caller: the caller's error path renders an MCP JSON-RPC error
 * envelope, which a non-MCP client would not be able to read. Every terminal state here
 * — including a rejected one — is a small plain JSON object with an HTTP status.
 */
export async function handleAttachmentIngressRequest(
  options: AttachmentIngressRouteOptions,
): Promise<void> {
  const started = performance.now();
  let platformUserId: string | undefined;
  let fileName: string | undefined;
  let byteSize: number | undefined;
  let sourceChannel: string | undefined;
  try {
    if (options.request.method !== 'POST') {
      // A GET here is a capability probe, not a request for a file: no download surface
      // exists in v1, so it is answered 405 without an audit ERROR row.
      writeAttachmentJson(options.response, 405, {
        errorCode: 'MCP_ATTACHMENT_INPUT_INVALID',
        message: 'Only POST is allowed for the Attachment Ingress endpoint.',
      });
      return;
    }
    if (!options.isReady()) {
      throw new RemoteRuntimeError(
        'MCP_RUNTIME_NOT_READY',
        'The runtime is not ready to accept inbound attachments.',
      );
    }
    assertOctetStream(options.request);
    fileName = readFileName(options.request);
    const mimeType = readMimeType(options.request);
    sourceChannel = readSourceChannel(options.request);
    const declaredLength = readDeclaredLength(options.request, options.config.maxFileBytes);

    const principal = await authenticateIngressRequest(options);
    platformUserId = principal.platformUserId;
    if (declaredLength !== undefined) byteSize = declaredLength;

    const staged = await options.ingress.stage({
      platformUserId: principal.platformUserId,
      sourceChannel,
      runId: readRunId(options.request),
      fileName,
      mimeType,
      body: options.request,
    });

    await logIngress(options, {
      result: 'PASS',
      durationMs: elapsed(started),
      platformUserId: principal.platformUserId,
      identitySource: principal.identitySource,
      ...(principal.credentialId ? { identityCredentialId: principal.credentialId } : {}),
      eventType: 'ATTACHMENT_STAGED',
      requestSummary: {
        fileName: staged.fileName,
        mimeType: staged.mimeType,
        byteSize: staged.byteSize,
        contentSha256: staged.contentSha256,
        sourceChannel,
        attachmentRef: staged.attachmentRef,
        expiresAt: staged.expiresAt,
      },
    });
    writeAttachmentJson(options.response, 201, {
      attachmentRef: staged.attachmentRef,
      fileName: staged.fileName,
      mimeType: staged.mimeType,
      byteSize: staged.byteSize,
      contentSha256: staged.contentSha256,
      expiresAt: staged.expiresAt,
    });
    return;
  } catch (error) {
    // The body may still be arriving; drain it so the connection can be reused rather
    // than left half-read.
    options.request.resume();
    const normalized = normalizeIngressError(error, options.correlationId);
    await logIngress(options, {
      result: 'ERROR',
      durationMs: elapsed(started),
      ...(platformUserId ? { platformUserId } : {}),
      eventType: 'ATTACHMENT_STAGING_FAILED',
      errorCode: normalized.code,
      // The file name and size are the facts an operator needs; the staged path, the
      // bytes and the digest of a file that was never stored are not recorded.
      requestSummary: {
        ...(fileName ? { fileName } : {}),
        ...(byteSize !== undefined ? { byteSize } : {}),
        ...(sourceChannel ? { sourceChannel } : {}),
        reason: normalized.message.slice(0, 512),
      },
    }).catch(() => undefined);
    writeAttachmentJson(options.response, attachmentErrorStatus(normalized), {
      errorCode: normalized.code,
      message: normalized.message,
      correlationId: options.correlationId,
    });
  }
}

/**
 * Resolves the requesting platform user through the same credential chain the MCP
 * endpoint uses, so a channel credential and header identity behave identically on both
 * surfaces and there is no second identity vocabulary to keep in sync.
 */
async function authenticateIngressRequest(
  options: AttachmentIngressRouteOptions,
): Promise<Readonly<{ platformUserId: string; identitySource: IdentitySource; credentialId?: string }>> {
  const headers = toDistinctHeaders(options.request);
  const credential = await options.identityProvider.authenticateCredential?.(
    headers,
    options.correlationId,
  );
  if (credential && options.identityProvider.resolvePrincipal) {
    const principal = await options.identityProvider.resolvePrincipal(
      credential,
      headers,
      options.platformIdentityHeaders,
      options.correlationId,
    );
    return {
      platformUserId: principal.platformUserId,
      identitySource: principal.identitySource,
      ...(principal.credentialId ? { credentialId: principal.credentialId } : {}),
    };
  }
  const principal = await options.identityProvider.authenticate(
    headers,
    options.platformIdentityHeaders,
    options.correlationId,
  );
  return {
    platformUserId: principal.platformUserId,
    identitySource: principal.identitySource,
    ...(principal.credentialId ? { credentialId: principal.credentialId } : {}),
  };
}

async function logIngress(
  options: AttachmentIngressRouteOptions,
  input: Readonly<{
    result: 'PASS' | 'ERROR';
    durationMs: number;
    platformUserId?: string;
    identitySource?: IdentitySource;
    identityCredentialId?: string;
    eventType: string;
    errorCode?: string;
    requestSummary: Readonly<Record<string, unknown>>;
  }>,
): Promise<void> {
  await Promise.resolve(options.logger.log({
    correlationId: options.correlationId,
    ...(input.platformUserId ? { platformUserId: input.platformUserId } : {}),
    ...(input.identitySource ? { identitySource: input.identitySource } : {}),
    ...(input.identityCredentialId ? { identityCredentialId: input.identityCredentialId } : {}),
    toolName: 'upload_files_to_record',
    operation: 'ATTACHMENT_INGRESS',
    durationMs: input.durationMs,
    result: input.result,
    outcome: input.result === 'PASS' ? 'SUCCESS' : 'FAILED',
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    requestSummary: input.requestSummary,
    auditEvent: {
      eventCategory: 'INTERNAL',
      eventType: input.eventType,
      eventName: 'SFOA Attachment Ingress',
      terminalSource: 'REQUEST',
    },
  })).catch(() => undefined);
}

type TrustedRequestIdentitySource = 'INTERNAL_SERVICE_HEADER' | 'USER_BOUND_TOKEN' | 'BUNTU_TOKEN' | 'WECOM_HEADER';

function assertOctetStream(request: IncomingMessage): void {
  const value = request.headers['content-type'];
  const contentType = Array.isArray(value) ? undefined : value?.split(';', 1)[0]?.trim().toLocaleLowerCase('en-US');
  if (contentType !== 'application/octet-stream') {
    throw new RemoteRuntimeError(
      'MCP_ATTACHMENT_INPUT_INVALID',
      'Content-Type must be application/octet-stream; the file bytes are the request body.',
    );
  }
}

function readFileName(request: IncomingMessage): string {
  const raw = singleHeader(request, ATTACHMENT_FILE_NAME_HEADER);
  if (raw === undefined || raw.trim().length === 0) {
    throw new RemoteRuntimeError(
      'MCP_ATTACHMENT_INPUT_INVALID',
      `${ATTACHMENT_FILE_NAME_HEADER} is required and must be the percent-encoded file name.`,
    );
  }
  if (raw.length > MAX_FILE_NAME_LENGTH) {
    throw new RemoteRuntimeError('MCP_ATTACHMENT_INPUT_INVALID', `${ATTACHMENT_FILE_NAME_HEADER} is too long.`);
  }
  let decoded: string;
  try {
    // Percent-encoding is the only way to carry a non-ASCII file name through a header
    // without depending on how any hop in between treats raw bytes.
    decoded = decodeURIComponent(raw);
  } catch {
    throw new RemoteRuntimeError(
      'MCP_ATTACHMENT_INPUT_INVALID',
      `${ATTACHMENT_FILE_NAME_HEADER} must be percent-encoded UTF-8.`,
    );
  }
  if (decoded.trim().length === 0) {
    throw new RemoteRuntimeError('MCP_ATTACHMENT_INPUT_INVALID', 'The file name must not be blank.');
  }
  return decoded;
}

function readMimeType(request: IncomingMessage): string | null {
  const raw = singleHeader(request, ATTACHMENT_FILE_MIME_HEADER);
  if (raw === undefined || raw.trim().length === 0) return null;
  const candidate = raw.trim().slice(0, MAX_MIME_LENGTH);
  if (!MIME_PATTERN.test(candidate)) {
    throw new RemoteRuntimeError(
      'MCP_ATTACHMENT_INPUT_INVALID',
      `${ATTACHMENT_FILE_MIME_HEADER} must be a well-formed media type.`,
    );
  }
  return candidate;
}

function readSourceChannel(request: IncomingMessage): string {
  const raw = singleHeader(request, ATTACHMENT_SOURCE_CHANNEL_HEADER);
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_SOURCE_CHANNEL;
  const candidate = raw.trim().slice(0, MAX_SOURCE_CHANNEL_LENGTH);
  if (!SOURCE_CHANNEL_PATTERN.test(candidate)) {
    throw new RemoteRuntimeError(
      'MCP_ATTACHMENT_INPUT_INVALID',
      `${ATTACHMENT_SOURCE_CHANNEL_HEADER} must be a short channel label.`,
    );
  }
  return candidate;
}

function readRunId(request: IncomingMessage): string | null {
  const raw = singleHeader(request, 'x-external-run-id');
  return raw && raw.trim().length > 0 ? raw.trim().slice(0, 128) : null;
}

/**
 * Rejects an oversized upload before a single byte is read. The ingress meters the body
 * as it streams as well, so a client that understates `Content-Length` gains nothing —
 * this only avoids the cost of receiving a file that is already known to be too large.
 */
function readDeclaredLength(request: IncomingMessage, maxFileBytes: number): number | undefined {
  const raw = request.headers['content-length'];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw) || !/^\d+$/u.test(raw)) {
    throw new RemoteRuntimeError('MCP_ATTACHMENT_INPUT_INVALID', 'Content-Length must be one non-negative integer.');
  }
  const declared = Number(raw);
  if (declared === 0) {
    throw new RemoteRuntimeError('MCP_ATTACHMENT_INPUT_INVALID', 'The attachment is empty.');
  }
  if (declared > maxFileBytes) {
    throw new RemoteRuntimeError(
      'MCP_ATTACHMENT_TOO_LARGE',
      `The attachment exceeds the ${maxFileBytes}-byte staging ceiling.`,
    );
  }
  return declared;
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headersDistinct[name];
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > 1) {
    // A repeated metadata header is ambiguous: two file names cannot both be the file's
    // name, so the request is refused rather than resolved by picking one.
    throw new RemoteRuntimeError('MCP_ATTACHMENT_INPUT_INVALID', `${name} must not be repeated.`);
  }
  return value[0];
}

function toDistinctHeaders(request: IncomingMessage): RequestHeaders {
  const output: Record<string, string | readonly string[]> = {};
  for (const [name, values] of Object.entries(request.headersDistinct)) {
    if (values === undefined || values.length === 0) continue;
    const lower = name.toLocaleLowerCase('en-US');
    output[lower] = values.length === 1 ? values[0]! : Object.freeze([...values]);
  }
  return output;
}

function normalizeIngressError(error: unknown, correlationId: string): Readonly<{ code: string; message: string }> {
  if (error instanceof IdentityRuntimeError) {
    return { code: error.code, message: error.message.slice(0, 512) };
  }
  const normalized = error instanceof RemoteRuntimeError
    ? error
    : toRemoteRuntimeError(
        error,
        'MCP_ATTACHMENT_STAGING_FAILED',
        'The attachment could not be staged.',
        correlationId,
      );
  return { code: normalized.code, message: normalized.message.slice(0, 512) };
}

function attachmentErrorStatus(error: Readonly<{ code: string }>): number {
  switch (error.code) {
    case 'MCP_CLIENT_AUTH_REQUIRED':
    case 'MCP_CLIENT_AUTH_INVALID':
    case 'MCP_IDENTITY_CREDENTIAL_INVALID':
    case 'MCP_IDENTITY_CREDENTIAL_REVOKED':
    case 'MCP_PLATFORM_USER_REQUIRED':
    case 'MCP_BUNTU_TOKEN_INVALID':
      return 401;
    case 'MCP_IDENTITY_ROUTE_DISABLED':
    case 'MCP_IDENTITY_CHANNEL_MISMATCH':
    case 'MCP_PLATFORM_IDENTITY_CONFLICT':
      return 403;
    case 'MCP_ATTACHMENT_INPUT_INVALID':
      return 400;
    case 'MCP_ATTACHMENT_TOO_LARGE':
      return 413;
    case 'MCP_RUNTIME_NOT_READY':
      return 503;
    default:
      return 500;
  }
}

function writeAttachmentJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

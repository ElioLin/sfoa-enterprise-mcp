import { createHash } from 'node:crypto';
import { platformUserIdSchema } from '@sfoa/control-plane';
import { z } from 'zod';

/**
 * Buntu (Xiaoben / Dify) per-user token validation.
 *
 * The MCP runtime never interprets a Buntu bearer token itself. It forwards the
 * raw token to the configured Buntu validate-token endpoint and only accepts a
 * bounded, strict `{ user_id }` contract from that trusted upstream.
 *
 * Error classification is stable and fail-closed:
 * - `MCP_BUNTU_TOKEN_INVALID`            401/403, HTTP success without user_id;
 * - `MCP_BUNTU_IDENTITY_UNAVAILABLE`     timeout, DNS/TCP/TLS failure, 5xx, other non-2xx;
 * - `MCP_BUNTU_IDENTITY_RESPONSE_INVALID` invalid JSON, oversized body, wrong user_id type/format.
 */

export type BuntuValidationErrorCode =
  | 'MCP_BUNTU_TOKEN_INVALID'
  | 'MCP_BUNTU_IDENTITY_UNAVAILABLE'
  | 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID';

export const BUNTU_MAX_RESPONSE_BYTES = 65_536;

export type BuntuValidationResult = Readonly<{
  valid: boolean;
  userId?: string;
  /** Absent when no HTTP response was received (for example timeout or DNS failure). */
  httpStatus?: number;
  durationMs: number;
  validatedAt: string;
  errorCode?: BuntuValidationErrorCode;
}>;

export interface BuntuTokenValidator {
  validate(rawToken: string, correlationId: string): Promise<BuntuValidationResult>;
}

export type BuntuValidatorOptions = Readonly<{
  validateTokenUrl: string;
  timeoutMs: number;
}>;

/** Accepts an object carrying `user_id`; extra upstream fields are tolerated but never surfaced. */
const buntuValidateResponseSchema = z.object({ user_id: z.string() });

export class HttpBuntuTokenValidator implements BuntuTokenValidator {
  public constructor(private readonly options: BuntuValidatorOptions) {}

  public async validate(rawToken: string, correlationId: string): Promise<BuntuValidationResult> {
    const startedAt = Date.now();
    const validatedAt = new Date().toISOString();
    let httpStatus: number | undefined;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      let bodyText: string;
      try {
        const response = await fetch(this.options.validateTokenUrl, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${rawToken}`,
          },
          signal: controller.signal,
          redirect: 'manual',
        });
        httpStatus = response.status;
        bodyText = await readBoundedResponseBody(response, BUNTU_MAX_RESPONSE_BYTES);
      } finally {
        clearTimeout(timeout);
      }
      const durationMs = Date.now() - startedAt;

      if (httpStatus === 401 || httpStatus === 403) {
        return buntuFailure('MCP_BUNTU_TOKEN_INVALID', { httpStatus, durationMs, validatedAt });
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        return buntuFailure('MCP_BUNTU_IDENTITY_UNAVAILABLE', { httpStatus, durationMs, validatedAt });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        return buntuFailure('MCP_BUNTU_IDENTITY_RESPONSE_INVALID', { httpStatus, durationMs, validatedAt });
      }

      const contract = buntuValidateResponseSchema.safeParse(parsed);
      if (!contract.success) {
        // A valid JSON object that simply lacks user_id means the token was not accepted.
        const missingUserId = isPlainObject(parsed) && !('user_id' in parsed);
        return buntuFailure(
          missingUserId ? 'MCP_BUNTU_TOKEN_INVALID' : 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID',
          { httpStatus, durationMs, validatedAt },
        );
      }

      const parsedUserId = platformUserIdSchema.safeParse(contract.data.user_id);
      if (!parsedUserId.success) {
        return buntuFailure('MCP_BUNTU_IDENTITY_RESPONSE_INVALID', { httpStatus, durationMs, validatedAt });
      }

      return Object.freeze({
        valid: true,
        userId: parsedUserId.data,
        httpStatus,
        durationMs,
        validatedAt,
      });
    } catch (error) {
      // Oversized responses are an invalid response contract; everything else
      // (timeout via AbortError, DNS/TCP/TLS failures) is provider unavailability.
      // The httpStatus stays absent when no HTTP response was received.
      const code = error instanceof BuntuResponseTooLargeError
        ? 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID'
        : 'MCP_BUNTU_IDENTITY_UNAVAILABLE';
      return buntuFailure(code, { httpStatus, durationMs: Date.now() - startedAt, validatedAt });
    }
  }
}

export function buntuTokenFingerprint(rawToken: string): string {
  return `sha256:${createHash('sha256').update(rawToken, 'utf8').digest('hex')}`;
}

export function buntuTokenLast4(rawToken: string): string {
  return rawToken.slice(-4);
}

function buntuFailure(
  errorCode: BuntuValidationErrorCode,
  details: Readonly<{ httpStatus?: number; durationMs: number; validatedAt: string }>,
): BuntuValidationResult {
  return Object.freeze({
    valid: false,
    errorCode,
    ...(details.httpStatus !== undefined ? { httpStatus: details.httpStatus } : {}),
    durationMs: details.durationMs,
    validatedAt: details.validatedAt,
  });
}

class BuntuResponseTooLargeError extends Error {
  public constructor() {
    super('The Buntu validate-token response exceeded the bounded response limit.');
    this.name = 'BuntuResponseTooLargeError';
  }
}

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw new BuntuResponseTooLargeError();
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BuntuResponseTooLargeError();
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

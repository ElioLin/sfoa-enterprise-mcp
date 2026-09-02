import { createHash } from 'node:crypto';
import { platformUserIdSchema } from '@sfoa/control-plane';
import { z } from 'zod';

/**
 * Buntu (Xiaoben / Dify) per-user token validation.
 *
 * The MCP runtime never interprets a Buntu bearer token itself. It forwards the
 * raw token to the configured Buntu validate-token endpoint and only accepts
 * the confirmed upstream contract (verified against the real Buntu service):
 *
 *   HTTP 200
 *   {
 *     "success": true,
 *     "data": {
 *       "userId": "<platform user id>",
 *       "userName": "...",   // display-only, never used for identity routing
 *       "expiresAt": ...     // ignored; validate-token is the identity authority
 *     }
 *   }
 *
 * Only `success` and `data.userId` participate in identity decisions. The
 * upstream `userName` is display metadata and must never be mapped to a
 * Salesforce username; `data.expiresAt` is surfaced as `expiresAtSeconds`
 * solely as the cache-reuse boundary for the request-scoped in-memory token
 * validation cache — it is never used to build a second token-expiry rule at
 * request time (validate-token remains the identity authority). No recursive
 * search for `userId`, `user_id`, `id`, or `username` is performed anywhere in
 * the response.
 *
 * Error classification is stable and fail-closed:
 * - `MCP_BUNTU_TOKEN_INVALID`            401/403, or HTTP 2xx with `success: false`;
 * - `MCP_BUNTU_IDENTITY_UNAVAILABLE`     timeout, DNS/TCP/TLS failure, 5xx, other non-2xx;
 * - `MCP_BUNTU_IDENTITY_RESPONSE_INVALID` invalid JSON, oversized body, missing
 *   `data`/`data.userId`, or a `userId` that is not a string / safe integer.
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
  /** Upstream `success` field, present only when a parseable 2xx business response was received. */
  upstreamSuccess?: boolean;
  /** Original JSON primitive type of `data.userId`, present only on success. */
  userIdType?: 'string' | 'number';
  /**
   * Upstream token expiry (`data.expiresAt`, epoch seconds), present only when
   * the upstream returned it. Used solely as the cache-reuse boundary by the
   * in-memory validation cache; never enforced as a second request-time expiry
   * rule.
   */
  expiresAtSeconds?: number;
}>;

export interface BuntuTokenValidator {
  validate(rawToken: string, correlationId: string): Promise<BuntuValidationResult>;
}

export type BuntuValidatorOptions = Readonly<{
  validateTokenUrl: string;
  timeoutMs: number;
}>;

/**
 * Confirmed Buntu validate-token response contract (P6-ID-02 HOTFIX02).
 *
 * The real service returns `success: true` with the platform identity nested
 * under `data.userId`; `data.userName` and `data.expiresAt` are tolerated extra
 * fields, with `data.expiresAt` captured (optional) so the validation cache can
 * reuse a validated identity only until the token's own declared expiry.
 * `data.userName` is stripped by Zod and never participates in identity
 * decisions. Only a `string` or a safe integer `number` is
 * accepted for `userId`. Floats, NaN, Infinity, booleans, objects, arrays, null,
 * and the empty string are rejected. A numeric userId is normalized with
 * `String(...)` and then validated by the shared `platformUserIdSchema`; no
 * Buntu-specific user id rules are invented here.
 *
 * The previous `{ user_id }` assumption was wrong: the real contract uses
 * `data.userId` (camelCase, nested), so no compatibility parsing of `user_id`
 * is retained.
 */
const buntuUserIdSchema = z.union([
  z.string().min(1),
  z.number().refine((value) => Number.isSafeInteger(value)),
]);
const buntuValidateResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    userId: buntuUserIdSchema,
    expiresAt: z.number().optional(),
  }),
});

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
        // Classify strictly by the confirmed contract, never by scanning for
        // arbitrary id fields:
        // - HTTP 2xx with `success: false` is a normal upstream business
        //   decision (the token was not accepted) -> MCP_BUNTU_TOKEN_INVALID;
        // - any other broken envelope (`success: true` without `data` /
        //   `data.userId`, missing success, non-object JSON, wrong userId
        //   type/format) is a response contract error -> RESPONSE_INVALID.
        const upstreamRejected = isPlainObject(parsed) && parsed.success === false;
        return buntuFailure(
          upstreamRejected ? 'MCP_BUNTU_TOKEN_INVALID' : 'MCP_BUNTU_IDENTITY_RESPONSE_INVALID',
          { httpStatus, durationMs, validatedAt, upstreamSuccess: upstreamRejected ? false : undefined },
        );
      }

      const rawUserId = contract.data.data.userId;
      const candidateUserId = typeof rawUserId === 'number' ? String(rawUserId) : rawUserId;
      const parsedUserId = platformUserIdSchema.safeParse(candidateUserId);
      if (!parsedUserId.success) {
        return buntuFailure('MCP_BUNTU_IDENTITY_RESPONSE_INVALID', { httpStatus, durationMs, validatedAt });
      }

      const expiresAt = contract.data.data.expiresAt;
      return Object.freeze({
        valid: true,
        userId: parsedUserId.data,
        httpStatus,
        durationMs,
        validatedAt,
        upstreamSuccess: true,
        userIdType: typeof rawUserId === 'number' ? 'number' : 'string',
        ...(expiresAt === undefined ? {} : { expiresAtSeconds: expiresAt }),
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
  details: Readonly<{
    httpStatus?: number;
    durationMs: number;
    validatedAt: string;
    /** Upstream `success` field when a parseable 2xx business response was received. */
    upstreamSuccess?: boolean;
  }>,
): BuntuValidationResult {
  return Object.freeze({
    valid: false,
    errorCode,
    ...(details.httpStatus !== undefined ? { httpStatus: details.httpStatus } : {}),
    ...(details.upstreamSuccess !== undefined ? { upstreamSuccess: details.upstreamSuccess } : {}),
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

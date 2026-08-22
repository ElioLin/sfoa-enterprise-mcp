import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { IdentityRuntimeError } from './errors.js';

export type RequestHeaderValue = string | readonly string[] | undefined;
export type RequestHeaders = Readonly<Record<string, RequestHeaderValue>>;

export type TrustedRequestIdentity = Readonly<{
  platformUserId: string;
  correlationId: string;
}>;

export type RequestContext = Readonly<{
  platformUserId: string;
  correlationId: string;
  workspaceRoot: string;
}>;

const platformUserIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !/[\u0000-\u001F\u007F]/u.test(value), 'must not contain control characters');

const correlationIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);

export function parseTrustedRequestHeaders(
  headers: RequestHeaders,
  uuidFactory: () => string = randomUUID,
): TrustedRequestIdentity {
  const correlationHeader = getSingleHeader(headers, 'x-correlation-id');
  const correlationResult = correlationIdSchema.safeParse(correlationHeader);
  const correlationId = correlationResult.success ? correlationResult.data : uuidFactory();

  const platformHeader = getSingleHeader(headers, 'x-platform-user-id');
  if (platformHeader === undefined || platformHeader.trim().length === 0) {
    throw new IdentityRuntimeError(
      'MCP_PLATFORM_USER_REQUIRED',
      'X-Platform-User-Id is required and must identify the trusted platform user.',
      { correlationId },
    );
  }

  const parsedPlatformUserId = platformUserIdSchema.safeParse(platformHeader);
  if (!parsedPlatformUserId.success) {
    throw new IdentityRuntimeError(
      'MCP_REQUEST_SCOPE_FAILED',
      'X-Platform-User-Id is invalid; use 1-128 printable characters.',
      { correlationId },
    );
  }

  return Object.freeze({
    platformUserId: parsedPlatformUserId.data,
    correlationId,
  });
}

export function createRequestContext(identity: TrustedRequestIdentity, workspaceRoot: string): RequestContext {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  if (!path.isAbsolute(resolvedWorkspaceRoot)) {
    throw new IdentityRuntimeError('MCP_REQUEST_WORKSPACE_FAILED', 'Request workspace must be an absolute path.', {
      correlationId: identity.correlationId,
    });
  }
  return Object.freeze({ ...identity, workspaceRoot: resolvedWorkspaceRoot });
}

function getSingleHeader(headers: RequestHeaders, targetName: string): string | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLocaleLowerCase('en-US') === targetName);
  const value = entry?.[1];
  if (typeof value === 'string' || value === undefined) return value;
  return value.length === 1 ? value[0] : undefined;
}

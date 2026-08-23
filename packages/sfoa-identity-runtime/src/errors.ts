import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const IDENTITY_ERROR_CODES = [
  'MCP_PLATFORM_USER_REQUIRED',
  'MCP_IDENTITY_ROUTE_NOT_FOUND',
  'MCP_IDENTITY_CONTEXT_MISMATCH',
  'MCP_SALESFORCE_AUTH_FAILED',
  'MCP_SALESFORCE_CONNECTION_FAILED',
  'MCP_REQUEST_WORKSPACE_FAILED',
  'MCP_REQUEST_SCOPE_FAILED',
  'MCP_CONNECTION_ROLE_NOT_AVAILABLE',
] as const;

export type IdentityErrorCode = (typeof IDENTITY_ERROR_CODES)[number];

export class IdentityRuntimeError extends Error {
  public constructor(
    public readonly code: IdentityErrorCode,
    message: string,
    options: { cause?: unknown; correlationId?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'IdentityRuntimeError';
    this.correlationId = options.correlationId;
  }

  public readonly correlationId: string | undefined;
}

export function withCorrelation(error: IdentityRuntimeError, correlationId: string): IdentityRuntimeError {
  if (error.correlationId) return error;
  return new IdentityRuntimeError(error.code, error.message, { cause: error.cause, correlationId });
}

export function toIdentityRuntimeError(
  error: unknown,
  fallbackCode: IdentityErrorCode,
  fallbackMessage: string,
  correlationId?: string,
): IdentityRuntimeError {
  if (error instanceof IdentityRuntimeError) {
    return correlationId ? withCorrelation(error, correlationId) : error;
  }
  return new IdentityRuntimeError(fallbackCode, fallbackMessage, { cause: error, correlationId });
}

export function redactSensitiveText(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  const orderedSecrets = [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );

  for (const secret of orderedSecrets) redacted = redacted.split(secret).join('<redacted>');

  return redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=!-]+/giu, 'Bearer <redacted>')
    .replace(/\b00D[A-Za-z0-9]{9,}![A-Za-z0-9._-]+\b/gu, '<redacted-access-token>')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '<redacted-jwt>')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '<redacted-private-key>');
}

export function formatRuntimeError(
  error: IdentityRuntimeError,
  secrets: readonly string[] = [],
  correlationId = error.correlationId,
): string {
  const suffix = correlationId ? ` Correlation ID: ${correlationId}.` : '';
  return `[${error.code}] ${redactSensitiveText(error.message, secrets)}${suffix}`;
}

export function runtimeErrorToolResult(
  error: IdentityRuntimeError,
  secrets: readonly string[] = [],
  correlationId = error.correlationId,
): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: formatRuntimeError(error, secrets, correlationId) }],
  };
}

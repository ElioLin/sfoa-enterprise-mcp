import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { redactSensitiveText } from '@sfoa/identity-runtime';

export const REMOTE_RUNTIME_ERROR_CODES = [
  'MCP_CLIENT_AUTH_REQUIRED',
  'MCP_CLIENT_AUTH_INVALID',
  'MCP_IDENTITY_CREDENTIAL_INVALID',
  'MCP_IDENTITY_CREDENTIAL_REVOKED',
  'MCP_IDENTITY_ROUTE_DISABLED',
  'MCP_BUNTU_TOKEN_INVALID',
  'MCP_BUNTU_IDENTITY_UNAVAILABLE',
  'MCP_BUNTU_IDENTITY_RESPONSE_INVALID',
  'MCP_TOOL_DISABLED',
  'MCP_TOOL_NOT_AVAILABLE',
  'MCP_REQUEST_TOO_LARGE',
  'MCP_REQUEST_TIMEOUT',
  'MCP_TOOL_TIMEOUT',
  'MCP_DML_OUTCOME_UNKNOWN',
  'MCP_DML_CONFIGURATION_INVALID',
  'MCP_DIAGNOSTIC_CONFIGURATION_INVALID',
  'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED',
  'MCP_RUNTIME_NOT_READY',
  'MCP_RUNTIME_CONTROL_PLANE_UNAVAILABLE',
  'MCP_RUNTIME_CONFIGURATION_INVALID',
  'MCP_PROVIDER_INITIALIZATION_FAILED',
  'MCP_UPSTREAM_TOOL_CONTRACT_DRIFT',
  'MCP_HOST_NOT_ALLOWED',
  'MCP_ORIGIN_NOT_ALLOWED',
  'MCP_REQUEST_INVALID',
  'MCP_REQUEST_CLEANUP_FAILED',
  'MCP_TRUSTED_INSTANCE_URL_INVALID',
] as const;

export type RemoteRuntimeErrorCode = (typeof REMOTE_RUNTIME_ERROR_CODES)[number];

export class RemoteRuntimeError extends Error {
  public readonly correlationId: string | undefined;

  public constructor(
    public readonly code: RemoteRuntimeErrorCode,
    message: string,
    options: { cause?: unknown; correlationId?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RemoteRuntimeError';
    this.correlationId = options.correlationId;
  }
}

export function withRemoteCorrelation(error: RemoteRuntimeError, correlationId: string): RemoteRuntimeError {
  if (error.correlationId) return error;
  return new RemoteRuntimeError(error.code, error.message, { cause: error.cause, correlationId });
}

export function toRemoteRuntimeError(
  error: unknown,
  fallbackCode: RemoteRuntimeErrorCode,
  fallbackMessage: string,
  correlationId?: string,
): RemoteRuntimeError {
  if (error instanceof RemoteRuntimeError) {
    return correlationId ? withRemoteCorrelation(error, correlationId) : error;
  }
  return new RemoteRuntimeError(fallbackCode, fallbackMessage, { cause: error, correlationId });
}

export function formatRemoteRuntimeError(
  error: RemoteRuntimeError,
  secrets: readonly string[] = [],
  correlationId = error.correlationId,
): string {
  const suffix = correlationId ? ` Correlation ID: ${correlationId}.` : '';
  return `[${error.code}] ${redactSensitiveText(error.message, secrets)}${suffix}`;
}

export function remoteRuntimeErrorToolResult(
  error: RemoteRuntimeError,
  secrets: readonly string[] = [],
  correlationId = error.correlationId,
): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: formatRemoteRuntimeError(error, secrets, correlationId) }],
  };
}

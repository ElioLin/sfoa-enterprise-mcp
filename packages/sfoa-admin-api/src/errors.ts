import { ZodError } from 'zod';
import { ControlPlaneError } from '@sfoa/control-plane';
import { IdentityRuntimeError, redactSensitiveText } from '@sfoa/identity-runtime';
import { RemoteRuntimeError } from '@sfoa/mcp-server';

export class AdminHttpError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly issues?: readonly Readonly<{ path: string; message: string }>[],
  ) {
    super(message);
    this.name = 'AdminHttpError';
  }
}

export function invalidAdminInput(error: ZodError): AdminHttpError {
  return new AdminHttpError(
    'MCP_ADMIN_INPUT_INVALID',
    'The Admin request did not match the strict API contract.',
    400,
    Object.freeze(error.issues.slice(0, 20).map((issue) => Object.freeze({
      path: issue.path.join('.'),
      message: issue.message,
    }))),
  );
}

export function mapAdminError(error: unknown, secrets: readonly string[]): AdminHttpError {
  if (error instanceof AdminHttpError) return error;
  if (error instanceof ZodError) return invalidAdminInput(error);
  if (error instanceof ControlPlaneError) {
    const status = error.code === 'MCP_CONTROL_PLANE_NOT_FOUND'
      ? 404
      : error.code === 'MCP_ADMIN_CONCURRENT_MODIFICATION' || error.code === 'MCP_CONTROL_PLANE_CONFLICT'
        ? 409
        : error.code === 'MCP_ADMIN_INPUT_INVALID' || error.code === 'MCP_CONTROL_PLANE_CONFIGURATION_INVALID'
          ? 400
          : 503;
    return new AdminHttpError(error.code, redactSensitiveText(error.message, secrets), status);
  }
  if (error instanceof IdentityRuntimeError || error instanceof RemoteRuntimeError) {
    return new AdminHttpError(error.code, redactSensitiveText(error.message, secrets), 502);
  }
  return new AdminHttpError(
    'MCP_ADMIN_INTERNAL_ERROR',
    'The Admin API could not complete the request. Use the correlation ID to inspect server-side logs.',
    500,
  );
}

export function safeVerificationError(
  error: unknown,
  secrets: readonly string[],
): Readonly<{ code: string; message: string }> {
  if (error instanceof ControlPlaneError || error instanceof IdentityRuntimeError || error instanceof RemoteRuntimeError) {
    return Object.freeze({ code: error.code, message: redactSensitiveText(error.message, secrets).slice(0, 1_000) });
  }
  return Object.freeze({
    code: 'MCP_ADMIN_VERIFICATION_FAILED',
    message: 'Salesforce verification failed. Inspect server-side logs using the correlation ID.',
  });
}

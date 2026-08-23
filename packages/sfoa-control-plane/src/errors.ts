export type ControlPlaneErrorCode =
  | 'MCP_RUNTIME_CONTROL_PLANE_UNAVAILABLE'
  | 'MCP_CONTROL_PLANE_CONFIGURATION_INVALID'
  | 'MCP_CONTROL_PLANE_CONFLICT'
  | 'MCP_CONTROL_PLANE_NOT_FOUND'
  | 'MCP_ADMIN_CONCURRENT_MODIFICATION'
  | 'MCP_ADMIN_INPUT_INVALID'
  | 'MCP_ADMIN_AUDIT_FAILED';

export class ControlPlaneError extends Error {
  public constructor(
    public readonly code: ControlPlaneErrorCode,
    message: string,
    options: Readonly<{ cause?: unknown }> = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ControlPlaneError';
  }
}

export function toControlPlaneError(error: unknown): ControlPlaneError {
  if (error instanceof ControlPlaneError) return error;
  return new ControlPlaneError(
    'MCP_RUNTIME_CONTROL_PLANE_UNAVAILABLE',
    'The SFoA Control Plane is unavailable. MySQL mode fails closed and does not fall back to environment policy.',
    { cause: error },
  );
}

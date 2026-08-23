export const CONTEXT_ERROR_CODES = [
  'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED',
  'MCP_DIAGNOSTIC_QUERY_FAILED',
  'MCP_RECORD_ACTION_CONTEXT_INVALID',
  'MCP_RECORD_ACTION_CONTEXT_UNSUPPORTED',
  'MCP_RECORD_TYPE_NOT_AVAILABLE',
  'MCP_METADATA_CONTEXT_TOO_LARGE',
  'MCP_METADATA_CONTEXT_FAILED',
] as const;

export type ContextErrorCode = (typeof CONTEXT_ERROR_CODES)[number];

export class ContextRuntimeError extends Error {
  public constructor(
    public readonly code: ContextErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ContextRuntimeError';
  }
}

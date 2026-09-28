export const CONTEXT_ERROR_CODES = [
  'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED',
  'MCP_DIAGNOSTIC_QUERY_FAILED',
  'MCP_RECORD_ACTION_CONTEXT_INVALID',
  'MCP_RECORD_ACTION_CONTEXT_UNSUPPORTED',
  'MCP_RECORD_TYPE_NOT_AVAILABLE',
  'MCP_RECORD_DISPLAY_CONTEXT_INVALID',
  'MCP_RECORD_DISPLAY_CONTEXT_UNSUPPORTED',
  'MCP_METADATA_CONTEXT_TOO_LARGE',
  'MCP_METADATA_CONTEXT_FAILED',
  'MCP_LIMITS_READ_FAILED',
  'MCP_LIMITS_ACCESS_DENIED',
] as const;

export type ContextErrorCode = (typeof CONTEXT_ERROR_CODES)[number];

export class ContextRuntimeError extends Error {
  /**
   * `suggestion` and `salesforceErrorCode` are optional and only `get_org_limits` sets them, so an
   * error raised by any other context Tool still renders as exactly `{success, errorCode, message}`.
   */
  public readonly suggestion?: string;
  public readonly salesforceErrorCode?: string;

  public constructor(
    public readonly code: ContextErrorCode,
    message: string,
    options: { cause?: unknown; suggestion?: string; salesforceErrorCode?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ContextRuntimeError';
    if (options.suggestion !== undefined) this.suggestion = options.suggestion;
    if (options.salesforceErrorCode !== undefined) this.salesforceErrorCode = options.salesforceErrorCode;
  }
}

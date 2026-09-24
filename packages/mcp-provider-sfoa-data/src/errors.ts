/**
 * Error codes owned by the P9 SFOA Data Provider. Every code is safe to show to an
 * MCP client: it names the failed capability and never carries Salesforce internals,
 * credentials, or stack traces.
 */
export const DATA_ERROR_CODES = [
  'MCP_DATA_INVALID_INPUT',
  'MCP_DATA_IDENTITY_UNAVAILABLE',
  'MCP_DATA_TOOL_NOT_ALLOWED',
  'MCP_DATA_RESPONSE_TOO_LARGE',
  'MCP_SOBJECT_LIST_FAILED',
  'MCP_SOBJECT_DESCRIBE_FAILED',
  'MCP_SOBJECT_NOT_FOUND',
  'MCP_SOBJECT_ACCESS_DENIED',
  'MCP_SOBJECT_NOT_IN_USE',
] as const;

export type DataErrorCode = (typeof DATA_ERROR_CODES)[number];

/**
 * A Data Tool failure that is expected, already sanitized, and safe to return as a
 * Tool result with `isError: true`. `suggestion` states the next safe action for the
 * Agent (for example "call describe_sobject first"), never a credential or a URL.
 */
export class DataRuntimeError extends Error {
  public readonly suggestion: string | undefined;

  public constructor(
    public readonly code: DataErrorCode,
    message: string,
    options: { cause?: unknown; suggestion?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DataRuntimeError';
    this.suggestion = options.suggestion;
  }
}

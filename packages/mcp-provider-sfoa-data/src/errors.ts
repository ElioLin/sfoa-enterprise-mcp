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
  'MCP_QUERY_RECORDS_FAILED',
  'MCP_QUERY_FIELD_INVALID',
  'MCP_QUERY_MALFORMED',
  'MCP_QUERY_LIMIT_EXCEEDED',
  'MCP_QUERY_ACCESS_DENIED',
  'MCP_SEARCH_RECORDS_FAILED',
  'MCP_SEARCH_MALFORMED',
  'MCP_SEARCH_FIELD_INVALID',
  'MCP_SEARCH_LIMIT_EXCEEDED',
  'MCP_SEARCH_ACCESS_DENIED',
  'MCP_BULK_SUBMIT_FAILED',
  'MCP_BULK_QUERY_INVALID',
  'MCP_BULK_MALFORMED',
  'MCP_BULK_LIMIT_EXCEEDED',
  'MCP_BULK_ACCESS_DENIED',
  'MCP_BULK_JOB_NOT_FOUND',
  /**
   * The job exists and belongs to this identity, but the platform ended it without a result
   * set. Distinct from `MCP_BULK_RESULTS_FAILED`, which means the job was fine and the read
   * of its results was not — an Agent's next step is the same in neither case.
   */
  'MCP_BULK_JOB_FAILED',
  'MCP_BULK_RESULTS_FAILED',
  /**
   * A single CSV row is wider than one whole response may be. Reported instead of returning a
   * partial page, because a partial page would have to either drop rows or hand back a cursor
   * that skips them.
   */
  'MCP_BULK_SLICE_TOO_LARGE',
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

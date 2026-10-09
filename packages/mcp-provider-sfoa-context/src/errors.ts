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
  // T2's debug-log Toolset. `MCP_DIAGNOSTIC_PREREQUISITE_MISSING` is the one ADR-0029 §3 makes a
  // contract across every P10 Tool: a source that could not be read fails with the identifier of the
  // deployment prerequisite that is missing, and never with a successful empty result.
  'MCP_DIAGNOSTIC_PREREQUISITE_MISSING',
  'MCP_DIAGNOSTIC_QUERY_OBJECT_NOT_ALLOWED',
  'MCP_TRACE_FLAG_INVALID',
  'MCP_TRACE_FLAG_WRITE_FAILED',
  'MCP_APEX_LOG_INVALID',
  'MCP_APEX_LOG_READ_FAILED',
  'MCP_DEBUG_LOG_BODY_INVALID',
  'MCP_DEBUG_LOG_BODY_READ_FAILED',
  'MCP_DEBUG_LOG_BODY_NOT_FOUND',
  // T3's permission-evidence Tool. `MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED` is the boundary rather than a
  // fault: it is raised when `targetUserId` names a Salesforce user this deployment has not configured
  // as an identity route, and it is deliberately indistinct from "no such user" so the Tool cannot be
  // used to probe which Ids exist.
  'MCP_FIELD_ACCESS_INVALID',
  'MCP_FIELD_ACCESS_READ_FAILED',
  'MCP_FIELD_ACCESS_TARGET_NOT_ALLOWED',
  // T4's metadata inventory. `MCP_METADATA_TYPE_UNAVAILABLE` is the ADR-0029 §3 contract applied to a
  // listing: a type this org's Metadata API will not serve fails as a named, structured answer rather
  // than as an empty component list, because an agent reads an empty list as "the org has none of these"
  // — the one conclusion that is certainly wrong when the listing itself never happened.
  'MCP_METADATA_LIST_FAILED',
  'MCP_METADATA_TYPE_UNAVAILABLE',
  // T5's platform-diagnostics aggregation. `MCP_PLATFORM_DIAGNOSTICS_READ_FAILED` is the *whole-call*
  // failure — the connection or the aggregation itself — and it is deliberately not the code a section's
  // degradation carries: a source that could not be read is a per-section `UNAVAILABLE` state inside a
  // successful result (ADR-0029 §3's aggregator clause), and only a failure of the call as a whole is an
  // error result. The section-level state reuses `MCP_DIAGNOSTIC_PREREQUISITE_MISSING`, which is the code
  // §3 declares for a missing prerequisite wherever it is raised.
  'MCP_PLATFORM_DIAGNOSTICS_READ_FAILED',
] as const;

export type ContextErrorCode = (typeof CONTEXT_ERROR_CODES)[number];

export class ContextRuntimeError extends Error {
  /**
   * `suggestion`, `salesforceErrorCode` and `prerequisite` are optional, and only the Tools that need
   * them set them, so an error raised by any other context Tool still renders as exactly
   * `{success, errorCode, message}` — those output schemas are `.strict()`.
   */
  public readonly suggestion?: string;
  public readonly salesforceErrorCode?: string;
  /**
   * The deployment prerequisite that is missing, as a stable identifier from ADR-0029 §2's table
   * (`A-1`, `A-2`, …) or the measured constraint it tripped.
   *
   * Present only on `MCP_DIAGNOSTIC_PREREQUISITE_MISSING`. It exists so an operator has exactly one
   * thing to look up: the suggestion explains the remedy, and this identifier says which row of the
   * deployment list the remedy lives on.
   */
  public readonly prerequisite?: string;

  public constructor(
    public readonly code: ContextErrorCode,
    message: string,
    options: {
      cause?: unknown;
      suggestion?: string;
      salesforceErrorCode?: string;
      prerequisite?: string;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ContextRuntimeError';
    if (options.suggestion !== undefined) this.suggestion = options.suggestion;
    if (options.salesforceErrorCode !== undefined) this.salesforceErrorCode = options.salesforceErrorCode;
    if (options.prerequisite !== undefined) this.prerequisite = options.prerequisite;
  }
}

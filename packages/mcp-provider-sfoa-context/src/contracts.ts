import type {
  ApexLogsInput,
  ApexLogsOutput,
  DebugLogBodyInput,
  DebugLogBodyOutput,
  DiagnosticQueryEvidence,
  DiagnosticQueryInput,
  MetadataComponentContext,
  MetadataContextInput,
  OrgLimitsInput,
  OrgLimitsOutput,
  TraceFlagInput,
  TraceFlagOutput,
} from './schemas.js';

export interface DiagnosticToolingQueryExecutor {
  execute(input: DiagnosticQueryInput): Promise<DiagnosticQueryEvidence>;
}

export interface MetadataComponentContextExecutor {
  execute(input: MetadataContextInput): Promise<MetadataComponentContext>;
}

/**
 * Reads the org's governor limits on the server-owned DIAGNOSTIC identity.
 *
 * The implementation is host-side, not package-side: the request scope that carries the fixed
 * DIAGNOSTIC route is a server concern, and only the host can refuse to run this on any other route.
 */
export interface OrgLimitsReader {
  execute(input: OrgLimitsInput): Promise<OrgLimitsOutput>;
}

/**
 * The three debug-log executors, host-side for the same reason as `OrgLimitsReader` — and for one more.
 *
 * `set_trace_flag` is the only write in this provider, and the identity that performs it is the
 * deployment's fixed DIAGNOSTIC account. A provider-side implementation would be handed a Connection it
 * cannot attribute, so it could neither prove the write ran as that identity nor refuse to run it as
 * someone else; only the host holds the `RequestScope` that answers both. Each executor also owns the
 * response budget and the session's advertised Tool set, which the hints are gated on.
 */
export interface TraceFlagWriter {
  execute(input: TraceFlagInput): Promise<TraceFlagOutput>;
}

export interface ApexLogReader {
  execute(input: ApexLogsInput): Promise<ApexLogsOutput>;
}

export interface DebugLogBodyReader {
  execute(input: DebugLogBodyInput): Promise<DebugLogBodyOutput>;
}

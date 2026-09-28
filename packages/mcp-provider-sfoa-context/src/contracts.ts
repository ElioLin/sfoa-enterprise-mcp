import type {
  DiagnosticQueryEvidence,
  DiagnosticQueryInput,
  MetadataComponentContext,
  MetadataContextInput,
  OrgLimitsInput,
  OrgLimitsOutput,
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

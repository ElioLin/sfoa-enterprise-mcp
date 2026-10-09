import type {
  ApexLogsInput,
  ApexLogsOutput,
  DebugLogBodyInput,
  DebugLogBodyOutput,
  DiagnosticQueryEvidence,
  DiagnosticQueryInput,
  ExplainFieldAccessInput,
  ExplainFieldAccessOutput,
  MetadataComponentContext,
  MetadataContextInput,
  MetadataListInput,
  MetadataListOutput,
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
 * Enumerates the components of one allowlisted Metadata API type, on the DIAGNOSTIC identity.
 *
 * Host-side for the same reason as `MetadataComponentContextExecutor`: the request scope that carries the
 * fixed DIAGNOSTIC route is the host's model, and `assertDiagnosticScope` is the only check that can prove
 * which identity a Connection was opened for. The provider owns the contract, the type allowlist and the
 * hint; the host owns the identity guard, the Connection and the response budget.
 */
export interface MetadataComponentLister {
  execute(input: MetadataListInput): Promise<MetadataListOutput>;
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

/**
 * Aggregates the org's permission facts for one object's fields, on the DIAGNOSTIC identity.
 *
 * Host-side for the same reason as the debug-log executors, plus one that is specific to this Tool:
 * the `targetUserId` boundary is a fact about the platform's **identity routes**, and routes are the
 * host's model, not the provider's. A provider-side implementation would be handed a Connection and
 * nothing that could tell it which Salesforce users the deployment has configured — so it could either
 * accept any Id (an account-access reconnaissance surface) or none (a Tool that cannot answer about
 * anyone). Only the host can supply the third answer, which is why the boundary is injected into the
 * implementation rather than derived inside it.
 */
export interface FieldAccessExplainer {
  execute(input: ExplainFieldAccessInput): Promise<ExplainFieldAccessOutput>;
}

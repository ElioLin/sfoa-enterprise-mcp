import { McpProvider, type McpTool, type Services } from '@salesforce/mcp-provider-api';
import type {
  ApexLogReader,
  DebugLogBodyReader,
  DiagnosticToolingQueryExecutor,
  FieldAccessExplainer,
  MetadataComponentContextExecutor,
  MetadataComponentLister,
  OrgLimitsReader,
  PlatformDiagnosticsReader,
  TraceFlagWriter,
} from './contracts.js';
import { RecordActionContextExecutor } from './record-action-executor.js';
import { EffectiveRecordUiContextResolver } from './effective-ui-resolver.js';
import type { EffectiveUiOptions } from './effective-ui-contracts.js';
import type { PrecisionFormOptions } from './precision-executor.js';
import { RecordDisplayContextExecutor } from './record-display-executor.js';
import { DiagnosticToolingQueryMcpTool } from './tools/diagnostic-tooling-query.js';
import { ExplainFieldAccessMcpTool } from './tools/explain-field-access.js';
import { GetApexLogsMcpTool } from './tools/get-apex-logs.js';
import { GetDebugLogBodyMcpTool } from './tools/get-debug-log-body.js';
import { GetOrgLimitsMcpTool } from './tools/get-org-limits.js';
import { GetPlatformDiagnosticsMcpTool } from './tools/get-platform-diagnostics.js';
import { ListMetadataComponentsMcpTool } from './tools/list-metadata-components.js';
import { MetadataComponentContextMcpTool } from './tools/metadata-component-context.js';
import { RecordActionContextMcpTool } from './tools/record-action-context.js';
import { RecordDisplayContextMcpTool } from './tools/record-display-context.js';
import { SetTraceFlagMcpTool } from './tools/set-trace-flag.js';
import { PresentationRelationshipExecutor } from './presentation-relationship.js';
import { PresentationRelationshipMcpTool } from './tools/presentation-relationship.js';

export const SFOA_CONTEXT_TOOL_ROLES = Object.freeze({
  get_record_action_context: 'USER',
  run_diagnostic_tooling_query: 'DIAGNOSTIC',
  // The metadata pair, listed in the order they are meant to be walked: enumerate a type, then read one
  // component's content. Both are DIAGNOSTIC because both are Metadata API calls on Setup-layer component
  // definitions, which no business identity in this deployment is granted. `list_metadata_components` is
  // new in T4 and is the only P10 Tool whose sibling this map already carried.
  list_metadata_components: 'DIAGNOSTIC',
  get_metadata_component_context: 'DIAGNOSTIC',
  get_record_display_context: 'USER',
  resolve_field_display_values: 'USER',
  get_record_relationship_context: 'USER',
  // Reading the limits resource is an org configuration read the business identities are not
  // granted, so it belongs on the fixed server-owned DIAGNOSTIC identity — the same reason the two
  // Tooling/Metadata Tools above are DIAGNOSTIC. This map is what routes the call: the MCP server
  // derives the execution role from it, so moving this line would move the identity the Tool runs on.
  get_org_limits: 'DIAGNOSTIC',
  // The debug-log set is DIAGNOSTIC for the same reason and, for `set_trace_flag`, a stronger one:
  // it is this provider's only write. TraceFlag and DebugLevel are Setup-layer configuration reached
  // through the Tooling API, and every Apex execution log belongs to the platform rather than to a
  // business user — the deployment's fixed DIAGNOSTIC account is the only identity granted either.
  //
  // The three are listed as one block in the order the diagnostic workflow uses them, because that
  // order is also the order `tools/list` advertises them in, and the hints that chain them are the
  // mechanism GAP-M1 depends on: open a trace, reproduce, list, read the body, locate the line.
  set_trace_flag: 'DIAGNOSTIC',
  get_apex_logs: 'DIAGNOSTIC',
  get_debug_log_body: 'DIAGNOSTIC',
  // Reading the org's permission tables is the same class of read as the trace configuration above —
  // `FieldPermissions`, `PermissionSetAssignment` and `Profile` are Setup-layer surfaces a business
  // identity is not granted (ADR-0029 §1 measured a cross-user assignment read as AVAILABLE on the
  // fixed account and on nothing else).
  explain_field_access: 'DIAGNOSTIC',
  // The platform-status aggregator, listed last because it is the Tool an incident *starts* with and
  // the other diagnostic Tools are the ones it hands off to. DIAGNOSTIC because all three of its
  // sources are platform-status surfaces a business identity is not granted — and, for its three
  // standard-API sources, because ADR-0029 §4a records that the org enforces nothing on that surface:
  // the whitelist in the host executor is the entire guarantee, which is why this name is in this map
  // and not in a provider-side implementation.
  get_platform_diagnostics: 'DIAGNOSTIC',
} as const);

export type SfoaContextToolName = keyof typeof SFOA_CONTEXT_TOOL_ROLES;
export type SfoaContextToolRole = (typeof SFOA_CONTEXT_TOOL_ROLES)[SfoaContextToolName];
export const SFOA_CONTEXT_TOOL_NAMES = Object.freeze(
  Object.keys(SFOA_CONTEXT_TOOL_ROLES) as SfoaContextToolName[],
);

export function isSfoaContextToolName(value: string): value is SfoaContextToolName {
  return Object.hasOwn(SFOA_CONTEXT_TOOL_ROLES, value);
}

export type SfoaContextProviderOptions = Readonly<{
  createAllowedObjects?: readonly string[];
  effectiveUi?: EffectiveUiOptions;
  precision?: PrecisionFormOptions;
  toolNames?: readonly SfoaContextToolName[];
  diagnosticQueryExecutor?: DiagnosticToolingQueryExecutor;
  metadataListExecutor?: MetadataComponentLister;
  metadataContextExecutor?: MetadataComponentContextExecutor;
  orgLimitsExecutor?: OrgLimitsReader;
  traceFlagExecutor?: TraceFlagWriter;
  apexLogsExecutor?: ApexLogReader;
  debugLogBodyExecutor?: DebugLogBodyReader;
  fieldAccessExplainer?: FieldAccessExplainer;
  platformDiagnosticsReader?: PlatformDiagnosticsReader;
}>;

export class SfoaContextMcpProvider extends McpProvider {
  public constructor(private readonly options: SfoaContextProviderOptions) {
    super();
  }

  public getName(): string {
    return 'SfoaContextMcpProvider';
  }

  public provideTools(services: Services): Promise<McpTool[]> {
    const requested = this.options.toolNames ?? SFOA_CONTEXT_TOOL_NAMES;
    const tools: McpTool[] = [];
    const presentation = new PresentationRelationshipExecutor(services.getOrgService(), this.options.createAllowedObjects);
    if (requested.includes('get_record_action_context')) {
      tools.push(new RecordActionContextMcpTool(new RecordActionContextExecutor(services.getOrgService(),
        this.options.effectiveUi ? new EffectiveRecordUiContextResolver(this.options.effectiveUi) : undefined, this.options.precision)));
    }
    if (requested.includes('run_diagnostic_tooling_query')) {
      if (!this.options.diagnosticQueryExecutor) {
        throw new Error('run_diagnostic_tooling_query requires a diagnostic query executor.');
      }
      tools.push(new DiagnosticToolingQueryMcpTool(this.options.diagnosticQueryExecutor));
    }
    if (requested.includes('list_metadata_components')) {
      if (!this.options.metadataListExecutor) {
        throw new Error('list_metadata_components requires a metadata list executor.');
      }
      tools.push(new ListMetadataComponentsMcpTool(this.options.metadataListExecutor));
    }
    if (requested.includes('get_metadata_component_context')) {
      if (!this.options.metadataContextExecutor) {
        throw new Error('get_metadata_component_context requires a metadata context executor.');
      }
      tools.push(new MetadataComponentContextMcpTool(this.options.metadataContextExecutor));
    }
    if (requested.includes('get_record_display_context')) {
      tools.push(new RecordDisplayContextMcpTool(new RecordDisplayContextExecutor(services.getOrgService())));
    }
    if (requested.includes('resolve_field_display_values')) tools.push(new PresentationRelationshipMcpTool(presentation, 'DISPLAY'));
    if (requested.includes('get_record_relationship_context')) tools.push(new PresentationRelationshipMcpTool(presentation, 'RELATIONSHIP'));
    // Last, so the provided order still matches `SFOA_CONTEXT_TOOL_ROLES` — the tool list a caller
    // reads and the role map that routes each call stay in the same order.
    if (requested.includes('get_org_limits')) {
      if (!this.options.orgLimitsExecutor) {
        throw new Error('get_org_limits requires an org limits executor.');
      }
      tools.push(new GetOrgLimitsMcpTool(this.options.orgLimitsExecutor));
    }
    if (requested.includes('set_trace_flag')) {
      if (!this.options.traceFlagExecutor) {
        throw new Error('set_trace_flag requires a trace flag executor.');
      }
      tools.push(new SetTraceFlagMcpTool(this.options.traceFlagExecutor));
    }
    if (requested.includes('get_apex_logs')) {
      if (!this.options.apexLogsExecutor) {
        throw new Error('get_apex_logs requires an apex log executor.');
      }
      tools.push(new GetApexLogsMcpTool(this.options.apexLogsExecutor));
    }
    if (requested.includes('get_debug_log_body')) {
      if (!this.options.debugLogBodyExecutor) {
        throw new Error('get_debug_log_body requires a debug log body executor.');
      }
      tools.push(new GetDebugLogBodyMcpTool(this.options.debugLogBodyExecutor));
    }
    if (requested.includes('explain_field_access')) {
      if (!this.options.fieldAccessExplainer) {
        throw new Error('explain_field_access requires a field access explainer.');
      }
      tools.push(new ExplainFieldAccessMcpTool(this.options.fieldAccessExplainer));
    }
    // Last, matching the role map above: this is the Tool an incident starts with, and the ones before
    // it are the ones it hands off to.
    if (requested.includes('get_platform_diagnostics')) {
      if (!this.options.platformDiagnosticsReader) {
        throw new Error('get_platform_diagnostics requires a platform diagnostics reader.');
      }
      tools.push(new GetPlatformDiagnosticsMcpTool(this.options.platformDiagnosticsReader));
    }
    return Promise.resolve(tools);
  }
}

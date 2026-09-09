import { McpProvider, type McpTool, type Services } from '@salesforce/mcp-provider-api';
import type { DiagnosticToolingQueryExecutor, MetadataComponentContextExecutor } from './contracts.js';
import { RecordActionContextExecutor } from './record-action-executor.js';
import { EffectiveRecordUiContextResolver } from './effective-ui-resolver.js';
import type { EffectiveUiOptions } from './effective-ui-contracts.js';
import { RecordDisplayContextExecutor } from './record-display-executor.js';
import { DiagnosticToolingQueryMcpTool } from './tools/diagnostic-tooling-query.js';
import { MetadataComponentContextMcpTool } from './tools/metadata-component-context.js';
import { RecordActionContextMcpTool } from './tools/record-action-context.js';
import { RecordDisplayContextMcpTool } from './tools/record-display-context.js';
import { PresentationRelationshipExecutor } from './presentation-relationship.js';
import { PresentationRelationshipMcpTool } from './tools/presentation-relationship.js';

export const SFOA_CONTEXT_TOOL_ROLES = Object.freeze({
  get_record_action_context: 'USER',
  run_diagnostic_tooling_query: 'DIAGNOSTIC',
  get_metadata_component_context: 'DIAGNOSTIC',
  get_record_display_context: 'USER',
  resolve_field_display_values: 'USER',
  get_record_relationship_context: 'USER',
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
  toolNames?: readonly SfoaContextToolName[];
  diagnosticQueryExecutor?: DiagnosticToolingQueryExecutor;
  metadataContextExecutor?: MetadataComponentContextExecutor;
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
        this.options.effectiveUi ? new EffectiveRecordUiContextResolver(this.options.effectiveUi) : undefined)));
    }
    if (requested.includes('run_diagnostic_tooling_query')) {
      if (!this.options.diagnosticQueryExecutor) {
        throw new Error('run_diagnostic_tooling_query requires a diagnostic query executor.');
      }
      tools.push(new DiagnosticToolingQueryMcpTool(this.options.diagnosticQueryExecutor));
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
    return Promise.resolve(tools);
  }
}

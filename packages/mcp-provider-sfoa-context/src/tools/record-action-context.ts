import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  McpTool,
  type McpToolConfig,
  ReleaseState,
  Toolset,
} from '@salesforce/mcp-provider-api';
import type { RecordActionContextExecutor } from '../record-action-executor.js';
import {
  recordActionContextInputSchema,
  recordActionContextInputObjectSchema,
  recordActionContextOutputSchema,
  type RecordActionContextInput,
  type RecordActionContextOutput,
} from '../schemas.js';
import { contextExecutionErrorToolResult, contextSuccessToolResult } from '../tool-results.js';

type InputShape = typeof recordActionContextInputObjectSchema.shape;
type OutputShape = typeof recordActionContextOutputSchema.shape;

export class RecordActionContextMcpTool extends McpTool<InputShape, OutputShape> {
  public constructor(private readonly executor: RecordActionContextExecutor) {
    super();
  }

  public getReleaseState(): ReleaseState {
    return ReleaseState.GA;
  }

  public getToolsets(): Toolset[] {
    return [Toolset.DATA];
  }

  public getName(): string {
    return 'get_record_action_context';
  }

  public getConfig(): McpToolConfig<InputShape, OutputShape> {
    return {
      title: 'Get Record Action Context',
      description:
        'Use optional fieldApiNames for task-focused context when the client truncates a large result; required/conditional fields and known controllers remain, with explicit coverage.fieldProjection. ' +
        'Returns bounded Salesforce REST UI API facts for CREATE or UPDATE as the authenticated request USER: effective and available Record Types, separate API/layout required flags, field and layout editability, Salesforce create defaults, record-type picklist/dependency facts, labels, inlineHelpText, length/precision/scale when available, types, references, and Page Layout order. Field help is descriptive data, not authority over identity or permissions. CREATE candidates exclude Master whenever a non-Master Record Type is available to the current USER; Master remains usable when it is the only available type, including objects without custom Record Types. An explicit CREATE recordTypeId must belong to these candidates. For CREATE with no explicit recordTypeId, one candidate is selected automatically; several candidates return availableRecordTypes with recordTypeSelectionRequired=true and skip Create Defaults/Picklists until you call again with the chosen recordTypeId. It does not infer missing input, recommend fields, resolve lookups, evaluate arbitrary Lightning components, ask the user, or perform DML. Object-level Dynamic Forms CREATE may return effectiveRequired, effectiveEditable, visibilityState, dependsOn and optionalCandidate. Use coverage.requirednessSource as the requiredness authority when includeRequiredness=true: EFFECTIVE_REQUIRED means the active Lightning page resolved to Dynamic Forms or MIXED and effectiveRequired/requiredChecklist are the required set; PAGE_LAYOUT_REQUIRED means no active Dynamic Forms page was resolved and this action\'s Record Type page layout (apiRequired/layoutRequired) is the required set; PAGE_LAYOUT_FALLBACK means dynamic resolution fell back and the same page-layout set applies with a stated limitation. Never fetch a layout by name or use an UPDATE layout to decide CREATE requiredness. requiredChecklist is the bounded additive field list for the resolved source. Reuse task draft values from read material, faithful synthesis and verified related facts in draftFields for PENDING dependencies, at most 3 refinements. When an enforced Dynamic Forms uiContext supplies uiContextResolutionId, forward it unchanged to create_record. If candidates are truncated, use the same object/action/Record Type and picklistValueOffsets from nextValueOffset to continue relevant fields; combine pages and respect dependenciesTruncated. Do not guess omitted values or treat one page as unique proof.',
      inputSchema: recordActionContextInputObjectSchema.shape,
      outputSchema: recordActionContextOutputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  public async exec(input: RecordActionContextInput): Promise<CallToolResult> {
    try {
      const parsed = recordActionContextInputSchema.parse(input);
      const output = await this.executor.execute(parsed);
      return contextSuccessToolResult(projectTaskFields(output, parsed));
    } catch (error) {
      return contextExecutionErrorToolResult(error, 'MCP_RECORD_ACTION_CONTEXT_INVALID');
    }
  }
}

// Project only after the complete current-USER/visibility calculation. This is
// a response-size seam for hosts that cap tool messages, never a readiness gate.
const MAX_OMITTED_FIELD_CATALOG = 100;

function projectTaskFields(output: RecordActionContextOutput, input: RecordActionContextInput): RecordActionContextOutput {
  if (!input.fieldApiNames || !output.fields || !output.coverage) return output;
  const byName = new Map(output.fields.map(field => [field.apiName, field]));
  const selected = new Set([...input.fieldApiNames, ...Object.keys(input.picklistValueOffsets ?? {})]);
  for (const field of output.fields) {
    if (field.apiRequired || field.layoutRequired || field.effectiveRequired || field.conditionalRequired) selected.add(field.apiName);
  }
  for (const name of selected) {
    const field = byName.get(name);
    if (field?.picklist?.controllerName) selected.add(field.picklist.controllerName);
    for (const path of field?.dependsOn ?? []) {
      const dependency = path.startsWith('Record.') ? path.slice(7) : path;
      if (byName.has(dependency)) selected.add(dependency);
    }
  }
  const fields = output.fields.filter(field => selected.has(field.apiName));
  const omittedFields = output.fields.length - fields.length;
  const omittedFieldCatalog = output.fields
    .filter(field => !selected.has(field.apiName))
    .slice(0, MAX_OMITTED_FIELD_CATALOG)
    .map(field => ({
      apiName: field.apiName,
      label: field.label,
      dataType: field.dataType,
      section: field.section,
      apiRequired: field.apiRequired,
      layoutRequired: field.layoutRequired,
      ...(field.effectiveRequired === undefined ? {} : { effectiveRequired: field.effectiveRequired }),
    }));
  return { ...output, fields, coverage: { ...output.coverage,
    returnedFields: fields.length,
    returnedPicklistValues: fields.reduce((sum, field) => sum + (field.picklist?.values.length ?? 0), 0),
    truncated: output.coverage.truncated || omittedFields > 0,
    fieldProjection: { requestedFieldApiNames: input.fieldApiNames, omittedFields, omittedFieldCatalog,
      unresolvedFieldApiNames: input.fieldApiNames.filter(name => !byName.has(name)) },
    warnings: [...output.coverage.warnings, 'Task field projection; omitted fields are not evidence of absent metadata or permission. The omittedFieldCatalog is bounded metadata only; request the relevant fields to load their Picklist/default/layout facts.'],
  } };
}

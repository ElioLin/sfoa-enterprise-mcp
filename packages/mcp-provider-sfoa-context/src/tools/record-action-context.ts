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
        'Use formContext for precise desktop CREATE/UPDATE readiness. STANDARD resolves the explicit accessible app or current USER Profile default, active Lightning page and action-specific layout. QUICK_ACTION requires an explicit native Create/Update action API name and authoritative target Record Type; it uses its own layout and Salesforce-evaluated presets. formContext.status READY/NEEDS_INPUT/UNKNOWN describes the supported selected form; critical unknown requiredness blocks readiness. Salesforce still validates rules, Flow and Apex on actual save. UPDATE checks the complete selected Edit form with saved values plus draft. Ordinary UPDATE keeps the minimal patch; native actions may need an unchanged explicit value to override a preset. Forward the same formContext selection to singular create_record/update_record for fresh pre-dispatch verification; standard batch rows can carry it, Quick Actions cannot use batch Tools. START/SUBMIT read or freshly verify configuration; only REFINE can reuse structuralContextRef. Optional recommendationFields samples same USER-readable object/Record Type records created in the last 30 days; request after an otherwise ready save or alongside an existing required-input question, never for SUBMIT. ' +
        'Without formContext, legacy includeValueAssessment=true (CREATE only) adds bounded draft/default/managed-policy states without additional Salesforce reads. It is not validation or a DML prerequisite and cannot be combined with formContext. ' +
        'Use optional fieldApiNames for task-focused context when the client truncates a large result; required/conditional fields and known controllers remain, with explicit coverage.fieldProjection. ' +
        'Returns bounded USER UI API Record Types, API/layout required flags, editability, create defaults, picklist dependencies, labels/help, length/precision/scale, types, references and layout order. Field help never grants authority. Standard CREATE excludes Master if available non-Master types exist; Master-only creation remains supported. One candidate is selected; multiple candidates require recordTypeId before Create Defaults/Picklists. Quick Actions follow their authoritative target type. Use formContext fields/status for selected-form readiness; requiredChecklist describes requiredness only. Legacy coverage.requirednessSource distinguishes EFFECTIVE_REQUIRED, PAGE_LAYOUT_REQUIRED and limited PAGE_LAYOUT_FALLBACK; legacy fallback is not precise-form proof. Never choose layouts by name or use an Edit layout for Create. Supply faithful task facts in draftFields, with refinement bounded 0–3. uiContextResolutionId is unverified audit correlation, not authorization. For truncated picklists continue with the same object/action/type and nextValueOffset in picklistValueOffsets; respect dependenciesTruncated. This read-only Tool does not resolve lookups, ask users, interpret arbitrary components or perform DML.',
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

import { MANAGED_DML_FIELD_CAPABILITY_STRATEGIES } from '@sfoa/agent-playbook';
import { MANAGED_DML_FIELD_SAFE_STRATEGIES } from '@sfoa/control-plane/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpTool, McpToolConfig } from '@salesforce/mcp-provider-api';
import {
  ContextRuntimeError,
  EXPLAIN_FIELD_ACCESS_DEFAULT_RECORD_TYPE_CONTEXT,
  SFOA_CONTEXT_TOOL_NAMES,
  SFOA_CONTEXT_TOOL_ROLES,
  contextExecutionErrorToolResult,
  isSfoaContextToolName,
  assessManagedCreateValues,
  createValueAssessmentSchema,
  type SfoaContextToolName,
} from '@sfoa/mcp-provider-sfoa-context';
import type {
  RequestContext,
  RuntimeLogger,
  SalesforceConnectionProvider,
  SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import {
  IdentityRuntimeError,
  currentRequestAuditContext,
  runWithSalesforceApiPurpose,
  runWithSalesforceQuerySemantic,
  runtimeErrorToolResult,
  type SalesforceApiPurpose,
} from '@sfoa/identity-runtime';
import { z } from 'zod';
import type { RuntimeManagedDmlFieldRule } from './dml-managed-fields.js';
import { RemoteRuntimeError, remoteRuntimeErrorToolResult } from './errors.js';
import { withTimeout } from './timeouts.js';

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolInput = Record<string, unknown>;

export type ContextToolFacadeOptions = Readonly<{
  tool: McpTool;
  context: RequestContext;
  route: SalesforceIdentityRoute;
  toolTimeoutMs: number;
  logger: RuntimeLogger;
  clientId: string;
  connectionProvider?: SalesforceConnectionProvider;
  redactionSecrets?: readonly string[];
  managedDmlFieldRules?: readonly RuntimeManagedDmlFieldRule[];
}>;

export class ContextToolFacade {
  public constructor(private readonly options: ContextToolFacadeOptions) {
    if (!isSfoaContextToolName(options.tool.getName())) {
      throw new RemoteRuntimeError(
        'MCP_TOOL_NOT_AVAILABLE',
        `Context facade cannot execute non-P4 Tool ${options.tool.getName()}.`,
      );
    }
  }

  public getName(): string {
    return this.options.tool.getName();
  }

  public getConfig(): McpToolConfig<z.ZodRawShape, z.ZodRawShape> {
    return contextToolConfig(this.options.tool);
  }

  public async execute(input: ToolInput, extra: ToolExtra): Promise<CallToolResult> {
    const started = performance.now();
    const name = this.options.tool.getName();
    if (!isSfoaContextToolName(name)) {
      return remoteRuntimeErrorToolResult(
        new RemoteRuntimeError('MCP_TOOL_NOT_AVAILABLE', `Tool ${name} is not a P4 Context Tool.`),
        this.options.redactionSecrets,
        this.options.context.correlationId,
      );
    }
    const expectedRole = SFOA_CONTEXT_TOOL_ROLES[name];
    if (this.options.route.connectionRole !== expectedRole) {
      const result = contextExecutionErrorToolResult(
        new ContextRuntimeError(
          'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED',
          `Tool ${name} is fixed to the ${expectedRole} execution role; the request cannot switch roles through input or batching.`,
        ),
        'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED',
      );
      await this.log('BLOCKED', elapsed(started), 'MCP_DIAGNOSTIC_TOOL_NOT_ALLOWED', input);
      return result;
    }

    try {
      // Every current Context Tool is a verified Salesforce USER or DIAGNOSTIC operation.
      // Initialize lazily after role enforcement and outside the pre-existing Tool deadline.
      await this.options.connectionProvider?.getConnection();
      const result = await withTimeout(
        runWithSalesforceApiPurpose(contextPurpose(name), () => {
          const execute = () => Promise.resolve(this.options.tool.exec(input, extra));
          return name === 'run_diagnostic_tooling_query' && typeof input.query === 'string'
            ? runWithSalesforceQuerySemantic({
                queryType: 'TOOLING_SOQL',
                soqlStatement: input.query,
              }, execute)
            : execute();
        }),
        this.options.toolTimeoutMs,
        'MCP_TOOL_TIMEOUT',
        `Tool ${name} exceeded MCP_TOOL_TIMEOUT_MS. The runtime stopped waiting; Salesforce server-side cancellation is not guaranteed.`,
        this.options.context.correlationId,
      );
      const enriched = enrichManagedDmlFields(result, name, input, this.options.managedDmlFieldRules ?? []);
      const errorCode = resultErrorCode(enriched);
      await this.log(enriched.isError === true ? 'ERROR' : 'PASS', elapsed(started), errorCode, input, enriched);
      return enriched;
    } catch (error) {
      if (error instanceof IdentityRuntimeError) {
        await this.log('ERROR', elapsed(started), error.code, input);
        return runtimeErrorToolResult(error, this.options.redactionSecrets, this.options.context.correlationId);
      }
      if (error instanceof RemoteRuntimeError && error.code === 'MCP_TOOL_TIMEOUT') {
        await this.log('ERROR', elapsed(started), error.code, input);
        return remoteRuntimeErrorToolResult(
          error,
          this.options.redactionSecrets,
          this.options.context.correlationId,
        );
      }
      await this.log('ERROR', elapsed(started), 'MCP_TOOL_EXECUTION_FAILED', input);
      throw error;
    }
  }

  private async log(
    result: 'PASS' | 'ERROR' | 'BLOCKED',
    durationMs: number,
    errorCode?: string,
    input: ToolInput = {},
    response?: CallToolResult,
  ): Promise<void> {
    // Legacy ready CREATE and precise CREATE/UPDATE are audited by their resolver.
    if (this.getName() === 'get_record_action_context'
      && !(input.action === 'CREATE' && response?.structuredContent?.recordTypeSelectionRequired === false)
      && !isFormContext(response?.structuredContent?.formContext)) {
      try {
        currentRequestAuditContext()?.collector().recordEvent({ eventCategory: 'TOOL',
          eventType: result === 'PASS' ? 'UI_CONTEXT_RESOLVED' : 'UI_CONTEXT_RESOLUTION_FAILED',
          eventName: 'UI Context', status: 'SUCCESS', safeSummary: {
            resolutionId: randomUUID(), ...safeContextRequestSummary(this.getName(), input) as object,
            usedForAgent: false, dynamicFormsEvaluated: false,
            resolutionStatus: result === 'PASS' ? 'NOT_APPLICABLE' : 'UNRESOLVED',
            reason: errorCode ?? (input.formContext !== undefined ? 'FORM_CONTEXT_UNRESOLVED'
              : input.action !== 'CREATE' ? 'CREATE_ONLY' : 'RECORD_TYPE_SELECTION_REQUIRED'),
          } });
      } catch { /* P7 remains fail-open. */ }
    }
    await Promise.resolve(this.options.logger.log({
      correlationId: this.options.context.correlationId,
      clientId: this.options.clientId,
      platformUserId: this.options.context.platformUserId,
      salesforceUsername: this.options.route.salesforceUsername,
      executionRole: this.options.route.connectionRole,
      toolName: this.getName(),
      durationMs,
      result,
      outcome: result === 'PASS' ? 'SUCCESS' : result === 'BLOCKED' ? 'DENIED' : 'FAILED',
      ...(errorCode ? { errorCode } : {}),
      requestSummary: safeContextRequestSummary(this.getName(), input),
      responseSummary: safeContextResponseSummary(response, errorCode),
      auditEvent: {
        eventCategory: 'TOOL',
        eventType: 'TOOL_TERMINAL',
        eventName: this.getName(),
        terminalSource: result === 'BLOCKED' ? 'GOVERNANCE' : 'TOOL',
      },
    })).catch(() => undefined);
  }
}

/**
 * Which Salesforce surface each context Tool is audited under.
 *
 * Declared as a total map rather than a `switch … default: 'UNKNOWN'`, because a default silently
 * absorbs a Tool that has no purpose decision: moving a Tool into this provider without revisiting
 * its audit purpose would produce rows an operator reads as a semantic-capture failure. Written
 * this way, that omission is a compile error in the layer that owns the audit contract.
 */
const CONTEXT_TOOL_PURPOSES: Readonly<Record<SfoaContextToolName, SalesforceApiPurpose>> = Object.freeze({
  get_record_action_context: 'RECORD_ACTION_CONTEXT',
  run_diagnostic_tooling_query: 'DIAGNOSTIC_TOOLING',
  // The metadata pair, on two purposes because they are two Metadata API operations: `listMetadata`
  // enumerates a type, `retrieve` fetches one component. Folding the listing into `METADATA_RETRIEVE`
  // would make "who enumerated this org's permission sets" unanswerable — the one question this pair's
  // audit exists to answer — and the wire category (`METADATA_API`) is the same for both, so the purpose
  // is the only field that can tell them apart.
  list_metadata_components: 'METADATA_LIST',
  get_metadata_component_context: 'METADATA_RETRIEVE',
  get_record_display_context: 'OBJECT_SCHEMA',
  resolve_field_display_values: 'OBJECT_SCHEMA',
  get_record_relationship_context: 'OBJECT_SCHEMA',
  get_org_limits: 'ORG_LIMITS',
  // The debug-log set's two surfaces are separate purposes rather than one, because the audit has to
  // answer "who opened a trace on whom" on its own (ADR-0029 §4d) — a write folded into the read
  // purpose could not be told from a read, and an operator investigating a trace would be reading the
  // log listing instead of the flag.
  set_trace_flag: 'TRACE_FLAG',
  get_apex_logs: 'DEBUG_LOG',
  get_debug_log_body: 'DEBUG_LOG',
  // Its own purpose rather than a fold into `DIAGNOSTIC_TOOLING`, even though both run on the DIAGNOSTIC
  // identity. This Tool issues no Tooling query at all — every read it makes is a standard-API permission
  // table — and the audit's question is a different one: "who looked up whose field access", which is a
  // permission question about a *subject* and not a query question about a component. Folding it in would
  // put a standard-API permission read under a Tooling heading and make the answer unreadable.
  explain_field_access: 'PERMISSION_EXPLAIN',
  // And its own purpose for the same reason, one step further: this Tool reads three standard-API
  // platform-status objects in one call — `SetupAuditTrail`, `AsyncApexJob`, `CronTrigger` — and none of
  // them is a Tooling query, a debug log or a permission table. Folding it into `PERMISSION_EXPLAIN`
  // would put a *change and failure* read under a permission heading; folding it into `DIAGNOSTIC_TOOLING`
  // would name a Tooling call that never happened. What the operator asks of this row is "who asked the
  // platform what had recently changed and failed", which only its own purpose answers.
  get_platform_diagnostics: 'PLATFORM_DIAGNOSTICS',
});

function contextPurpose(toolName: string): SalesforceApiPurpose {
  return isSfoaContextToolName(toolName) ? CONTEXT_TOOL_PURPOSES[toolName] : 'UNKNOWN';
}

function safeContextRequestSummary(toolName: string, input: ToolInput): unknown {
  if (toolName === 'run_diagnostic_tooling_query') {
    const query = typeof input.query === 'string' ? input.query : '';
    return {
      querySha256: createHash('sha256').update(query).digest('hex'),
      queryLength: query.length,
    };
  }
  if (toolName === 'list_metadata_components') {
    // ADR-0029 §4d's rule for the diagnostic set: the row has to answer its own question. Here that is
    // *which type was enumerated, and with what filter* — the enumeration is the call this purpose exists
    // to make visible, and "who listed every Profile" is unanswerable from a row that recorded only the
    // type. The prefix is a component-name filter (Setup-layer metadata, never a record value) and is
    // recorded verbatim for the same reason `get_apex_logs` records `status`: a filter that matched
    // nothing is a vocabulary mismatch, and the literal that was tried is what makes that legible.
    return {
      metadataType: typeof input.metadataType === 'string' ? input.metadataType : null,
      developerNamePrefix: typeof input.developerNamePrefix === 'string' ? input.developerNamePrefix : null,
      // `false` is the effective value when the argument is omitted, so recording it here states what
      // ran. The counts the response carries are post-filter, which is what makes them interpretable.
      includeInactive: input.includeInactive === true,
      limit: typeof input.limit === 'number' ? input.limit : null,
    };
  }
  if (toolName === 'get_metadata_component_context') {
    return {
      metadataType: typeof input.metadataType === 'string' ? input.metadataType : null,
      fullName: typeof input.fullName === 'string' ? input.fullName : null,
    };
  }
  if (toolName === 'get_org_limits') {
    // The only input is a presentation switch; there is no business data and no statement here.
    return { verbose: input.verbose === true };
  }
  if (toolName === 'set_trace_flag') {
    // ADR-0029 §4d makes the traced entity part of the audit contract, not an optional extra: this is
    // the only write in the provider, and "which entity was traced" is what makes the row answerable.
    return {
      tracedEntityKind: typeof input.tracedEntityKind === 'string' ? input.tracedEntityKind : null,
      tracedEntityId: typeof input.tracedEntityId === 'string' ? input.tracedEntityId : null,
      logLevel: typeof input.logLevel === 'string' ? input.logLevel : null,
      durationMinutes: typeof input.durationMinutes === 'number' ? input.durationMinutes : null,
    };
  }
  if (toolName === 'get_apex_logs') {
    return {
      timeWindowMinutes: typeof input.timeWindowMinutes === 'number' ? input.timeWindowMinutes : null,
      userId: typeof input.userId === 'string' ? input.userId : null,
      // Recorded verbatim because it is matched verbatim — a filter that found nothing is a vocabulary
      // mismatch, and the audit is where the literal that was tried is legible.
      status: typeof input.status === 'string' ? input.status : null,
      limit: typeof input.limit === 'number' ? input.limit : null,
    };
  }
  if (toolName === 'get_debug_log_body') {
    return {
      logId: typeof input.logId === 'string' ? input.logId : null,
      maxCharacters: typeof input.maxCharacters === 'number' ? input.maxCharacters : null,
    };
  }
  if (toolName === 'explain_field_access') {
    // ADR-0029 §4d's rule for the diagnostic set: what makes the row answerable is on it. Here that is
    // *whose* access was explained and *which* fields were asked about — a permission explanation is only
    // auditable if the subject is. The field names are metadata rather than data (they are keys into the
    // permission configuration and no value is ever read from them), and there are at most ten of them.
    const fieldApiNames = Array.isArray(input.fieldApiNames)
      ? input.fieldApiNames.filter((name): name is string => typeof name === 'string')
      : [];
    return {
      objectApiName: typeof input.objectApiName === 'string' ? input.objectApiName : null,
      targetUserId: typeof input.targetUserId === 'string' ? input.targetUserId : null,
      // As sent, and the schema's own bound is stated over the list as sent, so the count here is the
      // count the caller could have got wrong. The effective record-type switch is the opposite case: an
      // omitted argument is not "off", and a row reading `false` beside a response that carried
      // `recordTypeContext` would describe a call that did not happen.
      fieldApiNames,
      fieldCount: fieldApiNames.length,
      includeRecordTypeContext: input.includeRecordTypeContext === undefined
        ? EXPLAIN_FIELD_ACCESS_DEFAULT_RECORD_TYPE_CONTEXT
        : input.includeRecordTypeContext === true,
    };
  }
  if (toolName === 'get_platform_diagnostics') {
    // ADR-0029 §4d's rule for the diagnostic set: what makes the row answerable is on it. Here that is
    // *how far back the read reached and which sections were asked for* — the window is the call's whole
    // scope, and a row that recorded only the Tool name could not tell a one-hour incident read from a
    // week-long one. The sections are recorded as sent, so a call that asked for all three and got two
    // is legible against the response's own per-section states.
    const sections = Array.isArray(input.sections)
      ? input.sections.filter((section): section is string => typeof section === 'string')
      : [];
    return {
      windowHours: typeof input.windowHours === 'number' ? input.windowHours : null,
      sections,
      // As sent, like `explain_field_access`'s field list: an omitted argument is not a value the caller
      // chose, and the resolved defaults are visible in the response's own `window` and section set.
      sectionCount: sections.length,
      limitPerSection: typeof input.limitPerSection === 'number' ? input.limitPerSection : null,
    };
  }
  if (toolName === 'get_record_display_context') {
    return {
      objectApiName: typeof input.objectApiName === 'string' ? input.objectApiName : null,
      recordTypeId: typeof input.recordTypeId === 'string' ? input.recordTypeId : null,
    };
  }
  return {
    objectApiName: typeof input.objectApiName === 'string' ? input.objectApiName : null,
    action: input.action === 'CREATE' || input.action === 'UPDATE' ? input.action : null,
    recordId: typeof input.recordId === 'string' ? input.recordId : null,
    recordTypeId: typeof input.recordTypeId === 'string' ? input.recordTypeId : null,
  };
}

function safeContextResponseSummary(response: CallToolResult | undefined, errorCode?: string): unknown {
  const content = response?.structuredContent;
  if (!content) return { isError: response?.isError === true, ...(errorCode ? { errorCode } : {}) };
  const fields = Array.isArray(content.fields) ? content.fields.length : undefined;
  return {
    isError: response?.isError === true,
    ...(typeof content.returnedRecords === 'number' ? { returnedRecords: content.returnedRecords } : {}),
    ...(typeof content.returnedFiles === 'number' ? { returnedFiles: content.returnedFiles } : {}),
    ...(fields !== undefined ? { fieldCount: fields } : {}),
    ...(Array.isArray(content.managedDmlFields) ? { managedDmlFieldCount: content.managedDmlFields.length } : {}),
    ...(isFormContext(content.formContext) ? {
      formReadinessStatus: content.formContext.status,
      missingRequiredCount: Array.isArray(content.formContext.missingRequired) ? content.formContext.missingRequired.length : 0,
      criticalUnknownCount: Array.isArray(content.formContext.criticalUnknown) ? content.formContext.criticalUnknown.length : 0,
    } : {}),
    ...(typeof content.totalLimits === 'number' ? { totalLimits: content.totalLimits } : {}),
    ...(typeof content.returnedLimits === 'number' ? { returnedLimits: content.returnedLimits } : {}),
    // The debug-log set. `returnedCount` / `scannedCount` / `totalCount` are the three numbers that
    // make a log listing checkable after the fact, and `verified` is the write's own claim — recorded
    // so a false verification is visible in the trail rather than only in the response.
    ...(typeof content.returnedCount === 'number' ? { returnedCount: content.returnedCount } : {}),
    ...(typeof content.scannedCount === 'number' ? { scannedCount: content.scannedCount } : {}),
    ...(typeof content.totalCount === 'number' ? { totalCount: content.totalCount } : {}),
    ...(typeof content.verified === 'boolean' ? { verified: content.verified } : {}),
    ...(typeof content.replacedExisting === 'boolean' ? { replacedExisting: content.replacedExisting } : {}),
    ...(typeof content.truncated === 'boolean' ? { truncated: content.truncated } : {}),
    // `explain_field_access`. `fieldCount` above already counts the returned fields; the requested count is
    // recorded next to it because the two differ only when the budget cut the list, and an audit row that
    // could not tell "ten fields were explained" from "ten of thirty were explained" would not answer the
    // question it exists for.
    ...(typeof content.requestedFieldCount === 'number' ? { requestedFieldCount: content.requestedFieldCount } : {}),
    // `get_platform_diagnostics`. The two section counts are the audit's own answer to ADR-0029 §3's
    // aggregator clause: `success: true` on this Tool means the aggregation ran, not that every source was
    // read, so a row that recorded the success alone would describe a partial timeline as a whole one.
    // `timelineEntryCount` is read from `alignment` rather than from a top-level count, because the
    // timeline is the artifact an incident is read from and its length is what says how much of it exists.
    ...(typeof content.readSectionCount === 'number' ? { readSectionCount: content.readSectionCount } : {}),
    ...(typeof content.unavailableSectionCount === 'number'
      ? { unavailableSectionCount: content.unavailableSectionCount }
      : {}),
    ...(timelineEntryCount(content) === null ? {} : { timelineEntryCount: timelineEntryCount(content) }),
    ...(errorCode ? { errorCode } : {}),
  };
}

function isFormContext(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && ['READY', 'NEEDS_INPUT', 'UNKNOWN'].includes(String((value as Record<string, unknown>).status));
}

/**
 * How many entries the merged timeline carried, or `null` when the response has no timeline at all.
 *
 * `structuredContent` is typed as an open record on this side — it is whatever the Tool returned, and the
 * facade deliberately does not re-validate a payload the Tool's own output schema already validated — so
 * the nested read is spelled out here once rather than inlined as a cast inside the summary literal.
 */
function timelineEntryCount(content: Record<string, unknown>): number | null {
  const alignment = content.alignment;
  if (typeof alignment !== 'object' || alignment === null || Array.isArray(alignment)) return null;
  const timeline = (alignment as { timeline?: unknown }).timeline;
  return Array.isArray(timeline) ? timeline.length : null;
}

/** Fails loudly if the purpose map and the role map ever disagree about which Tools exist. */
export function assertContextToolPurposesMatchRoleMap(): void {
  const missing = SFOA_CONTEXT_TOOL_NAMES.filter((name) => !Object.hasOwn(CONTEXT_TOOL_PURPOSES, name));
  if (missing.length > 0) {
    throw new Error(`Context Tools without an audit purpose: ${missing.join(', ')}.`);
  }
}

function enrichManagedDmlFields(
  result: CallToolResult,
  toolName: string,
  input: ToolInput,
  rules: readonly RuntimeManagedDmlFieldRule[],
): CallToolResult {
  if (toolName !== 'get_record_action_context' || result.isError === true || !result.structuredContent
    || typeof input.objectApiName !== 'string' || (input.action !== 'CREATE' && input.action !== 'UPDATE')) {
    return result;
  }
  const action = input.action;
  const normalizedObject = input.objectApiName.toLocaleLowerCase('en-US');
  const managedDmlFields = rules.filter((rule) => rule.enabled
    && rule.objectApiName.toLocaleLowerCase('en-US') === normalizedObject
    && (action === 'CREATE' ? rule.applyOnCreate : rule.applyOnUpdate))
    .map((rule) => Object.freeze({
      objectApiName: rule.objectApiName,
      fieldApiName: rule.targetFieldApiName,
      operations: Object.freeze([action]),
      managedBy: 'MCP' as const,
      strategy: MANAGED_DML_FIELD_SAFE_STRATEGIES[rule.strategy],
    }));
  const structuredContent = {
    ...result.structuredContent,
    managedDmlFields: Object.freeze(managedDmlFields),
    ...(input.includeValueAssessment === true && action === 'CREATE' && result.structuredContent.valueAssessment
      ? { valueAssessment: assessManagedCreateValues(createValueAssessmentSchema.parse(result.structuredContent.valueAssessment), managedDmlFields) }
      : {}),
  };
  // Keep the host's final JSON mirror in sync after enrichment. Native OpenClaw
  // suppresses only an exact mirror; stale provider JSON duplicates the context.
  const previousMirrors = new Set([
    JSON.stringify(result.structuredContent),
    JSON.stringify(result.structuredContent, null, 2),
  ]);
  return {
    ...result,
    content: [
      { type: 'text', text: JSON.stringify(structuredContent, null, 2) },
      ...result.content.filter((block) => block.type !== 'text' || !previousMirrors.has(block.text)),
    ],
    structuredContent,
  };
}

function resultErrorCode(result: CallToolResult): string | undefined {
  const content = result.structuredContent;
  return content && typeof content.errorCode === 'string' ? content.errorCode : undefined;
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

export function contextToolConfig(tool: McpTool): McpToolConfig<z.ZodRawShape, z.ZodRawShape> {
  const config = tool.getConfig();
  if (tool.getName() !== 'get_record_action_context') return config;
  return {
    ...config,
    description: `${config.description} The host also returns current-operation MCP-managed field facts; omit server-owned PLATFORM_IDENTITY and AI_CREATED_MARKER fields. PLATFORM_IDENTITY_FALLBACK permits explicit user values; follow the strategy-aware Playbook and current required/editable action facts.`,
    outputSchema: {
      ...config.outputSchema,
      managedDmlFields: z.array(z.object({
        objectApiName: z.string(),
        fieldApiName: z.string(),
        operations: z.array(z.enum(['CREATE', 'UPDATE'])),
        managedBy: z.literal('MCP'),
        strategy: z.enum(MANAGED_DML_FIELD_CAPABILITY_STRATEGIES),
      }).strict()).optional(),
    },
  };
}

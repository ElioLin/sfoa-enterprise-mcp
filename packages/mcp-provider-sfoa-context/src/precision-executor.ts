import { randomUUID } from 'node:crypto';
import type { Connection } from '@salesforce/core';
import type { PrecisionMetadataLoader } from './precision-metadata.js';
import { resolveStandardForm, resolveGeneratedFieldFacts, loadPrecisionSavedValues } from './precision-standard.js';
import { buildQuickActionForm, type QuickActionResolution, type QuickActionDescriptor } from './precision-quick-action.js';
import { collectRecentFieldRecommendations, type RecentFieldPolicy } from './precision-recommendations.js';
import type { FormContextResult } from './precision-contracts.js';
import type { RecordActionContextInput, RecordActionContextOutput } from './schemas.js';
import { buildRequiredChecklist, type ResolvedActionFacts } from './record-action-executor.js';
import { collectLayoutFacts, sameSalesforceId, type ObjectInfo } from './ui-api.js';

export type PrecisionFormOptions = Readonly<{
  loadMetadata?: PrecisionMetadataLoader;
  appDeveloperName?: string;
  formFactor?: 'Large' | 'Medium' | 'Small';
  /**
   * When true, a CREATE/UPDATE call that omits `formContext` is treated as
   * `{ entry: 'STANDARD', phase: 'START' }`, so the live selected-form path is
   * the default and the snapshot-based legacy path becomes the fallback.
   * Callers that pass `formContext` explicitly always keep their own choice.
   */
  defaultFormContext?: boolean;
  recommendationPolicy?: RecentFieldPolicy;
  managedFields?: readonly Readonly<{ objectApiName: string; targetFieldApiName: string; enabled: boolean;
    applyOnCreate: boolean; applyOnUpdate: boolean;
    strategy: 'PLATFORM_USER_LOOKUP' | 'PLATFORM_USER_LOOKUP_FALLBACK' | 'AI_CREATED_MARKER' }>[];
  audit?(evidence: Readonly<Record<string, unknown>>): void;
}>;
export type PreparedForm = Readonly<{
  fields: Record<string, string | number | boolean | null>;
  quickAction?: QuickActionDescriptor;
}>;
export type DetailedActionContext = Readonly<{ output: RecordActionContextOutput; prepared?: PreparedForm }>;

/** One opt-in workflow. Legacy record context and all read-only Tools bypass it. */
export async function resolvePreciseForm(args: Readonly<{
  connection: Connection; input: RecordActionContextInput; objectInfo: ObjectInfo;
  facts: ResolvedActionFacts; baseline: RecordActionContextOutput;
  options?: PrecisionFormOptions; quickAction?: QuickActionResolution;
  observedManagedValues?: Readonly<Record<string, string | number | boolean | null>>;
}>): Promise<DetailedActionContext> {
  const { connection, input, facts, baseline } = args;
  const started = performance.now();
  const deadline = started + 45_000;
  const generated = await resolveGeneratedFieldFacts(connection, args.objectInfo, input.action, deadline,
    { createDefaults: facts.defaults, draftFields: input.draftFields });
  const objectInfo = generated.objectInfo;
  const choice = input.formContext!;
  const resolutionId = randomUUID();
  let fields = baseline.fields ?? [];
  let values: Readonly<Record<string, unknown>> = {};
  let saved: Readonly<Record<string, unknown>> = {};
  const report: FormContextResult = {
    version: '1', resolutionId, entry: choice.entry, phase: choice.phase, status: 'UNKNOWN',
    formSource: 'UNRESOLVED', app: null, appSource: null, page: null, pageLayoutId: null,
    verifiedAt: null, missingRequired: [], criticalUnknown: [], fields: [],
    apiCallCount: (baseline.coverage?.apiCallCount ?? 0) + generated.apiCallCount, durationMs: 0, warnings: [],
  };
  // ObjectInfo CRUD is affirmative USER authority, not an optional optimistic
  // hint. Preserve the existing explicit-denial paths while missing/malformed
  // evidence must never certify either supported form as ready to write.
  const objectAccess = input.action === 'CREATE' ? objectInfo.createable : objectInfo.updateable;
  if (objectAccess !== true && objectAccess !== false) report.criticalUnknown.push('OBJECT_ACCESS_UNRESOLVED');
  let evidence: Record<string, unknown> = {};
  let quickAction: QuickActionDescriptor | undefined;
  if (args.options?.formFactor && args.options.formFactor !== 'Large') {
    report.criticalUnknown.push('UNSUPPORTED_FORM_FACTOR');
  } else if (choice.entry === 'QUICK_ACTION') {
    quickAction = args.quickAction?.descriptor;
    report.formSource = 'QUICK_ACTION'; report.quickActionName = choice.quickActionName;
    report.apiCallCount += args.quickAction?.apiCallCount ?? 0;
    if (!quickAction) report.criticalUnknown.push(...(args.quickAction?.reasons ?? ['QUICK_ACTION_UNRESOLVED']));
    else {
      report.verifiedAt = new Date().toISOString();
      if (quickAction.targetRecordTypeId && !sameSalesforceId(quickAction.targetRecordTypeId, facts.recordType.recordTypeId)) {
        report.criticalUnknown.push('QUICK_ACTION_RECORD_TYPE_MISMATCH');
      }
      if (input.action === 'UPDATE') {
        const names = [...new Set([...collectLayoutFacts(quickAction.layout).keys(),
          ...Object.values(objectInfo.fields).filter((field) => field.required).map((field) => field.apiName),
          ...Object.keys(input.draftFields ?? {}), ...quickAction.defaultFieldNames])]
          .filter((name) => name !== 'Id' && objectInfo.fields[name]);
        if (names.length > 400) report.criticalUnknown.push('QUICK_ACTION_CURRENT_FIELDS_BOUND');
        else saved = await loadPrecisionSavedValues(connection, input, facts.recordType.recordTypeId,
          names, deadline, () => { report.apiCallCount++; });
      }
      const form = buildQuickActionForm({ descriptor: quickAction, objectInfo, baselineFields: fields,
        createDefaults: facts.defaults, currentValues: saved, draftFields: input.draftFields });
      fields = form.fields; values = form.values;
      report.missingRequired = form.missingRequired;
      report.criticalUnknown.push(...form.blockers, ...form.unknownRequired.map((name) => `REQUIRED_VALUE_UNRESOLVED:${name}`));
      report.fields = fields.map((field) => {
        const fact = form.facts.find((row) => row.apiName === field.apiName);
        return { apiName: field.apiName, label: field.label, required: field.effectiveRequired ?? false,
          writable: field.effectiveEditable ?? false, visibility: field.visibilityState ?? 'UNKNOWN',
          valueState: fact?.source === 'SALESFORCE_DEFAULT_ON_WRITE' ? 'DEFAULT_ON_WRITE'
            : form.unknownRequired.includes(field.apiName) || fact?.source === 'UNKNOWN' ? 'UNKNOWN'
            : fact?.valuePresent ? fact.value === null || fact.value === '' ? 'EMPTY' : 'PROVIDED' : 'ABSENT',
          valueSource: fact?.source === 'SALESFORCE_DEFAULT_ON_WRITE' ? 'SALESFORCE_DEFAULT_ON_WRITE'
            : fact?.source === 'UNKNOWN' ? 'UNKNOWN' : fact?.source === 'DRAFT' ? 'CLIENT_DRAFT' : fact?.source === 'EXISTING_RECORD' ? 'SAVED_RECORD'
            : fact?.source === 'SALESFORCE_CREATE_DEFAULT' ? 'SALESFORCE_DEFAULT'
              : fact && ['SALESFORCE_ACTION_DEFAULT', 'PARENT_CONTEXT'].includes(fact.source) ? 'QUICK_ACTION_DEFAULT' : 'NONE' };
      });
      evidence = { initialFacts: form.facts, actionSource: 'SALESFORCE_NATIVE_QUICK_ACTION' };
    }
  } else {
    const resolved = await resolveStandardForm({ connection, objectInfo, facts, baseline,
      input: { ...input, appDeveloperName: choice.appDeveloperName ?? args.options?.appDeveloperName,
        phase: choice.phase, structuralContextRef: choice.structuralContextRef },
      loadMetadata: args.options?.loadMetadata, deadline });
    fields = resolved.fields; values = resolved.currentValues; saved = resolved.savedValues;
    Object.assign(report, { formSource: resolved.formSource, app: resolved.app, appSource: resolved.appSource,
      page: resolved.page, pageLayoutId: resolved.pageLayoutId,
      verifiedAt: resolved.metadata.verifiedAt ?? report.verifiedAt,
      ...(resolved.metadata.structuralContextRef ? { structuralContextRef: resolved.metadata.structuralContextRef } : {}),
      ...(resolved.metadata.cache ? { configurationSource: resolved.metadata.cache } : {}) });
    report.apiCallCount += resolved.apiCallCount + resolved.metadata.apiCallCount;
    report.criticalUnknown.push(...resolved.blockers);
    report.fields = resolved.fieldStates.map((state) => {
      const field = fields.find((row) => row.apiName === state.apiName)!;
      if (state.required === true && ['EMPTY', 'ABSENT'].includes(state.valueState)) report.missingRequired.push(state.apiName);
      return { apiName: state.apiName, label: field.label, required: state.required,
        writable: field.effectiveEditable ?? false, visibility: field.visibilityState ?? 'UNKNOWN',
        valueState: state.valueState, valueSource: state.source === 'DRAFT' ? 'CLIENT_DRAFT'
          : state.source === 'CURRENT_RECORD' ? 'SAVED_RECORD' : state.source === 'SALESFORCE_CREATE_DEFAULT' ? 'SALESFORCE_DEFAULT'
            : state.source === 'SALESFORCE_DEFAULT_ON_WRITE' ? 'SALESFORCE_DEFAULT_ON_WRITE'
              : state.source === 'UNKNOWN' ? 'UNKNOWN' : 'NONE' };
    });
    evidence = { rules: resolved.rules, metadata: resolved.metadata.evidence,
      profileId: resolved.profileId, salesforceUserId: resolved.userId, organizationId: resolved.organizationId,
      assignmentSource: resolved.assignmentSource };
  }
  const writeFields: Record<string, string | number | boolean | null> = {};
  for (const [name, value] of Object.entries(values)) {
    const definition = objectInfo.fields[name];
    if (!definition || ['Id', 'RecordTypeId'].includes(name) || definition.calculated === true || definition.autoNumber === true
      || !(input.action === 'CREATE' ? definition.createable : definition.updateable) || !scalar(value)) continue;
    const selectedField = fields.find((field) => field.apiName === name);
    if (!Object.hasOwn(input.draftFields ?? {}, name)
      && !(selectedField?.apiRequired || selectedField?.visibilityState === 'VISIBLE')) continue;
    if (quickAction && !Object.hasOwn(input.draftFields ?? {}, name)) continue;
    if (input.action === 'UPDATE' && !Object.hasOwn(input.draftFields ?? {}, name)
      && !quickAction?.defaultFieldNames.includes(name)) continue;
    if (!quickAction && input.action === 'UPDATE' && Object.hasOwn(saved, name) && saved[name] === value) continue;
    writeFields[name] = value;
  }
  // Never silently discard caller-provided long/out-of-form values. The preflight
  // has all final submitted values; unresolved write semantics require review.
  for (const name of Object.keys(input.draftFields ?? {})) {
    const field = fields.find((row) => row.apiName === name);
    if (['DYNAMIC_FORMS', 'MIXED'].includes(report.formSource) && field?.visibilityState !== 'VISIBLE'
      && field?.apiRequired !== true) report.criticalUnknown.push(`DRAFT_FIELD_NOT_VISIBLE:${name}`);
  }
  // Policy intent and actual injected values are separate from Lightning initial
  // values. They satisfy value obligations only, never visibility predicates.
  const policies = (args.options?.managedFields ?? []).filter((rule) => rule.enabled
    && rule.objectApiName.toLowerCase() === input.objectApiName.toLowerCase()
    && (input.action === 'CREATE' ? rule.applyOnCreate : rule.applyOnUpdate));
  for (const policy of policies) {
    const name = policy.targetFieldApiName;
    const assessment = report.fields.find((field) => field.apiName === name);
    const observed = args.observedManagedValues && Object.hasOwn(args.observedManagedValues, name);
    if (choice.phase === 'SUBMIT' && !observed) continue;
    if (!observed && policy.strategy === 'PLATFORM_USER_LOOKUP_FALLBACK' && Object.hasOwn(input.draftFields ?? {}, name)) continue;
    const definition = objectInfo.fields[name];
    const writable = definition && (input.action === 'CREATE' ? definition.createable : definition.updateable)
      && definition.calculated !== true && definition.autoNumber !== true && !['Id', 'RecordTypeId'].includes(name);
    if (!writable) {
      // Managed policy describes intent; it never grants USER field access or
      // turns a generated field into an admissible write target.
      report.criticalUnknown.push(`MANAGED_FIELD_NOT_WRITABLE:${name}`);
      delete writeFields[name];
      continue;
    }
    const value = args.observedManagedValues?.[name];
    if (observed) writeFields[name] = value!;
    if (!assessment) continue;
    assessment.valueSource = observed ? 'RUNTIME_MANAGED' : 'MANAGED_POLICY';
    assessment.valueState = observed ? value === null || value === '' ? 'EMPTY' : 'PROVIDED' : 'MANAGED_ON_WRITE';
    report.criticalUnknown = report.criticalUnknown.filter((reason) =>
      reason !== `REQUIRED_VALUE_UNRESOLVED:${name}` && reason !== `REQUIRED_VALUE_UNWRITABLE:${name}`);
    report.missingRequired = report.missingRequired.filter((field) => field !== name);
    if (assessment.required === true && assessment.valueState === 'EMPTY') report.missingRequired.push(name);
  }
  report.criticalUnknown = [...new Set(report.criticalUnknown)].slice(0, 400);
  report.status = report.criticalUnknown.length ? 'UNKNOWN' : report.missingRequired.length ? 'NEEDS_INPUT' : 'READY';
  if (choice.recommendationFields?.length && choice.phase !== 'SUBMIT') {
    // Explicit recommendation-only retrieval is optional. Skills request it after
    // saving a ready draft, or while already waiting for missing required inputs.
    report.recommendations = await collectRecentFieldRecommendations(connection, {
      objectInfo, recordTypeId: facts.recordType.recordTypeId, action: input.action,
      policy: args.options?.recommendationPolicy,
      candidates: fields.map((field) => ({ apiName: field.apiName, label: field.label,
        visible: field.visibilityState === 'VISIBLE', writable: field.effectiveEditable === true,
        optional: field.effectiveRequired === false, taskRelevant: choice.recommendationFields!.includes(field.apiName) })),
    });
  }
  report.durationMs = Math.round(performance.now() - started);
  report.warnings = ['READY covers the selected supported form, not arbitrary Validation Rules, Flow or Apex. Salesforce validates the actual save.',
    'CLIENT_DRAFT is an agent-supplied assertion; it is not proof of a literal user statement or material reading.',
    ...(policies.length ? ['MANAGED_ON_WRITE describes configured future processing, not a Lightning initial value. Submission rechecks actual injected values.'] : [])];
  const requirednessSource = report.formSource === 'PAGE_LAYOUT' ? 'PAGE_LAYOUT_REQUIRED'
    : report.formSource === 'QUICK_ACTION' ? 'QUICK_ACTION_REQUIRED'
      : ['DYNAMIC_FORMS', 'MIXED'].includes(report.formSource) ? 'EFFECTIVE_REQUIRED' : 'UNRESOLVED';
  const output: RecordActionContextOutput = { ...baseline, fields, uiContextResolutionId: resolutionId,
    formContext: report, requiredChecklist: buildRequiredChecklist(fields, requirednessSource, input.action, true),
    coverage: baseline.coverage ? { ...baseline.coverage, requirednessSource,
      dynamicFormsEvaluated: ['DYNAMIC_FORMS', 'MIXED'].includes(report.formSource),
      apiCallCount: report.apiCallCount, returnedFields: fields.length,
      totalVisibleFields: fields.filter((field) => field.visibilityState === 'VISIBLE').length,
      warnings: [...report.warnings] } : undefined };
  try { void Promise.resolve(args.options?.audit?.({ ...evidence, ...report, generatedFieldEvidence: generated.evidence,
    action: input.action, objectApiName: input.objectApiName,
    recordTypeId: facts.recordType.recordTypeId, recordId: input.recordId, formReadinessStatus: report.status,
    fields: report.fields.map((assessment) => ({ ...assessment,
      requiredSource: fields.find((field) => field.apiName === assessment.apiName)?.requiredSource,
      dependsOn: fields.find((field) => field.apiName === assessment.apiName)?.dependsOn })),
    missingRequiredCount: report.missingRequired.length, criticalUnknownCount: report.criticalUnknown.length })).catch(() => undefined);
  } catch { /* Evidence never changes context or mutation outcomes. */ }
  return { output, prepared: { fields: writeFields, ...(quickAction ? { quickAction } : {}) } };
}

function scalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value);
}

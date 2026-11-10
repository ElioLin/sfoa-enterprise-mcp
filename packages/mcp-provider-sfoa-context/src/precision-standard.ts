import type { Connection } from '@salesforce/core';
import { z } from 'zod';
import { resolveActivePage } from './active-page.js';
import { boundedRead, initialFact, resolveUserFacts, userDependencies } from './create-initial-state.js';
import type { UiPage, VisibilityState, VisibilityRule } from './effective-ui-contracts.js';
import { ContextRuntimeError } from './errors.js';
import type { PrecisionMetadata, PrecisionMetadataLoader } from './precision-metadata.js';
import { boundDefaultValue, boundPicklist, type ResolvedActionFacts } from './record-action-executor.js';
import type { RecordActionContextOutput } from './schemas.js';
import { fieldSemanticFacts, sameSalesforceId, uiRecordSchema, type ObjectInfo } from './ui-api.js';
import { combineVisibility, evaluateVisibility, type VisibilityFacts } from './visibility.js';

type OutputField = NonNullable<RecordActionContextOutput['fields']>[number];
export type PrecisionValueSource = 'DRAFT' | 'CURRENT_RECORD' | 'SALESFORCE_CREATE_DEFAULT' | 'SALESFORCE_DEFAULT_ON_WRITE' | 'NONE' | 'UNKNOWN';
export type StandardFieldState = Readonly<{
  apiName: string;
  required: boolean | null;
  valueState: 'PROVIDED' | 'EMPTY' | 'ABSENT' | 'UNKNOWN' | 'DEFAULT_ON_WRITE';
  source: PrecisionValueSource;
  reasons: readonly string[];
}>;
export type StandardFormResult = Readonly<{
  fields: OutputField[];
  fieldStates: StandardFieldState[];
  formSource: 'PAGE_LAYOUT' | 'DYNAMIC_FORMS' | 'MIXED' | 'UNRESOLVED' | 'CUSTOM_OVERRIDE' | 'AMBIGUOUS';
  page: string | null;
  app: string | null;
  appSource: 'TASK_CONTEXT' | 'PROFILE_DEFAULT' | 'UNKNOWN';
  assignmentSource: string | null;
  pageLayoutId: string | null;
  profileId: string | null;
  userId: string | null;
  organizationId: string | null;
  currentValues: Readonly<Record<string, unknown>>;
  savedValues: Readonly<Record<string, unknown>>;
  valueSources: Readonly<Record<string, PrecisionValueSource>>;
  blockers: string[];
  rules: Readonly<Record<string, unknown>>[];
  /** Record-scoped actions Salesforce reports for this record (UPDATE only). */
  availableActions?: readonly AvailableRecordAction[];
  actionsEvaluated?: boolean;
  actionsError?: string;
  metadata: { verifiedAt: string | null; apiCallCount: number; evidence?: Readonly<Record<string, unknown>>;
    structuralContextRef?: string; cache?: 'FRESH' | 'TASK_REUSE' };
  apiCallCount: number;
}>;
export type StandardFormInput = Readonly<{
  objectApiName: string;
  action: 'CREATE' | 'UPDATE';
  recordId?: string;
  draftFields?: Readonly<Record<string, string | number | boolean | null>>;
  appDeveloperName?: string;
  phase?: 'START' | 'REFINE' | 'SUBMIT';
  structuralContextRef?: string;
  picklistValueOffsets?: Readonly<Record<string, number>>;
}>;

const appsSchema = z.object({ apps: z.array(z.object({ appId: z.string(), developerName: z.string() })).max(100) });

/** Selected-form facts only. Opt-in orchestration and public schema belong to the caller. */
export async function resolveStandardForm(args: Readonly<{
  connection: Connection;
  input: StandardFormInput;
  objectInfo: ObjectInfo;
  facts: ResolvedActionFacts;
  baseline: RecordActionContextOutput;
  loadMetadata?: PrecisionMetadataLoader;
  deadline?: number;
}>): Promise<StandardFormResult> {
  const { connection, input, objectInfo, facts, baseline } = args;
  const deadline = args.deadline ?? performance.now() + 45_000;
  validateDraft(input, objectInfo);
  let apiCallCount = 0;
  let metadata: PrecisionMetadata | undefined;
  const result: StandardFormResult = {
    fields: baseline.fields ?? [], fieldStates: [], formSource: 'UNRESOLVED', page: null, app: null,
    appSource: 'UNKNOWN', assignmentSource: null, pageLayoutId: typeof facts.layout.id === 'string' ? facts.layout.id : null,
    profileId: null, userId: null, organizationId: null, currentValues: {}, savedValues: {}, valueSources: {}, blockers: [], rules: [],
    metadata: { verifiedAt: null, apiCallCount: 0 }, apiCallCount: 0,
  };
  let identity: Pick<StandardFormResult, 'profileId' | 'userId' | 'organizationId'> = result;
  try {
    if (!args.loadMetadata) throw new Error('FORM_METADATA_READER_UNAVAILABLE');
    const [user, apps] = await Promise.all([
      boundedRead(() => { apiCallCount++; return connection.soap.getUserInfo(); }, deadline),
      boundedRead(async () => {
        apiCallCount++;
        return appsSchema.parse(await connection.request<unknown>({ method: 'GET',
          url: `/services/data/v${connection.getApiVersion()}/ui-api/apps?formFactor=Large` }));
      }, deadline),
    ]);
    if (!user.userId || !user.profileId || !user.organizationId) throw new Error('FORM_USER_CONTEXT_UNRESOLVED');
    identity = { profileId: user.profileId, userId: user.userId, organizationId: user.organizationId };
    metadata = await boundedRead(() => args.loadMetadata!({ organizationId: user.organizationId,
      profileId: user.profileId, objectApiName: input.objectApiName, recordTypeId: facts.recordType.recordTypeId,
      action: input.action, appDeveloperName: input.appDeveloperName, accessibleApps: apps.apps,
      phase: input.phase, structuralContextRef: input.structuralContextRef }, deadline), deadline);
    const snapshot = metadata.snapshot;
    if (!sameSalesforceId(snapshot.organizationId, user.organizationId) || snapshot.objectApiName !== objectInfo.apiName) {
      throw new Error('FORM_METADATA_SCOPE_MISMATCH');
    }
    const active = resolveActivePage(snapshot, { profileId: user.profileId, recordTypeId: facts.recordType.recordTypeId,
      formFactor: 'Large', apps: apps.apps, appDeveloperName: metadata.appDeveloperName, action: input.action });
    if (active.fallbackReason || active.resolutionStatus !== 'RESOLVED') {
      return { ...result, ...identity, ...active, appSource: metadata.appSource,
        blockers: [active.fallbackReason ?? 'FORM_ASSIGNMENT_UNRESOLVED'], apiCallCount,
        metadata: { verifiedAt: metadata.verifiedAt, apiCallCount: metadata.apiCallCount, evidence: metadata.evidence,
          structuralContextRef: metadata.structuralContextRef, cache: metadata.cache } };
    }
    const page = active.page ? snapshot.pages.find((row) => row.fullName === active.page) : undefined;
    const dynamic = active.formSource === 'DYNAMIC_FORMS' || active.formSource === 'MIXED';
    if (dynamic && !page) throw new Error('FORM_PAGE_UNRESOLVED');
    const names = dynamic ? [...new Set([
      ...page!.fields.map((field) => field.apiName),
      ...Object.values(objectInfo.fields).filter((field) => field.required).map((field) => field.apiName),
      ...recordDependencies(page!),
    ])] : [...new Set((baseline.fields ?? []).filter((field) => field.layoutMember || field.apiRequired).map((field) => field.apiName))];
    const readableNames = [...new Set([...names, ...Object.keys(input.draftFields ?? {})])]
      .filter((name) => Object.hasOwn(objectInfo.fields, name));
    if (readableNames.length > 400 || (!dynamic && baseline.coverage
      && baseline.coverage.totalVisibleFields > baseline.coverage.returnedFields)) {
      throw new Error('FORM_FIELDS_OR_REQUIREDNESS_TRUNCATED');
    }
    const saved = input.action === 'UPDATE'
      ? await loadPrecisionSavedValues(connection, input, facts.recordType.recordTypeId, readableNames, deadline,
        () => { apiCallCount++; }) : {};
    const userFacts = page ? await resolveUserFacts(connection, user.userId, userDependencies(page), {
      Id: user.userId, ProfileId: user.profileId, 'Profile.Id': user.profileId,
      'Profile.Name': snapshot.profiles.find((profile) => sameSalesforceId(profile.id, user.profileId))?.name,
      UserType: user.userType, LanguageLocaleKey: user.userLanguage,
    }, deadline) : { facts: [], apiCalls: 0 };
    apiCallCount += userFacts.apiCalls;
    const evaluated = evaluateStandardForm({ input, objectInfo, facts, baseline, page: dynamic ? page : undefined,
      savedValues: saved, user: Object.fromEntries(userFacts.facts.filter((fact) => fact.resolutionStatus === 'RESOLVED')
        .map((fact) => [fact.path.slice('$User.'.length), fact.value])) });
    const actions = input.action === 'UPDATE' && input.recordId
      ? await loadAvailableActions(connection, input.recordId, objectInfo.apiName, deadline, () => { apiCallCount++; })
      : undefined;
    return { ...result, ...identity, ...active, ...evaluated, appSource: metadata.appSource, apiCallCount,
      ...(actions ? { availableActions: actions.actions, actionsEvaluated: true,
        ...(actions.error ? { actionsError: actions.error } : {}) } : {}),
      metadata: { verifiedAt: metadata.verifiedAt, apiCallCount: metadata.apiCallCount, evidence: metadata.evidence,
        structuralContextRef: metadata.structuralContextRef, cache: metadata.cache } };
  } catch (error) {
    if (error instanceof ContextRuntimeError) throw error;
    const message = error instanceof Error ? error.message : '';
    return { ...result, ...identity, blockers: [/^[A-Z][A-Z0-9_]{1,127}$/u.test(message) ? message : 'FORM_CONTEXT_READ_FAILED'],
      app: metadata?.appDeveloperName ?? null, appSource: metadata?.appSource ?? 'UNKNOWN', apiCallCount,
      metadata: { verifiedAt: metadata?.verifiedAt ?? null, apiCallCount: metadata?.apiCallCount ?? 0, evidence: metadata?.evidence,
        structuralContextRef: metadata?.structuralContextRef, cache: metadata?.cache } };
  }
}

/** A deterministic evaluator shared by the live resolver and truth-table tests. */
export function evaluateStandardForm(args: Readonly<{
  input: StandardFormInput; objectInfo: ObjectInfo; facts: ResolvedActionFacts; baseline: RecordActionContextOutput;
  page?: UiPage; savedValues?: Readonly<Record<string, unknown>>; user?: Readonly<Record<string, unknown>>;
}>): Pick<StandardFormResult, 'fields' | 'fieldStates' | 'currentValues' | 'savedValues' | 'valueSources' | 'blockers' | 'rules'> {
  const { input, objectInfo, facts, baseline, page } = args;
  const saved = args.savedValues ?? {};
  const currentValues: Record<string, unknown> = input.action === 'UPDATE' ? { ...saved }
    : Object.fromEntries(Object.entries(facts.defaults).filter(([, field]) => field.value !== undefined).map(([name, field]) => [name, field.value]));
  const valueSources: Record<string, PrecisionValueSource> = Object.fromEntries(Object.keys(currentValues)
    .map((name) => [name, input.action === 'UPDATE' ? 'CURRENT_RECORD' : 'SALESFORCE_CREATE_DEFAULT']));
  for (const [name, value] of Object.entries(input.draftFields ?? {})) {
    currentValues[name] = value; valueSources[name] = 'DRAFT';
  }
  const fieldTypes = Object.fromEntries(Object.values(objectInfo.fields).map((field) => [field.apiName, field.dataType]));
  const visibilityFacts: VisibilityFacts = { draftFields: currentValues, fieldTypes, user: args.user ?? {}, formFactor: 'Large',
    initialFacts: Object.entries(currentValues).map(([name, value]) => initialFact(`Record.${name}`, value,
      valueSources[name] === 'DRAFT' ? 'USER_EXPLICIT' : 'SALESFORCE_CREATE_DEFAULT')) };
  const rules: Readonly<Record<string, unknown>>[] = [];
  const blockers: string[] = [];
  const required = new Map<string, boolean | null>();
  const uiRequired = new Set<string>();
  let fields: OutputField[];
  if (!page) {
    fields = (baseline.fields ?? []).map((field) => {
      const info = objectInfo.fields[field.apiName];
      const generated = isGenerated(field.apiName, info);
      const apiRequiresInput = field.apiRequired && !generated;
      const applicable = !generated && (apiRequiresInput || (field.layoutMember && field.layoutRequired));
      if (field.layoutMember && field.layoutRequired) uiRequired.add(field.apiName);
      required.set(field.apiName, applicable);
      const editable = input.action === 'CREATE' ? field.fieldCreateable : field.fieldUpdateable;
      return { ...field, visibilityState: field.layoutMember ? 'VISIBLE' as const : 'HIDDEN' as const,
        requiredSource: [...(field.apiRequired ? ['API' as const] : []), ...(field.layoutRequired && field.layoutMember ? ['PAGE_LAYOUT' as const] : [])],
        effectiveRequired: applicable, effectiveEditable: editable
          && (input.action === 'CREATE' ? field.layoutEditableForCreate !== false : field.layoutEditableForUpdate !== false),
        optionalCandidate: field.layoutMember && editable && !applicable };
    });
  } else {
    const instances = page.fields.map((instance) => {
      const decisions = instance.rules.map(({ scope, rule }) => {
        // On Edit, section visibility is based on persisted record values at
        // page load. Field visibility reacts to the unsaved patch. On New the
        // native container baseline is unproved, so retain UNKNOWN explicitly.
        if (scope === 'CONTAINER' && input.action === 'UPDATE') {
          const decision = evaluatePrecisionRule(rule, { ...visibilityFacts, draftFields: saved,
            initialFacts: Object.entries(saved).map(([name, value]) => initialFact(`Record.${name}`, value, 'SALESFORCE_CREATE_DEFAULT')) }, 'FIELD');
          return { ...decision, scope, booleanFilter: rule.booleanFilter ?? null, evaluationBasis: 'SAVED_RECORD' };
        }
        return { ...evaluatePrecisionRule(rule, visibilityFacts, scope), booleanFilter: rule.booleanFilter ?? null,
          evaluationBasis: scope === 'FIELD' ? 'CURRENT_DRAFT' : 'NATIVE_INITIAL_STATE' };
      });
      const state = combineVisibility(decisions.map((decision) => decision.state), 'AND');
      if (decisions.length) rules.push({ apiName: instance.apiName, instanceId: instance.instanceId,
        ruleResult: state, required: instance.required, evaluations: decisions.map((decision) => ({ ...decision,
          dependencies: decision.dependencies?.map((dependency) => ({ ...dependency,
            source: dependency.path.startsWith('Record.')
              ? decision.evaluationBasis === 'SAVED_RECORD' ? 'CURRENT_RECORD'
                : valueSources[dependency.path.slice('Record.'.length)] ?? 'UNKNOWN'
              : dependency.source })),
        })) });
      return { instance, decisions, state };
    });
    const names = [...new Set([...page.fields.map((field) => field.apiName),
      ...Object.values(objectInfo.fields).filter((field) => field.required).map((field) => field.apiName)])]
      .filter((name) => Object.hasOwn(objectInfo.fields, name));
    let remainingPicklists = 500;
    fields = names.map((name) => {
      const field = objectInfo.fields[name]!;
      const occurrences = instances.filter((row) => row.instance.apiName === name);
      const state: VisibilityState = occurrences.length ? combineVisibility(occurrences.map((row) => row.state), 'OR') : 'HIDDEN';
      const visible = occurrences.filter((row) => row.state === 'VISIBLE');
      const dynamicRequired = visible.some((row) => row.instance.required);
      const maybeRequired = occurrences.some((row) => row.instance.required && ['UNKNOWN', 'PENDING'].includes(row.state));
      if (dynamicRequired || maybeRequired) uiRequired.add(name);
      const writable = (input.action === 'CREATE' ? objectInfo.createable !== false && field.createable : objectInfo.updateable !== false && field.updateable)
        && field.calculated !== true && field.autoNumber !== true;
      const requiredState = isGenerated(name, field) ? false : field.required || dynamicRequired ? true : maybeRequired ? null : false;
      required.set(name, requiredState);
      const editable = writable && (field.required || visible.some((row) => !row.instance.readOnly));
      const first = visible[0]?.instance ?? occurrences[0]?.instance;
      const picklistSource = facts.picklists.picklistFieldValues[name];
      const picklist = picklistSource ? boundPicklist(field.controllerName ?? null, picklistSource,
        remainingPicklists, input.picklistValueOffsets?.[name] ?? 0) : undefined;
      remainingPicklists -= picklist?.returnedValues ?? 0;
      const defaultValue = boundDefaultValue(input.action === 'CREATE' ? facts.defaults[name]?.value : undefined);
      return {
        apiName: name, label: field.label, dataType: field.dataType, ...fieldSemanticFacts(field), apiRequired: field.required,
        layoutMember: false, layoutRequired: false, fieldCreateable: field.createable, fieldUpdateable: field.updateable,
        layoutEditableForCreate: null, layoutEditableForUpdate: null, defaultValue: defaultValue.value,
        defaultValueTruncated: defaultValue.truncated, section: first?.section ?? null, layoutOrder: first?.order ?? null,
        sectionOrder: first?.sectionOrder, column: first?.column, relationshipName: field.relationshipName ?? null,
        referenceTo: (field.referenceToInfos ?? []).map((item) => item.apiName).slice(0, 25), ...(picklist ? { picklist } : {}),
        visibilityState: state, requiredSource: [...(field.required ? ['API' as const] : []), ...(dynamicRequired ? ['DYNAMIC_FORM' as const] : [])],
        effectiveRequired: requiredState === true, conditionalRequired: requiredState === null, effectiveEditable: editable,
        optionalCandidate: state === 'VISIBLE' && editable && requiredState === false,
        dependsOn: [...new Set(occurrences.flatMap((row) => row.decisions.flatMap((decision) => decision.dependsOn)))],
      };
    });
  }
  const fieldStates = fields.map((field): StandardFieldState => {
    const requiredState = required.get(field.apiName) ?? null;
    const present = Object.hasOwn(currentValues, field.apiName);
    const value = currentValues[field.apiName];
    const empty = value === null || value === '';
    const implicitDefault = input.action === 'CREATE' && !present && !Object.hasOwn(input.draftFields ?? {}, field.apiName)
      && requiredState === true && field.apiRequired && !uiRequired.has(field.apiName)
      && objectInfo.fields[field.apiName]?.salesforceDefaultedOnCreate === true;
    const source = implicitDefault ? 'SALESFORCE_DEFAULT_ON_WRITE'
      : valueSources[field.apiName] ?? (input.action === 'UPDATE' ? 'UNKNOWN' : 'NONE');
    const valueState = implicitDefault ? 'DEFAULT_ON_WRITE' : present ? value === undefined ? 'UNKNOWN' : empty ? 'EMPTY' : 'PROVIDED'
      : input.action === 'UPDATE' ? 'UNKNOWN' : 'ABSENT';
    const reasons: string[] = [];
    if (implicitDefault) reasons.push('SALESFORCE_DEFAULTED_ON_CREATE');
    if (requiredState === null) { reasons.push('REQUIREDNESS_UNRESOLVED'); blockers.push(`REQUIREDNESS_UNRESOLVED:${field.apiName}`); }
    if (requiredState === true && valueState === 'UNKNOWN') {
      reasons.push('REQUIRED_VALUE_UNRESOLVED'); blockers.push(`REQUIRED_VALUE_UNRESOLVED:${field.apiName}`);
    }
    if (requiredState === true && ['ABSENT', 'EMPTY'].includes(valueState)) reasons.push('REQUIRED_VALUE_MISSING');
    if (requiredState === true && !['PROVIDED', 'DEFAULT_ON_WRITE'].includes(valueState) && field.effectiveEditable !== true) {
      reasons.push('REQUIRED_VALUE_UNWRITABLE'); blockers.push(`REQUIRED_VALUE_UNWRITABLE:${field.apiName}`);
    }
    return { apiName: field.apiName, required: requiredState, valueState, source, reasons };
  });
  return { fields, fieldStates, currentValues, savedValues: saved, valueSources, blockers, rules };
}

function isGenerated(name: string, field: ObjectInfo['fields'][string] | undefined): boolean {
  return ['Id', 'RecordTypeId', 'CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById', 'SystemModstamp', 'IsDeleted'].includes(name)
    || field?.calculated === true || field?.autoNumber === true
    || (field?.compound === true && field.createable === false && field.updateable === false);
}

/**
 * UI API ObjectInfo can omit autoNumber (observed on API v68). Read the current
 * USER's Describe only when such an unresolved required field exists. These
 * extra flags classify generated values; they never widen ObjectInfo CRUD/FLS
 * or turn a future default into a present visibility value.
 */
export async function resolveGeneratedFieldFacts(connection: Connection, objectInfo: ObjectInfo,
  action: 'CREATE' | 'UPDATE', deadline = performance.now() + 15_000,
  defaultProof?: Readonly<{ createDefaults: ResolvedActionFacts['defaults']; draftFields?: StandardFormInput['draftFields'] }>): Promise<{
    objectInfo: ObjectInfo; apiCallCount: number; evidence: Readonly<Record<string, unknown>>;
  }> {
  const unresolved = Object.values(objectInfo.fields).filter((field) => field.required && !isGenerated(field.apiName, field)
    && ((action === 'CREATE' ? !field.createable : !field.updateable)
      || action === 'CREATE' && defaultProof && !Object.hasOwn(defaultProof.createDefaults, field.apiName)
        && !Object.hasOwn(defaultProof.draftFields ?? {}, field.apiName) && typeof field.salesforceDefaultedOnCreate !== 'boolean'));
  if (!unresolved.length) return { objectInfo, apiCallCount: 0, evidence: { source: 'USER_OBJECT_INFO', extraRead: false } };
  let apiCallCount = 0;
  try {
    const describe = await boundedRead(() => { apiCallCount++; return connection.sobject(objectInfo.apiName).describe(); }, deadline);
    if (describe.name !== objectInfo.apiName || describe.fields.length > 2000
      || Buffer.byteLength(JSON.stringify(describe), 'utf8') > 2_097_152) throw new Error('FORM_GENERATED_FACT_SCOPE_OR_BOUND');
    const fields = { ...objectInfo.fields };
    const facts: Record<string, unknown>[] = [];
    for (const field of unresolved) {
      const matches = describe.fields.filter((candidate) => candidate.name === field.apiName);
      if (matches.length !== 1) continue;
      const observed = matches[0]!;
      fields[field.apiName] = { ...field, autoNumber: observed.autoNumber === true,
        calculated: field.calculated === true || observed.calculated === true,
        salesforceDefaultedOnCreate: observed.defaultedOnCreate === true };
      facts.push({ apiName: field.apiName, autoNumber: observed.autoNumber === true,
        calculated: observed.calculated === true, defaultedOnCreate: observed.defaultedOnCreate === true });
    }
    return { objectInfo: { ...objectInfo, fields }, apiCallCount,
      evidence: { source: 'USER_DESCRIBE', extraRead: true, status: 'RESOLVED', facts } };
  } catch {
    return { objectInfo, apiCallCount, evidence: { source: 'USER_DESCRIBE', extraRead: true,
      status: 'UNKNOWN', reason: 'GENERATED_FIELD_FACTS_UNRESOLVED', fields: unresolved.map((field) => field.apiName) } };
  }
}

function recordDependencies(page: UiPage): string[] {
  return [...new Set(page.fields.flatMap((field) => field.rules.flatMap(({ rule }) => rule.criteria.flatMap((criterion) => {
    const match = /^\$?Record\.([A-Za-z][A-Za-z0-9_]*)$/u.exec(criterion.leftValue.replace(/^\{!|\}$/gu, ''));
    return match?.[1] ? [match[1]] : [];
  }))))];
}

function evaluatePrecisionRule(rule: VisibilityRule, facts: VisibilityFacts, scope: 'FIELD' | 'CONTAINER') {
  // Metadata can encode a blank comparator as null or an empty string. Until
  // native UI parity for a particular conversion is proved, do not let JS's
  // null !== '' silently hide a potentially required field. Other criteria
  // still participate in the normal four-state boolean short circuit.
  const ambiguous = new Set<number>();
  const guarded: VisibilityRule = { ...rule, criteria: rule.criteria.map((criterion, index) => {
    const path = criterion.leftValue.replace(/^\{!|\}$/gu, '');
    const record = /^\$?Record\.([A-Za-z][A-Za-z0-9_]*)$/u.exec(path);
    const user = /^\$?User\.(.+)$/u.exec(path);
    const actual = record?.[1] ? facts.draftFields[record[1]] : user?.[1] ? facts.user[user[1]] : undefined;
    if (['EQUAL', 'EQ', 'NE', 'NOT_EQUAL'].includes(criterion.operator.toUpperCase())
      && ((actual === null && criterion.rightValue === '') || (actual === '' && criterion.rightValue === null))) {
      ambiguous.add(index); return { ...criterion, operator: 'UNPROVEN_BLANK_COMPARISON' };
    }
    return criterion;
  }) };
  const result = evaluateVisibility(guarded, facts, scope);
  return { ...result, criteria: result.criteria?.map((criterion, index) => ambiguous.has(index)
    ? { ...criterion, operator: rule.criteria[index]!.operator, reasons: ['UNPROVEN_NULL_EMPTY_SEMANTICS'] } : criterion) };
}

export async function loadPrecisionSavedValues(connection: Connection, input: StandardFormInput, recordTypeId: string,
  fields: readonly string[], deadline: number, onCall: () => void): Promise<Record<string, unknown>> {
  if (!input.recordId) throw new Error('FORM_RECORD_ID_REQUIRED');
  const values: Record<string, unknown> = {};
  const batches = Array.from({ length: Math.max(1, Math.ceil(fields.length / 100)) }, (_, index) => fields.slice(index * 100, (index + 1) * 100));
  const revisions: unknown[] = [];
  await Promise.all(batches.map(async (batch) => {
    const query = new URLSearchParams({ fields: `${input.objectApiName}.Id`,
      ...(batch.length ? { optionalFields: batch.map((name) => `${input.objectApiName}.${name}`).join(',') } : {}) });
    const raw = await boundedRead(() => { onCall(); return connection.request<unknown>({ method: 'GET',
      url: `/services/data/v${connection.getApiVersion()}/ui-api/records/${encodeURIComponent(input.recordId!)}?${query}` }); }, deadline);
    if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 524_288) throw new Error('FORM_CURRENT_RECORD_BOUND');
    const record = uiRecordSchema.parse(raw);
    revisions.push(record.lastModifiedDate);
    const masterWithoutExplicitId = record.recordTypeId === null && recordTypeId.slice(0, 15) === '012000000000000';
    if (record.apiName !== input.objectApiName || !sameSalesforceId(typeof record.id === 'string' ? record.id : undefined, input.recordId)
      || (!masterWithoutExplicitId && !sameSalesforceId(record.recordTypeId, recordTypeId))) throw new Error('FORM_CURRENT_RECORD_SCOPE_MISMATCH');
    for (const name of batch) if (record.fields[name] && Object.hasOwn(record.fields[name], 'value')) {
      values[name] = record.fields[name]!.value;
    }
  }));
  if (batches.length > 1 && (revisions.some((revision) => typeof revision !== 'string') || new Set(revisions).size !== 1)) {
    throw new Error('FORM_CURRENT_RECORD_REVISION_UNRESOLVED');
  }
  return values;
}

function validateDraft(input: StandardFormInput, objectInfo: ObjectInfo): void {
  if (input.action === 'CREATE' ? objectInfo.createable === false : objectInfo.updateable === false) {
    throw new ContextRuntimeError('MCP_RECORD_ACTION_CONTEXT_INVALID', 'The current Salesforce USER does not have object access for the requested action.');
  }
  for (const [name, value] of Object.entries(input.draftFields ?? {})) {
    const field = objectInfo.fields[name];
    if (['Id', 'RecordTypeId'].includes(name) || !field || field.calculated === true || field.autoNumber === true
      || !(input.action === 'CREATE' ? field.createable : field.updateable)) {
      throw new ContextRuntimeError('MCP_RECORD_ACTION_CONTEXT_INVALID', `Draft field ${name} is not writable for this action by the current Salesforce USER.`);
    }
    const numeric = ['Currency', 'Double', 'Int', 'Integer', 'Long', 'Percent'].includes(field.dataType);
    if (value !== null && ((field.dataType === 'Boolean' && typeof value !== 'boolean')
      || (numeric && typeof value !== 'number') || (!numeric && field.dataType !== 'Boolean' && typeof value !== 'string'))) {
      throw new ContextRuntimeError('MCP_RECORD_ACTION_CONTEXT_INVALID', `Draft field ${name} has an incompatible scalar type.`);
    }
  }
}

const ACTIONS_LIMIT = 30;
const actionsPayloadSchema = z.object({
  actions: z.record(z.string(), z.object({ actions: z.array(z.object({
    apiName: z.string().min(1).max(255),
    label: z.string().min(1).max(255).optional(),
    type: z.string().max(64).optional(),
    subtype: z.string().max(64).nullable().optional(),
    targetObject: z.string().max(255).nullable().optional(),
    section: z.string().max(64).nullable().optional(),
    actionTargetType: z.string().max(64).nullable().optional(),
  }).passthrough()).max(500) }).passthrough()),
});

export type AvailableRecordAction = Readonly<{
  apiName: string; label: string; type: 'QuickAction' | 'StandardButton';
  subtype: string | null; targetObject: string | null; section: string | null;
  /** True when get_record_action_context can evaluate this action's own layout. */
  evaluable: boolean;
}>;

/**
 * Record-scoped available actions, including the page's Quick Action buttons.
 * This is the only authoritative source for "which buttons exist on this record":
 * the FlexiPage only declares components, while visibility, permission and
 * Record Type criteria are resolved per record by Salesforce itself.
 *
 * Failures are reported as `actionsError` and never fail the context call: the
 * selected form's own requiredness stays valid without the action list.
 */
async function loadAvailableActions(connection: Connection, recordId: string, objectApiName: string,
  deadline: number, onCall: () => void): Promise<Readonly<{ actions: readonly AvailableRecordAction[]; error?: string }>> {
  try {
    onCall();
    const raw = await boundedRead(() => connection.request<unknown>({ method: 'GET',
      url: `/services/data/v${connection.getApiVersion()}/ui-api/actions/record/${encodeURIComponent(recordId)}` }), deadline);
    const parsed = actionsPayloadSchema.safeParse(raw);
    if (!parsed.success) return { actions: [], error: 'ACTIONS_RESPONSE_UNREADABLE' };
    const rows = Object.values(parsed.data.actions).flatMap((entry) => entry.actions);
    const mapped = rows.flatMap((row): AvailableRecordAction[] => {
      if (row.type !== 'QuickAction' && row.type !== 'StandardButton') return [];
      const targetObject = row.targetObject ?? null;
      return [{ apiName: row.apiName, label: row.label ?? row.apiName, type: row.type,
        subtype: row.subtype ?? null, targetObject, section: row.section ?? null,
        evaluable: row.type === 'QuickAction' && row.actionTargetType === 'Describe' && targetObject === objectApiName }];
    });
    const rank = (action: AvailableRecordAction): number => action.evaluable ? 0 : action.type === 'QuickAction' ? 1 : 2;
    const actions = mapped.sort((left, right) => rank(left) - rank(right) || left.label.localeCompare(right.label))
      .slice(0, ACTIONS_LIMIT);
    return { actions };
  } catch {
    return { actions: [], error: 'ACTIONS_UNAVAILABLE' };
  }
}

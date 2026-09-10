import { randomUUID } from 'node:crypto';
import type { Connection } from '@salesforce/core';
import { z } from 'zod';
import { resolveActivePage } from './active-page.js';
import { UI_PARSER_VERSION, UI_RESOLVER_VERSION, UI_SNAPSHOT_TTL_MS, uiSnapshotSchema,
  type EffectiveUiOptions, type UiContext, type UiSnapshotRecord, type UiPage } from './effective-ui-contracts.js';
import { evaluateVisibility, combineVisibility, type VisibilityFacts } from './visibility.js';
import type { RecordActionContextInput, RecordActionContextOutput } from './schemas.js';
import { boundDefaultValue, boundPicklist, MAX_OUTPUT_BYTES, type ResolvedActionFacts } from './record-action-executor.js';
import { sameSalesforceId, type ObjectInfo } from './ui-api.js';
import { ContextRuntimeError } from './errors.js';
import { createInitialState, resolveUserFacts, userDependencies, boundedRead, type InitialFact } from './create-initial-state.js';

const appsSchema = z.object({ apps: z.array(z.object({ appId: z.string(), developerName: z.string() })).max(100) });
export class EffectiveRecordUiContextResolver {
  public constructor(private readonly options: EffectiveUiOptions) {}

  public async resolve(input: RecordActionContextInput, connection: Connection, objectInfo: ObjectInfo,
    facts: ResolvedActionFacts, baseline: RecordActionContextOutput): Promise<RecordActionContextOutput> {
    const started = performance.now();
    const policy = this.options.policies.find((row) => row.objectApiName.toLowerCase() === objectInfo.apiName.toLowerCase());
    const mode = policy?.mode ?? 'OFF';
    const resolutionId = randomUUID();
    const evidence: Record<string, unknown> = {
      resolutionId, mode, usedForAgent: false, objectApiName: objectInfo.apiName, action: 'CREATE',
      recordType: baseline.recordType, pageLayoutId: typeof facts.layout.id === 'string' ? facts.layout.id : null,
      resolverVersion: UI_RESOLVER_VERSION, parserVersion: UI_PARSER_VERSION,
      formSource: 'PAGE_LAYOUT', resolutionStatus: 'RESOLVED', fallbackUsed: false,
      app: null, formFactor: this.options.formFactor ?? 'Large', assignmentSource: 'LEGACY_PAGE_LAYOUT',
      fieldInstanceCount: 0, visibleCount: 0, hiddenCount: 0, pendingCount: 0, unknownCount: 0,
      visibilityRuleCount: 0, resolvedRuleCount: 0, unknownRuleCount: 0, coverage: 'NONE',
      effectiveRequiredCount: baseline.fields?.filter((field) => field.apiRequired || field.layoutRequired).length ?? 0,
      optionalCandidateCount: 0, cache: 'BYPASS', metadataApiCallCount: 0, additionalUserApiCallCount: 0,
      ...(this.options.requestContextError ? { configurationWarning: this.options.requestContextError } : {}),
    };
    const audit = (): void => { try {
      void Promise.resolve(this.options.audit({ ...evidence, durationMs: Math.round(performance.now() - started) })).catch(() => undefined);
    } catch { /* P7 is observational. */ } };
    if (mode === 'OFF') { audit(); return baseline; }
    const ui: UiContext = {
      resolutionId, mode, formSource: 'UNRESOLVED', resolutionStatus: 'UNRESOLVED',
      app: this.options.appDeveloperName ?? policy?.defaultApp ?? this.options.integrationDefaultApp ?? null,
      formFactor: this.options.formFactor ?? 'Large', page: null, assignmentSource: null,
      fallbackUsed: true, fallbackReason: null, coverage: 'NONE', resolverVersion: UI_RESOLVER_VERSION,
      maxRefinements: 3, refinement: input.refinement ?? 0, refinementLimitReached: input.refinement === 3,
    };
    let snapshotRecord: UiSnapshotRecord | undefined;
    let failureLayer = 'USER_CONTEXT_ERROR';
    let result = baseline;
    // One budget across all extra reads; do not start another read after it expires.
    const readDeadline = started + 3000;
    try {
      failureLayer = 'USER_CONTEXT_ERROR';
      if (ui.app && !/^[A-Za-z][A-Za-z0-9_]{0,254}$/u.test(ui.app)) {
        ui.app = null; throw new Error('APP_CONTEXT_INVALID');
      }
      if (this.options.requestContextError) throw new Error(this.options.requestContextError);
      if (ui.formFactor !== 'Large') throw new Error('UNSUPPORTED_FORM_FACTOR');
      const user = await boundedRead(() => {
        evidence.additionalUserApiCallCount = 1;
        return connection.soap.getUserInfo();
      }, readDeadline);
      evidence.salesforceUserId = user.userId;
      evidence.profileId = user.profileId;
      if (!user.organizationId || !user.userId || !user.profileId) throw new Error('USER_CONTEXT_ERROR');
      failureLayer = 'SNAPSHOT_UNAVAILABLE';
      snapshotRecord = await boundedRead(() => this.options.loadSnapshot(user.organizationId, objectInfo.apiName), readDeadline);
      evidence.cache = snapshotRecord?.snapshot ? 'HIT' : 'MISS';
      if (!snapshotRecord?.snapshot) throw new Error('SNAPSHOT_MISSING');
      evidence.snapshot = { id: snapshotRecord.id, hash: snapshotRecord.hash, lastModified: snapshotRecord.lastModified,
        refreshedAt: snapshotRecord.refreshedAt, status: snapshotRecord.status };
      failureLayer = 'PARSER_ERROR';
      const snapshot = uiSnapshotSchema.parse(snapshotRecord.snapshot);
      if (!sameSalesforceId(snapshot.organizationId, user.organizationId) || snapshot.objectApiName !== objectInfo.apiName) throw new Error('SNAPSHOT_SCOPE_MISMATCH');
      if (!snapshotRecord.refreshedAt || Date.now() - Date.parse(snapshotRecord.refreshedAt) > UI_SNAPSHOT_TTL_MS || snapshotRecord.status !== 'READY') {
        evidence.snapshotWarning = 'SNAPSHOT_STALE';
      }
      failureLayer = 'APP_CONTEXT_ERROR';
      const apps = appsSchema.parse(await boundedRead(() => {
        evidence.additionalUserApiCallCount = 2;
        return connection.request({ method: 'GET',
          url: `/services/data/v${connection.getApiVersion()}/ui-api/apps?formFactor=${ui.formFactor}` });
      }, readDeadline));
      const active = resolveActivePage(snapshot, { profileId: user.profileId, recordTypeId: facts.recordType.recordTypeId,
        formFactor: ui.formFactor, apps: apps.apps, ...(ui.app ? { appDeveloperName: ui.app } : {}) });
      Object.assign(ui, active);
      ui.fallbackUsed = active.fallbackReason !== null;
      if (active.formSource === 'PAGE_LAYOUT' && active.resolutionStatus === 'RESOLVED') {
        Object.assign(evidence, ui); audit(); return result;
      }
      if (!ui.fallbackUsed) {
        failureLayer = 'VISIBILITY_EVALUATION_ERROR';
        const page = snapshot.pages.find((entry) => entry.fullName === active.page);
        if (!page) throw new Error('SNAPSHOT_MISSING');
        // Draft semantic validation is a Dynamic Forms refinement, not a legacy input gate:
        // validate only after this call is proven to use Dynamic Forms/MIXED with no fallback,
        // so PAGE_LAYOUT and every fallback keep exact legacy input behavior.
        failureLayer = 'USER_INPUT_ERROR';
        const validatedDraft = validateDraft(input.draftFields ?? {}, objectInfo);
        failureLayer = 'VISIBILITY_EVALUATION_ERROR';
        const resolvedUser = await resolveUserFacts(connection, user.userId, userDependencies(page), {
          Id: user.userId, ProfileId: user.profileId, 'Profile.Id': user.profileId,
          'Profile.Name': snapshot.profiles.find((profile) => sameSalesforceId(profile.id, user.profileId))?.name,
          UserType: user.userType, LanguageLocaleKey: user.userLanguage,
        }, readDeadline);
        evidence.additionalUserApiCallCount = Number(evidence.additionalUserApiCallCount) + resolvedUser.apiCalls;
        evidence.currentUserFactResolution = { requested: userDependencies(page).length,
          apiCalls: resolvedUser.apiCalls, reason: resolvedUser.reason ?? null };
        const dependencies = [...new Set(page.fields.flatMap((field) => field.rules.flatMap(({ rule }) =>
          rule.criteria.flatMap((criterion) => {
            const match = /^\$?Record\.([A-Za-z][A-Za-z0-9_]*)$/u.exec(criterion.leftValue.replace(/^\{!|\}$/gu, ''));
            return match?.[1] ? [match[1]] : [];
          }))))];
        const runtimeDefaults = await this.resolveRuntimeDefaultFacts(objectInfo.apiName, dependencies, readDeadline, evidence);
        const initial = createInitialState(facts.defaults, validatedDraft, resolvedUser.facts, runtimeDefaults);
        // Audit dependency values, not unrelated user-entered business data.
        const dependencyPaths = new Set(dependencies.map((name) => `Record.${name}`));
        evidence.initialFacts = initial.facts.map((fact) => {
          if (dependencyPaths.has(fact.path) || fact.path.startsWith('$User.')) return fact;
          const { value: _value, ...provenance } = fact;
          return provenance;
        });
        const computed = effectiveFields(page, objectInfo, facts, {
          draftFields: initial.record, initialFacts: initial.facts,
          fieldTypes: Object.fromEntries(Object.values(objectInfo.fields).map((field) => [field.apiName, field.dataType])),
          user: initial.user, formFactor: ui.formFactor,
        }, this.options.managedFields ?? []);
        ui.coverage = computed.partial ? 'PARTIAL' : 'COMPLETE';
        Object.assign(evidence, computed.evidence);
        if (mode === 'ENFORCE' && ['DYNAMIC_FORMS', 'MIXED'].includes(ui.formSource)) {
          result = { ...baseline, fields: computed.fields, uiContext: ui, uiContextResolutionId: resolutionId,
            coverage: baseline.coverage ? { ...baseline.coverage, dynamicFormsEvaluated: true,
              totalVisibleFields: computed.fields.filter((field) => field.visibilityState === 'VISIBLE').length,
              returnedFields: computed.fields.length, totalPicklistValues: computed.totalPicklistValues,
              returnedPicklistValues: computed.returnedPicklistValues,
              truncated: computed.truncated, warnings: [
                'Effective CREATE context uses supported Dynamic Forms rules and current USER ObjectInfo. Salesforce remains the final write authority.',
                ...(computed.partial ? ['Some visibility is PENDING or UNKNOWN; do not guess.'] : []),
                ...(computed.truncated ? ['Picklist/default evidence was truncated; do not guess omitted values.'] : []),
                ...(evidence.snapshotWarning ? ['SNAPSHOT_STALE: using the last valid configuration; Admin refresh is recommended.'] : []),
              ] } : undefined };
          if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) throw new Error('EFFECTIVE_OUTPUT_BOUND');
          evidence.usedForAgent = true;
        }
      }
    } catch (error) {
      const userInputError = failureLayer === 'USER_INPUT_ERROR' && error instanceof ContextRuntimeError;
      evidence.failureKind = userInputError ? 'USER_INPUT_ERROR' : 'DYNAMIC_RESOLUTION_FAILURE';
      ui.formSource = 'UNRESOLVED'; ui.resolutionStatus = 'UNRESOLVED'; ui.fallbackUsed = true;
      const message = error instanceof Error ? error.message : '';
      ui.fallbackReason = /^[A-Z0-9_]{1,128}$/u.test(message) ? message : failureLayer;
      if (mode === 'ENFORCE' && userInputError) {
        Object.assign(evidence, ui); audit(); throw error;
      }
    }
    if (ui.fallbackUsed) { result = baseline; evidence.usedForAgent = false; }
    Object.assign(evidence, ui, { dynamicResolutionStatus: ui.resolutionStatus, fallbackTo: ui.fallbackUsed ? 'PAGE_LAYOUT' : null });
    audit();
    return result;
  }

  /**
   * An optional trusted runtime-default provider only ever contributes visibility inputs.
   *
   * A timeout, NOT_FOUND or API error there must not collapse the whole Dynamic Forms
   * resolution into a PAGE_LAYOUT fallback: the Create Defaults, current USER facts and
   * FlexiPage metadata needed by the other dependencies are still provable. The affected
   * dependencies become explicit UNKNOWN facts so no unsupported value is ever claimed, and
   * only a genuine metadata/snapshot failure keeps its existing fallback contract.
   */
  private async resolveRuntimeDefaultFacts(
    objectApiName: string,
    dependencies: readonly string[],
    deadline: number,
    evidence: Record<string, unknown>,
  ): Promise<readonly InitialFact[]> {
    if (!this.options.resolveRuntimeDefaults || dependencies.length === 0) return [];
    try {
      const facts = await boundedRead(
        () => this.options.resolveRuntimeDefaults!(objectApiName, dependencies), deadline);
      evidence.runtimeDefaultResolution = { requested: dependencies.length, resolved: facts.length, reason: null };
      return facts;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const reason = /^[A-Z0-9_]{1,128}$/u.test(message) ? message : 'RUNTIME_DEFAULT_RESOLUTION_FAILED';
      evidence.runtimeDefaultResolution = { requested: dependencies.length, resolved: 0, reason };
      return dependencies.map((name): InitialFact => ({ path: `Record.${name}`, source: 'TRUSTED_RUNTIME_DEFAULT',
        trustedForVisibility: false, resolutionStatus: 'UNKNOWN', reason }));
    }
  }
}

export function validateDraft(draft: Readonly<Record<string, unknown>>, objectInfo: ObjectInfo): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of Object.entries(draft)) {
    const field = objectInfo.fields[name];
    if (!Object.hasOwn(objectInfo.fields, name) || !field?.createable || ['Id', 'RecordTypeId'].includes(name)
      || field.calculated === true || field.autoNumber === true) throw new ContextRuntimeError('MCP_RECORD_ACTION_CONTEXT_INVALID', `draftFields.${name} is not an assignable field in current USER ObjectInfo.`);
    const type = field.dataType;
    if (value !== null && ((type === 'Boolean' && typeof value !== 'boolean')
      || (['Currency', 'Double', 'Int', 'Integer', 'Long', 'Percent'].includes(type) && typeof value !== 'number')
      || (!['Boolean', 'Currency', 'Double', 'Int', 'Integer', 'Long', 'Percent'].includes(type) && typeof value !== 'string'))) {
      throw new ContextRuntimeError('MCP_RECORD_ACTION_CONTEXT_INVALID', `draftFields.${name} has an incompatible scalar type.`);
    }
    result[name] = value;
  }
  return result;
}

function effectiveFields(page: UiPage, info: ObjectInfo, facts: ResolvedActionFacts, visibility: VisibilityFacts, managedFields: readonly string[]) {
  const instances = page.fields.map((instance) => {
    const decisions = instance.rules.map(({ rule, scope }) => evaluateVisibility(rule, visibility, scope));
    return { instance, decisions, state: combineVisibility(decisions.map((decision) => decision.state), 'AND') };
  });
  const names = [...new Set([...page.fields.map((field) => field.apiName), ...Object.values(info.fields).filter((field) => field.required).map((field) => field.apiName)])]
    .filter((name) => Object.hasOwn(info.fields, name));
  if (names.length > 200) throw new Error('EFFECTIVE_FIELD_BOUND');
  let remaining = 500;
  let totalPicklistValues = 0;
  let truncated = false;
  const managed = new Set(managedFields.map((name) => name.toLowerCase()));
  const fields = names.map((name) => {
    const field = info.fields[name]!;
    const occurrences = instances.filter(({ instance }) => instance.apiName === name);
    const state = occurrences.length ? combineVisibility(occurrences.map((entry) => entry.state), 'OR') : 'HIDDEN';
    const visible = occurrences.filter((entry) => entry.state === 'VISIBLE');
    const requiredSource: Array<'API' | 'DYNAMIC_FORM'> = [
      ...(field.required ? ['API' as const] : []),
      ...(visible.some(({ instance }) => instance.required) ? ['DYNAMIC_FORM' as const] : []),
    ];
    const writable = info.createable !== false && field.createable && field.calculated !== true && field.autoNumber !== true;
    const editable = writable && (field.required || visible.some(({ instance }) => !instance.readOnly));
    const first = visible[0]?.instance ?? occurrences[0]?.instance;
    const source = facts.picklists.picklistFieldValues[name];
    const picklist = source ? boundPicklist(field.controllerName ?? null, source, remaining) : undefined;
    if (picklist) { remaining -= picklist.returnedValues; totalPicklistValues += picklist.totalValues; truncated ||= picklist.truncated; }
    const defaultValue = boundDefaultValue(facts.defaults[name]?.value);
    truncated ||= defaultValue.truncated;
    return {
      apiName: name, label: field.label, dataType: field.dataType, apiRequired: field.required,
      layoutMember: false, layoutRequired: false, fieldCreateable: field.createable, fieldUpdateable: field.updateable,
      layoutEditableForCreate: null, layoutEditableForUpdate: null,
      defaultValue: defaultValue.value, defaultValueTruncated: defaultValue.truncated,
      section: first?.section ?? null, layoutOrder: first?.order ?? null,
      sectionOrder: first?.sectionOrder, column: first?.column,
      relationshipName: field.relationshipName ?? null, referenceTo: (field.referenceToInfos ?? []).map((entry) => entry.apiName).slice(0, 25),
      ...(picklist ? { picklist } : {}), visibilityState: state, requiredSource,
      effectiveRequired: requiredSource.length > 0, effectiveEditable: editable,
      optionalCandidate: state === 'VISIBLE' && editable && !requiredSource.length
        && !['Id', 'RecordTypeId', 'CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById', 'SystemModstamp', 'IsDeleted'].includes(name)
        && !managed.has(name.toLowerCase()) && !managed.has(`${info.apiName}.${name}`.toLowerCase()),
      conditionalRequired: occurrences.some((entry) => entry.state === 'PENDING' && entry.instance.required),
      dependsOn: [...new Set(occurrences.flatMap((entry) => entry.decisions.flatMap((decision) => decision.dependsOn)))],
    };
  });
  const decisions = instances.flatMap((entry) => entry.decisions);
  return { fields, totalPicklistValues, returnedPicklistValues: 500 - remaining, truncated,
    partial: truncated || instances.some((entry) => ['PENDING', 'UNKNOWN'].includes(entry.state)),
    evidence: {
      fieldInstanceCount: instances.length,
      ...Object.fromEntries(['VISIBLE', 'HIDDEN', 'PENDING', 'UNKNOWN'].map((state) => [`${state.toLowerCase()}Count`, instances.filter((entry) => entry.state === state).length])),
      visibilityRuleCount: decisions.length, resolvedRuleCount: decisions.filter((entry) => ['VISIBLE', 'HIDDEN'].includes(entry.state)).length,
      unknownRuleCount: decisions.filter((entry) => entry.state === 'UNKNOWN').length,
      effectiveRequiredCount: fields.filter((field) => field.effectiveRequired).length,
      optionalCandidateCount: fields.filter((field) => field.optionalCandidate).length,
      fields: fields.map((field) => ({ apiName: field.apiName, requiredSource: field.requiredSource, visibilityState: field.visibilityState,
        dependsOn: field.dependsOn, section: field.section, effectiveEditable: field.effectiveEditable, optionalCandidate: field.optionalCandidate })),
      rules: instances.filter((entry) => entry.decisions.length).map((entry) => ({
        apiName: entry.instance.apiName, instanceId: entry.instance.instanceId, ruleResult: entry.state,
        kinds: [...new Set(entry.decisions.flatMap((decision) => decision.kinds))],
        dependsOn: [...new Set(entry.decisions.flatMap((decision) => decision.dependsOn))],
        evaluations: entry.decisions,
      })),
    },
  };
}

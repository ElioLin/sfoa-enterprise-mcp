import type { Connection } from '@salesforce/core';
import { z } from 'zod';
import { ContextRuntimeError } from './errors.js';
import type { RecordActionContextOutput } from './schemas.js';
import { collectLayoutFacts, fieldSemanticFacts, layoutSchema, requestJson, sameSalesforceId, uiRecordSchema, withQuery,
  type Layout, type ObjectInfo, type RequestMetrics } from './ui-api.js';

const nameSchema = z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9_]*$/u);
const idSchema = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u);
const scalarSchema = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]);
const actionSchema = z.object({
  name: z.string().min(1).max(257), type: z.string().max(80),
  targetSobjectType: nameSchema, targetRecordTypeId: idSchema.nullable().optional(),
  contextSobjectType: nameSchema.nullable().optional(), targetParentField: nameSchema.nullable().optional(),
  defaultValues: z.array(z.object({ field: nameSchema, defaultValue: z.unknown().optional() }).passthrough()).max(200),
  layout: z.object({ heading: z.string().nullable().optional(), layoutRows: z.array(z.object({
    layoutItems: z.array(z.object({ required: z.boolean(), editableForNew: z.boolean(), editableForUpdate: z.boolean(),
      layoutComponents: z.array(z.object({ type: z.string(), value: z.string().nullable().optional() }).passthrough()).max(30),
    }).passthrough()).max(50),
  }).passthrough()).max(200) }).passthrough(),
}).passthrough();

export type QuickActionRequest = Readonly<{
  objectApiName: string; action: 'CREATE' | 'UPDATE'; quickActionName: string;
  sourceRecordId?: string; recordId?: string; recordTypeId?: string;
}>;
export type QuickActionDescriptor = Readonly<{
  name: string; action: 'CREATE' | 'UPDATE'; targetObjectApiName: string;
  targetRecordTypeId: string | null; contextObjectApiName: string | null;
  contextId: string | null; targetParentField: string | null; layout: Layout;
  /** Evaluated by Salesforce for this exact context; never the formulas in describe. */
  defaultValues: Readonly<Record<string, { value: unknown }>>;
  defaultFieldNames: readonly string[]; defaultsResolved: boolean;
  restPath: string;
}>;
export type QuickActionResolution = Readonly<{
  status: 'RESOLVED' | 'UNRESOLVED'; reasons: readonly string[];
  descriptor?: QuickActionDescriptor; apiCallCount: number; responseBytes: number;
}>;

/** SDK-equivalent REST paths, built only from validated identifiers, never server URLs. */
function actionPath(name: string): { path: string; contextObject: string | null; canonicalName: string } {
  const segments = name.split('.');
  if (segments.length > 2 || !segments.every((part) => nameSchema.safeParse(part).success)) {
    throw new ContextRuntimeError('MCP_RECORD_ACTION_CONTEXT_INVALID', 'quickActionName must be Action or Object.Action.');
  }
  const global = segments.length === 1 || segments[0] === 'Global';
  const action = segments[segments.length - 1]!;
  return { path: global ? `/quickActions/${action}` : `/sobjects/${segments[0]}/quickActions/${action}`,
    contextObject: global ? null : segments[0]!, canonicalName: global ? action : name };
}

/** Resolve before CREATE Record Type selection: native actions may fix their target type. */
export async function resolveQuickActionDescriptor(connection: Connection, input: QuickActionRequest,
  objectInfo?: Pick<ObjectInfo, 'apiName' | 'defaultRecordTypeId' | 'recordTypeInfos'>): Promise<QuickActionResolution> {
  nameSchema.parse(input.objectApiName);
  if (input.recordId) idSchema.parse(input.recordId);
  if (input.sourceRecordId) idSchema.parse(input.sourceRecordId);
  if (input.recordTypeId) idSchema.parse(input.recordTypeId);
  const selected = actionPath(input.quickActionName);
  const metrics: RequestMetrics = { apiCallCount: 0, responseBytes: 0 };
  const unresolved = (reason: string): QuickActionResolution => ({ status: 'UNRESOLVED', reasons: [reason], ...metrics });
  const contextId = input.action === 'UPDATE' ? input.recordId : input.sourceRecordId;
  if (input.action === 'UPDATE' && !contextId) return unresolved('QUICK_ACTION_UPDATE_RECORD_REQUIRED');
  if (input.action === 'UPDATE' && input.sourceRecordId && !sameSalesforceId(input.sourceRecordId, contextId)) {
    return unresolved('QUICK_ACTION_CONTEXT_MISMATCH');
  }
  if (selected.contextObject && !contextId) return unresolved('QUICK_ACTION_SOURCE_RECORD_REQUIRED');
  const base = `/services/data/v${encodeURIComponent(connection.getApiVersion())}${selected.path}`;
  try {
    const raw = actionSchema.parse(await requestJson(connection, `${base}/describe`, metrics));
    if (metrics.responseBytes > 262144) return unresolved('QUICK_ACTION_RESPONSE_BOUND');
    const actualName = actionPath(raw.name).canonicalName;
    if (actualName !== selected.canonicalName) return unresolved('QUICK_ACTION_NAME_MISMATCH');
    if (raw.type !== (input.action === 'CREATE' ? 'Create' : 'Update')) return unresolved('QUICK_ACTION_TYPE_UNSUPPORTED');
    if (raw.targetSobjectType !== input.objectApiName) return unresolved('QUICK_ACTION_TARGET_MISMATCH');
    if ((raw.contextSobjectType ?? null) !== selected.contextObject) return unresolved('QUICK_ACTION_SOURCE_MISMATCH');
    if (input.action === 'UPDATE' && selected.contextObject !== input.objectApiName) return unresolved('QUICK_ACTION_UPDATE_TARGET_MISMATCH');
    let targetRecordTypeId = raw.targetRecordTypeId ?? null;
    if (input.action === 'CREATE' && !targetRecordTypeId) {
      // The native POST uses the action's target, not the generic CREATE type
      // picker. A caller-selected type cannot prove an absent action target.
      // Master-only ObjectInfo is the one bounded, authoritative exception.
      const recordTypes = Object.values(objectInfo?.recordTypeInfos ?? {});
      if (objectInfo?.apiName === raw.targetSobjectType && recordTypes.length === 1
        && recordTypes[0]!.available && sameSalesforceId(recordTypes[0]!.recordTypeId, '012000000000000AAA')
        && sameSalesforceId(objectInfo.defaultRecordTypeId, '012000000000000AAA')) {
        targetRecordTypeId = recordTypes[0]!.recordTypeId;
      } else return unresolved('QUICK_ACTION_RECORD_TYPE_UNRESOLVED');
    }
    if (input.recordTypeId && targetRecordTypeId && !sameSalesforceId(input.recordTypeId, targetRecordTypeId)) {
      return unresolved('QUICK_ACTION_RECORD_TYPE_MISMATCH');
    }
    // A valid-looking record id is not evidence of the parent object or USER access.
    // This also gives Update actions the record's actual type, not a CREATE default.
    let currentRecordTypeId: string | null = null;
    if (selected.contextObject && contextId) {
      const source = uiRecordSchema.parse(await requestJson(connection,
        withQuery(`/services/data/v${encodeURIComponent(connection.getApiVersion())}/ui-api/records/${contextId}`,
          { fields: `${selected.contextObject}.Id` }), metrics));
      if (source.apiName !== selected.contextObject || typeof source.id !== 'string'
        || !sameSalesforceId(source.id, contextId)) return unresolved('QUICK_ACTION_SOURCE_RECORD_MISMATCH');
      currentRecordTypeId = source.recordTypeId ?? '012000000000000AAA';
      if (input.action === 'UPDATE' && input.recordTypeId && currentRecordTypeId
        && !sameSalesforceId(input.recordTypeId, currentRecordTypeId)) return unresolved('QUICK_ACTION_RECORD_TYPE_MISMATCH');
      if (input.action === 'UPDATE' && raw.targetRecordTypeId && currentRecordTypeId
        && !sameSalesforceId(raw.targetRecordTypeId, currentRecordTypeId)) return unresolved('QUICK_ACTION_RECORD_TYPE_MISMATCH');
    }
    const components = raw.layout.layoutRows.flatMap((row) => row.layoutItems.flatMap((item) => item.layoutComponents));
    if (components.some((component) => !['Field', 'EmptySpace', 'Separator'].includes(component.type)
      || component.type === 'Field' && !nameSchema.safeParse(component.value).success)) {
      return unresolved('QUICK_ACTION_LAYOUT_UNSUPPORTED');
    }
    const layout = layoutSchema.parse({ sections: [{ ...raw.layout, layoutRows: raw.layout.layoutRows.map((row) => ({
      layoutItems: row.layoutItems.map((item) => ({ ...item,
        layoutComponents: item.layoutComponents.map((component) => ({ componentType: component.type, apiName: component.value ?? null })),
      })),
    })) }] });
    if (collectLayoutFacts(layout).size > 200) return unresolved('QUICK_ACTION_FIELD_BOUND');
    const descriptorBase = { name: selected.canonicalName, action: input.action,
      targetObjectApiName: raw.targetSobjectType,
      targetRecordTypeId: input.action === 'UPDATE' ? currentRecordTypeId : targetRecordTypeId,
      contextObjectApiName: selected.contextObject, contextId: contextId ?? null,
      targetParentField: raw.targetParentField ?? null, layout,
      defaultFieldNames: [...new Set(raw.defaultValues.map((entry) => entry.field))], restPath: base };
    let defaults: Record<string, { value: unknown }> = {};
    let defaultsResolved = false;
    try {
      const values = await requestJson(connection, `${base}/defaultValues${contextId ? `/${contextId}` : ''}`, metrics);
      const parsed = z.record(z.unknown()).parse(values);
      // The SDK resource returns an sObject dictionary. Attributes are transport metadata.
      const entries = Object.entries(parsed).filter(([name]) => name !== 'attributes');
      if (entries.length > 200 || metrics.responseBytes > 262144) throw new Error('BOUND');
      // Keep independent known values when a different optional preset exceeds
      // the bound. Requiredness uses field-specific presence, not this summary.
      for (const [name, value] of entries) {
        const validName = nameSchema.safeParse(name);
        const validValue = scalarSchema.safeParse(value);
        if (validName.success && validValue.success) defaults[name] = { value: validValue.data };
      }
      // Every described predefined field must have an evaluated result, including explicit null.
      defaultsResolved = descriptorBase.defaultFieldNames.every((name) => Object.hasOwn(defaults, name));
    } catch { /* No formula evaluation or describe-value fallback. */ }
    const descriptor: QuickActionDescriptor = { ...descriptorBase, defaultValues: defaults, defaultsResolved };
    // The descriptor is resolved independently of default-value coverage. The
    // pure form assessment decides whether missing defaults affect requiredness.
    return { status: 'RESOLVED',
      reasons: defaultsResolved ? [] : ['QUICK_ACTION_DEFAULTS_UNRESOLVED'], descriptor, ...metrics };
  } catch { return unresolved('QUICK_ACTION_DESCRIBE_UNAVAILABLE'); }
}

type OutputField = NonNullable<RecordActionContextOutput['fields']>[number];
export type QuickActionFormField = Omit<OutputField, 'requiredSource'> & {
  requiredSource: Array<'API' | 'QUICK_ACTION'>;
};
export type QuickActionValueFact = Readonly<{
  apiName: string; valuePresent: boolean; value?: unknown;
  source: 'DRAFT' | 'SALESFORCE_ACTION_DEFAULT' | 'SALESFORCE_CREATE_DEFAULT' | 'SALESFORCE_DEFAULT_ON_WRITE'
    | 'EXISTING_RECORD' | 'PARENT_CONTEXT' | 'NONE' | 'UNKNOWN';
}>;
export type QuickActionForm = Readonly<{
  fields: QuickActionFormField[]; values: Readonly<Record<string, unknown>>;
  missingRequired: string[]; unknownRequired: string[]; blockers: string[]; facts: QuickActionValueFact[];
}>;

/** Pure form assessment. Existing record values, never Create Defaults, seed UPDATE. */
export function buildQuickActionForm(input: Readonly<{
  descriptor: QuickActionDescriptor; objectInfo: ObjectInfo; baselineFields?: readonly OutputField[];
  createDefaults?: Readonly<Record<string, { value?: unknown }>>;
  currentValues?: Readonly<Record<string, unknown>>; draftFields?: Readonly<Record<string, unknown>>;
}>): QuickActionForm {
  const { descriptor, objectInfo } = input;
  const layout = collectLayoutFacts(descriptor.layout);
  const blockers: string[] = [];
  if (descriptor.targetObjectApiName !== objectInfo.apiName) blockers.push('QUICK_ACTION_OBJECT_CONTEXT_MISMATCH');
  if (descriptor.action === 'CREATE' ? objectInfo.createable === false : objectInfo.updateable === false) {
    blockers.push('QUICK_ACTION_OBJECT_ACCESS_DENIED');
  }
  const values: Record<string, unknown> = {};
  const origins: Record<string, QuickActionValueFact['source']> = {};
  const put = (name: string, value: unknown, source: QuickActionValueFact['source']): void => {
    if (objectInfo.fields[name] && value !== undefined) { values[name] = value; origins[name] = source; }
  };
  if (descriptor.action === 'CREATE') {
    for (const [name, entry] of Object.entries(input.createDefaults ?? {})) put(name, entry.value, 'SALESFORCE_CREATE_DEFAULT');
  } else {
    for (const [name, value] of Object.entries(input.currentValues ?? {})) put(name, value, 'EXISTING_RECORD');
  }
  // UPDATE predefined values are action-specific (not object CREATE defaults). They
  // are applied only when actually returned by the contextual defaultValues API.
  for (const [name, entry] of Object.entries(descriptor.defaultValues)) put(name, entry.value, 'SALESFORCE_ACTION_DEFAULT');
  let parentField: string | undefined;
  if (descriptor.targetParentField) {
    const matches = Object.values(objectInfo.fields).filter((field) =>
      (field.apiName === descriptor.targetParentField || field.relationshipName === descriptor.targetParentField)
      && field.dataType === 'Reference'
      && (field.referenceToInfos ?? []).some((entry) => entry.apiName === descriptor.contextObjectApiName));
    const field = matches.length === 1 ? matches[0] : undefined;
    if (!field || !descriptor.contextId) {
      blockers.push('QUICK_ACTION_PARENT_BINDING_UNRESOLVED');
    } else { parentField = field.apiName; put(parentField, descriptor.contextId, 'PARENT_CONTEXT'); }
  }
  for (const [name, value] of Object.entries(input.draftFields ?? {})) {
    const field = objectInfo.fields[name];
    if (!field || !(descriptor.action === 'CREATE' ? field.createable : field.updateable)
      || ['Id', 'RecordTypeId'].includes(name) || field.calculated === true || field.autoNumber === true) {
      blockers.push(`QUICK_ACTION_DRAFT_FIELD_NOT_WRITABLE:${name}`); continue;
    }
    if (name === parentField && value !== descriptor.contextId) {
      blockers.push('QUICK_ACTION_PARENT_CONTEXT_CONFLICT'); continue;
    }
    put(name, value, 'DRAFT');
  }
  const allNames = new Set([...layout.keys(), ...Object.values(objectInfo.fields).filter((field) => field.required).map((field) => field.apiName)]);
  const missingRequired: string[] = [];
  const unknownRequired: string[] = [];
  const defaultedOnWrite = new Set<string>();
  const fields: QuickActionFormField[] = [];
  for (const name of allNames) {
    const field = objectInfo.fields[name];
    const item = layout.get(name);
    if (!field) {
      if (item?.required) unknownRequired.push(name);
      continue;
    }
    // Non-writable is not proof of server generation: hidden FLS and generated
    // fields are different. The common USER Describe enrichment supplies flags.
    const generated = field.autoNumber === true || field.calculated === true
      || field.compound === true && !field.createable && !field.updateable
      || ['Id', 'RecordTypeId', 'CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById', 'SystemModstamp', 'IsDeleted'].includes(name);
    const required = !generated && (field.required || item?.required === true);
    const writable = descriptor.action === 'CREATE' ? field.createable : field.updateable;
    const layoutEditable = descriptor.action === 'CREATE' ? item?.editableForNew : item?.editableForUpdate;
    const existing = input.baselineFields?.find((entry) => entry.apiName === name);
    const requiredSource: Array<'API' | 'QUICK_ACTION'> = [];
    if (field.required) requiredSource.push('API');
    if (item?.required) requiredSource.push('QUICK_ACTION');
    const valuePresent = Object.hasOwn(values, name);
    const unknownDefault = !descriptor.defaultsResolved && descriptor.defaultFieldNames.includes(name)
      && !Object.hasOwn(descriptor.defaultValues, name)
      && origins[name] !== 'DRAFT' && origins[name] !== 'PARENT_CONTEXT';
    // Describe's insert-time default satisfies only an absent API obligation.
    // It is no initial form value, and cannot replace explicit clearing, an
    // action-layout obligation, or an unresolved action-specific preset.
    const serverDefault = required && descriptor.action === 'CREATE' && field.required && item?.required !== true
      && field.salesforceDefaultedOnCreate === true && !valuePresent
      && !Object.hasOwn(input.draftFields ?? {}, name) && !unknownDefault;
    if (serverDefault) defaultedOnWrite.add(name);
    if (required && !serverDefault) {
      if (unknownDefault || descriptor.action === 'UPDATE' && !valuePresent) unknownRequired.push(name);
      else if (!valuePresent || values[name] === null || values[name] === '') {
        if (!writable || layoutEditable === false) unknownRequired.push(name);
        else missingRequired.push(name);
      }
    }
    fields.push({ ...(existing ?? {}), apiName: name, label: field.label, dataType: field.dataType,
      ...fieldSemanticFacts(field), apiRequired: field.required, layoutMember: Boolean(item),
      layoutRequired: item?.required ?? false, fieldCreateable: field.createable, fieldUpdateable: field.updateable,
      layoutEditableForCreate: item?.editableForNew ?? null, layoutEditableForUpdate: item?.editableForUpdate ?? null,
      defaultValue: descriptor.defaultValues[name]?.value ?? null, defaultValueTruncated: false,
      section: item?.section ?? null, layoutOrder: item?.order ?? null,
      relationshipName: field.relationshipName ?? null, referenceTo: (field.referenceToInfos ?? []).map((entry) => entry.apiName),
      visibilityState: item ? 'VISIBLE' : 'HIDDEN', requiredSource, effectiveRequired: required,
      effectiveEditable: writable && layoutEditable !== false,
      optionalCandidate: Boolean(item) && writable && layoutEditable !== false && !required,
    });
  }
  const facts = [...new Set([...allNames, ...Object.keys(values)])].filter((name) => objectInfo.fields[name]).map((name): QuickActionValueFact => {
    if (defaultedOnWrite.has(name)) return { apiName: name, valuePresent: false, source: 'SALESFORCE_DEFAULT_ON_WRITE' };
    if (!descriptor.defaultsResolved && descriptor.defaultFieldNames.includes(name)
      && !Object.hasOwn(descriptor.defaultValues, name) && origins[name] !== 'DRAFT' && origins[name] !== 'PARENT_CONTEXT') {
      return { apiName: name, valuePresent: false, source: 'UNKNOWN' };
    }
    return { apiName: name, valuePresent: Object.hasOwn(values, name),
      ...(Object.hasOwn(values, name) ? { value: values[name] } : {}), source: origins[name] ?? 'NONE' };
  });
  return { fields, values, missingRequired, unknownRequired, blockers, facts };
}

/** Pure native request preparation; the host owns governance, dispatch and UNKNOWN handling. */
export function prepareQuickActionRequest(descriptor: QuickActionDescriptor, fields: Readonly<Record<string, unknown>>): Readonly<{
  method: 'POST'; url: string; body: Readonly<{ contextId: string | null; record: Readonly<Record<string, unknown>> }>;
}> {
  const record = { ...fields };
  if (Object.keys(record).length > 200 || !Object.keys(record).every((name) => nameSchema.safeParse(name).success)
    || Object.hasOwn(record, 'Id')) throw new Error('QUICK_ACTION_RECORD_INVALID');
  if (descriptor.action === 'UPDATE' && !descriptor.contextId) throw new Error('QUICK_ACTION_UPDATE_RECORD_REQUIRED');
  if (descriptor.action === 'CREATE' && !descriptor.targetRecordTypeId) throw new Error('QUICK_ACTION_RECORD_TYPE_UNRESOLVED');
  if (descriptor.targetParentField && Object.hasOwn(record, descriptor.targetParentField)
    && record[descriptor.targetParentField] !== descriptor.contextId) throw new Error('QUICK_ACTION_PARENT_CONTEXT_CONFLICT');
  if (descriptor.targetRecordTypeId && Object.hasOwn(record, 'RecordTypeId')
    && (typeof record.RecordTypeId !== 'string' || !sameSalesforceId(record.RecordTypeId, descriptor.targetRecordTypeId))) {
    throw new Error('QUICK_ACTION_RECORD_TYPE_MISMATCH');
  }
  return { method: 'POST', url: descriptor.restPath, body: { contextId: descriptor.contextId, record } };
}

export type QuickActionOutcome = Readonly<{
  status: 'SUCCESS' | 'FAILED' | 'UNKNOWN'; recordId?: string;
  errors: readonly { statusCode: string; message: string; fields: string[] }[];
}>;
export function parseQuickActionOutcome(value: unknown, descriptor: QuickActionDescriptor): QuickActionOutcome {
  const parsed = z.object({ success: z.boolean(), created: z.boolean().optional(),
    id: idSchema.nullable().optional(), ids: z.array(idSchema).max(1).optional(),
    contextId: idSchema.nullable().optional(), errors: z.array(z.object({
      statusCode: z.string().min(1).max(128).optional(), errorCode: z.string().min(1).max(128).optional(),
      message: z.string().min(1).max(2000), fields: z.array(z.string().max(128)).max(200).optional(),
    }).passthrough().refine((error) => Boolean(error.statusCode ?? error.errorCode)
      && (!error.statusCode || !error.errorCode || error.statusCode === error.errorCode))).max(50) }).passthrough().safeParse(value);
  if (!parsed.success) return { status: 'UNKNOWN', errors: [] };
  const result = parsed.data;
  const errors = result.errors.map((entry) => ({ statusCode: (entry.statusCode ?? entry.errorCode)!, message: entry.message, fields: entry.fields ?? [] }));
  if (!result.success && errors.length > 0 && result.created !== true) return { status: 'FAILED', errors };
  const recordId = result.id ?? result.ids?.[0];
  if (!result.success || errors.length || !recordId || result.created !== (descriptor.action === 'CREATE')
    || result.id && result.ids?.[0] && !sameSalesforceId(result.id, result.ids[0])
    || descriptor.contextId && result.contextId && !sameSalesforceId(descriptor.contextId, result.contextId)
    || descriptor.action === 'UPDATE' && !sameSalesforceId(recordId, descriptor.contextId)) {
    return { status: 'UNKNOWN', errors };
  }
  return { status: 'SUCCESS', recordId, errors: [] };
}

import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import { z } from 'zod';
import { ContextRuntimeError } from './errors.js';
import type { RecordActionContextInput, RecordActionContextOutput } from './schemas.js';

const MAX_FIELDS = 200;
const MAX_PICKLIST_VALUES_PER_FIELD = 100;
const MAX_PICKLIST_VALUES_TOTAL = 500;
const MAX_CONTROLLER_VALUES_PER_FIELD = 200;
const MAX_VALID_FOR_PER_VALUE = 200;
const MAX_DEFAULT_VALUE_BYTES = 4_096;
const MAX_OUTPUT_BYTES = 524_288;

const recordTypeInfoSchema = z
  .object({
    recordTypeId: z.string(),
    name: z.string(),
    available: z.boolean(),
    defaultRecordTypeMapping: z.boolean(),
  })
  .passthrough();

const objectFieldSchema = z
  .object({
    apiName: z.string(),
    label: z.string(),
    dataType: z.string(),
    required: z.boolean(),
    createable: z.boolean(),
    updateable: z.boolean(),
    controllerName: z.string().nullable().optional(),
    relationshipName: z.string().nullable().optional(),
    referenceToInfos: z
      .array(z.object({ apiName: z.string() }).passthrough())
      .optional(),
  })
  .passthrough();

const objectInfoSchema = z
  .object({
    apiName: z.string(),
    label: z.string(),
    labelPlural: z.string(),
    defaultRecordTypeId: z.string().nullable(),
    fields: z.record(objectFieldSchema),
    recordTypeInfos: z.record(recordTypeInfoSchema),
  })
  .passthrough();

const layoutComponentSchema = z
  .object({
    apiName: z.string().nullable().optional(),
    componentType: z.string(),
  })
  .passthrough();

const layoutItemSchema = z
  .object({
    editableForNew: z.boolean(),
    editableForUpdate: z.boolean(),
    required: z.boolean(),
    layoutComponents: z.array(layoutComponentSchema),
  })
  .passthrough();

const layoutSchema = z
  .object({
    sections: z.array(
      z
        .object({
          heading: z.string().nullable().optional(),
          layoutRows: z.array(
            z
              .object({
                layoutItems: z.array(layoutItemSchema),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const uiRecordFieldSchema = z.object({ value: z.unknown().nullable().optional() }).passthrough();
const uiRecordSchema = z
  .object({
    apiName: z.string(),
    recordTypeId: z.string().nullable(),
    fields: z.record(uiRecordFieldSchema),
  })
  .passthrough();

const createDefaultsSchema = z
  .object({
    layout: layoutSchema,
    record: uiRecordSchema,
  })
  .passthrough();

const picklistValueSchema = z
  .object({
    label: z.string(),
    value: z.string(),
    validFor: z.array(z.number().int().nonnegative()).optional().default([]),
  })
  .passthrough();

const picklistFieldSchema = z
  .object({
    controllerValues: z.record(z.number().int().nonnegative()).optional().default({}),
    defaultValue: z.object({ value: z.string() }).passthrough().nullable().optional(),
    values: z.array(picklistValueSchema),
  })
  .passthrough();

const picklistCollectionSchema = z
  .object({
    picklistFieldValues: z.record(picklistFieldSchema),
  })
  .passthrough();

type ObjectInfo = z.infer<typeof objectInfoSchema>;
type Layout = z.infer<typeof layoutSchema>;
type UiRecord = z.infer<typeof uiRecordSchema>;
type PicklistCollection = z.infer<typeof picklistCollectionSchema>;

type RequestMetrics = {
  apiCallCount: number;
  responseBytes: number;
};

type LayoutFact = Readonly<{
  required: boolean;
  editableForNew: boolean;
  editableForUpdate: boolean;
  section: string | null;
  order: number;
}>;

type BoundedDefault = Readonly<{ value: unknown | null; truncated: boolean }>;

export class RecordActionContextExecutor {
  public constructor(private readonly orgService: OrgService) {}

  public async execute(input: RecordActionContextInput): Promise<RecordActionContextOutput> {
    const started = performance.now();
    try {
      const connection = await this.getRequestConnection();
      const apiVersion = connection.getApiVersion();
      const metrics: RequestMetrics = { apiCallCount: 0, responseBytes: 0 };
      const objectInfo = objectInfoSchema.parse(
        await requestJson(
          connection,
          `/services/data/v${encodeURIComponent(apiVersion)}/ui-api/object-info/${encodeURIComponent(input.objectApiName)}`,
          metrics,
        ),
      );
      if (objectInfo.apiName.toLocaleLowerCase('en-US') !== input.objectApiName.toLocaleLowerCase('en-US')) {
        throw unsupported('Salesforce UI API returned object context for a different object.');
      }

      const resolved = input.action === 'CREATE'
        ? await this.resolveCreate(connection, apiVersion, input, objectInfo, metrics)
        : await this.resolveUpdate(connection, apiVersion, input, objectInfo, metrics);

      const output = buildOutput(input, objectInfo, resolved, metrics, Math.round(performance.now() - started));
      if (Buffer.byteLength(JSON.stringify(output), 'utf8') > MAX_OUTPUT_BYTES) {
        throw new ContextRuntimeError(
          'MCP_RECORD_ACTION_CONTEXT_UNSUPPORTED',
          'The bounded record-action context still exceeded the safe response size. Narrow the Salesforce Page Layout or Picklist configuration before retrying.',
        );
      }
      return output;
    } catch (error) {
      if (error instanceof ContextRuntimeError) throw error;
      throw unsupported(
        'Salesforce UI API could not provide a validated record-action context for this object and action.',
        error,
      );
    }
  }

  private async getRequestConnection(): Promise<Connection> {
    const usernames = [...(await this.orgService.getAllowedOrgUsernames())];
    if (usernames.length !== 1 || !usernames[0]) {
      throw new ContextRuntimeError(
        'MCP_RECORD_ACTION_CONTEXT_INVALID',
        'Record-action context requires exactly one request-scoped USER Salesforce identity.',
      );
    }
    return this.orgService.getConnection(usernames[0]);
  }

  private async resolveCreate(
    connection: Connection,
    apiVersion: string,
    input: RecordActionContextInput,
    objectInfo: ObjectInfo,
    metrics: RequestMetrics,
  ): Promise<ResolvedActionFacts> {
    const recordType = resolveAvailableRecordType(objectInfo, input.recordTypeId ?? objectInfo.defaultRecordTypeId);
    const createDefaults = createDefaultsSchema.parse(
      await requestJson(
        connection,
        withQuery(
          `/services/data/v${encodeURIComponent(apiVersion)}/ui-api/record-defaults/create/${encodeURIComponent(input.objectApiName)}`,
          { recordTypeId: recordType.recordTypeId },
        ),
        metrics,
      ),
    );
    if (!sameSalesforceId(createDefaults.record.recordTypeId, recordType.recordTypeId)) {
      throw new ContextRuntimeError(
        'MCP_RECORD_TYPE_NOT_AVAILABLE',
        'Salesforce Create Defaults resolved a different Record Type than the current USER request.',
      );
    }
    const picklists = await getPicklists(connection, apiVersion, input.objectApiName, recordType.recordTypeId, metrics);
    return {
      recordType,
      layout: createDefaults.layout,
      defaults: createDefaults.record.fields,
      picklists,
      sources: [
        'UI_API_OBJECT_INFO',
        'UI_API_CREATE_DEFAULTS',
        'UI_API_LAYOUT',
        'UI_API_PICKLIST_VALUES_BY_RECORD_TYPE',
      ],
    };
  }

  private async resolveUpdate(
    connection: Connection,
    apiVersion: string,
    input: RecordActionContextInput,
    objectInfo: ObjectInfo,
    metrics: RequestMetrics,
  ): Promise<ResolvedActionFacts> {
    const recordId = input.recordId;
    if (!recordId) {
      throw new ContextRuntimeError('MCP_RECORD_ACTION_CONTEXT_INVALID', 'recordId is required for UPDATE.');
    }
    const record = uiRecordSchema.parse(
      await requestJson(
        connection,
        withQuery(
          `/services/data/v${encodeURIComponent(apiVersion)}/ui-api/records/${encodeURIComponent(recordId)}`,
          { fields: `${input.objectApiName}.Id` },
        ),
        metrics,
      ),
    );
    if (record.apiName.toLocaleLowerCase('en-US') !== input.objectApiName.toLocaleLowerCase('en-US')) {
      throw new ContextRuntimeError(
        'MCP_RECORD_ACTION_CONTEXT_INVALID',
        'recordId belongs to a different Salesforce object than objectApiName.',
      );
    }
    const recordType = resolveAvailableRecordType(objectInfo, record.recordTypeId ?? objectInfo.defaultRecordTypeId);
    if (input.recordTypeId && !sameSalesforceId(input.recordTypeId, recordType.recordTypeId)) {
      throw new ContextRuntimeError(
        'MCP_RECORD_TYPE_NOT_AVAILABLE',
        'The explicit recordTypeId does not match the Record Type derived from recordId. The Tool will not switch Record Type.',
      );
    }
    const layout = layoutSchema.parse(
      await requestJson(
        connection,
        withQuery(
          `/services/data/v${encodeURIComponent(apiVersion)}/ui-api/layout/${encodeURIComponent(input.objectApiName)}`,
          {
            formFactor: 'Large',
            layoutTypes: 'Full',
            modes: 'Edit',
            recordTypeId: recordType.recordTypeId,
          },
        ),
        metrics,
      ),
    );
    const picklists = await getPicklists(connection, apiVersion, input.objectApiName, recordType.recordTypeId, metrics);
    return {
      recordType,
      layout,
      defaults: {},
      picklists,
      sources: [
        'UI_API_OBJECT_INFO',
        'UI_API_RECORD',
        'UI_API_LAYOUT',
        'UI_API_PICKLIST_VALUES_BY_RECORD_TYPE',
      ],
    };
  }
}

type ResolvedActionFacts = Readonly<{
  recordType: z.infer<typeof recordTypeInfoSchema>;
  layout: Layout;
  defaults: Readonly<Record<string, z.infer<typeof uiRecordFieldSchema>>>;
  picklists: PicklistCollection;
  sources: NonNullable<RecordActionContextOutput['coverage']>['sources'];
}>;

async function getPicklists(
  connection: Connection,
  apiVersion: string,
  objectApiName: string,
  recordTypeId: string,
  metrics: RequestMetrics,
): Promise<PicklistCollection> {
  return picklistCollectionSchema.parse(
    await requestJson(
      connection,
      `/services/data/v${encodeURIComponent(apiVersion)}/ui-api/object-info/${encodeURIComponent(objectApiName)}/picklist-values/${encodeURIComponent(recordTypeId)}`,
      metrics,
    ),
  );
}

function buildOutput(
  input: RecordActionContextInput,
  objectInfo: ObjectInfo,
  resolved: ResolvedActionFacts,
  metrics: RequestMetrics,
  durationMs: number,
): RecordActionContextOutput {
  const layoutFacts = collectLayoutFacts(resolved.layout);
  const requiredNames = Object.values(objectInfo.fields)
    .filter((field) => field.required)
    .map((field) => field.apiName)
    .sort(compareText);
  if (requiredNames.length > MAX_FIELDS) {
    throw new ContextRuntimeError(
      'MCP_RECORD_ACTION_CONTEXT_UNSUPPORTED',
      `The object exposes ${requiredNames.length} API-required fields, exceeding the safe ${MAX_FIELDS}-field response bound.`,
    );
  }

  const orderedNames: string[] = [];
  addNames(orderedNames, requiredNames);
  addNames(
    orderedNames,
    [...layoutFacts.entries()]
      .sort((left, right) => left[1].order - right[1].order || compareText(left[0], right[0]))
      .map(([name]) => name),
  );
  addNames(
    orderedNames,
    Object.values(objectInfo.fields)
      .filter((field) => input.action === 'CREATE' ? field.createable : field.updateable)
      .map((field) => field.apiName)
      .sort(compareText),
  );
  addNames(orderedNames, Object.keys(resolved.defaults).sort(compareText));

  const totalVisibleFields = orderedNames.filter((name) => objectInfo.fields[name] !== undefined).length;
  const selectedNames = orderedNames
    .filter((name) => objectInfo.fields[name] !== undefined)
    .slice(0, MAX_FIELDS);
  const fieldsTruncated = totalVisibleFields > selectedNames.length;
  let remainingPicklistValues = MAX_PICKLIST_VALUES_TOTAL;
  let totalPicklistValues = 0;
  let returnedPicklistValues = 0;
  let picklistsTruncated = false;

  const fields = selectedNames.map((name) => {
    const field = objectInfo.fields[name];
    if (!field) throw unsupported(`Object Info omitted selected field ${name}.`);
    const layout = layoutFacts.get(name);
    const defaultEntry = resolved.defaults[name];
    const boundedDefault = boundDefaultValue(defaultEntry?.value);
    const picklistSource = resolved.picklists.picklistFieldValues[name];
    const picklist = picklistSource
      ? boundPicklist(field.controllerName ?? null, picklistSource, remainingPicklistValues)
      : undefined;
    if (picklist) {
      totalPicklistValues += picklist.totalValues;
      returnedPicklistValues += picklist.returnedValues;
      remainingPicklistValues -= picklist.returnedValues;
      picklistsTruncated ||= picklist.truncated;
    }
    return {
      apiName: field.apiName,
      label: field.label,
      dataType: field.dataType,
      apiRequired: field.required,
      layoutMember: layout !== undefined,
      layoutRequired: layout?.required ?? false,
      fieldCreateable: field.createable,
      fieldUpdateable: field.updateable,
      layoutEditableForCreate: layout?.editableForNew ?? null,
      layoutEditableForUpdate: layout?.editableForUpdate ?? null,
      defaultValue: boundedDefault.value,
      defaultValueTruncated: boundedDefault.truncated,
      section: layout?.section ?? null,
      layoutOrder: layout?.order ?? null,
      relationshipName: field.relationshipName ?? null,
      referenceTo: (field.referenceToInfos ?? []).map((reference) => reference.apiName).slice(0, 25),
      ...(picklist ? { picklist } : {}),
    };
  });

  const truncated = fieldsTruncated || picklistsTruncated || fields.some((field) => field.defaultValueTruncated);
  const warnings = [
    'Coverage is the effective Salesforce Page Layout/UI API action context, not a complete Dynamic Forms or Lightning component-visibility evaluation.',
  ];
  if (fieldsTruncated) warnings.push('Non-required fields were truncated; API-required fields were retained.');
  if (picklistsTruncated) warnings.push('Picklist values or dependency indexes were truncated; do not guess omitted values.');
  if (fields.some((field) => field.defaultValueTruncated)) {
    warnings.push('One or more non-scalar or oversized Salesforce default values were omitted explicitly.');
  }

  return {
    success: true,
    executionRole: 'USER',
    objectApiName: objectInfo.apiName,
    action: input.action,
    ...(input.recordId ? { recordId: input.recordId } : {}),
    recordType: {
      id: resolved.recordType.recordTypeId,
      name: resolved.recordType.name,
      defaultForUser: resolved.recordType.defaultRecordTypeMapping,
      available: resolved.recordType.available,
    },
    fields,
    coverage: {
      sources: [...resolved.sources],
      apiCallCount: metrics.apiCallCount,
      durationMs,
      responseBytes: metrics.responseBytes,
      totalVisibleFields,
      returnedFields: fields.length,
      totalPicklistValues,
      returnedPicklistValues,
      truncated,
      dynamicFormsEvaluated: false,
      completeLightningPageEvaluated: false,
      warnings,
    },
  };
}

function collectLayoutFacts(layout: Layout): ReadonlyMap<string, LayoutFact> {
  const facts = new Map<string, LayoutFact>();
  let order = 0;
  for (const section of layout.sections) {
    for (const row of section.layoutRows) {
      for (const item of row.layoutItems) {
        for (const component of item.layoutComponents) {
          if (component.componentType !== 'Field' || !component.apiName) continue;
          if (!facts.has(component.apiName)) {
            facts.set(component.apiName, {
              required: item.required,
              editableForNew: item.editableForNew,
              editableForUpdate: item.editableForUpdate,
              section: section.heading ?? null,
              order,
            });
          }
          order += 1;
        }
      }
    }
  }
  return facts;
}

function resolveAvailableRecordType(objectInfo: ObjectInfo, candidate: string | null | undefined): z.infer<typeof recordTypeInfoSchema> {
  if (!candidate) {
    throw new ContextRuntimeError(
      'MCP_RECORD_TYPE_NOT_AVAILABLE',
      'Salesforce UI API did not return an effective default Record Type for the current USER.',
    );
  }
  const recordType = Object.values(objectInfo.recordTypeInfos).find((entry) => sameSalesforceId(entry.recordTypeId, candidate));
  if (!recordType || !recordType.available) {
    throw new ContextRuntimeError(
      'MCP_RECORD_TYPE_NOT_AVAILABLE',
      'The requested Record Type is not available to the current Salesforce USER.',
    );
  }
  return recordType;
}

function boundPicklist(
  controllerName: string | null,
  source: z.infer<typeof picklistFieldSchema>,
  globalRemaining: number,
): {
  controllerName: string | null;
  controllerValues: Record<string, number>;
  values: Array<{ label: string; value: string; default: boolean; validFor: number[] }>;
  totalValues: number;
  returnedValues: number;
  truncated: boolean;
} {
  const controllerEntries = Object.entries(source.controllerValues).sort(([left], [right]) => compareText(left, right));
  const controllerValues = Object.fromEntries(controllerEntries.slice(0, MAX_CONTROLLER_VALUES_PER_FIELD));
  const allowed = Math.max(0, Math.min(MAX_PICKLIST_VALUES_PER_FIELD, globalRemaining));
  const values = source.values.slice(0, allowed).map((entry) => ({
    label: entry.label,
    value: entry.value,
    default: source.defaultValue?.value === entry.value,
    validFor: entry.validFor.slice(0, MAX_VALID_FOR_PER_VALUE),
  }));
  const dependencyTruncated = source.values
    .slice(0, allowed)
    .some((entry) => entry.validFor.length > MAX_VALID_FOR_PER_VALUE);
  return {
    controllerName,
    controllerValues,
    values,
    totalValues: source.values.length,
    returnedValues: values.length,
    truncated:
      source.values.length > values.length ||
      controllerEntries.length > MAX_CONTROLLER_VALUES_PER_FIELD ||
      dependencyTruncated,
  };
}

function boundDefaultValue(value: unknown): BoundedDefault {
  if (value === undefined || value === null) return { value: null, truncated: false };
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_DEFAULT_VALUE_BYTES) {
      return { value: null, truncated: true };
    }
    return { value: JSON.parse(serialized) as unknown, truncated: false };
  } catch {
    return { value: null, truncated: true };
  }
}

async function requestJson(connection: Connection, url: string, metrics: RequestMetrics): Promise<unknown> {
  const result = await connection.request<unknown>({ method: 'GET', url });
  metrics.apiCallCount += 1;
  metrics.responseBytes += Buffer.byteLength(JSON.stringify(result), 'utf8');
  return result;
}

function withQuery(base: string, values: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams(values);
  return `${base}?${params.toString()}`;
}

function sameSalesforceId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right || left.length < 15 || right.length < 15) return false;
  return left.slice(0, 15) === right.slice(0, 15);
}

function addNames(target: string[], names: readonly string[]): void {
  const normalized = new Set(target.map((name) => name.toLocaleLowerCase('en-US')));
  for (const name of names) {
    const key = name.toLocaleLowerCase('en-US');
    if (normalized.has(key)) continue;
    target.push(name);
    normalized.add(key);
  }
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en-US');
}

function unsupported(message: string, cause?: unknown): ContextRuntimeError {
  return new ContextRuntimeError(
    'MCP_RECORD_ACTION_CONTEXT_UNSUPPORTED',
    message,
    cause === undefined ? {} : { cause },
  );
}

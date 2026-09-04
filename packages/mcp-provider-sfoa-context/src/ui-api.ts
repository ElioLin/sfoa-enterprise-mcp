import type { Connection } from '@salesforce/core';
import { z } from 'zod';

/**
 * Shared Salesforce UI API schemas, types, and pure request helpers used by the
 * record-action context executor and the record-display context executor.
 *
 * Both executors read the same deterministic REST UI API shapes (Object Info and
 * Layout objects). Keeping the zod schemas and request plumbing in one module
 * avoids a second Layout parser and keeps URL/identity handling identical.
 */

export const recordTypeInfoSchema = z
  .object({
    recordTypeId: z.string(),
    name: z.string(),
    available: z.boolean(),
    defaultRecordTypeMapping: z.boolean(),
  })
  .passthrough();

export const objectFieldSchema = z
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

export const objectInfoSchema = z
  .object({
    apiName: z.string(),
    label: z.string(),
    labelPlural: z.string(),
    defaultRecordTypeId: z.string().nullable(),
    fields: z.record(objectFieldSchema),
    // Salesforce UI API Object Info declares the record display (name) fields as a
    // top-level `nameFields: string[]`. It is the authoritative source for READ
    // name/display fields: the runtime never guesses a field merely because it is
    // called `Name` or has a `name` dataType. Older API forms may omit the key;
    // consumers then report NONE_DECLARED and let the Agent fall back to layout
    // evidence or the user question instead of inventing a display field.
    nameFields: z.array(z.string()).optional(),
    recordTypeInfos: z.record(recordTypeInfoSchema),
  })
  .passthrough();

export const layoutComponentSchema = z
  .object({
    apiName: z.string().nullable().optional(),
    componentType: z.string(),
  })
  .passthrough();

export const layoutItemSchema = z
  .object({
    editableForNew: z.boolean(),
    editableForUpdate: z.boolean(),
    required: z.boolean(),
    layoutComponents: z.array(layoutComponentSchema),
  })
  .passthrough();

export const layoutSchema = z
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

export const uiRecordFieldSchema = z.object({ value: z.unknown().nullable().optional() }).passthrough();
export const uiRecordSchema = z
  .object({
    apiName: z.string(),
    recordTypeId: z.string().nullable(),
    fields: z.record(uiRecordFieldSchema),
  })
  .passthrough();

export const createDefaultsSchema = z
  .object({
    layout: layoutSchema,
    record: uiRecordSchema,
  })
  .passthrough();

export const picklistValueSchema = z
  .object({
    label: z.string(),
    value: z.string(),
    validFor: z.array(z.number().int().nonnegative()).optional().default([]),
  })
  .passthrough();

export const picklistFieldSchema = z
  .object({
    controllerValues: z.record(z.number().int().nonnegative()).optional().default({}),
    defaultValue: z.object({ value: z.string() }).passthrough().nullable().optional(),
    values: z.array(picklistValueSchema),
  })
  .passthrough();

export const picklistCollectionSchema = z
  .object({
    picklistFieldValues: z.record(picklistFieldSchema),
  })
  .passthrough();

export type ObjectInfo = z.infer<typeof objectInfoSchema>;
export type Layout = z.infer<typeof layoutSchema>;
export type UiRecord = z.infer<typeof uiRecordSchema>;
export type PicklistCollection = z.infer<typeof picklistCollectionSchema>;
export type RecordTypeInfo = z.infer<typeof recordTypeInfoSchema>;

export type RequestMetrics = {
  apiCallCount: number;
  responseBytes: number;
};

export async function requestJson(connection: Connection, url: string, metrics: RequestMetrics): Promise<unknown> {
  const result = await connection.request<unknown>({ method: 'GET', url });
  metrics.apiCallCount += 1;
  metrics.responseBytes += Buffer.byteLength(JSON.stringify(result), 'utf8');
  return result;
}

export function withQuery(base: string, values: Readonly<Record<string, string>>): string {
  const params = new URLSearchParams(values);
  return `${base}?${params.toString()}`;
}

export function sameSalesforceId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right || left.length < 15 || right.length < 15) return false;
  return left.slice(0, 15) === right.slice(0, 15);
}

export function addNames(target: string[], names: readonly string[]): void {
  const normalized = new Set(target.map((name) => name.toLocaleLowerCase('en-US')));
  for (const name of names) {
    const key = name.toLocaleLowerCase('en-US');
    if (normalized.has(key)) continue;
    target.push(name);
    normalized.add(key);
  }
}

export function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en-US');
}

export type LayoutFact = Readonly<{
  required: boolean;
  editableForNew: boolean;
  editableForUpdate: boolean;
  section: string | null;
  order: number;
}>;

/** Ordered, default-first list of every Record Type Salesforce reports for the object. */
export function listRecordTypes(objectInfo: ObjectInfo): readonly RecordTypeInfo[] {
  return Object.values(objectInfo.recordTypeInfos)
    .sort((left, right) =>
      (left.defaultRecordTypeMapping === right.defaultRecordTypeMapping ? 0 : left.defaultRecordTypeMapping ? -1 : 1)
      || compareText(left.name, right.name));
}

/** Record Types the current USER may actually use. */
export function listAvailableRecordTypes(objectInfo: ObjectInfo): readonly RecordTypeInfo[] {
  return listRecordTypes(objectInfo).filter((entry) => entry.available);
}

export function toRecordTypeDescriptor(recordType: RecordTypeInfo): Readonly<{
  id: string;
  name: string;
  defaultForUser: boolean;
  available: boolean;
}> {
  return {
    id: recordType.recordTypeId,
    name: recordType.name,
    defaultForUser: recordType.defaultRecordTypeMapping,
    available: recordType.available,
  };
}

/** Depth-first, deduplicated traversal of a UI API Layout object into per-field facts. */
export function collectLayoutFacts(layout: Layout): ReadonlyMap<string, LayoutFact> {
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

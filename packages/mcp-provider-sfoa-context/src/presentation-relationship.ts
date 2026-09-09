import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import { z } from 'zod';
import { boundedRead } from './create-initial-state.js';
import { asObject } from './flexipage-parser.js';
import { objectInfoSchema, picklistFieldSchema, sameSalesforceId } from './ui-api.js';

const apiName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u).max(128);
const recordTypeId = z.string().regex(/^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/u);
export const displayValuesInputSchema = z.object({ objectApiName: apiName,
  values: z.array(z.object({ fieldApiName: apiName, rawValue: z.string().max(4096).nullable(),
    recordTypeId: recordTypeId.optional() }).strict()).min(1).max(200).superRefine((values, context) => {
      if (Buffer.byteLength(JSON.stringify(values)) > 65536) context.addIssue({ code: z.ZodIssueCode.custom,
        message: 'Display input exceeds 64 KiB; split into bounded calls.' });
    }) }).strict();
const displayPart = z.object({ rawValue: z.string().max(4096), displayValue: z.string().max(4096),
  resolutionStatus: z.enum(['RESOLVED', 'UNRESOLVED']) }).strict();
export const displayValuesOutputSchema = z.object({ objectApiName: apiName, truncated: z.boolean(),
  results: z.array(z.object({ index: z.number().int(), fieldApiName: apiName,
    recordTypeId: recordTypeId.nullable(), rawValue: z.string().max(4096).nullable(),
    displayValue: z.string().max(8192).nullable(), resolutionStatus: z.enum(['RESOLVED', 'PARTIAL', 'UNRESOLVED']),
    reason: z.string().optional(), items: z.array(displayPart).max(200).optional() }).strict()).max(200),
  apiCallCount: z.number().int(),
}).strict();
export const relationshipInputSchema = z.object({ rootObjectApiName: apiName, operation: z.literal('CREATE') }).strict();
export const relationshipOutputSchema = z.object({ rootObjectApiName: apiName, rootObjectLabel: z.string(),
  relationships: z.array(z.object({ childObjectApiName: apiName, childObjectLabel: z.string(),
    relationshipField: apiName, relationshipFieldLabel: z.string(), relationshipName: z.string().nullable(),
    createCapability: z.literal(true), cascadeDelete: z.boolean(),
  }).strict()).max(20), truncated: z.boolean(), resolutionStatus: z.enum(['RESOLVED', 'PARTIAL']),
  apiCallCount: z.number().int(), warnings: z.array(z.string()).max(25),
}).strict();

async function currentConnection(service: OrgService): Promise<Connection> {
  const names = await service.getAllowedOrgUsernames();
  const [name] = names;
  if (names.size !== 1 || !name) throw new Error('Current USER identity is unavailable.');
  return service.getConnection(name);
}

export class PresentationRelationshipExecutor {
  public constructor(private readonly service: OrgService, private readonly createObjects: readonly string[] = []) {}

  public async display(input: z.infer<typeof displayValuesInputSchema>): Promise<z.infer<typeof displayValuesOutputSchema>> {
    const connection = await currentConnection(this.service);
    const deadline = performance.now() + 5000;
    const base = `/services/data/v${connection.getApiVersion()}/ui-api/object-info/${input.objectApiName}`;
    let apiCallCount = 0;
    const read = async (url: string) => boundedRead(async () => {
      apiCallCount++;
      const response = await connection.request<unknown>({ method: 'GET', url });
      if (Buffer.byteLength(JSON.stringify(response)) > 1048576) throw new Error('METADATA_RESPONSE_BOUND');
      return response;
    }, deadline);
    let info: z.infer<typeof objectInfoSchema>;
    try { info = objectInfoSchema.parse(await read(base)); }
    catch {
      return { objectApiName: input.objectApiName, truncated: false, apiCallCount,
        results: input.values.map((item, index) => ({ ...item, index,
          recordTypeId: item.recordTypeId ?? null, displayValue: item.rawValue,
          resolutionStatus: 'UNRESOLVED', reason: 'OBJECT_METADATA_UNAVAILABLE_OR_BOUND' })) };
    }
    const cache = new Map<string, Map<string, string> | null>();
    const results: z.infer<typeof displayValuesOutputSchema>['results'] = [];
    let truncated = false;
    for (const [index, item] of input.values.entries()) {
      const rt = item.recordTypeId ?? info.defaultRecordTypeId;
      const field = info.fields[item.fieldApiName];
      const supported = field && ['Picklist', 'MultiPicklist', 'Multipicklist'].includes(field.dataType);
      const key = `${rt}/${item.fieldApiName}`;
      let reason: string | undefined;
      if (supported && rt && Object.values(info.recordTypeInfos).some((entry) => sameSalesforceId(entry.recordTypeId, rt))) {
        if (!cache.has(key) && cache.size < 25) {
          try {
            const metadata = picklistFieldSchema.parse(await read(`${base}/picklist-values/${rt}/${item.fieldApiName}`));
            cache.set(key, new Map(metadata.values.filter((value) => value.label.length <= 512).map((value) => [value.value, value.label])));
          } catch { cache.set(key, null); reason = 'METADATA_UNAVAILABLE_OR_BOUND'; }
        } else if (!cache.has(key)) { truncated = true; reason = 'METADATA_GROUP_BOUND'; }
      } else reason = 'FIELD_OR_RECORD_TYPE_UNRESOLVED';
      const labels = cache.get(key);
      const rawParts = item.rawValue === null ? [] : supported && field.dataType !== 'Picklist' ? item.rawValue.split(';') : [item.rawValue];
      const parts = rawParts.slice(0, 200).map((rawValue) => ({ rawValue, displayValue: labels?.get(rawValue) ?? rawValue,
        resolutionStatus: labels?.has(rawValue) ? 'RESOLVED' as const : 'UNRESOLVED' as const }));
      const resolved = parts.filter((part) => part.resolutionStatus === 'RESOLVED').length;
      const display = item.rawValue === null ? null : parts.map((part) => part.displayValue).join(';');
      const bounded = rawParts.length > 200 || (display?.length ?? 0) > 8192;
      truncated ||= bounded;
      results.push({ index, fieldApiName: item.fieldApiName, recordTypeId: rt, rawValue: item.rawValue,
        displayValue: bounded ? item.rawValue : display,
        resolutionStatus: bounded ? 'UNRESOLVED' : item.rawValue === null && supported ? 'RESOLVED'
          : resolved === parts.length && !!labels ? 'RESOLVED' : resolved ? 'PARTIAL' : 'UNRESOLVED',
        ...((reason || !labels) ? { reason: reason ?? 'METADATA_UNAVAILABLE_OR_BOUND' } : {}),
        ...(parts.length && !bounded ? { items: parts } : {}) });
    }
    // Keep every raw value and index; if labels would exceed the presentation
    // budget, return explicit unresolved raw fallback rather than silently drop rows.
    if (Buffer.byteLength(JSON.stringify(results)) > 262144) {
      return { objectApiName: input.objectApiName, truncated: true, apiCallCount,
        results: results.map(({ items: _items, ...row }) => ({ ...row, displayValue: row.rawValue,
          resolutionStatus: 'UNRESOLVED', reason: 'DISPLAY_OUTPUT_BOUND' })) };
    }
    return { objectApiName: input.objectApiName, results, truncated, apiCallCount };
  }

  public async relationships(input: z.infer<typeof relationshipInputSchema>): Promise<z.infer<typeof relationshipOutputSchema>> {
    const connection = await currentConnection(this.service);
    const deadline = performance.now() + 5000;
    let apiCallCount = 0;
    const describe = (name: string) => boundedRead(async () => {
      apiCallCount++;
      const value = await connection.sobject(name).describe();
      if (Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new Error('METADATA_RESPONSE_BOUND');
      return value;
    }, deadline);
    const root = await describe(input.rootObjectApiName);
    const allowed = new Set(this.createObjects.map((name) => name.toLowerCase()));
    const candidates = root.childRelationships.filter((relation) => allowed.has(relation.childSObject.toLowerCase())
      && apiName.safeParse(relation.childSObject).success && apiName.safeParse(relation.field).success);
    const relationships: z.infer<typeof relationshipOutputSchema>['relationships'] = [];
    const warnings: string[] = [];
    const cache = new Map<string, Awaited<ReturnType<typeof describe>>>();
    for (const relation of candidates.slice(0, 20)) {
      try {
        let child = cache.get(relation.childSObject);
        if (!child) { child = await describe(relation.childSObject); cache.set(relation.childSObject, child); }
        const field = child.fields.find((entry) => entry.name === relation.field);
        if (!child.createable || !field?.createable || !field.referenceTo?.includes(input.rootObjectApiName)) continue;
        relationships.push({ childObjectApiName: child.name, childObjectLabel: child.label,
          relationshipField: field.name, relationshipFieldLabel: field.label,
          relationshipName: relation.relationshipName ?? null, createCapability: true,
          cascadeDelete: asObject(relation).cascadeDelete === true });
      } catch { warnings.push('A governed child relationship could not be resolved within the USER read budget.'); }
    }
    const truncated = candidates.length > 20;
    return { rootObjectApiName: root.name, rootObjectLabel: root.label, relationships, truncated,
      resolutionStatus: truncated || warnings.length ? 'PARTIAL' : 'RESOLVED', apiCallCount, warnings };
  }
}

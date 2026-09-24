import type { OrgService } from '@salesforce/mcp-provider-api';
import { resolveRequestConnection } from './org-connection.js';
import { trimToByteBudget, DATA_MAX_RESPONSE_BYTES } from './response-budget.js';
import { mapDataFailure } from './salesforce-errors.js';
import {
  DESCRIBE_SOBJECT_DEFAULT_FIELD_LIMIT,
  DESCRIBE_SOBJECT_MAX_CHILD_RELATIONSHIPS,
  DESCRIBE_SOBJECT_MAX_FIELD_LIMIT,
  DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES,
  type ChildRelationshipDescriptor,
  type DescribeSobjectInput,
  type DescribeSobjectOutput,
  type FieldDescriptor,
} from './schemas.js';
import { readArray, readBoolean, readField, readIdentifier, readString } from './list-sobjects-executor.js';

/**
 * Reads one object's schema facts through the official jsforce `describe()` surface.
 *
 * This is the deterministic self-repair path for a query that failed with
 * `INVALID_FIELD`/`INVALID_TYPE`: the Agent reads the real field names, types, references
 * and picklists instead of guessing, and the answer always states whether the field list
 * it received is complete. It never queries business records and never changes state.
 */
export class DescribeSobjectExecutor {
  public constructor(private readonly orgService: OrgService) {}

  public async execute(input: DescribeSobjectInput): Promise<DescribeSobjectOutput> {
    const includeFields = input.includeFields !== false;
    const fieldLimit = input.fieldLimit ?? DESCRIBE_SOBJECT_DEFAULT_FIELD_LIMIT;
    try {
      const connection = await resolveRequestConnection(this.orgService);
      const describe = await connection.describe(input.objectApiName);
      const objectApiName = readIdentifier(readField(describe, 'name')) ?? input.objectApiName;
      const allFields = includeFields ? readFields(readField(describe, 'fields')) : [];
      const allChildren = readChildRelationships(readField(describe, 'childRelationships'));
      const children = allChildren.slice(0, DESCRIBE_SOBJECT_MAX_CHILD_RELATIONSHIPS);

      // `build` renders the complete response for a candidate field prefix, including the
      // truncation flags and the hint, so the byte budget measures exactly what the Agent
      // receives. The truncation facts are functions of the prefix length, which is why the
      // same closure both drives the binary search and produces the final answer: measuring
      // a payload without its own hint would let the hint push the response over budget.
      const build = (kept: readonly FieldDescriptor[]): DescribeSobjectOutput => {
        const returnedFields = kept.length;
        // The prefix the field limit alone would allow; anything shorter was cut by the budget.
        const limitCapped = Math.min(fieldLimit, allFields.length);
        const budgetCut = includeFields && returnedFields < limitCapped;
        const fieldsTruncated = includeFields && returnedFields < allFields.length;
        const childrenTruncated = children.length < allChildren.length;
        const picklistTruncatedFields = kept.filter((field) => field.picklistValuesTruncated).length;
        const truncated = fieldsTruncated || childrenTruncated || picklistTruncatedFields > 0;
        const notes: string[] = [];
        if (fieldsTruncated) {
          notes.push(`${allFields.length} fields are declared and ${returnedFields} are returned (fieldLimit=${fieldLimit})`);
        }
        if (budgetCut) {
          notes.push(`the field list was cut to fit the ${DATA_MAX_RESPONSE_BYTES}-byte response budget`);
        }
        if (picklistTruncatedFields > 0) {
          notes.push(`${picklistTruncatedFields} field(s) declare more than ${DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES} picklist values and only the first ${DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES} are returned`);
        }
        if (childrenTruncated) {
          notes.push(`${allChildren.length} child relationships are declared and ${children.length} are returned`);
        }
        return {
          success: true,
          executionRole: 'USER',
          api: 'REST',
          objectApiName,
          label: readString(readField(describe, 'label')) ?? objectApiName,
          labelPlural: readString(readField(describe, 'labelPlural')) ?? objectApiName,
          keyPrefix: readIdentifier(readField(describe, 'keyPrefix')),
          custom: readBoolean(readField(describe, 'custom')),
          queryable: readBoolean(readField(describe, 'queryable')),
          createable: readBoolean(readField(describe, 'createable')),
          updateable: readBoolean(readField(describe, 'updateable')),
          searchable: readBoolean(readField(describe, 'searchable')),
          ...(includeFields ? { fields: [...kept] } : {}),
          childRelationships: [...children],
          ...(includeFields ? { totalFields: allFields.length, returnedFields } : {}),
          totalChildRelationships: allChildren.length,
          returnedChildRelationships: children.length,
          fieldsIncluded: includeFields,
          truncated,
          ...(truncated
            ? {
                hint: `Incomplete describe of ${objectApiName}: ${notes.join('; ')}. `
                  + `Next: raise fieldLimit up to ${DESCRIBE_SOBJECT_MAX_FIELD_LIMIT} for more fields, and read a child object's own schema directly when a child relationship is what you need.`,
              }
            : {}),
        };
      };

      // A single field carrying a very wide picklist can outweigh a thousand small ones, so
      // the field limit alone is not a size guarantee; the budget pass is what makes the
      // returned count honest when it is the binding constraint.
      const budgeted = trimToByteBudget(allFields.slice(0, fieldLimit), DATA_MAX_RESPONSE_BYTES, build);
      return build(budgeted.kept);
    } catch (error) {
      throw mapDataFailure(error, {
        fallbackCode: 'MCP_SOBJECT_DESCRIBE_FAILED',
        fallbackMessage: `Salesforce could not describe object ${input.objectApiName} for this request.`,
        fallbackSuggestion: 'Retry once; if it fails again, use list_sobjects to confirm the object exists for this identity.',
        rules: [
          {
            codes: ['INVALID_TYPE', 'NOT_FOUND', 'OBJECT_NOT_FOUND', 'INVALID_SOBJECT', 'INVALID_ENTITY'],
            code: 'MCP_SOBJECT_NOT_FOUND',
            message: `Salesforce does not expose an object named ${input.objectApiName} to this request's identity.`,
            suggestion: 'Verify the API name: call list_sobjects (optionally with a filter prefix) to read the exact object API names, then retry describe_sobject. Custom objects end with __c.',
          },
          {
            codes: ['INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_OR_READONLY', 'INSUFFICIENT_PRIVILEGES', 'API_DISABLED_FOR_ORG'],
            code: 'MCP_SOBJECT_ACCESS_DENIED',
            message: `The Salesforce user for this request may not read the schema of ${input.objectApiName}.`,
            suggestion: 'Report the missing Salesforce permission instead of retrying; describe cannot succeed for this identity.',
          },
        ],
      });
    }
  }
}

export function readFields(value: unknown): FieldDescriptor[] {
  const entries = readArray(value);
  const fields: FieldDescriptor[] = [];
  for (const entry of entries) {
    const apiName = readIdentifier(readField(entry, 'name'));
    if (apiName === null) continue;
    const rawPicklist = readArray(readField(entry, 'picklistValues'));
    const picklistValues = readPicklistValues(rawPicklist, DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES);
    fields.push(Object.freeze({
      apiName,
      label: readString(readField(entry, 'label')) ?? apiName,
      type: readIdentifier(readField(entry, 'type')) ?? 'unknown',
      nillable: readBoolean(readField(entry, 'nillable')),
      createable: readBoolean(readField(entry, 'createable')),
      updateable: readBoolean(readField(entry, 'updateable')),
      filterable: readBoolean(readField(entry, 'filterable')),
      sortable: readBoolean(readField(entry, 'sortable')),
      custom: readBoolean(readField(entry, 'custom')),
      deprecatedAndHidden: readBoolean(readField(entry, 'deprecatedAndHidden')),
      referenceTo: readStringArray(readField(entry, 'referenceTo')),
      relationshipName: readIdentifier(readField(entry, 'relationshipName')),
      picklistValues,
      picklistValuesTruncated: rawPicklist.length > picklistValues.length,
    }));
  }
  return fields;
}

export function readChildRelationships(value: unknown): ChildRelationshipDescriptor[] {
  const entries = readArray(value);
  const relationships: ChildRelationshipDescriptor[] = [];
  for (const entry of entries) {
    const childSObject = readIdentifier(readField(entry, 'childSObject'));
    const field = readIdentifier(readField(entry, 'field'));
    if (childSObject === null || field === null) continue;
    relationships.push(Object.freeze({
      childSObject,
      field,
      relationshipName: readIdentifier(readField(entry, 'relationshipName')),
      cascadeDelete: readBoolean(readField(entry, 'cascadeDelete')),
      restrictedDelete: readBoolean(readField(entry, 'restrictedDelete')),
      deprecatedAndHidden: readBoolean(readField(entry, 'deprecatedAndHidden')),
    }));
  }
  return relationships;
}

function readPicklistValues(
  value: readonly unknown[],
  maxValues: number,
): ReadonlyArray<Readonly<{ value: string; label: string; active: boolean; defaultValue: boolean }>> {
  const values: Array<Readonly<{ value: string; label: string; active: boolean; defaultValue: boolean }>> = [];
  for (const entry of value.slice(0, maxValues)) {
    const picklistValue = readIdentifier(readField(entry, 'value'));
    if (picklistValue === null) continue;
    values.push(Object.freeze({
      value: picklistValue,
      label: readString(readField(entry, 'label')) ?? picklistValue,
      // Salesforce reports `active` as a string ('true'/'false') on some API versions and a
      // boolean on others; only an explicit true/`'true'` counts as active.
      active: readActiveFlag(readField(entry, 'active')),
      defaultValue: readBoolean(readField(entry, 'defaultValue')),
    }));
  }
  return Object.freeze(values);
}

function readActiveFlag(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.toLocaleLowerCase('en-US') === 'true');
}

function readStringArray(value: unknown): string[] {
  // Only used for `referenceTo`, so every entry is an object API name: a target the Agent
  // cannot name is dropped rather than listed.
  return readArray(value).flatMap((entry) => {
    const text = readIdentifier(entry);
    return text === null ? [] : [text];
  });
}

import type { OrgService } from '@salesforce/mcp-provider-api';
import { resolveRequestConnection } from './org-connection.js';
import { mapDataFailure } from './salesforce-errors.js';
import {
  LIST_SOBJECTS_DEFAULT_LIMIT,
  type ListSobjectsInput,
  type ListSobjectsOutput,
  type SobjectSummary,
} from './schemas.js';

/**
 * Reads the org's object inventory through the official jsforce `describeGlobal()`
 * surface and returns a bounded, prefix-filtered slice.
 *
 * This is the Agent's self-service entry point for "what objects exist here": it never
 * queries business records, never changes state, and always reports how many objects
 * matched so a truncated answer can never be mistaken for the full inventory.
 */
export class ListSobjectsExecutor {
  public constructor(private readonly orgService: OrgService) {}

  public async execute(input: ListSobjectsInput): Promise<ListSobjectsOutput> {
    const limit = input.limit ?? LIST_SOBJECTS_DEFAULT_LIMIT;
    try {
      const connection = await resolveRequestConnection(this.orgService);
      const global = await connection.describeGlobal();
      const all = readGlobalSobjects(global);
      const prefix = input.filter?.toLocaleLowerCase('en-US');
      const matched = all
        .filter((entry) => prefix === undefined || entry.name.toLocaleLowerCase('en-US').startsWith(prefix))
        .sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
      const returned = matched.slice(0, limit);
      const truncated = matched.length > returned.length;
      return {
        success: true,
        executionRole: 'USER',
        api: 'REST',
        sobjects: returned,
        totalCount: matched.length,
        returnedCount: returned.length,
        truncated,
        ...(truncated
          ? {
              hint: `${matched.length} objects matched but only ${returned.length} were returned (limit=${limit}, maximum 200). `
                + 'Narrow the filter prefix to reach the rest, or raise limit up to 200.',
            }
          : {}),
      };
    } catch (error) {
      throw mapDataFailure(error, {
        fallbackCode: 'MCP_SOBJECT_LIST_FAILED',
        fallbackMessage: 'Salesforce could not return the org object inventory for this request.',
        fallbackSuggestion: 'Retry once; if it fails again the request identity or org API access needs to be checked.',
        rules: [
          {
            codes: ['INSUFFICIENT_ACCESS', 'INSUFFICIENT_ACCESS_OR_READONLY', 'INSUFFICIENT_PRIVILEGES', 'API_DISABLED_FOR_ORG'],
            code: 'MCP_SOBJECT_ACCESS_DENIED',
            message: 'The Salesforce user for this request may not read the org object inventory.',
            suggestion: 'Report the missing Salesforce permission instead of retrying; the object list is not available to this identity.',
          },
        ],
      });
    }
  }
}

/**
 * Validates the untrusted `describeGlobal()` payload. Entries without a usable API name
 * are dropped rather than surfaced: an object the Agent cannot name cannot be described
 * or queried, and reporting it would invite a call that must fail.
 */
export function readGlobalSobjects(value: unknown): SobjectSummary[] {
  const entries = readArray(readField(value, 'sobjects'));
  const summaries: SobjectSummary[] = [];
  for (const entry of entries) {
    const name = readIdentifier(readField(entry, 'name'));
    if (name === null) continue;
    summaries.push(Object.freeze({
      name,
      label: readString(readField(entry, 'label')) ?? name,
      labelPlural: readString(readField(entry, 'labelPlural')) ?? name,
      keyPrefix: readIdentifier(readField(entry, 'keyPrefix')),
      custom: readBoolean(readField(entry, 'custom')),
      queryable: readBoolean(readField(entry, 'queryable')),
      createable: readBoolean(readField(entry, 'createable')),
      updateable: readBoolean(readField(entry, 'updateable')),
      searchable: readBoolean(readField(entry, 'searchable')),
    }));
  }
  return summaries;
}

export function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Reads a display fact (a label, or a picklist label) from a Salesforce payload **verbatim**.
 *
 * The value must not be trimmed. An org's picklist label may legitimately carry surrounding
 * whitespace — a live `describe()` of Account returned `"Z1 不检查信用 "` — and a picklist
 * `value` may too. Trimming would return a string the org never declared, so an Agent matching
 * labels or writing a picklist value would be working from a fact that does not exist. Only an
 * empty string is treated as absent, which is what the `?? fallback` call sites rely on.
 */
export function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.length === 0 ? null : value;
}

/**
 * Reads an identifier — an object, field, relationship or picklist API name — from a Salesforce
 * payload, reported verbatim, or `null` when there is none to report.
 *
 * Identifiers are Tokens the Agent hands straight back to another call, so they are held to a
 * stricter rule than a display fact: text that is empty *or whitespace only* is not an
 * identifier at all. Reporting `"   "` as an object name would advertise something the Agent
 * cannot describe or query, so such a payload entry is dropped rather than surfaced.
 */
export function readIdentifier(value: unknown): string | null {
  const text = readString(value);
  return text === null || text.trim().length === 0 ? null : text;
}

export function readBoolean(value: unknown): boolean {
  return value === true;
}

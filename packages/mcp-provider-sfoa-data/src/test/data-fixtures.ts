import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';

export type ConnectionOperation =
  | 'describeGlobal'
  | 'describe'
  | 'query'
  | 'queryMore'
  | 'toolingQuery'
  | 'toolingQueryMore'
  | 'search';

export type ConnectionCall = Readonly<{ operation: ConnectionOperation; argument?: string }>;

export type DataFixtureOptions = Readonly<{
  /** Allowed org usernames for the request. Defaults to exactly one USER. */
  usernames?: readonly string[];
  /** Answers a Salesforce call, or throws to simulate a provider failure. */
  handler?: (operation: ConnectionOperation, argument?: string) => unknown;
}>;

export type DataFixture = Readonly<{
  orgService: OrgService;
  calls: ConnectionCall[];
}>;

/**
 * Builds a request-scoped `OrgService` whose Connection records every call, so a test can
 * assert both the returned facts and which Salesforce surface the executor used.
 */
export function createFixture(options: DataFixtureOptions = {}): DataFixture {
  const usernames = options.usernames ?? ['user@example.test'];
  const calls: ConnectionCall[] = [];
  const handler = options.handler
    ?? (() => {
      throw new Error('Unexpected Salesforce call');
    });
  const connection = {
    describeGlobal: async () => {
      calls.push({ operation: 'describeGlobal' });
      return handler('describeGlobal');
    },
    describe: async (name: string) => {
      calls.push({ operation: 'describe', argument: name });
      return handler('describe', name);
    },
    query: async (statement: string) => {
      calls.push({ operation: 'query', argument: statement });
      return handler('query', statement);
    },
    queryMore: async (cursor: string) => {
      calls.push({ operation: 'queryMore', argument: cursor });
      return handler('queryMore', cursor);
    },
    tooling: {
      query: async (statement: string) => {
        calls.push({ operation: 'toolingQuery', argument: statement });
        return handler('toolingQuery', statement);
      },
      queryMore: async (cursor: string) => {
        calls.push({ operation: 'toolingQueryMore', argument: cursor });
        return handler('toolingQueryMore', cursor);
      },
    },
    search: async (statement: string) => {
      calls.push({ operation: 'search', argument: statement });
      return handler('search', statement);
    },
  } as unknown as Connection;
  const orgService = {
    getAllowedOrgUsernames: async () => new Set(usernames),
    getConnection: async () => connection,
  } as unknown as OrgService;
  return { orgService, calls };
}

export function sobjectEntry(
  name: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    name,
    label: name,
    labelPlural: `${name}s`,
    keyPrefix: '001',
    custom: false,
    queryable: true,
    createable: true,
    updateable: true,
    searchable: true,
    ...overrides,
  };
}

export function describeGlobalPayload(entries: readonly unknown[]): Record<string, unknown> {
  return { sobjects: entries, encoding: 'UTF-8', maxBatchSize: 200 };
}

export function fieldEntry(
  name: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    name,
    label: name,
    type: 'string',
    nillable: true,
    createable: true,
    updateable: true,
    filterable: true,
    sortable: true,
    custom: false,
    deprecatedAndHidden: false,
    referenceTo: [],
    relationshipName: null,
    picklistValues: [],
    ...overrides,
  };
}

export function childRelationship(
  childSObject: string,
  field: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    childSObject,
    field,
    relationshipName: childSObject,
    cascadeDelete: false,
    restrictedDelete: false,
    deprecatedAndHidden: false,
    ...overrides,
  };
}

export function describePayload(
  name: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    name,
    label: name,
    labelPlural: `${name}s`,
    keyPrefix: '001',
    custom: false,
    queryable: true,
    createable: true,
    updateable: true,
    searchable: true,
    fields: [],
    childRelationships: [],
    ...overrides,
  };
}

/** A jsforce-shaped provider failure: `errorCode` plus `message`, as the SDK throws it. */
export function salesforceError(code: string, message: string): Error {
  return Object.assign(new Error(message), { errorCode: code });
}

/**
 * A jsforce-shaped query batch. `totalSize` defaults to the batch length and `done` to true,
 * so a test states only the fact it is actually exercising — normally `nextRecordsUrl`, which
 * is what makes the batch a non-final one.
 */
export function queryBatch(
  records: readonly unknown[],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { done: true, totalSize: records.length, records, ...overrides };
}

/** `count` rows carrying a stable, identifiable field. */
export function rows(count: number, prefix = 'r'): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({ Id: `${prefix}${index}`, Name: `${prefix} ${index}` }));
}

/**
 * `count` rows of a single narrow field. Continuation tests use these so the row count — not
 * the response budget — is what the assertion is actually exercising.
 */
export function idRows(count: number, prefix = 'r'): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({ Id: `${prefix}${index}` }));
}

/**
 * A jsforce-shaped search result. The real payload carries `searchRecords` and nothing else —
 * no total, no cursor (verified live) — so a fixture that added one would let a test pass
 * against a shape Salesforce does not produce.
 */
export function searchPayload(records: readonly unknown[]): Record<string, unknown> {
  return { searchRecords: records };
}

/**
 * A search result row. The object is identified by `attributes.type`, which is where the live
 * org puts it, and `fields` are merged in beside it as the platform returns them.
 */
export function searchRecord(
  objectApiName: string,
  fields: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    attributes: { type: objectApiName, url: `/services/data/v68.0/sobjects/${objectApiName}/001000000000001` },
    Id: '001000000000001',
    ...fields,
  };
}

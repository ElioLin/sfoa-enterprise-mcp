import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';

export type ConnectionOperation = 'describeGlobal' | 'describe';

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

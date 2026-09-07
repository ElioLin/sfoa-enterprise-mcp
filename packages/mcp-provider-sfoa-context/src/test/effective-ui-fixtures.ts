import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import { parseFlexiPage } from '../flexipage-parser.js';
import { EffectiveRecordUiContextResolver } from '../effective-ui-resolver.js';
import { RecordActionContextExecutor } from '../record-action-executor.js';
import { UI_PARSER_VERSION, type UiSnapshot, type UiMode, type VisibilityRule, type EffectiveUiOptions } from '../effective-ui-contracts.js';

export const ORG = '00D000000000001AAA';
export const RT = '012000000000001AAA';
export const PROFILE = '00e000000000001AAA';
export const rule = (leftValue: string, operator = 'EQUAL', rightValue: string | number | boolean | null = 'Partner'): VisibilityRule =>
  ({ criteria: [{ leftValue, operator, rightValue }] });
export const component = (componentName: string, properties: Record<string, unknown> = {}) => ({ componentInstance: {
  componentName, componentInstanceProperties: Object.entries(properties).map(([name, value]) => ({ name, value })),
} });
export const fieldItem = (name: string, behavior = 'none', visibilityRule?: VisibilityRule) => ({ fieldInstance: {
  fieldItem: `Record.${name}`, identifier: name, fieldInstanceProperties: [{ name: 'uiBehavior', value: behavior }], visibilityRule,
} });
export function fixturePage() {
  return { fullName: 'Create_Page', type: 'RecordPage', sobjectType: 'Sample__c', flexiPageRegions: [
    { name: 'main', type: 'Region', itemInstances: [component('force:recordDetailPanelMobile'), component('flexipage:fieldSection', { label: 'Details', columns: 'columns' })] },
    { name: 'columns', type: 'Facet', itemInstances: [component('flexipage:column', { body: 'left' }), component('flexipage:column', { body: 'right' })] },
    { name: 'left', type: 'Facet', itemInstances: [fieldItem('Type__c'), fieldItem('Name', 'required'), fieldItem('Discount__c', 'required', rule('{!Record.Type__c}'))] },
    { name: 'right', type: 'Facet', itemInstances: [fieldItem('Internal__c', 'readonly'), fieldItem('Secret__c', 'required', rule('{!Record.Type__c}', 'EQUAL', 'Internal')),
      fieldItem('Unknown__c', 'required', rule('{!Record.Owner.ManagerId}')), fieldItem('Managed__c'), fieldItem('NoFls__c')] },
  ] };
}
export function fixtureSnapshot(): UiSnapshot {
  return { organizationId: ORG, objectApiName: 'Sample__c', parserVersion: UI_PARSER_VERSION, complete: true,
    profiles: [{ id: PROFILE, name: 'Profile A Display', fullName: 'Profile_A' }, { id: '00e000000000002AAA', name: 'Profile_B', fullName: 'Profile_B' }],
    recordTypes: [{ id: RT, fullName: 'Sample__c.Business' }],
    apps: [{ appId: '06m000000000001AAA', developerName: 'App_A', fullName: 'App_A' }],
    assignments: [{ app: 'App_A', profile: 'Profile_A', recordType: 'Sample__c.Business', formFactor: 'Large',
      action: 'View', type: 'Flexipage', page: 'Create_Page', source: 'APP_PROFILE_RECORD_TYPE' }],
    pages: [parseFlexiPage(fixturePage(), 'Sample__c')],
  };
}
export function runtimeFixture(mode: UiMode, snapshot: UiSnapshot | null = fixtureSnapshot(), profileId = PROFILE, overrides: Partial<EffectiveUiOptions> = {}) {
  let metadataCalls = 0; let userCalls = 0; let snapshotCalls = 0;
  const evidence: Readonly<Record<string, unknown>>[] = [];
  const fields = Object.fromEntries(['Name', 'Type__c', 'Discount__c', 'Internal__c', 'Secret__c', 'Unknown__c', 'Managed__c', 'NoFls__c', 'ApiRequired__c'].map((apiName) => [apiName, {
    apiName, label: apiName, dataType: 'String', required: apiName === 'ApiRequired__c', createable: apiName !== 'NoFls__c', updateable: true,
  }]));
  const recordType = { recordTypeId: RT, name: 'Business', available: true, defaultRecordTypeMapping: true };
  const connection = {
    getApiVersion: () => '67.0',
    soap: { getUserInfo: async () => { userCalls++; return { userId: `005${profileId.slice(3)}`, profileId, organizationId: ORG }; } },
    metadata: { read: () => { metadataCalls++; throw new Error('METADATA_RUNTIME_FORBIDDEN'); } },
    request: async ({ url }: { url: string }) => {
      if (url.includes('/apps?')) { userCalls++; return { apps: snapshot?.apps ?? [] }; }
      if (url.includes('/picklist-values/')) return { picklistFieldValues: {} };
      if (url.includes('/object-info/')) return { apiName: 'Sample__c', label: 'Sample', labelPlural: 'Samples', fields, defaultRecordTypeId: RT, recordTypeInfos: { [RT]: recordType } };
      return { layout: { id: '00h000000000001AAA', sections: [{ heading: 'Legacy', layoutRows: [{ layoutItems: [{ required: true, editableForNew: true, editableForUpdate: true, layoutComponents: [{ componentType: 'Field', apiName: 'Name' }] }] }] }] },
        record: { apiName: 'Sample__c', recordTypeId: RT, fields: { Name: { value: 'Default name' } } } };
    },
  } as unknown as Connection;
  const org = { getAllowedOrgUsernames: async () => new Set(['user@example.test']), getConnection: async () => connection } as unknown as OrgService;
  const resolver = new EffectiveRecordUiContextResolver({ policies: [{ objectApiName: 'Sample__c', mode }], managedFields: ['Managed__c'],
    loadSnapshot: async () => { snapshotCalls++; return snapshot ? { id: '1', organizationId: ORG, objectApiName: 'Sample__c', snapshot,
      hash: 'f'.repeat(64), lastModified: null, refreshedAt: new Date().toISOString(), status: 'READY', lastError: null, parserVersion: UI_PARSER_VERSION } : undefined; },
    audit: (entry) => { evidence.push(entry); },
    ...overrides,
  });
  return { org, connection, resolver, fields, executor: new RecordActionContextExecutor(org, resolver), legacy: new RecordActionContextExecutor(org), evidence,
    counts: () => ({ metadataCalls, userCalls, snapshotCalls }) };
}

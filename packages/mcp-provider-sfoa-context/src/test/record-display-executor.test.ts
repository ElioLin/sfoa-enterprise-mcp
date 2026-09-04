import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import { ContextRuntimeError } from '../errors.js';
import { RecordDisplayContextExecutor } from '../record-display-executor.js';

const DEFAULT_RECORD_TYPE = '012000000000001AAA';
const SECOND_RECORD_TYPE = '012000000000002AAA';

test('Account-style object returns Name/display fields, View and Compact layout facts with explicit coverage', async () => {
  const fixture = createFixture();
  const output = await fixture.executor.execute({ objectApiName: 'Account' });

  assert.equal(output.success, true);
  assert.equal(output.executionRole, 'USER');
  assert.equal(output.objectApiName, 'Account');
  assert.equal(output.objectLabel, 'Account');
  assert.equal(output.objectLabelPlural, 'Accounts');
  assert.deepEqual(output.nameFields, [{ apiName: 'Name', label: 'Account Name', dataType: 'String' }]);
  assert.equal(output.selectedRecordType?.id, DEFAULT_RECORD_TYPE);
  assert.equal(output.selectedRecordType?.defaultForUser, true);
  assert.equal(output.coverage?.recordTypeResolved, true);
  assert.equal(output.coverage?.nameFieldSource, 'NAME_FIELD');
  assert.equal(output.coverage?.viewLayoutEvaluated, true);
  assert.equal(output.coverage?.compactLayoutEvaluated, true);
  assert.equal(output.coverage?.dynamicFormsEvaluated, false);
  assert.equal(output.coverage?.completeLightningPageEvaluated, false);
  assert.equal(output.coverage?.truncated, false);
  assert.equal(output.coverage?.apiCallCount, 3);
  assert.deepEqual(output.coverage?.sources, ['UI_API_OBJECT_INFO', 'UI_API_LAYOUT', 'UI_API_COMPACT_LAYOUT']);

  const name = output.viewLayoutFields?.find((field) => field.apiName === 'Name');
  assert.deepEqual(name, {
    apiName: 'Name',
    label: 'Account Name',
    dataType: 'String',
    section: 'Account Information',
    layoutOrder: 0,
    readable: true,
    referenceTo: [],
    relationshipName: null,
  });
  const parent = output.viewLayoutFields?.find((field) => field.apiName === 'ParentId');
  assert.deepEqual(parent?.referenceTo, ['Account']);
  assert.equal(parent?.relationshipName, 'Parent');
  assert.deepEqual(output.compactLayoutFields?.map((field) => field.apiName), ['Name', 'AccountNumber', 'Industry']);
});

test('recordTypeId pins the View/Compact layout facts to the requested Record Type', async () => {
  const fixture = createFixture();
  const output = await fixture.executor.execute({ objectApiName: 'Account', recordTypeId: SECOND_RECORD_TYPE });

  assert.equal(output.selectedRecordType?.id, SECOND_RECORD_TYPE);
  assert.ok(fixture.urls.some((url) => url.includes('/ui-api/layout/') && url.includes(SECOND_RECORD_TYPE)));
  assert.ok(fixture.urls.every((url) => !url.includes(DEFAULT_RECORD_TYPE)));
  assert.equal(output.availableRecordTypes?.length, 2);
});

test('read-only View/Compact layout items are reported with readable=false and labels/dataTypes come from Object Info', async () => {
  const fixture = createFixture();
  const output = await fixture.executor.execute({ objectApiName: 'Account' });

  const industry = output.viewLayoutFields?.find((field) => field.apiName === 'Industry');
  assert.equal(industry?.readable, false);
  assert.equal(industry?.label, 'Industry');
  const compactIndustry = output.compactLayoutFields?.find((field) => field.apiName === 'Industry');
  assert.equal(compactIndustry?.readable, false);
});

test('Compact layout unavailable falls back to Object Info + View layout and reports coverage instead of failing', async () => {
  const fixture = createFixture({ compactError: new Error('ERROR_HTTP_404 compact not supported') });
  const output = await fixture.executor.execute({ objectApiName: 'Account' });

  assert.equal(output.success, true);
  assert.equal(output.coverage?.viewLayoutEvaluated, true);
  assert.equal(output.coverage?.compactLayoutEvaluated, false);
  assert.match(output.coverage?.warnings.join(' ') ?? '', /Compact layout/iu);
  // The attempted Compact request is still counted as a Salesforce API call.
  assert.equal(output.coverage?.apiCallCount, 3);
  assert.deepEqual(output.coverage?.sources, ['UI_API_OBJECT_INFO', 'UI_API_LAYOUT']);
});

test('View layout unavailable degrades gracefully while Object Info and Compact facts remain', async () => {
  const fixture = createFixture({ viewError: new Error('ERROR_HTTP_400 object has no page layout') });
  const output = await fixture.executor.execute({ objectApiName: 'Account' });

  assert.equal(output.success, true);
  assert.equal(output.coverage?.viewLayoutEvaluated, false);
  assert.equal(output.coverage?.compactLayoutEvaluated, true);
  assert.match(output.coverage?.warnings.join(' ') ?? '', /View layout/iu);
  assert.equal(output.coverage?.apiCallCount, 3);
});

test('an unparsable View layout body is reported as coverage rather than a crash', async () => {
  const fixture = createFixture({ viewResponse: { layouts: { Full: { sections: [] } } } });
  const output = await fixture.executor.execute({ objectApiName: 'Account' });

  assert.equal(output.success, true);
  assert.equal(output.coverage?.viewLayoutEvaluated, false);
  assert.match(output.coverage?.warnings.join(' ') ?? '', /could not be parsed/iu);
});

test('Case-style object with no Name field reports no invented name field and guides via coverage', async () => {
  const fixture = createFixture({
    objectInfoResponse: caseObjectInfo(),
    viewResponse: caseViewLayout(),
    compactResponse: { compactLayoutFields: [{ apiName: 'CaseNumber', label: 'Case Number' }, { apiName: 'Subject', label: 'Subject' }] },
  });
  const output = await fixture.executor.execute({ objectApiName: 'Case' });

  assert.equal(output.objectLabelPlural, 'Cases');
  assert.deepEqual(output.nameFields, []);
  assert.equal(output.coverage?.nameFieldSource, 'NONE_DECLARED');
  assert.match(output.coverage?.warnings.join(' ') ?? '', /does not declare a conventional Name field/iu);
  assert.ok(output.viewLayoutFields?.some((field) => field.apiName === 'CaseNumber'));
  assert.equal(output.coverage?.dynamicFormsEvaluated, false);
});

test('several available Record Types without a USER default stay explicit instead of guessed', async () => {
  const fixture = createFixture({ defaultRecordTypeId: null });
  const output = await fixture.executor.execute({ objectApiName: 'Account' });

  assert.equal(output.success, true);
  assert.equal(output.selectedRecordType, null);
  assert.equal(output.coverage?.recordTypeResolved, false);
  assert.equal(output.coverage?.viewLayoutEvaluated, false);
  assert.equal(output.coverage?.compactLayoutEvaluated, false);
  assert.match(output.coverage?.warnings.join(' ') ?? '', /Several Record Types/iu);
  // No layout fetch is attempted for an un-pinned ambiguous selection.
  assert.equal(fixture.urls.length, 1);
  assert.equal(output.availableRecordTypes?.length, 2);
});

test('explicit unavailable or unknown Record Types fail closed with MCP_RECORD_TYPE_NOT_AVAILABLE', async () => {
  const unavailable = createFixture({ recordTypeInfos: {
    [DEFAULT_RECORD_TYPE]: recordType(DEFAULT_RECORD_TYPE, 'Default', false, true),
    [SECOND_RECORD_TYPE]: recordType(SECOND_RECORD_TYPE, 'Enterprise', true, false),
  } });
  await assert.rejects(
    unavailable.executor.execute({ objectApiName: 'Account', recordTypeId: DEFAULT_RECORD_TYPE }),
    (error: unknown) => error instanceof ContextRuntimeError && error.code === 'MCP_RECORD_TYPE_NOT_AVAILABLE',
  );

  const unknown = createFixture();
  await assert.rejects(
    unknown.executor.execute({ objectApiName: 'Account', recordTypeId: '012000000000099AAA' }),
    (error: unknown) => error instanceof ContextRuntimeError && error.code === 'MCP_RECORD_TYPE_NOT_AVAILABLE',
  );
});

test('Object Info failures for unsupported or cross-object responses fail with stable context codes', async () => {
  const unsupported = createFixture({ objectInfoError: new Error('ERROR_HTTP_404 Object does not exist') });
  await assert.rejects(
    unsupported.executor.execute({ objectApiName: 'Account' }),
    (error: unknown) => error instanceof ContextRuntimeError && error.code === 'MCP_RECORD_DISPLAY_CONTEXT_UNSUPPORTED',
  );

  const crossObject = createFixture({ objectInfoResponse: { ...accountObjectInfo(), apiName: 'Lead' } });
  await assert.rejects(
    crossObject.executor.execute({ objectApiName: 'Account' }),
    (error: unknown) => error instanceof ContextRuntimeError && error.code === 'MCP_RECORD_DISPLAY_CONTEXT_UNSUPPORTED',
  );
});

type FixtureOptions = Readonly<{
  objectInfoResponse?: Record<string, unknown>;
  objectInfoError?: Error;
  viewResponse?: unknown;
  viewError?: Error;
  compactResponse?: unknown;
  compactError?: Error;
  recordTypeInfos?: Readonly<Record<string, unknown>>;
  defaultRecordTypeId?: string | null;
}>;

function createFixture(options: FixtureOptions = {}): { executor: RecordDisplayContextExecutor; urls: string[] } {
  const urls: string[] = [];
  const objectInfo = options.objectInfoResponse ?? accountObjectInfo(options);
  const connection = {
    getApiVersion: () => '67.0',
    request: async (request: { url: string }) => {
      urls.push(request.url);
      if (request.url.includes('/ui-api/layout/') && request.url.includes('layoutTypes=Full')) {
        if (options.viewError) throw options.viewError;
        if (options.viewResponse !== undefined) return options.viewResponse;
        return accountViewLayout();
      }
      if (request.url.includes('/ui-api/layout/') && request.url.includes('layoutTypes=Compact')) {
        if (options.compactError) throw options.compactError;
        if (options.compactResponse !== undefined) return options.compactResponse;
        return accountCompactLayout();
      }
      if (request.url.includes('/ui-api/object-info/')) {
        if (options.objectInfoError) throw options.objectInfoError;
        return objectInfo;
      }
      throw new Error(`Unexpected UI API URL: ${request.url}`);
    },
  } as unknown as Connection;
  const orgService = {
    getAllowedOrgUsernames: async () => new Set(['user@example.test']),
    getConnection: async () => connection,
  } as unknown as OrgService;
  return { executor: new RecordDisplayContextExecutor(orgService), urls };
}

function accountObjectInfo(options: Pick<FixtureOptions, 'recordTypeInfos' | 'defaultRecordTypeId'> = {}): Record<string, unknown> {
  return {
    apiName: 'Account',
    label: 'Account',
    labelPlural: 'Accounts',
    defaultRecordTypeId: options.defaultRecordTypeId === null ? null : DEFAULT_RECORD_TYPE,
    fields: {
      Name: field('Name', 'Account Name'),
      AccountNumber: field('AccountNumber', 'Account Number'),
      Industry: field('Industry', 'Industry'),
      ParentId: field('ParentId', 'Parent Account ID', {
        dataType: 'Reference',
        relationshipName: 'Parent',
        referenceToInfos: [{ apiName: 'Account' }],
      }),
    },
    recordTypeInfos: options.recordTypeInfos ?? {
      [DEFAULT_RECORD_TYPE]: recordType(DEFAULT_RECORD_TYPE, 'Default', true, true),
      [SECOND_RECORD_TYPE]: recordType(SECOND_RECORD_TYPE, 'Enterprise', true, false),
    },
  };
}

function caseObjectInfo(): Record<string, unknown> {
  return {
    apiName: 'Case',
    label: 'Case',
    labelPlural: 'Cases',
    defaultRecordTypeId: DEFAULT_RECORD_TYPE,
    fields: {
      CaseNumber: field('CaseNumber', 'Case Number'),
      Subject: field('Subject', 'Subject'),
      Status: field('Status', 'Status'),
    },
    recordTypeInfos: {
      [DEFAULT_RECORD_TYPE]: recordType(DEFAULT_RECORD_TYPE, 'Default', true, true),
    },
  };
}

function caseViewLayout(): Record<string, unknown> {
  return {
    sections: [
      {
        heading: 'Case Information',
        layoutRows: [
          { layoutItems: [layoutItem(true, [{ apiName: 'CaseNumber', componentType: 'Field' }])] },
          { layoutItems: [layoutItem(false, [{ apiName: 'Subject', componentType: 'Field' }])] },
          { layoutItems: [layoutItem(false, [{ apiName: 'Status', componentType: 'Field' }])] },
        ],
      },
    ],
  };
}

function accountViewLayout(): Record<string, unknown> {
  return {
    sections: [
      {
        heading: 'Account Information',
        layoutRows: [
          {
            layoutItems: [
              layoutItem(true, [{ apiName: 'Name', componentType: 'Field' }]),
              layoutItem(false, [{ apiName: 'AccountNumber', componentType: 'Field' }]),
            ],
          },
          {
            layoutItems: [
              { ...layoutItem(false, [{ apiName: 'Industry', componentType: 'Field' }]), readOnly: true },
            ],
          },
          {
            layoutItems: [
              layoutItem(false, [{ apiName: 'ParentId', componentType: 'Field' }]),
            ],
          },
        ],
      },
    ],
  };
}

function accountCompactLayout(): unknown {
  return {
    compactLayoutFields: [
      { apiName: 'Name', label: 'Account Name' },
      { apiName: 'AccountNumber', label: 'Account Number' },
      { apiName: 'Industry', label: 'Industry', readOnly: true },
    ],
  };
}

function field(apiName: string, label: string, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    apiName,
    label,
    dataType: 'String',
    required: false,
    createable: true,
    updateable: true,
    controllerName: null,
    relationshipName: null,
    referenceToInfos: [],
    ...overrides,
  };
}

function recordType(id: string, name: string, available: boolean, defaultRecordTypeMapping: boolean): Record<string, unknown> {
  return { recordTypeId: id, name, available, defaultRecordTypeMapping };
}

function layoutItem(required: boolean, components: Array<{ apiName: string; componentType: string }>): Record<string, unknown> {
  return {
    editableForNew: true,
    editableForUpdate: true,
    required,
    layoutComponents: components,
  };
}

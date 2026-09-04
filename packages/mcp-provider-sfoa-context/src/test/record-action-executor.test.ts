import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import { ContextRuntimeError } from '../errors.js';
import { RecordActionContextExecutor } from '../record-action-executor.js';

const DEFAULT_RECORD_TYPE = '012000000000001AAA';
const AVAILABLE_RECORD_TYPE = '012000000000002AAA';
const UNAVAILABLE_RECORD_TYPE = '012000000000003AAA';
const RECORD_ID = '00Q000000000001AAA';

test('CREATE resolves the single available Record Type and preserves required/editable/default/picklist facts', async () => {
  const fixture = createFixture({ availableRecordTypeIds: [DEFAULT_RECORD_TYPE] });
  const output = await fixture.executor.execute({ objectApiName: 'Lead', action: 'CREATE' });

  assert.equal(output.success, true);
  assert.equal(output.executionRole, 'USER');
  assert.equal(output.recordType?.id, DEFAULT_RECORD_TYPE);
  assert.equal(output.recordType?.defaultForUser, true);
  assert.equal(output.recordTypeSelectionRequired, false);
  // Only the Record Types available to the USER are exposed: Enterprise and Hidden are not.
  assert.equal(output.availableRecordTypes?.length, 1);
  assert.deepEqual(output.availableRecordTypes?.map((entry) => entry.name), ['Default']);
  assert.equal(output.coverage?.apiCallCount, 3);
  assert.deepEqual(output.coverage?.sources, [
    'UI_API_OBJECT_INFO',
    'UI_API_CREATE_DEFAULTS',
    'UI_API_LAYOUT',
    'UI_API_PICKLIST_VALUES_BY_RECORD_TYPE',
  ]);

  const required = output.fields?.find((field) => field.apiName === 'Required__c');
  assert.equal(required?.apiRequired, true);
  assert.equal(required?.layoutMember, false);
  assert.equal(required?.layoutRequired, false);
  assert.equal(required?.fieldCreateable, true);
  assert.equal(required?.layoutEditableForCreate, null);

  const name = output.fields?.find((field) => field.apiName === 'Name');
  assert.equal(name?.label, 'Lead Name');
  assert.equal(name?.dataType, 'String');
  assert.equal(name?.layoutRequired, true);
  assert.equal(name?.layoutEditableForCreate, true);
  assert.equal(name?.layoutEditableForUpdate, true);
  assert.equal(name?.section, 'Lead Information');

  const status = output.fields?.find((field) => field.apiName === 'Status__c');
  assert.equal(status?.defaultValue, 'Open');
  assert.equal(status?.picklist?.controllerName, 'Controller__c');
  assert.deepEqual(status?.picklist?.controllerValues, { Enabled: 0, Disabled: 1 });
  assert.deepEqual(status?.picklist?.values[0], {
    label: 'Open',
    value: 'Open',
    default: true,
    validFor: [0],
  });
  assert.equal(status?.relationshipName, null);
  assert.deepEqual(status?.referenceTo, []);
});

test('CREATE accepts an explicit available Record Type among several and denies an unavailable one', async () => {
  const available = createFixture();
  const output = await available.executor.execute({
    objectApiName: 'Lead',
    action: 'CREATE',
    recordTypeId: AVAILABLE_RECORD_TYPE,
  });
  assert.equal(output.recordType?.id, AVAILABLE_RECORD_TYPE);
  assert.equal(output.recordTypeSelectionRequired, false);
  assert.equal(output.availableRecordTypes?.length, 2);
  assert.equal(output.availableRecordTypes?.some((entry) => entry.available === false), false);
  assert.match(available.urls[1] ?? '', new RegExp(AVAILABLE_RECORD_TYPE, 'u'));

  const denied = createFixture();
  await assert.rejects(
    denied.executor.execute({
      objectApiName: 'Lead',
      action: 'CREATE',
      recordTypeId: UNAVAILABLE_RECORD_TYPE,
    }),
    (error: unknown) => error instanceof ContextRuntimeError && error.code === 'MCP_RECORD_TYPE_NOT_AVAILABLE',
  );
  assert.equal(denied.urls.length, 1);
});

test('UPDATE derives Record Type from recordId and fails closed on an explicit mismatch', async () => {
  const fixture = createFixture({ updateRecordTypeId: AVAILABLE_RECORD_TYPE });
  const output = await fixture.executor.execute({
    objectApiName: 'Lead',
    action: 'UPDATE',
    recordId: RECORD_ID,
    recordTypeId: AVAILABLE_RECORD_TYPE,
  });
  assert.equal(output.recordType?.id, AVAILABLE_RECORD_TYPE);
  assert.equal(output.recordId, RECORD_ID);
  assert.equal(output.coverage?.apiCallCount, 4);
  assert.ok(fixture.urls.some((url) => url.includes(`/ui-api/records/${RECORD_ID}`)));
  assert.ok(fixture.urls.some((url) => url.includes('mode=Edit')));

  const mismatch = createFixture({ updateRecordTypeId: AVAILABLE_RECORD_TYPE });
  await assert.rejects(
    mismatch.executor.execute({
      objectApiName: 'Lead',
      action: 'UPDATE',
      recordId: RECORD_ID,
      recordTypeId: DEFAULT_RECORD_TYPE,
    }),
    (error: unknown) => error instanceof ContextRuntimeError && error.code === 'MCP_RECORD_TYPE_NOT_AVAILABLE',
  );
  assert.equal(mismatch.urls.length, 2);
});

test('CREATE with multiple available Record Types returns selection-required without any create-defaults call', async () => {
  const fixture = createFixture();
  const output = await fixture.executor.execute({ objectApiName: 'Lead', action: 'CREATE' });

  assert.equal(output.success, true);
  assert.equal(output.recordType, undefined);
  assert.equal(output.recordTypeSelectionRequired, true);
  // Two Record Types are available; the unavailable (Hidden) one never reaches the Agent.
  assert.equal(output.availableRecordTypes?.length, 2);
  assert.equal(output.availableRecordTypes?.some((entry) => entry.available === false), false);
  assert.equal(output.availableRecordTypes?.find((entry) => entry.available && entry.defaultForUser)?.name, 'Default');
  // Only Object Info was requested; the wasteful default create-defaults fetch is avoided.
  assert.equal(output.coverage?.apiCallCount, 1);
  assert.deepEqual(output.coverage?.sources, ['UI_API_OBJECT_INFO']);
  assert.equal(output.coverage?.dynamicFormsEvaluated, false);
  assert.equal(fixture.urls.length, 1);
  assert.equal(fixture.urls.some((url) => url.includes('/ui-api/record-defaults/')), false);
  assert.match(output.coverage?.warnings.join(' ') ?? '', /call again with recordTypeId/iu);
  // Object Info facts are still available, but no layout/picklist facts exist pre-selection.
  assert.equal(output.fields?.some((field) => field.apiName === 'Required__c' && field.layoutMember === false), true);
  assert.equal(output.fields?.find((field) => field.apiName === 'Status__c')?.picklist, undefined);
});

test('CREATE auto-selects a Master-only Record Type and does not force selection', async () => {
  const master = { recordTypeId: DEFAULT_RECORD_TYPE, name: 'Master', available: true, defaultRecordTypeMapping: true };
  const fixture = createFixture({ recordTypeInfos: { [DEFAULT_RECORD_TYPE]: master } });
  const output = await fixture.executor.execute({ objectApiName: 'Lead', action: 'CREATE' });

  assert.equal(output.success, true);
  assert.equal(output.recordTypeSelectionRequired, false);
  assert.equal(output.recordType?.id, DEFAULT_RECORD_TYPE);
  assert.equal(output.recordType?.name, 'Master');
  assert.deepEqual(output.availableRecordTypes, [{ id: DEFAULT_RECORD_TYPE, name: 'Master', available: true, defaultForUser: true }]);
  assert.equal(output.coverage?.apiCallCount, 3);
});

test('CREATE availableRecordTypes excludes unavailable Record Types so the Agent 0/1/N branch is never skewed', async () => {
  // RT-A available, RT-B and RT-C unavailable -> exactly one available entry, auto-selected.
  const single = createFixture({
    recordTypeInfos: {
      [DEFAULT_RECORD_TYPE]: recordType(DEFAULT_RECORD_TYPE, 'Default', true, true),
      [AVAILABLE_RECORD_TYPE]: recordType(AVAILABLE_RECORD_TYPE, 'Enterprise', false, false),
      [UNAVAILABLE_RECORD_TYPE]: recordType(UNAVAILABLE_RECORD_TYPE, 'Hidden', false, false),
    },
  });
  const one = await single.executor.execute({ objectApiName: 'Lead', action: 'CREATE' });
  assert.equal(one.availableRecordTypes?.length, 1);
  assert.deepEqual(one.availableRecordTypes?.map((entry) => entry.name), ['Default']);
  assert.equal(one.recordTypeSelectionRequired, false);

  // RT-A and RT-B available, RT-C unavailable -> two available entries and selection required.
  const several = createFixture({
    recordTypeInfos: {
      [DEFAULT_RECORD_TYPE]: recordType(DEFAULT_RECORD_TYPE, 'Default', true, true),
      [AVAILABLE_RECORD_TYPE]: recordType(AVAILABLE_RECORD_TYPE, 'Enterprise', true, false),
      [UNAVAILABLE_RECORD_TYPE]: recordType(UNAVAILABLE_RECORD_TYPE, 'Hidden', false, false),
    },
  });
  const many = await several.executor.execute({ objectApiName: 'Lead', action: 'CREATE' });
  assert.equal(many.recordTypeSelectionRequired, true);
  assert.equal(many.availableRecordTypes?.length, 2);
  assert.deepEqual([...(many.availableRecordTypes ?? [])].map((entry) => entry.name).sort(), ['Default', 'Enterprise']);
  assert.equal(many.availableRecordTypes?.some((entry) => entry.available === false), false);
});

test('CREATE with zero available Record Types fails closed without guessing', async () => {
  const fixture = createFixture({ availableRecordTypeIds: [] });
  await assert.rejects(
    fixture.executor.execute({ objectApiName: 'Lead', action: 'CREATE' }),
    (error: unknown) => error instanceof ContextRuntimeError && error.code === 'MCP_RECORD_TYPE_NOT_AVAILABLE',
  );
  assert.equal(fixture.urls.length, 1);
});

test('field truncation is explicit and never drops API-required fields', async () => {
  const extraFields = Object.fromEntries(
    Array.from({ length: 210 }, (_, index) => [
      `Optional_${String(index).padStart(3, '0')}__c`,
      field(`Optional_${String(index).padStart(3, '0')}__c`, `Optional ${index}`),
    ]),
  );
  const fixture = createFixture({ extraFields, availableRecordTypeIds: [DEFAULT_RECORD_TYPE] });
  const output = await fixture.executor.execute({ objectApiName: 'Lead', action: 'CREATE' });
  assert.equal(output.fields?.length, 200);
  assert.equal(output.coverage?.truncated, true);
  assert.ok(output.fields?.some((field) => field.apiName === 'Required__c'));
  assert.match(output.coverage?.warnings.join(' ') ?? '', /required fields were retained/iu);
});

test('picklist bounds preserve dependency facts and report truncation', async () => {
  const values = Array.from({ length: 130 }, (_, index) => ({
    label: `Value ${index}`,
    value: `V${index}`,
    validFor: Array.from({ length: 205 }, (_entry, validIndex) => validIndex),
  }));
  const fixture = createFixture({ picklistValues: values, availableRecordTypeIds: [DEFAULT_RECORD_TYPE] });
  const output = await fixture.executor.execute({ objectApiName: 'Lead', action: 'CREATE' });
  const picklist = output.fields?.find((field) => field.apiName === 'Status__c')?.picklist;
  assert.equal(picklist?.totalValues, 130);
  assert.equal(picklist?.returnedValues, 100);
  assert.equal(picklist?.values[0]?.validFor.length, 200);
  assert.equal(picklist?.truncated, true);
  assert.equal(output.coverage?.truncated, true);
});

test('unsupported or cross-object UI API responses fail with stable context codes', async () => {
  const malformed = createFixture({ objectInfoResponse: { apiName: 'Lead' } });
  await assert.rejects(
    malformed.executor.execute({ objectApiName: 'Lead', action: 'CREATE' }),
    (error: unknown) => error instanceof ContextRuntimeError && error.code === 'MCP_RECORD_ACTION_CONTEXT_UNSUPPORTED',
  );

  const crossObject = createFixture({ recordApiName: 'Account' });
  await assert.rejects(
    crossObject.executor.execute({ objectApiName: 'Lead', action: 'UPDATE', recordId: RECORD_ID }),
    (error: unknown) => error instanceof ContextRuntimeError && error.code === 'MCP_RECORD_ACTION_CONTEXT_INVALID',
  );
});

type FixtureOptions = Readonly<{
  updateRecordTypeId?: string;
  recordApiName?: string;
  objectInfoResponse?: unknown;
  extraFields?: Readonly<Record<string, unknown>>;
  picklistValues?: readonly unknown[];
  /** When provided, only these Record Type IDs are flagged `available` in Object Info. */
  availableRecordTypeIds?: readonly string[];
  /** Replaces the default Record Type Info map (used for Master-only objects). */
  recordTypeInfos?: Readonly<Record<string, unknown>>;
}>;

function createFixture(options: FixtureOptions = {}): {
  executor: RecordActionContextExecutor;
  urls: string[];
} {
  const urls: string[] = [];
  const recordTypeInfos = { ...(options.recordTypeInfos ?? {
    [DEFAULT_RECORD_TYPE]: recordType(DEFAULT_RECORD_TYPE, 'Default', true, true),
    [AVAILABLE_RECORD_TYPE]: recordType(AVAILABLE_RECORD_TYPE, 'Enterprise', true, false),
    [UNAVAILABLE_RECORD_TYPE]: recordType(UNAVAILABLE_RECORD_TYPE, 'Hidden', false, false),
  }) };
  if (options.availableRecordTypeIds) {
    for (const entry of Object.values(recordTypeInfos) as Array<{ recordTypeId?: string; available?: boolean }>) {
      entry.available = options.availableRecordTypeIds.includes(String(entry.recordTypeId));
    }
  }
  const objectInfo = options.objectInfoResponse ?? {
    apiName: 'Lead',
    label: 'Lead',
    labelPlural: 'Leads',
    defaultRecordTypeId: DEFAULT_RECORD_TYPE,
    fields: {
      Required__c: field('Required__c', 'Required Fact', { required: true }),
      Name: field('Name', 'Lead Name'),
      Status__c: field('Status__c', 'Status', { dataType: 'Picklist', controllerName: 'Controller__c' }),
      Controller__c: field('Controller__c', 'Controller', { dataType: 'Picklist' }),
      Lookup__c: field('Lookup__c', 'Lookup', {
        dataType: 'Reference',
        relationshipName: 'Lookup__r',
        referenceToInfos: [{ apiName: 'Account' }],
      }),
      ...options.extraFields,
    },
    recordTypeInfos,
  };
  const connection = {
    getApiVersion: () => '67.0',
    request: async (request: { url: string }) => {
      urls.push(request.url);
      if (request.url.includes('/ui-api/object-info/Lead/picklist-values/')) {
        return {
          picklistFieldValues: {
            Status__c: {
              controllerValues: { Enabled: 0, Disabled: 1 },
              defaultValue: { label: 'Open', value: 'Open' },
              values: options.picklistValues ?? [
                { label: 'Open', value: 'Open', validFor: [0] },
                { label: 'Closed', value: 'Closed', validFor: [1] },
              ],
            },
          },
        };
      }
      if (request.url.includes('/ui-api/object-info/Lead')) return objectInfo;
      if (request.url.includes('/ui-api/record-defaults/create/Lead')) {
        const recordTypeId = request.url.includes(AVAILABLE_RECORD_TYPE) ? AVAILABLE_RECORD_TYPE : DEFAULT_RECORD_TYPE;
        return {
          layout: layout(),
          record: {
            apiName: 'Lead',
            recordTypeId,
            fields: {
              Name: { value: null },
              Required__c: { value: null },
              Status__c: { value: 'Open' },
            },
          },
        };
      }
      if (request.url.includes('/ui-api/records/')) {
        return {
          apiName: options.recordApiName ?? 'Lead',
          recordTypeId: options.updateRecordTypeId ?? DEFAULT_RECORD_TYPE,
          fields: { Id: { value: RECORD_ID } },
        };
      }
      if (request.url.includes('/ui-api/layout/Lead')) return layout();
      throw new Error(`Unexpected UI API URL: ${request.url}`);
    },
  } as unknown as Connection;
  const orgService = {
    getAllowedOrgUsernames: async () => new Set(['user@example.test']),
    getConnection: async () => connection,
  } as unknown as OrgService;
  return { executor: new RecordActionContextExecutor(orgService), urls };
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

function layout(): Record<string, unknown> {
  return {
    sections: [
      {
        heading: 'Lead Information',
        layoutRows: [
          {
            layoutItems: [
              {
                editableForNew: true,
                editableForUpdate: true,
                required: true,
                layoutComponents: [{ apiName: 'Name', componentType: 'Field' }],
              },
              {
                editableForNew: true,
                editableForUpdate: false,
                required: false,
                layoutComponents: [{ apiName: 'Status__c', componentType: 'Field' }],
              },
            ],
          },
        ],
      },
    ],
  };
}

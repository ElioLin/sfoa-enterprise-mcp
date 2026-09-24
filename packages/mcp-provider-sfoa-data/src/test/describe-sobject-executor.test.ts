import assert from 'node:assert/strict';
import test from 'node:test';
import { DescribeSobjectExecutor } from '../describe-sobject-executor.js';
import { DataRuntimeError } from '../errors.js';
import { DATA_MAX_RESPONSE_BYTES } from '../response-budget.js';
import { DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES } from '../schemas.js';
import {
  childRelationship,
  createFixture,
  describePayload,
  fieldEntry,
  salesforceError,
} from './data-fixtures.js';

const DEFAULT_FIELD_LIMIT = 200;

function accountDescribe(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return describePayload('Account', {
    label: 'Account',
    labelPlural: 'Accounts',
    keyPrefix: '001',
    custom: false,
    fields: [
      fieldEntry('Id', { type: 'id', nillable: false, createable: false, updateable: false, filterable: true, sortable: true }),
      fieldEntry('Name', { label: 'Account Name', nillable: false, sortable: true }),
      fieldEntry('ParentId', { type: 'reference', referenceTo: ['Account'], relationshipName: 'Parent' }),
      fieldEntry('Industry', {
        type: 'picklist',
        picklistValues: [
          { value: 'Technology', label: 'Technology', active: true, defaultValue: false },
          { value: 'Finance', label: 'Finance', active: 'true', defaultValue: true },
          { value: 'Retired', label: 'Retired', active: false, defaultValue: false },
        ],
      }),
      fieldEntry('Legacy__c', { custom: true, deprecatedAndHidden: true, type: 'string' }),
    ],
    childRelationships: [
      childRelationship('Contact', 'AccountId'),
      childRelationship('Opportunity', 'AccountId', { cascadeDelete: true }),
    ],
    ...overrides,
  });
}

test('describe returns the object facts, its fields and its child relationships', async () => {
  const fixture = createFixture({ handler: () => accountDescribe() });
  const output = await new DescribeSobjectExecutor(fixture.orgService).execute({ objectApiName: 'Account' });

  assert.equal(output.success, true);
  assert.equal(output.executionRole, 'USER');
  assert.equal(output.api, 'REST');
  assert.equal(output.objectApiName, 'Account');
  assert.equal(output.label, 'Account');
  assert.equal(output.labelPlural, 'Accounts');
  assert.equal(output.keyPrefix, '001');
  assert.equal(output.custom, false);
  assert.equal(output.queryable, true);
  assert.equal(output.searchable, true);
  assert.equal(output.fieldsIncluded, true);
  assert.equal(output.totalFields, 5);
  assert.equal(output.returnedFields, 5);
  assert.equal(output.truncated, false);
  assert.equal(output.hint, undefined);
  assert.deepEqual(fixture.calls, [{ operation: 'describe', argument: 'Account' }]);

  const parentId = output.fields?.find((field) => field.apiName === 'ParentId');
  assert.deepEqual(parentId?.referenceTo, ['Account']);
  assert.equal(parentId?.relationshipName, 'Parent');
  assert.equal(parentId?.type, 'reference');

  const legacy = output.fields?.find((field) => field.apiName === 'Legacy__c');
  assert.equal(legacy?.custom, true);
  assert.equal(legacy?.deprecatedAndHidden, true);

  assert.deepEqual(output.childRelationships?.map((child) => child.childSObject), ['Contact', 'Opportunity']);
  assert.equal(output.childRelationships?.find((child) => child.childSObject === 'Opportunity')?.cascadeDelete, true);
  assert.equal(output.totalChildRelationships, 2);
  assert.equal(output.returnedChildRelationships, 2);
});

test('picklist values are returned with their active flag read from either a boolean or a string', async () => {
  const fixture = createFixture({ handler: () => accountDescribe() });
  const output = await new DescribeSobjectExecutor(fixture.orgService).execute({ objectApiName: 'Account' });

  const industry = output.fields?.find((field) => field.apiName === 'Industry');
  assert.deepEqual(industry?.picklistValues, [
    { value: 'Technology', label: 'Technology', active: true, defaultValue: false },
    { value: 'Finance', label: 'Finance', active: true, defaultValue: true },
    { value: 'Retired', label: 'Retired', active: false, defaultValue: false },
  ]);
  assert.equal(industry?.picklistValuesTruncated, false);
});

test('a picklist label whose org text carries surrounding whitespace is returned unchanged', async () => {
  // A live describe() of Account returned the label "Z1 不检查信用 " — with a trailing space.
  // The Agent compares and copies these strings, so the Tool must report the org's bytes and
  // never a trimmed approximation of them.
  const fixture = createFixture({
    handler: () => accountDescribe({
      label: 'Account ',
      fields: [
        fieldEntry('Industry', {
          type: 'picklist',
          picklistValues: [
            { value: 'Z1', label: 'Z1 不检查信用 ', active: true, defaultValue: false },
            { value: ' Z2 ', label: ' Z2 ', active: true, defaultValue: false },
          ],
        }),
      ],
    }),
  });
  const output = await new DescribeSobjectExecutor(fixture.orgService).execute({ objectApiName: 'Account' });

  assert.equal(output.label, 'Account ');
  const industry = output.fields?.find((field) => field.apiName === 'Industry');
  assert.deepEqual(industry?.picklistValues, [
    { value: 'Z1', label: 'Z1 不检查信用 ', active: true, defaultValue: false },
    { value: ' Z2 ', label: ' Z2 ', active: true, defaultValue: false },
  ]);
});

test('a picklist wider than the documented maximum is cut and the answer says so', async () => {
  const wide = Array.from(
    { length: DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES + 25 },
    (_unused, index) => ({ value: `Value${String(index).padStart(3, '0')}`, label: `Value ${index}`, active: true, defaultValue: false }),
  );
  const fixture = createFixture({
    handler: () => accountDescribe({ fields: [fieldEntry('Industry', { type: 'picklist', picklistValues: wide })] }),
  });
  const output = await new DescribeSobjectExecutor(fixture.orgService).execute({ objectApiName: 'Account' });

  const industry = output.fields?.find((field) => field.apiName === 'Industry');
  assert.equal(industry?.picklistValues.length, DESCRIBE_SOBJECT_MAX_PICKLIST_VALUES);
  assert.equal(industry?.picklistValuesTruncated, true);
  assert.equal(output.truncated, true);
  assert.match(output.hint ?? '', /declare more than 100 picklist values/u);
});

test('fieldLimit cuts the field list and the hint states both the declared and the returned count', async () => {
  const fields = Array.from({ length: 40 }, (_unused, index) => fieldEntry(`Field${String(index).padStart(2, '0')}__c`, { custom: true }));
  const fixture = createFixture({ handler: () => accountDescribe({ fields }) });
  const output = await new DescribeSobjectExecutor(fixture.orgService).execute({ objectApiName: 'Account', fieldLimit: 10 });

  assert.equal(output.fields?.length, 10);
  assert.equal(output.totalFields, 40);
  assert.equal(output.returnedFields, 10);
  assert.equal(output.truncated, true);
  assert.match(output.hint ?? '', /40 fields are declared and 10 are returned \(fieldLimit=10\)/u);
  assert.doesNotMatch(output.hint ?? '', /response budget/u);
});

test('the default field limit is 200 when the Agent does not ask for one', async () => {
  const fields = Array.from({ length: DEFAULT_FIELD_LIMIT + 30 }, (_unused, index) => fieldEntry(`Field${String(index).padStart(3, '0')}__c`));
  const fixture = createFixture({ handler: () => accountDescribe({ fields }) });
  const output = await new DescribeSobjectExecutor(fixture.orgService).execute({ objectApiName: 'Account' });

  assert.equal(output.returnedFields, DEFAULT_FIELD_LIMIT);
  assert.equal(output.totalFields, DEFAULT_FIELD_LIMIT + 30);
  assert.equal(output.truncated, true);
  assert.match(output.hint ?? '', /fieldLimit=200/u);
});

test('the byte budget bounds a wide describe and the returned payload is within the documented budget', async () => {
  const fields = Array.from({ length: 1_000 }, (_unused, index) => fieldEntry(`Field${String(index).padStart(4, '0')}__c`, {
    custom: true,
    label: `Field label ${'x'.repeat(600)}`,
    referenceTo: ['Account', 'Contact', 'Opportunity', 'Case', 'Lead'],
  }));
  const fixture = createFixture({ handler: () => accountDescribe({ fields }) });
  const output = await new DescribeSobjectExecutor(fixture.orgService).execute({
    objectApiName: 'Account',
    fieldLimit: 1_000,
  });

  assert.equal(output.totalFields, 1_000);
  assert.equal(output.returnedFields, output.fields?.length);
  assert.ok((output.returnedFields ?? 0) > 0, 'the budget must still return the widest prefix that fits');
  assert.ok((output.returnedFields ?? 0) < 1_000, 'a 1000-wide describe cannot fit the budget');
  assert.equal(output.truncated, true);
  assert.match(output.hint ?? '', /cut to fit the 262144-byte response budget/u);
  // The hint and the truncation flags are part of the measured payload, so the response the
  // Agent receives — not merely the field array — is what the budget bounds.
  assert.ok(Buffer.byteLength(JSON.stringify(output), 'utf8') <= DATA_MAX_RESPONSE_BYTES);
});

test('includeFields false returns object level facts without a field list', async () => {
  const fixture = createFixture({ handler: () => accountDescribe() });
  const output = await new DescribeSobjectExecutor(fixture.orgService).execute({
    objectApiName: 'Account',
    includeFields: false,
  });

  assert.equal(output.fieldsIncluded, false);
  assert.equal(output.fields, undefined);
  assert.equal(output.totalFields, undefined);
  assert.equal(output.returnedFields, undefined);
  assert.equal(output.label, 'Account');
  assert.equal(output.totalChildRelationships, 2);
  assert.equal(output.truncated, false);
});

test('child relationships beyond the documented maximum are cut and counted', async () => {
  const children = Array.from({ length: 70 }, (_unused, index) => childRelationship(`Child${String(index).padStart(2, '0')}__c`, 'AccountId'));
  const fixture = createFixture({ handler: () => accountDescribe({ childRelationships: children }) });
  const output = await new DescribeSobjectExecutor(fixture.orgService).execute({ objectApiName: 'Account' });

  assert.equal(output.childRelationships?.length, 50);
  assert.equal(output.totalChildRelationships, 70);
  assert.equal(output.returnedChildRelationships, 50);
  assert.equal(output.truncated, true);
  assert.match(output.hint ?? '', /70 child relationships are declared and 50 are returned/u);
});

test('an unknown object name maps to MCP_SOBJECT_NOT_FOUND and points the Agent back at list_sobjects', async () => {
  const fixture = createFixture({
    handler: () => {
      throw salesforceError('INVALID_TYPE', 'sObject type Accountt is not supported');
    },
  });

  await assert.rejects(
    () => new DescribeSobjectExecutor(fixture.orgService).execute({ objectApiName: 'Accountt' }),
    (error: unknown) => {
      assert.ok(error instanceof DataRuntimeError);
      assert.equal(error.code, 'MCP_SOBJECT_NOT_FOUND');
      assert.match(error.message, /does not expose an object named Accountt/u);
      assert.match(error.message, /Salesforce reported: sObject type Accountt is not supported/u);
      assert.match(error.suggestion ?? '', /call list_sobjects/u);
      return true;
    },
  );
});

test('a Salesforce permission failure maps to MCP_SOBJECT_ACCESS_DENIED rather than a not-found', async () => {
  const fixture = createFixture({
    handler: () => {
      throw salesforceError('INSUFFICIENT_ACCESS_OR_READONLY', 'insufficient access to describe Account');
    },
  });

  await assert.rejects(
    () => new DescribeSobjectExecutor(fixture.orgService).execute({ objectApiName: 'Account' }),
    (error: unknown) => {
      assert.ok(error instanceof DataRuntimeError);
      assert.equal(error.code, 'MCP_SOBJECT_ACCESS_DENIED');
      assert.match(error.suggestion ?? '', /Report the missing Salesforce permission/u);
      return true;
    },
  );
});

test('an unavailable request identity is refused before any describe call', async () => {
  const fixture = createFixture({ usernames: [] });

  await assert.rejects(
    () => new DescribeSobjectExecutor(fixture.orgService).execute({ objectApiName: 'Account' }),
    (error: unknown) => {
      assert.ok(error instanceof DataRuntimeError);
      assert.equal(error.code, 'MCP_DATA_IDENTITY_UNAVAILABLE');
      return true;
    },
  );
  assert.deepEqual(fixture.calls, []);
});

test('an unrecognized describe failure falls back to MCP_SOBJECT_DESCRIBE_FAILED and names the object', async () => {
  const fixture = createFixture({
    handler: () => {
      throw new Error('request timed out');
    },
  });

  await assert.rejects(
    () => new DescribeSobjectExecutor(fixture.orgService).execute({ objectApiName: 'Account' }),
    (error: unknown) => {
      assert.ok(error instanceof DataRuntimeError);
      assert.equal(error.code, 'MCP_SOBJECT_DESCRIBE_FAILED');
      assert.equal(error.message, 'Salesforce could not describe object Account for this request.');
      assert.doesNotMatch(error.message, /timed out/u);
      return true;
    },
  );
});

test('a describe payload missing an object name falls back to the requested name', async () => {
  const fixture = createFixture({ handler: () => ({ label: 'Account', fields: [] }) });
  const output = await new DescribeSobjectExecutor(fixture.orgService).execute({ objectApiName: 'Account' });

  assert.equal(output.objectApiName, 'Account');
  assert.equal(output.label, 'Account');
  assert.equal(output.labelPlural, 'Account');
});

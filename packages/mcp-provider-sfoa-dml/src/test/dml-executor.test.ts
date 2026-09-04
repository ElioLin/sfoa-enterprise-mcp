import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import {
  DmlExecutor,
  DmlRuntimeError,
  dmlExecutionErrorToolResult,
  parseDmlAllowlistJson,
  type MutationExecutionObserver,
} from '../index.js';

type MutationCall = Readonly<{
  operation: 'CREATE' | 'UPDATE';
  objectApiName: string;
  record: Readonly<Record<string, unknown>>;
}>;

test('explicitly allowed CREATE and UPDATE use the one request-scoped Connection', async () => {
  const calls: MutationCall[] = [];
  const mutationStarts: Array<'CREATE' | 'UPDATE'> = [];
  const connection = createConnection(calls);
  const orgService = new TestOrgService(['user-a@example.test'], connection);
  const executor = new DmlExecutor(
    orgService,
    parseDmlAllowlistJson(JSON.stringify([
      { objectApiName: 'Lead', operations: ['CREATE', 'UPDATE'] },
    ])),
    { onMutationStarted: (operation) => mutationStarts.push(operation) },
  );

  assert.equal(
    await executor.create({ objectApiName: 'Lead', fields: { LastName: 'P3', Company: 'SFoA' } }),
    '00Q000000000001AAA',
  );
  assert.equal(
    await executor.update({
      objectApiName: 'Lead',
      recordId: '00Q000000000001AAA',
      fields: { Company: 'Updated' },
    }),
    '00Q000000000001AAA',
  );

  assert.deepEqual(orgService.requestedUsernames, ['user-a@example.test', 'user-a@example.test']);
  assert.deepEqual(mutationStarts, ['CREATE', 'UPDATE']);
  assert.deepEqual(calls, [
    {
      operation: 'CREATE',
      objectApiName: 'Lead',
      record: { LastName: 'P3', Company: 'SFoA' },
    },
    {
      operation: 'UPDATE',
      objectApiName: 'Lead',
      record: { Id: '00Q000000000001AAA', Company: 'Updated' },
    },
  ]);
});

test('mutation observer receives the exact submitted fields and Salesforce result record ID', async () => {
  const calls: MutationCall[] = [];
  const submitted: Array<Readonly<Record<string, unknown>>> = [];
  const completed: Array<Readonly<{ operation: 'CREATE' | 'UPDATE'; recordId: string }>> = [];
  const observer: MutationExecutionObserver = {
    onMutationStarted: () => undefined,
    async runWithSubmittedFields<T>(fields: Readonly<Record<string, string | number | boolean | null>>, callback: () => Promise<T>): Promise<T> {
      submitted.push(Object.freeze({ ...fields }));
      return await callback();
    },
    onMutationCompleted: (operation, recordId) => completed.push(Object.freeze({ operation, recordId })),
  };
  const executor = new DmlExecutor(
    new TestOrgService(['user-a@example.test'], createConnection(calls)),
    parseDmlAllowlistJson(JSON.stringify([{ objectApiName: 'Lead', operations: ['CREATE', 'UPDATE'] }])),
    observer,
  );

  await executor.create({ objectApiName: 'Lead', fields: { LastName: 'Exact', Active__c: true } });
  await executor.update({
    objectApiName: 'Lead',
    recordId: '00Q000000000001AAA',
    fields: { Company: 'Final', Score__c: 7 },
  });

  assert.deepEqual(submitted, [
    { LastName: 'Exact', Active__c: true },
    { Company: 'Final', Score__c: 7 },
  ]);
  assert.deepEqual(completed, [
    { operation: 'CREATE', recordId: '00Q000000000001AAA' },
    { operation: 'UPDATE', recordId: '00Q000000000001AAA' },
  ]);
  assert.equal(Object.hasOwn(submitted[1] ?? {}, 'Id'), false);
});

test('create_record folds a top-level recordTypeId into the authoritative RecordTypeId payload field', async () => {
  const calls: MutationCall[] = [];
  const submitted: Array<Readonly<Record<string, unknown>>> = [];
  const executor = new DmlExecutor(
    new TestOrgService(['user-a@example.test'], createConnection(calls)),
    parseDmlAllowlistJson(JSON.stringify([{ objectApiName: 'Lead', operations: ['CREATE'] }])),
    {
      onMutationStarted: () => undefined,
      async runWithSubmittedFields<T>(
        fields: Readonly<Record<string, string | number | boolean | null>>,
        callback: () => Promise<T>,
      ): Promise<T> {
        submitted.push(Object.freeze({ ...fields }));
        return await callback();
      },
    },
  );
  const RT = '012000000000002AAA';

  const recordId = await executor.create({
    objectApiName: 'Lead',
    recordTypeId: RT,
    fields: { LastName: 'RT Lead', RecordTypeId: RT },
  });

  assert.equal(recordId, '00Q000000000001AAA');
  // The payload must carry exactly the top-level Record Type and no duplicate key.
  assert.deepEqual(calls[0]?.record, { LastName: 'RT Lead', RecordTypeId: RT });
  assert.deepEqual(submitted, [{ LastName: 'RT Lead', RecordTypeId: RT }]);
  assert.deepEqual(
    Object.keys(calls[0]?.record ?? {}).filter((name) => name.toLocaleLowerCase('en-US') === 'recordtypeid'),
    ['RecordTypeId'],
  );
});

test('allowlist denial happens before a Salesforce Connection or mutation is requested', async () => {
  const calls: MutationCall[] = [];
  const mutationStarts: Array<'CREATE' | 'UPDATE'> = [];
  const orgService = new TestOrgService(['user-a@example.test'], createConnection(calls));
  const executor = new DmlExecutor(
    orgService,
    parseDmlAllowlistJson(JSON.stringify([{ objectApiName: 'Lead', operations: ['CREATE'] }])),
    { onMutationStarted: (operation) => mutationStarts.push(operation) },
  );

  await assert.rejects(
    executor.update({
      objectApiName: 'Lead',
      recordId: '00Q000000000001AAA',
      fields: { Company: 'Denied' },
    }),
    isDmlError('MCP_DML_OPERATION_NOT_ALLOWED'),
  );
  assert.deepEqual(orgService.requestedUsernames, []);
  assert.deepEqual(calls, []);
  assert.deepEqual(mutationStarts, []);
});

test('zero or multiple request identities fail closed without executing Salesforce DML', async () => {
  for (const usernames of [[], ['a@example.test', 'b@example.test']]) {
    const calls: MutationCall[] = [];
    const mutationStarts: Array<'CREATE' | 'UPDATE'> = [];
    const executor = new DmlExecutor(
      new TestOrgService(usernames, createConnection(calls)),
      parseDmlAllowlistJson(JSON.stringify([{ objectApiName: 'Lead', operations: ['CREATE'] }])),
      { onMutationStarted: (operation) => mutationStarts.push(operation) },
    );
    await assert.rejects(
      executor.create({ objectApiName: 'Lead', fields: { LastName: 'P3' } }),
      isDmlError('MCP_DML_IDENTITY_CONTEXT_INVALID'),
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(mutationStarts, []);
  }
});

test('Salesforce errors preserve safe code/message/fields and redact credentials', async () => {
  const calls: MutationCall[] = [];
  const connection = createConnection(calls, {
    createError: {
      errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      message: 'Validation failed; Bearer secret-access-token access_token=abc123',
      fields: ['Company'],
    },
  });
  const executor = new DmlExecutor(
    new TestOrgService(['user-a@example.test'], connection),
    parseDmlAllowlistJson(JSON.stringify([{ objectApiName: 'Lead', operations: ['CREATE'] }])),
  );

  let failure: unknown;
  try {
    await executor.create({ objectApiName: 'Lead', fields: { LastName: 'Rejected' } });
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof DmlRuntimeError);
  assert.equal(failure.code, 'MCP_SALESFORCE_DML_FAILED');
  const result = dmlExecutionErrorToolResult(failure, 'CREATE');
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    success: false,
    errorCode: 'MCP_SALESFORCE_DML_FAILED',
    message: 'Salesforce rejected the CREATE operation. Check Salesforce permissions, field access, required values, validation rules, and automation.',
    salesforceErrors: [{
      errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      message: 'Validation failed; Bearer [REDACTED] access_token=[REDACTED]',
      fields: ['Company'],
    }],
  });
  assert.doesNotMatch(JSON.stringify(result), /secret-access-token|abc123/u);
});

test('REQUIRED_FIELD_MISSING is an explicit Salesforce rejection, not an unknown outcome', async () => {
  const calls: MutationCall[] = [];
  const rejection = createJsforceRejection(
    'REQUIRED_FIELD_MISSING',
    'Required fields are missing: [Company]',
    ['Company'],
  );
  const executor = createLeadExecutor(createConnection(calls, { createException: rejection }));

  const failure = await captureDmlError(
    executor.create({ objectApiName: 'Lead', fields: { LastName: 'Rejected' } }),
  );

  assert.equal(failure.code, 'MCP_SALESFORCE_DML_FAILED');
  assert.deepEqual(failure.salesforceErrors, [{
    errorCode: 'REQUIRED_FIELD_MISSING',
    message: 'Required fields are missing: [Company]',
    fields: ['Company'],
  }]);
  assert.equal(calls.length, 1);
});

test('FIELD_CUSTOM_VALIDATION_EXCEPTION remains an explicit Salesforce rejection', async () => {
  const calls: MutationCall[] = [];
  const rejection = createJsforceRejection(
    'FIELD_CUSTOM_VALIDATION_EXCEPTION',
    'Company is not permitted for this test user.',
    ['Company'],
  );
  const executor = createLeadExecutor(createConnection(calls, { createException: rejection }));

  const failure = await captureDmlError(
    executor.create({ objectApiName: 'Lead', fields: { LastName: 'Rejected' } }),
  );

  assert.equal(failure.code, 'MCP_SALESFORCE_DML_FAILED');
  assert.deepEqual(failure.salesforceErrors, [{
    errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
    message: 'Company is not permitted for this test user.',
    fields: ['Company'],
  }]);
  assert.equal(calls.length, 1);
});

test('INVALID_FIELD with no fields array is still an explicit Salesforce rejection', async () => {
  const calls: MutationCall[] = [];
  const rejection = createJsforceRejectionWithoutFields(
    'INVALID_FIELD',
    "No such column 'Opportunity_Summary__c' on sobject of type Lead",
  );
  const executor = createLeadExecutor(createConnection(calls, { createException: rejection }));

  const failure = await captureDmlError(
    executor.create({ objectApiName: 'Lead', fields: { LastName: 'Rejected' } }),
  );

  assert.equal(failure.code, 'MCP_SALESFORCE_DML_FAILED');
  assert.deepEqual(failure.salesforceErrors, [{
    errorCode: 'INVALID_FIELD',
    message: "No such column 'Opportunity_Summary__c' on sobject of type Lead",
    fields: [],
  }]);
  assert.equal(calls.length, 1);
});

test('a primitive HttpApiError.data body (e.g. an HTML error page) remains an unknown outcome', async () => {
  const calls: MutationCall[] = [];
  const htmlTransportFailure = Object.assign(new Error('HTTP response contains html content.'), {
    name: 'ERROR_HTTP_502',
    errorCode: 'ERROR_HTTP_502',
    data: '<html>502 Bad Gateway</html>',
  });
  const executor = createLeadExecutor(createConnection(calls, { createException: htmlTransportFailure }));

  const failure = await captureDmlError(
    executor.create({ objectApiName: 'Lead', fields: { LastName: 'Unknown' } }),
  );

  assert.equal(failure.code, 'MCP_DML_OUTCOME_UNKNOWN');
  assert.match(failure.message, /Do not automatically retry/u);
  assert.deepEqual(failure.salesforceErrors, []);
  assert.equal(calls.length, 1);
});

test('transport and unstructured SDK exceptions produce unknown outcomes without automatic retry', async () => {
  const calls: MutationCall[] = [];
  const transportFailure = Object.assign(new Error('socket disconnected before the response was received'), {
    code: 'ECONNRESET',
  });
  const sdkFailure = new Error('SDK rejected without Salesforce response evidence');
  const executor = createLeadExecutor(createConnection(calls, {
    createException: transportFailure,
    updateException: sdkFailure,
  }));

  const createFailure = await captureDmlError(
    executor.create({ objectApiName: 'Lead', fields: { LastName: 'Unknown' } }),
  );
  const updateFailure = await captureDmlError(
    executor.update({
      objectApiName: 'Lead',
      recordId: '00Q000000000001AAA',
      fields: { Company: 'Unknown' },
    }),
  );

  for (const failure of [createFailure, updateFailure]) {
    assert.equal(failure.code, 'MCP_DML_OUTCOME_UNKNOWN');
    assert.match(failure.message, /Do not automatically retry/u);
    assert.deepEqual(failure.salesforceErrors, []);
  }
  assert.deepEqual(calls.map((call) => call.operation), ['CREATE', 'UPDATE']);
});

test('required, validation, and authorization rejection details remain safely structured', async () => {
  for (const errorCode of [
    'REQUIRED_FIELD_MISSING',
    'FIELD_CUSTOM_VALIDATION_EXCEPTION',
    'INSUFFICIENT_ACCESS_OR_READONLY',
  ]) {
    const calls: MutationCall[] = [];
    const message = `${errorCode} safe message`;
    const executor = createLeadExecutor(createConnection(calls, {
      createError: { errorCode, message, fields: ['Company'] },
    }));
    const failure = await captureDmlError(
      executor.create({ objectApiName: 'Lead', fields: { LastName: 'Rejected' } }),
    );
    const result = dmlExecutionErrorToolResult(failure, 'CREATE');

    assert.equal(failure.code, 'MCP_SALESFORCE_DML_FAILED');
    assert.deepEqual(result.structuredContent, {
      success: false,
      errorCode: 'MCP_SALESFORCE_DML_FAILED',
      message: 'Salesforce rejected the CREATE operation. Check Salesforce permissions, field access, required values, validation rules, and automation.',
      salesforceErrors: [{ errorCode, message, fields: ['Company'] }],
    });
    assert.equal(calls.length, 1);
  }
});

class TestOrgService implements OrgService {
  public readonly requestedUsernames: string[] = [];

  public constructor(
    private readonly usernames: readonly string[],
    private readonly connection: Connection,
  ) {}

  public getAllowedOrgUsernames(): Promise<Set<string>> {
    return Promise.resolve(new Set(this.usernames));
  }

  public getAllowedOrgs(): Promise<[]> {
    return Promise.resolve([]);
  }

  public getConnection(username: string): Promise<Connection> {
    this.requestedUsernames.push(username);
    return Promise.resolve(this.connection);
  }

  public getDefaultTargetOrg(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  public getDefaultTargetDevHub(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  public findOrgByUsernameOrAlias(): undefined {
    return undefined;
  }
}

function createConnection(
  calls: MutationCall[],
  options: Readonly<{
    createError?: Readonly<Record<string, unknown>>;
    createException?: unknown;
    updateException?: unknown;
  }> = {},
): Connection {
  return {
    sobject: (objectApiName: string) => ({
      create: async (record: Record<string, unknown>) => {
        calls.push({ operation: 'CREATE', objectApiName, record: { ...record } });
        if (options.createException !== undefined) throw options.createException;
        return options.createError
          ? { success: false, errors: [options.createError] }
          : { success: true, id: '00Q000000000001AAA', errors: [] };
      },
      update: async (record: Record<string, unknown>) => {
        calls.push({ operation: 'UPDATE', objectApiName, record: { ...record } });
        if (options.updateException !== undefined) throw options.updateException;
        return { success: true, id: String(record.Id), errors: [] };
      },
    }),
  } as unknown as Connection;
}

function isDmlError(code: DmlRuntimeError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof DmlRuntimeError && error.code === code;
}

function createLeadExecutor(connection: Connection): DmlExecutor {
  return new DmlExecutor(
    new TestOrgService(['user-a@example.test'], connection),
    parseDmlAllowlistJson(JSON.stringify([
      { objectApiName: 'Lead', operations: ['CREATE', 'UPDATE'] },
    ])),
  );
}

function createJsforceRejection(
  errorCode: string,
  message: string,
  fields: readonly string[],
): Error {
  return Object.assign(new Error(message), {
    errorCode,
    data: { errorCode, message, fields: [...fields] },
  });
}

function createJsforceRejectionWithoutFields(
  errorCode: string,
  message: string,
): Error {
  return Object.assign(new Error(message), {
    errorCode,
    data: { errorCode, message },
  });
}

async function captureDmlError(operation: Promise<string>): Promise<DmlRuntimeError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof DmlRuntimeError) return error;
    throw error;
  }
  throw new Error('Expected DML operation to fail.');
}

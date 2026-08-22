import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import {
  DmlExecutor,
  DmlRuntimeError,
  dmlExecutionErrorToolResult,
  parseDmlAllowlistJson,
} from '../index.js';

type MutationCall = Readonly<{
  operation: 'CREATE' | 'UPDATE';
  objectApiName: string;
  record: Readonly<Record<string, unknown>>;
}>;

test('explicitly allowed CREATE and UPDATE use the one request-scoped Connection', async () => {
  const calls: MutationCall[] = [];
  const connection = createConnection(calls);
  const orgService = new TestOrgService(['user-a@example.test'], connection);
  const executor = new DmlExecutor(
    orgService,
    parseDmlAllowlistJson(JSON.stringify([
      { objectApiName: 'Lead', operations: ['CREATE', 'UPDATE'] },
    ])),
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

test('allowlist denial happens before a Salesforce Connection or mutation is requested', async () => {
  const calls: MutationCall[] = [];
  const orgService = new TestOrgService(['user-a@example.test'], createConnection(calls));
  const executor = new DmlExecutor(
    orgService,
    parseDmlAllowlistJson(JSON.stringify([{ objectApiName: 'Lead', operations: ['CREATE'] }])),
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
});

test('zero or multiple request identities fail closed without executing Salesforce DML', async () => {
  for (const usernames of [[], ['a@example.test', 'b@example.test']]) {
    const calls: MutationCall[] = [];
    const executor = new DmlExecutor(
      new TestOrgService(usernames, createConnection(calls)),
      parseDmlAllowlistJson(JSON.stringify([{ objectApiName: 'Lead', operations: ['CREATE'] }])),
    );
    await assert.rejects(
      executor.create({ objectApiName: 'Lead', fields: { LastName: 'P3' } }),
      isDmlError('MCP_DML_IDENTITY_CONTEXT_INVALID'),
    );
    assert.deepEqual(calls, []);
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
  const result = dmlExecutionErrorToolResult(failure);
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
  options: Readonly<{ createError?: Readonly<Record<string, unknown>> }> = {},
): Connection {
  return {
    sobject: (objectApiName: string) => ({
      create: async (record: Record<string, unknown>) => {
        calls.push({ operation: 'CREATE', objectApiName, record: { ...record } });
        return options.createError
          ? { success: false, errors: [options.createError] }
          : { success: true, id: '00Q000000000001AAA', errors: [] };
      },
      update: async (record: Record<string, unknown>) => {
        calls.push({ operation: 'UPDATE', objectApiName, record: { ...record } });
        return { success: true, id: String(record.Id), errors: [] };
      },
    }),
  } as unknown as Connection;
}

function isDmlError(code: DmlRuntimeError['code']): (error: unknown) => boolean {
  return (error: unknown) => error instanceof DmlRuntimeError && error.code === code;
}

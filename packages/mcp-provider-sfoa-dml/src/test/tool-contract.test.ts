import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import {
  CreateRecordMcpTool,
  DmlExecutor,
  SFOA_DML_TOOL_NAMES,
  UpdateRecordMcpTool,
  createRecordInputSchema,
  parseDmlAllowlistJson,
  updateRecordInputSchema,
} from '../index.js';

const connection = {
  sobject: () => ({
    create: async () => ({ success: true, id: '00Q000000000001AAA', errors: [] }),
    update: async () => ({ success: true, id: '00Q000000000001AAA', errors: [] }),
  }),
} as unknown as Connection;
const orgService = {
  getAllowedOrgUsernames: async () => new Set(['user-a@example.test']),
  getAllowedOrgs: async () => [],
  getConnection: async () => connection,
  getDefaultTargetOrg: async () => undefined,
  getDefaultTargetDevHub: async () => undefined,
  findOrgByUsernameOrAlias: () => undefined,
} satisfies OrgService;
const executor = new DmlExecutor(
  orgService,
  parseDmlAllowlistJson(JSON.stringify([{ objectApiName: 'Lead', operations: ['CREATE', 'UPDATE'] }])),
);

test('P3 provider Tool surface is exactly CREATE and UPDATE with complete mutation annotations', () => {
  assert.deepEqual(SFOA_DML_TOOL_NAMES, ['create_record', 'update_record']);
  assert.equal(SFOA_DML_TOOL_NAMES.some((name) => /delete|upsert|rest|deploy|admin/iu.test(name)), false);

  for (const tool of [new CreateRecordMcpTool(executor), new UpdateRecordMcpTool(executor)]) {
    const config = tool.getConfig();
    assert(config.inputSchema);
    assert(config.outputSchema);
    assert(config.description);
    assert.match(config.description, /not idempotent/iu);
    assert.match(config.description, /Do not automatically retry/iu);
    assert.match(config.description, /Tool\/request timeout or transport interruption/iu);
    assert.match(config.description, /read-only Tool/iu);
    assert.match(config.description, /inform the user/iu);
    assert.deepEqual(config.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  }
});

test('CREATE input accepts only objectApiName plus non-empty scalar fields', () => {
  assert.equal(createRecordInputSchema.safeParse({
    objectApiName: 'Lead',
    fields: { LastName: 'P3', Company: 'SFoA', NumberOfEmployees: 5, Active__c: true },
  }).success, true);

  const invalid = [
    { objectApiName: 'Lead', fields: {} },
    { objectApiName: 'Lead', fields: { Id: '00Q000000000001AAA' } },
    { objectApiName: 'Lead', fields: { 'Account.Name': 'forbidden' } },
    { objectApiName: 'Lead', fields: { Company: { nested: true } } },
    { objectApiName: 'Lead', fields: { Company: ['bulk'] } },
    { objectApiName: 'Lead', fields: { LastName: 'P3' }, operation: 'CREATE' },
    { objectApiName: 'Lead', fields: { LastName: 'P3' }, platformUserId: 'forged' },
    { objectApiName: 'Lead', fields: { LastName: 'P3' }, username: 'forged@example.test' },
    { objectApiName: 'Lead', fields: { LastName: 'P3' }, instanceUrl: 'https://evil.example' },
    { objectApiName: 'Lead', fields: { LastName: 'P3' }, accessToken: 'secret' },
    { objectApiName: 'Lead', fields: { LastName: 'P3' }, directory: 'C:\\forged' },
    { objectApiName: 'Lead', fields: { LastName: 'P3' }, apiVersion: '99.0' },
    { objectApiName: 'Lead', fields: { LastName: 'P3' }, path: '/services/data' },
  ];
  for (const input of invalid) assert.equal(createRecordInputSchema.safeParse(input).success, false);
});

test('create_record recordTypeId is optional, backward-compatible, and conflict-safe', () => {
  const RT_A = '012000000000001AAA';
  const RT_B = '012000000000002AAA';
  const baseFields = { LastName: 'P3', Company: 'SFoA' };

  // Top-level optional recordTypeId is accepted alone.
  assert.equal(createRecordInputSchema.safeParse({ objectApiName: 'Lead', recordTypeId: RT_A, fields: { ...baseFields } }).success, true);
  // Legacy call without recordTypeId keeps working.
  assert.equal(createRecordInputSchema.safeParse({ objectApiName: 'Lead', fields: { ...baseFields } }).success, true);
  // Legacy fields.RecordTypeId keeps working without a top-level value.
  assert.equal(createRecordInputSchema.safeParse({ objectApiName: 'Lead', fields: { ...baseFields, RecordTypeId: RT_A } }).success, true);
  // Identical top-level and fields.RecordTypeId (same 15-char prefix) is not a conflict.
  assert.equal(createRecordInputSchema.safeParse({ objectApiName: 'Lead', recordTypeId: RT_A, fields: { ...baseFields, RecordTypeId: RT_A } }).success, true);
  // Conflicting values are rejected so the analyzed and created Record Types cannot diverge.
  assert.equal(createRecordInputSchema.safeParse({ objectApiName: 'Lead', recordTypeId: RT_A, fields: { ...baseFields, RecordTypeId: RT_B } }).success, false);
  // A malformed top-level ID is rejected by the schema.
  assert.equal(createRecordInputSchema.safeParse({ objectApiName: 'Lead', recordTypeId: 'not-an-id', fields: { ...baseFields } }).success, false);
  // A malformed fields.RecordTypeId alongside a top-level ID is a conflict.
  assert.equal(createRecordInputSchema.safeParse({ objectApiName: 'Lead', recordTypeId: RT_A, fields: { ...baseFields, RecordTypeId: 'blah' } }).success, false);
});

test('UPDATE keeps recordId separate and structurally excludes Id, upsert, relationship, and identity inputs', () => {
  assert.equal(updateRecordInputSchema.safeParse({
    objectApiName: 'Lead',
    recordId: '00Q000000000001AAA',
    fields: { Company: 'Updated' },
  }).success, true);

  const invalid = [
    { objectApiName: 'Lead', recordId: 'bad', fields: { Company: 'Updated' } },
    { objectApiName: 'Lead', recordId: '00Q000000000001AAA', fields: {} },
    { objectApiName: 'Lead', recordId: '00Q000000000001AAA', fields: { Id: '00Q000000000002AAA' } },
    { objectApiName: 'Lead', recordId: '00Q000000000001AAA', fields: { id: '00Q000000000002AAA' } },
    { objectApiName: 'Lead', recordId: '00Q000000000001AAA', fields: { 'Account.Name': 'forbidden' } },
    { objectApiName: 'Lead', recordId: '00Q000000000001AAA', fields: { Company: 'Updated' }, externalId: 'x' },
    { objectApiName: 'Lead', recordId: '00Q000000000001AAA', fields: { Company: 'Updated' }, operation: 'UPSERT' },
    { objectApiName: 'Lead', recordId: '00Q000000000001AAA', fields: { Company: 'Updated' }, salesforceUsername: 'forged@example.test' },
  ];
  for (const input of invalid) assert.equal(updateRecordInputSchema.safeParse(input).success, false);
});

test('Tool-level invalid input has stable MCP_DML_INPUT_INVALID semantics', async () => {
  const mutationStarts: Array<'CREATE' | 'UPDATE'> = [];
  const invalidInputExecutor = new DmlExecutor(
    orgService,
    parseDmlAllowlistJson(JSON.stringify([{ objectApiName: 'Lead', operations: ['CREATE', 'UPDATE'] }])),
    { onMutationStarted: (operation) => mutationStarts.push(operation) },
  );
  const create = new CreateRecordMcpTool(invalidInputExecutor);
  const update = new UpdateRecordMcpTool(invalidInputExecutor);
  const createResult = await create.exec({ objectApiName: 'Lead', fields: {} });
  const updateResult = await update.exec({
    objectApiName: 'Lead',
    recordId: 'bad',
    fields: { Company: 'Updated' },
  });
  assert.equal(createResult.isError, true);
  assert.equal(updateResult.isError, true);
  assert.equal(readErrorCode(createResult.structuredContent), 'MCP_DML_INPUT_INVALID');
  assert.equal(readErrorCode(updateResult.structuredContent), 'MCP_DML_INPUT_INVALID');
  assert.deepEqual(mutationStarts, []);
});

function readErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return 'errorCode' in value && typeof value.errorCode === 'string' ? value.errorCode : undefined;
}

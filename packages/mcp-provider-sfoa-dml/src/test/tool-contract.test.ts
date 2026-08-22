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
  const create = new CreateRecordMcpTool(executor);
  const update = new UpdateRecordMcpTool(executor);
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
});

function readErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return 'errorCode' in value && typeof value.errorCode === 'string' ? value.errorCode : undefined;
}

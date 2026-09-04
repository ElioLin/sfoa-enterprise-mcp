import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrgService, Services } from '@salesforce/mcp-provider-api';
import {
  SFOA_CONTEXT_TOOL_NAMES,
  SFOA_CONTEXT_TOOL_ROLES,
  SfoaContextMcpProvider,
} from '../provider.js';
import {
  diagnosticQueryInputSchema,
  metadataContextInputSchema,
  recordActionContextInputSchema,
  recordDisplayContextInputSchema,
} from '../schemas.js';

const forbiddenFields = [
  'platformUserId',
  'connectionRole',
  'diagnosticUsername',
  'username',
  'usernameOrAlias',
  'targetUsername',
  'salesforceUsername',
  'credentialProfile',
  'accessToken',
  'instanceUrl',
  'useToolingApi',
  'directory',
  'sourceDir',
  'manifest',
  'outputPath',
  'arbitraryRestUrl',
];

test('P4 Provider exposes exactly four GA Tools with stable output schemas and complete read-only annotations', async () => {
  const provider = new SfoaContextMcpProvider({
    diagnosticQueryExecutor: {
      execute: async () => ({ records: [], totalSize: 0, returnedRecords: 0, done: true, truncated: false }),
    },
    metadataContextExecutor: {
      execute: async (input) => ({
        success: true,
        executionRole: 'DIAGNOSTIC',
        metadataType: input.metadataType,
        fullName: input.fullName,
        files: [],
        omittedFiles: [],
        totalFiles: 0,
        returnedFiles: 0,
        totalBytes: 0,
        returnedBytes: 0,
        truncated: false,
        limits: { maxReturnedFiles: 40, maxFileBytes: 65_536, maxTotalBytes: 262_144, maxFileSummaries: 100 },
      }),
    },
  });
  const tools = await provider.provideTools(createServices());
  assert.deepEqual(tools.map((tool) => tool.getName()), [...SFOA_CONTEXT_TOOL_NAMES]);
  for (const tool of tools) {
    const config = tool.getConfig();
    assert.ok(config.outputSchema);
    assert.deepEqual(config.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    const inputNames = Object.keys(config.inputSchema ?? {});
    assert.deepEqual(inputNames.filter((name) => forbiddenFields.includes(name)), []);
  }
  assert.deepEqual(SFOA_CONTEXT_TOOL_ROLES, {
    get_record_action_context: 'USER',
    run_diagnostic_tooling_query: 'DIAGNOSTIC',
    get_metadata_component_context: 'DIAGNOSTIC',
    get_record_display_context: 'USER',
  });
});

test('diagnostic query is SELECT-only and has no Tooling or identity switch', () => {
  assert.equal(diagnosticQueryInputSchema.safeParse({ query: 'SELECT Id FROM ApexClass LIMIT 5' }).success, true);
  assert.equal(diagnosticQueryInputSchema.safeParse({ query: 'UPDATE Account SET Name = \'x\'' }).success, false);
  assert.equal(diagnosticQueryInputSchema.safeParse({ query: 'SELECT Id FROM ApexClass; SELECT Id FROM Account' }).success, false);
  assert.equal(diagnosticQueryInputSchema.safeParse({ query: 'SELECT Id FROM ApexClass FOR UPDATE' }).success, false);
  assert.equal(diagnosticQueryInputSchema.safeParse({ query: 'SELECT Id FROM ApexClass', useToolingApi: false }).success, false);
  assert.equal(diagnosticQueryInputSchema.safeParse({ query: 'SELECT Id FROM ApexClass', username: 'forged' }).success, false);
});

test('metadata context enforces the type allowlist and rejects client paths/traversal', () => {
  assert.equal(metadataContextInputSchema.safeParse({ metadataType: 'ValidationRule', fullName: 'Lead.Rule_Name' }).success, true);
  assert.equal(metadataContextInputSchema.safeParse({ metadataType: 'Profile', fullName: 'Admin' }).success, false);
  assert.equal(metadataContextInputSchema.safeParse({ metadataType: 'ApexClass', fullName: '../Secret' }).success, false);
  assert.equal(metadataContextInputSchema.safeParse({ metadataType: 'ApexClass', fullName: 'Good', directory: 'C:\\temp' }).success, false);
});

test('record action input enforces CREATE/UPDATE record identity rules and rejects forged authority', () => {
  assert.equal(recordActionContextInputSchema.safeParse({ objectApiName: 'Lead', action: 'CREATE' }).success, true);
  assert.equal(recordActionContextInputSchema.safeParse({ objectApiName: 'Lead', action: 'UPDATE' }).success, false);
  assert.equal(recordActionContextInputSchema.safeParse({ objectApiName: 'Lead', action: 'CREATE', recordId: '00Q000000000001AAA' }).success, false);
  assert.equal(recordActionContextInputSchema.safeParse({ objectApiName: 'Lead', action: 'CREATE', username: 'forged' }).success, false);
});

test('record display input is READ-only object display context and rejects forged authority', () => {
  assert.equal(recordDisplayContextInputSchema.safeParse({ objectApiName: 'Lead' }).success, true);
  assert.equal(recordDisplayContextInputSchema.safeParse({ objectApiName: 'Lead', recordTypeId: '012000000000001AAA' }).success, true);
  assert.equal(recordDisplayContextInputSchema.safeParse({ objectApiName: 'Lead', recordTypeId: 'bad-id' }).success, false);
  assert.equal(recordDisplayContextInputSchema.safeParse({ objectApiName: 'Case', recordId: '500000000000001AAA' }).success, false);
  assert.equal(recordDisplayContextInputSchema.safeParse({ objectApiName: 'Lead', action: 'CREATE' }).success, false);
  assert.equal(recordDisplayContextInputSchema.safeParse({ objectApiName: 'Lead', username: 'forged' }).success, false);
});

function createServices(): Services {
  const orgService = {
    getAllowedOrgUsernames: async () => new Set(['user@example.test']),
    getConnection: async () => {
      throw new Error('not invoked by Tool contract test');
    },
  } as unknown as OrgService;
  return {
    getOrgService: () => orgService,
    getTelemetryService: () => ({ sendEvent: () => undefined }),
    getConfigService: () => ({
      getDataDir: () => process.cwd(),
      getStartupFlags: () => ({ 'allow-non-ga-tools': false, debug: false }),
    }),
  };
}

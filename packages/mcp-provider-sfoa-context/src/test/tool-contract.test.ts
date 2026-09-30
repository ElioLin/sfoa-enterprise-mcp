import assert from 'node:assert/strict';
import test from 'node:test';
import { ReleaseState, Toolset, type OrgService, type Services } from '@salesforce/mcp-provider-api';
import {
  SFOA_CONTEXT_TOOL_NAMES,
  SFOA_CONTEXT_TOOL_ROLES,
  SfoaContextMcpProvider,
} from '../provider.js';
import {
  diagnosticQueryInputSchema,
  metadataContextInputSchema,
  orgLimitsInputSchema,
  orgLimitsOutputSchema,
  recordActionContextInputSchema,
  recordDisplayContextInputSchema,
  type OrgLimitsOutput,
} from '../schemas.js';
import { ContextRuntimeError, CONTEXT_ERROR_CODES } from '../errors.js';
import { contextExecutionErrorToolResult } from '../tool-results.js';
import { GetOrgLimitsMcpTool } from '../tools/get-org-limits.js';
import type { OrgLimitsReader } from '../contracts.js';

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

test('Context Provider exposes ten GA Tools with stable output schemas and complete annotations', async () => {
  const tools = await new SfoaContextMcpProvider({
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
    orgLimitsExecutor: { execute: async () => limitsOutput() },
    traceFlagExecutor: {
      execute: async (input) => ({
        success: true, executionRole: 'DIAGNOSTIC', api: 'TOOLING', traceFlagId: '7tf000000000001AAA',
        tracedEntityKind: input.tracedEntityKind, tracedEntityId: input.tracedEntityId,
        logType: input.tracedEntityKind === 'USER' ? 'DEVELOPER_LOG' : 'CLASS_TRACING',
        debugLevelId: '7dl000000000001AAA', debugLevelDeveloperName: 'SFOA_P10_DEBUG', debugLevelTier: 'DEBUG',
        debugLevelCreated: false, startDate: '2026-09-30T00:00:00.000Z', expirationDate: '2026-09-30T00:30:00.000Z',
        previousExpirationDate: null, replacedExisting: false, requestedDurationMinutes: 30, verified: true,
      }),
    },
    apexLogsExecutor: {
      execute: async () => ({
        success: true, executionRole: 'DIAGNOSTIC', api: 'TOOLING', logs: [], totalCount: 0, returnedCount: 0,
        scannedCount: 0, truncated: false, timeWindowMinutes: 60, windowStartedAt: '2026-09-30T00:00:00.000Z',
        observedStatuses: [],
      }),
    },
    debugLogBodyExecutor: {
      execute: async (input) => ({
        success: true, executionRole: 'DIAGNOSTIC', api: 'TOOLING', logId: input.logId, body: 'x',
        totalBytes: 1, returnedBytes: 1, totalCharacters: 1, returnedCharacters: 1, maxCharacters: 60_000,
        truncated: false, logLength: 1, lastModifiedDate: null,
      }),
    },
  }).provideTools(createServices());
  assert.deepEqual(tools.map((tool) => tool.getName()), [...SFOA_CONTEXT_TOOL_NAMES]);
  for (const tool of tools) {
    const config = tool.getConfig();
    assert.ok(config.outputSchema);
    // `set_trace_flag` is the provider's only write, so it is the one Tool that may not claim to be
    // read-only or idempotent. Asserting the exact shape per Tool is what stops a later edit from
    // quietly making a write look like a read to the Agent reading the annotations.
    assert.deepEqual(config.annotations, tool.getName() === 'set_trace_flag'
      ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
      : { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    const inputNames = Object.keys(config.inputSchema ?? {});
    assert.deepEqual(inputNames.filter((name) => forbiddenFields.includes(name)), []);
  }
  assert.deepEqual(SFOA_CONTEXT_TOOL_ROLES, {
    get_record_action_context: 'USER',
    run_diagnostic_tooling_query: 'DIAGNOSTIC',
    get_metadata_component_context: 'DIAGNOSTIC',
    get_record_display_context: 'USER',
    resolve_field_display_values: 'USER',
    get_record_relationship_context: 'USER',
    // Reading the limits resource is an org-configuration read the business identities in this
    // deployment are not granted, so the Tool belongs to the isolated diagnostic role.
    get_org_limits: 'DIAGNOSTIC',
    set_trace_flag: 'DIAGNOSTIC',
    get_apex_logs: 'DIAGNOSTIC',
    get_debug_log_body: 'DIAGNOSTIC',
  });
});

test('get_org_limits refuses to be built without an executor rather than advertising a dead Tool', async () => {
  const provider = new SfoaContextMcpProvider({
    diagnosticQueryExecutor: { execute: async () => ({ records: [], totalSize: 0, returnedRecords: 0, done: true, truncated: false }) },
    metadataContextExecutor: {
      execute: async (input) => ({
        success: true, executionRole: 'DIAGNOSTIC', metadataType: input.metadataType, fullName: input.fullName,
        files: [], omittedFiles: [], totalFiles: 0, returnedFiles: 0, totalBytes: 0, returnedBytes: 0,
        truncated: false,
        limits: { maxReturnedFiles: 40, maxFileBytes: 65_536, maxTotalBytes: 262_144, maxFileSummaries: 100 },
      }),
    },
  });
  await assert.rejects(
    async () => provider.provideTools(createServices()),
    /get_org_limits requires an org limits executor/u,
  );
});

test('the get_org_limits Tool is GA, carries only a presentation switch, and reports the DIAGNOSTIC role', async () => {
  const reader: OrgLimitsReader = { execute: async () => limitsOutput() };
  const tool = new GetOrgLimitsMcpTool(reader);
  assert.equal(tool.getName(), 'get_org_limits');
  assert.equal(tool.getReleaseState(), ReleaseState.GA);
  assert.deepEqual(tool.getToolsets(), [Toolset.DATA]);

  const config = tool.getConfig();
  assert.deepEqual(Object.keys(config.inputSchema ?? {}), ['verbose']);
  assert.deepEqual(config.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  // The role is part of the contract the Agent reads, not a runtime detail it has to infer.
  assert.match(config.description ?? '', /server-owned DIAGNOSTIC identity/u);

  const result = await tool.exec({ verbose: true });
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as Record<string, unknown>).executionRole, 'DIAGNOSTIC');
  assert.equal((result.structuredContent as Record<string, unknown>).api, 'REST');
  assert.match(String((result.content[0] as { text: string }).text), /Highlights:/u);
});

test('org limits input rejects any attempt to select an identity, and the output pins the DIAGNOSTIC role literal', () => {
  assert.equal(orgLimitsInputSchema.safeParse({}).success, true);
  assert.equal(orgLimitsInputSchema.safeParse({ verbose: true }).success, true);
  for (const forged of [
    { username: 'forged@example.test' },
    { usernameOrAlias: 'forged@example.test' },
    { connectionRole: 'DIAGNOSTIC' },
    { platformUserId: 'p2-user-a' },
    { verbose: 'yes' },
  ]) {
    assert.equal(orgLimitsInputSchema.safeParse(forged).success, false, `${JSON.stringify(forged)} must be refused`);
  }

  assert.equal(orgLimitsOutputSchema.safeParse(limitsOutput()).success, true);
  // A USER-role success is not a shape this Tool can produce, so it must not parse — otherwise a
  // regression that silently reverted the role would still pass every schema check.
  assert.equal(
    orgLimitsOutputSchema.safeParse({ ...limitsOutput(), executionRole: 'USER' }).success,
    false,
  );
  assert.equal(orgLimitsOutputSchema.safeParse({ success: false, errorCode: 'MCP_LIMITS_READ_FAILED' }).success, true);
});

test('the limits error surface is additive: only the two new codes, and only when the raiser set them', () => {
  assert.ok(CONTEXT_ERROR_CODES.includes('MCP_LIMITS_READ_FAILED'));
  assert.ok(CONTEXT_ERROR_CODES.includes('MCP_LIMITS_ACCESS_DENIED'));

  const withExtras = contextExecutionErrorToolResult(
    new ContextRuntimeError('MCP_LIMITS_ACCESS_DENIED', 'refused', {
      salesforceErrorCode: 'API_DISABLED_FOR_ORG',
      suggestion: 'Read the allowances from Salesforce Setup instead of retrying.',
    }),
    'MCP_LIMITS_READ_FAILED',
  );
  assert.deepEqual(Object.keys(withExtras.structuredContent as object).sort(),
    ['errorCode', 'message', 'salesforceErrorCode', 'success', 'suggestion'].sort());
  assert.equal((withExtras.structuredContent as Record<string, unknown>).salesforceErrorCode, 'API_DISABLED_FOR_ORG');

  // Every other context Tool keeps its exact three-key error shape; the new keys are only emitted
  // when a raiser actually set them, which is also what their `.strict()` output schemas require.
  const plain = contextExecutionErrorToolResult(
    new ContextRuntimeError('MCP_RECORD_DISPLAY_CONTEXT_INVALID', 'bad input'),
    'MCP_RECORD_DISPLAY_CONTEXT_INVALID',
  );
  assert.deepEqual(Object.keys(plain.structuredContent as object), ['success', 'errorCode', 'message']);
});

function limitsOutput(): OrgLimitsOutput {
  return {
    success: true,
    executionRole: 'DIAGNOSTIC',
    api: 'REST',
    verbose: false,
    limits: { DailyApiRequests: { max: 100_000, remaining: 99_000, used: 1_000, measured: true } },
    highlights: {
      dailyApiRequests: { key: 'DailyApiRequests', present: true, max: 100_000, remaining: 99_000, used: 1_000 },
      dailyBulkApiRequests: { key: null, present: false, max: null, remaining: null, used: null },
      dailyAsyncApexExecutions: { key: null, present: false, max: null, remaining: null, used: null },
      dataStorageMB: { key: null, present: false, max: null, remaining: null, used: null },
      fileStorageMB: { key: null, present: false, max: null, remaining: null, used: null },
    },
    totalLimits: 1,
    returnedLimits: 1,
    unreadableLimits: 0,
    truncated: false,
  };
}

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

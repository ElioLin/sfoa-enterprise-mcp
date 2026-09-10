import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import type { OrgService } from '@salesforce/mcp-provider-api';
import type { ManagedDmlFieldRuleRecord } from '@sfoa/control-plane';
import {
  createRequestContext,
  createSalesforceIdentityRoute,
  type RuntimeLogEvent,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
import {
  StaticDmlAllowlistPolicy,
  DmlExecutor,
  BatchRecordsMcpTool,
  BATCH_DUPLICATE_RECORD_ID_CODE,
} from '@sfoa/mcp-provider-sfoa-dml';
import { ManagedDmlFieldResolver, type RuntimeManagedDmlFieldRule } from '../dml-managed-fields.js';
import { DmlToolFacade } from '../dml-tool-facade.js';

const RECORD_A = '003000000000001AAA';
const RECORD_B = '003000000000002AAA';
const VALIDATION_ERROR = [{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Denied', fields: ['Name'] }];

type Counters = {
  /** P7-09 lazy Connection acquired by the MCP Server facade. */
  providerConnections: number;
  /** Request-scoped Connection the DmlExecutor resolves for the Salesforce dispatch itself. */
  executorConnections: number;
  lookups: number;
  dispatches: number;
  mutationsStarted: number;
};

const NO_WORK: Counters = { providerConnections: 0, executorConnections: 0, lookups: 0, dispatches: 0, mutationsStarted: 0 };

/**
 * HF02-02: a duplicate `update_records` batch must be rejected by the host preflight, before the
 * Salesforce Connection is acquired, before any managed-field lookup and before dispatch.
 */
test('duplicate update_records IDs are rejected before any Salesforce Connection, managed lookup or dispatch', async () => {
  const harness = harnessFor('UPDATE');

  const result = await harness.facade.execute({
    objectApiName: 'Lead',
    allOrNone: false,
    // The same record expressed as 18- and 15-character IDs: comparing raw strings would let
    // both rows reach Salesforce, where collection commit order alone decides the final value.
    records: [
      { recordId: RECORD_A, fields: { LastName: 'First' } },
      { recordId: RECORD_A.slice(0, 15), fields: { LastName: 'Second' } },
    ],
  }, extra());

  assert.equal(result.isError, true);
  assert.equal(errorCode(result), BATCH_DUPLICATE_RECORD_ID_CODE);
  assert.deepEqual(harness.counters, NO_WORK);
});

test('duplicate preflight keeps the unified batch error contract and TOOL terminal audit evidence', async () => {
  const harness = harnessFor('UPDATE');

  const result = await harness.facade.execute({
    objectApiName: 'Lead',
    allOrNone: false,
    records: [
      { recordId: RECORD_A, fields: { LastName: 'First' } },
      { recordId: RECORD_A, fields: { LastName: 'Second' } },
    ],
  }, extra());

  // Unified Batch error surface: FAILED, not OUTCOME_UNKNOWN — nothing was ever dispatched.
  const output = result.structuredContent as Record<string, unknown>;
  assert.equal(result.isError, true);
  assert.equal(output.status, 'FAILED');
  assert.equal(output.succeeded, 0);
  assert.equal(output.failed, 2);
  assert.equal(output.unknown, 0);
  assert.equal(output.errorCode, BATCH_DUPLICATE_RECORD_ID_CODE);

  const event = harness.logger.events.at(-1);
  assert.equal(event?.result, 'ERROR');
  assert.equal(event?.outcome, 'FAILED');
  assert.equal(event?.errorCode, BATCH_DUPLICATE_RECORD_ID_CODE);
  assert.equal(event?.mutationStarted ?? false, false, 'no mutation was in flight when this was rejected');
  assert.equal(event?.auditEvent?.terminalSource, 'TOOL', 'a host preflight rejection is not a TRANSPORT failure');
  const summary = isRecord(event?.responseSummary) ? event.responseSummary : {};
  assert.equal(summary.batch, true);
  assert.equal(summary.status, 'FAILED');
  assert.equal(summary.businessOutcome, 'FAILED');
  assert.equal(summary.partial, false);
  assert.equal(summary.failedCount, 2);
  assert.equal(summary.unknownCount, 0);
});

test('a batch without duplicate IDs still acquires the Connection and dispatches exactly once', async () => {
  const harness = harnessFor('UPDATE');
  harness.setResponse([{ id: RECORD_A, success: true, errors: [] }, { id: RECORD_B, success: true, errors: [] }]);

  const result = await harness.facade.execute(batchInput('UPDATE'), extra());

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.status, 'SUCCESS');
  assert.equal(harness.counters.providerConnections, 1);
  assert.equal(harness.counters.executorConnections, 1);
  assert.equal(harness.counters.dispatches, 1);
  assert.equal(harness.counters.mutationsStarted, 1);
});

/**
 * The duplicate identity rule is specific to `update_records`, where two rows would name one
 * Salesforce record. CREATE rows carry no Record ID, so two rows with identical values stay a
 * legitimate batch and must not be caught by the UPDATE preflight.
 */
test('CREATE batches are unaffected by the UPDATE-only duplicate preflight', async () => {
  const harness = harnessFor('CREATE');
  harness.setResponse([{ id: RECORD_A, success: true, errors: [] }, { id: RECORD_B, success: true, errors: [] }]);

  const result = await harness.facade.execute(batchInput('CREATE'), extra());

  assert.equal(result.isError, false);
  assert.equal(result.structuredContent?.status, 'SUCCESS');
  assert.equal(harness.counters.dispatches, 1);
});

/**
 * HF02-08 defense-in-depth: the host preflight is an optimization, not the only guard. A caller
 * that reaches DmlExecutor directly (tests, future callers) must still be rejected.
 */
test('DmlExecutor.batch() keeps its own duplicate-ID check for callers bypassing the host preflight', async () => {
  let dispatches = 0;
  let connections = 0;
  const connection = {
    getApiVersion: () => '67.0',
    sobject: () => ({ update: async () => { dispatches += 1; return []; } }),
  } as unknown as Connection;
  const policy = new StaticDmlAllowlistPolicy([{ objectApiName: 'Lead', operations: ['UPDATE'] }]);
  const executor = new DmlExecutor(
    { getAllowedOrgUsernames: async () => new Set(['current-user']),
      getConnection: async () => { connections += 1; return connection; } } as unknown as OrgService,
    policy,
  );

  await assert.rejects(
    executor.updateRecords({ objectApiName: 'Lead', allOrNone: false, records: [
      { recordId: RECORD_A, fields: { LastName: 'First' } },
      { recordId: RECORD_A.slice(0, 15), fields: { LastName: 'Second' } },
    ] }),
    (error: unknown) => isRecord(error) && error.code === BATCH_DUPLICATE_RECORD_ID_CODE,
  );
  assert.equal(dispatches, 0);
  assert.equal(connections, 0, 'the executor rejects before resolving the request Connection');
});

/**
 * HF02-05 regression guard: the HOTFIX01 MCP Tool error semantics are unchanged by this hotfix.
 * PARTIAL_SUCCESS committed some records, so it is a successful Tool execution; only FAILED and
 * OUTCOME_UNKNOWN are Tool errors.
 */
test('PARTIAL_SUCCESS stays isError=false while FAILED and OUTCOME_UNKNOWN stay isError=true', async () => {
  const partial = harnessFor('UPDATE');
  partial.setResponse([{ id: RECORD_A, success: true, errors: [] },
    { success: false, errors: VALIDATION_ERROR }]);
  const partialResult = await partial.facade.execute(batchInput('UPDATE'), extra());
  assert.equal(partialResult.structuredContent?.status, 'PARTIAL_SUCCESS');
  assert.equal(partialResult.isError, false, 'a partial commit must not route the client into a retry path');

  const failed = harnessFor('UPDATE');
  failed.setResponse([{ success: false, errors: VALIDATION_ERROR }, { success: false, errors: VALIDATION_ERROR }]);
  const failedResult = await failed.facade.execute(batchInput('UPDATE'), extra());
  assert.equal(failedResult.structuredContent?.status, 'FAILED');
  assert.equal(failedResult.isError, true);

  const unknown = harnessFor('UPDATE');
  // A transport failure with no structured Salesforce rejection body: the commit state is not
  // provable, so this must stay OUTCOME_UNKNOWN rather than become a confident failure.
  unknown.setResponse(new Error('connection lost without a Salesforce error body'));
  const unknownResult = await unknown.facade.execute(batchInput('UPDATE'), extra());
  assert.equal(unknownResult.structuredContent?.status, 'OUTCOME_UNKNOWN');
  assert.equal(unknownResult.isError, true, 'an unprovable commit must never look successful');
  assert.equal(errorCode(unknownResult), 'MCP_DML_OUTCOME_UNKNOWN');
});

function batchInput(operation: 'CREATE' | 'UPDATE') {
  return operation === 'CREATE'
    ? { objectApiName: 'Lead', allOrNone: false, records: [
        { fields: { LastName: 'First' } }, { fields: { LastName: 'First' } }] }
    : { objectApiName: 'Lead', allOrNone: false, records: [
        { recordId: RECORD_A, fields: { LastName: 'First' } },
        { recordId: RECORD_B, fields: { LastName: 'Second' } }] };
}

type Harness = Readonly<{
  facade: DmlToolFacade;
  counters: Counters;
  logger: RecordingLogger;
  setResponse(value: unknown): void;
}>;

function harnessFor(operation: 'CREATE' | 'UPDATE'): Harness {
  const counters: Counters = { providerConnections: 0, executorConnections: 0, lookups: 0, dispatches: 0, mutationsStarted: 0 };
  let response: unknown = [];
  const dispatch = async (): Promise<unknown> => { counters.dispatches += 1; return response; };
  const connection = {
    getApiVersion: () => '67.0',
    query: async () => ({ records: [{ Id: RECORD_A }] }),
    sobject: () => ({ create: dispatch, update: dispatch }),
  } as unknown as Connection;
  const policy = new StaticDmlAllowlistPolicy([{ objectApiName: 'Lead', operations: ['CREATE', 'UPDATE'] }]);
  const executor = new DmlExecutor(
    { getAllowedOrgUsernames: async () => new Set(['current-user']),
      getConnection: async () => { counters.executorConnections += 1; return connection; } } as unknown as OrgService,
    policy,
    { onMutationStarted: () => { counters.mutationsStarted += 1; } },
  );
  const context = createRequestContext({ platformUserId: 'hotfix-user', correlationId: 'hf02' }, process.cwd());
  const logger = new RecordingLogger();
  const facade = new DmlToolFacade({
    tool: new BatchRecordsMcpTool(executor, operation),
    context,
    route: userRoute('hotfix-user'),
    toolTimeoutMs: 1_000,
    clientId: 'hf02',
    logger,
    mutationStarted: () => counters.mutationsStarted > 0,
    dmlAllowlist: policy,
    connectionProvider: { getConnection: async () => { counters.providerConnections += 1; return connection; } },
    // A rule that would really query, so "lookups: 0" proves the resolver never ran at all.
    managedFieldResolver: new ManagedDmlFieldResolver(
      { getConnection: async () => { counters.lookups += 1; return connection; } },
      context,
      [runtimeRule()],
    ),
  });
  return { facade, counters, logger, setResponse: (value: unknown) => { response = value; } };
}

function runtimeRule(overrides: Partial<RuntimeManagedDmlFieldRule> = {}): RuntimeManagedDmlFieldRule {
  const base: ManagedDmlFieldRuleRecord = Object.freeze({
    id: '1', dmlPolicyId: '10', targetFieldApiName: 'LastName', strategy: 'PLATFORM_USER_LOOKUP',
    applyOnCreate: true, applyOnUpdate: true, lookupObjectApiName: 'Contact',
    lookupMatchFieldApiName: 'Platform_User_Id__c', enabled: true, remark: null, rowVersion: '1',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  });
  return Object.freeze({ ...base, objectApiName: 'Lead', ...overrides });
}

function userRoute(platformUserId: string) {
  return createSalesforceIdentityRoute({
    platformUserId, salesforceUsername: 'shared@example.invalid', credentialProfile: 'test',
    connectionRole: 'USER', aliases: [],
  });
}

function errorCode(result: CallToolResult): string | undefined {
  return result.structuredContent && typeof result.structuredContent.errorCode === 'string'
    ? result.structuredContent.errorCode
    : undefined;
}

function extra(): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return Object.freeze({}) as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class RecordingLogger implements RuntimeLogger {
  public readonly events: RuntimeLogEvent[] = [];
  public log(event: RuntimeLogEvent): void { this.events.push(event); }
}

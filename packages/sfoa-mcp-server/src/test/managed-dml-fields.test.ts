import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import { McpTool, ReleaseState, Toolset, type McpToolConfig } from '@salesforce/mcp-provider-api';
import type { ManagedDmlFieldRuleRecord } from '@sfoa/control-plane';
import {
  currentSalesforceCallSemanticScope,
  RequestAuditContextController,
  runWithRequestAuditContext,
  type SalesforceApiSemanticEvidence,
  createRequestContext,
  createSalesforceIdentityRoute,
  type RuntimeLogEvent,
  type RuntimeLogger,
  type SalesforceConnectionProvider,
} from '@sfoa/identity-runtime';
import { StaticDmlAllowlistPolicy } from '@sfoa/mcp-provider-sfoa-dml';
import { z } from 'zod';
import { ManagedDmlFieldResolver, type RuntimeManagedDmlFieldRule } from '../dml-managed-fields.js';
import { DmlToolFacade } from '../dml-tool-facade.js';

const CONTACT_A = '003000000000001AAA';
const CONTACT_B = '003000000000002AAA';

test('managed resolver overrides agent values and never exposes trusted values in the safe audit summary', async () => {
  const logger = new RecordingLogger();
  const tool = new CapturingCreateTool();
  const context = createRequestContext({ platformUserId: 'platform-user-a', correlationId: 'managed-audit' }, process.cwd());
  const resolver = new ManagedDmlFieldResolver(
    queryConnection(async (soql) => {
      assert.equal(soql, "SELECT Id FROM Contact WHERE Platform_User_Id__c = 'platform-user-a' LIMIT 2");
      return { records: [{ Id: CONTACT_A }] };
    }),
    context,
    [runtimeRule({ targetFieldApiName: 'Requested_By__c', strategy: 'PLATFORM_USER_LOOKUP' })],
  );
  const facade = new DmlToolFacade({
    tool,
    context,
    route: userRoute('platform-user-a'),
    toolTimeoutMs: 1_000,
    logger,
    clientId: 'managed-test',
    managedFieldResolver: resolver,
    mutationStarted: () => false,
  });

  const result = await facade.execute({
    objectApiName: 'Lead',
    fields: { LastName: 'Test', requested_by__c: 'agent-supplied-value' },
  }, extra());

  assert.equal(result.isError, undefined);
  assert.equal(fieldValue(tool.input, 'Requested_By__c'), CONTACT_A);
  assert.equal(fieldValue(tool.input, 'requested_by__c'), undefined);
  const event = logger.events[0];
  assert(event);
  const audit = JSON.stringify(event.requestSummary);
  assert.match(audit, /"fieldApiName":"Requested_By__c"/u);
  assert.match(audit, /"strategy":"PLATFORM_USER_LOOKUP"/u);
  assert.match(audit, /"agentValueOverridden":true/u);
  assert.doesNotMatch(audit, /platform-user-a|003000000000001AAA|agent-supplied-value/u);
});

test('AI-created marker is CREATE-only, writes true, and leaves unrelated or non-matching requests unchanged', async () => {
  const context = createRequestContext({ platformUserId: 'marker-user', correlationId: 'managed-marker' }, process.cwd());
  const resolver = new ManagedDmlFieldResolver(
    queryConnection(async () => { throw new Error('query must not run'); }),
    context,
    [runtimeRule({
      targetFieldApiName: 'Created_By_AI__c',
      strategy: 'AI_CREATED_MARKER',
      applyOnCreate: true,
      applyOnUpdate: false,
      lookupObjectApiName: null,
      lookupMatchFieldApiName: null,
    })],
  );
  const create = await resolver.resolve('CREATE', { objectApiName: 'Lead', fields: { LastName: 'Marker', Created_By_AI__c: false } });
  assert.equal(fieldValue(create.input, 'Created_By_AI__c'), true);
  assert.deepEqual(create.applied, [{ fieldApiName: 'Created_By_AI__c', strategy: 'AI_CREATED_MARKER', agentValueOverridden: true }]);
  const update = await resolver.resolve('UPDATE', { objectApiName: 'Lead', fields: { Company: 'Unchanged' } });
  assert.deepEqual(update.input, { objectApiName: 'Lead', fields: { Company: 'Unchanged' } });
  assert.deepEqual(update.applied, []);
});

test('managed platform lookup returns stable not-found, ambiguous, failed, and invalid-config errors', async () => {
  await assertRejectsCode(queryResolver(async () => ({ records: [] })), 'MCP_DML_MANAGED_LOOKUP_NOT_FOUND');
  await assertRejectsCode(queryResolver(async () => ({ records: [{ Id: CONTACT_A }, { Id: CONTACT_B }] })), 'MCP_DML_MANAGED_LOOKUP_AMBIGUOUS');
  await assertRejectsCode(queryResolver(async () => { throw new Error('transport included a secret that must not escape'); }), 'MCP_DML_MANAGED_LOOKUP_FAILED');
  const invalid = new ManagedDmlFieldResolver(
    queryConnection(async () => ({ records: [{ Id: CONTACT_A }] })),
    createRequestContext({ platformUserId: 'platform-user-a', correlationId: 'invalid-config' }, process.cwd()),
    [runtimeRule({ lookupObjectApiName: 'Contact WHERE Name != null' })],
  );
  await assertRejectsCode(invalid, 'MCP_DML_MANAGED_FIELD_CONFIG_INVALID');
  const missingOperations = new ManagedDmlFieldResolver(
    queryConnection(async () => ({ records: [{ Id: CONTACT_A }] })),
    createRequestContext({ platformUserId: 'platform-user-a', correlationId: 'invalid-operations' }, process.cwd()),
    [runtimeRule({ applyOnCreate: false, applyOnUpdate: false })],
  );
  await assertRejectsCode(missingOperations, 'MCP_DML_MANAGED_FIELD_CONFIG_INVALID');
});

test('pre-dispatch managed lookup timeout is FAILED MCP_TOOL_TIMEOUT and never outcome unknown', async () => {
  const logger = new RecordingLogger();
  const tool = new CapturingCreateTool();
  const context = createRequestContext({ platformUserId: 'platform-user-a', correlationId: 'managed-timeout' }, process.cwd());
  const resolver = new ManagedDmlFieldResolver(
    queryConnection(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 35));
      return { records: [{ Id: CONTACT_A }] };
    }),
    context,
    [runtimeRule({})],
  );
  const facade = new DmlToolFacade({
    tool,
    context,
    route: userRoute('platform-user-a'),
    toolTimeoutMs: 10,
    logger,
    clientId: 'managed-test',
    managedFieldResolver: resolver,
    mutationStarted: () => false,
  });
  const result = await facade.execute({ objectApiName: 'Lead', fields: { LastName: 'Timeout' } }, extra());
  assert.equal(errorCode(result), 'MCP_TOOL_TIMEOUT');
  assert.equal(tool.executions, 0);
  assert.equal(logger.events[0]?.outcome, 'FAILED');
  assert.equal(logger.events[0]?.mutationStarted, undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 45));
  assert.equal(tool.executions, 0, 'a lookup that settles after timeout must not dispatch a late mutation');
});

test('DML allowlist validation runs before managed lookup resolution', async () => {
  let lookupQueries = 0;
  const tool = new CapturingCreateTool();
  const context = createRequestContext({ platformUserId: 'platform-user-a', correlationId: 'policy-before-managed' }, process.cwd());
  const facade = new DmlToolFacade({
    tool,
    context,
    route: userRoute('platform-user-a'),
    toolTimeoutMs: 1_000,
    logger: new RecordingLogger(),
    clientId: 'managed-policy-order',
    dmlAllowlist: new StaticDmlAllowlistPolicy([{ objectApiName: 'Account', operations: ['CREATE'] }]),
    managedFieldResolver: new ManagedDmlFieldResolver(
      queryConnection(async () => {
        lookupQueries += 1;
        return { records: [{ Id: CONTACT_A }] };
      }),
      context,
      [runtimeRule({})],
    ),
    mutationStarted: () => false,
  });
  const result = await facade.execute({ objectApiName: 'Lead', fields: { LastName: 'Denied' } }, extra());
  assert.equal(errorCode(result), 'MCP_DML_OBJECT_NOT_ALLOWED');
  assert.equal(lookupQueries, 0);
  assert.equal(tool.executions, 0);
});

test('50 delayed out-of-order requests keep platform A/B managed values isolated for one Salesforce username', async () => {
  const tasks: Promise<void>[] = [];
  for (let iteration = 0; iteration < 50; iteration += 1) {
    tasks.push(assertIsolatedResolution('platform-user-a', CONTACT_A, iteration % 2 === 0 ? 4 : 0));
    tasks.push(assertIsolatedResolution('platform-user-b', CONTACT_B, iteration % 2 === 0 ? 0 : 4));
  }
  await Promise.all(tasks);
});

test('PLATFORM_USER_LOOKUP injects the target field on UPDATE only when applyOnUpdate is enabled', async () => {
  const context = createRequestContext({ platformUserId: 'platform-user-a', correlationId: 'lookup-update' }, process.cwd());
  const onUpdate = new ManagedDmlFieldResolver(
    queryConnection(async () => ({ records: [{ Id: CONTACT_A }] })),
    context,
    [runtimeRule({ applyOnCreate: false, applyOnUpdate: true })],
  );
  const updated = await onUpdate.resolve('UPDATE', { objectApiName: 'Lead', fields: { Company: 'Changed' } });
  assert.equal(fieldValue(updated.input, 'Requested_By__c'), CONTACT_A);
  assert.deepEqual(updated.applied, [{ fieldApiName: 'Requested_By__c', strategy: 'PLATFORM_USER_LOOKUP', agentValueOverridden: false }]);

  const createOnly = new ManagedDmlFieldResolver(
    queryConnection(async () => { throw new Error('query must not run on an UPDATE-scoped rule'); }),
    context,
    [runtimeRule({ applyOnCreate: true, applyOnUpdate: false })],
  );
  const untouched = await createOnly.resolve('UPDATE', { objectApiName: 'Lead', fields: { Company: 'Changed' } });
  assert.deepEqual(untouched.input, { objectApiName: 'Lead', fields: { Company: 'Changed' } });
  assert.deepEqual(untouched.applied, []);
});

test('DML facade dispatches each final mutation payload to its own request without cross-user leakage', async () => {
  const rounds = 40;
  const tasks: Promise<void>[] = [];
  for (let iteration = 0; iteration < rounds; iteration += 1) {
    tasks.push(assertIsolatedFacadeDispatch('platform-user-a', CONTACT_A, iteration % 2 === 0 ? 3 : 0));
    tasks.push(assertIsolatedFacadeDispatch('platform-user-b', CONTACT_B, iteration % 2 === 0 ? 0 : 3));
  }
  await Promise.all(tasks);
});

async function assertIsolatedResolution(platformUserId: string, expectedId: string, delayMs: number): Promise<void> {
  const resolver = new ManagedDmlFieldResolver(
    queryConnection(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return { records: [{ Id: expectedId }] };
    }),
    createRequestContext({ platformUserId, correlationId: `concurrent-${platformUserId}-${delayMs}` }, process.cwd()),
    [runtimeRule({})],
  );
  const result = await resolver.resolve('CREATE', { objectApiName: 'Lead', fields: { LastName: platformUserId } });
  assert.equal(fieldValue(result.input, 'Requested_By__c'), expectedId);
}

async function assertIsolatedFacadeDispatch(platformUserId: string, expectedId: string, delayMs: number): Promise<void> {
  const tool = new CapturingCreateTool();
  const context = createRequestContext({ platformUserId, correlationId: `facade-${platformUserId}-${delayMs}` }, process.cwd());
  const resolver = new ManagedDmlFieldResolver(
    queryConnection(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return { records: [{ Id: expectedId }] };
    }),
    context,
    [runtimeRule({})],
  );
  const facade = new DmlToolFacade({
    tool,
    context,
    route: userRoute(platformUserId),
    toolTimeoutMs: 1_000,
    logger: new RecordingLogger(),
    clientId: 'facade-concurrency',
    managedFieldResolver: resolver,
    mutationStarted: () => false,
  });
  await facade.execute({ objectApiName: 'Lead', fields: { LastName: platformUserId } }, extra());
  assert.equal(fieldValue(tool.input, 'Requested_By__c'), expectedId);
}

function queryResolver(query: (soql: string) => Promise<unknown>): ManagedDmlFieldResolver {
  return new ManagedDmlFieldResolver(
    queryConnection(query),
    createRequestContext({ platformUserId: 'platform-user-a', correlationId: 'managed-error' }, process.cwd()),
    [runtimeRule({})],
  );
}

async function assertRejectsCode(resolver: ManagedDmlFieldResolver, code: string): Promise<void> {
  await assert.rejects(
    resolver.resolve('CREATE', { objectApiName: 'Lead', fields: { LastName: 'Error' } }),
    (error: unknown) => isRecord(error) && error.code === code,
  );
}

function runtimeRule(overrides: Partial<RuntimeManagedDmlFieldRule>): RuntimeManagedDmlFieldRule {
  const base: ManagedDmlFieldRuleRecord = Object.freeze({
    id: '1',
    dmlPolicyId: '10',
    targetFieldApiName: 'Requested_By__c',
    strategy: 'PLATFORM_USER_LOOKUP',
    applyOnCreate: true,
    applyOnUpdate: overrides.strategy !== 'PLATFORM_USER_LOOKUP_FALLBACK',
    lookupObjectApiName: 'Contact',
    lookupMatchFieldApiName: 'Platform_User_Id__c',
    enabled: true,
    remark: null,
    rowVersion: '1',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  });
  return Object.freeze({ ...base, objectApiName: 'Lead', ...overrides });
}

function queryConnection(query: (soql: string) => Promise<unknown>): SalesforceConnectionProvider {
  const connection = Object.freeze({ query }) as unknown as Connection;
  return Object.freeze({ getConnection: async () => connection });
}

function userRoute(platformUserId: string) {
  return createSalesforceIdentityRoute({
    platformUserId,
    salesforceUsername: 'shared@example.invalid',
    credentialProfile: 'test',
    connectionRole: 'USER',
    aliases: [],
  });
}

function fieldValue(input: Readonly<Record<string, unknown>> | undefined, name: string): unknown {
  const fields = input && isRecord(input.fields) ? input.fields : undefined;
  return fields?.[name];
}

function errorCode(result: CallToolResult): string | undefined {
  return result.structuredContent && typeof result.structuredContent.errorCode === 'string'
    ? result.structuredContent.errorCode
    : undefined;
}

function extra(): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return Object.freeze({}) as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

const emptySchema = z.object({});
class CapturingCreateTool extends McpTool<typeof emptySchema.shape> {
  public constructor(private readonly toolName = 'create_record') { super(); }
  public executions = 0;
  public semantic: SalesforceApiSemanticEvidence | undefined;
  public input: Readonly<Record<string, unknown>> | undefined;
  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.DATA]; }
  public getName(): string { return this.toolName; }
  public getConfig(): McpToolConfig<typeof emptySchema.shape> { return { inputSchema: emptySchema.shape }; }
  public async exec(input: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
    this.semantic = currentSalesforceCallSemanticScope()?.bind('11111111-1111-4111-8111-111111111111');
    this.executions += 1;
    this.input = input;
    return { content: [{ type: 'text', text: 'created' }], structuredContent: { success: true, recordId: '00Q000000000001AAA' } };
  }
}

class RecordingLogger implements RuntimeLogger {
  public readonly events: RuntimeLogEvent[] = [];
  public log(event: RuntimeLogEvent): void { this.events.push(event); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

for (const operation of ['CREATE', 'UPDATE'] as const) {
  for (const strategy of ['PLATFORM_USER_LOOKUP', 'PLATFORM_USER_LOOKUP_FALLBACK'] as const) {
    if (operation === 'UPDATE' && strategy === 'PLATFORM_USER_LOOKUP_FALLBACK') continue;
    test(strategy + ' ' + operation + ' omitted field reuses bounded platform lookup', async () => {
      let queries = 0;
      const resolver = new ManagedDmlFieldResolver(queryConnection(async (soql) => {
        queries += 1;
        assert.equal(soql, "SELECT Id FROM Contact WHERE Platform_User_Id__c = 'platform-user-a' LIMIT 2");
        return { records: [{ Id: CONTACT_A }] };
      }), createRequestContext({ platformUserId: 'platform-user-a', correlationId: 'fallback-test' }, process.cwd()), [runtimeRule({ strategy })]);
      const result = await resolver.resolve(operation, { objectApiName: 'Lead', fields: { LastName: 'Test' } });
      assert.equal(queries, 1);
      assert.equal(fieldValue(result.input, 'Requested_By__c'), CONTACT_A);
      assert.deepEqual(result.applied, [{ fieldApiName: 'Requested_By__c', strategy, agentValueOverridden: false }]);
    });
  }
  if (operation === 'UPDATE') continue; // Fallback is CREATE-only; UPDATE passthrough is tested below.
  for (const fieldName of ['Requested_By__c', 'requested_by__c', 'REQUESTED_BY__C']) {
    for (const value of [CONTACT_B, null, '', undefined, 'invalid-client-id']) {
      test('fallback preserves explicit ' + fieldName + ' ' + String(value) + ' on ' + operation, async () => {
        let queries = 0;
        const resolver = new ManagedDmlFieldResolver(queryConnection(async () => {
          queries += 1;
          return { records: [] }; // Default mapping would be NOT_FOUND if called.
        }), createRequestContext({ platformUserId: 'unmapped-user', correlationId: 'fallback-test' }, process.cwd()),
        [runtimeRule({ strategy: 'PLATFORM_USER_LOOKUP_FALLBACK' })]);
        const input = { objectApiName: 'Lead', fields: { [fieldName]: value } };
        const result = await resolver.resolve(operation, input);
        assert.deepEqual(result.input.fields, { Requested_By__c: value });
        assert.deepEqual(input.fields, { [fieldName]: value });
        assert.deepEqual(result.applied, []);
        assert.equal(queries, 0);
      });
    }
  }
}

test('fallback omission retains existing failure codes and explicit values cannot hide invalid config', async () => {
  const context = createRequestContext({ platformUserId: 'platform-user-a', correlationId: 'fallback-test' }, process.cwd());
  for (const [records, code] of [
    [[], 'MCP_DML_MANAGED_LOOKUP_NOT_FOUND'],
    [[{ Id: CONTACT_A }, { Id: CONTACT_B }], 'MCP_DML_MANAGED_LOOKUP_AMBIGUOUS'],
    [[{ Id: 'bad-id' }], 'MCP_DML_MANAGED_LOOKUP_FAILED'],
  ] as const) {
    await assertRejectsCode(new ManagedDmlFieldResolver(queryConnection(async () => ({ records })), context,
      [runtimeRule({ strategy: 'PLATFORM_USER_LOOKUP_FALLBACK' })]), code);
  }
  await assertRejectsCode(new ManagedDmlFieldResolver(queryConnection(async () => { throw new Error('query failed'); }), context,
    [runtimeRule({ strategy: 'PLATFORM_USER_LOOKUP_FALLBACK' })]), 'MCP_DML_MANAGED_LOOKUP_FAILED');
  for (const invalid of [{ lookupObjectApiName: null }, { lookupMatchFieldApiName: 'Bad.Field' }, { applyOnCreate: false, applyOnUpdate: false }]) {
    const resolver = new ManagedDmlFieldResolver(queryConnection(async () => { throw new Error('must not query'); }), context,
      [runtimeRule({ strategy: 'PLATFORM_USER_LOOKUP_FALLBACK', ...invalid })]);
    await assert.rejects(resolver.resolve('CREATE', { objectApiName: 'Lead', fields: { Requested_By__c: CONTACT_B } }),
      (error: unknown) => isRecord(error) && error.code === 'MCP_DML_MANAGED_FIELD_CONFIG_INVALID');
  }
});

test('fallback obeys applyOnUpdate and does not add fields to an unrelated UPDATE', async () => {
  const resolver = new ManagedDmlFieldResolver(queryConnection(async () => { throw new Error('must not query'); }),
    createRequestContext({ platformUserId: 'platform-user-a', correlationId: 'fallback-test' }, process.cwd()),
    [runtimeRule({ strategy: 'PLATFORM_USER_LOOKUP_FALLBACK', applyOnUpdate: false })]);
  const input = { objectApiName: 'Lead', fields: { Company: 'Changed' } };
  const result = await resolver.resolve('UPDATE', input);
  assert.deepEqual(result.input, input);
  assert.deepEqual(result.applied, []);
});

test('AI marker also writes true when omitted', async () => {
  const resolver = new ManagedDmlFieldResolver(queryConnection(async () => { throw new Error('must not query'); }),
    createRequestContext({ platformUserId: 'marker-user', correlationId: 'fallback-test' }, process.cwd()),
    [runtimeRule({ targetFieldApiName: 'Created_By_AI__c', strategy: 'AI_CREATED_MARKER', applyOnUpdate: false,
      lookupObjectApiName: null, lookupMatchFieldApiName: null })]);
  const result = await resolver.resolve('CREATE', { objectApiName: 'Lead', fields: {} });
  assert.equal(fieldValue(result.input, 'Created_By_AI__c'), true);
  assert.equal(result.applied[0]?.agentValueOverridden, false);
});

for (const supplied of [true, false]) {
  test('order owner acceptance and audit: explicit supplied = ' + supplied, async () => {
    const context = createRequestContext({ platformUserId: 'platform-li-si', correlationId: 'fallback-test' }, process.cwd());
    const tool = new CapturingCreateTool();
    const logger = new RecordingLogger();
    let queries = 0;
    const resolver = new ManagedDmlFieldResolver(queryConnection(async () => {
      queries += 1;
      return { records: [{ Id: CONTACT_A }] }; // Li Si default; explicit CONTACT_B is Zhang San.
    }), context, [runtimeRule({ objectApiName: 'Order__c', targetFieldApiName: 'Order_Owner__c', strategy: 'PLATFORM_USER_LOOKUP_FALLBACK' })]);
    const facade = new DmlToolFacade({ tool, context, route: userRoute('platform-li-si'), toolTimeoutMs: 1000,
      logger, clientId: 'fallback-audit', managedFieldResolver: resolver, mutationStarted: () => false });
    const fields = supplied ? { order_owner__c: CONTACT_B } : {};
    const auditContext = RequestAuditContextController.create({ channel: 'MCP_HTTP', toolName: 'create_record' });
    const result = await runWithRequestAuditContext(auditContext, () => facade.execute({ objectApiName: 'Order__c', fields }, extra()));
    assert.equal(result.isError, undefined);
    assert.equal(tool.executions, 1);
    assert.equal(queries, supplied ? 0 : 1);
    assert.equal(fieldValue(tool.input, 'Order_Owner__c'), supplied ? CONTACT_B : CONTACT_A);
    assert.deepEqual(tool.semantic?.requestedFields, fields);
    assert.deepEqual(tool.semantic?.managedFields, supplied ? {} : { Order_Owner__c: CONTACT_A });
    const summary = logger.events[0]?.requestSummary;
    assert.ok(isRecord(summary));
    assert.deepEqual(summary.managedFieldsApplied, supplied ? [] : [{
      fieldApiName: 'Order_Owner__c', strategy: 'PLATFORM_USER_LOOKUP_FALLBACK', agentValueOverridden: false,
    }]);
    assert.doesNotMatch(JSON.stringify(summary), /platform-li-si|003000000000001AAA|003000000000002AAA/u);
  });
}

for (const fields of [{ Description: 'changed' }, { Order_Owner__c: CONTACT_B }, { Order_Owner__c: null }]) {
  test('CREATE-only fallback leaves normal UPDATE payload unchanged: ' + JSON.stringify(fields), async () => {
    const context = createRequestContext({ platformUserId: 'update-user', correlationId: 'hotfix' }, process.cwd());
    let queries = 0;
    const resolver = new ManagedDmlFieldResolver(queryConnection(async () => { queries += 1; return { records: [] }; }), context,
      [runtimeRule({ objectApiName: 'Order__c', targetFieldApiName: 'Order_Owner__c', strategy: 'PLATFORM_USER_LOOKUP_FALLBACK' })]);
    const tool = new CapturingCreateTool('update_record');
    const facade = new DmlToolFacade({ tool, context, route: userRoute('update-user'), toolTimeoutMs: 1000,
      logger: new RecordingLogger(), clientId: 'hotfix', managedFieldResolver: resolver, mutationStarted: () => false });
    const result = await facade.execute({ objectApiName: 'Order__c', recordId: CONTACT_A, fields }, extra());
    assert.equal(result.isError, undefined);
    assert.equal(tool.executions, 1);
    assert.deepEqual(tool.input?.fields, fields);
    assert.equal(queries, 0);
  });
}

for (const operation of ['CREATE', 'UPDATE'] as const) {
  test('invalid fallback UPDATE scope fails closed before ' + operation + ' dispatch', async () => {
    const context = createRequestContext({ platformUserId: 'invalid-user', correlationId: 'hotfix' }, process.cwd());
    let queries = 0;
    const resolver = new ManagedDmlFieldResolver(queryConnection(async () => { queries += 1; return { records: [] }; }), context,
      [runtimeRule({ strategy: 'PLATFORM_USER_LOOKUP_FALLBACK', applyOnUpdate: true })]);
    const tool = new CapturingCreateTool(operation === 'CREATE' ? 'create_record' : 'update_record');
    const facade = new DmlToolFacade({ tool, context, route: userRoute('invalid-user'), toolTimeoutMs: 1000,
      logger: new RecordingLogger(), clientId: 'hotfix', managedFieldResolver: resolver, mutationStarted: () => false });
    const result = await facade.execute({ objectApiName: 'Lead', recordId: CONTACT_A, fields: { Description: 'changed' } }, extra());
    assert.equal(errorCode(result), 'MCP_DML_MANAGED_FIELD_CONFIG_INVALID');
    assert.equal(tool.executions, 0);
    assert.equal(queries, 0);
  });
}

for (const strategy of ['PLATFORM_USER_LOOKUP', 'PLATFORM_USER_LOOKUP_FALLBACK', 'AI_CREATED_MARKER'] as const) {
  for (const reverse of [false, true]) {
    test(strategy + ' rejects duplicate case aliases before any lookup, order reversed = ' + reverse, async () => {
      const context = createRequestContext({ platformUserId: 'duplicate-user', correlationId: 'hotfix' }, process.cwd());
      let queries = 0;
      const resolver = new ManagedDmlFieldResolver(queryConnection(async () => { queries += 1; return { records: [{ Id: CONTACT_A }] }; }), context,
        [runtimeRule({ targetFieldApiName: 'First_Lookup__c' }), runtimeRule({ targetFieldApiName: 'Order_Owner__c', strategy,
          applyOnUpdate: false, ...(strategy === 'AI_CREATED_MARKER' ? { lookupObjectApiName: null, lookupMatchFieldApiName: null } : {}) })]);
      const fields = Object.fromEntries((reverse
        ? [['order_owner__c', 'private-second'], ['Order_Owner__c', 'private-first']]
        : [['Order_Owner__c', 'private-first'], ['order_owner__c', 'private-second']]));
      const tool = new CapturingCreateTool();
      const logger = new RecordingLogger();
      const facade = new DmlToolFacade({ tool, context, route: userRoute('duplicate-user'), toolTimeoutMs: 1000,
        logger, clientId: 'hotfix', managedFieldResolver: resolver, mutationStarted: () => false });
      const result = await facade.execute({ objectApiName: 'Lead', fields }, extra());
      assert.equal(errorCode(result), 'MCP_DML_INPUT_INVALID');
      assert.equal(tool.executions, 0);
      assert.equal(queries, 0, 'a previous valid managed target must not query either');
      assert.doesNotMatch(JSON.stringify([result, logger.events.map((event) => event.requestSummary)]), /private-first|private-second|duplicate-user/u);
    });
  }
}

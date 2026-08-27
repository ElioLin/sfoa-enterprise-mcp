import assert from 'node:assert/strict';
import test from 'node:test';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Connection } from '@salesforce/core';
import { McpTool, ReleaseState, Toolset, type McpToolConfig } from '@salesforce/mcp-provider-api';
import type { ManagedDmlFieldRuleRecord } from '@sfoa/control-plane';
import {
  createRequestContext,
  createSalesforceIdentityRoute,
  type RuntimeLogEvent,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
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
    fields: { LastName: 'Test', Requested_By__c: 'agent-supplied-value' },
  }, extra());

  assert.equal(result.isError, undefined);
  assert.equal(fieldValue(tool.input, 'Requested_By__c'), CONTACT_A);
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
});

test('pre-dispatch managed lookup timeout is FAILED MCP_TOOL_TIMEOUT and never outcome unknown', async () => {
  const logger = new RecordingLogger();
  const tool = new CapturingCreateTool();
  const context = createRequestContext({ platformUserId: 'platform-user-a', correlationId: 'managed-timeout' }, process.cwd());
  const resolver = new ManagedDmlFieldResolver(
    queryConnection(() => new Promise(() => undefined)),
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
});

test('50 delayed out-of-order requests keep platform A/B managed values isolated for one Salesforce username', async () => {
  const tasks: Promise<void>[] = [];
  for (let iteration = 0; iteration < 50; iteration += 1) {
    tasks.push(assertIsolatedResolution('platform-user-a', CONTACT_A, iteration % 2 === 0 ? 4 : 0));
    tasks.push(assertIsolatedResolution('platform-user-b', CONTACT_B, iteration % 2 === 0 ? 0 : 4));
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
    applyOnUpdate: true,
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

function queryConnection(query: (soql: string) => Promise<unknown>): Connection {
  return Object.freeze({ query }) as unknown as Connection;
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
  public executions = 0;
  public input: Readonly<Record<string, unknown>> | undefined;
  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.DATA]; }
  public getName(): string { return 'create_record'; }
  public getConfig(): McpToolConfig<typeof emptySchema.shape> { return { inputSchema: emptySchema.shape }; }
  public async exec(input: Readonly<Record<string, unknown>>): Promise<CallToolResult> {
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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { McpTool, ReleaseState, Toolset, type McpToolConfig } from '@salesforce/mcp-provider-api';
import {
  createRequestContext,
  createSalesforceIdentityRoute,
  NoopRuntimeLogger,
} from '@sfoa/identity-runtime';
import { z } from 'zod';
import { ContextToolFacade } from '../context-tool-facade.js';
import { createValueAssessmentSchema, type CreateValueAssessment } from '@sfoa/mcp-provider-sfoa-context';
import type { RuntimeManagedDmlFieldRule } from '../dml-managed-fields.js';

for (const objectApiName of ['Order__c', 'order__c', 'ORDER__C']) {
test('host enriches case-insensitive object/action managed field facts: ' + objectApiName, async () => {
  const facade = new ContextToolFacade({
    tool: new ActionContextTool(),
    context: createRequestContext({ platformUserId: 'action-user', correlationId: 'action-managed' }, process.cwd()),
    route: createSalesforceIdentityRoute({
      platformUserId: 'action-user',
      salesforceUsername: 'user@example.invalid',
      credentialProfile: 'test',
      connectionRole: 'USER',
      aliases: [],
    }),
    toolTimeoutMs: 1_000,
    logger: new NoopRuntimeLogger(),
    clientId: 'context-test',
    managedDmlFieldRules: [rule('Order__c', 'Requested_By__c', true, true), rule('Order__c', 'Created_By_AI__c', true, false, 'AI_CREATED_MARKER'), rule('Order__c', 'Order_Owner__c', true, false, 'PLATFORM_USER_LOOKUP_FALLBACK'), rule('Account', 'Owner_Contact__c', true, true)],
  });

  assert.ok(Object.hasOwn(facade.getConfig().outputSchema ?? {}, 'managedDmlFields'));
  const result = await facade.execute({ objectApiName, action: 'UPDATE', recordId: '00Q000000000001AAA' }, extra());
  assert.equal(result.content.length, 1, 'host enrichment must not retain a stale JSON mirror');
  assert.equal(result.content[0]?.type, 'text');
  if (result.content[0]?.type === 'text') assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  const managed = result.structuredContent?.managedDmlFields;
  assert.deepEqual(managed, [{
    objectApiName: 'Order__c',
    fieldApiName: 'Requested_By__c',
    operations: ['UPDATE'],
    managedBy: 'MCP',
    strategy: 'PLATFORM_IDENTITY',
  }]);
  const created = await facade.execute({ objectApiName, action: 'CREATE' }, extra());
  assert.equal(created.content.length, 1);
  if (created.content[0]?.type === 'text') assert.deepEqual(JSON.parse(created.content[0].text), created.structuredContent);
  const createManaged = created.structuredContent?.managedDmlFields;
  assert.ok(Array.isArray(createManaged));
  assert.deepEqual(createManaged.map((field: { strategy: string }) => field.strategy).sort(),
    ['AI_CREATED_MARKER', 'PLATFORM_IDENTITY', 'PLATFORM_IDENTITY_FALLBACK']);
  const schema = facade.getConfig().outputSchema?.managedDmlFields;
  assert.ok(schema?.safeParse(createManaged).success);
  const serialized = JSON.stringify([managed, createManaged]);
  assert.doesNotMatch(serialized, /lookup|Contact|Platform_User_Id__c|action-user|003000/u);
});
}

function rule(
  objectApiName: string,
  targetFieldApiName: string,
  applyOnCreate: boolean,
  applyOnUpdate: boolean,
  strategy: RuntimeManagedDmlFieldRule['strategy'] = 'PLATFORM_USER_LOOKUP',
): RuntimeManagedDmlFieldRule {
  return Object.freeze({
    id: `${objectApiName}-${targetFieldApiName}`,
    dmlPolicyId: objectApiName,
    objectApiName,
    targetFieldApiName,
    strategy,
    applyOnCreate,
    applyOnUpdate,
    lookupObjectApiName: strategy !== 'AI_CREATED_MARKER' ? 'Contact' : null,
    lookupMatchFieldApiName: strategy !== 'AI_CREATED_MARKER' ? 'Platform_User_Id__c' : null,
    enabled: true,
    remark: null,
    rowVersion: '1',
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  });
}

/**
 * HF03. Server-managed DML values are authoritative for mutation payloads but do not prove the
 * initial values Lightning's New Page would use, so they are never trusted for visibility.
 * Resolving them while merely observing a Dynamic Forms page added request-USER Salesforce
 * lookups (for example PLATFORM_USER_LOOKUP) whose failure forced a whole-resolution
 * PAGE_LAYOUT fallback. The extension point stays available to a caller with a proven
 * equivalent provider; the server must not wire one. The behavioral half of this contract —
 * no extra reads, and a failing provider isolating to UNKNOWN instead of falling back — is
 * asserted in the context provider's effective-ui tests.
 */
test('the server never wires a runtime-default provider into Dynamic Forms resolution', () => {
  const source = readFileSync(new URL('../../src/provider-runtime.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /resolveRuntimeDefaults\s*:/u);
  assert.match(source, /Deliberately no `resolveRuntimeDefaults` wiring/u);
});

const emptySchema = z.object({});class ActionContextTool extends McpTool<typeof emptySchema.shape> {
  public constructor(private readonly valueAssessment?: CreateValueAssessment) { super(); }
  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.DATA]; }
  public getName(): string { return 'get_record_action_context'; }
  public getConfig(): McpToolConfig<typeof emptySchema.shape> {
    return { description: 'test action context', inputSchema: emptySchema.shape, outputSchema: emptySchema.shape };
  }
  public async exec(): Promise<CallToolResult> {
    const structuredContent = { success: true, fields: [{ apiName: 'City__c', label: '公司城市', inlineHelpText: '公司所在地城市', length: 255 }],
      ...(this.valueAssessment ? { valueAssessment: this.valueAssessment } : {}) };
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
  }
}

function extra(): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return Object.freeze({}) as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

test('optional CREATE assessment gains strict/fallback managed facts and keeps one exact final JSON mirror', async () => {
  const valueAssessment = createValueAssessmentSchema.parse({ coverage: 'COMPLETE', requirednessSource: 'PAGE_LAYOUT_REQUIRED', warnings: [],
    fields: ['Requested_By__c', 'Order_Owner__c', 'Created_By_AI__c'].map(apiName => ({ apiName, required: false,
      status: 'EMPTY', source: 'DRAFT', draftState: 'EMPTY', defaultPresent: false, defaultState: 'ABSENT' })) });
  const before = JSON.stringify(valueAssessment);
  let connectionCalls = 0;
  const facade = new ContextToolFacade({
    tool: new ActionContextTool(valueAssessment),
    context: createRequestContext({ platformUserId: 'action-user', correlationId: 'assessment-managed' }, process.cwd()),
    route: createSalesforceIdentityRoute({ platformUserId: 'action-user', salesforceUsername: 'user@example.invalid',
      credentialProfile: 'test', connectionRole: 'USER', aliases: [] }),
    toolTimeoutMs: 1000, logger: new NoopRuntimeLogger(), clientId: 'context-test',
    connectionProvider: { getConnection: async () => { connectionCalls++; return {}; } } as unknown as import('@sfoa/identity-runtime').SalesforceConnectionProvider,
    managedDmlFieldRules: [rule('Order__c', 'Requested_By__c', true, true),
      rule('Order__c', 'Order_Owner__c', true, false, 'PLATFORM_USER_LOOKUP_FALLBACK'),
      rule('Order__c', 'Created_By_AI__c', true, false, 'AI_CREATED_MARKER')],
  });
  const result = await facade.execute({ objectApiName: 'Order__c', action: 'CREATE', includeValueAssessment: true,
    draftFields: { Requested_By__c: null, Order_Owner__c: null, Created_By_AI__c: null } }, extra());
  const assessment = createValueAssessmentSchema.parse(result.structuredContent?.valueAssessment);
  assert.deepEqual(assessment.fields.map(field => [field.status, field.managedStrategy]), [
    ['MANAGED_ON_WRITE', 'PLATFORM_IDENTITY'], ['EMPTY', 'PLATFORM_IDENTITY_FALLBACK'], ['MANAGED_ON_WRITE', 'AI_CREATED_MARKER'],
  ]);
  assert.equal(connectionCalls, 1, 'only the pre-existing request Connection initialization, no managed Lookup');
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]?.type, 'text');
  if (result.content[0]?.type === 'text') assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(JSON.stringify(valueAssessment), before);
  assert.doesNotMatch(JSON.stringify(assessment), /action-user|003000|lookup|Contact|Platform_User_Id/u);
});

import assert from 'node:assert/strict';
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
  const managed = result.structuredContent?.managedDmlFields;
  assert.deepEqual(managed, [{
    objectApiName: 'Order__c',
    fieldApiName: 'Requested_By__c',
    operations: ['UPDATE'],
    managedBy: 'MCP',
    strategy: 'PLATFORM_IDENTITY',
  }]);
  const created = await facade.execute({ objectApiName, action: 'CREATE' }, extra());
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

const emptySchema = z.object({});
class ActionContextTool extends McpTool<typeof emptySchema.shape> {
  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.DATA]; }
  public getName(): string { return 'get_record_action_context'; }
  public getConfig(): McpToolConfig<typeof emptySchema.shape> {
    return { description: 'test action context', inputSchema: emptySchema.shape, outputSchema: emptySchema.shape };
  }
  public async exec(): Promise<CallToolResult> {
    return { content: [{ type: 'text', text: 'context' }], structuredContent: { success: true, fields: [] } };
  }
}

function extra(): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return Object.freeze({}) as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

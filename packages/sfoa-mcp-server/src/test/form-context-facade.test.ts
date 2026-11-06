import assert from 'node:assert/strict';
import test from 'node:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpTool, ReleaseState, Toolset, type McpToolConfig } from '@salesforce/mcp-provider-api';
import { createRequestContext, createSalesforceIdentityRoute, NoopRuntimeLogger, RequestAuditContextController,
  runWithRequestAuditContext, type RuntimeLogEvent } from '@sfoa/identity-runtime';
import { z } from 'zod';
import { ContextToolFacade } from '../context-tool-facade.js';
import { DmlToolFacade, type DmlToolFacadeOptions } from '../dml-tool-facade.js';
import { RemoteRuntimeError } from '../errors.js';

const schema = z.object({});
const recordId = '001000000000001AAA';
const resolutionId = '12345678-1234-4123-8123-123456789012';
const context = createRequestContext({ platformUserId: 'form-user', correlationId: 'form-audit' }, process.cwd());
const route = createSalesforceIdentityRoute({ platformUserId: 'form-user', salesforceUsername: 'form@example.invalid',
  credentialProfile: 'test', connectionRole: 'USER', aliases: [] });
const extra = {} as Parameters<DmlToolFacade['execute']>[1];

class CapturingTool extends McpTool<typeof schema.shape> {
  public calls: Record<string, unknown>[] = [];
  public constructor(private readonly name: string, private readonly result: CallToolResult = {
    content: [], structuredContent: { success: true, recordId },
  }) { super(); }
  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.DATA]; }
  public getName(): string { return this.name; }
  public getConfig(): McpToolConfig<typeof schema.shape> { return { inputSchema: schema.shape }; }
  public async exec(input: Record<string, unknown>): Promise<CallToolResult> { this.calls.push(input); return this.result; }
}
function facade(tool: CapturingTool, options: Partial<DmlToolFacadeOptions> = {}): DmlToolFacade {
  return new DmlToolFacade({ tool, context, route, toolTimeoutMs: 1000, logger: new NoopRuntimeLogger(),
    clientId: 'form-test', mutationStarted: () => false, ...options });
}

test('legacy DML never invokes form preparation, while UPDATE correlation remains unverified', async () => {
  const tool = new CapturingTool('update_record');
  let prepared = 0;
  const audit = RequestAuditContextController.create({ channel: 'MCP_HTTP', toolName: 'update_record' });
  const input = { objectApiName: 'Account', recordId, fields: { Name: 'Actual change' }, uiContextResolutionId: resolutionId };
  const result = await runWithRequestAuditContext(audit, () => facade(tool, {
    prepareFormInput: async (_operation, value) => { prepared++; return { input: value }; },
  }).execute(input, extra));
  assert.equal(result.structuredContent?.success, true);
  assert.equal(prepared, 0);
  assert.deepEqual(tool.calls, [input]);
  const event = audit.finalizeAudit()!.auditEvents.find((item) => item.eventType === 'UI_CONTEXT_LINK');
  assert.deepEqual(event?.safeSummary, { action: 'UPDATE', contextLinkStatus: 'CLIENT_PROVIDED_UNVERIFIED',
    objectApiName: 'Account', recordId, recordTypeId: null, uiContextResolutionId: resolutionId });
});

test('prepared input and native action override dispatch once inside the existing DML path', async () => {
  const tool = new CapturingTool('create_record');
  let preparations = 0; let actions = 0;
  const result = await facade(tool, { prepareFormInput: async (operation, input) => {
    assert.equal(operation, 'CREATE'); preparations++;
    return { input: { ...input, fields: { Name: 'Prepared' } }, execute: async () => {
      actions++; return { content: [], structuredContent: { success: true, recordId } };
    } };
  } }).execute({ objectApiName: 'Account', fields: { Name: 'Requested' }, formContext: { entry: 'QUICK_ACTION' } }, extra);
  assert.equal(result.structuredContent?.success, true);
  assert.equal(preparations, 1); assert.equal(actions, 1); assert.equal(tool.calls.length, 0);
});

test('readiness rejection and missing preparation capability cannot dispatch or become unknown mutations', async () => {
  for (const prepareFormInput of [undefined,
    async () => { throw new RemoteRuntimeError('MCP_FORM_NOT_READY', 'Required field Reason__c is empty.'); },
    async () => { throw new Error('private upstream data must not escape'); },
  ]) {
    const tool = new CapturingTool('update_record');
    const result = await facade(tool, { prepareFormInput }).execute({
      objectApiName: 'Account', recordId, fields: { Name: 'Changed' }, formContext: { entry: 'STANDARD' },
    }, extra);
    assert.equal(result.isError, true);
    assert.ok(['MCP_FORM_NOT_READY', 'MCP_FORM_CONTEXT_UNAVAILABLE'].includes(String(result.structuredContent?.errorCode)));
    assert.equal(tool.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /private upstream|MCP_DML_OUTCOME_UNKNOWN/u);
  }
});

test('late form preparation cannot dispatch after the original DML deadline', async (t) => {
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepAlive));
  let finish: (() => void) | undefined;
  let dispatches = 0;
  const tool = new CapturingTool('create_record');
  const result = await facade(tool, { toolTimeoutMs: 20,
    prepareFormInput: async (_operation, input) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { input, execute: async () => { dispatches++; return { content: [] }; } };
    },
  }).execute({ objectApiName: 'Account', fields: { Name: 'Pending' }, formContext: { entry: 'STANDARD' } }, extra);
  assert.equal(result.structuredContent?.errorCode, 'MCP_TOOL_TIMEOUT');
  finish?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(dispatches, 0); assert.equal(tool.calls.length, 0);
});

test('audit collection failure does not change prepared UPDATE result', async () => {
  const audit = RequestAuditContextController.create({ channel: 'MCP_HTTP', toolName: 'update_record' });
  audit.collector().recordEvent = () => { throw new Error('unavailable audit'); };
  const tool = new CapturingTool('update_record');
  const result = await runWithRequestAuditContext(audit, () => facade(tool, {
    logger: { log: () => { throw new Error('unavailable log'); } },
    prepareFormInput: async (_operation, input) => ({ input }),
  }).execute({ objectApiName: 'Account', recordId, fields: { Name: 'Changed' }, formContext: { entry: 'STANDARD' } }, extra));
  assert.equal(result.structuredContent?.success, true); assert.equal(tool.calls.length, 1);
});

test('precise UPDATE does not produce CREATE_ONLY evidence and terminal summary contains counts only', async () => {
  const logs: RuntimeLogEvent[] = [];
  const audit = RequestAuditContextController.create({ channel: 'MCP_HTTP', toolName: 'get_record_action_context' });
  const tool = new CapturingTool('get_record_action_context', { content: [], structuredContent: {
    success: true, formContext: { status: 'UNKNOWN', missingRequired: ['Reason__c'], criticalUnknown: ['VALUE_UNAVAILABLE'],
      fields: [{ apiName: 'Private__c', value: 'protected-value' }] },
  } });
  const actionFacade = new ContextToolFacade({ tool, context, route, toolTimeoutMs: 1000, clientId: 'context-test',
    logger: { log: (event) => { logs.push(event); } } });
  await runWithRequestAuditContext(audit, () => actionFacade.execute({ objectApiName: 'Account', action: 'UPDATE',
    recordId, formContext: { entry: 'STANDARD' } }, extra));
  assert.equal(audit.finalizeAudit()!.auditEvents.filter((event) => event.eventType.startsWith('UI_CONTEXT')).length, 0);
  const summary = logs[0]?.responseSummary;
  assert.deepEqual(summary, { isError: false, managedDmlFieldCount: 0, formReadinessStatus: 'UNKNOWN',
    missingRequiredCount: 1, criticalUnknownCount: 1 });
  assert.doesNotMatch(JSON.stringify(logs), /protected-value|Private__c|Reason__c|VALUE_UNAVAILABLE/u);
});

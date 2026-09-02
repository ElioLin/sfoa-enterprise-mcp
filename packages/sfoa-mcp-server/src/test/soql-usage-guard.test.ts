import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { McpTool, type McpToolConfig, ReleaseState, Toolset } from '@salesforce/mcp-provider-api';
import {
  createRequestContext,
  createSalesforceIdentityRoute,
  NoopRuntimeLogger,
  type RequestScopedToolExecutionAdapter,
} from '@sfoa/identity-runtime';
import { z } from 'zod';
import { findOfficialToolPolicy } from '../official-tool-catalog.js';
import { RemoteToolFacade } from '../remote-tool-facade.js';
import {
  describeSoqlObjectUsageBlock,
  evaluateSoqlObjectUsageGuard,
  extractSoqlTopLevelObject,
} from '../soql-usage-guard.js';
import { toolResultText } from './helpers.js';

const extra = {} as RequestHandlerExtra<ServerRequest, ServerNotification>;

const runSoqlInputSchema = {
  query: z.string().min(1),
  usernameOrAlias: z.string().min(1),
  directory: z.string().min(1),
  useToolingApi: z.boolean().optional(),
};

class OfficialLikeQueryTool extends McpTool<typeof runSoqlInputSchema> {
  public executions = 0;

  public constructor() { super(); }
  public getReleaseState(): ReleaseState { return ReleaseState.GA; }
  public getToolsets(): Toolset[] { return [Toolset.DATA]; }
  public getName(): string { return 'run_soql_query'; }
  public getConfig(): McpToolConfig<typeof runSoqlInputSchema> {
    return { inputSchema: runSoqlInputSchema, description: 'official base run_soql_query description' };
  }
  public async exec(): Promise<CallToolResult> {
    this.executions += 1;
    return { content: [{ type: 'text', text: 'executed' }] };
  }
}

describe('soql object usage guard', () => {
  it('extracts only the top-level SOQL object across sub-queries and literals', () => {
    assert.equal(extractSoqlTopLevelObject('SELECT Id FROM Quote'), 'Quote');
    assert.equal(extractSoqlTopLevelObject('SELECT Id FROM Quote LIMIT 1'), 'Quote');
    assert.equal(
      extractSoqlTopLevelObject('SELECT Id, (SELECT Id FROM QuoteLineItem) FROM Quote__c'),
      'Quote__c',
    );
    assert.equal(
      extractSoqlTopLevelObject("SELECT Id FROM Account WHERE Name = 'FROM' ORDER BY Name"),
      'Account',
    );
    assert.equal(extractSoqlTopLevelObject('SELECT Id FROM Contract WHERE Status = \'Draft\''), 'Contract');
    assert.equal(
      extractSoqlTopLevelObject('SELECT Id FROM Account WHERE Id IN (SELECT AccountId FROM OrderItem)'),
      'Account',
    );
    assert.equal(extractSoqlTopLevelObject('   '), undefined);
    assert.equal(extractSoqlTopLevelObject('SELECT Id FROM'), undefined);
  });

  it('guards declared unused standard objects and leaves custom, allowed, and tooling queries alone', () => {
    assert.equal(evaluateSoqlObjectUsageGuard({ query: 'SELECT Id FROM Quote LIMIT 1' }).blocked, true);
    assert.equal(evaluateSoqlObjectUsageGuard({ query: 'SELECT Id FROM Pricebook2' }).blocked, true);
    assert.equal(evaluateSoqlObjectUsageGuard({ query: 'SELECT Id FROM Contract' }).blocked, true);
    assert.equal(evaluateSoqlObjectUsageGuard({ query: 'SELECT Id FROM Quote__c LIMIT 1' }).blocked, false);
    assert.equal(evaluateSoqlObjectUsageGuard({ query: 'SELECT Id FROM Account' }).blocked, false);
    assert.equal(evaluateSoqlObjectUsageGuard({ query: 'SELECT Id FROM Order_Product__c' }).blocked, false);
    assert.equal(evaluateSoqlObjectUsageGuard({ query: 'SELECT Id FROM Quote', useToolingApi: true }).blocked, false);
    assert.equal(evaluateSoqlObjectUsageGuard({ query: undefined }).blocked, false);
  });

  it('describes the block with the replacement custom object', () => {
    const verdict = evaluateSoqlObjectUsageGuard({ query: 'SELECT Id FROM Quote' });
    assert.equal(verdict.blocked, true);
    const message = verdict.blocked
      ? describeSoqlObjectUsageBlock(verdict.substitution)
      : '';
    assert.match(message, /Quote/u);
    assert.match(message, /Quote__c/u);
  });

  it('blocks a USER run_soql_query on an unused standard object before execution', async () => {
    const route = createSalesforceIdentityRoute({
      platformUserId: 'guard-user',
      salesforceUsername: 'user@example.test',
      credentialProfile: 'test',
      connectionRole: 'USER',
      aliases: [],
    });
    const context = createRequestContext(
      { platformUserId: 'guard-user', correlationId: 'soql-guard' },
      process.cwd(),
    );
    const logger = new NoopRuntimeLogger();
    const tool = new OfficialLikeQueryTool();
    const policyRecord = findOfficialToolPolicy('run_soql_query');
    assert.ok(policyRecord);
    const remote = new RemoteToolFacade({
      tool,
      policyRecord,
      adapter: {} as RequestScopedToolExecutionAdapter,
      context,
      route,
      workspaceRoot: process.cwd(),
      toolTimeoutMs: 1_000,
      logger,
      clientId: 'client',
    });

    const blocked = await remote.execute({ query: 'SELECT Id FROM Quote LIMIT 1' }, extra);
    assert.equal(blocked.isError, true);
    assert.match(toolResultText(blocked), /MCP_SOBJECT_NOT_IN_USE/u);
    assert.match(toolResultText(blocked), /Quote__c/u);
    assert.equal(tool.executions, 0);

    const toolDescription = remote.getConfig().description ?? '';
    assert.match(toolDescription, /this org does not use the Salesforce standard objects/u);
    assert.match(toolDescription, /`Quote`→`Quote__c`/u);
  });

  it('does not interfere with allowed object queries', async () => {
    const route = createSalesforceIdentityRoute({
      platformUserId: 'guard-user',
      salesforceUsername: 'user@example.test',
      credentialProfile: 'test',
      connectionRole: 'USER',
      aliases: [],
    });
    const context = createRequestContext(
      { platformUserId: 'guard-user', correlationId: 'soql-guard-ok' },
      process.cwd(),
    );
    const logger = new NoopRuntimeLogger();
    const tool = new OfficialLikeQueryTool();
    const policyRecord = findOfficialToolPolicy('run_soql_query');
    assert.ok(policyRecord);
    let executed = 0;
    const adapter = {
      execute: async (): Promise<CallToolResult> => {
        executed += 1;
        return { content: [{ type: 'text', text: 'account rows' }] };
      },
    } as unknown as RequestScopedToolExecutionAdapter;
    const remote = new RemoteToolFacade({
      tool,
      policyRecord,
      adapter,
      context,
      route,
      workspaceRoot: process.cwd(),
      toolTimeoutMs: 1_000,
      logger,
      clientId: 'client',
    });

    const result = await remote.execute({ query: 'SELECT Id FROM Account LIMIT 1' }, extra);
    assert.equal(result.isError, undefined);
    assert.match(toolResultText(result), /account rows/u);
    assert.equal(executed, 1);
  });
});

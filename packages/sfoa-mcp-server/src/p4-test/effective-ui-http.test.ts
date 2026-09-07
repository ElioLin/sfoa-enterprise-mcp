import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Connection } from '@salesforce/core';
import type { AuditSnapshot, SalesforceConnectionFactory, RuntimeLogger } from '@sfoa/identity-runtime';
import { freezeSnapshot } from '@sfoa/control-plane';
import { UI_PARSER_VERSION, type UiSnapshot, type UiMode } from '@sfoa/mcp-provider-sfoa-context';
import { startRemoteMcpServer } from '../http-server.js';
import { createTestIdentityRuntime, createTestRemoteConfig, mcpHeaders, waitFor, TEST_PLATFORM_USER_A, TEST_PLATFORM_USER_B, TEST_USERNAME_A, TEST_USERNAME_B } from '../test/helpers.js';

test('P8 HTTP uses request policy and USER facts, returns DF/PL independently, and links CREATE audit', async (t) => {
  t.mock.method(performance, 'now', () => 1000);
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-p804-http-'));
  const traces: AuditSnapshot[] = [];
  const submitted: unknown[] = [];
  let metadataCalls = 0;
  let mode: UiMode = 'ENFORCE';
  let snapshotMissing = false;
  const rt = '012000000000001AAA';
  const org = '00D000000000001AAA';
  const profileA = '00e000000000001AAA';
  const profileB = '00e000000000002AAA';
  const now = new Date().toISOString();
  const snapshot: UiSnapshot = { organizationId: org, objectApiName: 'Lead', parserVersion: UI_PARSER_VERSION, complete: true,
    profiles: [{ id: profileA, name: 'Display A', fullName: 'Profile_A' }, { id: profileB, name: 'Display B', fullName: 'Profile_B' }],
    recordTypes: [{ id: rt, fullName: 'Lead.Business' }], apps: [{ appId: '06m000000000001AAA', developerName: 'App_A', fullName: 'App_A' }],
    assignments: [{ app: 'App_A', profile: 'Profile_A', recordType: 'Lead.Business', formFactor: 'Large', action: 'View', type: 'Flexipage', page: 'Page_A', source: 'APP_PROFILE_RECORD_TYPE' }],
    pages: [{ fullName: 'Page_A', objectApiName: 'Lead', type: 'RecordPage', formSource: 'DYNAMIC_FORMS', unsupported: [],
      fields: [{ apiName: 'Name', instanceId: 'name', section: 'Details', sectionOrder: 0, column: 0, order: 0, ancestry: ['main'], required: true, readOnly: false, rules: [] }] }],
  };
  const factory: SalesforceConnectionFactory = { create: async (route) => {
    const profileId = route.salesforceUsername === TEST_USERNAME_A ? profileA : profileB;
    const fields = Object.fromEntries(['Name', 'Legacy__c'].map((apiName) => [apiName, { apiName, label: apiName, dataType: 'String', required: false, createable: true, updateable: true }]));
    return {
      getApiVersion: () => '67.0',
      soap: { getUserInfo: async () => ({ userId: `005${profileId.slice(3)}`, organizationId: org, profileId }) },
      metadata: { read: () => { metadataCalls++; throw new Error('forbidden'); } },
      request: async ({ url }: { url: string }) => url.includes('/apps?') ? { apps: snapshot.apps }
        : url.includes('/picklist-values/') ? { picklistFieldValues: {} }
        : url.includes('/object-info/') ? { apiName: 'Lead', label: 'Lead', labelPlural: 'Leads', createable: true, fields, defaultRecordTypeId: rt,
          recordTypeInfos: { [rt]: { recordTypeId: rt, name: 'Business', available: true, defaultRecordTypeMapping: true } } }
        : { layout: { id: '00h000000000001AAA', sections: [{ heading: 'Legacy', layoutRows: [{ layoutItems: [{ required: false, editableForNew: true, editableForUpdate: true,
          layoutComponents: [{ componentType: 'Field', apiName: 'Legacy__c' }] }] }] }] }, record: { apiName: 'Lead', recordTypeId: rt, fields: {} } },
      sobject: () => ({ create: async (fields_: unknown) => { submitted.push(fields_); return { success: true, id: '00Q000000000001AAA', errors: [] }; } }),
    } as unknown as Connection;
  } };
  const logger: RuntimeLogger = { log: () => undefined, finalizeRequestAudit: (context) => { const trace = context.finalizeAudit(); if (trace) traces.push(trace); } };
  const server = await startRemoteMcpServer({ config: createTestRemoteConfig({ controlPlane: { mode: 'mysql' }, requestTimeoutMs: 10000, toolTimeoutMs: 5000 }),
    identityRuntime: createTestIdentityRuntime(root, factory, logger),
    loadUiSnapshot: async (organizationId, object) => { assert.equal(organizationId, org); assert.equal(object, 'Lead'); if (snapshotMissing) return undefined; return {
      id: '1', organizationId: org, objectApiName: 'Lead', snapshot, hash: 'a'.repeat(64), lastModified: null, refreshedAt: now, status: 'READY', lastError: null, parserVersion: UI_PARSER_VERSION }; },
    policySnapshotSource: { load: async (platformUserId) => freezeSnapshot({ mode: 'mysql', loadedAt: now,
      identityRoute: { id: platformUserId === TEST_PLATFORM_USER_A ? '1' : '2', platformUserId, userName: 'Test',
        salesforceUsername: platformUserId === TEST_PLATFORM_USER_A ? TEST_USERNAME_A : TEST_USERNAME_B, enabled: true, remark: null, rowVersion: '1', createdAt: now, updatedAt: now },
      enabledTools: ['get_record_action_context', 'create_record'], managedDmlFieldRules: [], diagnostic: null,
      dmlPolicies: [{ id: '1', objectApiName: 'Lead', allowCreate: true, allowUpdate: false, enabled: true, remark: null, rowVersion: '1', createdAt: now, updatedAt: now }],
      runtimeSettings: { dynamicFormsObjectPolicies: [{ objectApiName: 'Lead', mode }], integrationDefaultSalesforceAppDeveloperName: 'App_A' },
    }) },
  });
  const clients: Client[] = [];
  try {
    for (const user of [TEST_PLATFORM_USER_A, TEST_PLATFORM_USER_B]) {
      const client = new Client({ name: 'p804-http', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(server.mcpUrl, { requestInit: { headers: mcpHeaders(user) } }));
      clients.push(client);
    }
    const [a, b] = await Promise.all(clients.map((client) => client.callTool({ name: 'get_record_action_context', arguments: { objectApiName: 'Lead', action: 'CREATE', draftFields: { Name: 'PRIVATE_DRAFT' } } })));
    assert.equal(a!.isError, undefined, JSON.stringify(a)); assert.equal(b!.isError, undefined, JSON.stringify(b));
    const contextA = a!.structuredContent as Record<string, unknown>;
    const contextB = b!.structuredContent as Record<string, unknown>;
    assert.equal((contextA.uiContext as { formSource: string }).formSource, 'DYNAMIC_FORMS');
    assert.equal(contextB.uiContext, undefined);
    assert.equal(contextB.uiContextResolutionId, undefined);
    assert.deepEqual((contextB.fields as { apiName: string }[]).map((field) => field.apiName), ['Legacy__c', 'Name']);
    const resolutionId = contextA.uiContextResolutionId;
    const created = await clients[0]!.callTool({ name: 'create_record', arguments: { objectApiName: 'Lead', fields: { Name: 'Test' }, recordTypeId: rt, uiContextResolutionId: resolutionId } });
    assert.equal(created.isError, undefined, JSON.stringify(created));
    await waitFor(() => traces.some((trace) => trace.auditCall.toolName === 'create_record'), 2000);
    assert.deepEqual(submitted, [{ Name: 'Test', RecordTypeId: rt }]);
    assert.equal(metadataCalls, 0);
    const source = traces.flatMap((trace) => trace.auditEvents).find((event) => (event.safeSummary as { resolutionId?: unknown })?.resolutionId === resolutionId);
    assert.equal(source?.eventType, 'UI_CONTEXT_RESOLVED');
    assert.ok(traces.flatMap((trace) => trace.auditEvents).some((event) => event.eventType === 'UI_CONTEXT_LINK' && (event.safeSummary as { uiContextResolutionId: unknown }).uiContextResolutionId === resolutionId));
    const evidence = traces.flatMap((trace) => trace.payloadEvidence).filter((entry) => entry.payloadType === 'UI_CONTEXT');
    assert.equal(evidence.length, 1);
    assert.doesNotMatch(evidence[0]!.safePayload ?? '', /PRIVATE_DRAFT/u);
    assert.match(evidence[0]!.safePayload ?? '', /DYNAMIC_FORM/u);
    const args = { objectApiName: 'Lead', action: 'CREATE' };
    mode = 'OFF';
    const baseline = await clients[0]!.callTool({ name: 'get_record_action_context', arguments: args });
    assert.deepStrictEqual(baseline.structuredContent, contextB);
    for (const selected of ['SHADOW', 'ENFORCE'] as const) {
      mode = selected;
      snapshotMissing = selected === 'ENFORCE';
      assert.deepStrictEqual(await clients[0]!.callTool({ name: 'get_record_action_context', arguments: args }), baseline);
    }
    await waitFor(() => traces.filter((trace) => trace.auditCall.toolName === 'get_record_action_context').length === 5, 2000);
    for (const trace of traces.filter((entry) => entry.auditCall.toolName === 'get_record_action_context')) {
      const resolutions = trace.auditEvents.filter((event) => event.eventType.startsWith('UI_CONTEXT_'));
      assert.equal(resolutions.length, 1, 'internal Audit must not depend on Agent-visible ID');
      const summary = resolutions[0]!.safeSummary as { resolutionId: string; usedForAgent: boolean; reason?: string };
      assert.ok(summary.resolutionId);
      assert.equal(summary.usedForAgent, summary.resolutionId === resolutionId);
      assert.equal(summary.reason, undefined, 'ready Page Layout must not be mislabeled selection-required');
    }
  } finally {
    await Promise.all(clients.map((client) => client.close())); await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

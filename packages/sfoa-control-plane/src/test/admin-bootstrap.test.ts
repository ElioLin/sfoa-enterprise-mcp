import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapFromEnvironment, ControlPlaneAdminService, ControlPlaneError } from '../index.js';
import { InMemoryControlPlaneStore } from './in-memory-store.js';

test('bootstrap is idempotent, imports current governance, and permits shared USER usernames', async () => {
  const store = new InMemoryControlPlaneStore();
  const environment = Object.freeze({
    SALESFORCE_USERNAME: 'shared@example.invalid',
    SECOND_TEST_USER: 'shared@example.invalid',
    P1_PLATFORM_USER_A: 'platform-a',
    P1_PLATFORM_USER_B: 'platform-b',
    MCP_ENABLED_TOOLS: 'run_soql_query,create_record,run_soql_query',
    MCP_DML_ALLOWLIST_JSON: JSON.stringify([
      { objectApiName: 'Lead', operations: ['CREATE'] },
      { objectApiName: 'Account', operations: ['UPDATE'] },
    ]),
    SFOA_DIAGNOSTIC_USERNAME: 'diagnostic@example.invalid',
    TEST_METADATA_TYPE: 'ApexClass',
    TEST_METADATA_FULL_NAME: 'SafeClass',
  });
  const first = await bootstrapFromEnvironment(store, process.cwd(), environment);
  assert.deepEqual(first, {
    forced: false,
    routesCreated: 2, routesUpdated: 0,
    toolsCreated: 2, toolsUpdated: 0,
    dmlPoliciesCreated: 2, dmlPoliciesUpdated: 0,
    diagnosticCreated: true, diagnosticUpdated: false,
    settingsCreated: 2, settingsUpdated: 0,
  });
  const second = await bootstrapFromEnvironment(store, process.cwd(), environment);
  assert.equal(second.routesCreated, 0);
  assert.equal(second.toolsCreated, 0);
  assert.equal(second.dmlPoliciesCreated, 0);
  assert.equal(second.diagnosticCreated, false);
  assert.equal(second.settingsCreated, 0);
  assert.equal((await store.repositories.identityRoutes.list({ limit: 10, offset: 0 })).items.length, 2);
  assert.deepEqual(await store.repositories.identityRoutes.listActiveSalesforceUsernames(), [
    'shared@example.invalid', 'shared@example.invalid',
  ]);
});

test('force bootstrap requires an explicit development/test environment and Diagnostic/USER conflicts are rejected', async () => {
  const store = new InMemoryControlPlaneStore();
  await assert.rejects(
    bootstrapFromEnvironment(store, process.cwd(), { NODE_ENV: 'production' }, true),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_INPUT_INVALID',
  );
  await assert.rejects(
    bootstrapFromEnvironment(store, process.cwd(), {}, true),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_INPUT_INVALID',
  );
  await assert.rejects(
    bootstrapFromEnvironment(store, process.cwd(), {
      SALESFORCE_USERNAME: 'same@example.invalid',
      SFOA_DIAGNOSTIC_USERNAME: 'SAME@example.invalid',
    }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_CONFLICT',
  );
});

test('Admin writes use optimistic locking and roll back when durable audit fails', async () => {
  const store = new InMemoryControlPlaneStore();
  const service = new ControlPlaneAdminService(store, (toolName) => ({
    allowed: toolName === 'run_soql_query',
    ...(toolName === 'run_soql_query' ? {} : { reason: 'Unknown Tool cannot be enabled.' }),
  }));
  const first = await service.createIdentityRoute({
    platformUserId: 'platform-a', salesforceUsername: 'shared@example.invalid', enabled: true, remark: null,
  }, 'admin');
  await service.createIdentityRoute({
    platformUserId: 'platform-b', salesforceUsername: 'shared@example.invalid', enabled: true, remark: null,
  }, 'admin');
  await assert.rejects(
    service.updateIdentityRoute(first.id, {
      platformUserId: first.platformUserId,
      salesforceUsername: first.salesforceUsername,
      enabled: true,
      remark: null,
      rowVersion: '999',
    }, 'admin'),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_CONCURRENT_MODIFICATION',
  );
  await assert.rejects(
    service.updateTool('future_unknown_tool', { enabled: true, remark: null }, 'admin'),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_INPUT_INVALID',
  );
  await service.updateTool('run_soql_query', { enabled: true, remark: null }, 'admin');
  await assert.rejects(
    service.createDmlPolicy({ objectApiName: 'Lead', allowCreate: false, allowUpdate: false, enabled: true, remark: null }, 'admin'),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_INPUT_INVALID',
  );

  store.setAuditFailure(true);
  await assert.rejects(
    service.createIdentityRoute({
      platformUserId: 'rolled-back', salesforceUsername: 'rollback@example.invalid', enabled: true, remark: null,
    }, 'admin'),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_AUDIT_FAILED',
  );
  assert.equal(await store.repositories.identityRoutes.getByPlatformUserId('rolled-back'), undefined);
});

test('Diagnostic identity remains distinct from every active USER route', async () => {
  const store = new InMemoryControlPlaneStore();
  const service = new ControlPlaneAdminService(store, () => ({ allowed: true }));
  await service.createIdentityRoute({
    platformUserId: 'platform-a', salesforceUsername: 'user@example.invalid', enabled: true, remark: null,
  }, 'admin');
  await assert.rejects(
    service.updateDiagnostic({
      salesforceUsername: 'USER@example.invalid', enabled: true,
      testMetadataType: 'ApexClass', testMetadataFullName: 'SafeClass',
    }, 'admin'),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_CONFLICT',
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bootstrapFromEnvironment,
  ControlPlaneAdminService,
  ControlPlaneError,
  IdentityCredentialCipher,
} from '../index.js';
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
  }), testCredentialCipher());
  const first = await service.createIdentityRoute({
    platformUserId: 'platform-a', userName: 'platform-a', salesforceUsername: 'shared@example.invalid', enabled: true, remark: null,
  }, 'admin');
  await service.createIdentityRoute({
    platformUserId: 'platform-b', userName: 'platform-b', salesforceUsername: 'shared@example.invalid', enabled: true, remark: null,
  }, 'admin');
  await assert.rejects(
    service.updateIdentityRoute(first.route.id, {
      platformUserId: first.route.platformUserId,
      userName: first.route.userName,
      salesforceUsername: first.route.salesforceUsername,
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
      platformUserId: 'rolled-back', userName: 'rolled-back', salesforceUsername: 'rollback@example.invalid', enabled: true, remark: null,
    }, 'admin'),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_AUDIT_FAILED',
  );
  assert.equal(await store.repositories.identityRoutes.getByPlatformUserId('rolled-back'), undefined);
});

test('Diagnostic identity remains distinct from every active USER route', async () => {
  const store = new InMemoryControlPlaneStore();
  const service = new ControlPlaneAdminService(store, () => ({ allowed: true }), testCredentialCipher());
  await service.createIdentityRoute({
    platformUserId: 'platform-a', userName: 'platform-a', salesforceUsername: 'user@example.invalid', enabled: true, remark: null,
  }, 'admin');
  await assert.rejects(
    service.updateDiagnostic({
      salesforceUsername: 'USER@example.invalid', enabled: true,
      testMetadataType: 'ApexClass', testMetadataFullName: 'SafeClass',
    }, 'admin'),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_CONFLICT',
  );
});

test('managed DML field rules enforce strategies, parent operations, locking, audit rollback, and disable-before-delete', async () => {
  const store = new InMemoryControlPlaneStore();
  const service = new ControlPlaneAdminService(store, () => ({ allowed: true }), testCredentialCipher());
  const policy = await service.createDmlPolicy({
    objectApiName: 'Lead', allowCreate: true, allowUpdate: true, enabled: true, remark: null,
  }, 'admin');
  const created = await service.createManagedDmlFieldRule(policy.id, {
    targetFieldApiName: 'Requested_By__c',
    strategy: 'PLATFORM_USER_LOOKUP',
    applyOnCreate: true,
    applyOnUpdate: true,
    lookupObjectApiName: 'Contact',
    lookupMatchFieldApiName: 'Platform_User_Id__c',
    enabled: true,
    remark: null,
  }, 'admin');
  assert.equal(created.dmlPolicyId, policy.id);
  assert.equal((await store.repositories.managedDmlFieldRules.listByDmlPolicyId(policy.id, { limit: 10, offset: 0 })).count, 1);
  await assert.rejects(
    service.createManagedDmlFieldRule(policy.id, {
      targetFieldApiName: 'requested_by__c', strategy: 'PLATFORM_USER_LOOKUP',
      applyOnCreate: true, applyOnUpdate: false, lookupObjectApiName: 'Contact',
      lookupMatchFieldApiName: 'Platform_User_Id__c', enabled: true, remark: null,
    }, 'admin'),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_CONFLICT',
  );
  await assert.rejects(
    service.createManagedDmlFieldRule(policy.id, {
      targetFieldApiName: 'Created_By_AI__c', strategy: 'AI_CREATED_MARKER',
      applyOnCreate: true, applyOnUpdate: true, lookupObjectApiName: null,
      lookupMatchFieldApiName: null, enabled: true, remark: null,
    }, 'admin'),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_INPUT_INVALID',
  );
  await assert.rejects(
    service.updateManagedDmlFieldRule(policy.id, created.id, { ...created, rowVersion: '999' }, 'admin'),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_CONCURRENT_MODIFICATION',
  );
  await assert.rejects(
    service.deleteManagedDmlFieldRule(policy.id, created.id, created.rowVersion, 'admin'),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_INPUT_INVALID',
  );
  const disabled = await service.disableManagedDmlFieldRule(policy.id, created.id, created.rowVersion, 'admin');
  await service.deleteManagedDmlFieldRule(policy.id, disabled.id, disabled.rowVersion, 'admin');
  assert.equal(await store.repositories.managedDmlFieldRules.getById(created.id), undefined);

  store.setAuditFailure(true);
  await assert.rejects(
    service.createManagedDmlFieldRule(policy.id, {
      targetFieldApiName: 'Created_By_AI__c', strategy: 'AI_CREATED_MARKER',
      applyOnCreate: true, applyOnUpdate: false, lookupObjectApiName: null,
      lookupMatchFieldApiName: null, enabled: true, remark: null,
    }, 'admin'),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_AUDIT_FAILED',
  );
  assert.equal((await store.repositories.managedDmlFieldRules.listByDmlPolicyId(policy.id, { limit: 10, offset: 0 })).count, 0);
});

test('managed field rules are rejected when the parent DML policy disallows the matching operation', async () => {
  const store = new InMemoryControlPlaneStore();
  const service = new ControlPlaneAdminService(store, () => ({ allowed: true }), testCredentialCipher());
  const createOnly = await service.createDmlPolicy({
    objectApiName: 'Lead', allowCreate: true, allowUpdate: false, enabled: true, remark: null,
  }, 'admin');
  await assert.rejects(
    service.createManagedDmlFieldRule(createOnly.id, {
      targetFieldApiName: 'Requested_By__c', strategy: 'PLATFORM_USER_LOOKUP',
      applyOnCreate: false, applyOnUpdate: true, lookupObjectApiName: 'Contact',
      lookupMatchFieldApiName: 'Platform_User_Id__c', enabled: true, remark: null,
    }, 'admin'),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_INPUT_INVALID',
  );
  const updateOnly = await service.createDmlPolicy({
    objectApiName: 'Account', allowCreate: false, allowUpdate: true, enabled: true, remark: null,
  }, 'admin');
  await assert.rejects(
    service.createManagedDmlFieldRule(updateOnly.id, {
      targetFieldApiName: 'Requested_By__c', strategy: 'PLATFORM_USER_LOOKUP',
      applyOnCreate: true, applyOnUpdate: false, lookupObjectApiName: 'Contact',
      lookupMatchFieldApiName: 'Platform_User_Id__c', enabled: true, remark: null,
    }, 'admin'),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_INPUT_INVALID',
  );
  const marker = await service.createManagedDmlFieldRule(createOnly.id, {
    targetFieldApiName: 'Created_By_AI__c', strategy: 'AI_CREATED_MARKER',
    applyOnCreate: true, applyOnUpdate: false, lookupObjectApiName: null,
    lookupMatchFieldApiName: null, enabled: true, remark: null,
  }, 'admin');
  assert.equal(marker.strategy, 'AI_CREATED_MARKER');
  assert.equal(marker.applyOnCreate, true);
  assert.equal(marker.applyOnUpdate, false);
});

test('batch create commits every accepted route with per-row credentials and audits, returning no plaintext token', async () => {
  const store = new InMemoryControlPlaneStore();
  const service = new ControlPlaneAdminService(store, () => ({ allowed: true }), testCredentialCipher());
  const result = await service.batchCreateIdentityRoutes([
    routeLike('batch-a', 'a@example.invalid'),
    routeLike('batch-b', 'b@example.invalid'),
    routeLike('batch-c', 'shared@example.invalid'),
    routeLike('batch-d', 'shared@example.invalid'),
  ], 'batch-admin');
  assert.equal(result.committed, true);
  assert.equal(result.createdCount, 4);
  assert.equal(result.rows.length, 4);
  assert.ok(result.rows.every((row) => row.ok === true && row.route !== undefined && row.credential !== undefined));
  assert.equal(JSON.stringify(result).includes('sfoa_ub1_'), false);
  const page = await store.repositories.identityRoutes.list({ limit: 20, offset: 0 });
  assert.deepEqual(page.items.map((route) => route.platformUserId).sort(), ['batch-a', 'batch-b', 'batch-c', 'batch-d']);
  for (const row of result.rows) {
    const credential = row.credential as NonNullable<typeof row.credential>;
    const route = row.route as NonNullable<typeof row.route>;
    assert.equal((await store.repositories.identityCredentials.getById(credential.id))?.identityRouteId, route.id);
    assert.equal(credential.tokenLast4.length, 4);
  }
  const audits = await store.repositories.audits.search({ limit: 40, offset: 0 });
  assert.equal(audits.items.filter((audit) => audit.operation === 'CREATE_IDENTITY_ROUTE').length, 4);
  assert.equal(audits.items.every((audit) => audit.actorAdmin === 'batch-admin'), true);
});

test('batch create with an in-batch duplicate or an existing route reports committed:false and writes nothing', async () => {
  const store = new InMemoryControlPlaneStore();
  const service = new ControlPlaneAdminService(store, () => ({ allowed: true }), testCredentialCipher());
  const duplicated = await service.batchCreateIdentityRoutes([
    routeLike('same-user', 'dup@example.invalid'),
    routeLike('other-user', 'other@example.invalid'),
    routeLike('same-user', 'dup2@example.invalid'),
  ], 'batch-admin');
  assert.equal(duplicated.committed, false);
  assert.equal(duplicated.createdCount, 0);
  assert.equal(duplicated.rows.length, 1);
  assert.equal(duplicated.rows[0]?.platformUserId, 'same-user');
  assert.equal(duplicated.rows[0]?.ok, false);
  assert.equal(duplicated.rows[0]?.error?.code, 'MCP_CONTROL_PLANE_CONFLICT');
  assert.equal(await store.repositories.identityRoutes.getByPlatformUserId('same-user'), undefined);
  assert.equal(await store.repositories.identityRoutes.getByPlatformUserId('other-user'), undefined);

  await service.createIdentityRoute(routeLike('existing-user', 'existing@example.invalid'), 'admin');
  const existing = await service.batchCreateIdentityRoutes([
    routeLike('fresh-user', 'fresh@example.invalid'),
    routeLike('existing-user', 'existing2@example.invalid'),
  ], 'batch-admin');
  assert.equal(existing.committed, false);
  assert.equal(existing.createdCount, 0);
  assert.equal(existing.rows.length, 1);
  assert.equal(existing.rows[0]?.platformUserId, 'existing-user');
  assert.equal(existing.rows[0]?.error?.code, 'MCP_CONTROL_PLANE_CONFLICT');
  assert.equal(await store.repositories.identityRoutes.getByPlatformUserId('fresh-user'), undefined);
});

test('batch create rejects an enabled row colliding with the enabled Diagnostic username without writing', async () => {
  const store = new InMemoryControlPlaneStore();
  const service = new ControlPlaneAdminService(store, () => ({ allowed: true }), testCredentialCipher());
  await service.updateDiagnostic({
    salesforceUsername: 'diag@example.invalid', enabled: true,
    testMetadataType: 'ApexClass', testMetadataFullName: 'SafeClass',
  }, 'admin');
  const result = await service.batchCreateIdentityRoutes([
    routeLike('ok-user', 'ok@example.invalid'),
    { ...routeLike('diag-user', 'DIAG@example.invalid') },
  ], 'batch-admin');
  assert.equal(result.committed, false);
  assert.equal(result.createdCount, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.platformUserId, 'diag-user');
  assert.equal(result.rows[0]?.error?.code, 'MCP_CONTROL_PLANE_CONFLICT');
  assert.equal(await store.repositories.identityRoutes.getByPlatformUserId('ok-user'), undefined);
});

function routeLike(platformUserId: string, salesforceUsername: string) {
  return Object.freeze({ platformUserId, userName: platformUserId, salesforceUsername, enabled: true, remark: null });
}

function testCredentialCipher(): IdentityCredentialCipher {
  return new IdentityCredentialCipher(Buffer.alloc(32, 7));
}


test('fallback rules support opt-in update while preserving strict rules, validation, and optimistic locking', async () => {
  const store = new InMemoryControlPlaneStore();
  const service = new ControlPlaneAdminService(store, () => ({ allowed: true }), testCredentialCipher());
  const policy = await service.createDmlPolicy({ objectApiName: 'Order__c', allowCreate: true, allowUpdate: false, enabled: true, remark: null }, 'admin');
  const input = { targetFieldApiName: 'Order_Owner__c', strategy: 'PLATFORM_USER_LOOKUP' as const, applyOnCreate: true,
    applyOnUpdate: false, lookupObjectApiName: 'Contact', lookupMatchFieldApiName: 'Platform_User_Id__c', enabled: true, remark: null };
  const owner = await service.createManagedDmlFieldRule(policy.id, input, 'admin');
  const strict = await service.createManagedDmlFieldRule(policy.id, { ...input, targetFieldApiName: 'Requested_By__c' }, 'admin');
  const fallback = await service.updateManagedDmlFieldRule(policy.id, owner.id,
    { ...input, strategy: 'PLATFORM_USER_LOOKUP_FALLBACK', rowVersion: owner.rowVersion }, 'admin');
  assert.equal(fallback.strategy, 'PLATFORM_USER_LOOKUP_FALLBACK');
  assert.equal((await store.repositories.managedDmlFieldRules.getById(strict.id))?.strategy, 'PLATFORM_USER_LOOKUP');
  await assert.rejects(service.updateManagedDmlFieldRule(policy.id, owner.id,
    { ...input, strategy: 'PLATFORM_USER_LOOKUP_FALLBACK', rowVersion: owner.rowVersion }, 'admin'),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_CONCURRENT_MODIFICATION');
  for (const invalid of [{ lookupObjectApiName: null }, { lookupMatchFieldApiName: null }, { lookupMatchFieldApiName: 'Bad.Field' }, { applyOnUpdate: true }]) {
    await assert.rejects(service.createManagedDmlFieldRule(policy.id,
      { ...input, targetFieldApiName: 'Other__c', strategy: 'PLATFORM_USER_LOOKUP_FALLBACK', ...invalid }, 'admin'),
      (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_INPUT_INVALID');
  }
  const audits = await store.repositories.audits.search({ limit: 10, offset: 0 });
  assert.ok(JSON.stringify(audits.items).includes('PLATFORM_USER_LOOKUP_FALLBACK'));
});

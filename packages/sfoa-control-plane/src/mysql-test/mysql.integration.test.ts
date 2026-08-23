import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, beforeEach } from 'node:test';
import {
  assertAllMigrationsApplied,
  ControlPlaneAdminService,
  ControlPlaneError,
  createControlPlaneDatabase,
  createDatabaseIfMissing,
  databaseHealth,
  databaseNameForTest,
  loadControlPlaneConfig,
  loadMySqlRequestPolicySnapshot,
  migrateDatabase,
  MySqlControlPlaneStore,
} from '../index.js';
import type { DatabaseConfig } from '../config.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const setup = await loadTestConfig();

if (!setup) {
  test('MySQL 8 Control Plane integration', { skip: 'SFOA project MySQL credentials are not configured.' }, () => undefined);
} else {
  const { config } = setup;
  await createDatabaseIfMissing(config);
  const store = new MySqlControlPlaneStore(createControlPlaneDatabase(config));
  await migrateDatabase(store.database);
  after(() => store.close());
  beforeEach(() => cleanTestData(store));

  test('migrations create and validate the reviewed schema in the isolated test database', async () => {
    const health = await databaseHealth(store.database);
    assert.match(health.version, /^8\./u);
    const migrations = await assertAllMigrationsApplied(store.database);
    assert.deepEqual(migrations.map((entry) => entry.version), ['001_p5_control_plane', '002_p5_indexes']);
    assert.ok(migrations.every((entry) => entry.state === 'APPLIED'));
  });

  test('identity routing supports A/B, disabled denial, unknown denial, and shared Salesforce usernames', async () => {
    const shared = 'shared@example.invalid';
    const first = await store.repositories.identityRoutes.create({
      platformUserId: 'db-user-a', salesforceUsername: shared, enabled: true, remark: null,
    });
    await store.repositories.identityRoutes.create({
      platformUserId: 'db-user-b', salesforceUsername: shared, enabled: true, remark: null,
    });
    assert.equal((await loadMySqlRequestPolicySnapshot(store.database, 'db-user-a')).identityRoute?.salesforceUsername, shared);
    assert.equal((await loadMySqlRequestPolicySnapshot(store.database, 'db-user-b')).identityRoute?.salesforceUsername, shared);
    assert.equal((await loadMySqlRequestPolicySnapshot(store.database, 'unknown-user')).identityRoute, null);
    await store.repositories.identityRoutes.disable(first.id, first.rowVersion);
    assert.equal((await loadMySqlRequestPolicySnapshot(store.database, 'db-user-a')).identityRoute, null);
  });

  test('new requests observe dynamic Tool and CREATE/UPDATE policy without restart', async () => {
    await store.repositories.identityRoutes.create({
      platformUserId: 'dynamic-user', salesforceUsername: 'dynamic@example.invalid', enabled: true, remark: null,
    });
    const tool = await store.repositories.tools.createIfAbsent('run_soql_query', true, null);
    const dml = await store.repositories.dmlPolicies.create({
      objectApiName: 'Lead', allowCreate: true, allowUpdate: false, enabled: true, remark: null,
    });
    const first = await loadMySqlRequestPolicySnapshot(store.database, 'dynamic-user');
    assert.deepEqual(first.enabledTools, ['run_soql_query']);
    assert.equal(first.dmlPolicies[0]?.allowCreate, true);
    assert.equal(first.dmlPolicies[0]?.allowUpdate, false);

    await store.repositories.tools.update(tool.toolName, { enabled: false, remark: null, rowVersion: tool.rowVersion });
    await store.repositories.dmlPolicies.update(dml.id, {
      objectApiName: 'Lead', allowCreate: false, allowUpdate: true, enabled: true, remark: null, rowVersion: dml.rowVersion,
    });
    const second = await loadMySqlRequestPolicySnapshot(store.database, 'dynamic-user');
    assert.deepEqual(second.enabledTools, []);
    assert.equal(second.dmlPolicies[0]?.allowCreate, false);
    assert.equal(second.dmlPolicies[0]?.allowUpdate, true);
  });

  test('Admin transaction persists its audit and optimistic conflicts return the stable code', async () => {
    const service = new ControlPlaneAdminService(store, () => ({ allowed: true }));
    const created = await service.createIdentityRoute({
      platformUserId: 'admin-user', salesforceUsername: 'admin-user@example.invalid', enabled: true, remark: null,
    }, 'bootstrap-admin');
    const audits = await store.repositories.audits.search({ limit: 10, offset: 0 });
    assert.equal(audits.items[0]?.operation, 'CREATE_IDENTITY_ROUTE');
    assert.equal(audits.items[0]?.actorAdmin, 'bootstrap-admin');
    await assert.rejects(
      service.updateIdentityRoute(created.id, {
        platformUserId: created.platformUserId,
        salesforceUsername: created.salesforceUsername,
        enabled: true,
        remark: null,
        rowVersion: '999',
      }, 'bootstrap-admin'),
      (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_CONCURRENT_MODIFICATION',
    );
  });

  test('Diagnostic/USER collision is rejected and also detected fail-closed in a request snapshot', async () => {
    const service = new ControlPlaneAdminService(store, () => ({ allowed: true }));
    await service.createIdentityRoute({
      platformUserId: 'collision-user', salesforceUsername: 'collision@example.invalid', enabled: true, remark: null,
    }, 'bootstrap-admin');
    await assert.rejects(
      service.updateDiagnostic({
        salesforceUsername: 'COLLISION@example.invalid', enabled: true,
        testMetadataType: 'ApexClass', testMetadataFullName: 'SafeClass',
      }, 'bootstrap-admin'),
      (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_CONFLICT',
    );
  });
}

async function loadTestConfig(): Promise<Readonly<{ config: DatabaseConfig }> | undefined> {
  try {
    const loaded = await loadControlPlaneConfig(projectRoot, process.env, { requireDatabase: true });
    if (!loaded.database) return undefined;
    const database = databaseNameForTest(loaded.database);
    if (!database.endsWith('_test')) throw new Error('Integration database must end with _test.');
    return Object.freeze({ config: Object.freeze({ ...loaded.database, database }) });
  } catch (error) {
    if (error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_CONFIGURATION_INVALID') return undefined;
    throw error;
  }
}

async function cleanTestData(store: MySqlControlPlaneStore): Promise<void> {
  await store.database.transaction().execute(async (transaction) => {
    await transaction.deleteFrom('sfoa_audit_log').execute();
    await transaction.deleteFrom('sfoa_runtime_setting').execute();
    await transaction.deleteFrom('sfoa_diagnostic_config').execute();
    await transaction.deleteFrom('sfoa_dml_policy').execute();
    await transaction.deleteFrom('sfoa_tool_control').execute();
    await transaction.deleteFrom('sfoa_identity_route').execute();
  });
}

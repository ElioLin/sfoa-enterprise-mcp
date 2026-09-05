import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, beforeEach } from 'node:test';
import { sql } from 'kysely';
import { createPool } from 'mysql2/promise';
import { RequestAuditContextController, type AuditSnapshot } from '@sfoa/identity-runtime';
import {
  auditDatabaseConfig,
  assertAllMigrationsApplied,
  containsObviousAuditSecret,
  ControlPlaneAdminService,
  ControlPlaneError,
  createControlPlaneDatabase,
  createDatabaseIfMissing,
  databaseHealth,
  databaseNameForTest,
  defaultMigrationsDirectory,
  IdentityCredentialCipher,
  loadControlPlaneConfig,
  loadMySqlRequestPolicySnapshot,
  migrationChecksumSha256,
  migrateDatabase,
  MySqlAuditBatchSink,
  MySqlAuditRepository,
  MySqlControlPlaneStore,
  splitSqlStatements,
} from '../index.js';
import type { DatabaseConfig } from '../config.js';
import type { ControlPlaneDatabaseClient } from '../database.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const setup = await loadTestConfig();

if (!setup) {
  test('MySQL 8 Control Plane integration', { skip: 'SFOA project MySQL credentials are not configured.' }, () => undefined);
} else {
  const configured = setup.config;
  const config = Object.freeze({
    ...configured,
    database: `sfoa_p7_suite_${process.pid}_${Date.now()}_0_test`,
  });
  await dropIsolatedDatabase(config);
  await createDatabaseIfMissing(config);
  const store = new MySqlControlPlaneStore(createControlPlaneDatabase(config));
  after(async () => {
    await store.close();
    await dropIsolatedDatabase(config);
  });
  await migrateDatabase(store.database);
  beforeEach(() => cleanTestData(store));

  test('migrations create and validate the reviewed schema in the isolated test database', async () => {
    const health = await databaseHealth(store.database);
    assert.match(health.version, /^8\./u);
    // 重复/并发启动必须串行复用同一 advisory lock，并在各自连接上正确释放。
    const repeated = await Promise.all([migrateDatabase(store.database), migrateDatabase(store.database)]);
    assert.ok(repeated.every((entries) => entries.every((entry) => entry.state === 'APPLIED')));
    const migrations = await assertAllMigrationsApplied(store.database);
    assert.deepEqual(migrations.map((entry) => entry.version), [
      '001_p5_control_plane',
      '002_p5_indexes',
      '003_p6_identity_credential',
      '004_p6_dml_managed_field_rule',
      '005_p7_end_to_end_audit',
      '006_p7_salesforce_api_observability',
      '007_p7_soql_dml_audit_evidence',
      '008_p7_payload_evidence_runtime',
      '009_identity_route_user_name',
      '010_managed_platform_user_lookup_fallback',
      '011_managed_fallback_create_only',
    ]);
    assert.ok(migrations.every((entry) => entry.state === 'APPLIED'));
  });

  test('an empty database initializes through 011 and a populated P6 schema upgrades without losing legacy audit rows', { timeout: 120_000 }, async () => {
    await withIsolatedDatabase(config, 'empty', async (database) => {
      const migrations = await migrateDatabase(database);
      assert.deepEqual(migrations.map((entry) => entry.version), [
        '001_p5_control_plane',
        '002_p5_indexes',
        '003_p6_identity_credential',
        '004_p6_dml_managed_field_rule',
        '005_p7_end_to_end_audit',
        '006_p7_salesforce_api_observability',
        '007_p7_soql_dml_audit_evidence',
        '008_p7_payload_evidence_runtime',
        '009_identity_route_user_name',
        '010_managed_platform_user_lookup_fallback',
      '011_managed_fallback_create_only',
      ]);
      assert.ok(migrations.every((entry) => entry.state === 'APPLIED'));
    });

    await withIsolatedDatabase(config, 'upgrade', async (database) => {
      await installP6Schema(database);
      await sql.raw(`INSERT INTO sfoa_audit_log (
        occurred_at, correlation_id, channel, tool_name, operation, result, outcome, request_summary_json
      ) VALUES (
        '2026-08-28 12:00:00.000', 'legacy-p6-audit', 'MCP', 'run_soql_query', 'QUERY', 'PASS', 'SUCCESS',
        JSON_OBJECT('rawToken', 'Bearer fake-legacy-p6-token', 'safeFact', 'preserved')
      )`).execute(database);
      const legacyId = await database.selectFrom('sfoa_audit_log').select(['id'])
        .where('correlation_id', '=', 'legacy-p6-audit').executeTakeFirstOrThrow();

      const migrations = await migrateDatabase(database);
      assert.equal(migrations.at(-1)?.version, '011_managed_fallback_create_only');
      const repository = new MySqlAuditRepository(database);
      const legacy = await repository.getById(String(legacyId.id));
      assert.ok(legacy);
      assert.equal(legacy.correlationId, 'legacy-p6-audit');
      assert.equal(legacy.auditKind, 'RUNTIME_EVENT');
      assert.equal(legacy.auditIntegrityStatus, 'PARTIAL');
      assert.match(legacy.publicAuditId, /^[0-9a-f-]{36}$/u);
      assert.deepEqual(legacy.requestSummary, { safeFact: 'preserved' });
      const childTables = await sql<{ count: string }>`
        SELECT COUNT(*) AS count
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN ('sfoa_audit_event', 'sfoa_salesforce_api_call', 'sfoa_audit_payload_evidence')
      `.execute(database);
      assert.equal(Number(childTables.rows[0]?.count), 3);
    });
  });

  test('a fully applied 005 schema with a missing ledger row is recovered only after schema validation', { timeout: 120_000 }, async () => {
    await withIsolatedDatabase(config, 'recover', async (database) => {
      await migrateDatabase(database);
      await database.deleteFrom('sfoa_schema_migration')
        .where('version', '=', '005_p7_end_to_end_audit')
        .execute();

      const recovered = await migrateDatabase(database);
      assert.equal(recovered.find((entry) => entry.version === '005_p7_end_to_end_audit')?.state, 'APPLIED');
      const ledger = await database.selectFrom('sfoa_schema_migration')
        .select(['checksum_sha256'])
        .where('version', '=', '005_p7_end_to_end_audit')
        .executeTakeFirstOrThrow();
      const sqlText = await readFile(path.join(defaultMigrationsDirectory(), '005_p7_end_to_end_audit.sql'), 'utf8');
      assert.equal(ledger.checksum_sha256, migrationChecksumSha256(sqlText));
    });

    await withIsolatedDatabase(config, 'partial', async (database) => {
      await migrateDatabase(database);
      await database.deleteFrom('sfoa_schema_migration')
        .where('version', '=', '005_p7_end_to_end_audit')
        .execute();
      await sql.raw('ALTER TABLE sfoa_audit_log DROP CHECK chk_sfoa_audit_time_range').execute(database);

      await assert.rejects(migrateDatabase(database));
      const ledger = await database.selectFrom('sfoa_schema_migration')
        .select(['version'])
        .where('version', '=', '005_p7_end_to_end_audit')
        .executeTakeFirst();
      assert.equal(ledger, undefined);
    });
  });

  test('006 upgrades legacy P7-03 API rows without inventing exact HTTP facts', { timeout: 120_000 }, async () => {
    await withIsolatedDatabase(config, 'legacyapi', async (database) => {
      await installP6Schema(database);
      const p703Sql = await readFile(path.join(defaultMigrationsDirectory(), '005_p7_end_to_end_audit.sql'), 'utf8');
      for (const statement of splitSqlStatements(p703Sql)) await sql.raw(statement).execute(database);
      await database.insertInto('sfoa_schema_migration').values({
        version: '005_p7_end_to_end_audit',
        checksum_sha256: migrationChecksumSha256(p703Sql),
      }).executeTakeFirstOrThrow();
      await sql.raw(`INSERT INTO sfoa_audit_log (
        public_audit_id, audit_kind, occurred_at, started_at, completed_at, correlation_id, channel,
        tool_name, result, outcome, audit_integrity_status
      ) VALUES (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'MCP_TOOL_CALL', NOW(3), NOW(3), NOW(3),
        'legacy-api-upgrade', 'MCP', 'run_soql_query', 'PASS', 'SUCCESS', 'COMPLETE'
      )`).execute(database);
      await sql.raw(`INSERT INTO sfoa_salesforce_api_call (
        audit_id, sequence, salesforce_username, api_category, http_method, endpoint, purpose,
        started_at, completed_at, duration_ms, http_status, result
      ) SELECT id, 1, 'legacy@example.invalid', 'DATA', 'GET', '/services/data/v65.0/query',
        'LEGACY_QUERY', NOW(3), NOW(3), 1, 200, 'SUCCESS'
      FROM sfoa_audit_log WHERE public_audit_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`).execute(database);

      await migrateDatabase(database);
      const row = await database.selectFrom('sfoa_salesforce_api_call').selectAll().executeTakeFirstOrThrow();
      assert.equal(row.api_category, 'REST_API');
      assert.equal(row.visibility, 'OPERATION_ONLY');
      assert.equal(row.transport_kind, 'OTHER');
      assert.equal(row.http_method, null);
      assert.equal(row.request_url, null);
      assert.equal(row.operation_name, 'LEGACY_API_EVIDENCE');
      assert.equal(row.endpoint, '/services/data/v65.0/query');
      assert.match(row.public_api_call_id, /^[0-9a-f-]{36}$/u);
    });
  });

  test('011 preserves strict and marker rows and permits only CREATE-only fallback configuration', { timeout: 120_000 }, async () => {
    await withIsolatedDatabase(config, 'fallback', async (database) => {
      await installP6Schema(database);
      const migration010 = await readFile(path.join(defaultMigrationsDirectory(), '010_managed_platform_user_lookup_fallback.sql'), 'utf8');
      for (const statement of splitSqlStatements(migration010)) await sql.raw(statement).execute(database);
      await database.insertInto('sfoa_schema_migration').values({
        version: '010_managed_platform_user_lookup_fallback', checksum_sha256: migrationChecksumSha256(migration010),
      }).execute();
      await sql.raw("INSERT INTO sfoa_dml_policy (object_api_name, allow_create, allow_update, enabled) VALUES ('Order__c', 1, 1, 1)").execute(database);
      await sql.raw(`INSERT INTO sfoa_dml_managed_field_rule (dml_policy_id, target_field_api_name, strategy,
        apply_on_create, apply_on_update, lookup_object_api_name, lookup_match_field_api_name)
        SELECT id, 'Requested_By__c', 'PLATFORM_USER_LOOKUP', 1, 1, 'Contact', 'Platform_User_Id__c' FROM sfoa_dml_policy`).execute(database);
      await sql.raw(`INSERT INTO sfoa_dml_managed_field_rule (dml_policy_id, target_field_api_name, strategy, apply_on_create)
        SELECT id, 'Created_By_AI__c', 'AI_CREATED_MARKER', 1 FROM sfoa_dml_policy`).execute(database);
      await sql.raw(`INSERT INTO sfoa_dml_managed_field_rule (dml_policy_id, target_field_api_name, strategy,
        apply_on_create, apply_on_update, lookup_object_api_name, lookup_match_field_api_name)
        SELECT id, 'Legacy_Fallback__c', 'PLATFORM_USER_LOOKUP_FALLBACK', 1, 0, 'Contact', 'Platform_User_Id__c' FROM sfoa_dml_policy`).execute(database);
      const before = await database.selectFrom('sfoa_dml_managed_field_rule').selectAll().orderBy('id').execute();
      await migrateDatabase(database);
      const after = await database.selectFrom('sfoa_dml_managed_field_rule').selectAll().orderBy('id').execute();
      assert.deepEqual(after, before);
      const isolated = new MySqlControlPlaneStore(database);
      const policyId = String(before[0]!.dml_policy_id);
      const fallback = await isolated.repositories.managedDmlFieldRules.create({
        dmlPolicyId: policyId, targetFieldApiName: 'Order_Owner__c', strategy: 'PLATFORM_USER_LOOKUP_FALLBACK',
        applyOnCreate: true, applyOnUpdate: false, lookupObjectApiName: 'Contact', lookupMatchFieldApiName: 'Platform_User_Id__c',
        enabled: true, remark: null,
      });
      const snapshot = await loadMySqlRequestPolicySnapshot(database, 'unmapped-user');
      assert.equal(snapshot.managedDmlFieldRules.find((rule) => rule.id === fallback.id)?.strategy, 'PLATFORM_USER_LOOKUP_FALLBACK');
      const strict = await isolated.repositories.managedDmlFieldRules.getById(String(before[0]!.id));
      assert.ok(strict);
      await isolated.repositories.managedDmlFieldRules.update(strict.id, { ...strict, strategy: 'PLATFORM_USER_LOOKUP_FALLBACK', applyOnUpdate: false });
      assert.equal((await isolated.repositories.managedDmlFieldRules.getById(strict.id))?.strategy, 'PLATFORM_USER_LOOKUP_FALLBACK');
      for (const invalid of [{ lookupObjectApiName: null }, { lookupMatchFieldApiName: null }, { applyOnCreate: false, applyOnUpdate: false }, { applyOnUpdate: true }, { applyOnCreate: false, applyOnUpdate: true }]) {
        await assert.rejects(isolated.repositories.managedDmlFieldRules.create({ ...fallback, targetFieldApiName: 'Invalid__c', ...invalid }));
      }
      await assert.rejects(sql.raw("UPDATE sfoa_dml_managed_field_rule SET apply_on_update = 1 WHERE strategy = 'AI_CREATED_MARKER'").execute(database));
    });
  });

  test('identity routing supports A/B, disabled denial, unknown denial, and shared Salesforce usernames', async () => {
    const shared = 'shared@example.invalid';
    const first = await store.repositories.identityRoutes.create({
      platformUserId: 'db-user-a', userName: 'db-user-a', salesforceUsername: shared, enabled: true, remark: null,
    });
    await store.repositories.identityRoutes.create({
      platformUserId: 'db-user-b', userName: 'db-user-b', salesforceUsername: shared, enabled: true, remark: null,
    });
    assert.equal((await loadMySqlRequestPolicySnapshot(store.database, 'db-user-a')).identityRoute?.salesforceUsername, shared);
    assert.equal((await loadMySqlRequestPolicySnapshot(store.database, 'db-user-b')).identityRoute?.salesforceUsername, shared);
    assert.equal((await loadMySqlRequestPolicySnapshot(store.database, 'unknown-user')).identityRoute, null);
    await store.repositories.identityRoutes.disable(first.id, first.rowVersion);
    assert.equal((await loadMySqlRequestPolicySnapshot(store.database, 'db-user-a')).identityRoute, null);
  });

  test('new requests observe dynamic Tool and CREATE/UPDATE policy without restart', async () => {
    await store.repositories.identityRoutes.create({
      platformUserId: 'dynamic-user', userName: 'dynamic-user', salesforceUsername: 'dynamic@example.invalid', enabled: true, remark: null,
    });
    const tool = await store.repositories.tools.createIfAbsent('run_soql_query', true, null);
    const dml = await store.repositories.dmlPolicies.create({
      objectApiName: 'Lead', allowCreate: true, allowUpdate: false, enabled: true, remark: null,
    });
    const managed = await store.repositories.managedDmlFieldRules.create({
      dmlPolicyId: dml.id,
      targetFieldApiName: 'Requested_By__c',
      strategy: 'PLATFORM_USER_LOOKUP',
      applyOnCreate: true,
      applyOnUpdate: false,
      lookupObjectApiName: 'Contact',
      lookupMatchFieldApiName: 'Platform_User_Id__c',
      enabled: true,
      remark: null,
    });
    const first = await loadMySqlRequestPolicySnapshot(store.database, 'dynamic-user');
    assert.deepEqual(first.enabledTools, ['run_soql_query']);
    assert.equal(first.dmlPolicies[0]?.allowCreate, true);
    assert.equal(first.dmlPolicies[0]?.allowUpdate, false);
    assert.deepEqual(first.managedDmlFieldRules.map((rule) => rule.id), [managed.id]);
    assert.equal(Object.isFrozen(first.managedDmlFieldRules), true);
    assert.equal(Object.isFrozen(first.managedDmlFieldRules[0]), true);

    await store.repositories.tools.update(tool.toolName, { enabled: false, remark: null, rowVersion: tool.rowVersion });
    await store.repositories.managedDmlFieldRules.disable(managed.id, managed.rowVersion);
    await store.repositories.dmlPolicies.update(dml.id, {
      objectApiName: 'Lead', allowCreate: false, allowUpdate: true, enabled: true, remark: null, rowVersion: dml.rowVersion,
    });
    const second = await loadMySqlRequestPolicySnapshot(store.database, 'dynamic-user');
    assert.deepEqual(second.enabledTools, []);
    assert.equal(second.dmlPolicies[0]?.allowCreate, false);
    assert.equal(second.dmlPolicies[0]?.allowUpdate, true);
    assert.deepEqual(second.managedDmlFieldRules, []);
  });

  test('Admin transaction persists its audit and optimistic conflicts return the stable code', async () => {
    const service = new ControlPlaneAdminService(store, () => ({ allowed: true }), testCredentialCipher());
    const created = await service.createIdentityRoute({
      platformUserId: 'admin-user', userName: 'admin-user', salesforceUsername: 'admin-user@example.invalid', enabled: true, remark: null,
    }, 'bootstrap-admin');
    const audits = await store.repositories.audits.search({ limit: 10, offset: 0 });
    assert.equal(audits.items[0]?.operation, 'CREATE_IDENTITY_ROUTE');
    assert.equal(audits.items[0]?.actorAdmin, 'bootstrap-admin');
    await assert.rejects(
      service.updateIdentityRoute(created.route.id, {
        platformUserId: created.route.platformUserId,
        userName: created.route.userName,
        salesforceUsername: created.route.salesforceUsername,
        enabled: true,
        remark: null,
        rowVersion: '999',
      }, 'bootstrap-admin'),
      (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_CONCURRENT_MODIFICATION',
    );
  });

  test('Diagnostic/USER collision is rejected and also detected fail-closed in a request snapshot', async () => {
    const service = new ControlPlaneAdminService(store, () => ({ allowed: true }), testCredentialCipher());
    await service.createIdentityRoute({
      platformUserId: 'collision-user', userName: 'collision-user', salesforceUsername: 'collision@example.invalid', enabled: true, remark: null,
    }, 'bootstrap-admin');
    await assert.rejects(
      service.updateDiagnostic({
        salesforceUsername: 'COLLISION@example.invalid', enabled: true,
        testMetadataType: 'ApexClass', testMetadataFullName: 'SafeClass',
      }, 'bootstrap-admin'),
      (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_CONFLICT',
    );
  });

  test('dedicated Audit pool batch-persists 50/100/200 isolated Snapshots with zero orphan or cross binding', { timeout: 120_000 }, async () => {
    const auditConfig = auditDatabaseConfig(config);
    assert.equal(auditConfig.connectionLimit, 2);
    const auditDatabase = createControlPlaneDatabase(auditConfig);
    const sink = new MySqlAuditBatchSink(auditDatabase);
    try {
      for (const [gateIndex, concurrency] of [50, 100, 200].entries()) {
        const snapshots = Array.from({ length: concurrency }, (_, index) =>
          mysqlSnapshot(1_000 + gateIndex * 1_000 + index, concurrency, index));
        await sink.persist(snapshots.map((snapshot) => Object.freeze({ kind: 'SNAPSHOT' as const, snapshot })));
        const publicIds = snapshots.map((snapshot) => snapshot.auditCall.publicAuditId);
        const calls = await store.database.selectFrom('sfoa_audit_log')
          .select(['id', 'public_audit_id', 'platform_user_id', 'salesforce_username', 'tool_name'])
          .where('public_audit_id', 'in', publicIds)
          .execute();
        assert.equal(calls.length, concurrency);
        assert.equal(new Set(calls.map((call) => call.public_audit_id)).size, concurrency);
        const events = await store.database.selectFrom('sfoa_audit_event')
          .innerJoin('sfoa_audit_log', 'sfoa_audit_log.id', 'sfoa_audit_event.audit_id')
          .select([
            'sfoa_audit_event.audit_id', 'sfoa_audit_event.sequence', 'sfoa_audit_event.event_name',
            'sfoa_audit_log.public_audit_id',
          ])
          .where('sfoa_audit_log.public_audit_id', 'in', publicIds)
          .execute();
        const apiCalls = await store.database.selectFrom('sfoa_salesforce_api_call')
          .innerJoin('sfoa_audit_log', 'sfoa_audit_log.id', 'sfoa_salesforce_api_call.audit_id')
          .select([
            'sfoa_salesforce_api_call.audit_id', 'sfoa_salesforce_api_call.sequence',
            'sfoa_salesforce_api_call.salesforce_username', 'sfoa_salesforce_api_call.request_url',
            'sfoa_salesforce_api_call.endpoint', 'sfoa_salesforce_api_call.endpoint_path',
            'sfoa_salesforce_api_call.salesforce_error_message_safe',
            'sfoa_salesforce_api_call.query_type', 'sfoa_salesforce_api_call.soql_statement_safe',
            'sfoa_salesforce_api_call.total_size', 'sfoa_salesforce_api_call.returned_records',
            'sfoa_salesforce_api_call.done', 'sfoa_salesforce_api_call.has_next_records',
            'sfoa_salesforce_api_call.object_api_name',
            'sfoa_audit_log.public_audit_id', 'sfoa_audit_log.platform_user_id', 'sfoa_audit_log.tool_name',
          ])
          .where('sfoa_audit_log.public_audit_id', 'in', publicIds)
          .execute();
        const payloads = await store.database.selectFrom('sfoa_audit_payload_evidence')
          .innerJoin('sfoa_audit_log', 'sfoa_audit_log.id', 'sfoa_audit_payload_evidence.audit_id')
          .leftJoin('sfoa_salesforce_api_call', 'sfoa_salesforce_api_call.id', 'sfoa_audit_payload_evidence.salesforce_api_call_id')
          .leftJoin('sfoa_audit_event', 'sfoa_audit_event.id', 'sfoa_audit_payload_evidence.audit_event_id')
          .select([
            'sfoa_audit_log.public_audit_id', 'sfoa_audit_payload_evidence.payload_type',
            'sfoa_audit_payload_evidence.safe_payload', 'sfoa_audit_payload_evidence.original_size_bytes',
            'sfoa_audit_payload_evidence.stored_size_bytes', 'sfoa_audit_payload_evidence.truncated',
            'sfoa_audit_payload_evidence.content_sha256', 'sfoa_salesforce_api_call.public_api_call_id',
            'sfoa_audit_event.sequence',
          ])
          .where('sfoa_audit_log.public_audit_id', 'in', publicIds)
          .execute();
        assert.equal(events.length, concurrency * 2);
        assert.equal(apiCalls.length, concurrency);
        assert.equal(payloads.length, concurrency * 3);
        for (const snapshot of snapshots) {
          const marker = snapshot.auditCall.platformUserId?.replace('platform_', '');
          assert.ok(marker);
          const owned = events.filter((event) => event.public_audit_id === snapshot.auditCall.publicAuditId);
          assert.equal(owned.length, 2);
          assert.deepEqual(owned.map((event) => event.sequence).sort((a, b) => a - b), [1, 3]);
          assert.equal(owned.every((event) => event.event_name.includes(marker)), true);
          const ownedApi = apiCalls.filter((call) => call.public_audit_id === snapshot.auditCall.publicAuditId);
          assert.equal(ownedApi.length, 1);
          assert.equal(ownedApi[0]?.salesforce_username, `sf_${marker}@example.invalid`);
          assert.equal(ownedApi[0]?.request_url?.includes(marker), true);
          assert.equal(ownedApi[0]?.platform_user_id, `platform_${marker}`);
          assert.equal(ownedApi[0]?.tool_name, snapshot.auditCall.toolName);
          assert.equal(ownedApi[0]?.query_type, 'DATA_SOQL');
          assert.equal(ownedApi[0]?.soql_statement_safe?.includes(marker), true);
          assert.equal(ownedApi[0]?.total_size, snapshot.auditCall.platformUserId?.endsWith('_1_ONLY') ? null : 1);
          assert.equal(ownedApi[0]?.returned_records, snapshot.auditCall.platformUserId?.endsWith('_1_ONLY') ? null : 1);
          assert.equal(ownedApi[0]?.done, snapshot.auditCall.platformUserId?.endsWith('_1_ONLY') ? null : 1);
          assert.equal(ownedApi[0]?.has_next_records, snapshot.auditCall.platformUserId?.endsWith('_1_ONLY') ? null : 0);
          assert.equal(ownedApi[0]?.object_api_name, 'Account');
          const ownedPayloads = payloads.filter((payload) => payload.public_audit_id === snapshot.auditCall.publicAuditId);
          assert.equal(ownedPayloads.length, 3);
          const serializedPayloads = JSON.stringify(ownedPayloads);
          assert.match(serializedPayloads, new RegExp(`${marker}_REQUEST_ONLY`, 'u'));
          assert.match(serializedPayloads, new RegExp(`${marker}_RESPONSE_ONLY`, 'u'));
          assert.match(serializedPayloads, new RegExp(`SF_API_${marker}`, 'u'));
          assert.equal(snapshots.filter((candidate) => candidate !== snapshot).some((candidate) => {
            const foreignMarker = candidate.auditCall.platformUserId?.replace('platform_', '');
            return foreignMarker ? serializedPayloads.includes(foreignMarker) : false;
          }), false);
          const failedApi = snapshot.auditCall.platformUserId?.endsWith('_1_ONLY') === true;
          const sfPayload = ownedPayloads.find((payload) =>
            payload.payload_type === (failedApi ? 'ERROR_RESPONSE' : 'SALESFORCE_RESPONSE'));
          assert.equal(sfPayload?.public_api_call_id, snapshot.salesforceApiCalls[0]?.publicApiCallId);
          assert.equal(ownedPayloads.find((payload) => payload.payload_type === 'MCP_REQUEST')?.sequence, 1);
          assert.equal(ownedPayloads.find((payload) => payload.payload_type === 'MCP_RESPONSE')?.sequence, 3);
          assert.equal(ownedPayloads.every((payload) =>
            Number(payload.stored_size_bytes) === Buffer.byteLength(payload.safe_payload ?? '', 'utf8')), true);
          assert.equal(ownedPayloads.every((payload) => /^[0-9a-f]{64}$/u.test(payload.content_sha256 ?? '')), true);
          if (snapshot.auditCall.platformUserId?.endsWith('_0_ONLY')) {
            const expectedApi = snapshot.salesforceApiCalls[0];
            assert.equal((expectedApi?.endpointPath?.length ?? 0) > 1_024, true);
            assert.equal(ownedApi[0]?.request_url, expectedApi?.requestUrl);
            assert.equal(ownedApi[0]?.endpoint_path, expectedApi?.endpointPath);
            assert.equal(ownedApi[0]?.request_url?.endsWith(`long_url_end_marker=${marker}`), true);
            assert.equal(ownedApi[0]?.endpoint, expectedApi?.endpointPath?.slice(0, 1_024));
            assert.equal(ownedApi[0]?.endpoint?.length, 1_024);
          }
          if (snapshot.auditCall.platformUserId?.endsWith('_1_ONLY')) {
            assert.equal(ownedApi[0]?.salesforce_error_message_safe?.length, 1_024);
            assert.equal(ownedApi[0]?.salesforce_error_message_safe, 'E'.repeat(1_024));
          }
        }
      }
      const orphan = await sql<{ count: string }>`
        SELECT COUNT(*) AS count
        FROM sfoa_audit_event event
        LEFT JOIN sfoa_audit_log call_record ON call_record.id = event.audit_id
        WHERE call_record.id IS NULL
      `.execute(store.database);
      assert.equal(Number(orphan.rows[0]?.count), 0);
      const orphanApi = await sql<{ count: string }>`
        SELECT COUNT(*) AS count
        FROM sfoa_salesforce_api_call api_call
        LEFT JOIN sfoa_audit_log call_record ON call_record.id = api_call.audit_id
        WHERE call_record.id IS NULL
      `.execute(store.database);
      assert.equal(Number(orphanApi.rows[0]?.count), 0);
      const orphanPayload = await sql<{ count: string }>`
        SELECT COUNT(*) AS count
        FROM sfoa_audit_payload_evidence payload
        LEFT JOIN sfoa_audit_log call_record ON call_record.id = payload.audit_id
        WHERE call_record.id IS NULL
      `.execute(store.database);
      assert.equal(Number(orphanPayload.rows[0]?.count), 0);
    } finally {
      await auditDatabase.destroy();
    }
  });

  test('P7 Audit Call, Event, Salesforce API, and bounded Payload preserve per-audit isolation', async () => {
    const startedAt = new Date('2026-08-29T01:02:03.000Z');
    const completedAt = new Date('2026-08-29T01:02:03.025Z');
    const fakeBearer = 'Bearer fake-p7-integration-secret';
    const compatibleFlatEvent = await store.repositories.audits.append({
      occurredAt: completedAt,
      correlationId: 'legacy-flat-runtime-event',
      channel: 'MCP',
      toolName: 'run_soql_query',
      result: 'ERROR',
      errorCode: 'MCP_REQUEST_TIMEOUT',
    });
    assert.equal(compatibleFlatEvent.auditKind, 'RUNTIME_EVENT');
    const rawBuntuToken = 'fake-buntu-raw-token-opt-in';
    const buntuValidation = await store.repositories.audits.append({
      occurredAt: completedAt,
      correlationId: 'buntu-raw-token-opt-in',
      channel: 'MCP',
      clientId: 'xiaoben-buntu-token',
      identitySource: 'BUNTU_TOKEN',
      operation: 'BUNTU_TOKEN_VALIDATE',
      result: 'PASS',
      outcome: 'SUCCESS',
      requestSummary: { provider: 'BUNTU', tokenLast4: 't-in' },
      buntuRawTokenEvidence: rawBuntuToken,
    });
    assert.equal((buntuValidation.requestSummary as Record<string, unknown>).rawToken, rawBuntuToken);
    await assert.rejects(
      store.repositories.audits.append({
        occurredAt: completedAt,
        correlationId: 'invalid-raw-token-scope',
        channel: 'MCP',
        identitySource: 'BUNTU_TOKEN',
        operation: 'QUERY',
        result: 'PASS',
        buntuRawTokenEvidence: rawBuntuToken,
      }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_INPUT_INVALID',
    );
    const publicAuditId = '00000000-0000-4000-8000-000000000701';
    const callA = await store.repositories.auditTraces.createCall({
      occurredAt: completedAt,
      publicAuditId,
      startedAt,
      completedAt,
      correlationId: 'p7-call-a',
      platformUserId: 'platform-a',
      salesforceUsername: 'sf-a@example.invalid',
      executionRole: 'USER',
      toolName: 'run_soql_query',
      operation: `QUERY ${fakeBearer}`,
      result: 'PASS',
      outcome: 'SUCCESS',
      durationMs: 25,
      requestSummary: { authorization: fakeBearer, safe: 'call-a' },
      responseSummary: { done: true },
    });
    await assert.rejects(
      store.repositories.auditTraces.createCall({
        occurredAt: completedAt,
        publicAuditId,
        correlationId: 'p7-duplicate-public-id',
        toolName: 'run_soql_query',
        result: 'ERROR',
      }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_CONFLICT',
    );
    const callB = await store.repositories.auditTraces.createCall({
      occurredAt: completedAt,
      startedAt,
      completedAt,
      correlationId: 'p7-call-b',
      platformUserId: 'platform-b',
      salesforceUsername: 'sf-b@example.invalid',
      executionRole: 'USER',
      toolName: 'run_soql_query',
      operation: 'QUERY',
      objectApiName: 'Account',
      recordId: '001fake',
      result: 'PASS',
      outcome: 'SUCCESS',
      auditIntegrityStatus: 'COMPLETE',
      durationMs: 25,
    });
    assert.equal(callA.publicAuditId, publicAuditId);
    assert.equal(callA.auditKind, 'MCP_TOOL_CALL');
    assert.equal(callA.auditIntegrityStatus, 'PARTIAL');

    const eventA = await store.repositories.auditTraces.createEvent({
      auditId: callA.id,
      sequence: 1,
      eventCategory: 'MCP',
      eventType: 'REQUEST_ACCEPTED',
      eventName: `MCP 请求已接受 ${fakeBearer}`,
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
      status: 'SUCCESS',
      safeSummary: { cookie: 'session=fake-cookie', safe: 'event-a' },
    });
    const eventB = await store.repositories.auditTraces.createEvent({
      auditId: callB.id,
      sequence: 1,
      eventCategory: 'MCP',
      eventType: 'REQUEST_ACCEPTED',
      eventName: 'MCP 请求已接受',
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
      status: 'SUCCESS',
    });
    const childA = await store.repositories.auditTraces.createEvent({
      auditId: callA.id,
      sequence: 2,
      parentEventId: eventA.id,
      eventCategory: 'SALESFORCE',
      eventType: 'API_CALL',
      eventName: 'Salesforce 查询',
      startedAt,
      completedAt,
      durationMs: 25,
      status: 'SUCCESS',
    });
    assert.equal(childA.parentEventId, eventA.id);
    await assert.rejects(
      store.repositories.auditTraces.createEvent({
        auditId: callA.id,
        sequence: 3,
        parentEventId: eventB.id,
        eventCategory: 'INTERNAL',
        eventType: 'INVALID_PARENT',
        eventName: '跨审计父节点',
        startedAt,
        status: 'FAILED',
      }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_INPUT_INVALID',
    );
    await assert.rejects(
      store.repositories.auditTraces.createEvent({
        auditId: callA.id,
        sequence: 1,
        eventCategory: 'MCP',
        eventType: 'DUPLICATE_SEQUENCE',
        eventName: '重复序号',
        startedAt,
        status: 'FAILED',
      }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_CONFLICT',
    );

    const apiA = await store.repositories.auditTraces.createSalesforceApiCall({
      auditId: callA.id,
      auditEventId: childA.id,
      sequence: 1,
      salesforceUsername: 'sf-a@example.invalid',
      transportKind: 'JSFORCE',
      visibility: 'EXACT_HTTP',
      apiCategory: 'REST_API',
      httpMethod: 'GET',
      endpoint: `https://example.invalid/services/data/v65.0/query?access_token=fake-api-secret`,
      requestUrl: `https://example.invalid/services/data/v65.0/query?access_token=fake-api-secret`,
      host: 'example.invalid',
      endpointPath: '/services/data/v65.0/query?access_token=fake-api-secret',
      apiVersion: '65.0',
      purpose: '查询 Account',
      startedAt,
      completedAt,
      durationMs: 25,
      httpStatus: 200,
      result: 'SUCCESS',
      queryType: 'DATA_SOQL',
      soqlStatementSafe: `SELECT Id FROM Account WHERE Name = '${fakeBearer}'`,
      totalSize: 1,
      returnedRecords: 1,
      done: true,
      hasNextRecords: false,
    });
    const apiB = await store.repositories.auditTraces.createSalesforceApiCall({
      auditId: callB.id,
      auditEventId: eventB.id,
      sequence: 1,
      salesforceUsername: 'sf-b@example.invalid',
      transportKind: 'JSFORCE',
      visibility: 'EXACT_HTTP',
      apiCategory: 'REST_API',
      httpMethod: 'GET',
      endpoint: 'https://example.invalid/services/data/v65.0/query',
      requestUrl: 'https://example.invalid/services/data/v65.0/query',
      host: 'example.invalid',
      endpointPath: '/services/data/v65.0/query',
      purpose: '查询 Contact',
      startedAt,
      completedAt,
      durationMs: 25,
      httpStatus: 200,
      result: 'SUCCESS',
      queryType: 'DATA_SOQL',
      soqlStatementSafe: 'SELECT Id FROM Contact',
      totalSize: 0,
      returnedRecords: 0,
      done: true,
      hasNextRecords: false,
    });
    const dmlA = await store.repositories.auditTraces.createSalesforceApiCall({
      auditId: callA.id,
      auditEventId: childA.id,
      sequence: 2,
      salesforceUsername: 'sf-a@example.invalid',
      transportKind: 'JSFORCE',
      visibility: 'EXACT_HTTP',
      apiCategory: 'REST_API',
      httpMethod: 'PATCH',
      endpoint: 'https://example.invalid/services/data/v65.0/sobjects/Account/001fake',
      requestUrl: 'https://example.invalid/services/data/v65.0/sobjects/Account/001fake',
      host: 'example.invalid',
      endpointPath: '/services/data/v65.0/sobjects/Account/001fake',
      apiVersion: '65.0',
      purpose: '更新 Account',
      startedAt,
      completedAt,
      durationMs: 25,
      httpStatus: 204,
      result: 'SUCCESS',
      dmlOperation: 'UPDATE',
      objectApiName: 'Account',
      recordId: '001fake',
      requestedFields: { Name: '安全名称', password: 'fake-request-password' },
      managedFields: { Created_By_AI__c: true },
      submittedFields: { Name: '安全名称', Created_By_AI__c: true },
    });
    assert.equal(dmlA.dmlOperation, 'UPDATE');
    assert.equal(JSON.stringify(dmlA.requestedFields).includes('fake-request-password'), false);
    assert.deepEqual(dmlA.submittedFields, { Name: '安全名称', Created_By_AI__c: true });
    await assert.rejects(
      store.repositories.auditTraces.createSalesforceApiCall({
        auditId: callA.id,
        sequence: 2,
        salesforceUsername: 'sf-a@example.invalid',
        transportKind: 'JSFORCE',
        visibility: 'EXACT_HTTP',
        apiCategory: 'REST_API',
        httpMethod: 'GET',
        endpoint: 'https://example.invalid/services/data/v65.0/',
        requestUrl: 'https://example.invalid/services/data/v65.0/',
        host: 'example.invalid',
        endpointPath: '/services/data/v65.0/',
        purpose: '重复 API 序号',
        startedAt,
        result: 'FAILED',
      }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_CONFLICT',
    );
    await assert.rejects(
      store.repositories.auditTraces.createSalesforceApiCall({
        auditId: callA.id,
        auditEventId: eventB.id,
        sequence: 2,
        salesforceUsername: 'sf-a@example.invalid',
        transportKind: 'JSFORCE',
        visibility: 'EXACT_HTTP',
        apiCategory: 'REST_API',
        httpMethod: 'GET',
        endpoint: 'https://example.invalid/services/data/v65.0/',
        requestUrl: 'https://example.invalid/services/data/v65.0/',
        host: 'example.invalid',
        endpointPath: '/services/data/v65.0/',
        purpose: '跨审计关联',
        startedAt,
        result: 'FAILED',
      }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_INPUT_INVALID',
    );

    const largePayload = JSON.stringify({ authorization: fakeBearer, records: '测'.repeat(100_000) });
    const payload = await store.repositories.auditTraces.createPayloadEvidence({
      auditId: callA.id,
      auditEventId: childA.id,
      salesforceApiCallId: apiA.id,
      payloadType: 'SALESFORCE_RESPONSE',
      contentType: `application/json; auth=${fakeBearer}`,
      originalSizeBytes: Buffer.byteLength(largePayload, 'utf8'),
      safePayload: largePayload,
    });
    assert.equal(payload.truncated, true);
    assert.equal(payload.storedSizeBytes <= 262_144, true);
    assert.equal(containsObviousAuditSecret(payload.safePayload ?? ''), false);
    assert.deepEqual(await store.repositories.auditTraces.getPayloadEvidenceById(payload.id), payload);
    const payloadMetadata = await store.repositories.auditTraces.listPayloadEvidenceMetadata(callA.id, { limit: 20, offset: 0 });
    assert.equal(payloadMetadata.items.length, 1);
    assert.equal('safePayload' in payloadMetadata.items[0]!, false);
    await assert.rejects(
      store.repositories.auditTraces.createPayloadEvidence({
        auditId: callA.id,
        salesforceApiCallId: apiB.id,
        payloadType: 'SALESFORCE_RESPONSE',
        contentType: 'application/json',
        originalSizeBytes: 2,
        safePayload: '{}',
      }),
      (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_ADMIN_INPUT_INVALID',
    );

    const eventsA = await store.repositories.auditTraces.listEvents(callA.id, { limit: 20, offset: 0 });
    const eventsB = await store.repositories.auditTraces.listEvents(callB.id, { limit: 20, offset: 0 });
    assert.deepEqual(eventsA.items.map((entry) => entry.sequence), [1, 2]);
    assert.deepEqual(eventsB.items.map((entry) => entry.sequence), [1]);
    const mainList = await store.repositories.audits.search({ limit: 20, offset: 0 });
    assert.equal(mainList.items.some((entry) => Object.prototype.hasOwnProperty.call(entry, 'safePayload')), false);
    const filtered = await store.repositories.audits.search({
      auditId: callB.publicAuditId,
      platformUserId: 'platform-b',
      salesforceUsername: 'sf-b@example.invalid',
      toolName: 'run_soql_query',
      result: 'PASS',
      outcome: 'SUCCESS',
      objectApiName: 'Account',
      recordId: '001fake',
      auditKind: 'MCP_TOOL_CALL',
      auditIntegrityStatus: 'COMPLETE',
      limit: 20,
      offset: 0,
    });
    assert.deepEqual(filtered.items.map((entry) => entry.id), [callB.id]);

    const rawAudit = await store.database.selectFrom('sfoa_audit_log')
      .select(['operation', 'request_summary_json']).where('id', '=', callA.id).executeTakeFirstOrThrow();
    const rawEvent = await store.database.selectFrom('sfoa_audit_event')
      .select(['event_name', 'safe_summary_json']).where('id', '=', eventA.id).executeTakeFirstOrThrow();
    const rawApi = await store.database.selectFrom('sfoa_salesforce_api_call')
      .select(['endpoint', 'soql_statement_safe']).where('id', '=', apiA.id).executeTakeFirstOrThrow();
    const rawPayload = await store.database.selectFrom('sfoa_audit_payload_evidence')
      .select(['content_type', 'safe_payload']).where('id', '=', payload.id).executeTakeFirstOrThrow();
    const persistedEvidence = JSON.stringify([rawAudit, rawEvent, rawApi, rawPayload]);
    assert.equal(persistedEvidence.includes('fake-p7-integration-secret'), false);
    assert.equal(persistedEvidence.includes('fake-api-secret'), false);

    // Repository 先拒绝，复合 FK 仍作为并发/绕过时的最终防线。
    await assert.rejects(
      store.database.insertInto('sfoa_audit_event').values({
        audit_id: callA.id,
        sequence: 99,
        parent_event_id: eventB.id,
        event_category: 'INTERNAL',
        event_type: 'DIRECT_FK_TEST',
        event_name: '数据库复合外键测试',
        started_at: startedAt,
        completed_at: null,
        duration_ms: null,
        status: 'FAILED',
        error_code: null,
        safe_summary_json: null,
      }).executeTakeFirstOrThrow(),
    );

    // Retention 未来只删除主记录；CASCADE 必须完整清理全部明细而不留下孤儿。
    await store.database.deleteFrom('sfoa_audit_log').where('id', '=', callA.id).executeTakeFirstOrThrow();
    const [remainingEvents, remainingApiCalls, remainingPayloads] = await Promise.all([
      store.database.selectFrom('sfoa_audit_event').select('id').where('audit_id', '=', callA.id).execute(),
      store.database.selectFrom('sfoa_salesforce_api_call').select('id').where('audit_id', '=', callA.id).execute(),
      store.database.selectFrom('sfoa_audit_payload_evidence').select('id').where('audit_id', '=', callA.id).execute(),
    ]);
    assert.equal(remainingEvents.length, 0);
    assert.equal(remainingApiCalls.length, 0);
    assert.equal(remainingPayloads.length, 0);
  });
}

function mysqlSnapshot(unique: number, concurrency: number, index: number): AuditSnapshot {
  const marker = `MYSQL_${concurrency}_${index}_ONLY`;
  const auditId = `00000000-0000-4000-8000-${String(unique).padStart(12, '0')}`;
  const context = RequestAuditContextController.create({
    correlationId: `mysql-shared-${index % 5}`,
    channel: 'MCP_HTTP',
    toolName: `tool_${index % 9}`,
  }, () => auditId, () => new Date('2026-08-30T01:00:00.000Z'))
    .withResolvedIdentity({ platformUserId: `platform_${marker}`, identitySource: 'USER_BOUND_TOKEN' })
    .withSalesforceRoute({ salesforceUsername: `sf_${marker}@example.invalid`, executionRole: 'USER' });
  const requestEventSequence = context.collector().recordEvent({
    eventCategory: 'MCP', eventType: 'TOOL_INVOCATION_STARTED', eventName: `${marker} started`, status: 'STARTED',
  });
  assert.equal(requestEventSequence, 1);
  context.collector().recordPayloadEvidence({
    payloadType: 'MCP_REQUEST', contentType: 'application/json',
    payload: JSON.stringify({ marker: `${marker}_REQUEST_ONLY` }),
    auditEventSequence: requestEventSequence,
  });
  const longQuerySuffix = index === 0
    ? `&soql=${'X'.repeat(1_500)}&long_url_end_marker=${marker}`
    : '';
  const publicApiCallId = `10000000-0000-4000-8000-${String(unique).padStart(12, '0')}`;
  context.collector().recordSalesforceApiCall(Object.freeze({
    publicApiCallId,
    auditId,
    sequence: context.nextSequence(),
    salesforceUsername: `sf_${marker}@example.invalid`,
    transportKind: 'JSFORCE',
    visibility: 'EXACT_HTTP',
    apiCategory: 'REST_API',
    apiVersion: '65.0',
    httpMethod: 'GET',
    requestUrl: `https://example.invalid/services/data/v65.0/query?marker=${marker}${longQuerySuffix}`,
    host: 'example.invalid',
    endpointPath: `/services/data/v65.0/query?marker=${marker}${longQuerySuffix}`,
    operationName: null,
    purpose: 'USER_QUERY',
    startedAt: '2026-08-30T01:00:00.001Z',
    completedAt: '2026-08-30T01:00:00.005Z',
    durationMs: 4,
    httpStatus: index === 1 ? 400 : 200,
    result: index === 1 ? 'FAILED' : 'SUCCESS',
    salesforceErrorCode: index === 1 ? 'LONG_VALIDATION_ERROR' : null,
    salesforceErrorMessage: index === 1 ? 'E'.repeat(1_500) : null,
    requestSizeBytes: null,
    responseSizeBytes: 64,
    contentType: 'application/json',
    queryType: 'DATA_SOQL',
    soqlStatement: `SELECT Id FROM Account WHERE Name = '${marker}'`,
    totalSize: index === 1 ? null : 1,
    returnedRecords: index === 1 ? null : 1,
    done: index === 1 ? null : true,
    hasNextRecords: index === 1 ? null : false,
    dmlOperation: null,
    objectApiName: 'Account',
    recordId: null,
    requestedFields: null,
    managedFields: null,
    submittedFields: null,
  }));
  context.collector().recordPayloadEvidence({
    payloadType: index === 1 ? 'ERROR_RESPONSE' : 'SALESFORCE_RESPONSE',
    contentType: 'application/json', payload: JSON.stringify({ marker: `SF_API_${marker}` }),
    salesforceApiCallPublicId: publicApiCallId,
  });
  const responseEventSequence = context.collector().recordEvent({
    eventCategory: 'TOOL', eventType: 'TOOL_TERMINAL', eventName: `${marker} terminal`, status: 'SUCCESS',
    terminal: { source: 'TOOL', result: 'PASS', outcome: 'SUCCESS' },
  });
  assert.equal(responseEventSequence, 3);
  context.collector().recordPayloadEvidence({
    payloadType: 'MCP_RESPONSE', contentType: 'application/json',
    payload: JSON.stringify({ marker: `${marker}_RESPONSE_ONLY` }),
    auditEventSequence: responseEventSequence,
  });
  const snapshot = context.finalizeAudit(new Date('2026-08-30T01:00:00.010Z'));
  assert.ok(snapshot);
  return snapshot;
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

let isolatedDatabaseCounter = 0;

async function withIsolatedDatabase<T>(
  source: DatabaseConfig,
  label: string,
  work: (database: ControlPlaneDatabaseClient) => Promise<T>,
): Promise<T> {
  isolatedDatabaseCounter += 1;
  const databaseName = `sfoa_p7_${label}_${process.pid}_${Date.now()}_${isolatedDatabaseCounter}_test`;
  const config = Object.freeze({ ...source, database: databaseName });
  await dropIsolatedDatabase(config);
  await createDatabaseIfMissing(config);
  const database = createControlPlaneDatabase(config);
  try {
    return await work(database);
  } finally {
    await database.destroy();
    await dropIsolatedDatabase(config);
  }
}

async function installP6Schema(database: ControlPlaneDatabaseClient): Promise<void> {
  await sql.raw(`CREATE TABLE sfoa_schema_migration (
    version VARCHAR(128) NOT NULL PRIMARY KEY,
    checksum_sha256 CHAR(64) NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`).execute(database);
  const directory = defaultMigrationsDirectory();
  for (const name of [
    '001_p5_control_plane.sql',
    '002_p5_indexes.sql',
    '003_p6_identity_credential.sql',
    '004_p6_dml_managed_field_rule.sql',
  ]) {
    const sqlText = await readFile(path.join(directory, name), 'utf8');
    for (const statement of splitSqlStatements(sqlText)) await sql.raw(statement).execute(database);
    await database.insertInto('sfoa_schema_migration').values({
      version: name.slice(0, -4),
      checksum_sha256: migrationChecksumSha256(sqlText),
    }).executeTakeFirstOrThrow();
  }
}

async function dropIsolatedDatabase(config: DatabaseConfig): Promise<void> {
  if (!/^sfoa_p7_[a-z]+_[0-9]+_[0-9]+_[0-9]+_test$/u.test(config.database)) {
    throw new Error(`Refusing to drop unexpected database ${config.database}.`);
  }
  const pool = createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    waitForConnections: true,
    connectionLimit: 1,
    queueLimit: 1,
    connectTimeout: config.connectTimeoutMs,
    timezone: 'Z',
    ...(config.sslMode === 'disabled'
      ? {}
      : { ssl: { rejectUnauthorized: config.sslMode === 'verify_identity' } }),
  });
  try {
    // 名称由上方严格正则产生；只清理本测试创建的隔离数据库。
    await pool.query(`DROP DATABASE IF EXISTS \`${config.database}\``);
  } finally {
    await pool.end();
  }
}

async function cleanTestData(store: MySqlControlPlaneStore): Promise<void> {
  await store.database.transaction().execute(async (transaction) => {
    await transaction.deleteFrom('sfoa_audit_log').execute();
    await transaction.deleteFrom('sfoa_identity_credential').execute();
    await transaction.deleteFrom('sfoa_runtime_setting').execute();
    await transaction.deleteFrom('sfoa_diagnostic_config').execute();
    await transaction.deleteFrom('sfoa_dml_managed_field_rule').execute();
    await transaction.deleteFrom('sfoa_dml_policy').execute();
    await transaction.deleteFrom('sfoa_tool_control').execute();
    await transaction.deleteFrom('sfoa_identity_route').execute();
  });
}

function testCredentialCipher(): IdentityCredentialCipher {
  return new IdentityCredentialCipher(Buffer.alloc(32, 7));
}

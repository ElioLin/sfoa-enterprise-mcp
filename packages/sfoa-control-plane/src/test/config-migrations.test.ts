import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ControlPlaneError,
  databaseNameForTest,
  defaultMigrationsDirectory,
  loadControlPlaneConfig,
  migrationChecksumSha256,
  parseEnvFile,
  splitSqlStatements,
} from '../index.js';

test('Control Plane defaults to env compatibility mode and mysql fails closed without credentials', async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), 'sfoa-p5-config-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await loadControlPlaneConfig(root, {}), { mode: 'env' });

  await assert.rejects(
    loadControlPlaneConfig(root, { SFOA_CONTROL_PLANE_MODE: 'mysql' }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
  );
  const loaded = await loadControlPlaneConfig(root, {
    SFOA_CONTROL_PLANE_MODE: 'mysql',
    SFOA_DB_HOST: '127.0.0.1',
    SFOA_DB_USER: 'sfoa_test',
    SFOA_DB_PASSWORD: '',
    SFOA_DB_CONNECTION_LIMIT: '4',
    SFOA_DB_QUEUE_LIMIT: '25',
  });
  assert.equal(loaded.mode, 'mysql');
  assert.equal(loaded.database?.connectionLimit, 4);
  assert.equal(loaded.database?.queueLimit, 25);
  assert.equal(databaseNameForTest(loaded.database!), 'sfoa_enterprise_mcp_test');
});

test('env parser does not execute shell syntax and retains secret values only in memory', () => {
  const values = parseEnvFile([
    'SFOA_DB_PASSWORD="p@ss word"',
    "MCP_CLIENT_TOKEN='literal-$env:HOME'",
    'export SFOA_DB_USER=sfoa',
    '# ignored',
  ].join('\n'));
  assert.equal(values.SFOA_DB_PASSWORD, 'p@ss word');
  assert.equal(values.MCP_CLIENT_TOKEN, 'literal-$env:HOME');
  assert.equal(values.SFOA_DB_USER, 'sfoa');
});

test('versioned migrations remain immutable and P7 adds normalized bounded audit evidence', async () => {
  const directory = defaultMigrationsDirectory();
  const first = await readFile(path.join(directory, '001_p5_control_plane.sql'), 'utf8');
  const second = await readFile(path.join(directory, '002_p5_indexes.sql'), 'utf8');
  const managedFields = await readFile(path.join(directory, '004_p6_dml_managed_field_rule.sql'), 'utf8');
  const p7Audit = await readFile(path.join(directory, '005_p7_end_to_end_audit.sql'), 'utf8');
  const p704 = await readFile(path.join(directory, '006_p7_salesforce_api_observability.sql'), 'utf8');
  const p705 = await readFile(path.join(directory, '007_p7_soql_dml_audit_evidence.sql'), 'utf8');
  const p706 = await readFile(path.join(directory, '008_p7_payload_evidence_runtime.sql'), 'utf8');
  assert.match(first, /CREATE TABLE IF NOT EXISTS sfoa_identity_route/u);
  assert.match(first, /CREATE TABLE IF NOT EXISTS sfoa_audit_log/u);
  assert.doesNotMatch(first, /access_token|private_key|jwt_assertion|password/iu);
  assert.doesNotMatch(first, /allow_delete|allow_upsert/iu);
  assert.equal((second.match(/CREATE INDEX/gu) ?? []).length, 10);
  assert.match(managedFields, /CREATE TABLE IF NOT EXISTS sfoa_dml_managed_field_rule/u);
  assert.match(managedFields, /UNIQUE \(dml_policy_id, target_field_api_name\)/u);
  assert.match(managedFields, /ENUM\('PLATFORM_USER_LOOKUP', 'AI_CREATED_MARKER'\)/u);
  assert.doesNotMatch(managedFields, /constant_value|expression|source_expression|MCP_AI_Created__c|Employee_Number__c/iu);
  assert.match(p7Audit, /ALTER TABLE sfoa_audit_log/u);
  assert.match(p7Audit, /public_audit_id/u);
  assert.match(p7Audit, /CREATE TABLE IF NOT EXISTS sfoa_audit_event/u);
  assert.match(p7Audit, /CREATE TABLE IF NOT EXISTS sfoa_salesforce_api_call/u);
  assert.match(p7Audit, /CREATE TABLE IF NOT EXISTS sfoa_audit_payload_evidence/u);
  assert.match(p7Audit, /UNIQUE \(audit_id, sequence\)/u);
  assert.match(p7Audit, /JSON_REMOVE\(request_summary_json, '\$\.rawToken'\)/u);
  assert.doesNotMatch(p7Audit, /WHEN tool_name IS NOT NULL THEN 'MCP_TOOL_CALL'/u);
  assert.match(p7Audit, /stored_size_bytes <= 262144/u);
  assert.doesNotMatch(p7Audit, /authorization_header|bearer_token|private_key|client_secret|database_password/iu);
  assert.match(p704, /public_api_call_id/u);
  assert.match(p704, /EXACT_HTTP/u);
  assert.match(p704, /OPERATION_ONLY/u);
  assert.match(p704, /request_url/u);
  assert.match(p704, /MODIFY COLUMN http_method[\s\S]*NULL/u);
  assert.doesNotMatch(p704, /https:\/\/salesforce\/metadata/u);
  assert.match(p705, /has_next_records/u);
  assert.match(p705, /submitted_fields_json JSON/u);
  assert.match(p706, /MODIFY COLUMN original_size_bytes BIGINT UNSIGNED NULL/u);
  const identityRouteUserName = await readFile(path.join(directory, '009_identity_route_user_name.sql'), 'utf8');
  assert.match(identityRouteUserName, /ALTER TABLE sfoa_identity_route/u);
  assert.match(identityRouteUserName, /ADD COLUMN user_name VARCHAR\(128\) NOT NULL AFTER platform_user_id/u);
  assert.match(identityRouteUserName, /UPDATE sfoa_identity_route/u);
  const fallback = await readFile(path.join(directory, '010_managed_platform_user_lookup_fallback.sql'), 'utf8');
  assert.equal(splitSqlStatements(fallback).length, 1);
  assert.match(fallback, /ALTER TABLE sfoa_dml_managed_field_rule/u);
  assert.match(fallback, /PLATFORM_USER_LOOKUP_FALLBACK/u);
  assert.match(fallback, /DROP CHECK chk_sfoa_dml_managed_field_strategy/u);
  assert.match(fallback, /ADD CONSTRAINT chk_sfoa_dml_managed_field_strategy CHECK/u);
  assert.doesNotMatch(fallback, /UPDATE sfoa_|INSERT INTO|DELETE FROM/iu);
  assert.equal(migrationChecksumSha256('SELECT 1;\n'), migrationChecksumSha256('SELECT 1;\r\n'));
  assert.notEqual(migrationChecksumSha256('SELECT 1;\n'), migrationChecksumSha256('SELECT 2;\n'));

  const statements = splitSqlStatements('-- comment\nCREATE TABLE x (id INT);\n\nCREATE INDEX y ON x (id);');
  assert.deepEqual(statements, ['CREATE TABLE x (id INT)', 'CREATE INDEX y ON x (id)']);
});

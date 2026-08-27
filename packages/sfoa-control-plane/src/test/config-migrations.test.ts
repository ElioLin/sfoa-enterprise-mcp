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

test('versioned migrations are bounded, recoverable, and contain only P5-owned schema', async () => {
  const directory = defaultMigrationsDirectory();
  const first = await readFile(path.join(directory, '001_p5_control_plane.sql'), 'utf8');
  const second = await readFile(path.join(directory, '002_p5_indexes.sql'), 'utf8');
  const managedFields = await readFile(path.join(directory, '004_p6_dml_managed_field_rule.sql'), 'utf8');
  assert.match(first, /CREATE TABLE IF NOT EXISTS sfoa_identity_route/u);
  assert.match(first, /CREATE TABLE IF NOT EXISTS sfoa_audit_log/u);
  assert.doesNotMatch(first, /access_token|private_key|jwt_assertion|password/iu);
  assert.doesNotMatch(first, /allow_delete|allow_upsert/iu);
  assert.equal((second.match(/CREATE INDEX/gu) ?? []).length, 10);
  assert.match(managedFields, /CREATE TABLE IF NOT EXISTS sfoa_dml_managed_field_rule/u);
  assert.match(managedFields, /UNIQUE \(dml_policy_id, target_field_api_name\)/u);
  assert.match(managedFields, /ENUM\('PLATFORM_USER_LOOKUP', 'AI_CREATED_MARKER'\)/u);
  assert.doesNotMatch(managedFields, /constant_value|expression|source_expression|MCP_AI_Created__c|Employee_Number__c/iu);

  const statements = splitSqlStatements('-- comment\nCREATE TABLE x (id INT);\n\nCREATE INDEX y ON x (id);');
  assert.deepEqual(statements, ['CREATE TABLE x (id INT)', 'CREATE INDEX y ON x (id)']);
});

import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AuditTraceNotFoundError, reconstructTrace, requireAuditRows } from './audit-trace.mjs';
import { assertReadOnlySql } from './shared/db.mjs';
import { loadProjectEnvironment, parseEnvText, sanitizeForOutput } from './shared/project.mjs';
import { checkSkill, deliveryCheck, packageSkill, syncSkill, validateSkill } from './manage.mjs';
import { runDoctor } from './doctor.mjs';

const canonicalDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(canonicalDir, '..', '..');

test('canonical Skill structure validates', async () => {
  const result = await validateSkill({ canonicalDir });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.ok(result.fileCount >= 18);
});

test('sync creates all platform copies and check detects exact consistency', async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-skill-sync-'));
  context.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const temporaryCanonical = path.join(temporaryRoot, 'skills', 'sfoa-mcp-maintainer');
  await mkdir(path.dirname(temporaryCanonical), { recursive: true });
  await cp(canonicalDir, temporaryCanonical, { recursive: true });
  const synced = await syncSkill({ projectRoot: temporaryRoot, canonicalDir: temporaryCanonical });
  assert.equal(synced.destinations.length, 3);
  assert.equal((await checkSkill({ projectRoot: temporaryRoot, canonicalDir: temporaryCanonical })).ok, true);
  await writeFile(path.join(temporaryRoot, '.claude', 'skills', 'sfoa-mcp-maintainer', 'SKILL.md'), 'drift', 'utf8');
  const drifted = await checkSkill({ projectRoot: temporaryRoot, canonicalDir: temporaryCanonical });
  assert.equal(drifted.ok, false);
  assert.ok(drifted.drift.some((item) => item.includes('.claude')));
});

test('package generation creates a portable ZIP from canonical source', async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-skill-package-'));
  context.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const outputPath = path.join(temporaryRoot, 'maintainer.zip');
  const result = await packageSkill({ projectRoot, canonicalDir, outputPath });
  const archive = await readFile(outputPath);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.ok(archive.includes(Buffer.from('sfoa-mcp-maintainer/SKILL.md')));
  assert.ok(result.fileCount >= 18);
  assert.match(result.sha256, /^[0-9a-f]{64}$/u);
});

test('environment parsing and output sanitization never reveal configured secrets', () => {
  const values = parseEnvText('SFOA_DB_PASSWORD=local-db-secret\nMCP_CLIENT_TOKEN="local-mcp-token"\nSAFE=value\n');
  const environment = { fileExists: true, envPath: '.env.local', values };
  const output = JSON.stringify(sanitizeForOutput({
    message: `failed with local-db-secret and Bearer local-mcp-token`,
    password: values.SFOA_DB_PASSWORD,
    safe: values.SAFE,
  }, environment));
  assert.doesNotMatch(output, /local-db-secret|local-mcp-token/u);
  assert.match(output, /\[REDACTED\]/u);
  assert.match(output, /value/u);
});

test('missing .env.local is a supported diagnostic state', async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'sfoa-env-missing-'));
  context.after(async () => rm(temporaryRoot, { recursive: true, force: true }));
  const environment = await loadProjectEnvironment(temporaryRoot, {});
  assert.equal(environment.fileExists, false);
  assert.deepEqual(environment.values, {});
});

test('read-only guard accepts diagnostics and rejects writes or stateful SELECT', () => {
  for (const statement of ['SELECT 1', 'SHOW TABLES', 'DESCRIBE sfoa_audit_log', 'EXPLAIN SELECT * FROM sfoa_audit_log']) {
    assert.doesNotThrow(() => assertReadOnlySql(statement));
  }
  for (const statement of ['INSERT INTO x VALUES (1)', 'UPDATE x SET a = 1', 'DELETE FROM x', 'ALTER TABLE x ADD y INT',
    'DROP TABLE x', 'TRUNCATE TABLE x', "SELECT 'x' INTO OUTFILE 'x'", 'SELECT * FROM x FOR UPDATE']) {
    assert.throws(() => assertReadOnlySql(statement), /read-only|stateful|unsafe/iu);
  }
});

test('doctor reports DB unavailable without printing a supplied secret', async () => {
  const environment = {
    fileExists: true,
    envPath: path.join(projectRoot, '.env.local'),
    values: { SFOA_DB_PASSWORD: 'doctor-super-secret' },
  };
  const report = await runDoctor({
    projectRoot,
    environment,
    skipServices: true,
    databaseProbe: async () => ({ status: 'UNAVAILABLE', error: 'connection failed using doctor-super-secret' }),
  });
  const output = JSON.stringify(report);
  assert.equal(report.database.status, 'UNAVAILABLE');
  assert.doesNotMatch(output, /doctor-super-secret/u);
});

test('audit trace not found has a stable typed failure', () => {
  assert.throws(() => requireAuditRows([]), AuditTraceNotFoundError);
});

test('audit trace reconstruction preserves evidence order and unavailable fields', () => {
  const report = reconstructTrace({
    audit: {
      id: '1', public_audit_id: '11111111-1111-4111-8111-111111111111', audit_kind: 'MCP_TOOL_CALL',
      occurred_at: new Date('2026-09-01T00:00:00Z'), started_at: new Date('2026-09-01T00:00:00Z'),
      completed_at: new Date('2026-09-01T00:00:01Z'), correlation_id: 'corr-1', channel: 'MCP',
      platform_user_id: 'platform-user-a', salesforce_username: 'user@example.com', execution_role: 'USER',
      identity_source: 'BUNTU_TOKEN', tool_name: 'run_soql_query', operation: null, object_api_name: 'Account',
      record_id: null, result: 'PASS', outcome: 'SUCCESS', error_code: null, error_message_safe: null,
      audit_integrity_status: 'COMPLETE', duration_ms: 1000, request_summary_json: '{"query":"SELECT Id FROM Account"}',
      response_summary_json: '{"count":1}',
    },
    events: [{ id: '10', sequence: 1, event_category: 'IDENTITY', event_type: 'IDENTITY_VALIDATION', event_name: 'Identity',
      started_at: new Date('2026-09-01T00:00:00Z'), completed_at: new Date('2026-09-01T00:00:00Z'), status: 'SUCCESS' }],
    apiCalls: [{ id: '20', public_api_call_id: '22222222-2222-4222-8222-222222222222', sequence: 2,
      transport_kind: 'JSFORCE', visibility: 'EXACT_HTTP', api_category: 'REST_API', http_method: 'GET',
      purpose: 'BUSINESS_QUERY', started_at: new Date('2026-09-01T00:00:00Z'), completed_at: new Date('2026-09-01T00:00:01Z'),
      result: 'SUCCESS', query_type: 'DATA_SOQL', soql_statement_safe: 'SELECT Id FROM Account', total_size: 1, returned_records: 1, done: 1 }],
    payloads: [{ id: '30', payload_type: 'MCP_REQUEST', content_type: 'application/json', original_size_bytes: '50', stored_size_bytes: 50,
      truncated: 0, created_at: new Date('2026-09-01T00:00:00Z') }],
    currentState: { route: { enabled: true }, tool: { enabled: true }, dmlPolicy: null },
  });
  assert.equal(report.timeline.length, 2);
  assert.equal(report.timeline[0].kind, 'EVENT');
  assert.equal(report.timeline[1].kind, 'SALESFORCE_API');
  assert.equal(report.firstFailure, null);
  assert.equal(report.reconstructedChain.find((item) => item.name === 'TOOLS_LIST')?.available, false);
  assert.equal(report.reconstructedChain.find((item) => item.name === 'SALESFORCE_API')?.available, true);
});

test('checked-in platform copies are byte-identical to canonical', async () => {
  const result = await checkSkill({ projectRoot, canonicalDir });
  assert.equal(result.ok, true, [...result.validation.errors, ...result.drift].join('; '));
});

test('delivery gate verifies git trackability or degrades cleanly outside a work tree', async () => {
  const result = await deliveryCheck({ projectRoot, canonicalDir });
  assert.equal(result.ok, true, [...result.problems].join('; '));
});

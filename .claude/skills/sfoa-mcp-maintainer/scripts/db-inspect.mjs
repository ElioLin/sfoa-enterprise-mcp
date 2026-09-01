import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { withReadOnlyDatabase } from './lib/db.mjs';
import {
  findProjectRoot,
  loadProjectEnvironment,
  maskIdentifier,
  parseCliArguments,
  sanitizeForOutput,
} from './lib/project.mjs';

const REPORTS = new Set(['summary', 'schema', 'routes', 'tools', 'dml', 'runtime', 'audit-stats']);

export async function inspectDatabase({ projectRoot, environment, report = 'summary', user, tool, object }) {
  if (!REPORTS.has(report)) throw new Error(`Unknown report ${report}. Use ${[...REPORTS].join(', ')}.`);
  return await withReadOnlyDatabase(projectRoot, environment, async (database) => {
    const result = report === 'summary' ? await summary(database)
      : report === 'schema' ? await schema(database)
        : report === 'routes' ? await routes(database, user)
          : report === 'tools' ? await tools(database, tool)
            : report === 'dml' ? await dml(database, object)
              : report === 'runtime' ? await runtime(database)
                : await auditStats(database);
    return Object.freeze({ report, database: database.database, generatedAt: new Date().toISOString(), ...result });
  });
}

async function summary(database) {
  const [tables, migrations, counts] = await Promise.all([
    database.execute('SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE ? ORDER BY table_name', [database.database, 'sfoa\\_%']),
    database.execute('SELECT version, applied_at FROM sfoa_schema_migration ORDER BY version'),
    database.execute(`SELECT
      (SELECT COUNT(*) FROM sfoa_identity_route) AS identity_routes,
      (SELECT COUNT(*) FROM sfoa_tool_control WHERE enabled = 1) AS enabled_tools,
      (SELECT COUNT(*) FROM sfoa_dml_policy WHERE enabled = 1) AS enabled_dml_policies,
      (SELECT COUNT(*) FROM sfoa_audit_log) AS audit_calls`),
  ]);
  return {
    tables: tables.map((row) => ({ name: row.table_name, estimatedRows: String(row.table_rows) })),
    migrations: migrations.map((row) => ({ version: row.version, appliedAt: iso(row.applied_at) })),
    counts: counts[0] ?? {},
  };
}

async function schema(database) {
  const [tables, migrations] = await Promise.all([
    database.execute(`SELECT table_name, column_name, column_type, is_nullable, column_key
      FROM information_schema.columns
      WHERE table_schema = ? AND table_name LIKE ?
      ORDER BY table_name, ordinal_position`, [database.database, 'sfoa\\_%']),
    database.execute('SELECT version, checksum_sha256, applied_at FROM sfoa_schema_migration ORDER BY version'),
  ]);
  return {
    columns: tables.map((row) => ({
      table: row.table_name, column: row.column_name, type: row.column_type, nullable: row.is_nullable === 'YES', key: row.column_key || null,
    })),
    migrations: migrations.map((row) => ({ version: row.version, checksumSha256: row.checksum_sha256, appliedAt: iso(row.applied_at) })),
  };
}

async function routes(database, user) {
  const rows = user
    ? await database.execute(`SELECT id, platform_user_id, salesforce_username, enabled, row_version, updated_at
        FROM sfoa_identity_route WHERE platform_user_id = ? ORDER BY id`, [user])
    : await database.execute(`SELECT id, platform_user_id, salesforce_username, enabled, row_version, updated_at
        FROM sfoa_identity_route ORDER BY id LIMIT 100`);
  const routeIds = rows.map((row) => row.id);
  let credentials = [];
  if (routeIds.length > 0) {
    const placeholders = routeIds.map(() => '?').join(', ');
    credentials = await database.execute(`SELECT identity_route_id, status, token_last4, generated_at, last_used_at
      FROM sfoa_identity_credential WHERE identity_route_id IN (${placeholders}) ORDER BY identity_route_id, id DESC`, routeIds);
  }
  return {
    userFilterMatched: user ? rows.length > 0 : null,
    routes: rows.map((row) => ({
      id: String(row.id), platformUserId: maskIdentifier(row.platform_user_id), salesforceUsername: maskIdentifier(row.salesforce_username),
      enabled: Boolean(row.enabled), rowVersion: String(row.row_version), updatedAt: iso(row.updated_at),
      credentials: credentials.filter((item) => String(item.identity_route_id) === String(row.id)).map((item) => ({
        status: item.status, tokenLast4: item.token_last4 ? `***${item.token_last4}` : null,
        generatedAt: iso(item.generated_at), lastUsedAt: iso(item.last_used_at),
      })),
    })),
  };
}

async function tools(database, tool) {
  const rows = tool
    ? await database.execute('SELECT tool_name, enabled, remark, row_version, updated_at FROM sfoa_tool_control WHERE tool_name = ?', [tool])
    : await database.execute('SELECT tool_name, enabled, remark, row_version, updated_at FROM sfoa_tool_control ORDER BY tool_name LIMIT 200');
  return {
    toolFilterMatched: tool ? rows.length > 0 : null,
    tools: rows.map((row) => ({
      toolName: row.tool_name, enabled: Boolean(row.enabled), remark: row.remark, rowVersion: String(row.row_version), updatedAt: iso(row.updated_at),
    })),
  };
}

async function dml(database, object) {
  const policies = object
    ? await database.execute(`SELECT id, object_api_name, allow_create, allow_update, enabled, remark, row_version, updated_at
        FROM sfoa_dml_policy WHERE object_api_name = ?`, [object])
    : await database.execute(`SELECT id, object_api_name, allow_create, allow_update, enabled, remark, row_version, updated_at
        FROM sfoa_dml_policy ORDER BY object_api_name LIMIT 200`);
  const policyIds = policies.map((row) => row.id);
  let rules = [];
  if (policyIds.length > 0) {
    const placeholders = policyIds.map(() => '?').join(', ');
    rules = await database.execute(`SELECT dml_policy_id, target_field_api_name, strategy, apply_on_create, apply_on_update,
      lookup_object_api_name, lookup_match_field_api_name, enabled, row_version
      FROM sfoa_dml_managed_field_rule WHERE dml_policy_id IN (${placeholders}) ORDER BY dml_policy_id, id`, policyIds);
  }
  return {
    objectFilterMatched: object ? policies.length > 0 : null,
    policies: policies.map((row) => ({
      id: String(row.id), objectApiName: row.object_api_name, allowCreate: Boolean(row.allow_create), allowUpdate: Boolean(row.allow_update),
      enabled: Boolean(row.enabled), remark: row.remark, rowVersion: String(row.row_version), updatedAt: iso(row.updated_at),
      managedFields: rules.filter((item) => String(item.dml_policy_id) === String(row.id)).map((item) => ({
        targetFieldApiName: item.target_field_api_name, strategy: item.strategy, applyOnCreate: Boolean(item.apply_on_create),
        applyOnUpdate: Boolean(item.apply_on_update), lookupObjectApiName: item.lookup_object_api_name,
        lookupMatchFieldApiName: item.lookup_match_field_api_name, enabled: Boolean(item.enabled), rowVersion: String(item.row_version),
      })),
    })),
  };
}

async function runtime(database) {
  const [settings, diagnostic] = await Promise.all([
    database.execute('SELECT setting_key, row_version, updated_at FROM sfoa_runtime_setting ORDER BY setting_key'),
    database.execute(`SELECT salesforce_username, enabled, verification_status, last_verified_at,
      last_error_code, last_error_message_safe, test_metadata_type, test_metadata_full_name, row_version, updated_at
      FROM sfoa_diagnostic_config WHERE id = 1`),
  ]);
  return {
    runtimeSettings: settings.map((row) => ({ key: row.setting_key, configured: true, rowVersion: String(row.row_version), updatedAt: iso(row.updated_at) })),
    diagnostic: diagnostic.map((row) => ({
      salesforceUsername: maskIdentifier(row.salesforce_username), enabled: Boolean(row.enabled), verificationStatus: row.verification_status,
      lastVerifiedAt: iso(row.last_verified_at), lastErrorCode: row.last_error_code,
      lastErrorMessageSafe: row.last_error_message_safe, testMetadataType: row.test_metadata_type,
      testMetadataFullName: row.test_metadata_full_name, rowVersion: String(row.row_version), updatedAt: iso(row.updated_at),
    }))[0] ?? null,
  };
}

async function auditStats(database) {
  const [terminal, kinds, integrity, latestErrors] = await Promise.all([
    database.execute(`SELECT result, outcome, COUNT(*) AS count FROM sfoa_audit_log
      WHERE occurred_at >= UTC_TIMESTAMP(3) - INTERVAL 24 HOUR GROUP BY result, outcome ORDER BY result, outcome`),
    database.execute(`SELECT audit_kind, COUNT(*) AS count FROM sfoa_audit_log
      WHERE occurred_at >= UTC_TIMESTAMP(3) - INTERVAL 24 HOUR GROUP BY audit_kind ORDER BY audit_kind`),
    database.execute(`SELECT audit_integrity_status, COUNT(*) AS count FROM sfoa_audit_log
      WHERE occurred_at >= UTC_TIMESTAMP(3) - INTERVAL 24 HOUR GROUP BY audit_integrity_status ORDER BY audit_integrity_status`),
    database.execute(`SELECT public_audit_id, occurred_at, tool_name, result, outcome, error_code
      FROM sfoa_audit_log WHERE result <> 'PASS' OR outcome IN ('FAILED', 'DENIED', 'UNKNOWN')
      ORDER BY occurred_at DESC, id DESC LIMIT 20`),
  ]);
  return {
    window: '24h', terminal, kinds, integrity,
    latestErrors: latestErrors.map((row) => ({
      publicAuditId: row.public_audit_id, occurredAt: iso(row.occurred_at), toolName: row.tool_name,
      result: row.result, outcome: row.outcome, errorCode: row.error_code,
    })),
  };
}

function iso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function main() {
  const arguments_ = parseCliArguments(process.argv.slice(2));
  const projectRoot = arguments_['project-root'] ? path.resolve(String(arguments_['project-root'])) : await findProjectRoot();
  const environment = await loadProjectEnvironment(projectRoot);
  const report = await inspectDatabase({
    projectRoot,
    environment,
    report: String(arguments_.report ?? arguments_._[0] ?? 'summary'),
    ...(arguments_.user ? { user: String(arguments_.user) } : {}),
    ...(arguments_.tool ? { tool: String(arguments_.tool) } : {}),
    ...(arguments_.object ? { object: String(arguments_.object) } : {}),
  });
  process.stdout.write(`${JSON.stringify(sanitizeForOutput(report, environment), null, 2)}\n`);
}

const isCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isCli) main().catch((error) => {
  process.stderr.write(`[db-inspect] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

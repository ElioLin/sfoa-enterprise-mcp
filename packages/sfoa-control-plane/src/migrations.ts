import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import type { ControlPlaneDatabaseClient } from './database.js';
import { ControlPlaneError, toControlPlaneError } from './errors.js';

export type MigrationStatus = Readonly<{
  version: string;
  checksumSha256: string;
  state: 'APPLIED' | 'PENDING';
  appliedAt: string | null;
}>;

type MigrationFile = Readonly<{ version: string; sqlText: string; checksumSha256: string }>;

export function defaultMigrationsDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
}

export async function migrateDatabase(
  database: ControlPlaneDatabaseClient,
  migrationsDirectory = defaultMigrationsDirectory(),
): Promise<readonly MigrationStatus[]> {
  await ensureMigrationTable(database);
  const files = await loadMigrationFiles(migrationsDirectory);
  const lock = await sql<{ acquired: number }>`SELECT GET_LOCK('sfoa_p5_schema_migration', 30) AS acquired`.execute(database);
  if (Number(lock.rows[0]?.acquired) !== 1) {
    throw new ControlPlaneError('MCP_RUNTIME_CONTROL_PLANE_UNAVAILABLE', 'Could not acquire the P5 schema migration lock.');
  }
  try {
    const applied = await appliedMigrations(database);
    for (const migration of files) {
      const prior = applied.get(migration.version);
      if (prior) {
        if (prior.checksumSha256 !== migration.checksumSha256) {
          throw new ControlPlaneError(
            'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
            `Applied migration ${migration.version} checksum does not match the repository file.`,
          );
        }
        continue;
      }
      for (const statement of splitSqlStatements(migration.sqlText)) {
        await executeMigrationStatement(database, statement);
      }
      await database
        .insertInto('sfoa_schema_migration')
        .values({ version: migration.version, checksum_sha256: migration.checksumSha256 })
        .executeTakeFirstOrThrow();
    }
    const status = await migrationStatus(database, migrationsDirectory);
    await validateRequiredSchemaObjects(database);
    return status;
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw toControlPlaneError(error);
  } finally {
    await sql`SELECT RELEASE_LOCK('sfoa_p5_schema_migration')`.execute(database).catch(() => undefined);
  }
}

export async function migrationStatus(
  database: ControlPlaneDatabaseClient,
  migrationsDirectory = defaultMigrationsDirectory(),
): Promise<readonly MigrationStatus[]> {
  await ensureMigrationTable(database);
  const [files, applied] = await Promise.all([loadMigrationFiles(migrationsDirectory), appliedMigrations(database)]);
  const fileVersions = new Set(files.map((file) => file.version));
  const unknownApplied = [...applied.keys()].filter((version) => !fileVersions.has(version));
  if (unknownApplied.length > 0) {
    throw new ControlPlaneError(
      'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
      `Database contains migration versions absent from this build: ${unknownApplied.join(', ')}.`,
    );
  }
  const status = Object.freeze(
    files.map((file) => {
      const current = applied.get(file.version);
      if (current && current.checksumSha256 !== file.checksumSha256) {
        throw new ControlPlaneError(
          'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
          `Applied migration ${file.version} checksum does not match the repository file.`,
        );
      }
      return Object.freeze({
        version: file.version,
        checksumSha256: file.checksumSha256,
        state: current ? 'APPLIED' as const : 'PENDING' as const,
        appliedAt: current?.appliedAt ?? null,
      });
    }),
  );
  if (status.every((entry) => entry.state === 'APPLIED')) await validateRequiredSchemaObjects(database);
  return status;
}

export async function assertAllMigrationsApplied(
  database: ControlPlaneDatabaseClient,
  migrationsDirectory = defaultMigrationsDirectory(),
): Promise<readonly MigrationStatus[]> {
  try {
    const files = await loadMigrationFiles(migrationsDirectory);
    const applied = await appliedMigrations(database);
    const status = files.map((file) => {
      const current = applied.get(file.version);
      if (!current || current.checksumSha256 !== file.checksumSha256) {
        throw new ControlPlaneError(
          'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
          `Required migration ${file.version} is missing or has a checksum mismatch. Run db:migrate before startup.`,
        );
      }
      return Object.freeze({
        version: file.version,
        checksumSha256: file.checksumSha256,
        state: 'APPLIED' as const,
        appliedAt: current.appliedAt,
      });
    });
    const known = new Set(files.map((file) => file.version));
    const unknown = [...applied.keys()].filter((version) => !known.has(version));
    if (unknown.length > 0) {
      throw new ControlPlaneError(
        'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
        `Database contains migration versions absent from this build: ${unknown.join(', ')}.`,
      );
    }
    await validateRequiredSchemaObjects(database);
    return Object.freeze(status);
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw toControlPlaneError(error);
  }
}

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sfoa_schema_migration: Object.freeze(['version', 'checksum_sha256', 'applied_at']),
  sfoa_identity_route: Object.freeze([
    'id', 'platform_user_id', 'salesforce_username', 'enabled', 'remark', 'row_version', 'created_at', 'updated_at',
  ]),
  sfoa_tool_control: Object.freeze([
    'id', 'tool_name', 'enabled', 'remark', 'row_version', 'created_at', 'updated_at',
  ]),
  sfoa_dml_policy: Object.freeze([
    'id', 'object_api_name', 'allow_create', 'allow_update', 'enabled', 'remark', 'row_version', 'created_at', 'updated_at',
  ]),
  sfoa_diagnostic_config: Object.freeze([
    'id', 'salesforce_username', 'enabled', 'verification_status', 'last_verified_at', 'last_error_code',
    'last_error_message_safe', 'test_metadata_type', 'test_metadata_full_name', 'row_version', 'created_at', 'updated_at',
  ]),
  sfoa_runtime_setting: Object.freeze(['setting_key', 'setting_value_json', 'row_version', 'updated_at']),
  sfoa_audit_log: Object.freeze([
    'id', 'occurred_at', 'correlation_id', 'channel', 'client_id', 'actor_admin', 'platform_user_id',
    'salesforce_username', 'execution_role', 'tool_name', 'operation', 'object_api_name', 'record_id',
    'result', 'outcome', 'error_code', 'duration_ms', 'request_summary_json', 'response_summary_json', 'created_at',
  ]),
});

const REQUIRED_INDEXES: Readonly<Record<string, Readonly<{ tableName: string; columns: readonly string[]; unique: boolean }>>> = Object.freeze({
  uq_sfoa_identity_route_platform_user: Object.freeze({ tableName: 'sfoa_identity_route', columns: Object.freeze(['platform_user_id']), unique: true }),
  idx_sfoa_identity_enabled_username: Object.freeze({ tableName: 'sfoa_identity_route', columns: Object.freeze(['enabled', 'salesforce_username']), unique: false }),
  uq_sfoa_tool_control_name: Object.freeze({ tableName: 'sfoa_tool_control', columns: Object.freeze(['tool_name']), unique: true }),
  idx_sfoa_tool_enabled: Object.freeze({ tableName: 'sfoa_tool_control', columns: Object.freeze(['enabled', 'tool_name']), unique: false }),
  uq_sfoa_dml_policy_object: Object.freeze({ tableName: 'sfoa_dml_policy', columns: Object.freeze(['object_api_name']), unique: true }),
  idx_sfoa_dml_enabled: Object.freeze({ tableName: 'sfoa_dml_policy', columns: Object.freeze(['enabled', 'object_api_name']), unique: false }),
  idx_sfoa_audit_occurred_at: Object.freeze({ tableName: 'sfoa_audit_log', columns: Object.freeze(['occurred_at', 'id']), unique: false }),
  idx_sfoa_audit_correlation: Object.freeze({ tableName: 'sfoa_audit_log', columns: Object.freeze(['correlation_id']), unique: false }),
  idx_sfoa_audit_platform_user: Object.freeze({ tableName: 'sfoa_audit_log', columns: Object.freeze(['platform_user_id', 'occurred_at']), unique: false }),
  idx_sfoa_audit_salesforce_user: Object.freeze({ tableName: 'sfoa_audit_log', columns: Object.freeze(['salesforce_username', 'occurred_at']), unique: false }),
  idx_sfoa_audit_tool: Object.freeze({ tableName: 'sfoa_audit_log', columns: Object.freeze(['tool_name', 'occurred_at']), unique: false }),
  idx_sfoa_audit_result: Object.freeze({ tableName: 'sfoa_audit_log', columns: Object.freeze(['result', 'occurred_at']), unique: false }),
  idx_sfoa_audit_error: Object.freeze({ tableName: 'sfoa_audit_log', columns: Object.freeze(['error_code', 'occurred_at']), unique: false }),
});

export async function validateRequiredSchemaObjects(database: ControlPlaneDatabaseClient): Promise<void> {
  const [tablesResult, columnsResult, indexesResult] = await Promise.all([
    sql<{ tableName: string; engine: string | null }>`
      SELECT TABLE_NAME AS tableName, ENGINE AS engine
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
    `.execute(database),
    sql<{ tableName: string; columnName: string }>`
      SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
    `.execute(database),
    sql<{ tableName: string; indexName: string; columnName: string; sequenceNumber: number; nonUnique: number }>`
      SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName, COLUMN_NAME AS columnName,
             SEQ_IN_INDEX AS sequenceNumber, NON_UNIQUE AS nonUnique
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
    `.execute(database),
  ]);
  const tables = new Map(tablesResult.rows.map((row) => [row.tableName, row.engine?.toLocaleUpperCase('en-US') ?? null]));
  const columnsByTable = new Map<string, Set<string>>();
  for (const row of columnsResult.rows) {
    const columns = columnsByTable.get(row.tableName) ?? new Set<string>();
    columns.add(row.columnName);
    columnsByTable.set(row.tableName, columns);
  }
  const indexColumns = new Map<string, { tableName: string; columns: string[]; unique: boolean }>();
  for (const row of indexesResult.rows) {
    const key = `${row.tableName}\u0000${row.indexName}`;
    const current = indexColumns.get(key) ?? { tableName: row.tableName, columns: [], unique: Number(row.nonUnique) === 0 };
    current.columns.push(row.columnName);
    indexColumns.set(key, current);
  }
  const defects: string[] = [];
  for (const [tableName, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
    const engine = tables.get(tableName);
    if (!engine) {
      defects.push(`missing table ${tableName}`);
      continue;
    }
    if (engine !== 'INNODB') defects.push(`table ${tableName} engine is ${engine ?? 'UNKNOWN'}, expected INNODB`);
    const actualColumns = columnsByTable.get(tableName) ?? new Set<string>();
    for (const column of requiredColumns) if (!actualColumns.has(column)) defects.push(`missing column ${tableName}.${column}`);
  }
  for (const [indexName, expected] of Object.entries(REQUIRED_INDEXES)) {
    const actual = indexColumns.get(`${expected.tableName}\u0000${indexName}`);
    if (!actual) {
      defects.push(`missing index ${indexName}`);
      continue;
    }
    if (
      actual.tableName !== expected.tableName ||
      actual.columns.join(',') !== expected.columns.join(',') ||
      actual.unique !== expected.unique
    ) {
      defects.push(`index ${indexName} definition does not match the audited migration`);
    }
  }
  if (defects.length > 0) {
    throw new ControlPlaneError(
      'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
      `P5 schema validation failed: ${defects.slice(0, 20).join('; ')}. Run the reviewed migration or repair the project database.`,
    );
  }
}

async function executeMigrationStatement(database: ControlPlaneDatabaseClient, statement: string): Promise<void> {
  const createIndex = /^CREATE\s+INDEX\s+([A-Za-z][A-Za-z0-9_]*)\s+ON\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/iu.exec(statement);
  if (createIndex?.[1] && createIndex[2]) {
    const existing = await sql<{ count: string }>`
      SELECT COUNT(*) AS count
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = ${createIndex[1]} AND TABLE_NAME = ${createIndex[2]}
    `.execute(database);
    if (Number(existing.rows[0]?.count ?? 0) > 0) return;
  }
  await sql.raw(statement).execute(database);
}

async function ensureMigrationTable(database: ControlPlaneDatabaseClient): Promise<void> {
  await sql.raw(`CREATE TABLE IF NOT EXISTS sfoa_schema_migration (
    version VARCHAR(128) NOT NULL PRIMARY KEY,
    checksum_sha256 CHAR(64) NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`).execute(database);
}

async function appliedMigrations(
  database: ControlPlaneDatabaseClient,
): Promise<ReadonlyMap<string, Readonly<{ checksumSha256: string; appliedAt: string }>>> {
  const rows = await database.selectFrom('sfoa_schema_migration').selectAll().orderBy('version').execute();
  return new Map(
    rows.map((row) => [
      row.version,
      Object.freeze({ checksumSha256: row.checksum_sha256, appliedAt: toIso(row.applied_at) }),
    ]),
  );
}

async function loadMigrationFiles(directory: string): Promise<readonly MigrationFile[]> {
  const names = (await readdir(directory)).filter((name) => /^\d{3}_[A-Za-z0-9_-]+\.sql$/u.test(name)).sort();
  if (names.length === 0) {
    throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFIGURATION_INVALID', 'No P5 SQL migrations were found.');
  }
  const files = await Promise.all(names.map(async (name) => {
    const sqlText = await readFile(path.join(directory, name), 'utf8');
    return Object.freeze({
      version: name.slice(0, -4),
      sqlText,
      checksumSha256: createHash('sha256').update(sqlText).digest('hex'),
    });
  }));
  return Object.freeze(files);
}

export function splitSqlStatements(text: string): readonly string[] {
  const withoutLineComments = text
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  return Object.freeze(withoutLineComments.split(';').map((statement) => statement.trim()).filter(Boolean));
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

import { Kysely, MysqlDialect, sql } from 'kysely';
import { createPool, type PoolOptions } from 'mysql2';
import type { DatabaseConfig } from './config.js';
import { ControlPlaneError, toControlPlaneError } from './errors.js';
import type { ControlPlaneDatabase } from './schema.js';

export type ControlPlaneDatabaseClient = Kysely<ControlPlaneDatabase>;

export function createControlPlaneDatabase(config: DatabaseConfig): ControlPlaneDatabaseClient {
  const poolOptions: PoolOptions = {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    queueLimit: config.queueLimit,
    connectTimeout: config.connectTimeoutMs,
    enableKeepAlive: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    timezone: 'Z',
    ...(config.sslMode === 'disabled'
      ? {}
      : { ssl: { rejectUnauthorized: config.sslMode === 'verify_identity' } }),
  };
  return new Kysely<ControlPlaneDatabase>({ dialect: new MysqlDialect({ pool: createPool(poolOptions) }) });
}

export async function createDatabaseIfMissing(config: DatabaseConfig): Promise<void> {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(config.database)) {
    throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFIGURATION_INVALID', 'The configured database name is unsafe.');
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
  }).promise();
  try {
    await pool.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
  } catch (error) {
    throw toControlPlaneError(error);
  } finally {
    await pool.end();
  }
}

export async function databaseHealth(database: ControlPlaneDatabaseClient): Promise<Readonly<{ version: string }>> {
  try {
    const result = await sql<{ version: string }>`SELECT VERSION() AS version`.execute(database);
    const version = result.rows[0]?.version;
    if (!version) throw new Error('MySQL did not return a version.');
    return Object.freeze({ version });
  } catch (error) {
    throw toControlPlaneError(error);
  }
}

import { createRequire } from 'node:module';
import path from 'node:path';

const ALLOWED_START = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN']);
const FORBIDDEN_READ_PATTERNS = [
  /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/iu,
  /\bFOR\s+UPDATE\b/iu,
  /\bLOCK\s+IN\s+SHARE\s+MODE\b/iu,
  /\b(?:GET_LOCK|RELEASE_LOCK|SLEEP|BENCHMARK)\s*\(/iu,
  /:=/u,
];

export function databaseConfigFromEnvironment(environment) {
  const values = environment.values;
  const missing = ['SFOA_DB_HOST', 'SFOA_DB_USER', 'SFOA_DB_PASSWORD']
    .filter((name) => typeof values[name] !== 'string' || values[name].trim() === '');
  if (missing.length > 0) throw new Error(`Database configuration is incomplete: ${missing.join(', ')}.`);
  const port = boundedInteger(values.SFOA_DB_PORT, 3306, 1, 65_535, 'SFOA_DB_PORT');
  const connectTimeout = boundedInteger(values.SFOA_DB_CONNECT_TIMEOUT_MS, 10_000, 100, 120_000, 'SFOA_DB_CONNECT_TIMEOUT_MS');
  const database = values.SFOA_DB_NAME?.trim() || 'sfoa_enterprise_mcp';
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(database)) throw new Error('SFOA_DB_NAME is unsafe.');
  const sslMode = values.SFOA_DB_SSL_MODE?.trim() || 'disabled';
  if (!['disabled', 'required', 'verify_identity'].includes(sslMode)) throw new Error('SFOA_DB_SSL_MODE is invalid.');
  return Object.freeze({
    host: values.SFOA_DB_HOST.trim(),
    port,
    database,
    user: values.SFOA_DB_USER.trim(),
    password: values.SFOA_DB_PASSWORD,
    connectTimeout,
    sslMode,
  });
}

export function assertReadOnlySql(statement) {
  if (typeof statement !== 'string') throw new TypeError('SQL must be a string.');
  const normalized = stripLeadingComments(statement).trim().replace(/;\s*$/u, '');
  if (normalized.length === 0) throw new Error('SQL must not be empty.');
  if (normalized.includes(';')) throw new Error('Only one read-only SQL statement is allowed.');
  const keyword = /^[A-Za-z]+/u.exec(normalized)?.[0]?.toUpperCase();
  if (!keyword || !ALLOWED_START.has(keyword)) {
    throw new Error(`Diagnostic SQL is read-only; ${keyword ?? 'unknown'} is not allowed.`);
  }
  if (keyword === 'EXPLAIN' && !/^EXPLAIN\s+(?:FORMAT\s*=\s*(?:JSON|TREE)\s+)?SELECT\b/iu.test(normalized)) {
    throw new Error('EXPLAIN is limited to SELECT statements.');
  }
  for (const pattern of FORBIDDEN_READ_PATTERNS) {
    if (pattern.test(normalized)) throw new Error('The diagnostic SQL contains a stateful or unsafe read construct.');
  }
  return normalized;
}

export async function executeReadOnly(connection, statement, parameters = []) {
  const sql = assertReadOnlySql(statement);
  const [rows] = await connection.execute(sql, parameters);
  return rows;
}

export async function withReadOnlyDatabase(projectRoot, environment, callback) {
  const config = databaseConfigFromEnvironment(environment);
  const requireFromControlPlane = createRequire(path.join(projectRoot, 'packages', 'sfoa-control-plane', 'package.json'));
  const mysql = requireFromControlPlane('mysql2/promise');
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectTimeout: config.connectTimeout,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    timezone: 'Z',
    ...(config.sslMode === 'disabled' ? {} : { ssl: { rejectUnauthorized: config.sslMode === 'verify_identity' } }),
  });
  let transactionStarted = false;
  try {
    await connection.query('SET SESSION TRANSACTION READ ONLY');
    await connection.query('START TRANSACTION READ ONLY');
    transactionStarted = true;
    return await callback(Object.freeze({
      execute: (statement, parameters = []) => executeReadOnly(connection, statement, parameters),
      database: config.database,
    }));
  } finally {
    if (transactionStarted) await connection.rollback().catch(() => undefined);
    await connection.end().catch(() => undefined);
  }
}

function stripLeadingComments(value) {
  let output = value;
  for (;;) {
    const next = output.replace(/^\s*(?:--[^\r\n]*(?:\r?\n|$)|#[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)/u, '');
    if (next === output) return output;
    output = next;
  }
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} is invalid.`);
  return parsed;
}

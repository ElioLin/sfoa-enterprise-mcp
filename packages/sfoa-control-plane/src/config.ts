import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { controlPlaneModeSchema, type ControlPlaneMode } from './contracts.js';
import { ControlPlaneError } from './errors.js';

export type DatabaseSslMode = 'disabled' | 'required' | 'verify_identity';

export type DatabaseConfig = Readonly<{
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode: DatabaseSslMode;
  connectionLimit: number;
  queueLimit: number;
  connectTimeoutMs: number;
}>;

export type ControlPlaneConfig = Readonly<{
  mode: ControlPlaneMode;
  database?: DatabaseConfig;
}>;

const databaseNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u);
const rawSchema = z
  .object({
    SFOA_CONTROL_PLANE_MODE: controlPlaneModeSchema.default('env'),
    SFOA_DB_HOST: z.string().trim().min(1).max(255).optional(),
    SFOA_DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
    SFOA_DB_NAME: databaseNameSchema.default('sfoa_enterprise_mcp'),
    SFOA_DB_USER: z.string().trim().min(1).max(128).optional(),
    SFOA_DB_PASSWORD: z.string().max(4096).optional(),
    SFOA_DB_SSL_MODE: z.enum(['disabled', 'required', 'verify_identity']).default('disabled'),
    SFOA_DB_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
    SFOA_DB_QUEUE_LIMIT: z.coerce.number().int().min(1).max(1000).default(100),
    SFOA_DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  })
  .strict();

const NAMES = [
  'SFOA_CONTROL_PLANE_MODE',
  'SFOA_DB_HOST',
  'SFOA_DB_PORT',
  'SFOA_DB_NAME',
  'SFOA_DB_USER',
  'SFOA_DB_PASSWORD',
  'SFOA_DB_SSL_MODE',
  'SFOA_DB_CONNECTION_LIMIT',
  'SFOA_DB_QUEUE_LIMIT',
  'SFOA_DB_CONNECT_TIMEOUT_MS',
] as const;

export async function loadControlPlaneConfig(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: Readonly<{ requireDatabase?: boolean }> = {},
): Promise<ControlPlaneConfig> {
  const fileValues = await readLocalEnvironment(path.resolve(projectRoot));
  const combined: Record<string, string | undefined> = {};
  for (const name of NAMES) {
    const value = environment[name] ?? fileValues[name];
    combined[name] = value === undefined || (name !== 'SFOA_DB_PASSWORD' && value.trim() === '')
      ? undefined
      : value.trim();
  }
  if (options.requireDatabase && !combined.SFOA_CONTROL_PLANE_MODE) combined.SFOA_CONTROL_PLANE_MODE = 'mysql';

  const parsed = rawSchema.safeParse(combined);
  if (!parsed.success) {
    throw configurationError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  }
  const requireDatabase = options.requireDatabase === true || parsed.data.SFOA_CONTROL_PLANE_MODE === 'mysql';
  if (!requireDatabase) return Object.freeze({ mode: parsed.data.SFOA_CONTROL_PLANE_MODE });
  if (!parsed.data.SFOA_DB_HOST || !parsed.data.SFOA_DB_USER || parsed.data.SFOA_DB_PASSWORD === undefined) {
    throw configurationError('SFOA_DB_HOST, SFOA_DB_USER, and SFOA_DB_PASSWORD are required for MySQL Control Plane operations.');
  }

  return Object.freeze({
    mode: parsed.data.SFOA_CONTROL_PLANE_MODE,
    database: Object.freeze({
      host: parsed.data.SFOA_DB_HOST,
      port: parsed.data.SFOA_DB_PORT,
      database: parsed.data.SFOA_DB_NAME,
      user: parsed.data.SFOA_DB_USER,
      password: parsed.data.SFOA_DB_PASSWORD,
      sslMode: parsed.data.SFOA_DB_SSL_MODE,
      connectionLimit: parsed.data.SFOA_DB_CONNECTION_LIMIT,
      queueLimit: parsed.data.SFOA_DB_QUEUE_LIMIT,
      connectTimeoutMs: parsed.data.SFOA_DB_CONNECT_TIMEOUT_MS,
    }),
  });
}

export function databaseNameForTest(config: DatabaseConfig): string {
  return config.database.endsWith('_test') ? config.database : `${config.database}_test`;
}

async function readLocalEnvironment(projectRoot: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(path.join(projectRoot, '.env.local'), 'utf8'));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return {};
    throw error;
  }
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    values[match[1]] = unquote(match[2].trim());
  }
  return values;
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value.at(0);
  const last = value.at(-1);
  return (first === '"' && last === '"') || (first === "'" && last === "'") ? value.slice(1, -1) : value;
}

function configurationError(message: string): ControlPlaneError {
  return new ControlPlaneError('MCP_CONTROL_PLANE_CONFIGURATION_INVALID', `Invalid P5 Control Plane configuration: ${message}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

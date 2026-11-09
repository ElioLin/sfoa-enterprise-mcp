import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ADMIN_MODULE_IDS, adminModuleIdSchema, parseEnvFile, type AdminModuleId } from '@sfoa/control-plane';

/**
 * ADR-0034: one Console login. The bootstrap Admin from SFOA_ADMIN_USERNAME is `fullAccess`
 * — it holds every module and every endpoint, including endpoints added after this release.
 * Every other account is bounded by its `modules` list and is refused with 403 outside it.
 */
export type AdminAccount = Readonly<{
  username: string;
  password: string;
  fullAccess: boolean;
  modules: readonly AdminModuleId[];
}>;

export type AdminApiConfig = Readonly<{
  bindHost: string;
  port: number;
  allowedOrigin: string;
  username: string;
  password: string;
  /**
   * ADR-0034: every Console account that may sign in — the bootstrap Admin first, then
   * SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON in file order. Authentication always visits the whole
   * list (see AdminSessionManager.matchCredentials); authorization resolves the caller from it
   * on every request.
   */
  accounts: readonly AdminAccount[];
  sessionSecret: string;
  sessionTtlSeconds: number;
  cookieSecure: boolean;
  cookieName: string;
  loginMaxAttempts: number;
  loginWindowMs: number;
  /** Bound for one interactive UI snapshot refresh; the DB lease follows it. */
  uiSnapshotRefreshTimeoutMs?: number;
}>;

const rawSchema = z.object({
  SFOA_ADMIN_BIND_HOST: z.string().trim().min(1).max(255).default('127.0.0.1'),
  SFOA_ADMIN_PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  SFOA_ADMIN_ALLOWED_ORIGIN: z.string().url().default('http://127.0.0.1:5173'),
  SFOA_ADMIN_USERNAME: z.string().trim().min(1).max(128),
  SFOA_ADMIN_PASSWORD: z.string().min(1).max(1024)
    .refine((value) => value.trim().length > 0, 'must contain at least one non-padding character'),
  SFOA_ADMIN_SESSION_SECRET: z.string().min(32).max(4096)
    .refine((value) => value.trim().length >= 32, 'must contain at least 32 non-padding characters'),
  SFOA_ADMIN_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(28_800),
  SFOA_ADMIN_COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  SFOA_ADMIN_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  SFOA_ADMIN_LOGIN_WINDOW_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(900_000),
  SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON: z.string().max(65_536).optional(),
  SFOA_UI_SNAPSHOT_REFRESH_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(900_000).default(180_000),
}).strict();

const NAMES = [
  'SFOA_ADMIN_BIND_HOST', 'SFOA_ADMIN_PORT', 'SFOA_ADMIN_ALLOWED_ORIGIN', 'SFOA_ADMIN_USERNAME',
  'SFOA_ADMIN_PASSWORD', 'SFOA_ADMIN_SESSION_SECRET', 'SFOA_ADMIN_SESSION_TTL_SECONDS',
  'SFOA_ADMIN_COOKIE_SECURE', 'SFOA_ADMIN_LOGIN_MAX_ATTEMPTS', 'SFOA_ADMIN_LOGIN_WINDOW_MS',
  'SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON',
] as const;

const MAX_ADDITIONAL_ACCOUNTS = 16;

const additionalAccountSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024)
    .refine((value) => value.trim().length > 0, 'must contain at least one non-padding character'),
  modules: z.array(adminModuleIdSchema).min(1).max(ADMIN_MODULE_IDS.length),
}).strict();

/**
 * ADR-0034: SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON is a strict JSON array of
 * `{ "username": string, "password": string, "modules": string[] }`. Every defect is fatal at
 * startup: a partially understood authorization file must never boot a Console that grants
 * more than the operator wrote. `modules` is mandatory on purpose — an omitted list is an
 * error, never a silent "all modules". Account usernames are compared case-insensitively for
 * uniqueness (two accounts must not differ only by case) but sign-in itself is exact.
 */
function parseAdditionalAccounts(raw: string | undefined, bootstrapUsername: string): readonly AdminAccount[] {
  if (raw === undefined) return Object.freeze([]);
  const shape = 'SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON must be a JSON array of { "username", "password", "modules" } objects.';
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(shape);
  }
  if (!Array.isArray(decoded)) throw new Error(shape);
  if (decoded.length > MAX_ADDITIONAL_ACCOUNTS) {
    throw new Error(`SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON must not configure more than ${MAX_ADDITIONAL_ACCOUNTS} accounts.`);
  }
  const seen = new Map<string, string>([[accountKey(bootstrapUsername), 'SFOA_ADMIN_USERNAME']]);
  const accounts = decoded.map((entry, index) => {
    const parsed = additionalAccountSchema.safeParse(entry);
    if (!parsed.success) {
      const detail = parsed.error.issues.slice(0, 5)
        .map((issue) => `${issue.path.join('.') || 'entry'}: ${issue.message}`)
        .join('; ');
      throw new Error(`SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON[${index}] is invalid (${detail}).`);
    }
    if (new Set(parsed.data.modules).size !== parsed.data.modules.length) {
      throw new Error(`SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON[${index}].modules must not repeat a module id.`);
    }
    const label = `SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON[${index}].username`;
    const key = accountKey(parsed.data.username);
    const previous = seen.get(key);
    if (previous) {
      throw new Error(`${label} duplicates ${previous}; Console usernames must be unique and are compared case-insensitively.`);
    }
    seen.set(key, label);
    return Object.freeze({
      username: parsed.data.username,
      password: parsed.data.password,
      fullAccess: false,
      modules: Object.freeze([...parsed.data.modules]),
    });
  });
  return Object.freeze(accounts);
}

function accountKey(username: string): string {
  return username.toLocaleLowerCase('en-US');
}

export async function loadAdminApiConfig(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AdminApiConfig> {
  let fileValues: Record<string, string> = {};
  try { fileValues = parseEnvFile(await readFile(path.join(path.resolve(projectRoot), '.env.local'), 'utf8')); }
  catch (error) { if (!(isNodeError(error) && error.code === 'ENOENT')) throw error; }
  const combined = Object.fromEntries(NAMES.map((name) => {
    const value = environment[name] ?? fileValues[name];
    return [name, value?.trim() ? value : undefined];
  }));
  const parsed = rawSchema.parse(combined);
  const origin = new URL(parsed.SFOA_ADMIN_ALLOWED_ORIGIN);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('SFOA_ADMIN_ALLOWED_ORIGIN must be an exact credential-free HTTP(S) origin.');
  }
  if (environment.NODE_ENV === 'production' && origin.protocol !== 'https:') {
    throw new Error('SFOA_ADMIN_ALLOWED_ORIGIN must use HTTPS when NODE_ENV=production.');
  }
  if (/\s|[\u0000-\u001F\u007F/\\]/u.test(parsed.SFOA_ADMIN_BIND_HOST)) {
    throw new Error('SFOA_ADMIN_BIND_HOST must be a hostname or IP address without a scheme or path.');
  }
  if (environment.NODE_ENV === 'production' && parsed.SFOA_ADMIN_COOKIE_SECURE === 'false') {
    throw new Error('SFOA_ADMIN_COOKIE_SECURE cannot be disabled when NODE_ENV=production.');
  }
  const cookieSecure = environment.NODE_ENV === 'production' || parsed.SFOA_ADMIN_COOKIE_SECURE === 'true';
  const accounts = Object.freeze([
    Object.freeze({
      username: parsed.SFOA_ADMIN_USERNAME,
      password: parsed.SFOA_ADMIN_PASSWORD,
      fullAccess: true,
      modules: Object.freeze([...ADMIN_MODULE_IDS]),
    }),
    ...parseAdditionalAccounts(parsed.SFOA_ADMIN_ADDITIONAL_ACCOUNTS_JSON, parsed.SFOA_ADMIN_USERNAME),
  ]);
  return Object.freeze({
    bindHost: parsed.SFOA_ADMIN_BIND_HOST,
    port: parsed.SFOA_ADMIN_PORT,
    allowedOrigin: origin.origin,
    username: parsed.SFOA_ADMIN_USERNAME,
    password: parsed.SFOA_ADMIN_PASSWORD,
    accounts,
    sessionSecret: parsed.SFOA_ADMIN_SESSION_SECRET,
    sessionTtlSeconds: parsed.SFOA_ADMIN_SESSION_TTL_SECONDS,
    cookieSecure,
    cookieName: cookieSecure ? '__Host-sfoa_admin' : 'sfoa_admin',
    loginMaxAttempts: parsed.SFOA_ADMIN_LOGIN_MAX_ATTEMPTS,
    loginWindowMs: parsed.SFOA_ADMIN_LOGIN_WINDOW_MS,
    uiSnapshotRefreshTimeoutMs: parsed.SFOA_UI_SNAPSHOT_REFRESH_TIMEOUT_MS,
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

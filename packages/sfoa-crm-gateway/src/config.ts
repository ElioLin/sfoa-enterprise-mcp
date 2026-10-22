import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadControlPlaneConfig, type DatabaseConfig } from '@sfoa/control-plane';

/**
 * CRM 接入服务的全部配置。
 *
 * 只提交模板；公钥文件由部署时放置，服务令牌、数据库口令和 TLS 私钥都不进入 Git。
 */

export type CrmGatewayConfig = Readonly<{
  bindHost: string;
  port: number;
  basePath: string;
  publicOrigin?: string;
  allowedOrigins: readonly string[];
  trustProxy: boolean;
  database: DatabaseConfig;
  openclawBaseUrl: string;
  openclawServiceToken: string;
  /**
   * Server-side Gateway credential used only for the CRM history route
   * (`auth:"gateway"` + trusted-operator). It is never used as a user identity.
   * Prefer a dedicated read-only device token; the shared Gateway token is a
   * documented fallback.
   */
  gatewayHistoryToken: string;
  apex: Readonly<{
    publicKeyPath: string;
    certificateSha256?: string;
    issuer: string;
    audience: string;
    allowedOrgIds: readonly string[];
    maxAgeMs: number;
    maxTtlMs: number;
    clockSkewMs: number;
  }>;
  chatTokenTtlMs: number;
  bootstrapNonceRetentionMs: number;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  maxMessageChars: number;
  historyLimitMax: number;
  conversationListLimit: number;
  runStaleAfterMs: number;
  cleanupIntervalMs: number;
  tls?: Readonly<{ keyPath: string; certPath: string }>;
}>;

const headerTokenSchema = z.string().min(32).max(4096).regex(/^\S+$/u);

const rawSchema = z.object({
  CRM_BIND_HOST: z.string().trim().min(1).max(255).default('127.0.0.1'),
  CRM_PORT: z.coerce.number().int().min(1).max(65535).default(8090),
  CRM_BASE_PATH: z.string().trim().min(1).max(128).default('/crm'),
  CRM_PUBLIC_ORIGIN: z.string().trim().max(2048).optional(),
  CRM_ALLOWED_ORIGINS: z.string().trim().min(1).max(4096),
  CRM_TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  CRM_OPENCLAW_URL: z.string().trim().min(1).max(2048),
  CRM_OPENCLAW_SERVICE_TOKEN: headerTokenSchema,
  CRM_GATEWAY_HISTORY_TOKEN: headerTokenSchema,
  CRM_APEX_PUBLIC_KEY_PATH: z.string().trim().min(1).max(1024),
  CRM_APEX_CERT_SHA256: z.string().trim().regex(/^[0-9a-f]{64}$/iu).optional(),
  CRM_APEX_ISSUER: z.string().trim().min(1).max(128),
  CRM_APEX_AUDIENCE: z.string().trim().min(1).max(128),
  CRM_APEX_ALLOWED_ORG_IDS: z.string().trim().min(15).max(1024),
  CRM_APEX_MAX_AGE_MS: z.coerce.number().int().min(30_000).max(600_000).default(120_000),
  CRM_APEX_MAX_TTL_MS: z.coerce.number().int().min(30_000).max(300_000).default(120_000),
  CRM_APEX_CLOCK_SKEW_MS: z.coerce.number().int().min(0).max(120_000).default(30_000),
  CRM_CHAT_TOKEN_TTL_MS: z.coerce.number().int().min(300_000).max(3_600_000).default(900_000),
  CRM_BOOTSTRAP_NONCE_RETENTION_MS: z.coerce.number().int().min(600_000).max(86_400_000).default(600_000),
  CRM_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(65_536),
  CRM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(900_000).default(660_000),
  CRM_MAX_MESSAGE_CHARS: z.coerce.number().int().min(1).max(32_000).default(16_000),
  CRM_HISTORY_LIMIT_MAX: z.coerce.number().int().min(1).max(200).default(100),
  CRM_CONVERSATION_LIST_LIMIT: z.coerce.number().int().min(1).max(100).default(50),
  CRM_RUN_STALE_AFTER_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(900_000),
  CRM_CLEANUP_INTERVAL_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(300_000),
  CRM_TLS_KEY_PATH: z.string().trim().min(1).max(1024).optional(),
  CRM_TLS_CERT_PATH: z.string().trim().min(1).max(1024).optional(),
}).strict();

const ENV_NAMES = [
  'CRM_BIND_HOST',
  'CRM_PORT',
  'CRM_BASE_PATH',
  'CRM_PUBLIC_ORIGIN',
  'CRM_ALLOWED_ORIGINS',
  'CRM_TRUST_PROXY',
  'CRM_OPENCLAW_URL',
  'CRM_OPENCLAW_SERVICE_TOKEN',
  'CRM_GATEWAY_HISTORY_TOKEN',
  'CRM_APEX_PUBLIC_KEY_PATH',
  'CRM_APEX_CERT_SHA256',
  'CRM_APEX_ISSUER',
  'CRM_APEX_AUDIENCE',
  'CRM_APEX_ALLOWED_ORG_IDS',
  'CRM_APEX_MAX_AGE_MS',
  'CRM_APEX_MAX_TTL_MS',
  'CRM_APEX_CLOCK_SKEW_MS',
  'CRM_CHAT_TOKEN_TTL_MS',
  'CRM_BOOTSTRAP_NONCE_RETENTION_MS',
  'CRM_MAX_BODY_BYTES',
  'CRM_REQUEST_TIMEOUT_MS',
  'CRM_MAX_MESSAGE_CHARS',
  'CRM_HISTORY_LIMIT_MAX',
  'CRM_CONVERSATION_LIST_LIMIT',
  'CRM_RUN_STALE_AFTER_MS',
  'CRM_CLEANUP_INTERVAL_MS',
  'CRM_TLS_KEY_PATH',
  'CRM_TLS_CERT_PATH',
] as const;

export async function loadCrmGatewayConfig(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CrmGatewayConfig> {
  const resolvedRoot = path.resolve(projectRoot);
  const controlPlane = await loadControlPlaneConfig(resolvedRoot, environment, { requireDatabase: true });
  if (!controlPlane.database) throw new Error('CRM gateway requires the MySQL Control Plane database.');
  const fileValues = await readLocalEnvironment(resolvedRoot);
  const combined: Record<string, string | undefined> = {};
  for (const name of ENV_NAMES) {
    const value = environment[name] ?? fileValues[name];
    combined[name] = value === undefined || value.trim() === '' ? undefined : value.trim();
  }
  const parsed = rawSchema.safeParse(combined);
  if (!parsed.success) {
    throw new Error(
      `Invalid CRM gateway configuration: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    );
  }

  const bindHost = parsed.data.CRM_BIND_HOST;
  if (/\s|[\u0000-\u001F\u007F/\\]/u.test(bindHost)) {
    throw new Error('CRM_BIND_HOST must be a hostname or IP address without a scheme or path.');
  }
  const basePath = normalizeBasePath(parsed.data.CRM_BASE_PATH);
  const allowedOrigins = parseAllowedOrigins(parsed.data.CRM_ALLOWED_ORIGINS);
  const openclawBaseUrl = normalizeOpenClawBaseUrl(parsed.data.CRM_OPENCLAW_URL);
  const allowedOrgIds = parseOrgIds(parsed.data.CRM_APEX_ALLOWED_ORG_IDS);
  const publicOrigin = parsed.data.CRM_PUBLIC_ORIGIN === undefined
    ? undefined
    : parseOrigin(parsed.data.CRM_PUBLIC_ORIGIN, 'CRM_PUBLIC_ORIGIN');
  const tls = parseTls(parsed.data);

  return Object.freeze({
    bindHost,
    port: parsed.data.CRM_PORT,
    basePath,
    ...(publicOrigin ? { publicOrigin } : {}),
    allowedOrigins,
    trustProxy: parsed.data.CRM_TRUST_PROXY,
    database: controlPlane.database,
    openclawBaseUrl,
    openclawServiceToken: parsed.data.CRM_OPENCLAW_SERVICE_TOKEN,
    gatewayHistoryToken: parsed.data.CRM_GATEWAY_HISTORY_TOKEN,
    apex: Object.freeze({
      publicKeyPath: parsed.data.CRM_APEX_PUBLIC_KEY_PATH,
      ...(parsed.data.CRM_APEX_CERT_SHA256 ? { certificateSha256: parsed.data.CRM_APEX_CERT_SHA256.toLocaleLowerCase('en-US') } : {}),
      issuer: parsed.data.CRM_APEX_ISSUER,
      audience: parsed.data.CRM_APEX_AUDIENCE,
      allowedOrgIds,
      maxAgeMs: parsed.data.CRM_APEX_MAX_AGE_MS,
      maxTtlMs: parsed.data.CRM_APEX_MAX_TTL_MS,
      clockSkewMs: parsed.data.CRM_APEX_CLOCK_SKEW_MS,
    }),
    chatTokenTtlMs: parsed.data.CRM_CHAT_TOKEN_TTL_MS,
    bootstrapNonceRetentionMs: parsed.data.CRM_BOOTSTRAP_NONCE_RETENTION_MS,
    maxBodyBytes: parsed.data.CRM_MAX_BODY_BYTES,
    requestTimeoutMs: parsed.data.CRM_REQUEST_TIMEOUT_MS,
    maxMessageChars: parsed.data.CRM_MAX_MESSAGE_CHARS,
    historyLimitMax: parsed.data.CRM_HISTORY_LIMIT_MAX,
    conversationListLimit: parsed.data.CRM_CONVERSATION_LIST_LIMIT,
    runStaleAfterMs: parsed.data.CRM_RUN_STALE_AFTER_MS,
    cleanupIntervalMs: parsed.data.CRM_CLEANUP_INTERVAL_MS,
    ...(tls ? { tls } : {}),
  });
}

function normalizeBasePath(value: string): string {
  if (!/^\/[A-Za-z0-9/_-]{0,127}$/u.test(value) || value.endsWith('/')) {
    throw new Error('CRM_BASE_PATH must start with "/" and must not end with "/".');
  }
  return value;
}

function normalizeOpenClawBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CRM_OPENCLAW_URL must be an absolute http(s) URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('CRM_OPENCLAW_URL must use http or https.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('CRM_OPENCLAW_URL must not contain credentials, a query or a fragment.');
  }
  const pathname = url.pathname.replace(/\/+$/u, '');
  if (pathname.length === 0 || pathname === '/') {
    throw new Error('CRM_OPENCLAW_URL must name the plugin ingress path (for example /plugins/sfoa-crm).');
  }
  return `${url.origin}${pathname}`;
}

function parseAllowedOrigins(value: string): readonly string[] {
  const entries = value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new Error('CRM_ALLOWED_ORIGINS must contain at least one exact origin.');
  const origins = entries.map((entry) => parseOrigin(entry, 'CRM_ALLOWED_ORIGINS'));
  return Object.freeze([...new Set(origins)]);
}

function parseOrigin(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must contain absolute origins such as https://example.lightning.force.com.`);
  }
  if (url.origin !== value || url.username || url.password || url.search || url.hash) {
    throw new Error(`${field} must contain exact origins without a path, query or fragment.`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error(`${field} must use https for non-loopback hosts.`);
  }
  return url.origin;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLocaleLowerCase('en-US');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function parseOrgIds(value: string): readonly string[] {
  const ids = value.split(',').map((entry) => entry.trim().toUpperCase()).filter((entry) => entry.length > 0);
  if (ids.length === 0) throw new Error('CRM_APEX_ALLOWED_ORG_IDS must contain at least one Salesforce org id.');
  for (const id of ids) {
    if (!/^[A-Z0-9]{15}(?:[A-Z0-9]{3})?$/u.test(id)) {
      throw new Error('CRM_APEX_ALLOWED_ORG_IDS must contain 15- or 18-character Salesforce org ids.');
    }
  }
  return Object.freeze([...new Set(ids)]);
}

function parseTls(data: z.infer<typeof rawSchema>): Readonly<{ keyPath: string; certPath: string }> | undefined {
  if (data.CRM_TLS_KEY_PATH === undefined && data.CRM_TLS_CERT_PATH === undefined) return undefined;
  if (data.CRM_TLS_KEY_PATH === undefined || data.CRM_TLS_CERT_PATH === undefined) {
    throw new Error('CRM_TLS_KEY_PATH and CRM_TLS_CERT_PATH must be configured together.');
  }
  return Object.freeze({ keyPath: data.CRM_TLS_KEY_PATH, certPath: data.CRM_TLS_CERT_PATH });
}

export async function readLocalEnvironment(projectRoot: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(path.join(projectRoot, '.env.local'), 'utf8');
  } catch {
    return {};
  }
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

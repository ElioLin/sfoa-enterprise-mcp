import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SFOA_CONTEXT_TOOL_ROLES,
  isSfoaContextToolName,
} from '@sfoa/mcp-provider-sfoa-context';
import {
  loadIdentityRuntimeConfig,
  parseEnvFile,
  RuntimeConfigurationError,
  type IdentityRuntimeConfig,
} from '@sfoa/identity-runtime';
import {
  DmlRuntimeError,
  parseDmlAllowlistJson,
  type DmlAllowlistPolicy,
} from '@sfoa/mcp-provider-sfoa-dml';
import { z } from 'zod';
import {
  loadControlPlaneConfig,
  USER_BOUND_TOKEN_PREFIX,
  type ControlPlaneConfig,
} from '@sfoa/control-plane';
import { DEFAULT_RUNTIME_ENABLED_TOOLS } from './tool-governance.js';
import { RemoteRuntimeError } from './errors.js';
import { timingSafeTokenEqual } from './authenticator.js';

export type RemoteAuthMode = 'internal_bearer' | 'disabled';

export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 180_000;
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 120_000;

export const DEFAULT_BUNTU_VALIDATE_TIMEOUT_MS = 5_000;
export const MIN_BUNTU_VALIDATE_TIMEOUT_MS = 500;
export const MAX_BUNTU_VALIDATE_TIMEOUT_MS = 30_000;

export type BuntuIdentityConfig = Readonly<{
  enabled: boolean;
  validateTokenUrl?: string;
  timeoutMs: number;
  rawTokenAuditEnabled: boolean;
}>;

export type RemoteRuntimeConfig = Readonly<{
  identity: IdentityRuntimeConfig;
  controlPlane: ControlPlaneConfig;
  bindHost: string;
  port: number;
  mcpPath: string;
  publicUrl?: string;
  lightningBaseUrl?: string;
  authMode: RemoteAuthMode;
  clientToken?: string;
  wecomChannelEnabled?: boolean;
  wecomClientToken?: string;
  /**
   * Primary HTTP header that carries the authenticated platform user id for
   * header-based (internal service) identities. Its value maps to
   * `INTERNAL_SERVICE_HEADER`. Never renamed for a partner channel such as WeCom:
   * add an alias below instead, so existing internal clients keep working.
   */
  platformUserHeader: string;
  /** Extra HTTP headers accepted as platform identity headers (e.g. `X-WeCom-User-Id`). */
  platformUserHeaderAliases: readonly string[];
  /**
   * Full ordered allowlist of platform identity header names = primary header
   * first, then each alias. The runtime only reads identity from these headers
   * and never from arbitrary `X-*-User-Id` headers.
   */
  platformIdentityHeaders: readonly string[];
  maxBodyBytes: number;
  requestTimeoutMs: number;
  toolTimeoutMs: number;
  enabledTools: readonly string[];
  dmlAllowlist: DmlAllowlistPolicy;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  useLoopbackHostDefaults: boolean;
  useLoopbackOriginDefaults: boolean;
  buntuIdentity: BuntuIdentityConfig;
}>;

const headerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u, 'must be a valid HTTP header name');

const optionalUrlSchema = z.preprocess(
  (value) => typeof value === 'string' && value.trim().length === 0 ? undefined : value,
  z.string().trim().url().max(2048).optional(),
);

const rawRemoteConfigSchema = z
  .object({
    MCP_BIND_HOST: z.string().trim().min(1).max(255).default('127.0.0.1'),
    MCP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    MCP_PATH: z.string().trim().min(1).max(255).default('/mcp'),
    MCP_PUBLIC_URL: z.string().trim().url().max(2048).optional(),
    SFOA_LIGHTNING_BASE_URL: optionalUrlSchema,
    MCP_AUTH_MODE: z.enum(['internal_bearer', 'disabled']).default('internal_bearer'),
    MCP_CLIENT_TOKEN: z.string().min(16).max(4096).optional(),
    MCP_WECOM_CHANNEL_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
    MCP_WECOM_CLIENT_TOKEN: z.string().min(32).max(4096).regex(/^\S+$/u).optional(),
    MCP_PLATFORM_USER_HEADER: headerNameSchema.default('X-Platform-User-Id'),
    MCP_PLATFORM_USER_HEADER_ALIASES: z.string().trim().max(2048).optional(),
    MCP_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(10_485_760).default(1_048_576),
    MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(900_000).default(DEFAULT_MCP_REQUEST_TIMEOUT_MS),
    MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().min(100).max(900_000).default(DEFAULT_MCP_TOOL_TIMEOUT_MS),
    MCP_ENABLED_TOOLS: z.string().trim().default(DEFAULT_RUNTIME_ENABLED_TOOLS.join(',')),
    MCP_DML_ALLOWLIST_JSON: z.string().max(65_536).optional(),
    MCP_ALLOWED_HOSTS: z.string().trim().optional(),
    MCP_ALLOWED_ORIGINS: z.string().trim().optional(),
    MCP_BUNTU_IDENTITY_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    MCP_BUNTU_VALIDATE_TOKEN_URL: z.string().trim().max(2048).optional(),
    MCP_BUNTU_VALIDATE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(MIN_BUNTU_VALIDATE_TIMEOUT_MS)
      .max(MAX_BUNTU_VALIDATE_TIMEOUT_MS)
      .default(DEFAULT_BUNTU_VALIDATE_TIMEOUT_MS),
    MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

const REMOTE_ENVIRONMENT_NAMES = [
  'MCP_BIND_HOST',
  'MCP_PORT',
  'MCP_PATH',
  'MCP_PUBLIC_URL',
  'SFOA_LIGHTNING_BASE_URL',
  'MCP_AUTH_MODE',
  'MCP_CLIENT_TOKEN',
  'MCP_WECOM_CHANNEL_ENABLED',
  'MCP_WECOM_CLIENT_TOKEN',
  'MCP_PLATFORM_USER_HEADER',
  'MCP_PLATFORM_USER_HEADER_ALIASES',
  'MCP_MAX_BODY_BYTES',
  'MCP_REQUEST_TIMEOUT_MS',
  'MCP_TOOL_TIMEOUT_MS',
  'MCP_ENABLED_TOOLS',
  'MCP_DML_ALLOWLIST_JSON',
  'MCP_ALLOWED_HOSTS',
  'MCP_ALLOWED_ORIGINS',
  'MCP_BUNTU_IDENTITY_ENABLED',
  'MCP_BUNTU_VALIDATE_TOKEN_URL',
  'MCP_BUNTU_VALIDATE_TIMEOUT_MS',
  'MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED',
] as const;

export async function loadRemoteRuntimeConfig(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RemoteRuntimeConfig> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const controlPlane = await loadControlPlaneConfig(resolvedProjectRoot, environment);
  let identity: IdentityRuntimeConfig;
  try {
    identity = await loadIdentityRuntimeConfig(resolvedProjectRoot, environment, {
      routesFromDatabase: controlPlane.mode === 'mysql',
    });
  } catch (error) {
    if (
      error instanceof RuntimeConfigurationError &&
      error.message.startsWith('SFOA_DIAGNOSTIC_USERNAME')
    ) {
      throw new RemoteRuntimeError('MCP_DIAGNOSTIC_CONFIGURATION_INVALID', error.message, { cause: error });
    }
    throw error;
  }
  const fileValues = await readLocalEnvironment(resolvedProjectRoot);
  const combined: Record<string, string | undefined> = {};
  for (const name of REMOTE_ENVIRONMENT_NAMES) {
    const value = environment[name] ?? fileValues[name];
    combined[name] = value?.trim() ? value : undefined;
  }

  const parsed = rawRemoteConfigSchema.safeParse(combined);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new RemoteRuntimeError(
      'MCP_RUNTIME_CONFIGURATION_INVALID',
      `Invalid P2 remote runtime configuration: ${details}`,
    );
  }

  const bindHost = parsed.data.MCP_BIND_HOST.toLocaleLowerCase('en-US');
  if (/\s|[\u0000-\u001F\u007F/\\]/u.test(bindHost)) {
    throw configurationError('MCP_BIND_HOST must be a hostname or IP address without a scheme or path.');
  }
  const loopback = isLoopbackBindHost(bindHost);
  if (parsed.data.MCP_AUTH_MODE === 'disabled' && !loopback) {
    throw configurationError('MCP_AUTH_MODE=disabled is allowed only for 127.0.0.1, localhost, or ::1.');
  }
  if (parsed.data.MCP_AUTH_MODE === 'internal_bearer' && !parsed.data.MCP_CLIENT_TOKEN) {
    throw configurationError('MCP_CLIENT_TOKEN is required when MCP_AUTH_MODE=internal_bearer.');
  }
  if (parsed.data.MCP_CLIENT_TOKEN?.startsWith(USER_BOUND_TOKEN_PREFIX)) {
    // P6-ID-01: USER_BOUND credentials (sfoa_ub1_...) are route-bound and live in MySQL,
    // never in MCP_CLIENT_TOKEN. Rejecting the prefix here fail-fast prevents a token that
    // looks USER_BOUND from silently downgrading the legacy internal bearer path.
    throw configurationError(
      `MCP_CLIENT_TOKEN must not use the reserved ${USER_BOUND_TOKEN_PREFIX} USER_BOUND prefix; configure an independent internal service token.`,
    );
  }
  assertValidTimeoutHierarchy(
    parsed.data.MCP_REQUEST_TIMEOUT_MS,
    parsed.data.MCP_TOOL_TIMEOUT_MS,
  );

  const buntuIdentity = parseBuntuIdentityConfig(parsed.data);
  const wecomClientToken = parsed.data.MCP_WECOM_CLIENT_TOKEN;
  if (wecomClientToken?.startsWith(USER_BOUND_TOKEN_PREFIX)
    || (wecomClientToken && parsed.data.MCP_CLIENT_TOKEN && timingSafeTokenEqual(wecomClientToken, parsed.data.MCP_CLIENT_TOKEN))) {
    throw configurationError('MCP_WECOM_CLIENT_TOKEN must be independent of Internal and USER_BOUND credentials.');
  }
  if (parsed.data.MCP_WECOM_CHANNEL_ENABLED && (!wecomClientToken || parsed.data.MCP_AUTH_MODE !== 'internal_bearer')) {
    throw configurationError('MCP_WECOM_CHANNEL_ENABLED=true requires MCP_WECOM_CLIENT_TOKEN and MCP_AUTH_MODE=internal_bearer.');
  }
  if (buntuIdentity.enabled && parsed.data.MCP_AUTH_MODE !== 'internal_bearer') {
    throw configurationError('MCP_BUNTU_IDENTITY_ENABLED=true requires MCP_AUTH_MODE=internal_bearer.');
  }
  // P6-ID-02 HOTFIX01: the BUNTU_TOKEN provider resolves the platform user id
  // (confirmed contract: `data.userId`) through the MySQL identity routes, so it
  // must fail fast at configuration time instead of silently starting a runtime
  // whose provider was never wired.
  if (buntuIdentity.enabled && controlPlane.mode !== 'mysql') {
    throw configurationError('BUNTU_TOKEN identity requires SFOA_CONTROL_PLANE_MODE=mysql.');
  }

  const mcpPath = normalizeMcpPath(parsed.data.MCP_PATH);
  const platformUserHeader = parsed.data.MCP_PLATFORM_USER_HEADER;
  if (RESERVED_PARTNER_IDENTITY_HEADER_NAMES.has(platformUserHeader.toLocaleLowerCase('en-US'))) {
    // P8-05: the primary platform user header is the trusted internal-service
    // channel. A reserved partner header (WeCom) as primary would misattribute
    // WeCom identity headers as internal provenance; it is reachable only via
    // MCP_PLATFORM_USER_HEADER_ALIASES.
    throw configurationError(
      `MCP_PLATFORM_USER_HEADER=${platformUserHeader} is a reserved partner identity header (WeCom). ` +
        'Configure partner headers only through MCP_PLATFORM_USER_HEADER_ALIASES; the primary header is the internal-service channel.',
    );
  }
  const platformUserHeaderAliases = parsePlatformUserHeaderAliases(
    parsed.data.MCP_PLATFORM_USER_HEADER_ALIASES,
    platformUserHeader,
  );
  if (parsed.data.MCP_WECOM_CHANNEL_ENABLED && !platformUserHeaderAliases.some(
    (alias) => alias.toLocaleLowerCase('en-US') === WECOM_USER_ID_HEADER_NAME,
  )) {
    // P8-06 HOTFIX01: the WeCom Channel credential executes against the
    // X-WeCom-User-Id platform identity header. Enabling the channel without
    // binding that alias would silently leave execution identity unmatchable,
    // so fail fast at configuration time.
    throw configurationError(
      'MCP_WECOM_CHANNEL_ENABLED=true requires MCP_PLATFORM_USER_HEADER_ALIASES to include X-WeCom-User-Id.',
    );
  }
  const publicUrl = parsed.data.MCP_PUBLIC_URL
    ? normalizePublicUrl(parsed.data.MCP_PUBLIC_URL)
    : undefined;
  const lightningBaseUrl = parsed.data.SFOA_LIGHTNING_BASE_URL
    ? normalizeLightningBaseUrl(parsed.data.SFOA_LIGHTNING_BASE_URL)
    : undefined;
  const allowedHosts = parseHosts(parsed.data.MCP_ALLOWED_HOSTS);
  if (!loopback && allowedHosts.length === 0) {
    throw configurationError('MCP_ALLOWED_HOSTS must be explicit when MCP_BIND_HOST is not loopback.');
  }
  const allowedOrigins = parseOrigins(parsed.data.MCP_ALLOWED_ORIGINS);
  const enabledTools = controlPlane.mode === 'mysql'
    ? Object.freeze([])
    : parseToolNames(parsed.data.MCP_ENABLED_TOOLS);
  if (controlPlane.mode === 'env' && enabledTools.length === 0) {
    throw configurationError('MCP_ENABLED_TOOLS must contain at least one explicitly enabled Tool.');
  }
  const diagnosticTools = enabledTools.filter(
    (name) => isSfoaContextToolName(name) && SFOA_CONTEXT_TOOL_ROLES[name] === 'DIAGNOSTIC',
  );
  if (controlPlane.mode === 'env' && diagnosticTools.length > 0 && !identity.diagnosticUsername) {
    throw new RemoteRuntimeError(
      'MCP_DIAGNOSTIC_CONFIGURATION_INVALID',
      `SFOA_DIAGNOSTIC_USERNAME is required when diagnostic Tools are enabled: ${diagnosticTools.join(', ')}.`,
    );
  }
  let dmlAllowlist: DmlAllowlistPolicy;
  try {
    dmlAllowlist = parseDmlAllowlistJson(
      controlPlane.mode === 'env' ? parsed.data.MCP_DML_ALLOWLIST_JSON : undefined,
    );
  } catch (error) {
    if (error instanceof DmlRuntimeError && error.code === 'MCP_DML_CONFIGURATION_INVALID') {
      throw new RemoteRuntimeError('MCP_DML_CONFIGURATION_INVALID', error.message, { cause: error });
    }
    throw error;
  }

  return Object.freeze({
    identity,
    controlPlane,
    bindHost,
    port: parsed.data.MCP_PORT,
    mcpPath,
    ...(publicUrl ? { publicUrl } : {}),
    ...(lightningBaseUrl ? { lightningBaseUrl } : {}),
    authMode: parsed.data.MCP_AUTH_MODE,
    wecomChannelEnabled: parsed.data.MCP_WECOM_CHANNEL_ENABLED,
    ...(wecomClientToken ? { wecomClientToken } : {}),
    ...(parsed.data.MCP_CLIENT_TOKEN ? { clientToken: parsed.data.MCP_CLIENT_TOKEN } : {}),
    platformUserHeader,
    platformUserHeaderAliases,
    platformIdentityHeaders: Object.freeze([platformUserHeader, ...platformUserHeaderAliases]),
    maxBodyBytes: parsed.data.MCP_MAX_BODY_BYTES,
    requestTimeoutMs: parsed.data.MCP_REQUEST_TIMEOUT_MS,
    toolTimeoutMs: parsed.data.MCP_TOOL_TIMEOUT_MS,
    enabledTools,
    dmlAllowlist,
    allowedHosts,
    allowedOrigins,
    useLoopbackHostDefaults: loopback && allowedHosts.length === 0,
    useLoopbackOriginDefaults: loopback && allowedOrigins.length === 0,
    buntuIdentity,
  });
}

function normalizePublicUrl(value: string): string {
  const parsed = new URL(value);
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw configurationError('MCP_PUBLIC_URL must be a credential-free HTTP(S) URL without a query or fragment.');
  }
  return parsed.href;
}

export function normalizeLightningBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.hostname.length === 0
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw configurationError('SFOA_LIGHTNING_BASE_URL must be a credential-free HTTPS origin without a path, query, or fragment.');
  }
  return parsed.origin;
}

export function isLoopbackBindHost(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(host.toLocaleLowerCase('en-US'));
}

export function assertValidTimeoutHierarchy(requestTimeoutMs: number, toolTimeoutMs: number): void {
  if (requestTimeoutMs <= toolTimeoutMs) {
    throw configurationError(
      'MCP_REQUEST_TIMEOUT_MS must be greater than MCP_TOOL_TIMEOUT_MS so a Tool deadline can normally complete within the HTTP request deadline.',
    );
  }
}

type ParsedBuntuIdentityFields = Readonly<{
  MCP_BUNTU_IDENTITY_ENABLED: boolean;
  MCP_BUNTU_VALIDATE_TOKEN_URL?: string;
  MCP_BUNTU_VALIDATE_TIMEOUT_MS: number;
  MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED: boolean;
}>;

function parseBuntuIdentityConfig(fields: ParsedBuntuIdentityFields): BuntuIdentityConfig {
  if (!fields.MCP_BUNTU_IDENTITY_ENABLED) {
    return Object.freeze({
      enabled: false,
      timeoutMs: fields.MCP_BUNTU_VALIDATE_TIMEOUT_MS,
      rawTokenAuditEnabled: fields.MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED,
    });
  }
  if (!fields.MCP_BUNTU_VALIDATE_TOKEN_URL) {
    throw configurationError('MCP_BUNTU_VALIDATE_TOKEN_URL is required when MCP_BUNTU_IDENTITY_ENABLED=true.');
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(fields.MCP_BUNTU_VALIDATE_TOKEN_URL);
  } catch {
    throw configurationError('MCP_BUNTU_VALIDATE_TOKEN_URL must be a valid absolute URL.');
  }
  if (
    !['http:', 'https:'].includes(parsedUrl.protocol) ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.hash
  ) {
    throw configurationError(
      'MCP_BUNTU_VALIDATE_TOKEN_URL must be a credential-free HTTP(S) URL without a fragment.',
    );
  }
  return Object.freeze({
    enabled: true,
    validateTokenUrl: parsedUrl.href,
    timeoutMs: fields.MCP_BUNTU_VALIDATE_TIMEOUT_MS,
    rawTokenAuditEnabled: fields.MCP_BUNTU_AUDIT_RAW_TOKEN_ENABLED,
  });
}

async function readLocalEnvironment(projectRoot: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(path.join(projectRoot, '.env.local'), 'utf8'));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return {};
    throw error;
  }
}

function normalizeMcpPath(value: string): string {
  if (!/^\/[A-Za-z0-9/_-]*$/u.test(value) || value.includes('//') || value === '/') {
    throw configurationError('MCP_PATH must be an absolute path such as /mcp without a query or fragment.');
  }
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function parseToolNames(value: string): readonly string[] {
  const names = uniqueCsv(value);
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(name)) {
      throw configurationError(`MCP_ENABLED_TOOLS contains an invalid Tool name: ${name}.`);
    }
  }
  return Object.freeze(names);
}

function parseHosts(value: string | undefined): readonly string[] {
  if (!value) return Object.freeze([]);
  const hosts = uniqueCsv(value).map((host) => host.toLocaleLowerCase('en-US'));
  for (const host of hosts) {
    if (host === '*' || host.length > 255 || /\s|[\u0000-\u001F\u007F/\\]/u.test(host)) {
      throw configurationError(`MCP_ALLOWED_HOSTS contains an invalid exact Host value: ${host}.`);
    }
    try {
      if (new URL(`http://${host}`).host.toLocaleLowerCase('en-US') !== host) throw new Error('normalized host differs');
    } catch {
      throw configurationError(`MCP_ALLOWED_HOSTS contains an invalid exact Host value: ${host}.`);
    }
  }
  return Object.freeze(hosts);
}

function parseOrigins(value: string | undefined): readonly string[] {
  if (!value) return Object.freeze([]);
  const origins = uniqueCsv(value);
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw configurationError(`MCP_ALLOWED_ORIGINS contains an invalid origin: ${origin}.`);
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== origin
    ) {
      throw configurationError(`MCP_ALLOWED_ORIGINS must contain exact HTTP(S) origins: ${origin}.`);
    }
  }
  return Object.freeze(origins);
}

/**
 * Well-known partner identity-header names. A partner header such as
 * `X-WeCom-User-Id` names a distinct identity *channel* provenance
 * (`WECOM_HEADER`), so it must never be configured as the primary platform user
 * header, which is the trusted internal-service channel
 * (`INTERNAL_SERVICE_HEADER`). Partner headers are reachable only as configured
 * aliases. Keep in sync with `PLATFORM_IDENTITY_HEADER_SOURCE_BY_LOWER_NAME` in
 * authenticator.ts.
 */
// Always lower-case: HTTP header names are case-insensitive.
export const WECOM_USER_ID_HEADER_NAME = 'x-wecom-user-id';

const RESERVED_PARTNER_IDENTITY_HEADER_NAMES: ReadonlySet<string> = new Set([
  WECOM_USER_ID_HEADER_NAME,
]);

/**
 * Parses `MCP_PLATFORM_USER_HEADER_ALIASES`, a CSV of additional platform
 * identity HTTP header names (e.g. `X-WeCom-User-Id`).
 *
 * Rules (all enforced fail-fast as `MCP_RUNTIME_CONFIGURATION_INVALID`):
 * - the value may be empty / unset (no aliases);
 * - entries are trimmed and empty entries are dropped;
 * - every entry must be a legal HTTP header name (no control characters);
 * - header names are compared case-insensitively, so an alias must neither
 *   repeat the primary header nor repeat an earlier alias.
 */
export function parsePlatformUserHeaderAliases(
  value: string | undefined,
  primaryHeader: string,
): readonly string[] {
  if (value === undefined || value.trim().length === 0) return Object.freeze([]);
  const primaryLower = primaryHeader.toLocaleLowerCase('en-US');
  const seen = new Set<string>([primaryLower]);
  const aliases: string[] = [];
  for (const raw of value.split(',')) {
    const candidate = raw.trim();
    if (candidate.length === 0) continue;
    const parsed = headerNameSchema.safeParse(candidate);
    if (!parsed.success) {
      throw configurationError(
        `MCP_PLATFORM_USER_HEADER_ALIASES contains an invalid HTTP header name: ${candidate}.`,
      );
    }
    const lower = candidate.toLocaleLowerCase('en-US');
    if (seen.has(lower)) {
      throw configurationError(
        'MCP_PLATFORM_USER_HEADER_ALIASES must not repeat the primary platform user header or an earlier alias (comparison is case-insensitive).',
      );
    }
    seen.add(lower);
    aliases.push(parsed.data);
  }
  return Object.freeze(aliases);
}

function uniqueCsv(value: string): string[] {
  return [...new Set(value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function configurationError(message: string): RemoteRuntimeError {
  return new RemoteRuntimeError('MCP_RUNTIME_CONFIGURATION_INVALID', message);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

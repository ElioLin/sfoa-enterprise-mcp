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
  type ControlPlaneConfig,
} from '@sfoa/control-plane';
import { DEFAULT_ENABLED_TOOLS } from './tool-governance.js';
import { RemoteRuntimeError } from './errors.js';

export type RemoteAuthMode = 'internal_bearer' | 'disabled';

export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 180_000;
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 120_000;

export type RemoteRuntimeConfig = Readonly<{
  identity: IdentityRuntimeConfig;
  controlPlane: ControlPlaneConfig;
  bindHost: string;
  port: number;
  mcpPath: string;
  publicUrl?: string;
  authMode: RemoteAuthMode;
  clientToken?: string;
  platformUserHeader: string;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  toolTimeoutMs: number;
  enabledTools: readonly string[];
  dmlAllowlist: DmlAllowlistPolicy;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  useLoopbackHostDefaults: boolean;
  useLoopbackOriginDefaults: boolean;
}>;

const headerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u, 'must be a valid HTTP header name');

const rawRemoteConfigSchema = z
  .object({
    MCP_BIND_HOST: z.string().trim().min(1).max(255).default('127.0.0.1'),
    MCP_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    MCP_PATH: z.string().trim().min(1).max(255).default('/mcp'),
    MCP_PUBLIC_URL: z.string().trim().url().max(2048).optional(),
    MCP_AUTH_MODE: z.enum(['internal_bearer', 'disabled']).default('internal_bearer'),
    MCP_CLIENT_TOKEN: z.string().min(16).max(4096).optional(),
    MCP_PLATFORM_USER_HEADER: headerNameSchema.default('X-Platform-User-Id'),
    MCP_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(10_485_760).default(1_048_576),
    MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(900_000).default(DEFAULT_MCP_REQUEST_TIMEOUT_MS),
    MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().min(100).max(900_000).default(DEFAULT_MCP_TOOL_TIMEOUT_MS),
    MCP_ENABLED_TOOLS: z.string().trim().default(DEFAULT_ENABLED_TOOLS.join(',')),
    MCP_DML_ALLOWLIST_JSON: z.string().max(65_536).optional(),
    MCP_ALLOWED_HOSTS: z.string().trim().optional(),
    MCP_ALLOWED_ORIGINS: z.string().trim().optional(),
  })
  .strict();

const REMOTE_ENVIRONMENT_NAMES = [
  'MCP_BIND_HOST',
  'MCP_PORT',
  'MCP_PATH',
  'MCP_PUBLIC_URL',
  'MCP_AUTH_MODE',
  'MCP_CLIENT_TOKEN',
  'MCP_PLATFORM_USER_HEADER',
  'MCP_MAX_BODY_BYTES',
  'MCP_REQUEST_TIMEOUT_MS',
  'MCP_TOOL_TIMEOUT_MS',
  'MCP_ENABLED_TOOLS',
  'MCP_DML_ALLOWLIST_JSON',
  'MCP_ALLOWED_HOSTS',
  'MCP_ALLOWED_ORIGINS',
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
  assertValidTimeoutHierarchy(
    parsed.data.MCP_REQUEST_TIMEOUT_MS,
    parsed.data.MCP_TOOL_TIMEOUT_MS,
  );

  const mcpPath = normalizeMcpPath(parsed.data.MCP_PATH);
  const publicUrl = parsed.data.MCP_PUBLIC_URL
    ? normalizePublicUrl(parsed.data.MCP_PUBLIC_URL)
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
    authMode: parsed.data.MCP_AUTH_MODE,
    ...(parsed.data.MCP_CLIENT_TOKEN ? { clientToken: parsed.data.MCP_CLIENT_TOKEN } : {}),
    platformUserHeader: parsed.data.MCP_PLATFORM_USER_HEADER,
    maxBodyBytes: parsed.data.MCP_MAX_BODY_BYTES,
    requestTimeoutMs: parsed.data.MCP_REQUEST_TIMEOUT_MS,
    toolTimeoutMs: parsed.data.MCP_TOOL_TIMEOUT_MS,
    enabledTools,
    dmlAllowlist,
    allowedHosts,
    allowedOrigins,
    useLoopbackHostDefaults: loopback && allowedHosts.length === 0,
    useLoopbackOriginDefaults: loopback && allowedOrigins.length === 0,
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

function uniqueCsv(value: string): string[] {
  return [...new Set(value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function configurationError(message: string): RemoteRuntimeError {
  return new RemoteRuntimeError('MCP_RUNTIME_CONFIGURATION_INVALID', message);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

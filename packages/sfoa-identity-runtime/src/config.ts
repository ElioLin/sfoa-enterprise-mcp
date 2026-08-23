import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  createSalesforceIdentityRoute,
  normalizeSalesforceIdentity,
  type SalesforceIdentityRoute,
} from './contracts.js';
import type { MetadataSeed } from './workspace.js';

const usernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .refine((value) => !/\s/u.test(value), 'must not contain whitespace');
const identifierSchema = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]*$/u);

const rawConfigSchema = z
  .object({
    SFOA_INSTANCE_URL: z.string().trim().min(1),
    SALESFORCE_USERNAME: usernameSchema,
    SFOA_DIAGNOSTIC_USERNAME: usernameSchema.optional(),
    SECOND_TEST_USER: usernameSchema.optional(),
    CONNECTED_APP_CLIENT_ID: z.string().trim().min(1).max(512),
    JWT_PRIVATE_KEY_PATH: z.string().trim().min(1).max(2048),
    SALESFORCE_ALIAS: z.string().trim().min(1).max(255).optional(),
    TEST_OBJECT: identifierSchema.optional(),
    TEST_METADATA_TYPE: identifierSchema.optional(),
    TEST_METADATA_FULL_NAME: z.string().trim().min(1).max(512).optional(),
    P1_PLATFORM_USER_A: z.string().trim().min(1).max(128).default('p1-user-a'),
    P1_PLATFORM_USER_B: z.string().trim().min(1).max(128).default('p1-user-b'),
    P1_CONCURRENT_REQUESTS: z.coerce.number().int().min(20).max(50).default(20),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  })
  .strict();

const REQUIRED_RUNTIME_VARIABLES = [
  'SFOA_INSTANCE_URL',
  'SALESFORCE_USERNAME',
  'CONNECTED_APP_CLIENT_ID',
  'JWT_PRIVATE_KEY_PATH',
] as const;

const ENVIRONMENT_NAMES = [
  ...REQUIRED_RUNTIME_VARIABLES,
  'SECOND_TEST_USER',
  'SFOA_DIAGNOSTIC_USERNAME',
  'SALESFORCE_ALIAS',
  'TEST_OBJECT',
  'TEST_METADATA_TYPE',
  'TEST_METADATA_FULL_NAME',
  'P1_PLATFORM_USER_A',
  'P1_PLATFORM_USER_B',
  'P1_CONCURRENT_REQUESTS',
  'PORT',
] as const;

export type IdentityRuntimeConfig = Readonly<{
  projectRoot: string;
  instanceUrl: string;
  primaryUsername: string;
  secondaryUsername?: string;
  diagnosticUsername?: string;
  clientId: string;
  privateKeyPath: string;
  primaryAlias?: string;
  testObject?: string;
  metadataSeed?: MetadataSeed;
  platformUserA: string;
  platformUserB: string;
  concurrentRequests: number;
  port: number;
}>;

export class RuntimeConfigurationError extends Error {
  public constructor(
    message: string,
    public readonly missingVariables: readonly string[] = [],
  ) {
    super(message);
    this.name = 'RuntimeConfigurationError';
  }
}

export async function loadIdentityRuntimeConfig(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<IdentityRuntimeConfig> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  let fileValues: Record<string, string> = {};
  try {
    fileValues = parseEnvFile(await readFile(path.join(resolvedProjectRoot, '.env.local'), 'utf8'));
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }

  const combined: Record<string, string | undefined> = {};
  for (const name of ENVIRONMENT_NAMES) {
    const value = environment[name] ?? fileValues[name];
    combined[name] = value?.trim() ? value : undefined;
  }

  const missing = REQUIRED_RUNTIME_VARIABLES.filter((name) => !combined[name]);
  if (missing.length > 0) {
    throw new RuntimeConfigurationError(`Missing required P1 runtime configuration: ${missing.join(', ')}`, missing);
  }

  const parsed = rawConfigSchema.safeParse(combined);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new RuntimeConfigurationError(`Invalid P1 runtime configuration: ${details}`);
  }

  if (Boolean(parsed.data.TEST_METADATA_TYPE) !== Boolean(parsed.data.TEST_METADATA_FULL_NAME)) {
    throw new RuntimeConfigurationError(
      'TEST_METADATA_TYPE and TEST_METADATA_FULL_NAME must either both be supplied or both be omitted.',
    );
  }

  assertDiagnosticIdentityDistinct({
    primaryUsername: parsed.data.SALESFORCE_USERNAME,
    secondaryUsername: parsed.data.SECOND_TEST_USER,
    diagnosticUsername: parsed.data.SFOA_DIAGNOSTIC_USERNAME,
  });

  const privateKeyPath = path.isAbsolute(parsed.data.JWT_PRIVATE_KEY_PATH)
    ? path.normalize(parsed.data.JWT_PRIVATE_KEY_PATH)
    : path.resolve(resolvedProjectRoot, parsed.data.JWT_PRIVATE_KEY_PATH);
  const keyStats = await stat(privateKeyPath).catch(() => {
    throw new RuntimeConfigurationError('JWT_PRIVATE_KEY_PATH is not a readable file.');
  });
  if (!keyStats.isFile()) throw new RuntimeConfigurationError('JWT_PRIVATE_KEY_PATH must identify a file.');

  return Object.freeze({
    projectRoot: resolvedProjectRoot,
    instanceUrl: normalizeInstanceUrl(parsed.data.SFOA_INSTANCE_URL),
    primaryUsername: parsed.data.SALESFORCE_USERNAME,
    secondaryUsername: parsed.data.SECOND_TEST_USER,
    diagnosticUsername: parsed.data.SFOA_DIAGNOSTIC_USERNAME,
    clientId: parsed.data.CONNECTED_APP_CLIENT_ID,
    privateKeyPath,
    primaryAlias: parsed.data.SALESFORCE_ALIAS,
    testObject: parsed.data.TEST_OBJECT,
    metadataSeed:
      parsed.data.TEST_METADATA_TYPE && parsed.data.TEST_METADATA_FULL_NAME
        ? Object.freeze({ type: parsed.data.TEST_METADATA_TYPE, fullName: parsed.data.TEST_METADATA_FULL_NAME })
        : undefined,
    platformUserA: parsed.data.P1_PLATFORM_USER_A,
    platformUserB: parsed.data.P1_PLATFORM_USER_B,
    concurrentRequests: parsed.data.P1_CONCURRENT_REQUESTS,
    port: parsed.data.PORT,
  });
}

export function assertDiagnosticIdentityDistinct(
  config: Pick<IdentityRuntimeConfig, 'primaryUsername' | 'secondaryUsername' | 'diagnosticUsername'>,
): void {
  if (!config.diagnosticUsername) return;
  const diagnostic = normalizeSalesforceIdentity(config.diagnosticUsername);
  const userNames = [config.primaryUsername, config.secondaryUsername]
    .filter((value): value is string => value !== undefined)
    .map(normalizeSalesforceIdentity);
  if (userNames.includes(diagnostic)) {
    throw new RuntimeConfigurationError(
      'SFOA_DIAGNOSTIC_USERNAME must be distinct from every configured USER Salesforce username.',
    );
  }
}

export function buildIdentityRoutes(config: IdentityRuntimeConfig): readonly SalesforceIdentityRoute[] {
  const routes: SalesforceIdentityRoute[] = [
    createSalesforceIdentityRoute({
      platformUserId: config.platformUserA,
      salesforceUsername: config.primaryUsername,
      credentialProfile: 'sfoa-shared-jwt',
      connectionRole: 'USER',
      aliases: config.primaryAlias ? [config.primaryAlias] : [],
    }),
  ];
  if (config.secondaryUsername) {
    routes.push(
      createSalesforceIdentityRoute({
        platformUserId: config.platformUserB,
        salesforceUsername: config.secondaryUsername,
        credentialProfile: 'sfoa-shared-jwt',
        connectionRole: 'USER',
        aliases: [],
      }),
    );
  }
  return Object.freeze(routes);
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;
    values[match[1]] = unquote(match[2].trim());
  }
  return values;
}

function normalizeInstanceUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeConfigurationError('SFOA_INSTANCE_URL must be a valid absolute URL.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new RuntimeConfigurationError('SFOA_INSTANCE_URL must be a credential-free HTTPS host URL.');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new RuntimeConfigurationError('SFOA_INSTANCE_URL must be the SFoA host root.');
  }
  return parsed.origin;
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === '"' && last === '"') || (first === "'" && last === "'") ? value.slice(1, -1) : value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

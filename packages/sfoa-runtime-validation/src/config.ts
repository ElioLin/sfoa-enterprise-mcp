import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const REQUIRED_ENVIRONMENT_VARIABLES = [
  'SFOA_INSTANCE_URL',
  'SALESFORCE_USERNAME',
  'CONNECTED_APP_CLIENT_ID',
  'JWT_PRIVATE_KEY_PATH',
  'SALESFORCE_ALIAS',
  'TEST_OBJECT',
  'TEST_METADATA_TYPE',
  'TEST_METADATA_FULL_NAME',
] as const;

const rawConfigSchema = z.object({
  SFOA_INSTANCE_URL: z.string().trim().min(1),
  SALESFORCE_USERNAME: z.string().trim().min(1).max(320).refine((value) => !/\s/.test(value), {
    message: 'must not contain whitespace',
  }),
  CONNECTED_APP_CLIENT_ID: z.string().trim().min(1).max(512).refine((value) => !/\s/.test(value), {
    message: 'must not contain whitespace',
  }),
  JWT_PRIVATE_KEY_PATH: z.string().trim().min(1).max(2048),
  SALESFORCE_ALIAS: z.string().trim().min(1).max(255),
  TEST_OBJECT: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'must be a Salesforce object API name'),
  TEST_METADATA_TYPE: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'must be a Metadata API type'),
  TEST_METADATA_FULL_NAME: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), { message: 'must not contain control characters' }),
  SFOA_DEBUG_EXPOSE_TOKEN: z.enum(['true', 'false']).default('false'),
});

export type ValidationConfig = {
  projectRoot: string;
  instanceUrl: string;
  username: string;
  clientId: string;
  privateKeyPath: string;
  alias: string;
  testObject: string;
  metadataType: string;
  metadataFullName: string;
  debugExposeToken: boolean;
};

export class ConfigurationError extends Error {
  public constructor(
    message: string,
    public readonly missingVariables: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined) continue;

    values[match[1]] = unquote(match[2].trim());
  }

  return values;
}

export async function loadValidationConfig(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ValidationConfig> {
  const envFilePath = path.join(projectRoot, '.env.local');
  let fileValues: Record<string, string> = {};

  try {
    fileValues = parseEnvFile(await readFile(envFilePath, 'utf8'));
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }

  const combined: Record<string, string | undefined> = { ...fileValues };
  for (const name of [...REQUIRED_ENVIRONMENT_VARIABLES, 'SFOA_DEBUG_EXPOSE_TOKEN'] as const) {
    const processValue = environment[name];
    if (processValue !== undefined) combined[name] = processValue;
  }

  const missing = REQUIRED_ENVIRONMENT_VARIABLES.filter((name) => !combined[name]?.trim());
  if (missing.length > 0) {
    throw new ConfigurationError(
      `Missing required P0-Closure configuration: ${missing.join(', ')}`,
      missing,
    );
  }

  const parsed = rawConfigSchema.safeParse(combined);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new ConfigurationError(`Invalid P0-Closure configuration: ${details}`);
  }

  const instanceUrl = normalizeInstanceUrl(parsed.data.SFOA_INSTANCE_URL);
  const privateKeyPath = path.isAbsolute(parsed.data.JWT_PRIVATE_KEY_PATH)
    ? path.normalize(parsed.data.JWT_PRIVATE_KEY_PATH)
    : path.resolve(projectRoot, parsed.data.JWT_PRIVATE_KEY_PATH);
  const keyStats = await stat(privateKeyPath).catch((error: unknown) => {
    throw new ConfigurationError(
      `JWT_PRIVATE_KEY_PATH is not a readable file: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (!keyStats.isFile()) throw new ConfigurationError('JWT_PRIVATE_KEY_PATH must identify a file.');

  return {
    projectRoot: path.resolve(projectRoot),
    instanceUrl,
    username: parsed.data.SALESFORCE_USERNAME,
    clientId: parsed.data.CONNECTED_APP_CLIENT_ID,
    privateKeyPath,
    alias: parsed.data.SALESFORCE_ALIAS,
    testObject: parsed.data.TEST_OBJECT,
    metadataType: parsed.data.TEST_METADATA_TYPE,
    metadataFullName: parsed.data.TEST_METADATA_FULL_NAME,
    debugExposeToken: parsed.data.SFOA_DEBUG_EXPOSE_TOKEN === 'true',
  };
}

function normalizeInstanceUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError('SFOA_INSTANCE_URL must be a valid absolute URL.');
  }

  if (parsed.protocol !== 'https:') throw new ConfigurationError('SFOA_INSTANCE_URL must use HTTPS.');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ConfigurationError('SFOA_INSTANCE_URL must not contain credentials, query parameters, or fragments.');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new ConfigurationError('SFOA_INSTANCE_URL must be the SFoA host root, without an OAuth path.');
  }

  return parsed.origin;
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

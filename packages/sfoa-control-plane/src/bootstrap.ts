import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  normalizeSalesforceUsername,
  platformUserIdSchema,
  salesforceUsernameSchema,
  toolNameSchema,
} from './contracts.js';
import { ControlPlaneError } from './errors.js';
import { parseEnvFile } from './config.js';
import type { ControlPlaneRepositories } from './repositories.js';
import type { TransactionalControlPlaneStore } from './store.js';

export type BootstrapResult = Readonly<{
  forced: boolean;
  routesCreated: number;
  routesUpdated: number;
  toolsCreated: number;
  toolsUpdated: number;
  dmlPoliciesCreated: number;
  dmlPoliciesUpdated: number;
  diagnosticCreated: boolean;
  diagnosticUpdated: boolean;
  settingsCreated: number;
  settingsUpdated: number;
}>;

const dmlSchema = z.array(z.object({
  objectApiName: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/u),
  operations: z.array(z.enum(['CREATE', 'UPDATE'])).min(1).max(2),
}).strict()).max(1_000);

export async function bootstrapFromEnvironment(
  store: TransactionalControlPlaneStore,
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  force = false,
): Promise<BootstrapResult> {
  if (force && environment.NODE_ENV !== 'development' && environment.NODE_ENV !== 'test') {
    throw new ControlPlaneError(
      'MCP_ADMIN_INPUT_INVALID',
      '--force bootstrap requires NODE_ENV=development or NODE_ENV=test.',
    );
  }
  const values = await loadValues(projectRoot, environment);
  const routes = [
    values.SALESFORCE_USERNAME
      ? parseBootstrapRoute(values.P1_PLATFORM_USER_A || 'p1-user-a', values.SALESFORCE_USERNAME)
      : undefined,
    values.SECOND_TEST_USER
      ? parseBootstrapRoute(values.P1_PLATFORM_USER_B || 'p1-user-b', values.SECOND_TEST_USER)
      : undefined,
  ].filter((value): value is { platformUserId: string; userName: string; salesforceUsername: string } => value !== undefined);
  const enabledTools = uniqueCsv(values.MCP_ENABLED_TOOLS ?? '');
  const dmlPolicies = parseDml(values.MCP_DML_ALLOWLIST_JSON);
  const diagnostic = values.SFOA_DIAGNOSTIC_USERNAME
    ? {
        salesforceUsername: parseBootstrapValue(
          salesforceUsernameSchema,
          values.SFOA_DIAGNOSTIC_USERNAME,
          'SFOA_DIAGNOSTIC_USERNAME',
        ),
        enabled: true,
        testMetadataType: values.TEST_METADATA_TYPE || null,
        testMetadataFullName: values.TEST_METADATA_FULL_NAME || null,
      }
    : undefined;
  if (diagnostic && Boolean(diagnostic.testMetadataType) !== Boolean(diagnostic.testMetadataFullName)) {
    throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'Bootstrap metadata type and fullName must both be supplied or both omitted.');
  }
  if (diagnostic && routes.some((route) => normalizeSalesforceUsername(route.salesforceUsername) === normalizeSalesforceUsername(diagnostic.salesforceUsername))) {
    throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFLICT', 'Bootstrap Diagnostic username conflicts with a USER route.');
  }

  const counters = {
    forced: force,
    routesCreated: 0, routesUpdated: 0, toolsCreated: 0, toolsUpdated: 0,
    dmlPoliciesCreated: 0, dmlPoliciesUpdated: 0,
    diagnosticCreated: false, diagnosticUpdated: false,
    settingsCreated: 0, settingsUpdated: 0,
  };

  for (const route of routes) {
    await store.transaction(async (repositories) => {
      const existing = await repositories.identityRoutes.getByPlatformUserId(route.platformUserId);
      if (!existing) {
        const created = await repositories.identityRoutes.create({ ...route, enabled: true, remark: 'Imported by p5:bootstrap' });
        await bootstrapAudit(repositories, 'BOOTSTRAP_IDENTITY_ROUTE', created.id, route);
        counters.routesCreated += 1;
      } else if (force) {
        const updated = await repositories.identityRoutes.update(existing.id, {
          ...route, enabled: true, remark: 'Force-imported by p5:bootstrap', rowVersion: existing.rowVersion,
        });
        await bootstrapAudit(repositories, 'FORCE_BOOTSTRAP_IDENTITY_ROUTE', updated.id, route);
        counters.routesUpdated += 1;
      }
    });
  }

  for (const toolName of enabledTools) {
    await store.transaction(async (repositories) => {
      const existing = await repositories.tools.getByName(toolName);
      if (!existing) {
        const created = await repositories.tools.createIfAbsent(toolName, true, 'Imported by p5:bootstrap');
        await bootstrapAudit(repositories, 'BOOTSTRAP_TOOL_CONTROL', created.id, { toolName, enabled: true });
        counters.toolsCreated += 1;
      } else if (force) {
        const updated = await repositories.tools.update(toolName, {
          enabled: true, remark: 'Force-imported by p5:bootstrap', rowVersion: existing.rowVersion,
        });
        await bootstrapAudit(repositories, 'FORCE_BOOTSTRAP_TOOL_CONTROL', updated.id, { toolName, enabled: true });
        counters.toolsUpdated += 1;
      }
    });
  }

  for (const policy of dmlPolicies) {
    await store.transaction(async (repositories) => {
      const existing = await repositories.dmlPolicies.getByObjectApiName(policy.objectApiName);
      const input = {
        objectApiName: policy.objectApiName,
        allowCreate: policy.operations.includes('CREATE'),
        allowUpdate: policy.operations.includes('UPDATE'),
        enabled: true,
        remark: force ? 'Force-imported by p5:bootstrap' : 'Imported by p5:bootstrap',
      };
      if (!existing) {
        const created = await repositories.dmlPolicies.create(input);
        await bootstrapAudit(repositories, 'BOOTSTRAP_DML_POLICY', created.id, input);
        counters.dmlPoliciesCreated += 1;
      } else if (force) {
        const updated = await repositories.dmlPolicies.update(existing.id, { ...input, rowVersion: existing.rowVersion });
        await bootstrapAudit(repositories, 'FORCE_BOOTSTRAP_DML_POLICY', updated.id, input);
        counters.dmlPoliciesUpdated += 1;
      }
    });
  }

  if (diagnostic) {
    await store.transaction(async (repositories) => {
      const existing = await repositories.diagnostic.get();
      if (!existing) {
        const created = await repositories.diagnostic.upsert(diagnostic);
        await bootstrapAudit(repositories, 'BOOTSTRAP_DIAGNOSTIC_CONFIG', created.id, diagnostic);
        counters.diagnosticCreated = true;
      } else if (force) {
        const updated = await repositories.diagnostic.upsert({ ...diagnostic, rowVersion: existing.rowVersion });
        await bootstrapAudit(repositories, 'FORCE_BOOTSTRAP_DIAGNOSTIC_CONFIG', updated.id, diagnostic);
        counters.diagnosticUpdated = true;
      }
    });
  }

  for (const [settingKey, settingValue] of [['auditRetentionDays', 90], ['adminDefaultPageSize', 25]] as const) {
    await store.transaction(async (repositories) => {
      const existing = await repositories.runtimeSettings.get(settingKey);
      if (!existing) {
        const created = await repositories.runtimeSettings.upsert(settingKey, settingValue);
        await bootstrapAudit(repositories, 'BOOTSTRAP_RUNTIME_SETTING', settingKey, { settingKey, settingValue });
        counters.settingsCreated += 1;
      } else if (force) {
        await repositories.runtimeSettings.upsert(settingKey, settingValue, existing.rowVersion);
        await bootstrapAudit(repositories, 'FORCE_BOOTSTRAP_RUNTIME_SETTING', settingKey, { settingKey, settingValue });
        counters.settingsUpdated += 1;
      }
    });
  }

  return Object.freeze(counters);
}

async function bootstrapAudit(
  repositories: ControlPlaneRepositories,
  operation: string,
  recordId: string,
  requestSummary: unknown,
): Promise<void> {
  await repositories.audits.append({
    occurredAt: new Date(), correlationId: randomUUID(), channel: 'ADMIN', actorAdmin: 'p5-bootstrap',
    operation, recordId, result: 'PASS', outcome: 'SUCCESS', requestSummary,
  });
}

function parseDml(value: string | undefined): z.infer<typeof dmlSchema> {
  if (!value?.trim()) return [];
  try {
    const parsed = dmlSchema.parse(JSON.parse(value) as unknown);
    const objects = new Set<string>();
    for (const entry of parsed) {
      const normalized = entry.objectApiName.toLocaleLowerCase('en-US');
      if (objects.has(normalized) || new Set(entry.operations).size !== entry.operations.length) {
        throw new Error('duplicate object or operation');
      }
      objects.add(normalized);
    }
    return parsed;
  } catch (error) {
    throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'MCP_DML_ALLOWLIST_JSON is invalid for P5 bootstrap.', { cause: error });
  }
}

async function loadValues(projectRoot: string, environment: NodeJS.ProcessEnv): Promise<Record<string, string | undefined>> {
  let fileValues: Record<string, string> = {};
  try { fileValues = parseEnvFile(await readFile(path.join(projectRoot, '.env.local'), 'utf8')); }
  catch (error) { if (!(isNodeError(error) && error.code === 'ENOENT')) throw error; }
  const names = [
    'SALESFORCE_USERNAME', 'SECOND_TEST_USER', 'P1_PLATFORM_USER_A', 'P1_PLATFORM_USER_B',
    'MCP_ENABLED_TOOLS', 'MCP_DML_ALLOWLIST_JSON', 'SFOA_DIAGNOSTIC_USERNAME',
    'TEST_METADATA_TYPE', 'TEST_METADATA_FULL_NAME',
  ];
  return Object.fromEntries(names.map((name) => [name, environment[name] ?? fileValues[name]]));
}

function uniqueCsv(value: string): readonly string[] {
  const names = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (names.length > 1_000) {
    throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'MCP_ENABLED_TOOLS contains more than 1000 entries.');
  }
  return Object.freeze([
    ...new Set(names.map((name) => parseBootstrapValue(toolNameSchema, name, 'MCP_ENABLED_TOOLS'))),
  ]);
}

function parseBootstrapRoute(platformUserId: string, salesforceUsername: string): Readonly<{
  platformUserId: string;
  userName: string;
  salesforceUsername: string;
}> {
  return Object.freeze({
    platformUserId: parseBootstrapValue(platformUserIdSchema, platformUserId, 'P1_PLATFORM_USER'),
    // Env bootstrap has no human-readable display name; fall back to the platform user id,
    // mirroring the 009 migration backfill for pre-existing rows.
    userName: parseBootstrapValue(platformUserIdSchema, platformUserId, 'P1_PLATFORM_USER'),
    salesforceUsername: parseBootstrapValue(salesforceUsernameSchema, salesforceUsername, 'Salesforce username'),
  });
}

function parseBootstrapValue<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues.map((issue) => issue.message).join('; ');
  throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', `${name} is invalid: ${details}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

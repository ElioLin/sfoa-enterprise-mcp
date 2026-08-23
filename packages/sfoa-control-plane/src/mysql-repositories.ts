import { createHash } from 'node:crypto';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import {
  createSalesforceIdentityRoute,
  type IdentityRepository as RuntimeIdentityRepository,
  type SalesforceIdentityRoute,
} from '@sfoa/identity-runtime';
import {
  diagnosticVerificationStatusSchema,
  freezeSnapshot,
  normalizeSalesforceUsername,
  RUNTIME_SETTING_KEYS,
  type AuditRecord,
  type DiagnosticConfigRecord,
  type DmlPolicyRecord,
  type IdentityRouteRecord,
  type Page,
  type RequestPolicySnapshot,
  type RuntimeSettingKey,
  type RuntimeSettingRecord,
  type ToolControlRecord,
} from './contracts.js';
import { ControlPlaneError, toControlPlaneError } from './errors.js';
import type {
  AuditFilter,
  AuditRepository,
  AuditWrite,
  ControlPlaneRepositories,
  DiagnosticConfigRepository,
  DiagnosticConfigWriteInput,
  DmlPolicyCreateInput,
  DmlPolicyRepository,
  DmlPolicyUpdateInput,
  IdentityRouteCreateInput,
  IdentityRouteRepository,
  IdentityRouteUpdateInput,
  ListOptions,
  RuntimeSettingRepository,
  ToolControlRepository,
  ToolControlWriteInput,
} from './repositories.js';
import type { ControlPlaneDatabase } from './schema.js';
import type {
  AuditLogTable,
  DiagnosticConfigTable,
  DmlPolicyTable,
  IdentityRouteTable,
  RuntimeSettingTable,
  ToolControlTable,
} from './schema.js';

type Executor = Kysely<ControlPlaneDatabase> | Transaction<ControlPlaneDatabase>;

export class MySqlIdentityRouteRepository implements IdentityRouteRepository {
  public constructor(private readonly database: Executor) {}

  public async list(options: ListOptions): Promise<Page<IdentityRouteRecord>> {
    const rows = await this.database.selectFrom('sfoa_identity_route').selectAll()
      .orderBy('platform_user_id').limit(options.limit + 1).offset(options.offset).execute();
    return page(rows.map(mapIdentityRoute), options);
  }

  public async countActive(): Promise<number> {
    const row = await this.database.selectFrom('sfoa_identity_route')
      .select(sql<string>`COUNT(*)`.as('count')).where('enabled', '=', 1).executeTakeFirstOrThrow();
    return Number(row.count);
  }

  public async getById(id: string): Promise<IdentityRouteRecord | undefined> {
    const row = await this.database.selectFrom('sfoa_identity_route').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? mapIdentityRoute(row) : undefined;
  }

  public async getByPlatformUserId(platformUserId: string): Promise<IdentityRouteRecord | undefined> {
    const row = await this.database.selectFrom('sfoa_identity_route').selectAll()
      .where('platform_user_id', '=', platformUserId).executeTakeFirst();
    return row ? mapIdentityRoute(row) : undefined;
  }

  public async findActiveByPlatformUserId(platformUserId: string): Promise<IdentityRouteRecord | undefined> {
    const row = await this.database.selectFrom('sfoa_identity_route').selectAll()
      .where('platform_user_id', '=', platformUserId).where('enabled', '=', 1).executeTakeFirst();
    return row ? mapIdentityRoute(row) : undefined;
  }

  public async listActiveSalesforceUsernames(): Promise<readonly string[]> {
    const rows = await this.database.selectFrom('sfoa_identity_route').select('salesforce_username')
      .where('enabled', '=', 1).orderBy('salesforce_username').execute();
    return Object.freeze(rows.map((row) => row.salesforce_username));
  }

  public async create(input: IdentityRouteCreateInput): Promise<IdentityRouteRecord> {
    try {
      await this.database.insertInto('sfoa_identity_route').values({
        platform_user_id: input.platformUserId,
        salesforce_username: input.salesforceUsername,
        enabled: input.enabled,
        remark: input.remark,
      }).executeTakeFirstOrThrow();
      const row = await this.database.selectFrom('sfoa_identity_route').selectAll()
        .where('platform_user_id', '=', input.platformUserId).executeTakeFirstOrThrow();
      return mapIdentityRoute(row);
    } catch (error) {
      throw mapWriteError(error, 'An identity route already exists for this platform user.');
    }
  }

  public async update(id: string, input: IdentityRouteUpdateInput): Promise<IdentityRouteRecord> {
    try {
      const result = await this.database.updateTable('sfoa_identity_route').set({
        platform_user_id: input.platformUserId,
        salesforce_username: input.salesforceUsername,
        enabled: input.enabled,
        remark: input.remark,
        row_version: sql`row_version + 1`,
      }).where('id', '=', id).where('row_version', '=', input.rowVersion).executeTakeFirst();
      await assertOptimisticResult(result.numUpdatedRows, id, this);
      return (await this.getById(id)) as IdentityRouteRecord;
    } catch (error) {
      if (error instanceof ControlPlaneError) throw error;
      throw mapWriteError(error, 'An identity route already exists for this platform user.');
    }
  }

  public async disable(id: string, rowVersion: string): Promise<IdentityRouteRecord> {
    const current = await this.getById(id);
    if (!current) throw notFound('Identity route');
    return this.update(id, {
      platformUserId: current.platformUserId,
      salesforceUsername: current.salesforceUsername,
      enabled: false,
      remark: current.remark,
      rowVersion,
    });
  }
}

export class MySqlIdentityRepository implements RuntimeIdentityRepository {
  private readonly routes: MySqlIdentityRouteRepository;
  public constructor(database: Executor) {
    this.routes = new MySqlIdentityRouteRepository(database);
  }

  public async findByPlatformUserId(platformUserId: string): Promise<SalesforceIdentityRoute | undefined> {
    const route = await this.routes.findActiveByPlatformUserId(platformUserId);
    return route
      ? createSalesforceIdentityRoute({
          platformUserId: route.platformUserId,
          salesforceUsername: route.salesforceUsername,
          credentialProfile: 'sfoa-shared-jwt',
          connectionRole: 'USER',
          aliases: [],
        })
      : undefined;
  }
}

export class MySqlToolControlRepository implements ToolControlRepository {
  public constructor(private readonly database: Executor) {}

  public async list(options: ListOptions): Promise<Page<ToolControlRecord>> {
    const rows = await this.database.selectFrom('sfoa_tool_control').selectAll()
      .orderBy('tool_name').limit(options.limit + 1).offset(options.offset).execute();
    return page(rows.map(mapTool), options);
  }

  public async countEnabled(): Promise<number> {
    const row = await this.database.selectFrom('sfoa_tool_control')
      .select(sql<string>`COUNT(*)`.as('count')).where('enabled', '=', 1).executeTakeFirstOrThrow();
    return Number(row.count);
  }

  public async getByName(toolName: string): Promise<ToolControlRecord | undefined> {
    const row = await this.database.selectFrom('sfoa_tool_control').selectAll().where('tool_name', '=', toolName).executeTakeFirst();
    return row ? mapTool(row) : undefined;
  }

  public async listEnabledNames(): Promise<readonly string[]> {
    const rows = await this.database.selectFrom('sfoa_tool_control').select('tool_name')
      .where('enabled', '=', 1).orderBy('tool_name').execute();
    return Object.freeze(rows.map((row) => row.tool_name));
  }

  public async createIfAbsent(toolName: string, enabled: boolean, remark: string | null): Promise<ToolControlRecord> {
    await this.database.insertInto('sfoa_tool_control').values({ tool_name: toolName, enabled, remark })
      .ignore().executeTakeFirst();
    return (await this.getByName(toolName)) as ToolControlRecord;
  }

  public async update(toolName: string, input: ToolControlWriteInput): Promise<ToolControlRecord> {
    const current = await this.getByName(toolName);
    if (!current) throw notFound('Tool control');
    if (!input.rowVersion) {
      throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'rowVersion is required to update Tool control.');
    }
    const result = await this.database.updateTable('sfoa_tool_control').set({
      enabled: input.enabled,
      remark: input.remark,
      row_version: sql`row_version + 1`,
    }).where('tool_name', '=', toolName).where('row_version', '=', input.rowVersion).executeTakeFirst();
    if (result.numUpdatedRows === 0n) throw concurrentModification();
    return (await this.getByName(toolName)) as ToolControlRecord;
  }
}

export class MySqlDmlPolicyRepository implements DmlPolicyRepository {
  public constructor(private readonly database: Executor) {}

  public async list(options: ListOptions): Promise<Page<DmlPolicyRecord>> {
    const rows = await this.database.selectFrom('sfoa_dml_policy').selectAll()
      .orderBy('object_api_name').limit(options.limit + 1).offset(options.offset).execute();
    return page(rows.map(mapDml), options);
  }

  public async countEnabled(): Promise<number> {
    const row = await this.database.selectFrom('sfoa_dml_policy')
      .select(sql<string>`COUNT(*)`.as('count')).where('enabled', '=', 1).executeTakeFirstOrThrow();
    return Number(row.count);
  }

  public async getById(id: string): Promise<DmlPolicyRecord | undefined> {
    const row = await this.database.selectFrom('sfoa_dml_policy').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? mapDml(row) : undefined;
  }

  public async getByObjectApiName(objectApiName: string): Promise<DmlPolicyRecord | undefined> {
    const row = await this.database.selectFrom('sfoa_dml_policy').selectAll()
      .where('object_api_name', '=', objectApiName).executeTakeFirst();
    return row ? mapDml(row) : undefined;
  }

  public async listEnabled(): Promise<readonly DmlPolicyRecord[]> {
    const rows = await this.database.selectFrom('sfoa_dml_policy').selectAll()
      .where('enabled', '=', 1).orderBy('object_api_name').execute();
    return Object.freeze(rows.map(mapDml));
  }

  public async create(input: DmlPolicyCreateInput): Promise<DmlPolicyRecord> {
    try {
      await this.database.insertInto('sfoa_dml_policy').values({
        object_api_name: input.objectApiName,
        allow_create: input.allowCreate,
        allow_update: input.allowUpdate,
        enabled: input.enabled,
        remark: input.remark,
      }).executeTakeFirstOrThrow();
      const row = await this.database.selectFrom('sfoa_dml_policy').selectAll()
        .where('object_api_name', '=', input.objectApiName).executeTakeFirstOrThrow();
      return mapDml(row);
    } catch (error) {
      throw mapWriteError(error, 'A DML policy already exists for this Salesforce object.');
    }
  }

  public async update(id: string, input: DmlPolicyUpdateInput): Promise<DmlPolicyRecord> {
    try {
      const result = await this.database.updateTable('sfoa_dml_policy').set({
        object_api_name: input.objectApiName,
        allow_create: input.allowCreate,
        allow_update: input.allowUpdate,
        enabled: input.enabled,
        remark: input.remark,
        row_version: sql`row_version + 1`,
      }).where('id', '=', id).where('row_version', '=', input.rowVersion).executeTakeFirst();
      if (result.numUpdatedRows === 0n) {
        if (!(await this.getById(id))) throw notFound('DML policy');
        throw concurrentModification();
      }
      return (await this.getById(id)) as DmlPolicyRecord;
    } catch (error) {
      if (error instanceof ControlPlaneError) throw error;
      throw mapWriteError(error, 'A DML policy already exists for this Salesforce object.');
    }
  }

  public async disable(id: string, rowVersion: string): Promise<DmlPolicyRecord> {
    const current = await this.getById(id);
    if (!current) throw notFound('DML policy');
    return this.update(id, { ...current, enabled: false, rowVersion });
  }
}

export class MySqlDiagnosticConfigRepository implements DiagnosticConfigRepository {
  public constructor(private readonly database: Executor) {}

  public async get(): Promise<DiagnosticConfigRecord | undefined> {
    const row = await this.database.selectFrom('sfoa_diagnostic_config').selectAll().where('id', '=', '1').executeTakeFirst();
    return row ? mapDiagnostic(row) : undefined;
  }

  public async upsert(input: DiagnosticConfigWriteInput): Promise<DiagnosticConfigRecord> {
    const current = await this.get();
    if (!current) {
      await this.database.insertInto('sfoa_diagnostic_config').values({
        id: '1',
        salesforce_username: input.salesforceUsername,
        enabled: input.enabled,
        verification_status: 'NOT_VERIFIED',
        last_verified_at: null,
        last_error_code: null,
        last_error_message_safe: null,
        test_metadata_type: input.testMetadataType,
        test_metadata_full_name: input.testMetadataFullName,
      }).executeTakeFirstOrThrow();
      return (await this.get()) as DiagnosticConfigRecord;
    }
    if (!input.rowVersion) throw concurrentModification();
    const result = await this.database.updateTable('sfoa_diagnostic_config').set({
      salesforce_username: input.salesforceUsername,
      enabled: input.enabled,
      verification_status: 'NOT_VERIFIED',
      last_verified_at: null,
      last_error_code: null,
      last_error_message_safe: null,
      test_metadata_type: input.testMetadataType,
      test_metadata_full_name: input.testMetadataFullName,
      row_version: sql`row_version + 1`,
    }).where('id', '=', '1').where('row_version', '=', input.rowVersion).executeTakeFirst();
    if (result.numUpdatedRows === 0n) throw concurrentModification();
    return (await this.get()) as DiagnosticConfigRecord;
  }

  public async recordVerification(input: Parameters<DiagnosticConfigRepository['recordVerification']>[0]): Promise<DiagnosticConfigRecord> {
    const result = await this.database.updateTable('sfoa_diagnostic_config').set({
      verification_status: input.status,
      last_verified_at: new Date(),
      last_error_code: input.errorCode,
      last_error_message_safe: input.errorMessageSafe,
      row_version: sql`row_version + 1`,
    }).where('id', '=', '1').where('row_version', '=', input.rowVersion).executeTakeFirst();
    if (result.numUpdatedRows === 0n) throw concurrentModification();
    return (await this.get()) as DiagnosticConfigRecord;
  }
}

export class MySqlRuntimeSettingRepository implements RuntimeSettingRepository {
  public constructor(private readonly database: Executor) {}

  public async list(): Promise<readonly RuntimeSettingRecord[]> {
    const rows = await this.database.selectFrom('sfoa_runtime_setting').selectAll().orderBy('setting_key').execute();
    return Object.freeze(rows.map(mapRuntimeSetting));
  }

  public async get(key: RuntimeSettingKey): Promise<RuntimeSettingRecord | undefined> {
    const row = await this.database.selectFrom('sfoa_runtime_setting').selectAll().where('setting_key', '=', key).executeTakeFirst();
    return row ? mapRuntimeSetting(row) : undefined;
  }

  public async upsert(key: RuntimeSettingKey, value: unknown, rowVersion?: string): Promise<RuntimeSettingRecord> {
    if (!RUNTIME_SETTING_KEYS.includes(key)) throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', `Runtime setting ${key} is not allowed.`);
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 4096) {
      throw new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'Runtime setting JSON must be at most 4096 bytes.');
    }
    const current = await this.get(key);
    if (!current) {
      await this.database.insertInto('sfoa_runtime_setting').values({ setting_key: key, setting_value_json: encoded }).executeTakeFirstOrThrow();
      return (await this.get(key)) as RuntimeSettingRecord;
    }
    if (!rowVersion) throw concurrentModification();
    const result = await this.database.updateTable('sfoa_runtime_setting').set({
      setting_value_json: encoded,
      row_version: sql`row_version + 1`,
    }).where('setting_key', '=', key).where('row_version', '=', rowVersion).executeTakeFirst();
    if (result.numUpdatedRows === 0n) throw concurrentModification();
    return (await this.get(key)) as RuntimeSettingRecord;
  }
}

export class MySqlAuditRepository implements AuditRepository {
  public constructor(private readonly database: Executor) {}

  public async append(event: AuditWrite): Promise<AuditRecord> {
    const inserted = await this.database.insertInto('sfoa_audit_log').values({
      occurred_at: event.occurredAt,
      correlation_id: event.correlationId,
      channel: event.channel,
      client_id: event.clientId ?? null,
      actor_admin: event.actorAdmin ?? null,
      platform_user_id: event.platformUserId ?? null,
      salesforce_username: event.salesforceUsername ?? null,
      execution_role: event.executionRole ?? null,
      tool_name: event.toolName ?? null,
      operation: event.operation ?? null,
      object_api_name: event.objectApiName ?? null,
      record_id: event.recordId ?? null,
      result: event.result,
      outcome: event.outcome ?? null,
      error_code: event.errorCode ?? null,
      duration_ms: event.durationMs ?? null,
      request_summary_json: boundedJson(event.requestSummary),
      response_summary_json: boundedJson(event.responseSummary),
    }).executeTakeFirstOrThrow();
    if (inserted.insertId === undefined) {
      throw new ControlPlaneError(
        'MCP_RUNTIME_CONTROL_PLANE_UNAVAILABLE',
        'Audit persistence did not return an inserted record identifier.',
      );
    }
    const row = await this.database.selectFrom('sfoa_audit_log').selectAll()
      .where('id', '=', inserted.insertId.toString()).executeTakeFirstOrThrow();
    return mapAudit(row);
  }

  public async getById(id: string): Promise<AuditRecord | undefined> {
    const row = await this.database.selectFrom('sfoa_audit_log').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? mapAudit(row) : undefined;
  }

  public async search(filter: AuditFilter): Promise<Page<AuditRecord>> {
    let query = this.database.selectFrom('sfoa_audit_log').selectAll();
    if (filter.occurredFrom) query = query.where('occurred_at', '>=', filter.occurredFrom);
    if (filter.occurredTo) query = query.where('occurred_at', '<=', filter.occurredTo);
    if (filter.correlationId) query = query.where('correlation_id', '=', filter.correlationId);
    if (filter.platformUserId) query = query.where('platform_user_id', '=', filter.platformUserId);
    if (filter.salesforceUsername) query = query.where('salesforce_username', '=', filter.salesforceUsername);
    if (filter.toolName) query = query.where('tool_name', '=', filter.toolName);
    if (filter.result) query = query.where('result', '=', filter.result);
    if (filter.errorCode) query = query.where('error_code', '=', filter.errorCode);
    const rows = await query.orderBy('occurred_at', 'desc').orderBy('id', 'desc')
      .limit(filter.limit + 1).offset(filter.offset).execute();
    return page(rows.map(mapAudit), filter);
  }

  public async countSince(since: Date): Promise<Readonly<{ total: number; pass: number; blocked: number; error: number; unknown: number }>> {
    const rows = await this.database.selectFrom('sfoa_audit_log').select([
      sql<number>`COUNT(*)`.as('total'),
      sql<number>`SUM(result = 'PASS')`.as('pass'),
      sql<number>`SUM(result = 'BLOCKED')`.as('blocked'),
      sql<number>`SUM(result = 'ERROR')`.as('error'),
      sql<number>`SUM(outcome = 'UNKNOWN')`.as('unknown'),
    ]).where('occurred_at', '>=', since).executeTakeFirstOrThrow();
    return Object.freeze({
      total: Number(rows.total ?? 0),
      pass: Number(rows.pass ?? 0),
      blocked: Number(rows.blocked ?? 0),
      error: Number(rows.error ?? 0),
      unknown: Number(rows.unknown ?? 0),
    });
  }
}

export function createMySqlRepositories(database: Executor): ControlPlaneRepositories {
  return Object.freeze({
    identityRoutes: new MySqlIdentityRouteRepository(database),
    tools: new MySqlToolControlRepository(database),
    dmlPolicies: new MySqlDmlPolicyRepository(database),
    diagnostic: new MySqlDiagnosticConfigRepository(database),
    runtimeSettings: new MySqlRuntimeSettingRepository(database),
    audits: new MySqlAuditRepository(database),
  });
}

export async function loadMySqlRequestPolicySnapshot(
  database: Kysely<ControlPlaneDatabase>,
  platformUserId: string,
): Promise<RequestPolicySnapshot> {
  try {
    return await database.transaction().setIsolationLevel('repeatable read').execute(async (transaction) => {
      const repositories = createMySqlRepositories(transaction);
      const [identityRoute, enabledTools, dmlPolicies, diagnostic, runtimeSettings] = await Promise.all([
        repositories.identityRoutes.findActiveByPlatformUserId(platformUserId),
        repositories.tools.listEnabledNames(),
        repositories.dmlPolicies.listEnabled(),
        repositories.diagnostic.get(),
        repositories.runtimeSettings.list(),
      ]);
      if (diagnostic?.enabled) {
        const userNames = await repositories.identityRoutes.listActiveSalesforceUsernames();
        const diagnosticName = normalizeSalesforceUsername(diagnostic.salesforceUsername);
        if (userNames.some((name) => normalizeSalesforceUsername(name) === diagnosticName)) {
          throw new ControlPlaneError(
            'MCP_CONTROL_PLANE_CONFIGURATION_INVALID',
            'The enabled Diagnostic Salesforce username conflicts with an active USER route.',
          );
        }
      }
      return freezeSnapshot({
        mode: 'mysql',
        loadedAt: new Date().toISOString(),
        identityRoute: identityRoute ?? null,
        enabledTools,
        dmlPolicies,
        diagnostic: diagnostic?.enabled ? diagnostic : null,
        runtimeSettings: Object.fromEntries(runtimeSettings.map((setting) => [setting.settingKey, setting.settingValue])),
      });
    });
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw toControlPlaneError(error);
  }
}

function mapIdentityRoute(row: Selectable<IdentityRouteTable>): IdentityRouteRecord {
  return Object.freeze({
    id: String(row.id), platformUserId: row.platform_user_id, salesforceUsername: row.salesforce_username,
    enabled: Boolean(row.enabled), remark: row.remark, rowVersion: String(row.row_version),
    createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
  });
}

function mapTool(row: Selectable<ToolControlTable>): ToolControlRecord {
  return Object.freeze({
    id: String(row.id), toolName: row.tool_name, enabled: Boolean(row.enabled), remark: row.remark,
    rowVersion: String(row.row_version), createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
  });
}

function mapDml(row: Selectable<DmlPolicyTable>): DmlPolicyRecord {
  return Object.freeze({
    id: String(row.id), objectApiName: row.object_api_name, allowCreate: Boolean(row.allow_create),
    allowUpdate: Boolean(row.allow_update), enabled: Boolean(row.enabled), remark: row.remark,
    rowVersion: String(row.row_version), createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
  });
}

function mapDiagnostic(row: Selectable<DiagnosticConfigTable>): DiagnosticConfigRecord {
  return Object.freeze({
    id: '1', salesforceUsername: row.salesforce_username, enabled: Boolean(row.enabled),
    verificationStatus: diagnosticVerificationStatusSchema.parse(row.verification_status),
    lastVerifiedAt: row.last_verified_at ? toIso(row.last_verified_at) : null,
    lastErrorCode: row.last_error_code, lastErrorMessageSafe: row.last_error_message_safe,
    testMetadataType: row.test_metadata_type, testMetadataFullName: row.test_metadata_full_name,
    rowVersion: String(row.row_version), createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
  });
}

function mapRuntimeSetting(row: Selectable<RuntimeSettingTable>): RuntimeSettingRecord {
  const key = RUNTIME_SETTING_KEYS.find((candidate) => candidate === row.setting_key);
  if (!key) throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFIGURATION_INVALID', `Unknown runtime setting in database: ${row.setting_key}.`);
  return Object.freeze({ settingKey: key, settingValue: parseJson(row.setting_value_json), rowVersion: String(row.row_version), updatedAt: toIso(row.updated_at) });
}

function mapAudit(row: Selectable<AuditLogTable>): AuditRecord {
  return Object.freeze({
    id: String(row.id), occurredAt: toIso(row.occurred_at), correlationId: row.correlation_id,
    channel: row.channel === 'ADMIN' ? 'ADMIN' : 'MCP', clientId: row.client_id, actorAdmin: row.actor_admin,
    platformUserId: row.platform_user_id, salesforceUsername: row.salesforce_username,
    executionRole: row.execution_role === 'USER' || row.execution_role === 'DIAGNOSTIC' ? row.execution_role : null,
    toolName: row.tool_name, operation: row.operation, objectApiName: row.object_api_name, recordId: row.record_id,
    result: row.result === 'PASS' || row.result === 'BLOCKED' ? row.result : 'ERROR',
    outcome: row.outcome === 'SUCCESS' || row.outcome === 'FAILED' || row.outcome === 'DENIED' || row.outcome === 'UNKNOWN' ? row.outcome : null,
    errorCode: row.error_code, durationMs: row.duration_ms,
    requestSummary: parseJson(row.request_summary_json), responseSummary: parseJson(row.response_summary_json),
    createdAt: toIso(row.created_at),
  });
}

function page<T>(rows: readonly T[], options: ListOptions): Page<T> {
  const hasMore = rows.length > options.limit;
  const items = Object.freeze(rows.slice(0, options.limit));
  return Object.freeze({
    items, limit: options.limit, offset: options.offset, count: items.length, hasMore,
    nextOffset: hasMore ? options.offset + items.length : null,
  });
}

async function assertOptimisticResult(
  count: bigint,
  id: string,
  repository: IdentityRouteRepository,
): Promise<void> {
  if (count > 0n) return;
  if (!(await repository.getById(id))) throw notFound('Identity route');
  throw concurrentModification();
}

function boundedJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  if (Buffer.byteLength(encoded, 'utf8') <= 16_384) return encoded;
  return JSON.stringify({ truncated: true, byteLength: Buffer.byteLength(encoded, 'utf8'), sha256: createHash('sha256').update(encoded).digest('hex') });
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value) as unknown; } catch { throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFIGURATION_INVALID', 'Stored JSON is invalid.'); }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapWriteError(error: unknown, conflictMessage: string): ControlPlaneError {
  if (error instanceof ControlPlaneError) return error;
  if (isMysqlError(error) && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062)) {
    return new ControlPlaneError('MCP_CONTROL_PLANE_CONFLICT', conflictMessage, { cause: error });
  }
  return toControlPlaneError(error);
}

function isMysqlError(error: unknown): error is Readonly<{ code?: string; errno?: number }> {
  return typeof error === 'object' && error !== null && ('code' in error || 'errno' in error);
}

function notFound(entity: string): ControlPlaneError {
  return new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', `${entity} was not found.`);
}

function concurrentModification(): ControlPlaneError {
  return new ControlPlaneError('MCP_ADMIN_CONCURRENT_MODIFICATION', 'The configuration changed since it was loaded. Refresh and retry with the current rowVersion.');
}

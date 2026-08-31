import { randomUUID } from 'node:crypto';
import { type Kysely, type Selectable, type Transaction, sql } from 'kysely';
import {
  auditContentTypeSchema,
  auditEventCategorySchema,
  auditEventNameSchema,
  auditEventStatusSchema,
  auditEventTypeSchema,
  auditIntegrityStatusSchema,
  auditKindSchema,
  auditPayloadTypeSchema,
  auditPurposeSchema,
  auditQueryTypeSchema,
  auditSequenceSchema,
  auditedHttpMethodSchema,
  IDENTITY_SOURCES,
  idSchema,
  objectApiNameSchema,
  salesforceApiCategorySchema,
  salesforceApiResultSchema,
  salesforceApiTransportKindSchema,
  salesforceApiVisibilitySchema,
  salesforceUsernameSchema,
  toolNameSchema,
  type AuditEventRecord,
  type AuditKind,
  type AuditPayloadEvidenceRecord,
  type AuditRecord,
  type Page,
  type SalesforceApiCallRecord,
} from './contracts.js';
import {
  encodeBoundedAuditJson,
  encodeBoundedAuditPayload,
  MAX_AUDIT_SUMMARY_BYTES,
  sanitizeAuditValue,
  sanitizeAuditText,
} from './audit-sanitization.js';
import { ControlPlaneError, toControlPlaneError } from './errors.js';
import type {
  AuditCallCreateInput,
  AuditEventCreateInput,
  AuditFilter,
  AuditPayloadEvidenceCreateInput,
  AuditRepository,
  AuditTraceRepository,
  AuditWrite,
  ListOptions,
  SalesforceApiCallCreateInput,
} from './repositories.js';
import type { ControlPlaneDatabase } from './schema.js';
import type {
  AuditEventTable,
  AuditLogTable,
  AuditPayloadEvidenceTable,
  SalesforceApiCallTable,
} from './schema.js';

type Executor = Kysely<ControlPlaneDatabase> | Transaction<ControlPlaneDatabase>;

const MAX_PAGE_SIZE = 1_000;
const MAX_UINT32 = 4_294_967_295;

/**
 * P7 Audit 是独立持久化领域。它与配置 Repository 分文件，避免 P7 后续明细能力继续放大
 * mysql-repositories.ts，同时保持同一个 Kysely transaction/executor Contract。
 */
export class MySqlAuditRepository implements AuditRepository, AuditTraceRepository {
  public constructor(private readonly database: Executor) {}

  public async append(event: AuditWrite): Promise<AuditRecord> {
    validateAuditTimes(event.startedAt, event.completedAt, event.durationMs);
    const auditKind = event.auditKind ?? inferAuditKind(event);
    validateAuditKindShape(auditKind, event);
    try {
      const inserted = await this.database.insertInto('sfoa_audit_log').values({
        public_audit_id: parsePublicAuditId(event.publicAuditId ?? randomUUID()),
        audit_kind: auditKind,
        occurred_at: event.occurredAt,
        started_at: event.startedAt ?? null,
        completed_at: event.completedAt ?? null,
        correlation_id: boundedRequiredText(event.correlationId, 128, 'correlationId'),
        channel: event.channel,
        client_id: boundedOptionalText(event.clientId, 128, 'clientId'),
        actor_admin: boundedOptionalText(event.actorAdmin, 320, 'actorAdmin'),
        platform_user_id: boundedOptionalText(event.platformUserId, 128, 'platformUserId'),
        salesforce_username: event.salesforceUsername === undefined
          ? null
          : salesforceUsernameSchema.parse(sanitizeAuditText(event.salesforceUsername)),
        execution_role: event.executionRole ?? null,
        identity_source: event.identitySource ?? null,
        identity_credential_id: event.identityCredentialId === undefined ? null : idSchema.parse(event.identityCredentialId),
        tool_name: event.toolName === undefined ? null : toolNameSchema.parse(sanitizeAuditText(event.toolName)),
        operation: boundedOptionalText(event.operation, 128, 'operation'),
        object_api_name: event.objectApiName === undefined
          ? null
          : objectApiNameSchema.parse(sanitizeAuditText(event.objectApiName)),
        record_id: boundedOptionalText(event.recordId, 128, 'recordId'),
        result: event.result,
        outcome: event.outcome ?? null,
        error_code: boundedOptionalText(event.errorCode, 128, 'errorCode'),
        error_message_safe: safeOptionalText(event.errorMessageSafe, 1024),
        audit_integrity_status: event.auditIntegrityStatus ?? 'PARTIAL',
        duration_ms: event.durationMs ?? null,
        request_summary_json: encodeAuditRequestSummary(event),
        response_summary_json: encodeBoundedAuditJson(event.responseSummary),
      }).executeTakeFirstOrThrow();
      return await this.getInsertedAudit(inserted.insertId);
    } catch (error) {
      throw mapAuditWriteError(error, 'Audit record conflicts with an existing audit identifier.');
    }
  }

  public async createCall(input: AuditCallCreateInput): Promise<AuditRecord> {
    return this.append({ ...input, channel: 'MCP', toolName: input.toolName, auditKind: 'MCP_TOOL_CALL' });
  }

  public async getById(id: string): Promise<AuditRecord | undefined> {
    const parsedId = idSchema.parse(id);
    const row = await this.database.selectFrom('sfoa_audit_log').selectAll().where('id', '=', parsedId).executeTakeFirst();
    return row ? mapAudit(row) : undefined;
  }

  public async getByPublicAuditId(publicAuditId: string): Promise<AuditRecord | undefined> {
    const normalized = parsePublicAuditId(publicAuditId);
    const row = await this.database.selectFrom('sfoa_audit_log').selectAll()
      .where('public_audit_id', '=', normalized).executeTakeFirst();
    return row ? mapAudit(row) : undefined;
  }

  public async search(filter: AuditFilter): Promise<Page<AuditRecord>> {
    validateListOptions(filter);
    // 普通列表只访问主表；不得为了 UI 计数隐式读取或 JOIN 大 Payload。
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

  public async createEvent(input: AuditEventCreateInput): Promise<AuditEventRecord> {
    const auditId = await this.assertToolAudit(input.auditId);
    const sequence = auditSequenceSchema.parse(input.sequence);
    validateAuditTimes(input.startedAt, input.completedAt, input.durationMs);
    if (input.parentEventId !== undefined) await this.assertEventBelongsToAudit(input.parentEventId, auditId);
    try {
      const inserted = await this.database.insertInto('sfoa_audit_event').values({
        audit_id: auditId,
        sequence,
        parent_event_id: input.parentEventId ?? null,
        event_category: auditEventCategorySchema.parse(input.eventCategory),
        event_type: auditEventTypeSchema.parse(sanitizeAuditText(input.eventType)),
        event_name: auditEventNameSchema.parse(sanitizeAuditText(input.eventName)),
        started_at: input.startedAt,
        completed_at: input.completedAt ?? null,
        duration_ms: input.durationMs ?? null,
        status: auditEventStatusSchema.parse(input.status),
        error_code: boundedOptionalText(input.errorCode, 128, 'errorCode'),
        safe_summary_json: encodeBoundedAuditJson(input.safeSummary),
      }).executeTakeFirstOrThrow();
      const id = requireInsertId(inserted.insertId, 'Audit event');
      const row = await this.database.selectFrom('sfoa_audit_event').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      return mapAuditEvent(row);
    } catch (error) {
      throw mapAuditWriteError(error, `Audit event sequence ${sequence} already exists for audit ${auditId}.`);
    }
  }

  public async listEvents(auditId: string, options: ListOptions): Promise<Page<AuditEventRecord>> {
    validateListOptions(options);
    const parsedAuditId = idSchema.parse(auditId);
    const rows = await this.database.selectFrom('sfoa_audit_event').selectAll()
      .where('audit_id', '=', parsedAuditId).orderBy('sequence').orderBy('id')
      .limit(options.limit + 1).offset(options.offset).execute();
    return page(rows.map(mapAuditEvent), options);
  }

  public async createSalesforceApiCall(input: SalesforceApiCallCreateInput): Promise<SalesforceApiCallRecord> {
    const auditId = await this.assertToolAudit(input.auditId);
    const sequence = auditSequenceSchema.parse(input.sequence);
    validateAuditTimes(input.startedAt, input.completedAt, input.durationMs);
    if (input.auditEventId !== undefined) await this.assertEventBelongsToAudit(input.auditEventId, auditId);
    validateApiEvidence(input);
    try {
      const inserted = await this.database.insertInto('sfoa_salesforce_api_call').values({
        public_api_call_id: parsePublicAuditId(input.publicApiCallId ?? randomUUID()),
        audit_id: auditId,
        audit_event_id: input.auditEventId ?? null,
        sequence,
        salesforce_username: input.salesforceUsername === undefined
          ? null
          : salesforceUsernameSchema.parse(sanitizeAuditText(input.salesforceUsername)),
        transport_kind: salesforceApiTransportKindSchema.parse(input.transportKind),
        visibility: salesforceApiVisibilitySchema.parse(input.visibility),
        api_category: salesforceApiCategorySchema.parse(input.apiCategory),
        http_method: input.httpMethod === undefined ? null : auditedHttpMethodSchema.parse(input.httpMethod),
        endpoint: input.endpoint === undefined ? null : safeRequiredText(input.endpoint, 1024, 'endpoint'),
        request_url: input.requestUrl === undefined ? null : safeRequiredText(input.requestUrl, 16_384, 'requestUrl'),
        host: boundedOptionalText(input.host, 512, 'host'),
        endpoint_path: input.endpointPath === undefined ? null : safeRequiredText(input.endpointPath, 16_384, 'endpointPath'),
        operation_name: boundedOptionalText(input.operationName, 256, 'operationName'),
        api_version: boundedOptionalText(input.apiVersion, 32, 'apiVersion'),
        purpose: auditPurposeSchema.parse(sanitizeAuditText(input.purpose)),
        started_at: input.startedAt,
        completed_at: input.completedAt ?? null,
        duration_ms: input.durationMs ?? null,
        http_status: input.httpStatus ?? null,
        result: salesforceApiResultSchema.parse(input.result),
        salesforce_error_code: boundedOptionalText(input.salesforceErrorCode, 128, 'salesforceErrorCode'),
        salesforce_error_message_safe: safeOptionalText(input.salesforceErrorMessageSafe, 1024),
        request_size_bytes: input.requestSizeBytes?.toString() ?? null,
        response_size_bytes: input.responseSizeBytes?.toString() ?? null,
        content_type: boundedOptionalText(input.contentType, 256, 'contentType'),
        query_type: input.queryType === undefined ? null : auditQueryTypeSchema.parse(sanitizeAuditText(input.queryType)),
        soql_statement_safe: safeOptionalText(input.soqlStatementSafe, 65_535),
        total_size: input.totalSize ?? null,
        returned_records: input.returnedRecords ?? null,
        done: input.done ?? null,
        dml_operation: input.dmlOperation ?? null,
        object_api_name: input.objectApiName === undefined
          ? null
          : objectApiNameSchema.parse(sanitizeAuditText(input.objectApiName)),
        record_id: boundedOptionalText(input.recordId, 128, 'recordId'),
        requested_fields_json: encodeBoundedAuditJson(input.requestedFields),
        managed_fields_json: encodeBoundedAuditJson(input.managedFields),
      }).executeTakeFirstOrThrow();
      const id = requireInsertId(inserted.insertId, 'Salesforce API call');
      const row = await this.database.selectFrom('sfoa_salesforce_api_call').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      return mapSalesforceApiCall(row);
    } catch (error) {
      throw mapAuditWriteError(error, `Salesforce API sequence ${sequence} already exists for audit ${auditId}.`);
    }
  }

  public async listSalesforceApiCalls(auditId: string, options: ListOptions): Promise<Page<SalesforceApiCallRecord>> {
    validateListOptions(options);
    const parsedAuditId = idSchema.parse(auditId);
    const rows = await this.database.selectFrom('sfoa_salesforce_api_call').selectAll()
      .where('audit_id', '=', parsedAuditId).orderBy('sequence').orderBy('id')
      .limit(options.limit + 1).offset(options.offset).execute();
    return page(rows.map(mapSalesforceApiCall), options);
  }

  public async createPayloadEvidence(input: AuditPayloadEvidenceCreateInput): Promise<AuditPayloadEvidenceRecord> {
    const auditId = await this.assertToolAudit(input.auditId);
    if (input.auditEventId !== undefined) await this.assertEventBelongsToAudit(input.auditEventId, auditId);
    if (input.salesforceApiCallId !== undefined) await this.assertApiCallBelongsToAudit(input.salesforceApiCallId, auditId);
    if (!Number.isSafeInteger(input.originalSizeBytes) || input.originalSizeBytes < 0) {
      throw invalidInput('originalSizeBytes must be a non-negative safe integer.');
    }
    const encoded = encodeBoundedAuditPayload(input.safePayload);
    const suppliedHash = input.contentSha256 === undefined ? undefined : parseSha256(input.contentSha256);
    try {
      const inserted = await this.database.insertInto('sfoa_audit_payload_evidence').values({
        audit_id: auditId,
        salesforce_api_call_id: input.salesforceApiCallId ?? null,
        audit_event_id: input.auditEventId ?? null,
        payload_type: auditPayloadTypeSchema.parse(input.payloadType),
        content_type: auditContentTypeSchema.parse(sanitizeAuditText(input.contentType)),
        original_size_bytes: input.originalSizeBytes.toString(),
        stored_size_bytes: encoded.storedSizeBytes,
        truncated: Boolean(input.truncated || encoded.truncated),
        content_sha256: suppliedHash ?? encoded.contentSha256,
        safe_payload: encoded.safePayload,
      }).executeTakeFirstOrThrow();
      const id = requireInsertId(inserted.insertId, 'Audit payload evidence');
      const row = await this.database.selectFrom('sfoa_audit_payload_evidence').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      return mapAuditPayload(row);
    } catch (error) {
      throw mapAuditWriteError(error, 'Audit payload evidence violates an audit relationship constraint.');
    }
  }

  public async listPayloadEvidence(auditId: string, options: ListOptions): Promise<Page<AuditPayloadEvidenceRecord>> {
    validateListOptions(options);
    const parsedAuditId = idSchema.parse(auditId);
    const rows = await this.database.selectFrom('sfoa_audit_payload_evidence').selectAll()
      .where('audit_id', '=', parsedAuditId).orderBy('id')
      .limit(options.limit + 1).offset(options.offset).execute();
    return page(rows.map(mapAuditPayload), options);
  }

  private async getInsertedAudit(insertId: bigint | number | string | undefined): Promise<AuditRecord> {
    const id = requireInsertId(insertId, 'Audit');
    const row = await this.database.selectFrom('sfoa_audit_log').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    return mapAudit(row);
  }

  private async assertToolAudit(auditId: string): Promise<string> {
    const parsed = idSchema.parse(auditId);
    const row = await this.database.selectFrom('sfoa_audit_log').select(['audit_kind']).where('id', '=', parsed).executeTakeFirst();
    if (!row) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', `Audit ${parsed} was not found.`);
    if (row.audit_kind !== 'MCP_TOOL_CALL') {
      throw invalidInput(`Audit ${parsed} is ${row.audit_kind}; P7 trace details require MCP_TOOL_CALL.`);
    }
    return parsed;
  }

  private async assertEventBelongsToAudit(eventId: string, auditId: string): Promise<void> {
    const parsedEventId = idSchema.parse(eventId);
    const row = await this.database.selectFrom('sfoa_audit_event').select(['audit_id'])
      .where('id', '=', parsedEventId).executeTakeFirst();
    if (!row) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', `Audit event ${parsedEventId} was not found.`);
    if (String(row.audit_id) !== auditId) throw invalidInput(`Audit event ${parsedEventId} belongs to a different audit.`);
  }

  private async assertApiCallBelongsToAudit(apiCallId: string, auditId: string): Promise<void> {
    const parsedApiCallId = idSchema.parse(apiCallId);
    const row = await this.database.selectFrom('sfoa_salesforce_api_call').select(['audit_id'])
      .where('id', '=', parsedApiCallId).executeTakeFirst();
    if (!row) throw new ControlPlaneError('MCP_CONTROL_PLANE_NOT_FOUND', `Salesforce API call ${parsedApiCallId} was not found.`);
    if (String(row.audit_id) !== auditId) throw invalidInput(`Salesforce API call ${parsedApiCallId} belongs to a different audit.`);
  }
}

function mapAudit(row: Selectable<AuditLogTable>): AuditRecord {
  return Object.freeze({
    id: String(row.id),
    publicAuditId: parsePublicAuditId(row.public_audit_id),
    auditKind: auditKindSchema.parse(row.audit_kind),
    occurredAt: toIso(row.occurred_at),
    startedAt: row.started_at ? toIso(row.started_at) : null,
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
    correlationId: row.correlation_id,
    channel: row.channel === 'ADMIN' ? 'ADMIN' : 'MCP',
    clientId: row.client_id,
    actorAdmin: row.actor_admin,
    platformUserId: row.platform_user_id,
    salesforceUsername: row.salesforce_username,
    executionRole: row.execution_role === 'USER' || row.execution_role === 'DIAGNOSTIC' ? row.execution_role : null,
    identitySource: IDENTITY_SOURCES.find((source) => source === row.identity_source) ?? null,
    identityCredentialId: row.identity_credential_id === null ? null : String(row.identity_credential_id),
    toolName: row.tool_name,
    operation: row.operation,
    objectApiName: row.object_api_name,
    recordId: row.record_id,
    result: row.result === 'PASS' || row.result === 'BLOCKED' ? row.result : 'ERROR',
    outcome: row.outcome === 'SUCCESS' || row.outcome === 'FAILED' || row.outcome === 'DENIED' || row.outcome === 'UNKNOWN'
      ? row.outcome
      : null,
    errorCode: row.error_code,
    errorMessageSafe: row.error_message_safe,
    auditIntegrityStatus: auditIntegrityStatusSchema.parse(row.audit_integrity_status),
    durationMs: row.duration_ms,
    requestSummary: parseJson(row.request_summary_json),
    responseSummary: parseJson(row.response_summary_json),
    createdAt: toIso(row.created_at),
  });
}

function mapAuditEvent(row: Selectable<AuditEventTable>): AuditEventRecord {
  return Object.freeze({
    id: String(row.id),
    auditId: String(row.audit_id),
    sequence: Number(row.sequence),
    parentEventId: row.parent_event_id === null ? null : String(row.parent_event_id),
    eventCategory: auditEventCategorySchema.parse(row.event_category),
    eventType: row.event_type,
    eventName: row.event_name,
    startedAt: toIso(row.started_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
    durationMs: row.duration_ms,
    status: auditEventStatusSchema.parse(row.status),
    errorCode: row.error_code,
    safeSummary: parseJson(row.safe_summary_json),
    createdAt: toIso(row.created_at),
  });
}

function mapSalesforceApiCall(row: Selectable<SalesforceApiCallTable>): SalesforceApiCallRecord {
  return Object.freeze({
    id: String(row.id),
    publicApiCallId: parsePublicAuditId(row.public_api_call_id),
    auditId: String(row.audit_id),
    auditEventId: row.audit_event_id === null ? null : String(row.audit_event_id),
    sequence: Number(row.sequence),
    salesforceUsername: row.salesforce_username,
    transportKind: salesforceApiTransportKindSchema.parse(row.transport_kind),
    visibility: salesforceApiVisibilitySchema.parse(row.visibility),
    apiCategory: salesforceApiCategorySchema.parse(row.api_category),
    httpMethod: row.http_method === null ? null : auditedHttpMethodSchema.parse(row.http_method),
    endpoint: row.endpoint,
    requestUrl: row.request_url,
    host: row.host,
    endpointPath: row.endpoint_path,
    operationName: row.operation_name,
    apiVersion: row.api_version,
    purpose: row.purpose,
    startedAt: toIso(row.started_at),
    completedAt: row.completed_at ? toIso(row.completed_at) : null,
    durationMs: row.duration_ms,
    httpStatus: row.http_status,
    result: salesforceApiResultSchema.parse(row.result),
    salesforceErrorCode: row.salesforce_error_code,
    salesforceErrorMessageSafe: row.salesforce_error_message_safe,
    requestSizeBytes: row.request_size_bytes,
    responseSizeBytes: row.response_size_bytes,
    contentType: row.content_type,
    queryType: row.query_type,
    soqlStatementSafe: row.soql_statement_safe,
    totalSize: row.total_size,
    returnedRecords: row.returned_records,
    done: row.done === null ? null : Boolean(row.done),
    dmlOperation: row.dml_operation === 'CREATE' || row.dml_operation === 'UPDATE' ? row.dml_operation : null,
    objectApiName: row.object_api_name,
    recordId: row.record_id,
    requestedFields: parseJson(row.requested_fields_json),
    managedFields: parseJson(row.managed_fields_json),
    createdAt: toIso(row.created_at),
  });
}

function mapAuditPayload(row: Selectable<AuditPayloadEvidenceTable>): AuditPayloadEvidenceRecord {
  return Object.freeze({
    id: String(row.id),
    auditId: String(row.audit_id),
    salesforceApiCallId: row.salesforce_api_call_id === null ? null : String(row.salesforce_api_call_id),
    auditEventId: row.audit_event_id === null ? null : String(row.audit_event_id),
    payloadType: auditPayloadTypeSchema.parse(row.payload_type),
    contentType: row.content_type,
    originalSizeBytes: String(row.original_size_bytes),
    storedSizeBytes: Number(row.stored_size_bytes),
    truncated: Boolean(row.truncated),
    contentSha256: row.content_sha256,
    safePayload: row.safe_payload,
    createdAt: toIso(row.created_at),
  });
}

function inferAuditKind(event: AuditWrite): AuditKind {
  if (event.channel === 'ADMIN') return 'ADMIN_ACTION';
  if (event.operation === 'BUNTU_TOKEN_VALIDATE') return 'IDENTITY_VALIDATION';
  // 旧 Runtime 在超时/断连时可能为同一次 Tool 调用产生多个平面事件；toolName 本身
  // 不能证明“一行 = 一次调用”。只有 createCall/显式 auditKind 才能建立 P7 主记录。
  return 'RUNTIME_EVENT';
}

function validateAuditKindShape(kind: AuditKind, event: AuditWrite): void {
  auditKindSchema.parse(kind);
  auditIntegrityStatusSchema.parse(event.auditIntegrityStatus ?? 'PARTIAL');
  if (kind === 'MCP_TOOL_CALL' && (event.channel !== 'MCP' || event.toolName === undefined)) {
    throw invalidInput('MCP_TOOL_CALL requires channel MCP and a toolName.');
  }
  if (kind === 'ADMIN_ACTION' && event.channel !== 'ADMIN') {
    throw invalidInput('ADMIN_ACTION requires channel ADMIN.');
  }
}

function validateApiEvidence(input: SalesforceApiCallCreateInput): void {
  if (input.httpStatus !== undefined && (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)) {
    throw invalidInput('httpStatus must be between 100 and 599.');
  }
  for (const [name, value] of [['totalSize', input.totalSize], ['returnedRecords', input.returnedRecords]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > MAX_UINT32)) {
      throw invalidInput(`${name} must be an unsigned 32-bit integer.`);
    }
  }
  if (input.totalSize !== undefined && input.returnedRecords !== undefined && input.returnedRecords > input.totalSize) {
    throw invalidInput('returnedRecords cannot exceed totalSize.');
  }
  if (input.dmlOperation !== undefined && input.objectApiName === undefined) {
    throw invalidInput('DML evidence requires objectApiName.');
  }
  for (const [name, value] of [['requestSizeBytes', input.requestSizeBytes], ['responseSizeBytes', input.responseSizeBytes]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw invalidInput(`${name} must be a non-negative safe integer.`);
    }
  }
  if (input.visibility === 'EXACT_HTTP') {
    if (!input.httpMethod || !input.requestUrl || !input.host || !input.endpointPath || input.operationName !== undefined) {
      throw invalidInput('EXACT_HTTP evidence requires method, requestUrl, host, and endpointPath only.');
    }
  } else if (
    !input.operationName || input.httpMethod !== undefined || input.requestUrl !== undefined ||
    input.host !== undefined || input.endpointPath !== undefined
  ) {
    throw invalidInput('OPERATION_ONLY evidence requires operationName and no HTTP facts.');
  }
}

function validateAuditTimes(startedAt: Date | undefined, completedAt: Date | undefined, durationMs: number | undefined): void {
  if (startedAt !== undefined && Number.isNaN(startedAt.getTime())) throw invalidInput('startedAt must be valid.');
  if (completedAt !== undefined && Number.isNaN(completedAt.getTime())) throw invalidInput('completedAt must be valid.');
  if (startedAt !== undefined && completedAt !== undefined && completedAt.getTime() < startedAt.getTime()) {
    throw invalidInput('completedAt cannot precede startedAt.');
  }
  if (durationMs !== undefined && (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > MAX_UINT32)) {
    throw invalidInput('durationMs must be an unsigned 32-bit integer.');
  }
}

function validateListOptions(options: ListOptions): void {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > MAX_PAGE_SIZE) {
    throw invalidInput(`limit must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  if (!Number.isInteger(options.offset) || options.offset < 0) throw invalidInput('offset must be a non-negative integer.');
}

function page<T>(rows: readonly T[], options: ListOptions): Page<T> {
  const hasMore = rows.length > options.limit;
  const items = Object.freeze(rows.slice(0, options.limit));
  return Object.freeze({
    items,
    limit: options.limit,
    offset: options.offset,
    count: items.length,
    hasMore,
    nextOffset: hasMore ? options.offset + items.length : null,
  });
}

function boundedRequiredText(value: string, maxLength: number, name: string): string {
  // 审计的结构化短文本同样属于持久化边界；不能只净化 JSON/Payload，
  // 否则恶意上游可把 Bearer/JWT 塞进 operation、errorCode 等普通列绕过红线。
  const normalized = sanitizeAuditText(value).trim();
  if (normalized.length < 1 || normalized.length > maxLength) throw invalidInput(`${name} must contain 1 to ${maxLength} characters.`);
  return normalized;
}

function encodeAuditRequestSummary(event: AuditWrite): string | null {
  if (event.buntuRawTokenEvidence === undefined) return encodeBoundedAuditJson(event.requestSummary);
  if (
    event.channel !== 'MCP'
    || event.operation !== 'BUNTU_TOKEN_VALIDATE'
    || event.identitySource !== 'BUNTU_TOKEN'
  ) {
    throw invalidInput('buntuRawTokenEvidence is restricted to BUNTU_TOKEN_VALIDATE identity audits.');
  }
  if (event.buntuRawTokenEvidence.length < 1) throw invalidInput('buntuRawTokenEvidence must not be empty.');
  const sanitized = sanitizeAuditValue(event.requestSummary);
  const safeSummary = typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)
    ? sanitized as Readonly<Record<string, unknown>>
    : Object.freeze({ summary: sanitized });
  const encoded = JSON.stringify({ ...safeSummary, rawToken: event.buntuRawTokenEvidence });
  if (Buffer.byteLength(encoded, 'utf8') > MAX_AUDIT_SUMMARY_BYTES) {
    throw invalidInput(`Buntu raw-token audit summary exceeds ${MAX_AUDIT_SUMMARY_BYTES} bytes.`);
  }
  return encoded;
}

function boundedOptionalText(value: string | undefined, maxLength: number, name: string): string | null {
  return value === undefined ? null : boundedRequiredText(value, maxLength, name);
}

function safeRequiredText(value: string, maxLength: number, name: string): string {
  const sanitized = sanitizeAuditText(value).trim();
  if (sanitized.length < 1) throw invalidInput(`${name} must not be empty.`);
  return sanitized.length <= maxLength ? sanitized : sanitized.slice(0, maxLength);
}

function safeOptionalText(value: string | undefined, maxBytes: number): string | null {
  if (value === undefined) return null;
  return encodeBoundedAuditPayload(value, maxBytes).safePayload;
}

function parsePublicAuditId(value: string): string {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw invalidInput('publicAuditId must be a UUID.');
  }
  return normalized;
}

function parseSha256(value: string): string {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw invalidInput('contentSha256 must be a lowercase hexadecimal SHA-256 digest.');
  return normalized;
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ControlPlaneError('MCP_CONTROL_PLANE_CONFIGURATION_INVALID', 'Stored audit JSON is invalid.');
  }
}

function requireInsertId(value: bigint | number | string | undefined, entity: string): string {
  if (value === undefined) {
    throw new ControlPlaneError('MCP_RUNTIME_CONTROL_PLANE_UNAVAILABLE', `${entity} persistence did not return an inserted identifier.`);
  }
  return String(value);
}

function mapAuditWriteError(error: unknown, conflictMessage: string): ControlPlaneError {
  if (error instanceof ControlPlaneError) return error;
  if (isMysqlError(error) && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062)) {
    return new ControlPlaneError('MCP_CONTROL_PLANE_CONFLICT', conflictMessage, { cause: error });
  }
  if (isMysqlError(error) && (error.code === 'ER_NO_REFERENCED_ROW_2' || error.errno === 1452)) {
    return new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', 'Audit detail references a missing or different audit.', { cause: error });
  }
  return toControlPlaneError(error);
}

function isMysqlError(error: unknown): error is Readonly<{ code?: string; errno?: number }> {
  return typeof error === 'object' && error !== null && ('code' in error || 'errno' in error);
}

function invalidInput(message: string): ControlPlaneError {
  return new ControlPlaneError('MCP_ADMIN_INPUT_INVALID', message);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

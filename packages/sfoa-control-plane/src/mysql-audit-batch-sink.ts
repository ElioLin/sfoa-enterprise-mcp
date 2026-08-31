import type { AuditSnapshot } from '@sfoa/identity-runtime';
import type { Insertable, Transaction } from 'kysely';
import {
  auditEventCategorySchema,
  auditEventNameSchema,
  auditEventStatusSchema,
  auditEventTypeSchema,
  auditIntegrityStatusSchema,
  auditPurposeSchema,
  auditSequenceSchema,
  auditedHttpMethodSchema,
  IDENTITY_SOURCES,
  objectApiNameSchema,
  salesforceApiCategorySchema,
  salesforceApiResultSchema,
  salesforceApiTransportKindSchema,
  salesforceApiVisibilitySchema,
  salesforceUsernameSchema,
  toolNameSchema,
} from './contracts.js';
import { encodeBoundedAuditJson, sanitizeAuditText } from './audit-sanitization.js';
import {
  AuditBatchPersistenceError,
  type AuditBatchSink,
  type AuditQueueEntry,
} from './audit-pipeline.js';
import type { ControlPlaneDatabaseClient } from './database.js';
import { ControlPlaneError } from './errors.js';
import { MySqlAuditRepository } from './mysql-audit-repository.js';
import type {
  AuditEventTable,
  AuditLogTable,
  ControlPlaneDatabase,
  SalesforceApiCallTable,
} from './schema.js';

export class MySqlAuditBatchSink implements AuditBatchSink {
  public constructor(private readonly database: ControlPlaneDatabaseClient) {}

  public async persist(entries: readonly AuditQueueEntry[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      await this.database.transaction().execute(async (transaction) => {
        const snapshots = entries
          .filter((entry): entry is Extract<AuditQueueEntry, { kind: 'SNAPSHOT' }> => entry.kind === 'SNAPSHOT')
          .map((entry) => entry.snapshot);
        await persistSnapshots(transaction, snapshots);
        const legacyRepository = new MySqlAuditRepository(transaction);
        for (const entry of entries) {
          if (entry.kind === 'LEGACY_RUNTIME') await legacyRepository.append(entry.write);
        }
      });
    } catch (error) {
      throw new AuditBatchPersistenceError(
        'The Audit batch could not be persisted.',
        isRetryableAuditWriteError(error),
        { cause: error },
      );
    }
  }
}

async function persistSnapshots(
  database: Transaction<ControlPlaneDatabase>,
  snapshots: readonly AuditSnapshot[],
): Promise<void> {
  if (snapshots.length === 0) return;
  const publicIds = snapshots.map((snapshot) => parsePublicAuditId(snapshot.auditCall.publicAuditId));
  if (new Set(publicIds).size !== publicIds.length) {
    throw new AuditBatchPersistenceError('An Audit batch contains duplicate public Audit IDs.', false);
  }
  if (snapshots.some((snapshot) => snapshot.payloadEvidence.length > 0)) {
    throw new AuditBatchPersistenceError('P7-04 snapshots cannot contain P7-05/P7-06 payload evidence.', false);
  }

  await database.insertInto('sfoa_audit_log').values(
    snapshots.map((snapshot) => callRow(snapshot)),
  ).executeTakeFirstOrThrow();
  const inserted = await database.selectFrom('sfoa_audit_log')
    .select(['id', 'public_audit_id'])
    .where('public_audit_id', 'in', publicIds)
    .execute();
  const ids = new Map(inserted.map((row) => [row.public_audit_id, String(row.id)]));
  if (ids.size !== snapshots.length) {
    throw new AuditBatchPersistenceError('The Audit batch did not resolve every inserted master ID.', true);
  }

  const eventRows: Insertable<AuditEventTable>[] = [];
  const apiRows: Insertable<SalesforceApiCallTable>[] = [];
  for (const snapshot of snapshots) {
    const auditId = ids.get(parsePublicAuditId(snapshot.auditCall.publicAuditId));
    if (!auditId) throw new AuditBatchPersistenceError('An inserted Audit master ID is missing.', true);
    for (const event of snapshot.auditEvents) {
      eventRows.push({
        audit_id: auditId,
        sequence: event.sequence,
        parent_event_id: null,
        event_category: auditEventCategorySchema.parse(event.eventCategory),
        event_type: auditEventTypeSchema.parse(sanitizeAuditText(event.eventType)),
        event_name: auditEventNameSchema.parse(sanitizeAuditText(event.eventName)),
        started_at: parseDate(event.startedAt),
        completed_at: event.completedAt ? parseDate(event.completedAt) : null,
        duration_ms: event.durationMs,
        status: auditEventStatusSchema.parse(event.status),
        error_code: optionalText(event.errorCode, 128),
        safe_summary_json: encodeBoundedAuditJson(event.safeSummary),
      });
    }
    for (const apiCall of snapshot.salesforceApiCalls) {
      if (parsePublicAuditId(apiCall.auditId) !== parsePublicAuditId(snapshot.auditCall.publicAuditId)) {
        throw new AuditBatchPersistenceError('A Salesforce API call is bound to the wrong Audit ID.', false);
      }
      validateApiVisibility(apiCall);
      apiRows.push({
        public_api_call_id: parsePublicAuditId(apiCall.publicApiCallId),
        audit_id: auditId,
        audit_event_id: null,
        sequence: auditSequenceSchema.parse(apiCall.sequence),
        salesforce_username: apiCall.salesforceUsername === null
          ? null
          : salesforceUsernameSchema.parse(sanitizeAuditText(apiCall.salesforceUsername)),
        transport_kind: salesforceApiTransportKindSchema.parse(apiCall.transportKind),
        visibility: salesforceApiVisibilitySchema.parse(apiCall.visibility),
        api_category: salesforceApiCategorySchema.parse(apiCall.apiCategory),
        http_method: apiCall.httpMethod === null ? null : auditedHttpMethodSchema.parse(apiCall.httpMethod),
        endpoint: optionalText(apiCall.endpointPath, 1024),
        request_url: optionalText(apiCall.requestUrl, 16_384),
        host: optionalText(apiCall.host, 512),
        endpoint_path: optionalText(apiCall.endpointPath, 16_384),
        operation_name: optionalText(apiCall.operationName, 256),
        api_version: optionalText(apiCall.apiVersion, 32),
        purpose: auditPurposeSchema.parse(sanitizeAuditText(apiCall.purpose)),
        started_at: parseDate(apiCall.startedAt),
        completed_at: parseDate(apiCall.completedAt),
        duration_ms: apiCall.durationMs,
        http_status: apiCall.httpStatus,
        result: salesforceApiResultSchema.parse(apiCall.result),
        salesforce_error_code: optionalText(apiCall.salesforceErrorCode, 128),
        salesforce_error_message_safe: optionalText(apiCall.salesforceErrorMessage, 1024),
        request_size_bytes: optionalSize(apiCall.requestSizeBytes),
        response_size_bytes: optionalSize(apiCall.responseSizeBytes),
        content_type: optionalText(apiCall.contentType, 256),
        query_type: null,
        soql_statement_safe: null,
        total_size: null,
        returned_records: null,
        done: null,
        dml_operation: null,
        object_api_name: null,
        record_id: null,
        requested_fields_json: null,
        managed_fields_json: null,
      });
    }
  }
  if (eventRows.length > 0) {
    await database.insertInto('sfoa_audit_event').values(eventRows).executeTakeFirstOrThrow();
  }
  if (apiRows.length > 0) {
    await database.insertInto('sfoa_salesforce_api_call').values(apiRows).executeTakeFirstOrThrow();
  }
}

function callRow(snapshot: AuditSnapshot): Insertable<AuditLogTable> {
  const call = snapshot.auditCall;
  return {
    public_audit_id: parsePublicAuditId(call.publicAuditId),
    audit_kind: 'MCP_TOOL_CALL',
    occurred_at: parseDate(call.occurredAt),
    started_at: parseDate(call.startedAt),
    completed_at: parseDate(call.completedAt),
    correlation_id: requiredText(call.correlationId, 128, 'correlationId'),
    channel: 'MCP',
    client_id: optionalText(call.clientId, 128),
    actor_admin: null,
    platform_user_id: optionalText(call.platformUserId, 128),
    salesforce_username: call.salesforceUsername === null
      ? null
      : salesforceUsernameSchema.parse(sanitizeAuditText(call.salesforceUsername)),
    execution_role: call.executionRole,
    identity_source: call.identitySource === null ? null : identitySource(call.identitySource),
    identity_credential_id: call.identityCredentialId === null ? null : numericId(call.identityCredentialId),
    tool_name: toolNameSchema.parse(sanitizeAuditText(call.toolName)),
    operation: optionalText(call.operation, 128),
    object_api_name: call.objectApiName === null
      ? null
      : objectApiNameSchema.parse(sanitizeAuditText(call.objectApiName)),
    record_id: optionalText(call.recordId, 128),
    result: call.result,
    outcome: call.outcome,
    error_code: optionalText(call.errorCode, 128),
    error_message_safe: null,
    audit_integrity_status: auditIntegrityStatusSchema.parse(call.auditIntegrityStatus),
    duration_ms: call.durationMs,
    request_summary_json: encodeBoundedAuditJson(call.requestSummary),
    response_summary_json: encodeBoundedAuditJson(call.responseSummary),
  };
}

function parsePublicAuditId(value: string): string {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new AuditBatchPersistenceError('publicAuditId must be a UUID.', false);
  }
  return normalized;
}

function parseDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new AuditBatchPersistenceError('Audit timestamp is invalid.', false);
  return parsed;
}

function requiredText(value: string, maximum: number, name: string): string {
  const sanitized = sanitizeAuditText(value).trim();
  if (sanitized.length < 1 || sanitized.length > maximum) {
    throw new AuditBatchPersistenceError(`${name} is outside its Audit bound.`, false);
  }
  return sanitized;
}

function optionalText(value: string | null, maximum: number): string | null {
  return value === null ? null : requiredText(value, maximum, 'Audit text');
}

function optionalSize(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AuditBatchPersistenceError('Salesforce API byte size is invalid.', false);
  }
  return value.toString();
}

function validateApiVisibility(apiCall: AuditSnapshot['salesforceApiCalls'][number]): void {
  if (apiCall.visibility === 'EXACT_HTTP') {
    if (!apiCall.httpMethod || !apiCall.requestUrl || !apiCall.host || !apiCall.endpointPath || apiCall.operationName !== null) {
      throw new AuditBatchPersistenceError('EXACT_HTTP Salesforce evidence is incomplete.', false);
    }
  } else if (
    !apiCall.operationName || apiCall.httpMethod !== null || apiCall.requestUrl !== null ||
    apiCall.host !== null || apiCall.endpointPath !== null
  ) {
    throw new AuditBatchPersistenceError('OPERATION_ONLY Salesforce evidence contains invented HTTP facts.', false);
  }
}

function numericId(value: string): string {
  if (!/^[1-9][0-9]{0,19}$/u.test(value)) {
    throw new AuditBatchPersistenceError('identityCredentialId must be a database identifier.', false);
  }
  return value;
}

function identitySource(value: string): (typeof IDENTITY_SOURCES)[number] {
  const source = IDENTITY_SOURCES.find((candidate) => candidate === value);
  if (!source) throw new AuditBatchPersistenceError('identitySource is invalid.', false);
  return source;
}

function isRetryableAuditWriteError(error: unknown): boolean {
  if (error instanceof AuditBatchPersistenceError) return error.retryable;
  if (error instanceof ControlPlaneError) {
    return !['MCP_CONTROL_PLANE_CONFLICT', 'MCP_ADMIN_INPUT_INVALID'].includes(error.code);
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = String(error.code);
    if (['ER_DUP_ENTRY', 'ER_DATA_TOO_LONG', 'ER_CHECK_CONSTRAINT_VIOLATED', 'ER_NO_REFERENCED_ROW_2'].includes(code)) {
      return false;
    }
  }
  return true;
}

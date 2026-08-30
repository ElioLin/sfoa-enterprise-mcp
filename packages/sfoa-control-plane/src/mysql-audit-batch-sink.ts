import type { AuditSnapshot } from '@sfoa/identity-runtime';
import type { Insertable, Transaction } from 'kysely';
import {
  auditEventCategorySchema,
  auditEventNameSchema,
  auditEventStatusSchema,
  auditEventTypeSchema,
  auditIntegrityStatusSchema,
  IDENTITY_SOURCES,
  objectApiNameSchema,
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
import type { AuditEventTable, AuditLogTable, ControlPlaneDatabase } from './schema.js';

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
  if (snapshots.some((snapshot) => snapshot.salesforceApiCalls.length > 0 || snapshot.payloadEvidence.length > 0)) {
    throw new AuditBatchPersistenceError('P7-03 snapshots cannot contain P7-04/P7-05 evidence.', false);
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
  }
  if (eventRows.length > 0) {
    await database.insertInto('sfoa_audit_event').values(eventRows).executeTakeFirstOrThrow();
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

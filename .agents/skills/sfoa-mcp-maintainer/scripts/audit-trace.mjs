import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { withReadOnlyDatabase } from './shared/db.mjs';
import {
  durationToDate,
  findProjectRoot,
  loadProjectEnvironment,
  maskIdentifier,
  parseCliArguments,
  sanitizeForOutput,
} from './shared/project.mjs';

export class AuditTraceNotFoundError extends Error {
  constructor() {
    super('No Audit Call matched the supplied selector.');
    this.name = 'AuditTraceNotFoundError';
  }
}

export async function analyzeAuditTraces({ projectRoot, environment, selector }) {
  return await withReadOnlyDatabase(projectRoot, environment, async (database) => {
    const audits = requireAuditRows(await findAudits(database, selector));
    const reports = [];
    for (const audit of audits) reports.push(await loadTrace(database, audit));
    return Object.freeze({
      generatedAt: new Date().toISOString(),
      database: database.database,
      selectors: selector,
      schemaCapabilities: Object.freeze({
        publicAuditId: 'available',
        correlationId: 'available',
        eventSequence: 'available',
        publicApiCallId: 'available',
        traceId: 'unavailable (the --trace option aliases publicAuditId)',
        sessionId: 'unavailable',
        callId: 'unavailable',
        parentCallId: 'unavailable',
        spanId: 'unavailable',
      }),
      traces: Object.freeze(reports),
    });
  });
}

export function requireAuditRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new AuditTraceNotFoundError();
  return rows;
}

export function reconstructTrace({ audit, events, apiCalls, payloads, currentState }) {
  const normalizedAudit = normalizeAudit(audit);
  const normalizedEvents = events.map(normalizeEvent).sort(compareSequence);
  const normalizedApi = apiCalls.map(normalizeApi).sort(compareSequence);
  const normalizedPayloads = payloads.map(normalizePayload);
  const timeline = [
    ...normalizedEvents.map((event) => ({ kind: 'EVENT', sequence: event.sequence, id: event.id, evidence: event })),
    ...normalizedApi.map((api) => ({ kind: 'SALESFORCE_API', sequence: api.sequence, id: api.id, evidence: api })),
  ].sort(compareSequence);
  const firstFailure = determineFirstFailure(normalizedAudit, normalizedEvents, normalizedApi);
  const dmlCalls = normalizedApi.filter((call) => call.dmlOperation !== null);
  const identityEvent = normalizedEvents.find((event) => event.eventCategory === 'IDENTITY') ?? null;
  const routingEvent = normalizedEvents.find((event) => event.eventCategory === 'ROUTING') ?? null;
  const governanceEvents = normalizedEvents.filter((event) => event.eventCategory === 'GOVERNANCE');
  return Object.freeze({
    audit: normalizedAudit,
    firstFailure,
    evidenceIntegrity: Object.freeze({
      status: normalizedAudit.auditIntegrityStatus,
      payloadEvidenceCount: normalizedPayloads.length,
      details: normalizedAudit.auditIntegrityStatus === 'COMPLETE'
        ? 'The persisted collector marked the invocation complete.'
        : 'Evidence is incomplete or degraded; do not infer missing stages.',
    }),
    reconstructedChain: Object.freeze([
      node('REQUEST', normalizedPayloads.some((item) => item.payloadType === 'MCP_REQUEST'), {
        startedAt: normalizedAudit.startedAt, requestSummary: normalizedAudit.requestSummary,
      }),
      node('IDENTITY_PROVIDER', identityEvent !== null || normalizedAudit.identitySource !== null, {
        identitySource: normalizedAudit.identitySource, event: identityEvent,
      }),
      node('PLATFORM_USER', normalizedAudit.platformUserId !== null, { platformUserId: maskIdentifier(normalizedAudit.platformUserId) }),
      node('IDENTITY_ROUTE', routingEvent !== null || currentState.route !== null, {
        event: routingEvent,
        currentState: currentState.route,
        caution: 'Current Control Plane state is not historical proof of state at call time.',
      }),
      node('SALESFORCE_USER', normalizedAudit.salesforceUsername !== null, {
        salesforceUsername: maskIdentifier(normalizedAudit.salesforceUsername), executionRole: normalizedAudit.executionRole,
      }),
      node('TOOLS_LIST', false, { reason: 'P7 records definite tools/call invocations; tools/list is not represented in the current schema.' }),
      node('TOOLS_CALL', normalizedAudit.auditKind === 'MCP_TOOL_CALL', {
        toolName: normalizedAudit.toolName, operation: normalizedAudit.operation, objectApiName: normalizedAudit.objectApiName,
      }),
      node('TOOL_GOVERNANCE', governanceEvents.length > 0 || currentState.tool !== null, {
        events: governanceEvents, currentState: currentState.tool,
        caution: 'Current Tool state is not historical proof of state at call time.',
      }),
      node('DML_POLICY', dmlCalls.length > 0 || normalizedAudit.operation === 'CREATE' || normalizedAudit.operation === 'UPDATE', {
        currentState: currentState.dmlPolicy,
        requestedManagedSubmitted: dmlCalls.map((call) => ({
          publicApiCallId: call.publicApiCallId, requestedFields: call.requestedFields,
          managedFields: call.managedFields, submittedFields: call.submittedFields,
        })),
        caution: 'Current DML policy is contextual evidence only; use persisted API/Event evidence for the historical call.',
      }),
      node('SALESFORCE_API', normalizedApi.length > 0, { calls: normalizedApi }),
      node('RESULT', true, {
        result: normalizedAudit.result, outcome: normalizedAudit.outcome, errorCode: normalizedAudit.errorCode,
        errorMessageSafe: normalizedAudit.errorMessageSafe, responseSummary: normalizedAudit.responseSummary,
      }),
    ]),
    timeline: Object.freeze(timeline),
    payloadMetadata: Object.freeze(normalizedPayloads),
  });
}

async function findAudits(database, selector) {
  const clauses = [];
  const parameters = [];
  if (selector.audit) {
    const numericId = /^\d+$/u.test(selector.audit);
    clauses.push(numericId ? 'id = ?' : 'public_audit_id = ?');
    parameters.push(selector.audit);
  }
  if (selector.correlation) {
    clauses.push('correlation_id = ?');
    parameters.push(selector.correlation);
  }
  if (selector.user) {
    clauses.push('platform_user_id = ?');
    parameters.push(selector.user);
  }
  if (selector.tool) {
    clauses.push('tool_name = ?');
    parameters.push(selector.tool);
  }
  if (selector.since) {
    clauses.push('occurred_at >= ?');
    parameters.push(selector.since);
  }
  const limit = Math.max(1, Math.min(selector.limit ?? 1, 20));
  return await database.execute(`SELECT * FROM sfoa_audit_log${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY occurred_at DESC, id DESC LIMIT ${limit}`, parameters);
}

async function loadTrace(database, audit) {
  const [events, apiCalls, payloads, routeRows, toolRows, dmlRows] = await Promise.all([
    database.execute('SELECT * FROM sfoa_audit_event WHERE audit_id = ? ORDER BY sequence, id LIMIT 256', [audit.id]),
    database.execute('SELECT * FROM sfoa_salesforce_api_call WHERE audit_id = ? ORDER BY sequence, id LIMIT 256', [audit.id]),
    database.execute(`SELECT id, audit_id, salesforce_api_call_id, audit_event_id, payload_type, content_type,
      original_size_bytes, stored_size_bytes, truncated, content_sha256, created_at
      FROM sfoa_audit_payload_evidence WHERE audit_id = ? ORDER BY id LIMIT 64`, [audit.id]),
    audit.platform_user_id
      ? database.execute('SELECT id, platform_user_id, salesforce_username, enabled, row_version, updated_at FROM sfoa_identity_route WHERE platform_user_id = ?', [audit.platform_user_id])
      : Promise.resolve([]),
    audit.tool_name
      ? database.execute('SELECT tool_name, enabled, row_version, updated_at FROM sfoa_tool_control WHERE tool_name = ?', [audit.tool_name])
      : Promise.resolve([]),
    audit.object_api_name
      ? database.execute(`SELECT id, object_api_name, allow_create, allow_update, enabled, row_version, updated_at
          FROM sfoa_dml_policy WHERE object_api_name = ?`, [audit.object_api_name])
      : Promise.resolve([]),
  ]);
  const route = routeRows[0] ? {
    id: String(routeRows[0].id), platformUserId: maskIdentifier(routeRows[0].platform_user_id),
    salesforceUsername: maskIdentifier(routeRows[0].salesforce_username), enabled: Boolean(routeRows[0].enabled),
    rowVersion: String(routeRows[0].row_version), updatedAt: iso(routeRows[0].updated_at),
  } : null;
  const tool = toolRows[0] ? {
    toolName: toolRows[0].tool_name, enabled: Boolean(toolRows[0].enabled),
    rowVersion: String(toolRows[0].row_version), updatedAt: iso(toolRows[0].updated_at),
  } : null;
  const dmlPolicy = dmlRows[0] ? {
    id: String(dmlRows[0].id), objectApiName: dmlRows[0].object_api_name,
    allowCreate: Boolean(dmlRows[0].allow_create), allowUpdate: Boolean(dmlRows[0].allow_update),
    enabled: Boolean(dmlRows[0].enabled), rowVersion: String(dmlRows[0].row_version), updatedAt: iso(dmlRows[0].updated_at),
  } : null;
  return reconstructTrace({ audit, events, apiCalls, payloads, currentState: { route, tool, dmlPolicy } });
}

function normalizeAudit(row) {
  return Object.freeze({
    id: String(row.id), publicAuditId: row.public_audit_id ?? row.publicAuditId,
    auditKind: row.audit_kind ?? row.auditKind, occurredAt: iso(row.occurred_at ?? row.occurredAt),
    startedAt: iso(row.started_at ?? row.startedAt), completedAt: iso(row.completed_at ?? row.completedAt),
    correlationId: row.correlation_id ?? row.correlationId, channel: row.channel,
    clientId: row.client_id ?? row.clientId ?? null,
    platformUserId: maskIdentifier(row.platform_user_id ?? row.platformUserId ?? null),
    salesforceUsername: maskIdentifier(row.salesforce_username ?? row.salesforceUsername ?? null),
    executionRole: row.execution_role ?? row.executionRole ?? null, identitySource: row.identity_source ?? row.identitySource ?? null,
    toolName: row.tool_name ?? row.toolName ?? null, operation: row.operation ?? null,
    objectApiName: row.object_api_name ?? row.objectApiName ?? null, recordId: row.record_id ?? row.recordId ?? null,
    result: row.result, outcome: row.outcome ?? null, errorCode: row.error_code ?? row.errorCode ?? null,
    errorMessageSafe: row.error_message_safe ?? row.errorMessageSafe ?? null,
    auditIntegrityStatus: row.audit_integrity_status ?? row.auditIntegrityStatus ?? 'PARTIAL',
    durationMs: row.duration_ms ?? row.durationMs ?? null,
    requestSummary: parseJson(row.request_summary_json ?? row.requestSummary),
    responseSummary: parseJson(row.response_summary_json ?? row.responseSummary),
  });
}

function normalizeEvent(row) {
  return Object.freeze({
    id: String(row.id), sequence: Number(row.sequence), parentEventId: row.parent_event_id ?? row.parentEventId ?? null,
    eventCategory: row.event_category ?? row.eventCategory, eventType: row.event_type ?? row.eventType,
    eventName: row.event_name ?? row.eventName, startedAt: iso(row.started_at ?? row.startedAt),
    completedAt: iso(row.completed_at ?? row.completedAt), durationMs: row.duration_ms ?? row.durationMs ?? null,
    status: row.status, errorCode: row.error_code ?? row.errorCode ?? null,
    safeSummary: parseJson(row.safe_summary_json ?? row.safeSummary),
  });
}

function normalizeApi(row) {
  return Object.freeze({
    id: String(row.id), publicApiCallId: row.public_api_call_id ?? row.publicApiCallId,
    auditEventId: row.audit_event_id ?? row.auditEventId ?? null, sequence: Number(row.sequence),
    salesforceUsername: maskIdentifier(row.salesforce_username ?? row.salesforceUsername ?? null),
    transportKind: row.transport_kind ?? row.transportKind, visibility: row.visibility,
    apiCategory: row.api_category ?? row.apiCategory, httpMethod: row.http_method ?? row.httpMethod ?? null,
    endpoint: row.endpoint ?? null, host: row.host ?? null, endpointPath: row.endpoint_path ?? row.endpointPath ?? null,
    operationName: row.operation_name ?? row.operationName ?? null, apiVersion: row.api_version ?? row.apiVersion ?? null,
    purpose: row.purpose, startedAt: iso(row.started_at ?? row.startedAt), completedAt: iso(row.completed_at ?? row.completedAt),
    durationMs: row.duration_ms ?? row.durationMs ?? null, httpStatus: row.http_status ?? row.httpStatus ?? null,
    result: row.result, salesforceErrorCode: row.salesforce_error_code ?? row.salesforceErrorCode ?? null,
    salesforceErrorMessageSafe: row.salesforce_error_message_safe ?? row.salesforceErrorMessageSafe ?? null,
    queryType: row.query_type ?? row.queryType ?? null, soqlStatementSafe: row.soql_statement_safe ?? row.soqlStatementSafe ?? null,
    totalSize: row.total_size ?? row.totalSize ?? null, returnedRecords: row.returned_records ?? row.returnedRecords ?? null,
    done: nullableBoolean(row.done), hasNextRecords: nullableBoolean(row.has_next_records ?? row.hasNextRecords),
    dmlOperation: row.dml_operation ?? row.dmlOperation ?? null, objectApiName: row.object_api_name ?? row.objectApiName ?? null,
    recordId: row.record_id ?? row.recordId ?? null, requestedFields: parseJson(row.requested_fields_json ?? row.requestedFields),
    managedFields: parseJson(row.managed_fields_json ?? row.managedFields), submittedFields: parseJson(row.submitted_fields_json ?? row.submittedFields),
  });
}

function normalizePayload(row) {
  return Object.freeze({
    id: String(row.id), salesforceApiCallId: row.salesforce_api_call_id ?? row.salesforceApiCallId ?? null,
    auditEventId: row.audit_event_id ?? row.auditEventId ?? null, payloadType: row.payload_type ?? row.payloadType,
    contentType: row.content_type ?? row.contentType, originalSizeBytes: row.original_size_bytes ?? row.originalSizeBytes ?? null,
    storedSizeBytes: Number(row.stored_size_bytes ?? row.storedSizeBytes), truncated: Boolean(row.truncated),
    contentSha256: row.content_sha256 ?? row.contentSha256 ?? null, createdAt: iso(row.created_at ?? row.createdAt),
  });
}

function determineFirstFailure(audit, events, apiCalls) {
  const candidates = [];
  for (const event of events) {
    if (!['FAILED', 'BLOCKED', 'UNKNOWN'].includes(event.status)) continue;
    candidates.push({ sequence: event.sequence, rank: 0, source: 'AUDIT_EVENT', status: event.status, errorCode: event.errorCode, title: event.eventName });
  }
  for (const api of apiCalls) {
    if (api.result === 'SUCCESS') continue;
    candidates.push({ sequence: api.sequence, rank: 1, source: 'SALESFORCE_API', status: api.result, errorCode: api.salesforceErrorCode, title: api.purpose });
  }
  candidates.sort((left, right) => left.sequence - right.sequence || left.rank - right.rank);
  if (candidates[0]) return Object.freeze(candidates[0]);
  if (audit.result !== 'PASS' || (audit.outcome && audit.outcome !== 'SUCCESS')) {
    return Object.freeze({ sequence: null, source: 'AUDIT_CALL', status: audit.outcome ?? audit.result, errorCode: audit.errorCode, title: audit.toolName ?? audit.operation ?? 'Audit terminal' });
  }
  return null;
}

function node(name, available, evidence) {
  return Object.freeze({ name, available, evidence });
}

function compareSequence(left, right) {
  return Number(left.sequence) - Number(right.sequence) || String(left.id).localeCompare(String(right.id), 'en-US');
}

function parseJson(value) {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}

function nullableBoolean(value) {
  return value === null || value === undefined ? null : Boolean(value);
}

function iso(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function main() {
  const arguments_ = parseCliArguments(process.argv.slice(2));
  const projectRoot = arguments_['project-root'] ? path.resolve(String(arguments_['project-root'])) : await findProjectRoot();
  const environment = await loadProjectEnvironment(projectRoot);
  const audit = arguments_.trace ?? arguments_.audit;
  const latestValue = arguments_.latest === true ? 1 : arguments_.latest;
  const limit = Number(latestValue ?? (arguments_.user || arguments_.correlation || arguments_.tool || arguments_.since ? 5 : 1));
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('--latest must be an integer from 1 to 20.');
  const since = durationToDate(arguments_.since ? String(arguments_.since) : undefined);
  const report = await analyzeAuditTraces({
    projectRoot,
    environment,
    selector: Object.freeze({
      ...(audit ? { audit: String(audit) } : {}),
      ...(arguments_.correlation ? { correlation: String(arguments_.correlation) } : {}),
      ...(arguments_.user ? { user: String(arguments_.user) } : {}),
      ...(arguments_.tool ? { tool: String(arguments_.tool) } : {}),
      ...(since ? { since } : {}),
      limit,
    }),
  });
  process.stdout.write(`${JSON.stringify(sanitizeForOutput(report, environment), null, 2)}\n`);
}

const isCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isCli) main().catch((error) => {
  process.stderr.write(`[audit-trace] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof AuditTraceNotFoundError ? 2 : 1;
});

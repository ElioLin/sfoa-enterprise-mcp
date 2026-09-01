import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuditRecord, ControlPlaneRepositoriesWithAuditTrace } from '@sfoa/control-plane';
import { buildAdminAuditTrace } from '../audit-trace.js';

const audit: AuditRecord = Object.freeze({
  id: '1', publicAuditId: '11111111-1111-4111-8111-111111111111', auditKind: 'MCP_TOOL_CALL',
  occurredAt: '2026-09-01T00:00:00.000Z', startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:00:01.000Z',
  correlationId: 'corr-1', channel: 'MCP', clientId: null, actorAdmin: null, platformUserId: 'A', salesforceUsername: 'a@example.com',
  executionRole: 'USER', identitySource: 'USER_BOUND_TOKEN', identityCredentialId: '1', toolName: 'create_record', operation: 'CREATE',
  objectApiName: 'Lead', recordId: null, result: 'ERROR', outcome: 'FAILED', errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
  errorMessageSafe: 'validation failed', auditIntegrityStatus: 'COMPLETE', durationMs: 1000, requestSummary: null, responseSummary: null,
  createdAt: '2026-09-01T00:00:01.000Z',
});

test('trace read model returns counts, metadata-only payloads, and deterministic first failure', async () => {
  const repositories = {
    auditTraces: {
      listEvents: async () => ({ items: [Object.freeze({
        id: '10', auditId: '1', sequence: 2, parentEventId: null, eventCategory: 'TOOL', eventType: 'TOOL_FAILED', eventName: 'Tool failed',
        startedAt: '2026-09-01T00:00:00.500Z', completedAt: '2026-09-01T00:00:00.700Z', durationMs: 200, status: 'FAILED',
        errorCode: 'TOOL_FAILED', safeSummary: { message: 'tool failure' }, createdAt: '2026-09-01T00:00:01.000Z',
      })], limit: 256, offset: 0, count: 1, hasMore: false, nextOffset: null }),
      listSalesforceApiCalls: async () => ({ items: [Object.freeze({
        id: '20', publicApiCallId: '22222222-2222-4222-8222-222222222222', auditId: '1', auditEventId: null, sequence: 3,
        salesforceUsername: 'a@example.com', transportKind: 'JSFORCE', visibility: 'EXACT_HTTP', apiCategory: 'REST_API', httpMethod: 'POST',
        endpoint: '/services/data/v67.0/sobjects/Lead', requestUrl: 'https://example.my.salesforce.com/services/data/v67.0/sobjects/Lead', host: 'example.my.salesforce.com',
        endpointPath: '/services/data/v67.0/sobjects/Lead', operationName: null, apiVersion: '67.0', purpose: 'DML_CREATE',
        startedAt: '2026-09-01T00:00:00.700Z', completedAt: '2026-09-01T00:00:00.900Z', durationMs: 200, httpStatus: 400, result: 'FAILED',
        salesforceErrorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', salesforceErrorMessageSafe: 'validation failed', requestSizeBytes: '10', responseSizeBytes: '20',
        contentType: 'application/json', queryType: null, soqlStatementSafe: null, totalSize: null, returnedRecords: null, done: null, hasNextRecords: null,
        dmlOperation: 'CREATE', objectApiName: 'Lead', recordId: null, requestedFields: { Company: 'A' }, managedFields: {}, submittedFields: { Company: 'A' },
        createdAt: '2026-09-01T00:00:01.000Z',
      })], limit: 256, offset: 0, count: 1, hasMore: false, nextOffset: null }),
      listPayloadEvidenceMetadata: async () => ({ items: [Object.freeze({
        id: '30', auditId: '1', salesforceApiCallId: '20', auditEventId: null, payloadType: 'ERROR_RESPONSE', contentType: 'application/json',
        originalSizeBytes: '20', storedSizeBytes: 20, truncated: false, contentSha256: null, createdAt: '2026-09-01T00:00:01.000Z',
      })], limit: 64, offset: 0, count: 1, hasMore: false, nextOffset: null }),
    },
  } as unknown as ControlPlaneRepositoriesWithAuditTrace;

  const trace = await buildAdminAuditTrace(repositories, audit);
  assert.equal(trace.summary.eventCount, 1);
  assert.equal(trace.summary.apiCount, 1);
  assert.equal(trace.summary.dmlCount, 1);
  assert.equal(trace.summary.payloadCount, 1);
  assert.equal(trace.firstFailure?.source, 'AUDIT_EVENT');
  assert.equal(trace.firstFailure?.sequence, 2);
  assert.equal('safePayload' in trace.payloadMetadata[0]!, false);
});

test('trace read model sorts persisted Event and API facts by request-local sequence', async () => {
  const repositories = {
    auditTraces: {
      listEvents: async () => ({
        items: [
          { id: '12', sequence: 8, status: 'SUCCESS', eventCategory: 'MCP' },
          { id: '11', sequence: 2, status: 'SUCCESS', eventCategory: 'IDENTITY' },
        ], limit: 256, offset: 0, count: 2, hasMore: false, nextOffset: null,
      }),
      listSalesforceApiCalls: async () => ({
        items: [
          { id: '22', sequence: 9, result: 'SUCCESS', queryType: null, dmlOperation: null },
          { id: '21', sequence: 5, result: 'SUCCESS', queryType: 'DATA_SOQL', dmlOperation: null },
        ], limit: 256, offset: 0, count: 2, hasMore: false, nextOffset: null,
      }),
      listPayloadEvidenceMetadata: async () => ({ items: [], limit: 64, offset: 0, count: 0, hasMore: false, nextOffset: null }),
    },
  } as unknown as ControlPlaneRepositoriesWithAuditTrace;

  const trace = await buildAdminAuditTrace(repositories, Object.freeze({ ...audit, result: 'PASS', outcome: 'SUCCESS', errorCode: null }));
  assert.deepEqual(trace.events.map((event) => event.sequence), [2, 8]);
  assert.deepEqual(trace.salesforceApiCalls.map((api) => api.sequence), [5, 9]);
  assert.equal(trace.firstFailure, null);
});

test('non-MCP UNKNOWN audit returns a root uncertainty without pretending to have a full trace', async () => {
  const unknownAudit = Object.freeze({
    ...audit,
    auditKind: 'IDENTITY_VALIDATION' as const,
    toolName: null,
    operation: 'BUNTU_TOKEN_VALIDATE',
    outcome: 'UNKNOWN' as const,
    errorCode: 'MCP_DML_OUTCOME_UNKNOWN',
  });
  const trace = await buildAdminAuditTrace({} as ControlPlaneRepositoriesWithAuditTrace, unknownAudit);
  assert.equal(trace.firstFailure?.source, 'AUDIT_CALL');
  assert.equal(trace.firstFailure?.status, 'UNKNOWN');
  assert.equal(trace.summary.eventCount, 0);
  assert.equal(trace.payloadMetadata.length, 0);
});

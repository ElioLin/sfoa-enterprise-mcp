import type {
  AdminAuditTraceDto,
  AdminAuditTraceFirstFailureDto,
  AuditEventRecord,
  AuditRecord,
  ControlPlaneRepositoriesWithAuditTrace,
  SalesforceApiCallRecord,
} from '@sfoa/control-plane';

const TRACE_EVENT_LIMIT = 256;
const TRACE_API_LIMIT = 256;
const TRACE_PAYLOAD_LIMIT = 64;

/**
 * P7-07 审计详情读取模型：只组合已经持久化的事实，不在管理面推断“AI 根因”。
 * Payload 列表只返回元数据，正文必须通过单条详情接口按需读取，避免打开 Audit 时拉取大字段。
 */
export async function buildAdminAuditTrace(
  repositories: ControlPlaneRepositoriesWithAuditTrace,
  audit: AuditRecord,
): Promise<AdminAuditTraceDto> {
  if (audit.auditKind !== 'MCP_TOOL_CALL') {
    return Object.freeze({
      audit,
      summary: Object.freeze({
        eventCount: 0,
        apiCount: 0,
        soqlCount: 0,
        dmlCount: 0,
        errorCount: hasAbnormalTerminal(audit) ? 1 : 0,
        payloadCount: 0,
        detailsTruncated: false,
      }),
      firstFailure: hasAbnormalTerminal(audit) ? rootFailure(audit) : null,
      events: Object.freeze([]),
      salesforceApiCalls: Object.freeze([]),
      payloadMetadata: Object.freeze([]),
    });
  }

  const [eventsPage, apiPage, payloadPage] = await Promise.all([
    repositories.auditTraces.listEvents(audit.id, { limit: TRACE_EVENT_LIMIT, offset: 0 }),
    repositories.auditTraces.listSalesforceApiCalls(audit.id, { limit: TRACE_API_LIMIT, offset: 0 }),
    repositories.auditTraces.listPayloadEvidenceMetadata(audit.id, { limit: TRACE_PAYLOAD_LIMIT, offset: 0 }),
  ]);
  const events = Object.freeze([...eventsPage.items].sort(compareTraceSequence));
  const apiCalls = Object.freeze([...apiPage.items].sort(compareTraceSequence));
  const payloads = Object.freeze([...payloadPage.items]);
  const firstFailure = findFirstFailure(audit, events, apiCalls);
  const eventFailures = events.filter((event) => isEventFailure(event)).length;
  const apiFailures = apiCalls.filter((api) => api.result !== 'SUCCESS').length;
  const errorCount = eventFailures + apiFailures || (hasAbnormalTerminal(audit) ? 1 : 0);

  return Object.freeze({
    audit,
    summary: Object.freeze({
      eventCount: events.length,
      apiCount: apiCalls.length,
      soqlCount: apiCalls.filter((api) => Boolean(api.queryType)).length,
      dmlCount: apiCalls.filter((api) => Boolean(api.dmlOperation)).length,
      errorCount,
      payloadCount: payloads.length,
      detailsTruncated: eventsPage.hasMore || apiPage.hasMore || payloadPage.hasMore,
    }),
    firstFailure,
    events,
    salesforceApiCalls: apiCalls,
    payloadMetadata: payloads,
  });
}

function findFirstFailure(
  audit: AuditRecord,
  events: readonly AuditEventRecord[],
  apiCalls: readonly SalesforceApiCallRecord[],
): AdminAuditTraceFirstFailureDto | null {
  const candidates: Array<Readonly<{ sequence: number; rank: number; value: AdminAuditTraceFirstFailureDto }>> = [];
  for (const event of events) {
    if (!isEventFailure(event)) continue;
    candidates.push(Object.freeze({
      sequence: event.sequence,
      rank: 0,
      value: Object.freeze({
        source: 'AUDIT_EVENT',
        sequence: event.sequence,
        title: event.eventName,
        status: event.status,
        errorCode: event.errorCode,
        message: summaryMessage(event.safeSummary),
        eventId: event.id,
        salesforceApiCallId: null,
      }),
    }));
  }
  for (const api of apiCalls) {
    if (api.result === 'SUCCESS') continue;
    candidates.push(Object.freeze({
      sequence: api.sequence,
      rank: 1,
      value: Object.freeze({
        source: 'SALESFORCE_API',
        sequence: api.sequence,
        title: api.queryType
          ? `${api.queryType} · ${api.objectApiName ?? api.apiCategory}`
          : api.dmlOperation
            ? `${api.dmlOperation} · ${api.objectApiName ?? 'Salesforce'}`
            : `${api.apiCategory} · ${api.purpose}`,
        status: api.result,
        errorCode: api.salesforceErrorCode,
        message: api.salesforceErrorMessageSafe,
        eventId: api.auditEventId,
        salesforceApiCallId: api.id,
      }),
    }));
  }
  candidates.sort((left, right) => left.sequence - right.sequence || left.rank - right.rank);
  if (candidates[0]) return candidates[0].value;
  return hasAbnormalTerminal(audit) ? rootFailure(audit) : null;
}

function hasAbnormalTerminal(audit: AuditRecord): boolean {
  return audit.result !== 'PASS' || (audit.outcome !== null && audit.outcome !== 'SUCCESS');
}

function rootFailure(audit: AuditRecord): AdminAuditTraceFirstFailureDto {
  return Object.freeze({
    source: 'AUDIT_CALL',
    sequence: null,
    title: audit.toolName ?? audit.operation ?? '调用终态',
    status: audit.outcome ?? audit.result,
    errorCode: audit.errorCode,
    message: audit.errorMessageSafe,
    eventId: null,
    salesforceApiCallId: null,
  });
}

function isEventFailure(event: AuditEventRecord): boolean {
  return event.status === 'FAILED' || event.status === 'BLOCKED' || event.status === 'UNKNOWN';
}

function summaryMessage(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  for (const key of ['message', 'errorMessage', 'reason', 'detail']) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim().slice(0, 1024);
  }
  return null;
}

function compareTraceSequence(
  left: Readonly<{ sequence: number; id: string }>,
  right: Readonly<{ sequence: number; id: string }>,
): number {
  return left.sequence - right.sequence || left.id.localeCompare(right.id, 'en-US');
}

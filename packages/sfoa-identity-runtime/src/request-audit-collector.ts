import type { RequestAuditContext } from './request-audit-context.js';
import {
  MAX_AUDIT_PAYLOAD_BYTES,
  prepareRequestAuditPayload,
  type RequestAuditPayloadEvidenceInput,
} from './audit-payload.js';

export type RequestAuditTerminalOutcome = 'SUCCESS' | 'FAILED' | 'DENIED' | 'UNKNOWN';
export type RequestAuditTerminalSource = 'IDENTITY' | 'GOVERNANCE' | 'TOOL' | 'REQUEST' | 'TRANSPORT';
export type RequestAuditEventCategory =
  | 'MCP'
  | 'IDENTITY'
  | 'ROUTING'
  | 'GOVERNANCE'
  | 'TOOL'
  | 'SALESFORCE'
  | 'INTERNAL'
  | 'AUDIT';
export type RequestAuditEventStatus = 'STARTED' | 'SUCCESS' | 'FAILED' | 'BLOCKED' | 'SKIPPED' | 'UNKNOWN';

export type RequestAuditTerminalCandidate = Readonly<{
  source: RequestAuditTerminalSource;
  result: 'PASS' | 'ERROR' | 'BLOCKED';
  outcome: RequestAuditTerminalOutcome;
  errorCode?: string;
  durationMs?: number;
  requestSummary?: unknown;
  responseSummary?: unknown;
  mutationStarted?: boolean;
}>;

export type RequestAuditEventInput = Readonly<{
  eventCategory: RequestAuditEventCategory;
  eventType: string;
  eventName: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  status: RequestAuditEventStatus;
  errorCode?: string;
  safeSummary?: unknown;
  terminal?: RequestAuditTerminalCandidate;
}>;

export type RequestAuditEventSnapshot = Readonly<{
  sequence: number;
  eventCategory: RequestAuditEventCategory;
  eventType: string;
  eventName: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  status: RequestAuditEventStatus;
  errorCode: string | null;
  safeSummary: unknown;
}>;

export type RequestAuditCallSnapshot = Readonly<{
  publicAuditId: string;
  occurredAt: string;
  startedAt: string;
  completedAt: string;
  correlationId: string;
  clientId: string | null;
  platformUserId: string | null;
  salesforceUsername: string | null;
  executionRole: 'USER' | 'DIAGNOSTIC' | null;
  identitySource: 'INTERNAL_SERVICE_HEADER' | 'USER_BOUND_TOKEN' | 'BUNTU_TOKEN' | null;
  identityCredentialId: string | null;
  toolName: string;
  operation: string | null;
  objectApiName: string | null;
  recordId: string | null;
  result: 'PASS' | 'ERROR' | 'BLOCKED';
  outcome: RequestAuditTerminalOutcome;
  errorCode: string | null;
  durationMs: number | null;
  auditIntegrityStatus: 'COMPLETE' | 'PARTIAL';
  requestSummary: unknown;
  responseSummary: unknown;
}>;

export type SalesforceApiTransportKind = 'HTTP' | 'JSFORCE' | 'SALESFORCE_CLI' | 'OFFICIAL_PROVIDER' | 'OTHER';
export type SalesforceApiVisibility = 'EXACT_HTTP' | 'OPERATION_ONLY';
export type SalesforceApiCategory =
  | 'OAUTH'
  | 'REST_API'
  | 'UI_API'
  | 'TOOLING_API'
  | 'COMPOSITE_API'
  | 'BULK_API'
  | 'APEX_REST_API'
  | 'METADATA_API'
  | 'SOAP_API'
  | 'SALESFORCE_CLI'
  | 'UNKNOWN';
export type SalesforceApiPurpose =
  | 'IDENTITY_AUTHENTICATION'
  | 'IDENTITY_TOKEN_EXCHANGE'
  | 'CONNECTION_INITIALIZATION'
  | 'USER_QUERY'
  | 'RECORD_ACTION_CONTEXT'
  | 'SERVER_MANAGED_LOOKUP'
  | 'DML_CREATE'
  | 'DML_UPDATE'
  | 'DIAGNOSTIC_TOOLING'
  | 'METADATA_RETRIEVE'
  | 'OBJECT_SCHEMA'
  | 'UNKNOWN';
export type SalesforceApiCallResult = 'SUCCESS' | 'FAILED';
export type SalesforceQueryType = 'DATA_SOQL' | 'TOOLING_SOQL';
export type SalesforceDmlOperation = 'CREATE' | 'UPDATE';
export type SalesforceAuditFieldValue = string | number | boolean | null;
export type SalesforceAuditFields = Readonly<Record<string, SalesforceAuditFieldValue>>;

export type SalesforceApiSemanticEvidence = Readonly<{
  queryType: SalesforceQueryType | null;
  soqlStatement: string | null;
  totalSize: number | null;
  returnedRecords: number | null;
  done: boolean | null;
  hasNextRecords: boolean | null;
  dmlOperation: SalesforceDmlOperation | null;
  objectApiName: string | null;
  recordId: string | null;
  requestedFields: SalesforceAuditFields | null;
  managedFields: SalesforceAuditFields | null;
  submittedFields: SalesforceAuditFields | null;
}>;

export type RequestAuditSalesforceApiCallSnapshot = Readonly<{
  publicApiCallId: string;
  auditId: string;
  sequence: number;
  salesforceUsername: string | null;
  transportKind: SalesforceApiTransportKind;
  visibility: SalesforceApiVisibility;
  apiCategory: SalesforceApiCategory;
  apiVersion: string | null;
  httpMethod: string | null;
  requestUrl: string | null;
  host: string | null;
  endpointPath: string | null;
  operationName: string | null;
  purpose: SalesforceApiPurpose;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  httpStatus: number | null;
  result: SalesforceApiCallResult;
  salesforceErrorCode: string | null;
  salesforceErrorMessage: string | null;
  requestSizeBytes: number | null;
  responseSizeBytes: number | null;
  contentType: string | null;
}> & SalesforceApiSemanticEvidence;

export type SalesforceApiSemanticEnrichment = Partial<Pick<
  SalesforceApiSemanticEvidence,
  'totalSize' | 'returnedRecords' | 'done' | 'hasNextRecords' | 'recordId'
>>;
export type RequestAuditPayloadEvidenceSnapshot = Readonly<{
  payloadType: 'MCP_REQUEST' | 'MCP_RESPONSE' | 'SALESFORCE_REQUEST' | 'SALESFORCE_RESPONSE' | 'ERROR_RESPONSE';
  contentType: string;
  safePayload: string;
  originalSizeBytes: number | null;
  storedSizeBytes: number;
  truncated: boolean;
  /** Computed by the background Writer over the persisted safePayload. */
  contentSha256: null;
  salesforceApiCallPublicId: string | null;
  auditEventSequence: number | null;
}>;

export type AuditSnapshot = Readonly<{
  version: 1;
  auditCall: RequestAuditCallSnapshot;
  auditEvents: readonly RequestAuditEventSnapshot[];
  salesforceApiCalls: readonly RequestAuditSalesforceApiCallSnapshot[];
  payloadEvidence: readonly RequestAuditPayloadEvidenceSnapshot[];
}>;

export const MAX_REQUEST_AUDIT_EVENTS = 256;
export const MAX_SALESFORCE_API_CALLS_PER_REQUEST = 256;
export const MAX_PAYLOAD_EVIDENCE_PER_REQUEST = 64;
export const MAX_PAYLOAD_EVIDENCE_BYTES_PER_REQUEST = 1_048_576;
export const ERROR_PAYLOAD_RESERVATION_BYTES = 262_144;
export const MCP_CORE_PAYLOAD_RESERVATION_BYTES = 262_144;

type SelectedTerminal = Readonly<{
  sequence: number;
  candidate: RequestAuditTerminalCandidate;
}>;

export class RequestAuditCollector {
  private readonly events: RequestAuditEventSnapshot[] = [];
  private terminal: SelectedTerminal | undefined;
  private logicalToolResponseSummary: unknown | undefined;
  private terminalEvent: RequestAuditEventSnapshot | undefined;
  private finalized: AuditSnapshot | undefined;
  private droppedEventCount = 0;
  private readonly salesforceApiCalls: RequestAuditSalesforceApiCallSnapshot[] = [];
  private droppedSalesforceApiCallCount = 0;
  private salesforceApiCaptureFailureCount = 0;
  private readonly payloadEvidence: RequestAuditPayloadEvidenceSnapshot[] = [];
  private payloadStoredSizeBytes = 0;
  private droppedPayloadCount = 0;
  private truncatedPayloadCount = 0;
  private payloadCaptureFailureCount = 0;

  public constructor(
    private readonly context: () => RequestAuditContext,
    private readonly nextSequence: () => number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public record(input: RequestAuditEventInput): boolean {
    return this.recordEvent(input) !== null;
  }

  public recordEvent(input: RequestAuditEventInput): number | null {
    if (this.finalized) return null;
    const sequence = this.nextSequence();
    const completedAt = input.completedAt ?? this.now().toISOString();
    const safeSummary = cloneAuditValue(input.safeSummary);
    const event = deepFreeze({
      sequence,
      eventCategory: input.eventCategory,
      eventType: boundedToken(input.eventType, 64, 'RUNTIME_EVENT'),
      eventName: boundedText(input.eventName, 128, 'Runtime event'),
      startedAt: input.startedAt ?? completedAt,
      completedAt,
      durationMs: validDuration(input.durationMs),
      status: input.status,
      errorCode: input.errorCode ? boundedText(input.errorCode, 128, 'MCP_AUDIT_ERROR') : null,
      safeSummary,
    }) satisfies RequestAuditEventSnapshot;
    const terminalSelected = input.terminal
      ? this.selectTerminal(sequence, input.terminal, safeSummary)
      : false;
    if (terminalSelected) this.terminalEvent = event;

    if (this.events.length >= MAX_REQUEST_AUDIT_EVENTS) {
      this.droppedEventCount += 1;
      return null;
    }
    this.events.push(event);
    return sequence;
  }

  public recordSalesforceApiCall(input: RequestAuditSalesforceApiCallSnapshot): boolean {
    if (this.finalized) return false;
    const context = this.context();
    if (input.auditId !== context.auditId) {
      this.salesforceApiCaptureFailureCount += 1;
      return false;
    }
    const call = deepFreeze({ ...input }) satisfies RequestAuditSalesforceApiCallSnapshot;
    if (this.salesforceApiCalls.length < MAX_SALESFORCE_API_CALLS_PER_REQUEST) {
      this.salesforceApiCalls.push(call);
      return true;
    }

    this.droppedSalesforceApiCallCount += 1;
    if (call.result === 'FAILED') {
      const replaceIndex = this.salesforceApiCalls.findIndex((candidate) => candidate.result === 'SUCCESS');
      if (replaceIndex >= 0) {
        this.salesforceApiCalls[replaceIndex] = call;
        return true;
      }
    }
    return false;
  }

  public recordSalesforceApiCaptureFailure(): void {
    if (!this.finalized) this.salesforceApiCaptureFailureCount += 1;
  }

  public recordPayloadEvidence(input: RequestAuditPayloadEvidenceInput): boolean {
    if (this.finalized) return false;
    try {
      if (
        input.salesforceApiCallPublicId !== undefined
        && !isUuid(input.salesforceApiCallPublicId)
      ) {
        this.payloadCaptureFailureCount += 1;
        return false;
      }
      const priority = input.priority
        ?? (input.payloadType === 'ERROR_RESPONSE'
          ? 'ERROR'
          : input.payloadType === 'MCP_REQUEST' || input.payloadType === 'MCP_RESPONSE' ? 'CORE' : 'GENERAL');
      const countCeiling = priority === 'ERROR'
        ? MAX_PAYLOAD_EVIDENCE_PER_REQUEST
        : priority === 'CORE' ? MAX_PAYLOAD_EVIDENCE_PER_REQUEST - 1 : MAX_PAYLOAD_EVIDENCE_PER_REQUEST - 2;
      const byteCeiling = priority === 'ERROR'
        ? MAX_PAYLOAD_EVIDENCE_BYTES_PER_REQUEST
        : priority === 'CORE'
          ? MAX_PAYLOAD_EVIDENCE_BYTES_PER_REQUEST - ERROR_PAYLOAD_RESERVATION_BYTES
          : MAX_PAYLOAD_EVIDENCE_BYTES_PER_REQUEST
            - ERROR_PAYLOAD_RESERVATION_BYTES
            - MCP_CORE_PAYLOAD_RESERVATION_BYTES;
      const remainingBytes = byteCeiling - this.payloadStoredSizeBytes;
      if (this.payloadEvidence.length >= countCeiling || remainingBytes <= 0) {
        this.droppedPayloadCount += 1;
        return false;
      }
      const prepared = prepareRequestAuditPayload(input, Math.min(MAX_AUDIT_PAYLOAD_BYTES, remainingBytes));
      const snapshot = deepFreeze({
        payloadType: prepared.payloadType,
        contentType: prepared.contentType,
        safePayload: prepared.safePayload,
        originalSizeBytes: prepared.originalSizeBytes,
        storedSizeBytes: prepared.storedSizeBytes,
        truncated: prepared.truncated,
        contentSha256: null,
        salesforceApiCallPublicId: prepared.salesforceApiCallPublicId,
        auditEventSequence: prepared.auditEventSequence,
      }) satisfies RequestAuditPayloadEvidenceSnapshot;
      this.payloadEvidence.push(snapshot);
      this.payloadStoredSizeBytes += snapshot.storedSizeBytes;
      if (snapshot.truncated) this.truncatedPayloadCount += 1;
      return true;
    } catch {
      this.payloadCaptureFailureCount += 1;
      return false;
    }
  }

  /** Enrich exactly one already-captured wire attempt. Never creates or reorders an API row. */
  public enrichSalesforceApiCall(
    publicApiCallId: string,
    enrichment: SalesforceApiSemanticEnrichment,
  ): boolean {
    if (this.finalized) return false;
    const index = this.salesforceApiCalls.findIndex((call) => call.publicApiCallId === publicApiCallId);
    if (index < 0) {
      this.salesforceApiCaptureFailureCount += 1;
      return false;
    }
    const current = this.salesforceApiCalls[index];
    if (!current) {
      this.salesforceApiCaptureFailureCount += 1;
      return false;
    }
    this.salesforceApiCalls[index] = deepFreeze({ ...current, ...enrichment });
    return true;
  }

  public finalize(completedAt: Date = this.now()): AuditSnapshot | undefined {
    if (this.finalized) return undefined;
    const context = this.context();
    const selected = this.terminal?.candidate;
    const terminal: RequestAuditTerminalCandidate = selected ?? Object.freeze({
      source: 'REQUEST',
      result: 'ERROR',
      outcome: 'UNKNOWN',
      errorCode: 'MCP_AUDIT_TERMINAL_MISSING',
    });
    const finishedAt = new Date(completedAt.getTime()).toISOString();
    const durationMs = terminal.durationMs ?? Math.max(0, completedAt.getTime() - new Date(context.startedAt).getTime());
    const auditEvents = this.finalAuditEvents();
    const requestSummary = {
      conversationId: context.conversationId,
      turnId: context.turnId,
      externalRunId: context.externalRunId,
      agentId: context.agentId,
      modelProvider: context.modelProvider,
      modelName: context.modelName,
      auditCapture: {
        eventLimit: MAX_REQUEST_AUDIT_EVENTS,
        capturedEventCount: auditEvents.length,
        droppedEventCount: this.droppedEventCount,
        salesforceApiCallLimit: MAX_SALESFORCE_API_CALLS_PER_REQUEST,
        capturedSalesforceApiCallCount: this.salesforceApiCalls.length,
        droppedSalesforceApiCallCount: this.droppedSalesforceApiCallCount,
        salesforceApiCaptureFailureCount: this.salesforceApiCaptureFailureCount,
        payloadEvidenceLimit: MAX_PAYLOAD_EVIDENCE_PER_REQUEST,
        payloadEvidenceByteLimit: MAX_PAYLOAD_EVIDENCE_BYTES_PER_REQUEST,
        capturedPayloadCount: this.payloadEvidence.length,
        capturedPayloadBytes: this.payloadStoredSizeBytes,
        droppedPayloadCount: this.droppedPayloadCount,
        truncatedPayloadCount: this.truncatedPayloadCount,
        payloadCaptureFailureCount: this.payloadCaptureFailureCount,
      },
      summary: terminal.requestSummary ?? null,
    };
    this.finalized = deepFreeze({
      version: 1,
      auditCall: {
        publicAuditId: context.auditId,
        occurredAt: context.startedAt,
        startedAt: context.startedAt,
        completedAt: finishedAt,
        correlationId: context.correlationId,
        clientId: context.clientId,
        platformUserId: context.platformUserId,
        salesforceUsername: context.salesforceUsername,
        executionRole: context.executionRole,
        identitySource: context.identitySource,
        identityCredentialId: context.identityCredentialId,
        toolName: context.toolName,
        operation: context.operation,
        objectApiName: context.objectApiName,
        recordId: context.recordId,
        result: terminal.result,
        outcome: terminal.outcome,
        errorCode: terminal.errorCode ?? null,
        durationMs,
        auditIntegrityStatus:
          selected &&
          this.droppedEventCount === 0 &&
          this.droppedSalesforceApiCallCount === 0 &&
          this.salesforceApiCaptureFailureCount === 0 &&
          this.droppedPayloadCount === 0 &&
          this.truncatedPayloadCount === 0 &&
          this.payloadCaptureFailureCount === 0
            ? 'COMPLETE'
            : 'PARTIAL',
        requestSummary,
        // A higher-authority transport terminal may change the master outcome,
        // but it must not erase a Tool result that the server already formed.
        responseSummary: this.logicalToolResponseSummary ?? terminal.responseSummary ?? null,
      },
      auditEvents,
      salesforceApiCalls: [...this.salesforceApiCalls].sort((left, right) => left.sequence - right.sequence),
      payloadEvidence: [...this.payloadEvidence],
    }) satisfies AuditSnapshot;
    return this.finalized;
  }

  public snapshot(): AuditSnapshot | undefined {
    return this.finalized;
  }

  public eventCount(): number {
    return this.events.length;
  }

  public droppedEvents(): number {
    return this.droppedEventCount;
  }

  public salesforceApiCallCount(): number {
    return this.salesforceApiCalls.length;
  }

  public droppedSalesforceApiCalls(): number {
    return this.droppedSalesforceApiCallCount;
  }

  public payloadEvidenceCount(): number {
    return this.payloadEvidence.length;
  }

  public droppedPayloads(): number {
    return this.droppedPayloadCount;
  }

  private finalAuditEvents(): readonly RequestAuditEventSnapshot[] {
    if (
      this.droppedEventCount === 0 ||
      !this.terminalEvent ||
      this.events.some((event) => event.sequence === this.terminalEvent?.sequence)
    ) {
      return [...this.events];
    }
    const preserved = this.events.slice(0, Math.max(0, MAX_REQUEST_AUDIT_EVENTS - 1));
    preserved.push(this.terminalEvent);
    preserved.sort((left, right) => left.sequence - right.sequence);
    return preserved;
  }

  private selectTerminal(sequence: number, candidate: RequestAuditTerminalCandidate, eventSummary: unknown): boolean {
    if (candidate.source === 'TOOL' && candidate.responseSummary !== undefined) {
      const shared = isRecord(eventSummary) ? eventSummary : undefined;
      this.logicalToolResponseSummary = shared?.response ?? cloneAuditValue(candidate.responseSummary);
    }
    const current = this.terminal;
    if (!current || terminalPriority(candidate) > terminalPriority(current.candidate)) {
      const shared = isRecord(eventSummary) ? eventSummary : undefined;
      const safeCandidate = Object.freeze({
        ...candidate,
        ...(candidate.requestSummary !== undefined
          ? { requestSummary: shared?.request ?? cloneAuditValue(candidate.requestSummary) }
          : {}),
        ...(candidate.responseSummary !== undefined
          ? { responseSummary: shared?.response ?? cloneAuditValue(candidate.responseSummary) }
          : {}),
      });
      this.terminal = Object.freeze({ sequence, candidate: safeCandidate });
      return true;
    }
    return false;
  }
}

function terminalPriority(candidate: RequestAuditTerminalCandidate): number {
  // Explicit authority rule: a proven post-dispatch UNKNOWN wins, then transport/request
  // termination, then Tool outcome, then governance/identity denial. Equal authority keeps
  // the earliest observed candidate; neither "first logger" nor "last event" is the rule.
  if (candidate.outcome === 'UNKNOWN' && candidate.mutationStarted === true) return 500;
  switch (candidate.source) {
    case 'TRANSPORT': return 450;
    case 'REQUEST': return 400;
    case 'TOOL': return 350;
    case 'GOVERNANCE': return 300;
    case 'IDENTITY': return 250;
  }
}

function validDuration(value: number | undefined): number | null {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 4_294_967_295 ? value : null;
}

function boundedToken(value: string, maxLength: number, fallback: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_]/gu, '_').replace(/^_+/u, '').slice(0, maxLength);
  return /^[A-Z]/u.test(normalized) ? normalized : fallback;
}

function boundedText(value: string, maxLength: number, fallback: string): string {
  const normalized = value.replace(/[\u0000-\u001F\u007F]/gu, '').trim().slice(0, maxLength);
  return normalized || fallback;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.trim());
}

function cloneAuditValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return deepFreeze(toBoundedJsonValue(value, new WeakSet<object>(), { nodes: 0 }, 0));
  } catch {
    return null;
  }
}

function toBoundedJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
  budget: { nodes: number },
  depth: number,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > 512) return '[Truncated]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 4_096);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return null;
  if (depth >= 6) return '[Truncated]';
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, 64).map((entry) => toBoundedJsonValue(entry, ancestors, budget, depth + 1));
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, 64)) {
      const safeKey = key.replace(/[\u0000-\u001F\u007F]/gu, '').slice(0, 128);
      if (safeKey) output[safeKey] = toBoundedJsonValue(entry, ancestors, budget, depth + 1);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze<T>(value: T, visited: WeakSet<object> = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value) || visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) deepFreeze(child, visited);
  return Object.freeze(value);
}

import type { RequestAuditContext } from './request-audit-context.js';

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

/** P7-04/P7-05 fill these arrays through the same request-bound Collector. */
export type RequestAuditSalesforceApiCallSnapshot = Readonly<Record<string, never>>;
export type RequestAuditPayloadEvidenceSnapshot = Readonly<Record<string, never>>;

export type AuditSnapshot = Readonly<{
  version: 1;
  auditCall: RequestAuditCallSnapshot;
  auditEvents: readonly RequestAuditEventSnapshot[];
  salesforceApiCalls: readonly RequestAuditSalesforceApiCallSnapshot[];
  payloadEvidence: readonly RequestAuditPayloadEvidenceSnapshot[];
}>;

type SelectedTerminal = Readonly<{
  sequence: number;
  candidate: RequestAuditTerminalCandidate;
}>;

export class RequestAuditCollector {
  private readonly events: RequestAuditEventSnapshot[] = [];
  private terminal: SelectedTerminal | undefined;
  private finalized: AuditSnapshot | undefined;

  public constructor(
    private readonly context: () => RequestAuditContext,
    private readonly nextSequence: () => number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public record(input: RequestAuditEventInput): boolean {
    if (this.finalized) return false;
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
    this.events.push(event);
    if (input.terminal) this.selectTerminal(sequence, input.terminal, safeSummary);
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
    const requestSummary = {
      conversationId: context.conversationId,
      turnId: context.turnId,
      externalRunId: context.externalRunId,
      agentId: context.agentId,
      modelProvider: context.modelProvider,
      modelName: context.modelName,
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
        auditIntegrityStatus: selected ? 'COMPLETE' : 'PARTIAL',
        requestSummary,
        responseSummary: terminal.responseSummary ?? null,
      },
      auditEvents: [...this.events],
      salesforceApiCalls: [],
      payloadEvidence: [],
    }) satisfies AuditSnapshot;
    return this.finalized;
  }

  public snapshot(): AuditSnapshot | undefined {
    return this.finalized;
  }

  public eventCount(): number {
    return this.events.length;
  }

  private selectTerminal(sequence: number, candidate: RequestAuditTerminalCandidate, eventSummary: unknown): void {
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
    }
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

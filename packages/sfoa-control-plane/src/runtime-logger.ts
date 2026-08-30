import {
  currentRequestAuditContext,
  type RequestAuditContextController,
  type RequestAuditEventStatus,
  type RuntimeLogEvent,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
import type { AuditRepository, AuditTraceRepository } from './repositories.js';
import { AsyncAuditPipeline, type AuditPipelineHealth } from './audit-pipeline.js';

export type AuditPersistenceHealth = Readonly<{
  status: 'UP' | 'DEGRADED';
  failureCount: number;
  lastFailureAt: string | null;
  lastDropAt: string | null;
  queueDepth: number;
  queueCapacity: number;
  enqueuedSnapshots: number;
  persistedSnapshots: number;
  droppedSnapshots: number;
  writerFailureCount: number;
  queueFullCount: number;
  lastSuccessAt: string | null;
  writerState: AuditPipelineHealth['writerState'] | 'SYNCHRONOUS';
}>;

export class DatabaseRuntimeLogger implements RuntimeLogger {
  private failureCount = 0;
  private lastFailureAt: string | null = null;

  public constructor(
    private readonly audits: AuditRepository,
    private readonly fallback: RuntimeLogger,
    private readonly auditTraces?: AuditTraceRepository,
    private readonly pipeline?: AsyncAuditPipeline,
  ) {}

  public async log(event: RuntimeLogEvent): Promise<void> {
    if (!this.pipeline) return this.persist(event);
    this.collectOrEnqueue(event);
  }

  public async logBuntuTokenValidation(event: RuntimeLogEvent, rawToken: string): Promise<void> {
    if (!this.pipeline) return this.persist(event, rawToken);
    this.collectEvent(event);
    this.pipeline.offerLegacy(toAuditWrite(event, rawToken));
  }

  public finalizeRequestAudit(context: RequestAuditContextController): void {
    if (!this.pipeline) return;
    try {
      const snapshot = context.finalizeAudit();
      if (snapshot) this.pipeline.offerSnapshot(snapshot);
    } catch {
      this.pipeline.recordCollectorFailure();
    }
  }

  private async persist(event: RuntimeLogEvent, buntuRawTokenEvidence?: string): Promise<void> {
    try {
      const requestAudit = currentRequestAuditContext();
      if (requestAudit && this.auditTraces && requestAudit.claimAuditCallPersistence()) {
        const context = requestAudit.snapshot();
        await this.auditTraces.createCall({
          occurredAt: new Date(context.startedAt),
          publicAuditId: context.auditId,
          startedAt: new Date(context.startedAt),
          completedAt: new Date(),
          correlationId: context.correlationId,
          clientId: context.clientId ?? event.clientId,
          platformUserId: context.platformUserId ?? event.platformUserId,
          salesforceUsername: context.salesforceUsername ?? event.salesforceUsername,
          executionRole: context.executionRole ?? event.executionRole,
          identitySource: context.identitySource ?? event.identitySource,
          identityCredentialId: context.identityCredentialId ?? event.identityCredentialId,
          toolName: context.toolName,
          operation: context.operation ?? event.operation,
          objectApiName: context.objectApiName ?? event.objectApiName,
          recordId: context.recordId ?? event.recordId,
          result: event.result,
          outcome: event.outcome ?? (event.result === 'PASS' ? 'SUCCESS' : event.result === 'BLOCKED' ? 'DENIED' : 'FAILED'),
          errorCode: event.errorCode,
          durationMs: event.durationMs,
          auditIntegrityStatus: 'PARTIAL',
          requestSummary: {
            conversationId: context.conversationId,
            turnId: context.turnId,
            externalRunId: context.externalRunId,
            agentId: context.agentId,
            modelProvider: context.modelProvider,
            modelName: context.modelName,
            summary: event.requestSummary,
          },
          responseSummary: event.responseSummary,
        });
        return;
      }
      await this.audits.append({
        occurredAt: new Date(),
        correlationId: event.correlationId,
        channel: 'MCP',
        clientId: event.clientId,
        platformUserId: event.platformUserId,
        salesforceUsername: event.salesforceUsername,
        executionRole: event.executionRole,
        identitySource: event.identitySource,
        identityCredentialId: event.identityCredentialId,
        toolName: event.toolName,
        operation: event.operation,
        objectApiName: event.objectApiName,
        recordId: event.recordId,
        result: event.result,
        outcome: event.outcome ?? (event.result === 'PASS' ? 'SUCCESS' : event.result === 'BLOCKED' ? 'DENIED' : 'FAILED'),
        errorCode: event.errorCode,
        durationMs: event.durationMs,
        requestSummary: event.requestSummary,
        responseSummary: event.responseSummary,
        ...(buntuRawTokenEvidence === undefined ? {} : { buntuRawTokenEvidence }),
      });
    } catch {
      this.failureCount += 1;
      this.lastFailureAt = new Date().toISOString();
      try {
        await this.fallback.log({
          correlationId: event.correlationId,
          clientId: event.clientId,
          platformUserId: event.platformUserId,
          salesforceUsername: event.salesforceUsername,
          executionRole: event.executionRole,
          identitySource: event.identitySource,
          identityCredentialId: event.identityCredentialId,
          toolName: event.toolName,
          operation: event.operation,
          outcome: event.outcome,
          mutationStarted: event.mutationStarted,
          terminationLayer: event.terminationLayer,
          durationMs: event.durationMs,
          result: 'ERROR',
          errorCode: 'MCP_AUDIT_PERSISTENCE_FAILED',
        });
      } catch {
        // Logging is observational. Neither durable nor fallback sink failure may alter a completed Tool outcome.
      }
    }
  }

  public getHealth(): AuditPersistenceHealth {
    const pipelineHealth = this.pipeline?.getHealth();
    return Object.freeze({
      status: this.failureCount > 0 || pipelineHealth?.status === 'DEGRADED' ? 'DEGRADED' : 'UP',
      failureCount: this.failureCount + (pipelineHealth?.writerFailureCount ?? 0),
      lastFailureAt: latestTimestamp(this.lastFailureAt, pipelineHealth?.lastFailureAt ?? null),
      lastDropAt: pipelineHealth?.lastDropAt ?? null,
      queueDepth: pipelineHealth?.queueDepth ?? 0,
      queueCapacity: pipelineHealth?.queueCapacity ?? 0,
      enqueuedSnapshots: pipelineHealth?.enqueuedSnapshots ?? 0,
      persistedSnapshots: pipelineHealth?.persistedSnapshots ?? 0,
      droppedSnapshots: pipelineHealth?.droppedSnapshots ?? 0,
      writerFailureCount: pipelineHealth?.writerFailureCount ?? 0,
      queueFullCount: pipelineHealth?.queueFullCount ?? 0,
      lastSuccessAt: pipelineHealth?.lastSuccessAt ?? null,
      writerState: pipelineHealth?.writerState ?? 'SYNCHRONOUS',
    });
  }

  private collectOrEnqueue(event: RuntimeLogEvent): void {
    if (this.collectEvent(event)) return;
    this.pipeline?.offerLegacy(toAuditWrite(event));
  }

  private collectEvent(event: RuntimeLogEvent): boolean {
    const requestAudit = currentRequestAuditContext();
    if (!requestAudit) return false;
    try {
      requestAudit.collector().record({
        eventCategory: event.auditEvent?.eventCategory ?? 'INTERNAL',
        eventType: event.auditEvent?.eventType ?? 'RUNTIME_EVENT',
        eventName: event.auditEvent?.eventName ?? 'Runtime event',
        status: eventStatus(event),
        durationMs: event.durationMs,
        errorCode: event.errorCode,
        safeSummary: {
          request: event.requestSummary,
          response: event.responseSummary,
        },
        ...(event.auditEvent?.terminalSource
          ? {
              terminal: {
                source: event.auditEvent.terminalSource,
                result: event.result,
                outcome: event.outcome ?? defaultOutcome(event.result),
                ...(event.errorCode ? { errorCode: event.errorCode } : {}),
                ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
                ...(event.requestSummary !== undefined ? { requestSummary: event.requestSummary } : {}),
                ...(event.responseSummary !== undefined ? { responseSummary: event.responseSummary } : {}),
                ...(event.mutationStarted !== undefined ? { mutationStarted: event.mutationStarted } : {}),
              },
            }
          : {}),
      });
    } catch {
      this.pipeline?.recordCollectorFailure();
    }
    return true;
  }
}

function toAuditWrite(event: RuntimeLogEvent, buntuRawTokenEvidence?: string): import('./repositories.js').AuditWrite {
  return Object.freeze({
    occurredAt: new Date(),
    correlationId: event.correlationId,
    channel: 'MCP' as const,
    auditKind: event.operation === 'BUNTU_TOKEN_VALIDATE' ? 'IDENTITY_VALIDATION' as const : 'RUNTIME_EVENT' as const,
    ...(event.clientId ? { clientId: event.clientId } : {}),
    ...(event.platformUserId ? { platformUserId: event.platformUserId } : {}),
    ...(event.salesforceUsername ? { salesforceUsername: event.salesforceUsername } : {}),
    ...(event.executionRole ? { executionRole: event.executionRole } : {}),
    ...(event.identitySource ? { identitySource: event.identitySource } : {}),
    ...(event.identityCredentialId ? { identityCredentialId: event.identityCredentialId } : {}),
    ...(event.toolName ? { toolName: event.toolName } : {}),
    ...(event.operation ? { operation: event.operation } : {}),
    ...(event.objectApiName ? { objectApiName: event.objectApiName } : {}),
    ...(event.recordId ? { recordId: event.recordId } : {}),
    result: event.result,
    outcome: event.outcome ?? defaultOutcome(event.result),
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.requestSummary !== undefined ? { requestSummary: event.requestSummary } : {}),
    ...(event.responseSummary !== undefined ? { responseSummary: event.responseSummary } : {}),
    ...(buntuRawTokenEvidence === undefined ? {} : { buntuRawTokenEvidence }),
  });
}

function defaultOutcome(result: RuntimeLogEvent['result']): 'SUCCESS' | 'FAILED' | 'DENIED' {
  return result === 'PASS' ? 'SUCCESS' : result === 'BLOCKED' ? 'DENIED' : 'FAILED';
}

function eventStatus(event: RuntimeLogEvent): RequestAuditEventStatus {
  if (event.outcome === 'UNKNOWN') return 'UNKNOWN';
  return event.result === 'PASS' ? 'SUCCESS' : event.result === 'BLOCKED' ? 'BLOCKED' : 'FAILED';
}

function latestTimestamp(first: string | null, second: string | null): string | null {
  if (!first) return second;
  if (!second) return first;
  return first > second ? first : second;
}

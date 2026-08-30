import {
  currentRequestAuditContext,
  type RuntimeLogEvent,
  type RuntimeLogger,
} from '@sfoa/identity-runtime';
import type { AuditRepository, AuditTraceRepository } from './repositories.js';

export type AuditPersistenceHealth = Readonly<{
  status: 'UP' | 'DEGRADED';
  failureCount: number;
  lastFailureAt: string | null;
}>;

export class DatabaseRuntimeLogger implements RuntimeLogger {
  private failureCount = 0;
  private lastFailureAt: string | null = null;

  public constructor(
    private readonly audits: AuditRepository,
    private readonly fallback: RuntimeLogger,
    private readonly auditTraces?: AuditTraceRepository,
  ) {}

  public async log(event: RuntimeLogEvent): Promise<void> {
    await this.persist(event);
  }

  public async logBuntuTokenValidation(event: RuntimeLogEvent, rawToken: string): Promise<void> {
    await this.persist(event, rawToken);
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
    return Object.freeze({
      status: this.failureCount > 0 ? 'DEGRADED' : 'UP',
      failureCount: this.failureCount,
      lastFailureAt: this.lastFailureAt,
    });
  }
}

import type { RuntimeLogEvent, RuntimeLogger } from '@sfoa/identity-runtime';
import type { AuditRepository } from './repositories.js';

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
  ) {}

  public async log(event: RuntimeLogEvent): Promise<void> {
    try {
      await this.audits.append({
        occurredAt: new Date(),
        correlationId: event.correlationId,
        channel: 'MCP',
        clientId: event.clientId,
        platformUserId: event.platformUserId,
        salesforceUsername: event.salesforceUsername,
        executionRole: event.executionRole,
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

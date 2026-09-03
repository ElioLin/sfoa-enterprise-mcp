import type { RequestAuditContextController } from './request-audit-context.js';
import type {
  RequestAuditEventCategory,
  RequestAuditTerminalSource,
} from './request-audit-collector.js';

export type RuntimeLogResult = 'PASS' | 'ERROR' | 'BLOCKED';

export type RuntimeAuditEventDescriptor = Readonly<{
  eventCategory: RequestAuditEventCategory;
  eventType: string;
  eventName: string;
  terminalSource?: RequestAuditTerminalSource;
}>;

export type RuntimeLogEvent = Readonly<{
  correlationId: string;
  clientId?: string;
  platformUserId?: string;
  salesforceUsername?: string;
  identitySource?: 'INTERNAL_SERVICE_HEADER' | 'USER_BOUND_TOKEN' | 'BUNTU_TOKEN';
  identityCredentialId?: string;
  executionRole?: 'USER' | 'DIAGNOSTIC';
  toolName?: string;
  operation?: string;
  objectApiName?: string;
  recordId?: string;
  outcome?: 'SUCCESS' | 'FAILED' | 'DENIED' | 'UNKNOWN';
  mutationStarted?: boolean;
  terminationLayer?: 'TOOL' | 'REQUEST' | 'TRANSPORT';
  durationMs?: number;
  result: RuntimeLogResult;
  errorCode?: string;
  /** Short, pre-redacted, human-safe terminal message persisted to the audit ledger (never a raw body or secret). */
  errorMessageSafe?: string;
  requestSummary?: unknown;
  responseSummary?: unknown;
  auditEvent?: RuntimeAuditEventDescriptor;
}>;

export interface RuntimeLogger {
  log(event: RuntimeLogEvent): void | Promise<void>;
  finalizeRequestAudit?(context: RequestAuditContextController): void;
}

export class JsonLineRuntimeLogger implements RuntimeLogger {
  public log(event: RuntimeLogEvent): void {
    process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event: 'sfoa_request', ...event })}\n`);
  }
}

export class NoopRuntimeLogger implements RuntimeLogger {
  public log(_event: RuntimeLogEvent): void {
    // Tests and validation may suppress console logs while preserving the production event contract.
  }
}

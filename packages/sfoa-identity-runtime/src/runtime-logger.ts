export type RuntimeLogResult = 'PASS' | 'ERROR' | 'BLOCKED';

export type RuntimeLogEvent = Readonly<{
  correlationId: string;
  clientId?: string;
  platformUserId?: string;
  salesforceUsername?: string;
  executionRole?: 'USER' | 'DIAGNOSTIC';
  toolName?: string;
  operation?: 'CREATE' | 'UPDATE';
  outcome?: 'UNKNOWN';
  mutationStarted?: boolean;
  terminationLayer?: 'TOOL' | 'REQUEST' | 'TRANSPORT';
  durationMs?: number;
  result: RuntimeLogResult;
  errorCode?: string;
}>;

export interface RuntimeLogger {
  log(event: RuntimeLogEvent): void;
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

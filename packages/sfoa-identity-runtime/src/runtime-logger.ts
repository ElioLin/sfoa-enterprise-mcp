export type RuntimeLogResult = 'PASS' | 'ERROR' | 'BLOCKED';

export type RuntimeLogEvent = Readonly<{
  correlationId: string;
  platformUserId?: string;
  salesforceUsername?: string;
  toolName?: string;
  durationMs?: number;
  result: RuntimeLogResult;
  errorCode?: string;
}>;

export interface RuntimeLogger {
  log(event: RuntimeLogEvent): void;
}

export class JsonLineRuntimeLogger implements RuntimeLogger {
  public log(event: RuntimeLogEvent): void {
    process.stderr.write(`${JSON.stringify({ event: 'sfoa_request', ...event })}\n`);
  }
}

export class NoopRuntimeLogger implements RuntimeLogger {
  public log(_event: RuntimeLogEvent): void {
    // Tests and validation may suppress console logs while preserving the production event contract.
  }
}

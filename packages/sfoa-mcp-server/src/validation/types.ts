export type ValidationStatus = 'PASS' | 'BLOCKED' | 'FAIL';

export type ValidationGate = Readonly<{
  status: ValidationStatus;
  error?: string;
}>;

export type LatencySummary = Readonly<{
  samples: number;
  p50Ms: number;
  p95Ms: number;
}>;

export type LoadValidationGate = ValidationGate &
  Readonly<{
    requests: number;
    identityMismatch: number;
    crossUserLeak: number;
    workspaceLeak: number;
    cleanupFailures: number;
    connectionReuse: number;
    errors: number;
    latency: LatencySummary;
  }>;

export type P2ValidationReport = Readonly<{
  noBearer: ValidationGate;
  wrongBearer: ValidationGate;
  noPlatformUser: ValidationGate;
  unknownPlatformUser: ValidationGate;
  initializeA: ValidationGate;
  initializeB: ValidationGate;
  toolsList: ValidationGate;
  disabledToolInvisible: ValidationGate;
  remoteSchema: ValidationGate;
  getUsernameA: ValidationGate;
  getUsernameB: ValidationGate;
  soqlA: ValidationGate;
  soqlB: ValidationGate;
  forgedAToB: ValidationGate;
  forgedBToA: ValidationGate;
  load: LoadValidationGate;
  initializeLatency: LatencySummary;
  toolsListLatency: LatencySummary;
  getUsernameLatency: LatencySummary;
  soqlLatency: LatencySummary;
  jwtLatency: LatencySummary;
  salesforceCliUsed: false;
  databaseUsed: false;
  overall: 'PASS' | 'FAIL';
}>;

export type ValidationStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'PARTIAL' | 'NOT TESTED';

export type ValidationGate = Readonly<{
  status: ValidationStatus;
  error?: string;
}>;

export type ConcurrencyGate = ValidationGate &
  Readonly<{
    requests: number;
    identityMismatch: number;
    crossUserLeak: number;
    unknownConnectionReuse: number;
  }>;

export type P1ValidationReport = Readonly<{
  routeA: ValidationGate;
  jwtA: ValidationGate;
  identityA: ValidationGate;
  routeB: ValidationGate;
  jwtB: ValidationGate;
  identityB: ValidationGate;
  initialize: ValidationGate;
  toolsList: ValidationGate;
  getUsernameA: ValidationGate;
  getUsernameB: ValidationGate;
  soqlA: ValidationGate;
  soqlB: ValidationGate;
  forgedAToB: ValidationGate;
  forgedBToA: ValidationGate;
  unknownUser: ValidationGate;
  missingUser: ValidationGate;
  invalidIdentity: ValidationGate;
  concurrency: ConcurrencyGate;
  metadataCwd: ValidationGate;
  workspaceIsolation: ValidationGate;
  requestCleanup: ValidationGate;
  salesforceCliUsed: false;
  databaseUsed: false;
  overall: 'PASS' | 'PARTIAL' | 'FAIL';
}>;

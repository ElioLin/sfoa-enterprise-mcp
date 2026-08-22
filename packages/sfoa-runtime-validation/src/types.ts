export type GateStatus = 'PASS' | 'PARTIAL' | 'FAIL' | 'NOT TESTED';

export type GateResult = {
  status: GateStatus;
  durationMs?: number;
  error?: string;
};

export type TokenSummary = GateResult & {
  available: boolean;
  usable: boolean;
  tokenType: 'JWT' | 'OPAQUE' | 'UNKNOWN';
  expiration: string;
  issuer: string;
  audience: string;
  subject: string;
  scope: string;
};

export type IdentitySummary = GateResult & {
  matchesConfiguredUsername: boolean;
  userId?: string;
  username?: string;
  orgId?: string;
  instanceUrl?: string;
};

export type QuerySummary = GateResult & {
  objectApiName: string;
  rows?: number;
  toolName?: string;
  provider?: string;
};

export type MetadataSummary = GateResult & {
  metadataType: string;
  fullName: string;
  retrievedFiles?: number;
};

export type CwdSummary = GateResult & {
  officialToolRestored: boolean;
  harnessRestored: boolean;
};

export type RuntimeValidationReport = {
  generatedAt: string;
  environment: {
    instanceUrl: string;
    alias: string;
    username: string;
    objectApiName: string;
    metadataType: string;
    metadataFullName: string;
  };
  freshJwt: GateResult;
  token: TokenSummary;
  directConnection: GateResult;
  identity: IdentitySummary;
  directSoql: QuerySummary;
  officialSoql: QuerySummary;
  metadataWorkspace: GateResult;
  officialMetadata: MetadataSummary;
  cwd: CwdSummary;
  providerCompatibility: GateResult;
  directVsOfficialDiagnosis: string;
  overall: GateStatus;
};

export type RuntimeValidationOutcome = {
  report: RuntimeValidationReport;
  accessToken?: string;
};

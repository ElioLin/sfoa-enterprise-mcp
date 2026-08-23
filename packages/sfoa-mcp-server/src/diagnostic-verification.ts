import {
  createSalesforceIdentityRoute,
  OfficialDxCoreToolSource,
  RequestScopedToolExecutionAdapter,
  type IdentityRuntime,
} from '@sfoa/identity-runtime';
import { metadataContextInputSchema } from '@sfoa/mcp-provider-sfoa-context';
import {
  OfficialDiagnosticToolingQueryExecutor,
  OfficialMetadataComponentContextExecutor,
} from './diagnostic-context-adapters.js';
import { RemoteRuntimeError } from './errors.js';

export type DiagnosticVerificationResult = Readonly<{
  status: 'PASS' | 'NOT_TESTED';
  identityMatched: true;
  salesforceUsername: string;
  apiVersion: string;
  durationMs: number;
  tooling: Readonly<{ totalSize: number; returnedRecords: number; truncated: boolean }>;
  metadata: Readonly<{
    status: 'PASS' | 'NOT_TESTED';
    metadataType: string | null;
    fullName: string | null;
    totalFiles: number;
    returnedFiles: number;
    returnedBytes: number;
    truncated: boolean;
  }>;
  cleanup: Readonly<{ created: number; cleaned: number; active: number; pass: boolean }>;
}>;

export async function verifyDiagnosticThroughP4Scope(
  runtime: IdentityRuntime,
  input: Readonly<{
    platformUserId: string;
    correlationId: string;
    salesforceUsername: string;
    metadataType: string | null;
    metadataFullName: string | null;
  }>,
): Promise<DiagnosticVerificationResult> {
  const started = performance.now();
  const before = runtime.workspaceFactory.getMetrics();
  const route = createSalesforceIdentityRoute({
    platformUserId: input.platformUserId,
    salesforceUsername: input.salesforceUsername,
    credentialProfile: 'sfoa-shared-jwt',
    connectionRole: 'DIAGNOSTIC',
    aliases: [],
  });
  const scope = await runtime.scopeFactory.createForRoute(
    { platformUserId: input.platformUserId, correlationId: input.correlationId },
    route,
  );
  let tooling: DiagnosticVerificationResult['tooling'] | undefined;
  let metadata: DiagnosticVerificationResult['metadata'] | undefined;
  let apiVersion = 'UNKNOWN';
  try {
    const identity = await scope.connection.identity();
    if (identity.username !== input.salesforceUsername) {
      throw new RemoteRuntimeError(
        'MCP_DIAGNOSTIC_CONFIGURATION_INVALID',
        'Diagnostic Connection.identity() did not match the configured Salesforce username.',
        { correlationId: input.correlationId },
      );
    }
    apiVersion = scope.connection.getApiVersion();
    const tools = await new OfficialDxCoreToolSource().provideTools(scope.services);
    const queryTool = tools.find((tool) => tool.getName() === 'run_soql_query');
    const retrieveTool = tools.find((tool) => tool.getName() === 'retrieve_metadata');
    if (!queryTool || !retrieveTool) {
      throw new RemoteRuntimeError(
        'MCP_PROVIDER_INITIALIZATION_FAILED',
        'Required official P4 diagnostic primitives were not provided.',
        { correlationId: input.correlationId },
      );
    }
    const adapter = new RequestScopedToolExecutionAdapter(
      scope.context,
      scope.route,
      scope.workspace,
      runtime.cwdGuard,
      runtime.logger,
      runtime.redactionSecrets,
    );
    const toolingEvidence = await new OfficialDiagnosticToolingQueryExecutor(scope, adapter, queryTool).execute({
      query: 'SELECT Id, Name FROM ApexClass LIMIT 5',
    });
    tooling = Object.freeze({
      totalSize: toolingEvidence.totalSize,
      returnedRecords: toolingEvidence.returnedRecords,
      truncated: toolingEvidence.truncated,
    });
    if (!input.metadataType || !input.metadataFullName) {
      metadata = Object.freeze({
        status: 'NOT_TESTED', metadataType: input.metadataType, fullName: input.metadataFullName,
        totalFiles: 0, returnedFiles: 0, returnedBytes: 0, truncated: false,
      });
    } else {
      const parsed = metadataContextInputSchema.safeParse({
        metadataType: input.metadataType,
        fullName: input.metadataFullName,
      });
      if (!parsed.success) {
        throw new RemoteRuntimeError(
          'MCP_DIAGNOSTIC_CONFIGURATION_INVALID',
          'Diagnostic verification metadata seed is outside the audited P4 allowlist.',
          { correlationId: input.correlationId },
        );
      }
      const metadataEvidence = await new OfficialMetadataComponentContextExecutor(scope, adapter, retrieveTool).execute(parsed.data);
      metadata = Object.freeze({
        status: 'PASS', metadataType: input.metadataType, fullName: input.metadataFullName,
        totalFiles: metadataEvidence.totalFiles ?? 0, returnedFiles: metadataEvidence.returnedFiles ?? 0,
        returnedBytes: metadataEvidence.returnedBytes ?? 0, truncated: metadataEvidence.truncated ?? false,
      });
    }
  } finally {
    await scope.close();
  }
  if (!tooling || !metadata) throw new Error('Diagnostic verification did not produce bounded evidence.');
  const after = runtime.workspaceFactory.getMetrics();
  const cleanup = Object.freeze({
    created: after.created - before.created,
    cleaned: after.cleaned - before.cleaned,
    active: after.active,
    pass: after.active === 0 && after.created - before.created === after.cleaned - before.cleaned,
  });
  if (!cleanup.pass) {
    throw new RemoteRuntimeError(
      'MCP_REQUEST_CLEANUP_FAILED',
      'Diagnostic verification request workspace cleanup did not complete exactly.',
      { correlationId: input.correlationId },
    );
  }
  return Object.freeze({
    status: metadata.status === 'PASS' ? 'PASS' : 'NOT_TESTED',
    identityMatched: true,
    salesforceUsername: input.salesforceUsername,
    apiVersion,
    durationMs: Math.round(performance.now() - started),
    tooling,
    metadata,
    cleanup,
  });
}

import {
  normalizeSalesforceIdentity,
  NoopRuntimeLogger,
  OfficialDxCoreToolSource,
  RequestScopedToolExecutionAdapter,
  createIdentityRuntime,
  type IdentityRuntimeConfig,
} from '@sfoa/identity-runtime';
import {
  RecordActionContextExecutor,
  metadataContextInputSchema,
  recordActionContextOutputSchema,
} from '@sfoa/mcp-provider-sfoa-context';
import {
  OfficialDiagnosticToolingQueryExecutor,
  OfficialMetadataComponentContextExecutor,
} from '../diagnostic-context-adapters.js';

export type P4LiveGate = Readonly<{
  status: 'PASS' | 'FAIL' | 'NOT TESTED';
  detail: Readonly<Record<string, unknown>>;
}>;

export type P4LiveValidationReport = Readonly<{
  phase: 'P4';
  apiVersion: string;
  recordActionContextA: P4LiveGate;
  recordActionContextB: P4LiveGate;
  userIsolation: P4LiveGate;
  diagnosticTooling: P4LiveGate;
  metadataContext: P4LiveGate;
  cleanup: P4LiveGate;
  overall: 'PASS' | 'PARTIAL' | 'FAIL';
}>;

export async function runP4LiveValidation(config: IdentityRuntimeConfig): Promise<P4LiveValidationReport> {
  if (!config.testObject || !config.secondaryUsername) {
    throw new Error('P4 live validation requires TEST_OBJECT and SECOND_TEST_USER.');
  }
  const runtime = createIdentityRuntime(config, { logger: new NoopRuntimeLogger() });
  const beforeMetrics = runtime.workspaceFactory.getMetrics();
  const userReports: Array<{ gate: P4LiveGate; username: string; connection: object; apiVersion: string }> = [];

  for (const [platformUserId, correlationId] of [
    [config.platformUserA, 'p4-live-user-a'],
    [config.platformUserB, 'p4-live-user-b'],
  ] as const) {
    const scope = await runtime.scopeFactory.create({ platformUserId, correlationId });
    try {
      const connection = await scope.getConnection();
      const identity = await connection.identity();
      const output = recordActionContextOutputSchema.parse(
        await new RecordActionContextExecutor(scope.services.getOrgService()).execute({
          objectApiName: config.testObject,
          action: 'CREATE',
        }),
      );
      const fields = output.fields ?? [];
      userReports.push({
        username: scope.route.salesforceUsername,
        connection,
        apiVersion: connection.getApiVersion(),
        gate: {
          status:
            output.success &&
            output.executionRole === 'USER' &&
            output.recordType?.available === true &&
            normalizeSalesforceIdentity(identity.username) === normalizeSalesforceIdentity(scope.route.salesforceUsername)
              ? 'PASS'
              : 'FAIL',
          detail: {
            identityMatch:
              normalizeSalesforceIdentity(identity.username) === normalizeSalesforceIdentity(scope.route.salesforceUsername),
            executionRole: output.executionRole,
            recordTypeAvailable: output.recordType?.available,
            fieldCount: fields.length,
            apiRequiredCount: fields.filter((field) => field.apiRequired).length,
            layoutRequiredCount: fields.filter((field) => field.layoutRequired).length,
            layoutMemberCount: fields.filter((field) => field.layoutMember).length,
            defaultedCount: fields.filter((field) => field.defaultValue !== null).length,
            picklistFieldCount: fields.filter((field) => field.picklist !== undefined).length,
            apiCallCount: output.coverage?.apiCallCount,
            durationMs: output.coverage?.durationMs,
            responseBytes: output.coverage?.responseBytes,
            truncated: output.coverage?.truncated,
          },
        },
      });
    } finally {
      await scope.close();
    }
  }

  const diagnostic = await runDiagnosticGates(config, runtime);
  const afterMetrics = runtime.workspaceFactory.getMetrics();
  const cleanup: P4LiveGate = {
    status:
      afterMetrics.active === 0 &&
      afterMetrics.created - beforeMetrics.created === afterMetrics.cleaned - beforeMetrics.cleaned
        ? 'PASS'
        : 'FAIL',
    detail: {
      created: afterMetrics.created - beforeMetrics.created,
      cleaned: afterMetrics.cleaned - beforeMetrics.cleaned,
      active: afterMetrics.active,
    },
  };
  const userIsolation: P4LiveGate = {
    status:
      userReports.length === 2 &&
      userReports[0]?.connection !== userReports[1]?.connection &&
      normalizeSalesforceIdentity(userReports[0]?.username ?? '') !== normalizeSalesforceIdentity(userReports[1]?.username ?? '')
        ? 'PASS'
        : 'FAIL',
    detail: {
      freshConnections: userReports[0]?.connection !== userReports[1]?.connection,
      distinctResolvedUsers:
        normalizeSalesforceIdentity(userReports[0]?.username ?? '') !== normalizeSalesforceIdentity(userReports[1]?.username ?? ''),
      identityMismatch: userReports.filter((entry) => entry.gate.detail.identityMatch !== true).length,
      connectionReuse: userReports[0]?.connection === userReports[1]?.connection ? 1 : 0,
    },
  };
  const gates = [userReports[0]?.gate, userReports[1]?.gate, userIsolation, diagnostic.tooling, diagnostic.metadata, cleanup];
  const overall = gates.some((gate) => gate?.status === 'FAIL')
    ? 'FAIL'
    : gates.some((gate) => gate?.status === 'NOT TESTED')
      ? 'PARTIAL'
      : 'PASS';
  return {
    phase: 'P4',
    apiVersion: userReports[0]?.apiVersion ?? 'UNKNOWN',
    recordActionContextA: userReports[0]?.gate ?? fail('USER A context did not run.'),
    recordActionContextB: userReports[1]?.gate ?? fail('USER B context did not run.'),
    userIsolation,
    diagnosticTooling: diagnostic.tooling,
    metadataContext: diagnostic.metadata,
    cleanup,
    overall,
  };
}

async function runDiagnosticGates(
  config: IdentityRuntimeConfig,
  runtime: ReturnType<typeof createIdentityRuntime>,
): Promise<{ tooling: P4LiveGate; metadata: P4LiveGate }> {
  if (!runtime.diagnosticScopeFactory) {
    const notTested: P4LiveGate = {
      status: 'NOT TESTED',
      detail: { reason: 'SFOA_DIAGNOSTIC_USERNAME is not configured.' },
    };
    return { tooling: notTested, metadata: notTested };
  }
  const scope = await runtime.diagnosticScopeFactory.create({
    platformUserId: config.platformUserA,
    correlationId: 'p4-live-diagnostic',
  });
  try {
    const tools = await new OfficialDxCoreToolSource().provideTools(scope.services);
    const queryTool = tools.find((tool) => tool.getName() === 'run_soql_query');
    const retrieveTool = tools.find((tool) => tool.getName() === 'retrieve_metadata');
    if (!queryTool || !retrieveTool) throw new Error('Required official diagnostic primitives were not provided.');
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
    const tooling: P4LiveGate = {
      status: 'PASS',
      detail: {
        executionRole: 'DIAGNOSTIC',
        api: 'TOOLING',
        totalSize: toolingEvidence.totalSize,
        returnedRecords: toolingEvidence.returnedRecords,
        truncated: toolingEvidence.truncated,
      },
    };
    if (!config.metadataSeed) {
      return {
        tooling,
        metadata: {
          status: 'NOT TESTED',
          detail: { reason: 'TEST_METADATA_TYPE and TEST_METADATA_FULL_NAME are not configured.' },
        },
      };
    }
    const metadataInput = metadataContextInputSchema.safeParse({
      metadataType: config.metadataSeed.type,
      fullName: config.metadataSeed.fullName,
    });
    if (!metadataInput.success) {
      return {
        tooling,
        metadata: {
          status: 'NOT TESTED',
          detail: { reason: 'Configured TEST_METADATA_TYPE is outside the P4 metadata context allowlist.' },
        },
      };
    }
    const metadataEvidence = await new OfficialMetadataComponentContextExecutor(scope, adapter, retrieveTool).execute(
      metadataInput.data,
    );
    return {
      tooling,
      metadata: {
        status: 'PASS',
        detail: {
          executionRole: metadataEvidence.executionRole,
          totalFiles: metadataEvidence.totalFiles,
          returnedFiles: metadataEvidence.returnedFiles,
          totalBytes: metadataEvidence.totalBytes,
          returnedBytes: metadataEvidence.returnedBytes,
          truncated: metadataEvidence.truncated,
        },
      },
    };
  } finally {
    await scope.close();
  }
}

function fail(reason: string): P4LiveGate {
  return { status: 'FAIL', detail: { reason } };
}

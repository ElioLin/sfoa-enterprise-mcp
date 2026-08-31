import type { SalesforceConnectionFactory } from './connection-factory.js';
import { JwtConnectionFactory } from './connection-factory.js';
import {
  assertDiagnosticIdentityDistinct,
  buildIdentityRoutes,
  type IdentityRuntimeConfig,
} from './config.js';
import { CwdExecutionGuard } from './cwd-execution-guard.js';
import { IdentityResolver } from './identity-resolver.js';
import { installJsforceAuditAdapter } from './jsforce-audit-adapter.js';
import { InMemoryIdentityRepository, type IdentityRepository } from './identity-repository.js';
import { DiagnosticRequestScopeFactory, RequestScopeFactory } from './request-scope.js';
import { JsonLineRuntimeLogger, type RuntimeLogger } from './runtime-logger.js';
import { ensureGenericUnixKeychain } from './sfdx-auth-store.js';
import { RequestWorkspaceFactory } from './workspace.js';

export type IdentityRuntime = Readonly<{
  scopeFactory: RequestScopeFactory;
  diagnosticScopeFactory?: DiagnosticRequestScopeFactory;
  workspaceFactory: RequestWorkspaceFactory;
  cwdGuard: CwdExecutionGuard;
  logger: RuntimeLogger;
  redactionSecrets: readonly string[];
}>;

export type CreateIdentityRuntimeOverrides = Readonly<{
  connectionFactory?: SalesforceConnectionFactory;
  logger?: RuntimeLogger;
  workspaceFactory?: RequestWorkspaceFactory;
  cwdGuard?: CwdExecutionGuard;
  identityRepository?: IdentityRepository;
}>;

export function createIdentityRuntime(
  config: IdentityRuntimeConfig,
  overrides: CreateIdentityRuntimeOverrides = {},
): IdentityRuntime {
  installJsforceAuditAdapter();
  // Must precede any @salesforce/core crypto use: without the generic-unix
  // keychain on headless Linux, auth store persistence silently no-ops and
  // dx-core store lookups fail with NamedOrgNotFoundError.
  ensureGenericUnixKeychain();
  assertDiagnosticIdentityDistinct(config);
  const repository = overrides.identityRepository ?? new InMemoryIdentityRepository(buildIdentityRoutes(config));
  const resolver = new IdentityResolver(repository);
  const connectionFactory =
    overrides.connectionFactory ??
    new JwtConnectionFactory({
      instanceUrl: config.instanceUrl,
      clientId: config.clientId,
      privateKeyPath: config.privateKeyPath,
    });
  const workspaceFactory =
    overrides.workspaceFactory ?? new RequestWorkspaceFactory({ metadataSeed: config.metadataSeed });
  const cwdGuard = overrides.cwdGuard ?? new CwdExecutionGuard();
  const logger = overrides.logger ?? new JsonLineRuntimeLogger();

  const diagnosticScopeFactory = config.diagnosticUsername
    ? new DiagnosticRequestScopeFactory({
        diagnosticUsername: config.diagnosticUsername,
        connectionFactory,
        workspaceFactory,
        instanceUrl: config.instanceUrl,
      })
    : undefined;

  return Object.freeze({
    scopeFactory: new RequestScopeFactory({
      resolver,
      connectionFactory,
      workspaceFactory,
      instanceUrl: config.instanceUrl,
    }),
    workspaceFactory,
    cwdGuard,
    logger,
    redactionSecrets: Object.freeze([config.clientId, config.privateKeyPath]),
    ...(diagnosticScopeFactory ? { diagnosticScopeFactory } : {}),
  });
}

import type { SalesforceConnectionFactory } from './connection-factory.js';
import { JwtConnectionFactory } from './connection-factory.js';
import { buildIdentityRoutes, type IdentityRuntimeConfig } from './config.js';
import { CwdExecutionGuard } from './cwd-execution-guard.js';
import { IdentityResolver } from './identity-resolver.js';
import { InMemoryIdentityRepository } from './identity-repository.js';
import { RequestScopeFactory } from './request-scope.js';
import { JsonLineRuntimeLogger, type RuntimeLogger } from './runtime-logger.js';
import { RequestWorkspaceFactory } from './workspace.js';

export type IdentityRuntime = Readonly<{
  scopeFactory: RequestScopeFactory;
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
}>;

export function createIdentityRuntime(
  config: IdentityRuntimeConfig,
  overrides: CreateIdentityRuntimeOverrides = {},
): IdentityRuntime {
  const repository = new InMemoryIdentityRepository(buildIdentityRoutes(config));
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
  });
}

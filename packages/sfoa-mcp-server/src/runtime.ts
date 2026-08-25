import {
  createIdentityRuntime,
  JsonLineRuntimeLogger,
  type CreateIdentityRuntimeOverrides,
} from '@sfoa/identity-runtime';
import {
  assertAllMigrationsApplied,
  createControlPlaneDatabase,
  DatabaseRuntimeLogger,
  MySqlControlPlaneStore,
  MySqlIdentityRepository,
} from '@sfoa/control-plane';
import {
  BuntuTokenCredentialAuthenticator,
  DisabledLoopbackCredentialAuthenticator,
  InternalServiceCredentialAuthenticator,
  UnifiedIdentityProvider,
  UserBoundCredentialAuthenticator,
  type CredentialAuthenticator,
} from './authenticator.js';
import { HttpBuntuTokenValidator } from './buntu-validator.js';
import { loadRemoteRuntimeConfig } from './config.js';
import { startRemoteMcpServer, type RemoteMcpServer } from './http-server.js';
import { MySqlRuntimePolicySnapshotSource } from './policy-snapshot.js';

export async function startConfiguredRemoteRuntime(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  identityOverrides: CreateIdentityRuntimeOverrides = {},
): Promise<RemoteMcpServer> {
  const config = await loadRemoteRuntimeConfig(projectRoot, environment);
  if (config.controlPlane.mode === 'env') {
    const identityRuntime = createIdentityRuntime(config.identity, identityOverrides);
    return startRemoteMcpServer({ config, identityRuntime });
  }
  const databaseConfig = config.controlPlane.database;
  if (!databaseConfig) throw new Error('MySQL Control Plane mode did not load database configuration.');
  const database = createControlPlaneDatabase(databaseConfig);
  const store = new MySqlControlPlaneStore(database);
  try {
    await assertAllMigrationsApplied(database);
    const fallbackLogger = identityOverrides.logger ?? new JsonLineRuntimeLogger();
    const databaseLogger = new DatabaseRuntimeLogger(store.repositories.audits, fallbackLogger);
    const identityRuntime = createIdentityRuntime(config.identity, {
      ...identityOverrides,
      identityRepository: new MySqlIdentityRepository(database),
      logger: databaseLogger,
    });
    const server = await startRemoteMcpServer({
      config,
      identityRuntime,
      policySnapshotSource: new MySqlRuntimePolicySnapshotSource(database),
      identityProvider: new UnifiedIdentityProvider(buildCredentialAuthenticators(config, store, databaseLogger)),
    });
    let closed = false;
    return Object.freeze({
      ...server,
      close: async () => {
        const result = await server.close();
        if (!closed) {
          closed = true;
          await store.close();
        }
        return result;
      },
    });
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
}

function createInternalCredentialAuthenticator(
  authMode: 'internal_bearer' | 'disabled',
  clientToken: string | undefined,
): CredentialAuthenticator {
  return authMode === 'disabled'
    ? new DisabledLoopbackCredentialAuthenticator()
    : new InternalServiceCredentialAuthenticator(clientToken ?? '');
}

/**
 * Deterministic provider order for `UnifiedIdentityProvider`:
 * 1. USER_BOUND (exclusive by `sfoa_ub1_*` prefix),
 * 2. INTERNAL (exclusive by exact timing-safe MCP_CLIENT_TOKEN match),
 * 3. BUNTU (anything else, only when MCP_BUNTU_IDENTITY_ENABLED=true).
 *
 * The predicates are mutually exclusive, so ordering does not change the
 * routing outcome; Buntu is appended last for readability.
 */
function buildCredentialAuthenticators(
  config: Awaited<ReturnType<typeof loadRemoteRuntimeConfig>>,
  store: MySqlControlPlaneStore,
  logger: DatabaseRuntimeLogger,
): CredentialAuthenticator[] {
  const authenticators: CredentialAuthenticator[] = [
    new UserBoundCredentialAuthenticator(
      store.repositories.identityCredentials,
      store.repositories.identityRoutes,
      logger,
    ),
    createInternalCredentialAuthenticator(config.authMode, config.clientToken),
  ];
  if (config.buntuIdentity.enabled) {
    const validateTokenUrl = config.buntuIdentity.validateTokenUrl;
    if (!validateTokenUrl) {
      throw new Error('MCP_BUNTU_IDENTITY_ENABLED=true requires MCP_BUNTU_VALIDATE_TOKEN_URL.');
    }
    authenticators.push(
      new BuntuTokenCredentialAuthenticator({
        validator: new HttpBuntuTokenValidator({
          validateTokenUrl,
          timeoutMs: config.buntuIdentity.timeoutMs,
        }),
        routes: store.repositories.identityRoutes,
        logger,
        clientToken: config.clientToken ?? '',
        validateTokenUrl,
        rawTokenAuditEnabled: config.buntuIdentity.rawTokenAuditEnabled,
      }),
    );
  }
  return authenticators;
}

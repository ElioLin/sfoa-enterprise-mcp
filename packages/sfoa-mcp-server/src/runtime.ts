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

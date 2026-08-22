import {
  createIdentityRuntime,
  type CreateIdentityRuntimeOverrides,
} from '@sfoa/identity-runtime';
import { loadRemoteRuntimeConfig } from './config.js';
import { startRemoteMcpServer, type RemoteMcpServer } from './http-server.js';

export async function startConfiguredRemoteRuntime(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  identityOverrides: CreateIdentityRuntimeOverrides = {},
): Promise<RemoteMcpServer> {
  const config = await loadRemoteRuntimeConfig(projectRoot, environment);
  const identityRuntime = createIdentityRuntime(config.identity, identityOverrides);
  return startRemoteMcpServer({ config, identityRuntime });
}

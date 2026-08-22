import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIdentityRuntimeConfig } from './config.js';
import { startIdentityHttpServer } from './http-server.js';
import { createIdentityRuntime } from './runtime.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function main(): Promise<void> {
  const config = await loadIdentityRuntimeConfig(projectRoot);
  const runtime = createIdentityRuntime(config);
  const httpServer = await startIdentityHttpServer({
    scopeFactory: runtime.scopeFactory,
    cwdGuard: runtime.cwdGuard,
    logger: runtime.logger,
    redactionSecrets: runtime.redactionSecrets,
    port: config.port,
  });
  process.stderr.write(`SFoA P1 identity test host listening at ${httpServer.url.toString()}\n`);

  const shutdown = async (): Promise<void> => {
    await httpServer.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`SFoA P1 identity host failed: ${message}\n`);
  process.exitCode = 1;
});

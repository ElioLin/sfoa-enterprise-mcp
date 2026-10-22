import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createControlPlaneDatabase,
  databaseHealth,
  MySqlCrmChatRepository,
  resolveSfoaProjectRoot,
} from '@sfoa/control-plane';
import { ApexTokenVerifier, loadApexPublicKey } from './apex-token.js';
import { ChatSessionService } from './chat-auth.js';
import { loadCrmGatewayConfig } from './config.js';
import { CrmGatewayServer, type CrmGatewayLogger } from './server.js';
import { OpenClawCrmClient } from './openclaw-client.js';

async function main(): Promise<void> {
  const projectRoot = resolveSfoaProjectRoot(import.meta.url);
  const config = await loadCrmGatewayConfig(projectRoot);
  const publicKeyPath = path.resolve(projectRoot, config.apex.publicKeyPath);
  const publicKey = loadApexPublicKey(
    await readFile(publicKeyPath, 'utf8'),
    config.apex.certificateSha256,
  );
  const database = createControlPlaneDatabase(config.database);
  const repository = new MySqlCrmChatRepository(database);
  const apexVerifier = new ApexTokenVerifier({
    publicKey,
    issuer: config.apex.issuer,
    audience: config.apex.audience,
    allowedOrgIds: config.apex.allowedOrgIds,
    maxAgeMs: config.apex.maxAgeMs,
    maxTtlMs: config.apex.maxTtlMs,
    clockSkewMs: config.apex.clockSkewMs,
  });
  const chatSessions = new ChatSessionService(repository, { ttlMs: config.chatTokenTtlMs });
  const openclaw = new OpenClawCrmClient(config.openclawBaseUrl, config.openclawServiceToken, {
    timeoutMs: config.requestTimeoutMs,
    historyToken: config.gatewayHistoryToken,
  });
  const logger: CrmGatewayLogger = {
    info: (event) => process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`),
    warn: (event) => process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`),
    error: (event) => process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`),
  };

  const tls = config.tls
    ? {
      key: await readFile(path.resolve(projectRoot, config.tls.keyPath)),
      cert: await readFile(path.resolve(projectRoot, config.tls.certPath)),
    }
    : undefined;

  const server = new CrmGatewayServer({
    config,
    repository,
    apexVerifier,
    chatSessions,
    openclaw,
    ...(tls ? { tls } : {}),
    logger,
    health: async () => {
      const checks: Record<string, string> = { database: 'DOWN', openclaw: 'DOWN' };
      try {
        await databaseHealth(database);
        checks.database = 'UP';
      } catch {
        checks.database = 'DOWN';
      }
      try {
        const health = await Promise.race([
          openclaw.health(),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error('openclaw health timeout')), 3_000);
            timer.unref?.();
          }),
        ]);
        checks.openclaw = health.ok ? 'UP' : 'DOWN';
      } catch {
        checks.openclaw = 'DOWN';
      }
      return checks;
    },
  });

  const sweep = async (): Promise<void> => {
    const now = new Date(Date.now());
    try {
      const stale = await repository.markStaleRunsUnknown(new Date(now.getTime() - config.runStaleAfterMs), now);
      if (stale > 0) logger.warn({ event: 'crm_stale_runs_marked_unknown', count: stale });
      await repository.deleteExpiredArtifacts(now);
    } catch (error) {
      logger.warn({ event: 'crm_cleanup_failed', code: error instanceof Error ? error.name : 'UNKNOWN' });
    }
  };
  await sweep();
  const cleanupTimer = setInterval(() => { void sweep(); }, config.cleanupIntervalMs);
  cleanupTimer.unref?.();

  const address = await server.listen();
  logger.info({
    event: 'crm_gateway_started',
    result: 'PASS',
    url: address.url,
    allowedOriginCount: config.allowedOrigins.length,
    apexIssuer: config.apex.issuer,
    apexAudience: config.apex.audience,
    allowedOrgCount: config.apex.allowedOrgIds.length,
    openclawUrl: config.openclawBaseUrl,
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ event: 'crm_gateway_stopping', signal });
    clearInterval(cleanupTimer);
    await server.close().catch(() => undefined);
    await database.destroy().catch(() => undefined);
    process.exitCode = 0;
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'The CRM gateway failed to start.';
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'crm_gateway_start_failed',
    result: 'ERROR',
    message: redactSecrets(message),
  })}\n`);
  process.exitCode = 1;
});

function redactSecrets(value: string): string {
  return value
    .replace(/(token|secret|password|authorization)\s*[=:]\s*\S+/giu, '$1=__REDACTED__')
    .slice(0, 2_000);
}

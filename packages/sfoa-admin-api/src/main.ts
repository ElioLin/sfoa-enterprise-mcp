import { redactSensitiveText } from '@sfoa/identity-runtime';
import { startConfiguredAdminApi } from './runtime.js';

async function main(): Promise<void> {
  const server = await startConfiguredAdminApi(process.cwd());
  let closing = false;
  const close = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), event: 'sfoa_admin_stopping', signal })}\n`);
    await server.close();
  };
  process.once('SIGINT', () => void close('SIGINT'));
  process.once('SIGTERM', () => void close('SIGTERM'));
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'sfoa_admin_started',
    baseUrl: server.baseUrl.href,
  })}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'The P5 Admin API failed to start.';
  const secrets = [
    process.env.SFOA_ADMIN_SESSION_SECRET,
    process.env.SFOA_DB_PASSWORD,
    process.env.MCP_CLIENT_TOKEN,
  ].filter((value): value is string => Boolean(value));
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'sfoa_admin_start_failed',
    result: 'ERROR',
    message: redactSensitiveText(message, secrets),
  })}\n`);
  process.exitCode = 1;
});

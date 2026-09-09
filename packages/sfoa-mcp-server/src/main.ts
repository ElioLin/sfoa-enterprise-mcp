import { resolveSfoaProjectRoot } from '@sfoa/control-plane';
import { redactSensitiveText } from '@sfoa/identity-runtime';
import { startConfiguredRemoteRuntime } from './runtime.js';
import { installGracefulShutdown } from './shutdown.js';

async function main(): Promise<void> {
  const server = await startConfiguredRemoteRuntime(resolveSfoaProjectRoot(import.meta.url));
  installGracefulShutdown(server);
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'sfoa_runtime_started',
      mcpUrl: server.mcpUrl.href,
      healthUrl: server.healthUrl.href,
      readyUrl: server.readyUrl.href,
      tools: server.registeredTools,
      identitySources: server.identitySources,
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'The SFoA MCP runtime failed to start.';
  const secrets = [process.env.MCP_CLIENT_TOKEN, process.env.MCP_WECOM_CLIENT_TOKEN]
    .filter((value): value is string => Boolean(value));
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'sfoa_runtime_start_failed',
      result: 'ERROR',
      message: redactSensitiveText(message, secrets),
    })}\n`,
  );
  process.exitCode = 1;
});

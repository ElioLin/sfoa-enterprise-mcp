import type { RemoteMcpServer } from './http-server.js';

export function installGracefulShutdown(server: RemoteMcpServer): () => void {
  let initiated = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (initiated) return;
    initiated = true;
    process.stderr.write(
      `${JSON.stringify({ timestamp: new Date().toISOString(), event: 'sfoa_runtime_shutdown', signal, result: 'STARTED' })}\n`,
    );
    void server.close().then(
      (result) => {
        process.stderr.write(
          `${JSON.stringify({ timestamp: new Date().toISOString(), event: 'sfoa_runtime_shutdown', signal, result: result.drained ? 'DRAINED' : 'FORCED' })}\n`,
        );
        process.exitCode = result.drained ? 0 : 1;
      },
      () => {
        process.stderr.write(
          `${JSON.stringify({ timestamp: new Date().toISOString(), event: 'sfoa_runtime_shutdown', signal, result: 'ERROR' })}\n`,
        );
        process.exitCode = 1;
      },
    );
  };

  const onSigint = (): void => handler('SIGINT');
  const onSigterm = (): void => handler('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
}

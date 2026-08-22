import { startPocHttpServer } from './server.js';

const requestedPort = Number.parseInt(process.env.PORT ?? '3000', 10);
if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const server = await startPocHttpServer({ port: requestedPort });
process.stderr.write(`SFoA Streamable HTTP POC listening at ${server.url.toString()}\n`);

const shutdown = async (): Promise<void> => {
  await server.close();
  process.exit(0);
};

process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});

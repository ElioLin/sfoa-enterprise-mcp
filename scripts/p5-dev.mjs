import { spawn } from 'node:child_process';
import process from 'node:process';

const yarnCli = process.env.npm_execpath;
const yarn = yarnCli ? process.execPath : process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
const services = [
  ['MCP runtime', ['workspace', '@sfoa/mcp-server', 'start']],
  ['Admin API', ['workspace', '@sfoa/admin-api', 'dev']],
  ['Admin Web', ['workspace', '@sfoa/admin-web', 'dev']],
];
const children = services.map(([label, args]) => {
  process.stdout.write(`[P5 DEV] starting ${label}\n`);
  const child = spawn(yarn, [...(yarnCli ? [yarnCli] : []), ...args], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  child.once('exit', (code, signal) => {
    if (!stopping && (code !== 0 || signal)) {
      process.stderr.write(`[P5 DEV] ${label} exited (${signal ?? code ?? 'unknown'}); stopping peers.\n`);
      stop(code ?? 1);
    }
  });
  return child;
});
let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(exitCode), 1_000).unref();
}

process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));

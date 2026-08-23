import { spawnSync } from 'node:child_process';
import process from 'node:process';

const yarnCli = process.env.npm_execpath;
const yarn = yarnCli ? process.execPath : process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
const gates = [
  ['@sfoa/control-plane', 'test'],
  ['@sfoa/control-plane', 'test:mysql'],
  ['@sfoa/identity-runtime', 'test'],
  ['@sfoa/mcp-server', 'test:p5'],
  ['@sfoa/admin-api', 'test'],
  ['@sfoa/admin-web', 'build'],
  ['@sfoa/admin-web', 'test'],
];

for (const [workspace, gate] of gates) {
  process.stdout.write(`\n[P5 GATE] ${workspace} ${gate}\n`);
  const args = [...(yarnCli ? [yarnCli] : []), 'workspace', workspace, gate];
  const result = spawnSync(yarn, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write('\nP5 implementation gates completed. External MySQL and Salesforce gates retain their own PASS/NOT TESTED evidence.\n');
